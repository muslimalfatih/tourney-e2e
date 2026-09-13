import { test, expect } from '@playwright/test';
import { fillStable, expectToast, gotoAuthed, clickTab, openDialogVia } from '../helpers/ui';
import { apiContext, api } from '../helpers/api';
import { ORGANIZER_EMAIL } from '../helpers/env';

// Journey 2 — tournament workflow, driven through the real organizer UI:
// create tournament → add division → add pairs → fixtures with duplicate
// protection and the explicit rematch confirmation. Slot taxonomy (placement
// feeds, winner feeds, byes, empty slots) is asserted read-only on the Renon
// Cup demo, which permanently exhibits all four.
const SLUG = 'e2e-flow';

test.describe.configure({ mode: 'serial' });

test('create tournament and division, add pairs', async ({ page }) => {
	// Session cookies can be invalidated mid-suite by refresh-token rotation
	// races; the whole create sequence retries with a fresh login and a fresh
	// slug (the wipe clears every e2e-% slug regardless).
	let attempt = 0;
	await expect(async () => {
		attempt++;
		await gotoAuthed(page, '/organizer/tournaments/new', ORGANIZER_EMAIL);
		await fillStable(page, 'input[name="name"]', 'E2E Flow Cup');
		await fillStable(page, 'input[name="slug"]', `${SLUG}-${attempt}`);
		// NOT page.click('button[type=submit]') — the admin header's Sign out
		// button is also a submit and precedes the form in the DOM.
		await page.getByRole('button', { name: 'Create tournament' }).click();
		await page.waitForURL('**/organizer/tournaments/**', { timeout: 15_000 });
	}).toPass({ timeout: 70_000 });

	// Tournament overview shows the new event with its draft state.
	await expect(page.locator('h1')).toContainText('E2E Flow Cup');
	await expect(page.locator('body')).toContainText(/draft/i);

	// Add a round-robin doubles division through the modal.
	const modal = await openDialogVia(page, () =>
		page.getByRole('button', { name: 'Add event' }).first().click()
	);
	await modal.locator('input[name="name"]').fill('E2E Doubles');
	await modal.locator('select[name="discipline"]').selectOption('doubles');
	await modal.locator('select[name="format"]').selectOption('round_robin');
	await modal.getByRole('button', { name: 'Add event' }).click();
	await expect(page.locator('table')).toContainText('E2E Doubles');

	// Into the division via the row's Configure action (the name is a plain
	// cell; the link is the row's action button). Breadcrumb check follows.
	await page.getByRole('row', { name: /E2E Doubles/ }).getByRole('link').first().click();
	await page.waitForURL('**/organizer/events/**');
	await expect(page.getByRole('link', { name: /E2E Flow Cup/ })).toBeVisible();

	// Participants tab: add three pairs through the inline form.
	await clickTab(page, 'Participants');
	for (const name of ['Alpha / One', 'Bravo / Two', 'Charlie / Three']) {
		// Submit retried until the participant ROW exists — a re-render from the
		// previous add can wipe the input mid-keystroke in dev.
		await expect(async () => {
			const input = page.locator('form[action="?/addParticipant"] input[name="display_name"]');
			await input.fill(name);
			await input.press('Enter');
			await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible({
				timeout: 3_000
			});
		}).toPass({ timeout: 30_000 });
	}

	// Setup progress reflects reality: participants done, draw pending.
	await clickTab(page, 'Overview');
	await expect(page.getByText('3 entered')).toBeVisible();
	await expect(page.getByText('Add participants')).toBeVisible();
	await expect(page.getByText('Build the draw')).toBeVisible();
});

