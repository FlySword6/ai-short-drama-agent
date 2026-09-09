import { sql } from "drizzle-orm";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { AssetSearchItem, JsonObject } from "../../domain/assets/types.js";
import {
  buildAssetMediaDisplay,
  redactAssetStorageMetadata,
} from "./mediaDisplay.js";
import { assetImageMediaKindSql } from "./assetImageKinds.js";
import {
  directorPreviewBindingSql,
  directorPreviewIntentSql,
  directorPreviewSourceMediaIdSql,
  directorPreviewSourceSha256Sql,
} from "./directorPreviewBinding.js";
import { sanitizeSearchQueryTokenTexts, tokenizeSearchQuery } from "./queryTokenizer.js";

export type HybridSearchSourceTable = "asset_entities" | "asset_variants";

export interface HybridSearchKey {
  sourceTable: HybridSearchSourceTable;
  sourceId: string;
}

export interface HybridLexicalCandidate extends HybridSearchKey {
  /** PostgreSQL lexical relevance. It is only an input to fusion ranking, never public. */
  relevance: number;
}

export interface HybridSearchScope {
  actorId: string;
  /** Optional asset-center boundary. Omit it for the existing mixed search. */
  libraryScope?: "personal" | "common";
  /** A route-issued project capability. Omit it for personal + common scope. */
  projectId?: string;
  /** Filters by asset_source_projects.id. This is a retrieval scope, not authorization. */
  sourceProjectId?: string;
}

export interface HybridSearchRepositoryPort {
  lexicalRecall(
    query: string,
    scope: HybridSearchScope,
    limit: number,
    lexicalTokens?: string[],
  ): Promise<HybridLexicalCandidate[]>;
  hydrate(keys: HybridSearchKey[], scope: HybridSearchScope): Promise<AssetSearchItem[]>;
}

interface LexicalRow {
  source_table: string;
  source_id: string;
  relevance: number | string;
}

interface HydratedRow {
  source_table: string;
  source_id: string;
  visibility: string | null;
  status: string | null;
  owner_user_id: string | null;
  asset_kind: string | null;
  name: string | null;
  display_name: string | null;
  parent_entity_id: string | null;
  parent_entity_name: string | null;
  intro: string | null;
  appearance: string | null;
  description: string | null;
  usage_context: string | null;
  visual_prompt: string | null;
  media_source_sha256: string | null;
  rendition_kind: string | null;
  rendition_strategy: string | null;
  rendition_status: string | null;
  rendition_storage_bucket: string | null;
  rendition_storage_path: string | null;
  rendition_source_sha256: string | null;
  rendition_width_px: number | null;
  rendition_height_px: number | null;
  rendition_format: string | null;
  rendition_sha256: string | null;
  rendition_checked_at: Date | string | null;
  metadata: unknown;
}

interface SqlResult<T> {
  rows: T[];
}

/**
 * PostgreSQL is the source of truth for both lexical recall and access control.
 * Milvus only supplies candidate keys to the service; every key is hydrated
 * here again under the same visibility boundary before it can leave the API.
 */
export class HybridAssetSearchRepository implements HybridSearchRepositoryPort {
  constructor(private readonly db: Database) {}

