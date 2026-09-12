import { chromium, type FullConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { DATABASE_URL, WEB_URL, ORGANIZER_EMAIL, ORGANIZER_PASSWORD } from './helpers/env';
import { fillStable } from './helpers/ui';

// Wipe any e2e-created tournaments (cascade removes their divisions, pairs,
// matches, slots), then log in once through the real UI and persist the
// session for every authenticated spec. Only rows with the e2e- slug prefix
// are ever touched — shared demo data (Renon Cup, Bali Open) is read-only.
export function wipeE2EData(): void {
	execFileSync('psql', [DATABASE_URL, '-c', "DELETE FROM tournaments WHERE slug LIKE 'e2e-%'"], {
		stdio: 'pipe'
	});
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
	wipeE2EData();

	mkdirSync('.auth', { recursive: true });
	const browser = await chromium.launch();
	const page = await browser.newPage();
	// The dev server compiles routes on first hit — the whole login sequence
	// retries so a cold-start stall can't sink the run before it begins.
	let ok = false;
	for (let attempt = 0; attempt < 4 && !ok; attempt++) {
		try {
			await page.goto(`${WEB_URL}/login`, { timeout: 60_000 });
			await fillStable(page, 'input[name="email"]', ORGANIZER_EMAIL);
			await page.fill('input[name="password"]', ORGANIZER_PASSWORD);
			await page.click('button[type="submit"]');
			await page.waitForURL('**/organizer**', { timeout: 30_000 });
			ok = true;
		} catch {
			// retry from the top
		}
	}
	if (!ok) throw new Error('global setup: UI login did not complete');
	await page.context().storageState({ path: '.auth/organizer.json' });
	await browser.close();
}
