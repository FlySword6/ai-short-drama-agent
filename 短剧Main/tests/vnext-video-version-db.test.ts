/**
 * vNext video version DB contract tests.
 *
 * Run with a real PostgreSQL instance via:
 *   VNEXT_VIDEO_VERSION_TEST_DATABASE_URL=<url> node --import tsx --test tests/vnext-video-version-db.test.ts
 *
 * Covers: chain growth from succeeded attempts, idempotent registration,
 * single-child conflict, append-only enforcement — with immutability and the
 * advisory-lock insert path pinned to the real runtime role vnext_app (a
 * superuser connection would bypass REVOKE and hide permission-contract
 * regressions; SELECT ... FOR UPDATE on these tables would fail 42501).
 * Zero real provider calls. No paid smoke.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { createDatabase, type Database } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { runVnextMigrations } from "../src/db/migrate.js";
import { ConflictError, ForbiddenError } from "../src/shared/errors.js";
import { ControlPackageRepository } from "../src/modules/vnext/control-packages/repository.js";
import { ControlPackageService, createControlPackageProjectAccess } from "../src/modules/vnext/control-packages/service.js";
import { VnextPendingIntentAuthorization } from "../src/modules/vnext/generation-intents/authorization.js";
import { PendingIntentRepository } from "../src/modules/vnext/generation-intents/repository.js";
import { GenerationIntentService } from "../src/modules/vnext/generation-intents/service.js";
import { VnextDatabaseReferenceResolver } from "../src/modules/vnext/generation/referenceResolver.js";
import { VnextGenerationRepository } from "../src/modules/vnext/generation/repository.js";
import { VnextGenerationService } from "../src/modules/vnext/generation/service.js";
import { Seedance25Provider } from "../src/modules/vnext/providers/seedance/seedance25Provider.js";

import { VnextVideoChangeDraftRepository, VnextVideoVersionRepository } from "../src/modules/vnext/video-versions/repository.js";
import { VnextVideoVersionService } from "../src/modules/vnext/video-versions/service.js";

const databaseUrl = process.env.VNEXT_VIDEO_VERSION_TEST_DATABASE_URL;

const TOS_ITEM = {
  providerResultKey: "0:https://cdn.example.com/v.mp4",
  storageBucket: "bucket",
  objectKey: "vnext/generation/t/a/0.mp4",
  storageUrl: "https://tos.example.com/vnext/generation/t/a/0.mp4",
  mimeType: "video/mp4",
  sha256: "a".repeat(64),
  durationSeconds: 4,
  copiedAt: "2026-08-17T00:00:00.000Z",
};

test("vnext video versions: chain growth, idempotency, conflict, and append-only under vnext_app", {
  skip: !databaseUrl,
}, async (t) => {
  const handle = createDatabase(databaseUrl!);
  const projectId = randomUUID();
  const actorId = randomUUID();
  const foreignProjectId = randomUUID();
  const foreignActorId = randomUUID();

  try {
    await runVnextMigrations(handle.pool);
    await handle.db.execute(sql`
      INSERT INTO vnext.projects (id, name, owner_user_id)
      VALUES (${projectId}::uuid, 'video version db test', ${actorId}::uuid)`);
    await handle.db.execute(sql`
      INSERT INTO vnext.project_members (project_id, user_id, role)
      VALUES (${projectId}::uuid, ${actorId}::uuid, 'owner')`);
    await handle.db.execute(sql`
      INSERT INTO vnext.projects (id, name, owner_user_id)
      VALUES (${foreignProjectId}::uuid, 'foreign video version db test', ${foreignActorId}::uuid)`);
    await handle.db.execute(sql`
      INSERT INTO vnext.project_members (project_id, user_id, role)
      VALUES (${foreignProjectId}::uuid, ${foreignActorId}::uuid, 'owner')`);

    const versions = new VnextVideoVersionRepository(handle.db);
    const drafts = new VnextVideoChangeDraftRepository(handle.db);

    async function createSucceededTask(
      key: string,
      costFen: number,
      target: { projectId: string; actorId: string } = { projectId, actorId },
      database: Database = handle.db,
      model = "ep-seedance25",
      provider = "seedance_2_5",
    ) {
      const packages = new ControlPackageRepository(database);
      const intents = new PendingIntentRepository(database);
      const generation = new VnextGenerationRepository(database);
      const pkg = await packages.write({
        projectId: target.projectId, actorId: target.actorId, references: [],
        finalPrompt: `雨夜巷口 ${key}`, model,
        parameters: { ratio: "9:16", durationSeconds: 4 }, noBgm: true,
        modelAvailability: { status: "available", checkedAt: "2026-08-16T00:00:00.000Z" },
        estimatedCostFen: costFen,
      });
      const { intent } = await intents.create({
        projectId: target.projectId, actorId: target.actorId, clientIdempotencyKey: `intent-${key}`,
        controlPackageId: pkg.id, controlPackageVersion: pkg.version,
        references: [], finalPrompt: pkg.finalPrompt, model: pkg.model,
        parameters: pkg.parameters, noBgm: pkg.noBgm, estimatedCostFen: pkg.estimatedCostFen,
        status: "pending_confirmation",
      });
      const { task } = await generation.createTask({
        projectId: target.projectId, actorId: target.actorId, intentId: intent.id, clientIdempotencyKey: `task-${key}`,
        controlPackageId: pkg.id, controlPackageVersion: pkg.version,
        references: [], provider, model: pkg.model,
        prompt: pkg.finalPrompt, noBgm: true,
        parameters: { ratio: "9:16", durationSeconds: 4, generateAudio: true },
        estimatedCostFen: costFen,
      });
      const worker = `worker-${key}`;
      const attemptId = await generation.claimNextAttempt(worker, 30);
      assert.ok(attemptId, `expected claimable attempt for ${key}`);
      await generation.markSubmitting(attemptId, worker);
      await generation.markProviderQueued(attemptId, `prov-${key}`, "queued", worker);
      await generation.markProviderSucceeded(attemptId, {
        status: "succeeded", rawStatus: "succeeded", providerTaskId: `prov-${key}`,
        mediaUrls: ["https://cdn.example.com/v.mp4"],
      }, worker);
      await generation.markCopyingToTos(attemptId, worker);
      await generation.recordTosMedia(attemptId, { ...TOS_ITEM, objectKey: `vnext/generation/${task.id}/${attemptId}/0.mp4` }, worker);
      await generation.markSucceeded(attemptId, worker);
      return { pkg, intent, task, attemptId };
    }

    function attachInput(
      task: { id: string; controlPackageId: string; controlPackageVersion: number; provider: string; model: string; prompt: string; estimatedCostFen: number; parameters: Record<string, unknown> },
      attemptId: string,
      origin: { id: string } | null,
      changeType: "register" | "modify" | "extend",
      target: { projectId: string; actorId: string } = { projectId, actorId },
    ) {
      return {
        projectId: target.projectId, actorId: target.actorId, changeType,
        originVersionId: origin?.id ?? null,
        sourceTaskId: task.id, sourceAttemptId: attemptId,
        controlPackageId: task.controlPackageId, controlPackageVersion: task.controlPackageVersion,
        provider: task.provider, model: task.model, prompt: task.prompt,
        parameters: task.parameters, tosMedia: [TOS_ITEM],
        estimatedCostFen: task.estimatedCostFen, actualCostFen: null,
      };
    }

    // ── Register version 1 from a succeeded attempt; idempotent replay. ──────
    const foreign = await createSucceededTask("foreign", 100, { projectId: foreignProjectId, actorId: foreignActorId });
    const { version: foreignVersion } = await versions.create(
      attachInput(foreign.task, foreign.attemptId, null, "register", { projectId: foreignProjectId, actorId: foreignActorId }),
    );
    const first = await createSucceededTask("one", 100);
    const { version: v1, created } = await versions.create(attachInput(first.task, first.attemptId, null, "register"));
    assert.equal(created, true);
    assert.equal(v1.versionNo, 1);
    assert.equal(v1.changeType, "register");
    assert.equal(v1.originVersionId, null);
    assert.equal(v1.chainId, v1.id);
    assert.equal(v1.tosMedia.length, 1);
    assert.equal(v1.estimatedCostFen, 100);


    const replay = await versions.create(attachInput(first.task, first.attemptId, null, "register"));
    assert.equal(replay.created, false);
    assert.equal(replay.version.id, v1.id);

    // ── Change draft linkage is idempotent and conflict-checked. ─────────────
    const second = await createSucceededTask("two", 120);
    const draftInput = {
      projectId, actorId, originVersionId: v1.id, changeType: "modify" as const,
      intentId: second.intent.id, clientIdempotencyKey: "draft-modify-1",
    };
    const draftCreated = await drafts.create(draftInput);
    assert.equal(draftCreated.created, true);
    const draftReplay = await drafts.create(draftInput);
    assert.equal(draftReplay.created, false);
    assert.equal(draftReplay.draft.id, draftCreated.draft.id);
    await assert.rejects(
      drafts.create({ ...draftInput, changeType: "extend" }),
      (error: unknown) => error instanceof ConflictError,
    );
    assert.equal((await drafts.findByIntentId(second.intent.id))?.originVersionId, v1.id);
    assert.equal(await drafts.findUnlinkedIntentIdByKey(projectId, actorId, "intent-two"), null);

    // ── Modify grows the same chain to version 2; origin stays untouched. ────
    const { version: v2, created: createdV2 } = await versions.create(attachInput(second.task, second.attemptId, v1, "modify"));
    assert.equal(createdV2, true);
    assert.equal(v2.versionNo, 2);
    assert.equal(v2.chainId, v1.chainId);
    assert.equal(v2.originVersionId, v1.id);
    assert.equal(v2.estimatedCostFen, 120);

    const chain = await versions.listByProject(projectId);
    assert.deepEqual(chain.map((row) => row.versionNo), [1, 2]);
    assert.equal(chain[0]?.id, v1.id, "origin row must remain the first chain entry");

    // ── Linear growth: a second child on the same origin conflicts. ──────────
    const third = await createSucceededTask("three", 130);
    await assert.rejects(
      versions.create(attachInput(third.task, third.attemptId, v1, "modify")),
      (error: unknown) => error instanceof ConflictError
        && (error as ConflictError).message.includes("后续版本"),
    );

    // ── A version row requires persisted TOS media (CHECK). ──────────────────
    await assert.rejects(
      versions.create({ ...attachInput(third.task, third.attemptId, null, "register"), tosMedia: [] }),
      /vnext_video_versions_tos_media|Failed query/,
    );

    // ── Append-only: triggers reject mutation even for the owner connection. ──
    await assert.rejects(
      handle.db.execute(sql`UPDATE vnext.video_versions SET prompt = 'evil' WHERE id = ${v1.id}::uuid`),
      /append-only|Failed query/,
    );
    await assert.rejects(
      handle.db.execute(sql`DELETE FROM vnext.video_versions WHERE id = ${v1.id}::uuid`),
      /append-only|Failed query/,
    );
    await assert.rejects(
      handle.db.execute(sql`DELETE FROM vnext.video_change_drafts WHERE id = ${draftCreated.draft.id}::uuid`),
      /append-only|Failed query/,
    );

    // ── Runtime role contract: pin vnext_app so REVOKE actually bites. ────────
    const roleClient = await handle.pool.connect();
    try {
      await roleClient.query("SET ROLE vnext_app");
      const roleDb = drizzle(roleClient, { schema: schema.databaseSchema }) as unknown as Database;

      // SELECT + INSERT are granted: the full repository insert path (advisory
      // lock, no row locks on immutable tables) succeeds under the real role.
      const roleVersions = new VnextVideoVersionRepository(roleDb);
      const { version: vOther, created: createdOther } = await roleVersions.create(
        attachInput(third.task, third.attemptId, null, "register"),
      );
      assert.equal(createdOther, true);
      assert.equal(vOther.versionNo, 1);
      const listed = await roleVersions.listByProject(projectId);
      assert.equal(listed.length, 3);

      // Resolver reads the append-only version under the real runtime role.
      const signedOriginUrl = "https://tos.example.com/vnext/generation/t/a/0.mp4?X-Tos-Signature=test";
      const roleResolver = new VnextDatabaseReferenceResolver(roleDb, {
        async createDownloadUrl(storagePath, options) {
          assert.equal(storagePath, TOS_ITEM.objectKey);
          assert.deepEqual(options, { bucket: TOS_ITEM.storageBucket, expiresSeconds: 900 });
          return { url: signedOriginUrl, expiresAt: new Date("2026-08-17T00:15:00.000Z") };
        },
      });
      const originReference = [{
        referenceId: v1.id,
        referenceVersionId: v1.id,
        label: "原视频段 v1",
        reason: "修改或续写的来源",
        position: 0,
        capabilitySnapshot: {
          version: "vnext-video-version",
          capturedAt: "2026-08-17T00:00:00.000Z",
          capabilities: ["video-reference"],
        },
      }];
      const resolvedOrigin = await roleResolver.resolve(projectId, originReference);
      assert.deepEqual(
        resolvedOrigin,
        [{ referenceVersionId: v1.id, kind: "video", url: signedOriginUrl, durationSeconds: 4 }],
      );
      await assert.rejects(
        roleResolver.resolve(randomUUID(), originReference),
        /不存在、未通过审核或不支持/,
      );

      // A human-created change draft must clear the pending-intent authorization
      // gate and then resolve its video reference under the runtime role.
      const roleAccess = createControlPackageProjectAccess(roleDb);
      const roleIntents = new GenerationIntentService(
        new PendingIntentRepository(roleDb),
        new ControlPackageRepository(roleDb),
        roleAccess,
        new VnextPendingIntentAuthorization(roleDb, roleDb),
      );
      const roleVideoService = new VnextVideoVersionService({
        versions: roleVersions,
        drafts: new VnextVideoChangeDraftRepository(roleDb),
        access: roleAccess,
        controlPackages: new ControlPackageService(new ControlPackageRepository(roleDb), roleAccess),
        intents: roleIntents,
        pendingIntents: new PendingIntentRepository(roleDb),
        generationTasks: new VnextGenerationRepository(roleDb),
        lockedTaskParameters: new Seedance25Provider({
          apiKey: "test-key",
          endpointModel: "ep-seedance25",
        }),
      });
      const draftInput = {
        changeType: "modify" as const,
        clientIdempotencyKey: "runtime-video-reference",
        references: originReference,
        finalPrompt: "雨夜巷口，人物回望（修改）",
        model: "ep-seedance25",
        parameters: { ratio: "9:16", durationSeconds: 4 },
        noBgm: true,
        modelAvailability: { status: "available" as const, checkedAt: "2026-08-17T00:00:00.000Z" },
        estimatedCostFen: 100,
      };
      const changeDraft = await roleVideoService.createChangeDraft(actorId, projectId, v1.id, draftInput);
      assert.equal(changeDraft.intent.references[0]?.referenceVersionId, v1.id);
      assert.deepEqual(await roleResolver.resolve(projectId, changeDraft.intent.references), [
        { referenceVersionId: v1.id, kind: "video", url: signedOriginUrl, durationSeconds: 4 },
      ]);
      // Draft → control package → intent → confirm must preserve the locked
      // Seedance parameters under the actual runtime role. The provider seam
      // rejects any accidental dispatch; confirm only creates a paid task.
      assert.equal(changeDraft.intent.parameters["ratio"], "adaptive");
      assert.equal(changeDraft.intent.parameters["durationSeconds"], -1);
      const confirmService = new VnextGenerationService({
        store: new VnextGenerationRepository(roleDb),
        intents: new PendingIntentRepository(roleDb),
        access: roleAccess,
        provider: new Seedance25Provider({
          apiKey: "test-key",
          endpointModel: "ep-seedance25",
          fetchImpl: async () => {
            throw new Error("confirm must not submit to the provider");
          },
        }),
        storage: {
          async downloadBytes() { throw new Error("confirm must not download media"); },
          async uploadBytes() { throw new Error("confirm must not upload media"); },
        },
        referenceResolver: {
          async resolve() { throw new Error("confirm must not resolve provider references"); },
        },
      });
      const lockedTask = await confirmService.confirmIntent(
        actorId,
        projectId,
        changeDraft.intent.id,
        "runtime-video-reference-confirm",
      );
      assert.equal(lockedTask.task.parameters["ratio"], "adaptive");
      assert.equal(lockedTask.task.parameters["durationSeconds"], -1);
      await assert.rejects(
        roleVideoService.createChangeDraft(actorId, projectId, v1.id, {
          ...draftInput,
          clientIdempotencyKey: "foreign-video-reference",
          references: [{ ...originReference[0]!, referenceId: foreignVersion.id, referenceVersionId: foreignVersion.id }],
        }),
        (error: unknown) => error instanceof ForbiddenError,
      );

      await t.test("vnext video versions: cross-provider extend is currently permitted (characterization)", async () => {
        // This fixes the observed behavior as of 2026-08-21. The boundary of a
        // “do not mix” policy awaits product decisions including #432. If a
        // cross-model check is later added, this test must turn red and be
        // updated to assert that behavior, never deleted or skipped.
        const crossProviderSource = await createSucceededTask(
          "cross-provider-source",
          140,
          { projectId, actorId },
          roleDb,
          "ep-cross-provider-source",
          "cross_provider_source",
        );
        const crossProviderTarget = await createSucceededTask(
          "cross-provider-target",
          100,
          { projectId, actorId },
          roleDb,
          "ep-cross-provider-target",
          "cross_provider_target",
        );
        const { version: crossSourceVersion } = await roleVersions.create(
          attachInput(crossProviderSource.task, crossProviderSource.attemptId, null, "register"),
        );
        const { version: crossTargetVersion } = await roleVersions.create(
          attachInput(crossProviderTarget.task, crossProviderTarget.attemptId, null, "register"),
        );
        assert.notEqual(crossSourceVersion.provider, crossTargetVersion.provider);
        assert.notEqual(crossSourceVersion.model, crossTargetVersion.model);

        const crossProviderDraft = await roleVideoService.createChangeDraft(actorId, projectId, crossSourceVersion.id, {
          changeType: "extend",
          clientIdempotencyKey: "cross-provider-extend-characterization",
          references: [{
            referenceId: crossSourceVersion.id,
            referenceVersionId: crossSourceVersion.id,
            label: "跨模型原视频段",
            reason: "续写来源",
            position: 0,
            capabilitySnapshot: {
              version: "vnext-video-version",
              capturedAt: "2026-08-21T00:00:00.000Z",
              capabilities: ["video-reference"],
            },
          }],
          finalPrompt: "雨夜巷口，人物继续前行（跨模型续写）",
          model: crossTargetVersion.model,
          parameters: { ratio: "9:16", durationSeconds: 4 },
          noBgm: true,
          modelAvailability: { status: "available", checkedAt: "2026-08-21T00:00:00.000Z" },
          estimatedCostFen: 100,
        });
        assert.equal(crossProviderDraft.intent.references[0]?.referenceVersionId, crossSourceVersion.id);
        assert.deepEqual(await roleResolver.resolve(projectId, crossProviderDraft.intent.references), [
          { referenceVersionId: crossSourceVersion.id, kind: "video", url: signedOriginUrl, durationSeconds: 4 },
        ]);
      });

      // UPDATE/DELETE are revoked from vnext_app on both append-only tables.
      await assert.rejects(
        roleClient.query(`UPDATE vnext.video_versions SET prompt = 'evil' WHERE id = '${v1.id}'`),
        /permission denied|42501/,
      );
      await assert.rejects(
        roleClient.query(`DELETE FROM vnext.video_versions WHERE id = '${v1.id}'`),
        /permission denied|42501/,
      );
      await assert.rejects(
        roleClient.query(`UPDATE vnext.video_change_drafts SET change_type = 'extend' WHERE id = '${draftCreated.draft.id}'`),
        /permission denied|42501/,
      );
      await assert.rejects(
        roleClient.query(`DELETE FROM vnext.video_change_drafts WHERE id = '${draftCreated.draft.id}'`),
        /permission denied|42501/,
      );
      const readable = await roleClient.query(`SELECT count(*)::text AS count FROM vnext.video_versions`);
      assert.equal(readable.rows[0]?.count, "6");
    } finally {
      await roleClient.query("RESET ROLE").catch(() => undefined);
      roleClient.release();
    }
  } finally {
    await handle.pool.end();
  }
});
