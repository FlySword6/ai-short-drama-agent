import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { ConflictError, NotFoundError } from "../../../shared/errors.js";
import type { VnextTosMediaItem } from "../generation/types.js";
import type { VnextVideoChangeDraft, VnextVideoChangeType, VnextVideoVersion } from "./types.js";

// ─── Row types ────────────────────────────────────────────────────────────────

interface VersionRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  chain_id: string;
  version_no: number;
  change_type: string;
  origin_version_id: string | null;
  actor_id: string;
  source_task_id: string;
  source_attempt_id: string;
  control_package_id: string;
  control_package_version: number;
  provider: string;
  model: string;
  prompt: string;
  parameters: Record<string, unknown>;
  tos_media: VnextTosMediaItem[];
  estimated_cost_fen: string;
  actual_cost_fen: string | null;
  created_at: Date | string;
}

interface DraftRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  actor_id: string;
  origin_version_id: string;
  change_type: string;
  intent_id: string;
  client_idempotency_key: string;
  created_at: Date | string;
}

// ─── Store interfaces ─────────────────────────────────────────────────────────

export interface CreateVnextVideoVersionInput {
  projectId: string;
  actorId: string;
  changeType: VnextVideoChangeType;
  originVersionId: string | null;
  sourceTaskId: string;
  sourceAttemptId: string;
  controlPackageId: string;
  controlPackageVersion: number;
  provider: string;
  model: string;
  prompt: string;
  parameters: Record<string, unknown>;
  tosMedia: VnextTosMediaItem[];
  estimatedCostFen: number;
  actualCostFen: number | null;
}

export interface VnextVideoVersionStore {
  listByProject(projectId: string): Promise<VnextVideoVersion[]>;
  findById(versionId: string, projectId: string): Promise<VnextVideoVersion | null>;
  /** Idempotent append: same (project, source_attempt) replays the existing version. */
  create(input: CreateVnextVideoVersionInput): Promise<{ version: VnextVideoVersion; created: boolean }>;
}

export interface CreateVnextVideoChangeDraftInput {
  projectId: string;
  actorId: string;
  originVersionId: string;
  changeType: "modify" | "extend";
  intentId: string;
  clientIdempotencyKey: string;
}

export interface VnextVideoChangeDraftStore {
  findByKey(projectId: string, actorId: string, clientIdempotencyKey: string): Promise<VnextVideoChangeDraft | null>;
  findByIntentId(intentId: string): Promise<VnextVideoChangeDraft | null>;
  /** Crash recovery: intent created by an earlier draft request whose linkage insert never landed. */
  findUnlinkedIntentIdByKey(projectId: string, actorId: string, clientIdempotencyKey: string): Promise<string | null>;
  create(input: CreateVnextVideoChangeDraftInput): Promise<{ draft: VnextVideoChangeDraft; created: boolean }>;
}

// ─── Repositories ─────────────────────────────────────────────────────────────

const VERSION_COLS = sql`
  id, project_id, chain_id, version_no, change_type, origin_version_id, actor_id,
  source_task_id, source_attempt_id, control_package_id, control_package_version,
  provider, model, prompt, parameters, tos_media, estimated_cost_fen, actual_cost_fen,
  created_at`;

export class VnextVideoVersionRepository implements VnextVideoVersionStore {
  constructor(private readonly db: Database) {}

  async listByProject(projectId: string): Promise<VnextVideoVersion[]> {
    const result = await this.db.execute<VersionRow>(sql`
      SELECT ${VERSION_COLS}
      FROM vnext.video_versions
      WHERE project_id = ${projectId}::uuid
      ORDER BY chain_id ASC, version_no ASC, created_at ASC`);
    return result.rows.map(toVersion);
  }

  async findById(versionId: string, projectId: string): Promise<VnextVideoVersion | null> {
    const result = await this.db.execute<VersionRow>(sql`
      SELECT ${VERSION_COLS}
      FROM vnext.video_versions
      WHERE id = ${versionId}::uuid AND project_id = ${projectId}::uuid
      LIMIT 1`);
    return result.rows[0] ? toVersion(result.rows[0]) : null;
  }

