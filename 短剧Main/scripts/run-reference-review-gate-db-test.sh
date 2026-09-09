#!/usr/bin/env bash
# #28 未过审资产生产门禁：一次性 PostgreSQL 14，验证控制包 + 生成付费链，绝不连接云库。
set -euo pipefail

if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${SKIP_REFERENCE_REVIEW_GATE_DB:-}" == "1" && "${CI:-}" != "true" ]]; then
    echo "[skip] 已显式设置 SKIP_REFERENCE_REVIEW_GATE_DB=1，本地跳过真 PG 段" >&2
    exit 0
  fi
  echo "::error title=Reference review gate PostgreSQL test did not run::本门禁要求 Docker；只有非 CI 且显式设置 SKIP_REFERENCE_REVIEW_GATE_DB=1 才可跳过" >&2
  exit 1
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="reference-review-gate-$$"
password="reference-review-gate-local-$(date +%s)-$$"
database="reference_review_gate"
schema="reference_review_gate_rehearsal"
generation_schema="reference_review_gate_generation_regression"
pre_050_migrations="$(mktemp -d "${TMPDIR:-/tmp}/reference-review-pre-050.XXXXXX")"
migration_050_only="$(mktemp -d "${TMPDIR:-/tmp}/reference-review-050-only.XXXXXX")"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$pre_050_migrations"
  rm -rf "$migration_050_only"
}
trap cleanup EXIT

for migration in migrations/0[0-4][0-9]_*.sql; do
  cp "$migration" "$pre_050_migrations/"
done
cp migrations/050_reference_review_paid_submission_guard.sql "$migration_050_only/"

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
database_url="postgresql://postgres:${password}@127.0.0.1:${port}/${database}"

NODE_ENV="development" \
AUTH_EMAIL_DELIVERY_MODE="dev_log" \
ALLOW_PAID_GENERATION="true" \
PAID_GENERATION_BUDGET_FEN="50000000" \
PAID_GENERATION_REVIEW_THRESHOLD_FEN="50000000" \
ARK_BASE_URL="http://127.0.0.1:9" \
ARK_API_KEY="reference-review-gate-test-key-never-used" \
ARK_IMAGE_MODEL="doubao-seedream-5-0-pro-260628" \
TOS_BUCKET="reference-review-gate-test" \
TOS_ENDPOINT="https://tos.example.invalid" \
TOS_PUBLIC_BASE_URL="https://reference-review-gate-test.example.com" \
TOS_ACCESS_KEY="reference-review-gate-test-ak-never-used" \
TOS_SECRET_KEY="reference-review-gate-test-sk-never-used" \
DATABASE_URL="$database_url" \
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
REFERENCE_REVIEW_GATE_TEST_DATABASE_URL="$database_url" \
REFERENCE_REVIEW_GATE_PRE_050_MIGRATIONS_DIR="$pre_050_migrations" \
REFERENCE_REVIEW_GATE_050_MIGRATIONS_DIR="$migration_050_only" \
node --import tsx --test tests/reference-review-gate-db.test.ts

# The repository-level review check now runs before pricing and retry guards.
# Re-run the existing quote/confirm/retry suite against a clean schema so its
# valid reference fixtures and paid-state ordering cannot regress silently.
DATABASE_URL="$database_url" POSTGRES_SSL_MODE="disable" POSTGRES_SCHEMA="$generation_schema" \
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

NODE_ENV="development" \
AUTH_EMAIL_DELIVERY_MODE="dev_log" \
ALLOW_PAID_GENERATION="true" \
PAID_GENERATION_BUDGET_FEN="50000000" \
PAID_GENERATION_REVIEW_THRESHOLD_FEN="50000000" \
ARK_API_KEY="reference-review-gate-test-key-never-used" \
ARK_IMAGE_MODEL="doubao-seedream-5-0-pro-260628" \
TOS_BUCKET="reference-review-gate-test" \
TOS_ENDPOINT="https://tos-cn-beijing.volces.com" \
TOS_PUBLIC_BASE_URL="https://reference-review-gate-test.example.com" \
TOS_ACCESS_KEY="reference-review-gate-test-ak-never-used" \
TOS_SECRET_KEY="reference-review-gate-test-sk-never-used" \
DATABASE_URL="$database_url" \
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$generation_schema" \
GENERATION_QUOTES_TEST_DATABASE_URL="$database_url" \
node --import tsx --test tests/generation-quotes-db.test.ts
