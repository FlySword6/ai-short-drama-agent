#!/usr/bin/env bash
# 资产使用明细真 PostgreSQL 门禁：独立临时 PostgreSQL 14，绝不连接云库。
set -euo pipefail

# Docker 抖动时仅允许本地显式跳过；CI 的真 PostgreSQL 验收绝不能静默变绿。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=asset usage PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="asset-usage-$$"
password="asset-usage-local-$(date +%s)-$$"
database="asset_usage"
schema="asset_usage_rehearsal"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1::5432 "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' 2>/dev/null | grep -qx '1'; then
    break
  fi
  sleep 1
done
docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' | grep -qx '1'
docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
database_url="postgresql://postgres:${password}@127.0.0.1:${port}/${database}"

# 先完整前向迁移，再由测试重复演练其关注的迁移，确保它不依赖任意共享开发库。
DATABASE_URL="$database_url" POSTGRES_SSL_MODE="disable" POSTGRES_SCHEMA="$schema" \
node --import tsx -e '
  const { createDatabase } = await import("./src/db/client.ts");
  const { runMigrations } = await import("./src/db/migrate.ts");
  const handle = createDatabase();
  try {
    await runMigrations(handle);
  } finally {
    await handle.pool.end();
  }
'

# 两个文件共用同一 schema，且 asset-usage 的 041 用例会故意重放全表归一迁移。
# 文件级并发会偶发改写 #24 刚造的 personal 历史脏行，造成与业务无关的竞态红。
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
ASSET_USAGE_TEST_DATABASE_URL="$database_url" \
REVIEW_AUTHZ_TEST_DATABASE_URL="$database_url" \
TOS_BUCKET="asset-usage-test" \
ASSET_MEDIA_DISPLAY_BASE_URL="https://assets.test" \
node --import tsx --test --test-concurrency=1 \
  tests/asset-usage-db.test.ts tests/review-cross-tenant-authz-db.test.ts
