import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDatabase } from "../src/db/client.js";
import { createVnextDatabase, VNEXT_RUNTIME_ROLE } from "../src/modules/vnext/db.js";
import { runMigrations } from "../src/db/migrate.js";
import { SnapshotAImportService, type SnapshotARegistrationPort, type SnapshotATosVerificationPort } from "../src/modules/vnext/imports/service.js";

const databaseUrl = process.env.VNEXT_ASSETS_TEST_DATABASE_URL;
const baseInput = {
  sourceSystem: "legacy_snapshot_a",
  sourceId: "approved-scene-001",
  name: "雨夜街道",
  assetKind: "scene" as const,
  mediaKind: "image" as const,
  mediaUrl: "https://assets.example.test/snapshot-a/rain-street.png",
  mediaSha256: "a".repeat(64),
  snapshotAt: "2026-08-15T00:00:00.000Z",
  snapshotVersion: "snapshot-a",
};

type DatabaseHandle = ReturnType<typeof createDatabase>;
function counts(handle: DatabaseHandle) {
  return handle.pool.query<{ assets: number; mappings: number; attempts: number; verifications: number }>(`
    SELECT (SELECT count(*)::int FROM vnext.imported_assets) AS assets,
           (SELECT count(*)::int FROM vnext.import_source_mappings) AS mappings,
           (SELECT count(*)::int FROM vnext.import_registration_attempts) AS attempts,
           (SELECT count(*)::int FROM vnext.import_verification_attempts) AS verifications`);
}

async function seedApproval(handle: DatabaseHandle, input: typeof baseInput): Promise<void> {
  await handle.pool.query(
    `INSERT INTO vnext.import_source_approvals (
      source_system, source_id, media_sha256, asset_kind, media_kind, name, snapshot_version, source_snapshot_at, approved, is_human
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, FALSE)`,
    [input.sourceSystem, input.sourceId, input.mediaSha256, input.assetKind, input.mediaKind, input.name, input.snapshotVersion, input.snapshotAt],
  );
}

