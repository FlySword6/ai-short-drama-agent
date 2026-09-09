import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  aiCalls,
  assetEntities,
  episodes,
  episodeScriptVersions,
  generationDefaultStrategies,
  projectAssetRefs,
  promptDefaultTemplates,
  promptTemplates,
  projects,
  scenes,
  scriptBreakdownRuns,
  scriptBreakdownRunStages,
  shots,
} from "../../db/schema.js";
import type {
  EpisodeScriptVersionRow,
  ScriptBreakdownRunRow,
  ScriptBreakdownRunStageRow,
} from "../../db/schema.js";
import { ConflictError, isPostgresUniqueViolation, NotFoundError } from "../../shared/errors.js";
import { DEFAULT_VIDEO_PROMPT_TEMPLATE } from "../generation/promptCompiler.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { buildVersionSnapshot, lockProjectAssetNamespace } from "../project-assets/repository.js";
import type {
  ApprovedAssetSummary,
  AssetCandidates,
  CharacterAssetCandidate,
  ConfirmMapping,
  ConfirmResult,
  CreateOutcome,
  DraftValidation,
  DuplicateCoverage,
  EpisodeContext,
  RunUsage,
  ScriptBreakdownDraft,
  ScriptBreakdownRepository,
  ScriptBreakdownRunRecord,
  ScriptBreakdownRunStatus,
  ScriptBreakdownStageRecord,
  ScriptVersionRecord,
  StageUsage,
  StageValidation,
  UnmatchedAsset,
  ValidationIssue,
  StoryboardVideoConfig,
} from "./types.js";
import { FILL_EVENTS_STAGE_KEY, type PersistedFillEvent } from "./types.js";
import { draftFromUnknown, STORYBOARD_SHOTS_PER_SEGMENT_MAX } from "./schemas.js";

/**
 * 草稿区唯一事实入口。AI 产出的全部写路径只指向 episode_script_versions /
 * script_breakdown_runs / script_breakdown_run_stages;正式 scenes/shots 的
 * 唯一写入点是 confirmRun 的单事务。
 */
export class DrizzleScriptBreakdownRepository implements ScriptBreakdownRepository {
  constructor(private readonly db: Database) {}

  async findEpisode(episodeId: string): Promise<EpisodeContext | null> {
    const rows = await this.db.select({
      id: episodes.id,
      projectId: episodes.projectId,
      status: episodes.status,
      deletedAt: episodes.deletedAt,
    }).from(episodes).where(eq(episodes.id, episodeId)).limit(1);
    return rows[0] ?? null;
  }

