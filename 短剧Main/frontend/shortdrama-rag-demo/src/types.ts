export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonRecord = { [key: string]: JsonValue };

export type AssetScope = "personal" | "common" | "project";

interface AssetListFilters {
  query?: string;
  assetKind?: string;
  status?: string;
  tag?: string;
  /** browse v1(R130):CSV 多值标签(同维度 OR);旧 tag 单值并存兼容。 */
  tags?: string;
  /** browse v1:细类(值取自数据)。 */
  category?: string;
  /** browse v1:媒体形态 image|model3d(EXISTS 筛选,不拆资产)。 */
  media?: string;
  /** browse v1:来源资产库(source_project_id)。 */
  source?: string;
  /** browse v1:角色因子,仅 assetKind=character 有效,值域引资产因子字典(仅覆盖已标注)。 */
  gender?: string;
  ageBand?: string;
  /** browse v1:排序 composite(默认)|newest,方向固定。 */
  sort?: string;
  page?: number;
  pageSize?: number;
}

export type AssetListInput = AssetListFilters & (
  | { scope: "personal" | "common"; projectId?: never }
  | { scope: "project"; projectId: string }
);

export interface User {
  id: string;
  username: string;
  display_name: string;
  /** 界面模式（红线 R2：users.ui_mode 是唯一事实源，GET /auth/me 随用户返回；禁 localStorage/URL/构建开关替代）。 */
  ui_mode: "lite" | "full";
}

