#!/usr/bin/env bash
# Launch a FRESH tourney-api on :8095 for the e2e suite, with the repo's dev env.
set -e
cd "$(dirname "$0")/../../tourney-api"
while IFS= read -r line; do
  case "$line" in \#*|"") continue;; esac
  export "$line"
done < .env
export PORT=8095
# The e2e web app runs on :4400 — SSE needs it in the CORS allowlist.
export CORS_ORIGINS=http://localhost:4400
# Same refusal as helpers/env.ts, for the process that actually writes the
# rows: this script sources the API repo's .env verbatim, so without a check
# here a dev machine pointed at hosted Postgres would serve the whole suite
# against it.
case "$DATABASE_URL" in
	*@localhost[:/]*|*@127.0.0.1[:/]*) ;;
	*)
		echo "run-api.sh: refusing to start the e2e API against a non-local database." >&2
		echo "Point tourney-api/.env at a local Postgres first." >&2
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
