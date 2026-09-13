import { request, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { API_URL, ORGANIZER_EMAIL, ADMIN_EMAIL } from './env';

// Direct API fixture helpers. UI journeys stay UI-driven; these exist so a
// spec can ARRANGE its scenario (create a division, publish, score a match)
// without re-walking flows that other specs already cover.
//
// Signing in is OTP now, rate-limited to 3 requests per email per 10 minutes
// -- and nine call sites across the suite ask for an organizer context. Two
// designs were tried and rejected before this one:
//
//   1. A fresh OTP login per call. Nine call sites, several in separate spec
//      files, blew through the 3-per-10-minutes limit before the run finished.
//   2. Caching the {ctx, token} PAIR across calls. Playwright disposes every
//      APIRequestContext created via the top-level `request` import at the
//      end of the test (or file) it was created in, regardless of a JS-level
//      reference surviving in this module's scope -- so a cached ctx from an
//      earlier file failed with "context has been closed" the moment a later
//      file tried to reuse it.
//
// What actually survives across files is a plain STRING: the access token
// global-setup.ts already minted, read back out of the storageState file it
// wrote. That's cached. The APIRequestContext wrapping it is cheap (no
// network call) and created fresh per call, so it can never outlive the test
// that asked for it.
function tokenFromStorageState(path: string): string {
	const state = JSON.parse(readFileSync(path, 'utf8')) as {
		cookies: { name: string; value: string }[];
	};
	const cookie = state.cookies.find((c) => c.name === 'tourney_at');
	if (!cookie) throw new Error(`no tourney_at cookie in ${path} -- did global-setup run?`);
	return cookie.value;
}

const tokenCache = new Map<string, string>();

function tokenFor(email: string, storagePath: string): string {
	let token = tokenCache.get(email);
	if (!token) {
		token = tokenFromStorageState(storagePath);
		tokenCache.set(email, token);
	}
	return token;
}

async function contextFor(email: string, storagePath: string): Promise<{ ctx: APIRequestContext; token: string }> {
	const ctx = await request.newContext({ baseURL: API_URL });
	return { ctx, token: tokenFor(email, storagePath) };
}

/** An organizer's API context, using the session global-setup.ts already
 *  created. A fresh (but network-free) request context per call, sharing
 *  only the cached token. */
export function apiContext(): Promise<{ ctx: APIRequestContext; token: string }> {
	return contextFor(ORGANIZER_EMAIL, '.auth/organizer.json');
}

/** A super admin's API context — same idea, separate identity. */
export function adminApiContext(): Promise<{ ctx: APIRequestContext; token: string }> {
	return contextFor(ADMIN_EMAIL, '.auth/admin.json');
}

type Json = Record<string, unknown>;

export async function api(
	ctx: APIRequestContext,
	token: string,
	method: 'get' | 'post' | 'patch' | 'delete',
	path: string,
	data?: Json
): Promise<{ status: number; body: Json }> {
	const res = await ctx[method](`${API_URL}${path}`, {
		data,
		headers: { Authorization: `Bearer ${token}` }
	});
	let body: Json = {};
	try {
		body = await res.json();
	} catch {
		// 204s and error pages have no JSON body.
	}
	return { status: res.status(), body };
}

export interface Fixture {
	tournamentId: string;
	slug: string;
	eventId: string;
	participantIds: string[];
}

/** Round-robin division with named pairs under a fresh e2e tournament. */
export async function makeRRTournament(
	ctx: APIRequestContext,
	token: string,
	slug: string,
	pairNames: string[],
	opts: { publish?: boolean } = {}
): Promise<Fixture> {
	const t = await api(ctx, token, 'post', '/tournaments', {
		name: `E2E ${slug}`,
		slug,
		sport: 'tennis'
	});
	if (t.status !== 201) throw new Error(`create tournament ${slug}: ${t.status}`);
	const tournamentId = (t.body.data as Json).id as string;

	const e = await api(ctx, token, 'post', `/tournaments/${tournamentId}/events`, {
		name: 'E2E Division',
		discipline: 'doubles',
		format: 'round_robin'
	});
	if (e.status !== 201) throw new Error(`create division: ${e.status}`);
	const eventId = (e.body.data as Json).id as string;

	const participantIds: string[] = [];
	for (const name of pairNames) {
		const p = await api(ctx, token, 'post', `/events/${eventId}/participants`, {
			display_name: name
		});
		if (p.status !== 201) throw new Error(`add pair: ${p.status}`);
		participantIds.push((p.body.data as Json).id as string);
	}

	if (opts.publish) {
		const pub = await api(ctx, token, 'post', `/tournaments/${tournamentId}/publish`);
		if (pub.status !== 200) throw new Error(`publish: ${pub.status}`);
	}
	return { tournamentId, slug, eventId, participantIds };
}

export async function addFixture(
	ctx: APIRequestContext,
	token: string,
	eventId: string,
	a: string,
	b: string
): Promise<string> {
	const r = await api(ctx, token, 'post', `/events/${eventId}/matches`, {
		team_a_id: a,
		team_b_id: b
	});
	if (r.status !== 201) throw new Error(`add fixture: ${r.status}`);
	return (r.body.data as Json).id as string;
}

export async function scoreNormal(
	ctx: APIRequestContext,
	token: string,
	matchId: string,
	gamesA = 6,
	gamesB = 0
): Promise<void> {
	const r = await api(ctx, token, 'patch', `/matches/${matchId}/score`, {
		sets: [
			{ set_number: 1, games_a: gamesA, games_b: gamesB },
			{ set_number: 2, games_a: gamesA, games_b: gamesB }
		],
		completion: 'normal'
	});
	if (r.status !== 200) throw new Error(`score: ${r.status} ${JSON.stringify(r.body)}`);
}
