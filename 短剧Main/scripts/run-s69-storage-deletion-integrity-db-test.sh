#!/usr/bin/env bash
set -euo pipefail

# S69「永久删除不能误删共享对象、且必须清干净全部向量键」这条口径只有真 PostgreSQL 能证：
# 共享 media/variant 的引用计数、事务可见性和向量键回收都不是内存假库能复现的。
# 测试自带一次性 PostgreSQL 14 容器(tmpfs、随机端口、退出即焚)并自行清理。
#
# 2026-08-12 建：此前本用例混在 npm run test:node 里，pre-push 快车道会直接 docker run。
# Docker 没起来时 pre-push 报的是一长串 node child_process 堆栈加
# "Cannot connect to the Docker daemon"，根因看不出来。现在改成与
# trash-retention / auth-single-active-session 同款：快车道排除，本 runner 负责跑，
# CI 的 verify-postgres 车道兜底真跑。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=S69 storage deletion test did not run::Docker is required in CI; refusing a false-green deletion-integrity check." >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时，本地跳过真 PG 回放——CI 车道仍必跑" >&2
  exit 0
fi

# 夹具在一次性容器里迁移的是 app schema；钉住 POSTGRES_SCHEMA，防止开发机 .env
# 把 Drizzle 表对象绑到从未迁移的 schema 上。
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="app" \
node --import tsx --test tests/s69-storage-deletion-integrity-db.test.ts
