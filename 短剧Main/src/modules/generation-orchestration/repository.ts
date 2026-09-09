import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { agentMessages, agentSessions } from "../../db/schema.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  parseOperationReceipt,
  parseStoredOperation,
  serializeStoredOperation,
} from "./schemas.js";
import type {
  GenerationIntentClarification,
  GenerationOperationReceipt,
  GenerationOrchestrationSession,
  GenerationOrchestrationStore,
  StoredGenerationOperation,
} from "./types.js";

const OPERATION_TOOL = "generation_orchestration";
const RECEIPT_TOOL = "generation_orchestration_receipt";

export class DrizzleGenerationOrchestrationStore implements GenerationOrchestrationStore {
  constructor(private readonly db: Database) {}

  async getSession(actorId: string, sessionId: string): Promise<GenerationOrchestrationSession> {
    const session = (await this.db.select({
      id: agentSessions.id,
      userId: agentSessions.userId,
      projectId: agentSessions.projectId,
      shotId: agentSessions.shotId,
    }).from(agentSessions).where(and(
      eq(agentSessions.id, sessionId),
      isNull(agentSessions.deletedAt),
    )).limit(1))[0];
    if (!session) throw new NotFoundError("助手会话不存在");
    if (session.userId !== actorId) throw new ForbiddenError();
    return session;
  }

  async appendUserTurn(sessionId: string, content: string): Promise<void> {
    await this.insertMessage({
      sessionId,
      role: "user",
      content: content.slice(0, 8_000),
    });
  }

  async saveClarification(
    sessionId: string,
    clarification: GenerationIntentClarification,
  ): Promise<string> {
    return this.insertMessage({
      sessionId,
      role: "assistant",
      content: clarification.question,
      toolName: OPERATION_TOOL,
      toolResultSummary: {
        kind: "clarification",
        code: clarification.code,
        question: clarification.question,
        choices: clarification.choices ?? [],
      },
    });
  }

  async saveOperation(sessionId: string, operation: StoredGenerationOperation): Promise<string> {
    return this.insertMessage({
      sessionId,
      role: "assistant",
      content: operationSummary(operation),
      toolName: OPERATION_TOOL,
      toolResultSummary: {
        kind: "operation",
        operation: serializeStoredOperation(operation),
      },
    });
  }

  async getOperation(
    actorId: string,
    sessionId: string,
    operationId: string,
  ): Promise<StoredGenerationOperation> {
    await this.getSession(actorId, sessionId);
    const row = (await this.db.select({
      toolName: agentMessages.toolName,
      summary: agentMessages.toolResultSummary,
    }).from(agentMessages).where(and(
      eq(agentMessages.id, operationId),
      eq(agentMessages.sessionId, sessionId),
    )).limit(1))[0];
    const summary = record(row?.summary);
    const operation = row?.toolName === OPERATION_TOOL
      && summary?.kind === "operation"
      ? parseStoredOperation(summary.operation)
      : null;
    if (!operation) throw new NotFoundError("生成操作不存在或已经失效");
    return operation;
  }

  async findReceipt(
    actorId: string,
    sessionId: string,
    operationId: string,
  ): Promise<GenerationOperationReceipt | null> {
    await this.getSession(actorId, sessionId);
    const rows = await this.db.select({
      summary: agentMessages.toolResultSummary,
    }).from(agentMessages).where(and(
      eq(agentMessages.sessionId, sessionId),
      eq(agentMessages.toolName, RECEIPT_TOOL),
    )).orderBy(asc(agentMessages.createdAt), asc(agentMessages.id));
    for (const row of rows) {
      const receipt = parseOperationReceipt(record(row.summary)?.receipt);
      if (receipt?.operationId === operationId) return receipt;
    }
    return null;
  }

  async saveReceipt(
    sessionId: string,
    receipt: GenerationOperationReceipt,
  ): Promise<GenerationOperationReceipt> {
    const rows = await this.db.select({
      summary: agentMessages.toolResultSummary,
    }).from(agentMessages).where(and(
      eq(agentMessages.sessionId, sessionId),
      eq(agentMessages.toolName, RECEIPT_TOOL),
    )).orderBy(asc(agentMessages.createdAt), asc(agentMessages.id));
    for (const row of rows) {
      const existing = parseOperationReceipt(record(row.summary)?.receipt);
      if (existing?.operationId === receipt.operationId) return existing;
    }
    await this.insertMessage({
      sessionId,
      role: "tool",
      content: receipt.message,
      toolName: RECEIPT_TOOL,
      toolArguments: { operationId: receipt.operationId },
      toolResultSummary: { receipt },
    });
    return receipt;
  }

  private async insertMessage(input: {
    sessionId: string;
    role: "user" | "assistant" | "tool";
    content: string;
    toolName?: string;
    toolArguments?: Record<string, unknown>;
    toolResultSummary?: Record<string, unknown>;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date();
    await this.db.insert(agentMessages).values({
      id,
      sessionId: input.sessionId,
      role: input.role,
      content: input.content.slice(0, 100_000),
      toolName: input.toolName ?? null,
      toolArguments: input.toolArguments ?? null,
      toolResultSummary: input.toolResultSummary ?? null,
      status: "completed",
      provider: null,
      model: null,
      usage: null,
      providerCostUsdMicros: null,
      pointsSpent: 0,
      durationMs: null,
      errorSummary: null,
      createdAt: now,
    });
    await this.db.update(agentSessions).set({ updatedAt: now })
      .where(eq(agentSessions.id, input.sessionId));
    return id;
  }
}

function operationSummary(operation: StoredGenerationOperation): string {
  const action = operation.operationType === "edit" ? "修改" : "生成";
  const media = operation.mediaKind === "image"
    ? "图片"
    : operation.mediaKind === "video"
      ? "视频"
      : "音频";
  return `已准备${action}${media}操作，请确认后执行。`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
