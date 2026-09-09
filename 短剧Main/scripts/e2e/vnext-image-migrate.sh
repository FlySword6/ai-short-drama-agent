#!/usr/bin/env bash
# Issue #345 复审 P1-1 验证:最终运行镜像必须真实包含并能执行 vNext migration。
#
# Dockerfile 运行阶段必须同时打包 dist/、根 migrations/ 与
# src/db/migrations/vnext：dist/db/migrate.js 会在运行时读取后者。
# 本脚本验证干净库正式迁移，以及生产镜像里的真实 001→002/003 旧库升级。
set -euo pipefail

image_tag="vnext-image-migrate:$$"
pg_container="vnext-image-migrate-pg-$$"
network="vnext-image-migrate-net-$$"
password="vnext-image-$$"
docker_build_args=()
if [[ -n "${VNEXT_DOCKER_NPM_REGISTRY:-}" ]]; then
  docker_build_args+=(--build-arg "NPM_CONFIG_REGISTRY=${VNEXT_DOCKER_NPM_REGISTRY}")
fi
if [[ -n "${VNEXT_DOCKER_BUILD_NETWORK:-}" ]]; then
  docker_build_args+=(--network "${VNEXT_DOCKER_BUILD_NETWORK}")
fi
cleanup() {
  docker rm -f "$pg_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker image rm -f "$image_tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build "${docker_build_args[@]}" --target runtime -t "$image_tag" .
docker network create "$network" >/dev/null
docker run -d --rm --name "$pg_container" --network "$network" \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=vnext \
  --tmpfs /var/lib/postgresql/data:rw,size=512m postgres:14-alpine >/dev/null
for _ in $(seq 1 30); do
  if docker exec -e PGPASSWORD="$password" "$pg_container" psql -U postgres -d vnext -c "SELECT 1" >/dev/null 2>&1; then break; fi
  sleep 1
done
# 与正式迁移前置一致(见 migrations/017 与 scripts/e2e/vnext-project-db.sh)。
docker exec -e PGPASSWORD="$password" "$pg_container" psql -U postgres -d vnext -v ON_ERROR_STOP=1 \
  -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null

echo "==> 在最终运行镜像里对干净库执行正式迁移入口 node dist/db/migrate.js"
docker run --rm --network "$network" \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://postgres:${password}@${pg_container}:5432/vnext" \
  -e POSTGRES_SCHEMA=shortdrama -e POSTGRES_SSL_MODE=disable \
  "$image_tag" node dist/db/migrate.js

tables="$(docker exec -e PGPASSWORD="$password" "$pg_container" psql -U postgres -d vnext -tA \
  -c "SELECT tablename FROM pg_tables WHERE schemaname='vnext' ORDER BY tablename" | paste -sd, -)"
expected="agent_session_contexts,generation_telemetry_events,graph_documents,graph_revisions,project_members,projects,schema_migrations"
if [[ "$tables" != "$expected" ]]; then
  echo "FAIL: 镜像内正式迁移后 vNext 表不完整。实际: [$tables] 期望: [$expected]" >&2
  exit 1
fi
echo "PASS: 最终运行镜像执行正式迁移后 vNext 表齐备: $tables"

echo "==> 在最终运行镜像里构造只应用 001 的真实旧库"
docker exec -e PGPASSWORD="$password" "$pg_container" psql -U postgres -d vnext -v ON_ERROR_STOP=1 \
  -c "DROP SCHEMA vnext CASCADE" >/dev/null
docker run --rm --network "$network" \
  -e DATABASE_URL="postgresql://postgres:${password}@${pg_container}:5432/vnext" \
  "$image_tag" node --input-type=module -e '
    import { copyFile, mkdtemp, rm } from "node:fs/promises";
    import { Pool } from "pg";
    import { runVnextMigrations } from "./dist/db/migrate.js";
    const stage = await mkdtemp("/tmp/vnext-001-");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await copyFile(
        "src/db/migrations/vnext/001_vnext_projects_graph.sql",
        `${stage}/001_vnext_projects_graph.sql`,
      );
      const applied = await runVnextMigrations(pool, stage);
      if (applied.join(",") !== "001_vnext_projects_graph.sql") {
        throw new Error(`旧库构造只允许应用 001，实际: ${applied.join(",")}`);
      }
    } finally {
      await pool.end();
      await rm(stage, { recursive: true, force: true });
    }
  '

legacy_project="11111111-1111-4111-8111-111111111111"
legacy_author="22222222-2222-4222-8222-222222222222"
legacy_document='{"schemaVersion":1,"nodes":[{"id":"33333333-3333-4333-8333-333333333333","kind":"scene","label":"镜像升级前场景","position":{"x":1,"y":2}}],"edges":[]}'
docker exec -e PGPASSWORD="$password" "$pg_container" psql -U postgres -d vnext -v ON_ERROR_STOP=1 \
  -c "INSERT INTO vnext.projects (id, owner_user_id, name) VALUES ('${legacy_project}', '${legacy_author}', '镜像升级验收')" \
  -c "INSERT INTO vnext.graph_documents (project_id, revision, document) VALUES ('${legacy_project}', 1, '${legacy_document}'::jsonb)" \
  -c "INSERT INTO vnext.graph_revisions (project_id, revision, document, created_by_user_id) VALUES ('${legacy_project}', 1, '${legacy_document}'::jsonb, '${legacy_author}')" \
  >/dev/null

echo "==> 在最终运行镜像里沿正式入口执行 001→002/003 升级"
docker run --rm --network "$network" \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgresql://postgres:${password}@${pg_container}:5432/vnext" \
  -e POSTGRES_SCHEMA=shortdrama -e POSTGRES_SSL_MODE=disable \
  "$image_tag" node dist/db/migrate.js

upgrade_evidence="$(docker exec -e PGPASSWORD="$password" "$pg_container" psql -U postgres -d vnext -tA -F '|' \
  -c "SELECT r.revision, r.document->'nodes'->0->>'label', r.created_by_user_id, r.created_by_kind, string_agg(m.version, ',' ORDER BY m.version) FROM vnext.graph_revisions r CROSS JOIN vnext.schema_migrations m WHERE r.project_id='${legacy_project}' GROUP BY r.revision, r.document, r.created_by_user_id, r.created_by_kind")"
expected_upgrade="1|镜像升级前场景|${legacy_author}|human|001_vnext_projects_graph.sql,002_graph_revisions_actor_kind.sql,003_vnext_app_runtime_membership.sql"
if [[ "$upgrade_evidence" != "$expected_upgrade" ]]; then
  echo "FAIL: 镜像 001→002/003 升级未完整保留旧 revision。实际: [$upgrade_evidence]" >&2
  exit 1
fi
echo "PASS: 镜像 001→002/003 升级保留旧 revision: $upgrade_evidence"
