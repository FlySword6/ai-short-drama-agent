import { eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { settings } from "../../config/env.js";
import { assetEntities } from "../../db/schema.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { canViewAsset, type AssetAccessRecord } from "./access.js";

type SqlResult<T> = { rows: T[] };

export interface AssetUsageShot {
  projectId: string;
  projectName: string;
  episodeId: string;
  episodeNo: number;
  sceneId: string | null;
  sceneNo: number | null;
  shotId: string;
  shotCode: string;
  via: string[];
  lanes: string[];
  mediaIds: string[];
}

export interface AssetUsageBinding {
  projectId: string;
  projectName: string;
  episodeNos: number[];
  shotCount: number;
}

export interface AssetUsageReport {
  counts: {
    controlPackages: number;
    shots: number;
    generationRequests: number;
  };
  bindings: AssetUsageBinding[];
  shots: AssetUsageShot[];
}

interface MediaIdRow {
  id: string;
}

interface ControlRefRow {
  package_id: string;
  project_id: string;
  project_name: string;
  episode_id: string;
  episode_no: number;
  scene_id: string | null;
  scene_no: number | null;
  shot_id: string;
  shot_code: string;
  lane: string;
  asset_media_id: string;
}

interface GenerationRow {
  generation_request_id: string;
  project_id: string;
  shot_id: string | null;
}

interface ShotDimRow {
  project_id: string;
  project_name: string;
  episode_id: string;
  episode_no: number;
  scene_id: string | null;
  scene_no: number | null;
  shot_id: string;
  shot_code: string;
}

interface BindingRow {
  project_id: string;
  project_name: string;
}

const assetMedia = qualifiedTable("asset_media");
const assetVariants = qualifiedTable("asset_variants");
const controlPackages = qualifiedTable("control_packages");
const controlPackageRefs = qualifiedTable("control_package_refs");
const shots = qualifiedTable("shots");
const episodes = qualifiedTable("episodes");
const scenes = qualifiedTable("scenes");
const projects = qualifiedTable("projects");
const generationRequests = qualifiedTable("generation_requests");
const projectAssetRefs = qualifiedTable("project_asset_refs");

/**
 * Raw SQL is intentional here: control_package_refs is owned by migration 013
 * raw definitions and the generation-request reference list is a jsonb string
 * array, so identifier-qualification plus `?|` reads better than Drizzle.
 */
function qualifiedTable(name: string) {
  return sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier(name)}`;
}

/**
 * 资产的分镜级使用明细(R8 上下文可见):该资产的媒体被哪些控制包参考栏、
 * 哪些分镜、哪些生成请求引用,以及登记进哪些项目。三条链全部只读,且沿
 * shots/episodes/projects 的 deleted_at 过滤,不统计已删除对象。
 */
export class AssetUsageService {
  private readonly projectAccess: ProjectAccessService;

  constructor(
    private readonly db: Database,
    projectAccess = ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
  ) {
    this.projectAccess = projectAccess;
  }

  async report(
    actorInput: string | ProjectAccessActor,
    assetId: string,
    projectId?: string,
  ): Promise<AssetUsageReport> {
    const actor = typeof actorInput === "string" ? { id: actorInput, role: "member" as const } : actorInput;
    await this.requireVisible(actor.id, assetId);
    const mediaIds = await this.assetMediaIds(assetId);

    const shotMap = new Map<string, AssetUsageShot & { laneSet: Set<string>; mediaSet: Set<string>; viaSet: Set<string> }>();
    const packageIds = new Set<string>();
    let generationRows: GenerationRow[] = [];

    if (mediaIds.length > 0) {
      const candidateRefRows = await query<ControlRefRow>(this.db, sql`
        SELECT c.id AS package_id, p.id AS project_id, p.name AS project_name,
               e.id AS episode_id, e.episode_no,
               sc.id AS scene_id, sc.scene_no,
               s.id AS shot_id, s.shot_code,
               r.lane, r.asset_media_id
        FROM ${controlPackageRefs} r
        INNER JOIN ${controlPackages} c ON c.id = r.package_id
        INNER JOIN ${shots} s ON s.id = c.shot_id AND s.deleted_at IS NULL
        INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
        INNER JOIN ${projects} p ON p.id = e.project_id AND p.deleted_at IS NULL
        LEFT JOIN ${scenes} sc ON sc.id = s.scene_id AND sc.deleted_at IS NULL
        WHERE r.asset_media_id IN (${idList(mediaIds)})
      `);
      const readableRefProjects = await this.projectAccess.filterReadableProjectIds(
        actor,
        candidateRefRows.map((row) => row.project_id),
      );
      for (const row of candidateRefRows) {
        if (!readableRefProjects.has(row.project_id) || (projectId && row.project_id !== projectId)) continue;
        packageIds.add(row.package_id);
        const entry = upsertShot(shotMap, row);
        entry.viaSet.add("control_package");
        entry.laneSet.add(row.lane);
        entry.mediaSet.add(row.asset_media_id);
      }

      const candidateGenerationRows = await query<GenerationRow>(this.db, sql`
        SELECT g.id AS generation_request_id, g.project_id, g.shot_id
        FROM ${generationRequests} g
        WHERE g.reference_media_ids ?| ARRAY[${idList(mediaIds)}]::text[]
      `);
      const readableGenerationProjects = await this.projectAccess.filterReadableProjectIds(
        actor,
        candidateGenerationRows.map((row) => row.project_id),
      );
      generationRows = candidateGenerationRows.filter((row) =>
        readableGenerationProjects.has(row.project_id) && (!projectId || row.project_id === projectId),
      );

      const linkedShotIds = [...new Set(
        generationRows.map((row) => row.shot_id).filter((id): id is string => id !== null),
      )].filter((id) => !shotMap.has(id));
      if (linkedShotIds.length > 0) {
        const dimRows = await query<ShotDimRow>(this.db, sql`
          SELECT p.id AS project_id, p.name AS project_name,
                 e.id AS episode_id, e.episode_no,
                 sc.id AS scene_id, sc.scene_no,
                 s.id AS shot_id, s.shot_code
          FROM ${shots} s
          INNER JOIN ${episodes} e ON e.id = s.episode_id AND e.deleted_at IS NULL
          INNER JOIN ${projects} p ON p.id = e.project_id AND p.deleted_at IS NULL
          LEFT JOIN ${scenes} sc ON sc.id = s.scene_id AND sc.deleted_at IS NULL
          WHERE s.id IN (${idList(linkedShotIds)}) AND s.deleted_at IS NULL
        `);
        for (const row of dimRows) upsertShot(shotMap, row);
      }
      for (const row of generationRows) {
        if (row.shot_id) shotMap.get(row.shot_id)?.viaSet.add("generation_request");
      }
    }

    const candidateBindingRows = await query<BindingRow>(this.db, sql`
      SELECT p.id AS project_id, p.name AS project_name
      FROM ${projectAssetRefs} r
      INNER JOIN ${projects} p ON p.id = r.project_id AND p.deleted_at IS NULL
      WHERE r.asset_entity_id = ${assetId} AND r.deleted_at IS NULL
      GROUP BY p.id, p.name
    `);

    const readableBindingProjects = await this.projectAccess.filterReadableProjectIds(
      actor,
      candidateBindingRows.map((row) => row.project_id),
    );
    const bindingRows = candidateBindingRows.filter((row) =>
      readableBindingProjects.has(row.project_id) && (!projectId || row.project_id === projectId),
    );

    const shotsList = [...shotMap.values()].map((entry) => ({
      projectId: entry.projectId,
      projectName: entry.projectName,
      episodeId: entry.episodeId,
      episodeNo: entry.episodeNo,
      sceneId: entry.sceneId,
      sceneNo: entry.sceneNo,
      shotId: entry.shotId,
      shotCode: entry.shotCode,
      via: [...entry.viaSet].sort(),
      lanes: [...entry.laneSet].sort(),
      mediaIds: [...entry.mediaSet].sort(),
    }));
    shotsList.sort((a, b) =>
      a.episodeNo - b.episodeNo
      || (a.sceneNo ?? 0) - (b.sceneNo ?? 0)
      || a.shotCode.localeCompare(b.shotCode),
    );

    const bindingMap = new Map<string, AssetUsageBinding & { episodeSet: Set<number> }>();
    for (const row of bindingRows) {
      bindingMap.set(row.project_id, {
        projectId: row.project_id,
        projectName: row.project_name,
        episodeNos: [],
        shotCount: 0,
        episodeSet: new Set<number>(),
      });
    }
    for (const shot of shotsList) {
      const binding = bindingMap.get(shot.projectId) ?? {
        projectId: shot.projectId,
        projectName: shot.projectName,
        episodeNos: [],
        shotCount: 0,
        episodeSet: new Set<number>(),
      };
      binding.episodeSet.add(shot.episodeNo);
      binding.shotCount += 1;
      bindingMap.set(shot.projectId, binding);
    }
    const bindings = [...bindingMap.values()].map((binding) => ({
      projectId: binding.projectId,
      projectName: binding.projectName,
      episodeNos: [...binding.episodeSet].sort((a, b) => a - b),
      shotCount: binding.shotCount,
    }));
    bindings.sort((a, b) => a.projectName.localeCompare(b.projectName));

    return {
      counts: {
        controlPackages: packageIds.size,
        shots: shotsList.length,
        generationRequests: generationRows.length,
      },
      bindings,
      shots: shotsList,
    };
  }

  private async assetMediaIds(assetId: string): Promise<string[]> {
    const rows = await query<MediaIdRow>(this.db, sql`
      SELECT m.id
      FROM ${assetMedia} m
      LEFT JOIN ${assetVariants} v ON v.id = m.asset_variant_id AND v.deleted_at IS NULL
      WHERE m.deleted_at IS NULL
        AND (m.asset_entity_id = ${assetId} OR v.asset_entity_id = ${assetId})
    `);
    return rows.map((row) => row.id);
  }

  private async requireVisible(actorId: string, assetId: string): Promise<void> {
    const [asset] = await this.db.select({
      id: assetEntities.id,
      ownerUserId: assetEntities.ownerUserId,
      visibility: assetEntities.visibility,
      status: assetEntities.status,
      deletedAt: assetEntities.deletedAt,
    }).from(assetEntities).where(eq(assetEntities.id, assetId)).limit(1);
    if (!asset || asset.deletedAt) throw new NotFoundError("资产不存在");
    if (asset.visibility !== "personal" && asset.visibility !== "common") {
      throw new ForbiddenError("查看资产没成：资产权限信息异常，请刷新后重试。");
    }
    const record: AssetAccessRecord = {
      id: asset.id,
      ownerUserId: asset.ownerUserId,
      visibility: asset.visibility,
      status: asset.status,
      deletedAt: asset.deletedAt,
    };
    if (!canViewAsset(record, actorId)) throw new ForbiddenError("无权查看该资产");
  }
}

function upsertShot(
  map: Map<string, AssetUsageShot & { laneSet: Set<string>; mediaSet: Set<string>; viaSet: Set<string> }>,
  row: ShotDimRow,
) {
  const existing = map.get(row.shot_id);
  if (existing) return existing;
  const created = {
    projectId: row.project_id,
    projectName: row.project_name,
    episodeId: row.episode_id,
    episodeNo: row.episode_no,
    sceneId: row.scene_id,
    sceneNo: row.scene_no,
    shotId: row.shot_id,
    shotCode: row.shot_code,
    via: [],
    lanes: [],
    mediaIds: [],
    laneSet: new Set<string>(),
    mediaSet: new Set<string>(),
    viaSet: new Set<string>(),
  };
  map.set(row.shot_id, created);
  return created;
}

async function query<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(statement) as unknown as SqlResult<T>).rows;
}

/**
 * Drizzle 的 sql 模板不会把 JS 数组绑成 uuid[] 参数(会报 cannot cast type
 * record to uuid[]),仓库惯例是展开成 IN (...) 列表,见 reviews/repository.ts。
 * 所有调用点都有 length > 0 守卫,空数组不会进来。
 */
function idList(ids: string[]) {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}
