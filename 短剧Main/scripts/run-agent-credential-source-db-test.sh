#!/usr/bin/env bash
# 047 真 PostgreSQL 回归：临时 PostgreSQL 14；仅回放本地迁移，绝不连云库。
set -euo pipefail

if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=047 PostgreSQL test did not run::Docker is required in CI; refusing a false-green credential migration check." >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时，本地跳过 047 真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="agent-credential-source-$$"
password="agent-credential-source-local-$(date +%s)-$$"
database="agent_credential_source"
schema="agent_credential_source_rehearsal"

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
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
AGENT_CREDENTIAL_SOURCE_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test tests/agent-credential-source-db.test.ts
