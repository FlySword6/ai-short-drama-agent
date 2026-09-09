import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetMediaRenditions,
  assetVariants,
  type AssetEntityRow,
  type AssetMediaRow,
} from "../../db/schema.js";
import {
  ProjectAssetRepository,
  type ProjectAssetReferenceRow,
} from "../project-assets/repository.js";
import type { AssetKindResolver, AssetTagRepository, TagResolver } from "../vocabulary/types.js";
import {
  identityAssetKindResolver,
  identityTagResolver,
  isDisplayOnlyPreview,
  resolveAssetMediaDisplaySource,
  toAssetData,
  toAssetMediaData,
  type AssetMediaWithRenditions,
} from "./catalog.js";
import { directorPreviewBinding } from "./directorPreviewBinding.js";
import { redactAssetStorageMetadata } from "./mediaDisplay.js";

export interface ProjectAssetScopeFilters {
  query?: string;
  assetKind?: string;
  status?: string;
  /** 标签 id 或别名,经词表解析为规范词后过滤。 */
  tag?: string;
}

export type ProjectAssetReferenceView = Pick<
  ProjectAssetReferenceRow,
  "id" | "projectId" | "assetEntityId" | "assetVariantId" | "assetMediaId" | "versionSnapshot" | "createdAt"
>;

export interface ProjectAssetReferenceReaderPort {
  list(
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): Promise<ProjectAssetReferenceView[]>;
}

export interface ProjectAssetViewBundle {
  assets: AssetEntityRow[];
  mediaByAssetId: Map<string, AssetMediaWithRenditions[]>;
  /** Active variant -> entity ownership, used to validate display bindings. */
  variantOwners?: ReadonlyMap<string, string>;
}

export interface ProjectAssetViewOptions {
  /** See `ProjectAssetViewReaderPort.loadVisible` for the security boundary. */
  allowReferencedPersonalAssets?: boolean;
  /**
   * The exact active project-reference locks. A personal asset owned by
   * someone else must not expose media outside its locked media/variant. A
   * null media and variant is the explicit legacy "share this whole asset"
   * form created by an owner.
   */
  referenceLocksByAssetId?: ReadonlyMap<
    string,
    Pick<ProjectAssetReferenceView, "assetVariantId" | "assetMediaId">
  >;
}

export interface ProjectAssetViewReaderPort {
  /**
   * When true, `assetIds` came exclusively from active project_asset_refs
   * after ProjectAccessService has authorized that exact project. It permits
   * project members to read a collaborator's personal asset only through its
   * already-established project reference; it never widens the global asset
   * catalog or direct asset routes.
   */
  loadVisible(
    actorId: string,
    assetIds: string[],
    options?: ProjectAssetViewOptions,
  ): Promise<ProjectAssetViewBundle>;
}

export interface ProjectAssetCatalogDependencies {
  references?: ProjectAssetReferenceReaderPort;
  views?: ProjectAssetViewReaderPort;
  /** 词表端口:缺省 identity(精确匹配、不触库);只在 HTTP 路由层接词表。 */
  kinds?: AssetKindResolver;
  tags?: TagResolver;
  tagLinks?: Pick<AssetTagRepository, "listTagIdsByAssetIds">;
}

export class ProjectAssetCatalogService {
  private readonly references: ProjectAssetReferenceReaderPort;
  private readonly views: ProjectAssetViewReaderPort;
  private readonly kinds: AssetKindResolver;
  private readonly tags: TagResolver;
  private readonly tagLinks: Pick<AssetTagRepository, "listTagIdsByAssetIds">;

  constructor(db: Database, dependencies: ProjectAssetCatalogDependencies = {}) {
    this.references = dependencies.references ?? new ProjectAssetRepository(db);
    this.views = dependencies.views ?? new DrizzleProjectAssetViewReader(db);
    this.kinds = dependencies.kinds ?? identityAssetKindResolver;
    this.tags = dependencies.tags ?? identityTagResolver;
    this.tagLinks = dependencies.tagLinks ?? { listTagIdsByAssetIds: async () => new Map() };
  }

