import { expect, type Locator, type Page } from '@playwright/test';
import { getOtpCode } from './otp';

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

/** Open a dropdown menu until its items actually exist.
 *
 *  Same hydration race as openDialogVia: a click that lands before the
 *  component has hydrated focuses the trigger and runs no handler, so the menu
 *  never opens and the wait for a menuitem burns the whole test timeout on a
 *  page that looks perfectly fine in the trace. Retrying the trigger is what
 *  distinguishes "not hydrated yet" from "this menu has no such item". */
export async function openMenuVia(
	page: Page,
	trigger: Locator
): Promise<ReturnType<Page['getByRole']>> {
	await expect(async () => {
		await trigger.click();
		await expect(page.getByRole('menuitem').first()).toBeVisible({ timeout: 1_500 });
	}).toPass({ timeout: 20_000 });
	return page.getByRole('menu');
}

/** Click a tab until it actually selects (same hydration race). A RegExp is
 *  useful when the tab's label carries a live count that a test can't pin to
 *  an exact number (e.g. "Users (4)"). */
export async function clickTab(page: Page, name: string | RegExp): Promise<void> {
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
 * stale (refresh-token rotation is single-use), sign back in through the
 * real OTP flow rather than reusing a stored session. */
export async function gotoAuthed(page: Page, path: string, email: string): Promise<void> {
	await page.goto(path);
	if (/\/login/.test(page.url())) {
		await fillStable(page, 'input[name="email"]', email);
		await page.getByRole('button', { name: 'Continue' }).click();
		await page.getByLabel(/six-digit code/i).waitFor({ timeout: 15_000 });
		const code = await getOtpCode(page.request, email);
		await page.fill('input[name="code"]', code);
		await page.getByRole('button', { name: /verify and sign in/i }).click();
		await page.waitForURL('**/organizer**');
		await page.goto(path);
	}
}
