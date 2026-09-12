import { test, expect } from '@playwright/test';
import { expectToast } from '../helpers/ui';

// Journey 6 — the share dialog: exact + filter-preserving URLs, copy with
// success AND fallback states, QR downloads, native share, and the social
// intents. External sites are never launched — window.open is intercepted.
// Real-device QR scanning is inherently manual (see the report's limitations);
// the encoder itself is verified byte-identical to upstream in unit tests.
test.use({ storageState: { cookies: [], origins: [] } });

async function openShare(page: import('@playwright/test').Page) {
	await page.getByRole('button', { name: 'Share this view' }).click();
	return page.getByRole('dialog');
}

test('the dialog carries the exact current URL and preserves public filters only', async ({
	page
}) => {
	// Legacy filter URLs redirect to the canonical division path; junk params
	// are carried through navigation but must never reach the share URL.
	await page.goto('/tournaments/renon-cup-2026/bracket?category=Beginner&utm_source=x&debug=1');
	await page.waitForURL('**/tournaments/renon-cup-2026/**');
	const dialog = await openShare(page);
	const url = await dialog.locator('#share-url').inputValue();

	const current = new URL(page.url());
	const expected = new URL(current.pathname, 'http://localhost:4400');
	for (const k of ['event', 'category', 'gender', 'phase']) {
		const v = current.searchParams.get(k);
		if (v) expected.searchParams.set(k, v);
	}
	expect(url).toBe(expected.toString());
	expect(url).not.toContain('utm_source');
	expect(url).not.toContain('debug');
	expect(url).not.toContain('8095'); // never the API origin
	// The QR is rendered from the same string.
	await expect(dialog.locator('svg[role="img"]')).toBeVisible();
});

test('copy succeeds with clipboard access', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await page.goto('/tournaments/renon-cup-2026');
	const dialog = await openShare(page);
	await dialog.getByRole('button', { name: 'Copy link' }).click();
	await expectToast(page, 'Link copied');
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toBe(await dialog.locator('#share-url').inputValue());
});

test('clipboard failure falls back to select-and-instruct, never a dead end', async ({
	page
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: () => Promise.reject(new Error('denied')) }
		});
	});
	await page.goto('/tournaments/renon-cup-2026');
	const dialog = await openShare(page);
	await dialog.getByRole('button', { name: 'Copy link' }).click();
	await expectToast(page, /press ctrl/i);
	// The URL is selected, one keystroke from copied.
	const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
	expect(selected).toContain('/tournaments/renon-cup-2026');
});

test('QR downloads as a named PNG', async ({ page }) => {
	await page.goto('/tournaments/renon-cup-2026');
	const dialog = await openShare(page);

	const png = page.waitForEvent('download');
	await dialog.getByRole('button', { name: 'Download QR' }).click();
	expect((await png).suggestedFilename()).toMatch(/qr\.png$/);
});

test('native share is offered when the platform has it, and receives the URL', async ({
	page
}) => {
	await page.addInitScript(() => {
		(window as unknown as { __shared: unknown[] }).__shared = [];
		Object.defineProperty(navigator, 'share', {
			value: (data: unknown) => {
				(window as unknown as { __shared: unknown[] }).__shared.push(data);
				return Promise.resolve();
			}
		});
	});
	await page.goto('/tournaments/renon-cup-2026');
	const dialog = await openShare(page);
	await dialog.getByRole('button', { name: 'Share…' }).click();
	const shared = await page.evaluate(
		() => (window as unknown as { __shared: { url?: string }[] }).__shared
	);
	expect(shared[0]?.url).toBe(await dialog.locator('#share-url').inputValue());
});

test('the WhatsApp intent wraps the exact URL', async ({ page }) => {
	await page.addInitScript(() => {
		(window as unknown as { __opened: string[] }).__opened = [];
		window.open = ((u: string) => {
			(window as unknown as { __opened: string[] }).__opened.push(String(u));
			return null;
		}) as typeof window.open;
	});
	await page.goto('/tournaments/renon-cup-2026');
	const dialog = await openShare(page);
	await dialog.getByRole('button', { name: 'WhatsApp' }).click();
	const opened = await page.evaluate(
		() => (window as unknown as { __opened: string[] }).__opened
	);
	expect(opened[0]).toContain('wa.me');
	expect(decodeURIComponent(opened[0])).toContain('/tournaments/renon-cup-2026');
});
