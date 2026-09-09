#!/usr/bin/env bash
set -euo pipefail

npm run build:frontend
image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="vnext-e2e-$$"
password="vnext-e2e-local-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=vnext_e2e \
  --tmpfs /var/lib/postgresql/data:rw,size=512m -p 127.0.0.1::5432 "$image" >/dev/null
for _ in $(seq 1 30); do
  if docker exec -e PGPASSWORD="$password" "$container" psql -U postgres -d vnext_e2e -c "SELECT 1" >/dev/null 2>&1; then break; fi
  sleep 1
done
# 与正式迁移前置一致:pg_trgm 由库管理员先行启用(见 migrations/017)。
docker exec -e PGPASSWORD="$password" "$container" psql -U postgres -d vnext_e2e -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null
port="$(docker port "$container" 5432/tcp | cut -d: -f2)"
VNEXT_E2E_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/vnext_e2e" POSTGRES_SSL_MODE=disable \
  node --import tsx scripts/e2e/vnext-project.mts
