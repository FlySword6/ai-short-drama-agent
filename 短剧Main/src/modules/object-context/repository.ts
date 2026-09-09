import { sql } from "drizzle-orm";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type {
  EntityRef,
  ObjectKind,
  ObjectState,
  ObjectSubject,
  ProjectScopedEdge,
  RelationEdge,
  RelationKind,
  RelatedObjectKind,
} from "./types.js";

type SqlResult<T> = { rows: T[] };

interface SubjectRow {
  id: string;
  display_name: string | null;
  project_id: string | null;
  owner_user_id: string | null;
  visibility: string | null;
  episode_id: string | null;
  shot_id: string | null;
  media_kind: string | null;
  selected_image_result_id: string | null;
  selected_video_result_id: string | null;
  lifecycle: string | null;
  platform_review_status: string | null;
  media_review_status: string | null;
  persistence_status: string | null;
  execution_status: string | null;
  control_package_ready: boolean | null;
  updated_at: Date | string;
  provider_cost_calculation_status: string | null;
  provider_cost_cny_micros: number | string | null;
  provider_cost_requires_attention: boolean | null;
}

interface EdgeRow {
  edge_id: string;
  relation: RelationKind;
  from_kind: RelatedObjectKind;
  from_id: string;
  from_name: string | null;
  to_kind: RelatedObjectKind;
  to_id: string;
  to_name: string | null;
  truth: RelationEdge["truth"];
  occurred_at: Date | string | null;
  metadata: Record<string, unknown> | null;
  project_id: string | null;
}

interface AssetEndpointAccessRow {
  ref_kind: "asset_entity" | "asset_media";
  ref_id: string;
  owner_user_id: string | null;
  visibility: string;
  status: string;
}

interface ProjectAssetEndpointAccessRow {
  project_id: string;
  ref_kind: "asset_entity" | "asset_media";
  ref_id: string;
}

export interface AssetEndpointAccess {
  kind: AssetEndpointAccessRow["ref_kind"];
  id: string;
  ownerUserId: string | null;
  visibility: string;
  status: string;
}

export interface ProductionHierarchyRow {
  projectId: string;
  projectName: string;
  projectStatus: string;
  projectUpdatedAt: string;
  episodeId: string | null;
  episodeNo: number | null;
  episodeName: string | null;
  episodeStatus: string | null;
  episodeUpdatedAt: string | null;
  sceneId: string | null;
  sceneNo: number | null;
  sceneName: string | null;
  sceneUpdatedAt: string | null;
  shotId: string | null;
  shotCode: string | null;
  shotTitle: string | null;
  shotUpdatedAt: string | null;
  selectedImageResultId: string | null;
  selectedVideoResultId: string | null;
  controlPackageId: string | null;
  controlPackageReady: boolean;
}

interface ProductionHierarchySqlRow {
  project_id: string;
  project_name: string;
  project_status: string;
  project_updated_at: Date | string;
  episode_id: string | null;
  episode_no: number | null;
  episode_name: string | null;
  episode_status: string | null;
  episode_updated_at: Date | string | null;
  scene_id: string | null;
  scene_no: number | null;
  scene_name: string | null;
  scene_updated_at: Date | string | null;
  shot_id: string | null;
  shot_code: string | null;
  shot_title: string | null;
  shot_updated_at: Date | string | null;
  selected_image_result_id: string | null;
  selected_video_result_id: string | null;
  control_package_id: string | null;
  ready_marked_at: Date | string | null;
}

export interface ProductionMediaRow {
  id: string;
  shotId: string;
  mediaKind: string;
  persistenceStatus: string;
  reviewStatus: string;
  executionStatus: string | null;
  updatedAt: string;
}

export interface SceneProductionRow {
  projectId: string;
  episodeId: string;
  sceneId: string;
  sceneNo: number;
  sceneName: string | null;
  sceneSortOrder: number;
  sceneUpdatedAt: string;
  shotId: string | null;
  shotSortOrder: number | null;
  shotCode: string | null;
  shotUpdatedAt: string | null;
  controlPackageId: string | null;
  controlPackageReady: boolean;
  filledLanes: string[];
  enabledLaneCount: number;
  attemptStatus: string | null;
  attemptPhase: string | null;
  queuePosition: number | null;
  attemptUpdatedAt: string | null;
  primaryMediaResultId: string | null;
  primaryMediaKind: string | null;
  primaryMediaStorageUrl: string | null;
  primaryMediaMimeType: string | null;
  primaryMediaCreatedAt: string | null;
  primaryProductionMode: "sample" | "full";
  primaryDelivered: boolean;
}

const projects = table("projects");
const projectAssetRefs = table("project_asset_refs");
const episodes = table("episodes");
const scenes = table("scenes");
const shots = table("shots");
const assetEntities = table("asset_entities");
const assetVariants = table("asset_variants");
const assetMedia = table("asset_media");
const generationRequests = table("generation_requests");
const generationAttempts = table("generation_attempts");
const mediaResults = table("media_results");
const providerCosts = table("provider_costs");
const controlPackages = table("control_packages");
const controlPackageRefs = table("control_package_refs");
const referenceLaneVocabulary = table("reference_lane_vocabulary");
const mediaReviewActions = table("media_review_actions");
const deliveryRecords = table("delivery_records");

