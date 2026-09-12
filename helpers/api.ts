import { request, type APIRequestContext } from '@playwright/test';
import { API_URL, ORGANIZER_EMAIL, ORGANIZER_PASSWORD } from './env';

// Direct API fixture helpers. UI journeys stay UI-driven; these exist so a
// spec can ARRANGE its scenario (create a division, publish, score a match)
// without re-walking flows that other specs already cover.

export async function apiContext(): Promise<{ ctx: APIRequestContext; token: string }> {
	const ctx = await request.newContext({ baseURL: API_URL });
	const res = await ctx.post(`${API_URL}/auth/login`, {
		data: { email: ORGANIZER_EMAIL, password: ORGANIZER_PASSWORD }
	});
	if (!res.ok()) throw new Error(`API login failed: ${res.status()}`);
	const body = await res.json();
	const token = body.data?.access_token ?? body.access_token;
	if (!token) throw new Error('API login returned no access_token');
	return { ctx, token };
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
