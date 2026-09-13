import { test, expect, type Page, type Locator } from '@playwright/test';
import { apiContext, adminApiContext, api } from '../helpers/api';
import { getOtpCode } from '../helpers/otp';
import { openDialogVia, expectToast, clickTab } from '../helpers/ui';
import { RUN, API_URL, WEB_URL } from '../helpers/env';

// Journey — the platform control center: invitations, user management,
// impersonation, and force actions. Runs as the seeded super admin
// (.auth/admin.json from global-setup.ts).
test.use({ storageState: '.auth/admin.json' });

const invitee = () => `e2e-admin-${RUN}-${Date.now()}@example.com`;

/** Clicks a bits-ui Select's trigger (a plain button named by its current
 *  label or placeholder) and picks an option by visible text. Mirrors the
 *  pattern already proven in workflow.spec.ts, with one addition: a Select
 *  given a `name` (for native form submission) also renders a hidden native
 *  <select><option> mirror for accessibility/native-picker support, and that
 *  mirror's <option> elements carry role="option" too — invisible, so a plain
 *  getByRole('option') click hangs forever on the wrong element. `:visible`
 *  scopes to the one a human could actually click. */
async function pick(scope: Locator, triggerName: string | RegExp, optionName?: string | RegExp) {
	await scope.getByRole('button', { name: triggerName }).click();
	const options = scope.page().locator('[role="option"]:visible');
	if (optionName) await options.filter({ hasText: optionName }).first().click();
	else await options.first().click();
}

/** Signs a freshly invited address in via the real OTP form, in its own page
 *  so it never disturbs the admin session driving the rest of the test. */
async function signInAsNewOrganizer(page: Page, email: string): Promise<void> {
	await page.goto('/login');
	await page.fill('input[name="email"]', email);
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.getByLabel(/six-digit code/i).waitFor();
	const code = await getOtpCode(page.request, email);
	await page.fill('input[name="code"]', code);
	await page.getByRole('button', { name: /verify and sign in/i }).click();
	await page.waitForURL('**/organizer**');
}

/** Invites `email` as an organizer directly via the API, into whichever
 *  organization the platform already has — the e2e suite has no business
 *  assuming a specific seeded org name, only that at least one exists. */
async function inviteOrganizer(email: string): Promise<void> {
	const { ctx, token } = await adminApiContext();
	const orgs = (await api(ctx, token, 'get', '/admin/organizations')).body.data as { id: string }[];
	if (orgs.length === 0) throw new Error('no organization exists to invite an organizer into');
	const res = await api(ctx, token, 'post', '/admin/invitations', {
		email,
		role: 'organizer',
		organization_id: orgs[0].id
	});
	if (res.status !== 201) throw new Error(`invite ${email}: ${res.status} ${JSON.stringify(res.body)}`);
}

