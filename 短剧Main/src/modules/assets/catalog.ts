import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetMediaRenditions,
  assetTags,
  assetVariants,
  parseAssetClearance,
  type AssetEntityRow,
  type AssetMediaRow,
  type AssetMediaRenditionRow,
} from "../../db/schema.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import type { AssetKindResolver, TagResolver } from "../vocabulary/types.js";
import {
  canManageAsset,
  canViewAsset,
  type AssetAccessRecord,
} from "./access.js";
import { lockAndRequireManageableAsset } from "./manageableAsset.js";
import {
  buildAssetMediaDisplay,
  redactAssetStorageMetadata,
  type AssetMediaDisplay,
  type AssetMediaDisplayInput,
} from "./mediaDisplay.js";
import {
  assetImageMediaKindSql,
  isAssetImageMediaKind,
} from "./assetImageKinds.js";
import {
  approvedAssetMediaOwnershipSql,
  assetMediaOwnerIdSql,
} from "./assetMediaVisibility.js";
import {
  directorPreviewBinding,
  directorPreviewBindingSql,
  directorPreviewIntentSql,
  directorPreviewSourceMediaIdSql,
  hasDirectorPreviewIntent,
} from "./directorPreviewBinding.js";

export interface AssetListFilters {
  scope: "personal" | "common";
  query?: string;
  assetKind?: string;
  status?: string;
  /** 仅平台审核入口可开；普通调用默认只能读取 status='approved' 的通用资产。 */
  allowUnapprovedCommon?: boolean;
  /** 标签 id 或别名,经词表解析为规范词后按同维度 OR 过滤。 */
  tags?: string[];
  /** 旧内部调用兼容；等价于只传一个 tags 值。 */
  tag?: string;
  media?: "image" | "model3d";
  category?: string;
  sourceProjectId?: string;
  gender?: string;
  /**
   * 资产因子字典中的规范值。字典仍在演进，因此这里把值当作不透明 ID，
   * 只匹配已标注资产的 metadata.age_band，不在 API 层复制第二套枚举。
   */
  ageBand?: string;
  sort?: "composite" | "newest";
}

export interface AssetListPage {
  items: Record<string, unknown>[];
  /** Count after all browse filters except the asset-kind tab. */
  total: number;
  /** Count after every filter; pagination must use this value. */
  filteredTotal: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  kindCounts: Record<string, number>;
}

/**
 * 默认解析端口:不接词表时保持精确匹配、不触库。离线工具与降级搜索等
 * 只传 db 的既有构造点因此零行为变化;词表接线只发生在 HTTP 路由层。
 */
export const identityAssetKindResolver: AssetKindResolver = {
  expandKinds: async (input) => [input],
};

export const identityTagResolver: TagResolver = {
  resolveTagId: async (input) => input,
  resolveTagIds: async (inputs) => inputs,
};

export interface AssetCatalogDependencies {
  kinds?: AssetKindResolver;
  tags?: TagResolver;
}

export interface AssetUpdateInput {
  name?: string;
  displayName?: string | null;
  intro?: string | null;
  appearance?: string | null;
  ageValue?: number | null;
  gender?: string | null;
  heightCm?: number | null;
  hairDescription?: string | null;
  outfitDescription?: string | null;
  category?: string | null;
  styleTags?: string[];
  reuseScope?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  role?: "character_identity" | "scene" | "prop" | "motion" | "camera_storyboard" | "style_env" | null;
  usageMode?: "reference" | "first_frame" | "last_frame" | null;
  /**
   * 不经过 HTTP 路由暴露（zod schema 会剥掉它）；直接调服务的写入方若携带
   * clearance，必须能过 parseAssetClearance——缺省位取 fail-safe 默认值，
   * 未知位或非布尔值在这里抛错，绝不落库。
   */
  clearance?: unknown;
}

export interface AssetViewOptions {
  allowUnapprovedCommon?: boolean;
}

export type AssetMediaWithRenditions = AssetMediaRow & {
  displayRenditions?: AssetMediaRenditionRow[];
};

export class AssetCatalogService {
  private readonly kinds: AssetKindResolver;
  private readonly tags: TagResolver;

  constructor(private readonly db: Database, dependencies: AssetCatalogDependencies = {}) {
    this.kinds = dependencies.kinds ?? identityAssetKindResolver;
    this.tags = dependencies.tags ?? identityTagResolver;
  }

