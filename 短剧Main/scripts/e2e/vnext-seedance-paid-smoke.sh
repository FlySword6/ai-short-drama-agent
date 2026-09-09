#!/usr/bin/env bash
# ┌──────────────────────────────────────────────────────────────────────────────┐
# │  PAID SMOKE — MUST NOT BE EXECUTED WITHOUT EXPLICIT HUMAN APPROVAL          │
# │                                                                              │
# │  Required environment variables:                                             │
# │    ARK_API_KEY          — real Ark credential                                │
# │    ARK_VIDEO_MODEL_2_5  — Seedance 2.5 endpoint (ep-...) id                 │
# │    TOS_BUCKET           — TOS bucket name                                    │
# │    TOS_ENDPOINT / TOS_SDK_ENDPOINT                                           │
# │    TOS_ACCESS_KEY / TOS_SECRET_KEY                                           │
# │    VNEXT_DATABASE_URL   — live vNext PostgreSQL URL                          │
# │    VNEXT_SEEDANCE_SMOKE_PROJECT_ID — project UUID for the test run           │
# │    VNEXT_SEEDANCE_SMOKE_ACTOR_ID   — actor UUID for the test run             │
# │                                                                              │
# │  This smoke makes ONE real Seedance 2.5 paid video generation call.         │
# │  It will DEBIT the company Ark account.                                      │
# │  Run only in an explicitly designated smoke environment.                     │
# └──────────────────────────────────────────────────────────────────────────────┘
set -euo pipefail

: "${VNEXT_SEEDANCE_PAID_SMOKE_APPROVED:?Set VNEXT_SEEDANCE_PAID_SMOKE_APPROVED=I_UNDERSTAND_THIS_CREATES_ONE_PAID_TASK after explicit human approval}"
[[ "$VNEXT_SEEDANCE_PAID_SMOKE_APPROVED" == "I_UNDERSTAND_THIS_CREATES_ONE_PAID_TASK" ]] || { echo "Refusing paid smoke: approval phrase mismatch" >&2; exit 2; }
: "${ARK_API_KEY:?ARK_API_KEY is required for paid smoke}"
: "${ARK_VIDEO_MODEL_2_5:?ARK_VIDEO_MODEL_2_5 is required for paid smoke}"
: "${VNEXT_DATABASE_URL:?VNEXT_DATABASE_URL is required for paid smoke}"
: "${VNEXT_SEEDANCE_SMOKE_PROJECT_ID:?VNEXT_SEEDANCE_SMOKE_PROJECT_ID is required}"
: "${VNEXT_SEEDANCE_SMOKE_ACTOR_ID:?VNEXT_SEEDANCE_SMOKE_ACTOR_ID is required}"
: "${TOS_BUCKET:?TOS_BUCKET is required for paid smoke}"
: "${TOS_ENDPOINT:?TOS_ENDPOINT is required for paid smoke}"
: "${TOS_ACCESS_KEY:?TOS_ACCESS_KEY is required for paid smoke}"
: "${TOS_SECRET_KEY:?TOS_SECRET_KEY is required for paid smoke}"

echo "[vnext-seedance-paid-smoke] Starting paid Seedance 2.5 smoke…"
PAID_SMOKE=true node --import tsx scripts/e2e/vnext-seedance-paid-smoke.mts
echo "[vnext-seedance-paid-smoke] Done."
