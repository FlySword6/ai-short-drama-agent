/**
 * GrillService —— assistant 模块与 grill 模块的桥接服务
 *
 * 来源：grill-engine-design.md §3 + §8 阶段 1 步骤 1.8。
 * 职责：
 * - 检查 GRILL_ENABLED feature flag
 * - 构造 ConversationContext 从 AssistantSession
 * - 调用 GrillEngineImpl.check() / absorb()
 * - 持久化 clarificationState 到 agent_sessions 表
 * - 将 GrillCheckResult 转为 HTTP 响应格式
 */

import { settings } from "../../../config/env.js";
import { GrillEngineImpl, type GrillEngineDeps } from "./engine.js";
import { getTaskProfile, enumValueToLabel } from "./profiles.js";
import { aiGatewayAsProvider } from "./callLLMWithGuard.js";
import type { AiCallRepository } from "../../ai/types.js";
import type { AiGatewayService } from "../../ai/service.js";
import type { AssistantRepository } from "../repository.js";
import type { UserPreferenceRepository } from "./absorb.js";
import type {
  ConversationContext,
  GrillCheckResult,
  TaskProfile,
  TaskType,
} from "./types.js";

export interface GrillServiceDeps {
  aiCallRepo: AiCallRepository;
  gateway: Pick<AiGatewayService, "completeValidated">;
  assistantRepo: AssistantRepository;
  prefRepo: UserPreferenceRepository;
}

export class GrillService {
  private engine: GrillEngineImpl | null = null;

  constructor(private readonly deps: GrillServiceDeps) {}

  private provider() {
    return aiGatewayAsProvider(this.deps.gateway);
  }

  private getEngine(): GrillEngineImpl {
    if (!this.engine) {
      const provider = this.provider();
      const engineDeps: GrillEngineDeps = {
        aiCallRepo: this.deps.aiCallRepo,
        provider,
        prefRepo: this.deps.prefRepo,
      };
      this.engine = new GrillEngineImpl(engineDeps);
    }
    return this.engine;
  }

  /**
   * 检查是否启用了 Grill Engine。
   */
  isEnabled(): boolean {
    return settings.grillEnabled;
  }

  /** 判断是否是主题类字段。 */
  private isSubjectField(fieldName: string): boolean {
    return (
      fieldName === "subject_or_theme" ||
      fieldName === "preferred_genre" ||
      fieldName.includes("theme") ||
      fieldName.includes("subject")
    );
  }

  /**
   * 获取 TaskProfile。
   */
  getProfile(taskType: TaskType): TaskProfile | undefined {
    return getTaskProfile(taskType);
  }

  /**
   * 重置反问计数器（用户主动确认执行或开始新对话时调用）。
   */
  resetClarificationCounter(userId: string, taskType: TaskType): void {
    this.getEngine().resetCounter(userId, taskType);
  }

  /**
   * 获取当前总交互轮次。
   */
  getTotalRounds(userId: string, taskType: TaskType): number {
    return this.getEngine().getTotalRounds(userId, taskType);
  }

  /**
   * 格式化轮次标注 [第N轮]。不设总轮次上限。
   */
  formatRoundAnnotation(userId: string, taskType: TaskType): string {
    return `[第${this.getTotalRounds(userId, taskType)}轮]`;
  }

  /**
   * 构造 ConversationContext。
   */
  buildContext(
    userId: string,
    projectId: string | undefined,
    clarificationState: Record<string, unknown> | null,
  ): ConversationContext {
    const ephemeralFields = (clarificationState?.ephemeralFields as Record<string, unknown>) ?? {};
    const fieldSources = (clarificationState?.fieldSources as Record<string, import("./types.js").FieldSource>) ?? {};
    return {
      userId,
      projectId,
      ephemeralFields,
      fieldSources,
      clarificationState: clarificationState as unknown as ConversationContext["clarificationState"],
    };
  }