  async list(actorId: string, filters: AssetListFilters): Promise<Record<string, unknown>[]> {
    const resolved = await this.resolveListFilters(filters);
    if (resolved.impossible) return [];
    const conditions = this.listConditions(actorId, filters, resolved, true);

    const rows = await this.db.select().from(assetEntities)
      .where(and(...conditions))
      // list() 是内部 PostgreSQL 降级召回入口，不承诺 browse-v1 产品排序。
      .orderBy(...this.legacyListOrder())
      .limit(500);
    const displayMedia = await this.displayMediaByEntity(rows.map((row) => row.id));
    return rows.map((row) => toAssetData(row, displayMedia.get(row.id)));
  }

  async listPage(
    actorId: string,
    filters: AssetListFilters,
    page: number,
    pageSize: number,
  ): Promise<AssetListPage> {
    const resolved = await this.resolveListFilters(filters);
    if (resolved.impossible) {
      return {
        items: [],
        total: 0,
        filteredTotal: 0,
        page,
        pageSize,
        hasMore: false,
        kindCounts: {},
      };
    }
    const conditions = this.listConditions(actorId, filters, resolved, true);
    const baseConditions = this.listConditions(actorId, filters, resolved, false);
    const where = and(...conditions);
    const baseWhere = and(...baseConditions);
    const offset = (page - 1) * pageSize;
    const [rows, totalRows, filteredTotalRows, kindCounts] = await Promise.all([
      this.db.select().from(assetEntities)
        .where(where)
        .orderBy(...this.listPageOrder(filters))
        .limit(pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(assetEntities).where(baseWhere),
      this.db.select({ value: count() }).from(assetEntities).where(where),
      this.kindCounts(actorId, filters, resolved),
    ]);
    const total = Number(totalRows[0]?.value ?? 0);
    const filteredTotal = Number(filteredTotalRows[0]?.value ?? 0);
    const displayMedia = await this.displayMediaByEntity(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toAssetData(row, displayMedia.get(row.id))),
      total,
      filteredTotal,
      page,
      pageSize,
      hasMore: offset + rows.length < filteredTotal,
      kindCounts,
    };
  }

  async get(
    actorId: string,
    assetId: string,
    options: AssetViewOptions = {},
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireVisible(actorId, assetId, options);
    const displayMedia = await this.displayMediaByEntity([asset.id]);
    return toAssetData(asset, displayMedia.get(asset.id));
  }

  async update(
    actorId: string,
    assetId: string,
    input: AssetUpdateInput,
  ): Promise<Record<string, unknown>> {
    const asset = await this.requireManageable(actorId, assetId);
    const { clearance, status, ...fields } = input;
    if (asset.visibility === "personal" && status !== undefined && status !== "approved") {
      throw new ConflictError(
        "个人资产无需审核，不能设置审核状态",
        "personal_asset_review_not_applicable",
      );
    }
    const rows = await this.db.update(assetEntities).set({
      ...fields,
      ...(asset.visibility === "personal"
        ? { status: "approved", approved: true }
        : status === undefined ? {} : { status }),
      ...(clearance === undefined ? {} : { clearance: parseAssetClearance(clearance) }),
      updatedAt: new Date(),
    }).where(and(eq(assetEntities.id, asset.id), isNull(assetEntities.deletedAt))).returning();
    const updated = rows[0];
    if (!updated) throw new NotFoundError("资产不存在");
    const displayMedia = await this.displayMediaByEntity([updated.id]);
    return toAssetData(updated, displayMedia.get(updated.id));
  }

  async moveToTrash(actorId: string, assetId: string): Promise<void> {
    const asset = await this.requireManageable(actorId, assetId);
    const rows = await this.db.update(assetEntities).set({
      deletedAt: new Date(),
      deletedByUserId: actorId,
      updatedAt: new Date(),
    }).where(and(eq(assetEntities.id, asset.id), isNull(assetEntities.deletedAt))).returning({
      id: assetEntities.id,
    });
    if (!rows[0]) throw new NotFoundError("资产不存在");
  }

