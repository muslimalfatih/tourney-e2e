import { chromium, type Browser, type FullConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { DATABASE_URL, WEB_URL, ORGANIZER_EMAIL, ADMIN_EMAIL } from './helpers/env';
import { fillStable } from './helpers/ui';
import { getOtpCode } from './helpers/otp';

// Wipe any e2e-created data, then log in twice through the real OTP UI —
// once as the seeded organizer, once as the seeded super admin — and persist
// both sessions for the specs that need them. Only rows tagged e2e-* are ever
// touched; shared demo data (Renon Cup, Bali Open) is read-only.
export function wipeE2EData(): void {
	execFileSync(
		'psql',
		[
			DATABASE_URL,
			'-c',
			"DELETE FROM tournaments WHERE slug LIKE 'e2e-%'; " +
				"DELETE FROM invitations WHERE email LIKE 'e2e-%'; " +
				"DELETE FROM users WHERE email LIKE 'e2e-%'"
		],
		{ stdio: 'pipe' }
	);
}

// Signs in through the real two-step OTP form and saves the resulting
// session. The code comes from the /internal/test/last-otp hook — the only
// way to read one back, since otp_challenges stores nothing but an
// irreversible hash by design. Retries the whole walk, not just one step: a
// SvelteKit dev server compiles routes on first hit, and a cold-start stall
// anywhere in the sequence shouldn't sink the run before it begins.
async function otpLoginAndSave(
	browser: Browser,
	email: string,
	storagePath: string,
	landingUrlPattern: RegExp
): Promise<void> {
	const page = await browser.newPage();
	let ok = false;
	for (let attempt = 0; attempt < 4 && !ok; attempt++) {
		try {
			await page.goto(`${WEB_URL}/login`, { timeout: 60_000 });
			await fillStable(page, 'input[name="email"]', email);
			await page.getByRole('button', { name: 'Continue' }).click();
			await page.getByLabel(/six-digit code/i).waitFor({ timeout: 15_000 });
			const code = await getOtpCode(page.request, email);
			await page.fill('input[name="code"]', code);
			await page.getByRole('button', { name: /verify and sign in/i }).click();
			await page.waitForURL(landingUrlPattern, { timeout: 30_000 });
			ok = true;
		} catch {
			// retry from the top
		}
	}
	if (!ok) throw new Error(`global setup: OTP login did not complete for ${email}`);
	await page.context().storageState({ path: storagePath });
	await page.close();
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
	wipeE2EData();
	mkdirSync('.auth', { recursive: true });

	const browser = await chromium.launch();
	// Both logins hit the SAME OTP request-rate limit (3 per email per 10
	// minutes) as everything else in the suite, but each email is used here
	// exactly once, so this alone never comes close to it.
	await otpLoginAndSave(browser, ORGANIZER_EMAIL, '.auth/organizer.json', /\/organizer/);
	await otpLoginAndSave(browser, ADMIN_EMAIL, '.auth/admin.json', /\/super-admin/);
	await browser.close();
}
