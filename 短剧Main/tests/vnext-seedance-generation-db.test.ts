/**
 * vNext generation task + attempt DB contract tests.
 *
 * Run with a real PostgreSQL instance via:
 *   VNEXT_SEEDANCE_GEN_TEST_DATABASE_URL=<url> node --import tsx --test tests/vnext-seedance-generation-db.test.ts
 *
 * The test creates a temporary schema and tears it down on exit.
 * Zero real provider calls. No paid smoke.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import { runVnextMigrations } from "../src/db/migrate.js";
import { VnextGenerationRepository } from "../src/modules/vnext/generation/repository.js";
import { PendingIntentRepository } from "../src/modules/vnext/generation-intents/repository.js";
import { ControlPackageRepository } from "../src/modules/vnext/control-packages/repository.js";

const databaseUrl = process.env.VNEXT_SEEDANCE_GEN_TEST_DATABASE_URL;

test("vnext generation task + attempt: idempotent create and stable attempt lifecycle", {
  skip: !databaseUrl,
}, async () => {
  const handle = createDatabase(databaseUrl!);
  const projectId = randomUUID();
  const actorId = randomUUID();
  const refVersionId = randomUUID();

  try {
    await runVnextMigrations(handle.pool);

    await handle.db.execute(sql`
      INSERT INTO vnext.projects (id, name, owner_user_id)
      VALUES (${projectId}::uuid, 'seedance gen db test', ${actorId}::uuid)`);
    await handle.db.execute(sql`
      INSERT INTO vnext.project_members (project_id, user_id, role)
      VALUES (${projectId}::uuid, ${actorId}::uuid, 'owner')`);

    // Create a control package.
    const packages = new ControlPackageRepository(handle.db);
    const pkg = await packages.write({
      projectId, actorId,
      references: [{
        referenceId: randomUUID(), referenceVersionId: refVersionId,
        label: "角色参考", reason: "保持角色一致", position: 0,
        capabilitySnapshot: { version: "caps-1", capturedAt: "2026-08-16T00:00:00.000Z", capabilities: ["image-reference"] },
      }],
      finalPrompt: "雨夜巷口，人物回望",
      model: "ep-seedance25",
      parameters: { ratio: "9:16", resolution: "720p", durationSeconds: 4 },
      noBgm: true,
      modelAvailability: { status: "available", checkedAt: "2026-08-16T00:00:00.000Z" },
      estimatedCostFen: 100,
    });
    assert.equal(pkg.version, 1);

    // Create a pending intent.
    const intents = new PendingIntentRepository(handle.db);
    const { intent } = await intents.create({
      projectId, actorId, clientIdempotencyKey: "idem-db-test-1",
      controlPackageId: pkg.id, controlPackageVersion: pkg.version,
      references: pkg.references, finalPrompt: pkg.finalPrompt,
      model: pkg.model, parameters: pkg.parameters,
      noBgm: pkg.noBgm, estimatedCostFen: pkg.estimatedCostFen,
      status: "pending_confirmation",
    });
    assert.ok(intent.id);

    // findById should return the intent.
    const found = await intents.findById(intent.id, projectId);
    assert.ok(found);
    assert.equal(found.id, intent.id);
    assert.equal(found.actorId, actorId);

    // Create a generation task.
    const repo = new VnextGenerationRepository(handle.db);
    const { task, created } = await repo.createTask({
      projectId, actorId, intentId: intent.id,
      clientIdempotencyKey: "task-idem-1",
      controlPackageId: pkg.id, controlPackageVersion: pkg.version,
      references: pkg.references,
      provider: "seedance_2_5",
      model: "ep-seedance25",
      prompt: "雨夜巷口，人物回望\n音频约束：只使用音效",
      noBgm: true,
      parameters: { ratio: "9:16", resolution: "720p", durationSeconds: 4, generateAudio: true },
      estimatedCostFen: 100,
    });
    assert.equal(created, true);
    assert.equal(task.status, "created");
    assert.equal(task.provider, "seedance_2_5");
    assert.deepEqual(task.references, pkg.references);
    assert.equal(task.noBgm, true);

    // Idempotent re-create returns same task.
    const { task: t2, created: c2 } = await repo.createTask({
      projectId, actorId, intentId: intent.id,
      clientIdempotencyKey: "task-idem-1",
      controlPackageId: pkg.id, controlPackageVersion: pkg.version,
      references: pkg.references,
      provider: "seedance_2_5", model: "ep-seedance25",
      prompt: "雨夜巷口，人物回望\n音频约束：只使用音效", noBgm: true,
      parameters: { ratio: "9:16", resolution: "720p", durationSeconds: 4, generateAudio: true },
      estimatedCostFen: 100,
    });
    assert.equal(c2, false);
    assert.equal(t2.id, task.id);

    // getTaskView should return task + latest attempt.
    const view = await repo.getTaskView(task.id, projectId);
    assert.ok(view);
    assert.equal(view.task.id, task.id);
    assert.deepEqual(view.task.references, pkg.references);
    assert.ok(view.latestAttempt);
    assert.equal(view.latestAttempt.status, "created");
    assert.equal(view.latestAttempt.attemptNo, 1);

    // Claim the attempt.
    const workerId = "test-worker-1";
    const leaseSeconds = 30;
    const claimedId = await repo.claimNextAttempt(workerId, leaseSeconds);
    assert.ok(claimedId, "Should claim the new attempt");

    // markSubmitting.
    await repo.markSubmitting(claimedId!, workerId);

    // markSubmitting: crashing after this should leave it in submitting →
    // worker picks it up and transitions to unknown_outcome.
    await repo.markUnknownOutcome(claimedId!, "Simulated crash in submitting", workerId);

    const ctx = await repo.getRecoverableContext(claimedId!);
    assert.equal(ctx?.attempt.status, "unknown_outcome");

    // Attempt control fields should be immutable (task only).
    // Verify that the task's control fields cannot be mutated via UPDATE.
    await assert.rejects(
      handle.db.execute(sql`
        UPDATE vnext.generation_tasks
        SET provider = 'evil_provider'
        WHERE id = ${task.id}::uuid`),
      (err: unknown) => {
        const direct = err instanceof Error ? err.message : String(err);
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
        return `${direct} ${cause}`.includes("immutable");
      },
    );

    // Renewal: worker with wrong id cannot renew.
    const renewedByWrongWorker = await repo.renewLease(claimedId!, "wrong-worker", 30);
    assert.equal(renewedByWrongWorker, false);

  } finally {
    await handle.pool.end();
  }
});

test("vnext generation attempt: markSucceeded propagates task status to succeeded", {
  skip: !databaseUrl,
}, async () => {
  const handle = createDatabase(databaseUrl!);
  const projectId = randomUUID();
  const actorId = randomUUID();

  try {
    await runVnextMigrations(handle.pool);

    await handle.db.execute(sql`
      INSERT INTO vnext.projects (id, name, owner_user_id)
      VALUES (${projectId}::uuid, 'seedance status prop test', ${actorId}::uuid)`);
    await handle.db.execute(sql`
      INSERT INTO vnext.project_members (project_id, user_id, role)
      VALUES (${projectId}::uuid, ${actorId}::uuid, 'owner')`);

    const packages = new ControlPackageRepository(handle.db);
    const pkg = await packages.write({
      projectId, actorId, references: [], finalPrompt: "test",
      model: "ep-test", parameters: {}, noBgm: true,
      modelAvailability: { status: "available", checkedAt: "2026-08-16T00:00:00.000Z" },
      estimatedCostFen: 0,
    });
    const intents = new PendingIntentRepository(handle.db);
    const { intent } = await intents.create({
      projectId, actorId, clientIdempotencyKey: "idem-status-test",
      controlPackageId: pkg.id, controlPackageVersion: pkg.version,
      references: [], finalPrompt: "test", model: "ep-test",
      parameters: {}, noBgm: true, estimatedCostFen: 0,
      status: "pending_confirmation",
    });
    const repo = new VnextGenerationRepository(handle.db);
    const { task } = await repo.createTask({
      projectId, actorId, intentId: intent.id,
      clientIdempotencyKey: "task-status-test",
      controlPackageId: pkg.id, controlPackageVersion: pkg.version,
      references: pkg.references,
      provider: "seedance_2_5", model: "ep-test", prompt: "test",
      noBgm: true, parameters: {}, estimatedCostFen: 0,
    });

    const workerId = "worker-status";
    const attemptId = (await repo.claimNextAttempt(workerId, 30))!;
    assert.ok(attemptId);

    await repo.markSubmitting(attemptId, workerId);
    await repo.markProviderQueued(attemptId, "prov-task-id", "queued", workerId);
    await repo.markProviderProgress(attemptId, "running", workerId);
    await repo.markProviderSucceeded(attemptId, {
      status: "succeeded", rawStatus: "succeeded", providerTaskId: "prov-task-id",
      mediaUrls: ["https://cdn.example.com/video.mp4"],
    }, workerId);
    await repo.markCopyingToTos(attemptId, workerId);
    await repo.markSucceeded(attemptId, workerId);

    const view = await repo.getTaskView(task.id, projectId);
    assert.equal(view?.task.status, "succeeded");
    assert.equal(view?.latestAttempt?.status, "succeeded");
  } finally {
    await handle.pool.end();
  }
});