  async create(input: CreateVnextVideoVersionInput): Promise<{ version: VnextVideoVersion; created: boolean }> {
    return this.db.transaction(async (tx) => {
      // video_versions is immutable by contract (010 revokes UPDATE/DELETE from
      // vnext_app), so this idempotency pre-check must not take row locks — a
      // locking read here fails with 42501 under the real runtime role.
      // Serialize per project with the same advisory-lock pattern as
      // PendingIntentRepository.create; domain 2 keeps the key space distinct
      // from control packages (0) and pending intents (1).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 2))`);
      const prior = await tx.execute<VersionRow>(sql`
        SELECT ${VERSION_COLS}
        FROM vnext.video_versions
        WHERE project_id = ${input.projectId}::uuid AND source_attempt_id = ${input.sourceAttemptId}::uuid
        LIMIT 1`);
      if (prior.rows[0]) {
        return { version: toVersion(prior.rows[0]), created: false };
      }

      const id = randomUUID();
      let chainId: string = id;
      let versionNo = 1;
      if (input.originVersionId) {
        const origin = await tx.execute<{ id: string; chain_id: string; version_no: number }>(sql`
          SELECT id, chain_id, version_no
          FROM vnext.video_versions
          WHERE id = ${input.originVersionId}::uuid AND project_id = ${input.projectId}::uuid
          LIMIT 1`);
        if (!origin.rows[0]) {
          throw new NotFoundError("原视频段版本不存在，无法在其上修改或续写");
        }
        const child = await tx.execute<{ id: string }>(sql`
          SELECT id FROM vnext.video_versions
          WHERE origin_version_id = ${input.originVersionId}::uuid
          LIMIT 1`);
        if (child.rows[0]) {
          throw new ConflictError("该视频段版本已经有后续版本，请基于最新版本继续修改或续写", "video_version_chain_conflict");
        }
        chainId = origin.rows[0].chain_id;
        versionNo = origin.rows[0].version_no + 1;
      }

      try {
        const row = await tx.execute<VersionRow>(sql`
          INSERT INTO vnext.video_versions (
            id, project_id, chain_id, version_no, change_type, origin_version_id, actor_id,
            source_task_id, source_attempt_id, control_package_id, control_package_version,
            provider, model, prompt, parameters, tos_media, estimated_cost_fen, actual_cost_fen
          ) VALUES (
            ${id}::uuid, ${input.projectId}::uuid, ${chainId}::uuid, ${versionNo}, ${input.changeType},
            ${input.originVersionId}::uuid, ${input.actorId}::uuid,
            ${input.sourceTaskId}::uuid, ${input.sourceAttemptId}::uuid,
            ${input.controlPackageId}::uuid, ${input.controlPackageVersion},
            ${input.provider}, ${input.model}, ${input.prompt},
            ${JSON.stringify(input.parameters)}::jsonb, ${JSON.stringify(input.tosMedia)}::jsonb,
            ${input.estimatedCostFen}, ${input.actualCostFen}
          ) RETURNING ${VERSION_COLS}`);
        return { version: toVersion(row.rows[0]!), created: true };
      } catch (error) {
        // Cross-process race safety net (the advisory lock already serializes
        // same-database writers): a concurrent child on the same origin or a
        // duplicate attempt registration surfaces as a domain conflict.
        if (isUniqueViolation(error, "vnext_video_versions_attempt_unique")) {
          const replayed = await tx.execute<VersionRow>(sql`
            SELECT ${VERSION_COLS} FROM vnext.video_versions
            WHERE project_id = ${input.projectId}::uuid AND source_attempt_id = ${input.sourceAttemptId}::uuid
            LIMIT 1`);
          if (replayed.rows[0]) return { version: toVersion(replayed.rows[0]), created: false };
        }
        if (isUniqueViolation(error, "vnext_video_versions_single_child")
          || isUniqueViolation(error, "vnext_video_versions_chain_version_unique")) {
          throw new ConflictError("该视频段版本已经有后续版本，请基于最新版本继续修改或续写", "video_version_chain_conflict");
        }
        throw error;
      }
    });
  }
}

const DRAFT_COLS = sql`
  id, project_id, actor_id, origin_version_id, change_type, intent_id,
  client_idempotency_key, created_at`;

export class VnextVideoChangeDraftRepository implements VnextVideoChangeDraftStore {
  constructor(private readonly db: Database) {}

