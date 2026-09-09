/**
 * GrillEngineImpl —— Grill Engine 主引擎实现（阶段 1）
 *
 * 来源：grill-engine-design.md §2.2 + §8 阶段 1。
 * 串联所有组件：RulePreChecker → SemanticSufficiencyEvaluator → ClarificationGenerator / CandidateGenerator → absorb。
 *
 * 成本控制路径：
 * 1. rulePreCheck (0 LLM) → sufficient = execute
 * 2. rulePreCheck → insufficient (critical 缺失) = clarify (LLM 生成问题, 超限降级到纯代码)
 * 3. rulePreCheck → needs_llm = SemanticSufficiencyEvaluator (1 LLM)
 *    3a. sufficient = execute (填入推断值)
 *    3b. insufficient = CandidateGenerator (首轮预置 0 LLM; 后续轮 LLM 动态生成)
 *    3c. 无候选 = clarify
 *
 * 计数器：达 maxClarifications 后不再 clarify，降级到 offer_candidates 或 execute（用默认值）。
 */

import type {
  AiCallRepository,
  AiCompletionProvider,
} from "../../ai/types.js";
import { rulePreCheck, stage0CheckBridge } from "./rule_precheck.js";
import { ClarificationCounter } from "./counter.js";
import { evaluateSemanticSufficiency } from "./semantic_eval.js";
import { generateClarification } from "./clarification.js";
import { generateCandidates } from "./candidate.js";
import { absorbAnswer, type UserPreferenceRepository } from "./absorb.js";
import { enumValueToLabel } from "./profiles.js";
import type {
  Candidate,
  ConversationContext,
  FieldSpec,
  GrillAbsorbResult,
  GrillCheckResult,
  TaskProfile,
  TaskType,
} from "./types.js";

export interface GrillEngineDeps {
  aiCallRepo: AiCallRepository;
  provider: AiCompletionProvider;
  prefRepo: UserPreferenceRepository;
}

/**
 * 进程级单例计数器。
 *
 * ClarificationCounter 必须在请求间持久化，否则每次 HTTP 请求创建新的
 * GrillService/GrillEngineImpl 会让计数器归零，永远无法达到 maxClarifications。
 * 改为模块级单例，所有 GrillEngineImpl 实例共享同一个计数器。
 */
const sharedCounter = new ClarificationCounter();

export class GrillEngineImpl {
  private readonly counter = sharedCounter;

  constructor(private readonly deps: GrillEngineDeps) {}

  /**
   * check()：判断当前上下文信息是否充分，决定执行/反问/给候选。
   */
  async check(
    profile: TaskProfile,
    intent: string,
    ctx: ConversationContext,
    opts?: { isVague?: boolean },
  ): Promise<GrillCheckResult> {
    // 0. 从 intent 中预提取枚举字段（0 LLM）
    // Bug 修复：用户首次说"帮我生成一张图片"时，content_type=image 应被自动提取，
    // 而不是从第1轮开始反问"你的内容类型是什么"。
    // G4: vague 意图跳过 preExtractFromIntent（不预提取字段），直接从第一个 critical 字段开始反问
    if (!opts?.isVague) {
      this.preExtractFromIntent(profile, intent, ctx);
    }

    // 1. 规则预检（0 LLM）
    const preCheck = rulePreCheck(profile, ctx);

    if (preCheck.conclusion === "sufficient") {
      // 规则判定充分 → 进入待确认状态
      return this.buildPendingConfirmation(profile, ctx);
    }

    if (preCheck.conclusion === "insufficient") {
      // critical 缺失 → 需要反问
      return this.handleClarify(profile, intent, ctx, preCheck.missingCritical[0]!);
    }

    // needs_llm：preferred 缺失
    const missingFields = preCheck.missingPreferred
      .map((name) => profile.requiredFields.find((f) => f.name === name))
      .filter((f): f is FieldSpec => f !== undefined);

    // registration profile：不允许自动推断，逐个反问直到所有 requiredFields 收集完毕。
    // 只有用户显式说"你来猜"时才走推断路径（通过 intent 中的关键词检测）。
    const isRegistration = profile.taskType === "registration";
    const userOptsInInference = /你来猜|你来推断|随便|都行|你来定|帮我填/u.test(intent);

    if (!isRegistration || userOptsInInference) {
      // content_creation 或用户显式 opt-in：用 LLM 判断能否推断
      const semanticResult = await evaluateSemanticSufficiency(
        this.deps.aiCallRepo,
        this.deps.provider,
        intent,
        missingFields,
        ctx,
      );

      if (semanticResult.conclusion === "sufficient") {
        // 可推断 → 填入推断值后进入待确认状态
        // G10: 把 LLM 推断的字段值写入 ephemeralFields，并标记来源为 inferred
        if (semanticResult.inferred && Object.keys(semanticResult.inferred).length > 0) {
          if (!ctx.ephemeralFields) {
            (ctx as { ephemeralFields: Record<string, unknown> }).ephemeralFields = {};
          }
          if (!ctx.fieldSources) {
            (ctx as { fieldSources: Record<string, import("./types.js").FieldSource> }).fieldSources = {};
          }
          for (const [k, v] of Object.entries(semanticResult.inferred)) {
            if (ctx.ephemeralFields![k] === undefined || ctx.ephemeralFields![k] === null || ctx.ephemeralFields![k] === "") {
              ctx.ephemeralFields![k] = v;
              ctx.fieldSources![k] = "inferred";
            }
          }
        }
        return this.buildPendingConfirmation(profile, ctx);
      }
    }

    // registration 未收集全 requiredFields（且用户未显式 opt-in）→ 逐个反问下一个缺失字段
    // content_creation 在 LLM 判定不可推断时也走反问路径
    const targetField = missingFields[0]!;
    return this.handleClarify(profile, intent, ctx, targetField.name);
  }