  async lexicalRecall(
    query: string,
    scope: HybridSearchScope,
    limit: number,
    lexicalTokens?: string[],
  ): Promise<HybridLexicalCandidate[]> {
    const normalized = normalizeQuery(query);
    const pattern = `%${escapeLike(normalized)}%`;
    const tokens = lexicalTokens?.length
      ? sanitizeSearchQueryTokenTexts(lexicalTokens)
      : tokenizeSearchQuery(normalized).map((token) => token.text);
    const entityTokenRelevance = entityTokenRelevanceSql(tokens);
    const variantTokenRelevance = variantTokenRelevanceSql(tokens);
    const entityTokenWhere = entityTokenWhereSql(tokens);
    const variantTokenWhere = variantTokenWhereSql(tokens);
    const rows = await queryRows<LexicalRow>(this.db, sql`
      WITH lexical_candidates AS (
        SELECT
          'asset_entities'::text AS source_table,
          entity.id::text AS source_id,
          GREATEST(
            CASE WHEN lower(entity.name) = lower(${normalized}) THEN 1.00 ELSE 0.0 END,
            CASE WHEN lower(COALESCE(entity.display_name, '')) = lower(${normalized}) THEN 0.98 ELSE 0.0 END,
            CASE WHEN entity.name ILIKE ${pattern} ESCAPE '\\' THEN 0.95 ELSE 0.0 END,
            CASE WHEN COALESCE(entity.display_name, '') ILIKE ${pattern} ESCAPE '\\' THEN 0.92 ELSE 0.0 END,
            CASE WHEN COALESCE(entity.category, '') ILIKE ${pattern} ESCAPE '\\' THEN 0.86 ELSE 0.0 END,
            CASE WHEN entity.style_tags::text ILIKE ${pattern} ESCAPE '\\' THEN 0.84 ELSE 0.0 END,
            CASE WHEN entity.search_text ILIKE ${pattern} ESCAPE '\\' THEN 0.75 ELSE 0.0 END,
            ${entityTokenRelevance},
            COALESCE(similarity(entity.name, ${normalized}), 0.0) * 0.90,
            COALESCE(similarity(COALESCE(entity.display_name, ''), ${normalized}), 0.0) * 0.85,
            COALESCE(similarity(entity.search_text, ${normalized}), 0.0) * 0.60
          ) AS relevance
        FROM ${assetEntitiesTable} entity
        WHERE entity.deleted_at IS NULL
          AND entity.clearance ->> 'search' IS DISTINCT FROM 'false'
          AND (${entityVisibleSql(scope, sql`entity`)})
          AND (${sourceProjectSql(scope, sql`entity`)})
          AND (
            entity.search_text ILIKE ${pattern} ESCAPE '\\'
            OR entity.search_text % ${normalized}
            OR ${entityTokenWhere}
          )

        UNION ALL

        SELECT
          'asset_variants'::text AS source_table,
          variant.id::text AS source_id,
          GREATEST(
            CASE WHEN lower(variant.name) = lower(${normalized}) THEN 1.00 ELSE 0.0 END,
            CASE WHEN variant.name ILIKE ${pattern} ESCAPE '\\' THEN 0.95 ELSE 0.0 END,
            CASE WHEN COALESCE(variant.usage_context, '') ILIKE ${pattern} ESCAPE '\\' THEN 0.86 ELSE 0.0 END,
            CASE WHEN COALESCE(variant.visual_prompt, '') ILIKE ${pattern} ESCAPE '\\' THEN 0.82 ELSE 0.0 END,
            CASE WHEN COALESCE(variant.description, '') ILIKE ${pattern} ESCAPE '\\' THEN 0.78 ELSE 0.0 END,
            CASE WHEN variant.search_text ILIKE ${pattern} ESCAPE '\\' THEN 0.75 ELSE 0.0 END,
            ${variantTokenRelevance},
            COALESCE(similarity(variant.name, ${normalized}), 0.0) * 0.90,
            COALESCE(similarity(variant.search_text, ${normalized}), 0.0) * 0.60
          ) AS relevance
        FROM ${assetVariantsTable} variant
        INNER JOIN ${assetEntitiesTable} entity ON entity.id = variant.asset_entity_id
        WHERE variant.deleted_at IS NULL
          AND entity.deleted_at IS NULL
          AND entity.clearance ->> 'search' IS DISTINCT FROM 'false'
          AND (${variantVisibleSql(scope, sql`entity`, sql`variant`)})
          AND (${sourceProjectSql(scope, sql`entity`)})
          AND (
            variant.search_text ILIKE ${pattern} ESCAPE '\\'
            OR variant.search_text % ${normalized}
            OR ${variantTokenWhere}
          )
      )
      SELECT source_table, source_id, relevance
      FROM lexical_candidates
      ORDER BY relevance DESC, source_table ASC, source_id ASC
      LIMIT ${limit}
    `);
    return rows.flatMap((row) => {
      const sourceTable = toSourceTable(row.source_table);
      if (!sourceTable || !row.source_id) return [];
      return [{ sourceTable, sourceId: row.source_id, relevance: numberValue(row.relevance) }];
    });
  }

