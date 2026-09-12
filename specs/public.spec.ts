import { test, expect } from '@playwright/test';
import { request } from '@playwright/test';
import { API_URL } from '../helpers/env';
import { apiContext, makeRRTournament } from '../helpers/api';

// Journey 5 — the public surfaces, read-only on the Renon Cup demo, plus
// draft protection with an unpublished e2e tournament and the mobile widths.
test.use({ storageState: { cookies: [], origins: [] } });

test('overview, standings, bracket, schedule, results', async ({ page }) => {
	await page.goto('/tournaments/renon-cup-2026');
	await expect(page.locator('body')).toContainText(/Renon Cup 2026/i);

	// Division navigation: the filter strip changes the active division/URL.
	await expect(page.getByRole('link', { name: 'Bracket' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Schedule' })).toBeVisible();

	// Schedule page groups by tournament-local day with times.
	await page.getByRole('link', { name: 'Schedule' }).click();
	await page.waitForURL('**/schedule');
	await expect(page.locator('body')).toContainText(/\d{2}:\d{2}/);

	// Back to the draw: standings or bracket content renders with results
	// (decided matches show set scores somewhere in the view).
	await page.getByRole('link', { name: 'Bracket' }).click();
	await expect
		.poll(async () => /Winner|Runner-up|Standings|\d\s+\d/.test(await page.locator('body').innerText()))
		.toBe(true);
});

test('public match detail renders names and score', async ({ page }) => {
	// Find a decided public match via the public API (read-only).
	const ctx = await request.newContext({ baseURL: API_URL });
	const t = await (await ctx.get(`${API_URL}/public/tournaments/renon-cup-2026`)).json();
	const events: { id: string }[] = t.data.events;
	let matchId = '';
	for (const ev of events) {
		const b = await (await ctx.get(`${API_URL}/public/events/${ev.id}/bracket`)).json();
		for (const r of b.data?.rounds ?? []) {
			for (const m of r.matches) {
				if (m.status === 'completed') matchId = m.id;
			}
		}
		if (matchId) break;
	}
	await ctx.dispose();
	test.skip(!matchId, 'demo data has no completed match');

	await page.goto(`/tournaments/renon-cup-2026/matches/${matchId}`);
	await expect(page.locator('body')).toContainText(/Match \d+/);
	await expect(page.locator('body')).toContainText(/completed|walkover|retired/i);
});

test('draft tournaments are invisible on every public surface', async ({ page }) => {
	const { ctx, token } = await apiContext();
	const draft = await makeRRTournament(ctx, token, 'e2e-draft', ['DA / 1', 'DB / 2']);
	await ctx.dispose();

	await page.goto(`/tournaments/${draft.slug}`);
	await expect(page.locator('body')).toContainText(/not found/i);
	await page.goto(`/tournaments/${draft.slug}/schedule`);
	await expect(page.locator('body')).toContainText(/not found/i);
	// The shell metadata hook must not leak the draft's name either.
	const html = await page.content();
	expect(html).not.toContain('E2E e2e-draft');
});

for (const width of [360, 375, 390]) {
	test(`mobile ${width}px: share control clear of tabs, no horizontal scroll`, async ({
		page
	}) => {
		await page.setViewportSize({ width, height: 780 });
		await page.goto('/tournaments/renon-cup-2026');
		await expect(page.getByRole('link', { name: 'Bracket' })).toBeVisible();

		const share = page.getByRole('button', { name: 'Share this view' });
		await expect(share).toBeVisible();
		const shareBox = (await share.boundingBox())!;
		const tabBox = (await page.getByRole('link', { name: 'Schedule' }).boundingBox())!;
		// Disjoint horizontally: the icon-only share pill must not cover the tab.
		expect(shareBox.x).toBeGreaterThanOrEqual(tabBox.x + tabBox.width - 1);

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(1);
	});
}

test('desktop 1280px: labelled share and presentation link', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/tournaments/renon-cup-2026');
	await expect(page.getByRole('button', { name: 'Share this view' })).toContainText('Share');
	await expect(page.getByRole('link', { name: /Present/ })).toBeVisible();
});
