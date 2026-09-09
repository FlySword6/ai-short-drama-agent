#!/usr/bin/env bash
set -euo pipefail

. scripts/e2e/vnext-script-postgres.sh
trap vnext_script_postgres_cleanup EXIT
vnext_script_postgres_start "vnext_seedance_gen" "vnext-seedance-gen-db"
VNEXT_SEEDANCE_GEN_TEST_DATABASE_URL="$VNEXT_SCRIPT_DATABASE_URL" \
  POSTGRES_SSL_MODE=disable node --import tsx --test tests/vnext-seedance-generation-db.test.ts
