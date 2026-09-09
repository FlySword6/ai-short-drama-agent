#!/usr/bin/env bash
# #371(#334 P0 批次) 混合检索真 PostgreSQL 门禁:一次性 PostgreSQL 14 容器 + pg_trgm,
# 先全量前向迁移再跑 test/hybrid-search-postgres.test.ts;连接固定走 127.0.0.1 随机端口,
# 退出即销毁,绝不连接既有 dev/test/prod 库。
set -euo pipefail

# Docker 抖动时仅允许本地显式跳过;CI 的真 PostgreSQL 验收绝不能静默变绿。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=hybrid search PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="p0-hybrid-search-$$"
password="p0-hybrid-search-local-$(date +%s)-$$"
database="hybrid_search"
schema="hybrid_search_rehearsal"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1::5432 "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec -e PGPASSWORD="$password" "$container" \
    psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' 2>/dev/null | grep -qx '1'; then
    break
  fi
  sleep 1
done
docker exec -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' | grep -qx '1'
# 混合检索与迁移 017 的 GIN(gin_trgm_ops) 索引都依赖 pg_trgm(见 migrations/extensions.json)。
docker exec -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
database_url="postgresql://postgres:${password}@127.0.0.1:${port}/${database}"

DATABASE_URL="$database_url" \
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
node --import tsx src/db/migrate.ts

POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
HYBRID_SEARCH_TEST_DATABASE_URL="$database_url" \
node --import tsx --test test/hybrid-search-postgres.test.ts