  /**
   * content_creation: 把用户已有偏好注入 ctx.metadata，供反问话术和候选生成引用。
   * check() 和 absorb() 都必须调用，否则后续轮次会丢失偏好。
   * 如果用户已经明确表示"换一个"，清除偏好 hints，不再反复提及。
   */
  private async injectPreferenceHints(
    taskType: TaskType,
    userId: string,
    ctx: ConversationContext,
  ): Promise<void> {
    if (taskType !== "content_creation") return;

    // 如果用户已明确拒绝偏好（说"换一个"等），不再注入
    const cs = ctx.clarificationState as unknown as Record<string, unknown> | null;
    if (cs?.preferenceRejected === true) {
      return;
    }

    const prefs = await this.deps.prefRepo.getByUserId(userId);
    if (!prefs) return;
    const hints: string[] = [];
    if (prefs.preferredGenre) hints.push(`题材偏好=${enumValueToLabel("registration", "preferred_genre", prefs.preferredGenre)}`);
    if (prefs.preferredTone) hints.push(`基调偏好=${prefs.preferredTone}`);
    if (hints.length > 0) {
      const meta = ctx.metadata ?? (ctx.metadata = {});
      meta.preferenceHints = hints.join("，");
    }
  }

  /**
   * 执行 check() 并持久化 clarificationState。
   */
  async check(
    taskType: TaskType,
    intent: string,
    sessionId: string,
    userId: string,
    projectId?: string,
    opts?: { isVague?: boolean },
  ): Promise<GrillCheckResult & { profile: TaskProfile } | null> {
    if (!this.isEnabled()) return null;

    const profile = this.getProfile(taskType);
    if (!profile) return null;

    const session = await this.deps.assistantRepo.getSession(userId, sessionId);
    const ctx = this.buildContext(userId, projectId, session.clarificationState);

    // Bug 8-4: 只有当前 session 有活跃的 grill 任务时才从 DB 恢复计数器。
    // 如果 lastAction 不是 clarify/offer_candidates/pending_confirmation，
    // 说明没有活跃的 grill 流程，不应恢复旧计数器（避免残留 [第2轮] 状态）。
    const cs = session.clarificationState as Record<string, unknown> | null;
    const lastAction = cs?.lastAction as string | undefined;
    const hasActiveGrill =
      lastAction === "clarify" ||
      lastAction === "offer_candidates" ||
      lastAction === "pending_confirmation";
    if (hasActiveGrill) {
      const counterData = cs?.counterState as Record<string, unknown> | null;
      this.getEngine().restoreCounter(userId, taskType, counterData);
    } else {
      // 无活跃 grill → 重置计数器，避免残留
      this.getEngine().resetCounter(userId, taskType);
    }

    // content_creation: 把用户已有偏好传入 ctx，供反问话术引用
    await this.injectPreferenceHints(taskType, userId, ctx);

    const result = await this.getEngine().check(profile, intent, ctx, opts);

    // P1-3: check 后序列化计数器状态，持久化到 DB
    const serializedCounter = this.getEngine().serializeCounter(userId, taskType);

    // 持久化 clarificationState（记录当前反问状态）
    // offer_candidates 也需要记录 targetField，以便用户选择后能正确 absorb
    const targetFieldToStore =
      result.action === "clarify"
        ? result.targetField
        : result.action === "offer_candidates"
          ? result.targetField
          : undefined;
    await this.deps.assistantRepo.updateClarificationState(sessionId, {
      ephemeralFields: ctx.ephemeralFields,
      fieldSources: ctx.fieldSources,
      lastAction: result.action,
      targetField: targetFieldToStore,
      taskType,
      intent,
      projectId,
      originalIntent: (session.clarificationState as Record<string, unknown> | null)?.originalIntent ?? intent.trim(),
      counterState: serializedCounter,
    });

    return { ...result, profile };
  }

