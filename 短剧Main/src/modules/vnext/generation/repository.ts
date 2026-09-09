import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import type { ControlPackageReference } from "../control-packages/types.js";
import { ConflictError } from "../../../shared/errors.js";
import { VnextAttemptLeaseLostError } from "./errors.js";
import type {
  VnextGenerationAttempt,
  VnextGenerationTask,
  VnextGenerationTaskView,
  VnextProviderResultSnapshot,
  VnextRecoverableAttemptContext,
  VnextTosMediaItem,
} from "./types.js";

// ─── Row types ────────────────────────────────────────────────────────────────

interface TaskRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  actor_id: string;
  intent_id: string;
  client_idempotency_key: string;
  control_package_id: string;
  control_package_version: number;
  reference_snapshot: ControlPackageReference[];
  provider: string;
  model: string;
  prompt: string;
  no_bgm: boolean;
  parameters: Record<string, unknown>;
  estimated_cost_fen: string;
  status: string;
  created_at: Date | string;
}

interface AttemptRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  attempt_no: number;
  status: string;
  provider_task_id: string | null;
  provider_raw_status: string | null;
  provider_result: VnextProviderResultSnapshot | null;
  tos_media: VnextTosMediaItem[];
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  error_code: string | null;
  error_message: string | null;
  actual_cost_fen: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function toTask(row: TaskRow): VnextGenerationTask {
  return {
    id: row.id,
    projectId: row.project_id,
    actorId: row.actor_id,
    intentId: row.intent_id,
    clientIdempotencyKey: row.client_idempotency_key,
    controlPackageId: row.control_package_id,
    controlPackageVersion: row.control_package_version,
    references: row.reference_snapshot ?? [],
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    noBgm: row.no_bgm,
    parameters: row.parameters ?? {},
    estimatedCostFen: Number(row.estimated_cost_fen),
    status: row.status as VnextGenerationTask["status"],
    createdAt: toIso(row.created_at),
  };
}

function toAttempt(row: AttemptRow): VnextGenerationAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    attemptNo: row.attempt_no,
    status: row.status as VnextGenerationAttempt["status"],
    providerTaskId: row.provider_task_id ?? null,
    providerRawStatus: row.provider_raw_status ?? null,
    providerResult: row.provider_result ?? null,
    tosMedia: row.tos_media ?? [],
    leaseOwner: row.lease_owner ?? null,
    leaseExpiresAt: row.lease_expires_at ? toIso(row.lease_expires_at) : null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    actualCostFen: row.actual_cost_fen !== null ? Number(row.actual_cost_fen) : null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

// ─── Store interface ──────────────────────────────────────────────────────────

export interface VnextGenerationStore {
  /** Idempotent confirm: creates task + first attempt or returns existing task. */
  createTask(input: {
    projectId: string;
    actorId: string;
    intentId: string;
    clientIdempotencyKey: string;
    controlPackageId: string;
    controlPackageVersion: number;
    references: ControlPackageReference[];
    provider: string;
    model: string;
    prompt: string;
    noBgm: boolean;
    parameters: Record<string, unknown>;
    estimatedCostFen: number;
  }): Promise<{ task: VnextGenerationTask; created: boolean }>;

  getTaskView(taskId: string, projectId: string): Promise<VnextGenerationTaskView | null>;

  /** Claim a recoverable attempt; returns null if none available. */
  claimNextAttempt(workerId: string, leaseSeconds: number): Promise<string | null>;
  renewLease(attemptId: string, workerId: string, leaseSeconds: number): Promise<boolean>;
  releaseLease(attemptId: string, workerId: string, delaySeconds?: number): Promise<void>;

  getRecoverableContext(attemptId: string): Promise<VnextRecoverableAttemptContext | null>;

  /** Phase transitions; each checks lease ownership before writing. */
  markSubmitting(attemptId: string, leaseOwner?: string): Promise<void>;
  markProviderQueued(attemptId: string, providerTaskId: string, rawStatus: string, leaseOwner?: string): Promise<void>;
  markProviderProgress(attemptId: string, rawStatus: string, leaseOwner?: string): Promise<void>;
  markProviderSucceeded(attemptId: string, result: VnextProviderResultSnapshot, leaseOwner?: string): Promise<void>;
  markCopyingToTos(attemptId: string, leaseOwner?: string): Promise<void>;
  recordTosMedia(attemptId: string, item: VnextTosMediaItem, leaseOwner?: string): Promise<void>;
  markSucceeded(attemptId: string, leaseOwner?: string): Promise<void>;
  markFailed(input: { attemptId: string; errorCode: string; errorMessage: string; actualCostFen?: number; leaseOwner?: string }): Promise<void>;
  markUnknownOutcome(attemptId: string, reason: string, leaseOwner?: string): Promise<void>;
  recordPollFailure(attemptId: string, reason: string, leaseOwner?: string): Promise<void>;
}

