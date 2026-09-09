import type { FastifyInstance } from "fastify";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { settings } from "../../config/env.js";
import { requireCurrentContext, requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { AppError, ConflictError, publicMessage } from "../../shared/errors.js";
import { safeErrorMessage } from "../generation/errors.js";
import { AssistantRepository, type AssistantAuditLogRow, type AssistantMessageRow } from "./repository.js";
import { createAssistantAgent, buildAssistantSystemPrompt } from "./runtime.js";
import { REMOTE_PI_UNKNOWN_USAGE_RESPONSE_ID } from "./remotePiProvider.js";
import { submitAssistantGenerationQuote } from "./generationQuoteSubmit.js";
import { assistantGenerationData, createAssistantToolServices } from "./services.js";
import type { VnextProjectService } from "../vnext/service.js";
import { GrillService, type GrillServiceDeps } from "./grill/service.js";
import {
  classifyIntent,
  isConfirmExecution,
  inferSessionState,
} from "./grill/intent_router.js";
import { INTENT_CONFIG } from "./grill/intent_config.js";
import { DrizzleAiCallRepository } from "../../modules/ai/repository.js";
import { createAiGatewayService } from "../../modules/ai/service.js";
import { UserPreferenceRepositoryImpl } from "./grill/userPreferenceRepository.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";

const uuid = z.string().uuid();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sessionParams = z.object({ session_id: uuid });
const projectParams = z.object({ project_id: uuid });
const assistantQuoteParams = z.object({ session_id: uuid, quote_id: uuid });
const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
});
const createSessionSchema = z.object({
  project_id: uuid.optional(),
  vnext_project_id: uuid.optional(),
  episode_id: uuid.optional(),
  shot_id: uuid.optional(),
  title: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((input, context) => {
  if (input.vnext_project_id && (input.project_id || input.episode_id || input.shot_id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "vNext 项目不能与旧项目、集或分镜上下文混用",
    });
  }
});
const messageSchema = z.object({ content: z.string().trim().min(1).max(8_000) });
const grillCheckSchema = z.object({
  taskType: z.enum(["registration", "content_creation"]),
  intent: z.string().trim().min(1).max(2_000),
  projectId: uuid.optional(),
});
const grillAbsorbSchema = z.object({
  taskType: z.enum(["registration", "content_creation"]),
  answer: z.string().trim().min(1).max(2_000),
  targetField: z.string().trim().min(1).max(64),
  projectId: uuid.optional(),
});
const activeSessions = new Set<string>();
const activeUsers = new Map<string, number>();
const recentRequests = new Map<string, number[]>();
let activeRequestCount = 0;
const maxGlobalRequests = 8;
const maxRequestsPerUser = 2;
const rateWindowMs = 60_000;
const maxRequestsPerMinute = 30;
const requestDeadlineMs = 90_000;
const vnextAssistantAgentType = "platform_assistant_vnext";

/** G9: 确认执行提示语，从 intent_config.ts 配置读取，按任务类型区分。 */
function getConfirmHint(taskType: string): string {
  return INTENT_CONFIG.confirm_hints[taskType] ?? INTENT_CONFIG.confirm_hints.default ?? "";
}


type AssistantRouteRepository = Pick<
  AssistantRepository,
  "createSession" | "getSession" | "listMessages" | "listProjectAuditLogs" | "appendMessage"
>;

/** Injectable route seams for no-I/O public DTO contract tests. */
export interface AssistantRouteDependencies {
  createRepository?: (db: Database) => AssistantRouteRepository;
  submitGenerationQuote?: typeof submitAssistantGenerationQuote;
  projectAccess?: Pick<ProjectAccessService, "requireCreative">;
  createVnextService?: () => VnextProjectService;
  grillDeps?: GrillServiceDeps;
}

/**
 * 构造默认的 GrillServiceDeps，注入 Drizzle 实现。
 * 仅在 GRILL_ENABLED=true 时实际使用；否则不会被调用。
 */
function createDefaultGrillDeps(db: Database): GrillServiceDeps {
  return {
    aiCallRepo: new DrizzleAiCallRepository(db),
    gateway: createAiGatewayService(db),
    assistantRepo: new AssistantRepository(db),
    prefRepo: new UserPreferenceRepositoryImpl(db),
  };
}

export async function registerAssistantRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AssistantRouteDependencies = {},
): Promise<void> {
  const createRepository = dependencies.createRepository ?? ((db: Database) => new AssistantRepository(db));
  const submitGenerationQuote = dependencies.submitGenerationQuote ?? submitAssistantGenerationQuote;
  app.post("/api/v1/agent/sessions", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const context = requireCurrentContext(request);
    const actor = context.user;
    const input = parseRequest(createSessionSchema, request.body);
    const vnextService = input.vnext_project_id ? dependencies.createVnextService?.() : undefined;
    if (input.vnext_project_id && !vnextService) {
      throw new AppError(503, "vnext_assistant_unavailable", "vNext 助手暂未就绪，请稍后重试。");
    }
    if (input.vnext_project_id) {
      await vnextService!.getProject(actor, input.vnext_project_id);
    }
    const session = await createRepository(getDatabase()).createSession({
      actorId: actor.id,
      authSessionId: context.credential.sessionId,
      agentType: input.vnext_project_id ? vnextAssistantAgentType : "platform_assistant",
      userAgent: context.credential.userAgent,
      projectId: input.project_id,
      episodeId: input.episode_id,
      shotId: input.shot_id,
      title: input.title,
    });
    if (input.vnext_project_id) {
      await vnextService!.bindAssistantSession(actor, session.id, input.vnext_project_id);
    }
    return reply.code(201).send(success({
      session_id: session.id,
      project_id: session.projectId,
      vnext_project_id: input.vnext_project_id ?? null,
      shot_id: session.shotId,
      title: session.title,
      created_at: session.createdAt,
    }));
  });

  app.get("/api/v1/agent/sessions/:session_id/messages", async (request) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(sessionParams, request.params);
    const items = await createRepository(getDatabase()).listMessages(actor.id, params.session_id);
    return success({ items: items.map(messageData), count: items.length });
  });

  app.get("/api/v1/projects/:project_id/ai-audit-logs", async (request) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(projectParams, request.params);
    const query = parseRequest(auditQuerySchema, request.query);
    const result = await createRepository(getDatabase()).listProjectAuditLogs({
      actorId: actor.id,
      projectId: params.project_id,
      page: query.page,
      pageSize: query.page_size,
    });
    return success({
      items: result.items.map(auditLogData),
      page: query.page,
      page_size: query.page_size,
      total: result.total,
      has_more: query.page * query.page_size < result.total,
    });
  });

  app.post(
    "/api/v1/agent/sessions/:session_id/generation-quotes/:quote_id/submit",
    { config: { agentAccess: "human_only" } },
    async (request, reply) => {
      const actor = requireCurrentUser(request);
      const params = parseRequest(assistantQuoteParams, request.params);
      const db = getDatabase();
      const session = await createRepository(db).getSession(actor.id, params.session_id);
      if (!session.projectId) {
        throw new AppError(409, "assistant_context_mismatch", "助手会话没有可提交生成的项目上下文");
      }
      const projectAccess = dependencies.projectAccess
        ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(db));
      const access = await projectAccess.requireCreative(actor, session.projectId);
      const view = await submitGenerationQuote(db, {
        actorId: actor.id,
        authorizedProjectId: access.projectId,
        session,
        quoteId: params.quote_id,
      });
      return reply.code(202).send(success(assistantGenerationData(view, { submitted: true })));
    },
  );

  // Grill Engine: information-sufficiency pre-check before running the agent.
  // If information is insufficient, returns a clarification question or
  // candidate list instead of running the agent with silent defaults.
  app.post("/api/v1/agent/sessions/:session_id/grill-check", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(sessionParams, request.params);
    const body = parseRequest(grillCheckSchema, request.body);

    const db = getDatabase();
    const grillDeps = dependencies.grillDeps ?? createDefaultGrillDeps(db);
    const grill = new GrillService(grillDeps);
    if (!grill.isEnabled()) {
      return reply.code(200).send(success({ action: "execute" as const }));
    }

    const result = await grill.check(
      body.taskType,
      body.intent,
      params.session_id,
      actor.id,
      body.projectId,
    );

    if (!result) {
      return reply.code(200).send(success({ action: "execute" as const }));
    }

    return reply.code(200).send(success(result));
  });

  // Grill Engine: absorb a user's answer to a clarification question.
  app.post("/api/v1/agent/sessions/:session_id/grill-absorb", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(sessionParams, request.params);
    const body = parseRequest(grillAbsorbSchema, request.body);

    const db = getDatabase();
    const grillDeps = dependencies.grillDeps ?? createDefaultGrillDeps(db);
    const grill = new GrillService(grillDeps);
    if (!grill.isEnabled()) {
      return reply.code(200).send(success({ extracted: null, nextAction: { action: "execute" as const } }));
    }

    const result = await grill.absorb(
      body.taskType,
      body.answer,
      body.targetField,
      params.session_id,
      actor.id,
      body.projectId,
    );

    if (!result) {
      return reply.code(200).send(success({ extracted: null, nextAction: { action: "execute" as const } }));
    }

    return reply.code(200).send(success(result));
  });

  app.post("/api/v1/agent/sessions/:session_id/messages", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(sessionParams, request.params);
    const input = parseRequest(messageSchema, request.body);
    const repository = createRepository(getDatabase());
    const session = await repository.getSession(actor.id, params.session_id);
    const vnextService = session.agentType === vnextAssistantAgentType
      ? dependencies.createVnextService?.()
      : undefined;
    if (session.agentType === vnextAssistantAgentType && !vnextService) {
      throw new AppError(503, "vnext_assistant_unavailable", "vNext 助手暂未就绪，请稍后重试。");
    }
    const vnextProjectId = vnextService
      ? await vnextService.resolveAssistantProject(actor, session.id)
      : null;
    const runtimeConfig = assistantRuntimeConfig();
    const modelId = runtimeConfig.remoteModelId;
    if (!runtimeConfig.aiGatewayEnabled || !runtimeConfig.remoteApiUrl || !runtimeConfig.remoteApiToken || !modelId) {
      throw new AppError(
        503,
        "assistant_not_configured",
        "AI 助手暂未开通：请联系管理员完成配置。",
      );
    }
    if (activeSessions.has(session.id)) {
      throw new ConflictError("这个助手会话正在回复，请稍后再发", "assistant_session_busy");
    }

    enforceAssistantRateLimit(actor.id);
    const releaseSlot = acquireAssistantSlot(actor.id, session.id);
    try {
      const historyRows = await repository.listMessages(actor.id, params.session_id);
      const isNewSession = historyRows.length === 0;
      const db = getDatabase();

      // ── 新会话时重置计数器，避免继承上一对话的轮次计数 ──
      // sharedCounter 是进程级单例，跨对话不自动重置
      if (isNewSession && settings.grillEnabled) {
        const resetDeps = dependencies.grillDeps ?? createDefaultGrillDeps(db);
        const resetGrill = new GrillService(resetDeps);
        try {
          resetGrill.resetClarificationCounter(actor.id, "registration");
          resetGrill.resetClarificationCounter(actor.id, "content_creation");
        } catch { /* ignore */ }
      }

      // ── 首回合注册引导预检 ──
      // 仅在 GRILL_ENABLED=true 且用户无任何偏好时触发
      if (isNewSession && settings.grillEnabled) {
        const grillDeps = dependencies.grillDeps ?? createDefaultGrillDeps(db);
        const prefRepo = grillDeps.prefRepo;
        const hasPrefs = await prefRepo.hasAnyPreference(actor.id);
        if (!hasPrefs) {
          const grill = new GrillService(grillDeps);

          try {
            // 从 grill 状态推断 sessionState，用于意图路由上下文修正
            const regClarifState = await grill.getClarificationState?.(session.id, actor.id) ?? null;
            const regSessionState = inferSessionState(regClarifState);

            const intentResult = classifyIntent(input.content, regSessionState);
            request.log.info({ intent: intentResult.category, confidence: intentResult.confidence, reason: intentResult.reason, taskSwitch: intentResult.task_switch, content: input.content.slice(0, 50) }, "intent classification");

            // 闲聊/问候 → 不进 grill，直接走 agent
            if (intentResult.category === "chat") {
              request.log.info("chat intent detected, skipping grill");
              // 落到后面的 agent.prompt 正常回复
            } else if (intentResult.category === "chat_but_in_clarifying") {
              // G2: 反问中的闲聊 → 回复闲聊应答 + 继续反问同一字段
              // 不 absorb、不重置计数器、不退出 grill
              request.log.info("chat in clarifying state, responding with small talk and re-asking");
              const lowerContent = input.content.trim().toLowerCase();
              let chatReply = "好的~";
              for (const [keyword, replies] of Object.entries(INTENT_CONFIG.chat_replies)) {
                if (lowerContent.includes(keyword.toLowerCase())) {
                  chatReply = replies[Math.floor(Math.random() * replies.length)] ?? chatReply;
                  break;
                }
              }
              // 继续反问当前字段（不 absorb、不重置计数器）
              const reaskResult = await grill.check(
                "registration",
                input.content,
                session.id,
                actor.id,
                session.projectId ?? undefined,
              );
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              const roundAnn = grill.formatRoundAnnotation(actor.id, "registration");
              if (reaskResult && reaskResult.action === "clarify") {
                send({ type: "text_delta", delta: `${chatReply}\n${roundAnn} ${reaskResult.question}\n${getConfirmHint("registration")}` });
              } else if (reaskResult && reaskResult.action === "offer_candidates") {
                const candidateList = reaskResult.candidates.map((c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ""}`).join("\n");
                send({ type: "text_delta", delta: `${chatReply}\n${roundAnn} 请从以下选项中选择（输入序号或选项名）：\n${candidateList}\n${getConfirmHint("registration")}` });
                send({ type: "card_delta", candidates: reaskResult.candidates });
              } else if (reaskResult && (reaskResult.action === "pending_confirmation" || reaskResult.action === "best_inference")) {
                send({ type: "text_delta", delta: `${chatReply}\n${reaskResult.summary}\n${getConfirmHint("registration")}` });
              } else {
                // check 返回 null 或 execute → 闲聊回复后走 agent
                send({ type: "text_delta", delta: chatReply });
              }
              send("[DONE]");
              reply.raw.end();
              return;
            } else if (regSessionState === "executing" && intentResult.category === "cancel") {
              // G5: executing 状态下 cancel → 中断执行
              request.log.info("cancel in executing state (registration), interrupting generation");
              try {
                grill.resetClarificationCounter(actor.id, "registration");
                await grill.clearClarificationState?.(session.id, actor.id);
              } catch { /* ignore */ }
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              send({ type: "text_delta", delta: "已取消生成。\n\n如需继续，请重新描述你想生成的内容。" });
              send("[DONE]");
              reply.raw.end();
              return;
            } else if (regSessionState === "executing") {
              // G5: executing 状态下其他输入 → 告知用户正在执行中
              request.log.info("input in executing state (registration), informing user");
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              send({ type: "text_delta", delta: '正在生成中，完成后会通知你。如需取消请说"取消"。\n\n' });
              send("[DONE]");
              reply.raw.end();
              return;
            } else if (intentResult.category === "cancel") {
              // Bug 8-2: 取消 → 重置计数器 + 清除 clarificationState，直接回复"已取消"，不走 agent
              request.log.info("cancel intent detected, resetting grill");
              try {
                grill.resetClarificationCounter(actor.id, "registration");
                await grill.clearClarificationState?.(session.id, actor.id);
              } catch { /* ignore */ }
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              send({ type: "text_delta", delta: "已取消。\n\n如需继续，请重新描述你想生成的内容。" });
              send("[DONE]");
              reply.raw.end();
              return;
            } else if (intentResult.category === "confirm") {
            // 用户主动确认执行 → 跳过 grill 反问，走正常 agent 流程
              try {
                grill.resetClarificationCounter(actor.id, "registration");
              } catch { /* ignore */ }
            } else {
            // task / task_switch / amend / vague → 进 grill 反问流程
            // task_switch: 用户切换了主题，重置计数器后重新走 check
            if (intentResult.task_switch) {
              request.log.info("task switch detected, resetting grill for new topic");
              try {
                grill.resetClarificationCounter(actor.id, "registration");
                await grill.clearClarificationState?.(session.id, actor.id);
              } catch { /* ignore */ }
            }
            // P1-1 + G3: clarifying 状态下 amend 意图 → 尝试定向修正已填字段，跳过 absorb
            // 用户说"不对""改一下""改成视频"不是在回答当前反问，而是想修改已填字段
            const skipAbsorb = intentResult.category === "amend" && regSessionState === "clarifying";
            let amendResult: { fieldName: string; newValue: string; nextAction: import("./grill/types.js").GrillCheckResult; profile: import("./grill/types.js").TaskProfile } | null = null;
            if (skipAbsorb) {
              request.log.info("amend intent in clarifying state, trying amendField");
              amendResult = await grill.amendField(
                "registration",
                input.content,
                session.id,
                actor.id,
                session.projectId ?? undefined,
              );
            }
            const absorbed = (intentResult.task_switch || skipAbsorb)
              ? null
              : await grill.absorbPendingAnswer(
                session.id,
                actor.id,
                input.content,
              );
            // absorb 成功：用 nextAction 决定下一步
            // absorb 返回 null：无 pending clarification，走正常 check 流程
            // G3: amend 成功：用 amendResult.nextAction 决定下一步
            const result = amendResult
              ? { ...amendResult.nextAction, profile: amendResult.profile }
              : absorbed
                ? { ...absorbed.nextAction, profile: grill.getProfile(absorbed.taskType)! }
                : await grill.check(
                  "registration",
                  input.content,
                  session.id,
                  actor.id,
                session.projectId ?? undefined,
                { isVague: intentResult.category === "vague" },
              );

            // G4: vague 意图 → 先输出前置回复，再进 grill check
            // vague 的语义是"用户意图不明确"，直接进反问流程会让用户困惑
            // 先回复"我不太确定你的需求，我先按[推断任务类型]来理解..."
            const vaguePrefix = intentResult.category === "vague"
              ? "我不太确定你的需求，我先按注册引导来理解，如果你想做别的可以直接告诉我。\n"
              : "";

            if (result && result.action === "clarify") {
              // 发反问问题，不进入 agent.prompt
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              const roundAnn = grill.formatRoundAnnotation(actor.id, "registration");
              send({ type: "text_delta", delta: `${vaguePrefix}${roundAnn} ${result.question}\n${getConfirmHint("registration")}` });
              send("[DONE]");
              reply.raw.end();
              return;
            }
            if (result && result.action === "offer_candidates") {
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              const roundAnn = grill.formatRoundAnnotation(actor.id, "registration");
              const candidateList = result.candidates.map((c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ""}`).join("\n");
              send({ type: "text_delta", delta: `${vaguePrefix}${roundAnn} 请从以下选项中选择（输入序号或选项名）：\n${candidateList}\n${getConfirmHint("registration")}` });
              send({ type: "card_delta", candidates: result.candidates });
              send("[DONE]");
              reply.raw.end();
              return;
            }
            if (result && (result.action === "pending_confirmation" || result.action === "best_inference")) {
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              send({ type: "text_delta", delta: `${vaguePrefix}${result.summary}\n${getConfirmHint("registration")}` });
              send("[DONE]");
              reply.raw.end();
              return;
            }
            } // end else (task or vague intent → grill flow)
          } catch (grillErr) {
            // Grill LLM 调用失败时不阻断主流程，继续走 agent.prompt
            request.log.warn({ error: safeErrorMessage(grillErr) }, "grill registration check failed, falling through to agent");
          }
        }
      }

      // ── 动态 system prompt：注入 user_role / preferred_style ──
      const grillDeps = dependencies.grillDeps ?? createDefaultGrillDeps(db);
      const systemPrompt = settings.grillEnabled
        ? await buildAssistantSystemPrompt(
          {
            sessionId: session.id,
            userId: actor.id,
            projectId: session.projectId,
            vnextProjectId,
            shotId: session.shotId,
          },
          grillDeps.prefRepo,
        )
        : undefined;

      await repository.appendMessage({ sessionId: session.id, role: "user", content: input.content });

      // ── 阶段 3：Grill Engine 注入 agent（content_creation profile） ──
      // GRILL_ENABLED=false 时 grill=undefined，beforeToolCall/afterToolCall 不触发
      const grillService = settings.grillEnabled
        ? new GrillService(grillDeps)
        : undefined;

      // ── Pre-agent content_creation grill check ──
      // 在 agent.prompt 之前运行 content_creation profile 检查，
      // 确保即使 LLM 不调用 prepare_generation_card，grill 也能拦截并反问。
      if (grillService && session.projectId) {
        try {
          // 从 grill 状态推断 sessionState
          const ccClarifState = await grillService.getClarificationState(session.id, actor.id) ?? null;
          const ccSessionState = inferSessionState(ccClarifState);

          const ccIntent = classifyIntent(input.content, ccSessionState);
          request.log.info({ intent: ccIntent.category, confidence: ccIntent.confidence, reason: ccIntent.reason, taskSwitch: ccIntent.task_switch, content: input.content.slice(0, 50) }, "content_creation intent classification");

          if (ccIntent.category === "chat") {
            // 闲聊/问候 → 不进 grill，直接走 agent
            request.log.info("chat intent detected, skipping content_creation grill");
          } else if (ccIntent.category === "chat_but_in_clarifying") {
            // G2: 反问中的闲聊 → 回复闲聊应答 + 继续反问同一字段
            // 不 absorb、不重置计数器、不退出 grill
            request.log.info("chat in clarifying state, responding with small talk and re-asking (content_creation)");
            const ccLowerContent = input.content.trim().toLowerCase();
            let ccChatReply = "好的~";
            for (const [keyword, replies] of Object.entries(INTENT_CONFIG.chat_replies)) {
              if (ccLowerContent.includes(keyword.toLowerCase())) {
                ccChatReply = replies[Math.floor(Math.random() * replies.length)] ?? ccChatReply;
                break;
              }
            }
            // 继续反问当前字段（不 absorb、不重置计数器）
            const ccReaskResult = await grillService.check(
              "content_creation",
              input.content,
              session.id,
              actor.id,
              session.projectId,
            );
            reply.hijack();
            reply.raw.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            reply.raw.flushHeaders?.();
            const ccSend = (data: unknown) => {
              if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
              }
            };
            const ccRoundAnn = grillService.formatRoundAnnotation(actor.id, "content_creation");
            if (ccReaskResult && ccReaskResult.action === "clarify") {
              ccSend({ type: "text_delta", delta: `${ccChatReply}\n${ccRoundAnn} ${ccReaskResult.question}\n\n${getConfirmHint("content_creation")}` });
            } else if (ccReaskResult && ccReaskResult.action === "offer_candidates") {
              const ccCandList = ccReaskResult.candidates.map((c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ""}`).join("\n");
              ccSend({ type: "text_delta", delta: `${ccChatReply}\n${ccRoundAnn} 请从以下选项中选择（输入序号或选项名），或直接输入你的想法：\n${ccCandList}\n${getConfirmHint("content_creation")}` });
              ccSend({ type: "card_delta", candidates: ccReaskResult.candidates });
            } else if (ccReaskResult && (ccReaskResult.action === "pending_confirmation" || ccReaskResult.action === "best_inference")) {
              ccSend({ type: "text_delta", delta: `${ccChatReply}\n${ccReaskResult.summary}\n${getConfirmHint("content_creation")}` });
            } else {
              ccSend({ type: "text_delta", delta: ccChatReply });
            }
            ccSend("[DONE]");
            reply.raw.end();
            return;
          } else if (ccSessionState === "executing" && ccIntent.category === "cancel") {
            // G5: executing 状态下 cancel → 中断执行
            // 后端不支持真实中断时，至少告知用户
            request.log.info("cancel in executing state, interrupting generation");
            try {
              grillService.resetClarificationCounter(actor.id, "content_creation");
              await grillService.clearClarificationState(session.id, actor.id);
            } catch { /* ignore */ }
            reply.hijack();
            reply.raw.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            reply.raw.flushHeaders?.();
            const send = (data: unknown) => {
              if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
              }
            };
            send({ type: "text_delta", delta: "已取消生成。\n\n如需继续，请重新描述你想生成的内容。" });
            send("[DONE]");
            reply.raw.end();
            return;
          } else if (ccSessionState === "executing") {
            // G5: executing 状态下其他输入 → 告知用户正在执行中
            request.log.info("input in executing state, informing user");
            reply.hijack();
            reply.raw.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            reply.raw.flushHeaders?.();
            const send = (data: unknown) => {
              if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
              }
            };
            send({ type: "text_delta", delta: '正在生成中，完成后会通知你。如需取消请说"取消"。\n\n' });
            send("[DONE]");
            reply.raw.end();
            return;
          } else if (ccIntent.category === "cancel") {
            // Bug 8-2: 取消 → 重置计数器 + 清除 clarificationState，直接回复"已取消"，不走 agent
            request.log.info("cancel intent detected, resetting content_creation grill");
            try {
              grillService.resetClarificationCounter(actor.id, "content_creation");
              await grillService.clearClarificationState(session.id, actor.id);
            } catch { /* ignore */ }
            reply.hijack();
            reply.raw.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            });
            reply.raw.flushHeaders?.();
            const send = (data: unknown) => {
              if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
              }
            };
            send({ type: "text_delta", delta: "已取消。\n\n如需继续，请重新描述你想生成的内容。" });
            send("[DONE]");
            reply.raw.end();
            return;
          } else if (ccIntent.category === "confirm" || isConfirmExecution(input.content)) {
            // 用户主动确认执行 → 跳过 grill 反问，直接进入 agent
            // 重置计数器，避免下次对话残留旧计数
            try {
              grillService.resetClarificationCounter(actor.id, "content_creation");
            } catch { /* ignore */ }
          } else {
            // task / task_switch / amend / vague → 进 grill 反问流程
            // task_switch: 用户切换了主题，重置后重新走 check
            if (ccIntent.task_switch) {
              request.log.info("task switch detected, resetting content_creation grill for new topic");
              try {
                grillService.resetClarificationCounter(actor.id, "content_creation");
                await grillService.clearClarificationState(session.id, actor.id);
              } catch { /* ignore */ }
            }
            // P1-1 + G3: clarifying 状态下 amend 意图 → 尝试定向修正已填字段，跳过 absorb
            const ccSkipAbsorb = ccIntent.category === "amend" && ccSessionState === "clarifying";
            let ccAmendResult: { fieldName: string; newValue: string; nextAction: import("./grill/types.js").GrillCheckResult; profile: import("./grill/types.js").TaskProfile } | null = null;
            if (ccSkipAbsorb) {
              request.log.info("amend intent in clarifying state (content_creation), trying amendField");
              ccAmendResult = await grillService.amendField(
                "content_creation",
                input.content,
                session.id,
                actor.id,
                session.projectId,
              );
            }
            const absorbed = (ccIntent.task_switch || ccSkipAbsorb)
              ? null
              : await grillService.absorbPendingAnswer(
                session.id,
                actor.id,
                input.content,
              );
            const result = ccAmendResult
              ? { ...ccAmendResult.nextAction, profile: ccAmendResult.profile }
              : absorbed
                ? { ...absorbed.nextAction, profile: grillService.getProfile(absorbed.taskType)! }
                : await grillService.check(
                  "content_creation",
                  input.content,
                  session.id,
                  actor.id,
                  session.projectId,
                  { isVague: ccIntent.category === "vague" },
                );

            // G4: vague 意图 → 先输出前置回复，再进 grill check
            const ccVaguePrefix = ccIntent.category === "vague"
              ? "我不太确定你的需求，我先按内容创作来理解，如果你想做别的可以直接告诉我。\n"
              : "";

            if (result && result.action === "clarify") {
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              const roundAnn = grillService.formatRoundAnnotation(actor.id, "content_creation");
              send({ type: "text_delta", delta: `${ccVaguePrefix}${roundAnn} ${result.question}\n\n${getConfirmHint("content_creation")}` });
              send("[DONE]");
              reply.raw.end();
              return;
            }
            if (result && result.action === "offer_candidates") {
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              const roundAnn = grillService.formatRoundAnnotation(actor.id, "content_creation");
              const candidateList = result.candidates.map((c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ""}`).join("\n");
              send({ type: "text_delta", delta: `${ccVaguePrefix}${roundAnn} 请从以下选项中选择（输入序号或选项名），或直接输入你的想法：\n${candidateList}\n${getConfirmHint("content_creation")}` });
              send({ type: "card_delta", candidates: result.candidates });
              send("[DONE]");
              reply.raw.end();
              return;
            }
            if (result && (result.action === "pending_confirmation" || result.action === "best_inference")) {
              reply.hijack();
              reply.raw.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
              });
              reply.raw.flushHeaders?.();
              const send = (data: unknown) => {
                if (!reply.raw.destroyed && !reply.raw.writableEnded) {
                  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
                }
              };
              send({ type: "text_delta", delta: `${ccVaguePrefix}${result.summary}\n${getConfirmHint("content_creation")}` });
              send("[DONE]");
              reply.raw.end();
              return;
            }
          }
        } catch (grillErr) {
          request.log.warn({ error: safeErrorMessage(grillErr) }, "grill content_creation pre-check failed, falling through to agent");
        }
      }

      const agent = createAssistantAgent({
        context: {
          sessionId: session.id,
          userId: actor.id,
          projectId: session.projectId,
          vnextProjectId,
          shotId: session.shotId,
        },
        config: {
          ...runtimeConfig,
        },
        services: {
          ...createAssistantToolServices(getDatabase()),
          ...(vnextProjectId && vnextService ? { vnextProjectService: vnextService } : {}),
        },
        messages: historyMessages(boundedHistory(historyRows), modelId),
        systemPrompt,
        ...(grillService
          ? { grill: { service: grillService, taskType: "content_creation" as const, intent: input.content }, userMessage: input.content }
          : {}),
      });

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.flushHeaders?.();
      const send = (data: unknown) => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
        }
      };
      const abort = () => agent.abort();
      reply.raw.once("close", abort);
      const toolStartedAt = new Map<string, number>();
      const runStartedAt = Date.now();
      let assistantFailure: string | undefined;
      let assistantDisplayFailure: string | undefined;
      let assistantFailureRecorded = false;
      let modelTurns = 0;
      const deadline = setTimeout(() => {
        assistantFailure = "助手回复超过 90 秒，已停止本次请求";
        assistantDisplayFailure = "AI 助手这次没能及时回复：请稍后再试。";
        agent.abort();
      }, requestDeadlineMs);

      const unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "turn_start") {
          modelTurns += 1;
          if (modelTurns > 2) {
            assistantFailure = "本次助手回复已达到两轮处理上限";
            assistantDisplayFailure = "AI 助手这次没回复完：请缩短问题后再试。";
            agent.abort();
          }
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          send({ type: "text_delta", delta: event.assistantMessageEvent.delta });
        }
        if (event.type === "tool_execution_start") {
          toolStartedAt.set(event.toolCallId, Date.now());
          send({ type: "tool_start", tool_name: event.toolName });
        }
        if (event.type === "tool_execution_end") {
          // ── 阶段 3：offer_candidates 路径提取 card_delta ──
          // afterToolCall 覆盖结果时在 details 里写了 grillAction="offer_candidates"
          // agent-loop.js:519-526 事件携带完整 result（含 details），此订阅器可读
          const resultDetails = isRecord(event.result) ? isRecord(event.result.details) ? event.result.details : undefined : undefined;
          if (resultDetails?.grillAction === "offer_candidates" && Array.isArray(resultDetails.candidates)) {
            const candidateList = (resultDetails.candidates as Array<{ label?: string; description?: string }>)
              .map((c, i) => `${i + 1}. ${c.label ?? ""}${c.description ? ` — ${c.description}` : ""}`)
              .join("\n");
            send({ type: "text_delta", delta: `请从以下选项中选择（输入序号或选项名）：\n${candidateList}\n${getConfirmHint("content_creation")}` });
            send({ type: "card_delta", candidates: resultDetails.candidates });
            // 继续走正常 tool_end 记录，但不覆盖已发送的 card_delta
          }
          const summary = safeJsonRecord(event.result);
          await repository.appendMessage({
            sessionId: session.id,
            role: "tool",
            content: event.isError ? "工具执行失败" : "工具执行完成",
            toolName: event.toolName,
            status: event.isError ? "failed" : "completed",
            durationMs: durationSince(toolStartedAt.get(event.toolCallId)),
            errorCode: event.isError ? "assistant_tool_failed" : undefined,
          });
          toolStartedAt.delete(event.toolCallId);
          send(toolEndSseEvent(event.toolName, event.isError, summary));
          const quoteEvent = generationQuoteSseEvent(event.toolName, event.isError, summary);
          if (quoteEvent) send(quoteEvent);
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          const content = assistantText(event.message);
          const status = assistantAuditStatus(event.message.stopReason);
          const failed = event.message.stopReason === "error" || event.message.stopReason === "aborted";
          const runtimeFailure = failed
            ? event.message.errorMessage || "助手回复中断"
            : undefined;
          const displayFailure = failed
            ? publicMessage(new Error(runtimeFailure), "AI 助手这次没回复成：请稍后再试。")
            : undefined;
          if (runtimeFailure) {
            request.log.error(
              { error: safeErrorMessage(new Error(runtimeFailure)) },
              "assistant provider response failed",
            );
          }
          await repository.appendMessage({
            sessionId: session.id,
            role: "assistant",
            content,
            status,
            provider: event.message.provider,
            model: event.message.responseModel ?? event.message.model,
            usage: assistantUsageData(event.message),
            providerCostUsdMicros: assistantProviderCostUsdMicros(event.message),
            durationMs: durationSince(runStartedAt),
            errorCode: failed
              ? (event.message.stopReason === "aborted" ? "assistant_aborted" : "assistant_model_error")
              : undefined,
          });
          if (failed) {
            assistantFailure = runtimeFailure;
            assistantDisplayFailure = displayFailure;
            assistantFailureRecorded = true;
          }
        }
      });

      try {
        await agent.prompt(input.content);
        if (assistantFailure) throw new Error(assistantFailure);
        send("[DONE]");
      } catch (error) {
        const rawMessage = safeErrorMessage(error);
        request.log.error({ error: rawMessage }, "assistant response failed");
        const message = assistantDisplayFailure ?? assistantPublicFailureMessage(error);
        if (!assistantFailureRecorded) {
          await repository.appendMessage({
            sessionId: session.id,
            role: "assistant",
            content: `本次回复失败：${message}`,
            status: "failed",
            model: modelId,
            durationMs: durationSince(runStartedAt),
            errorCode: "assistant_request_failed",
          }).catch(() => undefined);
        }
        send({ type: "error", message });
        send("[DONE]");
      } finally {
        clearTimeout(deadline);
        unsubscribe();
        reply.raw.off("close", abort);
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    } finally {
      releaseSlot();
    }
  });
}

