import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { settings } from "../src/config/env.js";
import type { Database } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import { AppError } from "../src/shared/errors.js";
import { PostgresMediaReviewRepository } from "../src/modules/reviews/mediaRepository.js";
import { MediaReviewService } from "../src/modules/reviews/mediaService.js";
import { ShotMediaRepository } from "../src/modules/shot-media/repository.js";
import { DrizzleDeliveryRepository } from "../src/modules/delivery/repository.js";
import { DeliveryService } from "../src/modules/delivery/service.js";
import { PostgresGenerationRepository } from "../src/modules/generation/repository.js";

// 显式环境变量门控:只允许指向本机一次性测试库(127.0.0.1/localhost/::1)。
// drizzle 表对象在模块加载时绑定 settings.postgresSchema,因此与 seedance
// 真库测试同一口径:迁移直接落进一次性库的同名 schema,不做每用例随机 schema。
const integrationTestDatabaseUrl = process.env.OUTPUT_REVIEW_DELIVERY_TEST_DATABASE_URL;

test("019 真 PG:产物审核状态机、鉴权、交付门禁与交付记录全链闭环", {
  skip: !integrationTestDatabaseUrl,
  timeout: 120_000,
}, async () => {
  assert.ok(integrationTestDatabaseUrl);
  assertLocalTestDatabaseUrl(integrationTestDatabaseUrl);

  const pool = new Pool({ connectionString: integrationTestDatabaseUrl });
  const schemaName = settings.postgresSchema;
  const schema = quoteIdentifier(schemaName);
  const ownerId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const outsiderId = randomUUID();
  const projectId = randomUUID();
  const autoProjectId = randomUUID();
  const episode1Id = randomUUID();
  const episode2Id = randomUUID();
  const autoEpisodeId = randomUUID();
  const shot1Id = randomUUID();
  const shot2Id = randomUUID();
  const shot3Id = randomUUID();
  const shot5Id = randomUUID();
  const shot8Id = randomUUID();
  const autoShotId = randomUUID();
  const m1 = randomUUID();
  const m2 = randomUUID();
  const m3 = randomUUID();
  const m4 = randomUUID();
  const m7 = randomUUID();
  const m8 = randomUUID();
  const m9 = randomUUID();

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${schema}`);
    await applyMigrations(pool, schemaName, await migrationFilesThrough019());

    // ---- 种子:用户、项目、成员、策略、分集、分镜 ----
    for (const [id, name] of [
      [ownerId, "or-owner"], [editorId, "or-editor"], [viewerId, "or-viewer"], [outsiderId, "or-outsider"],
    ] as const) {
      await pool.query(
        `INSERT INTO ${schema}.users (id, username, display_name, password_hash, active, role)
         VALUES ($1, $2, $2, 'test-only', true, 'member')`,
        [id, name],
      );
    }
    await pool.query(
      `INSERT INTO ${schema}.projects (id, owner_user_id, name, status) VALUES ($1, $2, '审核项目', 'active')`,
      [projectId, ownerId],
    );
    await pool.query(
      `INSERT INTO ${schema}.projects (id, owner_user_id, name, status) VALUES ($1, $2, '自动项目', 'active')`,
      [autoProjectId, ownerId],
    );
    for (const [pid, uid, role] of [
      [projectId, editorId, "editor"], [projectId, viewerId, "viewer"],
    ] as const) {
      await pool.query(
        `INSERT INTO ${schema}.project_members (project_id, user_id, role, added_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, now())`,
        [pid, uid, role, ownerId],
      );
    }
    // P1: image/video 均 pending_review(指定审核人稍后设置);P2: 无策略行 = automatic
    for (const kind of ["image", "video"] as const) {
      await pool.query(
        `INSERT INTO ${schema}.project_review_policies
           (id, project_id, media_kind, default_strategy, updated_by_user_id, reviewer_user_id, version)
         VALUES ($1, $2, $3, 'pending_review', $4, NULL, 1)`,
        [randomUUID(), projectId, kind, ownerId],
      );
    }
    await pool.query(
      `INSERT INTO ${schema}.episodes (id, project_id, episode_no, sort_order, status) VALUES ($1, $2, 1, 1, 'active')`,
      [episode1Id, projectId],
    );
    await pool.query(
      `INSERT INTO ${schema}.episodes (id, project_id, episode_no, sort_order, status) VALUES ($1, $2, 2, 2, 'active')`,
      [episode2Id, projectId],
    );
    await pool.query(
      `INSERT INTO ${schema}.episodes (id, project_id, episode_no, sort_order, status) VALUES ($1, $2, 1, 1, 'active')`,
      [autoEpisodeId, autoProjectId],
    );
    for (const [id, episodeId, code, order] of [
      [shot1Id, episode1Id, "G01", 1],
      [shot2Id, episode1Id, "G02", 2],
      [shot3Id, episode2Id, "G01", 1],
      [shot5Id, episode1Id, "G03", 3],
      [shot8Id, episode1Id, "G04", 4],
      [autoShotId, autoEpisodeId, "G01", 1],
    ] as const) {
      await pool.query(
        `INSERT INTO ${schema}.shots (id, episode_id, shot_code, sort_order) VALUES ($1, $2, $3, $4)`,
        [id, episodeId, code, order],
      );
    }
    // 产物(生成来源,带完整 request/attempt 链):m1/m2 视频待审,m7 视频待审(G03),m8 视频待审(G04)
    await insertGenerationMedia(pool, schema, { id: m1, projectId, shotId: shot1Id, userId: ownerId, kind: "video", status: "needs_review", key: "k-m1", createdAt: "2026-07-24T01:00:00Z" });
    await insertGenerationMedia(pool, schema, { id: m2, projectId, shotId: shot2Id, userId: ownerId, kind: "video", status: "needs_review", key: "k-m2", createdAt: "2026-07-24T02:00:00Z" });
    await insertGenerationMedia(pool, schema, { id: m7, projectId, shotId: shot5Id, userId: ownerId, kind: "video", status: "needs_review", key: "k-m7", createdAt: "2026-07-24T05:00:00Z" });
    await insertGenerationMedia(pool, schema, { id: m8, projectId, shotId: shot8Id, userId: ownerId, kind: "video", status: "needs_review", key: "k-m8", createdAt: "2026-07-24T06:00:00Z" });
    // 队列专用(不入选主版本):m3 图片待审(S1),m4 视频已通过(S1)
    await insertGenerationMedia(pool, schema, { id: m3, projectId, shotId: shot1Id, userId: ownerId, kind: "image", status: "needs_review", key: "k-m3", createdAt: "2026-07-24T03:00:00Z" });
    await insertGenerationMedia(pool, schema, { id: m4, projectId, shotId: shot1Id, userId: ownerId, kind: "video", status: "accepted", key: "k-m4", createdAt: "2026-07-24T04:00:00Z" });

    const database = drizzle(pool) as unknown as Database;
    const reviewRepository = new PostgresMediaReviewRepository(database);
    const reviewService = new MediaReviewService(reviewRepository);
    const shotMediaRepository = new ShotMediaRepository(database);
    const deliveryService = new DeliveryService(new DrizzleDeliveryRepository(database));
    const generationRepository = new PostgresGenerationRepository(database, 60_000);
    const owner = { id: ownerId, role: "member" as const };
    const editor = { id: editorId, role: "member" as const };
    const viewer = { id: viewerId, role: "member" as const };
    const outsider = { id: outsiderId, role: "member" as const };

    // ---- A. 待审队列:状态/集过滤、分页、total ----
    const queue = await reviewService.listQueue(owner, projectId, { status: "needs_review", page: 1, pageSize: 2 });
    assert.equal(queue.total, 5);
    assert.equal(queue.items.length, 2);
    assert.equal(queue.items[0]?.mediaResultId, m8, "按 created_at DESC,m8 最新");
    assert.equal(queue.items[0]?.shotCode, "G04");
    assert.equal(queue.items[0]?.isPrimary, false);
    const queuePage2 = await reviewService.listQueue(owner, projectId, { status: "needs_review", page: 3, pageSize: 2 });
    assert.equal(queuePage2.items.length, 1);
    assert.equal(queuePage2.items[0]?.mediaResultId, m1);
    const queueEpisode2 = await reviewService.listQueue(owner, projectId, {
      status: "needs_review", episodeId: episode2Id, page: 1, pageSize: 20,
    });
    assert.equal(queueEpisode2.total, 0);
    const queueAccepted = await reviewService.listQueue(owner, projectId, { status: "accepted", page: 1, pageSize: 20 });
    assert.equal(queueAccepted.total, 1);
    assert.equal(queueAccepted.items[0]?.mediaResultId, m4);

    // ---- B. 裁决鉴权与状态机 ----
    await assert.rejects(
      () => reviewService.listQueue(outsider, projectId, { status: "needs_review", page: 1, pageSize: 20 }),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
      "非成员队列必须 404,不泄露项目存在",
    );
    await assert.rejects(
      () => reviewService.decide(outsider, projectId, [{ mediaResultId: m1, action: "approve" }]),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
    await assert.rejects(
      () => reviewService.decide(viewer, projectId, [{ mediaResultId: m1, action: "approve" }]),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
      "项目成员但非审核人必须 403",
    );
    // owner 批量裁决:整集通过 m1/m2,逐镜拒绝 m3(带理由)
    const outcomes = await reviewService.decide(owner, projectId, [
      { mediaResultId: m1, action: "approve" },
      { mediaResultId: m2, action: "approve" },
      { mediaResultId: m3, action: "reject", rejectionReason: "人物穿帮" },
    ]);
    assert.deepEqual(outcomes.map((outcome) => [outcome.status, outcome.changed]), [
      ["accepted", true], ["accepted", true], ["rejected", true],
    ]);
    const actionRows = await pool.query(
      `SELECT action, from_status, to_status, reviewer_user_id, rejection_reason
       FROM ${schema}.media_review_actions`,
    );
    assert.equal(actionRows.rows.length, 3);
    // 同批动作共享事务时间戳,断言行集而非时间顺序
    assert.deepEqual(
      actionRows.rows.map((row) => [row.action, row.from_status, row.to_status]).sort(),
      [
        ["accepted", "needs_review", "accepted"],
        ["accepted", "needs_review", "accepted"],
        ["rejected", "needs_review", "rejected"],
      ].sort(),
    );
    const rejectedRow = actionRows.rows.find((row) => row.action === "rejected");
    assert.equal(rejectedRow?.rejection_reason, "人物穿帮");
    assert.ok(actionRows.rows.every((row) => row.reviewer_user_id === ownerId));
    // 幂等:重复通过同一条 already_accepted,不再落动作
    const again = await reviewService.decide(owner, projectId, [{ mediaResultId: m1, action: "approve" }]);
    assert.deepEqual([again[0]?.changed, again[0]?.reason], [false, "already_accepted"]);
    // 终态冲突:已通过的不能再拒绝
    await assert.rejects(
      () => reviewService.decide(owner, projectId, [{ mediaResultId: m1, action: "reject", rejectionReason: "反悔" }]),
      (error: unknown) => error instanceof AppError && error.statusCode === 409,
    );
    // 指定审核人:把 video 策略的 reviewer 设为 editor 后,editor 可裁决视频
    await pool.query(
      `UPDATE ${schema}.project_review_policies SET reviewer_user_id = $1
       WHERE project_id = $2 AND media_kind = 'video'`,
      [editorId, projectId],
    );
    const editorOutcome = await reviewService.decide(editor, projectId, [{ mediaResultId: m7, action: "approve" }]);
    assert.equal(editorOutcome[0]?.status, "accepted");
    // 但 editor 仍不能裁决 image(未被指定且非 owner)
    await assert.rejects(
      () => reviewService.decide(editor, projectId, [{ mediaResultId: m3, action: "approve" }]),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );

    // ---- C. 落库即审:pending_review 与 automatic 两种策略 ----
    const pendingMediaId = await persistGeneratedImage(generationRepository, pool, schema, {
      projectId, shotId: shot3Id, userId: ownerId, key: "pk-pending",
    });
    const pendingRow = await pool.query(`SELECT review_status FROM ${schema}.media_results WHERE id = $1`, [pendingMediaId]);
    assert.equal(pendingRow.rows[0]?.review_status, "needs_review", "pending_review 策略落库保持待审");
    const autoMediaId = await persistGeneratedImage(generationRepository, pool, schema, {
      projectId: autoProjectId, shotId: autoShotId, userId: ownerId, key: "pk-auto",
    });
    const autoRow = await pool.query(`SELECT review_status FROM ${schema}.media_results WHERE id = $1`, [autoMediaId]);
    assert.equal(autoRow.rows[0]?.review_status, "accepted", "automatic 策略落库即视同 accepted");
    const autoActions = await pool.query(
      `SELECT action, reviewer_user_id, from_status, to_status FROM ${schema}.media_review_actions
       WHERE media_result_id = $1`,
      [autoMediaId],
    );
    assert.equal(autoActions.rows.length, 1);
    assert.deepEqual(
      [autoActions.rows[0]?.action, autoActions.rows[0]?.reviewer_user_id, autoActions.rows[0]?.from_status, autoActions.rows[0]?.to_status],
      ["auto_accepted", null, "needs_review", "accepted"],
      "自动通过必须留系统动作痕迹,reviewer 为空不冒充人工",
    );

    // ---- D. set-primary 门禁 ----
    await assert.rejects(
      () => shotMediaRepository.setPrimary(owner, shot3Id, pendingMediaId),
      (error: unknown) => error instanceof AppError && error.statusCode === 409
        && (error as AppError).code === "media_review_not_accepted",
      "pending_review 下未审产物不能设主版本",
    );
    await reviewService.decide(owner, projectId, [{ mediaResultId: pendingMediaId, action: "approve" }]);
    const selected = await shotMediaRepository.setPrimary(owner, shot3Id, pendingMediaId);
    assert.equal(selected.selectedMediaResultId, pendingMediaId);
    const automaticDefault = await shotMediaRepository.list(owner, autoShotId);
    assert.deepEqual(
      automaticDefault.effectiveImage,
      { id: autoMediaId, source: "latest_default" },
      "无人点选时最新合格生成图是系统默认定稿",
    );
    const automaticQueue = await reviewService.listQueue(owner, autoProjectId, {
      status: "accepted", page: 1, pageSize: 20,
    });
    const defaultQueueItem = automaticQueue.items.find((item) => item.mediaResultId === autoMediaId);
    assert.deepEqual(
      [defaultQueueItem?.isPrimary, defaultQueueItem?.selectionSource],
      [true, "latest_default"],
      "审核列表也区分系统默认定稿",
    );
    const autoSelected = await shotMediaRepository.setPrimary(owner, autoShotId, autoMediaId);
    assert.equal(autoSelected.selectedMediaResultId, autoMediaId, "automatic 策略产物可直接设主");
    const newerAutoMediaId = await persistGeneratedImage(generationRepository, pool, schema, {
      projectId: autoProjectId, shotId: autoShotId, userId: ownerId, key: "pk-auto-newer",
    });
    const manualStillWins = await shotMediaRepository.list(owner, autoShotId);
    assert.deepEqual(
      manualStillWins.effectiveImage,
      { id: autoMediaId, source: "manual" },
      "人工定稿后更新生成图只进历史，不覆盖定稿",
    );
    assert.ok(manualStillWins.items.some((item) => item.media.id === newerAutoMediaId), "新版本仍保留在历史列表");

    // ---- E. 交付门禁、partial 与交付记录 ----
    const defaultDelivery = await new DrizzleDeliveryRepository(database).loadEpisode(owner, episode1Id);
    assert.deepEqual(
      defaultDelivery.shots.map((shot) => [shot.shotCode, shot.selectedVideoResultId]),
      [["G01", m4], ["G02", m2], ["G03", m7], ["G04", null]],
      "交付读取无人点选的最新合格视频；待审视频不能成为默认定稿",
    );
    const defaultPartialManifest = await deliveryService.getManifest(owner, episode1Id, { partial: true });
    assert.deepEqual(defaultPartialManifest.items.map((item) => item.mediaId), [m4, m2, m7]);
    assert.deepEqual(
      defaultPartialManifest.gaps.map((gap) => [gap.shotCode, gap.reason]),
      [["G04", "missing_video_primary"]],
      "完全无人点选时 manifest 实际消费系统默认视频",
    );
    await pool.query(`UPDATE ${schema}.shots SET selected_video_result_id = $1 WHERE id = $2`, [m1, shot1Id]);
    await pool.query(`UPDATE ${schema}.shots SET selected_video_result_id = $1 WHERE id = $2`, [m2, shot2Id]);
    await pool.query(`UPDATE ${schema}.shots SET selected_video_result_id = $1 WHERE id = $2`, [m7, shot5Id]);
    await pool.query(`UPDATE ${schema}.shots SET selected_video_result_id = $1 WHERE id = $2`, [m8, shot8Id]);

    await assert.rejects(
      () => deliveryService.getManifest(owner, episode1Id),
      (error: unknown) => {
        if (!(error instanceof AppError) || error.statusCode !== 409) return false;
        const details = JSON.stringify((error as AppError).details);
        return details.includes("G04") && details.includes("video_not_accepted");
      },
      "pending_review 项目未审产物在交付请求中必须报错并列出镜号",
    );
    const partialManifest = await deliveryService.getManifest(owner, episode1Id, { partial: true });
    assert.equal(partialManifest.partial, true);
    assert.deepEqual(partialManifest.items.map((item) => item.shotCode), ["G01", "G02", "G03"]);
    assert.deepEqual(partialManifest.gaps.map((gap) => [gap.shotCode, gap.reason]), [["G04", "video_not_accepted"]]);
    const partialPlayback = await deliveryService.getPlayback(owner, episode1Id, { partial: true });
    assert.equal(partialPlayback.playback.length, 3);
    // 部分交付落记录:缺口镜号入账
    const partialRecord = await deliveryService.createDeliveryRecord(owner, episode1Id, { partial: true, purpose: "预演送看" });
    assert.equal(partialRecord.partial, true);
    assert.deepEqual(partialRecord.missingShotCodes, ["G04"]);
    assert.equal(partialRecord.mediaResultIds.length, 3);
    assert.equal(partialRecord.purpose, "预演送看");
    // 审核通过 m8 后全集可交付;同一集交付两次,历史两行且 hash 一致
    await reviewService.decide(editor, projectId, [{ mediaResultId: m8, action: "approve" }]);
    const fullManifest = await deliveryService.getManifest(owner, episode1Id);
    assert.equal(fullManifest.items.length, 4);
    assert.equal(fullManifest.gaps.length, 0);
    const first = await deliveryService.createDeliveryRecord(owner, episode1Id, { purpose: "正式交付" });
    const second = await deliveryService.createDeliveryRecord(owner, episode1Id, {});
    assert.equal(first.manifestHash.length, 64);
    assert.equal(first.manifestHash, second.manifestHash, "内容未变的两次交付 hash 必须可对");
    assert.notEqual(first.manifestHash, partialRecord.manifestHash, "缺口交付与全量交付 hash 不同");
    const history = await deliveryService.listDeliveryRecords(owner, episode1Id, 1, 20);
    assert.equal(history.total, 3);
    assert.deepEqual(
      history.items.map((item) => item.id).sort(),
      [partialRecord.id, first.id, second.id].sort(),
    );
    assert.ok(
      history.items[0]!.createdAt >= history.items[2]!.createdAt,
      "历史按时间倒序",
    );
    // 队列里已通过产物标记主版本
    const acceptedQueue = await reviewService.listQueue(owner, projectId, { status: "accepted", page: 1, pageSize: 50 });
    assert.equal(acceptedQueue.items.find((item) => item.mediaResultId === m8)?.isPrimary, true);
    // automatic 项目:未审产物照今天行为进交付;被拒后立即卡住
    await insertGenerationMedia(pool, schema, { id: m9, projectId: autoProjectId, shotId: autoShotId, userId: ownerId, kind: "video", status: "needs_review", key: "k-m9", createdAt: "2026-07-24T07:00:00Z" });
    await pool.query(`UPDATE ${schema}.shots SET selected_video_result_id = $1 WHERE id = $2`, [m9, autoShotId]);
    const autoManifest = await deliveryService.getManifest(owner, autoEpisodeId);
    assert.equal(autoManifest.items.some((item) => item.mediaId === m9), true);
    await reviewService.decide(owner, autoProjectId, [{ mediaResultId: m9, action: "reject", rejectionReason: "风格不符" }]);
    await assert.rejects(
      () => deliveryService.getManifest(owner, autoEpisodeId),
      (error: unknown) => error instanceof AppError && error.statusCode === 409,
      "被拒产物即使在 automatic 项目也不能进交付",
    );

    // ---- F. 数据库约束:理由必填、系统动作形态、状态机、幂等唯一 ----
    await assert.rejects(
      pool.query(
        `INSERT INTO ${schema}.media_review_actions
           (id, project_id, media_result_id, action, from_status, to_status, reviewer_user_id)
         VALUES ($1, $2, $3, 'rejected', 'needs_review', 'rejected', $4)`,
        [randomUUID(), projectId, m4, ownerId],
      ),
      postgresConstraint("23514"),
      "拒绝无理由必须被 CHECK 拦截",
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO ${schema}.media_review_actions
           (id, project_id, media_result_id, action, from_status, to_status, reviewer_user_id)
         VALUES ($1, $2, $3, 'auto_accepted', 'needs_review', 'accepted', $4)`,
        [randomUUID(), projectId, m4, ownerId],
      ),
      postgresConstraint("23514"),
      "系统动作带人工 reviewer 必须被 CHECK 拦截",
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO ${schema}.media_review_actions
           (id, project_id, media_result_id, action, from_status, to_status, reviewer_user_id)
         VALUES ($1, $2, $3, 'auto_accepted', 'needs_review', 'accepted', NULL)`,
        [randomUUID(), autoProjectId, autoMediaId],
      ),
      postgresConstraint("23505"),
      "同一产物自动通过审计至多一行",
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO ${schema}.media_review_actions
           (id, project_id, media_result_id, action, from_status, to_status, reviewer_user_id)
         VALUES ($1, $2, $3, 'accepted', 'accepted', 'accepted', $4)`,
        [randomUUID(), projectId, m4, ownerId],
      ),
      postgresConstraint("23514"),
      "状态机只允许 needs_review 出发的迁移",
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});

