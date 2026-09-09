#!/usr/bin/env bash
# 一次性本地 PostgreSQL 14(对齐生产 PG14 基线,见 docs/proposals/pg14-vs-pg16-decision.md)
# 上跑 schema 漂移检测。容器用后即焚;绝不触碰任何非本机库。
set -euo pipefail

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="s22-drift-$$"
password="s22-drift-local-only"
db="drift"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB="$db" \
  -p 127.0.0.1::5432 "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -U postgres -d "$db" >/dev/null 2>&1; then break; fi
  sleep 1
done

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
# 不能 exec:exec 会替换掉 shell 进程,EXIT trap 永远不触发,容器泄漏
npx tsx scripts/check-schema-drift.mts \
  --database-url "postgresql://postgres:${password}@127.0.0.1:${port}/${db}"
