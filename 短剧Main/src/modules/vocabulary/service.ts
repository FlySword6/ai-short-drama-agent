import { BadRequestError, ConflictError, NotFoundError, isPostgresUniqueViolation } from "../../shared/errors.js";
import type {
  AssetKindEntry,
  AssetKindResolver,
  AssetKindVocabularyRepository,
  AssetTagRepository,
  CreateAssetKindInput,
  CreateGenreSuggestionInput,
  CreateTagInput,
  CreateVocabularyEntryInput,
  GenreSuggestion,
  TagEntry,
  TagResolver,
  TagVocabularyRepository,
  VocabularyEntry,
  VocabularyRepository,
} from "./types.js";

/**
 * Thin vocabulary service: reads pass through; creates translate the primary
 * key race into a human-facing 409 instead of a raw 23505.
 */
export class VocabularyService {
  constructor(private readonly repository: VocabularyRepository) {}

  listReferenceLanes(): Promise<VocabularyEntry[]> {
    return this.repository.listReferenceLanes();
  }

  listAssetRoles(): Promise<VocabularyEntry[]> {
    return this.repository.listAssetRoles();
  }

  listGenres(): Promise<GenreSuggestion[]> {
    return this.repository.listGenres();
  }

  createReferenceLane(input: CreateVocabularyEntryInput): Promise<VocabularyEntry> {
    return this.create(() => this.repository.createReferenceLane(input));
  }

  createAssetRole(input: CreateVocabularyEntryInput): Promise<VocabularyEntry> {
    return this.create(() => this.repository.createAssetRole(input));
  }

  createGenre(input: CreateGenreSuggestionInput): Promise<GenreSuggestion> {
    return this.create(() => this.repository.createGenre(input));
  }

  /**
   * Login-writable genre ensure (S24): a user-typed custom genre is appended to
   * the shared suggestions. Idempotent — an existing id returns created:false;
   * a lost insert race re-reads and reports created:false as well.
   */
  async ensureGenre(id: string, createdBy?: string | null): Promise<{ entry: GenreSuggestion; created: boolean }> {
    const existing = (await this.repository.listGenres()).find((genre) => genre.id === id);
    if (existing) return { entry: existing, created: false };
    const nextSort = (await this.repository.listGenres())
      .reduce((max, genre) => Math.max(max, genre.sort), 0) + 1;
    try {
      const entry = await this.createGenre({ id, sort: nextSort, createdBy });
      return { entry, created: true };
    } catch (error) {
      if (error instanceof ConflictError) {
        const raced = (await this.repository.listGenres()).find((genre) => genre.id === id);
        if (raced) return { entry: raced, created: false };
      }
      throw error;
    }
  }

  private async create<T>(insert: () => Promise<T>): Promise<T> {
    try {
      return await insert();
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError("词条已存在");
      throw error;
    }
  }
}

/* ========================================================================
 * S41:标签与资产类型共用「自指 canonical」解析。纯函数单独导出,
 * 服务与资产过滤共用同一份语义,不拆两套判断。
 * ====================================================================== */

/**
 * 类型过滤展开:输入别名或规范词,返回应匹配的全部 kind id。
 * 未收录的输入原样返回(开放词表:词表是建议源,不是写入约束,
 * 生产里可能存在尚未登记的 kind,精确匹配仍然有效)。
 */
export function expandKindAliases(entries: AssetKindEntry[], input: string): string[] {
  const hit = entries.find((entry) => entry.active && entry.id === input);
  if (!hit) return [input];
  const ids = new Set<string>([hit.canonicalId]);
  for (const entry of entries) {
    if (entry.active && entry.canonicalId === hit.canonicalId) ids.add(entry.id);
  }
  return [...ids];
}

/** 标签解析:别名或规范词 → 规范词 id;未注册或已停用返回 null。 */
export function resolveTagCanonical(entries: TagEntry[], input: string): string | null {
  const hit = entries.find((entry) => entry.active && entry.id === input);
  return hit ? hit.canonicalId : null;
}

/**
 * 标签词表服务:登录即可 ensure 规范词(幂等),别名由管理员登记并做一跳校验。
 * 资产打标/摘标也走这里:写入层把别名一跳解析成规范词 id 后落库。
 */
export class TagVocabularyService implements TagResolver {
  constructor(
    private readonly tags: TagVocabularyRepository,
    private readonly links?: AssetTagRepository,
  ) {}

