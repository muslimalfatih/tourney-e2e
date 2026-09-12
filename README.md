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
- A Postgres reachable from `tourney-api/.env`'s `DATABASE_URL`, with
  migrations applied and seeded (see below).
- Go, to build/run `tourney-api` (`go run ./cmd/api`).

## Configuration

This workspace has **no `.env` of its own**. `helpers/env.ts` reads
`tourney-api/.env` directly and pulls out:

| Variable | Used for |
| --- | --- |
| `SEED_ORGANIZER_EMAIL` / `SEED_ORGANIZER_PASSWORD` | UI login in `global-setup.ts` |
| `DATABASE_URL` | Wiping `e2e-*` tournaments before/after the run |

> [!WARNING]
> **`DATABASE_URL` must point at a local or scratch database — never
> production.** `global-setup.ts` runs `DELETE FROM tournaments WHERE slug
> LIKE 'e2e-%'` directly via `psql` against whatever `DATABASE_URL` resolves
> to, and `scripts/run-api.sh` boots a real API instance against it. If your
> `tourney-api/.env` is currently pointed at a shared or production database
> (check the host in `DATABASE_URL`/`MIGRATION_DATABASE_URL` before running
> this), point it at a local Postgres instead — `tourney-api`'s own
> `docker-compose.yml` gives you one — for the duration of the run.

Seed that database before the first run:

```sh
cd ../tourney-api
go run ./cmd/migrate up
SEED_ADMIN_EMAIL=... SEED_ADMIN_PASSWORD=... \
SEED_ORGANIZER_EMAIL=organizer@example.com SEED_ORGANIZER_PASSWORD=... \
SEED_ORG_NAME="Laga Demo" SEED_ORG_SLUG=laga-demo \
  go run ./cmd/seed
```

`SEED_ORG_SLUG` **must be exactly `laga-demo`** — `cmd/seed/renon.go` looks up
the demo organization by that literal slug (not by an env var) to attach the
"Renon Cup 2026" fixture dataset that `public.spec.ts` and `share.spec.ts`
read. Any other slug and the Renon seed step fails with `demo org missing`,
and both specs then 404 looking for a tournament that was never created —
that failure mode is a seeding mistake, not a suite bug, and it's exactly what
happened the first time this baseline was verified against a fresh scratch
database.

## Ports

| Port | What |
| --- | --- |
| `8095` | The e2e-only `tourney-api` instance (never your regular `:8090`/dev one) |
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

| File | Covers |
| --- | --- |
| `auth.spec.ts` | Login, session persistence, JWT never leaking to the client, route guards |
| `public.spec.ts` | Public tournament pages — overview/standings/bracket/schedule, draft invisibility, mobile share layout |
| `scheduling.spec.ts` | Courts, slots, conflict detection, short-rest warnings |
| `scoring.spec.ts` | Set scoring, walkover/retired/cancelled, idempotent rescoring, correction locks |
| `share.spec.ts` | Share dialog URL/filters, clipboard copy + fallback, QR download, native share, WhatsApp intent |
| `workflow.spec.ts` | End-to-end organizer flow: create tournament → division → pairs → fixtures |
| `z-present.spec.ts` | Presentation-mode deck: rotation, keyboard, live SSE updates, reconnect after an API restart |

(`z-present` sorts last on purpose — it restarts the shared API instance, so
nothing else may run after it in the same pass.)

## Known limitation

This baseline authenticates through a **password** login form
(`global-setup.ts` fills `input[name="email"]` / `input[name="password"]`).
`tourney-web`'s `phase-5-auth` branch replaces that with invitation-only email
OTP — once that branch merges to `main`, `global-setup.ts` and `auth.spec.ts`
need updating to the two-step email → code flow, and new specs are wanted for
invitations, impersonation, and the platform admin screens. That update is
scoped to Phase 5 subphase 5.6, not done here — this commit captures the
suite exactly as it last verified green against `main` (32/32,
`npx playwright test`, 2026-09-13), so that baseline has somewhere to live
before it changes.
