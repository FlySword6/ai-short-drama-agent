#!/usr/bin/env bash
# R131 剧本拆解增强真 PostgreSQL 门禁：一次性 PostgreSQL 14 + pg_trgm，
# 验证 001→当前迁移重放、草稿/正式层边界和人工确认事务；绝不连接云库。
set -euo pipefail

# 2026-08-03 Fable 批量固化:docker 高负载抖动预检(同坑型第 N 次,统一加装)。
# 不可用则显式跳过(打印原因,跳过≠通过);CI 车道 docker 稳定必真跑。
if ! timeout 15 docker info >/dev/null 2>&1; then
  # #284：这个套件现在是 PR 闸。闸在 docker 抖动时静默 exit 0,就还是「看着绿」。
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=script breakdown PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="script-breakdown-$$"
password="script-breakdown-local-$(date +%s)-$$"
database="script_breakdown"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1::5432 "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' 2>/dev/null \
    | grep -qx '1'; then
    break
  fi
  sleep 1
done
docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' \
  | grep -qx '1'
docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="sbd_rehearsal" \
SCRIPT_BREAKDOWN_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test tests/script-breakdown-db.test.ts
