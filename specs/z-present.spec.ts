import { test, expect } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { apiContext, api, makeRRTournament, addFixture } from '../helpers/api';

// Journey 7 — presentation mode. Named z- so it runs LAST: the final test
// kills and restarts the API process to prove the reconnect + catch-up path,
// which would disrupt any suite running after it.
const SLUG = 'e2e-present';

let matchId = '';

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
	const { ctx, token } = await apiContext();
	const f = await makeRRTournament(ctx, token, SLUG, ['PA / 1', 'PB / 2'], { publish: true });
	matchId = await addFixture(ctx, token, f.eventId, f.participantIds[0], f.participantIds[1]);
	await ctx.dispose();
});

test.describe.configure({ mode: 'serial' });

test('rotation, pause/resume, keyboard, fullscreen', async ({ page }) => {
	await page.goto(`/tournaments/${SLUG}/present?interval=4`);

	const counter = page.locator('span.tabular-nums', { hasText: '/' });
	await expect(counter).toContainText('1 /');

	// Auto-rotation advances within one interval (+ slack).
	await expect(counter).not.toContainText('1 /', { timeout: 8_000 });

	// Pause holds the slide across more than an interval.
	await page.getByRole('button', { name: 'Pause rotation' }).click();
	const held = await counter.innerText();
	await page.waitForTimeout(5_000);
	await expect(counter).toHaveText(held);

	// Keyboard: arrows move, Space resumes/pauses.
	await page.keyboard.press('ArrowRight');
	await expect(counter).not.toHaveText(held);
	await page.keyboard.press('ArrowLeft');
	await expect(counter).toHaveText(held);

	// Fullscreen toggles on F and reports its state on the control.
	await page.keyboard.press('f');
	await expect
		.poll(() => page.evaluate(() => document.fullscreenElement != null))
		.toBe(true);
	await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
	await page.keyboard.press('f');
	await expect
		.poll(() => page.evaluate(() => document.fullscreenElement != null))
		.toBe(false);
});

test('an SSE update surfaces the live slide without a reload', async ({ page }) => {
	await page.goto(`/tournaments/${SLUG}/present?interval=4`);
	await expect(page.locator('body')).toContainText('1 /');

	const { ctx, token } = await apiContext();
	const r = await api(ctx, token, 'patch', `/matches/${matchId}/status`, { status: 'live' });
	expect(r.status).toBe(200);
	await ctx.dispose();

	// The deck refetches on the event and the rotation reaches the new slide.
	await expect
		.poll(async () => (await page.locator('body').innerText()).includes('Live now'), {
			timeout: 30_000
		})
		.toBe(true);
});

test('API restart: reconnecting state, then automatic catch-up', async ({ page }) => {
	await page.goto(`/tournaments/${SLUG}/present?interval=60`);
	await expect(page.locator('body')).toContainText('1 /');

	// Kill the API out from under the open SSE stream.
	execSync('lsof -ti tcp:8095 -sTCP:LISTEN | xargs kill', { shell: '/bin/bash' });
	await expect(page.getByText(/Reconnecting/)).toBeVisible({ timeout: 30_000 });

	// Bring a fresh API back on the same port.
	const proc = spawn('bash', [join(__dirname, '..', 'scripts', 'run-api.sh')], {
		detached: true,
		stdio: 'ignore'
	});
	proc.unref();
	await expect
		.poll(
			async () => {
				try {
					const res = await fetch('http://localhost:8095/healthz');
					return res.ok;
				} catch {
					return false;
				}
			},
			{ timeout: 120_000, intervals: [1_000] }
		)
		.toBe(true);

	// EventSource reconnects on its own; the indicator clears...
	await expect(page.getByText(/Reconnecting/)).toBeHidden({ timeout: 30_000 });

	// ...and catch-up works: decide the match while the page just reconnected,
	// then expect the result to reach the deck (event + generation refetch).
	const { ctx, token } = await apiContext();
	await api(ctx, token, 'patch', `/matches/${matchId}/score`, {
		sets: [
			{ set_number: 1, games_a: 6, games_b: 1 },
			{ set_number: 2, games_a: 6, games_b: 1 }
		],
		completion: 'normal'
	});
	await ctx.dispose();
	// interval=60 keeps rotation still, so walk the deck manually until the
	// refetched slide list includes the new results slide.
	await expect
		.poll(
			async () => {
				await page.keyboard.press('ArrowRight');
				return (await page.locator('body').innerText()).includes('Latest results');
			},
			{ timeout: 30_000, intervals: [1_000] }
		)
		.toBe(true);
});