  async createScriptVersion(input: {
    episodeId: string;
    title: string | null;
    scriptText: string;
    scriptSha256: string;
    createdByUserId: string;
    clientIdempotencyKey: string;
    requestHash: string;
    now: Date;
  }): Promise<{ version: ScriptVersionRecord; outcome: CreateOutcome }> {
    return this.db.transaction(async (tx) => {
      // 集级咨询锁:版本号 max+1 分配与幂等检查必须串行。
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.episodeId}))`);
      const existing = await findVersionByIdempotencyKey(tx as unknown as Database, input.createdByUserId, input.clientIdempotencyKey);
      if (existing) {
        if (existing.scriptSha256 !== input.scriptSha256) {
          throw new ConflictError("同一幂等键提交了不同内容,请更换幂等键", "idempotency_conflict");
        }
        return { version: existing, outcome: "existing" };
      }
      const latest = await tx.select({ versionNo: episodeScriptVersions.versionNo })
        .from(episodeScriptVersions)
        .where(eq(episodeScriptVersions.episodeId, input.episodeId))
        .orderBy(desc(episodeScriptVersions.versionNo))
        .limit(1);
      try {
        const rows = await tx.insert(episodeScriptVersions).values({
          id: crypto.randomUUID(),
          episodeId: input.episodeId,
          versionNo: (latest[0]?.versionNo ?? 0) + 1,
          title: input.title,
          scriptText: input.scriptText,
          scriptSha256: input.scriptSha256,
          source: "manual",
          createdByUserId: input.createdByUserId,
          clientIdempotencyKey: input.clientIdempotencyKey,
          createdAt: input.now,
        }).returning();
        return { version: toVersionRecord(rows[0]!), outcome: "created" };
      } catch (error) {
        if (isPostgresUniqueViolation(error)) {
          const replayed = await findVersionByIdempotencyKey(tx as unknown as Database, input.createdByUserId, input.clientIdempotencyKey);
          if (replayed && replayed.scriptSha256 === input.scriptSha256) return { version: replayed, outcome: "existing" };
          throw new ConflictError("同一幂等键提交了不同内容,请更换幂等键", "idempotency_conflict");
        }
        throw error;
      }
    });
  }

  async listScriptVersions(episodeId: string): Promise<ScriptVersionRecord[]> {
    const rows = await this.db.select().from(episodeScriptVersions)
      .where(eq(episodeScriptVersions.episodeId, episodeId))
      .orderBy(desc(episodeScriptVersions.versionNo));
    return rows.map(toVersionRecord);
  }

  async getScriptVersion(id: string): Promise<ScriptVersionRecord | null> {
    const rows = await this.db.select().from(episodeScriptVersions)
      .where(eq(episodeScriptVersions.id, id)).limit(1);
    return rows[0] ? toVersionRecord(rows[0]) : null;
  }

  async createRun(input: {
    episodeId: string;
    scriptVersionId: string;
    createdByUserId: string;
    clientIdempotencyKey: string;
    requestHash: string;
    promptVersion: string;
    inputSha256: string;
    targetDurationSec: number | null;
    now: Date;
  }): Promise<{ run: ScriptBreakdownRunRecord; outcome: CreateOutcome }> {
    const existing = await this.findRunByIdempotencyKey(input.createdByUserId, input.clientIdempotencyKey);
    if (existing) {
      return { run: existing, outcome: "existing" };
    }
    try {
      return await this.db.transaction(async (transaction) => {
        // The savepoint is load-bearing when createRun participates in a
        // larger Lite project transaction. A unique violation must roll back
        // before the idempotency/active-run recovery query below can execute.
        const rows = await transaction.insert(scriptBreakdownRuns).values({
          id: crypto.randomUUID(),
          episodeId: input.episodeId,
          scriptVersionId: input.scriptVersionId,
          createdByUserId: input.createdByUserId,
          clientIdempotencyKey: input.clientIdempotencyKey,
          requestHash: input.requestHash,
          modelName: null,
          promptVersion: input.promptVersion,
          status: "queued",
          currentStage: null,
          targetDurationSec: input.targetDurationSec,
          inputSha256: input.inputSha256,
          draftJson: {},
          validationJson: emptyDraftValidationDb(),
          usageJson: runUsageToDb({ callCount: 0, totalInputTokens: 0, totalOutputTokens: 0 }),
          estimatedCostFen: null,
          actualCostFen: null,
          errorCode: null,
          errorMessage: null,
          confirmedByUserId: null,
          confirmedAt: null,
          discardedByUserId: null,
          discardedAt: null,
          supersededByRunId: null,
          createdAt: input.now,
          updatedAt: input.now,
        }).returning();
        return { run: toRunRecord(rows[0]!), outcome: "created" as const };
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        const replayed = await this.findRunByIdempotencyKey(input.createdByUserId, input.clientIdempotencyKey);
        if (replayed) return { run: replayed, outcome: "existing" };
        throw new ConflictError("这一集正在解析中，请稍候", "lite_run_in_flight");
      }
      throw error;
    }
  }
  /** Service provides the friendly preflight; the migration's partial unique index closes its TOCTOU window. */
  async findActiveRun(episodeId: string): Promise<{
    createdByUserId: string;
    clientIdempotencyKey: string;
  } | null> {
    const rows = await this.db.select({
      createdByUserId: scriptBreakdownRuns.createdByUserId,
      clientIdempotencyKey: scriptBreakdownRuns.clientIdempotencyKey,
    }).from(scriptBreakdownRuns).where(and(
      eq(scriptBreakdownRuns.episodeId, episodeId),
      inArray(scriptBreakdownRuns.status, ["queued", "running", "draft"]),
    )).limit(1);
    return rows[0] ?? null;
  }



  private async findRunByIdempotencyKey(userId: string, key: string): Promise<ScriptBreakdownRunRecord | null> {
    const rows = await this.db.select().from(scriptBreakdownRuns).where(and(
      eq(scriptBreakdownRuns.createdByUserId, userId),
      eq(scriptBreakdownRuns.clientIdempotencyKey, key),
    )).limit(1);
    return rows[0] ? toRunRecord(rows[0]) : null;
  }

  async getRun(runId: string): Promise<ScriptBreakdownRunRecord | null> {
    const rows = await this.db.select().from(scriptBreakdownRuns)
      .where(eq(scriptBreakdownRuns.id, runId)).limit(1);
    return rows[0] ? toRunRecord(rows[0]) : null;
  }

  async listRuns(episodeId: string): Promise<ScriptBreakdownRunRecord[]> {
    const rows = await this.db.select().from(scriptBreakdownRuns)
      .where(eq(scriptBreakdownRuns.episodeId, episodeId))
      .orderBy(desc(scriptBreakdownRuns.createdAt));
    return rows.map(toRunRecord);
  }

  async listStages(runId: string): Promise<ScriptBreakdownStageRecord[]> {
    const rows = await this.db.select().from(scriptBreakdownRunStages)
      .where(and(
        eq(scriptBreakdownRunStages.runId, runId),
        // 过程事件借住在这张表里,但它不是一个执行步骤:混进来的话导演端
        // 每轮询一次就会看到几十个「步骤」。
        ne(scriptBreakdownRunStages.stageKey, FILL_EVENTS_STAGE_KEY),
      ))
      .orderBy(scriptBreakdownRunStages.stageOrder);
    return rows.map(toStageRecord);
  }

  /**
   * 过程事件整体覆盖写。固定落成终态行:回收 worker 只改 running 行、
   * 续跑重置只改 running/failed 行,事件行谁都不该顺手改掉。
   */
  async recordFillEvents(input: {
    runId: string;
    executionToken: string;
    events: PersistedFillEvent[];
    now: Date;
  }): Promise<void> {
    const payload = { events: input.events.map(fillEventToDb) };
    const owned = await this.db.select({ id: scriptBreakdownRuns.id })
      .from(scriptBreakdownRuns)
      .where(and(
        eq(scriptBreakdownRuns.id, input.runId),
        eq(scriptBreakdownRuns.status, "running"),
        eq(scriptBreakdownRuns.executionToken, input.executionToken),
      ))
      .limit(1);
    if (owned.length === 0) return;
    await this.db.insert(scriptBreakdownRunStages).values({
      id: crypto.randomUUID(),
      runId: input.runId,
      stageKey: FILL_EVENTS_STAGE_KEY,
      stageOrder: 0,
      status: "succeeded",
      attemptCount: 1,
      outputJson: payload,
      validationJson: { issues: [] },
      usageJson: { calls: [] },
      errorCode: null,
      errorMessage: null,
      startedAt: input.now,
      completedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    }).onConflictDoUpdate({
      target: [scriptBreakdownRunStages.runId, scriptBreakdownRunStages.stageKey],
      set: {
        status: "succeeded",
        outputJson: payload,
        completedAt: input.now,
        updatedAt: input.now,
      },
    });
  }

  async listFillEvents(runId: string): Promise<PersistedFillEvent[]> {
    const rows = await this.db.select({ outputJson: scriptBreakdownRunStages.outputJson })
      .from(scriptBreakdownRunStages)
      .where(and(
        eq(scriptBreakdownRunStages.runId, runId),
        eq(scriptBreakdownRunStages.stageKey, FILL_EVENTS_STAGE_KEY),
      ))
      .limit(1);
    return fillEventsFromDb(rows[0]?.outputJson);
  }

  async claimExecution(runId: string, now: Date): Promise<string | null> {
    const executionToken = crypto.randomUUID();
    try {
      const rows = await this.db.update(scriptBreakdownRuns)
        .set({ status: "running", executionToken, updatedAt: now })
        .where(and(
          eq(scriptBreakdownRuns.id, runId),
          inArray(scriptBreakdownRuns.status, ["queued", "failed"]),
        ))
        .returning({ executionToken: scriptBreakdownRuns.executionToken });
      return rows[0]?.executionToken ?? null;
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictError("这一集正在解析中，请稍候", "lite_run_in_flight");
      }
      throw error;
    }
  }

  async reclaimStaleRuns(input: { cutoff: Date; now: Date }): Promise<number> {
    return this.db.transaction(async (tx) => {
      const reclaimed = await tx.update(scriptBreakdownRuns).set({
        status: "failed",
        executionToken: null,
        errorCode: "worker_timeout",
        errorMessage: "拆解执行进程失联，已安全回收，请继续执行。",
        updatedAt: input.now,
      }).where(and(
        eq(scriptBreakdownRuns.status, "running"),
        lt(scriptBreakdownRuns.updatedAt, input.cutoff),
      )).returning({ id: scriptBreakdownRuns.id });
      if (reclaimed.length === 0) return 0;

      const runIds = reclaimed.map((row) => row.id);
      await tx.update(scriptBreakdownRunStages).set({
        status: "failed",
        errorCode: "worker_timeout",
        errorMessage: "拆解执行进程失联，已安全回收，请继续执行。",
        completedAt: input.now,
        updatedAt: input.now,
      }).where(and(
        inArray(scriptBreakdownRunStages.runId, runIds),
        eq(scriptBreakdownRunStages.status, "running"),
      ));
      await tx.update(aiCalls).set({
        status: "failed",
        errorCode: "worker_timeout",
        durationMs: boundedAiCallDuration(input.now),
        completedAt: input.now,
      }).where(and(
        eq(aiCalls.relatedObjectType, "script_breakdown_run"),
        inArray(aiCalls.relatedObjectId, runIds),
        eq(aiCalls.status, "running"),
      ));
      return reclaimed.length;
    });
  }

  async updateRunExecution(input: {
    runId: string;
    executionToken: string;
    currentStage: string | null;
    draft?: ScriptBreakdownDraft;
    usage?: RunUsage;
    modelName?: string;
    now: Date;
  }): Promise<void> {
    await this.db.update(scriptBreakdownRuns).set({
      currentStage: input.currentStage,
      ...(input.draft !== undefined ? { draftJson: input.draft as Record<string, unknown> } : {}),
      ...(input.usage !== undefined ? { usageJson: runUsageToDb(input.usage) } : {}),
      ...(input.modelName !== undefined ? { modelName: input.modelName } : {}),
      updatedAt: input.now,
    }).where(and(
      eq(scriptBreakdownRuns.id, input.runId),
      eq(scriptBreakdownRuns.status, "running"),
      eq(scriptBreakdownRuns.executionToken, input.executionToken),
    ));
  }

  async finalizeRunDraft(input: {
    runId: string;
    executionToken: string;
    validation: DraftValidation;
    usage: RunUsage;
    now: Date;
  }): Promise<void> {
    await this.db.update(scriptBreakdownRuns).set({
      status: "draft",
      executionToken: null,
      currentStage: null,
      validationJson: draftValidationToDb(input.validation),
      usageJson: runUsageToDb(input.usage),
      errorCode: null,
      errorMessage: null,
      updatedAt: input.now,
    }).where(and(
      eq(scriptBreakdownRuns.id, input.runId),
      eq(scriptBreakdownRuns.status, "running"),
      eq(scriptBreakdownRuns.executionToken, input.executionToken),
    ));
  }

  async finalizeRunFailed(input: {
    runId: string;
    executionToken: string;
    currentStage: string | null;
    errorCode: string;
    errorMessage: string;
    validation?: DraftValidation;
    usage?: RunUsage;
    now: Date;
  }): Promise<void> {
    await this.db.update(scriptBreakdownRuns).set({
      status: "failed",
      executionToken: null,
      currentStage: input.currentStage,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage.slice(0, 512),
      ...(input.validation !== undefined ? { validationJson: draftValidationToDb(input.validation) } : {}),
      ...(input.usage !== undefined ? { usageJson: runUsageToDb(input.usage) } : {}),
      updatedAt: input.now,
    }).where(and(
      eq(scriptBreakdownRuns.id, input.runId),
      eq(scriptBreakdownRuns.status, "running"),
      eq(scriptBreakdownRuns.executionToken, input.executionToken),
    ));
  }

  async resetStagesForResume(runId: string, now: Date): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const resumable = await tx.select({ id: scriptBreakdownRuns.id })
          .from(scriptBreakdownRuns)
          .where(and(
            eq(scriptBreakdownRuns.id, runId),
            inArray(scriptBreakdownRuns.status, ["queued", "failed"]),
            isNull(scriptBreakdownRuns.executionToken),
          ))
          .for("update")
          .limit(1);
        if (resumable.length === 0) return false;
        /* pending 形状必须过 shape CHECK(completed_at 只能属于 succeeded/failed),
           同时清掉上一轮的错误与时间戳。只碰 running/failed:切到 agent 路之后
           这里剩下的是上一版留下的阶段行,以及固定为终态的过程事件行——
           事件行不该被续跑抹掉。 */
        await tx.update(scriptBreakdownRunStages).set({
          status: "pending",
          errorCode: null,
          errorMessage: null,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        }).where(and(
          eq(scriptBreakdownRunStages.runId, runId),
          inArray(scriptBreakdownRunStages.status, ["running", "failed"]),
        ));
        // Queue inside the same transaction so a conflicting active run is
        // rejected before the HTTP resume endpoint schedules background work.
        await tx.update(scriptBreakdownRuns).set({
          status: "queued",
          executionToken: null,
          errorCode: null,
          errorMessage: null,
          updatedAt: now,
        }).where(eq(scriptBreakdownRuns.id, runId));
        return true;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictError("这一集正在解析中，请稍候", "lite_run_in_flight");
      }
      throw error;
    }
  }

  async listApprovedProjectAssets(projectId: string): Promise<ApprovedAssetSummary[]> {
    const rows = await this.db.select({
      assetEntityId: assetEntities.id,
      name: assetEntities.name,
      assetKind: assetEntities.assetKind,
    }).from(projectAssetRefs)
      .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
      .where(and(
        eq(projectAssetRefs.projectId, projectId),
        isNull(projectAssetRefs.deletedAt),
        isNull(assetEntities.deletedAt),
        eq(assetEntities.status, "approved"),
      ))
      .orderBy(assetEntities.name, assetEntities.id)
      .limit(200);
    return rows;
  }

  async listApprovedProjectAssetsByNames(
    projectId: string,
    names: string[],
  ): Promise<ApprovedAssetSummary[]> {
    const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (uniqueNames.length === 0) return [];
    return this.db.select({
      assetEntityId: assetEntities.id,
      name: assetEntities.name,
      assetKind: assetEntities.assetKind,
    }).from(projectAssetRefs)
      .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
      .where(and(
        eq(projectAssetRefs.projectId, projectId),
        isNull(projectAssetRefs.deletedAt),
        isNull(assetEntities.deletedAt),
        eq(assetEntities.status, "approved"),
        inArray(assetEntities.name, uniqueNames),
      ))
      .orderBy(assetEntities.name, assetEntities.id);
  }

  /**
   * P6 阶段②只读配置(§2 P6 C)。真源顺序与分镜详情「AI 生成」getProjectVideoTemplate、
   * 生成期 resolveProjectGenerationConfig 同口径,三链一致:
   * - 默认视频风格 = projects.video_style_description(默认风格镜像列);
   * - 生效视频模板 = 真源 1 projects.video_prompt_template(项目设置文本列)
   *   → 真源 2 generation_default_strategies(video).parameters.prompt_template_id
   *   → prompt_templates(用户) / prompt_default_templates(平台)兜底,再落代码常量。
   */
  async resolveStoryboardVideoConfig(projectId: string): Promise<StoryboardVideoConfig> {
    const project = (await this.db.select({
      videoStyleDescription: projects.videoStyleDescription,
      videoPromptTemplate: projects.videoPromptTemplate,
    }).from(projects).where(and(
      eq(projects.id, projectId),
      isNull(projects.deletedAt),
    )).limit(1))[0];
    const styleDescription = project?.videoStyleDescription?.trim() || null;
    // 真源 1:项目设置文本列,与分镜详情 AI 草稿 / 生成期编译同源。设置了就不再读策略。
    const directTemplate = project?.videoPromptTemplate?.trim() || null;

    const strategy = (await this.db.select({
      parameters: generationDefaultStrategies.parameters,
    }).from(generationDefaultStrategies).where(and(
      eq(generationDefaultStrategies.projectId, projectId),
      eq(generationDefaultStrategies.mediaKind, "video"),
    )).limit(1))[0];

    let promptTemplate: string | null = directTemplate;
    if (!promptTemplate) {
      const templateId = strategy?.parameters?.prompt_template_id;
      if (typeof templateId === "string" && templateId.length > 0) {
        const userTemplate = (await this.db.select({ content: promptTemplates.content })
          .from(promptTemplates).where(and(
            eq(promptTemplates.id, templateId),
            eq(promptTemplates.mediaKind, "video"),
            isNull(promptTemplates.deletedAt),
          )).limit(1))[0];
        if (userTemplate) {
          promptTemplate = userTemplate.content;
        } else {
          const platformTemplate = (await this.db.select({ content: promptDefaultTemplates.content })
            .from(promptDefaultTemplates).where(eq(promptDefaultTemplates.mediaKind, "video")).limit(1))[0];
          promptTemplate = platformTemplate?.content ?? null;
        }
      } else {
        const platformTemplate = (await this.db.select({ content: promptDefaultTemplates.content })
          .from(promptDefaultTemplates).where(eq(promptDefaultTemplates.mediaKind, "video")).limit(1))[0];
        promptTemplate = platformTemplate?.content ?? null;
      }
    }

    return {
      styleDescription,
      promptTemplate: promptTemplate ?? DEFAULT_VIDEO_PROMPT_TEMPLATE,
      // 每段 Shot 数（模板面板「分镜 Shot 数」）：generation_default_strategies
      // (video).parameters.shots_per_segment；1..MAX 生效，其余（缺省/越界/非法）= null=自由。
      shotsPerSegment: resolveShotsPerSegment(strategy?.parameters?.shots_per_segment),
    };
  }

  async confirmRun(input: {
    runId: string;
    actor: ProjectAccessActor;
    mapping: ConfirmMapping;
    now: Date;
  }): Promise<ConfirmResult> {
    return this.db.transaction(async (tx) => {
      // Every project-scoped writer takes the advisory lock before row locks.
      // Read only the immutable run→episode→project identity first; the locked
      // reads below remain the authority for status, deletion and access.
      const target = (await tx.select({
        projectId: episodes.projectId,
      }).from(scriptBreakdownRuns)
        .innerJoin(episodes, eq(episodes.id, scriptBreakdownRuns.episodeId))
        .where(eq(scriptBreakdownRuns.id, input.runId))
        .limit(1))[0];
      if (!target) throw new NotFoundError("拆解记录不存在");
      await lockProjectAssetNamespace(tx as unknown as Database, target.projectId);

      // 1. 锁运行,读当前状态。重复确认走幂等返回,不重复建行。
      await tx.execute(sql`SELECT id FROM ${scriptBreakdownRuns} WHERE id = ${input.runId} FOR UPDATE`);
      const runRows = await tx.select().from(scriptBreakdownRuns)
        .where(eq(scriptBreakdownRuns.id, input.runId)).limit(1);
      const run = runRows[0];
      if (!run) throw new NotFoundError("拆解记录不存在");
      if (run.status === "confirmed") {
        return {
          runId: run.id,
          outcome: "already_confirmed",
          sceneCount: await countSourcedRows(tx as unknown as Database, "scenes", run.id),
          shotCount: await countSourcedRows(tx as unknown as Database, "shots", run.id),
          supersededRunIds: [],
          unmatchedAssets: input.mapping.unmatchedAssets,
        };
      }
      if (run.status === "superseded") {
        throw new ConflictError("这次拆解已被更新的确认替换,不能再次确认", "run_superseded");
      }
      if (run.status === "discarded") {
        throw new ConflictError("这次拆解已放弃,不能确认", "run_discarded");
      }
      if (run.status !== "draft") {
        throw new ConflictError("拆解尚未完成,不能确认", "run_not_ready");
      }

      // 2. 锁集并复查:集被删除/归档后不能确认旧草稿。
      await tx.execute(sql`SELECT id FROM ${episodes} WHERE id = ${run.episodeId} FOR UPDATE`);
      const episodeRows = await tx.select().from(episodes).where(eq(episodes.id, run.episodeId)).limit(1);
      const episode = episodeRows[0];
      if (!episode || episode.deletedAt) {
        throw new ConflictError("剧集已删除,不能确认旧草稿", "episode_unavailable");
      }
      if (episode.status !== "active") {
        throw new ConflictError("剧集已归档,不能确认旧草稿", "episode_unavailable");
      }

      // 3. 预览到确认之间成员可能变更,事务内以项目成员关系为准复查权限。
      await ProjectAccessService.fromDatabase(new ProjectAccessRepository(tx as unknown as Database))
        .require(input.actor, episode.projectId, "create");

      // 4. 重跑口径(§3.4.7 + §3.3 弹窗):确认 = 覆盖重建。既有场/分镜(无论
      // 本链路来源还是人工建的)在步骤 6 统一软删(R1 可逆),不再 409 拦人——
      // 旧守卫把「重新生成本集」变成死循环:弹窗承诺覆盖,确认却被自己拦下。
      const existingScenes = await tx.select().from(scenes).where(and(
        eq(scenes.episodeId, episode.id),
        isNull(scenes.deletedAt),
      ));
      const existingShots = await tx.select().from(shots).where(and(
        eq(shots.episodeId, episode.id),
        isNull(shots.deletedAt),
      ));

      // 5. 人工确认同时把资产候选转为正式项目资产。项目级咨询锁保证
      // 不同集并发确认时，同类同名候选不会各自创建一份。
      await materializeAssetCandidates(
        tx as unknown as Database,
        episode.projectId,
        input.actor.id,
        run.id,
        input.mapping.assetCandidates,
        input.now,
      );
      const currentReferenceAssets = await listCurrentReferenceAssets(
        tx as unknown as Database,
        episode.projectId,
        input.mapping.shots,
      );
      const finalizedShots = input.mapping.shots.map((shot) => ({
        ...shot,
        referenceAssetSnapshots: buildCurrentAssetSnapshots(shot, currentReferenceAssets),
      }));
      const unmatchedAssets = collectCurrentUnmatchedAssets(finalizedShots, currentReferenceAssets);

      // 6. 软删上一次确认产生的正式行,并标记来源运行被替换。
      const supersededRunIds = [...new Set(
        [...existingScenes, ...existingShots]
          .map((row) => row.sourceBreakdownRunId)
          .filter((id): id is string => id !== null && id !== run.id),
      )];
      if (existingShots.length > 0) {
        await tx.update(shots).set({
          deletedAt: input.now,
          deletedByUserId: input.actor.id,
          updatedAt: input.now,
        }).where(and(eq(shots.episodeId, episode.id), isNull(shots.deletedAt)));
      }
      if (existingScenes.length > 0) {
        await tx.update(scenes).set({
          deletedAt: input.now,
          deletedByUserId: input.actor.id,
          updatedAt: input.now,
        }).where(and(eq(scenes.episodeId, episode.id), isNull(scenes.deletedAt)));
      }
      if (supersededRunIds.length > 0) {
        await tx.update(scriptBreakdownRuns).set({
          status: "superseded",
          supersededByRunId: run.id,
          updatedAt: input.now,
        }).where(and(
          inArray(scriptBreakdownRuns.id, supersededRunIds),
          eq(scriptBreakdownRuns.status, "confirmed"),
        ));
      }

      // 7. 写正式场,再按场候选 ID 解析写正式分镜。
      const sceneIdByCandidate = new Map<string, string>();
      for (const mapped of input.mapping.scenes) {
        const id = crypto.randomUUID();
        await tx.insert(scenes).values({
          id,
          episodeId: episode.id,
          sceneNo: mapped.sceneNo,
          name: mapped.name,
          description: mapped.description,
          sortOrder: mapped.sortOrder,
          sourceBreakdownRunId: run.id,
          sourceCandidateId: mapped.sourceCandidateId,
          createdAt: input.now,
          updatedAt: input.now,
          deletedAt: null,
          deletedByUserId: null,
        });
        sceneIdByCandidate.set(mapped.candidateId, id);
      }
      const sceneNameByCandidate = new Map(
        input.mapping.scenes.map((s) => [s.candidateId, s.name]),
      );
      const shotIdByCandidate = new Map<string, string>();
      for (const mapped of finalizedShots) {
        const sceneId = sceneIdByCandidate.get(mapped.sceneCandidateId);
        if (!sceneId) {
          throw new ConflictError("分镜归属没有对上，请重新拆解后再确认", "mapping_inconsistent");
        }
        const id = crypto.randomUUID();
        shotIdByCandidate.set(mapped.sourceCandidateId, id);
        await tx.insert(shots).values({
          id,
          episodeId: episode.id,
          sceneId,
          shotCode: mapped.shotCode,
          title: mapped.title,
          scriptText: mapped.scriptText,
          breakdownElements: mapped.breakdownElements && {
            subject: mapped.breakdownElements.subject,
            action: mapped.breakdownElements.action,
            visual: mapped.breakdownElements.visual,
            camera_language: mapped.breakdownElements.cameraLanguage,
          },
          directorPrompt: mapped.directorPrompt,
          imagePrompt: mapped.imagePrompt,
          videoPrompt: mapped.videoPrompt,
          storyboardDetail: mapped.storyboardDetail,
          durationSeconds: mapped.durationSeconds,
          sortOrder: mapped.sortOrder,
          referenceAssetSnapshots: mapped.referenceAssetSnapshots,
          sourceBreakdownRunId: run.id,
          sourceCandidateId: mapped.sourceCandidateId,
          selectedImageResultId: null,
          selectedVideoResultId: null,
          createdAt: input.now,
          updatedAt: input.now,
          deletedAt: null,
          deletedByUserId: null,
        });
      }

      // 8. v1.3:sh 正式行落库后,对拍本项目 pending 关联按 (episode_no, shot_no, scene_name)
      // 转 bound + 回填 manual 快照(素材确认先于分镜插入,此时才可能对上)。
      // 内联进确认事务:正式 scenes/shots/asset_entities 的写只允许发生在 confirmRun 事务内
      // (见 boundary.test.ts 静态层合同);不跨模块 import(lite 的 usage 模型此处只读约定字段)。
      const reconcilePendingAssetUsages = async (
        reconcileShots: Array<{ shotId: string; shotNo: number; sceneName: string | null }>,
      ): Promise<void> => {
        if (reconcileShots.length === 0) return;
        const shotByNo = new Map<number, Array<{ shotId: string; sceneName: string | null }>>();
        for (const shot of reconcileShots) {
          const list = shotByNo.get(shot.shotNo) ?? [];
          list.push({ shotId: shot.shotId, sceneName: shot.sceneName });
          shotByNo.set(shot.shotNo, list);
        }

        const assetRows = await tx.select({
          id: assetEntities.id,
          name: assetEntities.name,
          assetKind: assetEntities.assetKind,
          metadata: assetEntities.metadata,
        })
          .from(projectAssetRefs)
          .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
          .where(and(
            eq(projectAssetRefs.projectId, episode.projectId),
            isNull(projectAssetRefs.deletedAt),
            isNull(assetEntities.deletedAt),
          ));

        const snapshotWrites: Array<{ shotId: string; snapshot: Record<string, unknown> }> = [];
        for (const assetRow of assetRows) {
          const metadata = assetRow.metadata as Record<string, unknown>;
          const lite = (metadata.lite as Record<string, unknown> | undefined) ?? {};
          const usages = Array.isArray(lite.usages) ? lite.usages as Array<Record<string, unknown>> : [];
          let changed = false;
          for (const usage of usages) {
            if (usage.status !== "pending") continue;
            if (usage.episode_no !== episode.episodeNo) continue;
            if (typeof usage.shot_no !== "number") continue;
            const candidates = shotByNo.get(usage.shot_no);
            if (!candidates || candidates.length === 0) continue;
            const sceneNames = Array.isArray(usage.scene_names) ? usage.scene_names as string[] : [];
            let chosen = candidates[0]!;
            if (sceneNames.length > 0) {
              const byScene = candidates.find(
                (candidate) => candidate.sceneName !== null
                  && sceneNames.some((name) => candidate.sceneName!.includes(name)),
              );
              if (byScene) chosen = byScene;
            }
            usage.status = "bound";
            usage.shot_id = chosen.shotId;
            usage.episode_id = episode.id;
            changed = true;
            snapshotWrites.push({
              shotId: chosen.shotId,
              snapshot: {
                asset_entity_id: assetRow.id,
                variant_id: usage.variant_id ?? null,
                name: assetRow.name,
                asset_kind: assetRow.assetKind,
                matched_by: "manual",
              },
            });
          }
          if (changed) {
            lite.usages = usages;
            metadata.lite = lite;
            await tx.update(assetEntities).set({ metadata, updatedAt: input.now })
              .where(eq(assetEntities.id, assetRow.id));
          }
        }

        if (snapshotWrites.length === 0) return;
        // 合并写 shots.reference_asset_snapshots:同 (asset_entity_id, variant_id) 覆盖,其余追加。
        const shotIds = [...new Set(snapshotWrites.map((w) => w.shotId))];
        const snapshotRows = await tx.select({
          id: shots.id,
          referenceAssetSnapshots: shots.referenceAssetSnapshots,
        })
          .from(shots)
          .where(inArray(shots.id, shotIds));
        const existingByShot = new Map(snapshotRows.map((row) => [row.id, row.referenceAssetSnapshots]));
        const writesByShot = new Map<string, Array<Record<string, unknown>>>();
        for (const write of snapshotWrites) {
          const list = writesByShot.get(write.shotId) ?? [];
          list.push(write.snapshot);
          writesByShot.set(write.shotId, list);
        }
        for (const [shotId, snapshots] of writesByShot) {
          const existing = [...(existingByShot.get(shotId) ?? [])];
          for (const snapshot of snapshots) {
            const idx = existing.findIndex((entry) =>
              entry.asset_entity_id === snapshot.asset_entity_id
              && (entry.variant_id ?? null) === (snapshot.variant_id ?? null),
            );
            if (idx >= 0) existing[idx] = snapshot;
            else existing.push(snapshot);
          }
          await tx.update(shots).set({ referenceAssetSnapshots: existing, updatedAt: input.now })
            .where(eq(shots.id, shotId));
        }
      };
      await reconcilePendingAssetUsages(finalizedShots.map((mapped) => ({
        shotId: shotIdByCandidate.get(mapped.sourceCandidateId)!,
        shotNo: mapped.sortOrder ?? 0,
        sceneName: mapped.sceneCandidateId ? (sceneNameByCandidate.get(mapped.sceneCandidateId) ?? null) : null,
      })));

      // 9. 运行落 confirmed:同一运行只能确认一次。
      await tx.update(scriptBreakdownRuns).set({
        status: "confirmed",
        confirmedByUserId: input.actor.id,
        confirmedAt: input.now,
        updatedAt: input.now,
      }).where(eq(scriptBreakdownRuns.id, run.id));

      return {
        runId: run.id,
        outcome: "confirmed",
        sceneCount: input.mapping.scenes.length,
        shotCount: input.mapping.shots.length,
        supersededRunIds,
        unmatchedAssets,
      };
    });
  }

  async discardRun(input: { runId: string; actorId: string; now: Date }): Promise<"discarded" | "not_discardable" | "not_found"> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.select({ status: scriptBreakdownRuns.status })
        .from(scriptBreakdownRuns)
        .where(eq(scriptBreakdownRuns.id, input.runId))
        .for("update")
        .limit(1);
      const status = existing[0]?.status;
      if (!status) return "not_found";
      if (!["queued", "running", "failed", "draft"].includes(status)) return "not_discardable";

      await tx.update(scriptBreakdownRuns).set({
        status: "discarded",
        executionToken: null,
        discardedByUserId: input.actorId,
        discardedAt: input.now,
        updatedAt: input.now,
      }).where(eq(scriptBreakdownRuns.id, input.runId));
      await tx.update(scriptBreakdownRunStages).set({
        status: "failed",
        errorCode: "run_discarded",
        errorMessage: "拆解已被用户放弃。",
        completedAt: input.now,
        updatedAt: input.now,
      }).where(and(
        eq(scriptBreakdownRunStages.runId, input.runId),
        eq(scriptBreakdownRunStages.status, "running"),
      ));
      await tx.update(aiCalls).set({
        status: "failed",
        errorCode: "run_discarded",
        durationMs: boundedAiCallDuration(input.now),
        completedAt: input.now,
      }).where(and(
        eq(aiCalls.relatedObjectType, "script_breakdown_run"),
        eq(aiCalls.relatedObjectId, input.runId),
        eq(aiCalls.status, "running"),
      ));
      return "discarded";
    });
  }
}

async function materializeAssetCandidates(
  db: Database,
  projectId: string,
  actorId: string,
  runId: string,
  candidates: AssetCandidates,
  now: Date,
): Promise<void> {
  await lockProjectAssetNamespace(db, projectId);
  const groups = [
    ["character", candidates.characters],
    ["scene", candidates.scenes],
    ["prop", candidates.props],
    ["costume", candidates.costumes],
    ["audio", candidates.audios],
  ] as const;
  for (const [assetKind, items] of groups) {
    for (const candidate of items) {
      const name = candidate.name.trim();
      const existing = await db.select({ entity: assetEntities })
        .from(projectAssetRefs)
        .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
        .where(and(
          eq(projectAssetRefs.projectId, projectId),
          isNull(projectAssetRefs.deletedAt),
          isNull(assetEntities.deletedAt),
          eq(assetEntities.assetKind, assetKind),
          eq(assetEntities.name, name),
        ))
        .orderBy(assetEntities.id)
        .for("update");
      if (existing.length > 1) {
        throw new ConflictError(
          `项目资产库里有多条同名${assetKindLabel(assetKind)}“${name}”，请先合并后再确认剧本`,
          "script_asset_name_ambiguous",
          { asset_kind: assetKind, name },
        );
      }

      const existingEntity = existing[0]?.entity;
      if (existingEntity) {
        if (existingEntity.status !== "approved") {
          throw new ConflictError(
            `项目资产“${name}”尚未可用，请先完成审核后再确认剧本`,
            "script_asset_not_approved",
            { asset_kind: assetKind, name, status: existingEntity.status },
          );
        }
        continue;
      }

      const character = assetKind === "character"
        ? candidate as CharacterAssetCandidate
        : null;
      const entity = (await db.insert(assetEntities).values({
        id: crypto.randomUUID(),
        copiedFromAssetEntityId: null,
        sourceProjectId: null,
        sourceProjectName: null,
        ownerUserId: actorId,
        visibility: "personal",
        assetKind,
        role: assetKind === "character" ? "character_identity" : assetKind,
        usageMode: "reference",
        name,
        displayName: name,
        intro: candidate.description,
        appearance: character?.appearance ?? candidate.description,
        ageValue: character?.ageValue ?? null,
        gender: character?.gender ?? null,
        heightCm: null,
        hairDescription: null,
        outfitDescription: null,
        category: assetKind,
        styleTags: character?.personalityTags ?? [],
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        sourceFileUrl: null,
        metadata: {
          source: "script_breakdown",
          source_breakdown_run_id: runId,
          source_candidate_id: candidate.candidateId,
          ...(character?.ageStage ? { age_stage: character.ageStage } : {}),
        },
        createdAt: now,
        updatedAt: now,
        useCount: 1,
        deletedAt: null,
        deletedByUserId: null,
      }).returning())[0];
      if (!entity) throw new Error("Failed to create script asset");

      await db.insert(projectAssetRefs).values({
        id: crypto.randomUUID(),
        projectId,
        assetEntityId: entity.id,
        assetVariantId: null,
        assetMediaId: null,
        versionSnapshot: buildVersionSnapshot(now, entity, null, null),
        createdByUserId: actorId,
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      });
    }
  }
}

async function listCurrentReferenceAssets(
  db: Database,
  projectId: string,
  shotsToConfirm: ConfirmMapping["shots"],
): Promise<ApprovedAssetSummary[]> {
  const names = [...new Set(shotsToConfirm.flatMap((shot) => [
    ...shot.referenceAssetNames.characters,
    ...shot.referenceAssetNames.scenes,
    ...shot.referenceAssetNames.props,
    ...shot.referenceAssetNames.costumes,
  ]))];
  if (names.length === 0) return [];
  const rows = await db.select({
    assetEntityId: assetEntities.id,
    name: assetEntities.name,
    assetKind: assetEntities.assetKind,
  }).from(projectAssetRefs)
    .innerJoin(assetEntities, eq(projectAssetRefs.assetEntityId, assetEntities.id))
    .where(and(
      eq(projectAssetRefs.projectId, projectId),
      isNull(projectAssetRefs.deletedAt),
      isNull(assetEntities.deletedAt),
      eq(assetEntities.status, "approved"),
      inArray(assetEntities.name, names),
    ))
    .orderBy(assetEntities.assetKind, assetEntities.name, assetEntities.id)
    .for("update");

  const seen = new Map<string, string>();
  for (const asset of rows) {
    const key = `${asset.assetKind}:${asset.name}`;
    const previous = seen.get(key);
    if (previous && previous !== asset.assetEntityId) {
      throw new ConflictError(
        `项目资产库里有多条同类同名资产“${asset.name}”，请先合并后再确认剧本`,
        "script_asset_name_ambiguous",
        { asset_kind: asset.assetKind, name: asset.name },
      );
    }
    seen.set(key, asset.assetEntityId);
  }
  return rows;
}

function buildCurrentAssetSnapshots(
  shot: ConfirmMapping["shots"][number],
  currentAssets: ApprovedAssetSummary[],
): Array<Record<string, unknown>> {
  const byKindAndName = new Map(
    currentAssets.map((asset) => [`${asset.assetKind}:${asset.name}`, asset]),
  );
  const snapshots: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const references = [
    ["character", shot.referenceAssetNames.characters],
    ["scene", shot.referenceAssetNames.scenes],
    ["prop", shot.referenceAssetNames.props],
    ["costume", shot.referenceAssetNames.costumes],
  ] as const;
  for (const [kind, names] of references) {
    for (const name of names) {
      const asset = byKindAndName.get(`${kind}:${name}`);
      if (!asset || seen.has(asset.assetEntityId)) continue;
      seen.add(asset.assetEntityId);
      snapshots.push({
        asset_entity_id: asset.assetEntityId,
        name: asset.name,
        asset_kind: asset.assetKind,
        matched_by: "exact_name",
      });
    }
  }
  return snapshots;
}

function collectCurrentUnmatchedAssets(
  shotsToConfirm: ConfirmMapping["shots"],
  currentAssets: ApprovedAssetSummary[],
): UnmatchedAsset[] {
  const known = new Set(currentAssets.map((asset) => `${asset.assetKind}:${asset.name}`));
  const unmatched = new Map<string, UnmatchedAsset>();
  const record = (kind: "character" | "scene" | "prop" | "costume", name: string, candidateId: string) => {
    const key = `${kind}:${name}`;
    if (known.has(key)) return;
    const item = unmatched.get(key) ?? { kind, name, shotCandidateIds: [] };
    if (!item.shotCandidateIds.includes(candidateId)) item.shotCandidateIds.push(candidateId);
    unmatched.set(key, item);
  };
  for (const shot of shotsToConfirm) {
    for (const name of shot.referenceAssetNames.characters) record("character", name, shot.candidateId);
    for (const name of shot.referenceAssetNames.scenes) record("scene", name, shot.candidateId);
    for (const name of shot.referenceAssetNames.props) record("prop", name, shot.candidateId);
    for (const name of shot.referenceAssetNames.costumes) record("costume", name, shot.candidateId);
  }
  return [...unmatched.values()];
}

function assetKindLabel(kind: "character" | "scene" | "prop" | "costume" | "audio"): string {
  if (kind === "character") return "角色";
  if (kind === "scene") return "场景";
  if (kind === "costume") return "服装";
  if (kind === "audio") return "音频";
  return "道具";
}

async function findVersionByIdempotencyKey(
  tx: Database,
  userId: string,
  key: string,
): Promise<ScriptVersionRecord | null> {
  const rows = await tx.select().from(episodeScriptVersions).where(and(
    eq(episodeScriptVersions.createdByUserId, userId),
    eq(episodeScriptVersions.clientIdempotencyKey, key),
  )).limit(1);
  return rows[0] ? toVersionRecord(rows[0]) : null;
}

async function countSourcedRows(tx: Database, table: "scenes" | "shots", runId: string): Promise<number> {
  const target = table === "scenes" ? scenes : shots;
  const rows = await tx.select({ id: target.id }).from(target).where(and(
    eq(target.sourceBreakdownRunId, runId),
    isNull(target.deletedAt),
  ));
  return rows.length;
}

function toVersionRecord(row: EpisodeScriptVersionRow): ScriptVersionRecord {
  return {
    id: row.id,
    episodeId: row.episodeId,
    versionNo: row.versionNo,
    title: row.title,
    scriptText: row.scriptText,
    scriptSha256: row.scriptSha256,
    source: row.source,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

function toRunRecord(row: ScriptBreakdownRunRow): ScriptBreakdownRunRecord {
  return {
    id: row.id,
    episodeId: row.episodeId,
    scriptVersionId: row.scriptVersionId,
    createdByUserId: row.createdByUserId,
    modelName: row.modelName,
    promptVersion: row.promptVersion,
    status: row.status as ScriptBreakdownRunStatus,
    currentStage: row.currentStage,
    targetDurationSec: row.targetDurationSec,
    inputSha256: row.inputSha256,
    draft: draftFromUnknown(row.draftJson),
    validation: draftValidationFromDb(row.validationJson),
    usage: runUsageFromDb(row.usageJson),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    confirmedByUserId: row.confirmedByUserId,
    confirmedAt: row.confirmedAt,
    discardedByUserId: row.discardedByUserId,
    discardedAt: row.discardedAt,
    supersededByRunId: row.supersededByRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 落库形态的白名单在 PersistedFillEvent 那里定,这里只做序列化。
 * 逐字段列出而不是整体展开:出口对面是数据库和导演端,新字段默认出不去。
 */
function fillEventToDb(event: PersistedFillEvent): Record<string, unknown> {
  return {
    sequence: event.sequence,
    tool: event.tool,
    status: event.status,
    description: event.description,
    reason: event.reason,
    occurred_at: event.occurredAt.toISOString(),
  };
}

function fillEventsFromDb(value: unknown): PersistedFillEvent[] {
  const rows = (value as { events?: unknown } | null)?.events;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const item = row as Record<string, unknown>;
    return {
      sequence: Number(item.sequence ?? 0),
      tool: typeof item.tool === "string" ? item.tool : null,
      status: item.status as PersistedFillEvent["status"],
      description: String(item.description ?? ""),
      reason: typeof item.reason === "string" ? item.reason : null,
      occurredAt: new Date(String(item.occurred_at ?? 0)),
    };
  });
}

function toStageRecord(row: ScriptBreakdownRunStageRow): ScriptBreakdownStageRecord {
  return {
    id: row.id,
    runId: row.runId,
    stageKey: row.stageKey,
    stageOrder: row.stageOrder,
    status: row.status as ScriptBreakdownStageRecord["status"],
    attemptCount: row.attemptCount,
    output: row.outputJson ?? null,
    validation: stageValidationFromDb(row.validationJson),
    usage: stageUsageFromDb(row.usageJson),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function emptyDraftValidationDb(): Record<string, unknown> {
  return {
    status: "pass",
    issues: [],
    unmatched_assets: [],
    duplicate_coverage: [],
    shot_count: 0,
    total_duration_sec: 0,
  };
}

function boundedAiCallDuration(now: Date) {
  return sql<number>`LEAST(
    2147483647,
    GREATEST(
      0,
      EXTRACT(EPOCH FROM (${now} - ${aiCalls.createdAt})) * 1000
    )
  )::integer`;
}

function runUsageToDb(usage: RunUsage): Record<string, unknown> {
  return {
    call_count: usage.callCount,
    total_input_tokens: usage.totalInputTokens,
    total_output_tokens: usage.totalOutputTokens,
  };
}

function runUsageFromDb(value: Record<string, unknown>): RunUsage {
  return {
    callCount: numberOr(value["call_count"], 0),
    totalInputTokens: numberOr(value["total_input_tokens"], 0),
    totalOutputTokens: numberOr(value["total_output_tokens"], 0),
  };
}

function stageUsageFromDb(value: Record<string, unknown>): StageUsage {
  const calls = Array.isArray(value["calls"]) ? value["calls"] : [];
  return {
    calls: calls.map((call) => ({
      kind: call?.kind === "repair" ? "repair" : "main",
      model: typeof call?.model === "string" ? call.model : "unknown",
      inputTokens: typeof call?.input_tokens === "number" ? call.input_tokens : null,
      outputTokens: typeof call?.output_tokens === "number" ? call.output_tokens : null,
      durationMs: typeof call?.duration_ms === "number" ? call.duration_ms : 0,
    })),
  };
}

function stageValidationFromDb(value: Record<string, unknown>): StageValidation {
  return { issues: issuesFromDb(value["issues"]) };
}

function draftValidationToDb(validation: DraftValidation): Record<string, unknown> {
  return {
    status: validation.status,
    issues: validation.issues.map(issueToDb),
    unmatched_assets: validation.unmatchedAssets.map((item) => ({
      kind: item.kind,
      name: item.name,
      shot_candidate_ids: item.shotCandidateIds,
    })),
    duplicate_coverage: validation.duplicateCoverage.map((item) => ({
      line_index: item.lineIndex,
      shot_candidate_ids: item.shotCandidateIds,
    })),
    shot_count: validation.shotCount,
    total_duration_sec: validation.totalDurationSec,
  };
}

function draftValidationFromDb(value: Record<string, unknown>): DraftValidation {
  const status = value["status"];
  const unmatched = Array.isArray(value["unmatched_assets"]) ? value["unmatched_assets"] : [];
  const duplicates = Array.isArray(value["duplicate_coverage"]) ? value["duplicate_coverage"] : [];
  return {
    status: status === "pass_with_warnings" || status === "failed" ? status : "pass",
    issues: issuesFromDb(value["issues"]),
    unmatchedAssets: unmatched.map((item): UnmatchedAsset => ({
      kind: item?.kind === "scene" || item?.kind === "prop" ? item.kind : "character",
      name: typeof item?.name === "string" ? item.name : "",
      shotCandidateIds: Array.isArray(item?.shot_candidate_ids) ? item.shot_candidate_ids.filter((id: unknown): id is string => typeof id === "string") : [],
    })),
    duplicateCoverage: duplicates.map((item): DuplicateCoverage => ({
      lineIndex: numberOr(item?.line_index, 0),
      shotCandidateIds: Array.isArray(item?.shot_candidate_ids) ? item.shot_candidate_ids.filter((id: unknown): id is string => typeof id === "string") : [],
    })),
    shotCount: numberOr(value["shot_count"], 0),
    totalDurationSec: numberOr(value["total_duration_sec"], 0),
  };
}

function issueToDb(issue: ValidationIssue): Record<string, unknown> {
  return { code: issue.code, message: issue.message, path: issue.path ?? null };
}

function issuesFromDb(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    code: typeof item?.code === "string" ? item.code : "unknown",
    message: typeof item?.message === "string" ? item.message : "",
    path: typeof item?.path === "string" ? item.path : undefined,
  }));
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** shots_per_segment 夹紧：合法正整数 ≤ MAX 才生效，其余一律 null（自由，Skill 规则 1）。 */
function resolveShotsPerSegment(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= STORYBOARD_SHOTS_PER_SEGMENT_MAX
    ? raw
    : null;
}
