import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getTableColumns } from "drizzle-orm";
import { Pool } from "pg";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import {
  adminOperationActions,
  assetEntities,
  assetReviewActions,
  costEntries,
  generationRequests,
  projectMembers,
  projectReviewPolicies,
  projects,
  teams,
  userGroups,
  userGroupMembers,
  users,
} from "../src/db/schema.js";

const migrationPath = path.resolve("migrations/016_operations_foundation.sql");
const integrationTestDatabaseUrl = process.env.OPERATIONS_FOUNDATION_TEST_DATABASE_URL;

test("operations foundation migration is schema-scoped and contains the required safety contracts", async () => {
  const source = await readFile(migrationPath, "utf8");
  const migrationRunner = await readFile(path.resolve("src/db/migrate.ts"), "utf8");
  const rendered = renderMigrationSql(source, "operations_foundation_contract_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /current_setting\('shortdrama\.admin_usernames', true\)/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "operations_foundation_contract_test"\.project_members/);
  assert.match(rendered, /project_members_one_owner_per_project/);
  assert.match(rendered, /project_members_require_synchronized_owner/);
  assert.match(rendered, /assert_team_one_level/);
  assert.match(rendered, /INSERT INTO "operations_foundation_contract_test"\.project_members[\s\S]*'owner'/);
  assert.match(rendered, /INSERT INTO "operations_foundation_contract_test"\.project_members[\s\S]*'editor'/);
  assert.match(rendered, /SUM\(quote\.estimated_cost_fen\)/);
  assert.match(rendered, /generation_quotes_refresh_charged_points/);
  assert.match(rendered, /CREATE OR REPLACE VIEW "operations_foundation_contract_test"\.cost_entries/);
  assert.match(rendered, /COALESCE\(ai_call\.cost_fen, 0\) AS charged_points/);
  assert.match(rendered, /ai_call\.cost_fen IS NULL AS is_unpriced/);
  assert.match(rendered, /reviewer_user_id/);
  assert.match(rendered, /assigned_reviewer_user_id/);
  assert.match(rendered, /asset_entities_clearance_object_check/);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "operations_foundation_contract_test"\.admin_operation_actions/);
  assert.match(migrationRunner, /SELECT set_config\(\$1, \$2, true\)/);
  assert.match(migrationRunner, /settings\.adminUsernames\.join\(","\)/);
});

test("Drizzle operations schema exposes only the database facts owned by migration 016", () => {
  assert.ok("role" in getTableColumns(users));
  assert.ok("teamId" in getTableColumns(projects));
  assert.ok("genre" in getTableColumns(projects));
  assert.ok("projectId" in getTableColumns(projectMembers));
  assert.ok("parentTeamId" in getTableColumns(teams));
  assert.ok("name" in getTableColumns(userGroups));
  assert.ok("userGroupId" in getTableColumns(userGroupMembers));
  assert.ok("chargedPoints" in getTableColumns(generationRequests));
  assert.ok("reviewerUserId" in getTableColumns(projectReviewPolicies));
  assert.ok("assignedReviewerUserId" in getTableColumns(assetReviewActions));
  assert.ok("clearance" in getTableColumns(assetEntities));
  assert.ok("targetType" in getTableColumns(adminOperationActions));
  // Drizzle exposes `existing()` views through a dedicated view symbol rather
  // than getTableColumns(); the migration test above remains the column-level
  // contract for the SQL view itself.
  assert.ok(costEntries);
});

