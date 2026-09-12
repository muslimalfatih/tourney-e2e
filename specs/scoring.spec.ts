import { test, expect, type Page } from '@playwright/test';
import { apiContext, api, makeRRTournament, addFixture, scoreNormal } from '../helpers/api';
import { expectToast, gotoAuthed } from '../helpers/ui';
import { ORGANIZER_EMAIL, ORGANIZER_PASSWORD } from '../helpers/env';

// Journey 3 — scoring through the real score modal: every completion type,
// tiebreak legality, same-result rescore, and the downstream lock on
// corrections. Fixtures are ARRANGED via the API; the behavior under test is
// always exercised in the browser.
const SLUG = 'e2e-score';

let rrEventId = '';
let seEventId = '';

test.beforeAll(async () => {
	const { ctx, token } = await apiContext();
	const rr = await makeRRTournament(ctx, token, SLUG, [
		'SA / 1',
		'SB / 2',
		'SC / 3',
		'SD / 4'
	]);
	rrEventId = rr.eventId;
	const [A, B, C, D] = rr.participantIds;
	await addFixture(ctx, token, rrEventId, A, B); // 7-6 legality
	await addFixture(ctx, token, rrEventId, A, C); // walkover
	await addFixture(ctx, token, rrEventId, A, D); // retired
	await addFixture(ctx, token, rrEventId, B, C); // cancelled
	await addFixture(ctx, token, rrEventId, B, D); // rescore-same-result

	// Single-elim division in the same tournament for the downstream lock.
	const se = await api(ctx, token, 'post', `/tournaments/${rr.tournamentId}/events`, {
		name: 'E2E Elim',
		discipline: 'doubles',
		format: 'single_elim'
	});
	seEventId = (se.body.data as Record<string, unknown>).id as string;
	const pids: string[] = [];
	for (const n of ['EA / 1', 'EB / 2', 'EC / 3', 'ED / 4']) {
		const p = await api(ctx, token, 'post', `/events/${seEventId}/participants`, {
			display_name: n
		});
		pids.push((p.body.data as Record<string, unknown>).id as string);
	}
	await api(ctx, token, 'post', `/events/${seEventId}/bracket/build`, {
		matches: [
			{ team_a_id: pids[0], team_b_id: pids[1] },
			{ team_a_id: pids[2], team_b_id: pids[3] }
		]
	});
	// Decide both semis so the final is fed; the lock test then reopens one.
	const list = await api(ctx, token, 'get', `/events/${seEventId}/matches`);
	const matches = list.body.data as { id: string; match_no: number }[];
	await scoreNormal(ctx, token, matches.find((m) => m.match_no === 1)!.id);
	await scoreNormal(ctx, token, matches.find((m) => m.match_no === 2)!.id);
	await ctx.dispose();
});

async function openScoreFor(page: Page, rowText: string | string[], button = 'Score') {
	// Match rows stack the two pair names in separate spans (no literal "vs"),
	// so multi-name targeting chains hasText filters.
	const texts = Array.isArray(rowText) ? rowText : [rowText];
	let row = page.locator('div.space-y-3 > *');
	for (const t of texts) row = row.filter({ hasText: t });
	const btn = row.first().getByRole('button', { name: button });
	// Retry until the dialog opens — a click landing before hydration focuses
	// the button but runs no handler.
	const { expect: e } = await import('@playwright/test');
	await e(async () => {
		await btn.click();
		await e(page.getByRole('dialog')).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 20_000 });
	return page.getByRole('dialog');
}

async function fillSet(dialog: ReturnType<Page['locator']>, i: number, a: string, b: string) {
	await dialog.locator('input[name="games_a"]').nth(i).fill(a);
	await dialog.locator('input[name="games_b"]').nth(i).fill(b);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
	await gotoAuthed(page, `/organizer/events/${rrEventId}/matches`, { email: ORGANIZER_EMAIL, password: ORGANIZER_PASSWORD });
});

