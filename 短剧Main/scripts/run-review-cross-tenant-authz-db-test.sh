#!/usr/bin/env bash
# Reviews 跨租户授权真 PostgreSQL 回归：一次性 PostgreSQL 14 + pg_trgm；
# 只走 127.0.0.1 随机端口和专用 schema，退出即销毁，绝不读取或连接既有库。
set -euo pipefail

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="review-cross-tenant-authz-$$"
password="review-authz-local-$(date +%s)-$$"
database="review_cross_tenant_authz"
schema="review_cross_tenant_authz_rehearsal"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  -p 127.0.0.1::5432 "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$container" psql -U postgres -d "$database" -Atqc 'SELECT 1' 2>/dev/null \
    | grep -qx '1'; then
    break
  fi
  sleep 1
done
docker exec "$container" psql -U postgres -d "$database" -Atqc 'SELECT 1' \
  | grep -qx '1'
docker exec "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
database_url="postgresql://postgres:${password}@127.0.0.1:${port}/${database}"

POSTGRES_SCHEMA="$schema" \
DATABASE_URL="$database_url" \
POSTGRES_SSL_MODE="disable" \
node --import tsx src/db/migrate.ts

POSTGRES_SCHEMA="$schema" \
REVIEW_AUTHZ_TEST_DATABASE_URL="$database_url" \
POSTGRES_SSL_MODE="disable" \
node --import tsx --test tests/review-cross-tenant-authz-db.test.ts
