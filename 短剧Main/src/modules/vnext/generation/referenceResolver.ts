import { sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { TosStorage } from "../../../integrations/tosStorage.js";
import { ForbiddenError } from "../../../shared/errors.js";
import type { ControlPackageReference } from "../control-packages/types.js";
import type { VnextGenerationReferenceResolver, VnextProviderReference } from "./references.js";

interface ReferenceRow extends Record<string, unknown> {
  reference_version_id: string;
  kind: "image" | "video";
  url: string;
  duration_seconds: number | null;
  storage_bucket: string | null;
  object_key: string | null;
}

type TOSReferenceAccess = Pick<TosStorage, "createDownloadUrl">;

export class VnextDatabaseReferenceResolver implements VnextGenerationReferenceResolver {
  constructor(
    private readonly db: Database,
    private readonly tos: TOSReferenceAccess = new TosStorage(),
  ) {}

  async resolve(projectId: string, references: ControlPackageReference[]): Promise<VnextProviderReference[]> {
    if (references.length === 0) return [];
    const requestedIds = `{${references.map((reference) => reference.referenceVersionId).join(",")}}`;
    const rows = await this.db.execute<ReferenceRow>(sql`
      SELECT id::text AS reference_version_id, 'image'::text AS kind, media_url AS url,
             NULL::integer AS duration_seconds, NULL::text AS storage_bucket, NULL::text AS object_key
      FROM vnext.storyboard_cell_versions
      WHERE project_id = ${projectId}::uuid AND id = ANY(${requestedIds}::uuid[])
      UNION ALL
      SELECT id::text AS reference_version_id,
             CASE WHEN media_kind = 'video' THEN 'video' ELSE 'image' END AS kind,
             media_url AS url, NULL::integer AS duration_seconds,
             NULL::text AS storage_bucket, NULL::text AS object_key
      FROM vnext.imported_assets
      WHERE review_status = 'approved' AND media_kind IN ('image', 'video')
        AND id = ANY(${requestedIds}::uuid[])
      UNION ALL
      SELECT v.id::text AS reference_version_id,
             'video'::text AS kind,
             media.item ->> 'storageUrl' AS url,
             (media.item ->> 'durationSeconds')::integer AS duration_seconds,
             media.item ->> 'storageBucket' AS storage_bucket,
             media.item ->> 'objectKey' AS object_key
      FROM vnext.video_versions v
      CROSS JOIN LATERAL (
        SELECT item
        FROM jsonb_array_elements(v.tos_media) WITH ORDINALITY AS items(item, ordinal)
        WHERE item ->> 'mimeType' LIKE 'video/%'
          AND COALESCE(item ->> 'storageUrl', '') <> ''
        ORDER BY ordinal
        LIMIT 1
      ) AS media
      WHERE v.project_id = ${projectId}::uuid
        AND v.id = ANY(${requestedIds}::uuid[])
    `);
    const byVersion = new Map(rows.rows.map((row) => [row.reference_version_id, row]));
    return Promise.all(references.map(async (reference) => {
      const row = byVersion.get(reference.referenceVersionId);
      if (!row) {
        throw new ForbiddenError(`参考《${reference.label}》不存在、未通过审核或不支持作为 Seedance 输入`);
      }
      const url = row.storage_bucket && row.object_key
        ? (await this.tos.createDownloadUrl(row.object_key, { bucket: row.storage_bucket, expiresSeconds: 900 })).url
        : row.url;
      return {
        referenceVersionId: row.reference_version_id,
        kind: row.kind,
        url,
        ...(row.duration_seconds == null ? {} : { durationSeconds: row.duration_seconds }),
      };
    }));
  }
}
