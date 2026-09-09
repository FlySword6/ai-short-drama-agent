#!/usr/bin/env bash
# #371(#334 P0 批次) 聚合 runner:串行跑 16 个此前无 CI 入口的孤儿真 PG 测试套件,
# 每个子 runner 各自起一次性 postgres:14-alpine 容器。任一子 runner 非零则整体失败。
set -euo pipefail

cd "$(dirname "$0")/.."

runners=(
  scripts/run-voice-catalog-db-test.sh
  scripts/run-ai-gateway-db-test.sh
  scripts/run-asset-primary-concurrency-db-test.sh
  scripts/run-asset-tags-db-test.sh
  scripts/run-asset-variants-db-test.sh
  scripts/run-command-palette-db-test.sh
  scripts/run-feedback-backend-db-test.sh
  scripts/run-hybrid-search-db-test.sh
  scripts/run-config-entries-migration-db-test.sh
  scripts/run-legacy-etl-db-test.sh
  scripts/run-seed-demo-data-db-test.sh
  scripts/run-release-card-keys-migration-db-test.sh
  scripts/run-vocabulary-migration-db-test.sh
  scripts/run-audio-candidate-transaction-db-test.sh
  scripts/run-topic-radar-db-test.sh
  scripts/run-output-review-delivery-db-test.sh
)

for runner in "${runners[@]}"; do
  echo "[p0-orphan-db] 运行 ${runner}"
  bash "$runner"
  echo "[p0-orphan-db] 通过 ${runner}"
done

echo "[p0-orphan-db] ${#runners[@]} 个 P0 孤儿真 PG 套件全部通过"