// ─── Repository ───────────────────────────────────────────────────────────────

const TASK_COLS = sql`
  id, project_id, actor_id, intent_id, client_idempotency_key,
  control_package_id, control_package_version, reference_snapshot,
  provider, model, prompt, no_bgm, parameters, estimated_cost_fen,
  status, created_at`;

const ATTEMPT_COLS = sql`
  id, task_id, attempt_no, status, provider_task_id, provider_raw_status,
  provider_result, tos_media, lease_owner, lease_expires_at,
  error_code, error_message, actual_cost_fen, created_at, updated_at`;

export class VnextGenerationRepository implements VnextGenerationStore {
  constructor(private readonly db: Database) {}

  async createTask(input: Parameters<VnextGenerationStore["createTask"]>[0]): Promise<{ task: VnextGenerationTask; created: boolean }> {
    return this.db.transaction(async (tx) => {
      // Idempotency check: same project/actor/key returns existing task.
      const existing = await tx.execute<TaskRow>(sql`
        SELECT ${TASK_COLS}
        FROM vnext.generation_tasks
        WHERE project_id = ${input.projectId}::uuid
          AND actor_id = ${input.actorId}::uuid
          AND client_idempotency_key = ${input.clientIdempotencyKey}
        LIMIT 1 FOR UPDATE`);
      if (existing.rows[0]) {
        // Confirm the idempotent match covers the same intent.
        const t = toTask(existing.rows[0]);
        if (t.intentId !== input.intentId || t.controlPackageId !== input.controlPackageId) {
          throw new ConflictError(
            "该幂等键已用于另一份生成意图，请刷新后重新确认",
            "VNEXT_GENERATION_IDEMPOTENCY_CONFLICT",
          );
        }
        return { task: t, created: false };
      }

      const taskId = randomUUID();
      const taskRow = await tx.execute<TaskRow>(sql`
        INSERT INTO vnext.generation_tasks (
          id, project_id, actor_id, intent_id, client_idempotency_key,
          control_package_id, control_package_version, reference_snapshot,
          provider, model, prompt, no_bgm, parameters, estimated_cost_fen, status
        ) VALUES (
          ${taskId}::uuid, ${input.projectId}::uuid, ${input.actorId}::uuid,
          ${input.intentId}::uuid, ${input.clientIdempotencyKey},
          ${input.controlPackageId}::uuid, ${input.controlPackageVersion},
          ${JSON.stringify(input.references)}::jsonb, ${input.provider}, ${input.model},
          ${input.prompt}, ${input.noBgm}, ${JSON.stringify(input.parameters)}::jsonb,
          ${input.estimatedCostFen}, 'created'
        ) RETURNING ${TASK_COLS}`);
      const task = toTask(taskRow.rows[0]!);

      // Append the first attempt.
      await tx.execute(sql`
        INSERT INTO vnext.generation_attempts (
          id, task_id, attempt_no, status, tos_media
        ) VALUES (
          ${randomUUID()}::uuid, ${taskId}::uuid, 1, 'created', '[]'::jsonb
        )`);

      return { task, created: true };
    });
  }

  async getTaskView(taskId: string, projectId: string): Promise<VnextGenerationTaskView | null> {
    const taskRows = await this.db.execute<TaskRow>(sql`
      SELECT ${TASK_COLS} FROM vnext.generation_tasks
      WHERE id = ${taskId}::uuid AND project_id = ${projectId}::uuid`);
    if (!taskRows.rows[0]) return null;
    const task = toTask(taskRows.rows[0]);
    const attempt = await this.latestAttemptFor(this.db, task.id);
    return { task, latestAttempt: attempt ? toAttemptView(attempt) : null };
  }

  async claimNextAttempt(workerId: string, leaseSeconds: number): Promise<string | null> {
    const row = await this.db.execute<{ id: string }>(sql`
      UPDATE vnext.generation_attempts
      SET lease_owner = ${workerId},
          lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
      WHERE id = (
        SELECT id FROM vnext.generation_attempts
        WHERE status IN ('created', 'provider_queued', 'provider_running', 'provider_succeeded', 'copying_to_tos')
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY updated_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`);
    return row.rows[0]?.id ?? null;
  }

