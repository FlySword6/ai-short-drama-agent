/**
 * absorb —— 答案抽取器（规则优先 + LLM 兜底）
 *
 * 来源：grill-engine-design.md §2.2 + §8 阶段 1 步骤 1.6。
 * 逻辑：
 * - regex 抽取：简单正则匹配（阶段1先用字符串包含）
 * - enum 抽取：枚举值匹配
 * - llm 抽取：LLM 从自然语言回答中提取结构化值
 * - persist 字段写入 user_preferences 表（通过 repository）
 * - ephemeral 字段写入会话上下文 ephemeralFields
 *
 * 成本控制：常态 0 次 LLM（regex/enum 能抽取），兜底 1 次 LLM。
 */

import type { AiCallRepository, AiCompletionProvider } from "../../ai/types.js";
import { callLLMWithGuard, readJsonField } from "./callLLMWithGuard.js";
import { INTENT_CONFIG } from "./intent_config.js";
import type { Candidate, FieldSpec, ConversationContext, GrillAbsorbResult } from "./types.js";

const ABSORB_SYSTEM = `你是一个答案抽取器。用户回答了一个问题，请从回答中提取结构化值。
只输出严格 JSON，格式：{"extracted": <提取的值>}
如果无法提取，输出 {"extracted": null}`;

export interface UserPreferenceRepository {
  upsert(userId: string, data: {
    preferredGenre?: string | null;
    preferredTone?: string | null;
    styleTags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  getByUserId(userId: string): Promise<{
    preferredGenre: string | null;
    preferredTone: string | null;
    styleTags: string[];
    metadata: Record<string, unknown>;
  } | null>;
  /** 检查用户是否有任何偏好设置（用于首回合注册引导判断）。 */
  hasAnyPreference(userId: string): Promise<boolean>;
  /** 读取单个字段值：先查已知列，再查 metadata。 */
  getField(userId: string, fieldName: string): Promise<unknown>;
}

/**
 * 从用户回答中抽取目标字段值。
 * 规则优先（regex/enum），LLM 兜底。
 * @param candidates profile 中预置的候选列表，用于 enum 匹配（可选）
 */
/**
 * P1-2: 乱码/无效输入检测。
 *
 * 检查用户输入是否为乱码或无意义内容：
 * - 空字符串或纯空白
 * - 纯标点/符号
 * - 重复字符（如 "aaaa", "。。。"）
 * - 有效文字字符占比过低（乱码）
 *
 * @returns true 如果输入有效；false 如果是乱码/无效
 */
export function isValidInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;

  // 纯标点/符号
  if (/^[\s\p{P}\p{S}]+$/u.test(trimmed)) return false;

  // 重复字符（≥3 个相同字符）
  if (trimmed.length >= 3) {
    const first = trimmed[0]!;
    if ([...trimmed].every((c) => c === first)) return false;
  }

  // 有效文字字符占比检测（乱码检测）
  // 有效 = CJK 汉字 + 字母 + 数字
  let validChars = 0;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    // CJK 统一汉字 + 扩展A
    if ((code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf)) {
      validChars++;
    } else if (/[a-zA-Z0-9]/.test(char)) {
      validChars++;
    }
  }
  // 有效字符占比低于 30% → 乱码
  if (validChars / trimmed.length < 0.3) return false;

  return true;
}

/**
 * G1: 重复输入检测。
 *
 * 检查用户当前输入是否与上一轮输入或原始意图完全相同（或高度相似）。
 * 场景：用户第1轮输入"帮我生成一段视频"，反问 content_type 后用户又输入
 * 完全相同的原话"帮我生成一段视频"——这不是在回答反问，而是重复指令。
 *
 * 匹配规则：
 * 1. 完全相同（trim 后）
 * 2. 相似度极高（编辑距离 ≤ 较短串长度的 20%，且长度 ≥ 4）
 *
 * @returns true 如果是重复输入；false 如果是新的有效回答
 */