test('duplicate fixture blocked; decided fixture offers explicit rematch', async ({ page }) => {
	// The UI walk to the division was covered by the create test; this one
	// resolves the division id via the API and deep-links to Draw setup.
	const { ctx, token } = await apiContext();
	const list = await api(ctx, token, 'get', '/tournaments');
	const cup = (list.body.data as { id: string; name: string }[]).find(
		(t) => t.name === 'E2E Flow Cup'
	)!;
	const evs = await api(ctx, token, 'get', `/tournaments/${cup.id}/events`);
	const div = (evs.body.data as { id: string; name: string }[]).find(
		(e) => e.name === 'E2E Doubles'
	)!;
	await ctx.dispose();
	await gotoAuthed(page, `/organizer/events/${div.id}`, ORGANIZER_EMAIL);
	await clickTab(page, 'Draw setup');

	// Fixture Alpha vs Bravo through the round-robin builder's selects.
	// bits-ui Select triggers are plain buttons named by the current label;
	// the two live inside the add-fixture form's .flex-1 wrappers.
	const pick = async (nth: number, option: string) => {
		await page.locator('form[action="?/addManualMatch"] .flex-1 button').nth(nth).click();
		await page.getByRole('option', { name: option }).click();
	};
	await pick(0, 'Alpha / One');
	await pick(1, 'Bravo / Two');
	await page.getByRole('button', { name: 'Add', exact: true }).click();
	await expectToast(page, 'Fixture added');
	await expect(page.getByText(/Fixtures · 1/)).toBeVisible();

	// The same (reversed) pairing is pre-blocked with the existing match named.
	await pick(0, 'Bravo / Two');
	await pick(1, 'Alpha / One');
	await expect(page.getByText(/already have an unplayed fixture \(Match 1/)).toBeVisible();
	await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();

	// Decide match 1 (matches page, normal 6-0 6-0), then the same pairing
	// offers — and requires — the explicit rematch confirmation.
	await page.goto(page.url().replace(/\?.*$/, '') + '/matches');
	const dialog = await openDialogVia(page, () =>
		page.getByRole('button', { name: 'Score' }).first().click()
	);
	await dialog.locator('input[name="games_a"]').nth(0).fill('6');
	await dialog.locator('input[name="games_b"]').nth(0).fill('0');
	await dialog.getByRole('button', { name: '+ Add set' }).click();
	await dialog.locator('input[name="games_a"]').nth(1).fill('6');
	await dialog.locator('input[name="games_b"]').nth(1).fill('0');
	await dialog.getByRole('button', { name: 'Complete match' }).click();
	await expectToast(page, 'Match completed');

	// Fresh load rather than history-back: back-navigation can serve the page
	// from the client cache with pre-add data.
	await page.goto(`/organizer/events/${div.id}`);
	await clickTab(page, 'Draw setup');
	await expect(page.getByText(/Fixtures · 1/)).toBeVisible();
	await pick(0, 'Alpha / One');
	await pick(1, 'Bravo / Two');
	await expect(page.getByText(/already played \(Match 1/)).toBeVisible();
	await page.getByRole('button', { name: 'Create rematch' }).click();
	await expectToast(page, 'Fixture added');
	await expect(page.getByText(/Fixtures · 2/)).toBeVisible();
});

test('slot taxonomy on the public demo: placement, winner-fed, bye, empty', async ({
	page
}) => {
	// Renon Cup (read-only). The taxonomy lives in the public read-model:
	// placement-fed slots (Winner/Runner-up/#3 …), winner-fed slots, bye pads
	// and still-empty slots. The public bracket UI renders unresolved slots as
	// TBD placeholders, so labels are asserted on the API payloads and the UI
	// on what it actually shows.
	const { request } = await import('@playwright/test');
	const { API_URL } = await import('../helpers/env');
	const ctx = await request.newContext();
	const t = await (await ctx.get(`${API_URL}/public/tournaments/renon-cup-2026`)).json();
	const events = t.data.events as { id: string; slug: string; format: string }[];

	let placement = false;
	let winnerFed = false;
	let bye = false;
	let empty = false;
	for (const ev of events) {
		for (const path of [`/public/events/${ev.id}/bracket`, `/public/events/${ev.id}/groups`]) {
			const res = await ctx.get(`${API_URL}${path}`);
			if (!res.ok()) continue;
			const body = JSON.stringify(await res.json());
			if (/Winner [^o]|Runner-up|#\d+ /.test(body)) placement = true;
			if (/Winner of/i.test(body) || /"source_label":"Winner/.test(body)) winnerFed = true;
			if (/"status":"bye"/.test(body)) bye = true;
			if (/"participant_id":null/.test(body)) empty = true;
		}
	}
	await ctx.dispose();
	expect(placement, 'placement-fed slot labels present').toBe(true);
	expect(winnerFed, 'winner-fed slot labels present').toBe(true);
	expect(bye, 'bye pad present').toBe(true);
	expect(empty, 'unresolved/empty slot present').toBe(true);

	// UI: a group-knockout division shows both phases; unresolved knockout
	// slots render as TBD placeholders rather than broken cards.
	const gk = events.find((e) => e.format === 'group_knockout');
	test.skip(!gk, 'demo has no group_knockout division');
	await page.goto(`/tournaments/renon-cup-2026/${gk!.slug}/bracket`);
	await expect(page.getByRole('button', { name: 'Group standings' })).toBeVisible();
	await expect(page.locator('body')).toContainText('TBD');
});
