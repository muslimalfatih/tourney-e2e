import { test, expect } from '@playwright/test';
import { ORGANIZER_EMAIL, ADMIN_EMAIL } from '../helpers/env';
import { fillStable } from '../helpers/ui';
import { getOtpCode } from '../helpers/otp';

// Journey 1 — authentication. Runs WITHOUT the shared storage state so every
// step exercises the real cookie flow, from a fully signed-out browser.
test.use({ storageState: { cookies: [], origins: [] } });

// A syntactically valid address that is not in the invitations table.
const uninvitedEmail = () => `not-invited-${Date.now()}@example.com`;

async function requestCode(page: import('@playwright/test').Page, email: string): Promise<void> {
	await page.goto('/login');
	await fillStable(page, 'input[name="email"]', email);
	await page.getByRole('button', { name: 'Continue' }).click();
}

test.describe('authentication', () => {
	test('uninvited email is rejected on step 1, with the exact product copy', async ({ page }) => {
		await requestCode(page, uninvitedEmail());
		await expect(page.locator('body')).toContainText(
			'This email has not been invited to Tourney.social.'
		);
		// Rejected on the email step -- no code field appeared to move on to.
		await expect(page.locator('input[name="code"]')).toHaveCount(0);
	});

	test('invalid email shape is rejected before any request leaves the browser', async ({ page }) => {
		await page.goto('/login');
		await page.fill('input[name="email"]', 'not-an-email');
		// The native type="email" input blocks submission client-side; the
		// server-side 422 (invalid_email) is exercised directly in the Go
		// integration suite, where a malformed value can actually be posted.
		await page.getByRole('button', { name: 'Continue' }).click();
		await expect(page).toHaveURL(/\/login/);
		await expect(page.locator('input[name="code"]')).toHaveCount(0);
	});

	test('wrong code is rejected and the email stays visible to retry', async ({ page }) => {
		await requestCode(page, ORGANIZER_EMAIL);
		await page.getByLabel(/six-digit code/i).waitFor();
		await page.fill('input[name="code"]', '000000');
		await page.getByRole('button', { name: /verify and sign in/i }).click();
		await expect(page.locator('body')).toContainText(/not right|invalid/i);
		// Still on step 2, same address -- a wrong code doesn't lose the
		// email or bounce back to step 1, which would force retyping it.
		await expect(page.locator('input[name="code"]')).toHaveCount(1);
		await expect(page.locator('body')).toContainText(ORGANIZER_EMAIL);
	});

	test('organizer signs in with a real code and lands on the organizer dashboard', async ({ page }) => {
		await requestCode(page, ORGANIZER_EMAIL);
		await page.getByLabel(/six-digit code/i).waitFor();
		const code = await getOtpCode(page.request, ORGANIZER_EMAIL);
		await page.fill('input[name="code"]', code);
		await page.getByRole('button', { name: /verify and sign in/i }).click();
		await page.waitForURL('**/organizer**');
		await expect(page).toHaveURL(/\/organizer/);
	});

	test('super admin signs in and lands on the platform overview, not the organizer view', async ({ page }) => {
		await requestCode(page, ADMIN_EMAIL);
		await page.getByLabel(/six-digit code/i).waitFor();
		const code = await getOtpCode(page.request, ADMIN_EMAIL);
		await page.fill('input[name="code"]', code);
		await page.getByRole('button', { name: /verify and sign in/i }).click();
		await page.waitForURL('**/super-admin**');
		await expect(page).toHaveURL(/\/super-admin/);
	});

	test('organizer routes are protected when logged out', async ({ page }) => {
		await page.goto('/organizer/tournaments');
		await expect(page).toHaveURL(/\/login/);
	});

	test('super-admin routes are protected when logged out', async ({ page }) => {
		await page.goto('/super-admin/organizers');
		await expect(page).toHaveURL(/\/login/);
	});

	test('session persistence, JWT hygiene, and real sign-out', async ({ page }) => {
		await requestCode(page, ORGANIZER_EMAIL);
		await page.getByLabel(/six-digit code/i).waitFor();
		const code = await getOtpCode(page.request, ORGANIZER_EMAIL);
		await page.fill('input[name="code"]', code);
		await page.getByRole('button', { name: /verify and sign in/i }).click();
		await page.waitForURL('**/organizer**');

		// Session survives a full reload (httpOnly cookies, no client storage).
		await page.reload();
		await expect(page).toHaveURL(/\/organizer/);

		// No JWT anywhere the browser can read: not in the served HTML or
		// serialized page data (Phase 1 S3 regression, now browser-level)...
		const html = await page.content();
		// A real JWT is three dot-separated base64url segments. (A bare eyJ
		// prefix also matches Vite's dev-mode CSS source maps — base64 '{"'.)
		const jwtShape = /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/;
		expect(html).not.toMatch(jwtShape);
		// ...and not in localStorage/sessionStorage either.
		const storage = await page.evaluate(() =>
			JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } })
		);
		expect(storage).not.toMatch(jwtShape);
		// ...nor the six-digit code itself, ever, in any page payload.
		expect(html).not.toContain(code);

		// Sign out calls the API's real logout (subphase 5.5b), which revokes
		// the session server-side rather than only clearing the cookie —
		// before that, a signed-out browser's refresh token stayed valid for
		// the rest of its 30-day TTL. Prove the session is actually dead, not
		// just that the cookie is gone: reusing the saved storage state must
		// no longer authenticate.
		const deadState = await page.context().storageState();
		await page.getByRole('button', { name: 'Sign out' }).click();
		await page.waitForURL('**/login**');
		await page.goto('/organizer/tournaments');
		await expect(page).toHaveURL(/\/login/);

		const deadContext = await page.context().browser()!.newContext({ storageState: deadState });
		const deadPage = await deadContext.newPage();
		await deadPage.goto('/organizer/tournaments');
		await expect(deadPage).toHaveURL(/\/login/);
		await deadContext.close();
	});
});
