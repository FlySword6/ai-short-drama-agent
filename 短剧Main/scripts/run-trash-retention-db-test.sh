#!/usr/bin/env bash
set -euo pipefail

# 2026-08-02 Fable 固化(同坑型第三次):docker 高负载抖动会让本测试在 pre-push 上间歇红。
# 预检 docker 可用性:不可用则显式跳过(打印原因,跳过≠通过);CI 车道 docker 稳定必真跑。
if ! timeout 15 docker info >/dev/null 2>&1; then
  # #284：这个套件现在是 PR 闸。闸在 docker 抖动时静默 exit 0,就还是「看着绿」。
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=trash retention PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时(负载/环境),本地跳过真 PG 回放——CI 车道仍必跑" >&2
  exit 0
fi
# The test owns a disposable PostgreSQL 14 container and removes it on exit.
# 夹具在一次性容器里迁移的是 app schema(tests/trash-retention-db.test.ts 写死
# "app");钉住 POSTGRES_SCHEMA=app,防止开发机 .env(如 POSTGRES_SCHEMA=lite)
# 把 Drizzle 表对象绑到从未迁移的 schema 上。
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="app" \
node --import tsx --test tests/trash-retention-db.test.ts
