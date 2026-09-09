import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { assetEntities } from "../../db/schema.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { DrizzleVocabularyRepository } from "../vocabulary/repository.js";
import { TagVocabularyService } from "../vocabulary/service.js";
import { canManageAsset, canViewAsset, type AssetAccessRecord, type AssetVisibility } from "./access.js";

const assetTagParams = z.object({ asset_id: z.string().uuid() });
const assetTagDeleteParams = z.object({
  asset_id: z.string().uuid(),
  tag_id: z.string().trim().min(1).max(64),
});
const attachTagSchema = z.object({
  tag_id: z.string().trim().min(1).max(64),
}).strict();

export interface AssetTagRouteDependencies {
  createTagService?: (
    db: Database,
  ) => Pick<TagVocabularyService, "listAssetTags" | "attachTag" | "detachTag">;
  /** 默认查 asset_entities;测试可注入内存实现,避免依赖数据库。 */
  loadAssetAccess?: (db: Database, assetId: string) => Promise<AssetAccessRecord | null>;
}

/**
 * S41 资产打标/摘标/标签列表。权限口径与资产主路由一致:common 只读,
 * personal 仅 owner 可管理。标签写入恒落规范词 id(服务层一跳解析别名)。
 */
export async function registerAssetTagRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AssetTagRouteDependencies = {},
): Promise<void> {
  const tagService = () => dependencies.createTagService?.(getDatabase())
    ?? new TagVocabularyService(
      new DrizzleVocabularyRepository(getDatabase()),
      new DrizzleVocabularyRepository(getDatabase()),
    );
  const loadAccess = dependencies.loadAssetAccess ?? defaultLoadAssetAccess;

  async function requireAsset(
    assetId: string,
    actorId: string,
    manage: boolean,
    allowUnapprovedCommon = false,
  ): Promise<void> {
    const asset = await loadAccess(getDatabase(), assetId);
    if (!asset || asset.deletedAt) throw new NotFoundError("资产不存在");
    if (!canViewAsset(asset, actorId, false, allowUnapprovedCommon)) {
      throw new ForbiddenError("无权查看该资产");
    }
    if (manage && !canManageAsset(asset, actorId)) {
      throw new ForbiddenError("通用资产为只读,不能修改或删除");
    }
  }

  app.get("/api/v1/assets/:asset_id/tags", async (request) => {
    const params = parseRequest(assetTagParams, request.params);
    const actor = requireCurrentUser(request);
    await requireAsset(params.asset_id, actor.id, false, actor.role === "admin");
    const items = await tagService().listAssetTags(params.asset_id);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/assets/:asset_id/tags", async (request, reply) => {
    const params = parseRequest(assetTagParams, request.params);
    const input = parseRequest(attachTagSchema, request.body);
    const actorId = requireCurrentUser(request).id;
    await requireAsset(params.asset_id, actorId, true);
    const result = await tagService().attachTag(params.asset_id, input.tag_id, actorId);
    return reply.code(result.created ? 201 : 200).send(success(result));
  });

  app.delete("/api/v1/assets/:asset_id/tags/:tag_id", async (request) => {
    const params = parseRequest(assetTagDeleteParams, request.params);
    const actorId = requireCurrentUser(request).id;
    await requireAsset(params.asset_id, actorId, true);
    await tagService().detachTag(params.asset_id, params.tag_id);
    return success({ deleted: true });
  });
}

async function defaultLoadAssetAccess(db: Database, assetId: string): Promise<AssetAccessRecord | null> {
  const row = (await db.select({
    id: assetEntities.id,
    ownerUserId: assetEntities.ownerUserId,
    visibility: assetEntities.visibility,
    status: assetEntities.status,
    deletedAt: assetEntities.deletedAt,
  }).from(assetEntities).where(eq(assetEntities.id, assetId)).limit(1))[0];
  if (!row) return null;
  if (row.visibility !== "personal" && row.visibility !== "common") {
    throw new Error("Asset visibility is invalid");
  }
  return { ...row, visibility: row.visibility as AssetVisibility };
}
