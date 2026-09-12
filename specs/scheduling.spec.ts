import { test, expect, type Page } from '@playwright/test';
import { apiContext, api, makeRRTournament, addFixture } from '../helpers/api';
import { expectToast, gotoAuthed, openDialogVia } from '../helpers/ui';
import { ORGANIZER_EMAIL, ORGANIZER_PASSWORD } from '../helpers/env';

// Journey 4 — scheduling through the organizer schedule page: conflicts, the
// rest warning with its explicit override, tournament-local confirmation
// times, and slot move/delete. The bits-ui DateTimePicker is bypassed by
// writing the ISO into the form's hidden field — the submitted FORM is what
// the server action reads, so the whole action → API → conflict-UI loop stays
// real end-to-end.
const SLUG = 'e2e-sched';

// Tomorrow at a fixed UTC hour, so runs never collide with past-time logic.
function at(hourUtc: number, minute = 0): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + 1);
	d.setUTCHours(hourUtc, minute, 0, 0);
	return d.toISOString();
}

let tournamentId = '';
let m1 = '';
let m2 = '';

test.beforeAll(async () => {
	const { ctx, token } = await apiContext();
	const f = await makeRRTournament(ctx, token, SLUG, ['MA / 1', 'MB / 2', 'MC / 3']);
	tournamentId = f.tournamentId;
	const [A, B, C] = f.participantIds;
	m1 = await addFixture(ctx, token, f.eventId, A, B); // M1
	m2 = await addFixture(ctx, token, f.eventId, A, C); // M2 shares pair A
	await ctx.dispose();
});

// Court name -> id, resolved once the UI has created them.
async function courtIds(): Promise<Record<string, string>> {
	const { ctx, token } = await apiContext();
	const r = await api(ctx, token, 'get', `/tournaments/${tournamentId}/courts`);
	await ctx.dispose();
	const out: Record<string, string> = {};
	for (const c of r.body.data as { id: string; name: string }[]) out[c.name] = c.id;
	return out;
}

async function addCourt(page: Page, name: string) {
	const modal = await openDialogVia(page, () =>
		page.getByRole('button', { name: 'Court', exact: true }).click()
	);
	await modal.locator('input[name="name"]').fill(name);
	await modal.getByRole('button', { name: 'Add court' }).click();
	await expectToast(page, 'Court added');
	await expect(page.getByRole('dialog')).toBeHidden();
}

// Open the slot modal, choose court + match by visible name, inject the ISO
// start, optionally tick the rest override, and submit the real form.
// The bits-ui Selects don't commit clicks reliably under automation, so the
// modal is driven through its FORM contract instead: court_id/match_id are
// the Selects' own hidden inputs, starts_at the picker's. The server action
// and every conflict/override behavior under test read exactly these fields.
async function scheduleSlot(
	page: Page,
	courtId: string,
	matchId: string | null,
	iso: string
) {
	// After a rejected submit the modal stays open with the error — reuse it
	// rather than fighting the overlay for the button underneath.
	const open = await page
		.getByRole('dialog')
		.isVisible()
		.catch(() => false);
	if (!open) {
		await openDialogVia(page, () =>
			page.getByRole('button', { name: 'Schedule match' }).click()
		);
	}
	await setSlotForm(page, courtId, matchId, iso);
}

async function setSlotForm(page: Page, courtId: string, matchId: string | null, iso: string) {
	const modal = page.getByRole('dialog');
	await modal.locator('input[name="court_id"]').evaluate((el, v) => ((el as HTMLInputElement).value = v), courtId);
	if (matchId !== null) {
		await modal.locator('input[name="match_id"]').evaluate((el, v) => ((el as HTMLInputElement).value = v), matchId);
	}
	await modal
		.locator('input[name="starts_at"]')
		.evaluate((el, v) => ((el as HTMLInputElement).value = v), iso);
	await modal
		.locator('form')
		.first()
		.evaluate((f) => (f as HTMLFormElement).requestSubmit());
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
	await gotoAuthed(page, `/organizer/tournaments/${tournamentId}/schedule`, { email: ORGANIZER_EMAIL, password: ORGANIZER_PASSWORD });
});

test('courts, a normal slot, and the tournament-local success time', async ({ page }) => {
	await addCourt(page, 'Court 1');
	await addCourt(page, 'Court 2');

	// 02:00 UTC = 10:00 in Asia/Makassar (the default tournament zone).
	const courts = await courtIds();
	await scheduleSlot(page, courts['Court 1'], m1, at(2));
	await expectToast(page, /Match scheduled — .*10:00/);
	await expect(page.locator('body')).toContainText('10:00');
	await expect(page.locator('body')).toContainText('Court 1');
});

test('court overlap and participant overlap are hard, readable errors', async ({ page }) => {
	// Same court, overlapping window → court conflict.
	const courts = await courtIds();
	await scheduleSlot(page, courts['Court 1'], m2, at(2, 30));
	await expect(page.locator('body')).toContainText(/court busy/i);

	// Other court, same window — pair MA is already playing → participant conflict.
	await scheduleSlot(page, courts['Court 2'], m2, at(2, 30));
	await expect(page.locator('body')).toContainText(/players already on court/i);
	await expect(page.locator('body')).not.toContainText(/schedule_conflict/);
});

test('short rest warns, and only the explicit override schedules it', async ({ page }) => {
	// M1 runs 02:00–03:30 UTC; 03:45 leaves 15 minutes of rest for pair MA.
	const courts = await courtIds();
	await scheduleSlot(page, courts['Court 2'], m2, at(3, 45));
	await expect(page.locator('body')).toContainText(/less than 30 minutes rest/i);
	const modal = page.getByRole('dialog');
	await expect(modal.getByText(/Schedule anyway/)).toBeVisible();

	await modal.getByLabel(/Schedule anyway/).check();
	await modal
		.locator('form')
		.first()
		.evaluate((f) => (f as HTMLFormElement).requestSubmit());
	await expectToast(page, /Match scheduled — .*11:45/);
});

test('a slot can be moved into a conflict (rejected) and deleted (freed)', async ({ page }) => {
	// Move the M2 slot onto Court 1 inside M1's window → rejected, slot keeps its time.
	const row = page.locator('li', { hasText: 'MC / 3' }).first();
	await expect(async () => {
		await row.locator('button').last().click();
		await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 20_000 });
	await page.getByRole('menuitem', { name: 'Edit' }).click();
	const courts = await courtIds();
	await setSlotForm(page, courts['Court 1'], m2, at(2, 15));
	await expect(page.locator('body')).toContainText(/court busy/i);
	await page.keyboard.press('Escape');
	await expect(page.locator('body')).toContainText('11:45'); // unchanged

	// Delete it through the page's own hidden form (the row menu's plumbing;
	// the menu interaction itself is already proven by the Edit path above).
	const { ctx, token } = await apiContext();
	const sched = await api(ctx, token, 'get', `/tournaments/${tournamentId}/schedule`);
	await ctx.dispose();
	const slot = (sched.body.data as { id: string; match_label: string | null }[]).find((x) =>
		x.match_label?.includes('MC / 3')
	)!;
	await page.evaluate((slotId) => {
		const form = document.getElementById('delSlotForm') as HTMLFormElement;
		(form.querySelector('input[name="slotId"]') as HTMLInputElement).value = slotId;
		form.requestSubmit();
	}, slot.id);
	await expectToast(page, 'Slot removed');
	await expect(page.locator('li', { hasText: 'MC / 3' })).toHaveCount(0);
});