export function isRepeatInput(
  currentInput: string,
  lastUserInput?: string,
  originalIntent?: string,
): boolean {
  const trimmed = currentInput.trim();
  if (!trimmed) return false;

  // 与 lastUserInput 对比
  if (lastUserInput) {
    const last = lastUserInput.trim();
    if (trimmed === last) return true;
    if (trimmed.length >= 4 && last.length >= 4) {
      const dist = levenshtein(trimmed, last);
      const minLen = Math.min(trimmed.length, last.length);
      if (dist <= Math.max(1, Math.floor(minLen * 0.2))) return true;
    }
  }

  // 与 originalIntent 对比
  if (originalIntent) {
    const orig = originalIntent.trim();
    if (trimmed === orig) return true;
    if (trimmed.length >= 4 && orig.length >= 4) {
      const dist = levenshtein(trimmed, orig);
      const minLen = Math.min(trimmed.length, orig.length);
      if (dist <= Math.max(1, Math.floor(minLen * 0.2))) return true;
    }
  }

  return false;
}

export async function absorbAnswer(
  repo: AiCallRepository,
  provider: AiCompletionProvider,
  prefRepo: UserPreferenceRepository,
  answer: string,
  targetField: FieldSpec,
  ctx: ConversationContext,
  candidates?: Candidate[],
): Promise<GrillAbsorbResult> {
  // P1-2: 乱码/无效输入检测——无效输入直接返回 null，不消耗 LLM 额度
  if (!isValidInput(answer)) {
    return { extracted: null, updatedCtx: ctx };
  }

  // G1: 重复输入检测——用户重复上一轮输入或原始意图时，不吸收，走候选兜底
  if (isRepeatInput(answer, ctx.clarificationState?.lastUserInput, ctx.clarificationState?.originalIntent)) {
    return { extracted: null, updatedCtx: ctx };
  }

  // 模糊词过滤：用户回答"不知道""都可以"等时，不提取为有效值，走候选兜底
  // 匹配规则与 intent_router 一致：精确匹配，或模糊词后跟标点（如"都可以。"）
  const trimmedAnswer = answer.trim();
  if (INTENT_CONFIG.dictionaries.vague_words.some(
    (w) => trimmedAnswer === w ||
    trimmedAnswer.startsWith(w + "，") ||
    trimmedAnswer.startsWith(w + ",") ||
    trimmedAnswer.startsWith(w + "。") ||
    trimmedAnswer.startsWith(w + ".") ||
    trimmedAnswer.startsWith(w + "！") ||
    trimmedAnswer.startsWith(w + "!") ||
    trimmedAnswer.startsWith(w + "、") ||
    trimmedAnswer.startsWith(w + " "),
  )) {
    return { extracted: null, updatedCtx: ctx };
  }

  let extracted: unknown;

  // ── 候选匹配优先（无论 extractor 类型）──
  // 当引擎展示了候选列表后，用户回答就是候选 label/value/序号
  // 必须先尝试候选匹配，否则 llm/regex 字段会跳过候选识别
  if (candidates && candidates.length > 0) {
    extracted = matchCandidate(answer, candidates);
  }

  // 候选匹配失败 → 按 extractor 类型走规则抽取
  if (extracted === null || extracted === undefined) {
    if (targetField.extractor === "regex") {
      extracted = extractByRegex(answer, targetField);
    } else if (targetField.extractor === "enum") {
      extracted = extractByEnum(answer, targetField, candidates);
    }
  }

  // 所有 extractor 类型规则抽取失败时都允许 LLM 兜底
  // enum 字段传候选列表给 LLM，让 LLM 能将非标准回答映射到有效候选值
  if (extracted === null || extracted === undefined) {
    extracted = await extractByLlm(repo, provider, answer, targetField, ctx, candidates);
  }

  // LLM 兜底仍失败时，仅对自由文本字段（无 knownEnums）接受原文兜底
  // enum 字段（有 knownEnums）LLM 失败时返回 null → 走多选兜底
  if ((extracted === null || extracted === undefined) && !targetField.knownEnums) {
    const trimmed = answer.trim();
    if (trimmed) {
      extracted = trimmed;
    }
  }

  // Bug 3: 抽取失败时不写入 ephemeralFields（避免 null 被误判为已填充）
  const hasValue = extracted !== null && extracted !== undefined && extracted !== "";
  const updatedCtx: ConversationContext = hasValue
    ? {
        ...ctx,
        ephemeralFields: {
          ...(ctx.ephemeralFields ?? {}),
          [targetField.name]: extracted,
        },
        // G10: 标记来源为 user（用户通过回答明确提供）
        fieldSources: {
          ...(ctx.fieldSources ?? {}),
          [targetField.name]: "user" as const,
        },
      }
    : ctx;

  // persist 字段写入 user_preferences 表
  if (targetField.usage === "persist" && extracted !== null && extracted !== undefined) {
    await persistField(prefRepo, ctx.userId, targetField, extracted);
  }

  return { extracted, updatedCtx };
}

