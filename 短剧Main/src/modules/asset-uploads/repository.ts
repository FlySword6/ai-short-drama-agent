import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { assetUploadTasks, type AssetUploadTaskRow } from "../../db/schema.js";
import { ConflictError, isPostgresUniqueViolation } from "../../shared/errors.js";
import {
  ETA_HISTORY_SAMPLE_LIMIT,
  medianEstimatedDurationSeconds,
} from "../generation/repository.js";

export interface CreateAssetUploadTaskInput {
  userId: string;
  originalFileName: string;
  contentType: string | null;
  assetKindHint: string | null;
  clientIdempotencyKey?: string | null;
  contentSha256?: string | null;
  requestSha256?: string | null;
  registrationForm?: Record<string, unknown> | null;
  stagedPath: string;
  stagedBytes: number;
}

/** Structural port so tests can substitute the queue store without a database. */
export interface AssetUploadTaskRepository {
  create(input: CreateAssetUploadTaskInput): Promise<AssetUploadTaskRow>;
  createOrReuse(input: CreateAssetUploadTaskInput): Promise<{ task: AssetUploadTaskRow; created: boolean }>;
  getByUser(userId: string, taskId: string): Promise<AssetUploadTaskRow | null>;
  listActiveByUser(userId: string): Promise<AssetUploadTaskRow[]>;
  listUnacknowledgedTerminal(userId: string, limit: number): Promise<AssetUploadTaskRow[]>;
  acknowledge(userId: string, taskId: string): Promise<void>;
  claimNextQueued(): Promise<AssetUploadTaskRow | null>;
  markSucceeded(
    taskId: string,
    patch: {
      resultAssetEntityId: string;
      resultAssetMediaId?: string | null;
      resultAssetName: string;
      resultRegistrationId?: string | null;
      resultRegistrationStatus?: string | null;
      registrationErrorCode?: string | null;
      registrationErrorMessage?: string | null;
      durationSeconds: number;
      finishedAt: Date;
    },
  ): Promise<void>;
  recordLocalResult(
    taskId: string,
    patch: { resultAssetEntityId: string; resultAssetMediaId: string; resultAssetName: string },
  ): Promise<void>;
  markFailed(
    taskId: string,
    patch: { errorCode?: string | null; errorMessage: string; durationSeconds: number; finishedAt: Date },
  ): Promise<void>;
  requeueInterrupted(): Promise<number>;
  queuePositionFor(task: AssetUploadTaskRow): Promise<number | null>;
  estimatedDuration(): Promise<{ seconds: number | null; sampleCount: number }>;
}

export class PostgresAssetUploadTaskRepository implements AssetUploadTaskRepository {
  constructor(private readonly db: Database) {}

  async create(input: CreateAssetUploadTaskInput): Promise<AssetUploadTaskRow> {
    const [row] = await this.db.insert(assetUploadTasks).values({
      id: randomUUID(),
      userId: input.userId,
      clientIdempotencyKey: input.clientIdempotencyKey ?? null,
      status: "queued",
      originalFileName: input.originalFileName,
      contentType: input.contentType,
      assetKindHint: input.assetKindHint,
      contentSha256: input.contentSha256 ?? null,
      requestSha256: input.requestSha256 ?? null,
      registrationForm: input.registrationForm ?? null,
      stagedPath: input.stagedPath,
      stagedBytes: input.stagedBytes,
      createdAt: new Date(),
    }).returning();
    return row!;
  }

  async createOrReuse(input: CreateAssetUploadTaskInput): Promise<{ task: AssetUploadTaskRow; created: boolean }> {
    if (!input.clientIdempotencyKey) {
      return { task: await this.create(input), created: true };
    }
    try {
      return { task: await this.create(input), created: true };
    } catch (error) {
      if (!isPostgresUniqueViolation(error)) throw error;
      const [existing] = await this.db.select().from(assetUploadTasks).where(and(
        eq(assetUploadTasks.userId, input.userId),
        eq(assetUploadTasks.clientIdempotencyKey, input.clientIdempotencyKey),
      )).limit(1);
      if (!existing) throw error;
      if (!input.requestSha256 || existing.requestSha256 !== input.requestSha256) {
        throw new ConflictError(
          "本次提交标识已被另一份内容使用，请重新提交",
          "idempotency_key_conflict",
        );
      }
      return { task: existing, created: false };
    }
  }

  async getByUser(userId: string, taskId: string): Promise<AssetUploadTaskRow | null> {
    const [row] = await this.db.select().from(assetUploadTasks).where(and(
      eq(assetUploadTasks.userId, userId),
      eq(assetUploadTasks.id, taskId),
    )).limit(1);
    return row ?? null;
  }

  async listActiveByUser(userId: string): Promise<AssetUploadTaskRow[]> {
    return this.db.select().from(assetUploadTasks).where(and(
      eq(assetUploadTasks.userId, userId),
      inArray(assetUploadTasks.status, ["queued", "processing"]),
    )).orderBy(assetUploadTasks.createdAt, assetUploadTasks.id);
  }

