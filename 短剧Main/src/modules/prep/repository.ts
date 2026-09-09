import crypto, { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetMediaRenditions,
  assetVariants,
  episodes,
  projects,
  referenceLaneVocabulary,
  scenePrepCommits,
  scenePrepItems,
  scenes,
  shots,
} from "../../db/schema.js";
import {
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../shared/errors.js";
import { canReferenceAsset } from "../assets/access.js";
import { isAssetImageMediaKind } from "../assets/assetImageKinds.js";
import {
  isDisplayOnlyPreview,
  resolveAssetMediaDisplaySource,
  type AssetMediaWithRenditions,
} from "../assets/catalog.js";
import { buildAssetMediaDisplay } from "../assets/mediaDisplay.js";
import { ControlPackageRepository } from "../control-packages/repository.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type {
  ProjectAccessAction,
  ProjectAccessActor,
} from "../project-access/types.js";
import { ProjectAssetRepository } from "../project-assets/repository.js";
import type {
  CommitScenePrepInput,
  PullScenePrepItemInput,
  ScenePrepCommitMode,
  ScenePrepCommitResult,
  ScenePrepItem,
  ScenePrepStore,
} from "./types.js";

type PrepRow = typeof scenePrepItems.$inferSelect;

export class ScenePrepRepository implements ScenePrepStore {
  constructor(private readonly db: Database) {}

  async sceneProjectId(sceneId: string): Promise<string | null> {
    const row = (await this.db.select({ projectId: episodes.projectId })
      .from(scenes)
      .innerJoin(episodes, eq(episodes.id, scenes.episodeId))
      .innerJoin(projects, eq(projects.id, episodes.projectId))
      .where(and(
        eq(scenes.id, sceneId),
        isNull(scenes.deletedAt),
        isNull(episodes.deletedAt),
        isNull(projects.deletedAt),
      ))
      .limit(1))[0];
    return row?.projectId ?? null;
  }

  async list(actor: ProjectAccessActor, sceneId: string): Promise<ScenePrepItem[]> {
    await this.requireSceneAccess(actor, sceneId, "read");
    const rows = await this.db.select({
      item: scenePrepItems,
      assetName: sql<string>`coalesce(${assetEntities.displayName}, ${assetEntities.name})`,
    }).from(scenePrepItems)
      .innerJoin(assetEntities, eq(assetEntities.id, scenePrepItems.assetEntityId))
      .where(eq(scenePrepItems.sceneId, sceneId))
      .orderBy(asc(scenePrepItems.createdAt), asc(scenePrepItems.id));
    const thumbnails = await this.thumbnailUrls(rows.map((row) => row.item));
    return rows.map((row) => prepItem(
      row.item,
      row.assetName,
      thumbnails.get(row.item.id) ?? null,
    ));
  }