test("Snapshot A keeps source truth isolated, exactly-once registration intent, and recovery on real PostgreSQL", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "db"].includes(new URL(databaseUrl).hostname));
  const handle = createDatabase(databaseUrl);
  let runtimeHandle: ReturnType<typeof createVnextDatabase> | undefined;
  let registerCalls = 0;
  let readbackCalls = 0;
  let registrationOutcome: "active" | "failed" = "active";
  let tosOutcome: "verified" | "unavailable" = "verified";
  const registration: SnapshotARegistrationPort = {
    async register({ assetId }) {
      registerCalls += 1;
      if (registrationOutcome === "failed") {
        return {
          registrationId: `remote-${assetId}`,
          status: "failed",
          failureCode: "ASSET_REGISTRY_REJECTED",
          failureReason: "controlled registration failure",
          readback: { state: "Failed" },
        };
      }
      return { registrationId: `remote-${assetId}`, status: "active", readback: { state: "Active" } };
    },
    async readback({ registrationId }) {
      readbackCalls += 1;
      return { registrationId, status: "active", readback: { state: "Active" } };
    },
    async readbackByName({ assetId, name }: { assetId: string; name: string }) {
      readbackCalls += 1;
      return { registrationId: "remote-reconciled", status: "active", readback: { state: "Active" } };
    },
  };
  const tos: SnapshotATosVerificationPort = {
    async verify({ mediaUrl, mediaSha256 }) {
      if (tosOutcome === "unavailable") throw new Error("controlled TOS outage");
      return { mediaUrl, mediaSha256: mediaSha256.toLowerCase() };
    },
  };
  try {
    await handle.pool.query("DROP SCHEMA IF EXISTS vnext CASCADE");
    await handle.pool.query('DROP SCHEMA IF EXISTS "app" CASCADE');
    const applied = await runMigrations(handle);
    assert.ok(applied.includes("vnext/005_snapshot_a_assets.sql"));
    await handle.pool.query("GRANT vnext_app TO CURRENT_USER");
    runtimeHandle = createVnextDatabase(databaseUrl);
    const runtimeRole = await runtimeHandle.pool.query<{ current_user: string }>("SELECT current_user");
    assert.equal(runtimeRole.rows[0]?.current_user, "vnext_app", "运行时连接必须按生产合同以最小权限角色执行");
    await handle.pool.query(`CREATE TABLE "app".lite_sentinel_assets (id uuid PRIMARY KEY, name text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await handle.pool.query(`INSERT INTO "app".lite_sentinel_assets (id, name) VALUES ($1::uuid, 'lite-sentinel')`, [randomUUID()]);
    const liteSentinelBefore = await handle.pool.query<{ id: string; name: string; updated_at: Date }>(`SELECT id, name, updated_at FROM "app".lite_sentinel_assets LIMIT 1`);
    await assert.rejects(
      runtimeHandle.pool.query(`UPDATE "app".lite_sentinel_assets SET name='mutated'`),
      /permission denied/,
      "运行时角色不得更新真实 Lite 存储",
    );
    await assert.rejects(
      runtimeHandle.pool.query(`DELETE FROM "app".lite_sentinel_assets`),
      /permission denied/,
      "运行时角色不得删除真实 Lite 存储",
    );
    for (const input of [
      baseInput,
      { ...baseInput, sourceId: "approved-scene-concurrent", mediaSha256: "d".repeat(64) },
      { ...baseInput, sourceId: "approved-character-002", assetKind: "character" as const, mediaSha256: "b".repeat(64) },
      { ...baseInput, sourceId: "approved-prop-video-003", assetKind: "prop" as const, mediaKind: "video" as const, mediaSha256: "c".repeat(64) },
      { ...baseInput, sourceId: "approved-scene-disabled", mediaSha256: "e".repeat(64) },
      { ...baseInput, sourceId: "approved-scene-retry-race", mediaSha256: "9".repeat(64) },
      { ...baseInput, sourceId: "approved-scene-processing-readback", mediaSha256: "7".repeat(64) },
      { ...baseInput, sourceId: "approved-scene-no-tos", mediaSha256: "8".repeat(64) },
      { ...baseInput, sourceId: "approved-scene-name-mismatch", mediaSha256: "6".repeat(64) },
    ]) {
      await seedApproval(handle, input);
    }

    // Trusted-source gate: server-side allowlist, not caller attestation.
    await assert.rejects(
      () => new SnapshotAImportService(handle.db, registration, tos).import({ ...baseInput, sourceId: "unlisted-source", mediaSha256: "f".repeat(64) }),
      /受信批准/,
    );
    const beforeGate = await counts(handle);
    assert.deepEqual(
      beforeGate.rows[0],
      { assets: 0, mappings: 0, attempts: 0, verifications: 0 },
      "未受信来源不得留下任何资产、映射或校验记录",
    );

    // Controlled TOS failure: nothing persisted; the failure is audited and retryable.
    tosOutcome = "unavailable";
    await assert.rejects(
      () => new SnapshotAImportService(handle.db, registration, tos).import(baseInput),
      /TOS/,
    );
    tosOutcome = "verified";
    const afterTosFailure = await counts(handle);
    assert.equal(afterTosFailure.rows[0]?.assets, 0, "TOS 校验失败不得落资产行");
    assert.equal(afterTosFailure.rows[0]?.verifications, 1, "TOS 校验失败必须留可重试证据");

    const service = new SnapshotAImportService(runtimeHandle.db, registration, tos);
    const first = await service.import(baseInput);
    const second = await service.import(baseInput);
    assert.equal(first.outcome, "created");
    assert.equal(second.outcome, "replayed");
    assert.equal(second.asset.id, first.asset.id);
    assert.equal(registerCalls, 1, "repeated import must not repeat external registration intent");
    assert.equal(first.asset.libraryName, "旧系统素材库");
    assert.equal(first.asset.registrationStatus, "active");
    assert.deepEqual(first.asset.registrationReadback, { state: "Active" });
    await assert.rejects(
      () => service.import({ ...baseInput, sourceId: "approved-scene-name-mismatch", mediaSha256: "6".repeat(64), name: "未批准名称" }),
      /素材事实与批准记录不一致/,
      "批准记录必须绑定展示名称和快照版本",
    );
    assert.equal(first.asset.mediaSha256, "a".repeat(64));
    await assert.rejects(
      () => service.import({ ...baseInput, sourceId: "approved-scene-disabled", mediaSha256: "f".repeat(64) }),
      /素材事实与批准记录不一致/,
      "批准记录必须绑定媒体哈希和素材类型",
    );
    await assert.rejects(
      () => service.import({ ...baseInput, mediaSha256: "f".repeat(64) }),
      /不可变素材事实发生冲突/,
      "同一旧来源不得映射为另一份媒体",
    );
    await assert.rejects(
      () => service.import({ ...baseInput, snapshotAt: "2026-08-16T00:00:00.000Z" }),
      /不可变素材事实发生冲突/,
      "同一旧来源不得改写快照时间",
    );

    const concurrent = await Promise.all(Array.from({ length: 12 }, () => service.import({
      ...baseInput,
      sourceId: "approved-scene-concurrent",
      mediaSha256: "d".repeat(64),
    })));
    assert.equal(new Set(concurrent.map((item) => item.asset.id)).size, 1, "并发导入必须重放同一素材");
    assert.equal(concurrent.filter((item) => item.outcome === "created").length, 1, "并发导入只允许创建一次");
    assert.equal(registerCalls, 2, "并发导入的注册意图必须恰好一次");

    const totals = await counts(handle);
    assert.deepEqual(
      { assets: totals.rows[0]?.assets, mappings: totals.rows[0]?.mappings, attempts: totals.rows[0]?.attempts },
      { assets: 2, mappings: 2, attempts: 2 },
    );
    assert.ok((totals.rows[0]?.verifications ?? 0) >= 2, "每次新建导入都必须先留下 TOS 校验记录");

    registrationOutcome = "failed";
    const failed = await service.import({ ...baseInput, sourceId: "approved-character-002", assetKind: "character", mediaSha256: "b".repeat(64) });
    assert.equal(failed.asset.registrationStatus, "failed");
    assert.equal(failed.asset.registrationFailureCode, "ASSET_REGISTRY_REJECTED");
    assert.equal(failed.asset.registrationFailureReason, "controlled registration failure", "失败原因必须持久化到素材视图");
    assert.deepEqual(failed.asset.registrationReadback, { state: "Failed" }, "供应商回读结果必须持久化到素材视图");
    registrationOutcome = "active";
    const recovered = await service.retry(failed.asset.id);
    assert.equal(recovered.registrationStatus, "active");
    assert.equal(registerCalls, 3, "已有远端 ID 的失败恢复不得再次登记");
    assert.equal(readbackCalls, 1, "已有远端 ID 的失败恢复必须走回读");
    const attemptTrail = await handle.pool.query<{ action: string; outcome: string; failure_reason: string | null; readback: Record<string, unknown> | null }>(
      "SELECT action, outcome, failure_reason, readback FROM vnext.import_registration_attempts WHERE imported_asset_id=$1 ORDER BY created_at",
      [failed.asset.id],
    );
    assert.deepEqual(
      attemptTrail.rows,
      [
        { action: "register", outcome: "failed", failure_reason: "controlled registration failure", readback: { state: "Failed" } },
        { action: "readback", outcome: "active", failure_reason: null, readback: { state: "Active" } },
      ],
      "失败原因与恢复回读必须在尝试账本上可追溯",
    );

    registrationOutcome = "failed";
    const race = await service.import({ ...baseInput, sourceId: "approved-scene-retry-race", mediaSha256: "9".repeat(64) });
    assert.equal(race.asset.registrationStatus, "failed");
    await handle.pool.query("UPDATE vnext.imported_assets SET registration_id=NULL WHERE id=$1", [race.asset.id]);
    registrationOutcome = "active";
    const raceCallsBefore = registerCalls;
    const raceResults = await Promise.all(Array.from({ length: 8 }, () => service.retry(race.asset.id)));
    assert.equal(registerCalls, raceCallsBefore + 1, "并发无远端 ID 的失败重试只允许一次外部登记");
    assert.equal(new Set(raceResults.map((item) => item.id)).size, 1, "并发重试必须收敛到同一素材");
    for (const item of raceResults) {
      assert.ok(["pending", "active"].includes(item.registrationStatus), "重试竞争者不得看到 failed 结果");
    }

    const processingAdapter: SnapshotARegistrationPort = {
      async register({ assetId }) {
        return { registrationId: `remote-processing-${assetId}`, status: "processing", readback: { state: "Processing" } };
      },
      async readback({ registrationId }) {
        readbackCalls += 1;
        return { registrationId, status: "active", readback: { state: "Active" } };
      },
    };
    const processingService = new SnapshotAImportService(runtimeHandle.db, processingAdapter, tos);
    const processing = await processingService.import({ ...baseInput, sourceId: "approved-scene-processing-readback", mediaSha256: "7".repeat(64) });
    assert.equal(processing.asset.registrationStatus, "processing");
    assert.equal(processing.asset.registrationId, `remote-processing-${processing.asset.id}`);
    const readbacksBeforeProcessing = readbackCalls;
    const settledProcessing = await Promise.all(Array.from({ length: 8 }, () => processingService.retry(processing.asset.id)));
    assert.equal(readbackCalls, readbacksBeforeProcessing + 1, "处理中的并发重试只能有一个调用者取得原子 claim");
    assert.ok(settledProcessing.every((asset) => ["pending", "active"].includes(asset.registrationStatus)), "未取得 claim 的调用者必须返回当前行");
    assert.equal((await processingService.retry(processing.asset.id)).registrationStatus, "active", "处理中素材必须通过回读收敛到 active");
    assert.equal((await service.retry(race.asset.id)).registrationStatus, "active", "竞争落定后重试幂等收敛");

    const unknownAsset = await handle.pool.query<{ id: string }>(
      `UPDATE vnext.imported_assets AS a
       SET registration_status='unknown', registration_id=NULL
       FROM vnext.import_source_mappings AS m
       WHERE m.imported_asset_id=a.id AND m.source_id=$1
       RETURNING a.id`,
      ["approved-character-002"],
    );
    const readbacksBeforeRace = readbackCalls;
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => service.retry(unknownAsset.rows[0]!.id)));
    assert.equal(readbackCalls, readbacksBeforeRace + 1, "未知状态的并发回读只能有一个调用者取得原子 claim");
    const boundResults = settled.filter((result) => result.status === "fulfilled" && result.value.registrationId === "remote-reconciled");
    const conflictResults = settled.filter((result) => result.status === "rejected" && (result.reason as { code?: string })?.code === "snapshot_registration_unknown");
    assert.equal(boundResults.length, 1, `按名回读必须恰好一次绑定远端素材 ID: ${JSON.stringify(settled.map((result) => result.status === "fulfilled" ? { status: result.value.registrationStatus, id: result.value.registrationId } : { error: (result.reason as Error)?.message }))}`);
    assert.equal(conflictResults.length, 7, "未取得 claim 的并发调用者必须收到明确人工复核冲突");
    assert.equal(registerCalls, raceCallsBefore + 1, "结果不明确时恢复不得重新提交登记");

    const video = await service.import({ ...baseInput, sourceId: "approved-prop-video-003", assetKind: "prop", mediaKind: "video", mediaSha256: "c".repeat(64) });
    assert.equal(video.asset.registrationStatus, "not_required", "非图片素材不得调用图片注册后端");

    const noProjectLinks = await handle.pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema='vnext' AND table_name IN ('project_assets', 'asset_project_links')`);
    assert.equal(noProjectLinks.rows[0]?.count, 0, "快照素材不得存在任何项目挂载结构");

    const liteWriteTables = await handle.pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_schema='vnext' AND table_name IN ('imported_assets', 'import_source_mappings') AND column_name ILIKE '%lite%'`);
    assert.equal(liteWriteTables.rows[0]?.count, 0, "快照表不得携带 Lite 变更语义");
    const liteSentinelAfter = await handle.pool.query<{ id: string; name: string; updated_at: Date }>(`SELECT id, name, updated_at FROM "app".lite_sentinel_assets LIMIT 1`);
    assert.deepEqual(liteSentinelAfter.rows, liteSentinelBefore.rows, "Lite 哨兵行在导入、TOS 失败、注册失败与重试后必须保持原样");

    // Database-enforced immutability: the runtime role can append mappings but
    // never rewrite source identity, and never writes the trusted allowlist.
    const isolation = await handle.pool.connect();
    try {
      await isolation.query("SET ROLE vnext_app");
      await assert.rejects(
        isolation.query("UPDATE vnext.import_source_mappings SET source_id='rewritten'"),
        /permission denied/,
        "运行时角色不得改写来源映射",
      );
      await assert.rejects(
        isolation.query("UPDATE vnext.import_source_approvals SET approved=FALSE"),
        /permission denied/,
        "运行时角色不得改写受信批准清单",
      );
      await assert.rejects(
        isolation.query(
          "INSERT INTO vnext.import_source_approvals (source_system, source_id, approved, is_human) VALUES ('legacy_snapshot_a', 'forged', TRUE, FALSE)",
        ),
        /permission denied/,
        "运行时角色不得伪造受信批准清单",
      );
      await assert.rejects(
        isolation.query("UPDATE vnext.import_registration_attempts SET outcome='active'"),
        /permission denied/,
        "运行时角色不得改写登记尝试账本",
      );
      await assert.rejects(
        isolation.query("UPDATE vnext.import_verification_attempts SET outcome='verified'"),
        /permission denied/,
        "运行时角色不得改写 TOS 校验尝试账本",
      );
    } finally {
      await isolation.query("RESET ROLE").catch(() => undefined);
      isolation.release();
    }

    const disabledService = new SnapshotAImportService(runtimeHandle.db, undefined, tos);
    const disabled = await disabledService.import({ ...baseInput, sourceId: "approved-scene-disabled", mediaSha256: "e".repeat(64) });
    assert.equal(disabled.asset.registrationStatus, "failed");
    assert.equal(disabled.asset.registrationFailureCode, "snapshot_registration_unavailable");
    assert.match(disabled.asset.registrationFailureReason ?? "", /未发送任何请求/);
    await assert.rejects(() => disabledService.retry(disabled.asset.id), /尚未开启/);
    assert.equal(registerCalls, raceCallsBefore + 1, "未注入注册后端时不得触碰任何外部动作");

    await assert.rejects(
      () => new SnapshotAImportService(runtimeHandle.db).import({ ...baseInput, sourceId: "approved-scene-no-tos", mediaSha256: "8".repeat(64) }),
      /TOS 校验尚未配置/,
      "缺少 TOS 校验缝时导入必须失败关闭，不得落资产行",
    );

    const finalCounts = await counts(handle);
    assert.equal(finalCounts.rows[0].assets, 7);
    assert.equal(finalCounts.rows[0].mappings, 7);
  } finally {
    await runtimeHandle?.pool.end().catch(() => undefined);
    await handle.pool.query("DROP SCHEMA IF EXISTS vnext CASCADE").catch(() => undefined);
    await handle.pool.query('DROP SCHEMA IF EXISTS "app" CASCADE').catch(() => undefined);
    await handle.pool.end();
  }
});
