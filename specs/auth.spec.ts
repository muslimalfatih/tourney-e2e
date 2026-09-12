import { test, expect } from '@playwright/test';
import { ORGANIZER_EMAIL, ORGANIZER_PASSWORD } from '../helpers/env';
import { fillStable } from '../helpers/ui';

// Journey 1 — authentication. Runs WITHOUT the shared storage state so every
// step exercises the real cookie flow.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('authentication', () => {
	test('invalid login is rejected and stays on the login page', async ({ page }) => {
		await page.goto('/login');
		await fillStable(page, 'input[name="email"]', ORGANIZER_EMAIL);
		await page.fill('input[name="password"]', 'definitely-wrong-password');
		await page.click('button[type="submit"]');
		await expect(page).toHaveURL(/\/login/);
		await expect(page.locator('body')).toContainText(/invalid|incorrect|wrong|could not/i);
	});

	test('organizer routes are protected when logged out', async ({ page }) => {
		await page.goto('/organizer/tournaments');
		await expect(page).toHaveURL(/\/login/);
	});

	test('login, session persistence, JWT hygiene, logout', async ({ page }) => {
		await page.goto('/login');
		await fillStable(page, 'input[name="email"]', ORGANIZER_EMAIL);
		await page.fill('input[name="password"]', ORGANIZER_PASSWORD);
		await page.click('button[type="submit"]');
		await page.waitForURL('**/organizer**');

		// Session survives a full reload (httpOnly cookies, no client storage).
		await page.reload();
		await expect(page).toHaveURL(/\/organizer/);

		// No JWT anywhere the browser can read: not in the served HTML or
		// serialized page data (Phase 1 S3 regression, now browser-level)...
		const html = await page.content();
		// A real JWT is three dot-separated base64url segments. (A bare eyJ
		// prefix also matches Vite's dev-mode CSS source maps — base64 '{"'.)
		expect(html).not.toMatch(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/);
		// ...and not in localStorage/sessionStorage either.
		const storage = await page.evaluate(() =>
			JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } })
		);
		expect(storage).not.toMatch(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/);

		// Logout ends the session and organizer routes lock again. /logout is
		// a POST action — the UI's Sign out button is the real path.
		await page.getByRole('button', { name: 'Sign out' }).click();
		await page.waitForURL('**/login**');
		await page.goto('/organizer/tournaments');
		await expect(page).toHaveURL(/\/login/);
	});
});
