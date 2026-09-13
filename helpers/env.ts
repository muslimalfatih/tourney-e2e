import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The e2e suite borrows the API repo's dev env: seeded account emails for UI
// login and DATABASE_URL for test-data cleanup. Values never appear in test
// output.
const API_ENV_PATH = join(__dirname, "..", "..", "tourney-api", ".env");
const E2E_ENV_PATH = join(__dirname, "..", ".env");

function parseEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const env = parseEnv(API_ENV_PATH);
// tourney-e2e/.env is optional and git-ignores itself; when present it wins,
// because it describes THIS suite rather than the API's own dev setup.
const e2eEnv = existsSync(E2E_ENV_PATH) ? parseEnv(E2E_ENV_PATH) : {};

// This suite is destructive by design: global-setup wipes every e2e-% row and
// the specs then create tournaments, users and sessions for real. Borrowing
// the API repo's DATABASE_URL meant borrowing whatever that developer last
// pointed it at -- on most machines, the hosted project they develop against.
// Nothing downstream would have complained: the wipe is prefix-scoped, so it
// would quietly succeed against production and leave test data behind in it.
//
// So the suite takes its own E2E_DATABASE_URL first, and refuses anything that
// isn't unmistakably local. scripts/run-api.sh resolves it in exactly the same
// order, so the API process and the test process cannot disagree about which
// database is under test. This is the one module every JS entry point
// (global-setup and each spec) already imports, so one check here covers them.
const dbUrl =
  e2eEnv.E2E_DATABASE_URL ??
  process.env.E2E_DATABASE_URL ??
  env.DATABASE_URL ??
  "";
if (dbUrl && !/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(dbUrl)) {
  const shown = dbUrl.replace(/\/\/[^@]*@/, "//***@");
  throw new Error(
    `refusing to run the e2e suite against a non-local database: ${shown}\n` +
      "It creates and deletes real rows. Set E2E_DATABASE_URL in " +
      "tourney-e2e/.env to a local Postgres -- see .env.example.",
  );
}

export const API_ORIGIN = "http://localhost:8095";
export const API_URL = `${API_ORIGIN}/api/v1`;
export const WEB_URL = "http://localhost:4400";

// Sign-in is invitation-only OTP since Phase 5 -- there is no password
// anymore. These are just the addresses cmd/seed creates and (since the seed
// fix that shipped alongside this suite's OTP update) gives a matching
// accepted invitation, so each can request and verify a real code.
export const ORGANIZER_EMAIL =
  e2eEnv.SEED_ORGANIZER_EMAIL ??
  env.SEED_ORGANIZER_EMAIL ??
  "organizer@laga.test";
export const ADMIN_EMAIL =
  e2eEnv.SEED_ADMIN_EMAIL ?? env.SEED_ADMIN_EMAIL ?? "admin@laga.test";
export const DATABASE_URL = dbUrl;

/** Deterministic per-run suffix so parallel humans don't collide; cleaned by slug prefix. */
export const RUN = process.env.E2E_RUN ?? String(process.pid % 100000);
export const slugFor = (name: string) => `e2e-${name}`;