  async hydrate(keys: HybridSearchKey[], scope: HybridSearchScope): Promise<AssetSearchItem[]> {
    const entityIds = keys.filter((key) => key.sourceTable === "asset_entities").map((key) => key.sourceId);
    const variantIds = keys.filter((key) => key.sourceTable === "asset_variants").map((key) => key.sourceId);
    if (!entityIds.length && !variantIds.length) return [];

    const entityIdsSql = sql.join(entityIds.map((id) => sql`${id}`), sql`, `);
    const variantIdsSql = sql.join(variantIds.map((id) => sql`${id}`), sql`, `);
    const entityRows = entityIds.length
      ? await queryRows<HydratedRow>(this.db, entityHydrationSql(entityIdsSql, scope))
      : [];
    const variantRows = variantIds.length
      ? await queryRows<HydratedRow>(this.db, variantHydrationSql(variantIdsSql, scope))
      : [];
    return [...entityRows, ...variantRows].flatMap((row) => toSearchItem(row, scope));
  }
}

function entityHydrationSql(ids: ReturnType<typeof sql.join>, scope: HybridSearchScope) {
  return sql`
    SELECT
      'asset_entities'::text AS source_table,
      entity.id::text AS source_id,
      entity.visibility,
      entity.status,
      entity.owner_user_id::text,
      entity.asset_kind,
      entity.name,
      entity.display_name,
      NULL::text AS parent_entity_id,
      NULL::text AS parent_entity_name,
      entity.intro,
      entity.appearance,
      NULL::text AS description,
      NULL::text AS usage_context,
      NULL::text AS visual_prompt,
      media.media_source_sha256,
      media.rendition_kind,
      media.rendition_strategy,
      media.rendition_status,
      media.rendition_storage_bucket,
      media.rendition_storage_path,
      media.rendition_source_sha256,
      media.rendition_width_px,
      media.rendition_height_px,
      media.rendition_format,
      media.rendition_sha256,
      media.rendition_checked_at,
      entity.metadata
    FROM ${assetEntitiesTable} entity
    LEFT JOIN LATERAL (
      SELECT
        candidate_media.sha256 AS media_source_sha256,
        rendition.rendition_kind,
        rendition.strategy AS rendition_strategy,
        rendition.status AS rendition_status,
        rendition.storage_bucket AS rendition_storage_bucket,
        rendition.storage_path AS rendition_storage_path,
        rendition.source_sha256 AS rendition_source_sha256,
        rendition.width_px AS rendition_width_px,
        rendition.height_px AS rendition_height_px,
        rendition.format AS rendition_format,
        rendition.sha256 AS rendition_sha256,
        rendition.checked_at AS rendition_checked_at
      FROM ${assetMediaTable} candidate_media
      INNER JOIN ${assetMediaRenditionsTable} rendition
        ON rendition.asset_media_id = candidate_media.id
        AND rendition.rendition_kind = 'detail'
        AND rendition.strategy = 'stored_object'
        AND rendition.status = 'healthy'
      WHERE candidate_media.deleted_at IS NULL
        AND ${assetImageMediaKindSql(sql`candidate_media.media_kind`)}
        AND candidate_media.approved IS TRUE
        AND (
          (
            candidate_media.asset_variant_id IS NULL
            AND candidate_media.asset_entity_id = entity.id
          )
          OR EXISTS (
            SELECT 1 FROM ${assetVariantsTable} candidate_variant
            WHERE candidate_variant.id = candidate_media.asset_variant_id
              AND candidate_variant.asset_entity_id = entity.id
              AND candidate_variant.deleted_at IS NULL
              AND (
                candidate_media.asset_entity_id IS NULL
                OR candidate_media.asset_entity_id = entity.id
              )
          )
        )
        AND (
          (
            NOT EXISTS (
              SELECT 1 FROM ${assetMediaTable} source_model
              WHERE source_model.deleted_at IS NULL
                AND source_model.media_kind = 'model_3d'
                AND source_model.approved IS TRUE
                AND (
                  (
                    source_model.asset_variant_id IS NULL
                    AND source_model.asset_entity_id = entity.id
                  )
                  OR EXISTS (
                    SELECT 1 FROM ${assetVariantsTable} source_variant
                    WHERE source_variant.id = source_model.asset_variant_id
                      AND source_variant.asset_entity_id = entity.id
                      AND source_variant.deleted_at IS NULL
                      AND (
                        source_model.asset_entity_id IS NULL
                        OR source_model.asset_entity_id = entity.id
                      )
                  )
                )
            )
            AND NOT (${directorPreviewIntentSql(sql`candidate_media.metadata`)})
          )
          OR EXISTS (
            SELECT 1 FROM ${assetMediaTable} source_model
            WHERE source_model.deleted_at IS NULL
              AND source_model.media_kind = 'model_3d'
              AND source_model.approved IS TRUE
              AND ${directorPreviewBindingSql(sql`candidate_media.metadata`)}
              AND source_model.id::text = ${directorPreviewSourceMediaIdSql(sql`candidate_media.metadata`)}
              AND source_model.sha256 = ${directorPreviewSourceSha256Sql(sql`candidate_media.metadata`)}
              AND source_model.asset_variant_id IS NOT DISTINCT FROM candidate_media.asset_variant_id
              AND (
                (
                  source_model.asset_variant_id IS NULL
                  AND source_model.asset_entity_id = entity.id
                )
                OR EXISTS (
                  SELECT 1 FROM ${assetVariantsTable} source_variant
                  WHERE source_variant.id = source_model.asset_variant_id
                    AND source_variant.asset_entity_id = entity.id
                    AND source_variant.deleted_at IS NULL
                    AND (
                      source_model.asset_entity_id IS NULL
                      OR source_model.asset_entity_id = entity.id
                    )
                )
              )
          )
        )
        AND (${mediaVisibleSql(scope, sql`entity`, sql`candidate_media`)})
      ORDER BY candidate_media.is_primary DESC, candidate_media.sort_order ASC, candidate_media.created_at ASC
      LIMIT 1
    ) media ON TRUE
    WHERE entity.id IN (${ids})
      AND entity.deleted_at IS NULL
      AND entity.clearance ->> 'search' IS DISTINCT FROM 'false'
      AND (${entityVisibleSql(scope, sql`entity`)})
      AND (${sourceProjectSql(scope, sql`entity`)})
  `;
}

