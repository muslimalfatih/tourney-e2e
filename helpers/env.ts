import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The e2e suite borrows the API repo's dev env: seeded organizer credentials
// for UI login and DATABASE_URL for test-data cleanup. Values never appear in
// test output.
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

export const API_URL = 'http://localhost:8095/api/v1';
export const WEB_URL = 'http://localhost:4400';
export const ORGANIZER_EMAIL = env.SEED_ORGANIZER_EMAIL ?? 'organizer@laga.test';
export const ORGANIZER_PASSWORD = env.SEED_ORGANIZER_PASSWORD ?? '';
export const DATABASE_URL = env.DATABASE_URL ?? '';

/** Deterministic per-run suffix so parallel humans don't collide; cleaned by slug prefix. */
export const RUN = process.env.E2E_RUN ?? String(process.pid % 100000);
export const slugFor = (name: string) => `e2e-${name}`;
