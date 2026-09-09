/**
 * ClarificationCounter —— 纯代码反问计数器（进程内 Map，暂不持久化）
 *
 * 来源：grill-engine-design.md §2.2 + §8 阶段 0 步骤 0.3。
 * 逻辑：
 * - 按 (userId, taskType, field) 维度记录单字段反问次数
 * - 按 (userId, taskType) 维度记录已问字段集合 + 主题细化深度
 * - 同一字段反问累计达 maxClarifications → 降级到候选，返回 limit_reached
 * - 不设总轮次硬上限——循环终止靠信息充分或用户确认执行
 * - 同一字段不得在已成功填充后再次反问
 *
 * 关键修复：计数按字段独立，成功填充字段 A 后只重置 A 的计数，
 * 不会影响字段 B 的已积累反问次数。
 *
 * 阶段 0 用进程内 Map，不写 agent_sessions 表（阶段 1 加持久化）。
 */

import type { TaskType, ClarificationState } from "./types.js";

/** 计数器 key：userId + taskType，同一用户不同场景的计数独立。 */
function counterKey(userId: string, taskType: TaskType): string {
  return `${userId}:${taskType}`;
}

/** 单字段计数器 key：userId + taskType + field。 */
function fieldKey(userId: string, taskType: TaskType, field: string): string {
  return `${userId}:${taskType}:${field}`;
}

/** 计数器判断结果。 */
export type CounterDecision =
  | { decision: "allow"; count: number; remaining: number }
  | { decision: "limit_reached"; count: number };

/**
 * 进程内反问计数器。
 * 阶段 0 不持久化——进程重启后计数归零。阶段 1 改为读写 agent_sessions.clarification_state。
 */
export class ClarificationCounter {
  /** 单字段反问次数：key = userId:taskType:field */
  private readonly fieldCounts = new Map<string, number>();
  private readonly totalRounds = new Map<string, number>();
  private readonly subjectDepths = new Map<string, number>();
  private readonly askedFields = new Map<string, Set<string>>();
  private readonly targetFields = new Map<string, string | undefined>();

  /** 获取当前反问状态快照。 */
  getState(userId: string, taskType: TaskType): ClarificationState {
    const key = counterKey(userId, taskType);
    // 兼容旧接口：返回当前 targetField 的计数
    const currentField = this.targetFields.get(key);
    const count = currentField
      ? (this.fieldCounts.get(fieldKey(userId, taskType, currentField)) ?? 0)
      : 0;
    return {
      count,
      totalRounds: this.totalRounds.get(key) ?? 0,
      subjectDepth: this.subjectDepths.get(key) ?? 0,
      targetField: currentField,
      askedFields: [...(this.askedFields.get(key) ?? [])],
    };
  }

  /**
   * 判断是否还能反问指定字段。
   * 两个上限：
   * 1. 单字段反问累计达 maxClarifications → 降级到候选。
   * 2. 总轮次达 maxTotalRounds → 强制进入待确认（防死循环）。
   * 同一字段已问过且未成功填充 → 不再重复反问（由 engine 调用前检查 askedFields）。
   */
  canClarify(
    userId: string,
    taskType: TaskType,
    maxClarifications: number,
    maxTotalRounds: number,
    targetField: string,
  ): CounterDecision {
    const key = counterKey(userId, taskType);
    const totalRounds = this.totalRounds.get(key) ?? 0;
    // Bug 1: 总轮次硬上限——达到后强制停止反问
    if (maxTotalRounds > 0 && totalRounds >= maxTotalRounds) {
      return { decision: "limit_reached", count: totalRounds };
    }
    const fk = fieldKey(userId, taskType, targetField);
    const count = this.fieldCounts.get(fk) ?? 0;
    if (count >= maxClarifications) {
      return { decision: "limit_reached", count };
    }
    return { decision: "allow", count, remaining: maxClarifications - count };
  }

  /**
   * 获取指定字段的反问次数。
   */
  getFieldCount(userId: string, taskType: TaskType, field: string): number {
    const fk = fieldKey(userId, taskType, field);
    return this.fieldCounts.get(fk) ?? 0;
  }

  /**
   * 获取指定字段是否已经被反问过（用于去重——同一维度不得重复反问）。
   * "已问过"的含义：该字段已被反问且用户已回答（absorb 已处理）。
   * 如果字段仍在缺失状态且未达上限，可以继续反问直到达到上限或用户回答。
   */
  hasAsked(userId: string, taskType: TaskType, field: string): boolean {
    const key = counterKey(userId, taskType);
    return (this.askedFields.get(key) ?? new Set()).has(field);
  }

  /**
   * 记录一次反问。
   * 在 clarify 分支发出反问后调用，递增该字段计数 + 总轮次，记录已问字段。
   */
  recordClarification(userId: string, taskType: TaskType, targetField: string): void {
    const key = counterKey(userId, taskType);
    const fk = fieldKey(userId, taskType, targetField);
    this.fieldCounts.set(fk, (this.fieldCounts.get(fk) ?? 0) + 1);
    this.totalRounds.set(key, (this.totalRounds.get(key) ?? 0) + 1);

    const asked = this.askedFields.get(key) ?? new Set<string>();
    asked.add(targetField);
    this.askedFields.set(key, asked);

    this.targetFields.set(key, targetField);
  }

