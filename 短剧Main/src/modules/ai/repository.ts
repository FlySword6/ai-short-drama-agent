import { randomUUID } from "node:crypto";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { aiCalls, scriptBreakdownRuns } from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";
import type {
  AiCallRepository,
  AiCallReservation,
  CompleteAiCallInput,
  FailAiCallInput,
  ReserveAiCallInput,
} from "./types.js";

export class DrizzleAiCallRepository implements AiCallRepository {
  constructor(private readonly db: Database) {}

  async reserve(input: ReserveAiCallInput): Promise<AiCallReservation> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const { start, end, key } = utcDay(input.now, input.actorId);
      if (input.executionFence) {
        if (
          input.relatedObject?.type !== input.executionFence.type
          || input.relatedObject.id !== input.executionFence.runId
        ) {
          throw new AiExecutionFenceLostError();
        }
        /*
         * This conditional heartbeat is the paid-call fence. If recovery or
         * discard won the row lock first, no reservation/provider call occurs.
         * If this update wins first, updated_at moves outside the stale window,
         * so recovery cannot reclaim the run immediately after reservation.
         */
        const owned = await db.update(scriptBreakdownRuns).set({
          updatedAt: input.now,
        }).where(and(
          eq(scriptBreakdownRuns.id, input.executionFence.runId),
          eq(scriptBreakdownRuns.status, "running"),
          eq(scriptBreakdownRuns.executionToken, input.executionFence.token),
        )).returning({ id: scriptBreakdownRuns.id });
        if (!owned[0]) throw new AiExecutionFenceLostError();
      }
      // Serialize one actor's UTC-day reservations. A failed provider call is
      // still a real attempt and is therefore deliberately counted.
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
      const total = (await db.select({ value: count(aiCalls.id) })
        .from(aiCalls)
        .where(and(
          eq(aiCalls.callerUserId, input.actorId),
          gte(aiCalls.createdAt, start),
          lt(aiCalls.createdAt, end),
        )))[0]?.value ?? 0;
      if (total >= input.dailyLimit) throw new AiDailyCallLimitError();

      const id = randomUUID();
      await db.insert(aiCalls).values({
        id,
        callerUserId: input.actorId,
        purpose: input.purpose,
        provider: input.provider,
        model: input.requestedModel,
        projectId: input.projectId,
        relatedObjectType: input.relatedObject?.type ?? null,
        relatedObjectId: input.relatedObject?.id ?? null,
        status: "running",
        createdAt: input.now,
      });
      return { id };
    });
  }

  async complete(input: CompleteAiCallInput): Promise<void> {
    const updated = await this.db.update(aiCalls).set({
      status: "succeeded",
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      durationMs: input.durationMs,
      completedAt: input.now,
    }).where(and(eq(aiCalls.id, input.id), eq(aiCalls.status, "running"))).returning({ id: aiCalls.id });
    if (!updated[0]) throw new Error("AI 调用审计记录不存在或已结束");
  }

  async fail(input: FailAiCallInput): Promise<void> {
    const updated = await this.db.update(aiCalls).set({
      status: "failed",
      errorCode: input.errorCode,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      durationMs: input.durationMs,
      completedAt: input.now,
    }).where(and(eq(aiCalls.id, input.id), eq(aiCalls.status, "running"))).returning({ id: aiCalls.id });
    if (!updated[0]) throw new Error("AI 调用审计记录不存在或已结束");
  }
}

export class AiDailyCallLimitError extends AppError {
  constructor() {
    super(429, "ai_daily_limit_exceeded", "今天的 AI 辅助次数已达到上限，请明天再试或联系管理员调整限额。", false);
    this.name = "AiDailyCallLimitError";
  }
}

export class AiExecutionFenceLostError extends AppError {
  constructor() {
    super(409, "ai_execution_fence_lost", "这次拆解执行权已失效，已停止旧任务。", false);
    this.name = "AiExecutionFenceLostError";
  }
}

function utcDay(now: Date, actorId: string): { start: Date; end: Date; key: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end, key: `shortdrama:ai-call:${actorId}:${start.toISOString().slice(0, 10)}` };
}