  async pull(
    actor: ProjectAccessActor,
    sceneId: string,
    input: PullScenePrepItemInput,
  ): Promise<ScenePrepItem> {
    const projectId = await this.requireSceneAccess(actor, sceneId, "create");
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await lockSceneProject(tx, sceneId, projectId);
      await transaction.execute(sql`
        select pg_advisory_xact_lock(hashtext(${`${actor.id}:${input.clientIdempotencyKey}`}))
      `);
      await assertLaneAvailable(tx, input.lane);
      const selection = await requireAssetSelection(tx, actor.id, input);

      const byKey = (await transaction.select().from(scenePrepItems).where(and(
        eq(scenePrepItems.createdByUserId, actor.id),
        eq(scenePrepItems.clientIdempotencyKey, input.clientIdempotencyKey),
      )).limit(1))[0];
      if (byKey) {
        assertPullIdentity(byKey, sceneId, input, selection.variantId, selection.mediaId);
        return this.readOne(tx, byKey.id);
      }

      const existing = (await transaction.select().from(scenePrepItems).where(and(
        eq(scenePrepItems.sceneId, sceneId),
        eq(scenePrepItems.lane, input.lane),
        eq(scenePrepItems.assetEntityId, input.assetEntityId),
      )).limit(1))[0];
      if (existing) {
        assertPullIdentity(existing, sceneId, input, selection.variantId, selection.mediaId);
        return this.readOne(tx, existing.id);
      }

      const now = new Date();
      const row = (await transaction.insert(scenePrepItems).values({
        id: crypto.randomUUID(),
        sceneId,
        lane: input.lane,
        assetEntityId: input.assetEntityId,
        assetVariantId: selection.variantId,
        assetMediaId: selection.mediaId,
        status: "pending",
        projectAssetRefId: null,
        createdByUserId: actor.id,
        committedByUserId: null,
        clientIdempotencyKey: input.clientIdempotencyKey,
        createdAt: now,
        updatedAt: now,
        committedAt: null,
      }).returning())[0];
      if (!row) throw new Error("备戏条目写入后未能读取");
      return this.readOne(tx, row.id);
    });
  }

  async remove(actor: ProjectAccessActor, sceneId: string, itemId: string): Promise<void> {
    await this.requireSceneAccess(actor, sceneId, "create");
    const removed = await this.db.delete(scenePrepItems).where(and(
      eq(scenePrepItems.id, itemId),
      eq(scenePrepItems.sceneId, sceneId),
      eq(scenePrepItems.status, "pending"),
    )).returning({ id: scenePrepItems.id });
    if (removed[0]) return;
    const existing = (await this.db.select({ status: scenePrepItems.status }).from(scenePrepItems)
      .where(and(eq(scenePrepItems.id, itemId), eq(scenePrepItems.sceneId, sceneId)))
      .limit(1))[0];
    if (existing?.status === "committed") {
      throw new ConflictError("这件资产已经送入场，不能从备戏单撤回", "prep_item_already_committed");
    }
    throw new NotFoundError("备戏条目不存在或你没有访问权限");
  }

  async commit(
    actor: ProjectAccessActor,
    sceneId: string,
    input: CommitScenePrepInput,
  ): Promise<ScenePrepCommitResult> {
    const projectId = await this.requireSceneAccess(actor, sceneId, "create");
    const normalized = normalizeCommitInput(input);
    const requestHash = commitHash(sceneId, normalized);
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await transaction.execute(sql`
        select pg_advisory_xact_lock(hashtext(${`${actor.id}:${input.clientIdempotencyKey}`}))
      `);

      const replay = (await transaction.select().from(scenePrepCommits).where(and(
        eq(scenePrepCommits.userId, actor.id),
        eq(scenePrepCommits.clientIdempotencyKey, input.clientIdempotencyKey),
      )).limit(1))[0];
      if (replay) {
        if (replay.sceneId !== sceneId || replay.requestHash !== requestHash) {
          throw new ConflictError("这个幂等键已经用于另一份备戏提交", "idempotency_conflict");
        }
        return commitResult(replay.result, true);
      }

      await lockSceneProject(tx, sceneId, projectId);
      const target = await resolveTarget(tx, sceneId, normalized);
      const items = await lockPendingItems(tx, sceneId, normalized.itemIds);
      if (items.length === 0) {
        throw new UnprocessableEntityError("备戏单没有待送入的资产");
      }

      const projectAssets = new ProjectAssetRepository(tx);
      const controlPackages = new ControlPackageRepository(tx);
      const projectAssetRefIds: string[] = [];
      const controlPackageRefIds: string[] = [];
      for (const item of items) {
        const projectRef = await projectAssets.add(actor.id, projectId, {
          assetEntityId: item.assetEntityId,
          assetVariantId: item.assetVariantId,
          assetMediaId: item.assetMediaId,
        }, projectId);
        projectAssetRefIds.push(projectRef.id);

        if (target.shotIds.length > 0) {
          if (!item.assetMediaId) {
            throw new UnprocessableEntityError(
              "送入镜头控制包需要选定具体素材，请回资产库为这件资产选择图片、视频或音频",
            );
          }
          for (const shotId of target.shotIds) {
            const ref = await controlPackages.addRef(actor, shotId, {
              lane: item.lane,
              assetMediaId: item.assetMediaId,
            });
            controlPackageRefIds.push(ref.id);
          }
        }
      }

      const committedAt = new Date();
      const itemIds = items.map((item) => item.id);
      for (const [index, item] of items.entries()) {
        await transaction.update(scenePrepItems).set({
          status: "committed",
          projectAssetRefId: projectAssetRefIds[index]!,
          committedByUserId: actor.id,
          committedAt,
          updatedAt: committedAt,
        }).where(eq(scenePrepItems.id, item.id));
      }

      const result: ScenePrepCommitResult = {
        commitId: crypto.randomUUID(),
        sceneId,
        projectId,
        mode: target.mode,
        itemIds,
        projectAssetRefIds: [...new Set(projectAssetRefIds)],
        shotIds: target.shotIds,
        controlPackageRefIds: [...new Set(controlPackageRefIds)],
        controlPackageRefCount: new Set(controlPackageRefIds).size,
        committedAt,
        idempotentReplay: false,
      };
      await transaction.insert(scenePrepCommits).values({
        id: result.commitId,
        sceneId,
        userId: actor.id,
        clientIdempotencyKey: input.clientIdempotencyKey,
        requestHash,
        targetMode: target.mode,
        result: commitSnapshot(result),
        createdAt: committedAt,
      });
      return result;
    });
  }

  private async readOne(db: Database, itemId: string): Promise<ScenePrepItem> {
    const row = (await db.select({
      item: scenePrepItems,
      assetName: sql<string>`coalesce(${assetEntities.displayName}, ${assetEntities.name})`,
    }).from(scenePrepItems)
      .innerJoin(assetEntities, eq(assetEntities.id, scenePrepItems.assetEntityId))
      .where(eq(scenePrepItems.id, itemId))
      .limit(1))[0];
    if (!row) throw new Error("备戏条目写入后未能读取");
    const thumbnails = await this.thumbnailUrls([row.item], db);
    return prepItem(row.item, row.assetName, thumbnails.get(row.item.id) ?? null);
  }

  private async requireSceneAccess(
    actor: ProjectAccessActor,
    sceneId: string,
    action: ProjectAccessAction,
  ): Promise<string> {
    const projectId = await this.sceneProjectId(sceneId);
    if (!projectId) throw new NotFoundError("场不存在或你没有访问权限");
    await ProjectAccessService.fromDatabase(new ProjectAccessRepository(this.db))
      .require(actor, projectId, action);
    return projectId;
  }

  private async thumbnailUrls(
    items: PrepRow[],
    db: Database = this.db,
  ): Promise<Map<string, string>> {
    if (!items.length) return new Map();
    const entityIds = [...new Set(items.map((item) => item.assetEntityId))];
    const variants = await db.select({ id: assetVariants.id, assetEntityId: assetVariants.assetEntityId })
      .from(assetVariants)
      .where(and(inArray(assetVariants.assetEntityId, entityIds), isNull(assetVariants.deletedAt)));
    const variantOwners = new Map(variants.map((variant) => [variant.id, variant.assetEntityId]));
    const media = await db.select().from(assetMedia).where(and(
      isNull(assetMedia.deletedAt),
      eq(assetMedia.approved, true),
      or(
        inArray(assetMedia.assetEntityId, entityIds),
        ...(variants.length ? [inArray(assetMedia.assetVariantId, variants.map((variant) => variant.id))] : []),
      ),
    )).orderBy(desc(assetMedia.isPrimary), asc(assetMedia.sortOrder), asc(assetMedia.createdAt));
    const renditions = media.length
      ? await db.select().from(assetMediaRenditions).where(
          inArray(assetMediaRenditions.assetMediaId, media.map((item) => item.id)),
        )
      : [];
    const renditionMap = new Map<string, typeof renditions>();
    for (const rendition of renditions) {
      const values = renditionMap.get(rendition.assetMediaId) ?? [];
      values.push(rendition);
      renditionMap.set(rendition.assetMediaId, values);
    }
    const enriched: AssetMediaWithRenditions[] = media.map((item) => ({
      ...item,
      displayRenditions: renditionMap.get(item.id) ?? [],
    }));
    const byEntity = new Map<string, AssetMediaWithRenditions[]>();
    for (const item of enriched) {
      const entityId = resolveActiveAssetMediaOwner(item, variantOwners);
      if (!entityId) continue;
      const values = byEntity.get(entityId) ?? [];
      values.push(item);
      byEntity.set(entityId, values);
    }
    const byId = new Map(
      [...byEntity.values()].flatMap((candidates) => candidates).map((item) => [item.id, item]),
    );
    const result = new Map<string, string>();
    for (const item of items) {
      const candidates = byEntity.get(item.assetEntityId) ?? [];
      const scopedCandidates = candidates.filter((candidate) =>
        candidate.assetVariantId === item.assetVariantId
      );
      const selected = item.assetMediaId ? byId.get(item.assetMediaId) : undefined;
      const source = selected?.assetVariantId === item.assetVariantId
        ? selected
        : scopedCandidates.find((candidate) =>
            !isDisplayOnlyPreview(candidate) && candidate.mediaKind === "model_3d"
          )
          ?? scopedCandidates.find((candidate) =>
            !isDisplayOnlyPreview(candidate) && isAssetImageMediaKind(candidate.mediaKind)
          );
      const displaySource = source
        ? resolveAssetMediaDisplaySource(source, scopedCandidates, variantOwners)
        : null;
      const thumbnail = displaySource
        ? buildAssetMediaDisplay({
            sourceSha256: displaySource.sha256,
            renditions: displaySource.displayRenditions ?? [],
          })?.thumbnail
        : null;
      if (thumbnail) result.set(item.id, thumbnail.url);
    }
    return result;
  }
}

