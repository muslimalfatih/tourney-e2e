# tourney-e2e

Browser end-to-end tests for [tourney.social](https://tourney.social) — auth,
public tournament pages, organizer scheduling/scoring workflows, share/QR, and
the presentation-mode deck. Playwright, its own workspace, its own npm tree.

It lives apart from `tourney-web` on purpose: that app's dependency tree was
hitting an Arborist bug, and a suite this size has no business sharing a
`package.json` with the app it tests anyway.

## How it fits together

```
../laga/
  tourney-api/     ← this suite launches a FRESH instance on :8095
  tourney-web/     ← this suite launches a dev server on :4400, pointed at :8095
  tourney-e2e/     ← you are here
```

Both are started and stopped by Playwright itself (`scripts/run-api.sh`,
`scripts/run-web.sh`, wired as `webServer` entries in `playwright.config.ts`).
You do not start them by hand, and this suite never touches whatever copy of
tourney-api you already have running on your usual dev port.

Everything runs **serially, one worker** (`workers: 1`, `fullyParallel: false`):
every spec shares one database and one API process, and the presentation spec
deliberately restarts the API at the very end. Don't parallelize this without
rethinking that.

## Prerequisites

- Node (whatever `tourney-web` requires — see its own `.nvmrc`).
- `tourney-api` and `tourney-web` checked out as sibling directories (see the
  layout above). `scripts/run-api.sh` / `run-web.sh` `cd` into them by
  relative path.
- A local Postgres for this suite alone, migrated and seeded (see below).
  The suite refuses to run against anything that isn't localhost.
- Go, to build/run `tourney-api` (`go run ./cmd/api`).

## Configuration

Copy `.env.example` to `.env` (git-ignores itself) and point it at a database
that exists for this suite and nothing else:

```sh
cp .env.example .env
```

| Variable                                    | Where              | Used for                                                                          |
| ------------------------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `E2E_DATABASE_URL`                          | `tourney-e2e/.env` | The database under test — wiping `e2e-*` rows, and what the API is booted against |
| `SEED_ORGANIZER_EMAIL` / `SEED_ADMIN_EMAIL` | either `.env`      | The seeded accounts `global-setup.ts` signs in as                                 |

Both `helpers/env.ts` and `scripts/run-api.sh` resolve the database the same
way — `E2E_DATABASE_URL` first, then `tourney-api/.env`'s `DATABASE_URL` —
so the test process and the API process can never end up pointed at different
databases.

> [!WARNING]
> **This suite is destructive, and it refuses to run against a non-local
> database.** `global-setup.ts` deletes every `e2e-%` tournament, user and
> invitation via `psql`, then the specs create real tournaments, users and
> sessions. Before the `E2E_DATABASE_URL` override existed, the suite simply
> borrowed `tourney-api/.env`'s `DATABASE_URL` — whatever a given machine
> last pointed it at. Because the wipe is prefix-scoped, running against a
> hosted project would have _quietly succeeded_ and left test data behind in
> it. Both entry points now reject any URL that doesn't resolve to
> `localhost` or `127.0.0.1`, and neither echoes the credentials when they do.

Create and seed that database before the first run:

```sh
createdb tourney_e2e
cd ../tourney-api
DATABASE_URL='postgresql://localhost:5432/tourney_e2e?sslmode=disable' \
  go run ./cmd/migrate up
DATABASE_URL='postgresql://localhost:5432/tourney_e2e?sslmode=disable' \
SEED_ADMIN_EMAIL=admin@laga.test SEED_ORGANIZER_EMAIL=organizer@laga.test \
SEED_ORG_NAME="Laga Demo" SEED_ORG_SLUG=laga-demo \
  go run ./cmd/seed
```

Sign-in is invitation-only OTP, so a seeded account also needs a matching
accepted invitation or it can never log in. `cmd/seed` creates both — that
was a real gap, fixed alongside this suite's OTP update.

`SEED_ORG_SLUG` **must be exactly `laga-demo`** — `cmd/seed/renon.go` looks up
the demo organization by that literal slug (not by an env var) to attach the
"Renon Cup 2026" fixture dataset that `public.spec.ts` and `share.spec.ts`
read. Any other slug and the Renon seed step fails with `demo org missing`,
and both specs then 404 looking for a tournament that was never created —
that failure mode is a seeding mistake, not a suite bug, and it's exactly what
happened the first time this baseline was verified against a fresh scratch
database.

## How sign-in works here

There is no password to type: Phase 5 made sign-in invitation-only email OTP.
`otp_challenges` stores only an irreversible HMAC-SHA256 hash, so no query can
recover a code — a human reads it from an email, and a browser test has no
inbox.

`scripts/run-api.sh` therefore sets `E2E_TEST_MODE=true`, which makes the API
(a) force its fake email sender, so **no test in this suite can send a real
email**, and (b) mount `GET /internal/test/last-otp`, which hands back the
code that fake sender just recorded in memory. `helpers/otp.ts` reads it.

`config.Load()` refuses `E2E_TEST_MODE` alongside `APP_ENV=production`, and
`cmd/api` only mounts the hook when it is set — two independent places would
have to be wrong for this to reach production.

## Ports

| Port   | What                                                                            |
| ------ | ------------------------------------------------------------------------------- |
| `8095` | The e2e-only `tourney-api` instance (never your regular `:8090`/dev one)        |
| `4400` | The e2e-only `tourney-web` dev server, `PUBLIC_API_BASE_URL` pointed at `:8095` |

Both are hardcoded across `playwright.config.ts`, the two `scripts/run-*.sh`
files, and `helpers/env.ts` — change all four together if you ever need to.

## Running

```sh
npm install
npx playwright install chromium   # once, or after a Playwright version bump
npm test                          # headless
npm run test:headed               # watch it drive a real browser window
```

A single spec or grep:

```sh
npx playwright test specs/scoring.spec.ts
npx playwright test -g "walkover"
```

`playwright.config.ts` sets `timeout: 90_000` per test and
`trace: 'retain-on-failure'` — on a failure, open the trace with:

```sh
npx playwright show-trace test-results/<failed-test-dir>/trace.zip
```

## Specs

| File                 | Covers                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin.spec.ts`      | Platform admin: invitations, suspend/reactivate with a reason, the last-super-admin guard, impersonation and exit, mobile layout                                                          |
| `auth.spec.ts`       | Two-step OTP sign-in, uninvited/invalid/wrong-code rejection, session persistence, JWT never leaking to the client, route guards, and that sign-out truly revokes the session server-side |
| `public.spec.ts`     | Public tournament pages — overview/standings/bracket/schedule, draft invisibility, mobile share layout                                                                                    |
| `scheduling.spec.ts` | Courts, slots, conflict detection, short-rest warnings                                                                                                                                    |
| `scoring.spec.ts`    | Set scoring, walkover/retired/cancelled, idempotent rescoring, correction locks                                                                                                           |
| `share.spec.ts`      | Share dialog URL/filters, clipboard copy + fallback, QR download, native share, WhatsApp intent                                                                                           |
| `workflow.spec.ts`   | End-to-end organizer flow: create tournament → division → pairs → fixtures                                                                                                                |
| `z-present.spec.ts`  | Presentation-mode deck: rotation, keyboard, live SSE updates, reconnect after an API restart                                                                                              |

(`z-present` sorts last on purpose — it restarts the shared API instance, so
nothing else may run after it in the same pass.)

## Known limitations

- **One worker, serial.** `workers: 1` and `fullyParallel: false`: the specs
  share one API instance and one database, and `z-present.spec.ts` restarts
  that API. Runtime is ~2–4 minutes.
- **OTP request rate limiting is real, and in-process.** The API allows 3
  requests per email per 10 minutes. `helpers/api.ts` works within that by
  caching the token string that `global-setup.ts` already minted rather than
  signing in per call site. A spec that adds a new sign-in for an existing
  address can still trip it.
- **No real email is ever sent, so delivery is not covered here.** That
  this suite passes says nothing about whether Plunk, DKIM/SPF alignment or
  inbox placement work — that needs a manual send to a real address.