  /**
   * 执行 absorb() 并持久化更新后的 clarificationState。
   */
  async absorb(
    taskType: TaskType,
    answer: string,
    targetFieldName: string,
    sessionId: string,
    userId: string,
    projectId?: string,
  ): Promise<{ extracted: unknown; nextAction: GrillCheckResult } | null> {
    if (!this.isEnabled()) return null;

    const profile = this.getProfile(taskType);
    if (!profile) return null;

    const session = await this.deps.assistantRepo.getSession(userId, sessionId);
    const ctx = this.buildContext(userId, projectId, session.clarificationState);

    // P1-3: absorb 前从 DB 恢复计数器状态
    const absorbCs = session.clarificationState as Record<string, unknown> | null;
    const absorbCounterData = absorbCs?.counterState as Record<string, unknown> | null;
    this.getEngine().restoreCounter(userId, taskType, absorbCounterData);

    // content_creation: absorb 也需注入偏好，否则后续轮次反问和候选丢失偏好
    await this.injectPreferenceHints(taskType, userId, ctx);

    const absorbResult = await this.getEngine().absorb(
      profile,
      answer,
      targetFieldName,
      ctx,
    );

    // P1-3: absorb 后序列化计数器状态，持久化到 DB
    const absorbCounterState = this.getEngine().serializeCounter(userId, taskType);

    // 持久化更新后的 ephemeralFields + 下一步动作
    const extractedFilled =
      absorbResult.extracted !== null &&
      absorbResult.extracted !== undefined &&
      absorbResult.extracted !== "";

    if (extractedFilled) {
      // 只重置该字段的计数，不影响其他字段已积累的反问次数
      this.getEngine().resetField(userId, taskType, targetFieldName);
      // 如果填充的是主题类字段，递增主题细化深度
      if (this.isSubjectField(targetFieldName)) {
        this.getEngine().incrementSubjectDepth(userId, taskType);
      }
    }

    // Bug 3: 用户输入与原输入相同或无有效新信息 → 视为未回答 → 触发多选兜底
    // 如果 absorb 没有抽取到有效值，且该字段反问次数已达上限，则强制走候选路径
    if (!extractedFilled) {
      const fieldCount = this.getEngine().getFieldCount(userId, taskType, targetFieldName);
      const bug3Profile = this.getProfile(taskType)!;
      if (fieldCount >= bug3Profile.maxClarifications) {
        // 达上限仍未回答 → 直接 offer_candidates（用预置候选兜底）
        const fieldSpec = bug3Profile.requiredFields.find((f) => f.name === targetFieldName);
        if (fieldSpec) {
          const { generateCandidates } = await import("./candidate.js");
          const provider = this.provider();
          const candidates = await generateCandidates(
            this.deps.aiCallRepo,
            provider,
            bug3Profile,
            fieldSpec,
            answer,
            userId,
            ctx,
          );
          // Bug 4: 确保候选非空
          const fallback = bug3Profile.fallbackCandidates?.[targetFieldName] ?? [];
          const validCandidates = (candidates && candidates.length > 0 ? candidates : fallback).slice(0, 4);
          if (validCandidates.length >= 2) {
            const nextAction: GrillCheckResult = {
              action: "offer_candidates",
              candidates: validCandidates,
              targetField: targetFieldName,
            };
            await this.deps.assistantRepo.updateClarificationState(sessionId, {
              ephemeralFields: absorbResult.updatedCtx.ephemeralFields,
              fieldSources: absorbResult.updatedCtx.fieldSources,
              lastAction: nextAction.action,
              targetField: nextAction.targetField,
              taskType,
              intent: answer,
              projectId,
              lastUserInput: answer.trim(),
              originalIntent: (session.clarificationState as Record<string, unknown> | null)?.originalIntent ?? answer.trim(),
              counterState: absorbCounterState,
            });
            return { extracted: absorbResult.extracted, nextAction };
          }
        }
      }
    }

    // 抽取后重新 check，决定下一步动作（Bug 5: 循环推进——询问下一个缺失维度）
    // 传入原始 intent 而非空字符串，确保语义评估器能基于用户原始意图判断充分性
    const storedIntent = (session.clarificationState as Record<string, unknown> | null)?.intent as string ?? answer;
    // 把偏好信息传递到 updatedCtx，确保下一轮反问和候选生成能引用
    if (ctx.metadata?.preferenceHints && !absorbResult.updatedCtx.metadata?.preferenceHints) {
      const meta = absorbResult.updatedCtx.metadata ?? (absorbResult.updatedCtx.metadata = {});
      meta.preferenceHints = ctx.metadata.preferenceHints;
    }
    const nextAction = await this.getEngine().check(profile, storedIntent, absorbResult.updatedCtx);

    // Bug 8-10: check() 内部 handleClarify 会调用 recordClarification 递增计数器，
    // 必须在 check() 之后重新序列化计数器，否则递增的轮次不会持久化，
    // 导致下次请求恢复旧计数器、canClarify 永远不返回 limit_reached（卡在反问循环）。
    const finalCounterState = this.getEngine().serializeCounter(userId, taskType);

    // 一次性持久化所有状态
    const nextTargetField =
      nextAction.action === "clarify"
        ? nextAction.targetField
        : nextAction.action === "offer_candidates"
          ? nextAction.targetField
          : undefined;
    await this.deps.assistantRepo.updateClarificationState(sessionId, {
      ephemeralFields: absorbResult.updatedCtx.ephemeralFields,
      fieldSources: absorbResult.updatedCtx.fieldSources,
      lastAction: nextAction.action,
      targetField: nextTargetField,
      taskType,
      intent: storedIntent,
      projectId,
      lastUserInput: answer.trim(),
      originalIntent: (session.clarificationState as Record<string, unknown> | null)?.originalIntent ?? answer.trim(),
      counterState: finalCounterState,
    });

    return { extracted: absorbResult.extracted, nextAction };
  }

