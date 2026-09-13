import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The e2e suite borrows the API repo's dev env: seeded account emails for UI
// login and DATABASE_URL for test-data cleanup. Values never appear in test
// output.
const API_ENV_PATH = join(__dirname, '..', '..', 'tourney-api', '.env');

function parseEnv(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		out[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return out;
}

const env = parseEnv(API_ENV_PATH);

// This suite is destructive by design: global-setup wipes every e2e-% row and
// the specs then create tournaments, users and sessions for real. It reads its
// connection string out of the API repo's .env, which on a normal dev machine
// is whatever that developer last pointed it at -- including a hosted Supabase
// project. Nothing downstream would complain: the wipe is prefix-scoped, so it
// would quietly succeed against production and leave test data behind in it.
//
// So refuse anything that isn't unmistakably a local database. This is the one
// place every JS entry point (global-setup and each spec) already routes
// through, so one check here covers all of them.
const dbUrl = env.DATABASE_URL ?? '';
if (dbUrl && !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(dbUrl)) {
	const shown = dbUrl.replace(/\/\/[^@]*@/, '//***@');
	throw new Error(
		`refusing to run the e2e suite against a non-local database: ${shown}\n` +
			'It creates and deletes real rows. Point tourney-api/.env at a local ' +
			'Postgres before running this suite.'
	);
}

export const API_ORIGIN = 'http://localhost:8095';
export const API_URL = `${API_ORIGIN}/api/v1`;
export const WEB_URL = 'http://localhost:4400';

// Sign-in is invitation-only OTP since Phase 5 -- there is no password
// anymore. These are just the addresses cmd/seed creates and (since the seed
// fix that shipped alongside this suite's OTP update) gives a matching
// accepted invitation, so each can request and verify a real code.
export const ORGANIZER_EMAIL = env.SEED_ORGANIZER_EMAIL ?? 'organizer@laga.test';
export const ADMIN_EMAIL = env.SEED_ADMIN_EMAIL ?? 'admin@laga.test';
export const DATABASE_URL = dbUrl;

/** Deterministic per-run suffix so parallel humans don't collide; cleaned by slug prefix. */
export const RUN = process.env.E2E_RUN ?? String(process.pid % 100000);
export const slugFor = (name: string) => `e2e-${name}`;