/** Reject historical dual ownership instead of letting a direct entity mask it. */
function resolveActiveAssetMediaOwner(
  media: Pick<typeof assetMedia.$inferSelect, "assetEntityId" | "assetVariantId">,
  variantOwners: ReadonlyMap<string, string>,
): string | undefined {
  if (!media.assetVariantId) return media.assetEntityId ?? undefined;
  const variantOwner = variantOwners.get(media.assetVariantId);
  if (!variantOwner || (media.assetEntityId && media.assetEntityId !== variantOwner)) return undefined;
  return variantOwner;
}

function prepItem(row: PrepRow, assetName: string, thumbnailUrl: string | null): ScenePrepItem {
  if (row.status !== "pending" && row.status !== "committed") {
    throw new Error("备戏条目状态不正确");
  }
  return {
    id: row.id,
    sceneId: row.sceneId,
    lane: row.lane,
    assetEntityId: row.assetEntityId,
    assetVariantId: row.assetVariantId,
    assetMediaId: row.assetMediaId,
    assetName,
    thumbnailUrl,
    status: row.status,
    projectAssetRefId: row.projectAssetRefId,
    committedByUserId: row.committedByUserId,
    committedAt: row.committedAt,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function assertLaneAvailable(db: Database, lane: string): Promise<void> {
  const row = (await db.select({ active: referenceLaneVocabulary.active })
    .from(referenceLaneVocabulary)
    .where(eq(referenceLaneVocabulary.id, lane))
    .limit(1))[0];
  if (!row?.active) throw new UnprocessableEntityError("这个备戏栏暂不可用，请换一个再试");
}

async function requireAssetSelection(
  db: Database,
  actorId: string,
  input: PullScenePrepItemInput,
): Promise<{ variantId: string | null; mediaId: string | null }> {
  const entity = (await db.select().from(assetEntities)
    .where(eq(assetEntities.id, input.assetEntityId)).limit(1))[0];
  if (!entity || !canReferenceAsset({
    id: entity.id,
    ownerUserId: entity.ownerUserId,
    visibility: entity.visibility === "common" ? "common" : "personal",
    status: entity.status,
    deletedAt: entity.deletedAt,
  }, actorId)) {
    throw new NotFoundError("资产不存在或不可用于备戏");
  }

  let variantId = input.assetVariantId ?? null;
  if (variantId) {
    const variant = (await db.select().from(assetVariants).where(and(
      eq(assetVariants.id, variantId),
      eq(assetVariants.assetEntityId, entity.id),
      isNull(assetVariants.deletedAt),
    )).limit(1))[0];
    if (!variant) throw new NotFoundError("资产版本不存在或不可用于备戏");
  }

  const mediaId = input.assetMediaId ?? null;
  if (mediaId) {
    const media = (await db.select().from(assetMedia).where(and(
      eq(assetMedia.id, mediaId),
      isNull(assetMedia.deletedAt),
      eq(assetMedia.approved, true),
    )).limit(1))[0];
    if (!media) throw new NotFoundError("素材不存在或不可用于备戏");
    if (media.assetEntityId && media.assetEntityId !== entity.id) {
      throw new ConflictError("素材不属于所选资产", "asset_media_mismatch");
    }
    if (media.assetVariantId) {
      const mediaVariant = (await db.select().from(assetVariants).where(and(
        eq(assetVariants.id, media.assetVariantId),
        eq(assetVariants.assetEntityId, entity.id),
        isNull(assetVariants.deletedAt),
      )).limit(1))[0];
      if (!mediaVariant) throw new ConflictError("素材关联的资产版本不可用", "asset_media_variant_missing");
      if (variantId && variantId !== mediaVariant.id) {
        throw new ConflictError("素材不属于所选版本", "asset_media_variant_mismatch");
      }
      variantId = mediaVariant.id;
    } else if (!media.assetEntityId) {
      throw new ConflictError("素材缺少可验证的资产归属", "asset_media_unbound");
    }
  }
  return { variantId, mediaId };
}

function assertPullIdentity(
  row: PrepRow,
  sceneId: string,
  input: PullScenePrepItemInput,
  variantId: string | null,
  mediaId: string | null,
): void {
  if (row.sceneId !== sceneId
    || row.lane !== input.lane
    || row.assetEntityId !== input.assetEntityId
    || row.assetVariantId !== variantId
    || row.assetMediaId !== mediaId) {
    throw new ConflictError("这个幂等键已经用于另一件备戏资产", "idempotency_conflict");
  }
}

function normalizeCommitInput(
  input: CommitScenePrepInput,
): Required<Pick<CommitScenePrepInput, "allShots">> & {
  itemIds?: string[];
  shotIds?: string[];
} {
  const itemIds = input.itemIds ? [...new Set(input.itemIds)] : undefined;
  const shotIds = input.shotIds ? [...new Set(input.shotIds)] : undefined;
  if (itemIds && itemIds.length !== input.itemIds!.length) {
    throw new UnprocessableEntityError("备戏条目不能重复");
  }
  if (shotIds && shotIds.length !== input.shotIds!.length) {
    throw new UnprocessableEntityError("镜头不能重复");
  }
  return {
    allShots: input.allShots === true,
    ...(itemIds ? { itemIds } : {}),
    ...(shotIds ? { shotIds } : {}),
  };
}

async function lockSceneProject(db: Database, sceneId: string, projectId: string): Promise<void> {
  const row = (await db.select({ projectId: episodes.projectId }).from(scenes)
    .innerJoin(episodes, eq(episodes.id, scenes.episodeId))
    .innerJoin(projects, eq(projects.id, episodes.projectId))
    .where(and(
      eq(scenes.id, sceneId),
      eq(episodes.projectId, projectId),
      isNull(scenes.deletedAt),
      isNull(episodes.deletedAt),
      isNull(projects.deletedAt),
    )).limit(1).for("update"))[0];
  if (!row) throw new NotFoundError("场不存在或你没有访问权限");
}

async function resolveTarget(
  db: Database,
  sceneId: string,
  input: { allShots: boolean; shotIds?: string[] },
): Promise<{ mode: ScenePrepCommitMode; shotIds: string[] }> {
  if (input.allShots) {
    const rows = await db.select({ id: shots.id }).from(shots).where(and(
      eq(shots.sceneId, sceneId),
      isNull(shots.deletedAt),
    )).orderBy(asc(shots.sortOrder), asc(shots.id));
    if (rows.length === 0) throw new UnprocessableEntityError("这场还没有镜头，不能铺全场");
    return { mode: "all_shots", shotIds: rows.map((row) => row.id) };
  }
  if (!input.shotIds) return { mode: "scene", shotIds: [] };
  const rows = await db.select({ id: shots.id }).from(shots).where(and(
    inArray(shots.id, input.shotIds),
    eq(shots.sceneId, sceneId),
    isNull(shots.deletedAt),
  ));
  if (rows.length !== input.shotIds.length) {
    throw new NotFoundError("有镜头不属于这场或你没有访问权限");
  }
  const allowed = new Set(rows.map((row) => row.id));
  return { mode: "shots", shotIds: input.shotIds.filter((id) => allowed.has(id)) };
}

async function lockPendingItems(
  db: Database,
  sceneId: string,
  itemIds: string[] | undefined,
): Promise<PrepRow[]> {
  const where = itemIds
    ? and(
        eq(scenePrepItems.sceneId, sceneId),
        inArray(scenePrepItems.id, itemIds),
        eq(scenePrepItems.status, "pending"),
      )
    : and(eq(scenePrepItems.sceneId, sceneId), eq(scenePrepItems.status, "pending"));
  const rows = await db.select().from(scenePrepItems)
    .where(where)
    .orderBy(asc(scenePrepItems.createdAt), asc(scenePrepItems.id))
    .for("update");
  if (itemIds && rows.length !== itemIds.length) {
    throw new ConflictError("有备戏条目已送入、已撤回或不属于这场", "prep_item_not_pending");
  }
  return rows;
}

function commitHash(
  sceneId: string,
  input: { allShots: boolean; itemIds?: string[]; shotIds?: string[] },
): string {
  return createHash("sha256").update(JSON.stringify({
    sceneId,
    allShots: input.allShots,
    itemIds: input.itemIds ?? null,
    shotIds: input.shotIds ?? null,
  })).digest("hex");
}

function commitSnapshot(result: ScenePrepCommitResult): Record<string, unknown> {
  return {
    commitId: result.commitId,
    sceneId: result.sceneId,
    projectId: result.projectId,
    mode: result.mode,
    itemIds: result.itemIds,
    projectAssetRefIds: result.projectAssetRefIds,
    shotIds: result.shotIds,
    controlPackageRefIds: result.controlPackageRefIds,
    controlPackageRefCount: result.controlPackageRefCount,
    committedAt: result.committedAt.toISOString(),
  };
}

function commitResult(
  value: Record<string, unknown>,
  idempotentReplay: boolean,
): ScenePrepCommitResult {
  const text = (key: string) => {
    const field = value[key];
    if (typeof field !== "string") throw new Error("备戏提交回执不完整");
    return field;
  };
  const texts = (key: string) => {
    const field = value[key];
    if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
      throw new Error("备戏提交回执不完整");
    }
    return field as string[];
  };
  const mode = text("mode");
  if (mode !== "scene" && mode !== "shots" && mode !== "all_shots") {
    throw new Error("备戏提交回执模式不正确");
  }
  return {
    commitId: text("commitId"),
    sceneId: text("sceneId"),
    projectId: text("projectId"),
    mode,
    itemIds: texts("itemIds"),
    projectAssetRefIds: texts("projectAssetRefIds"),
    shotIds: texts("shotIds"),
    controlPackageRefIds: texts("controlPackageRefIds"),
    controlPackageRefCount: texts("controlPackageRefIds").length,
    committedAt: new Date(text("committedAt")),
    idempotentReplay,
  };
}
