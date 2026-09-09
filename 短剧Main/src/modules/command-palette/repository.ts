import { and, asc, eq, ilike, isNull, or, type SQL } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  episodes,
  projectAssetRefs,
  projectMembers,
  projects,
  scenes,
  shots,
} from "../../db/schema.js";
import { platformRoleOrMember } from "../auth/types.js";
import type {
  CommandPaletteActor,
  CommandPaletteRepository,
  CommandPaletteSearchResults,
} from "./types.js";

/** Escape user input for a LIKE/ILIKE pattern (default Postgres escape is `\`). */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function containsPattern(query: string): string {
  return `%${escapeLikePattern(query)}%`;
}

/**
 * Five collection queries, each with the same visibility rule as
 * production.listProjects: members see owner/membership projects, platform
 * admin/operator see everything, soft-deleted rows never surface. The left
 * join is safe because (project_id, user_id) is the project_members PK, so a
 * project can join at most one membership row for the actor.
 */
export class DrizzleCommandPaletteRepository implements CommandPaletteRepository {
  constructor(private readonly db: Database) {}

  async searchVisible(actor: CommandPaletteActor, query: string, perGroupLimit: number): Promise<CommandPaletteSearchResults> {
    const pattern = containsPattern(query);
    const role = platformRoleOrMember(actor.role);
    const includeAll = role === "admin" || role === "operator";
    const limit = Math.max(1, Math.min(perGroupLimit, 50));

    const [projectRows, episodeRows, sceneRows, shotRows, assetRows] = await Promise.all([
      this.searchProjects(actor.id, includeAll, pattern, limit),
      this.searchEpisodes(actor.id, includeAll, pattern, limit),
      this.searchScenes(actor.id, includeAll, pattern, limit),
      this.searchShots(actor.id, includeAll, pattern, limit),
      this.searchAssets(actor.id, includeAll, pattern, limit),
    ]);

    return {
      projects: projectRows,
      episodes: episodeRows,
      scenes: sceneRows,
      shots: shotRows,
      assets: assetRows,
    };
  }

  /** The one visibility predicate, shared by all five groups. */
  private visibility(actorId: string, includeAll: boolean): SQL | undefined {
    if (includeAll) return undefined;
    return or(eq(projects.ownerUserId, actorId), eq(projectMembers.userId, actorId));
  }

  private membershipJoin(actorId: string) {
    return and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, actorId));
  }

  private async searchProjects(actorId: string, includeAll: boolean, pattern: string, limit: number) {
    const rows = await this.db.select({ project: projects }).from(projects)
      .leftJoin(projectMembers, this.membershipJoin(actorId))
      .where(and(
        isNull(projects.deletedAt),
        this.visibility(actorId, includeAll),
        ilike(projects.name, pattern),
      ))
      .orderBy(asc(projects.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.project.id,
      name: row.project.name,
      description: row.project.description,
    }));
  }

  private async searchEpisodes(actorId: string, includeAll: boolean, pattern: string, limit: number) {
    const rows = await this.db.select({ episode: episodes }).from(episodes)
      .innerJoin(projects, eq(projects.id, episodes.projectId))
      .leftJoin(projectMembers, this.membershipJoin(actorId))
      .where(and(
        isNull(episodes.deletedAt),
        isNull(projects.deletedAt),
        this.visibility(actorId, includeAll),
        ilike(episodes.name, pattern),
      ))
      .orderBy(asc(episodes.updatedAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.episode.id,
      projectId: row.episode.projectId,
      episodeNo: row.episode.episodeNo,
      name: row.episode.name,
    }));
  }

  private async searchScenes(actorId: string, includeAll: boolean, pattern: string, limit: number) {
    const rows = await this.db.select({ scene: scenes, projectId: projects.id }).from(scenes)
      .innerJoin(episodes, eq(episodes.id, scenes.episodeId))
      .innerJoin(projects, eq(projects.id, episodes.projectId))
      .leftJoin(projectMembers, this.membershipJoin(actorId))
      .where(and(
        isNull(scenes.deletedAt),
        isNull(episodes.deletedAt),
        isNull(projects.deletedAt),
        this.visibility(actorId, includeAll),
        ilike(scenes.name, pattern),
      ))
      .orderBy(asc(scenes.updatedAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.scene.id,
      projectId: row.projectId,
      episodeId: row.scene.episodeId,
      sceneNo: row.scene.sceneNo,
      name: row.scene.name,
    }));
  }

  private async searchShots(actorId: string, includeAll: boolean, pattern: string, limit: number) {
    const rows = await this.db.select({ shot: shots, projectId: projects.id }).from(shots)
      .innerJoin(episodes, eq(episodes.id, shots.episodeId))
      .innerJoin(projects, eq(projects.id, episodes.projectId))
      .leftJoin(projectMembers, this.membershipJoin(actorId))
      .where(and(
        isNull(shots.deletedAt),
        isNull(episodes.deletedAt),
        isNull(projects.deletedAt),
        this.visibility(actorId, includeAll),
        or(ilike(shots.shotCode, pattern), ilike(shots.title, pattern)),
      ))
      .orderBy(asc(shots.updatedAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.shot.id,
      projectId: row.projectId,
      episodeId: row.shot.episodeId,
      shotCode: row.shot.shotCode,
      title: row.shot.title,
    }));
  }

  /**
   * 资产=项目资产引用 join 资产实体。活跃唯一索引 project_asset_refs_active_unique
   * 保证同一项目同一实体至多一条活跃引用;groupBy (实体, 项目) 让同一实体挂在多个
   * 项目时每个项目各出一条(跳转需要项目上下文),同项目内不重复。
   */
  private async searchAssets(actorId: string, includeAll: boolean, pattern: string, limit: number) {
    const rows = await this.db.select({
      id: assetEntities.id,
      projectId: projects.id,
      name: assetEntities.name,
      displayName: assetEntities.displayName,
      assetKind: assetEntities.assetKind,
    }).from(projectAssetRefs)
      .innerJoin(assetEntities, eq(assetEntities.id, projectAssetRefs.assetEntityId))
      .innerJoin(projects, eq(projects.id, projectAssetRefs.projectId))
      .leftJoin(projectMembers, this.membershipJoin(actorId))
      .where(and(
        isNull(projectAssetRefs.deletedAt),
        isNull(assetEntities.deletedAt),
        isNull(projects.deletedAt),
        this.visibility(actorId, includeAll),
        or(ilike(assetEntities.name, pattern), ilike(assetEntities.displayName, pattern)),
      ))
      .groupBy(assetEntities.id, projects.id, assetEntities.name, assetEntities.displayName, assetEntities.assetKind)
      .orderBy(asc(assetEntities.name))
      .limit(limit);
    return rows;
  }
}
