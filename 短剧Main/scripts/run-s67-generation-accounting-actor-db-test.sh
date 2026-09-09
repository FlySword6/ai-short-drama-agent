#!/usr/bin/env bash
# S67/运营底座 P0 真 PostgreSQL 回归：临时 PostgreSQL 14 + pg_trgm；绝不连云库，退出即销毁。
set -euo pipefail

# 2026-08-03 Fable 批量固化:docker 高负载抖动预检(同坑型第 N 次,统一加装)。
# 不可用则显式跳过(打印原因,跳过≠通过);CI 车道 docker 稳定必真跑。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=S67/运营底座 P0 PostgreSQL test did not run::CI 必须提供 Docker，拒绝把真 PG 验收跳过算通过" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

ops_p0_only="${OPS_P0_ONLY:-false}"
image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="s67-generation-accounting-$$"
password="s67-local-$(date +%s)-$$"
database="s67_generation_accounting"
schema="s67_generation_accounting_rehearsal"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1::5432 "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' 2>/dev/null \
    | grep -qx '1'; then
    break
  fi
  sleep 1
done
docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -Atqc 'SELECT 1' \
  | grep -qx '1'
docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
if [[ "$ops_p0_only" != "true" ]]; then
  POSTGRES_SSL_MODE="disable" \
  POSTGRES_SCHEMA="$schema" \
  S67_GENERATION_ACCOUNTING_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
  node --import tsx --test tests/s67-generation-accounting-actor-db.test.ts
fi

# S57 covers 049 rerun safety and the same debit trigger's competing-quote
# serialization. The issue #26 PR lane must execute it even when the broader
# S67 ownership suite is omitted.
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="s57_account_credits_rehearsal" \
S57_ACCOUNT_CREDITS_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test tests/s57-account-credits-db.test.ts

# Issue #26 acceptance: use the same disposable database for the actual HTTP
# registration -> login -> quota -> admin adjustment -> cheapest quote path.
# The test proves that quote preparation creates no task, debit, or provider cost.
NODE_ENV="development" \
AUTH_EMAIL_DELIVERY_MODE="dev_log" \
ALLOW_MEMBER_CREATE_PROJECT="true" \
GENERATION_PILOT_CREDIT_GATE_ENABLED="true" \
ALLOW_PAID_GENERATION="false" \
COMPANY_PROVIDER_ALLOWLIST="ark" \
ARK_API_KEY="ops-p0-local-contract-key-never-used" \
ARK_IMAGE_MODEL="doubao-seedream-5-0-pro-260628" \
DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="ops_p0_http_rehearsal" \
OPS_P0_HTTP_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test tests/ops-p0-http-db.test.ts