/** GET /generations/in-flight 行(冻结信封,status 单轴;服务端已按等待最久优先排序)。 */
export interface GenerationInFlight {
  generation_request_id: string;
  current_attempt_id?: string | null;
  project_id: string;
  episode_id?: string | null;
  shot_id?: string | null;
  target_asset_entity_id?: string | null;
  media_kind: string;
  status: string;
  attempt_no?: number;
  model?: string | null;
  queue_position?: number | null;
  estimated_duration_seconds?: number | null;
  estimated_duration_sample_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** GET /generations/failed 行(P-10 失败区真源;合同 outputs/sol-failed-tasks-shape-20260803:
    每 request 只回最新 attempt 仍 failed 的行;ack 独立不因已读丢行;display_reason 直接上屏,
    failure_reason 原始审计值前端不上屏)。 */
export interface FailedGenerationTask {
  generation_request_id: string;
  current_attempt_id?: string | null;
  project_id: string;
  episode_id?: string | null;
  scene_id?: string | null;
  shot_id?: string | null;
  target_asset_entity_id?: string | null;
  media_kind: string;
  status: string;
  phase?: string | null;
  attempt_no?: number;
  model?: string | null;
  /** 服务端判定是否允许进入重试准备流程;不代表可自动付费重试。 */
  retryable?: boolean;
  error_code?: string | null;
  /** 中文安全展示文案(generationFailureDisplayReason 映射),直接上屏。 */
  display_reason?: string | null;
  created_at?: string | null;
  finished_at?: string | null;
  updated_at?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  status?: string | null;
  /** wire 真实字段（后端 toProject）。episode_count/asset_count 后端已补出（R147,
      原 Sol 缺口）；shot_count/metadata 后端仍无输出，前端无数据时不渲染对应 UI，不兜底 0。
      progress 后端同样无一等字段（S10 死声明清除，不再保留声明）。 */
  owner_user_id?: string | null;
  /** wire 真实字段（后端 toProject）：团队归属/题材/创建时间（运营底座 S12 起）。 */
  team_id?: string | null;
  genre?: string | null;
  created_at?: string | null;
  /** 旧读法（wire 已无此字段）；仅存留兼容本地 fixture，新代码一律用 owner_user_id。 */
  owner_id?: string | null;
  episode_count?: number;
  asset_count?: number;
  shot_count?: number;
  updated_at?: string | null;
  /** wire 真实字段（后端 toProject）：Lite 容器集指针，非空即 Lite 项目（A 方案，039 迁移起）。 */
  lite_episode_id?: string | null;
  metadata?: JsonRecord;
  /* #151 项目级生成配置（project.md §二/§四；后端 #149 接缝，未合入前 wire 无这些键）。
     画幅共用、清晰度图片/视频分开存（2026-08-06 裁决：两套刻度，不许互相映射）。 */
  aspect_ratio?: string | null;
  image_resolution?: string | null;
  video_resolution?: string | null;
  style_image_description?: string | null;
  style_image_reference_media_ids?: string[] | null;
  style_video_description?: string | null;
  style_video_reference_media_ids?: string[] | null;
  prompt_template_image?: string | null;
  prompt_template_video?: string | null;
}

export interface Asset {
  id: string;
  source_id?: string | null;
  asset_kind?: string | null;
  /** 控制职责六类（G1：character_identity/scene/prop/motion/camera_storyboard/style_env；后端迁移前可空）。 */
  role?: string | null;
  name?: string | null;
  display_name?: string | null;
  parent_entity_name?: string | null;
  intro?: string | null;
  appearance?: string | null;
  description?: string | null;
  usage_context?: string | null;
  visual_prompt?: string | null;
  source_file_url?: string | null;
  storage_url?: string | null;
  thumbnail_url?: string | null;
  /** Backend truth: no source, blocked source, auto-repairable display gap, or ready. */
  image_status?: "missing" | "unreadable" | "repairable" | "ready";
  scope?: AssetScope | string;
  status?: string | null;
  reuse_scope?: string | null;
  style_tags?: string[];
  /** browse v1(R130):细类(值取自数据,高级筛选下拉的选项来源)。 */
  category?: string | null;
  gender?: string | null;
  age_value?: number | null;
  use_count?: number;
  score?: number | null;
  project_id?: string;
  project_reference_id?: string;
  selected_variant_id?: string | null;
  selected_media_id?: string | null;
  selected_media?: MediaVersion | null;
  current_media?: MediaVersion | null;
  version_snapshot?: JsonRecord;
  referenced_at?: string;
  /** 后端 updatedAt 映射（资产库分拉合并时按它新→旧排序，与后端列表口径一致）。 */
  updated_at?: string | null;
  metadata?: JsonRecord;
}

export interface ProjectAssetRef {
  id: string;
  project_id?: string;
  asset_id?: string;
  asset_entity_id?: string;
  asset_media_id?: string | null;
  asset?: Asset;
  snapshot?: Asset;
  version_snapshot?: { entity?: Asset; media?: MediaVersion | null };
  created_at?: string;
}

export interface MediaVersion {
  id: string;
  asset_entity_id?: string | null;
  asset_variant_id?: string | null;
  media_kind?: string;
  /** v1.4（065）：视频版本号 = 同分镜 video 按 created_at 升序序号；图片为 null。 */
  version_no?: number | null;
  /** v1.4（065）：用户可改的版本标签（media_results.metadata.shot_version.label）。 */
  version_label?: string | null;
  /** v1.4（Lite 界面重做 §4.3.2）：版本备注（media_results.metadata.shot_version.note）。 */
  version_note?: string | null;
  /** v1.6.4(快乐马预览,设计 docs/design/happyhorse-preview-integration-2026-08-18.md §2.2):
      预览版身份标记(media_results.metadata.preview),版本条带「预览」徽记;无键=正式。 */
  preview?: boolean | null;
  /** v1.4：版本回溯入口——该版来源的 generation_request_id（素材库选用条目为 null）。 */
  generation_request_id?: string | null;
  /** 文件格式（jpg/png/webp/glb…）：引用选择器据此过滤出生成不可引用的 3D 资产。 */
  format?: string | null;
  /** 使用方式（G2：reference/first_frame/last_frame；缺省视为 reference）。 */
  usage_mode?: string | null;
  title?: string | null;
  description?: string | null;
  storage_url?: string | null;
  source_file_url?: string | null;
  thumbnail_url?: string | null;
  download_url?: string | null;
  is_primary?: boolean;
  persistence_status?: string | null;
  /** 视频时长秒（shot-media wire 透传 media_results.duration_seconds；产物面时间码用）。 */
  duration_seconds?: number | null;
  /** 供应商结果键（shot-media wire 透传：候选图='image-<i>'、视频任务副产物图行='last-frame-<i>'）。 */
  provider_result_key?: string | null;
  /* K2-A：产物审核状态（needs_review/accepted/rejected；后端 shot-media toShotMedia
     已在 wire 输出 review_status，本字段是唯一映射入口；rejected 不可设主版本）。 */
  review_status?: string | null;
  status?: string | null;
  created_at?: string | null;
  metadata?: JsonRecord;
}

export interface DashboardDataCounts {
  projects: number;
  assets: number;
  episodes: number;
  shots: number;
  images: number;
  videos: number;
  succeeded: number;
  failed: number;
}

export interface DashboardCostSummary {
  notice: string;
  total_tasks: number;
  succeeded_tasks: number;
  active_tasks: number;
  failed_tasks: number;
  image_estimated_cost_fen: number;
  video_estimated_cost_fen: number;
  total_estimated_cost_fen: number;
  by_project: Array<{
    project_id: string;
    project_name: string;
    tasks: number;
    succeeded: number;
    failed: number;
    estimated_cost_fen: number;
  }>;
  by_user: Array<{
    user_id: string;
    user_name: string;
    image_estimated_cost_fen: number;
    video_estimated_cost_fen: number;
    total_estimated_cost_fen: number;
  }>;
  by_date: Array<{
    date: string;
    tasks: number;
    estimated_cost_fen: number;
  }>;
}

export interface DashboardSummary {
  data: DashboardDataCounts;
  costs: DashboardCostSummary;
}

export interface ProjectCostAttempt {
  request_id: string;
  attempt_id: string;
  attempt_no: number;
  media_kind: "image" | "video" | string;
  provider: string;
  model: string;
  parameters: JsonRecord;
  quantity: number;
  status: string;
  estimated_cost_fen: number;
  actual_cost_fen: number | null;
  actual_cost_status: string;
  price_snapshot: JsonRecord;
  created_at: string;
  finished_at: string | null;
}

export interface ProjectCosts {
  project_id: string;
  project_name: string;
  notice: string;
  estimated_cost_fen: number;
  actual_cost_fen: number | null;
  attempts: ProjectCostAttempt[];
}

export interface TrashItem {
  id: string;
  kind: "project" | "asset";
  name: string;
  owner_user_id: string;
  deleted_at: string;
}

export interface DeliverableItem {
  project_id: string;
  project_name: string;
  episode_id: string;
  episode_no: number;
  shot_id: string;
  shot_code: string;
  shot_sort_order: number;
  media_id: string;
  media_kind: "image" | "video";
  storage_url: string;
  storage_path: string;
  mime_type: string | null;
  duration_seconds: number | null;
  generation_request_id: string;
  generation_attempt_id: string;
  provider: string;
  model: string;
  parameters: JsonRecord;
  estimated_cost_fen: number;
}

export interface DeliverableManifest {
  version: "v0.1";
  generated_at: string;
  project: { id: string; name: string };
  episode: { id: string; no: number };
  estimated_cost_fen: number;
  estimated_cost_notice: string;
  items: DeliverableItem[];
}

export interface EpisodePlayback extends DeliverableManifest {
  playback: DeliverableItem[];
}

/** 集状态真值域：与后端 episodes_status_check 约束（migrations/001_v01_core.sql）及
    production/routes.ts 的 zod enum 一致，只会出现 active/archived；
    旧 demo 的 imported/manual/draft 为死值，S10 起随值域收敛清除。 */
export type EpisodeStatus = "active" | "archived";

export interface Episode {
  id: string;
  project_id: string;
  episode_no: number;
  /** 后端 wire 只有 name（toEpisode）；旧 title 为死声明，S10 已删。 */
  name?: string | null;
  /** v1.4（065）：集级可编辑概要；空则前端回退最新剧本版本正文开头作占位。 */
  synopsis?: string | null;
  status?: EpisodeStatus | null;
  shot_count?: number;
  sort_order?: number;
}

export interface Scene {
  id: string;
  episode_id: string;
  name: string;
  sort_order?: number;
}

/* ---- 块 1 集视图:production-status 投影类型(sol SOL-P02B-BACKEND-DONE 冻结形状) ---- */
export type ProductionStatusCode =
  | "not_broken_down"
  | "broken_down"
  | "preparing"
  | "ready"
  | "generating"
  | "has_media"
  | "delivered";

export interface SceneProductionStatus {
  scene_id: string;
  episode_id: string;
  scene_no: number;
  name: string;
  sort_order: number;
  production_status: ProductionStatusCode;
  status_label: string;
  shot_summary: {
    total: number;
    control_package_started: number;
    ready: number;
    in_flight: number;
    with_primary_video: number;
    delivered: number;
  };
  control_package_summary: { filled_lane_count: number; enabled_lane_count: number };
  attempt_summary: { pending: number; running: number; queue_position: number | null };
  output_summary: { sample_primary_count: number; full_primary_count: number };
  cover_media: {
    media_result_id: string;
    production_mode: "full" | "sample";
    media_kind: string;
    storage_url: string;
    mime_type: string;
    created_at: string;
  } | null;
}

export interface EpisodeProductionStatus {
  schema_version: number;
  revision: string;
  episode_id: string;
  project_id: string;
  production_status: ProductionStatusCode;
  status_label: string;
  scene_count: number;
  delivered_scene_count: number;
  has_in_flight: boolean;
  next_scene_id: string | null;
  status_counts: Record<ProductionStatusCode, number>;
  scenes: SceneProductionStatus[];
}

export interface ShotBreakdownElements {
  subject: string | null;
  action: string | null;
  visual: string | null;
  camera_language: string | null;
}

/** v1.4（065）长尾字段的固定命名空间：氛围/结构化对白/提示词锁定。
    与后端 shots.metadata（ShotMetadata）镜像；只读写 `lite.shot` 键。 */
export interface ShotLiteMetadata {
  atmosphere?: string | null;
  /** 2026-08-18：Lite 详情「对白」输入框自由文本（与场景/时长同组），
      独立于结构化 dialogue.lines；后端 zod/合并已放开（065 命名空间）。 */
  dialogue_note?: string | null;
  dialogue?: {
    lines?: Array<{
      speaker: string;
      text: string;
      asset_entity_id?: string | null;
    }> | null;
  } | null;
  prompt_locked?: boolean | null;
}

export interface Shot {
  id: string;
  episode_id: string;
  scene_id?: string | null;
  shot_no: string;
  title?: string | null;
  script_text?: string | null;
  breakdown_elements?: ShotBreakdownElements | null;
  director_prompt?: string | null;
  image_prompt?: string | null;
  video_prompt?: string | null;
  /** P6（067）：skill 单次结构化拆镜全量；降级路径/旧分镜为 null。 */
  storyboard_detail?: ShotStoryboardDetail | null;
  duration_seconds?: number | null;
  sort_order?: number;
  /** v1.5.1（lite-assets 8.8 三路合同）：Lite 分镜引用真值——资产侧声明的只读投影。
      wire 由 toShot 原样透传（production/service.ts）；旧拆解快照无 variant_id，消费时跳过。 */
  reference_asset_snapshots?: ShotAssetSnapshot[] | null;
  /** v1.4（065）：长尾字段（氛围/对白/锁定），见 {@link ShotLiteMetadata}。 */
  metadata?: ShotLiteMetadata | null;
  /** 后端 toShot 不输出 status/image_status/video_status（死声明，S10 已删）；
      生成进度以 GenerationTask/selected_*_result_id 为准。 */
  selected_image_result_id?: string | null;
  selected_video_result_id?: string | null;
}


/** P6 storyboard_detail wire 形状（shots.storyboard_detail jsonb，迁移 067）。
    jsonb 原样透传；success() 递归 snake 化,与 Shot 域同口径全 snake_case。 */
export interface ShotStoryboardDetail {
  segment_title: string | null;
  shots: Array<{
    subject_action: string | null;
    physics_detail: string | null;
    camera_language: string | null;
    lighting: string | null;
  }>;
  lighting: string | null;
  sfx_layers: string[];
  dialogue: Array<{ speaker: string | null; text: string; lip_sync: boolean }>;
  asset_definitions: Array<{ kind: string; name: string }>;
  style: { art_style: string | null; color_tone: string | null; camera_strategy: string | null };
}
/** shots.reference_asset_snapshots 元素（v1.5.1 起为带变体的引用真值，合同见 lite-assets 8.8）。 */
export interface ShotAssetSnapshot {
  asset_entity_id: string;
  variant_id?: string | null;
  name: string;
  asset_kind?: string | null;
  matched_by?: "exact_name" | "manual" | string | null;
  status?: "bound" | "pending" | string | null;
  /** 读路径注入的展示主图 URL（v1.8，生产 toShot 按 asset_entity_id/variant_id 解析 asset_media）。 */
  image_url?: string | null;
  /** 读路径注入的变体展示名（生产 toShot 按 variant_id 解析 asset_variants.name；
      variant_id 为空即资产级引用，无此字段）。 */
  variant_name?: string | null;
}

/** 分镜-资产引用详情行（GET /shots/:shot_id/asset-refs wire 原样）。
    full/production 分镜台真值；**Lite 详情页不读不写**（v1.5.1，lite-assets 8.9）。 */
export interface ShotAssetRef {
  id: string;
  shot_id: string;
  asset_entity_id: string;
  asset_variant_id: string | null;
  asset_media_id: string | null;
  usage_mode: "reference" | "first_frame" | "last_frame" | null;
  enabled: boolean;
  sort_order: number;
  asset_name: string;
  asset_display_name: string | null;
  asset_role: string | null;
  asset_kind: string;
  variant_name: string | null;
  media_title: string | null;
  thumb_url: string | null;
  created_at: string;
  updated_at: string;
}

export type GenerationStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | string;

export interface MediaResult {
  id: string;
  media_kind: "image" | "video" | string;
  storage_url?: string | null;
  thumbnail_url?: string | null;
  download_url?: string | null;
  is_primary?: boolean;
  created_at?: string | null;
  /** 后端 generationData 透传的媒体格式（routes.ts media_results.mime_type）。 */
  mime_type?: string | null;
  /* generations wire 当前不输出本字段（列表只回 persisted 行，repository.persistedMedia）；
     类型留位做防御：一旦出现显式非 persisted 值，前端下载入口按「归档中」处理。 */
  persistence_status?: string | null;
}

export interface GenerationTask {
  generation_request_id: string;
  current_attempt_id?: string | null;
  status: GenerationStatus;
  /** #164:G10 镜头图片面板按媒体型过滤在途/失败任务(成功产物走 shot-media,在途/失败无产物行)。 */
  media_kind?: GenerationMediaKind;
  /** 提交时的提示词(wire 本就有;G10 失败卡「看看提示词」用)。 */
  prompt?: string;
  /** 服务端阶段（created/submitting/provider_queued/provider_running/provider_succeeded/persisting/complete）——阶段词展示用。 */
  phase?: string;
  attempt_no?: number;
  /** 提交档位（wire generationData tier_id；广场记录回显还原档位用，历史列表本就下发）。 */
  tier_id?: string | null;
  /** 提交参数快照（wire generationData parameters；广场记录回显展示比例/清晰度/时长）。 */
  parameters?: JsonRecord;
  /** 参考清单（wire generationData reference_manifest；广场记录回显还原变体勾选用）。 */
  reference_manifest?: Array<{ media_id?: string | null; kind?: string; role?: string }>;
  /** 多模型接缝(FABLE-007):用户端点不再下发 failure_reason/provider_task_id/真实 model;
      失败原因只读脱敏 display_reason,判定只读稳定 error_code。 */
  display_reason?: string | null;
  /** 服务端错误码（outcome-unknown 判定用：unknown=提交结果未知）。 */
  error_code?: string | null;
  estimated_cost_fen?: number | null;
  /** 任务归属（generationData 输出）：项目/集/镜；场景维度后端暂不输出，按 shot_id 归场。 */
  project_id?: string;
  episode_id?: string | null;
  shot_id?: string | null;
  /** 本地 worker 可领取队列顺位；null 不代表供应商队列位置。 */
  queue_position?: number | null;
  /** 真实历史样本不足时服务端明确返回 null，前端不得补默认分钟数。 */
  estimated_duration_seconds?: number | null;
  estimated_duration_sample_count?: number;
  media_results?: MediaResult[];
  created_at?: string;
  updated_at?: string;
}

/** 成功或确定失败生成任务的持久站内提醒；用户明确查看/知道后才会从未读列表移除。 */
export interface GenerationAttemptNotification {
  id: string;
  generation_request_id: string;
  attempt_id: string;
  project_id: string;
  episode_id?: string | null;
  shot_id?: string | null;
  target_asset_entity_id?: string | null;
  media_kind: GenerationMediaKind;
  status: Extract<GenerationStatus, "succeeded" | "failed">;
  display_reason?: string | null;
  created_at: string;
}

export interface GenerationAttemptNotificationList {
  items: GenerationAttemptNotification[];
  count: number;
}

/** S42: 图片上传入库的异步任务——提交即返回 202,服务端排队处理,关窗不丢任务。 */
export interface AssetUploadTask {
  id: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  original_file_name: string;
  asset_kind_hint?: string | null;
  /** 只对 queued 给值(与 worker 领取顺序一致);processing/终态为 null,前端不得编数字。 */
  queue_position?: number | null;
  /** 近 20 条成功任务耗时中位数;样本不足服务端给 null,前端不得补默认分钟数。 */
  estimated_duration_seconds?: number | null;
  estimated_duration_sample_count?: number;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  /** 公开业务文案；旧 error 审计字段不得直接上屏。 */
  display_reason?: string | null;
}

export interface AssetUploadTaskList {
  items: AssetUploadTask[];
  count: number;
}

export interface VideoIngestSubmission {
  assetId: string;
  mediaId: string;
  taskId: string;
  status: "queued" | "processing" | "succeeded" | "failed";
  storageBucket?: string;
  storagePath?: string;
  storageUrl?: string | null;
}

export const AUDIO_INGEST_CATEGORIES = ["音色", "背景音乐"] as const;
export type AudioIngestCategory = (typeof AUDIO_INGEST_CATEGORIES)[number];

export interface AudioIngestSubmission {
  assetId: string;
  mediaId: string;
  storageBucket: string;
  storagePath: string;
  storageUrl: string | null;
}

/** S42: 上传任务终态的持久站内提醒;用户明确确认后才从未读列表移除。 */
export interface AssetUploadNotification {
  id: string;
  status: "succeeded" | "failed";
  original_file_name: string;
  result_asset_entity_id?: string | null;
  result_asset_name?: string | null;
  error_message?: string | null;
  /** 公开业务文案；error_message 仅为一版过渡兼容。 */
  display_reason?: string | null;
  created_at: string;
  finished_at?: string | null;
}

export interface AssetUploadNotificationList {
  items: AssetUploadNotification[];
  count: number;
}

export type GenerationMediaKind = "image" | "video" | "audio";
export type GenerationQuoteAction = "submit" | "retry";
export type GenerationQuoteStatus = "pending_confirmation" | "confirmed" | "consumed";

export interface GenerationSubmissionInput {
  media_kind: GenerationMediaKind;
  project_id: string;
  episode_id?: string | null;
  scene_id?: string | null;
  shot_id?: string | null;
  target_asset_entity_id?: string | null;
  /** v1.9 十.10：从哪个变体发起生成，产物归属哪个变体（缺省回落第一变体）。 */
  target_asset_variant_id?: string | null;
  prompt: string;
  reference_media_ids: string[];
  parameters: JsonRecord;
  quantity: number;
  client_idempotency_key: string;
  /** #151：true = 这一次不带项目默认配置（风格描述/参考图/模板），只影响这一次。
      缺省/undefined = 带上。后端接缝见 #149（promptCompiler 项目级注入）。 */
  skip_project_defaults?: boolean;
  /** R223：本镜定稿图没存进资产库时后端默认挡住（不入库会导致人物跟定稿图对不上）。
      只在用户明确表示知情后才带上；类型只收 true，不留传 false 蒙混过关的口子。 */
  unregistered_final_image_confirmed?: true;
}

export interface GenerationQuote {
  generation_quote_id: string;
  source: "web" | "assistant" | "cli";
  action: GenerationQuoteAction;
  original_request_id?: string | null;
  status: GenerationQuoteStatus;
  estimated_cost_fen: number;
  currency: "CNY";
  expires_at: string;
  confirmed_at?: string | null;
  consumed_at?: string | null;
  generation_request_id?: string | null;
  generation_attempt_id?: string | null;
  /** 服务端判定超出管理员复核阈值时为 true；缺失表示额度内，可静默提交（合同缺口见交接回执）。 */
  requires_manual_review?: boolean;
  price_snapshot?: {
    pricing_rule_id?: string;
    media_kind?: GenerationMediaKind;
    billing_unit?: "request" | "image" | "second" | "ten_thousand_characters";
    unit_price_fen?: number;
    billable_units?: number;
    estimated_cost_fen?: number;
    full_estimated_cost_fen?: number;
    production_mode?: "full" | "sample";
    price_multiplier_bps?: 6000 | 10000;
    discount_numerator?: number;
    discount_denominator?: number;
    currency?: "CNY";
    pricing_basis?: JsonRecord;
  };
  notice?: string;
  media_kind?: GenerationMediaKind;
}

/** 候选值数据——后端 grill offer_candidates 路径发来的可选字段值。 */
export interface Candidate {
  label: string;
  description: string;
  value: string;
}

/** Grill Engine 询问结果——registration profile 引导收集 preferred_genre / user_role / preferred_tone。 */
export type GrillCheckResult =
  | { action: "execute" }
  | { action: "clarify"; question: string; targetField: string }
  | { action: "offer_candidates"; candidates: Candidate[]; targetField: string }
  | { action: "pending_confirmation"; summary: string; collectedFields: string[] };

export type AgentStreamEvent =
  | { type: "text_delta"; delta: string }
  /** 远程 runtime 的思考过程增量（W6-D 预留，渲染为可折叠「思考中」段）。 */
  | { type: "thinking_delta"; delta: string }
  | { type: "generation_quote"; quote: GenerationQuote }
  | { type: "tool_start"; tool_name: string }
  | { type: "tool_end"; tool_name: string; is_error: boolean }
  /** Grill Engine offer_candidates 路径：候选卡片渲染。 */
  | { type: "card_delta"; candidates: Candidate[] };

export interface StoryboardPreviewRow {
  source_sheet?: string | null;
  source_row?: number | null;
  episode_no?: number | null;
  scene_name?: string | null;
  shot_no?: string | number | null;
  sort_order?: number | null;
  screen_description?: string | null;
  camera_movement?: string | null;
  shot_size_angle?: string | null;
  dialogue?: string | null;
  sound_effect?: string | null;
  reference_image_note?: string | null;
  storyboard_image_note?: string | null;
  raw_fields?: Record<string, string>;
}

export interface StoryboardImportIssue {
  level: "warning" | "error";
  code?: string;
  message: string;
  source_row?: number;
}

export interface StoryboardImportPreviewData {
  rows: StoryboardPreviewRow[];
  issues: StoryboardImportIssue[];
  episode_count?: number;
  scene_count?: number;
  shot_count?: number;
  can_confirm: boolean;
}

export interface StoryboardImportRecord {
  id: string;
  project_id?: string;
  file_name?: string | null;
  status?: "previewed" | "confirmed" | "rejected" | string;
  /** K2O/GP-08：仅前端 demo 置位——标记这是示例预览数据，不是用户文件的解析结果；
      后端 wire 永不输出此字段。 */
  demo_sample?: boolean;
  preview: StoryboardImportPreviewData;
  confirmation_result?: {
    created_episode_ids?: string[];
    created_scene_ids?: string[];
    created_shot_ids?: string[];
    imported_shot_count?: number;
  } | null;
  confirmed_at?: string | null;
  created_at?: string;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  status?: "streaming" | "complete" | "failed";
  /** 远程 runtime 思考过程（W6-D）：随 thinking_delta 累积，渲染为可折叠段。 */
  thinking?: string;
  tool_name?: string | null;
  tool_result_summary?: JsonRecord | null;
  generation_quote?: GenerationQuote;
  created_at?: string;
}

export interface ListData<T> {
  items: T[];
  count: number;
  /** Count after every active filter; absent endpoints paginate by count. */
  filteredCount?: number;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
  kindCounts?: Record<string, number>;
}

/** 语义检索模式：hybrid=语义+结构化混合；structured_fallback=Milvus 不可用时的基础检索降级。 */
export type AssetSearchMode = "hybrid" | "structured_fallback";

export interface AssetSearchResult extends ListData<Asset> {
  mode?: AssetSearchMode;
  degraded_reason?: string;
}

/** S13：混合检索分页结果（POST /asset-search；hasMore 由服务端多取一条判断，前端切片退役）。 */
export interface AssetSearchPage extends ListData<Asset> {
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/* ---------- 批量估价（POST /api/v1/generations/batch-estimate） ---------- */

/** 批量清单的单项输入：在后端 batchEstimateItemSchema 基础上加客户端稳定句柄。 */
export interface BatchEstimateItemInput extends GenerationSubmissionInput {
  /** 客户端稳定句柄：逐项回显，批量清单保序（后端原样 echo 为 itemId）。 */
  item_id: string;
}

export type BatchEstimateAvailability = "available" | "invalid" | "unavailable" | "budget_blocked";

export interface BatchEstimateItem {
  itemId: string;
  availability: BatchEstimateAvailability;
  quote?: GenerationQuote;
  error?: { code?: string; message?: string };
}

export interface BatchEstimateResult {
  items: BatchEstimateItem[];
  count: number;
  available_count: number;
  unavailable_count: number;
  total_estimated_cost_fen: number;
  currency: "CNY";
  requires_manual_review: boolean;
  /** 恒为 false：估价只是看价；批量创建任务必须再逐项人工确认提交。 */
  creates_generation_tasks: boolean;
}

/* ---------- 批量人工授权（确认报价，再提交授权） ---------- */

export interface BatchSubmitItemInput {
  item_id: string;
  generation_quote_id: string;
}

export interface BatchSubmitInput {
  project_id: string;
  client_idempotency_key: string;
  expected_total_estimated_cost_fen: number;
  items: BatchSubmitItemInput[];
}

/**
 * 第一段人工确认的回执。authorization_id 代表服务端冻结并验证过的报价清单；
 * 后续提交只能携带它，不能由浏览器再次传递或篡改报价项。
 */
export interface BatchConfirmResult {
  authorization_id: string;
}

export type BatchSubmitItemStatus = "created" | "expired" | "price_changed" | "budget_blocked" | "quote_unavailable" | "failed";

export interface BatchSubmitItemResult {
  item_id: string;
  generation_quote_id: string;
  estimated_cost_fen: number;
  status: BatchSubmitItemStatus;
  generation_request_id?: string;
  generation_attempt_id?: string;
  error?: { code: string; message: string; retryable?: boolean };
  queue_position?: number;
  estimated_duration_seconds?: number;
}

export interface BatchSubmitResult {
  authorization_id: string;
  status: "completed" | "partial" | "failed";
  authorized_total_estimated_cost_fen: number;
  submitted_total_estimated_cost_fen: number;
  currency: "CNY";
  created_count: number;
  failed_count: number;
  items: BatchSubmitItemResult[];
  notice?: string;
}

/* ---------- 生成默认策略（GET/PUT /api/v1/projects/:id/generation-defaults） ---------- */

export type GenerationDefaultMode = "direct_reference" | "material_to_prompt" | "text_to_speech";

export interface GenerationDefaultStrategy {
  id: string;
  project_id: string;
  media_kind: GenerationMediaKind;
  mode: GenerationDefaultMode;
  model_key: string;
  parameters: JsonRecord;
  source_generation_request_id?: string | null;
  updated_by_user_id?: string;
  version: number;
  created_at?: string;
  updated_at?: string;
}

export interface PutGenerationDefaultInput {
  mode: GenerationDefaultMode;
  model_key: string;
  parameters: JsonRecord;
  source_generation_request_id?: string | null;
  expected_version: number;
}

/* ---------- Lite 提示词模板库（docs/design/prd-v2/lite-model-defaults.md §4.3） ----------
 * 只存用户自建模板；系统默认模板是代码常量（promptCompiler.ts），虚拟行不入库。
 * 生效 = 引用关系（strategy.parameters.prompt_template_id），软删后引用回落系统默认。 */

export interface PromptTemplate {
  id: string;
  project_id: string;
  media_kind: "image" | "video";
  name: string;
  content: string;
  created_by_user_id: string;
  deleted_by_user_id?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PromptTemplateInput {
  media_kind: "image" | "video";
  name: string;
  content: string;
}

/* ---------- Lite 项目风格库（docs/design/prd-v2/lite-config-tabs-and-style.md §4.4） ----------
 * 风格 = 一段 ≤5000 字的画面基调描述，可多条；每项目每媒介至多 1 个默认（服务端
 * project_styles_one_default_key 唯一索引兜底）。默认风格 = 行级永久锁定：不可编辑内容、
 * 不可取消默认、不可换设、不可删除（服务端 409；前端禁用只是快路径）。
 * 生成期：默认风格内容镜像写 projects.style* 列，服务端 resolveProjectGenerationConfig 注入。 */

export interface ProjectStyle {
  id: string;
  project_id: string;
  media_kind: "image" | "video";
  name: string;
  content: string;
  is_default: boolean;
  created_by_user_id: string;
  deleted_by_user_id?: string | null;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectStyleInput {
  media_kind: "image" | "video";
  name: string;
  content: string;
}

/* ---------- 资产审核域（/api/v1/projects/:id/review-policies、/reviews/*） ----------
 * wire 全 snake_case（后端 success() 对所有响应递归 toSnakeCaseJson，仓根 src/http/response.ts）；
 * 下列 camelCase 类型是前端规范形，由 api.ts 的 review*FromUnknown mapper 唯一归一；
 * 请求体仍按后端 zod 合同用 snake_case。 */

export type ReviewMediaKind = "image" | "video";
export type ReviewDefaultStrategy = "automatic" | "pending_review";
export type AssetReviewStatus = "automatic_review" | "pending_review" | "approved" | "rejected";
export type AssetReviewAction = "submitted" | "approved" | "rejected";

export interface ProjectReviewPolicy {
  /** null/version=0 表示安全默认（待审）尚未持久化。 */
  id: string | null;
  projectId: string;
  mediaKind: ReviewMediaKind;
  defaultStrategy: ReviewDefaultStrategy;
  /** 该媒体类型的指定审核人（项目成员）；null=只有 owner/平台 admin 能裁决。 */
  reviewerUserId?: string | null;
  updatedByUserId: string | null;
  /** 乐观锁版本号：PUT 时必须回传 expected_version。 */
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export type AssetReviewSubmitReason = "submitted" | "already_pending_review" | "already_approved" | "already_rejected";

/** 审核裁决请求体（snake_case，拒绝时 rejection_reason 必填）。 */
export interface ReviewDecision {
  action: "approve" | "reject";
  rejection_reason?: string;
}

export interface AssetReviewItem {
  assetId: string;
  status: AssetReviewStatus;
  changed: boolean;
  reason: AssetReviewSubmitReason;
  latestAction?: AssetReviewActionRecord;
}

export interface AssetReviewActionRecord {
  id: string;
  /** 公共采购库审核允许无项目上下文。 */
  projectId: string | null;
  assetId: string;
  action: AssetReviewAction;
  fromStatus: AssetReviewStatus;
  toStatus: AssetReviewStatus;
  reviewerUserId: string;
  reviewerDisplayName: string | null;
  rejectionReason: string | null;
  createdAt: string;
}

/* ---------- 参考测试域（/api/v1/projects/:id/reference-tests，板07） ----------
 * wire 同为 snake_case，由 api.ts 的 referenceTestFromUnknown / pageFromUnknown 等 mapper 归一为 camel；
 * 测试只记录配置，结果必须挂到正常生成链已持久化的产物上。 */

export type ReferenceTestMediaKind = "image" | "video";
export type ReferenceTestMode = "direct_reference" | "material_to_prompt";

export interface ReferenceTest {
  id: string;
  projectId: string;
  name: string;
  mediaKind: ReferenceTestMediaKind;
  mode: ReferenceTestMode;
  modelKey: string;
  prompt: string;
  parameters: JsonRecord;
  referenceMediaIds: string[];
  createdByUserId: string;
  /** 乐观锁版本号：PUT/DELETE 时必须回传 expected_version。 */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceTestResult {
  id: string;
  referenceTestId: string;
  generationRequestId: string;
  mediaResultId: string;
  mediaKind: ReferenceTestMediaKind;
  mode: ReferenceTestMode;
  modelKey: string;
  parameters: JsonRecord;
  createdByUserId: string;
  createdAt: string;
}

export interface ReferenceTestResultMediaSummary {
  storageUrl: string | null;
  persistenceStatus: string | null;
  mimeType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
}

/** 项目级结果流（板07「全部测试批次」）。 */
export interface ProjectReferenceTestResult extends ReferenceTestResult {
  referenceTestName: string;
  mediaResult: ReferenceTestResultMediaSummary | null;
}

export interface ReferenceTestInput {
  name: string;
  mediaKind: ReferenceTestMediaKind;
  mode: ReferenceTestMode;
  modelKey: string;
  prompt: string;
  parameters: JsonRecord;
  referenceMediaIds: string[];
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  hasNext: boolean;
}

/* ---------- JSON 资产入库（POST /api/v1/asset-ingest/json/assets） ---------- */

export interface JsonAssetIngestItem {
  asset_kind: string;
  name: string;
  display_name?: string | null;
  intro?: string | null;
  category?: string | null;
  style_tags?: string[];
  status?: string;
  reuse_scope?: string;
  source_file_url?: string | null;
  metadata?: JsonRecord;
}

/** 入库响应为 camelCase（IngestedAssetResponse）。 */
export interface IngestedAsset {
  id: string;
  assetKind: string;
  name: string;
  displayName?: string | null;
  sourceFileUrl?: string | null;
}

/** 选题雷达榜单条目与快照(契约 docs/contracts/v0.2.0/topic-radar.md;snake_case 原样透传)。 */
export interface TopicRadarItem {
  rank: number;
  title: string;
  /** 供应商原样热度串(如 "123.4w"),前端不做单位换算。 */
  heat: string;
  /** 外部链接;商用授权 pending 期间前端一律不导出打开;供应商可能不给,可缺省。 */
  link?: string;
}

export interface TopicRadarHot {
  items: TopicRadarItem[];
  /** 榜单所属日期;stale 时必须照实显示,不得伪装成当天。 */
  data_date: string;
  fetched_at: string;
  freshness: "fresh" | "stale";
  /** pending_vendor_written_approval 期间,展示位常驻「数据仅内部参考」。 */
  commercial_display_status: string;
}

/* ---------- Phase 3: 提示词预检 + 场景消耗汇总(snake_case 透传后端) ---------- */

export type PrecheckDimensionStatus = "good" | "ok" | "weak" | "missing";

export interface PromptDimensionScore {
  key: string;
  label: string;
  score: number;
  weight: number;
  status: PrecheckDimensionStatus;
  detail: string;
  suggestion?: string;
}

export interface PrecheckResult {
  overall_score: number;
  dimensions: PromptDimensionScore[];
  auto_prompt_preview: string;
  missing_references: string[];
  recommendations: string[];
  estimated_sampling_effect: {
    warning: boolean;
    message?: string;
  };
  precheck_id: string;
  created_at: string;
}

export interface SceneConsumptionBreakdownItem {
  kind: string;
  model: string;
  charged_points: number;
  request_count: number;
}

export interface SceneConsumptionSummary {
  total_cost_points: number;
  request_count: number;
  breakdown_by_kind: SceneConsumptionBreakdownItem[];
}