  /**
   * 记录一次总轮次递增（offer_candidates 也算一轮）。
   */
  recordRound(userId: string, taskType: TaskType): void {
    const key = counterKey(userId, taskType);
    this.totalRounds.set(key, (this.totalRounds.get(key) ?? 0) + 1);
  }

  /**
   * 递增主题细化深度（用户回答了主题类字段时调用）。
   * 返回递增后的深度。
   */
  incrementSubjectDepth(userId: string, taskType: TaskType): number {
    const key = counterKey(userId, taskType);
    const depth = (this.subjectDepths.get(key) ?? 0) + 1;
    this.subjectDepths.set(key, depth);
    return depth;
  }

  /**
   * 获取主题细化深度。
   */
  getSubjectDepth(userId: string, taskType: TaskType): number {
    const key = counterKey(userId, taskType);
    return this.subjectDepths.get(key) ?? 0;
  }

  /**
   * 重置指定字段的反问计数（成功 absorb 该字段后调用）。
   * 只清除该字段的计数，不影响其他字段。
   */
  resetField(userId: string, taskType: TaskType, targetField: string): void {
    const fk = fieldKey(userId, taskType, targetField);
    this.fieldCounts.delete(fk);
  }

  /**
   * 重置所有字段计数（用户主动确认执行时调用）。
   * 同时重置总轮次和主题深度，避免新对话继承旧计数。
   */
  reset(userId: string, taskType: TaskType): void {
    const key = counterKey(userId, taskType);
    // 删除该用户+任务类型下所有字段计数
    const prefix = `${counterKey(userId, taskType)}:`;
    for (const fk of this.fieldCounts.keys()) {
      if (fk.startsWith(prefix)) {
        this.fieldCounts.delete(fk);
      }
    }
    this.totalRounds.delete(key);
    this.subjectDepths.delete(key);
    this.askedFields.delete(key);
    this.targetFields.delete(key);
  }

  /**
   * 完全重置（包括总轮次和主题深度）——新会话开始时调用。
   */
  fullReset(userId: string, taskType: TaskType): void {
    const key = counterKey(userId, taskType);
    const prefix = `${key}:`;
    for (const fk of this.fieldCounts.keys()) {
      if (fk.startsWith(prefix)) {
        this.fieldCounts.delete(fk);
      }
    }
    this.totalRounds.delete(key);
    this.subjectDepths.delete(key);
    this.askedFields.delete(key);
    this.targetFields.delete(key);
  }

  // ── P1-3: 计数器持久化（序列化 / 反序列化）──

  /**
   * 序列化指定用户+任务类型的计数器状态，用于持久化到 DB。
   * 只导出该 (userId, taskType) 维度的数据，不泄露其他维度。
   *
   * G7: 导出的 fieldCounts key 带 `${userId}:${taskType}:${field}` 前缀。
   * restore() 用相同 key 逻辑恢复，如果 userId 或 taskType 在重启后变化，数据不匹配。
   * 这是边界情况——实际不会发生（同一用户同一任务类型），但需注意。
   */
  serialize(userId: string, taskType: TaskType): Record<string, unknown> {
    const key = counterKey(userId, taskType);
    const prefix = `${key}:`;
    const fc: Record<string, number> = {};
    for (const [k, v] of this.fieldCounts) {
      if (k.startsWith(prefix)) fc[k] = v;
    }
    return {
      fieldCounts: fc,
      totalRounds: this.totalRounds.get(key) ?? 0,
      subjectDepth: this.subjectDepths.get(key) ?? 0,
      askedFields: [...(this.askedFields.get(key) ?? [])],
      targetField: this.targetFields.get(key) ?? undefined,
    };
  }

  /**
   * 从 DB 恢复计数器状态。
   * 在每次 check/absorb 操作前调用，确保进程重启后计数不丢失。
   *
   * G7: 如果 data 中的 fieldCounts key 前缀与当前 (userId, taskType) 不匹配，
   * 说明数据属于不同维度（如 userId 或 taskType 变化），跳过这些条目避免污染。
   */
  restore(userId: string, taskType: TaskType, data: Record<string, unknown> | null): void {
    if (!data) return;
    const key = counterKey(userId, taskType);
    const expectedPrefix = `${key}:`;

    const fc = data.fieldCounts as Record<string, number> | undefined;
    if (fc && typeof fc === "object") {
      for (const [k, v] of Object.entries(fc)) {
        // G7: key 匹配校验——只恢复与当前 (userId, taskType) 前缀匹配的条目
        if (typeof v === "number" && k.startsWith(expectedPrefix)) {
          this.fieldCounts.set(k, v);
        }
      }
    }

    if (typeof data.totalRounds === "number") {
      this.totalRounds.set(key, data.totalRounds);
    }
    if (typeof data.subjectDepth === "number") {
      this.subjectDepths.set(key, data.subjectDepth);
    }
    if (Array.isArray(data.askedFields)) {
      this.askedFields.set(key, new Set(data.askedFields as string[]));
    }
    if (typeof data.targetField === "string") {
      this.targetFields.set(key, data.targetField);
    }
  }
}
