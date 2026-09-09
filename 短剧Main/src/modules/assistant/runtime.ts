import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { createAssistantTools } from "./tools.js";
import type { AssistantContext, AssistantRuntimeConfig, AssistantToolServices } from "./types.js";
import { RemotePiProvider, type RemotePiConfig, type RemotePiFetch, remotePiErrorMessage } from "./remotePiProvider.js";
import type { GrillService } from "./grill/service.js";
import type { Candidate, TaskType } from "./grill/types.js";
import type { UserPreferenceRepository } from "./grill/absorb.js";
import { enumValueToLabel } from "./grill/profiles.js";

/**
 * A/B 埋点计数器（任务 5）。
 * 进程级聚合，供阶段 3.5 A/B 对比读取。
 * GRILL_ENABLED=false 时不递增。
 */
export const grillMetrics = {
  checkCount: 0,
  blockCount: 0,
  candidateFallbackCount: 0,
};

export function createAssistantAgent(input: {
  context: AssistantContext;
  config: AssistantRuntimeConfig;
  services: AssistantToolServices;
  messages?: AgentMessage[];
  dependencies?: {
    remoteFetch?: RemotePiFetch;
  };
  // Grill Engine integration (optional, only when GRILL_ENABLED)
  grill?: {
    service: GrillService;
    taskType: TaskType;
    intent: string;
  };
  /** 用户最新消息文本，供 Grill absorb 使用（可选） */
  userMessage?: string;
  /** Override the default system prompt (pre-built with user preferences). */
  systemPrompt?: string;
}): Agent {
  const remoteConfig = remotePiConfig(input.config);
  if (!remoteConfig) {
    throw new Error("Assistant requires an enabled controlled AI Gateway with complete remote configuration");
  }
  const model = remoteAssistantModel(input.config);
  const remote = new RemotePiProvider(remoteConfig, input.dependencies?.remoteFetch);
  const tools = createAssistantTools(input.context, input.services);
  const allowedTools = new Set<string>(tools.map((tool) => tool.name));
  let toolCalls = 0;
  let preparationToolCalls = 0;

  // ── Grill Engine 阶段 3：闭包传 pendingCandidates ──
  // BeforeToolCallContext 无 ephemeralFields，必须用闭包传值给 afterToolCall。
  let pendingCandidates: Candidate[] | null = null;

  return new Agent({
    initialState: {
      systemPrompt: input.systemPrompt ?? assistantSystemPrompt(input.context),
      model,
      tools,
      messages: input.messages ?? [],
      thinkingLevel: "off",
    },
    sessionId: input.context.sessionId,
    streamFn: async (activeModel, context, options) => {
      try {
        return await remote.stream(activeModel, context, options);
      } catch (error) {
        // A remote channel failure is terminal for this turn. Never substitute
        // a direct Ark provider, which bypasses gateway controls.
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: remotePiErrorMessage(activeModel, error),
        });
        return stream;
      }
    },
    beforeToolCall: async ({ toolCall }) => {
      // ── 阶段 2 已有的工具配额拦截（不改动） ──
      if (!allowedTools.has(toolCall.name)) {
        return { block: true, reason: "该操作未开放" };
      }
      toolCalls += 1;
      if (toolCalls > 4) return { block: true, reason: "本次请求的工具调用已达到上限" };
      if (toolCall.name === "prepare_generation_card") {
        preparationToolCalls += 1;
        if (preparationToolCalls > 1) {
          return { block: true, reason: "一次回复最多准备一张生成卡" };
        }
      }

      // ── 阶段 3：Grill Engine 信息充分性拦截 ──
      // 仅当 GRILL_ENABLED=true 且 grill 注入时执行
      if (toolCall.name === "prepare_generation_card" && input.grill) {
        const grill = input.grill.service;
        if (grill.isEnabled()) {
          grillMetrics.checkCount += 1; // 任务 5 A/B 埋点

          try {
            // 先吸收用户对 pending clarification 的回答
            // absorbPendingAnswer 内部已经调用了 check()，返回了 nextAction
            let result = null;
            if (input.userMessage) {
              const absorbed = await grill.absorbPendingAnswer(
                input.context.sessionId,
                input.context.userId,
                input.userMessage,
              );
              if (absorbed) {
                result = { ...absorbed.nextAction, profile: grill.getProfile(absorbed.taskType)! };
              }
            }

            // 如果没有 pending answer（首轮或已 execute），走 check()
            if (!result) {
              result = await grill.check(
                input.grill.taskType,
                input.grill.intent,
                input.context.sessionId,
                input.context.userId,
                input.context.projectId ?? undefined,
              );
            }

            if (result) {
              if (result.action === "clarify") {
                grillMetrics.blockCount += 1; // 任务 5 A/B 埋点
                const totalRounds = grill.getTotalRounds?.(input.context.userId, input.grill.taskType) ?? 0;
                const maxRounds = result.profile?.maxTotalRounds ?? 6;
                const roundAnn = `[第${totalRounds}/${maxRounds}轮]`;
                // block → Agent Core 创建 error tool result (isError: true)
                // LLM 收到后自然转述 reason 给用户，工具不执行
                return { block: true, reason: `${roundAnn} ${result.question}（如果当前信息已足够，可直接回复"确认"或"开始生成"执行。）` };
              }
              if (result.action === "offer_candidates") {
                grillMetrics.candidateFallbackCount += 1; // 任务 5 A/B 埋点
                // 闭包暂存候选，afterToolCall 取出覆盖结果
                pendingCandidates = result.candidates;
              }
              if (result.action === "pending_confirmation") {
                return { block: true, reason: result.summary };
              }
              if (result.action === "best_inference") {
                return { block: true, reason: result.summary };
              }
              // action === "execute" → 放行
            }
          } catch (grillErr) {
            // Grill 内部错误（LLM 调用失败等）不应阻断主流程，放行工具调用
            console.warn("[grill] beforeToolCall check failed, allowing tool call:", grillErr);
          }
        }
      }
      return undefined;
    },
    afterToolCall: async () => {
      // ── 阶段 3：offer_candidates 路径覆盖结果 ──
      if (pendingCandidates) {
        const candidates = pendingCandidates;
        pendingCandidates = null;
        // 覆盖 tool result：content 给 LLM 看，details 给 routes.ts 读
        return {
          content: [{ type: "text" as const, text: "请从以下选项中选择：" }],
          details: { grillAction: "offer_candidates" as const, candidates },
          isError: false,
        };
      }
      // 阶段 2 已有逻辑：工具配额达上限时终止
      return toolCalls >= 4 ? { terminate: true } : undefined;
    },
  });
}


