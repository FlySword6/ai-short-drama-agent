#!/usr/bin/env bash
set -euo pipefail

. scripts/e2e/vnext-script-postgres.sh
trap vnext_script_postgres_cleanup EXIT
vnext_script_postgres_start "vnext_video_version" "vnext-video-version-db"
VNEXT_VIDEO_VERSION_TEST_DATABASE_URL="$VNEXT_SCRIPT_DATABASE_URL" \
  POSTGRES_SSL_MODE=disable \
  PAID_GENERATION_BUDGET_FEN=100 \
  GENERATION_PILOT_CREDIT_GATE_ENABLED=false \
  node --import tsx --test tests/vnext-video-version-db.test.ts
