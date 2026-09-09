import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { toHttpErrorResponse } from "../src/http/errorResponse.js";
import { ConflictError } from "../src/shared/errors.js";

/**
 * 迁移 021/045/048/076 真 PG 演练 + 草稿区边界实证(本包验收核心的数据库层证据):
 * 1. 独立 rehearsal schema 里从空库逐文件重放全部迁移,再重放关键迁移验幂等;
 * 2. 用真实 Drizzle repository + 假网关跑完整链路,证明:
 *    - 执行完毕(草稿就绪)后正式 scenes/shots 一行都没有;
 *    - 人工确认才写入,且带 source_breakdown_run_id/source_candidate_id;
 *    - 重复确认幂等不重复建行;
 *    - 新一次确认替换旧行,旧运行转 superseded;
 *    - 集内有人工正式内容时确认走覆盖重建(v8:旧 409 守卫退役,人工行软删可逆)。
 * 连接串只许本机/本地 Compose,拒绝云 RDS。
 */
const requestedDatabaseUrl = process.env.SCRIPT_BREAKDOWN_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;
const rehearsalSchema = "sbd_rehearsal";

test("script breakdown: 全迁移重放 + 草稿区边界 + 确认事务 + 幂等 + 替换", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  // drizzle schema 在模块加载时读取 POSTGRES_SCHEMA,必须先指到 rehearsal 再动态引入。
  process.env.POSTGRES_SCHEMA = rehearsalSchema;
  const { createDatabase } = await import("../src/db/client.js");
  const { quoteIdentifier, renderMigrationSql } = await import("../src/db/migrate.js");
  const { DrizzleScriptBreakdownRepository } = await import("../src/modules/script-breakdown/repository.js");
  const { ScriptBreakdownService } = await import("../src/modules/script-breakdown/service.js");
  const { ProjectAssetRepository } = await import("../src/modules/project-assets/repository.js");
  const {
    AiExecutionFenceLostError,
    DrizzleAiCallRepository,
  } = await import("../src/modules/ai/repository.js");
  const doubles = await import("../src/modules/script-breakdown/test-doubles.js");
  const { DEFAULT_VIDEO_PROMPT_TEMPLATE } = await import("../src/modules/generation/promptCompiler.js");
  const { registerScriptBreakdownRoutes } = await import("../src/modules/script-breakdown/routes.js");

  const quoted = quoteIdentifier(rehearsalSchema);
  const handle = createDatabase(databaseUrl);
  const now = new Date("2026-07-25T08:00:00.000Z");
  const ownerId = doubles.TEST_ACTOR.id;
  const projectId = randomUUID();
  const raceEpisodeId = randomUUID();
  const episodeId = randomUUID();
  const foreignEpisodeId = randomUUID();
  const migrationEpisodeId = randomUUID();

  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    const files = (await readdir(path.resolve("migrations")))
      .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
      .sort((left, right) => left.localeCompare(right));
    assert.ok(files.some((name) => name.startsWith("021_")), "迁移目录必须包含 021");
    assert.ok(files.some((name) => name.startsWith("045_")), "迁移目录必须包含 045");
    assert.ok(files.some((name) => name.startsWith("048_")), "迁移目录必须包含 048");
    assert.ok(files.some((name) => name.startsWith("076_")), "迁移目录必须包含 076");
    for (const file of files) {
      const source = await readFile(path.resolve("migrations", file), "utf8");
      await handle.pool.query(renderMigrationSql(source, rehearsalSchema));
    }
    // 幂等:关键迁移整体重放一遍不得报错
    const source021 = await readFile(path.resolve("migrations/021_script_breakdown.sql"), "utf8");
    await handle.pool.query(renderMigrationSql(source021, rehearsalSchema));
    const source045 = await readFile(path.resolve("migrations/045_script_breakdown_enrichment.sql"), "utf8");
    await handle.pool.query(renderMigrationSql(source045, rehearsalSchema));
    const source048 = await readFile(path.resolve("migrations/048_script_breakdown_execution_token.sql"), "utf8");
    await handle.pool.query(renderMigrationSql(source048, rehearsalSchema));
    const source076 = await readFile(path.resolve("migrations/076_script_breakdown_active_run_guard.sql"), "utf8");
    await handle.pool.query(renderMigrationSql(source076, rehearsalSchema));

    await handle.pool.query(
      `INSERT INTO ${quoted}.users (id, username, display_name, password_hash, active, created_at, updated_at)
       VALUES ($1, $2, 'SBD Rehearsal', 'test-only-hash', true, $3, $3)`,
      [ownerId, `sbd-rehearsal-${ownerId.slice(0, 8)}`, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.projects (id, owner_user_id, name, description, status, created_at, updated_at)
       VALUES ($1, $2, 'SBD Rehearsal Project', NULL, 'active', $3, $3)`,
      [projectId, ownerId, now],
    );
    for (const [id, episodeNo] of [[episodeId, 1], [foreignEpisodeId, 2], [raceEpisodeId, 3], [migrationEpisodeId, 4]] as const) {
      await handle.pool.query(
        `INSERT INTO ${quoted}.episodes (id, project_id, episode_no, name, sort_order, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $3, 'active', $5, $5)`,
        [id, projectId, episodeNo, `第${episodeNo}集`, now],
      );
    }

    /**
     * 造一条「上一版留下的」执行阶段行。切到 agent 路之后代码不再写这种行,
     * 但生产库里有,所以回收/续跑对它们的处理仍然要有覆盖。
     */
    const insertLegacyRunningStage = async (runId: string, at: Date = now) => {
      await handle.pool.query(
        `INSERT INTO ${quoted}.script_breakdown_run_stages (
           id, run_id, stage_key, stage_order, status, attempt_count,
           validation_json, usage_json, started_at, completed_at, created_at, updated_at
         ) VALUES ($1, $2, 'structure', 1, 'running', 1,
           '{"issues":[]}'::jsonb, '{"calls":[]}'::jsonb, $3, NULL, $3, $3)`,
        [randomUUID(), runId, at],
      );
    };

    const repository = new DrizzleScriptBreakdownRepository(handle.db);
    const gateway = new doubles.ScriptedToolTurnGateway(doubles.happyPathToolTurns());
    const service = new ScriptBreakdownService(repository, gateway, new doubles.AllowAllAccess());

    // ===== 076 存量收口:守卫前同集重复活跃 run 不得卡死迁移 =====
    const migrationVersion = await service.createScriptVersion(doubles.TEST_ACTOR, migrationEpisodeId, {
      title: "迁移存量集",
      scriptText: doubles.TEST_SCRIPT_TEXT,
      clientIdempotencyKey: "db-migration-version",
    });
    const migrationKeeper = await service.createRun(doubles.TEST_ACTOR, migrationEpisodeId, {
      scriptVersionId: migrationVersion.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: "db-migration-keeper",
    });
    await handle.pool.query(
      `DROP INDEX ${quoted}.script_breakdown_runs_episode_active_unique`,
    );
    const migrationDuplicate = await repository.createRun({
      episodeId: migrationEpisodeId,
      scriptVersionId: migrationVersion.version.id,
      createdByUserId: ownerId,
      clientIdempotencyKey: "db-migration-duplicate",
      requestHash: "a".repeat(64),
      promptVersion: migrationKeeper.run.promptVersion,
      inputSha256: "b".repeat(64),
      targetDurationSec: null,
      now: new Date(migrationKeeper.run.createdAt.getTime() + 1_000),
    });
    assert.equal(migrationDuplicate.outcome, "created");
    const migrationExecutionToken = await repository.claimExecution(
      migrationDuplicate.run.id,
      migrationDuplicate.run.createdAt,
    );
    assert.ok(migrationExecutionToken);
    await insertLegacyRunningStage(
      migrationDuplicate.run.id,
      migrationDuplicate.run.createdAt,
    );
    const migrationAiCallId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.ai_calls (
         id, caller_user_id, project_id, related_object_type, related_object_id,
         purpose, provider, model, status, created_at
       ) VALUES ($1, $2, $3, 'script_breakdown_run', $4,
         'script_breakdown_enrich', 'ark', 'test-model', 'running', $5)`,
      [
        migrationAiCallId,
        ownerId,
        projectId,
        migrationDuplicate.run.id,
        migrationDuplicate.run.createdAt,
      ],
    );

    await handle.pool.query(renderMigrationSql(source076, rehearsalSchema));
    await handle.pool.query(renderMigrationSql(source076, rehearsalSchema));
    const migratedRuns = await handle.pool.query<{
      id: string;
      status: string;
      execution_token: string | null;
      error_code: string | null;
    }>(
      `SELECT id, status, execution_token, error_code
       FROM ${quoted}.script_breakdown_runs
       WHERE episode_id = $1
       ORDER BY created_at ASC, id ASC`,
      [migrationEpisodeId],
    );
    assert.deepEqual(migratedRuns.rows, [
      {
        id: migrationKeeper.run.id,
        status: "queued",
        execution_token: null,
        error_code: null,
      },
      {
        id: migrationDuplicate.run.id,
        status: "failed",
        execution_token: null,
        error_code: "lite_run_in_flight",
      },
    ]);
    const migratedStage = await handle.pool.query<{
      status: string;
      error_code: string | null;
      completed_at: Date | null;
    }>(
      `SELECT status, error_code, completed_at
       FROM ${quoted}.script_breakdown_run_stages
       WHERE run_id = $1 AND stage_key = 'structure'`,
      [migrationDuplicate.run.id],
    );
    assert.equal(migratedStage.rows[0]?.status, "failed");
    assert.equal(migratedStage.rows[0]?.error_code, "lite_run_in_flight");
    assert.ok(migratedStage.rows[0]?.completed_at);
    const migratedAiCall = await handle.pool.query<{
      status: string;
      error_code: string | null;
      completed_at: Date | null;
      duration_ms: number | null;
    }>(
      `SELECT status, error_code, completed_at, duration_ms
       FROM ${quoted}.ai_calls WHERE id = $1`,
      [migrationAiCallId],
    );
    assert.equal(migratedAiCall.rows[0]?.status, "failed");
    assert.equal(migratedAiCall.rows[0]?.error_code, "lite_run_in_flight");
    assert.ok(migratedAiCall.rows[0]?.completed_at);
    assert.ok(migratedAiCall.rows[0]?.duration_ms !== null);
    await assert.rejects(
      repository.claimExecution(migrationDuplicate.run.id, now),
      (error: unknown) => error instanceof ConflictError
        && error.code === "lite_run_in_flight",
    );
    await assert.rejects(
      service.resumeRun(doubles.TEST_ACTOR, migrationDuplicate.run.id),
      (error: unknown) => error instanceof ConflictError
        && error.code === "lite_run_in_flight",
    );
    await service.discardRun(doubles.TEST_ACTOR, migrationKeeper.run.id);
    await service.resumeRun(doubles.TEST_ACTOR, migrationDuplicate.run.id);
    assert.equal(
      (await repository.getRun(migrationDuplicate.run.id))?.status,
      "queued",
      "存量重复 run 在保留项终态后仍可按 failed retry 合同续跑",
    );

    const version = await service.createScriptVersion(doubles.TEST_ACTOR, episodeId, {
      title: "第一集",
      scriptText: doubles.TEST_SCRIPT_TEXT,
      clientIdempotencyKey: "db-version-1",
    });
    const created = await service.createRun(doubles.TEST_ACTOR, episodeId, {
      scriptVersionId: version.version.id,
      targetDurationSec: 90,
      clientIdempotencyKey: "db-run-1",
    });
    assert.equal(created.outcome, "created");

    // ===== 硬门:真 PostgreSQL + 真 HTTP 并发不同幂等键，同集只能建一条活跃 run =====
    const concurrentVersion = await service.createScriptVersion(doubles.TEST_ACTOR, raceEpisodeId, {
      title: "第二集并发", scriptText: doubles.TEST_SCRIPT_TEXT, clientIdempotencyKey: "db-http-concurrent-version",
    });
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, _request, reply) => {
      const { statusCode, body } = toHttpErrorResponse(error);
      return reply.code(statusCode).send({ ok: false, error: body });
    });
    app.addHook("preHandler", async (request) => {
      request.authUser = {
        id: doubles.TEST_ACTOR.id,
        username: "sbd-rehearsal",
        displayName: "SBD Rehearsal",
        role: doubles.TEST_ACTOR.role,
      };
    });
    await registerScriptBreakdownRoutes(app, () => handle.db, {
      createService: () => new ScriptBreakdownService(
        repository,
        new doubles.ScriptedToolTurnGateway(doubles.happyPathToolTurns()),
        new doubles.AllowAllAccess(),
      ),
      executeRunsInline: true,
    });
    try {
      const concurrentResponses = await Promise.all([
        app.inject({
          method: "POST", url: `/api/v1/episodes/${raceEpisodeId}/script-breakdowns`, headers: { "content-type": "application/json" },
          payload: { script_version_id: concurrentVersion.version.id, client_idempotency_key: "db-http-active-run-1" },
        }),
        app.inject({
          method: "POST", url: `/api/v1/episodes/${raceEpisodeId}/script-breakdowns`, headers: { "content-type": "application/json" },
          payload: { script_version_id: concurrentVersion.version.id, client_idempotency_key: "db-http-active-run-2" },
        }),
      ]);
      assert.deepEqual(concurrentResponses.map((response) => response.statusCode).sort(), [200, 409]);
      const rejected = concurrentResponses.find((response) => response.statusCode === 409)!;
      assert.deepEqual(rejected.json().error, {
        code: "lite_run_in_flight", message: "这一集正在解析中，请稍候", retryable: false, details: null,
      });
      const activeRuns = await handle.pool.query<{ id: string; status: string }>(
        `SELECT id, status FROM ${quoted}.script_breakdown_runs
         WHERE episode_id = $1 AND status IN ('queued', 'running', 'draft')`,
        [raceEpisodeId],
      );
      console.info(JSON.stringify({
        active_run_race_http_statuses: concurrentResponses.map((response) => response.statusCode),
        rejected_code: rejected.json().error.code,
        active_run_count: activeRuns.rowCount,
      }));
      assert.equal(activeRuns.rowCount, 1, "并发 HTTP 后 DB 仅能读回一条活跃 run");
    } finally {
      await app.close();
    }

    await service.executeRun(created.run.id, doubles.TEST_ACTOR.id);
    const detail = await service.getRun(doubles.TEST_ACTOR, created.run.id);
    assert.equal(detail.run.status, "draft");
    assert.equal(detail.stages.length, 0, "agent 路不再产生执行阶段行");
    // 过程事件真的落进了 script_breakdown_run_stages,并且过得了 shape CHECK
    assert.ok(detail.events.length >= 8, "梗概 + 两场 + 五个资产 + 两个镜头 + 收尾");
    assert.deepEqual(
      detail.events.map((event) => event.sequence),
      detail.events.map((_event, index) => index + 1),
    );
    const eventRow = await handle.pool.query<{ stage_key: string; status: string; completed_at: Date | null; output_json: unknown }>(
      `SELECT stage_key, status, completed_at, output_json
       FROM ${quoted}.script_breakdown_run_stages WHERE run_id = $1`,
      [created.run.id]);
    assert.equal(eventRow.rowCount, 1, "整条运行只占一行,不是一条事件一行");
    assert.equal(eventRow.rows[0]?.stage_key, "fill_events");
    assert.equal(eventRow.rows[0]?.status, "succeeded");
    assert.ok(eventRow.rows[0]?.completed_at, "终态行必须带 completed_at(shape CHECK)");
    // 白名单:落库的原始 JSON 里只有约定字段
    const storedEvents = (eventRow.rows[0]?.output_json as { events: Array<Record<string, unknown>> }).events;
    for (const stored of storedEvents) {
      assert.deepEqual(
        Object.keys(stored).sort(),
        ["description", "occurred_at", "reason", "sequence", "status", "tool"],
      );
    }

    // ===== 边界实证:草稿就绪后,正式 scenes/shots 必须一行都没有 =====
    const scenesBefore = await handle.pool.query(
      `SELECT id FROM ${quoted}.scenes WHERE episode_id = $1 AND deleted_at IS NULL`, [episodeId]);
    const shotsBefore = await handle.pool.query(
      `SELECT id FROM ${quoted}.shots WHERE episode_id = $1 AND deleted_at IS NULL`, [episodeId]);
    assert.equal(scenesBefore.rowCount, 0, "AI 执行不得直接写正式 scenes");
    assert.equal(shotsBefore.rowCount, 0, "AI 执行不得直接写正式 shots");

    // ===== 人工确认:与普通项目资产添加竞争同名角色，最终只保留一条项目资产 =====
    const competingLinxueId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.asset_entities (
         id, owner_user_id, visibility, asset_kind, role, usage_mode, name, display_name,
         style_tags, approved, reuse_scope, status, metadata, created_at, updated_at, use_count
       ) VALUES (
         $1, $2, 'personal', 'character', 'character_identity', 'reference', '林雪', '林雪',
         '[]'::jsonb, true, 'all_projects', 'approved', '{}'::jsonb, $3, $3, 0
       )`,
      [competingLinxueId, ownerId, now],
    );
    const projectAssetsRepository = new ProjectAssetRepository(handle.db);
    const [confirmOutcome, addOutcome] = await Promise.allSettled([
      service.confirmRun(doubles.TEST_ACTOR, created.run.id),
      projectAssetsRepository.add(
        ownerId,
        projectId,
        { assetEntityId: competingLinxueId },
        projectId,
      ),
    ]);
    if (confirmOutcome.status !== "fulfilled") {
      throw new Error("剧本确认不能被并发项目资产添加打断", { cause: confirmOutcome.reason });
    }
    if (addOutcome.status === "rejected") {
      assert.equal(
        (addOutcome.reason as { code?: string }).code,
        "project_asset_name_conflict",
        "确认先拿锁时，普通添加必须明确拒绝同名重复资产",
      );
    }
    const confirmed = confirmOutcome.value;
    assert.equal(confirmed.outcome, "confirmed");
    assert.equal(confirmed.sceneCount, 2);
    assert.equal(confirmed.shotCount, 2);
    const shotsAfter = await handle.pool.query<{
      shot_code: string;
      source_breakdown_run_id: string;
      source_candidate_id: string;
      script_text: string | null;
      breakdown_elements: Record<string, unknown> | null;
      director_prompt: string | null;
      image_prompt: string | null;
      video_prompt: string | null;
      reference_asset_snapshots: Array<Record<string, unknown>>;
      storyboard_detail: Record<string, unknown> | null;
    }>(
      `SELECT shot_code, source_breakdown_run_id, source_candidate_id, script_text,
              breakdown_elements, director_prompt, image_prompt, video_prompt,
              reference_asset_snapshots, storyboard_detail
       FROM ${quoted}.shots WHERE episode_id = $1 AND deleted_at IS NULL ORDER BY sort_order`, [episodeId]);
    assert.equal(shotsAfter.rowCount, 2);
    assert.deepEqual(shotsAfter.rows.map((row) => row.shot_code), ["G01", "G02"]);
    for (const row of shotsAfter.rows) {
      assert.equal(row.source_breakdown_run_id, created.run.id, "正式分镜必须记录来源运行");
      assert.ok(row.source_candidate_id.startsWith("shot_"), "正式分镜必须记录来源候选");
    }
    assert.equal(shotsAfter.rows[0]!.script_text, "夜,旧仓库,林雪独白。\n林雪:我不会再等。");
    assert.deepEqual(shotsAfter.rows[0]!.breakdown_elements, {
      subject: "第 1 个镜头的主体动作",
      action: "第 2 个镜头的主体动作",
      visual: "第 1 个镜头的物理细节",
      camera_language: "缓慢推近",
    }, "v8 elements 取 skill 首两个 Shot 四模块");
    assert.equal(shotsAfter.rows[0]!.director_prompt, null, "v2 拆解不得伪造成文提示词");
    assert.equal(shotsAfter.rows[0]!.image_prompt, null);
    assert.ok(shotsAfter.rows[0]!.video_prompt?.includes("严禁任何字幕"), "v8 成文提示词由模型按生效模板写,落 video_prompt");
    assert.ok(shotsAfter.rows[0]!.storyboard_detail, "skill 全维度落 storyboard_detail");
    const projectAssets = await handle.pool.query<{
      id: string;
      asset_kind: string;
      name: string;
      visibility: string;
      owner_user_id: string;
      status: string;
    }>(
      `SELECT ae.id, ae.asset_kind, ae.name, ae.visibility, ae.owner_user_id, ae.status
       FROM ${quoted}.project_asset_refs par
       JOIN ${quoted}.asset_entities ae ON ae.id = par.asset_entity_id
       WHERE par.project_id = $1 AND par.deleted_at IS NULL AND ae.deleted_at IS NULL
       ORDER BY ae.asset_kind, ae.name`,
      [projectId],
    );
    assert.deepEqual(
      projectAssets.rows.map((asset) => `${asset.asset_kind}:${asset.name}`),
      ["audio:雨声", "character:周行", "character:林雪", "costume:风衣", "prop:怀表", "scene:天台", "scene:旧仓库"],
      "确认后五类候选必须成为当前项目的正式资产(v8)",
    );
    assert.ok(projectAssets.rows.every((asset) =>
      asset.visibility === "personal"
      && asset.owner_user_id === ownerId
      && asset.status === "approved"));
    const linxueId = projectAssets.rows.find((asset) => asset.name === "林雪")?.id;
    assert.ok(linxueId);
    assert.ok(shotsAfter.rows.every((shot) =>
      shot.reference_asset_snapshots.some((snapshot) => snapshot.asset_entity_id === linxueId)),
    "跨镜的林雪必须引用同一条正式资产");
    const scenesAfter = await handle.pool.query<{ scene_no: number; source_breakdown_run_id: string }>(
      `SELECT scene_no, source_breakdown_run_id FROM ${quoted}.scenes
       WHERE episode_id = $1 AND deleted_at IS NULL ORDER BY sort_order`, [episodeId]);
    assert.deepEqual(scenesAfter.rows.map((row) => row.scene_no), [1, 2]);

    // ===== v0.9:Lite materialize——音频出现记录 + audio_kind + 音频不写生成快照 =====
    // 动态 import 与文件头同因:drizzle schema 模块加载时读 POSTGRES_SCHEMA,
    // lite repository 必须在指到 rehearsal schema 之后才能加载,静态 import 会抢跑。
    const { DrizzleLiteRepository } = await import("../src/modules/lite/repository.js");
    const { LiteAssetService } = await import("../src/modules/lite/service.js");
    const liteService = new LiteAssetService(new DrizzleLiteRepository(handle.db), new doubles.AllowAllAccess());
    const materialized = await liteService.materializeAssets(doubles.TEST_ACTOR, projectId, episodeId);
    assert.equal(materialized.created, 0, "confirm 已建五类资产,materialize 全幂等");
    assert.equal(materialized.existed, 7);
    const audioAsset = await handle.pool.query<{ id: string; metadata: Record<string, unknown> }>(
      `SELECT ae.id, ae.metadata FROM ${quoted}.project_asset_refs par
       JOIN ${quoted}.asset_entities ae ON ae.id = par.asset_entity_id
       WHERE par.project_id = $1 AND par.deleted_at IS NULL
         AND ae.asset_kind = 'audio' AND ae.name = '雨声' AND ae.deleted_at IS NULL`,
      [projectId]);
    assert.equal(audioAsset.rowCount, 1);
    assert.equal(audioAsset.rows[0]!.metadata.audio_kind, "ambience", "音频五类分类落 metadata.audio_kind");
    const audioUsages = (audioAsset.rows[0]!.metadata.lite as { usages?: Array<Record<string, unknown>> } | undefined)?.usages ?? [];
    assert.equal(audioUsages.length, 1, "音频出现记录:第 1 集镜 1 一条");
    assert.equal(audioUsages[0]!.episode_no, 1);
    assert.equal(audioUsages[0]!.shot_no, 1);
    assert.equal(audioUsages[0]!.status, "bound");
    assert.equal(audioUsages[0]!.matched_by, "exact_name");
    assert.ok(
      shotsAfter.rows[0]!.reference_asset_snapshots.every((snapshot) => snapshot.asset_kind !== "audio"),
      "音频只写出现记录,不写生成快照(消费链认四栏引用)",
    );

    // ===== 重复确认:幂等返回,不重复建行 =====
    const replay = await service.confirmRun(doubles.TEST_ACTOR, created.run.id);
    assert.equal(replay.outcome, "already_confirmed");
    assert.equal(replay.shotCount, 2);
    const shotsAfterReplay = await handle.pool.query(
      `SELECT id FROM ${quoted}.shots WHERE episode_id = $1`, [episodeId]);
    assert.equal(shotsAfterReplay.rowCount, 2, "重复确认不得重复建行");

    // ===== 新一次确认:替换旧正式行,旧运行转 superseded =====
    const gateway2 = new doubles.ScriptedToolTurnGateway(doubles.happyPathToolTurns());
    const service2 = new ScriptBreakdownService(repository, gateway2, new doubles.AllowAllAccess());
    const created2 = await service2.createRun(doubles.TEST_ACTOR, episodeId, {
      scriptVersionId: version.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: "db-run-2",
    });
    await service2.executeRun(created2.run.id, doubles.TEST_ACTOR.id);
    const confirmed2 = await service2.confirmRun(doubles.TEST_ACTOR, created2.run.id);
    assert.equal(confirmed2.outcome, "confirmed");
    assert.deepEqual(confirmed2.supersededRunIds, [created.run.id]);
    const liveShots = await handle.pool.query(
      `SELECT id, source_breakdown_run_id FROM ${quoted}.shots WHERE episode_id = $1 AND deleted_at IS NULL`, [episodeId]);
    assert.equal(liveShots.rowCount, 2);
    assert.ok(liveShots.rows.every((row) => row.source_breakdown_run_id === created2.run.id));
    const oldRun = await service.getRun(doubles.TEST_ACTOR, created.run.id);
    assert.equal(oldRun.run.status, "superseded");
    assert.equal(oldRun.run.supersededByRunId, created2.run.id);
    const assetsAfterSecondConfirm = await handle.pool.query(
      `SELECT ae.id
       FROM ${quoted}.project_asset_refs par
       JOIN ${quoted}.asset_entities ae ON ae.id = par.asset_entity_id
       WHERE par.project_id = $1 AND par.deleted_at IS NULL AND ae.deleted_at IS NULL`,
      [projectId],
    );
    assert.equal(assetsAfterSecondConfirm.rowCount, 7, "再次拆解确认必须复用资产，不能重复创建同名资产(v8 五类)");
    // 被替换的运行不能再确认
    await assert.rejects(service.confirmRun(doubles.TEST_ACTOR, created.run.id), /已被更新的确认替换/);

    // ===== 人工正式内容存在时:确认 = 覆盖重建(v8 修订,§3.4.7 重跑口径) =====
    // 旧 409 守卫与弹窗承诺矛盾且把重跑变死循环;现在确认后人工场被软删(R1 可逆)。
    const foreignSceneId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.scenes (id, episode_id, scene_no, name, description, sort_order, created_at, updated_at)
       VALUES ($1, $2, 1, '人工场', NULL, 0, $3, $3)`,
      [foreignSceneId, foreignEpisodeId, now],
    );
    const version3 = await service.createScriptVersion(doubles.TEST_ACTOR, foreignEpisodeId, {
      title: null,
      scriptText: doubles.TEST_SCRIPT_TEXT,
      clientIdempotencyKey: "db-version-3",
    });
    const gateway3 = new doubles.ScriptedToolTurnGateway(doubles.happyPathToolTurns());
    const service3 = new ScriptBreakdownService(repository, gateway3, new doubles.AllowAllAccess());
    const created3 = await service3.createRun(doubles.TEST_ACTOR, foreignEpisodeId, {
      scriptVersionId: version3.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: "db-run-3",
    });
    await service3.executeRun(created3.run.id, doubles.TEST_ACTOR.id);
    const confirmed3 = await service3.confirmRun(doubles.TEST_ACTOR, created3.run.id);
    assert.equal(confirmed3.outcome, "confirmed", "有人工正式内容也确认得了:覆盖重建是合同口径");
    const foreignScene = await handle.pool.query(
      `SELECT deleted_at IS NOT NULL AS gone FROM ${quoted}.scenes WHERE id = $1`, [foreignSceneId]);
    assert.equal(foreignScene.rows[0]?.gone, true, "人工场确认后被软删(R1 可逆),不是硬删");
    const rebuiltShots = await handle.pool.query(
      `SELECT count(*)::int AS n FROM ${quoted}.shots
       WHERE episode_id = $1 AND deleted_at IS NULL AND source_breakdown_run_id = $2`,
      [foreignEpisodeId, created3.run.id]);
    assert.equal(rebuiltShots.rows[0]?.n, 2, "覆盖重建后的活分镜都带新 run 溯源");

    // ===== 放弃:草稿可放弃,放弃后不可确认 =====
    const discardRun4 = await service3.createRun(doubles.TEST_ACTOR, foreignEpisodeId, {
      scriptVersionId: version3.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: "db-run-discard",
    });
    await service3.executeRun(discardRun4.run.id, doubles.TEST_ACTOR.id);
    const discarded = await service3.discardRun(doubles.TEST_ACTOR, discardRun4.run.id);
    assert.equal(discarded.status, "discarded");
    await assert.rejects(service3.confirmRun(doubles.TEST_ACTOR, discardRun4.run.id), /已放弃/);

    // ===== 失败续跑:续跑不许把过程事件行抹掉(真库约束回归,
    // 内存替身不拦 shape CHECK,曾在此翻船) =====
    // 先成功填一格再挂:这样才既有过程事件、又有失败断点可以续跑
    const gatewayFail = new doubles.ScriptedToolTurnGateway([
      doubles.happyPathToolTurns()[0]!,
      { error: new Error("upstream 503") },
    ]);
    const service4 = new ScriptBreakdownService(repository, gatewayFail, new doubles.AllowAllAccess());
    const created4 = await service4.createRun(doubles.TEST_ACTOR, episodeId, {
      scriptVersionId: version.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: "db-run-4",
    });
    await service4.executeRun(created4.run.id, doubles.TEST_ACTOR.id);
    assert.equal((await service4.getRun(doubles.TEST_ACTOR, created4.run.id)).run.status, "failed");
    // 上一版留下的阶段行:续跑必须把它重置成过得了 shape CHECK 的 pending
    await handle.pool.query(
      `INSERT INTO ${quoted}.script_breakdown_run_stages (
         id, run_id, stage_key, stage_order, status, attempt_count,
         validation_json, usage_json, error_code, error_message,
         started_at, completed_at, created_at, updated_at
       ) VALUES ($1, $2, 'structure', 1, 'failed', 1,
         '{"issues":[]}'::jsonb, '{"calls":[]}'::jsonb, 'provider_error', '上一版留下的',
         $3, $3, $3, $3)`,
      [randomUUID(), created4.run.id, now],
    );
    await service4.resumeRun(doubles.TEST_ACTOR, created4.run.id);
    assert.equal(
      (await repository.getRun(created4.run.id))?.status,
      "queued",
      "resume 返回前先占住本集活跃位",
    );
    const resetStages = await handle.pool.query<{ stage_key: string; status: string; completed_at: Date | null; error_code: string | null; started_at: Date | null }>(
      `SELECT stage_key, status, completed_at, error_code, started_at FROM ${quoted}.script_breakdown_run_stages WHERE run_id = $1`,
      [created4.run.id]);
    const legacyStage = resetStages.rows.find((row) => row.stage_key === "structure")!;
    assert.equal(legacyStage.status, "pending");
    assert.equal(legacyStage.completed_at, null, "pending 阶段不得留 completed_at(shape CHECK)");
    assert.equal(legacyStage.error_code, null, "pending 阶段不得留上一轮错误");
    assert.equal(legacyStage.started_at, null);
    const survivingEvents = resetStages.rows.find((row) => row.stage_key === "fill_events");
    assert.equal(survivingEvents?.status, "succeeded", "过程事件行不许被续跑重置");
    // 续跑到底:换可用网关重新执行,运行能从断点走到 draft
    const gateway5 = new doubles.ScriptedToolTurnGateway(doubles.happyPathToolTurns());
    const service5 = new ScriptBreakdownService(repository, gateway5, new doubles.AllowAllAccess());
    await service5.executeRun(created4.run.id, doubles.TEST_ACTOR.id);
    assert.equal((await service5.getRun(doubles.TEST_ACTOR, created4.run.id)).run.status, "draft");
    await service5.discardRun(doubles.TEST_ACTOR, created4.run.id);

    // ===== 主动放弃 running：run + 遗留阶段行 + AI 审计必须同事务收口 =====
    const discardRun = await service5.createRun(doubles.TEST_ACTOR, episodeId, {
      scriptVersionId: version.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: "db-run-discard-running",
    });
    const discardExecutionToken = await repository.claimExecution(discardRun.run.id, now);
    assert.ok(discardExecutionToken);
    await insertLegacyRunningStage(discardRun.run.id);
    const discardAiCallId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.ai_calls (
         id, caller_user_id, project_id, related_object_type, related_object_id,
         purpose, provider, model, status, created_at
       ) VALUES ($1, $2, $3, 'script_breakdown_run', $4,
         'script_breakdown_enrich', 'ark', 'test-model', 'running', $5)`,
      [discardAiCallId, ownerId, projectId, discardRun.run.id, now],
    );
    assert.equal((await service5.discardRun(doubles.TEST_ACTOR, discardRun.run.id)).status, "discarded");
    const discardedState = await service5.getRun(doubles.TEST_ACTOR, discardRun.run.id);
    assert.equal(discardedState.stages.find((stage) => stage.stageKey === "structure")?.status, "failed");
    assert.equal(discardedState.stages.find((stage) => stage.stageKey === "structure")?.errorCode, "run_discarded");
    const discardedAiState = await handle.pool.query<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM ${quoted}.ai_calls WHERE id = $1`,
      [discardAiCallId],
    );
    assert.equal(discardedAiState.rows[0]?.status, "failed");
    assert.equal(discardedAiState.rows[0]?.error_code, "run_discarded");

    // ===== 失联回收:run + 当前 stage + AI 审计同事务失败，成功检查点可续跑 =====
    const staleRun = await service5.createRun(doubles.TEST_ACTOR, episodeId, {
      scriptVersionId: version.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: "db-run-stale-recovery",
    });
    const freshRun = await service5.createRun(doubles.TEST_ACTOR, foreignEpisodeId, {
      scriptVersionId: version3.version.id,
      targetDurationSec: null,
      clientIdempotencyKey: "db-run-fresh-recovery",
    });
    const staleAt = new Date("2026-07-25T07:50:00.000Z");
    const staleExecutionToken = await repository.claimExecution(staleRun.run.id, staleAt);
    assert.ok(staleExecutionToken);
    await insertLegacyRunningStage(staleRun.run.id, staleAt);
    assert.ok(await repository.claimExecution(freshRun.run.id, now));
    const staleAiCallId = randomUUID();
    const longStaleAiCallId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quoted}.ai_calls (
         id, caller_user_id, project_id, related_object_type, related_object_id,
         purpose, provider, model, status, created_at
       ) VALUES
         ($1, $2, $3, 'script_breakdown_run', $4,
          'script_breakdown_enrich', 'ark', 'test-model', 'running', $5),
         ($6, $2, $3, 'script_breakdown_run', $4,
          'script_breakdown_enrich', 'ark', 'test-model', 'running', $7)`,
      [
        staleAiCallId,
        ownerId,
        projectId,
        staleRun.run.id,
        staleAt,
        longStaleAiCallId,
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000),
      ],
    );

    assert.equal(await repository.reclaimStaleRuns({
      cutoff: new Date("2026-07-25T07:55:00.000Z"),
      now,
    }), 1);
    const staleState = await service5.getRun(doubles.TEST_ACTOR, staleRun.run.id);
    assert.equal(staleState.run.status, "failed");
    assert.equal(staleState.run.errorCode, "worker_timeout");
    const staleLegacy = staleState.stages.find((stage) => stage.stageKey === "structure");
    assert.equal(staleLegacy?.status, "failed", "遗留的 running 阶段行也要在同一事务里关掉");
    assert.equal(staleLegacy?.errorCode, "worker_timeout");
    const aiState = await handle.pool.query<{
      id: string;
      status: string;
      error_code: string;
      duration_ms: number;
      completed_at: Date | null;
    }>(
      `SELECT id, status, error_code, duration_ms, completed_at
       FROM ${quoted}.ai_calls
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[staleAiCallId, longStaleAiCallId]],
    );
    assert.equal(aiState.rowCount, 2);
    for (const call of aiState.rows) {
      assert.equal(call.status, "failed");
      assert.equal(call.error_code, "worker_timeout");
      assert.ok(call.completed_at);
    }
    assert.equal(
      aiState.rows.find((call) => call.id === longStaleAiCallId)?.duration_ms,
      2_147_483_647,
      "超过 PostgreSQL integer 上限的失联时长必须封顶，不能回滚整个回收事务",
    );
    assert.equal((await service5.getRun(doubles.TEST_ACTOR, freshRun.run.id)).run.status, "running");

    const aiRepository = new DrizzleAiCallRepository(handle.db);
    await assert.rejects(
      aiRepository.reserve({
        actorId: ownerId,
        purpose: "script_breakdown_enrich",
        provider: "ark",
        requestedModel: "test-model",
        projectId,
        relatedObject: { type: "script_breakdown_run", id: staleRun.run.id },
        executionFence: {
          type: "script_breakdown_run",
          runId: staleRun.run.id,
          token: staleExecutionToken,
        },
        dailyLimit: 100,
        now,
      }),
      (error: unknown) => error instanceof AiExecutionFenceLostError,
      "回收后的旧 worker 不得再预留新 AI 调用",
    );

    await service5.resumeRun(doubles.TEST_ACTOR, staleRun.run.id);
    const resumedStale = await service5.getRun(doubles.TEST_ACTOR, staleRun.run.id);
    assert.equal(resumedStale.stages.find((stage) => stage.stageKey === "structure")?.status, "pending");

    // 新执行认领后，旧 worker 即使晚到也不能覆盖新代次的 stage/run。
    const resumedExecutionToken = await repository.claimExecution(staleRun.run.id, now);
    assert.ok(resumedExecutionToken);
    assert.notEqual(resumedExecutionToken, staleExecutionToken);
    assert.equal(
      await repository.resetStagesForResume(staleRun.run.id, now),
      false,
      "并发过期 resume 不得把新 execution 的 stage 重置为 pending",
    );
    const currentReservation = await aiRepository.reserve({
      actorId: ownerId,
      purpose: "script_breakdown_enrich",
      provider: "ark",
      requestedModel: "test-model",
      projectId,
      relatedObject: { type: "script_breakdown_run", id: staleRun.run.id },
      executionFence: {
        type: "script_breakdown_run",
        runId: staleRun.run.id,
        token: resumedExecutionToken,
      },
      dailyLimit: 100,
      now,
    });
    await aiRepository.fail({
      id: currentReservation.id,
      errorCode: "test_cleanup",
      durationMs: 0,
      now,
    });
    // 旧 worker 晚到:写事件与关账两条路径都必须被围栏挡住
    await repository.recordFillEvents({
      runId: staleRun.run.id,
      executionToken: staleExecutionToken,
      events: [{
        sequence: 1,
        tool: null,
        status: "accepted",
        description: "旧 worker 晚到",
        reason: null,
        occurredAt: now,
      }],
      now,
    });
    await repository.finalizeRunFailed({
      runId: staleRun.run.id,
      executionToken: staleExecutionToken,
      currentStage: "assets",
      errorCode: "provider_error",
      errorMessage: "旧 worker 晚到",
      now,
    });
    const fencedState = await service5.getRun(doubles.TEST_ACTOR, staleRun.run.id);
    assert.equal(fencedState.run.status, "running");
    assert.notEqual(fencedState.run.errorCode, "provider_error", "旧 worker 的关账不得盖到新代次头上");
    assert.deepEqual(fencedState.events, [], "旧 worker 写的事件必须被围栏挡在外面");

    // P6 阶段②只读配置:真源顺序专项(v11 恢复「分镜 Shot 数」,策略 parameters.shots_per_segment)。
    // 期望与分镜详情「AI 生成」getProjectVideoTemplate / 生成期 resolveProjectGenerationConfig 三链同口径:
    // 真源 1 项目列 video_prompt_template → 真源 2 策略 prompt_template_id → 平台默认行 → 代码常量。
    const baseline = await repository.resolveStoryboardVideoConfig(projectId);
    assert.equal(baseline.styleDescription, null, "未配置风格时回 null");
    assert.equal(baseline.shotsPerSegment, null, "未配置每段 Shot 数时回 null(自由)");
    assert.ok(
      baseline.promptTemplate.includes("严禁任何字幕"),
      `无项目列/策略时应命中 064 播种的平台默认视频模板,实际=${baseline.promptTemplate.slice(0, 60)}`,
    );
    assert.notEqual(baseline.promptTemplate, DEFAULT_VIDEO_PROMPT_TEMPLATE, "064 播种 ≠ 代码常量");

    await handle.pool.query(
      `UPDATE ${quoted}.projects SET video_style_description = $1 WHERE id = $2`,
      ["晨雾森林风格", projectId],
    );
    const withStyle = await repository.resolveStoryboardVideoConfig(projectId);
    assert.equal(withStyle.styleDescription, "晨雾森林风格", "默认视频风格读 projects.video_style_description");

    // 真源 2:策略 prompt_template_id → prompt_templates(video) 用户模板。
    const userTemplateId = randomUUID();
    const userTemplateContent = "用户自建模板：逐镜成文，镜头语言统一";
    await handle.pool.query(
      `INSERT INTO ${quoted}.prompt_templates (id, project_id, media_kind, name, content, created_by_user_id)
       VALUES ($1, $2, 'video', '拆镜配置专项模板', $3, $4)`,
      [userTemplateId, projectId, userTemplateContent, ownerId],
    );
    await handle.pool.query(
      `INSERT INTO ${quoted}.generation_default_strategies
         (id, project_id, media_kind, mode, model_key, parameters, updated_by_user_id)
       VALUES ($1, $2, 'video', 'material_to_prompt', 'happyhorse-1.1-r2v', $3, $4)`,
      [randomUUID(), projectId, JSON.stringify({ prompt_template_id: userTemplateId, shots_per_segment: 3 }), ownerId],
    );
    const viaStrategy = await repository.resolveStoryboardVideoConfig(projectId);
    assert.equal(viaStrategy.promptTemplate, userTemplateContent, "无项目列时生效模板走策略 prompt_template_id → 用户模板");
    assert.equal(viaStrategy.shotsPerSegment, 3, "策略 parameters.shots_per_segment 生效(1..MAX)");

    // 真源 1:项目列优先于策略。设置了项目列就不再读策略/平台默认。
    await handle.pool.query(
      `UPDATE ${quoted}.projects SET video_prompt_template = $1 WHERE id = $2`,
      ["项目列视频模板：导演预设成文口径", projectId],
    );
    const viaProjectColumn = await repository.resolveStoryboardVideoConfig(projectId);
    assert.equal(viaProjectColumn.promptTemplate, "项目列视频模板：导演预设成文口径", "项目列 video_prompt_template 为真源 1,优先于策略");

    // 越界/非法的 shots_per_segment 视为未配置(自由)。
    await handle.pool.query(
      `UPDATE ${quoted}.generation_default_strategies SET parameters = $1 WHERE project_id = $2`,
      [JSON.stringify({ shots_per_segment: 99 }), projectId],
    );
    const outOfRange = await repository.resolveStoryboardVideoConfig(projectId);
    assert.equal(outOfRange.shotsPerSegment, null, "越界 shots_per_segment(>MAX)视为未配置,自由态");

    // 平台默认行缺失 → 回落代码常量 DEFAULT_VIDEO_PROMPT_TEMPLATE。
    await handle.pool.query(`DELETE FROM ${quoted}.prompt_default_templates WHERE media_kind = 'video'`);
    await handle.pool.query(`UPDATE ${quoted}.projects SET video_prompt_template = NULL WHERE id = $1`, [projectId]);
    await handle.pool.query(`DELETE FROM ${quoted}.generation_default_strategies WHERE project_id = $1`, [projectId]);
    const fellBack = await repository.resolveStoryboardVideoConfig(projectId);
    assert.equal(fellBack.promptTemplate, DEFAULT_VIDEO_PROMPT_TEMPLATE, "平台默认行删除后回落代码常量");
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("SCRIPT_BREAKDOWN_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
