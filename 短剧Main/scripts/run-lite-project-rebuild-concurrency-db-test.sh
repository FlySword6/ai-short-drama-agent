#!/usr/bin/env bash
# #400/#401:一次性 PostgreSQL 14 真并发门。绝不连接云库。
set -euo pipefail

if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=Lite project concurrency PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="lite-project-concurrency-$$"
password="lite-project-local-$(date +%s)-$$"
database="lite_project_concurrency"

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

docker exec -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="lite_concurrency_rehearsal" \
LITE_PROJECT_CONCURRENCY_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test tests/lite-project-rebuild-concurrency-db.test.ts
