#!/usr/bin/env bash
# main#292 抽卡任务「表与读」真 PostgreSQL 门禁：临时 PostgreSQL 14，退出即销毁。
set -euo pipefail

if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "[fail] CI 必须执行抽卡任务真 PostgreSQL 路由测试" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI PR 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="casting-tasks-$$"
password="casting-tasks-local-$(date +%s)-$$"
database="casting_tasks"
schema="casting_tasks_rehearsal"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1::5432 "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec -e PGPASSWORD="$password" "$container" \
    psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' 2>/dev/null \
    | grep -qx '1'; then
    break
  fi
  sleep 1
done
docker exec -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' \
  | grep -qx '1'
# 迁移 017 的 GIN(gin_trgm_ops) 索引依赖 pg_trgm；扩展是预置条件（见 migrations/extensions.json）。
docker exec -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
database_url="postgresql://postgres:${password}@127.0.0.1:${port}/${database}"
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
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
CASTING_TASKS_TEST_DATABASE_URL="$database_url" \
node --import tsx --test tests/casting-tasks-db.test.ts
