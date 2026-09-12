#!/usr/bin/env bash
# Vite dev server for the e2e suite, pointed at the e2e API instance.
set -e
cd "$(dirname "$0")/../../tourney-web"
export PUBLIC_API_BASE_URL=http://localhost:8095/api/v1
exec npm run dev -- --port 4400 --strictPort
