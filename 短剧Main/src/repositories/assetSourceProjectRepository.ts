import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { assetEntities, assetSourceProjects, type AssetSourceProjectRow } from "../db/schema.js";
import type { JsonObject } from "../domain/assets/types.js";

export type AssetSourceProjectListScope = "personal" | "common" | "all";

export interface AssetSourceProjectListItem {
  id: string;
  name: string | null;
  code: string | null;
  description: string | null;
  projectType: string | null;
  metadata: JsonObject;
  assetCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
  latestAssetAt: Date | null;
}

interface SourceProjectListRow {
  id: string;
  name: string | null;
  code: string | null;
  description: string | null;
  project_type: string | null;
  metadata: unknown;
  asset_count: number | string;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  latest_asset_at: Date | string | null;
}

interface SqlResult<T> {
  rows: T[];
}

export class AssetSourceProjectRepository {
  constructor(private readonly db: Database) {}

  async getByName(name: string): Promise<AssetSourceProjectRow | undefined> {
    const rows = await this.db
      .select()
      .from(assetSourceProjects)
      .where(eq(assetSourceProjects.name, name))
      .limit(1);
    return rows[0];
  }

  async getOrCreate(input: {
    name: string;
    code?: string | null;
    description?: string | null;
    projectType?: string | null;
    metadata?: JsonObject;
  }): Promise<AssetSourceProjectRow> {
    const existing = await this.getByName(input.name);
    if (existing) return existing;

    const now = new Date();
    const rows = await this.db
      .insert(assetSourceProjects)
      .values({
        id: crypto.randomUUID(),
        name: input.name,
        code: input.code ?? null,
        description: input.description ?? null,
        projectType: input.projectType ?? null,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("Failed to create asset source project");
    return created;
  }

  async listVisibleForUser(
    actorId: string,
    input: { scope?: AssetSourceProjectListScope; limit?: number } = {},
  ): Promise<AssetSourceProjectListItem[]> {
    const scope = input.scope ?? "all";
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const rows = await queryRows<SourceProjectListRow>(this.db, sql`
      SELECT
        ${assetSourceProjects.id}::text AS id,
        ${assetSourceProjects.name} AS name,
        ${assetSourceProjects.code} AS code,
        ${assetSourceProjects.description} AS description,
        ${assetSourceProjects.projectType} AS project_type,
        ${assetSourceProjects.metadata} AS metadata,
        ${assetSourceProjects.createdAt} AS created_at,
        ${assetSourceProjects.updatedAt} AS updated_at,
        COUNT(${assetEntities.id})::int AS asset_count,
        MAX(${assetEntities.updatedAt}) AS latest_asset_at
      FROM ${assetSourceProjects}
      INNER JOIN ${assetEntities}
        ON ${assetEntities.sourceProjectId} = ${assetSourceProjects.id}
      WHERE ${assetEntities.deletedAt} IS NULL
        AND ${assetEntities.clearance} ->> 'search' IS DISTINCT FROM 'false'
        AND (${visibleAssetSql(actorId, scope)})
      GROUP BY
        ${assetSourceProjects.id},
        ${assetSourceProjects.name},
        ${assetSourceProjects.code},
        ${assetSourceProjects.description},
        ${assetSourceProjects.projectType},
        ${assetSourceProjects.metadata},
        ${assetSourceProjects.createdAt},
        ${assetSourceProjects.updatedAt}
      ORDER BY MAX(${assetEntities.updatedAt}) DESC NULLS LAST,
        ${assetSourceProjects.name} ASC NULLS LAST,
        ${assetSourceProjects.id} ASC
      LIMIT ${limit}
    `);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      projectType: row.project_type,
      metadata: jsonObject(row.metadata),
      assetCount: numberValue(row.asset_count),
      createdAt: dateValue(row.created_at),
      updatedAt: dateValue(row.updated_at),
      latestAssetAt: dateValue(row.latest_asset_at),
    }));
  }
}

function visibleAssetSql(actorId: string, scope: AssetSourceProjectListScope) {
  if (scope === "personal") return sql`${assetEntities.ownerUserId} = ${actorId}`;
  if (scope === "common") return sql`${assetEntities.visibility} = 'common'`;
  return sql`${assetEntities.visibility} = 'common' OR ${assetEntities.ownerUserId} = ${actorId}`;
}

function jsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function numberValue(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateValue(value: Date | string | null): Date | null {
  if (value instanceof Date) return value;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function queryRows<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(statement) as unknown as SqlResult<T>).rows;
}