test("operations foundation forwards legacy ownership and cost facts in PostgreSQL", {
  skip: !integrationTestDatabaseUrl,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = `operations_migration_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const adminId = randomUUID();
  const creatorId = randomUUID();
  const projectId = randomUUID();
  const assetId = randomUUID();
  const requestId = randomUUID();
  const firstAttemptId = randomUUID();
  const retryAttemptId = randomUUID();
  const pricingRuleId = randomUUID();
  const firstQuoteId = randomUUID();
  const retryQuoteId = randomUUID();
  const policyId = randomUUID();
  const aiCallId = randomUUID();

  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    await applyMigrations(pool, schemaName, [
      "001_v01_core.sql",
      "002_generation_quotes.sql",
      "007_review_domain.sql",
      "009_global_asset_review_actions.sql",
      "014_ai_calls.sql",
    ]);

    await pool.query(`
      INSERT INTO ${schema}.users (id, username, display_name, password_hash, active)
      VALUES
        ($1, 'legacy-admin', 'Legacy Admin', 'test-only', true),
        ($2, 'legacy-creator', 'Legacy Creator', 'test-only', true)
    `, [adminId, creatorId]);
    await pool.query(`
      INSERT INTO ${schema}.projects (id, owner_user_id, name, status)
      VALUES ($1, $2, '迁移验证项目', 'active')
    `, [projectId, adminId]);
    await pool.query(`
      INSERT INTO ${schema}.asset_entities (id, asset_kind, name)
      VALUES ($1, 'character', '迁移验证角色')
    `, [assetId]);
    await pool.query(`
      INSERT INTO ${schema}.generation_requests (
        id, user_id, project_id, target_asset_entity_id, media_kind, prompt,
        reference_media_ids, reference_asset_snapshots, parameters, quantity,
        client_idempotency_key, request_hash
      ) VALUES (
        $1, $2, $3, $4, 'video', '迁移成本回填验证',
        '[]'::jsonb, '[]'::jsonb, '{"model_key":"seedance-test"}'::jsonb, 1,
        'operations-foundation-request', repeat('a', 64)
      )
    `, [requestId, creatorId, projectId, assetId]);
    await pool.query(`
      INSERT INTO ${schema}.pricing_rules (
        id, provider, model, media_kind, billing_unit, unit_price_fen,
        currency, source, effective_from, metadata
      ) VALUES (
        $1, 'ark', 'seedance-test', 'video', 'request', 1,
        'CNY', 'test', now(), '{}'::jsonb
      )
    `, [pricingRuleId]);
    await pool.query(`
      INSERT INTO ${schema}.generation_attempts (
        id, request_id, attempt_no, provider, model, estimated_cost_fen
      ) VALUES
        ($1, $2, 1, 'ark', 'seedance-test', 17),
        ($3, $2, 2, 'ark', 'seedance-test', 23)
    `, [firstAttemptId, requestId, retryAttemptId]);
    await pool.query(`
      INSERT INTO ${schema}.generation_quotes (
        id, user_id, source, action, request_hash, normalized_request,
        pricing_rule_id, price_snapshot, estimated_cost_fen, status,
        expires_at, confirmed_at, consumed_at, generation_request_id,
        generation_attempt_id
      ) VALUES ($1, $2, 'web', 'submit', repeat('b', 64), '{}'::jsonb,
        $3, '{}'::jsonb, 17, 'consumed', now() + interval '1 hour', now(), now(), $4, $5)
    `, [firstQuoteId, creatorId, pricingRuleId, requestId, firstAttemptId]);
    await pool.query(`
      INSERT INTO ${schema}.generation_quotes (
        id, user_id, source, action, original_request_id, base_attempt_id,
        base_attempt_no, request_hash, normalized_request, pricing_rule_id,
        price_snapshot, estimated_cost_fen, status, expires_at, confirmed_at,
        consumed_at, generation_request_id, generation_attempt_id
      ) VALUES ($1, $2, 'web', 'retry', $3, $4, 1, repeat('c', 64), '{}'::jsonb,
        $5, '{}'::jsonb, 23, 'consumed', now() + interval '1 hour', now(), now(), $3, $6)
    `, [retryQuoteId, creatorId, requestId, firstAttemptId, pricingRuleId, retryAttemptId]);
    await pool.query(`
      INSERT INTO ${schema}.project_review_policies (
        id, project_id, media_kind, default_strategy, updated_by_user_id, version
      ) VALUES ($1, $2, 'video', 'pending_review', $3, 1)
    `, [policyId, projectId, adminId]);
    await pool.query(`
      INSERT INTO ${schema}.ai_calls (
        id, caller_user_id, project_id, purpose, provider, model, status,
        duration_ms, completed_at
      ) VALUES ($1, $2, $3, 'operations.test', 'ark', 'seedance-test', 'succeeded', 1, now())
    `, [aiCallId, creatorId, projectId]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config($1, $2, true)", [
        "shortdrama.admin_usernames",
        "legacy-admin",
      ]);
      await applyMigrations(client, schemaName, ["016_operations_foundation.sql"]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const roles = await pool.query<{ username: string; role: string }>(`
      SELECT username, role FROM ${schema}.users ORDER BY username
    `);
    assert.deepEqual(roles.rows, [
      { username: "legacy-admin", role: "admin" },
      { username: "legacy-creator", role: "member" },
    ]);

    const members = await pool.query<{ user_id: string; role: string }>(`
      SELECT user_id, role FROM ${schema}.project_members
      WHERE project_id = $1 ORDER BY role DESC
    `, [projectId]);
    assert.deepEqual(members.rows, [
      { user_id: adminId, role: "owner" },
      { user_id: creatorId, role: "editor" },
    ]);

    const projectTeam = await pool.query<{ name: string; team_id: string | null }>(`
      SELECT team.name, project.team_id
      FROM ${schema}.projects project
      INNER JOIN ${schema}.teams team ON team.id = project.team_id
      WHERE project.id = $1
    `, [projectId]);
    assert.equal(projectTeam.rows[0]?.name, "未分配");
    assert.ok(projectTeam.rows[0]?.team_id);

    const charged = await pool.query<{ charged_points: number }>(`
      SELECT charged_points FROM ${schema}.generation_requests WHERE id = $1
    `, [requestId]);
    assert.equal(charged.rows[0]?.charged_points, 40, "all consumed quotes, including retry, must accumulate");

    const aiCostEntry = await pool.query<{ charged_points: number; is_unpriced: boolean }>(`
      SELECT charged_points, is_unpriced FROM ${schema}.cost_entries
      WHERE source_table = 'ai_calls' AND source_id = $1
    `, [aiCallId]);
    assert.deepEqual(aiCostEntry.rows, [{ charged_points: 0, is_unpriced: true }]);

    const generatedCostEntry = await pool.query<{ charged_points: number; is_unpriced: boolean }>(`
      SELECT charged_points, is_unpriced FROM ${schema}.cost_entries
      WHERE source_table = 'generation_requests' AND source_id = $1
    `, [requestId]);
    assert.deepEqual(generatedCostEntry.rows, [{ charged_points: 40, is_unpriced: false }]);

    const clearance = await pool.query<{ search: string; publish: string }>(`
      SELECT clearance ->> 'search' AS search,
             clearance ->> 'commercial_publish' AS publish
      FROM ${schema}.asset_entities WHERE id = $1
    `, [assetId]);
    assert.deepEqual(clearance.rows, [{ search: "true", publish: "false" }]);

    const reviewer = await pool.query<{ reviewer_user_id: string | null }>(`
      UPDATE ${schema}.project_review_policies
      SET reviewer_user_id = $1
      WHERE id = $2
      RETURNING reviewer_user_id
    `, [creatorId, policyId]);
    assert.deepEqual(reviewer.rows, [{ reviewer_user_id: creatorId }]);

    const actionId = randomUUID();
    const assignment = await pool.query<{ assigned_reviewer_user_id: string | null }>(`
      INSERT INTO ${schema}.asset_review_actions (
        id, project_id, asset_entity_id, action, from_status, to_status,
        reviewer_user_id, assigned_reviewer_user_id
      ) VALUES ($1, $2, $3, 'submitted', 'automatic_review', 'pending_review', $4, $5)
      RETURNING assigned_reviewer_user_id
    `, [actionId, projectId, assetId, adminId, creatorId]);
    assert.deepEqual(assignment.rows, [{ assigned_reviewer_user_id: creatorId }]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

async function applyMigrations(
  executor: Pick<Pool, "query">,
  schemaName: string,
  fileNames: readonly string[],
): Promise<void> {
  for (const fileName of fileNames) {
    const source = await readFile(path.resolve("migrations", fileName), "utf8");
    await executor.query(renderMigrationSql(source, schemaName));
  }
}
