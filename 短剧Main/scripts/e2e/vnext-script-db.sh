#!/usr/bin/env bash
set -euo pipefail

. scripts/e2e/vnext-script-postgres.sh
trap vnext_script_postgres_cleanup EXIT
vnext_script_postgres_start "vnext_script" "vnext-script-db"
VNEXT_SCRIPT_TEST_DATABASE_URL="$VNEXT_SCRIPT_DATABASE_URL" \
  POSTGRES_SSL_MODE=disable node --import tsx --test tests/vnext-script-db.test.ts
