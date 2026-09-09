#!/usr/bin/env bash
# #150 test-env 付费冒烟防重：临时 PostgreSQL 14，退出即销毁。
set -euo pipefail

if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "[fail] CI 必须执行 test-env 付费冒烟真 PostgreSQL 防重测试" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI PR 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="tier-smoke-ledger-$$"
password="tier-smoke-local-$(date +%s)-$$"
database="tier_smoke_ledger"
schema="tier_smoke_ledger_rehearsal"

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

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
TIER_SMOKE_LEDGER_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test tests/tier-smoke-ledger-db.test.ts
