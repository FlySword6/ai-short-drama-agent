/**
 * IntentRouter —— 生产级意图路由门
 *
 * 六层 Pipeline（纯代码，零 LLM）：
 * ① 预处理：trim / 全角转半角 / 去控制字符 / 超长截断 / 分段
 * ② 特征提取：动作词 / 闲聊词 / 否定 / 疑问 / 确认 / 取消 / 长度 / 标点 / 分段数
 * ③ 规则匹配：8 条规则并行打分，每条带权重 + 置信度贡献
 * ④ 上下文修正：结合 session 状态（idle / clarifying / pending_confirmation / executing）
 * ⑤ 决策：最高置信度胜出，低于阈值走 vague 兜底
 * ⑥ 后处理：复合意图拆分 / 意图变更检测 / 降级标记
 *
 * 关键设计：
 * - 动作词优先级高于闲聊词（解决"你好，帮我生成一张图"误判）
 * - 反问中的闲聊不退出 grill（chat_but_in_clarifying）
 * - 取消/修正/主题切换有专门意图
 */

import { INTENT_CONFIG as CFG } from "./intent_config.js";

// ── 意图枚举（完整） ─────────────────────────────────────

export type IntentCategory =
  | "chat"
  | "chat_but_in_clarifying"
  | "task"
  | "confirm"
  | "cancel"
  | "task_switch"
  | "amend"
  | "vague";

/** session 状态，由 routes.ts 传入。 */
export type SessionState =
  | "idle" // 无进行中的 grill 流程
  | "clarifying" // grill 正在反问，等待用户回答
  | "pending_confirmation" // 信息已收集，等待用户确认执行
  | "executing"; // 正在执行生成任务

export interface IntentResult {
  category: IntentCategory;
  /** 置信度 [0, 1] */
  confidence: number;
  /** 简短理由，用于审计日志 */
  reason: string;
  /** 子意图（复合意图拆分时填充） */
  sub_intents: IntentCategory[];
  /** 是否检测到主题切换 */
  task_switch: boolean;
  /** 是否为低置信度 */
  low_confidence: boolean;
}

// ── ① 预处理层 ──────────────────────────────────────────

interface PreprocessResult {
  cleaned: string;
  segments: string[];
  truncated: boolean;
}

