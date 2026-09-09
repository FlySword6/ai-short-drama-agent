import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { settings } from "../../config/env.js";
import { NotFoundError, UnprocessableEntityError } from "../../shared/errors.js";
import { commonAssetReviewRejection } from "../assets/productionReviewGate.js";
import { isMediaReviewCleared, resolveMediaReviewStrategies } from "../reviews/mediaPolicy.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import {
  CONTROL_PACKAGE_LANES,
  type AddControlPackageRefInput,
  type ControlPackageActor,
  type ControlPackage,
  type ControlPackageRef,
  type ControlPackageStore,
} from "./types.js";

type SqlResult<T> = { rows: T[] };

interface ShotAccessRow {
  shot_id: string;
  project_id: string;
}

interface PackageRow {
  id: string;
  shot_id: string;
  ready_marked_by: string | null;
  ready_marked_by_name: string | null;
  ready_marked_at: Date | string | null;
}

interface RefRow {
  id: string;
  lane: string;
  asset_media_id: string | null;
  media_result_id: string | null;
  asset_storage_url: string | null;
  result_storage_url: string | null;
  asset_thumbnail_url: string | null;
  result_thumbnail_url: string | null;
  note: string | null;
  sort_order: number;
}

interface AccessibleReference {
  mediaKind: string;
}

interface AudioVersionRow {
  id: string;
  status: "candidate" | "selected" | "locked" | "discarded";
}

interface DeleteRefRow extends ShotAccessRow {
  lane: string;
  media_result_id: string | null;
}

const controlPackages = qualifiedTable("control_packages");
const controlPackageRefs = qualifiedTable("control_package_refs");
const shots = qualifiedTable("shots");
const episodes = qualifiedTable("episodes");
const projects = qualifiedTable("projects");
const users = qualifiedTable("users");
const assetMedia = qualifiedTable("asset_media");
const assetEntities = qualifiedTable("asset_entities");
const assetVariants = qualifiedTable("asset_variants");
const projectAssetRefs = qualifiedTable("project_asset_refs");
const mediaResults = qualifiedTable("media_results");
const generationRequests = qualifiedTable("generation_requests");
const generationAttempts = qualifiedTable("generation_attempts");
const referenceLaneVocabulary = qualifiedTable("reference_lane_vocabulary");

/**
 * Raw SQL is intentional here: the shared Drizzle schema is owned by the
 * integrator. Migration 013 is the database definition until it is adopted
 * there. All identifiers remain schema-qualified rather than relying on the
 * connection search path.
 */
