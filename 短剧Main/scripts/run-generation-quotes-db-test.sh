#!/usr/bin/env bash
# CLI 付费红线真 PostgreSQL 回归：自建、迁移并销毁一次性 PostgreSQL 14，绝不连接共享库。
set -euo pipefail

# 本地缺 Docker 时明确跳过；CI 中前置条件缺失必须判红，不能冒充 PR 闸通过。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=generation quotes PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时，本地跳过报价红线真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="generation-quotes-$$"
password="generation-quotes-local-$(date +%s)-$$"
database="generation_quotes"
schema="generation_quotes_rehearsal"

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
# 正式迁移 017 的 GIN(gin_trgm_ops) 索引要求 DBA 预置 pg_trgm。
docker exec -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
database_url="postgresql://postgres:${password}@127.0.0.1:${port}/${database}"

DATABASE_URL="$database_url" \
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
node --import tsx src/db/migrate.ts

NODE_ENV="test" \
ALLOW_PAID_GENERATION="true" \
PAID_GENERATION_BUDGET_FEN="50000000" \
PAID_GENERATION_REVIEW_THRESHOLD_FEN="50000000" \
ARK_API_KEY="generation-quotes-test-key-never-used" \
ARK_IMAGE_MODEL="doubao-seedream-5-0-pro-260628" \
TOS_BUCKET="generation-quotes-test" \
TOS_ENDPOINT="https://tos.example.invalid" \
TOS_PUBLIC_BASE_URL="https://generation-quotes-test.example.invalid" \
TOS_ACCESS_KEY="generation-quotes-test-ak-never-used" \
TOS_SECRET_KEY="generation-quotes-test-sk-never-used" \
DATABASE_URL="$database_url" \
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
GENERATION_QUOTES_TEST_DATABASE_URL="$database_url" \
node --import tsx --test tests/generation-quotes-db.test.ts
