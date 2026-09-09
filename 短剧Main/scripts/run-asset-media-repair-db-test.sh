#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${ASSET_MEDIA_REPAIR_TEST_DATABASE_URL:-}" ]]; then
  node --import tsx --test tests/asset-media-repair-db.test.ts
  exit 0
fi

if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=asset media repair PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时；本地真 PostgreSQL 证据由独立临时实例命令提供，CI 仍必跑" >&2
  exit 0
fi

container="asset-media-repair-$$"
password="asset-media-repair-local-$$"
database="asset_media_repair"
schema="asset_media_repair_rehearsal"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1::5432 postgres:14-alpine >/dev/null

for _ in $(seq 1 30); do
  if docker exec -e PGPASSWORD="$password" "$container" \
    psql -h 127.0.0.1 -U postgres -d "$database" -Atqc "SELECT 1" 2>/dev/null | grep -qx "1"; then
    break
  fi
  sleep 1
done

docker exec -e PGPASSWORD="$password" "$container" \
  psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
ASSET_MEDIA_REPAIR_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test tests/asset-media-repair-db.test.ts
