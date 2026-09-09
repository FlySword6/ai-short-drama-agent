import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import { runVnextMigrations } from "../src/db/migrate.js";
import { ControlPackageRepository } from "../src/modules/vnext/control-packages/repository.js";
import { PendingIntentRepository } from "../src/modules/vnext/generation-intents/repository.js";

const databaseUrl = process.env.VNEXT_CONTROL_PACK_TEST_DATABASE_URL;

test("control package PostgreSQL preserves immutable versions and idempotent pending intents", { skip: !databaseUrl }, async () => {
  const handle = createDatabase(databaseUrl!);
  const projectId = randomUUID();
  const actorId = randomUUID();
  const versionId = randomUUID();
  try {
    await runVnextMigrations(handle.pool);
    await handle.db.execute(sql`INSERT INTO vnext.projects (id, name, owner_user_id) VALUES (${projectId}::uuid, 'control package db test', ${actorId}::uuid)`);
    await handle.db.execute(sql`INSERT INTO vnext.project_members (project_id, user_id, role) VALUES (${projectId}::uuid, ${actorId}::uuid, 'owner')`);
    const packages = new ControlPackageRepository(handle.db);
    const saved = await packages.write({
      projectId,
      actorId,
      references: [{
        referenceId: randomUUID(),
        referenceVersionId: versionId,
        label: "角色参考",
        reason: "保持角色一致",
        position: 0,
        capabilitySnapshot: { version: "caps-1", capturedAt: "2026-08-16T00:00:00.000Z", capabilities: ["image-reference"] },
      }],
      finalPrompt: "雨夜巷口，角色回望",
      model: "video-model-v1",
      parameters: { duration_seconds: 5, no_bgm: true },
      noBgm: true,
      modelAvailability: { status: "available", checkedAt: "2026-08-16T00:00:00.000Z" },
      estimatedCostFen: 42,
    });
    assert.equal(saved.version, 1);
    assert.equal((await packages.latest(projectId))?.references[0]?.referenceVersionId, versionId);
    await assert.rejects(
      handle.db.execute(sql`UPDATE vnext.control_package_versions SET snapshot = '{}'::jsonb WHERE id = ${saved.id}::uuid`),
      /append-only|Failed query/,
    );

    const intents = new PendingIntentRepository(handle.db);
    const input = {
      projectId,
      actorId,
      clientIdempotencyKey: "stable-paid-intent-key",
      controlPackageId: saved.id,
      controlPackageVersion: saved.version,
      references: saved.references,
      finalPrompt: saved.finalPrompt,
      model: saved.model,
      parameters: saved.parameters,
      noBgm: saved.noBgm,
      estimatedCostFen: saved.estimatedCostFen,
      status: "pending_confirmation" as const,
    };
    const created = await intents.create(input);
    const replay = await intents.create(input);
    assert.equal(created.created, true);
    assert.equal(replay.created, false);
    assert.equal(replay.intent.id, created.intent.id);
    assert.equal((await intents.latest(projectId, actorId))?.status, "pending_confirmation");
    const providerColumns = await handle.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_schema = 'vnext' AND table_name = 'pending_generation_intents'
        AND column_name IN ('provider_task_id', 'billing_receipt_id', 'provider_upload_id')`);
    assert.equal(providerColumns.rows[0]?.count, "0");
    await assert.rejects(
      handle.db.execute(sql`DELETE FROM vnext.pending_generation_intents WHERE id = ${created.intent.id}::uuid`),
      /append-only|Failed query/,
    );
  } finally {
    await handle.pool.end();
  }
});