export function assistantPublicFailureMessage(error: unknown): string {
  return publicMessage(error, "AI 助手这次没回复成：请稍后再试。");
}

function assistantRuntimeConfig() {
  const remoteApiUrl = settings.piRemoteApiUrl?.trim();
  const remoteApiToken = settings.piRemoteApiToken?.trim();
  const remoteModelId = settings.piRemoteModel?.trim();
  if (!settings.aiGatewayEnabled) {
    throw new AppError(
      503,
      "assistant_gateway_disabled",
      "AI 助手暂未开通：请联系管理员完成受控网关配置。",
    );
  }
  if (!remoteApiUrl || !remoteApiToken || !remoteModelId) {
    throw new AppError(
      503,
      "assistant_remote_config_incomplete",
      "AI 助手暂未就绪：请联系管理员检查配置。",
    );
  }
  return {
    aiGatewayEnabled: true,
    remoteApiUrl,
    remoteApiToken,
    remoteModelId,
  };
}

function messageData(message: AssistantMessageRow): Record<string, unknown> {
  const generationQuote = historyGenerationQuote(message);
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    tool_name: message.toolName,
    status: message.status,
    usage: message.usage,
    provider_cost_usd_micros: message.providerCostUsdMicros,
    points_spent: message.pointsSpent,
    duration_ms: message.durationMs,
    created_at: message.createdAt,
    // 刷新/重读历史时必须能恢复报价卡：内部查询仍保留 tool_result_summary 列，
    // 这里只从中派生最小、受校验的结构化报价；raw 字段本身继续不投影。
    ...(generationQuote ? { generation_quote: generationQuote } : {}),
  };
}