function preprocess(input: string): PreprocessResult {
  let text = input.trim();

  // 全角标点转半角（逗号、句号、问号、感叹号、分号）
  text = text.replace(/\u{FF0C}/gu, ",").replace(/\u{3002}/gu, ".");
  text = text.replace(/\u{FF1F}/gu, "?").replace(/\u{FF01}/gu, "!");
  text = text.replace(/\u{FF1B}/gu, ";");

  // 去除控制字符（保留换行和空格）
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // 超长截断
  let truncated = false;
  if (text.length > CFG.limits.max_length) {
    text = text.slice(0, CFG.limits.max_length);
    truncated = true;
  }

  // 分段：按逗号/分号/句号/感叹号/问号拆分
  const segments = text
    .split(/[,.;!?，。；！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return { cleaned: text, segments, truncated };
}

// ── ② 特征提取层 ────────────────────────────────────────

interface Features {
  has_action_verb: boolean;
  action_verb: string | null;
  has_chat_keyword: boolean;
  /** 匹配到的闲聊关键词短语列表——用于 R10：判断是否覆盖动作词 */
  matched_chat_keywords: string[];
  has_negation: boolean;
  has_question: boolean;
  has_confirm: boolean;
  has_cancel: boolean;
  has_amend: boolean;
  has_vague_word: boolean;
  text_length: number;
  segment_count: number;
  is_pure_question: boolean; // 纯问号或纯疑问句
  truncated: boolean;
  /** 是否包含查询关键词——绕过 grill 直接交给 agent 处理 */
  has_query_keyword: boolean;
}

function extractFeatures(
  cleaned: string,
  segments: string[],
  truncated: boolean,
): Features {
  const lower = cleaned.toLowerCase();

  // 动作词检测
  const actionVerb = CFG.dictionaries.action_verbs.find((v) => cleaned.includes(v));
  const hasActionVerb = !!actionVerb;

  // 闲聊关键词
  const chatKeywordMatches = CFG.dictionaries.chat_keywords.filter((k) =>
    lower.includes(k.toLowerCase()),
  );
  const hasChatKeyword = chatKeywordMatches.length > 0;

  // 否定词
  const hasNegation = CFG.dictionaries.negation_words.some((n) => cleaned.includes(n));

  // 疑问
  const hasQuestion = cleaned.includes("?") || cleaned.includes("？") ||
    /怎么|为什么|什么|吗|呢|哪/.test(cleaned);

  // 确认词
  const hasConfirm = CFG.dictionaries.confirm_words.some((w) => {
    if (w.length <= 2) return cleaned === w || cleaned.startsWith(w + "，") || cleaned.startsWith(w + ",");
    return cleaned.includes(w);
  });

  // 取消词
  const hasCancel = CFG.dictionaries.cancel_words.some((w) => cleaned.includes(w));

  // 修正词
  const hasAmend = CFG.dictionaries.amend_words.some((w) => cleaned.includes(w));

  // 真正模糊的短回答（不知道/随便/都行…）
  const hasVagueWord = CFG.dictionaries.vague_words.some((w) => cleaned === w || cleaned.startsWith(w + "，") || cleaned.startsWith(w + ",") || cleaned.startsWith(w + "。"));

  // 纯问号
  const isPureQuestion = /^[?？\s]+$/.test(cleaned) ||
    (hasQuestion && !hasActionVerb && cleaned.length <= 10);

  // 查询关键词（"查一下""状态""进度"等）——用于绕过 grill
  const hasQueryKeyword = CFG.dictionaries.query_keywords.some((kw) => cleaned.includes(kw));

  return {
    has_action_verb: hasActionVerb,
    action_verb: actionVerb ?? null,
    has_chat_keyword: hasChatKeyword,
    matched_chat_keywords: chatKeywordMatches,
    has_negation: hasNegation,
    has_question: hasQuestion,
    has_confirm: hasConfirm,
    has_cancel: hasCancel,
    has_amend: hasAmend,
    has_vague_word: hasVagueWord,
    text_length: cleaned.length,
    segment_count: segments.length,
    is_pure_question: isPureQuestion,
    truncated,
    has_query_keyword: hasQueryKeyword,
  };
}

// ── ③ 规则匹配层 ────────────────────────────────────────

interface RuleScore {
  rule_id: string;
  intent: IntentCategory;
  score: number;
  reason: string;
}

function evaluateRules(
  f: Features,
  sessionState: SessionState,
  cleaned: string,
): RuleScore[] {
  const scores: RuleScore[] = [];
  const W = CFG.rules;

  // R1: confirm 且无独立动作词
  // 特例：confirm_words 中包含动作词的短语（如"开始生成""直接生成"）仍算 confirm
  if (f.has_confirm) {
    // 检查 confirm 是否来自完整短语（而非单词匹配）
    const isConfirmPhrase = CFG.dictionaries.confirm_words.some((w) => {
      if (w.length <= 2) return cleaned === w || cleaned.startsWith(w + ",") || cleaned.startsWith(w + "，");
      return cleaned.includes(w);
    });
    if (isConfirmPhrase && (!f.has_action_verb || f.action_verb === "生成" || f.action_verb === "继续")) {
      // "开始生成""直接生成""生成吧"等确认短语中含动作词，仍判为 confirm
      scores.push({ rule_id: "R1", intent: "confirm", score: 0.9 * W.R1, reason: "confirm phrase (action verb is part of confirm)" });
    } else if (!f.has_action_verb) {
      scores.push({ rule_id: "R1", intent: "confirm", score: 0.9 * W.R1, reason: "confirm word, no action verb" });
    }
  }

  // R2: cancel 或 (negation + clarifying 状态)
  if (f.has_cancel) {
    scores.push({ rule_id: "R2", intent: "cancel", score: 0.9 * W.R2, reason: "cancel word" });
  } else if (f.has_negation && sessionState === "clarifying") {
    scores.push({ rule_id: "R2", intent: "cancel", score: 0.7 * W.R2, reason: "negation in clarifying state" });
  }

  // R3: action_verb 且无 chat_keyword
  if (f.has_action_verb && !f.has_chat_keyword) {
    scores.push({ rule_id: "R3", intent: "task", score: 0.8 * W.R3, reason: "action verb, no chat keyword" });
  }

  // R4: chat_keyword 且无 action_verb 且短文本
  if (f.has_chat_keyword && !f.has_action_verb && f.text_length <= CFG.limits.chat_max_length) {
    scores.push({ rule_id: "R4", intent: "chat", score: 0.7 * W.R4, reason: "chat keyword, short text" });
  }

  // R5: action_verb + chat_keyword（复合，action 优先）
  if (f.has_action_verb && f.has_chat_keyword) {
    scores.push({ rule_id: "R5", intent: "task", score: 0.6 * W.R5, reason: "compound: action verb overrides chat keyword" });
  }

  // R6: 无任何特征 且短文本
  if (!f.has_action_verb && !f.has_chat_keyword && !f.has_confirm && !f.has_cancel && f.text_length <= CFG.limits.vague_min_length) {
    scores.push({ rule_id: "R6", intent: "chat", score: 0.3 * W.R6, reason: "no features, short text" });
  }

  // R7: 无动作词 + 长文本 + 无闲聊词
  if (!f.has_action_verb && !f.has_chat_keyword && f.text_length > CFG.limits.vague_min_length) {
    scores.push({ rule_id: "R7", intent: "vague", score: 0.4 * W.R7, reason: "no verb, long text" });
  }

  // R8: 纯问号 + 无动作词
  if (f.is_pure_question && !f.has_action_verb) {
    scores.push({ rule_id: "R8", intent: "chat", score: 0.5 * W.R8, reason: "pure question, no action verb" });
  }

  // R9: 查询关键词 → 绕过 grill，直接交给 agent
  // 覆盖 R3 的 task 误判——如"查一下当前生成的素材状态"
  if (f.has_query_keyword) {
    scores.push({ rule_id: "R9", intent: "chat", score: 0.85 * W.R9, reason: "query keyword, bypass grill" });
  }

  // R10: 多字闲聊短语 + 单字动作词嵌入 → chat 覆盖 R5
  // 解决"你能做什么""你会做什么"等问能力句被判为 task 的问题
  // 条件：动作词为单字（做/写/画）、该字被 ≥3 字 chat 短语包裹、短语覆盖大部分输入
  if (
    f.has_action_verb &&
    f.has_chat_keyword &&
    f.action_verb &&
    f.action_verb.length === 1
  ) {
    const dominatingChat = f.matched_chat_keywords.find(
      (ck) => ck.length >= 2 && ck.includes(f.action_verb!) && cleaned.length <= ck.length + 4,
    );
    if (dominatingChat) {
      scores.push({
        rule_id: "R10",
        intent: "chat",
        score: 0.85 * W.R10,
        reason: `single-char verb '${f.action_verb}' embedded in chat phrase '${dominatingChat}'`,
      });
    }
  }

  return scores;
}

// ── ④ 上下文修正层 ──────────────────────────────────────

function applyContext(
  topIntent: IntentCategory,
  confidence: number,
  f: Features,
  sessionState: SessionState,
  cleaned: string,
): { intent: IntentCategory; confidence: number; reason: string } {
  // clarifying 状态下的修正
  if (sessionState === "clarifying") {
    // 取消和确认优先处理，不受短文本规则影响
    if (f.has_cancel) {
      return { intent: "cancel", confidence: 0.9, reason: "cancel in clarifying state" };
    }
    if (f.has_confirm) {
      return { intent: "confirm", confidence: 0.9, reason: "confirm in clarifying state" };
    }

    // P1-1: clarifying 状态下 amend 定向处理
    // 用户在反问阶段说"不对""改一下""换一个"等修正词 → amend
    // 定向到 amend 而非 vague/chat，使路由层能跳过 absorb 直接修改已填字段
    if (f.has_amend) {
      return {
        intent: "amend",
        confidence: 0.8,
        reason: "amend word in clarifying state",
      };
    }

    // Bug 8-5: clarifying 状态下，短文本（≤8字）是对反问的回答。
    // 不应标为 vague（会触发"我不太确定你的需求"前置回复），
    // 而应标为 task，让 absorbPendingAnswer 吸收为字段值。
    // vague 仅在 idle 状态（无上下文）时触发。
    //
    // 但需要排除真正的任务指令（如"帮我画一幅水墨画"），其特征是：
    // - 以请求前缀开头（帮我/请/我想/能不能...）
    // - 多字动作词出现在句首（生成/制作/创建...）
    const requestPrefix = /^(帮我|请|我想|我要|能不能|可以|麻烦|能不能请|来|给我)/;
    const multiCharVerbAtStart = CFG.dictionaries.action_verbs
      .filter((v) => v.length >= 2)
      .some((v) => cleaned.startsWith(v));
    const isLikelyNewTask = requestPrefix.test(cleaned) || multiCharVerbAtStart;

    if (f.text_length <= 8 && !f.has_chat_keyword && !isLikelyNewTask) {
      // 真正模糊的回答（不知道/随便/都行…）仍应判 vague，不改为 task
      if (f.has_vague_word) {
        return {
          intent: "vague",
          confidence: 0.5,
          reason: "vague word in clarifying state, user has no clear preference",
        };
      }
      return {
        intent: "task",
        confidence: 0.6,
        reason: "short answer in clarifying state, treating as response to clarification",
      };
    }

    // 闲聊关键词 → chat_but_in_clarifying（grill 不退出）
    if (f.has_chat_keyword) {
      return {
        intent: "chat_but_in_clarifying",
        confidence: Math.max(confidence, 0.6),
        reason: "chat in clarifying state, grill continues",
      };
    }

    // 长文本（>8字）+ 动作词 → 可能是主题切换，保持原意图
    // task_switch 检测放在后处理层
  }

  // pending_confirmation 状态下的修正
  if (sessionState === "pending_confirmation") {
    // 修正词 → amend
    if (f.has_amend || (f.has_negation && !f.has_cancel)) {
      return {
        intent: "amend",
        confidence: 0.8,
        reason: "amend word in pending_confirmation state",
      };
    }
  }

  // G5: executing 状态下的修正
  // executing = 正在执行生成任务
  if (sessionState === "executing") {
    // cancel → 中断执行
    if (f.has_cancel) {
      return { intent: "cancel", confidence: 0.95, reason: "cancel in executing state" };
    }
    // 其他输入 → ignore（执行中不处理新任务）
    return { intent: "vague", confidence: 0.3, reason: "executing state, queuing input" };
  }

  return { intent: topIntent, confidence, reason: "context: no adjustment" };
}

// ── ⑤ 决策层 ────────────────────────────────────────────

function pickTopIntent(scores: RuleScore[]): { intent: IntentCategory; confidence: number; reason: string } {
  if (scores.length === 0) {
    return { intent: "vague", confidence: 0.3, reason: "no rules matched" };
  }

  // 按分数排序，取最高
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top = sorted[0]!;

  return {
    intent: top.intent,
    confidence: Math.min(top.score, 1.0),
    reason: `${top.rule_id}: ${top.reason}`,
  };
}

// ── ⑥ 后处理层 ──────────────────────────────────────────

interface PostProcessResult {
  sub_intents: IntentCategory[];
  task_switch: boolean;
  low_confidence: boolean;
}

function postProcess(
  intent: IntentCategory,
  f: Features,
  sessionState: SessionState,
  confidence: number,
  cleaned: string,
): PostProcessResult {
  const sub_intents: IntentCategory[] = [];
  let task_switch = false;

  // 复合意图拆分：多个 segment 含动作词
  if (f.segment_count > 1 && f.has_action_verb) {
    // 如果有多个 segment 且都含动作词，拆出子意图
    // 简化处理：只要 segment_count > 2 且有动作词，标记可能有子意图
    if (f.segment_count > 2) {
      sub_intents.push("task");
    }
  }

  // 主题切换检测：clarifying/pending_confirmation 状态下出现新动作词
  // Bug 7 修复：短文本（≤8字）已被 applyContext 改为 vague（对反问的回答），
  // 不应触发 task_switch；只有真正的新任务指令才触发。
  // 判断标准：请求前缀开头（帮我/请/我想...）或多字动作词在句首。
  if ((sessionState === "clarifying" || sessionState === "pending_confirmation") &&
      f.has_action_verb &&
      (intent === "task" || intent === "vague")) {
    const requestPrefix = /^(帮我|请|我想|我要|能不能|可以|麻烦|能不能请|来|给我)/;
    const multiCharVerbAtStart = CFG.dictionaries.action_verbs
      .filter((v) => v.length >= 2)
      .some((v) => cleaned.startsWith(v));
    if (requestPrefix.test(cleaned) || multiCharVerbAtStart || f.text_length > 8) {
      task_switch = true;
    }
  }

  // 低置信度标记
  const low_confidence = confidence < CFG.thresholds.vague;

  return { sub_intents, task_switch, low_confidence };
}

// ── 主入口 ──────────────────────────────────────────────

/**
 * 路由用户输入的意图。
 *
 * @param input 用户原始输入文本
 * @param sessionState 当前 session 状态，默认 idle
 * @returns 路由结果
 */
export function classifyIntent(
  input: string,
  sessionState: SessionState = "idle",
): IntentResult {
  // ① 预处理
  const { cleaned, segments, truncated } = preprocess(input);

  if (!cleaned) {
    return {
      category: "chat",
      confidence: 1.0,
      reason: "empty input",
      sub_intents: [],
      task_switch: false,
      low_confidence: false,
    };
  }

  // ② 特征提取
  const features = extractFeatures(cleaned, segments, truncated);

  // ③ 规则匹配
  const scores = evaluateRules(features, sessionState, cleaned);

  // ⑤ 决策（先选最高分）
  const { intent: rawIntent, confidence: rawConfidence } = pickTopIntent(scores);

  // ④ 上下文修正
  const { intent, confidence, reason } = applyContext(rawIntent, rawConfidence, features, sessionState, cleaned);

  // ⑤ vague 兜底
  let finalIntent = intent;
  if (confidence < CFG.thresholds.vague && intent !== "cancel" && intent !== "confirm") {
    finalIntent = "vague";
  }

  // ⑥ 后处理
  const { sub_intents, task_switch, low_confidence } = postProcess(finalIntent, features, sessionState, confidence, cleaned);

  return {
    category: finalIntent,
    confidence: Math.round(confidence * 100) / 100,
    reason: reason + (truncated ? " [truncated]" : ""),
    sub_intents,
    task_switch,
    low_confidence,
  };
}

// ── 向后兼容：旧 IntentCategory 导出 ───────────────────

/**
 * 简化的意图类别，用于不需要置信度的场景。
 * chat_but_in_clarifying 归为 chat，其余保持原值。
 */
export function classifyIntentSimple(
  input: string,
  sessionState: SessionState = "idle",
): "chat" | "task" | "confirm" | "vague" {
  const result = classifyIntent(input, sessionState);
  switch (result.category) {
    case "chat":
    case "chat_but_in_clarifying":
      return "chat";
    case "task":
    case "task_switch":
    case "amend":
    case "cancel":
      return "task";
    case "confirm":
      return "confirm";
    default:
      return "vague";
  }
}

// ── 确认执行判断 ─────────────────────────────────────────

/**
 * 检查用户输入是否为确认执行指令。
 * 用于 grill 流程中判断用户是否要跳过反问直接执行。
 */
export function isConfirmExecution(input: string): boolean {
  const cleaned = input.trim().toLowerCase();
  return CFG.dictionaries.confirm_words.some((w) => {
    if (w.length <= 2) return cleaned === w || cleaned.startsWith(w + ",") || cleaned.startsWith(w + "，");
    return cleaned.includes(w);
  });
}

// ── Session 状态推断 ─────────────────────────────────────

/**
 * 根据 clarificationState 推断当前 grill 流程状态。
 * - lastAction 为 clarify/offer_candidates → clarifying
 * - lastAction 为 pending_confirmation → pending_confirmation
 * - lastAction 为 executing → executing
 * - 其他/无 → idle
 */
export function inferSessionState(
  clarificationState: { lastAction?: string; targetField?: string; taskType?: string; intent?: string } | null | undefined,
): SessionState {
  if (!clarificationState?.lastAction) return "idle";
  const action = clarificationState.lastAction;
  if (action === "clarify" || action === "offer_candidates") return "clarifying";
  if (action === "pending_confirmation") return "pending_confirmation";
  if (action === "executing") return "executing";
  return "idle";
}
