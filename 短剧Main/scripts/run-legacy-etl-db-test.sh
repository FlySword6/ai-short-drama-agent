#!/usr/bin/env bash
# #371(#334 P0 批次) legacy-merge-etl 真 PostgreSQL 门禁:一次性 PostgreSQL 14 容器
# + pg_trgm(测试自管 schema 但仍会重放含 017 的迁移链),
# 跑 test/legacy-merge-etl/etl-db.test.ts;连接固定走 127.0.0.1 随机端口,
# 退出即销毁,绝不连接既有 dev/test/prod 库。
# 注意:本 runner 不预跑全量迁移——测试自管 schema,预迁移会撞
# asset_entities_clearance_shape_check。
set -euo pipefail

# Docker 抖动时仅允许本地显式跳过;CI 的真 PostgreSQL 验收绝不能静默变绿。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=legacy etl PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="p0-legacy-etl-$$"
password="p0-legacy-etl-local-$(date +%s)-$$"
database="legacy_etl"

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
# 测试自建 schema 后会自己重放迁移链,017 的 GIN(gin_trgm_ops) 索引依赖 pg_trgm;
# 扩展是库级预置条件(见 migrations/extensions.json),由 runner 装好。
docker exec -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
database_url="postgresql://postgres:${password}@127.0.0.1:${port}/${database}"

POSTGRES_SSL_MODE="disable" \
LEGACY_ETL_TEST_DATABASE_URL="$database_url" \
node --import tsx --test test/legacy-merge-etl/etl-db.test.ts