function variantHydrationSql(ids: ReturnType<typeof sql.join>, scope: HybridSearchScope) {
  return sql`
    SELECT
      'asset_variants'::text AS source_table,
      variant.id::text AS source_id,
      entity.visibility,
      entity.status,
      entity.owner_user_id::text,
      entity.asset_kind,
      variant.name,
      variant.name AS display_name,
      entity.id::text AS parent_entity_id,
      entity.name AS parent_entity_name,
      entity.intro,
      entity.appearance,
      variant.description,
      variant.usage_context,
      variant.visual_prompt,
      media.media_source_sha256,
      media.rendition_kind,
      media.rendition_strategy,
      media.rendition_status,
      media.rendition_storage_bucket,
      media.rendition_storage_path,
      media.rendition_source_sha256,
      media.rendition_width_px,
      media.rendition_height_px,
      media.rendition_format,
      media.rendition_sha256,
      media.rendition_checked_at,
      variant.metadata
    FROM ${assetVariantsTable} variant
    INNER JOIN ${assetEntitiesTable} entity ON entity.id = variant.asset_entity_id
    LEFT JOIN LATERAL (
      SELECT
        candidate_media.sha256 AS media_source_sha256,
        rendition.rendition_kind,
        rendition.strategy AS rendition_strategy,
        rendition.status AS rendition_status,
        rendition.storage_bucket AS rendition_storage_bucket,
        rendition.storage_path AS rendition_storage_path,
        rendition.source_sha256 AS rendition_source_sha256,
        rendition.width_px AS rendition_width_px,
        rendition.height_px AS rendition_height_px,
        rendition.format AS rendition_format,
        rendition.sha256 AS rendition_sha256,
        rendition.checked_at AS rendition_checked_at
      FROM ${assetMediaTable} candidate_media
      INNER JOIN ${assetMediaRenditionsTable} rendition
        ON rendition.asset_media_id = candidate_media.id
        AND rendition.rendition_kind = 'detail'
        AND rendition.strategy = 'stored_object'
        AND rendition.status = 'healthy'
      WHERE candidate_media.deleted_at IS NULL
        AND ${assetImageMediaKindSql(sql`candidate_media.media_kind`)}
        AND candidate_media.approved IS TRUE
        AND candidate_media.asset_variant_id = variant.id
        AND (
          candidate_media.asset_entity_id IS NULL
          OR candidate_media.asset_entity_id = entity.id
        )
        AND (
          (
            NOT EXISTS (
              SELECT 1 FROM ${assetMediaTable} source_model
              WHERE source_model.deleted_at IS NULL
                AND source_model.media_kind = 'model_3d'
                AND source_model.asset_variant_id = variant.id
                AND source_model.approved IS TRUE
                AND (
                  source_model.asset_entity_id IS NULL
                  OR source_model.asset_entity_id = entity.id
                )
            )
            AND NOT (${directorPreviewIntentSql(sql`candidate_media.metadata`)})
          )
          OR EXISTS (
            SELECT 1 FROM ${assetMediaTable} source_model
            WHERE source_model.deleted_at IS NULL
              AND source_model.media_kind = 'model_3d'
              AND source_model.asset_variant_id = variant.id
              AND source_model.approved IS TRUE
              AND ${directorPreviewBindingSql(sql`candidate_media.metadata`)}
              AND source_model.id::text = ${directorPreviewSourceMediaIdSql(sql`candidate_media.metadata`)}
              AND source_model.sha256 = ${directorPreviewSourceSha256Sql(sql`candidate_media.metadata`)}
              AND (source_model.asset_entity_id IS NULL OR source_model.asset_entity_id = entity.id)
          )
        )
        AND (${mediaVisibleSql(scope, sql`entity`, sql`candidate_media`)})
      ORDER BY candidate_media.is_primary DESC, candidate_media.sort_order ASC, candidate_media.created_at ASC
      LIMIT 1
    ) media ON TRUE
    WHERE variant.id IN (${ids})
      AND variant.deleted_at IS NULL
      AND entity.deleted_at IS NULL
      AND entity.clearance ->> 'search' IS DISTINCT FROM 'false'
      AND (${variantVisibleSql(scope, sql`entity`, sql`variant`)})
      AND (${sourceProjectSql(scope, sql`entity`)})
  `;
}