  /**
   * 获取当前 session 的 clarificationState（用于意图路由上下文修正）。
   */
  async getClarificationState(
    sessionId: string,
    userId: string,
  ): Promise<{ lastAction?: string; targetField?: string; taskType?: string; intent?: string } | null> {
    const session = await this.deps.assistantRepo.getSession(userId, sessionId);
    return (session.clarificationState as Record<string, unknown> | null) as
      { lastAction?: string; targetField?: string; taskType?: string; intent?: string } | null;
  }

  /**
   * 清除 session 的 clarificationState（取消/主题切换时调用）。
   */
  async clearClarificationState(sessionId: string, _userId: string): Promise<void> {
    await this.deps.assistantRepo.updateClarificationState(sessionId, null);
  }

  /**
   * G3: 定向修正已填字段。
   *
   * 从用户输入中识别要修正的字段名和新值，
   * 直接修改 ephemeralFields，然后重新 check() 评估充分性。
   * 不重置轮次计数器。
   */
  async amendField(
    taskType: TaskType,
    userInput: string,
    sessionId: string,
    userId: string,
    projectId?: string,
  ): Promise<{ fieldName: string; newValue: string; nextAction: GrillCheckResult; profile: TaskProfile } | null> {
    if (!this.isEnabled()) return null;

    const profile = this.getProfile(taskType);
    if (!profile) return null;

    const session = await this.deps.assistantRepo.getSession(userId, sessionId);
    const ctx = this.buildContext(userId, projectId, session.clarificationState);

    // P1-3: 恢复计数器
    const cs = session.clarificationState as Record<string, unknown> | null;
    const counterData = cs?.counterState as Record<string, unknown> | null;
    this.getEngine().restoreCounter(userId, taskType, counterData);

    // 识别要修正的字段和值
    const amendTarget = this.getEngine().parseAmendTarget(profile, userInput, ctx);
    if (!amendTarget) return null;

    // 直接修改 ephemeralFields
    this.getEngine().amendField(profile, amendTarget.fieldName, amendTarget.newValue, ctx);

    // 重新 check 评估充分性
    const storedIntent = (cs?.intent as string) ?? userInput;
    const nextAction = await this.getEngine().check(profile, storedIntent, ctx);

    // 序列化计数器并持久化
    const serializedCounter = this.getEngine().serializeCounter(userId, taskType);

    const nextTargetField =
      nextAction.action === "clarify"
        ? nextAction.targetField
        : nextAction.action === "offer_candidates"
          ? nextAction.targetField
          : undefined;
    await this.deps.assistantRepo.updateClarificationState(sessionId, {
      ephemeralFields: ctx.ephemeralFields,
      fieldSources: ctx.fieldSources,
      lastAction: nextAction.action,
      targetField: nextTargetField,
      taskType,
      intent: storedIntent,
      projectId,
      lastUserInput: userInput.trim(),
      originalIntent: (cs?.originalIntent as string) ?? storedIntent,
      counterState: serializedCounter,
    });

    return { fieldName: amendTarget.fieldName, newValue: amendTarget.newValue, nextAction, profile };
  }

