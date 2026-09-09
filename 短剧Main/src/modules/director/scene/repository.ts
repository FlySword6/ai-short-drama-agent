import type { Pool } from "pg";
import { settings } from "../../../config/env.js";
import type { Database } from "../../../db/client.js";
import { ConflictError, NotFoundError } from "../../../shared/errors.js";

/**
 * 导演台场景持久化（director_scenes / director_scene_versions）。
 * 新表尚未进 drizzle schema（db/schema.ts 是公共文件），故本模块用注入的
 * pg client 写原生 SQL；DDL 真源是 migrations/004_director_scenes.sql。
 * 单测注入假 client，不依赖真实数据库。
 */

export interface DirectorDbQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}

export interface DirectorDbClient {
  query(text: string, values?: unknown[]): Promise<DirectorDbQueryResult>;
}

export interface DirectorDbExecutor extends DirectorDbClient {
  transaction<T>(fn: (client: DirectorDbClient) => Promise<T>): Promise<T>;
}

/** 从 drizzle 持有的 pg Pool 构造执行器（不修改 db 层任何文件）。 */
export function createPgDirectorDb(db: Database): DirectorDbExecutor {
  const pool = (db as unknown as { $client?: Pool }).$client;
  if (!pool) throw new Error("director 模块需要由 pg Pool 驱动的 Database");
  return {
    query: (text, values) => pool.query(text, values),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

const schemaName = /^[a-z_][a-z0-9_]*$/.test(settings.postgresSchema) ? settings.postgresSchema : "app";
const q = (table: string) => `${schemaName}.${table}`;

export const DIRECTOR_SCENE_STATUSES = ["draft", "saved", "archived"] as const;
export type DirectorSceneStatus = (typeof DIRECTOR_SCENE_STATUSES)[number];

export interface DirectorSceneRecord {
  id: string;
  projectId: string;
  status: DirectorSceneStatus;
  currentVersion: number;
  /** 当前版本快照（尚无版本时为 null）。 */
  snapshot: Record<string, unknown> | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DirectorSceneVersionRecord {
  id: string;
  sceneId: string;
  version: number;
  /** 派生语义：version = scenes.current_version 即 current，其余为 historical。 */
  kind: "current" | "historical";
  sourceAction: string;
  createdByUserId: string;
  createdAt: string;
}

export interface SaveSceneVersionInput {
  projectId: string;
  actorId: string;
  /** 乐观锁：期望的当前版本；创建场景时必须为 0。 */
  expectedVersion: number;
  snapshot: Record<string, unknown>;
  sourceAction: string;
  status?: "draft" | "saved";
}

export interface SaveSceneVersionResult {
  scene: DirectorSceneRecord;
  version: DirectorSceneVersionRecord;
}

export class PgDirectorSceneRepository {
  constructor(private readonly db: DirectorDbExecutor) {}

  async getScene(projectId: string): Promise<DirectorSceneRecord | null> {
    return getSceneWith(this.db, projectId);
  }

  async listVersions(sceneId: string): Promise<DirectorSceneVersionRecord[]> {
    const result = await this.db.query(
      `SELECT v.id, v.scene_id, v.version,
              (v.version = s.current_version) AS is_current,
              v.source_action, v.created_by_user_id, v.created_at
         FROM ${q("director_scene_versions")} v
         JOIN ${q("director_scenes")} s ON s.id = v.scene_id
        WHERE v.scene_id = $1
        ORDER BY v.version DESC`,
      [sceneId],
    );
    return result.rows.map(toVersionRecord);
  }

  /**
   * 保存新版本：服务层先用 ProjectAccessService 完成项目鉴权；这里仅负责
   * 行锁场景与条件更新乐观锁，避免在导演台复制一套 owner 判定。
   * 版本不符（含并发）抛 409 scene_version_conflict；版本号单调 +1。
   */
  async saveVersion(input: SaveSceneVersionInput): Promise<SaveSceneVersionResult> {
    return this.db.transaction(async (client) => {
      const existing = await client.query(
        `SELECT id, status, current_version
           FROM ${q("director_scenes")}
          WHERE project_id = $1 AND archived_at IS NULL
          FOR UPDATE`,
        [input.projectId],
      );
      const scene = existing.rows[0];

      if (!scene) {
        if (input.expectedVersion !== 0) {
          throw new NotFoundError("导演场景还没创建，请先新建场景");
        }
        const created = await client.query(
          `INSERT INTO ${q("director_scenes")}
             (id, project_id, status, current_version, created_by_user_id, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, 1, $3, now(), now())
           RETURNING id`,
          [input.projectId, input.status ?? "saved", input.actorId],
        );
        const sceneId = String(created.rows[0]?.["id"]);
        const version = await insertVersion(client, sceneId, 1, input);
        const record = await getSceneWith(client, input.projectId);
        if (!record) throw new Error("导演场景创建后读取失败");
        return { scene: record, version };
      }

      const currentVersion = Number(scene["current_version"]);
      if (currentVersion !== input.expectedVersion) {
        throw new ConflictError(
          "保存场景没成：场景已被更新，请刷新后再试。",
          "scene_version_conflict",
          { currentVersion },
        );
      }

      const nextVersion = currentVersion + 1;
      const updated = await client.query(
        `UPDATE ${q("director_scenes")}
            SET current_version = $2, status = $3, updated_at = now()
          WHERE id = $1 AND current_version = $4`,
        [scene["id"], nextVersion, input.status ?? "saved", currentVersion],
      );
      if (updated.rowCount !== 1) {
        throw new ConflictError(
          "保存场景没成：场景已被更新，请刷新后再试。",
          "scene_version_conflict",
          { currentVersion },
        );
      }

      const version = await insertVersion(client, String(scene["id"]), nextVersion, input);
      const record = await getSceneWith(client, input.projectId);
      if (!record) throw new Error("导演场景保存后读取失败");
      return { scene: record, version };
    });
  }
}

async function getSceneWith(client: DirectorDbClient, projectId: string): Promise<DirectorSceneRecord | null> {
  const result = await client.query(
    `SELECT s.id, s.project_id, s.status, s.current_version,
            v.snapshot,
            s.created_by_user_id, s.created_at, s.updated_at
       FROM ${q("director_scenes")} s
       LEFT JOIN ${q("director_scene_versions")} v
         ON v.scene_id = s.id AND v.version = s.current_version
      WHERE s.project_id = $1 AND s.archived_at IS NULL
      LIMIT 1`,
    [projectId],
  );
  const row = result.rows[0];
  return row ? toSceneRecord(row) : null;
}

async function insertVersion(
  client: DirectorDbClient,
  sceneId: string,
  version: number,
  input: SaveSceneVersionInput,
): Promise<DirectorSceneVersionRecord> {
  const result = await client.query(
    `INSERT INTO ${q("director_scene_versions")}
       (id, scene_id, version, snapshot, source_action, created_by_user_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4, $5, now())
     RETURNING id, scene_id, version, true AS is_current, source_action, created_by_user_id, created_at`,
    [sceneId, version, JSON.stringify(input.snapshot), input.sourceAction, input.actorId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("导演场景版本写入失败");
  return toVersionRecord(row);
}

function toSceneRecord(row: Record<string, unknown>): DirectorSceneRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    status: row["status"] as DirectorSceneStatus,
    currentVersion: Number(row["current_version"]),
    snapshot: (row["snapshot"] ?? null) as Record<string, unknown> | null,
    createdByUserId: String(row["created_by_user_id"]),
    createdAt: toIso(row["created_at"]),
    updatedAt: toIso(row["updated_at"]),
  };
}

function toVersionRecord(row: Record<string, unknown>): DirectorSceneVersionRecord {
  return {
    id: String(row["id"]),
    sceneId: String(row["scene_id"]),
    version: Number(row["version"]),
    kind: row["is_current"] ? "current" : "historical",
    sourceAction: String(row["source_action"]),
    createdByUserId: String(row["created_by_user_id"]),
    createdAt: toIso(row["created_at"]),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
