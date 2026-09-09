#!/usr/bin/env bash
# R1 对象图真 PostgreSQL 门禁：一次性 PostgreSQL 14 + pg_trgm，绝不连接云库。
set -euo pipefail

# Docker 抖动时仅允许本地显式跳过；CI 的真 PostgreSQL 验收绝不能静默变绿。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=object context PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="object-context-$$"
password="object-context-local-$(date +%s)-$$"
database="object_context"
schema="object_context_rehearsal"
control_schema="object_context_control_packages"
prep_schema="object_context_scene_prep"

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
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
OBJECT_CONTEXT_TEST_DATABASE_URL="$database_url" \
ALLOW_PAID_GENERATION=true \
node --import tsx --test tests/object-context-db.test.ts

# Control-package authorization is an R1 launch gate, not a side test. Prepare
# a second disposable schema so its repository test cannot share or hide state
# from the object-context assertions above.
DATABASE_URL="$database_url" POSTGRES_SSL_MODE="disable" POSTGRES_SCHEMA="$control_schema" \
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
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$control_schema" \
CONTROL_PACKAGES_TEST_DATABASE_URL="$database_url" \
node --import tsx --test tests/control-packages-db.test.ts

# R161 的场级备戏真源与控制包共用底层引用能力，但使用独立 schema
# 验证迁移 046 的 CHECK、场级不碰控制包和 all-shots 显式铺场。
DATABASE_URL="$database_url" POSTGRES_SSL_MODE="disable" POSTGRES_SCHEMA="$prep_schema" \
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
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$prep_schema" \
PREP_TEST_DATABASE_URL="$database_url" \
node --import tsx --test tests/prep-db.test.ts