  /** Terminal rows stay discoverable until their owner explicitly acknowledges them. */
  async listUnacknowledgedTerminal(userId: string, limit: number): Promise<AssetUploadTaskRow[]> {
    return this.db.select().from(assetUploadTasks).where(and(
      eq(assetUploadTasks.userId, userId),
      inArray(assetUploadTasks.status, ["succeeded", "failed"]),
      isNull(assetUploadTasks.acknowledgedAt),
    )).orderBy(desc(assetUploadTasks.createdAt), desc(assetUploadTasks.id)).limit(limit);
  }

  async acknowledge(userId: string, taskId: string): Promise<void> {
    await this.db.update(assetUploadTasks).set({ acknowledgedAt: new Date() }).where(and(
      eq(assetUploadTasks.id, taskId),
      eq(assetUploadTasks.userId, userId),
    ));
  }

  /**
   * Worker claim and user-facing queue position use one predicate
   * (status='queued', ordered by created_at,id) — a UI "第 1 位" never drifts
   * away from the row the worker actually picks next. Same rule as S29.
   */
  async claimNextQueued(): Promise<AssetUploadTaskRow | null> {
    return this.db.transaction(async (transaction) => {
      const rows = await transaction.select().from(assetUploadTasks)
        .where(eq(assetUploadTasks.status, "queued"))
        .orderBy(assetUploadTasks.createdAt, assetUploadTasks.id)
        .limit(1)
        .for("update", { skipLocked: true });
      const row = rows[0];
      if (!row) return null;
      const [updated] = await transaction.update(assetUploadTasks)
        .set({ status: "processing", startedAt: new Date() })
        .where(eq(assetUploadTasks.id, row.id))
        .returning();
      return updated ?? null;
    });
  }

  async markSucceeded(
    taskId: string,
    patch: {
      resultAssetEntityId: string;
      resultAssetMediaId?: string | null;
      resultAssetName: string;
      resultRegistrationId?: string | null;
      resultRegistrationStatus?: string | null;
      registrationErrorCode?: string | null;
      registrationErrorMessage?: string | null;
      durationSeconds: number;
      finishedAt: Date;
    },
  ): Promise<void> {
    await this.db.update(assetUploadTasks)
      .set({ status: "succeeded", ...patch })
      .where(eq(assetUploadTasks.id, taskId));
  }

  async recordLocalResult(
    taskId: string,
    patch: { resultAssetEntityId: string; resultAssetMediaId: string; resultAssetName: string },
  ): Promise<void> {
    await this.db.update(assetUploadTasks).set(patch).where(eq(assetUploadTasks.id, taskId));
  }

  async markFailed(
    taskId: string,
    patch: { errorCode?: string | null; errorMessage: string; durationSeconds: number; finishedAt: Date },
  ): Promise<void> {
    await this.db.update(assetUploadTasks)
      .set({ status: "failed", ...patch })
      .where(eq(assetUploadTasks.id, taskId));
  }

  /** A restart strands "processing" rows; they re-enter the claimable queue. */
  async requeueInterrupted(): Promise<number> {
    const rows = await this.db.update(assetUploadTasks)
      .set({ status: "queued", startedAt: null })
      .where(eq(assetUploadTasks.status, "processing"))
      .returning({ id: assetUploadTasks.id });
    return rows.length;
  }

  /** Position inside the yet-to-start queue; a processing task has no honest position. */
  async queuePositionFor(task: AssetUploadTaskRow): Promise<number | null> {
    if (task.status !== "queued") return null;
    const rows = await this.db.select({ id: assetUploadTasks.id }).from(assetUploadTasks)
      .where(eq(assetUploadTasks.status, "queued"))
      .orderBy(assetUploadTasks.createdAt, assetUploadTasks.id);
    const position = rows.findIndex((row) => row.id === task.id);
    return position < 0 ? null : position + 1;
  }

  /**
   * Median of the last 20 successful end-to-end upload durations. Returns null
   * when the sample is too small — never a made-up fallback number.
   */
  async estimatedDuration(): Promise<{ seconds: number | null; sampleCount: number }> {
    const rows = await this.db.select({ durationSeconds: assetUploadTasks.durationSeconds })
      .from(assetUploadTasks)
      .where(and(
        eq(assetUploadTasks.status, "succeeded"),
        isNotNull(assetUploadTasks.durationSeconds),
        sql`${assetUploadTasks.durationSeconds} >= 0`,
      ))
      .orderBy(desc(assetUploadTasks.finishedAt), desc(assetUploadTasks.id))
      .limit(ETA_HISTORY_SAMPLE_LIMIT);
    const durations = rows.flatMap((row) => typeof row.durationSeconds === "number" ? [row.durationSeconds] : []);
    return { seconds: medianEstimatedDurationSeconds(durations), sampleCount: durations.length };
  }
}
