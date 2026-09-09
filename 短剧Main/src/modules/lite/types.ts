import type { ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import type { CreateRunInput, CreateScriptVersionInput } from "../script-breakdown/service.js";
import type {
  AssetCandidates,
  ScriptBreakdownRunRecord,
  ScriptVersionRecord,
  ShotCandidate,
} from "../script-breakdown/types.js";

/**
 * Lite 界面模式 BFF 的领域类型。Lite 与完整版同库同事实源:本模块只做
 * 「项目 → 容器集(第 1 集) → 剧本两段式」的编排,不引入第二套写路径。
 */

export type LiteCreateOutcome = "created" | "existing";

/** Lite 集:项目下某一未软删的集(多集模式),与完整版共用 episodes 表。 */
export interface LiteContainerEpisode {
  id: string;
  projectId: string;
  episodeNo: number | null;
}

export interface SubmitLiteScriptInput {
  episodeId: string;
  rawText: string;
  clientIdempotencyKey: string;
}

export interface SubmitLiteScriptResult {
  episodeId: string;
  runId: string;
  /** 以 run 的建/查结果为准:重放同键拿到 existing 与同一 run。 */
  outcome: LiteCreateOutcome;
}

/** 整剧导入:每集一条建集+建剧本版本的结果。 */
export interface ImportedEpisodeResult {
  episodeId: string;
  episodeNo: number;
  scriptVersionId: string;
}

export interface ImportBulkScriptResult {
  episodes: ImportedEpisodeResult[];
  /** 本次导入覆盖(软删)掉的既有集数;0 表示项目原本是空的。 */
  replaced: number;
}

export interface LiteRepository {
  /** 确认集属于该项目且未软删(多集模式:由调用方传 episodeId);不存在返回 null。 */
  findEpisode(projectId: string, episodeId: string): Promise<LiteContainerEpisode | null>;
  /** 整剧导入:建集(与完整版 createEpisode 同表)。 */
  createEpisode(projectId: string, episodeNo: number, name: string, now: Date): Promise<string>;
  /**
   * 整剧导入的覆盖语义:软删项目下全部未软删的集(R1 特许的项目内可逆操作),
   * 返回被覆盖的集数。软删后同集号即可重建(episodes_project_number_active_unique
   * 只约束 deleted_at IS NULL 的行)。
   */
  softDeleteActiveEpisodes(projectId: string, actorId: string, now: Date): Promise<number>;
  /** 容器集下是否已有未软删成片(media_results 内连 shots 限定到集)。 */
  hasPersistedMedia(episodeId: string): Promise<boolean>;
  /** A 方案写回:projects.lite_episode_id 指向容器集(R1 特许的项目内写)。 */
  linkContainerEpisode(projectId: string, episodeId: string, now: Date): Promise<void>;
  /** 该集最新 status='confirmed' 拆解运行的资产候选草稿;没有 confirmed 运行返回 null。 */
  findLatestConfirmedRunAssetDraft(episodeId: string): Promise<LiteConfirmedRunAssetDraft | null>;
  /**
   * 候选幂等落资产(单事务):同项目下同类同名且未软删的资产(经 project_asset_refs
   * 内连 asset_entities)已存在则跳过;否则建 asset_entities 行 + project_asset_refs 行。
   * 重复调用不重复建行。
   *
   * v1.3:每次落库后确保资产有第一个变体(asset_variants 首行,variant_kind="look",
   * name=资产名,is_primary=true,sort_order=0);并对 confirmed run 的分镜候选做
   * backfill——按 (asset_entity_id, variant_id) 二元组写 metadata.lite.usages 与
   * shots.reference_asset_snapshots(matched_by="exact_name",幂等;manual 不被覆盖)。
   */
  materializeAssetCandidates(input: {
    projectId: string;
    actorId: string;
    /** 候选来源的 confirmed 运行 id,只进实体 metadata 做溯源。 */
    runId: string;
    candidates: LiteAssetCandidateInput[];
    /** 候选分镜,backfill 时按 source_candidate_id 反查真实 shot。 */
    shotCandidates: LiteShotCandidateInput[];
    /** 本集集号与集 id(usages 落 episode 维度)。 */
    episodeNo: number;
    episodeId: string;
    now: Date;
  }): Promise<LiteMaterializeAssetsResult>;
  /** 目标资产在本项目内的生成产物,media_results 未软删,按 created_at 倒序。 */
  listAssetMedia(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetMediaItem[]>;
  /**
   * 本项目已登记 active 的参考资产:refs 内连 entities(两侧未软删)→ 本项目
   * 生成产物(generation_requests.target_asset_entity_id + project_id 命中,
   * media_results 内连)→ seedance 登记(source_media_result_id 指 media_results,
   * 只认 status='active')→ 登记的 asset_media 行。一资产多条 active 登记时
   * 只回最新一条(按登记 updated_at)。
   */
  listReferenceAssets(input: { projectId: string }): Promise<LiteReferenceAssetItem[]>;
  /**
   * 素材列表页:按项目(+可选 kind)列资产实体(内连 project_asset_refs,两侧未软删)。
   * 返回列表项 + 按 asset_kind 聚合的全量 tab 计数(不受 kind 过滤影响)。
   */
  listAssets(input: { projectId: string; kind?: string }): Promise<LiteAssetListResult>;
  /** 资产详情:正式列 + metadata.lite 投影;未找到(跨项目/软删)返回 null。 */
  findAssetDetail(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetDetail | null>;
  /** 手动新建资产:建 asset_entities + project_asset_refs + 第一个变体,metadata.lite.usages 初始空数组。 */
  createAsset(input: {
    projectId: string;
    actorId: string;
    name: string;
    assetKind: string;
    intro: string | null;
    note: string | null;
    now: Date;
  }): Promise<{ assetEntityId: string; firstVariantId: string }>;
  /** 更新资产:只改 name/intro/metadata.lite.note,保留 metadata 其他命名空间。 */
  updateAsset(input: {
    projectId: string;
    assetEntityId: string;
    patch: LitePatchAssetInput;
    actorId: string;
    now: Date;
  }): Promise<void>;
  /** 资产变体列表(读 asset_variants,按 sort_order)。 */
  listAssetVariants(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetVariant[]>;
  /**
   * 版本图素材轨:合并上传图(asset_media)+ 生成图(media_results),按 createdAt DESC。
   * v1.3 渲染语义:无变体的生成图归属资产第一个变体;变体无主上传图时其最早生成图
   * 标记为有效主图(「落库绑定第一个变体 + AI 首图自动主图」过渡)。
   */
  listAssetVersionTrack(input: { projectId: string; assetEntityId: string }): Promise<LiteAssetVersionTrackItem[]>;
  /** 设主图(上传图):事务内原子翻转。冲突(主图已被他人改)返回 { conflict: true }。
      成功返回新主图 mediaId/mediaKind(供「成为主变体」自动登记判定)。 */
  setPrimaryMedia(input: {
    projectId: string;
    assetEntityId: string;
    targetMediaId: string;
  }): Promise<{ conflict: boolean; mediaId: string; mediaKind: string }>;
  /** 设主图(生成图):把 media_result 物化为 asset_media(id = media_result.id,命中版本轨去重契约)
      并原子翻转为主图;幂等(重复设同一张图只翻转,不重复建行)。 */
  setPrimaryMediaFromResult(input: {
    projectId: string;
    assetEntityId: string;
    targetMediaResultId: string;
  }): Promise<{ conflict: boolean; mediaId: string; mediaKind: string }>;
  /**
   * 关联分镜列表:读 metadata.lite.usages 展开为扁平条目(新 flat 格式 + 旧分组格式
   * 归一化),可选按 variant_id 过滤(bound 与 pending 都按此过滤)。
   */
  listAssetUsages(input: { projectId: string; assetEntityId: string; variantId?: string }): Promise<LiteAssetUsageEntry[]>;
  /** 按集号+分镜号+场景名查找 shot_id;优先 shots.sort_order(分镜号),回落 shot_code/title 数字。 */
  findShotByLabel(input: {
    projectId: string;
    episodeNo: number;
    shotNo: number;
    sceneName?: string;
  }): Promise<{ shotId: string } | null>;

  /**
   * 批量添加关联(单事务):items 支持 shot_id 或 (episode_no+shot_no) 两种寻址;
   * 命中真实分镜 → 落 bound 条目 + 回填 shots.reference_asset_snapshots(matched_by=manual,
   * 替换同 (asset, variant) 对的 manual/exact_name 快照);未命中(集未确认/镜号不存在)
   * → 落 status="pending" 待绑定条目(shot_id=null),不报错。variant_id 可选(不传=资产级)。
   * 返回 { added, pending }。
   */
  addAssetShotUsages(input: {
    projectId: string;
    assetEntityId: string;
    actorId: string;
    now: Date;
    items: LiteAddUsageItemInput[];
  }): Promise<{ added: number; pending: number }>;
  /**
   * 移除关联(按 usage_id):只删该条目;bound 时同时移除 shot 上 (asset_entity_id, variant_id)
   * 的快照(manual 与 exact_name 都删——用户显式移除)。
   */
  removeAssetShotUsage(input: {
    projectId: string;
    assetEntityId: string;
    usageId: string;
    now: Date;
  }): Promise<void>;
  /**
   * v1.7(八.10.4)分镜侧删除自动引用:移除 shot 上 (asset_entity_id, variant_id)
   * 的 exact_name 快照,并把该对追加进 shots.metadata.lite.removedAutoRefs(去重),
   * 使 materialize backfill A/B 两层重跑都不复活。shot 必须属于本项目且未软删。
   */
  removeShotAutoRef(input: {
    projectId: string;
    shotId: string;
    assetEntityId: string;
    variantId: string;
    actorId: string;
    now: Date;
  }): Promise<void>;
  /**
   * v1.7(八.10.4)解除抑制:从 shots.metadata.lite.removedAutoRefs 移除该对
   * (不存在时静默 no-op)。资产侧手动关联命中真实分镜后调用——用户显式恢复优先。
   */
  clearShotAutoRefSuppression(input: {
    projectId: string;
    shotId: string;
    assetEntityId: string;
    variantId: string;
    now: Date;
  }): Promise<void>;
  /**
   * v1.6 匹配建议的只读投影:本项目所有「已确认拆解集」的正式 shots 行
   * (episodes JOIN script_breakdown_runs status='confirmed'),带三要素
   * (集号/分镜号/场景名)与剧本单元(script_text / title / breakdown_elements)。
   * 未确认集不进入(问题八 8.2 范围)。
   */
  listShotsForMatchSuggest(input: { projectId: string }): Promise<LiteMatchSuggestShotRow[]>;
  /** 按真实 shot_id 回一条三要素(建议校验定位到真实分镜后补齐展示信息)。 */
  findShotSuggestInfo(input: { projectId: string; shotId: string }): Promise<LiteMatchSuggestShotRow | null>;
  /** 变体匹配档案:变体名/描述 + 所属资产名/类型/简介(拼模型上下文用)。 */
  findVariantForMatchSuggest(input: {
    projectId: string;
    assetEntityId: string;
    variantId: string;
  }): Promise<LiteVariantMatchProfile | null>;
  /**
   * v0.9 C 层(AI 自动挂):列本项目五类资产的全部活动变体档案(含第一变体),
   * 供一键生成后的 AI 语义匹配;跨项目/软删不出现。
   */
  listVariantsForAutoMatch(input: { projectId: string }): Promise<Array<LiteVariantMatchProfile & { variantId: string }>>;
  /**
   * v0.9 C 层写入:AI 语义匹配的出现记录(matched_by="ai_auto"),只写 usages 不写快照;
   * manual/exact_name/ai_auto 已有同 (shot, variant) 对不重复;抑制名单不复活。返回写入条数。
   */
  writeAiAutoUsages(input: {
    projectId: string;
    episodeId: string;
    episodeNo: number;
    writes: Array<{
      assetEntityId: string;
      variantId: string;
      shotId: string;
      shotNo: number;
      sceneName: string | null;
      sourceTextSnippets: string[];
    }>;
    now: Date;
  }): Promise<number>;
  /**
   * 删变体(软删):软删 asset_variants 行 + 其下 asset_media 行;清掉 metadata.lite.usages
   * 里引用该变体的条目 + 相关 shot 快照;若删的是主变体 → 晋升 sort_order 最小剩余变体为 is_primary。
   */
  /** v1.9 十.1 删资产(软删,级联变体/媒体/引用/快照)。 */
  deleteAsset(input: {
    projectId: string;
    assetEntityId: string;
    actorId: string;
    now: Date;
  }): Promise<void>;
  deleteAssetVariant(input: {
    projectId: string;
    assetEntityId: string;
    variantId: string;
    actorId: string;
    now: Date;
  }): Promise<void>;
  /**
   * 删媒体(软删,双 ID 空间):media_id 可为 asset_media.id 或 media_results.id;
   * 软删对应行;asset_media 为主图时同变体最早剩余图晋升主图。
   */
  deleteAssetMedia(input: {
    projectId: string;
    assetEntityId: string;
    mediaId: string;
    actorId: string;
    now: Date;
  }): Promise<void>;
}

export interface LiteAccessPort {
  require(actor: ProjectAccessActor, projectId: string, action: ProjectAccessAction): Promise<unknown>;
}

/** Lite 资产实体化:候选来源认 character/scene/prop/costume/audio 五类。 */
export type LiteAssetKind = "character" | "scene" | "prop" | "costume" | "audio";

/**
 * Lite 素材页 tab 可选的资产类型。除了五类可解析资产，还有三个纯上传参考通道。
 * tab 只是前端导航，分类唯一使用 asset_entities.asset_kind。
 */
export type LiteAssetTabKind = LiteAssetKind | "light_ref" | "photo_ref" | "video_ref";

/** 待落资产的一条候选(来自已确认拆解运行的 draft.assetCandidates)。 */
export interface LiteAssetCandidateInput {
  candidateId: string;
  assetKind: LiteAssetKind;
  name: string;
  description: string | null;
  /** v0.9：音频候选的五类分类(角色声音/旁白/音效/环境声/其他)；落 metadata.audio_kind。 */
  audioKind?: string | null;
}

/**
 * 分镜候选的轻量投影,供 materialize backfill 使用:按 (asset_kind, name) 与资产
 * 候选对拍,命中后经 source_candidate_id 反查真实 shots 行回填快照与证据。
 * audioNames(v0.9)= 阶段② assetDefinitions 中 kind=audio 的引用名(parse 已按
 * 资产库校验),只用于出现记录(usages),不进分镜四栏引用、不写生成快照。
 */
export interface LiteShotCandidateInput {
  candidateId: string;
  shotNo: number;
  lineIndices: number[];
  characterNames: string[];
  sceneNames: string[];
  propNames: string[];
  costumeNames: string[];
  audioNames: string[];
}

/**
 * 批量关联分镜的一条输入(路由层数组条目):shot_id 或 (episode_no+shot_no) 两种寻址
 * 二选一;variant_id 可选(不传 = 资产级关联,落 null)。
 */
export interface LiteAddUsageItemInput {
  shotId?: string;
  episodeNo?: number;
  shotNo?: number;
  sceneName?: string;
  variantId?: string;
}

/** 批量关联分镜的结果:added=命中真实分镜落 bound;pending=未命中落待绑定。 */
export interface LiteAddUsagesResult {
  added: number;
  pending: number;
}

export interface LiteMaterializedAsset {
  assetEntityId: string;
  assetKind: LiteAssetKind;
  name: string;
  /** created=本次新建实体+引用;existing=同项目同类同名已存在,幂等跳过。 */
  outcome: LiteCreateOutcome;
}

export interface LiteMaterializeAssetsResult {
  created: number;
  existed: number;
  assets: LiteMaterializedAsset[];
  /** v1.7 B 层(变体语义层)本次写入的变体关联条数。 */
  variantMatches: number;
  /** v1.7 B 层被整体跳过时的原因(异常兜底,不阻断 materialize);正常为 null。 */
  variantMatchSkipped: string | null;
  /** v0.9 C 层(AI 自动挂,用户拍板 2026-08-19):AI 语义匹配写入的出现记录条数。 */
  aiVariantMatches: number;
  /** v0.9 C 层被跳过/截断原因(无网关/无变体/超上限/异常);正常为 null。 */
  aiVariantMatchSkipped: string | null;
}

/** 容器集最新 confirmed 拆解运行里的资产候选草稿;无 confirmed 运行返回 null。 */
export interface LiteConfirmedRunAssetDraft {
  runId: string;
  assetCandidates: AssetCandidates | null;
  /** 候选分镜(v1.3 用于 backfill 时按 source_candidate_id 反查真实 shot)。 */
  shotCandidates: ShotCandidate[];
}

/** 资产候选图取数的输出项:目标资产的生成产物(media_results 内连 generation_requests)。 */
export interface LiteAssetMediaItem {
  id: string;
  mediaKind: string;
  storageUrl: string | null;
  persistenceStatus: string;
  reviewStatus: string;
  generationRequestId: string | null;
  widthPx: number | null;
  heightPx: number | null;
  createdAt: Date;
}

/**
 * 参考资产清单的输出项。asset_media_id 是 seedance 登记行认的媒体 id
 * (references 只认这个 id);storage_url 取登记对应的 asset_media 行;
 * registered_at 是登记行的 updated_at。
 */
export interface LiteReferenceAssetItem {
  assetEntityId: string;
  name: string;
  /** asset_entities.asset_kind 原值透传。 */
  kind: string;
  assetMediaId: string;
  storageUrl: string | null;
  registeredAt: Date;
}

/** 剧本两段式的窄口:由 ScriptBreakdownService 结构性满足,测试注入 fake。 */
export interface LiteScriptBreakdownPort {
  createScriptVersion(
    actor: ProjectAccessActor,
    episodeId: string,
    input: CreateScriptVersionInput,
  ): Promise<{ version: ScriptVersionRecord; outcome: LiteCreateOutcome }>;
  createRun(
    actor: ProjectAccessActor,
    episodeId: string,
    input: CreateRunInput,
  ): Promise<{ run: ScriptBreakdownRunRecord; outcome: LiteCreateOutcome }>;
  /** options.autoConfirm:一键生成本集默认采用(§2 P2)——拆解定稿后由服务续调确认。 */
  executeRun(runId: string, actorId: string, options?: { autoConfirm?: boolean }): Promise<void>;
}

/* ---------- 素材页资产 CRUD（第一阶段：列表 / 详情 / 手动新建 / 编辑） ---------- */

/** tab 聚合计数项。 */
export interface LiteAssetTabCount {
  kind: string;
  count: number;
}

/** 素材列表页单行：列表卡展示名称 + 一句话描述 + 主图，其余状态字段供详情页和分镜引用判断。 */
export interface LiteAssetListItem {
  assetEntityId: string;
  name: string;
  intro: string | null;
  assetKind: string;
  /** v0.9:音频五类分类(metadata.audio_kind);非音频资产恒 null。 */
  audioKind: string | null;
  /** 列表卡展示图:主图行的 storage_url,无 is_primary 主图时回落最新未软删图(上传/生成),与详情页封面同口径。 */
  primaryMediaUrl: string | null;
  hasMedia: boolean;
  hasPrimary: boolean;
  hasPendingGeneration: boolean;
  lastModifiedAt: Date;
}

export interface LiteAssetListResult {
  items: LiteAssetListItem[];
  /** 按 asset_kind 聚合的全量计数（不受 kind 过滤影响，供 tab bar 显示数量）。 */
  tabCounts: LiteAssetTabCount[];
}

/** 手动新建资产输入：名称必填，描述/备注可选，不关联 script_breakdown_runs。 */
export interface LiteCreateAssetInput {
  name: string;
  assetKind: string;
  intro: string | null;
  note: string | null;
}

/** 更新资产输入：所有字段可选，只改 name/intro/metadata.lite.note。 */
export interface LitePatchAssetInput {
  name?: string;
  intro?: string | null;
  note?: string | null;
}

/** 资产详情：列表字段 + 正式列 + metadata.lite 投影。 */
export interface LiteAssetDetail {
  assetEntityId: string;
  name: string;
  intro: string | null;
  assetKind: string;
  /** v0.9:音频五类分类(metadata.audio_kind);非音频资产恒 null。 */
  audioKind: string | null;
  /** 资产级备注，落 metadata.lite.note。 */
  note: string | null;
  hasMedia: boolean;
  hasPrimary: boolean;
  hasPendingGeneration: boolean;
  lastModifiedAt: Date;
  modifiedByUserId: string | null;
  /** 正式列角色属性（角色类型才有值）。 */
  gender: string | null;
  ageValue: number | null;
  appearance: string | null;
  hairDescription: string | null;
  outfitDescription: string | null;
  heightCm: number | null;
  /** metadata.lite 原值透传，详情页按需读取类型特有字段。 */
  metadataLite: Record<string, unknown> | null;
}

/* ---------- 素材页 Phase 2:变体 / 版本图轨 / 关联分镜 ---------- */

/** 资产变体(读 asset_variants 表)。 */
export interface LiteAssetVariant {
  variantId: string;
  variantKind: string;
  displayName: string;
  isPrimary: boolean;
  /** 变体首图(asset_media image,主图优先);无图 = null——弹窗变体行/已选行据此显图。 */
  imageUrl: string | null;
}

/** 版本图素材轨的一行(上传图 asset_media / 生成图 media_results 合并)。 */
export interface LiteAssetVersionTrackItem {
  /** 上传图有 asset_media_id;纯生成图可能为 null。 */
  assetMediaId: string | null;
  /** 生成图有 media_result_id;上传图为 null。 */
  mediaResultId: string | null;
  storageUrl: string | null;
  isPrimary: boolean;
  /** 来源:上传图 vs AI 生成。 */
  source: "upload" | "ai";
  /** 媒体类型(image/audio 等);audio 资产用媒体轨渲染,非图片不套 <img>。 */
  mediaKind: string | null;
  /** 文件格式(上传=asset_media.format,生成=media_results.mime_type 如 audio/mpeg)。 */
  format: string | null;
  widthPx: number | null;
  heightPx: number | null;
  createdAt: Date;
  /** 上传图归属的变体 ID;生成图为 null。 */
  variantId: string | null;
}

/**
 * 关联分镜的扁平条目(v1.3 变体级语义):
 * 新 flat 格式读 metadata.lite.usages;旧 {episode_id, shot_ids} 分组格式由读取端
 * 归一化为同形状(确定性 usage_id,status="bound",matched_by 按快照判定)。
 */
export interface LiteAssetUsageEntry {
  /** 稳定 ID,删除关联时用(旧格式条目为确定性派生 ID)。 */
  usageId: string;
  /** 关联的变体;资产级关联为 null。 */
  variantId: string | null;
  /** bound 必有真实分镜;pending 为 null(待绑定)。 */
  shotId: string | null;
  episodeId: string | null;
  episodeNo: number | null;
  shotNo: number | null;
  /** 分镜所在场景名(读 shots.scene_id → scenes.name)。 */
  sceneName: string | null;
  /** 分镜标题或 shot_code;pending 为空串。 */
  shotLabel: string;
  status: "bound" | "pending";
  /** manual=资产侧手动加;exact_name=脚本解析 backfill 自动匹配;ai_auto=v0.9 AI 语义自动挂。 */
  matchedBy: "manual" | "exact_name" | "ai_auto";
  /** 匹配证据(尽力回填;pending 可为空)。 */
  evidence: LiteAssetUsageEvidence;
}

/** 关联分镜的匹配证据(v1.3 T10.2:集/分镜/场景/证据落库)。 */
export interface LiteAssetUsageEvidence {
  sceneNames: string[];
  lineIndices: number[];
  sourceTextSnippets: string[];
}

/* ---------- v1.6:变体级动态匹配(问题八 8.2–8.9) ---------- */

/** 分镜投影:三要素 + 剧本单元,供匹配建议拼上下文与校验回补。 */
export interface LiteMatchSuggestShotRow {
  shotId: string;
  episodeId: string;
  episodeNo: number;
  shotNo: number;
  sceneName: string | null;
  title: string | null;
  scriptText: string | null;
  breakdownElements: Record<string, unknown> | null;
}

/** 变体匹配档案(只读):变体名/描述 + 所属资产档案。 */
export interface LiteVariantMatchProfile {
  variantName: string;
  variantDescription: string | null;
  assetEntityId: string;
  assetName: string;
  assetKind: string;
  assetIntro: string | null;
}

/** AI 匹配建议的一条(已校验):shot 定位 + 三要素 + 理由 + 冲突标注。 */
export interface LiteMatchSuggestItem {
  episodeNo: number;
  shotNo: number;
  sceneName: string | null;
  shotId: string;
  reason: string;
  /** 该 shot 已关联同资产其它变体时标注其变体名(勾选则并存,见问题八 8.2)。 */
  conflictVariantName: string | null;
}
