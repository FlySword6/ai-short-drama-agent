#!/usr/bin/env bash
set -euo pipefail

. scripts/e2e/vnext-script-postgres.sh
trap vnext_script_postgres_cleanup EXIT
vnext_script_postgres_start "vnext_storyboard_e2e" "vnext-storyboard-e2e"
VNEXT_STORYBOARD_E2E_DATABASE_URL="$VNEXT_SCRIPT_DATABASE_URL" \
  POSTGRES_SSL_MODE=disable node --import tsx scripts/e2e/vnext-storyboard-browser.mts