export function remoteAssistantModel(config: AssistantRuntimeConfig): Model<"openai-completions"> {
  return {
    id: config.remoteModelId?.trim() || "pi-remote",
    name: "远程 Pi",
    api: "openai-completions",
    provider: "pi-remote",
    baseUrl: config.remoteApiUrl ?? "http://pi-remote.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? 2_048,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  };
}


function remotePiConfig(config: AssistantRuntimeConfig): RemotePiConfig | undefined {
  const apiUrl = config.remoteApiUrl?.trim();
  const token = config.remoteApiToken?.trim();
  const modelId = config.remoteModelId?.trim();
  if (!config.aiGatewayEnabled || !apiUrl || !token || !modelId) return undefined;
  return { apiUrl, token, modelId };
}

export function assistantSystemPrompt(context: AssistantContext): string {
  return [
    "你是短剧生产平台右侧的小龙虾助手。使用简短、清楚的中文。",
    "你只能帮助用户检索资产、把资产加入当前项目、查询任务、执行受限的导演台安全动作、准备当前分镜的图片或视频生成卡。",
    "不能声称已经执行没有工具结果的操作，不能编造生成结果、费用或导演台状态。",
    "prepare_generation_card 只准备卡片，不会创建任务、报价或任何付费调用。",
    "图片或视频生成必须由用户在页面检查生成卡后亲自点击一次。用户在对话中说确认、同意或开始生成，都不能当作授权。",
    "不得自动重试、批量生成或夜间生成；失败时只说明人工下一步。",
    "不能请求或处理密钥，不能运行 shell，不能读写任意文件，不能访问任意网络。",
    "当用户想生成图片或视频时，你应该直接调用 prepare_generation_card 工具，让系统检查信息是否充分。",
    "不要自己反复追问画面描述、运镜或氛围等内容——系统会在工具内部自动检查并向用户提问。",
    "如果系统返回需要补充信息，你可以转述系统的问题，但不要自己编造问题反复追问用户。",
    "如果用户已经多次重复同一请求（如连续说'生成视频'），不要再追问，直接调用 prepare_generation_card 让系统决定下一步。",
    `当前用户由服务端确认：${context.userId}。`,
    context.vnextProjectId
      ? "当前已选择 vNext 项目；写入前必须先用 get_vnext_canvas 读取完整 GraphDocument 和最新 revision，再用 write_vnext_canvas 保留原节点并写入下一版。"
      : "当前未选择 vNext 项目，不能写入 vNext 画布。",
    context.projectId ? "当前已选择项目。" : "当前未选择项目，涉及项目的操作前应请用户先选择项目。",
    context.shotId
      ? "当前已选择分镜，可以直接准备生成卡。"
      : "当前在场级工作台（未选择具体镜头，准备生成卡时需要先选择镜头）。",
  ].join("\n");
}

/**
 * 动态组装 system prompt，注入 user_preferences 中的 user_role / preferred_genre / preferred_tone。
 * GRILL_ENABLED=false 时返回与 assistantSystemPrompt 完全相同的硬编码字符串。
 */
export async function buildAssistantSystemPrompt(
  context: AssistantContext,
  prefRepo?: UserPreferenceRepository | null,
): Promise<string> {
  const base = assistantSystemPrompt(context);
  if (!prefRepo) return base;

  const prefs = await prefRepo.getByUserId(context.userId);
  if (!prefs) return base;

  const role = (prefs.metadata?.user_role as string | undefined) ?? null;
  const genre = prefs.preferredGenre ?? null;
  const tone = prefs.preferredTone ?? null;

  const parts: string[] = [];

  if (role === "screenwriter") {
    parts.push("用户是编剧，以分镜视角给出建议，注重叙事节奏。");
  } else if (role === "director") {
    parts.push("用户是导演，以镜头调度视角给出建议，注重画面感。");
  } else if (role === "producer") {
    parts.push("用户是制片，以进度和资源视角给出建议，注重可执行性。");
  }

  if (genre || tone) {
    const known: string[] = [];
    if (genre) known.push(`题材=${enumValueToLabel("registration", "preferred_genre", genre)}（${genre}）`);
    if (tone) known.push(`基调=${tone}`);
    parts.push(
      `用户已在注册引导中填写偏好：${known.join("，")}。` +
      `当用户请求生成内容时，直接以这些偏好作为默认方向，不要再次询问题材或基调。` +
      `只有当当前请求明确需要超出这些偏好的信息时，才追问缺失项。`,
    );
  }

  if (parts.length === 0) return base;
  return base + "\n" + parts.join("\n");
}