  listTags(): Promise<TagEntry[]> {
    return this.tags.listTags();
  }

  /** 登录可写:只建规范词(canonical 自指),已存在则原样返回。 */
  async ensureTag(
    id: string,
    options: { domain?: string; displayName?: string; sort?: number; createdBy?: string | null } = {},
  ): Promise<{ entry: TagEntry; created: boolean }> {
    const existing = await this.tags.findTag(id);
    if (existing) return { entry: existing, created: false };
    try {
      const entry = await this.createTag({
        id,
        canonicalId: id,
        domain: options.domain,
        displayName: options.displayName,
        sort: options.sort,
        createdBy: options.createdBy,
      });
      return { entry, created: true };
    } catch (error) {
      if (error instanceof ConflictError) {
        const raced = await this.tags.findTag(id);
        if (raced) return { entry: raced, created: false };
      }
      throw error;
    }
  }

  /** 管理员:可建规范词或别名。别名的目标必须本身是规范词(一跳,不做多级链)。 */
  async createTag(input: CreateTagInput): Promise<TagEntry> {
    if (input.canonicalId !== input.id) {
      const target = await this.tags.findTag(input.canonicalId);
      if (!target || !target.active) {
        throw new BadRequestError("别名要对应一个已登记的标准名称");
      }
      if (target.canonicalId !== target.id) {
        throw new BadRequestError("别名不能再指向别名，请直接选择标准名称");
      }
    }
    try {
      return await this.tags.createTag(input);
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError("词条已存在");
      throw error;
    }
  }

  async resolveTagId(input: string): Promise<string | null> {
    return resolveTagCanonical(await this.tags.listTags(), input);
  }

  async resolveTagIds(inputs: string[]): Promise<Array<string | null>> {
    const tags = await this.tags.listTags();
    return inputs.map((input) => resolveTagCanonical(tags, input));
  }

  listAssetTags(assetEntityId: string): Promise<TagEntry[]> {
    return this.requireLinks().listByAsset(assetEntityId);
  }

  /** 打标:未注册 404;别名一跳解析为规范词;重复打标幂等(created:false)。 */
  async attachTag(
    assetEntityId: string,
    tagIdOrAlias: string,
    createdBy?: string | null,
  ): Promise<{ tag: TagEntry; created: boolean }> {
    const entry = (await this.tags.listTags()).find((tag) => tag.active && tag.id === tagIdOrAlias);
    if (!entry) throw new NotFoundError("标签未注册,请先登记");
    const canonical = entry.canonicalId === entry.id
      ? entry
      : await this.tags.findTag(entry.canonicalId) ?? entry;
    const created = await this.requireLinks().attach({ assetEntityId, tagId: canonical.id, createdBy });
    return { tag: canonical, created };
  }

  /** 摘标:幂等。别名同样一跳解析;未注册视为已无关联,不报错。 */
  async detachTag(assetEntityId: string, tagIdOrAlias: string): Promise<void> {
    const canonicalId = await this.resolveTagId(tagIdOrAlias);
    if (!canonicalId) return;
    await this.requireLinks().detach(assetEntityId, canonicalId);
  }

  private requireLinks(): AssetTagRepository {
    if (!this.links) throw new Error("TagVocabularyService 未注入 AssetTagRepository");
    return this.links;
  }
}

/** 资产类型词表服务:读建议源 + 管理员登记 + 别名展开(assets 过滤消费的端口)。 */
export class AssetKindVocabularyService implements AssetKindResolver {
  constructor(private readonly kinds: AssetKindVocabularyRepository) {}

  listAssetKinds(): Promise<AssetKindEntry[]> {
    return this.kinds.listAssetKinds();
  }

  async createAssetKind(input: CreateAssetKindInput): Promise<AssetKindEntry> {
    if (input.canonicalId !== input.id) {
      const target = await this.kinds.findAssetKind(input.canonicalId);
      if (!target || !target.active) {
        throw new BadRequestError("别名要对应一个已登记的标准名称");
      }
      if (target.canonicalId !== target.id) {
        throw new BadRequestError("别名不能再指向别名，请直接选择标准名称");
      }
    }
    try {
      return await this.kinds.createAssetKind(input);
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError("词条已存在");
      throw error;
    }
  }

  async expandKinds(input: string): Promise<string[]> {
    return expandKindAliases(await this.kinds.listAssetKinds(), input);
  }
}