/**
 * 从历史 tool_result_summary.details 派生结构化 generation_quote（方案 A）。
 *
 * 背景：字段清理后 /messages 不再投影 tool_result_summary，前端
 * generationQuoteFromMessage 的 fallback（读 tool_result_summary.details）随之
 * 失效，刷新后历史报价卡消失。本函数让服务端在读取历史时直接产出前端首选的
 * message.generation_quote，raw summary 仍不外发。
 *
 * 校验与前端 generationQuoteFromUnknown 保持一致，保证恢复出的报价与实时 SSE
 * 事件同形、可信；任何不完整字段返回 null（不渲染报价卡）。
 */
export function historyGenerationQuote(message: AssistantMessageRow): Record<string, unknown> | null {
  if (message.toolName !== "generate_media") return null;
  const summary = message.toolResultSummary;
  const details = summary && isRecord(summary) && isRecord(summary.details) ? summary.details : undefined;
  if (!details) return null;
  const quoteId = details.generation_quote_id;
  const estimatedCostFen = details.estimated_cost_fen;
  const expiresAt = details.expires_at;
  const status = details.status;
  if (
    typeof quoteId !== "string"
    || !uuidPattern.test(quoteId)
    || !Number.isSafeInteger(estimatedCostFen)
    || (estimatedCostFen as number) < 0
    || typeof expiresAt !== "string"
    || !Number.isFinite(Date.parse(expiresAt))
    || details.currency !== "CNY"
    || (status !== "pending_confirmation" && status !== "confirmed" && status !== "consumed")
  ) {
    return null;
  }
  return {
    generation_quote_id: quoteId,
    source: "assistant",
    action: "submit",
    status,
    estimated_cost_fen: estimatedCostFen,
    currency: "CNY",
    expires_at: expiresAt,
    ...(details.media_kind === "image" || details.media_kind === "video"
      ? { media_kind: details.media_kind }
      : {}),
    ...(typeof details.generation_request_id === "string"
      ? { generation_request_id: details.generation_request_id }
      : {}),
  };
}


