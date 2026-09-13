import type { APIRequestContext } from '@playwright/test';
import { API_ORIGIN } from './env';

/**
 * Reads back the code the API just issued for `email`, via the test-only
 * hook mounted at /internal/test/last-otp (internal/testhooks in
 * tourney-api). That route only exists when E2E_TEST_MODE=true --
 * scripts/run-api.sh sets it -- and it reads back whatever the FakeSender
 * E2E_TEST_MODE forces has recorded in this process's memory. There is no
 * other way to get here: otp_challenges stores nothing but an irreversible
 * hash, by design (see tourney-api's internal/auth/otp.go).
 *
 * Polls briefly. The request that triggers the code (a form submit or an API
 * call) and this read are two separate round trips, so a handful of retries
 * absorbs ordinary ordering wobble without masking a real failure -- if the
 * code never shows up, that is worth failing loudly on, not retrying forever.
 */
export async function getOtpCode(ctx: APIRequestContext, email: string): Promise<string> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const res = await ctx.get(`${API_ORIGIN}/internal/test/last-otp`, { params: { email } });
		if (res.ok()) {
			const body = await res.json();
			if (body.code) return body.code as string;
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`no OTP code recorded for ${email} after retrying -- is E2E_TEST_MODE set?`);
}
