#!/usr/bin/env bash
# Independent dev/test compatibility regression for scripts/preflight-v011-ecs.sh.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp "${TMPDIR:-/tmp}/shortdrama-preflight.XXXXXX")"
trap 'rm -f "$fixture"' EXIT

cat > "$fixture" <<'EOF'
APP_NAME=Shortdrama Dev Test
APP_VERSION=0.1.1
AUTH_REGISTRATION_ENABLED=false
ADMIN_USERNAMES=release-admin
DATABASE_URL=
POSTGRES_DB=shortdrama
POSTGRES_USER=shortdrama
POSTGRES_PASSWORD=not-a-real-secret
TOS_BUCKET=release-assets
TOS_ENDPOINT=
TOS_SDK_ENDPOINT=https://tos.example.invalid
TOS_PUBLIC_BASE_URL=https://media.example.invalid
TOS_REGION=cn-beijing
TOS_ACCESS_KEY=not-a-real-access-key
TOS_SECRET_KEY=not-a-real-secret-key
ALLOW_PAID_GENERATION=false
EOF

SHORTDRAMA_IMAGE='shortdrama-devtest:v0.1.1-testcommit' \
SHORTDRAMA_ROLLBACK_IMAGE='shortdrama-devtest:v0.1.1-previouscommit' \
  "$repo_root/scripts/preflight-v011-ecs.sh" --offline --env-file "$fixture" > /dev/null

echo "preflight static test passed"