test('7-6 without a tiebreak is rejected with a readable message; with one it saves', async ({
	page
}) => {
	const dialog = await openScoreFor(page, ['SA / 1', 'SB / 2']);
	await fillSet(dialog, 0, '7', '6');
	await dialog.getByRole('button', { name: '+ Add set' }).click();
	await fillSet(dialog, 1, '6', '0');
	await dialog.getByRole('button', { name: 'Complete match' }).click();
	await expect(page.locator('body')).toContainText(/tiebreak/i);
	// No UUIDs or raw codes in the message.
	await expect(page.locator('body')).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}/);

	await dialog.locator('input[name="tiebreak_a"]').nth(0).fill('7');
	await dialog.locator('input[name="tiebreak_b"]').nth(0).fill('3');
	await dialog.getByRole('button', { name: 'Complete match' }).click();
	await expectToast(page, 'Match completed');
});

test('walkover needs a winner and reports as a walkover', async ({ page }) => {
	const dialog = await openScoreFor(page, ['SA / 1', 'SC / 3']);
	await dialog.locator('#rr-ending').selectOption('walkover');
	// Set inputs disappear; the record button is held until a winner is picked.
	await expect(dialog.locator('input[name="games_a"]')).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: /Record walkover/ })).toBeDisabled();
	await dialog.getByRole('radio').first().check();
	await dialog.getByRole('button', { name: /Record walkover/ }).click();
	await expectToast(page, 'Walkover recorded');
	await expect(page.locator('body')).toContainText('walkover');
});

test('retired keeps partial sets and names the winner', async ({ page }) => {
	const dialog = await openScoreFor(page, ['SA / 1', 'SD / 4']);
	await fillSet(dialog, 0, '6', '3');
	await dialog.getByRole('button', { name: '+ Add set' }).click();
	await fillSet(dialog, 1, '2', '1');
	await dialog.locator('#rr-ending').selectOption('retired');
	await dialog.getByRole('radio').first().check();
	await dialog.getByRole('button', { name: /Record retired/ }).click();
	await expectToast(page, 'Retirement recorded');
});

test('cancelled voids the fixture', async ({ page }) => {
	const dialog = await openScoreFor(page, ['SB / 2', 'SC / 3']);
	await dialog.locator('#rr-ending').selectOption('cancelled');
	await dialog.getByRole('button', { name: /Record cancelled/ }).click();
	await expectToast(page, 'Match cancelled');
	await expect(page.locator('body')).toContainText('cancelled');
});

test('re-submitting the same decided result succeeds (idempotent rescore)', async ({ page }) => {
	// Score B-D normally, then reopen and submit the identical result.
	let dialog = await openScoreFor(page, ['SB / 2', 'SD / 4']);
	await fillSet(dialog, 0, '6', '2');
	await dialog.getByRole('button', { name: '+ Add set' }).click();
	await fillSet(dialog, 1, '6', '2');
	await dialog.getByRole('button', { name: 'Complete match' }).click();
	await expectToast(page, 'Match completed');

	dialog = await openScoreFor(page, ['SB / 2', 'SD / 4'], 'Edit');
	await dialog.getByRole('button', { name: 'Complete match' }).click();
	await expectToast(page, 'Match completed');
});

test('correcting a semi under a started final surfaces the downstream lock', async ({ page }) => {
	await gotoAuthed(page, `/organizer/events/${seEventId}/matches`, { email: ORGANIZER_EMAIL, password: ORGANIZER_PASSWORD });
	// Start the final with a partial score so its feeds lock.
	const final = await openScoreFor(page, 'Match 3');
	await fillSet(final, 0, '3', '2');
	await final.getByRole('button', { name: 'Save progress' }).click();
	await expectToast(page, 'Score saved');

	// Reopen semi 1 and flip the winner — blocked, in plain words.
	const semi = await openScoreFor(page, 'Match 1', 'Edit');
	await fillSet(semi, 0, '0', '6');
	if ((await semi.locator('input[name="games_a"]').count()) < 2) {
		await semi.getByRole('button', { name: '+ Add set' }).click();
	}
	await fillSet(semi, 1, '0', '6');
	await semi.getByRole('button', { name: 'Complete match' }).click();
	await expect(page.locator('body')).toContainText(/later matches already depend/i);
	await expect(page.locator('body')).toContainText(/Match 3/);
	await expect(page.locator('body')).not.toContainText(/downstream_phase_locked/);
});