/** Personal assets owned by another user only enter via an active reference in
 * the one already-authorized project. The route never passes a project id
 * before ProjectAccessService has resolved it. */
function entityVisibleSql(scope: HybridSearchScope, entity: ReturnType<typeof sql>) {
  const ownerOrCommon = approvedCommonOrOwnerSql(scope, entity);
  if (!scope.projectId || scope.libraryScope) return ownerOrCommon;
  return sql`
    ${ownerOrCommon}
    OR (${entity}.visibility = 'personal' AND EXISTS (
      SELECT 1 FROM ${projectAssetRefsTable} project_ref
      WHERE project_ref.project_id = ${scope.projectId}
        AND project_ref.asset_entity_id = ${entity}.id
        AND project_ref.deleted_at IS NULL
    ))
  `;
}

/** Variant hits cannot bypass a narrow project reference. A legacy entity-only
 * reference intentionally exposes all of that entity's variants; a media or
 * variant lock only exposes the selected variant. */
function variantVisibleSql(
  scope: HybridSearchScope,
  entity: ReturnType<typeof sql>,
  variant: ReturnType<typeof sql>,
) {
  const ownerOrCommon = approvedCommonVariantOrOwnerSql(scope, entity, variant);
  if (!scope.projectId || scope.libraryScope) return ownerOrCommon;
  return sql`
    ${ownerOrCommon}
    OR (${entity}.visibility = 'personal' AND EXISTS (
      SELECT 1
      FROM ${projectAssetRefsTable} project_ref
      LEFT JOIN ${assetMediaTable} locked_media
        ON locked_media.id = project_ref.asset_media_id
        AND locked_media.deleted_at IS NULL
      WHERE project_ref.project_id = ${scope.projectId}
        AND project_ref.asset_entity_id = ${entity}.id
        AND project_ref.deleted_at IS NULL
        AND (
          (project_ref.asset_variant_id IS NULL AND project_ref.asset_media_id IS NULL)
          OR project_ref.asset_variant_id = ${variant}.id
          OR locked_media.asset_variant_id = ${variant}.id
        )
    ))
  `;
}

