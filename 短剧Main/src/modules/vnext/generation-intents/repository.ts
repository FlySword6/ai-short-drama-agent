import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { ConflictError } from "../../../shared/errors.js";
import type { PendingGenerationIntent } from "./types.js";

interface IntentRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  actor_id: string;
  client_idempotency_key: string;
  control_package_id: string;
  control_package_version: number;
  snapshot: Omit<PendingGenerationIntent, "id" | "projectId" | "actorId" | "clientIdempotencyKey" | "controlPackageId" | "controlPackageVersion" | "createdAt">;
  created_at: Date | string;
}

export interface PendingIntentStore {
  latest(projectId: string, actorId: string): Promise<PendingGenerationIntent | null>;
  findById(intentId: string, projectId: string): Promise<PendingGenerationIntent | null>;
  create(input: Omit<PendingGenerationIntent, "id" | "createdAt">): Promise<{ intent: PendingGenerationIntent; created: boolean }>;
}

/** This repository persists a reviewable intent only; it has no provider, upload, reservation, or billing dependency. */
export class PendingIntentRepository implements PendingIntentStore {
  constructor(private readonly db: Database) {}

  async latest(projectId: string, actorId: string): Promise<PendingGenerationIntent | null> {
    const result = await this.db.execute<IntentRow>(sql`
      SELECT id, project_id, actor_id, client_idempotency_key, control_package_id,
             control_package_version, snapshot, created_at
      FROM vnext.pending_generation_intents
      WHERE project_id = ${projectId}::uuid AND actor_id = ${actorId}::uuid
      ORDER BY created_at DESC LIMIT 1`);
    return result.rows[0] ? toIntent(result.rows[0]) : null;
  }

  async findById(intentId: string, projectId: string): Promise<PendingGenerationIntent | null> {
    const result = await this.db.execute<IntentRow>(sql`
      SELECT id, project_id, actor_id, client_idempotency_key, control_package_id,
             control_package_version, snapshot, created_at
      FROM vnext.pending_generation_intents
      WHERE id = ${intentId}::uuid AND project_id = ${projectId}::uuid
      LIMIT 1`);
    return result.rows[0] ? toIntent(result.rows[0]) : null;
  }

  async create(input: Omit<PendingGenerationIntent, "id" | "createdAt">): Promise<{ intent: PendingGenerationIntent; created: boolean }> {
    return this.db.transaction(async (tx) => {
      // pending_generation_intents is immutable by contract (008 revokes
      // UPDATE/DELETE from vnext_app), so this idempotency pre-check must not
      // take row locks. Serialize per project with the same advisory-lock
      // pattern as ControlPackageRepository.write; domain 1 keeps the key
      // space distinct from the control-package domain 0.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 1))`);
      const prior = await tx.execute<IntentRow>(sql`
        SELECT id, project_id, actor_id, client_idempotency_key, control_package_id,
               control_package_version, snapshot, created_at
        FROM vnext.pending_generation_intents
        WHERE project_id = ${input.projectId}::uuid AND actor_id = ${input.actorId}::uuid
          AND client_idempotency_key = ${input.clientIdempotencyKey}
        LIMIT 1`);
      if (prior.rows[0]) {
        const existing = toIntent(prior.rows[0]);
        if (existing.controlPackageId !== input.controlPackageId || existing.controlPackageVersion !== input.controlPackageVersion) {
          throw new ConflictError("幂等键已经用于另一份生成控制包，请刷新后重新确认", "pending_intent_idempotency_conflict");
        }
        return { intent: existing, created: false };
      }
      const row = await tx.execute<IntentRow>(sql`
        INSERT INTO vnext.pending_generation_intents (
          id, project_id, actor_id, client_idempotency_key, control_package_id,
          control_package_version, snapshot
        ) VALUES (
          ${randomUUID()}::uuid, ${input.projectId}::uuid, ${input.actorId}::uuid,
          ${input.clientIdempotencyKey}, ${input.controlPackageId}::uuid,
          ${input.controlPackageVersion}, ${JSON.stringify(snapshot(input))}::jsonb
        ) RETURNING id, project_id, actor_id, client_idempotency_key, control_package_id,
          control_package_version, snapshot, created_at`);
      return { intent: toIntent(row.rows[0]!), created: true };
    });
  }
}

function snapshot(input: Omit<PendingGenerationIntent, "id" | "createdAt">): IntentRow["snapshot"] {
  return {
    references: input.references.map((reference) => ({ ...reference, capabilitySnapshot: { ...reference.capabilitySnapshot, capabilities: [...reference.capabilitySnapshot.capabilities] } })),
    finalPrompt: input.finalPrompt, model: input.model, parameters: { ...input.parameters },
    noBgm: input.noBgm, estimatedCostFen: input.estimatedCostFen, status: "pending_confirmation",
  };
}

function toIntent(row: IntentRow): PendingGenerationIntent {
  return {
    id: row.id, projectId: row.project_id, actorId: row.actor_id, clientIdempotencyKey: row.client_idempotency_key,
    controlPackageId: row.control_package_id, controlPackageVersion: row.control_package_version,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    ...snapshot({
      projectId: row.project_id, actorId: row.actor_id, clientIdempotencyKey: row.client_idempotency_key,
      controlPackageId: row.control_package_id, controlPackageVersion: row.control_package_version,
      ...row.snapshot,
    }),
  };
}