function auditLogData(message: AssistantAuditLogRow) {
  return {
    id: message.id,
    role: message.role,
    tool_name: message.toolName,
    status: message.status,
    provider: message.provider,
    model: message.model,
    usage: message.usage,
    provider_cost_usd_micros: message.providerCostUsdMicros,
    points_spent: message.pointsSpent,
    duration_ms: message.durationMs,
    error_code: message.errorCode,
    created_at: message.createdAt,
    session_id: message.sessionId,
    user_id: message.userId,
    user_name: message.userName,
    project_id: message.projectId,
    shot_id: message.shotId,
  };
}

export function historyMessages(rows: AssistantMessageRow[], fallbackModelId: string): AgentMessage[] {
  return rows.slice(-100).flatMap((row): AgentMessage[] => {
    if (row.role === "user") {
      return [{ role: "user", content: row.content, timestamp: row.createdAt.getTime() }];
    }
    if (row.role !== "assistant") return [];
    return [{
      role: "assistant",
      content: [{ type: "text", text: row.content }],
      api: "openai-completions",
      provider: row.provider ?? "pi-remote",
      model: row.model ?? fallbackModelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: row.createdAt.getTime(),
    }];
  });
}

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
  return message.content
    .filter((item): item is Extract<(typeof message.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
}

export function assistantAuditStatus(
  stopReason: Extract<AgentMessage, { role: "assistant" }>["stopReason"],
): "completed" | "failed" | "aborted" {
  if (stopReason === "error") return "failed";
  if (stopReason === "aborted") return "aborted";
  return "completed";
}

export function assistantUsageData(
  message: Extract<AgentMessage, { role: "assistant" }>,
): Record<string, unknown> {
  if (message.responseId === REMOTE_PI_UNKNOWN_USAGE_RESPONSE_ID) {
    return {
      status: "unknown",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      total_tokens: null,
      provider_cost: { currency: "USD", input: null, output: null, cache_read: null, cache_write: null, total: null, cost_known: false },
    };
  }
  return {
    status: "reported",
    api: message.api,
    input_tokens: nonNegativeNumber(message.usage.input),
    output_tokens: nonNegativeNumber(message.usage.output),
    cache_read_tokens: nonNegativeNumber(message.usage.cacheRead),
    cache_write_tokens: nonNegativeNumber(message.usage.cacheWrite),
    reasoning_tokens: message.usage.reasoning === undefined
      ? null
      : nonNegativeNumber(message.usage.reasoning),
    total_tokens: nonNegativeNumber(message.usage.totalTokens),
    provider_cost: {
      currency: "USD",
      input: nonNegativeNumber(message.usage.cost.input),
      output: nonNegativeNumber(message.usage.cost.output),
      cache_read: nonNegativeNumber(message.usage.cost.cacheRead),
      cache_write: nonNegativeNumber(message.usage.cost.cacheWrite),
      total: nonNegativeNumber(message.usage.cost.total),
      cost_known: true,
    },
  };
}

export function assistantProviderCostUsdMicros(
  message: Extract<AgentMessage, { role: "assistant" }>,
): number | undefined {
  if (message.responseId === REMOTE_PI_UNKNOWN_USAGE_RESPONSE_ID) return undefined;
  return usdToMicros(message.usage.cost.total);
}

export function usdToMicros(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const micros = Math.round(value * 1_000_000);
  return Number.isSafeInteger(micros) && micros <= 2_147_483_647 ? micros : undefined;
}

function nonNegativeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function durationSince(startedAt: number | undefined): number | undefined {
  if (startedAt === undefined) return undefined;
  return Math.max(0, Date.now() - startedAt);
}


function safeJsonRecord(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length > 20_000) return { summary: serialized.slice(0, 20_000), truncated: true };
  const parsed = JSON.parse(serialized) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : { value: parsed };
}

