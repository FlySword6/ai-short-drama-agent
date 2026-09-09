import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { parseRequest, success } from "../../http/response.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { createAiGatewayService } from "../ai/service.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import { DrizzleScriptBreakdownRepository } from "./repository.js";
import { ScriptBreakdownRecoveryWorker } from "./recovery.js";
import { ScriptBreakdownService, type ScriptBreakdownServiceConfig } from "./service.js";
import type {
  ConfirmResult,
  PersistedFillEvent,
  ScriptBreakdownRunRecord,
  ScriptBreakdownStageRecord,
  ScriptVersionRecord,
  ValidationIssue,
} from "./types.js";

const episodeParamsSchema = z.object({
  episode_id: z.string().uuid(),
});

const runParamsSchema = z.object({
  run_id: z.string().uuid(),
});

/**
 * 轮询增量:一次拆解会产生几十条过程事件,每次轮询全量重发是白费带宽。
 * 客户端报上次收到的最后一个序号,只取后面的。
 */
const runQuerySchema = z.object({
  since_sequence: z.coerce.number().int().min(0).optional(),
});

const createScriptVersionBodySchema = z.object({
  title: z.string().trim().min(1).max(255).nullish(),
  script_text: z.string().min(1).max(60_000),
  client_idempotency_key: z.string().trim().min(8).max(255),
}).strict();

const createRunBodySchema = z.object({
  script_version_id: z.string().uuid(),
  target_duration_sec: z.number().int().min(1).max(7_200).nullish(),
  client_idempotency_key: z.string().trim().min(8).max(255),
}).strict();

export interface ScriptBreakdownRouteDependencies {
  createService?: (db: Database) => ScriptBreakdownService;
  /** 测试用:创建/续跑后在请求内同步执行完拆解计划。 */
  executeRunsInline?: boolean;
}