/** The reference lock protects the actual media URL as well as candidate
 * visibility. Never fall back to an entity URL for another user's asset. */
function mediaVisibleSql(
  scope: HybridSearchScope,
  entity: ReturnType<typeof sql>,
  media: ReturnType<typeof sql>,
) {
  const ownerOrCommon = approvedCommonMediaOrOwnerSql(scope, entity, media);
  if (!scope.projectId || scope.libraryScope) return ownerOrCommon;
  return sql`
    ${ownerOrCommon}
    OR (${entity}.visibility = 'personal' AND EXISTS (
      SELECT 1 FROM ${projectAssetRefsTable} project_ref
      WHERE project_ref.project_id = ${scope.projectId}
        AND project_ref.asset_entity_id = ${entity}.id
        AND project_ref.deleted_at IS NULL
        AND (
          (project_ref.asset_variant_id IS NULL AND project_ref.asset_media_id IS NULL)
          OR project_ref.asset_media_id = ${media}.id
          OR (project_ref.asset_variant_id IS NOT NULL AND project_ref.asset_variant_id = ${media}.asset_variant_id)
        )
    ))
  `;
}

function sourceProjectSql(scope: HybridSearchScope, entity: ReturnType<typeof sql>) {
  return scope.sourceProjectId
    ? sql`${entity}.source_project_id = ${scope.sourceProjectId}`
    : sql`TRUE`;
}

function entityTokenRelevanceSql(tokens: string[]) {
  return tokenRelevanceSql(tokens, [
    { field: sql`entity.name`, weight: 0.20 },
    { field: sql`COALESCE(entity.display_name, '')`, weight: 0.18 },
    { field: sql`COALESCE(entity.category, '')`, weight: 0.12 },
    { field: sql`entity.style_tags::text`, weight: 0.12 },
    { field: sql`COALESCE(entity.hair_description, '')`, weight: 0.10 },
    { field: sql`COALESCE(entity.outfit_description, '')`, weight: 0.10 },
    { field: sql`COALESCE(entity.appearance, '')`, weight: 0.08 },
    { field: sql`COALESCE(entity.intro, '')`, weight: 0.06 },
    { field: sql`entity.search_text`, weight: 0.04 },
  ]);
}

