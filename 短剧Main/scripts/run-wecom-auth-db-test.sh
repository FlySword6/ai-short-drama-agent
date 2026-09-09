#!/usr/bin/env bash
set -euo pipefail

if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=WeCom auth database test did not run::Docker is required in CI; refusing a false-green authentication check." >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时，本地跳过企业微信真 PG 回放——CI PR 闸仍必跑" >&2
  exit 0
fi

POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="app" \
node --import tsx --test tests/wecom-auth-db.test.ts