export async function registerScriptBreakdownRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ScriptBreakdownRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase()) ?? createScriptBreakdownService(getDatabase());
  const recoveryWorker = dependencies.executeRunsInline
    ? null
    : new ScriptBreakdownRecoveryWorker(getDatabase, app.log);
  recoveryWorker?.start();
  if (recoveryWorker) {
    app.addHook("onClose", async () => recoveryWorker.stop());
  }
  const schedule = (runId: string, actorId: string) => {
    if (dependencies.executeRunsInline) return;
    setImmediate(() => {
      void service().executeRun(runId, actorId).catch((error: unknown) => {
        app.log.error(error, "script breakdown execution failed");
      });
    });
  };

  app.post("/api/v1/episodes/:episode_id/script-versions", {
    config: { agentAccess: "candidate" },
  }, async (request) => {
    const actor = requireCurrentUser(request);
    const { episode_id: episodeId } = parseRequest(episodeParamsSchema, request.params);
    const body = parseRequest(createScriptVersionBodySchema, request.body);
    const result = await service().createScriptVersion(actor, episodeId, {
      title: body.title ?? null,
      scriptText: body.script_text,
      clientIdempotencyKey: body.client_idempotency_key,
    });
    return success({
      version: toScriptVersionResponse(result.version),
      outcome: result.outcome,
    });
  });

  app.get("/api/v1/episodes/:episode_id/script-versions", async (request) => {
    const actor = requireCurrentUser(request);
    const { episode_id: episodeId } = parseRequest(episodeParamsSchema, request.params);
    const versions = await service().listScriptVersions(actor, episodeId);
    return success({ items: versions.map(toScriptVersionResponse), count: versions.length });
  });

  app.post("/api/v1/episodes/:episode_id/script-breakdowns", {
    config: { agentAccess: "candidate" },
  }, async (request) => {
    const actor = requireCurrentUser(request);
    const { episode_id: episodeId } = parseRequest(episodeParamsSchema, request.params);
    const body = parseRequest(createRunBodySchema, request.body);
    const result = await service().createRun(actor, episodeId, {
      scriptVersionId: body.script_version_id,
      targetDurationSec: body.target_duration_sec ?? null,
      clientIdempotencyKey: body.client_idempotency_key,
    });
    if (result.outcome === "created") {
      if (dependencies.executeRunsInline) {
        await service().executeRun(result.run.id, actor.id);
      } else {
        schedule(result.run.id, actor.id);
      }
    }
    const detail = await service().getRun(actor, result.run.id);
    return success({
      run: toRunResponse(detail.run),
      stages: detail.stages.map(toStageResponse),
      events: detail.events.map(toEventResponse),
      outcome: result.outcome,
    });
  });

  app.get("/api/v1/episodes/:episode_id/script-breakdowns", async (request) => {
    const actor = requireCurrentUser(request);
    const { episode_id: episodeId } = parseRequest(episodeParamsSchema, request.params);
    const runs = await service().listRuns(actor, episodeId);
    return success({ items: runs.map(toRunResponse), count: runs.length });
  });

  app.get("/api/v1/script-breakdowns/:run_id", async (request) => {
    const actor = requireCurrentUser(request);
    const { run_id: runId } = parseRequest(runParamsSchema, request.params);
    const { since_sequence: sinceSequence } = parseRequest(runQuerySchema, request.query);
    const detail = await service().getRun(actor, runId);
    return success({
      run: toRunResponse(detail.run),
      stages: detail.stages.map(toStageResponse),
      events: detail.events
        .filter((event) => event.sequence > (sinceSequence ?? 0))
        .map(toEventResponse),
    });
  });

  app.post("/api/v1/script-breakdowns/:run_id/resume", {
    config: { agentAccess: "candidate" },
  }, async (request) => {
    const actor = requireCurrentUser(request);
    const { run_id: runId } = parseRequest(runParamsSchema, request.params);
    const run = await service().resumeRun(actor, runId);
    if (dependencies.executeRunsInline) {
      await service().executeRun(run.id, actor.id);
    } else {
      schedule(run.id, actor.id);
    }
    const detail = await service().getRun(actor, run.id);
    return success({
      run: toRunResponse(detail.run),
      stages: detail.stages.map(toStageResponse),
      events: detail.events.map(toEventResponse),
    });
  });

  app.post("/api/v1/script-breakdowns/:run_id/confirm", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const actor = requireCurrentUser(request);
    const { run_id: runId } = parseRequest(runParamsSchema, request.params);
    const result = await service().confirmRun(actor, runId);
    return success(toConfirmResponse(result));
  });

  app.post("/api/v1/script-breakdowns/:run_id/discard", async (request) => {
    const actor = requireCurrentUser(request);
    const { run_id: runId } = parseRequest(runParamsSchema, request.params);
    const run = await service().discardRun(actor, runId);
    return success({ run: toRunResponse(run) });
  });
}

export function createScriptBreakdownService(
  db: Database,
  config: ScriptBreakdownServiceConfig = {},
): ScriptBreakdownService {
  return new ScriptBreakdownService(
    new DrizzleScriptBreakdownRepository(db),
    createAiGatewayService(db),
    ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
    config,
  );
}

function toScriptVersionResponse(version: ScriptVersionRecord) {
  return {
    id: version.id,
    episodeId: version.episodeId,
    versionNo: version.versionNo,
    title: version.title,
    scriptText: version.scriptText,
    scriptSha256: version.scriptSha256,
    source: version.source,
    createdByUserId: version.createdByUserId,
    createdAt: version.createdAt,
  };
}

