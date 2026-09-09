#!/usr/bin/env bash
set -euo pipefail
: "${VNEXT_STORYBOARD_E2E_ORIGIN:?set API origin}"
: "${VNEXT_STORYBOARD_E2E_TOKEN:?set authenticated token}"
: "${VNEXT_STORYBOARD_E2E_PROJECT_ID:?set project UUID}"
: "${VNEXT_STORYBOARD_E2E_CONFIRMATION_ID:?set confirmed shot-plan UUID}"
node --import tsx scripts/e2e/vnext-storyboard-api.mts