function table(name: string) {
  return sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier(name)}`;
}

export class ObjectContextRepository {
  constructor(
    private readonly db: Database,
    private readonly allowNewSubmission = settings.allowPaidGeneration,
  ) {}

  async loadSubject(kind: ObjectKind, id: string): Promise<ObjectSubject | null> {
    const rows = await query<SubjectRow>(this.db, subjectStatement(kind, id));
    const row = rows[0];
    return row ? toSubject(kind, row) : null;
  }

  async loadEdges(kind: ObjectKind, id: string): Promise<{
    origin: ProjectScopedEdge[];
    usage: ProjectScopedEdge[];
  }> {
    const [origin, usage] = await Promise.all([
      query<EdgeRow>(this.db, originStatement(kind, [id])),
      query<EdgeRow>(this.db, usageStatement(kind, id)),
    ]);
    return {
      origin: origin.map(toProjectScopedEdge),
      usage: usage.map(toProjectScopedEdge),
    };
  }

  async loadOriginEdges(refs: EntityRef[]): Promise<ProjectScopedEdge[]> {
    const groups = new Map<ObjectKind, string[]>();
    for (const ref of refs) {
      if (!isObjectKind(ref.kind)) continue;
      const ids = groups.get(ref.kind) ?? [];
      ids.push(ref.id);
      groups.set(ref.kind, ids);
    }
    const rows = await Promise.all([...groups.entries()].map(([kind, ids]) =>
      query<EdgeRow>(this.db, originStatement(kind, [...new Set(ids)])),
    ));
    return rows.flat().map(toProjectScopedEdge);
  }

  /**
   * Resolve every asset endpoint in at most two queries (entity + media).
   * Relation filtering must not turn a large project graph into one visibility
   * query per edge.
   */
  async loadAssetEndpointAccess(refs: EntityRef[]): Promise<Map<string, AssetEndpointAccess>> {
    const entityIds = uniqueIds(refs, "asset_entity");
    const mediaIds = uniqueIds(refs, "asset_media");
    const [entityRows, mediaRows] = await Promise.all([
      entityIds.length === 0
        ? Promise.resolve([])
        : query<AssetEndpointAccessRow>(this.db, sql`
          SELECT 'asset_entity'::text AS ref_kind, a.id AS ref_id,
                 a.owner_user_id, a.visibility, a.status
          FROM ${assetEntities} a
          WHERE a.id IN (${idList(entityIds)}) AND a.deleted_at IS NULL
        `),
      mediaIds.length === 0
        ? Promise.resolve([])
        : query<AssetEndpointAccessRow>(this.db, sql`
          SELECT 'asset_media'::text AS ref_kind, m.id AS ref_id,
                 a.owner_user_id, a.visibility, a.status
          FROM ${assetMedia} m
          LEFT JOIN ${assetVariants} v
            ON v.id = m.asset_variant_id AND v.deleted_at IS NULL
          INNER JOIN ${assetEntities} a
            ON a.id = COALESCE(m.asset_entity_id, v.asset_entity_id)
            AND a.deleted_at IS NULL
          WHERE m.id IN (${idList(mediaIds)}) AND m.deleted_at IS NULL
        `),
    ]);
    return new Map([...entityRows, ...mediaRows].map((row) => [
      assetEndpointKey(row.ref_kind, row.ref_id),
      {
        kind: row.ref_kind,
        id: row.ref_id,
        ownerUserId: row.owner_user_id,
        visibility: row.visibility,
        status: row.status,
      },
    ]));
  }

  /**
   * Project-scoped asset visibility is granted only by an exact active
   * project_asset_ref. Media/variant locks are preserved.
   */
  async loadProjectAssetEndpointAccess(
    projectIds: string[],
    refs: EntityRef[],
  ): Promise<Set<string>> {
    const uniqueProjectIds = [...new Set(projectIds)];
    const entityIds = uniqueIds(refs, "asset_entity");
    const mediaIds = uniqueIds(refs, "asset_media");
    if (uniqueProjectIds.length === 0 || (entityIds.length === 0 && mediaIds.length === 0)) {
      return new Set();
    }
    const [entityRows, mediaRows] = await Promise.all([
      entityIds.length === 0
        ? Promise.resolve([])
        : query<ProjectAssetEndpointAccessRow>(this.db, sql`
          SELECT DISTINCT r.project_id, 'asset_entity'::text AS ref_kind,
                 r.asset_entity_id AS ref_id
          FROM ${projectAssetRefs} r
          INNER JOIN ${assetEntities} a
            ON a.id = r.asset_entity_id AND a.deleted_at IS NULL
          WHERE r.project_id IN (${idList(uniqueProjectIds)})
            AND r.asset_entity_id IN (${idList(entityIds)})
            AND r.deleted_at IS NULL
        `),
      mediaIds.length === 0
        ? Promise.resolve([])
        : query<ProjectAssetEndpointAccessRow>(this.db, sql`
          SELECT DISTINCT r.project_id, 'asset_media'::text AS ref_kind, m.id AS ref_id
          FROM ${assetMedia} m
          LEFT JOIN ${assetVariants} v
            ON v.id = m.asset_variant_id AND v.deleted_at IS NULL
          INNER JOIN ${assetEntities} a
            ON a.id = COALESCE(m.asset_entity_id, v.asset_entity_id)
            AND a.deleted_at IS NULL
          INNER JOIN ${projectAssetRefs} r
            ON r.asset_entity_id = a.id
            AND r.deleted_at IS NULL
            AND (
              (r.asset_media_id IS NOT NULL AND r.asset_media_id = m.id)
              OR (
                r.asset_media_id IS NULL
                AND r.asset_variant_id IS NOT NULL
                AND r.asset_variant_id = m.asset_variant_id
              )
              OR (r.asset_media_id IS NULL AND r.asset_variant_id IS NULL)
            )
          WHERE r.project_id IN (${idList(uniqueProjectIds)})
            AND m.id IN (${idList(mediaIds)})
            AND m.deleted_at IS NULL
        `),
    ]);
    return new Set([...entityRows, ...mediaRows].map((row) =>
      projectAssetEndpointKey(row.project_id, row.ref_kind, row.ref_id),
    ));
  }

  async isAssetAvailableInProject(assetEntityId: string, projectId: string): Promise<boolean> {
    const rows = await query<{ found: boolean }>(this.db, sql`
      SELECT EXISTS(
        SELECT 1 FROM ${projectAssetRefs}
        WHERE project_id = ${projectId}
          AND asset_entity_id = ${assetEntityId}
          AND deleted_at IS NULL
      ) AS found
    `);
    return rows[0]?.found === true;
  }

  async resolveScope(
    projectId: string,
    scopeKind: "project" | "episode" | "scene",
    scopeId?: string,
  ): Promise<EntityRef | null> {
    if (scopeKind === "project") {
      if (scopeId && scopeId !== projectId) return null;
      const rows = await query<{ id: string; name: string }>(this.db, sql`
        SELECT id, name FROM ${projects}
        WHERE id = ${projectId} AND deleted_at IS NULL
      `);
      const row = rows[0];
      return row ? { kind: "project", id: row.id, displayName: row.name } : null;
    }
    if (!scopeId) return null;
    if (scopeKind === "episode") {
      const rows = await query<{ id: string; episode_no: number; name: string | null }>(this.db, sql`
        SELECT e.id, e.episode_no, e.name
        FROM ${episodes} e
        INNER JOIN ${projects} p ON p.id = e.project_id AND p.deleted_at IS NULL
        WHERE e.id = ${scopeId} AND e.project_id = ${projectId} AND e.deleted_at IS NULL
      `);
      const row = rows[0];
      return row ? {
        kind: "episode",
        id: row.id,
        displayName: row.name ?? `第${row.episode_no}集`,
      } : null;
    }
    const rows = await query<{ id: string; scene_no: number; name: string | null }>(this.db, sql`
      SELECT s.id, s.scene_no, s.name
      FROM ${scenes} s
      INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
      INNER JOIN ${projects} p ON p.id = e.project_id AND p.deleted_at IS NULL
      WHERE s.id = ${scopeId} AND e.project_id = ${projectId} AND s.deleted_at IS NULL
    `);
    const row = rows[0];
    return row ? {
      kind: "scene",
      id: row.id,
      displayName: row.name ?? `第${row.scene_no}场`,
    } : null;
  }

  async loadProductionHierarchy(
    projectId: string,
    scopeKind: "project" | "episode" | "scene",
    scopeId?: string,
  ): Promise<ProductionHierarchyRow[]> {
    const scope = scopePredicate(scopeKind, scopeId);
    const [shotRows, emptySceneRows] = await Promise.all([
      query<ProductionHierarchySqlRow>(this.db, sql`
        SELECT p.id AS project_id, p.name AS project_name, p.status AS project_status,
               p.updated_at AS project_updated_at,
               e.id AS episode_id, e.episode_no, e.name AS episode_name,
               e.status AS episode_status, e.updated_at AS episode_updated_at,
               sc.id AS scene_id, sc.scene_no, sc.name AS scene_name,
               sc.updated_at AS scene_updated_at,
               s.id AS shot_id, s.shot_code, s.title AS shot_title,
               s.updated_at AS shot_updated_at,
               s.selected_image_result_id, s.selected_video_result_id,
               cp.id AS control_package_id, cp.ready_marked_at
        FROM ${projects} p
        LEFT JOIN ${episodes} e
          ON e.project_id = p.id AND e.deleted_at IS NULL
        LEFT JOIN ${shots} s
          ON s.episode_id = e.id AND s.deleted_at IS NULL
        LEFT JOIN ${scenes} sc
          ON sc.id = s.scene_id AND sc.deleted_at IS NULL
        LEFT JOIN ${controlPackages} cp ON cp.shot_id = s.id
        WHERE p.id = ${projectId} AND p.deleted_at IS NULL AND ${scope}
        ORDER BY e.sort_order, e.episode_no, sc.sort_order, sc.scene_no, s.sort_order, s.shot_code
      `),
      query<ProductionHierarchySqlRow>(this.db, sql`
        SELECT p.id AS project_id, p.name AS project_name, p.status AS project_status,
               p.updated_at AS project_updated_at,
               e.id AS episode_id, e.episode_no, e.name AS episode_name,
               e.status AS episode_status, e.updated_at AS episode_updated_at,
               sc.id AS scene_id, sc.scene_no, sc.name AS scene_name,
               sc.updated_at AS scene_updated_at,
               NULL::uuid AS shot_id, NULL::text AS shot_code, NULL::text AS shot_title,
               NULL::timestamptz AS shot_updated_at,
               NULL::uuid AS selected_image_result_id, NULL::uuid AS selected_video_result_id,
               NULL::uuid AS control_package_id, NULL::timestamptz AS ready_marked_at
        FROM ${projects} p
        INNER JOIN ${episodes} e
          ON e.project_id = p.id AND e.deleted_at IS NULL
        INNER JOIN ${scenes} sc
          ON sc.episode_id = e.id AND sc.deleted_at IS NULL
        WHERE p.id = ${projectId} AND p.deleted_at IS NULL AND ${scope}
          AND NOT EXISTS (
            SELECT 1
            FROM ${shots} scene_shot
            WHERE scene_shot.scene_id = sc.id AND scene_shot.deleted_at IS NULL
          )
        ORDER BY e.sort_order, e.episode_no, sc.sort_order, sc.scene_no
      `),
    ]);
    const rows = [...shotRows, ...emptySceneRows];
    return rows.map((row) => ({
      projectId: row.project_id,
      projectName: row.project_name,
      projectStatus: row.project_status,
      projectUpdatedAt: timestamp(row.project_updated_at)!,
      episodeId: row.episode_id,
      episodeNo: row.episode_no,
      episodeName: row.episode_name,
      episodeStatus: row.episode_status,
      episodeUpdatedAt: timestamp(row.episode_updated_at),
      sceneId: row.scene_id,
      sceneNo: row.scene_no,
      sceneName: row.scene_name,
      sceneUpdatedAt: timestamp(row.scene_updated_at),
      shotId: row.shot_id,
      shotCode: row.shot_code,
      shotTitle: row.shot_title,
      shotUpdatedAt: timestamp(row.shot_updated_at),
      selectedImageResultId: row.selected_image_result_id,
      selectedVideoResultId: row.selected_video_result_id,
      controlPackageId: row.control_package_id,
      controlPackageReady: row.ready_marked_at !== null,
    }));
  }

  async loadProductionMedia(projectId: string, shotIds: string[]): Promise<ProductionMediaRow[]> {
    if (shotIds.length === 0) return [];
    const rows = await query<{
      id: string;
      shot_id: string;
      media_kind: string;
      persistence_status: string;
      review_status: string;
      execution_status: string | null;
      updated_at: Date | string;
    }>(this.db, sql`
      SELECT m.id, m.shot_id, m.media_kind, m.persistence_status, m.review_status,
             a.status AS execution_status, m.updated_at
      FROM ${mediaResults} m
      LEFT JOIN ${generationRequests} g ON g.id = m.request_id
      LEFT JOIN ${generationAttempts} a
        ON a.id = m.attempt_id AND a.request_id = m.request_id
      WHERE m.shot_id IN (${idList(shotIds)})
        AND m.deleted_at IS NULL
        AND (
          (m.request_id IS NOT NULL AND g.project_id = ${projectId})
          OR m.request_id IS NULL
        )
      ORDER BY m.shot_id, m.media_kind, m.created_at, m.id
    `);
    return rows.map((row) => ({
      id: row.id,
      shotId: row.shot_id,
      mediaKind: row.media_kind,
      persistenceStatus: row.persistence_status,
      reviewStatus: row.review_status,
      executionStatus: row.execution_status,
      updatedAt: timestamp(row.updated_at)!,
    }));
  }

  async loadEpisodeProductionRows(episodeId: string): Promise<SceneProductionRow[]> {
    return this.loadSceneProductionRowsWhere(sql`e.id = ${episodeId}`);
  }

  async loadEpisodeProjectId(episodeId: string): Promise<string | null> {
    const rows = await query<{ project_id: string }>(this.db, sql`
      SELECT e.project_id FROM ${episodes} e
      INNER JOIN ${projects} p ON p.id = e.project_id AND p.deleted_at IS NULL
      WHERE e.id = ${episodeId} AND e.deleted_at IS NULL
    `);
    return rows[0]?.project_id ?? null;
  }

  async loadSceneProductionRows(sceneId: string): Promise<SceneProductionRow[]> {
    return this.loadSceneProductionRowsWhere(sql`sc.id = ${sceneId}`);
  }

  private async loadSceneProductionRowsWhere(predicate: ReturnType<typeof sql>): Promise<SceneProductionRow[]> {
    const rows = await query<SceneProductionSqlRow>(this.db, sql`
      SELECT e.project_id, e.id AS episode_id,
             sc.id AS scene_id, sc.scene_no, sc.name AS scene_name,
             sc.sort_order AS scene_sort_order, sc.updated_at AS scene_updated_at,
             s.id AS shot_id, s.sort_order AS shot_sort_order, s.shot_code,
             s.updated_at AS shot_updated_at,
             cp.id AS control_package_id, (cp.ready_marked_at IS NOT NULL) AS control_package_ready,
             COALESCE(lanes.filled_lanes, ARRAY[]::text[]) AS filled_lanes,
             COALESCE(enabled.enabled_lane_count, 0)::int AS enabled_lane_count,
             current_attempt.status AS attempt_status, current_attempt.phase AS attempt_phase,
             queue_position.position AS queue_position,
             current_attempt.updated_at AS attempt_updated_at,
             primary_media.id AS primary_media_result_id, primary_media.media_kind AS primary_media_kind,
             primary_media.storage_url AS primary_media_storage_url,
             primary_media.mime_type AS primary_media_mime_type,
             primary_media.created_at AS primary_media_created_at,
             CASE WHEN COALESCE(
               current_attempt_for_primary.price_snapshot ->> 'productionMode',
               current_attempt_for_primary.price_snapshot ->> 'production_mode'
             ) = 'sample'
               THEN 'sample' ELSE 'full' END AS primary_production_mode,
             EXISTS (
               SELECT 1 FROM ${deliveryRecords} delivery
               WHERE delivery.project_id = e.project_id AND delivery.episode_id = e.id
                 AND delivery.media_result_ids ? primary_media.id::text
             ) AS primary_delivered
      FROM ${episodes} e
      INNER JOIN ${projects} p ON p.id = e.project_id AND p.deleted_at IS NULL
      INNER JOIN ${scenes} sc ON sc.episode_id = e.id AND sc.deleted_at IS NULL
      LEFT JOIN ${shots} s ON s.scene_id = sc.id AND s.deleted_at IS NULL
      LEFT JOIN ${controlPackages} cp ON cp.shot_id = s.id
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT ref.lane) AS filled_lanes
        FROM ${controlPackageRefs} ref
        INNER JOIN ${referenceLaneVocabulary} vocabulary
          ON vocabulary.id = ref.lane AND vocabulary.active = true
        WHERE ref.package_id = cp.id
      ) lanes ON true
      LEFT JOIN LATERAL (
        SELECT a.id, a.status, a.phase, a.next_poll_at, a.lease_until, a.created_at, a.updated_at
        FROM ${generationRequests} request
        INNER JOIN ${generationAttempts} a ON a.request_id = request.id
        WHERE request.shot_id = s.id AND request.project_id = e.project_id
          AND a.attempt_no = (
            SELECT max(latest.attempt_no) FROM ${generationAttempts} latest
            WHERE latest.request_id = request.id
          )
      ) current_attempt ON true
      LEFT JOIN LATERAL (
        SELECT 1 + count(*)::int AS position
        FROM ${generationAttempts} queued
        WHERE ${this.allowNewSubmission}
          AND current_attempt.status = 'pending' AND current_attempt.phase = 'created'
          AND (current_attempt.next_poll_at IS NULL OR current_attempt.next_poll_at <= CURRENT_TIMESTAMP)
          AND (current_attempt.lease_until IS NULL OR current_attempt.lease_until <= CURRENT_TIMESTAMP)
          AND queued.status IN ('pending', 'running')
          AND (queued.next_poll_at IS NULL OR queued.next_poll_at <= CURRENT_TIMESTAMP)
          AND (queued.lease_until IS NULL OR queued.lease_until <= CURRENT_TIMESTAMP)
          AND (
            (queued.next_poll_at IS NULL) < (current_attempt.next_poll_at IS NULL)
            OR ((queued.next_poll_at IS NULL) = (current_attempt.next_poll_at IS NULL)
              AND queued.next_poll_at < current_attempt.next_poll_at)
            OR (queued.next_poll_at IS NOT DISTINCT FROM current_attempt.next_poll_at
              AND queued.created_at = current_attempt.created_at AND queued.id < current_attempt.id)
            OR (queued.next_poll_at IS NOT DISTINCT FROM current_attempt.next_poll_at
              AND queued.created_at < current_attempt.created_at)
          )
      ) queue_position ON ${this.allowNewSubmission}
        AND current_attempt.status = 'pending' AND current_attempt.phase = 'created'
        AND (current_attempt.next_poll_at IS NULL OR current_attempt.next_poll_at <= CURRENT_TIMESTAMP)
        AND (current_attempt.lease_until IS NULL OR current_attempt.lease_until <= CURRENT_TIMESTAMP)
      LEFT JOIN ${mediaResults} primary_media
        ON primary_media.id = s.selected_video_result_id
          AND primary_media.shot_id = s.id
          AND primary_media.media_kind = 'video'
          AND primary_media.origin_kind = 'generation'
          AND primary_media.request_id IS NOT NULL
          AND primary_media.attempt_id IS NOT NULL
          AND primary_media.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM ${generationRequests} primary_request
            INNER JOIN ${generationAttempts} primary_attempt
              ON primary_attempt.id = primary_media.attempt_id
                AND primary_attempt.request_id = primary_request.id
                AND primary_attempt.status = 'succeeded'
            WHERE primary_request.id = primary_media.request_id
              AND primary_request.project_id = e.project_id
              AND primary_request.shot_id = s.id
              AND primary_request.media_kind = 'video'
          )
      LEFT JOIN ${generationAttempts} current_attempt_for_primary
        ON current_attempt_for_primary.id = primary_media.attempt_id
          AND current_attempt_for_primary.request_id = primary_media.request_id
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS enabled_lane_count FROM ${referenceLaneVocabulary} WHERE active = true
      ) enabled
      WHERE e.deleted_at IS NULL AND ${predicate}
      ORDER BY sc.sort_order, sc.scene_no, sc.id, s.sort_order, s.shot_code, s.id,
               current_attempt.created_at, current_attempt.id
    `);
    return rows.map(toSceneProductionRow);
  }
}

interface SceneProductionSqlRow {
  project_id: string;
  episode_id: string;
  scene_id: string;
  scene_no: number;
  scene_name: string | null;
  scene_sort_order: number;
  scene_updated_at: Date | string;
  shot_id: string | null;
  shot_sort_order: number | null;
  shot_code: string | null;
  shot_updated_at: Date | string | null;
  control_package_id: string | null;
  control_package_ready: boolean;
  filled_lanes: string[] | null;
  enabled_lane_count: number;
  attempt_status: string | null;
  attempt_phase: string | null;
  queue_position: number | null;
  attempt_updated_at: Date | string | null;
  primary_media_result_id: string | null;
  primary_media_kind: string | null;
  primary_media_storage_url: string | null;
  primary_media_mime_type: string | null;
  primary_media_created_at: Date | string | null;
  primary_production_mode: "sample" | "full";
  primary_delivered: boolean;
}

function toSceneProductionRow(row: SceneProductionSqlRow): SceneProductionRow {
  return {
    projectId: row.project_id,
    episodeId: row.episode_id,
    sceneId: row.scene_id,
    sceneNo: row.scene_no,
    sceneName: row.scene_name,
    sceneSortOrder: row.scene_sort_order,
    sceneUpdatedAt: timestamp(row.scene_updated_at)!,
    shotId: row.shot_id,
    shotSortOrder: row.shot_sort_order,
    shotCode: row.shot_code,
    shotUpdatedAt: timestamp(row.shot_updated_at),
    controlPackageId: row.control_package_id,
    controlPackageReady: row.control_package_ready === true,
    filledLanes: row.filled_lanes ?? [],
    enabledLaneCount: Number(row.enabled_lane_count),
    attemptStatus: row.attempt_status,
    attemptPhase: row.attempt_phase,
    queuePosition: row.queue_position === null ? null : Number(row.queue_position),
    attemptUpdatedAt: timestamp(row.attempt_updated_at),
    primaryMediaResultId: row.primary_media_result_id,
    primaryMediaKind: row.primary_media_kind,
    primaryMediaStorageUrl: row.primary_media_storage_url,
    primaryMediaMimeType: row.primary_media_mime_type,
    primaryMediaCreatedAt: timestamp(row.primary_media_created_at),
    primaryProductionMode: row.primary_production_mode === "sample" ? "sample" : "full",
    primaryDelivered: row.primary_delivered === true,
  };
}

function subjectStatement(kind: ObjectKind, id: string): ReturnType<typeof sql> {
  switch (kind) {
    case "project":
      return sql`
        SELECT p.id, p.name AS display_name, p.id AS project_id, p.owner_user_id,
               NULL::text AS visibility, NULL::uuid AS episode_id, NULL::uuid AS shot_id,
               NULL::text AS media_kind, NULL::uuid AS selected_image_result_id,
               NULL::uuid AS selected_video_result_id, p.status AS lifecycle,
               NULL::text AS platform_review_status, NULL::text AS media_review_status,
               NULL::text AS persistence_status, NULL::text AS execution_status,
               NULL::boolean AS control_package_ready, p.updated_at,
               NULL::text AS provider_cost_calculation_status,
               NULL::bigint AS provider_cost_cny_micros,
               NULL::boolean AS provider_cost_requires_attention
        FROM ${projects} p
        WHERE p.id = ${id} AND p.deleted_at IS NULL
      `;
    case "shot":
      return sql`
        SELECT s.id, COALESCE(s.title, s.shot_code) AS display_name, e.project_id,
               p.owner_user_id, NULL::text AS visibility, s.episode_id, s.id AS shot_id,
               NULL::text AS media_kind, s.selected_image_result_id, s.selected_video_result_id,
               'active'::text AS lifecycle, NULL::text AS platform_review_status,
               NULL::text AS media_review_status, NULL::text AS persistence_status,
               latest.status AS execution_status, (cp.ready_marked_at IS NOT NULL) AS control_package_ready,
               s.updated_at, NULL::text AS provider_cost_calculation_status,
               NULL::bigint AS provider_cost_cny_micros,
               NULL::boolean AS provider_cost_requires_attention
        FROM ${shots} s
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        INNER JOIN ${projects} p ON p.id = e.project_id AND p.deleted_at IS NULL
        LEFT JOIN ${controlPackages} cp ON cp.shot_id = s.id
        LEFT JOIN LATERAL (
          SELECT a.status
          FROM ${generationRequests} g
          INNER JOIN ${generationAttempts} a ON a.request_id = g.id
          WHERE g.shot_id = s.id AND g.project_id = e.project_id
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT 1
        ) latest ON true
        WHERE s.id = ${id} AND s.deleted_at IS NULL
      `;
    case "asset_entity":
      return sql`
        SELECT a.id, COALESCE(a.display_name, a.name) AS display_name, NULL::uuid AS project_id,
               a.owner_user_id, a.visibility, NULL::uuid AS episode_id, NULL::uuid AS shot_id,
               NULL::text AS media_kind, NULL::uuid AS selected_image_result_id,
               NULL::uuid AS selected_video_result_id,
               CASE WHEN a.deleted_at IS NULL THEN 'active' ELSE 'deleted' END AS lifecycle,
               a.status AS platform_review_status, NULL::text AS media_review_status,
               NULL::text AS persistence_status, NULL::text AS execution_status,
               NULL::boolean AS control_package_ready, a.updated_at,
               NULL::text AS provider_cost_calculation_status,
               NULL::bigint AS provider_cost_cny_micros,
               NULL::boolean AS provider_cost_requires_attention
        FROM ${assetEntities} a
        WHERE a.id = ${id} AND a.deleted_at IS NULL
      `;
    case "asset_media":
      return sql`
        SELECT m.id, COALESCE(m.title, a.display_name, a.name, m.id::text) AS display_name,
               NULL::uuid AS project_id, a.owner_user_id, a.visibility,
               NULL::uuid AS episode_id, NULL::uuid AS shot_id, m.media_kind,
               NULL::uuid AS selected_image_result_id, NULL::uuid AS selected_video_result_id,
               CASE WHEN m.deleted_at IS NULL THEN 'active' ELSE 'deleted' END AS lifecycle,
               a.status AS platform_review_status, NULL::text AS media_review_status,
               CASE WHEN m.storage_path IS NOT NULL OR m.storage_url IS NOT NULL THEN 'persisted' ELSE 'missing' END
                 AS persistence_status,
               NULL::text AS execution_status, NULL::boolean AS control_package_ready,
               COALESCE(m.created_at, a.updated_at) AS updated_at,
               NULL::text AS provider_cost_calculation_status,
               NULL::bigint AS provider_cost_cny_micros,
               NULL::boolean AS provider_cost_requires_attention
        FROM ${assetMedia} m
        LEFT JOIN ${assetVariants} v
          ON v.id = m.asset_variant_id AND v.deleted_at IS NULL
        INNER JOIN ${assetEntities} a
          ON a.id = COALESCE(m.asset_entity_id, v.asset_entity_id) AND a.deleted_at IS NULL
        WHERE m.id = ${id} AND m.deleted_at IS NULL
      `;
    case "media_result":
      return sql`
        SELECT m.id, CONCAT(m.media_kind, ' #', m.result_index + 1) AS display_name,
               COALESCE(g.project_id, e.project_id) AS project_id,
               p.owner_user_id, NULL::text AS visibility, e.id AS episode_id, m.shot_id,
               m.media_kind, s.selected_image_result_id, s.selected_video_result_id,
               CASE WHEN m.deleted_at IS NULL THEN 'active' ELSE 'deleted' END AS lifecycle,
               NULL::text AS platform_review_status, m.review_status AS media_review_status,
               m.persistence_status, a.status AS execution_status,
               (cp.ready_marked_at IS NOT NULL) AS control_package_ready, m.updated_at,
               pc.calculation_status AS provider_cost_calculation_status,
               pc.cost_cny_micros AS provider_cost_cny_micros,
               pc.requires_attention AS provider_cost_requires_attention
        FROM ${mediaResults} m
        LEFT JOIN ${generationRequests} g ON g.id = m.request_id
        LEFT JOIN ${generationAttempts} a
          ON a.id = m.attempt_id AND a.request_id = m.request_id
        LEFT JOIN ${providerCosts} pc
          ON pc.generation_attempt_id = m.attempt_id
          AND pc.generation_request_id = m.request_id
        LEFT JOIN ${shots} s ON s.id = m.shot_id AND s.deleted_at IS NULL
        LEFT JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        LEFT JOIN ${projects} p ON p.id = COALESCE(g.project_id, e.project_id) AND p.deleted_at IS NULL
        LEFT JOIN ${controlPackages} cp ON cp.shot_id = m.shot_id
        WHERE m.id = ${id} AND m.deleted_at IS NULL
          AND (g.project_id IS NULL OR e.project_id IS NULL OR g.project_id = e.project_id)
      `;
  }
}

function originStatement(kind: ObjectKind, ids: string[]): ReturnType<typeof sql> {
  switch (kind) {
    case "project":
      return emptyEdgeStatement();
    case "shot":
      return sql`
        SELECT CONCAT('contains:episode:', e.id, ':shot:', s.id) AS edge_id,
               'contains'::text AS relation, 'episode'::text AS from_kind, e.id AS from_id,
               COALESCE(e.name, CONCAT('第', e.episode_no, '集')) AS from_name,
               'shot'::text AS to_kind, s.id AS to_id, COALESCE(s.title, s.shot_code) AS to_name,
               'authoritative'::text AS truth, s.created_at AS occurred_at,
               jsonb_build_object('shot_code', s.shot_code) AS metadata, e.project_id
        FROM ${shots} s
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        WHERE s.id IN (${idList(ids)}) AND s.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('contains:scene:', sc.id, ':shot:', s.id), 'contains', 'scene', sc.id,
               COALESCE(sc.name, CONCAT('第', sc.scene_no, '场')), 'shot', s.id,
               COALESCE(s.title, s.shot_code), 'authoritative', s.created_at,
               jsonb_build_object('shot_code', s.shot_code), e.project_id
        FROM ${shots} s
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        INNER JOIN ${scenes} sc ON sc.id = s.scene_id AND sc.deleted_at IS NULL
        WHERE s.id IN (${idList(ids)}) AND s.deleted_at IS NULL
      `;
    case "asset_entity":
      return sql`
        SELECT CONCAT('copied_from:asset_entity:', a.id, ':asset_entity:', parent.id) AS edge_id,
               'copied_from'::text AS relation, 'asset_entity'::text AS from_kind, a.id AS from_id,
               COALESCE(a.display_name, a.name) AS from_name, 'asset_entity'::text AS to_kind,
               parent.id AS to_id, COALESCE(parent.display_name, parent.name) AS to_name,
               'authoritative'::text AS truth, a.created_at AS occurred_at,
               NULL::jsonb AS metadata, NULL::uuid AS project_id
        FROM ${assetEntities} a
        INNER JOIN ${assetEntities} parent
          ON parent.id = a.copied_from_asset_entity_id AND parent.deleted_at IS NULL
        WHERE a.id IN (${idList(ids)}) AND a.deleted_at IS NULL
      `;
    case "asset_media":
      return sql`
        SELECT CONCAT('contains:asset_entity:', a.id, ':asset_media:', m.id) AS edge_id,
               'contains'::text AS relation, 'asset_entity'::text AS from_kind, a.id AS from_id,
               COALESCE(a.display_name, a.name) AS from_name, 'asset_media'::text AS to_kind,
               m.id AS to_id, COALESCE(m.title, m.id::text) AS to_name,
               'authoritative'::text AS truth, m.created_at AS occurred_at,
               jsonb_build_object('media_kind', m.media_kind) AS metadata, NULL::uuid AS project_id
        FROM ${assetMedia} m
        LEFT JOIN ${assetVariants} v ON v.id = m.asset_variant_id AND v.deleted_at IS NULL
        INNER JOIN ${assetEntities} a
          ON a.id = COALESCE(m.asset_entity_id, v.asset_entity_id) AND a.deleted_at IS NULL
        WHERE m.id IN (${idList(ids)}) AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('contains:asset_variant:', v.id, ':asset_media:', m.id), 'contains',
               'asset_variant', v.id, v.name, 'asset_media', m.id, COALESCE(m.title, m.id::text),
               'authoritative', m.created_at, jsonb_build_object('media_kind', m.media_kind),
               NULL::uuid
        FROM ${assetMedia} m
        INNER JOIN ${assetVariants} v ON v.id = m.asset_variant_id AND v.deleted_at IS NULL
        WHERE m.id IN (${idList(ids)}) AND m.deleted_at IS NULL
      `;
    case "media_result":
      return sql`
        SELECT CONCAT('generated_from:generation_request:', g.id, ':media_result:', m.id) AS edge_id,
               'generated_from'::text AS relation, 'generation_request'::text AS from_kind,
               g.id AS from_id, CONCAT(g.media_kind, ' generation') AS from_name,
               'media_result'::text AS to_kind, m.id AS to_id,
               CONCAT(m.media_kind, ' #', m.result_index + 1) AS to_name,
               'authoritative'::text AS truth, m.created_at AS occurred_at,
               NULL::jsonb AS metadata, g.project_id
        FROM ${mediaResults} m
        INNER JOIN ${generationRequests} g ON g.id = m.request_id
        WHERE m.id IN (${idList(ids)}) AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('generated_from:generation_attempt:', a.id, ':media_result:', m.id),
               'generated_from', 'generation_attempt', a.id, CONCAT(a.provider, '/', a.model),
               'media_result', m.id, CONCAT(m.media_kind, ' #', m.result_index + 1),
               'authoritative', m.created_at,
               jsonb_build_object('attempt_status', a.status, 'attempt_no', a.attempt_no), g.project_id
        FROM ${mediaResults} m
        INNER JOIN ${generationAttempts} a ON a.id = m.attempt_id
        INNER JOIN ${generationRequests} g ON g.id = a.request_id
        WHERE m.id IN (${idList(ids)}) AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('generated_from:asset_media:', am.id, ':media_result:', m.id),
               'generated_from', 'asset_media', am.id, COALESCE(am.title, am.id::text),
               'media_result', m.id, CONCAT(m.media_kind, ' #', m.result_index + 1),
               'authoritative', m.created_at, NULL::jsonb, e.project_id
        FROM ${mediaResults} m
        INNER JOIN ${assetMedia} am ON am.id = m.source_asset_media_id AND am.deleted_at IS NULL
        INNER JOIN ${shots} s ON s.id = m.shot_id AND s.deleted_at IS NULL
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        WHERE m.id IN (${idList(ids)}) AND m.deleted_at IS NULL
      `;
  }
}

function usageStatement(kind: ObjectKind, id: string): ReturnType<typeof sql> {
  switch (kind) {
    case "project":
      return sql`
        SELECT CONCAT('contains:project:', p.id, ':episode:', e.id) AS edge_id,
               'contains'::text AS relation, 'project'::text AS from_kind, p.id AS from_id,
               p.name AS from_name, 'episode'::text AS to_kind, e.id AS to_id,
               COALESCE(e.name, CONCAT('第', e.episode_no, '集')) AS to_name,
               'authoritative'::text AS truth, e.created_at AS occurred_at,
               jsonb_build_object('episode_no', e.episode_no) AS metadata, p.id AS project_id
        FROM ${projects} p
        INNER JOIN ${episodes} e ON e.project_id = p.id AND e.deleted_at IS NULL
        WHERE p.id = ${id} AND p.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('contains:project:', p.id, ':shot:', s.id), 'contains', 'project', p.id,
               p.name, 'shot', s.id, COALESCE(s.title, s.shot_code), 'authoritative',
               s.created_at, jsonb_build_object('shot_code', s.shot_code), p.id
        FROM ${projects} p
        INNER JOIN ${episodes} e ON e.project_id = p.id AND e.deleted_at IS NULL
        INNER JOIN ${shots} s ON s.episode_id = e.id AND s.deleted_at IS NULL
        WHERE p.id = ${id} AND p.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('available_in:asset_entity:', a.id, ':project_asset_ref:', r.id), 'available_in',
               'asset_entity', a.id, COALESCE(a.display_name, a.name), 'project', p.id, p.name,
               'authoritative', r.created_at, NULL::jsonb, p.id
        FROM ${projectAssetRefs} r
        INNER JOIN ${projects} p ON p.id = r.project_id AND p.deleted_at IS NULL
        INNER JOIN ${assetEntities} a ON a.id = r.asset_entity_id AND a.deleted_at IS NULL
        WHERE r.project_id = ${id} AND r.deleted_at IS NULL
      `;
    case "shot":
      return sql`
        SELECT CONCAT('contains:shot:', s.id, ':control_package:', cp.id) AS edge_id,
               'contains'::text AS relation, 'shot'::text AS from_kind, s.id AS from_id,
               COALESCE(s.title, s.shot_code) AS from_name, 'control_package'::text AS to_kind,
               cp.id AS to_id, '控制包'::text AS to_name, 'authoritative'::text AS truth,
               cp.created_at AS occurred_at,
               jsonb_build_object('ready', cp.ready_marked_at IS NOT NULL) AS metadata, e.project_id
        FROM ${shots} s
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        INNER JOIN ${controlPackages} cp ON cp.shot_id = s.id
        WHERE s.id = ${id} AND s.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('used_by:shot:', s.id, ':generation_request:', g.id), 'used_by', 'shot', s.id,
               COALESCE(s.title, s.shot_code), 'generation_request', g.id,
               CONCAT(g.media_kind, ' generation'), 'authoritative', g.created_at,
               jsonb_build_object('media_kind', g.media_kind), g.project_id
        FROM ${shots} s
        INNER JOIN ${generationRequests} g ON g.shot_id = s.id
        WHERE s.id = ${id} AND s.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('contains:shot:', s.id, ':media_result:', m.id), 'contains', 'shot', s.id,
               COALESCE(s.title, s.shot_code), 'media_result', m.id,
               CONCAT(m.media_kind, ' #', m.result_index + 1), 'authoritative', m.created_at,
               jsonb_build_object('media_kind', m.media_kind, 'review_status', m.review_status),
               COALESCE(g.project_id, e.project_id)
        FROM ${shots} s
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        INNER JOIN ${mediaResults} m ON m.shot_id = s.id AND m.deleted_at IS NULL
        LEFT JOIN ${generationRequests} g ON g.id = m.request_id
        WHERE s.id = ${id} AND s.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('selected_as_primary:shot:', s.id, ':media_result:', m.id),
               'selected_as_primary', 'shot', s.id, COALESCE(s.title, s.shot_code),
               'media_result', m.id, CONCAT(m.media_kind, ' #', m.result_index + 1),
               'authoritative', s.updated_at, jsonb_build_object('media_kind', m.media_kind),
               COALESCE(g.project_id, e.project_id)
        FROM ${shots} s
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        INNER JOIN ${mediaResults} m
          ON m.id IN (s.selected_image_result_id, s.selected_video_result_id)
          AND m.deleted_at IS NULL
        LEFT JOIN ${generationRequests} g ON g.id = m.request_id
        WHERE s.id = ${id} AND s.deleted_at IS NULL
      `;
    case "asset_entity":
      return sql`
        SELECT CONCAT('contains:asset_entity:', a.id, ':asset_media:', m.id) AS edge_id,
               'contains'::text AS relation, 'asset_entity'::text AS from_kind, a.id AS from_id,
               COALESCE(a.display_name, a.name) AS from_name, 'asset_media'::text AS to_kind,
               m.id AS to_id, COALESCE(m.title, m.id::text) AS to_name,
               'authoritative'::text AS truth, m.created_at AS occurred_at,
               jsonb_build_object('media_kind', m.media_kind) AS metadata, NULL::uuid AS project_id
        FROM ${assetEntities} a
        INNER JOIN ${assetMedia} m
          ON m.deleted_at IS NULL
          AND (
            m.asset_entity_id = a.id
            OR EXISTS (
              SELECT 1
              FROM ${assetVariants} v
              WHERE v.id = m.asset_variant_id
                AND v.asset_entity_id = a.id
                AND v.deleted_at IS NULL
            )
          )
        WHERE a.id = ${id} AND a.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('available_in:asset_entity:', a.id, ':project_asset_ref:', r.id), 'available_in',
               'asset_entity', a.id, COALESCE(a.display_name, a.name), 'project', p.id, p.name,
               'authoritative', r.created_at, NULL::jsonb, p.id
        FROM ${assetEntities} a
        INNER JOIN ${projectAssetRefs} r
          ON r.asset_entity_id = a.id AND r.deleted_at IS NULL
        INNER JOIN ${projects} p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE a.id = ${id} AND a.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('used_by:asset_entity:', a.id, ':control_package_ref:', cr.id),
               'used_by', 'asset_entity',
               a.id, COALESCE(a.display_name, a.name), 'shot', s.id,
               COALESCE(s.title, s.shot_code), 'authoritative', cp.updated_at,
               jsonb_build_object('lane', cr.lane), e.project_id
        FROM ${assetEntities} a
        INNER JOIN ${assetMedia} m
          ON m.deleted_at IS NULL
          AND (
            m.asset_entity_id = a.id
            OR EXISTS (
              SELECT 1
              FROM ${assetVariants} v
              WHERE v.id = m.asset_variant_id
                AND v.asset_entity_id = a.id
                AND v.deleted_at IS NULL
            )
          )
        INNER JOIN ${controlPackageRefs} cr ON cr.asset_media_id = m.id
        INNER JOIN ${controlPackages} cp ON cp.id = cr.package_id
        INNER JOIN ${shots} s ON s.id = cp.shot_id AND s.deleted_at IS NULL
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        WHERE a.id = ${id} AND a.deleted_at IS NULL
      `;
    case "asset_media":
      return sql`
        SELECT CONCAT('available_in:asset_media:', m.id, ':project:', p.id) AS edge_id,
               'available_in'::text AS relation, 'asset_media'::text AS from_kind, m.id AS from_id,
               COALESCE(m.title, m.id::text) AS from_name, 'project'::text AS to_kind,
               p.id AS to_id, p.name AS to_name, 'authoritative'::text AS truth,
               r.created_at AS occurred_at, NULL::jsonb AS metadata, p.id AS project_id
        FROM ${assetMedia} m
        LEFT JOIN ${assetVariants} v ON v.id = m.asset_variant_id AND v.deleted_at IS NULL
        INNER JOIN ${projectAssetRefs} r
          ON r.asset_entity_id = COALESCE(m.asset_entity_id, v.asset_entity_id)
          AND r.deleted_at IS NULL
          AND (
            (r.asset_media_id IS NOT NULL AND r.asset_media_id = m.id)
            OR (
              r.asset_media_id IS NULL
              AND r.asset_variant_id IS NOT NULL
              AND r.asset_variant_id = m.asset_variant_id
            )
            OR (r.asset_media_id IS NULL AND r.asset_variant_id IS NULL)
          )
        INNER JOIN ${projects} p ON p.id = r.project_id AND p.deleted_at IS NULL
        WHERE m.id = ${id} AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('used_by:asset_media:', m.id, ':control_package_ref:', cr.id),
               'used_by', 'asset_media', m.id,
               COALESCE(m.title, m.id::text), 'shot', s.id, COALESCE(s.title, s.shot_code),
               'authoritative', cp.updated_at, jsonb_build_object('lane', cr.lane), e.project_id
        FROM ${assetMedia} m
        INNER JOIN ${controlPackageRefs} cr ON cr.asset_media_id = m.id
        INNER JOIN ${controlPackages} cp ON cp.id = cr.package_id
        INNER JOIN ${shots} s ON s.id = cp.shot_id AND s.deleted_at IS NULL
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        WHERE m.id = ${id} AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('references:asset_media:', m.id, ':generation_request:', g.id), 'references',
               'asset_media', m.id, COALESCE(m.title, m.id::text), 'generation_request', g.id,
               CONCAT(g.media_kind, ' generation'), 'snapshot', g.created_at,
               jsonb_build_object('media_kind', g.media_kind), g.project_id
        FROM ${assetMedia} m
        INNER JOIN ${generationRequests} g
          ON g.reference_media_ids ? (m.id::text)
        WHERE m.id = ${id} AND m.deleted_at IS NULL
      `;
    case "media_result":
      return sql`
        SELECT CONCAT('used_by:media_result:', m.id, ':shot:', s.id) AS edge_id,
               'used_by'::text AS relation, 'media_result'::text AS from_kind, m.id AS from_id,
               CONCAT(m.media_kind, ' #', m.result_index + 1) AS from_name, 'shot'::text AS to_kind,
               s.id AS to_id, COALESCE(s.title, s.shot_code) AS to_name,
               'authoritative'::text AS truth, m.created_at AS occurred_at,
               NULL::jsonb AS metadata, e.project_id
        FROM ${mediaResults} m
        INNER JOIN ${shots} s ON s.id = m.shot_id AND s.deleted_at IS NULL
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        WHERE m.id = ${id} AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('selected_as_primary:media_result:', m.id, ':shot:', s.id),
               'selected_as_primary', 'media_result', m.id,
               CONCAT(m.media_kind, ' #', m.result_index + 1), 'shot', s.id,
               COALESCE(s.title, s.shot_code), 'authoritative', s.updated_at,
               jsonb_build_object('media_kind', m.media_kind), e.project_id
        FROM ${mediaResults} m
        INNER JOIN ${shots} s
          ON m.id IN (s.selected_image_result_id, s.selected_video_result_id)
          AND s.deleted_at IS NULL
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        WHERE m.id = ${id} AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('used_by:media_result:', m.id, ':control_package_ref:', cr.id), 'used_by',
               'media_result', m.id, CONCAT(m.media_kind, ' #', m.result_index + 1),
               'control_package', cp.id, '控制包', 'authoritative', cr.created_at,
               jsonb_build_object('lane', cr.lane), e.project_id
        FROM ${mediaResults} m
        INNER JOIN ${controlPackageRefs} cr ON cr.media_result_id = m.id
        INNER JOIN ${controlPackages} cp ON cp.id = cr.package_id
        INNER JOIN ${shots} s ON s.id = cp.shot_id AND s.deleted_at IS NULL
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        WHERE m.id = ${id} AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('reviewed_by:media_result:', m.id, ':review_action:', ra.id), 'reviewed_by',
               'media_result', m.id, CONCAT(m.media_kind, ' #', m.result_index + 1),
               'review_action', ra.id, ra.action, 'authoritative', ra.created_at,
               jsonb_build_object('from_status', ra.from_status, 'to_status', ra.to_status),
               ra.project_id
        FROM ${mediaResults} m
        INNER JOIN ${mediaReviewActions} ra ON ra.media_result_id = m.id
        WHERE m.id = ${id} AND m.deleted_at IS NULL
        UNION ALL
        SELECT CONCAT('delivered_in:media_result:', m.id, ':delivery:', d.id), 'delivered_in',
               'media_result', m.id, CONCAT(m.media_kind, ' #', m.result_index + 1),
               'delivery', d.id, CONCAT('交付 ', d.created_at::text), 'snapshot', d.created_at,
               jsonb_build_object('partial', d.partial), d.project_id
        FROM ${mediaResults} m
        INNER JOIN ${deliveryRecords} d ON d.media_result_ids ? (m.id::text)
        WHERE m.id = ${id} AND m.deleted_at IS NULL
      `;
  }
}

function emptyEdgeStatement(): ReturnType<typeof sql> {
  return sql`
    SELECT NULL::text AS edge_id, NULL::text AS relation, NULL::text AS from_kind,
           NULL::uuid AS from_id, NULL::text AS from_name, NULL::text AS to_kind,
           NULL::uuid AS to_id, NULL::text AS to_name, NULL::text AS truth,
           NULL::timestamptz AS occurred_at, NULL::jsonb AS metadata,
           NULL::uuid AS project_id
    WHERE false
  `;
}

function scopePredicate(
  scopeKind: "project" | "episode" | "scene",
  scopeId?: string,
): ReturnType<typeof sql> {
  if (scopeKind === "project") return sql`true`;
  if (scopeKind === "episode") return sql`e.id = ${scopeId}`;
  return sql`sc.id = ${scopeId}`;
}

function toSubject(kind: ObjectKind, row: SubjectRow): ObjectSubject {
  const costValue = row.provider_cost_cny_micros === null
    ? null
    : Number(row.provider_cost_cny_micros);
  const providerCost: ObjectState["providerCost"] | null = row.provider_cost_calculation_status
    ? {
      calculationStatus: row.provider_cost_calculation_status,
      costCnyMicros: Number.isFinite(costValue) ? costValue : null,
      requiresAttention: row.provider_cost_requires_attention === true,
      source: "provider_costs",
    }
    : null;
  return {
    ref: {
      kind,
      id: row.id,
      displayName: row.display_name ?? undefined,
      revision: timestamp(row.updated_at) ?? undefined,
    },
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility,
    episodeId: row.episode_id,
    shotId: row.shot_id,
    mediaKind: row.media_kind,
    selectedImageResultId: row.selected_image_result_id,
    selectedVideoResultId: row.selected_video_result_id,
    lifecycle: row.lifecycle,
    platformReviewStatus: row.platform_review_status,
    mediaReviewStatus: row.media_review_status,
    persistenceStatus: row.persistence_status,
    executionStatus: row.execution_status,
    controlPackageReady: row.control_package_ready,
    updatedAt: timestamp(row.updated_at)!,
    providerCost,
  };
}

function toProjectScopedEdge(row: EdgeRow): ProjectScopedEdge {
  return {
    edge: {
      id: row.edge_id,
      relation: row.relation,
      from: ref(row.from_kind, row.from_id, row.from_name),
      to: ref(row.to_kind, row.to_id, row.to_name),
      truth: row.truth,
      ...(row.occurred_at ? { occurredAt: timestamp(row.occurred_at)! } : {}),
      ...(row.metadata ? { metadata: row.metadata } : {}),
    },
    projectId: row.project_id,
  };
}

function ref(kind: RelatedObjectKind, id: string, displayName: string | null): EntityRef {
  return { kind, id, ...(displayName ? { displayName } : {}) };
}

async function query<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(statement) as unknown as SqlResult<T>).rows;
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function idList(ids: string[]) {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

function uniqueIds(refs: EntityRef[], kind: AssetEndpointAccess["kind"]): string[] {
  return [...new Set(refs.flatMap((ref) => ref.kind === kind ? [ref.id] : []))];
}

function isObjectKind(kind: RelatedObjectKind): kind is ObjectKind {
  return kind === "project"
    || kind === "shot"
    || kind === "asset_entity"
    || kind === "asset_media"
    || kind === "media_result";
}

export function assetEndpointKey(kind: AssetEndpointAccess["kind"], id: string): string {
  return `${kind}:${id}`;
}

export function projectAssetEndpointKey(
  projectId: string,
  kind: AssetEndpointAccess["kind"],
  id: string,
): string {
  return `${projectId}:${assetEndpointKey(kind, id)}`;
}
