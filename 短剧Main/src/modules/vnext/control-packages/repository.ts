import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import type { ControlPackage, ControlPackageDraft } from "./types.js";

interface PackageRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  version: number;
  snapshot: ControlPackageDraft;
  created_by_user_id: string;
  created_at: Date | string;
}

export interface ControlPackageStore {
  latest(projectId: string): Promise<ControlPackage | null>;
  write(input: ControlPackageDraft & { projectId: string; actorId: string }): Promise<ControlPackage>;
}

/**
 * Versioned JSON snapshots make the exact reference order, immutable source-version
 * pointers, capability evidence, and final generation request one atomic fact.
 */
export class ControlPackageRepository implements ControlPackageStore {
  constructor(private readonly db: Database) {}

  async latest(projectId: string): Promise<ControlPackage | null> {
    const result = await this.db.execute<PackageRow>(sql`
      SELECT id, project_id, version, snapshot, created_by_user_id, created_at
      FROM vnext.control_package_versions
      WHERE project_id = ${projectId}::uuid
      ORDER BY version DESC
      LIMIT 1`);
    return result.rows[0] ? toPackage(result.rows[0]) : null;
  }

  async write(input: ControlPackageDraft & { projectId: string; actorId: string }): Promise<ControlPackage> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 0))`);
      const current = await tx.execute<{ version: number }>(sql`
        SELECT version FROM vnext.control_package_versions
        WHERE project_id = ${input.projectId}::uuid ORDER BY version DESC LIMIT 1`);
      const version = (current.rows[0]?.version ?? 0) + 1;
      const row = await tx.execute<PackageRow>(sql`
        INSERT INTO vnext.control_package_versions (
          id, project_id, version, snapshot, created_by_user_id
        ) VALUES (
          ${randomUUID()}::uuid, ${input.projectId}::uuid, ${version},
          ${JSON.stringify(snapshot(input))}::jsonb, ${input.actorId}::uuid
        ) RETURNING id, project_id, version, snapshot, created_by_user_id, created_at`);
      return toPackage(row.rows[0]!);
    });
  }
}

function snapshot(input: ControlPackageDraft): ControlPackageDraft {
  return {
    references: input.references.map((reference) => ({
      ...reference,
      capabilitySnapshot: { ...reference.capabilitySnapshot, capabilities: [...reference.capabilitySnapshot.capabilities] },
    })),
    finalPrompt: input.finalPrompt,
    model: input.model,
    parameters: { ...input.parameters },
    noBgm: input.noBgm,
    modelAvailability: { ...input.modelAvailability },
    estimatedCostFen: input.estimatedCostFen,
  };
}

function toPackage(row: PackageRow): ControlPackage {
  const capturedAt = row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString();
  return { id: row.id, projectId: row.project_id, version: row.version, createdByUserId: row.created_by_user_id, createdAt: capturedAt, ...snapshot(row.snapshot) };
}