  async findByKey(projectId: string, actorId: string, clientIdempotencyKey: string): Promise<VnextVideoChangeDraft | null> {
    const result = await this.db.execute<DraftRow>(sql`
      SELECT ${DRAFT_COLS}
      FROM vnext.video_change_drafts
      WHERE project_id = ${projectId}::uuid AND actor_id = ${actorId}::uuid
        AND client_idempotency_key = ${clientIdempotencyKey}
      LIMIT 1`);
    return result.rows[0] ? toDraft(result.rows[0]) : null;
  }

  async findByIntentId(intentId: string): Promise<VnextVideoChangeDraft | null> {
    const result = await this.db.execute<DraftRow>(sql`
      SELECT ${DRAFT_COLS}
      FROM vnext.video_change_drafts
      WHERE intent_id = ${intentId}::uuid
      LIMIT 1`);
    return result.rows[0] ? toDraft(result.rows[0]) : null;
  }

  async findUnlinkedIntentIdByKey(projectId: string, actorId: string, clientIdempotencyKey: string): Promise<string | null> {
    const result = await this.db.execute<{ id: string }>(sql`
      SELECT i.id
      FROM vnext.pending_generation_intents i
      WHERE i.project_id = ${projectId}::uuid AND i.actor_id = ${actorId}::uuid
        AND i.client_idempotency_key = ${clientIdempotencyKey}
        AND NOT EXISTS (
          SELECT 1 FROM vnext.video_change_drafts d WHERE d.intent_id = i.id
        )
      LIMIT 1`);
    return result.rows[0]?.id ?? null;
  }

  async create(input: CreateVnextVideoChangeDraftInput): Promise<{ draft: VnextVideoChangeDraft; created: boolean }> {
    return this.db.transaction(async (tx) => {
      // Same immutable-table constraint as video_versions: advisory lock only,
      // never a locking read. Domain 3 keeps the key space distinct.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 3))`);
      const prior = await tx.execute<DraftRow>(sql`
        SELECT ${DRAFT_COLS}
        FROM vnext.video_change_drafts
        WHERE project_id = ${input.projectId}::uuid AND actor_id = ${input.actorId}::uuid
          AND client_idempotency_key = ${input.clientIdempotencyKey}
        LIMIT 1`);
      if (prior.rows[0]) {
        const existing = toDraft(prior.rows[0]);
        if (existing.intentId !== input.intentId || existing.originVersionId !== input.originVersionId || existing.changeType !== input.changeType) {
          throw new ConflictError("幂等键已经用于另一份修改/续写草稿，请刷新后重新发起", "video_change_draft_idempotency_conflict");
        }
        return { draft: existing, created: false };
      }
      const row = await tx.execute<DraftRow>(sql`
        INSERT INTO vnext.video_change_drafts (
          id, project_id, actor_id, origin_version_id, change_type, intent_id, client_idempotency_key
        ) VALUES (
          ${randomUUID()}::uuid, ${input.projectId}::uuid, ${input.actorId}::uuid,
          ${input.originVersionId}::uuid, ${input.changeType}, ${input.intentId}::uuid,
          ${input.clientIdempotencyKey}
        ) RETURNING ${DRAFT_COLS}`);
      return { draft: toDraft(row.rows[0]!), created: true };
    });
  }
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function toVersion(row: VersionRow): VnextVideoVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    chainId: row.chain_id,
    versionNo: row.version_no,
    changeType: row.change_type as VnextVideoVersion["changeType"],
    originVersionId: row.origin_version_id ?? null,
    actorId: row.actor_id,
    sourceTaskId: row.source_task_id,
    sourceAttemptId: row.source_attempt_id,
    controlPackageId: row.control_package_id,
    controlPackageVersion: row.control_package_version,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    parameters: row.parameters ?? {},
    tosMedia: row.tos_media ?? [],
    estimatedCostFen: Number(row.estimated_cost_fen),
    actualCostFen: row.actual_cost_fen !== null ? Number(row.actual_cost_fen) : null,
    createdAt: toIso(row.created_at),
  };
}

function toDraft(row: DraftRow): VnextVideoChangeDraft {
  return {
    id: row.id,
    projectId: row.project_id,
    actorId: row.actor_id,
    originVersionId: row.origin_version_id,
    changeType: row.change_type as VnextVideoChangeDraft["changeType"],
    intentId: row.intent_id,
    clientIdempotencyKey: row.client_idempotency_key,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const code = (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "23505" && message.includes(constraint);
}