  async renewLease(attemptId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE vnext.generation_attempts
      SET lease_expires_at = now() + (${leaseSeconds} || ' seconds')::interval
      WHERE id = ${attemptId}::uuid
        AND lease_owner = ${workerId}
        AND status NOT IN ('succeeded', 'failed', 'unknown_outcome')
      RETURNING id`);
    return result.rows.length > 0;
  }

  async releaseLease(attemptId: string, workerId: string, delaySeconds?: number): Promise<void> {
    const expiresAt = typeof delaySeconds === "number" && delaySeconds > 0
      ? sql`now() + (${delaySeconds} || ' seconds')::interval`
      : sql`now()`;
    await this.db.execute(sql`
      UPDATE vnext.generation_attempts
      SET lease_expires_at = ${expiresAt}
      WHERE id = ${attemptId}::uuid AND lease_owner = ${workerId}`);
  }

  async getRecoverableContext(attemptId: string): Promise<VnextRecoverableAttemptContext | null> {
    const rows = await this.db.execute<{ task: TaskRow; attempt: AttemptRow }>(sql`
      SELECT
        row_to_json(t.*) AS task,
        row_to_json(a.*) AS attempt
      FROM vnext.generation_attempts a
      JOIN vnext.generation_tasks t ON t.id = a.task_id
      WHERE a.id = ${attemptId}::uuid`);
    if (!rows.rows[0]) return null;
    const r = rows.rows[0] as unknown as { task: TaskRow; attempt: AttemptRow };
    return { task: toTask(r.task), attempt: toAttempt(r.attempt) };
  }

  async markSubmitting(attemptId: string, leaseOwner?: string): Promise<void> {
    await this.writeAttemptPhase(
      attemptId,
      sql`status = 'submitting'`,
      ["created"],
      leaseOwner,
    );
  }

  async markProviderQueued(attemptId: string, providerTaskId: string, rawStatus: string, leaseOwner?: string): Promise<void> {
    await this.writeAttemptPhase(
      attemptId,
      sql`status = 'provider_queued',
          provider_task_id = ${providerTaskId},
          provider_raw_status = ${rawStatus}`,
      ["submitting"],
      leaseOwner,
    );
  }

  async markProviderProgress(attemptId: string, rawStatus: string, leaseOwner?: string): Promise<void> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE vnext.generation_attempts
      SET status = 'provider_running',
          provider_raw_status = ${rawStatus}
      WHERE id = ${attemptId}::uuid
        AND status IN ('provider_queued', 'provider_running')
        ${leaseOwner ? sql`AND lease_owner = ${leaseOwner}` : sql``}
      RETURNING id`);
    if (!result.rows[0]) {
      await this.checkLeaseLost(attemptId, leaseOwner);
    }
  }

  async markProviderSucceeded(attemptId: string, result: VnextProviderResultSnapshot, leaseOwner?: string): Promise<void> {
    await this.writeAttemptPhase(
      attemptId,
      sql`status = 'provider_succeeded',
          provider_raw_status = ${result.rawStatus},
          provider_result = ${JSON.stringify(result)}::jsonb`,
      ["provider_queued", "provider_running"],
      leaseOwner,
    );
  }

  async markCopyingToTos(attemptId: string, leaseOwner?: string): Promise<void> {
    // Idempotent: provider_succeeded or already copying_to_tos both advance cleanly.
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE vnext.generation_attempts
      SET status = 'copying_to_tos'
      WHERE id = ${attemptId}::uuid
        AND status IN ('provider_succeeded', 'copying_to_tos')
        ${leaseOwner ? sql`AND lease_owner = ${leaseOwner}` : sql``}
      RETURNING id`);
    if (!result.rows[0]) {
      await this.checkLeaseLost(attemptId, leaseOwner);
    }
  }

  async recordTosMedia(attemptId: string, item: VnextTosMediaItem, leaseOwner?: string): Promise<void> {
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE vnext.generation_attempts
      SET tos_media = tos_media || ${JSON.stringify(item)}::jsonb
      WHERE id = ${attemptId}::uuid
        AND status = 'copying_to_tos'
        AND NOT (tos_media @> ${JSON.stringify([{ providerResultKey: item.providerResultKey }])}::jsonb)
        ${leaseOwner ? sql`AND lease_owner = ${leaseOwner}` : sql``}
      RETURNING id`);
    // A duplicate key is safe to ignore (idempotent append).
    if (!result.rows[0]) {
      await this.checkLeaseLost(attemptId, leaseOwner);
    }
  }

  async markSucceeded(attemptId: string, leaseOwner?: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.execute<{ task_id: string }>(sql`
        UPDATE vnext.generation_attempts
        SET status = 'succeeded'
        WHERE id = ${attemptId}::uuid
          AND status = 'copying_to_tos'
          ${leaseOwner ? sql`AND lease_owner = ${leaseOwner}` : sql``}
        RETURNING task_id`);
      if (!result.rows[0]) {
        await this.checkLeaseLost(attemptId, leaseOwner, tx);
        return;
      }
      await tx.execute(sql`
        UPDATE vnext.generation_tasks
        SET status = 'succeeded'
        WHERE id = ${result.rows[0].task_id}::uuid`);
    });
  }

  async markFailed(input: { attemptId: string; errorCode: string; errorMessage: string; actualCostFen?: number; leaseOwner?: string }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.execute<{ task_id: string }>(sql`
        UPDATE vnext.generation_attempts
        SET status = 'failed',
            error_code = ${input.errorCode},
            error_message = ${input.errorMessage},
            actual_cost_fen = ${input.actualCostFen ?? null}
        WHERE id = ${input.attemptId}::uuid
          AND status NOT IN ('succeeded', 'failed', 'unknown_outcome')
          ${input.leaseOwner ? sql`AND lease_owner = ${input.leaseOwner}` : sql``}
        RETURNING task_id`);
      if (!result.rows[0]) {
        await this.checkLeaseLost(input.attemptId, input.leaseOwner, tx);
        return;
      }
      await tx.execute(sql`
        UPDATE vnext.generation_tasks
        SET status = 'failed'
        WHERE id = ${result.rows[0].task_id}::uuid`);
    });
  }

  async markUnknownOutcome(attemptId: string, reason: string, leaseOwner?: string): Promise<void> {
    // unknown_outcome means the paid POST may or may not have been accepted.
    // The task stays in running state; a human can inspect and re-confirm.
    const result = await this.db.execute<{ id: string }>(sql`
      UPDATE vnext.generation_attempts
      SET status = 'unknown_outcome',
          error_code = 'SUBMISSION_OUTCOME_UNKNOWN',
          error_message = ${reason}
      WHERE id = ${attemptId}::uuid
        AND status NOT IN ('succeeded', 'failed', 'unknown_outcome')
        ${leaseOwner ? sql`AND lease_owner = ${leaseOwner}` : sql``}
      RETURNING id`);
    if (!result.rows[0]) {
      await this.checkLeaseLost(attemptId, leaseOwner);
    }
  }

  async recordPollFailure(attemptId: string, reason: string, leaseOwner?: string): Promise<void> {
    // A poll outage does not change the attempt status; only update the message.
    await this.db.execute(sql`
      UPDATE vnext.generation_attempts
      SET error_message = ${reason}
      WHERE id = ${attemptId}::uuid
        AND status IN ('provider_queued', 'provider_running')
        ${leaseOwner ? sql`AND lease_owner = ${leaseOwner}` : sql``}`);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async latestAttemptFor(db: Database, taskId: string): Promise<VnextGenerationAttempt | null> {
    const rows = await db.execute<AttemptRow>(sql`
      SELECT ${ATTEMPT_COLS} FROM vnext.generation_attempts
      WHERE task_id = ${taskId}::uuid
      ORDER BY attempt_no DESC LIMIT 1`);
    return rows.rows[0] ? toAttempt(rows.rows[0]) : null;
  }

  private async writeAttemptPhase(
    attemptId: string,
    setClauses: ReturnType<typeof sql>,
    fromStatuses: string[],
    leaseOwner?: string,
    db: Database = this.db,
  ): Promise<void> {
    const result = await db.execute<{ id: string }>(sql`
      UPDATE vnext.generation_attempts
      SET ${setClauses}
      WHERE id = ${attemptId}::uuid
        AND status = ANY(${`{${fromStatuses.join(",")}}`}::text[])
        ${leaseOwner ? sql`AND lease_owner = ${leaseOwner}` : sql``}
      RETURNING id`);
    if (!result.rows[0]) {
      await this.checkLeaseLost(attemptId, leaseOwner, db);
    }
  }

  private async checkLeaseLost(attemptId: string, leaseOwner?: string, db: Database = this.db): Promise<void> {
    if (!leaseOwner) return;
    const row = await db.execute<{ lease_owner: string | null }>(sql`
      SELECT lease_owner FROM vnext.generation_attempts WHERE id = ${attemptId}::uuid`);
    if (!row.rows[0] || row.rows[0].lease_owner !== leaseOwner) {
      throw new VnextAttemptLeaseLostError(attemptId);
    }
  }
}

function toAttemptView(a: VnextGenerationAttempt) {
  return {
    id: a.id,
    attemptNo: a.attemptNo,
    status: a.status,
    providerTaskId: a.providerTaskId,
    tosMedia: a.tosMedia,
    errorCode: a.errorCode,
    errorMessage: a.errorMessage,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
