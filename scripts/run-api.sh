#!/usr/bin/env bash
# Launch a FRESH tourney-api on :8095 for the e2e suite, with the repo's dev env.
set -e
E2E_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$(dirname "$0")/../../tourney-api"
while IFS= read -r line; do
  case "$line" in \#*|"") continue;; esac
  export "$line"
done < .env
export PORT=8095
# The e2e web app runs on :4400 — SSE needs it in the CORS allowlist.
export CORS_ORIGINS=http://localhost:4400

# The suite needs its OWN database: it wipes rows and then creates
# tournaments, users and sessions for real. Sourcing tourney-api/.env above
# gave it whatever that dev machine last pointed at, which on most machines is
# the hosted project used for ordinary development.
#
# So E2E_DATABASE_URL (from tourney-e2e/.env, which git ignores) wins over the
# sourced value, and a non-local result is refused outright rather than run.
# helpers/env.ts resolves it the same way, so the API process and the test
# process can never disagree about which database is under test.
if [ -f "$E2E_DIR/.env" ]; then
  while IFS= read -r line; do
    case "$line" in \#*|"") continue;; esac
    export "$line"
  done < "$E2E_DIR/.env"
fi
[ -n "$E2E_DATABASE_URL" ] && export DATABASE_URL="$E2E_DATABASE_URL"

case "$DATABASE_URL" in
  *@localhost[:/]*|*@127.0.0.1[:/]*) ;;
  *)
    echo "run-api.sh: refusing to start the e2e API against a non-local database." >&2
    echo "Set E2E_DATABASE_URL in tourney-e2e/.env — see .env.example." >&2
    exit 1
    ;;
esac

# This suite tests the real invite-only OTP path, not the password fallback —
# override whatever the sourced .env says, in both directions.
export AUTH_PASSWORD_LOGIN_ENABLED=false
export OTP_PEPPER="${OTP_PEPPER:-e2e-suite-pepper-not-a-real-secret}"
# Forces the fake email sender (see internal/testhooks) and mounts
# /internal/test/last-otp, the ONLY way an automated browser can read back a
# sign-in code — otp_challenges stores nothing but an irreversible hash, by
# design. config.Load() itself refuses this alongside APP_ENV=production, so
# this is safe to export unconditionally here.
export E2E_TEST_MODE=true
exec go run ./cmd/api