  /**
   * 在 pending_confirmation 状态下，从用户补充消息中识别目标字段名。
   *
   * 用户可能说"补充大小，9*16"、"尺寸9*16"、"风格要水墨画"等。
   * 通过关键词匹配识别用户想补充哪个字段。
   */
  private identifyFieldFromMessage(message: string, taskType: TaskType): string | null {
    const profile = getTaskProfile(taskType);
    if (!profile) return null;

    const lower = message.toLowerCase();

    // 字段关键词映射表（按字段名 → 用户可能说的关键词）
    const fieldKeywords: Record<string, string[]> = {
      constraints: ["大小", "尺寸", "规格", "时长", "比例", "分辨率", "constraint"],
      style_or_tone: ["风格", "调性", "画风", "色调", "style", "tone"],
      subject_or_theme: ["主题", "题材", "方向", "内容", "subject", "theme"],
      content_type: ["类型", "图片", "视频", "文案", "content_type"],
      preferred_genre: ["题材偏好", "喜欢的题材"],
      user_role: ["角色", "身份"],
      preferred_tone: ["偏好调性"],
    };

    for (const field of profile.requiredFields) {
      const keywords = fieldKeywords[field.name];
      if (!keywords) continue;
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) {
          return field.name;
        }
      }
    }
    return null;
  }

  /**
   * 从用户补充消息中提取字段值（去掉字段名关键词前缀）。
   *
   * 例如："补充大小，9*16" → "9*16"
   *      "尺寸9*16" → "9*16"
   *      "风格要水墨画" → "水墨画"
   */
  private extractFieldValue(message: string, fieldName: string): string {
    const fieldKeywords: Record<string, string[]> = {
      constraints: ["补充大小", "补充尺寸", "补充规格", "补充时长", "补充比例", "大小", "尺寸", "规格", "时长", "比例", "分辨率"],
      style_or_tone: ["风格要", "调性要", "画风要", "色调要", "风格", "调性", "画风", "色调"],
      subject_or_theme: ["主题是", "题材是", "方向是", "主题", "题材", "方向"],
      content_type: ["类型是", "图片", "视频", "文案"],
    };

    const keywords = fieldKeywords[fieldName];
    if (!keywords) return message.trim();

    let result = message;
    for (const kw of keywords) {
      // 尝试去掉关键词和后面的分隔符（逗号、冒号、空格等）
      const idx = result.indexOf(kw);
      if (idx >= 0) {
        result = result.slice(idx + kw.length);
        break;
      }
    }
    // 去掉前导分隔符
    result = result.replace(/^[\s,，:：、]+/, "").trim();
    return result || message.trim();
  }

  /**
   * 吸收用户对 pending clarification 的回答。
   *
   * 从 session.clarificationState 中读取 taskType、intent、targetField，
   * 用 userMessage 作为 answer 调用 absorb()，然后重新 check()。
   * 如果没有 pending clarification，返回 null。
   */
  async absorbPendingAnswer(
    sessionId: string,
    userId: string,
    userMessage: string,
  ): Promise<{ extracted: unknown; nextAction: GrillCheckResult; taskType: TaskType; intent: string; targetField: string } | null> {
    if (!this.isEnabled()) return null;

    const session = await this.deps.assistantRepo.getSession(userId, sessionId);
    const cs = session.clarificationState as Record<string, unknown> | null;
    // absorb 在 clarify 和 offer_candidates 两种 lastAction 下都需要执行：
    // clarify → 用户输入文本回答；offer_candidates → 用户选择候选 label（也是文本）。
    // 不吸收 offer_candidates 的回答会导致无限循环候选卡片。
    if (
      !cs ||
      !cs.taskType
    ) {
      return null;
    }

    const taskType = cs.taskType as TaskType;
    const intent = (cs.intent as string) ?? "";
    let targetField = cs.targetField as string;

    // P0-2: 重复输入检测
    // 比对当前输入与 lastUserInput 和 originalIntent
    // 若相同 → 判定为"重复无效输入" → 跳过反问，直接走 offer_candidates
    const lastUserInput = (cs.lastUserInput as string) ?? "";
    const originalIntent = (cs.originalIntent as string) ?? intent;
    const trimmedMessage = userMessage.trim();

    if (
      trimmedMessage &&
      (trimmedMessage === lastUserInput || trimmedMessage === originalIntent) &&
      cs.lastAction !== "pending_confirmation"
    ) {
      // 重复输入 → 不消耗反问预算，直接走多选兜底
      const profile = this.getProfile(taskType);
      if (profile && targetField) {
        const fieldSpec = profile.requiredFields.find((f) => f.name === targetField);
        if (fieldSpec) {
          const { generateCandidates } = await import("./candidate.js");
          const provider = this.provider();
          // 构造 ctx 并注入偏好，让 LLM 候选生成能引用用户偏好
          const ctx = this.buildContext(userId, (cs.projectId as string) ?? undefined, cs);
          await this.injectPreferenceHints(taskType, userId, ctx);
          const candidates = await generateCandidates(
            this.deps.aiCallRepo,
            provider,
            profile,
            fieldSpec,
            trimmedMessage,
            userId,
            ctx,
          );
          const fallback = profile.fallbackCandidates?.[targetField] ?? [];
          const validCandidates = (candidates && candidates.length > 0 ? candidates : fallback).slice(0, 4);
          if (validCandidates.length >= 2) {
            const nextAction: GrillCheckResult = {
              action: "offer_candidates",
              candidates: validCandidates,
              targetField,
            };
            await this.deps.assistantRepo.updateClarificationState(sessionId, {
              ephemeralFields: (cs.ephemeralFields as Record<string, unknown>) ?? {},
              fieldSources: (cs.fieldSources as Record<string, import("./types.js").FieldSource>) ?? {},
              lastAction: nextAction.action,
              targetField,
              taskType,
              intent,
              projectId: (cs.projectId as string) ?? undefined,
              lastUserInput: trimmedMessage,
              originalIntent,
            });
            return { extracted: null, nextAction, taskType, intent, targetField };
          }
        }
      }
    }

    // "换一个"/"换一个口味"/"不要这个"/"其他选项"等 → 直接走候选生成（不走 absorb+check 反问）
    const wantDifferentOptions = /^(换一个|换个|换一个口味|换一个方向|不要这个|不要|其他|别的|再来|重新)[^。！？]*$/.test(trimmedMessage);
    if (
      wantDifferentOptions &&
      cs.lastAction !== "pending_confirmation" &&
      targetField
    ) {
      const profile = this.getProfile(taskType);
      if (profile) {
        const fieldSpec = profile.requiredFields.find((f) => f.name === targetField);
        if (fieldSpec) {
          const { generateCandidates } = await import("./candidate.js");
          const provider = this.provider();
          const ctx = this.buildContext(userId, (cs.projectId as string) ?? undefined, cs);
          await this.injectPreferenceHints(taskType, userId, ctx);
          const candidates = await generateCandidates(
            this.deps.aiCallRepo,
            provider,
            profile,
            fieldSpec,
            trimmedMessage,
            userId,
            ctx,
          );
          const fallback = profile.fallbackCandidates?.[targetField] ?? [];
          const validCandidates = (candidates && candidates.length > 0 ? candidates : fallback).slice(0, 4);
          if (validCandidates.length >= 2) {
            const nextAction: GrillCheckResult = {
              action: "offer_candidates",
              candidates: validCandidates,
              targetField,
            };
            await this.deps.assistantRepo.updateClarificationState(sessionId, {
              ephemeralFields: (cs.ephemeralFields as Record<string, unknown>) ?? {},
              fieldSources: (cs.fieldSources as Record<string, import("./types.js").FieldSource>) ?? {},
              lastAction: nextAction.action,
              targetField,
              taskType,
              intent,
              projectId: (cs.projectId as string) ?? undefined,
              lastUserInput: trimmedMessage,
              originalIntent,
              preferenceRejected: true,
            });
            return { extracted: null, nextAction, taskType, intent, targetField };
          }
        }
      }
    }

    // 更新 lastUserInput（非重复输入场景下记录）
    // pending_confirmation 状态下用户补充信息：
    // 尝试从消息中识别字段名（constraints/style_or_theme/subject_or_theme）
    // 如果识别到，就 absorb 该字段；否则返回 null 走 check()
    if (cs.lastAction === "pending_confirmation") {
      const identifiedField = this.identifyFieldFromMessage(userMessage, taskType);
      if (!identifiedField) {
        // 无法识别字段 → 返回 null，由 routes 走 check() 重新确认
        return null;
      }
      targetField = identifiedField;
      // 从消息中提取字段值（去掉"补充大小，"等前缀关键词）
      const cleanedAnswer = this.extractFieldValue(userMessage, targetField);
      // 用清理后的值调用 absorb
      const result = await this.absorb(
        taskType,
        cleanedAnswer,
        targetField,
        sessionId,
        userId,
        (cs.projectId as string) ?? undefined,
      );
      if (!result) return null;
      return {
        extracted: result.extracted,
        nextAction: result.nextAction,
        taskType,
        intent,
        targetField,
      };
    }

    if (
      !targetField
    ) {
      return null;
    }

    const result = await this.absorb(
      taskType,
      userMessage,
      targetField,
      sessionId,
      userId,
      (cs.projectId as string) ?? undefined,
    );

    if (!result) return null;

    // absorb() 内部已持久化所有状态（ephemeralFields + lastAction + targetField），
    // 此处无需再次写入，直接返回结果。
    return {
      extracted: result.extracted,
      nextAction: result.nextAction,
      taskType,
      intent,
      targetField,
    };
  }
}
