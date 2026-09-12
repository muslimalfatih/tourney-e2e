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
exec go run ./cmd/api