  async versions(
    actorId: string,
    assetId: string,
    options: AssetViewOptions = {},
  ): Promise<Record<string, unknown>[]> {
    await this.requireVisible(actorId, assetId, options);
    const media = await this.mediaForEntities([assetId]);
    return media
      .filter((item) => !isDisplayOnlyPreview(item))
      .map((item) => toAssetMediaData(
        item,
        assetId,
        resolveAssetMediaDisplaySource(item, media),
      ));
  }

  async setPrimary(
    actorId: string,
    assetId: string,
    mediaId: string,
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await lockAndRequireManageableAsset(db, actorId, assetId);
      const variantIds = (await db.select({ id: assetVariants.id }).from(assetVariants).where(and(
        eq(assetVariants.assetEntityId, assetId),
        isNull(assetVariants.deletedAt),
      ))).map((row) => row.id);
      const belongs = mediaBelongsToEntity(assetId, variantIds);
      const target = (await db.select().from(assetMedia).where(and(
        eq(assetMedia.id, mediaId),
        isNull(assetMedia.deletedAt),
        belongs,
      )).limit(1))[0];
      if (!target) throw new NotFoundError("资产媒体版本不存在");

      await db.update(assetMedia).set({ isPrimary: false }).where(and(
        isNull(assetMedia.deletedAt),
        belongs,
      ));
      const updated = (await db.update(assetMedia).set({ isPrimary: true }).where(and(
        eq(assetMedia.id, target.id),
        isNull(assetMedia.deletedAt),
      )).returning())[0];
      if (!updated) throw new NotFoundError("资产媒体版本不存在");
      return toAssetMediaData(updated, assetId);
    });
  }

  private async requireVisible(
    actorId: string,
    assetId: string,
    options: AssetViewOptions = {},
  ): Promise<AssetEntityRow> {
    const asset = (await this.db.select().from(assetEntities)
      .where(eq(assetEntities.id, assetId)).limit(1))[0];
    if (!asset || asset.deletedAt) throw new NotFoundError("资产不存在");
    if (!canViewAsset(
      accessRecord(asset),
      actorId,
      false,
      options.allowUnapprovedCommon === true,
    )) {
      throw new ForbiddenError("无权查看该资产");
    }
    return asset;
  }

  private async requireManageable(actorId: string, assetId: string): Promise<AssetEntityRow> {
    const asset = await this.requireVisible(actorId, assetId);
    if (!canManageAsset(accessRecord(asset), actorId)) throw new ForbiddenError("通用资产为只读，不能修改或删除");
    return asset;
  }

  private async displayMediaByEntity(entityIds: string[]): Promise<Map<string, AssetMediaWithRenditions>> {
    if (!entityIds.length) return new Map();

    const ownerId = assetMediaOwnerIdSql(
      assetMedia.assetEntityId,
      assetMedia.assetVariantId,
      assetVariants.assetEntityId,
    );
    const approvedOwner = approvedAssetMediaOwnershipSql({
      mediaEntityId: assetMedia.assetEntityId,
      mediaVariantId: assetMedia.assetVariantId,
      mediaApproved: assetMedia.approved,
      variantId: assetVariants.id,
      variantEntityId: assetVariants.assetEntityId,
    });
    const rows = await this.db.selectDistinctOn([ownerId], {
      ownerId,
      variantOwnerId: assetVariants.assetEntityId,
      media: assetMedia,
    }).from(assetMedia).leftJoin(assetVariants, and(
      eq(assetVariants.id, assetMedia.assetVariantId),
      isNull(assetVariants.deletedAt),
    )).where(and(
      isNull(assetMedia.deletedAt),
      approvedOwner,
      inArray(ownerId, entityIds),
      sql`not (${directorPreviewIntentSql(assetMedia.metadata)})`,
    )).orderBy(
      ownerId,
      // A 3D source owns its separately bound display preview. Do not let an
      // unrelated image under the same entity impersonate that preview.
      sql`case
        when ${assetMedia.mediaKind} = 'model_3d' then 0
        when ${assetImageMediaKindSql(assetMedia.mediaKind)} then 1
        else 2
      end`,
      desc(assetMedia.isPrimary),
      asc(assetMedia.sortOrder),
      asc(assetMedia.createdAt),
      asc(assetMedia.id),
    );

    const sources = rows.map((row) => row.media);
    const models = sources.filter((media) => media.mediaKind === "model_3d");
    const previewSource = alias(assetMedia, "display_preview_source");
    const previewVariant = alias(assetVariants, "display_preview_variant");
    const sourceVariant = alias(assetVariants, "display_preview_source_variant");
    const previewOwnerId = assetMediaOwnerIdSql(
      assetMedia.assetEntityId,
      assetMedia.assetVariantId,
      previewVariant.assetEntityId,
    );
    const sourceOwnerId = assetMediaOwnerIdSql(
      previewSource.assetEntityId,
      previewSource.assetVariantId,
      sourceVariant.assetEntityId,
    );
    const approvedPreviewOwner = approvedAssetMediaOwnershipSql({
      mediaEntityId: assetMedia.assetEntityId,
      mediaVariantId: assetMedia.assetVariantId,
      mediaApproved: assetMedia.approved,
      variantId: previewVariant.id,
      variantEntityId: previewVariant.assetEntityId,
    });
    const approvedSourceOwner = approvedAssetMediaOwnershipSql({
      mediaEntityId: previewSource.assetEntityId,
      mediaVariantId: previewSource.assetVariantId,
      mediaApproved: previewSource.approved,
      variantId: sourceVariant.id,
      variantEntityId: sourceVariant.assetEntityId,
    });
    const previewRows = models.length
      ? await this.db.select({
        media: assetMedia,
        variantOwnerId: previewVariant.assetEntityId,
      }).from(assetMedia)
        .innerJoin(previewSource, and(
          sql`${previewSource.id}::text = ${directorPreviewSourceMediaIdSql(assetMedia.metadata)}`,
          isNull(previewSource.deletedAt),
          eq(previewSource.mediaKind, "model_3d"),
        ))
        .leftJoin(previewVariant, and(
          eq(previewVariant.id, assetMedia.assetVariantId),
          isNull(previewVariant.deletedAt),
        ))
        .leftJoin(sourceVariant, and(
          eq(sourceVariant.id, previewSource.assetVariantId),
          isNull(sourceVariant.deletedAt),
        )).where(and(
          isNull(assetMedia.deletedAt),
          assetImageMediaKindSql(assetMedia.mediaKind),
          directorPreviewBindingSql(assetMedia.metadata),
          inArray(previewSource.id, models.map((media) => media.id)),
          // Resolve ownership only after validating both direct and variant
          // declarations. Historical dual-owned rows must not let a direct
          // entity mask a conflicting variant owner.
          approvedPreviewOwner,
          approvedSourceOwner,
          sql`${previewOwnerId} = ${sourceOwnerId}`,
          sql`((${assetMedia.assetVariantId} is null and ${previewSource.assetVariantId} is null)
            or ${assetMedia.assetVariantId} = ${previewSource.assetVariantId})`,
        ))
      : [];
    const previews = previewRows.map((row) => row.media);
    const variantOwners = new Map<string, string>();
    for (const row of [...rows, ...previewRows]) {
      if (row.media.assetVariantId && row.variantOwnerId) {
        variantOwners.set(row.media.assetVariantId, row.variantOwnerId);
      }
    }
    const candidates = [...sources, ...previews];
    const displayRows = rows.map((row) => ({
      ownerId: row.ownerId,
      media: resolveAssetMediaDisplaySource(row.media, candidates, variantOwners) ?? row.media,
    }));
    const enriched = await this.attachRenditions(displayRows.map((row) => row.media));
    const byId = new Map(enriched.map((media) => [media.id, media]));
    return new Map(displayRows.map((row) => [row.ownerId, byId.get(row.media.id)!]));
  }

  private async mediaForEntities(entityIds: string[]): Promise<AssetMediaWithRenditions[]> {
    if (!entityIds.length) return [];
    const ownerId = assetMediaOwnerIdSql(
      assetMedia.assetEntityId,
      assetMedia.assetVariantId,
      assetVariants.assetEntityId,
    );
    const approvedOwner = approvedAssetMediaOwnershipSql({
      mediaEntityId: assetMedia.assetEntityId,
      mediaVariantId: assetMedia.assetVariantId,
      mediaApproved: assetMedia.approved,
      variantId: assetVariants.id,
      variantEntityId: assetVariants.assetEntityId,
    });
    const rows = await this.db.select({ media: assetMedia }).from(assetMedia).leftJoin(
      assetVariants,
      and(
        eq(assetVariants.id, assetMedia.assetVariantId),
        isNull(assetVariants.deletedAt),
      ),
    ).where(and(
      isNull(assetMedia.deletedAt),
      approvedOwner,
      inArray(ownerId, entityIds),
    )).orderBy(desc(assetMedia.isPrimary), asc(assetMedia.sortOrder), asc(assetMedia.createdAt));
    return this.attachRenditions(rows.map((row) => row.media));
  }

  private async attachRenditions(media: AssetMediaRow[]): Promise<AssetMediaWithRenditions[]> {
    if (!media.length) return [];
    const rows = await this.db.select().from(assetMediaRenditions).where(
      inArray(assetMediaRenditions.assetMediaId, media.map((item) => item.id)),
    );
    const byMedia = new Map<string, AssetMediaRenditionRow[]>();
    for (const rendition of rows) {
      const values = byMedia.get(rendition.assetMediaId) ?? [];
      values.push(rendition);
      byMedia.set(rendition.assetMediaId, values);
    }
    return media.map((item) => ({
      ...item,
      displayRenditions: byMedia.get(item.id) ?? [],
    }));
  }

  private async resolveListFilters(filters: AssetListFilters): Promise<{
    impossible: boolean;
    kinds: string[];
    tagIds: string[];
  }> {
    const kinds = filters.assetKind ? await this.kinds.expandKinds(filters.assetKind) : [];
    const requestedTags = [...new Set(filters.tags ?? (filters.tag ? [filters.tag] : []))];
    const resolvedTags = requestedTags.length
      ? this.tags.resolveTagIds
        ? await this.tags.resolveTagIds(requestedTags)
        : await Promise.all(requestedTags.map((tag) => this.tags.resolveTagId(tag)))
      : [];
    const tagIds = requestedTags.length
      ? [...new Set(resolvedTags.filter((tag): tag is string => Boolean(tag)))]
      : [];
    return {
      impossible: Boolean(
        (filters.assetKind && kinds.length === 0)
        || (requestedTags.length > 0 && tagIds.length === 0)
      ),
      kinds,
      tagIds,
    };
  }

  private listConditions(
    actorId: string,
    filters: AssetListFilters,
    resolved: { kinds: string[]; tagIds: string[] },
    includeAssetKind: boolean,
  ): SQL[] {
    const conditions: SQL[] = [
      isNull(assetEntities.deletedAt),
      filters.scope === "common"
        ? eq(assetEntities.visibility, "common")
        : and(eq(assetEntities.visibility, "personal"), eq(assetEntities.ownerUserId, actorId))!,
    ];
    if (includeAssetKind && filters.assetKind) {
      conditions.push(resolved.kinds.length === 1
        ? eq(assetEntities.assetKind, resolved.kinds[0]!)
        : inArray(assetEntities.assetKind, resolved.kinds));
    }
    if (filters.scope === "common" && !filters.allowUnapprovedCommon) {
      conditions.push(eq(assetEntities.status, "approved"));
    } else if (filters.status) {
      conditions.push(eq(assetEntities.status, filters.status));
    }
    if (resolved.tagIds.length) {
      conditions.push(inArray(
        assetEntities.id,
        this.db.select({ id: assetTags.assetEntityId }).from(assetTags)
          .where(inArray(assetTags.tagId, resolved.tagIds)),
      ));
    }
    if (filters.media) {
      conditions.push(this.hasMedia(filters.media === "image" ? "image" : "model_3d"));
    }
    if (filters.category) conditions.push(eq(assetEntities.category, filters.category));
    if (filters.sourceProjectId) conditions.push(eq(assetEntities.sourceProjectId, filters.sourceProjectId));
    if (filters.gender) conditions.push(eq(assetEntities.gender, filters.gender));
    if (filters.ageBand) {
      conditions.push(sql`${assetEntities.metadata}->>'age_band' = ${filters.ageBand}`);
    }
    if (filters.query) {
      const pattern = `%${filters.query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      conditions.push(or(
        ilike(assetEntities.name, pattern),
        ilike(assetEntities.displayName, pattern),
        ilike(assetEntities.intro, pattern),
      )!);
    }
    return conditions;
  }

  private listPageOrder(filters: AssetListFilters): SQL[] {
    if (filters.scope !== "common") return this.legacyListOrder();
    const sort = filters.sort ?? "composite";
    if (sort === "newest") {
      return [desc(assetEntities.createdAt), asc(assetEntities.id)];
    }
    return [
      desc(sql`case when ${this.hasMedia("image")} then 1 else 0 end`),
      desc(assetEntities.useCount),
      desc(assetEntities.updatedAt),
      asc(assetEntities.id),
    ];
  }

  private legacyListOrder(): SQL[] {
    return [
      desc(assetEntities.updatedAt),
      asc(assetEntities.name),
      asc(assetEntities.id),
    ];
  }

  private hasMedia(mediaKind: "image" | "model_3d"): SQL {
    const ownerId = assetMediaOwnerIdSql(
      assetMedia.assetEntityId,
      assetMedia.assetVariantId,
      assetVariants.assetEntityId,
    );
    return exists(
      this.db.select({ id: assetMedia.id }).from(assetMedia)
        .leftJoin(assetVariants, and(
          eq(assetVariants.id, assetMedia.assetVariantId),
          isNull(assetVariants.deletedAt),
        ))
        .where(and(
          isNull(assetMedia.deletedAt),
          approvedAssetMediaOwnershipSql({
            mediaEntityId: assetMedia.assetEntityId,
            mediaVariantId: assetMedia.assetVariantId,
            mediaApproved: assetMedia.approved,
            variantId: assetVariants.id,
            variantEntityId: assetVariants.assetEntityId,
          }),
          mediaKind === "image"
            ? assetImageMediaKindSql(assetMedia.mediaKind)
            : eq(assetMedia.mediaKind, mediaKind),
          eq(ownerId, assetEntities.id),
        )),
    );
  }

  private async kindCounts(
    actorId: string,
    filters: AssetListFilters,
    resolved: { kinds: string[]; tagIds: string[] },
  ): Promise<Record<string, number>> {
    const rows = await this.db.select({
      assetKind: assetEntities.assetKind,
      value: count(),
    }).from(assetEntities)
      .where(and(...this.listConditions(actorId, filters, resolved, false)))
      .groupBy(assetEntities.assetKind);
    return Object.fromEntries(rows.map((row) => [row.assetKind, Number(row.value)]));
  }
}

/**
 * 卡片和详情的展示媒体优先使用图片预览。`is_primary` 的唯一约束按 media_kind
 * 分组，因此同一 3D 资产可以同时拥有主 GLB 和主 PNG；不能依赖数据库返回顺序
 * 猜哪一条是缩略图。没有图片时再保留既有的主媒体回落。
 */
export function selectDisplayMediaByEntity(
  rows: AssetMediaRow[],
  variantOwners: ReadonlyMap<string, string> = new Map(),
): Map<string, AssetMediaRow> {
  const grouped = new Map<string, AssetMediaRow[]>();
  for (const media of rows) {
    const owner = resolveAssetMediaOwner(media, variantOwners);
    if (!owner) continue;
    const values = grouped.get(owner) ?? [];
    values.push(media);
    grouped.set(owner, values);
  }
  const result = new Map<string, AssetMediaRow>();
  for (const [owner, media] of grouped) {
    const business = media.filter((item) =>
      item.approved === true
      && !isDisplayOnlyPreview(item)
      && resolveAssetMediaOwner(item, variantOwners) === owner
    );
    const source = business.find((item) => item.mediaKind === "model_3d")
      ?? business.find((item) => isAssetImageMediaKind(item.mediaKind))
      ?? business[0];
    if (!source) continue;
    result.set(owner, resolveAssetMediaDisplaySource(source, media, variantOwners) ?? source);
  }
  return result;
}

export function resolveAssetMediaDisplaySource<T extends AssetMediaRow>(
  source: T,
  candidates: readonly T[],
  variantOwners: ReadonlyMap<string, string> = new Map(),
): T | null {
  if (source.approved !== true) return null;
  if (isAssetImageMediaKind(source.mediaKind) && !isDisplayOnlyPreview(source)) return source;
  if (source.mediaKind !== "model_3d" || !source.sha256) return null;
  return candidates.find((candidate) => {
    const binding = directorPreviewBinding(candidate.metadata);
    return isAssetImageMediaKind(candidate.mediaKind)
      && candidate.approved === true
      && binding?.sourceMediaId === source.id
      && binding.sourceSha256 === source.sha256
      && sharesExactActiveAssetOwnership(source, candidate, variantOwners);
  }) ?? null;
}

/**
 * Metadata is only a binding hint, never an ownership proof. A preview may
 * display a model only when both rows resolve to the same entity; a variant
 * source additionally requires the same variant ID. Callers loading from SQL
 * enforce active variants there, while this final check prevents a malformed
 * candidate collection from reintroducing cross-asset binding.
 */
function sharesExactActiveAssetOwnership(
  source: Pick<AssetMediaRow, "assetEntityId" | "assetVariantId">,
  candidate: Pick<AssetMediaRow, "assetEntityId" | "assetVariantId">,
  variantOwners: ReadonlyMap<string, string>,
): boolean {
  if (source.assetVariantId || candidate.assetVariantId) {
    if (!source.assetVariantId || source.assetVariantId !== candidate.assetVariantId) {
      return false;
    }
    const variantOwner = variantOwners.get(source.assetVariantId);
    if (!variantOwner) {
      // Without an active-owner map, exact UUID identity is sufficient only
      // for pure variant-owned rows. A direct entity declaration could
      // conflict with that variant and therefore fails closed.
      return source.assetEntityId === null && candidate.assetEntityId === null;
    }
    return (source.assetEntityId === null || source.assetEntityId === variantOwner)
      && (candidate.assetEntityId === null || candidate.assetEntityId === variantOwner);
  }
  return Boolean(
    source.assetEntityId
    && source.assetEntityId === candidate.assetEntityId,
  );
}

function resolveAssetMediaOwner(
  media: Pick<AssetMediaRow, "assetEntityId" | "assetVariantId">,
  variantOwners: ReadonlyMap<string, string>,
): string | undefined {
  if (!media.assetVariantId) return media.assetEntityId ?? undefined;
  const variantOwner = variantOwners.get(media.assetVariantId);
  if (!variantOwner) return undefined;
  if (media.assetEntityId && media.assetEntityId !== variantOwner) return undefined;
  return variantOwner;
}

export function isDisplayOnlyPreview(
  media: Pick<AssetMediaRow, "metadata">,
): boolean {
  return hasDirectorPreviewIntent(media.metadata);
}

function mediaBelongsToEntity(assetId: string, variantIds: string[]) {
  return or(
    eq(assetMedia.assetEntityId, assetId),
    ...(variantIds.length ? [inArray(assetMedia.assetVariantId, variantIds)] : []),
  );
}

export function toAssetData(
  asset: AssetEntityRow,
  displayMedia?: AssetMediaWithRenditions,
  displayOptions: Pick<AssetMediaDisplayInput, "displayBaseUrl" | "displayBucket"> = {},
): Record<string, unknown> {
  const display = displayMedia ? mediaDisplay(displayMedia, displayOptions) : null;
  const imageStatus = assetImageStatus(displayMedia, display);
  const hasImageSource = imageStatus !== "missing";
  const primaryImage = hasImageSource && displayMedia
    ? toAssetMediaData(displayMedia)
    : undefined;
  const currentMedia = displayMedia
    ? toAssetMediaData(displayMedia, asset.id, displayMedia)
    : undefined;
  return {
    id: asset.id,
    sourceId: asset.id,
    copiedFromAssetEntityId: asset.copiedFromAssetEntityId,
    sourceProjectId: asset.sourceProjectId,
    sourceProjectName: asset.sourceProjectName,
    ownerUserId: asset.ownerUserId,
    scope: asset.visibility,
    visibility: asset.visibility,
    assetKind: asset.assetKind,
    role: asset.role,
    usageMode: asset.usageMode,
    name: asset.name,
    displayName: asset.displayName,
    intro: asset.intro,
    appearance: asset.appearance,
    ageValue: asset.ageValue,
    gender: asset.gender,
    heightCm: asset.heightCm,
    hairDescription: asset.hairDescription,
    outfitDescription: asset.outfitDescription,
    category: asset.category,
    styleTags: asset.styleTags,
    approved: asset.approved,
    reuseScope: asset.reuseScope,
    status: asset.status,
    // R183: originals are never a card/detail fallback. The legacy fields now
    // carry display-only renditions so old clients stay usable without learning
    // the source object URL.
    sourceFileUrl: null,
    storageUrl: display?.detail?.url ?? null,
    thumbnailUrl: display?.thumbnail?.url ?? null,
    currentMedia,
    mediaDisplay: displayData(display),
    imageStatus,
    metadata: {
      ...publicMetadata(asset.metadata),
      ...(primaryImage ? { primaryImage } : {}),
    },
    useCount: asset.useCount,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function assetImageStatus(
  displayMedia: AssetMediaWithRenditions | undefined,
  display: ReturnType<typeof buildAssetMediaDisplay>,
): "missing" | "unreadable" | "repairable" | "ready" {
  if (!isAssetImageMediaKind(displayMedia?.mediaKind)) return "missing";
  if (display?.thumbnail) return "ready";
  if (!displayMedia.storageBucket || !displayMedia.storagePath) return "unreadable";
  const sourceBlocked = displayMedia.displayRenditions?.some((rendition) =>
    rendition.status === "failed"
    && (
      rendition.errorCode === "source_object_missing"
      || rendition.errorCode === "source_object_unreadable"
    )
  );
  return sourceBlocked ? "unreadable" : "repairable";
}

export function toAssetMediaData(
  media: AssetMediaRow,
  ownerAssetId?: string,
  displaySource: AssetMediaWithRenditions | null = media as AssetMediaWithRenditions,
  displayOptions: Pick<AssetMediaDisplayInput, "displayBaseUrl" | "displayBucket"> = {},
): Record<string, unknown> {
  const display = displaySource ? mediaDisplay(displaySource, displayOptions) : null;
  const downloadAvailable = Boolean(media.storageBucket && media.storagePath && ownerAssetId);
  const playableOriginal = isPlayableOriginalMediaKind(media.mediaKind);
  return {
    id: media.id,
    assetEntityId: media.assetEntityId,
    assetVariantId: media.assetVariantId,
    mediaKind: media.mediaKind,
    viewAngle: media.viewAngle,
    title: media.title,
    description: media.description,
    storageBucket: null,
    storagePath: null,
    storageUrl: display?.detail?.url ?? null,
    sourceFileUrl: null,
    thumbnailUrl: display?.thumbnail?.url ?? null,
    downloadUrl: downloadAvailable && playableOriginal
      ? `/api/v1/assets/${ownerAssetId}/media/${media.id}/download`
      : null,
    mediaDisplay: displayData(display),
    original: {
      downloadAvailable,
      downloadEndpoint: downloadAvailable
        ? `/api/v1/assets/${ownerAssetId}/media/${media.id}/download-url`
        : null,
    },
    widthPx: media.widthPx,
    heightPx: media.heightPx,
    format: media.format,
    sha256: media.sha256,
    isPrimary: media.isPrimary,
    approved: media.approved,
    status: media.approved === false ? "pending" : "ready",
    sortOrder: media.sortOrder,
    metadata: publicMetadata(media.metadata),
    createdAt: media.createdAt,
  };
}

function isPlayableOriginalMediaKind(mediaKind: string | null): boolean {
  const normalized = mediaKind?.trim().toLowerCase() ?? "";
  return normalized === "video" || normalized === "audio";
}

function mediaDisplay(
  media: AssetMediaWithRenditions,
  displayOptions: Pick<AssetMediaDisplayInput, "displayBaseUrl" | "displayBucket"> = {},
) {
  return buildAssetMediaDisplay({
    sourceSha256: media.sha256,
    renditions: media.displayRenditions ?? [],
    ...displayOptions,
  });
}

function displayData(display: ReturnType<typeof buildAssetMediaDisplay>): Record<string, unknown> | null {
  if (!display) return null;
  return {
    thumbnail: displayVariantData(display.thumbnail),
    detail: displayVariantData(display.detail),
  };
}

function displayVariantData(
  display: AssetMediaDisplay | null,
): Record<string, unknown> | null {
  if (!display) return null;
  return {
    url: display.url,
    kind: display.kind,
    width: display.width,
    height: display.height,
    format: display.format,
  };
}

function publicMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactAssetStorageMetadata(value);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

function accessRecord(asset: AssetEntityRow): AssetAccessRecord {
  if (asset.visibility !== "personal" && asset.visibility !== "common") {
    throw new Error("Asset visibility is invalid");
  }
  return {
    id: asset.id,
    ownerUserId: asset.ownerUserId,
    visibility: asset.visibility,
    status: asset.status,
    deletedAt: asset.deletedAt,
  };
}