export function generationQuoteSseEvent(
  toolName: string,
  isError: boolean,
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (toolName !== "generate_media" || isError) return undefined;
  const details = isRecord(result.details) ? result.details : undefined;
  if (!details
    || typeof details.generation_quote_id !== "string"
    || !uuidPattern.test(details.generation_quote_id)
    || !Number.isSafeInteger(details.estimated_cost_fen)
    || (details.estimated_cost_fen as number) < 0
    || details.currency !== "CNY"
    || typeof details.expires_at !== "string"
    || !Number.isFinite(Date.parse(details.expires_at))
    || details.status !== "pending_confirmation"
    || (details.media_kind !== "image" && details.media_kind !== "video")) {
    return undefined;
  }
  return {
    type: "generation_quote",
    generation_quote_id: details.generation_quote_id,
    estimated_cost_fen: details.estimated_cost_fen,
    currency: "CNY",
    expires_at: details.expires_at,
    status: "pending_confirmation",
    media_kind: details.media_kind,
  };
}

/**
 * Keep the existing tool_end envelope stable while exposing only the small
 * piece of successful state that the UI can act on. Tool results can contain
 * model output, internal IDs, or future provider fields, so they must never be
 * forwarded wholesale over the stream.
 */
export function toolEndSseEvent(
  toolName: string,
  isError: boolean,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: "tool_end",
    tool_name: toolName,
    is_error: isError,
  };
  const resultSummary = toolResultSseSummary(toolName, isError, result);
  if (resultSummary) event.result_summary = resultSummary;
  return event;
}