function toRunResponse(run: ScriptBreakdownRunRecord) {
  return {
    id: run.id,
    episodeId: run.episodeId,
    scriptVersionId: run.scriptVersionId,
    status: run.status,
    currentStage: run.currentStage,
    promptVersion: run.promptVersion,
    targetDurationSec: run.targetDurationSec,
    inputSha256: run.inputSha256,
    draft: run.draft,
    validation: {
      ...run.validation,
      issues: run.validation.issues.map(publicValidationIssue),
    },
    usage: run.usage,
    errorCode: run.errorCode,
    displayReason: runDisplayReason(run),
    confirmedByUserId: run.confirmedByUserId,
    confirmedAt: run.confirmedAt,
    discardedByUserId: run.discardedByUserId,
    discardedAt: run.discardedAt,
    supersededByRunId: run.supersededByRunId,
    createdByUserId: run.createdByUserId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toStageResponse(stage: ScriptBreakdownStageRecord) {
  return {
    stageKey: stage.stageKey,
    stageOrder: stage.stageOrder,
    status: stage.status,
    attemptCount: stage.attemptCount,
    validation: {
      issues: stage.validation.issues
        .filter((issue) => issue.code !== "response_shape")
        .map(publicValidationIssue),
    },
    usage: stage.usage,
    errorCode: stage.errorCode,
    displayReason: stageDisplayReason(stage),
    startedAt: stage.startedAt,
    completedAt: stage.completedAt,
  };
}

/**
 * 事件外发形态。字段与 PersistedFillEvent 一一对应,不在这里补任何东西——
 * 白名单只有一处定义,加字段要先过那里。
 */
function toEventResponse(event: PersistedFillEvent) {
  return {
    sequence: event.sequence,
    tool: event.tool,
    status: event.status,
    description: event.description,
    reason: event.reason,
    occurredAt: event.occurredAt,
  };
}

function runDisplayReason(run: ScriptBreakdownRunRecord): string | null {
  if (run.status === "failed") {
    if (run.errorCode === "prompt_version_outdated") {
      return "剧本拆解没成：整理规则已经更新，请重新开始一次拆解。";
    }
    if (run.errorCode === "ai_daily_limit_exceeded") {
      return "剧本拆解没成：今天的 AI 辅助次数已用完，请明天再试或联系管理员。";
    }
    if (
      run.errorCode === "ai_gateway_disabled"
      || run.errorCode === "ai_gateway_not_configured"
      || run.errorCode === "ai_tool_calling_unavailable"
    ) {
      return "剧本拆解没成：AI 辅助暂时没有准备好，请联系管理员处理。";
    }
    if (run.errorCode === "breakdown_budget_exhausted") {
      return "剧本拆解没成：这一集太长，一次没拆完，已经拆好的都留着，点继续可以接着拆。";
    }
    if (run.errorCode === "breakdown_incomplete") {
      return "剧本拆解没成：这次没能整理完整，已经拆好的都留着，点继续可以接着拆。";
    }
    if (run.errorCode === "ai_service_unavailable" || run.errorCode === "provider_error") {
      return "剧本拆解没成：AI 辅助暂时没有完成处理，请稍后重试。";
    }
    if (run.errorCode === "episode_unavailable") {
      return "剧本拆解没成：这集或剧本版本已经不可用，请重新选择剧本。";
    }
    if (run.errorCode === "contract_validation_failed") {
      return "剧本拆解没成：这次的结果没通过完整性检查，请重新拆解一次。";
    }
    // 兜底不再让人「打开失败步骤」——阶段机退场之后界面上没有那个东西了。
    return "剧本拆解没成：这次出了点问题，已经拆好的都留着，点继续可以接着拆。";
  }
  if (run.status === "running" || run.status === "queued") return "剧本正在拆解，请稍等一会儿。";
  if (run.status === "discarded") return "这次拆解已放弃。";
  if (run.status === "superseded") return "这次拆解已被更新的结果替换。";
  return null;
}

function stageDisplayReason(stage: ScriptBreakdownStageRecord): string | null {
  if (stage.status === "failed") {
    const issue = stage.validation.issues.find((item) => item.code !== "response_shape");
    if (issue) return publicValidationIssue(issue).message;
    return "剧本拆解没成：这一段没有整理完整，请重新拆解。";
  }
  if (stage.status === "running") return "这一段正在整理。";
  return null;
}

function publicValidationIssue(issue: ValidationIssue): ValidationIssue {
  const sceneGap = /scene_divisions\.(\d+)\./.exec(issue.path ?? "");
  if (sceneGap) {
    const currentPosition = Number(sceneGap[1]);
    if (currentPosition > 0 && issue.code === "lines_not_covered") {
      return {
        code: issue.code,
        message: `剧本拆解没成：第 ${currentPosition} 场和第 ${currentPosition + 1} 场之间好像缺了场号，检查一下粘贴的剧本格式。`,
      };
    }
    if (currentPosition > 0 && issue.code === "scene_range_overlap") {
      return {
        code: issue.code,
        message: `剧本拆解没成：第 ${currentPosition} 场和第 ${currentPosition + 1} 场的正文范围重复了，请检查场次分隔。`,
      };
    }
  }
  const messageByCode: Record<string, string> = {
    invalid_json: "剧本拆解没成：整理结果不完整，请重新拆解。",
    invalid_type: "剧本拆解没成：有一项内容格式不对，请检查剧本后重试。",
    unrecognized_keys: "剧本拆解没成：整理结果里出现了不支持的内容，请重新拆解。",
    scene_index_not_continuous: "剧本拆解没成：场号顺序没有接上，检查一下粘贴的剧本格式。",
    scene_range_inverted: "剧本拆解没成：有一场的起止位置颠倒了，检查一下粘贴的剧本格式。",
    scene_range_out_of_bounds: "剧本拆解没成：有一场超出了剧本正文，检查一下粘贴的剧本格式。",
    scene_range_overlap: "剧本拆解没成：有两个场次重复包含了同一段正文，请检查场次分隔。",
    lines_not_covered: "剧本拆解没成：有一段正文没有归到任何场，检查一下粘贴的剧本格式。",
    candidate_id_duplicate: "剧本拆解没成：有两个候选内容重复了，请重新拆解。",
    asset_name_duplicate: "角色和场景没整理完整：有同名候选重复出现，请检查后重试。",
    shot_no_not_continuous: "分镜没整理完整：镜号顺序没有接上，请重新拆解。",
    line_index_out_of_scene: "分镜没整理完整：有镜头没有归到正确场次，请重新拆解。",
    line_order_regressed: "分镜没整理完整：镜头顺序和剧情顺序没有对上，请重新拆解。",
    shot_elements_empty: "分镜没整理完整：有镜头没有提取到主体、动作、画面或镜头语言，请检查后重试。",
    shots_total_exceeded: "分镜没整理完整：镜头数量太多，请缩短剧本或拆成多集后重试。",
    scene_index_unknown: "分镜没整理完整：有镜头没有对应到现有场次，请重新拆解。",
    scene_without_shots: "有场次暂时没有分镜，确认前请检查是否需要补镜头。",
    lines_without_shots: "有些剧本文本暂时没有对应分镜，确认前请检查是否需要补镜头。",
    duplicate_line_coverage: "有些剧本文本被相邻分镜重复使用，确认前请检查是否符合预期。",
    unmatched_asset_names: "有些角色、场景或道具还没有匹配到候选或项目资产，确认后不会自动绑定。",
    duration_deviation: "分镜总时长和目标时长相差较大，确认前请检查镜头时长。",
    truncated: "还有一些内容没有整理完整，请重新拆解后再检查。",
  };
  return {
    code: issue.code,
    message: messageByCode[issue.code] ?? "剧本拆解没成：有一项内容没有整理完整，请检查后重试。",
  };
}

function toConfirmResponse(result: ConfirmResult) {
  return {
    runId: result.runId,
    outcome: result.outcome,
    sceneCount: result.sceneCount,
    shotCount: result.shotCount,
    supersededRunIds: result.supersededRunIds,
    unmatchedAssets: result.unmatchedAssets,
  };
}