function variantTokenRelevanceSql(tokens: string[]) {
  return tokenRelevanceSql(tokens, [
    { field: sql`variant.name`, weight: 0.20 },
    { field: sql`COALESCE(variant.usage_context, '')`, weight: 0.14 },
    { field: sql`COALESCE(variant.visual_prompt, '')`, weight: 0.12 },
    { field: sql`COALESCE(variant.description, '')`, weight: 0.10 },
    { field: sql`variant.search_text`, weight: 0.08 },
    { field: sql`entity.name`, weight: 0.10 },
    { field: sql`COALESCE(entity.display_name, '')`, weight: 0.08 },
    { field: sql`COALESCE(entity.category, '')`, weight: 0.06 },
    { field: sql`entity.style_tags::text`, weight: 0.06 },
    { field: sql`COALESCE(entity.hair_description, '')`, weight: 0.04 },
    { field: sql`COALESCE(entity.outfit_description, '')`, weight: 0.04 },
  ]);
}

function entityTokenWhereSql(tokens: string[]) {
  return tokenWhereSql(tokens, [
    sql`entity.name`,
    sql`COALESCE(entity.display_name, '')`,
    sql`COALESCE(entity.category, '')`,
    sql`entity.style_tags::text`,
    sql`COALESCE(entity.hair_description, '')`,
    sql`COALESCE(entity.outfit_description, '')`,
    sql`COALESCE(entity.appearance, '')`,
    sql`COALESCE(entity.intro, '')`,
    sql`entity.search_text`,
  ]);
}

function variantTokenWhereSql(tokens: string[]) {
  return tokenWhereSql(tokens, [
    sql`variant.name`,
    sql`COALESCE(variant.usage_context, '')`,
    sql`COALESCE(variant.visual_prompt, '')`,
    sql`COALESCE(variant.description, '')`,
    sql`variant.search_text`,
    sql`entity.name`,
    sql`COALESCE(entity.display_name, '')`,
    sql`COALESCE(entity.category, '')`,
    sql`entity.style_tags::text`,
    sql`COALESCE(entity.hair_description, '')`,
    sql`COALESCE(entity.outfit_description, '')`,
  ]);
}

function tokenRelevanceSql(tokens: string[], fields: Array<{ field: ReturnType<typeof sql>; weight: number }>) {
  if (!tokens.length) return sql`0.0`;
  const clauses = tokens.flatMap((token) => {
    const tokenPattern = `%${escapeLike(token)}%`;
    return fields.map(({ field, weight }) => sql`
      CASE WHEN ${field} ILIKE ${tokenPattern} ESCAPE '\\' THEN ${weight} ELSE 0.0 END
    `);
  });
  return sql`LEAST(0.94, 0.20 + ((${sql.join(clauses, sql` + `)}) / ${tokens.length}))`;
}