/** 交付门禁专用:generation 来源产物,带合法 request/attempt 链。 */
async function insertGenerationMedia(
  pool: Pool,
  schema: string,
  input: {
    id: string;
    projectId: string;
    shotId: string;
    userId: string;
    kind: "image" | "video";
    status: string;
    key: string;
    createdAt: string;
  },
): Promise<void> {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO ${schema}.generation_requests
       (id, user_id, project_id, shot_id, media_kind, prompt, reference_media_ids,
        reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash, charged_points)
     VALUES ($1, $2, $3, $4, $5, '测试提示词', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 1, $6, $7, 0)`,
    [requestId, input.userId, input.projectId, input.shotId, input.kind, `idem-${input.key}`, "b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO ${schema}.generation_attempts
       (id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
        provider_response, estimated_cost_fen, retryable, price_snapshot)
     VALUES ($1, $2, 1, 'ark', 'test-model', '{}'::jsonb, 1, 'succeeded', 'complete', NULL, 0, false, '{}'::jsonb)`,
    [attemptId, requestId],
  );
  await pool.query(
    `INSERT INTO ${schema}.media_results
       (id, request_id, attempt_id, shot_id, origin_kind, media_kind, result_index, provider_result_key,
        persistence_status, storage_bucket, storage_path, storage_url, sha256, mime_type,
        review_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'generation', $5, 0, $6,
             'persisted', 'test-bucket', $7, $8, $9, $10, $11, $12, $12)`,
    [
      input.id,
      requestId,
      attemptId,
      input.shotId,
      input.kind,
      input.key,
      `test/${input.id}`,
      `https://storage.example/${input.id}`,
      "a".repeat(64),
      input.kind === "video" ? "video/mp4" : "image/png",
      input.status,
      input.createdAt,
    ],
  );
}