  /**
   * absorb()：从用户回答中抽取值并更新上下文。
   * 调用方需传入与 check() 相同的 profile。
   */
  async absorb(
    profile: TaskProfile,
    answer: string,
    targetFieldName: string,
    ctx: ConversationContext,
  ): Promise<GrillAbsorbResult> {
    const field = profile.requiredFields.find((f) => f.name === targetFieldName);
    if (!field) {
      return { extracted: answer, updatedCtx: ctx };
    }

    return absorbAnswer(
      this.deps.aiCallRepo,
      this.deps.provider,
      this.deps.prefRepo,
      answer,
      field,
      ctx,
      profile.fallbackCandidates?.[targetFieldName],
    );
  }

  // ── G3: 定向修正已填字段 ────────────────────────────────

  /**
   * G3: 直接修改 ephemeralFields 中的指定字段值。
   *
   * 用户在澄清状态中说"content_type 改成视频"或"改成视频"时，
   * 识别要修改的字段名和新值，直接更新 ephemeralFields，
   * 然后重新 check() 评估充分性。
   *
   * @returns 更新后的 ctx（ephemeralFields 已修改）
   */
  amendField(
    profile: TaskProfile,
    fieldName: string,
    newValue: unknown,
    ctx: ConversationContext,
  ): ConversationContext {
    // 验证字段存在于 profile
    const field = profile.requiredFields.find((f) => f.name === fieldName);
    if (!field) return ctx;

    // 如果是 enum 字段，验证新值在 knownEnums 中
    if (field.extractor === "enum" && field.knownEnums && field.knownEnums.length > 0) {
      if (!field.knownEnums.includes(String(newValue))) return ctx;
    }

    if (!ctx.ephemeralFields) {
      (ctx as { ephemeralFields: Record<string, unknown> }).ephemeralFields = {};
    }
    ctx.ephemeralFields![fieldName] = newValue;
    // G10: amend 后标记来源为 user（用户主动修改）
    if (!ctx.fieldSources) {
      (ctx as { fieldSources: Record<string, import("./types.js").FieldSource> }).fieldSources = {};
    }
    ctx.fieldSources![fieldName] = "user";
    return ctx;
  }

