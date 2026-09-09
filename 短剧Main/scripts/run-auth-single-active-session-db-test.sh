#!/usr/bin/env bash
set -euo pipefail

# 「同一账号能不能多处登录」这条口径只有真 PostgreSQL 能证：行锁、事务可见性和
# 撤销范围都不是内存假库能复现的。测试自带一次性 PostgreSQL 14 容器并自行清理。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=login session switch test did not run::Docker is required in CI; refusing a false-green session policy check." >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时，本地跳过真 PG 回放——CI 车道仍必跑" >&2
  exit 0
fi

# 夹具在一次性容器里迁移的是 app schema；钉住 POSTGRES_SCHEMA，防止开发机 .env
# 把 Drizzle 表对象绑到从未迁移的 schema 上。
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="app" \
node --import tsx --test tests/auth-single-active-session-db.test.ts
