import { expect, type Page } from '@playwright/test';

// SvelteKit hydration re-renders value-bound inputs shortly after load, which
// can wipe a fill that landed too early. fillStable retries until the value
// SURVIVES a settle window — i.e. hydration is done and the text stuck.
export async function fillStable(page: Page, selector: string, value: string): Promise<void> {
	const input = page.locator(selector);
	await expect(async () => {
		await input.fill(value);
		expect(await input.inputValue()).toBe(value);
		await page.waitForTimeout(200);
		expect(await input.inputValue()).toBe(value);
	}).toPass({ timeout: 15_000 });
}

/** Click a control until the dialog it opens is actually visible — clicks
 * that land before hydration focus the button but run no handler. */
export async function openDialogVia(
	page: Page,
	click: () => Promise<void>
): Promise<ReturnType<Page['getByRole']>> {
	await expect(async () => {
		await click();
		await expect(page.getByRole('dialog')).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 20_000 });
	return page.getByRole('dialog');
}

/** Click a tab until it actually selects (same hydration race). */
export async function clickTab(page: Page, name: string): Promise<void> {
	const tab = page.getByRole('tab', { name });
	await expect(async () => {
		await tab.click();
		await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 1_000 });
	}).toPass({ timeout: 20_000 });
}

/** Toast titles render twice in the DOM (visible + live region) — assert the
 * first match to stay strict-mode clean. */
export async function expectToast(page: Page, text: string | RegExp): Promise<void> {
	await expect(page.getByText(text).first()).toBeVisible();
}

/** Navigate to an authenticated page; if the shared storage state has gone
 * stale (refresh-token rotation is single-use), log back in through the UI. */
export async function gotoAuthed(
	page: Page,
	path: string,
	creds: { email: string; password: string }
): Promise<void> {
	await page.goto(path);
	if (/\/login/.test(page.url())) {
		await fillStable(page, 'input[name="email"]', creds.email);
		await page.fill('input[name="password"]', creds.password);
		await page.click('button[type="submit"]');
		await page.waitForURL('**/organizer**');
		await page.goto(path);
	}
}