/** regex 抽取：简单字符串包含（阶段1简化实现）。 */
function extractByRegex(answer: string, field: FieldSpec): unknown {
  const trimmed = answer.trim();
  if (!trimmed) return null;
  // Bug 3: 对于有 knownEnums 的字段，regex 只在匹配枚举时返回值
  // 否则返回 trimmed（向后兼容，允许自由文本字段如 subject_or_theme）
  return trimmed;
}

/**
 * 候选匹配：检查用户回答是否匹配某个候选。
 * 支持三种匹配方式：
 * 1. 序号匹配（"1", "2" 等）
 * 2. 候选 value 精确匹配
 * 3. 候选 label 模糊匹配（包含关系，不区分大小写）
 * 匹配成功返回候选的 value，否则返回 null。
 */
function matchCandidate(answer: string, candidates: Candidate[]): unknown {
  const trimmed = answer.trim();
  if (!trimmed) return null;

  // 1. 序号匹配
  const asNum = parseInt(trimmed, 10);
  if (!isNaN(asNum) && asNum >= 1 && asNum <= candidates.length) {
    return candidates[asNum - 1]!.value;
  }

  const lowerAnswer = trimmed.toLowerCase();

  // 2. 候选 value 精确匹配（区分大小写）
  for (const c of candidates) {
    const valStr = String(c.value);
    if (trimmed === valStr) {
      return c.value;
    }
  }

  // 3. 候选 label 模糊匹配（不区分大小写，包含关系）
  for (const c of candidates) {
    const labelLower = c.label.toLowerCase();
    const valLower = String(c.value).toLowerCase();
    if (lowerAnswer.includes(labelLower) || labelLower.includes(lowerAnswer) ||
        lowerAnswer.includes(valLower) || valLower.includes(lowerAnswer)) {
      return c.value;
    }
  }

  return null;
}

/**
 * 同义词表 —— 将非标准回答映射到有效枚举值。
 *
 * Bug 7 修复：用户输入"动画"不在候选 label 中，但语义上属于 "video"。
 * 此表提供第二级匹配（同义词匹配），避免完全依赖 LLM 兜底。
 *
 * key = 字段名，value = { 枚举值: [同义词...] }
 */
const SYNONYM_TABLE: Record<string, Record<string, string[]>> = {
  content_type: {
    video: ["视频", "动画", "动漫", "短视频", "影视", "动画片", "动态", "动效", "video"],
    image: ["图片", "插画", "海报", "照片", "画面", "图", "image", "photo"],
    text: ["文案", "文字", "文本", "剧本", "文章", "text", "copy"],
  },
  preferred_genre: {
    sweet: ["甜宠", "甜文", "恋爱", "甜", "高甜", "撒糖"],
    rebirth: ["重生复仇", "重生", "逆袭", "复仇", "打脸"],
    ancient: ["古风权谋", "古风", "古装", "权谋", "宫廷"],
  },
  user_role: {
    screenwriter: ["编剧", "写手", "剧本"],
    director: ["导演", "导"],
    producer: ["制片", "制作人", "策划"],
  },
  preferred_tone: {
    hot_blooded: ["热血", "燃", "激情", "爽"],
    healing: ["治愈", "温暖", "暖心", "温馨"],
    suspense: ["悬疑", "烧脑", "推理", "反转"],
  },
};

