/**
 * Creative vocabulary (migration 020): the readable/admin-editable registries
 * behind control-package lanes, asset roles, and project-genre suggestions.
 * See docs/design/creative-vocabulary-openness.md for the ruling record.
 */

export const VOCABULARY_DOMAINS = ["entity", "style", "media"] as const;

export type VocabularyDomain = (typeof VOCABULARY_DOMAINS)[number];

export interface LaneRecommendation {
  key: string;
  label: string;
  required: boolean;
}

export interface VocabularyEntry {
  id: string;
  displayName: string;
  domain: VocabularyDomain;
  pickKind: string | null;
  sort: number;
  active: boolean;
  /** 参考栏推荐工具项；仅参考栏词表持久化（023），资产身份词表恒为空数组。 */
  recommended: LaneRecommendation[];
}

export interface GenreSuggestion {
  id: string;
  sort: number;
  active: boolean;
}

export interface CreateVocabularyEntryInput {
  id: string;
  displayName: string;
  domain: VocabularyDomain;
  pickKind?: string | null;
  sort?: number;
  recommended?: LaneRecommendation[];
  createdBy?: string | null;
}

export interface CreateGenreSuggestionInput {
  id: string;
  sort?: number;
  createdBy?: string | null;
}

export interface VocabularyRepository {
  listReferenceLanes(): Promise<VocabularyEntry[]>;
  listAssetRoles(): Promise<VocabularyEntry[]>;
  listGenres(): Promise<GenreSuggestion[]>;
  createReferenceLane(input: CreateVocabularyEntryInput): Promise<VocabularyEntry>;
  createAssetRole(input: CreateVocabularyEntryInput): Promise<VocabularyEntry>;
  createGenre(input: CreateGenreSuggestionInput): Promise<GenreSuggestion>;
}

/* ========================================================================
 * S41 标签体系 + 资产类型别名(迁移 031):自指 canonical。
 * 别名和规范词同表,规范词自己指向自己;查询统一 resolve,不做多级链。
 * ====================================================================== */

export interface TagEntry {
  id: string;
  /** 规范词 = 自指;别名 = 指向规范词 id。 */
  canonicalId: string;
  /** 开放字符串(风格/情绪/题材……),不设枚举——域本身也是创作词汇。 */
  domain: string;
  displayName: string;
  sort: number;
  active: boolean;
}

export interface AssetKindEntry {
  id: string;
  canonicalId: string;
  displayName: string;
  sort: number;
  active: boolean;
}

export interface CreateTagInput {
  id: string;
  /** 规范词传自身 id;别名传目标规范词 id(服务层校验一跳)。 */
  canonicalId: string;
  domain?: string;
  /** 缺省 = id。 */
  displayName?: string;
  sort?: number;
  createdBy?: string | null;
}

export interface CreateAssetKindInput {
  id: string;
  canonicalId: string;
  displayName?: string;
  sort?: number;
  createdBy?: string | null;
}

export interface TagVocabularyRepository {
  listTags(): Promise<TagEntry[]>;
  findTag(id: string): Promise<TagEntry | null>;
  createTag(input: CreateTagInput): Promise<TagEntry>;
}

export interface AssetKindVocabularyRepository {
  listAssetKinds(): Promise<AssetKindEntry[]>;
  findAssetKind(id: string): Promise<AssetKindEntry | null>;
  createAssetKind(input: CreateAssetKindInput): Promise<AssetKindEntry>;
}

export interface AssetTagRepository {
  /** 资产身上的规范词条(关联行恒存规范词 id,这里 join 回词表取全貌)。 */
  listByAsset(assetEntityId: string): Promise<TagEntry[]>;
  /** 返回 true = 新建关联,false = 已存在(幂等)。tagId 必须已是规范词 id。 */
  attach(input: { assetEntityId: string; tagId: string; createdBy?: string | null }): Promise<boolean>;
  detach(assetEntityId: string, tagId: string): Promise<void>;
  /** 批量取资产的规范词 tagId 集合(项目范围过滤用)。 */
  listTagIdsByAssetIds(assetEntityIds: string[]): Promise<Map<string, Set<string>>>;
}

/** assets 模块消费标签解析的端口:输入别名或规范词,返回规范词 id;未注册返回 null。 */
export interface TagResolver {
  resolveTagId(input: string): Promise<string | null>;
  /** 列表筛选批量解析；实现方应尽量一次读取词表，避免每个 tag 一次往返。 */
  resolveTagIds?(inputs: string[]): Promise<Array<string | null>>;
}

/** assets 模块消费类型解析的端口:输入别名或规范词,返回应匹配的全部 kind id。 */
export interface AssetKindResolver {
  expandKinds(input: string): Promise<string[]>;
}