function toolResultSseSummary(
  toolName: string,
  isError: boolean,
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // A failing tool has no trustworthy success payload. In particular, do not
  // turn a partial result into a navigable UI reference.
  if (isError || toolName !== "add_project_asset") return undefined;

  const details = isRecord(result.details) ? result.details : undefined;
  if (!details) return undefined;
  const referenceId = details.reference_id;
  if (typeof referenceId !== "string" || !uuidPattern.test(referenceId)) return undefined;

  return {
    kind: "project_asset_added",
    ref_id: referenceId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedHistory(rows: AssistantMessageRow[]): AssistantMessageRow[] {
  const selected: AssistantMessageRow[] = [];
  let characters = 0;
  for (let index = rows.length - 1; index >= 0 && selected.length < 100; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    const size = row.content.length + JSON.stringify(row.toolResultSummary ?? {}).length;
    if (selected.length > 0 && characters + size > 32_000) break;
    selected.push(row);
    characters += size;
  }
  return selected.reverse();
}

function enforceAssistantRateLimit(userId: string): void {
  const now = Date.now();
  const current = (recentRequests.get(userId) ?? []).filter((timestamp) => now - timestamp < rateWindowMs);
  if (current.length >= maxRequestsPerMinute) {
    recentRequests.set(userId, current);
    throw new AppError(429, "assistant_rate_limited", "小龙虾请求过于频繁，请稍后再试", true);
  }
  current.push(now);
  recentRequests.set(userId, current);
}

function acquireAssistantSlot(userId: string, sessionId: string): () => void {
  if (activeRequestCount >= maxGlobalRequests) {
    throw new AppError(503, "assistant_busy", "小龙虾当前任务较多，请稍后再试", true);
  }
  const userCount = activeUsers.get(userId) ?? 0;
  if (userCount >= maxRequestsPerUser) {
    throw new ConflictError("当前账号已有两个助手请求在处理，请稍后再试", "assistant_user_busy");
  }
  activeRequestCount += 1;
  activeUsers.set(userId, userCount + 1);
  activeSessions.add(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRequestCount = Math.max(0, activeRequestCount - 1);
    const remaining = (activeUsers.get(userId) ?? 1) - 1;
    if (remaining > 0) activeUsers.set(userId, remaining);
    else activeUsers.delete(userId);
    activeSessions.delete(sessionId);
  };
}