function qualifiedTable(name: string) {
  return sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier(name)}`;
}

export class ControlPackageRepository implements ControlPackageStore {
  private readonly access: ProjectAccessService;

  constructor(private readonly db: Database) {
    this.access = ProjectAccessService.fromDatabase(new ProjectAccessRepository(db));
  }

  async get(actorInput: ControlPackageActor, shotId: string): Promise<ControlPackage> {
    await requireShotAccess(this.db, asProjectAccessActor(actorInput), shotId, "read", this.access);
    return readPackage(this.db, shotId);
  }

  async setReady(actorInput: ControlPackageActor, shotId: string, ready: boolean): Promise<ControlPackage> {
    const actor = asProjectAccessActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await lockShotAccess(db, actor, shotId, "create");
      if (ready) {
        const packageId = await ensurePackage(db, shotId);
        const now = new Date();
        await db.execute(sql`
          UPDATE ${controlPackages}
          SET ready_marked_by = ${actor.id}, ready_marked_at = ${now}, updated_at = ${now}
          WHERE id = ${packageId}
        `);
      } else {
        const now = new Date();
        await db.execute(sql`
          UPDATE ${controlPackages}
          SET ready_marked_by = NULL, ready_marked_at = NULL, updated_at = ${now}
          WHERE shot_id = ${shotId}
        `);
      }
      return readPackage(db, shotId);
    });
  }

  async addRef(
    actorInput: ControlPackageActor,
    shotId: string,
    input: AddControlPackageRefInput,
  ): Promise<ControlPackageRef> {
    const actor = asProjectAccessActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const access = await lockShotAccess(db, actor, shotId, "create");
      await assertLaneKnown(db, input.lane);
      const reference = await assertReferenceAccessible(db, actor.id, access.project_id, input);
      assertReferenceLaneMatchesMediaKind(input.lane, reference.mediaKind);
      const packageId = await ensurePackage(db, shotId);
      await db.execute(sql`SELECT id FROM ${controlPackages} WHERE id = ${packageId} FOR UPDATE`);

      // Lock the lifecycle row before deciding whether an audio candidate may
      // enter this package. This makes candidate -> selected and ref insertion
      // one transaction, and serializes competing packages for the same sound.
      const audioVersion = reference.mediaKind === "audio" && input.mediaResultId
        ? await lockAudioVersion(db, access.project_id, input.mediaResultId)
        : null;

      const existing = await findExistingRef(db, packageId, input);
      if (existing) {
        if (audioVersion?.status === "candidate" || audioVersion?.status === "discarded") {
          throw new UnprocessableEntityError("音频候选状态与控制包引用不一致,请先修复后再使用");
        }
        return toRef(existing);
      }

      if (audioVersion?.status === "discarded") {
        throw new UnprocessableEntityError("音频候选已废弃,不能挂入控制包");
      }
      if (audioVersion?.status === "selected") {
        // A selected version is meaningful only while it is attached to the
        // package that selected it. Never silently steal an existing binding or
        // repair an orphan by attaching it to an arbitrary package.
        const boundRef = await findAudioControlPackageRef(db, input.mediaResultId!);
        if (boundRef) {
          throw new UnprocessableEntityError("音频已被其他控制包选用,不能重复挂入");
        }
        throw new UnprocessableEntityError("这段声音素材的使用记录不完整，请刷新后再试");
      }

      const nextOrder = await nextSortOrder(db, packageId, input.lane);
      const now = new Date();
      const id = randomUUID();
      await db.execute(sql`
        INSERT INTO ${controlPackageRefs}
          (id, package_id, lane, asset_media_id, media_result_id, note, sort_order, created_at)
        VALUES (
          ${id}, ${packageId}, ${input.lane}, ${input.assetMediaId ?? null},
          ${input.mediaResultId ?? null}, ${input.note ?? null}, ${nextOrder}, ${now}
        )
        ON CONFLICT DO NOTHING
      `);
      const inserted = (await findRefBySource(db, packageId, input))[0];
      if (!inserted) throw new Error("控制包参考物写入后未能读取");
      if (audioVersion?.status === "candidate") {
        await selectAudioVersionForControlPackage(db, audioVersion.id, actor.id);
      }
      return toRef(inserted);
    });
  }

  async deleteRef(actorInput: ControlPackageActor, refId: string): Promise<void> {
    const actor = asProjectAccessActor(actorInput);
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const rows = await query<DeleteRefRow>(db, sql`
        SELECT s.id AS shot_id, e.project_id, r.lane, r.media_result_id
        FROM ${controlPackageRefs} r
        INNER JOIN ${controlPackages} c ON c.id = r.package_id
        INNER JOIN ${shots} s ON s.id = c.shot_id
        INNER JOIN ${episodes} e ON e.id = s.episode_id
        INNER JOIN ${projects} p ON p.id = e.project_id
        WHERE r.id = ${refId}
          AND s.deleted_at IS NULL AND e.deleted_at IS NULL AND p.deleted_at IS NULL
        FOR UPDATE OF r, s
      `);
      const access = rows[0];
      if (!access) throw hiddenControlRefNotFound();
      try {
        await ProjectAccessService.fromDatabase(new ProjectAccessRepository(db))
          .require(actor, access.project_id, "create");
      } catch (error) {
        if (error instanceof NotFoundError) throw hiddenControlRefNotFound();
        throw error;
      }
      const audioVersion = access.lane === "audio" && access.media_result_id
        ? await lockAudioVersion(db, access.project_id, access.media_result_id)
        : null;
      await db.execute(sql`DELETE FROM ${controlPackageRefs} WHERE id = ${refId}`);
      if (audioVersion?.status === "selected") {
        const remainingRef = await findAudioControlPackageRef(db, access.media_result_id!);
        if (!remainingRef) {
          await db.execute(sql`
            UPDATE ${qualifiedTable("audio_versions")}
            SET status = 'candidate', selected_by_user_id = NULL, selected_at = NULL, updated_at = ${new Date()}
            WHERE id = ${audioVersion.id} AND status = 'selected'
          `);
        }
      }
    });
  }
}

function asProjectAccessActor(actor: ControlPackageActor): ProjectAccessActor {
  return typeof actor === "string" ? { id: actor, role: "member" } : actor;
}

async function readPackage(db: Database, shotId: string): Promise<ControlPackage> {
  const packageRows = await query<PackageRow>(db, sql`
    SELECT c.id, c.shot_id, c.ready_marked_by, u.display_name AS ready_marked_by_name, c.ready_marked_at
    FROM ${controlPackages} c
    LEFT JOIN ${users} u ON u.id = c.ready_marked_by
    WHERE c.shot_id = ${shotId}
    LIMIT 1
  `);
  const row = packageRows[0];
  if (!row) return emptyPackage(shotId);
  const refs = await selectRefs(db, row.id);
  return {
    id: row.id,
    shotId,
    ready: row.ready_marked_by && row.ready_marked_by_name && row.ready_marked_at
      ? {
        markedBy: row.ready_marked_by,
        markedByName: row.ready_marked_by_name,
        markedAt: timestampText(row.ready_marked_at),
      }
      : null,
    lanes: groupLanes(refs),
  };
}

function emptyPackage(shotId: string): ControlPackage {
  return { id: null, shotId, ready: null, lanes: groupLanes([]) };
}

function groupLanes(refs: RefRow[]): Record<string, ControlPackageRef[]> {
  // Built-in lanes always appear (frozen response shape); vocabulary-registered
  // lanes beyond them appear dynamically once they carry refs.
  const lanes: Record<string, ControlPackageRef[]> = {};
  for (const lane of CONTROL_PACKAGE_LANES) lanes[lane] = [];
  for (const ref of refs) (lanes[ref.lane] ??= []).push(toRef(ref));
  return lanes;
}

function toRef(row: RefRow): ControlPackageRef {
  const isAsset = row.asset_media_id !== null;
  return {
    id: row.id,
    lane: row.lane,
    kind: isAsset ? "asset" : "generated",
    mediaId: row.asset_media_id ?? row.media_result_id!,
    thumbnailUrl: isAsset ? row.asset_thumbnail_url : row.result_thumbnail_url,
    storageUrl: isAsset ? row.asset_storage_url : row.result_storage_url,
    note: row.note,
    sortOrder: row.sort_order,
  };
}

function timestampText(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function requireShotAccess(
  db: Database,
  actor: ProjectAccessActor,
  shotId: string,
  action: ProjectAccessAction,
  accessService: ProjectAccessService,
): Promise<ShotAccessRow> {
  const rows = await query<ShotAccessRow>(db, sql`
    SELECT s.id AS shot_id, e.project_id
    FROM ${shots} s
    INNER JOIN ${episodes} e ON e.id = s.episode_id
    INNER JOIN ${projects} p ON p.id = e.project_id
    WHERE s.id = ${shotId}
      AND s.deleted_at IS NULL AND e.deleted_at IS NULL AND p.deleted_at IS NULL
    LIMIT 1
  `);
  const access = rows[0];
  if (!access) throw hiddenShotNotFound();
  try {
    await accessService.require(actor, access.project_id, action);
  } catch (error) {
    if (error instanceof NotFoundError) throw hiddenShotNotFound();
    throw error;
  }
  return access;
}

async function lockShotAccess(
  db: Database,
  actor: ProjectAccessActor,
  shotId: string,
  action: ProjectAccessAction,
): Promise<ShotAccessRow> {
  await db.execute(sql`SELECT id FROM ${shots} WHERE id = ${shotId} FOR UPDATE`);
  return requireShotAccess(
    db,
    actor,
    shotId,
    action,
    ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
  );
}

async function ensurePackage(db: Database, shotId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.execute(sql`
    INSERT INTO ${controlPackages} (id, shot_id, created_at, updated_at)
    VALUES (${id}, ${shotId}, ${now}, ${now})
    ON CONFLICT (shot_id) DO NOTHING
  `);
  const rows = await query<{ id: string }>(db, sql`
    SELECT id FROM ${controlPackages} WHERE shot_id = ${shotId} LIMIT 1
  `);
  const packageId = rows[0]?.id;
  if (!packageId) throw new Error("控制包创建后未能读取");
  return packageId;
}

function hiddenShotNotFound(): NotFoundError {
  return new NotFoundError("粗剪素材不存在或你没有访问权限");
}

function hiddenControlRefNotFound(): NotFoundError {
  return new NotFoundError("控制包参考物不存在或你没有访问权限");
}

/**
 * Lanes come from the reference_lane_vocabulary registry (migration 020). The
 * write path checks membership explicitly rather than catching the FK, so the
 * caller gets a human 422 instead of a raw 23503.
 */
async function assertLaneKnown(db: Database, lane: string): Promise<void> {
  const rows = await query<{ id: string; active: boolean }>(db, sql`
    SELECT id, active FROM ${referenceLaneVocabulary} WHERE id = ${lane} LIMIT 1
  `);
  const entry = rows[0];
  if (!entry) throw new UnprocessableEntityError("这个参考栏暂不可用，请换一个再试");
  if (!entry.active) throw new UnprocessableEntityError("这个参考栏已停用，请换一个再试");
}

async function assertReferenceAccessible(
  db: Database,
  actorId: string,
  projectId: string,
  input: AddControlPackageRefInput,
): Promise<AccessibleReference> {
  if (input.assetMediaId) {
    // Lock and validate the current reference facts in one fixed order. A
    // visibility/access query followed by a separate entity lock leaves a
    // TOCTOU window for media rebinding, common → personal changes, or project
    // reference revocation before the control-package row is inserted.
    const media = (await query<{
      id: string;
      media_kind: string;
      asset_entity_id: string | null;
      asset_variant_id: string | null;
    }>(db, sql`
      SELECT m.id, m.media_kind, m.asset_entity_id, m.asset_variant_id
      FROM ${assetMedia} m
      WHERE m.id = ${input.assetMediaId}
        AND m.deleted_at IS NULL
      LIMIT 1
      FOR SHARE
    `))[0];
    if (!media) throw new NotFoundError("库存资产不存在或不可引用");

    const variant = media.asset_variant_id
      ? (await query<{
          id: string;
          asset_entity_id: string;
        }>(db, sql`
          SELECT id, asset_entity_id
          FROM ${assetVariants}
          WHERE id = ${media.asset_variant_id}
            AND deleted_at IS NULL
          LIMIT 1
          FOR SHARE
        `))[0]
      : undefined;
    const entityId = media.asset_entity_id ?? variant?.asset_entity_id;
    if (!entityId) throw new NotFoundError("库存资产不存在或不可引用");

    const entity = (await query<{
      id: string;
      name: string | null;
      owner_user_id: string | null;
      visibility: string;
      status: string;
    }>(db, sql`
      SELECT id, name, owner_user_id, visibility, status
      FROM ${assetEntities}
      WHERE id = ${entityId}
        AND deleted_at IS NULL
      LIMIT 1
      FOR SHARE
    `))[0];
    if (!entity) throw new NotFoundError("库存资产不存在或不可引用");

    const projectRefs = await query<{
      asset_media_id: string | null;
      asset_variant_id: string | null;
    }>(db, sql`
      SELECT asset_media_id, asset_variant_id
      FROM ${projectAssetRefs}
      WHERE project_id = ${projectId}
        AND asset_entity_id = ${entity.id}
        AND deleted_at IS NULL
      ORDER BY id
      FOR SHARE
    `);
    const projectRefAccessible = projectRefs.some((projectRef) => (
      (projectRef.asset_media_id !== null && projectRef.asset_media_id === media.id)
      || (
        projectRef.asset_media_id === null
        && projectRef.asset_variant_id !== null
        && projectRef.asset_variant_id === media.asset_variant_id
      )
      || (projectRef.asset_media_id === null && projectRef.asset_variant_id === null)
    ));
    const canInspectUnapprovedCommon = entity.visibility === "common"
      && entity.status !== "approved"
      && !projectRefAccessible
      ? Boolean((await query<{ id: string }>(db, sql`
          SELECT id
          FROM ${users}
          WHERE id = ${actorId}
            AND active = true
            AND role = 'admin'
          LIMIT 1
          FOR SHARE
        `))[0])
      : false;
    const accessible = entity.visibility === "common"
      ? entity.status === "approved" || projectRefAccessible || canInspectUnapprovedCommon
      : entity.visibility === "personal"
        && (entity.owner_user_id === actorId || projectRefAccessible);
    if (!accessible) throw new NotFoundError("库存资产不存在或不可引用");

    const reviewRejection = commonAssetReviewRejection(entity, "参考控制包", media.id);
    if (reviewRejection) {
      const { message: displayMessage, details } = reviewRejection;
      throw new UnprocessableEntityError(displayMessage, details);
    }
    return { mediaKind: media.media_kind };
  }
  const rows = await query<{ id: string; review_status: string; media_kind: string }>(db, sql`
    SELECT r.id, r.review_status, r.media_kind
    FROM ${mediaResults} r
    LEFT JOIN ${generationRequests} g ON g.id = r.request_id
    LEFT JOIN ${generationAttempts} ga
      ON ga.id = r.attempt_id AND ga.request_id = r.request_id
    LEFT JOIN ${assetMedia} source_asset ON source_asset.id = r.source_asset_media_id
    LEFT JOIN ${shots} s ON s.id = r.shot_id
    LEFT JOIN ${episodes} e ON e.id = s.episode_id
    WHERE r.id = ${input.mediaResultId}
      AND r.deleted_at IS NULL
      AND r.persistence_status = 'persisted'
      AND (
        (r.origin_kind = 'generation' AND ga.status = 'succeeded')
        OR (
          r.origin_kind = 'asset_media'
          AND r.attempt_id IS NULL
          AND source_asset.id IS NOT NULL
          AND source_asset.deleted_at IS NULL
        )
      )
      AND (
        (r.request_id IS NOT NULL AND g.project_id = ${projectId})
        OR
        (r.request_id IS NULL AND e.project_id = ${projectId})
      )
    LIMIT 1
    FOR SHARE OF r
  `);
  const row = rows[0];
  if (!row) throw new NotFoundError("生成产物不存在或不属于当前项目");
  const mediaKind = asReviewMediaKind(row.media_kind);
  // 声音工坊的 candidate -> selected 就是“当前片段临时使用”的显式
  // 人为动作。它不能被项目的产品审核策略误变成不可选；真正的声音资产
  // 锁定仍由 AudioVersionRepository 在审核事实齐全后把关。已拒绝的音频
  // 不属于临时可用范围，保持拒绝。
  if (mediaKind === "audio") {
    if (row.review_status === "needs_review" || row.review_status === "accepted") {
      return { mediaKind };
    }
    throw new UnprocessableEntityError("音频产物已被拒绝，不能挂入控制包");
  }
  const strategies = await resolveMediaReviewStrategies(db, projectId);
  const strategy = strategies[mediaKind];
  if (!isMediaReviewCleared(row.review_status, strategy)) {
    throw new UnprocessableEntityError("产物尚未通过审核,不能挂入控制包");
  }
  return { mediaKind: row.media_kind };
}

/**
 * Audio lifecycle storage is owned by the audio package. The control-package
 * boundary locks it with schema-qualified SQL so the candidate transition can
 * be atomic without taking ownership of that module's Drizzle schema.
 */
async function lockAudioVersion(
  db: Database,
  projectId: string,
  mediaResultId: string,
): Promise<AudioVersionRow> {
  const audioVersions = qualifiedTable("audio_versions");
  const rows = await query<AudioVersionRow>(db, sql`
    SELECT id, status
    FROM ${audioVersions}
    WHERE media_result_id = ${mediaResultId}
      AND project_id = ${projectId}
    LIMIT 1
    FOR UPDATE
  `);
  const row = rows[0];
  if (!row) throw new UnprocessableEntityError("音频候选记录不存在,不能挂入控制包");
  return row;
}

function assertReferenceLaneMatchesMediaKind(lane: string, mediaKind: string): void {
  if (lane === "audio" && mediaKind !== "audio") {
    throw new UnprocessableEntityError("声音参考栏只能放声音素材");
  }
  if (lane !== "audio" && mediaKind === "audio") {
    throw new UnprocessableEntityError("声音素材只能放进声音参考栏");
  }
}

async function findAudioControlPackageRef(db: Database, mediaResultId: string): Promise<{ id: string } | undefined> {
  const rows = await query<{ id: string }>(db, sql`
    SELECT id
    FROM ${controlPackageRefs}
    WHERE media_result_id = ${mediaResultId} AND lane = 'audio'
    LIMIT 1
    FOR UPDATE
  `);
  return rows[0];
}

async function selectAudioVersionForControlPackage(
  db: Database,
  audioVersionId: string,
  actorId: string,
): Promise<void> {
  const now = new Date();
  const rows = await query<{ id: string }>(db, sql`
    UPDATE ${qualifiedTable("audio_versions")}
    SET status = 'selected', selected_by_user_id = ${actorId}, selected_at = ${now}, updated_at = ${now}
    WHERE id = ${audioVersionId} AND status = 'candidate'
    RETURNING id
  `);
  if (rows.length !== 1) {
    throw new UnprocessableEntityError("音频候选状态已变化,请刷新后重试");
  }
}

/**
 * A control package is a production input boundary. Unknown media must be
 * rejected here instead of inheriting an automatic image policy.
 */
function asReviewMediaKind(mediaKind: string): "image" | "video" | "audio" {
  if (mediaKind === "image" || mediaKind === "video" || mediaKind === "audio") return mediaKind;
  throw new UnprocessableEntityError("产物媒体类型未配置审核策略,不能挂入控制包");
}

async function findExistingRef(
  db: Database,
  packageId: string,
  input: AddControlPackageRefInput,
): Promise<RefRow | undefined> {
  return (await findRefBySource(db, packageId, input))[0];
}

async function findRefBySource(
  db: Database,
  packageId: string,
  input: AddControlPackageRefInput,
): Promise<RefRow[]> {
  return selectRefs(db, packageId, input.lane, input.assetMediaId, input.mediaResultId);
}

async function nextSortOrder(db: Database, packageId: string, lane: string): Promise<number> {
  const rows = await query<{ next_sort_order: number }>(db, sql`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
    FROM ${controlPackageRefs}
    WHERE package_id = ${packageId} AND lane = ${lane}
  `);
  return rows[0]?.next_sort_order ?? 0;
}

async function selectRefs(
  db: Database,
  packageId: string,
  lane?: string,
  assetMediaId?: string,
  mediaResultId?: string,
): Promise<RefRow[]> {
  const rows = await query<RefRow>(db, sql`
    SELECT
      r.id, r.lane, r.asset_media_id, r.media_result_id, r.note, r.sort_order,
      a.storage_url AS asset_storage_url,
      a.storage_url AS asset_thumbnail_url,
      m.storage_url AS result_storage_url,
      m.storage_url AS result_thumbnail_url
    FROM ${controlPackageRefs} r
    LEFT JOIN ${assetMedia} a ON a.id = r.asset_media_id
    LEFT JOIN ${mediaResults} m ON m.id = r.media_result_id
    LEFT JOIN ${generationAttempts} ga ON ga.id = m.attempt_id
    LEFT JOIN ${assetMedia} source_asset ON source_asset.id = m.source_asset_media_id
    WHERE r.package_id = ${packageId}
      AND (r.asset_media_id IS NULL OR a.deleted_at IS NULL)
      AND (
        r.media_result_id IS NULL
        OR (
          m.deleted_at IS NULL
          AND m.persistence_status = 'persisted'
          AND (
            (m.origin_kind = 'generation' AND ga.status = 'succeeded')
            OR (
              m.origin_kind = 'asset_media'
              AND m.attempt_id IS NULL
              AND source_asset.id IS NOT NULL
              AND source_asset.deleted_at IS NULL
            )
          )
        )
      )
      AND (${lane ?? null}::varchar IS NULL OR r.lane = ${lane ?? null})
      AND (${assetMediaId ?? null}::uuid IS NULL OR r.asset_media_id = ${assetMediaId ?? null})
      AND (${mediaResultId ?? null}::uuid IS NULL OR r.media_result_id = ${mediaResultId ?? null})
    ORDER BY r.lane ASC, r.sort_order ASC, r.created_at ASC
  `);
  return rows;
}

async function query<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(statement) as unknown as SqlResult<T>).rows;
}