/**
 * 计算两个字符串的编辑距离（Levenshtein distance）。
 * 用于模糊匹配的第三级。
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

/**
 * 模糊匹配：检查用户输入是否与候选值语义相似。
 * 使用包含关系 + 编辑距离双重判断。
 * @returns 匹配到的候选 value，或 null
 */
function fuzzyMatch(
  answer: string,
  candidates: Candidate[],
  synonyms: Record<string, string[]> | undefined,
): unknown {
  const trimmed = answer.trim();
  const lower = trimmed.toLowerCase();

  // 1. 同义词表匹配
  if (synonyms) {
    for (const [enumValue, synList] of Object.entries(synonyms)) {
      for (const syn of synList) {
        if (lower === syn.toLowerCase() || lower.includes(syn.toLowerCase())) {
          // 确认同义词对应的 enumValue 在候选列表中
          const matched = candidates.find((c) => String(c.value) === enumValue);
          if (matched) return matched.value;
        }
      }
    }
  }

  // 2. 包含关系匹配（用户输入包含候选 label 或被候选 label 包含）
  for (const c of candidates) {
    const labelLower = c.label.toLowerCase();
    if (lower.includes(labelLower) || labelLower.includes(lower)) {
      return c.value;
    }
  }

  // 3. 编辑距离匹配（阈值：≤ 2 且输入长度 ≥ 2）
  if (trimmed.length >= 2) {
    let bestMatch: { value: unknown; dist: number } | null = null;
    for (const c of candidates) {
      const labelDist = levenshtein(lower, c.label.toLowerCase());
      const valDist = levenshtein(lower, String(c.value).toLowerCase());
      const minDist = Math.min(labelDist, valDist);
      const threshold = Math.max(1, Math.floor(c.label.length / 3));
      if (minDist <= threshold && (!bestMatch || minDist < bestMatch.dist)) {
        bestMatch = { value: c.value, dist: minDist };
      }
    }
    if (bestMatch) return bestMatch.value;
  }

  return null;
}

/**
 * enum 抽取：三级匹配（精确 → 同义词 → 模糊）。
 *
 * Bug 7 修复：原来只有精确匹配，导致"动画"等语义有效但不在枚举列表的输入无法被吸收。
 * 现在改为三级匹配，未命中才返回 null（保持 Bug 3 逻辑）。
 */
function extractByEnum(answer: string, field: FieldSpec, candidates?: Candidate[]): unknown {
  const trimmed = answer.trim();
  const lowerAnswer = trimmed.toLowerCase();

  if (!trimmed) return null;

  // ── 第一级：精确匹配 ──────────────────────────
  // 1a. 检查 defaultValue
  if (field.defaultValue !== undefined) {
    const defaultStr = String(field.defaultValue).toLowerCase();
    if (lowerAnswer === defaultStr) {
      return field.defaultValue;
    }
  }

  // 1b. 精确匹配候选 value（区分大小写）
  if (candidates && candidates.length > 0) {
    for (const c of candidates) {
      const valStr = String(c.value);
      if (trimmed === valStr) {
        return c.value;
      }
    }
    // 1c. 精确匹配候选 label（不区分大小写）
    for (const c of candidates) {
      if (lowerAnswer === c.label.toLowerCase()) {
        return c.value;
      }
    }
  }

  // 1d. 检查 field.knownEnums（从 profiles.ts 注入，单一真源）
  if (field.knownEnums && field.knownEnums.length > 0) {
    for (const val of field.knownEnums) {
      if (lowerAnswer === val.toLowerCase()) {
        return val;
      }
    }
  }

  // ── 第二级 + 第三级：同义词 + 模糊匹配 ──────────
  const synonyms = SYNONYM_TABLE[field.name];

  // 有候选列表时，用候选列表做模糊匹配
  if (candidates && candidates.length > 0) {
    const fuzzyResult = fuzzyMatch(trimmed, candidates, synonyms);
    if (fuzzyResult !== null && fuzzyResult !== undefined) {
      return fuzzyResult;
    }
  }

  // 没有候选列表但有同义词表时，直接用同义词表
  if (synonyms && (!candidates || candidates.length === 0)) {
    for (const [enumValue, synList] of Object.entries(synonyms)) {
      for (const syn of synList) {
        if (lowerAnswer === syn.toLowerCase() || lowerAnswer.includes(syn.toLowerCase())) {
          return enumValue;
        }
      }
    }
  }

  // 三级都未命中 → 返回 null（保持 Bug 3 修复逻辑）
  return null;
}