  async list(
    actorId: string,
    projectId: string,
    filters: ProjectAssetScopeFilters = {},
    authorizedProjectId?: string,
  ): Promise<Record<string, unknown>[]> {
    // ProjectAssetRepository.list validates the route-issued project
    // capability before returning reference IDs. Read references first so a
    // private asset can only be seen through an existing active reference.
    const references = await this.references.list(actorId, projectId, authorizedProjectId);
    if (!references.length) return [];
    const bundle = await this.views.loadVisible(
      actorId,
      references.map((item) => item.assetEntityId),
      {
        allowReferencedPersonalAssets: authorizedProjectId === projectId,
        referenceLocksByAssetId: new Map(references.map((item) => [item.assetEntityId, item])),
      },
    );
    const assets = new Map(bundle.assets.map((asset) => [asset.id, asset]));

    // 词表解析只在带对应过滤时发生一次;identity 端口下零额外开销。
    const expandedKinds = filters.assetKind
      ? new Set(await this.kinds.expandKinds(filters.assetKind))
      : undefined;
    const tagId = filters.tag ? await this.tags.resolveTagId(filters.tag) : undefined;
    // 未注册/已停用的标签不可能有命中,与全局目录同一短路口径。
    if (filters.tag && !tagId) return [];
    const tagIdsByAsset = tagId
      ? await this.tagLinks.listTagIdsByAssetIds([...assets.keys()])
      : undefined;

    return references.flatMap((reference) => {
      const asset = assets.get(reference.assetEntityId);
      if (
        !asset
        || (asset.visibility === "common" && asset.status !== "approved")
        || !matchesFilters(asset, filters, {
          kinds: expandedKinds,
          ...(tagId ? { tagId, tagIds: tagIdsByAsset?.get(asset.id) } : {}),
        })
      ) return [];
      const media = bundle.mediaByAssetId.get(asset.id) ?? [];
      const selected = reference.assetMediaId
        ? media.find((item) => item.id === reference.assetMediaId)
        : undefined;
      const current = selected ?? media.find((item) => item.isPrimary) ?? media[0];
      const display = current
        ? resolveAssetMediaDisplaySource(current, media, bundle.variantOwners)
        : null;

      return [{
        ...toAssetData(asset, display ?? undefined),
        scope: "project",
        projectId,
        projectReferenceId: reference.id,
        selectedVariantId: reference.assetVariantId,
        selectedMediaId: reference.assetMediaId,
        selectedMedia: selected
          ? toAssetMediaData(selected, asset.id, resolveAssetMediaDisplaySource(selected, media, bundle.variantOwners))
          : null,
        currentMedia: current
          ? toAssetMediaData(current, asset.id, resolveAssetMediaDisplaySource(current, media, bundle.variantOwners))
          : null,
        versionSnapshot: publicVersionSnapshot(reference.versionSnapshot),
        referencedAt: reference.createdAt,
      }];
    });
  }
}

export class DrizzleProjectAssetViewReader implements ProjectAssetViewReaderPort {
  constructor(private readonly db: Database) {}

  async loadVisible(
    actorId: string,
    assetIds: string[],
    options: ProjectAssetViewOptions = {},
  ): Promise<ProjectAssetViewBundle> {
    const uniqueIds = [...new Set(assetIds)];
    if (!uniqueIds.length) return { assets: [], mediaByAssetId: new Map() };

    const assets = await this.db.select().from(assetEntities).where(and(
      inArray(assetEntities.id, uniqueIds),
      isNull(assetEntities.deletedAt),
      or(
        and(
          eq(assetEntities.visibility, "common"),
          eq(assetEntities.status, "approved"),
        ),
        ...(options.allowReferencedPersonalAssets
          ? [eq(assetEntities.visibility, "personal")]
          : []),
        and(eq(assetEntities.visibility, "personal"), eq(assetEntities.ownerUserId, actorId)),
      ),
    ));
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const visibleIds = assets.map((asset) => asset.id);
    if (!visibleIds.length) return { assets, mediaByAssetId: new Map() };

    const variants = await this.db.select({ id: assetVariants.id, assetEntityId: assetVariants.assetEntityId })
      .from(assetVariants)
      .where(and(inArray(assetVariants.assetEntityId, visibleIds), isNull(assetVariants.deletedAt)));
    const variantOwners = new Map(variants.map((variant) => [variant.id, variant.assetEntityId]));
    const media = await this.db.select().from(assetMedia).where(and(
      isNull(assetMedia.deletedAt),
      eq(assetMedia.approved, true),
      or(
        inArray(assetMedia.assetEntityId, visibleIds),
        ...(variants.length ? [inArray(assetMedia.assetVariantId, variants.map((item) => item.id))] : []),
      ),
    )).orderBy(desc(assetMedia.isPrimary), asc(assetMedia.sortOrder), asc(assetMedia.createdAt));

    const rawById = new Map(media.map((item) => [item.id, item]));
    const visibleMedia: AssetMediaRow[] = [];
    for (const item of media) {
      const assetId = resolveActiveAssetMediaOwner(item, variantOwners);
      if (!assetId) continue;
      const owner = assetsById.get(assetId);
      if (!owner) continue;
      if (owner.visibility === "personal" && owner.ownerUserId !== actorId) {
        const lock = options.referenceLocksByAssetId?.get(assetId);
        // The entity was reachable only through a project ref, so never turn
        // that fact into broad access to a collaborator's unselected media.
        if (!isProjectReferenceMediaAllowed(lock, item, rawById, variantOwners, assetId)) continue;
      }
      visibleMedia.push(item);
    }
    const renditionRows = visibleMedia.length
      ? await this.db.select().from(assetMediaRenditions).where(
          inArray(assetMediaRenditions.assetMediaId, visibleMedia.map((item) => item.id)),
        )
      : [];
    const renditionsByMedia = new Map<string, typeof renditionRows>();
    for (const rendition of renditionRows) {
      const values = renditionsByMedia.get(rendition.assetMediaId) ?? [];
      values.push(rendition);
      renditionsByMedia.set(rendition.assetMediaId, values);
    }
    const mediaByAssetId = new Map<string, AssetMediaWithRenditions[]>();
    for (const item of visibleMedia) {
      const assetId = resolveActiveAssetMediaOwner(item, variantOwners);
      if (!assetId) continue;
      const values = mediaByAssetId.get(assetId) ?? [];
      values.push({ ...item, displayRenditions: renditionsByMedia.get(item.id) ?? [] });
      mediaByAssetId.set(assetId, values);
    }
    return { assets, mediaByAssetId, variantOwners };
  }
}

