#!/usr/bin/env bash
# #371(#334 P0 批次) 配置项迁移真 PostgreSQL 门禁:一次性 PostgreSQL 14 容器,
# 先全量前向迁移再跑 tests/config-entries-migration-db.test.ts;连接固定走 127.0.0.1
# 随机端口,退出即销毁,绝不连接既有 dev/test/prod 库。
set -euo pipefail

# Docker 抖动时仅允许本地显式跳过;CI 的真 PostgreSQL 验收绝不能静默变绿。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=config entries migration PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="p0-config-entries-$$"
password="p0-config-entries-local-$(date +%s)-$$"
database="config_entries"
schema="config_entries_rehearsal"

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
# 迁移 017 的 GIN(gin_trgm_ops) 索引依赖 pg_trgm;扩展是预置条件(见 migrations/extensions.json)。
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
CONFIG_ENTRIES_TEST_DATABASE_URL="$database_url" \
node --import tsx --test tests/config-entries-migration-db.test.ts
