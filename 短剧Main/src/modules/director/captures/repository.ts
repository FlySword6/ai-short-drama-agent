import { settings } from "../../../config/env.js";
import type { StoredObject } from "../../../integrations/tosStorage.js";
import { BadRequestError, NotFoundError } from "../../../shared/errors.js";
import {
  type DirectorDbClient,
  type DirectorDbExecutor,
} from "../scene/repository.js";

/**
 * 导演台截图入库：asset_entities（scene_reference / 个人域免审）+
 * asset_media + project_asset_refs 三表一事务。
 * 与 scene repository 一样走注入的 pg client 原生 SQL。
 */

const schemaName = /^[a-z_][a-z0-9_]*$/.test(settings.postgresSchema) ? settings.postgresSchema : "app";
const q = (table: string) => `${schemaName}.${table}`;

export const DIRECTOR_CAPTURE_ASSET_KIND = "scene_reference";

export interface DirectorCapturePlacement {
  episodeId?: string;
  sceneId?: string;
  shotId?: string;
}

export interface PersistDirectorCaptureInput {
  actorId: string;
  projectId: string;
  assetEntityId: string;
  assetMediaId: string;
  title: string;
  originalFileName: string;
  declaredContentType?: string | null;
  sha256: string;
  image: { width: number; height: number; format: string; contentType: string };
  stored: StoredObject;
  placement: DirectorCapturePlacement;
}

export interface PersistDirectorCaptureResult {
  assetEntityId: string;
  assetMediaId: string;
  projectAssetRefId: string;
}

export class PgDirectorCaptureRepository {
  constructor(private readonly db: DirectorDbExecutor) {}

  /** episode/scene/shot 传入时必须存在且属于 URL 项目，且彼此父级一致。 */
  async assertPlacement(projectId: string, placement: DirectorCapturePlacement): Promise<void> {
    let episodeId = placement.episodeId ?? null;
    let sceneId = placement.sceneId ?? null;
    let shotId = placement.shotId ?? null;

    if (shotId) {
      const result = await this.db.query(
        `SELECT sh.episode_id, sh.scene_id
           FROM ${q("shots")} sh
           JOIN ${q("episodes")} e ON e.id = sh.episode_id
          WHERE sh.id = $1 AND e.project_id = $2
            AND sh.deleted_at IS NULL AND e.deleted_at IS NULL
          LIMIT 1`,
        [shotId, projectId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError("镜头不存在或不属于该项目");
      if (sceneId && row["scene_id"] && row["scene_id"] !== sceneId) {
        throw new BadRequestError("镜头不属于指定场景");
      }
      if (episodeId && row["episode_id"] !== episodeId) {
        throw new BadRequestError("镜头不属于指定剧集");
      }
      episodeId ??= String(row["episode_id"]);
      sceneId ??= row["scene_id"] ? String(row["scene_id"]) : null;
    }

    if (sceneId) {
      const result = await this.db.query(
        `SELECT s.episode_id
           FROM ${q("scenes")} s
           JOIN ${q("episodes")} e ON e.id = s.episode_id
          WHERE s.id = $1 AND e.project_id = $2
            AND s.deleted_at IS NULL AND e.deleted_at IS NULL
          LIMIT 1`,
        [sceneId, projectId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError("场景不存在或不属于该项目");
      if (episodeId && row["episode_id"] !== episodeId) {
        throw new BadRequestError("场景不属于指定剧集");
      }
      episodeId ??= String(row["episode_id"]);
    }

    if (placement.episodeId) {
      const result = await this.db.query(
        `SELECT 1 FROM ${q("episodes")}
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [placement.episodeId, projectId],
      );
      if (!result.rows[0]) throw new NotFoundError("剧集不存在或不属于该项目");
    }
  }

  async persistCapture(input: PersistDirectorCaptureInput): Promise<PersistDirectorCaptureResult> {
    return this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO ${q("asset_entities")}
           (id, owner_user_id, visibility, asset_kind, name, display_name,
            style_tags, approved, reuse_scope, status, metadata,
            created_at, updated_at, use_count)
         VALUES ($1, $2, 'personal', $3, $4, $4,
                 '[]'::jsonb, true, 'needs_review', 'approved', $5::jsonb,
                 now(), now(), 0)`,
        [
          input.assetEntityId,
          input.actorId,
          DIRECTOR_CAPTURE_ASSET_KIND,
          input.title,
          JSON.stringify({
            source: "director_capture",
            project_id: input.projectId,
            episode_id: input.placement.episodeId ?? null,
            scene_id: input.placement.sceneId ?? null,
            shot_id: input.placement.shotId ?? null,
            original_file_name: input.originalFileName,
            declared_content_type: input.declaredContentType ?? null,
          }),
        ],
      );

      await client.query(
        `INSERT INTO ${q("asset_media")}
           (id, asset_entity_id, asset_variant_id, media_kind, view_angle, title,
            storage_bucket, storage_path, storage_url, width_px, height_px,
            format, sha256, is_primary, approved, sort_order, metadata, created_at)
         VALUES ($1, $2, NULL, 'image', 'unknown', $3,
                 $4, $5, $6, $7, $8,
                 $9, $10, true, true, 0, $11::jsonb, now())`,
        [
          input.assetMediaId,
          input.assetEntityId,
          input.title,
          input.stored.bucket,
          input.stored.storagePath,
          input.stored.storageUrl,
          input.image.width,
          input.image.height,
          input.image.format,
          input.sha256,
          JSON.stringify({ source: "director_capture", project_id: input.projectId }),
        ],
      );

      const refId = await insertProjectAssetRef(client, input);
      return {
        assetEntityId: input.assetEntityId,
        assetMediaId: input.assetMediaId,
        projectAssetRefId: refId,
      };
    });
  }
}

async function insertProjectAssetRef(
  client: DirectorDbClient,
  input: PersistDirectorCaptureInput,
): Promise<string> {
  const versionSnapshot = {
    captured_at: new Date().toISOString(),
    entity: {
      id: input.assetEntityId,
      owner_user_id: input.actorId,
      visibility: "personal",
      asset_kind: DIRECTOR_CAPTURE_ASSET_KIND,
      name: input.title,
      status: "approved",
      approved: true,
      reuse_scope: "needs_review",
    },
    media: {
      id: input.assetMediaId,
      media_kind: "image",
      storage_bucket: input.stored.bucket,
      storage_path: input.stored.storagePath,
      storage_url: input.stored.storageUrl,
      width_px: input.image.width,
      height_px: input.image.height,
      format: input.image.format,
      sha256: input.sha256,
      approved: true,
    },
    placement: {
      episode_id: input.placement.episodeId ?? null,
      scene_id: input.placement.sceneId ?? null,
      shot_id: input.placement.shotId ?? null,
    },
  };
  const result = await client.query(
    `INSERT INTO ${q("project_asset_refs")}
       (id, project_id, asset_entity_id, asset_variant_id, asset_media_id,
        version_snapshot, created_by_user_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, NULL, $3, $4::jsonb, $5, now())
     RETURNING id`,
    [
      input.projectId,
      input.assetEntityId,
      input.assetMediaId,
      JSON.stringify(versionSnapshot),
      input.actorId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("项目资产引用写入失败");
  return String(row["id"]);
}
