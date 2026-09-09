#!/usr/bin/env bash
# S72B 真 PostgreSQL 演练：只起一次性 PostgreSQL 14 容器，退出时强制删除。
# 连接固定走 127.0.0.1 随机端口与专用数据库；不读取 .env，不连接既有 dev/test/prod。
set -euo pipefail

# Docker 抖动时仅允许本地显式跳过；CI 的真 PostgreSQL 验收绝不能静默变绿。
if ! timeout 15 docker info >/dev/null 2>&1; then
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=S72 repair PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时,本地跳过真 PG 段——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="s72b-repair-s58b-$$"
password="s72b-local-$(date +%s)-$$"
database="s72_repair"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1::5432 "$image" >/dev/null

for _ in $(seq 1 30); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d "$database" >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d "$database" >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
S72_REPAIR_TEST_ALLOW_WRITE="temporary-docker-only" \
S72_REPAIR_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test test/repair-s58b-tier-status.test.ts