function tokenWhereSql(tokens: string[], fields: Array<ReturnType<typeof sql>>) {
  if (!tokens.length) return sql`FALSE`;
  const clauses = tokens.flatMap((token) => {
    const tokenPattern = `%${escapeLike(token)}%`;
    return fields.map((field) => sql`${field} ILIKE ${tokenPattern} ESCAPE '\\'`);
  });
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

function toSearchItem(row: HydratedRow, scope: HybridSearchScope): AssetSearchItem[] {
  const sourceTable = toSourceTable(row.source_table);
  if (!sourceTable || !row.source_id) return [];
  if (row.visibility === "common" && row.status !== "approved") return [];
  const display = buildAssetMediaDisplay({
    sourceSha256: row.media_source_sha256,
    renditions: [{
      renditionKind: row.rendition_kind ?? "",
      strategy: row.rendition_strategy ?? "",
      status: row.rendition_status ?? "",
      storageBucket: row.rendition_storage_bucket,
      storagePath: row.rendition_storage_path,
      sourceSha256: row.rendition_source_sha256,
      widthPx: row.rendition_width_px,
      heightPx: row.rendition_height_px,
      format: row.rendition_format,
      sha256: row.rendition_sha256,
      checkedAt: row.rendition_checked_at,
    }],
  });
  const metadata = canExposeMetadata(row, scope)
    ? redactAssetStorageMetadata(jsonObject(row.metadata))
    : {};
  return [{
    score: null,
    sourceTable,
    sourceId: row.source_id,
    scope: row.visibility ?? undefined,
    status: row.status,
    assetKind: row.asset_kind,
    name: row.name,
    displayName: row.display_name,
    parentEntityId: row.parent_entity_id,
    parentEntityName: row.parent_entity_name,
    intro: row.intro,
    appearance: row.appearance,
    description: row.description,
    usageContext: row.usage_context,
    visualPrompt: row.visual_prompt,
    sourceFileUrl: display?.detail?.url ?? null,
    // A narrow project reference may grant access to just one media object.
    // Existing ingest metadata can contain a different media URL or a raw
    // provider payload, so it is never safe to return wholesale for a private
    // asset owned by someone else. The allowed media is already represented by
    // sourceFileUrl after mediaVisibleSql has enforced the reference lock.
    metadata: jsonObject(metadata),
    vectorText: null,
  }];
}

function canExposeMetadata(row: HydratedRow, scope: HybridSearchScope): boolean {
  return row.visibility === "common" || row.owner_user_id === scope.actorId;
}

function approvedCommonOrOwnerSql(
  scope: HybridSearchScope,
  entity: ReturnType<typeof sql>,
) {
  if (scope.libraryScope === "common") {
    return sql`(${entity}.visibility = 'common' AND ${entity}.status = 'approved')`;
  }
  if (scope.libraryScope === "personal") {
    return sql`(${entity}.visibility = 'personal' AND ${entity}.owner_user_id = ${scope.actorId})`;
  }
  return sql`(
    (${entity}.visibility = 'common' AND ${entity}.status = 'approved')
    OR ${entity}.owner_user_id = ${scope.actorId}
  )`;
}

function approvedCommonVariantOrOwnerSql(
  scope: HybridSearchScope,
  entity: ReturnType<typeof sql>,
  variant: ReturnType<typeof sql>,
) {
  const approvedCommon = sql`(
    ${entity}.visibility = 'common'
    AND ${entity}.status = 'approved'
    AND ${variant}.status = 'approved'
  )`;
  const personalOwner = sql`(
    ${entity}.visibility = 'personal'
    AND ${entity}.owner_user_id = ${scope.actorId}
  )`;
  if (scope.libraryScope === "common") return approvedCommon;
  if (scope.libraryScope === "personal") return personalOwner;
  return sql`(${approvedCommon} OR ${personalOwner})`;
}

function approvedCommonMediaOrOwnerSql(
  scope: HybridSearchScope,
  entity: ReturnType<typeof sql>,
  media: ReturnType<typeof sql>,
) {
  const approvedCommon = sql`(
    ${entity}.visibility = 'common'
    AND ${entity}.status = 'approved'
    AND ${media}.approved IS TRUE
    AND (${media}.asset_entity_id IS NULL OR ${media}.asset_entity_id = ${entity}.id)
    AND (
      ${media}.asset_variant_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM ${assetVariantsTable} visible_variant
        WHERE visible_variant.id = ${media}.asset_variant_id
          AND visible_variant.asset_entity_id = ${entity}.id
          AND visible_variant.deleted_at IS NULL
          AND visible_variant.status = 'approved'
      )
    )
  )`;
  const personalOwner = sql`(
    ${entity}.visibility = 'personal'
    AND ${entity}.owner_user_id = ${scope.actorId}
  )`;
  if (scope.libraryScope === "common") return approvedCommon;
  if (scope.libraryScope === "personal") return personalOwner;
  return sql`(${approvedCommon} OR ${personalOwner})`;
}

function toSourceTable(value: string): HybridSearchSourceTable | null {
  return value === "asset_entities" || value === "asset_variants" ? value : null;
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function numberValue(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

async function queryRows<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(statement) as unknown as SqlResult<T>).rows;
}

function table(name: string) {
  return sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier(name)}`;
}

const assetEntitiesTable = table("asset_entities");
const assetVariantsTable = table("asset_variants");
const assetMediaTable = table("asset_media");
const assetMediaRenditionsTable = table("asset_media_renditions");
const projectAssetRefsTable = table("project_asset_refs");