async function persistGeneratedImage(
  generationRepository: {
    recordTosObjectUpload: (
      attemptId: string,
      object: {
        providerResultKey: string;
        storageBucket: string;
        objectKey: string;
        producedAt: Date;
      },
    ) => Promise<void>;
    saveMediaResult: (attemptId: string, result: Record<string, unknown>) => Promise<void>;
  },
  pool: Pool,
  schema: string,
  input: { projectId: string; shotId: string; userId: string; key: string },
): Promise<string> {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO ${schema}.generation_requests
       (id, user_id, project_id, shot_id, media_kind, prompt, reference_media_ids,
        reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash, charged_points)
     VALUES ($1, $2, $3, $4, 'image', '测试提示词', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 1, $5, $6, 0)`,
    [requestId, input.userId, input.projectId, input.shotId, `idem-${input.key}`, "b".repeat(64)],
  );
  await pool.query(
    `INSERT INTO ${schema}.generation_attempts
       (id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
        provider_response, estimated_cost_fen, retryable, price_snapshot)
     VALUES ($1, $2, 1, 'ark', 'test-model', '{}'::jsonb, 1, 'running', 'persisting', $3::jsonb, 0, false, '{}'::jsonb)`,
    [attemptId, requestId, JSON.stringify({
      status: "succeeded",
      media: [{ kind: "image", temporaryUrl: "https://provider.example/tmp.png", providerResultKey: input.key }],
    })],
  );
  await generationRepository.recordTosObjectUpload(attemptId, {
    providerResultKey: input.key,
    storageBucket: "test-bucket",
    objectKey: `test/${input.key}.png`,
    producedAt: new Date(),
  });
  await generationRepository.saveMediaResult(attemptId, {
    providerResultKey: input.key,
    mediaKind: "image",
    storageBucket: "test-bucket",
    storagePath: `test/${input.key}.png`,
    storageUrl: `https://storage.example/${input.key}.png`,
    sha256: "c".repeat(64),
    mimeType: "image/png",
  });
  const row = await pool.query(
    `SELECT id FROM ${schema}.media_results WHERE attempt_id = $1 AND provider_result_key = $2`,
    [attemptId, input.key],
  );
  const id = row.rows[0]?.id as string | undefined;
  assert.ok(id, "落库后必须能找到 media_results 行");
  await pool.query(
    `UPDATE ${schema}.generation_attempts
     SET status = 'succeeded', phase = 'complete', finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [attemptId],
  );
  return id;
}

function postgresConstraint(code: string): (error: unknown) => boolean {
  return (error: unknown) => (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

async function migrationFilesThrough019(): Promise<string[]> {
  return (await readdir(path.resolve("migrations")))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName))
    .sort((left, right) => left.localeCompare(right));
}

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

function assertLocalTestDatabaseUrl(value: string): void {
  const host = new URL(value).hostname;
  assert.ok(
    host === "127.0.0.1" || host === "localhost" || host === "::1",
    "OUTPUT_REVIEW_DELIVERY_TEST_DATABASE_URL 只允许指向本机一次性测试库",
  );
}