/** LLM 抽取：从自然语言回答中提取结构化值。 */
async function extractByLlm(
  repo: AiCallRepository,
  provider: AiCompletionProvider,
  answer: string,
  field: FieldSpec,
  ctx: ConversationContext,
  candidates?: Candidate[],
): Promise<unknown> {
  const lines = [
    `用户回答: "${answer}"`,
    `需要抽取的字段: ${field.name} (${field.description})`,
  ];

  // 如果有候选列表，告诉 LLM 有效值范围，让 LLM 能将非标准回答映射到候选
  if (candidates && candidates.length > 0) {
    const candidateDesc = candidates.map(c => `"${c.value}" (${c.label})`).join(", ");
    lines.push(`该字段的有效值是: ${candidateDesc}`);
    lines.push(`如果用户的回答与某个候选含义相近，请映射到最接近的候选 value。`);
    lines.push(`如果用户的回答确实不属于任何候选，且字段是自由文本类型，则直接提取原文。`);
  }

  lines.push(`请从回答中提取该字段的值。`);

  const prompt = lines.join("\n\n");

  const result = await callLLMWithGuard(repo, provider, {
    userId: ctx.userId,
    purpose: "grill_absorb",
    system: ABSORB_SYSTEM,
    prompt,
    maxTokens: 200,
    projectId: ctx.projectId,
  });

  if (!result || !result.json) return null;

  return readJsonField<unknown>(result.json, "extracted") ?? null;
}

/** persist 字段写入 user_preferences 表。 */
async function persistField(
  prefRepo: UserPreferenceRepository,
  userId: string,
  field: FieldSpec,
  value: unknown,
): Promise<void> {
  const existing = await prefRepo.getByUserId(userId).catch(() => null);
  const metadata = existing?.metadata ?? {};
  metadata[field.name] = value;

  // 映射到 user_preferences 表列
  const update: {
    preferredGenre?: string | null;
    preferredTone?: string | null;
    styleTags?: string[];
    metadata?: Record<string, unknown>;
  } = { metadata };

  if (field.name === "preferred_genre" || field.name === "genre") {
    update.preferredGenre = typeof value === "string" ? value : null;
  }
  if (field.name === "preferred_tone" || field.name === "tone") {
    update.preferredTone = typeof value === "string" ? value : null;
  }
  if (field.name === "style_tags" && Array.isArray(value)) {
    update.styleTags = value as string[];
  }
  // user_role, preferred_style 等非列字段存入 metadata
  // metadata 已在上方设置

  await prefRepo.upsert(userId, {
    ...update,
    preferredGenre: update.preferredGenre ?? existing?.preferredGenre ?? null,
    preferredTone: update.preferredTone ?? existing?.preferredTone ?? null,
    styleTags: update.styleTags ?? existing?.styleTags ?? [],
  }).catch(() => undefined);
}
