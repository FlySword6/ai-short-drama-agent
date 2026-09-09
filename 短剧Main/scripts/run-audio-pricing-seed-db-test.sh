#!/usr/bin/env bash
# R154 真 PostgreSQL 回放：临时 PostgreSQL 14 + 完整迁移，容器退出即销毁。
set -euo pipefail

# 2026-08-02 Fable 固化(同坑型第三次):docker 高负载抖动会让本测试在 pre-push 上间歇红。
# 预检 docker 可用性:不可用则显式跳过(打印原因,跳过≠通过);CI 车道 docker 稳定必真跑。
if ! timeout 15 docker info >/dev/null 2>&1; then
  # #284：这个套件是 #157 的 PR 闸。注释上面写着「跳过≠通过」「CI 车道仍必跑」,
  # 但没有任何一行让它在 CI 里真的红——docker 一抖,闸就静默放行。
  if [[ "${CI:-}" == "true" ]]; then
    echo "::error title=audio pricing seed PostgreSQL test did not run::CI 必须提供 Docker" >&2
    exit 1
  fi
  echo "[skip] docker 不可用或超时(负载/环境),本地跳过真 PG 回放——CI 车道仍必跑" >&2
  exit 0
fi

image="${POSTGRES_IMAGE:-postgres:14-alpine}"
container="audio-pricing-seed-$$"
password="audio-pricing-local-$(date +%s)-$$"
database="audio_pricing_seed"
schema="audio_pricing_seed_rehearsal"

cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_DB="$database" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1::5432 "$image" >/dev/null

# 2026-08-03 Fable 集成修复:高负载机上 30s 内容器未就绪,循环走完无失败分支,
# CREATE EXTENSION 撞上未建库报「database does not exist」。等待加倍+就绪硬校验。
ready=false
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d "$database" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != "true" ]; then
  echo "audio-pricing seed 回放:PostgreSQL 容器 60s 未就绪,判失败(不是跳过)" >&2
  exit 1
fi
docker exec -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d "$database" -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' >/dev/null

port="$(docker port "$container" 5432/tcp | head -1 | awk -F: '{print $NF}')"
POSTGRES_SSL_MODE="disable" \
POSTGRES_SCHEMA="$schema" \
AUDIO_PRICING_SEED_TEST_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${database}" \
node --import tsx --test tests/audio-pricing-seed-db.test.ts
