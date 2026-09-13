# tourney-e2e

Browser end-to-end tests for [tourney.social](https://tourney.social), a tournament platform for tennis and padel.

44 tests across 8 suites, driven through a real Chromium browser against a real API and a real database. They cover invitation-only OTP sign-in, the public tournament pages, the organizer scheduling and scoring workflows, sharing and QR, platform administration, and the presentation-mode deck.

Built with [Playwright](https://playwright.dev). This repository is a standalone workspace: it has its own dependency tree and never shares a `package.json` with the application it tests.

## Quick start

You need [Node](https://nodejs.org) 24.10, [Go](https://go.dev) 1.25, and a local PostgreSQL. Check out `tourney-api` and `tourney-web` as sibling directories first — the launch scripts reach them by relative path.

```sh
# 1. Create a database that belongs to this suite alone
createdb tourney_e2e

# 2. Migrate and seed it
cd ../tourney-api
DATABASE_URL='postgresql://localhost:5432/tourney_e2e?sslmode=disable' go run ./cmd/migrate up
DATABASE_URL='postgresql://localhost:5432/tourney_e2e?sslmode=disable' \
  SEED_ADMIN_EMAIL=admin@laga.test \
  SEED_ORGANIZER_EMAIL=organizer@laga.test \
  SEED_ORG_NAME="Laga Demo" \
  SEED_ORG_SLUG=laga-demo \
  go run ./cmd/seed

# 3. Point the suite at it
cd ../tourney-e2e
cp .env.example .env          # then set E2E_DATABASE_URL

# 4. Run
npm install
npx playwright install chromium
npm test
```

A full run takes two to four minutes.

> [!WARNING]
> **These tests are destructive.** Setup deletes every `e2e-%` tournament, user, and invitation, and the suites then create real records. Give the suite a database of its own. Both entry points refuse any `E2E_DATABASE_URL` that does not resolve to `localhost` or `127.0.0.1`, and neither prints the credentials when they reject one.

## How it works

Playwright starts and stops everything. You never launch a server by hand.

```
laga/
├── tourney-api/     Go API — a fresh instance on :8095
├── tourney-web/     SvelteKit app — a dev server on :4400, pointed at :8095
└── tourney-e2e/     this repository
```

| Port   | Process                                                             |
| ------ | ------------------------------------------------------------------- |
| `8095` | The API instance for this suite, never your usual `:8090` dev server |
| `4400` | The web dev server for this suite, never your usual `:5173`          |

Both ports are hardcoded in `playwright.config.ts`, the two scripts under `scripts/`, and `helpers/env.ts`. Change all four together.

Tests run **serially on one worker**. Every suite shares one database and one API process, and `z-present.spec.ts` restarts that API to test reconnection — which is why it sorts last. Parallelizing requires giving each worker its own database and API instance.

## Configuration

Copy `.env.example` to `.env`. Git ignores it.

| Variable                                    | Purpose                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `E2E_DATABASE_URL`                          | The database under test, and what the API is booted against        |
| `SEED_ADMIN_EMAIL` / `SEED_ORGANIZER_EMAIL` | The seeded accounts that setup signs in as                         |

`helpers/env.ts` and `scripts/run-api.sh` resolve the database identically — `E2E_DATABASE_URL` first, then `tourney-api/.env`'s `DATABASE_URL` — so the test process and the API process cannot end up pointed at different databases.

Pin the account addresses in this repository's `.env` rather than letting them fall through to `tourney-api/.env`. That file describes a developer's own setup and changes when they repoint it.

## Sign-in and the OTP test hook

There is no password. Sign-in is invitation-only: you enter an email address, the API emails a six-digit code, and you enter that code.

This creates a problem for automation. The `otp_challenges` table stores only an irreversible HMAC-SHA256 hash of each code, deliberately, so no query can recover one. A person reads the code from an email; a browser test has no inbox.

`scripts/run-api.sh` therefore sets `E2E_TEST_MODE=true`, which makes the API do two things:

1. Force its fake email sender, so **no test in this suite can send a real email** — even with a live provider key in the environment.
2. Mount `GET /internal/test/last-otp`, which returns the code that fake sender just recorded in memory. `helpers/otp.ts` reads it.

The API refuses to start with `E2E_TEST_MODE` and `APP_ENV=production` set together, and only mounts the hook when the flag is on. Two independent guards would have to fail for this to reach production.

## Test suites

| Suite                | Tests | Covers                                                                                                      |
| -------------------- | ----: | ----------------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`       |     8 | Two-step OTP sign-in, rejection of uninvited and invalid input, session persistence, route guards, and that signing out revokes the session server-side |
| `admin.spec.ts`      |     7 | Invitations, suspension and reactivation with a mandatory reason, the last-super-admin guard, impersonation and exit, mobile layout |
| `public.spec.ts`     |     6 | Public tournament pages, draft invisibility, mobile share layout                                            |
| `scoring.spec.ts`    |     6 | Set scoring, walkover, retirement, cancellation, idempotent rescoring, correction locks                     |
| `share.spec.ts`      |     6 | Share dialog URLs and filters, clipboard copy and its fallback, QR download, native share, WhatsApp intent   |
| `scheduling.spec.ts` |     4 | Courts, slots, conflict detection, short-rest warnings                                                      |
| `workflow.spec.ts`   |     4 | Creating a tournament, division, pairs, and fixtures end to end                                             |
| `z-present.spec.ts`  |     3 | Presentation deck rotation, keyboard control, live updates over SSE, reconnection after an API restart      |

## Running tests

```sh
npm test                 # headless
npm run test:headed      # watch a real browser window

npx playwright test specs/scoring.spec.ts    # one suite
npx playwright test -g "walkover"            # one test by name
```

Each test gets 90 seconds; each assertion gets 10. Traces are kept for failures only:

```sh
npx playwright show-trace test-results/<failed-test>/trace.zip
```

## Troubleshooting

**`public.spec.ts` and `share.spec.ts` fail with 404s.** The seed ran with the wrong organization slug. `cmd/seed/renon.go` looks up the demo organization by the literal string `laga-demo`, not by an environment variable, and skips the "Renon Cup 2026" fixture dataset when it cannot find it. Reseed with `SEED_ORG_SLUG=laga-demo`.

**Setup fails with `OTP login did not complete`.** The addresses in `.env` do not match accounts in the database. Every account needs a matching accepted invitation to sign in; `cmd/seed` creates both. Confirm with `psql "$E2E_DATABASE_URL" -c 'table users'`.

**A suite fails with HTTP 429.** The API allows three code requests per email per ten minutes, and the limit is real. Setup mints one session per account and `helpers/api.ts` reuses that token rather than signing in again, so a new sign-in for an address already used in the run can exhaust it. Use a fresh address, or wait.

**The run refuses to start, citing a non-local database.** Working as intended. Set `E2E_DATABASE_URL` to a local database.

**A new test cannot find an element that is clearly on the page.** Two known causes. Components hydrate after the first paint, so a click can land before the handler exists: it focuses the control, runs nothing, and the wait that follows burns the whole timeout on a page that looks correct in the trace. Use the retrying helpers in `helpers/ui.ts` — `fillStable`, `clickTab`, `openDialogVia`, `openMenuVia` — rather than a bare `click()`. Separately, a `bits-ui` select with a `name` also renders a hidden native `<select>`, so `getByRole('option')` matches twice; scope to `[role="option"]:visible`.

**A context created with `browser.newContext()` is unexpectedly signed in.** Contexts created inside a test inherit that file's `test.use()` options, including `storageState`. Pass `storageState: undefined` and `baseURL` explicitly.

## Limitations

- **Delivery is not covered.** No test sends a real email, so a passing run says nothing about the email provider, DKIM and SPF alignment, or inbox placement. Verify those with a real send.
- **One browser.** Desktop Chromium at 1280×800, plus explicit mobile viewport checks inside some suites. No Firefox or WebKit.
- **No retries.** `retries: 0`, so a flaky test fails the run. That is deliberate: a retry that passes hides a race the product may also lose.

## Repository layout

```
helpers/     Shared utilities — API fixtures, hydration-safe UI actions, OTP readback
scripts/     Launch scripts for the API and web servers
specs/       Test suites
global-setup.ts      Wipes test data, signs in both accounts, saves their sessions
global-teardown.ts   Wipes test data again
```

## Contributing

Run the full suite before opening a pull request; it must pass 44/44. Keep new tests inside the existing serial model, put shared UI interactions in `helpers/ui.ts` so hydration races are handled in one place, and prefix any data you create with `e2e-` so setup can clean it up.

## License

[MIT](LICENSE) © Muslim Alfatih