  /**
   * G3: 从用户输入中识别要修正的字段名和新值。
   *
   * 识别逻辑：
   * 1. 字段名匹配：用户输入中的"内容类型""content_type""类型"等 → 映射到 FieldSpec.name
   * 2. 字段值匹配：用户输入中的"视频""video"等 → 映射到 fallbackCandidates 的 value
   * 3. 无字段名时（如"改成视频"）→ 尝试匹配所有已填字段，找到能匹配该值的字段更新
   *
   * @returns { fieldName, newValue } 或 null（无法识别）
   */
  parseAmendTarget(
    profile: TaskProfile,
    userInput: string,
    ctx: ConversationContext,
  ): { fieldName: string; newValue: string } | null {
    const lower = userInput.trim().toLowerCase();
    if (!lower) return null;

    // 1. 尝试从输入中识别字段名
    const fieldNameAliases: Record<string, string[]> = {
      content_type: ["content_type", "内容类型", "类型", "媒体类型", "形式"],
      subject_or_theme: ["subject_or_theme", "主题", "题材", "方向", "故事"],
      style_or_tone: ["style_or_tone", "风格", "调性", "风格调性", "画风"],
      constraints: ["constraints", "约束", "时长", "尺寸", "规格", "限制"],
      user_role: ["user_role", "角色", "身份"],
      preferred_genre: ["preferred_genre", "偏好", "喜好"],
    };

    let identifiedField: string | null = null;
    for (const field of profile.requiredFields) {
      const aliases = fieldNameAliases[field.name] ?? [field.name, field.description];
      if (aliases.some((alias) => lower.includes(alias.toLowerCase()))) {
        identifiedField = field.name;
        break;
      }
    }

    // 2. 尝试从输入中识别字段值（遍历所有字段的 fallbackCandidates）
    let identifiedValue: string | null = null;
    let valueFieldName: string | null = null;

    for (const field of profile.requiredFields) {
      const candidates = profile.fallbackCandidates?.[field.name];
      if (!candidates) continue;
      for (const c of candidates) {
        const labelLower = c.label.toLowerCase();
        const valLower = String(c.value).toLowerCase();
        if (lower.includes(labelLower) || lower.includes(valLower)) {
          identifiedValue = String(c.value);
          valueFieldName = field.name;
          break;
        }
      }
      if (identifiedValue) break;
    }

    // 3. 组合结果
    if (identifiedField && identifiedValue) {
      // 明确指定了字段名和值
      return { fieldName: identifiedField, newValue: identifiedValue };
    }

    if (identifiedField && !identifiedValue) {
      // 有字段名但没识别到值 → 取输入中字段名后面的文本作为值
      const aliases = fieldNameAliases[identifiedField] ?? [identifiedField];
      for (const alias of aliases) {
        const idx = lower.indexOf(alias.toLowerCase());
        if (idx >= 0) {
          const after = userInput.slice(idx + alias.length).trim();
          // 去掉前导的"改成""改为""换为"等修正词
          const cleaned = after.replace(/^(改成|改为|换成|换为|改为|修改为|改成|→|:|：|\s)+/u, "").trim();
          if (cleaned) {
            return { fieldName: identifiedField, newValue: cleaned };
          }
        }
      }
    }

    if (!identifiedField && identifiedValue && valueFieldName) {
      // 无字段名但识别到了值 → 用值匹配到的字段
      return { fieldName: valueFieldName, newValue: identifiedValue };
    }

    // 4. 无字段名且有值 → 尝试匹配已填字段
    if (!identifiedField && identifiedValue) {
      for (const field of profile.requiredFields) {
        const existing = ctx.ephemeralFields?.[field.name];
        if (existing !== undefined && existing !== null && existing !== "") {
          return { fieldName: field.name, newValue: identifiedValue };
        }
      }
    }

    return null;
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 获取指定字段的反问次数。
   */
  getFieldCount(userId: string, taskType: TaskType, targetField: string): number {
    return this.counter.getFieldCount(userId, taskType, targetField);
  }

  /**
   * 重置指定字段的反问计数（成功 absorb 该字段后调用）。
   */
  resetField(userId: string, taskType: TaskType, targetField: string): void {
    this.counter.resetField(userId, taskType, targetField);
  }

  /**
   * 重置所有字段反问计数器（用户主动确认执行时调用）。
   */
  resetCounter(userId: string, taskType: TaskType): void {
    this.counter.reset(userId, taskType);
  }

  /**
   * 递增主题细化深度。
   */
  incrementSubjectDepth(userId: string, taskType: TaskType): number {
    return this.counter.incrementSubjectDepth(userId, taskType);
  }

  /**
   * 获取当前总轮次。
   */
  getTotalRounds(userId: string, taskType: TaskType): number {
    return this.counter.getState(userId, taskType).totalRounds;
  }

  // ── P1-3: 计数器持久化集成 ──

  /**
   * 从 DB 恢复计数器状态。
   * 在 check()/absorb() 操作前由 service 层调用，确保进程重启后计数不丢失。
   */
  restoreCounter(userId: string, taskType: TaskType, data: Record<string, unknown> | null): void {
    this.counter.restore(userId, taskType, data);
  }

  /**
   * 序列化计数器状态用于持久化到 DB。
   * 在 check()/absorb() 操作后由 service 层调用，将计数器状态写入 clarificationState。
   */
  serializeCounter(userId: string, taskType: TaskType): Record<string, unknown> {
    return this.counter.serialize(userId, taskType);
  }

  private async handleClarify(
    profile: TaskProfile,
    intent: string,
    ctx: ConversationContext,
    targetFieldName: string,
  ): Promise<GrillCheckResult> {
    // 检查单字段反问上限 + 总轮次上限（Bug 1）
    // 先检查 canClarify，如果未达上限继续反问；达上限才降级到候选
    const counterDecision = this.counter.canClarify(
      ctx.userId,
      profile.taskType,
      profile.maxClarifications,
      profile.maxTotalRounds,
      targetFieldName,
    );

    if (counterDecision.decision === "limit_reached") {
      // 单字段反问达上限 → 降级到候选（禁止空候选）
      this.counter.recordRound(ctx.userId, profile.taskType);
      const targetField = profile.requiredFields.find((f) => f.name === targetFieldName);
      if (targetField) {
        const candidates = await generateCandidates(
          this.deps.aiCallRepo,
          this.deps.provider,
          profile,
          targetField,
          intent,
          ctx.userId,
          ctx,
        );
        // Bug 4: 候选必须 2-4 个具名候选，禁止空多选
        const validCandidates = this.ensureCandidates(candidates, profile, targetField);
        if (validCandidates.length >= 2) {
          return { action: "offer_candidates", candidates: validCandidates, targetField: targetFieldName };
        }
      }
      // 无候选也达上限 → 尝试下一个缺失维度，若全部缺失维度都达上限则进入待确认
      return this.tryNextMissingFieldOrPending(profile, intent, ctx, targetFieldName);
    }

    // 检查主题细化深度（防止无限递归细化）
    if (this.isSubjectField(targetFieldName)) {
      const depth = this.counter.getSubjectDepth(ctx.userId, profile.taskType);
      if (depth >= profile.maxSubjectDepth) {
        // 主题已细化到上限 → 不再细化，转问其他维度或进入待确认
        return this.tryNextMissingFieldOrPending(profile, intent, ctx, targetFieldName);
      }
    }

    // 记录反问（先递增轮次，使轮次从1开始）
    this.counter.recordClarification(ctx.userId, profile.taskType, targetFieldName);

    const targetField = profile.requiredFields.find((f) => f.name === targetFieldName);
    if (!targetField) {
      // 阶段 0 兜底
      const preCheck = rulePreCheck(profile, ctx);
      return stage0CheckBridge(profile, preCheck, ctx);
    }

    // 获取字段候选（用于辅助生成反问话术）
    const fieldCandidates = await generateCandidates(
      this.deps.aiCallRepo,
      this.deps.provider,
      profile,
      targetField,
      intent,
      ctx.userId,
      ctx,
    );

    // 生成纯文本反问（先反问，不直接给候选）
    const currentRound = this.counter.getState(ctx.userId, profile.taskType).totalRounds;
    const clarification = await generateClarification(
      this.deps.aiCallRepo,
      this.deps.provider,
      intent,
      targetField,
      ctx,
      ctx.userId,
      fieldCandidates ?? undefined,
      currentRound,
    );

    return {
      action: "clarify",
      question: clarification.question,
      targetField: clarification.targetField,
    };
  }

  /**
   * Bug 4: 确保候选列表非空且 2-4 个具名候选。
   * 如果 LLM 生成的候选不足 2 个，用 profile 预置候选补齐。
   */
  private ensureCandidates(
    candidates: Candidate[] | null,
    profile: TaskProfile,
    field: FieldSpec,
  ): Candidate[] {
    const result: Candidate[] = [];
    if (candidates) {
      result.push(...candidates);
    }
    // 如果候选不足 2 个，用预置候选补齐
    if (result.length < 2) {
      const preset = profile.fallbackCandidates?.[field.name];
      if (preset) {
        for (const p of preset) {
          if (result.length >= 2) break;
          if (!result.some((r) => r.label === p.label)) {
            result.push(p);
          }
        }
      }
    }
    return result.slice(0, Math.max(2, Math.min(4, result.length)));
  }

  /**
   * Bug 5: 当前字段达上限后，尝试询问下一个缺失维度。
   * 如果所有缺失维度都达上限，进入待确认状态。
   */
  private async tryNextMissingFieldOrPending(
    profile: TaskProfile,
    intent: string,
    ctx: ConversationContext,
    exhaustedField: string,
  ): Promise<GrillCheckResult> {
    const preCheck = rulePreCheck(profile, ctx);
    const allMissing = [
      ...(preCheck.conclusion === "insufficient" ? preCheck.missingCritical : []),
      ...(preCheck.conclusion === "needs_llm" ? preCheck.missingPreferred : []),
    ].filter((f) => f !== exhaustedField);

    // 尝试下一个未达上限的缺失字段
    for (const fieldName of allMissing) {
      const decision = this.counter.canClarify(
        ctx.userId,
        profile.taskType,
        profile.maxClarifications,
        profile.maxTotalRounds,
        fieldName,
      );
      if (decision.decision === "allow") {
        // 递归调用 handleClarify 处理下一个字段
        return this.handleClarify(profile, intent, ctx, fieldName);
      }
    }

    // 所有缺失字段都达上限 → 进入待确认（用默认值兜底）
    return this.checkPendingConfirmation(profile, ctx);
  }

  /** 判断是否是主题类字段（需要限制细化深度）。 */
  private isSubjectField(fieldName: string): boolean {
    return (
      fieldName === "subject_or_theme" ||
      fieldName === "preferred_genre" ||
      fieldName.includes("theme") ||
      fieldName.includes("subject")
    );
  }

  /** 收集已填充的字段名列表。 */
  private collectFields(profile: TaskProfile, ctx: ConversationContext): string[] {
    const collected: string[] = [];
    for (const field of profile.requiredFields) {
      const val = ctx.ephemeralFields?.[field.name];
      if (val !== undefined && val !== null && val !== "") {
        collected.push(`${field.description}: ${val}`);
      } else if (field.defaultValue) {
        collected.push(`${field.description}: ${field.defaultValue}（推断）`);
      }
    }
    return collected;
  }

  /**
   * G10: 构建待确认状态输出，区分用户提供 vs 引擎推断。
   *
   * 输出格式：
   *   你提供的：
   *     ①内容类型=视频 ②主题=平淡生活
   *   引擎推断（可直接修改）：
   *     ③风格=由主题推断 ④规格=标准规格
   *   （推断项如需修改请直接说明，如"改成轻松风格"）
   */
  private buildPendingConfirmation(
    profile: TaskProfile,
    ctx: ConversationContext,
  ): GrillCheckResult {
    const userFields: string[] = [];
    const inferredFields: string[] = [];
    let idx = 0;
    let infIdx = 0;

    for (const field of profile.requiredFields) {
      const val = ctx.ephemeralFields?.[field.name];
      const source = ctx.fieldSources?.[field.name];
      const rawVal = (val !== undefined && val !== null && val !== "")
        ? val
        : field.defaultValue;

      if (rawVal === undefined || rawVal === null || rawVal === "") continue;

      // 枚举值映射为中文标签，禁止显示英文
      const displayVal = enumValueToLabel(profile.taskType, field.name, String(rawVal));

      if (source === "user") {
        idx++;
        userFields.push(`${this.toCircledNumber(idx)}${field.description}=${displayVal}`);
      } else if (source === "inferred") {
        infIdx++;
        inferredFields.push(`${this.toCircledNumber(idx + infIdx)}${field.description}=${displayVal}`);
      } else if (source === "default") {
        infIdx++;
        inferredFields.push(`${this.toCircledNumber(idx + infIdx)}${field.description}=${displayVal}`);
      } else {
        // 无 source 标记：有值视为 user，有 defaultValue 视为 default
        if (val !== undefined && val !== null && val !== "") {
          idx++;
          userFields.push(`${this.toCircledNumber(idx)}${field.description}=${displayVal}`);
        } else {
          infIdx++;
          inferredFields.push(`${this.toCircledNumber(idx + infIdx)}${field.description}=${displayVal}`);
        }
      }
    }

    // 构建 summary
    const parts: string[] = [];
    if (userFields.length > 0) {
      parts.push(`你提供的：\n  ${userFields.join("  ")}`);
    }
    if (inferredFields.length > 0) {
      parts.push(`引擎推断（可直接修改）：\n  ${inferredFields.join("  ")}`);
    }
    if (inferredFields.length > 0) {
      parts.push('（推断项如需修改请直接说明，如"改成轻松风格"）');
    }

    // collectedFields 兼容旧格式
    const collectedFields = this.collectFields(profile, ctx);

    return {
      action: "pending_confirmation",
      summary: `信息已充分，请确认执行。\n${parts.join("\n")}`,
      collectedFields,
    };
  }

  /** G10: 数字转圆圈数字（①②③...⑩），超过10用方括号 [11]。 */
  private toCircledNumber(n: number): string {
    const circles = ["①","②","③","④","⑤","⑥","⑦","⑧","⑨","⑩"];
    if (n >= 1 && n <= 10) return circles[n - 1]!;
    return `[${n}]`;
  }

  /**
   * 从原始 intent 文本中预提取枚举字段值（0 LLM）。
   *
   * Bug 修复：用户首次说"帮我生成一张图片"时，content_type=image 应被自动提取，
   * 而不是从第1轮开始反问"你的内容类型是什么"。
   *
   * 逻辑：对 profile 中 extractor="enum" 且有 fallbackCandidates 的字段，
   * 用候选 label/value 做关键字匹配（includes），命中则填入 ephemeralFields。
   * 只填充尚未填充的字段，不覆盖已有值。
   */
  private preExtractFromIntent(
    profile: TaskProfile,
    intent: string,
    ctx: ConversationContext,
  ): void {
    if (!intent || !intent.trim()) return;
    const lower = intent.trim().toLowerCase();

    for (const field of profile.requiredFields) {
      // 只处理 enum 类型字段
      if (field.extractor !== "enum") continue;
      // 已有值则跳过
      const existing = ctx.ephemeralFields?.[field.name];
      if (existing !== undefined && existing !== null && existing !== "") continue;

      const candidates = profile.fallbackCandidates?.[field.name];
      if (!candidates || candidates.length === 0) continue;

      // G8: 多重匹配 → 收集所有命中候选+位置，取最后出现的
      // 用户通常最后说的是真实意图，如"不像图片的短视频" → 同时匹配 image(位置0) + video(位置靠后) → 取 video
      let bestCandidate: typeof candidates[number] | null = null;
      let bestPos = -1;

      for (const c of candidates) {
        const labelLower = c.label.toLowerCase();
        const valLower = String(c.value).toLowerCase();
        // intent 包含 label 或 value（如 "图片" in "帮我生成一张图片"）
        const labelPos = lower.indexOf(labelLower);
        const valPos = lower.indexOf(valLower);
        // 取 label 和 value 中更靠后的位置
        const matchPos = Math.max(
          labelPos >= 0 ? labelPos : -1,
          valPos >= 0 ? valPos : -1,
        );
        if (matchPos >= 0 && matchPos > bestPos) {
          bestPos = matchPos;
          bestCandidate = c;
        }
      }

      if (bestCandidate) {
        if (!ctx.ephemeralFields) {
          (ctx as { ephemeralFields: Record<string, unknown> }).ephemeralFields = {};
        }
        ctx.ephemeralFields![field.name] = bestCandidate.value;
        // G10: 标记来源为 user（从用户原话提取）
        if (!ctx.fieldSources) {
          (ctx as { fieldSources: Record<string, import("./types.js").FieldSource> }).fieldSources = {};
        }
        ctx.fieldSources![field.name] = "user";
      }
    }
  }

  /** 检查信息是否已充分到可以进入待确认状态。 */
  private checkPendingConfirmation(
    profile: TaskProfile,
    ctx: ConversationContext,
  ): GrillCheckResult {
    const collectedFields = this.collectFields(profile, ctx);
    if (collectedFields.length > 0) {
      return this.buildPendingConfirmation(profile, ctx);
    }
    return { action: "execute" };
  }
}