/**
 * A non-owner member can see a personal asset only via the exact project
 * reference. Legacy entity-only references intentionally share that entity's
 * media; a locked media or variant narrows the visible subset.
 */
export function isProjectReferenceMediaAllowed(
  lock: Pick<ProjectAssetReferenceView, "assetVariantId" | "assetMediaId"> | undefined,
  media: Pick<
    AssetMediaRow,
    "id" | "assetEntityId" | "assetVariantId" | "sha256" | "metadata" | "approved" | "deletedAt"
  >,
  mediaById: ReadonlyMap<string, AssetMediaRow> = new Map(),
  variantOwners: ReadonlyMap<string, string> = new Map(),
  expectedAssetId?: string,
): boolean {
  if (!lock || !isApprovedActiveMedia(media)) return false;
  const mediaOwner = resolveActiveAssetMediaOwner(media, variantOwners);
  if (!mediaOwner || (expectedAssetId && mediaOwner !== expectedAssetId)) return false;
  if (lock.assetMediaId) {
    if (lock.assetMediaId === media.id) {
      return media.assetVariantId === lock.assetVariantId;
    }
    const source = mediaById.get(lock.assetMediaId);
    if (
      !source
      || !isApprovedActiveMedia(source)
      || resolveActiveAssetMediaOwner(source, variantOwners) !== mediaOwner
      || source.assetVariantId !== lock.assetVariantId
    ) return false;
    const previewBinding = directorPreviewBinding(media.metadata);
    return Boolean(
      isDisplayOnlyPreview(media)
      && previewBinding?.sourceMediaId === source.id
      && previewBinding.sourceSha256 === source.sha256
      && media.assetVariantId === source.assetVariantId
      && resolveActiveAssetMediaOwner(media, variantOwners) === mediaOwner,
    );
  }
  if (lock.assetVariantId) {
    return lock.assetVariantId === media.assetVariantId;
  }
  return true;
}

function isApprovedActiveMedia(
  media: Pick<AssetMediaRow, "approved" | "deletedAt">,
): boolean {
  return media.approved === true && media.deletedAt === null;
}

/** A variant must be active and agree with any direct entity declaration. */
function resolveActiveAssetMediaOwner(
  media: Pick<AssetMediaRow, "assetEntityId" | "assetVariantId">,
  variantOwners: ReadonlyMap<string, string>,
): string | undefined {
  if (!media.assetVariantId) return media.assetEntityId ?? undefined;
  const variantOwner = variantOwners.get(media.assetVariantId);
  if (!variantOwner || (media.assetEntityId && media.assetEntityId !== variantOwner)) return undefined;
  return variantOwner;
}

function publicVersionSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactAssetStorageMetadata(value);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

interface ResolvedScopeFilters {
  /** assetKind 过滤的别名展开结果;缺省 = 精确匹配。 */
  kinds?: Set<string>;
  /** tag 过滤解析出的规范词 id,与当前资产持有的规范词集合。 */
  tagId?: string;
  tagIds?: Set<string>;
}

function matchesFilters(
  asset: AssetEntityRow,
  filters: ProjectAssetScopeFilters,
  resolved: ResolvedScopeFilters = {},
): boolean {
  if (filters.assetKind) {
    const matched = resolved.kinds
      ? resolved.kinds.has(asset.assetKind)
      : asset.assetKind === filters.assetKind;
    if (!matched) return false;
  }
  if (filters.status && asset.status !== filters.status) return false;
  if (resolved.tagId && !resolved.tagIds?.has(resolved.tagId)) return false;
  if (!filters.query) return true;
  const query = filters.query.toLocaleLowerCase();
  return [asset.name, asset.displayName, asset.intro]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLocaleLowerCase().includes(query));
}
