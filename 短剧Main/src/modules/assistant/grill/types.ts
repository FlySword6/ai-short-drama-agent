/**
 * Grill Engine 阶段 0 接口定义（零代码侵入）
 *
 * 来源：grill-engine-design.md §3「共享接口契约」+ §8 阶段 0 步骤 0.1。
 * 本文件只定义类型，不接对话循环，不含运行时逻辑。
 * 阶段 1+ 的 LLM 组件接口（SemanticSufficiencyEvaluator / ClarificationGenerator /
 * CandidateGenerator / absorb）不在本文件定义——阶段 0 只覆盖纯代码组件。
 */

// ── 场景配置 ──────────────────────────────────────────────

/** Grill Engine 支持的场景类型。阶段 0 只定义，不实现场景接入。 */
export type TaskType = "registration" | "content_creation" | "script_breakdown";

/** 字段优先级：critical=缺了必须问；preferred=可默认/可推断。 */
export type FieldPriority = "critical" | "preferred";

/** 字段用途：persist=写 user_preferences 表；ephemeral=写会话上下文。 */
export type FieldUsage = "persist" | "ephemeral";

/** absorb 抽取策略，默认 llm 兜底。阶段 0 不实现 absorb。 */
export type ExtractorType = "regex" | "enum" | "llm";

/** 场景配置：每个使用场景填一份 TaskProfile 接入同一引擎。 */
export interface TaskProfile {
  taskType: TaskType;
  requiredFields: FieldSpec[];
  /** 反问次数上限，默认 3。 */
  maxClarifications: number;
  /** 总交互轮次上限，默认 6。 */
  maxTotalRounds: number;
  /** 主题细化深度上限，默认 2（防止无限递归细化）。 */
  maxSubjectDepth: number;
  /** 候选数量，默认 3。 */
  candidateCount: number;
  /** profile 预置兜底候选，按 fieldName 分组。 */
  fallbackCandidates?: Record<string, Candidate[]>;
}

/** 字段规格：RulePreChecker 按 priority + exists 判断充分性。 */
export interface FieldSpec {
  name: string;
  description: string;
  priority: FieldPriority;
  /** preferred 字段可设默认值。 */
  defaultValue?: unknown;
  usage: FieldUsage;
  /** absorb 抽取策略，默认 llm 兜底。阶段 0 不使用。 */
  extractor?: ExtractorType;
  /** enum 字段的有效枚举值列表。有此属性的字段不接受原文兜底。 */
  knownEnums?: string[];
}

// ── 候选 ──────────────────────────────────────────────────

/** 候选项：label 给人看，value 给机器用。 */
export interface Candidate {
  label: string;
  description: string;
  value: unknown;
}

// ── 会话上下文 ────────────────────────────────────────────

/** 反问状态：计数 + 已问字段 + 当前目标字段 + 总轮次 + 主题细化深度。 */
export interface ClarificationState {
  count: number;
  /** 总交互轮次（跨字段累计）。 */
  totalRounds: number;
  /** 主题字段已细化深度（防止无限下钻）。 */
  subjectDepth: number;
  targetField?: string;
  askedFields: string[];
  /** P0-2: 上一轮用户输入，用于重复输入检测。 */
  lastUserInput?: string;
  /** P0-2: 用户原始意图文本，用于检测用户是否重复发同一句话。 */
  originalIntent?: string;
}

/** 字段来源标记：区分用户提供 vs 引擎推断 vs 默认值。 */
export type FieldSource = "user" | "inferred" | "default" | "preference";

/**
 * 会话上下文（扩展 AssistantContext）。
 * 阶段 0 只用 ephemeralFields 做 mock 测试，不接真实会话。
 */
export interface ConversationContext {
  userId: string;
  projectId?: string;
  shotId?: string;
  /** 反问状态。阶段 0 由 ClarificationCounter 进程内管理。 */
  clarificationState?: ClarificationState;
  /** 本回合临时收集的字段。 */
  ephemeralFields?: Record<string, unknown>;
  /** G10: 每个字段的来源标记（user/inferred/default/preference），用于待确认输出分组。 */
  fieldSources?: Record<string, FieldSource>;
  /** 运行时元信息，如用户偏好提示等。 */
  metadata?: Record<string, string>;
}

// ── Grill Engine 入口 ────────────────────────────────────

/** check() 返回的动作：执行 / 待确认 / 反问 / 给候选 / 最佳推断。 */
export type GrillCheckResult =
  | { action: "execute" }
  | { action: "pending_confirmation"; summary: string; collectedFields: string[] }
  | { action: "clarify"; question: string; targetField: string }
  | { action: "offer_candidates"; candidates: Candidate[]; targetField: string }
  | { action: "best_inference"; summary: string; collectedFields: string[] };

/** absorb() 返回值。阶段 0 不实现，仅定义接口。 */
export interface GrillAbsorbResult {
  extracted: unknown;
  updatedCtx: ConversationContext;
}

/**
 * Grill Engine 入口接口。
 * 它是 agent 运行循环的编排层（beforeToolCall / afterToolCall），不是工具。
 * 阶段 0 不实现完整 GrillEngine，只实现 RulePreChecker + ClarificationCounter。
 */
export interface GrillEngine {
  check(
    profile: TaskProfile,
    intent: string,
    ctx: ConversationContext,
  ): Promise<GrillCheckResult>;
  absorb(
    answer: string,
    targetField: string,
    ctx: ConversationContext,
  ): Promise<GrillAbsorbResult>;
}

// ── RulePreChecker 返回值 ──────────────────────────────────

/**
 * 规则预检结论。
 * - sufficient：规则能定论"充分"，直接执行。
 * - insufficient：critical 字段缺失，规则能定论"不充分"。
 * - needs_llm：preferred 字段缺失但可推断，规则无法定论，交 LLM 判断。
 *   阶段 0 不接 LLM，needs_llm 暂按 insufficient 处理（进入反问/降级流程）。
 */
export type RulePreCheckResult =
  | { conclusion: "sufficient" }
  | { conclusion: "insufficient"; missingCritical: string[]; missingPreferred?: string[] }
  | { conclusion: "needs_llm"; missingPreferred: string[] };

// ── afterToolCall 覆盖结果标记 ───────────────────────────

/**
 * afterToolCall 覆盖 tool result 时写入 details 的标记。
 * routes.ts tool_execution_end 通过 event.result.details.grillAction 读到。
 * 阶段 0 不接入 routes.ts，此类型仅用于验证报告和测试 mock。
 */
export interface GrillActionDetails {
  grillAction: "offer_candidates" | "pending_confirmation" | "best_inference";
  candidates?: Candidate[];
  summary?: string;
  collectedFields?: string[];
}