test.describe('platform administration', () => {
	test('organizer session is refused by every /admin/* API route', async () => {
		// The UI hiding nav links is convenience, not protection — this is the
		// boundary that actually matters.
		const { ctx, token } = await apiContext();
		for (const path of ['/admin/overview', '/admin/users', '/admin/invitations', '/admin/audit-logs']) {
			const res = await api(ctx, token, 'get', path);
			expect(res.status, `organizer token on ${path}`).toBe(403);
		}
	});

	test('invitation create → resend → revoke, each behind its own confirmation', async ({ page }) => {
		const email = invitee();
		await page.goto('/super-admin/invitations');

		const createDialog = await openDialogVia(page, () =>
			page.getByRole('button', { name: 'Invite' }).click()
		);
		await createDialog.locator('input[name="email"]').fill(email);
		// Role defaults to Organizer; pick whichever organization exists.
		await pick(createDialog, /choose an organization/i);
		await createDialog.getByRole('button', { name: 'Send invitation' }).click();
		await expectToast(page, 'Invitation sent');
		await expect(page.locator('body')).toContainText(email);

		// Resend — its own confirmation, not fired straight from the row menu.
		const row = page.locator('tr', { hasText: email });
		await row.getByRole('button', { name: 'Row actions' }).click();
		await page.getByRole('menuitem', { name: 'Resend' }).click();
		await page.getByRole('button', { name: 'Confirm resend' }).click();
		await expectToast(page, 'Invitation resent');

		// Revoke — confirmed, then verified dead at the API: the revoked
		// address can no longer even request a code.
		await row.getByRole('button', { name: 'Row actions' }).click();
		await page.getByRole('menuitem', { name: 'Revoke' }).click();
		await page.getByRole('button', { name: 'Confirm revoke' }).click();
		await expectToast(page, 'Invitation revoked');

		const revokedCheck = await (await apiContext()).ctx.post(`${API_URL}/auth/otp/request`, {
			data: { email }
		});
		expect(revokedCheck.status()).toBe(403);
	});

	test('creating a super_admin invitation requires the extra acknowledgement checkbox', async ({ page }) => {
		await page.goto('/super-admin/invitations');
		const dialog = await openDialogVia(page, () => page.getByRole('button', { name: 'Invite' }).click());
		await dialog.locator('input[name="email"]').fill(invitee());
		await pick(dialog, 'Organizer', 'Super Admin');

		const submit = dialog.getByRole('button', { name: /invite as super admin/i });
		await expect(submit).toBeDisabled();
		await dialog.locator('input[type="checkbox"]').check();
		await expect(submit).toBeEnabled();
		// Proves the gate exists without submitting — no need to leave a stray
		// super_admin invitation behind for later tests to trip over.
		await page.keyboard.press('Escape');
	});

	test('suspend and reactivate an organizer, each with a mandatory reason', async ({ page }) => {
		const email = invitee();
		await inviteOrganizer(email);
		// A page opened via browser.newPage() implicitly creates its OWN browser
		// context. Closing only the page (as an earlier draft did) leaks that
		// context for the rest of the run -- with several tests each opening
		// one of these, the accumulation was almost certainly why the LAST test
		// in this file (a plain viewport/overflow check) once measured a
		// spurious 137px overflow: not a layout bug, a resource-starved browser
		// slowing every subsequent page's render. Closing the context closes
		// the page inside it too.
		// browser.newContext() called from inside a test inherits this file's
		// `use`/test.use() options by default -- including storageState. Without
		// overriding it here, this "fresh" context silently started out already
		// signed in as the ADMIN (.auth/admin.json, from this file's own
		// test.use()), so goto('/login') just redirected straight back to
		// /super-admin and the email input this function waits for never
		// existed on the page it was actually looking at. baseURL needs the
		// same explicit override, since it isn't applied to a manually-created
		// context either.
		const setupContext = await page.context().browser()!.newContext({
			baseURL: WEB_URL,
			storageState: undefined
		});
		const setup = await setupContext.newPage();
		await signInAsNewOrganizer(setup, email);
		await setupContext.close();

		await page.goto('/super-admin/organizers');
		await clickTab(page, /Users/);
		const row = page.locator('tr', { hasText: email });
		await expect(row).toBeVisible();

		await row.getByRole('button', { name: 'Row actions' }).click();
		await page.getByRole('menuitem', { name: 'Suspend' }).click();
		const suspendDialog = page.getByRole('dialog');
		const suspendSubmit = suspendDialog.getByRole('button', { name: 'Confirm suspend' });
		await expect(suspendSubmit).toBeDisabled();
		await suspendDialog.locator('textarea[name="reason"]').fill('e2e suspension check');
		await suspendSubmit.click();
		await expectToast(page, 'Account suspended');
		await expect(row.getByText('suspended', { exact: true })).toBeVisible();

		await row.getByRole('button', { name: 'Row actions' }).click();
		await page.getByRole('menuitem', { name: 'Reactivate' }).click();
		const reactivateDialog = page.getByRole('dialog');
		await reactivateDialog.locator('textarea[name="reason"]').fill('e2e reactivation check');
		await reactivateDialog.getByRole('button', { name: 'Confirm reactivate' }).click();
		await expectToast(page, 'Account reactivated');
		await expect(row.getByText('active', { exact: true })).toBeVisible();
	});

	test('impersonation: banner, organizer access, exit restores the admin — no JWT ever visible', async ({
		page
	}) => {
		const email = invitee();
		await inviteOrganizer(email);
		// A page opened via browser.newPage() implicitly creates its OWN browser
		// context. Closing only the page (as an earlier draft did) leaks that
		// context for the rest of the run -- with several tests each opening
		// one of these, the accumulation was almost certainly why the LAST test
		// in this file (a plain viewport/overflow check) once measured a
		// spurious 137px overflow: not a layout bug, a resource-starved browser
		// slowing every subsequent page's render. Closing the context closes
		// the page inside it too.
		// browser.newContext() called from inside a test inherits this file's
		// `use`/test.use() options by default -- including storageState. Without
		// overriding it here, this "fresh" context silently started out already
		// signed in as the ADMIN (.auth/admin.json, from this file's own
		// test.use()), so goto('/login') just redirected straight back to
		// /super-admin and the email input this function waits for never
		// existed on the page it was actually looking at. baseURL needs the
		// same explicit override, since it isn't applied to a manually-created
		// context either.
		const setupContext = await page.context().browser()!.newContext({
			baseURL: WEB_URL,
			storageState: undefined
		});
		const setup = await setupContext.newPage();
		await signInAsNewOrganizer(setup, email);
		await setupContext.close();

		await page.goto('/super-admin/organizers');
		await clickTab(page, /Users/);
		const row = page.locator('tr', { hasText: email });
		await row.getByRole('button', { name: 'Row actions' }).click();
		await page.getByRole('menuitem', { name: 'Impersonate' }).click();
		await page.getByRole('button', { name: 'Start impersonation' }).click();

		// Lands in the ORGANIZER dashboard, under a borrowed identity.
		await page.waitForURL('**/organizer**');
		const banner = page.getByRole('status');
		await expect(banner).toContainText(email);
		await expect(banner).toContainText('Exit impersonation');

		// No super-admin navigation while impersonating — the nav is derived
		// from role, and /me reports role: organizer for this session, so
		// there is nothing separate to hide.
		await expect(page.getByRole('link', { name: 'Invitations' })).toHaveCount(0);
		// The organizer dashboard actually works, not just the shell.
		await expect(page.getByRole('link', { name: 'Tournaments' })).toBeVisible();

		const html = await page.content();
		expect(html).not.toMatch(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/);

		// Exit is a distinct control from Sign out, and restores the ADMIN
		// dashboard, not a re-login screen.
		await banner.getByRole('button', { name: 'Exit impersonation' }).click();
		await page.waitForURL('**/super-admin**');
		await expect(page.getByRole('link', { name: 'Invitations' })).toBeVisible();
		await expect(page.getByRole('status')).toHaveCount(0);
	});

	test('force-unpublish a tournament requires a reason before the button enables', async ({ page }) => {
		await page.goto('/super-admin/tournaments');
		const row = page.locator('tbody tr').first();
		await row.getByRole('button', { name: 'Row actions' }).click();
		// Whichever force action this row offers first — publish or unpublish —
		// the reason gate applies identically.
		const forceItem = page.getByRole('menuitem', { name: /force (publish|unpublish)/i }).first();
		await forceItem.click();

		const dialog = page.getByRole('dialog');
		const submit = dialog.getByRole('button', { name: /^Confirm/ });
		await expect(submit).toBeDisabled();
		await dialog.locator('textarea[name="reason"]').fill('e2e reason-required check');
		await expect(submit).toBeEnabled();
		// Escape rather than submit — don't flip the shared demo tournament's
		// public visibility, which public.spec.ts depends on staying published.
		await page.keyboard.press('Escape');
	});

	test('the platform admin layout has no horizontal overflow on a phone-width viewport', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto('/super-admin');
		// Measuring immediately after goto() races Svelte's hydration re-render
		// (the same class of race fillStable exists for) and can catch a
		// transient pre-layout width. Waiting on a real element settles it,
		// matching the proven pattern in public.spec.ts's own mobile checks.
		await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible();
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow).toBeLessThanOrEqual(1);
	});
});
