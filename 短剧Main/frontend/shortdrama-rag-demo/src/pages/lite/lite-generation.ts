/* ============================================================
   lite-generation.ts — Lite 分镜「生成链路」共享模块（v1.4 拆出）

   纯搬运自 lite-shots-page.tsx（签名/行为一字不改）：轮询节奏与状态机、
   sessionStorage 幂等键台账、档反查、分镜媒体与候选/视频/定稿推导、
   生视频 references 组装。列表页与详情页共用，避免两处各写一套。

   口径锁定（docs/design/prd-v2/lite.md）：
   - 生视频 = 全能参考：定稿图（登记产物）排首位 + 勾选参考素材，全部
     usage_mode="reference" 同槽进请求；旧的锚定用途字段与接力方案整条删除，
     lite 目录源码 grep 无 旧锚定关键词 字样。
   - 轮询规范（计划 §5.2②）：起始 3s、指数退避 15s 封顶、单任务 30 分钟总上限
     （超时提示不自动重发）、document.hidden 暂停 + visibilitychange 恢复即查。
   ============================================================ */
import { ApiClientError, api, type TieredGenerationSubmissionInput } from "../../api";
import { activeTiers, demoEstimatePoints, isPreviewTier, listCapabilityTiers, type CapabilityTier } from "../../capability-tiers";
import { tierDimensionValue } from "../../generation-dimensions";
import type { GenerationDefaultStrategy, GenerationMediaKind, GenerationTask, MediaVersion, PromptTemplate, Shot } from "../../types";
import { humanErrorMessage } from "../batch-generate-drawer";

/* ---------- 轮询与配置常量 ---------- */

/** 轮询节奏（计划 §5.2②）：起始 3s，指数退避到 15s 上限，单任务 30 分钟总上限。 */
export const POLL_BASE_MS = 3000;
export const POLL_MAX_MS = 15_000;
export const POLL_TOTAL_CAP_MS = 30 * 60 * 1000;
/** 连续轮询失败达到该次数后在卡片上提示「状态可能偏旧」（照 workbench 5 次口径）。 */
export const POLL_FAILURE_NOTICE_THRESHOLD = 5;

export const ACTIVE_GENERATION_STATUSES: ReadonlyArray<string> = ["pending", "running"];

/** 参考素材提交被供应商 422 拒绝时的人话（「图片N」指代修复 ee2a085f 已随主线合入；
    仍触发说明是平台侧新口径，提示语不给假动作）。 */
export const LITE_REFERENCE_REJECT_MESSAGE = "参考素材提交被模型拒绝（参数校验未过）：请调整参考素材后重试；反复出现请联系管理员";

/* ---------- Lite 提交体（后端 zod 形状） ---------- */

/** 控制资产引用项（routes.ts:117-120 generationInputShape.references 的合法 usage_mode
    有 reference 等三种；全能参考口径下只发 reference——一切参考素材同槽同身份）。 */
export interface LiteReferenceInput {
  media_id: string;
  usage_mode: "reference";
}

/**
 * Lite 提交体 = 后端 generationInputShape 的两段式子集：不带 prompt（人工全段）与
 * reference_media_ids（旧版字段），只发 supplement_prompt / references。
 * 前端共享类型 GenerationSubmissionInput 把 prompt/reference_media_ids 标成必填，
 * 是完整版「人工确认全段」流程的旧约束；把它们改成可选会连带改动完整版页面与测试，
 * 故按后端合同另立形状，调用 quoteGeneration/createGeneration 处一次性窄断言
 * （两个方法只做 JSON 透传，运行时即后端期望的 wire 形状）。
 */
export type LiteSubmissionInput = Omit<TieredGenerationSubmissionInput, "prompt" | "reference_media_ids"> & {
  supplement_prompt?: string;
  references?: LiteReferenceInput[];
};

/* ---------- sessionStorage 幂等键台账（lite-gen:{shotId}:{kind} → { key, requestId? }） ---------- */

export const LITE_GEN_MARKER_PREFIX = "lite-gen:";

export interface LiteGenMarker {
  key: string;
  requestId?: string;
}

export function liteGenMarkerKey(shotId: string, kind: GenerationMediaKind): string {
  return `${LITE_GEN_MARKER_PREFIX}${shotId}:${kind}`;
}

/** 提交前落键（计划 §5.2③）；requestId 在 createGeneration 返回后补写同一位置。 */
export function rememberLiteGenMarker(storage: Storage, shotId: string, kind: GenerationMediaKind, marker: LiteGenMarker): void {
  storage.setItem(liteGenMarkerKey(shotId, kind), JSON.stringify(marker));
}

export function forgetLiteGenMarker(storage: Storage, shotId: string, kind: GenerationMediaKind): void {
  storage.removeItem(liteGenMarkerKey(shotId, kind));
}

/** 扫描本标签页的 Lite 幂等键台账（恢复用）；脏行跳过不放大。 */
export function readLiteGenMarkers(storage: Storage): Array<{ shotId: string; kind: GenerationMediaKind; marker: LiteGenMarker }> {
  const found: Array<{ shotId: string; kind: GenerationMediaKind; marker: LiteGenMarker }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const storageKey = storage.key(index);
    if (!storageKey || !storageKey.startsWith(LITE_GEN_MARKER_PREFIX)) continue;
    const rest = storageKey.slice(LITE_GEN_MARKER_PREFIX.length);
    const separator = rest.lastIndexOf(":");
    if (separator <= 0) continue;
    const shotId = rest.slice(0, separator);
    const kind = rest.slice(separator + 1);
    if (kind !== "image" && kind !== "video") continue;
    try {
      const parsed = JSON.parse(storage.getItem(storageKey) ?? "") as Partial<LiteGenMarker> | null;
      if (typeof parsed?.key !== "string" || parsed.key.length < 8) continue;
      found.push({
        shotId,
        kind,
        marker: { key: parsed.key, ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}) },
      });
    } catch {
      /* 单行损坏不影响其它行的恢复 */
    }
  }
  return found;
}

/* ---------- 预览视频身份台账（2026-08-19） ----------
   预览弹窗提交的生成请求 id 记入本镜预览集；主区版本列表据此排除预览版（预览只
   在弹窗展示，不进版本条/播放器），弹窗用 previewVideos 单独展示。
   与幂等键台账同用 sessionStorage：生命周期内跨导航保留；关标签页后预览版会以
   普通版本形态回到主区（后端 metadata.preview 未落标记时的兜底语义，见
   lite-shot-detail-page.tsx 页头注释）。 */
const LITE_PREVIEW_REQUEST_PREFIX = "lite:preview-video-request:";

export function litePreviewRequestKey(shotId: string): string {
  return `${LITE_PREVIEW_REQUEST_PREFIX}${shotId}`;
}

/** 读本镜预览请求 id 集（脏行跳过：非数组或非字符串项不放大）。 */
export function readLitePreviewRequestIds(storage: Storage, shotId: string): ReadonlySet<string> {
  try {
    const parsed: unknown = storage.getItem(litePreviewRequestKey(shotId)) ? JSON.parse(storage.getItem(litePreviewRequestKey(shotId)) ?? "[]") : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

/** 预览提交成功后补记 requestId（幂等）。 */
export function rememberLitePreviewRequest(storage: Storage, shotId: string, requestId: string): void {
  const set = readLitePreviewRequestIds(storage, shotId);
  if (set.has(requestId)) return;
  storage.setItem(litePreviewRequestKey(shotId), JSON.stringify([...set, requestId]));
}

/* ---------- 生成配置（档 + 项目默认策略） ---------- */

export interface LiteKindConfig {
  tiers: CapabilityTier[];
  /** null = 从未配置过（404），按钮禁用并指向配置页。 */
  strategy: GenerationDefaultStrategy | null;
  /** 本项目自建模板库（仅本媒介；生成期解析 prompt_template_id → 内容用）。 */
  library: PromptTemplate[];
}

/** 读某媒介的 active 档与已存默认策略 + 自建模板库；404 不算错（未配置过），其余错误原样抛给页头条。
    模板库读不到按空回落：引用按系统默认执行，照常可生成。 */
export async function loadLiteKindConfig(projectId: string, kind: GenerationMediaKind): Promise<LiteKindConfig> {
  const { tiers } = await listCapabilityTiers(kind, false);
  const strategy = await api.generationDefault(projectId, kind).catch((reason) => {
    if (reason instanceof ApiClientError && reason.status === 404) return null;
    throw reason;
  });
  const library = await api.promptTemplates(projectId, kind).catch(() => ({ items: [] }));
  return { tiers, strategy, library: library.items };
}

export function textParam(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 档的清晰度取值（图片档 params.resolution 是登记键，params.size 为兼容读法）。 */
export function tierResolutionOf(tier: CapabilityTier): string | undefined {
  const value = tierDimensionValue(tier, "resolution") ?? tier.params.size;
  return typeof value === "string" ? value : undefined;
}

/**
 * 由已存策略反查可提交档：model_key 存的是档 id（FABLE-007 后 tier_id 是唯一公开选择键），
 * 只认 active 档里同档、且清晰度（图片 size / 视频 resolution，配置页写入口径）与比例、
 * 时长（视频 ratio ↔ 档 aspect_ratio、duration_seconds）一致者；查不到 = 配置的组合当前
 * 无档可提交，按钮禁用给原因，绝不换档静默提交。
 */
export function resolveLiteTier(tiers: readonly CapabilityTier[], kind: GenerationMediaKind, strategy: GenerationDefaultStrategy): CapabilityTier | null {
  const sameTier = activeTiers(tiers).filter((tier) => tier.tier_id === strategy.model_key);
  if (sameTier.length === 0) return null;
  const resolution = textParam(strategy.parameters.resolution) ?? textParam(strategy.parameters.size);
  const ratio = textParam(strategy.parameters.ratio);
  const duration = typeof strategy.parameters.duration_seconds === "number" && Number.isFinite(strategy.parameters.duration_seconds)
    ? strategy.parameters.duration_seconds
    : null;
  if (!resolution) return sameTier[0]!;
  const matches = sameTier.filter((tier) => {
    if (tierResolutionOf(tier) !== resolution) return false;
    if (kind === "video" && ratio !== null && tierDimensionValue(tier, "aspect_ratio") !== ratio) return false;
    /* 时长参与反查（配置页存的就是档声明值）；档未声明该维度时不误杀。 */
    if (kind === "video" && duration !== null) {
      const declared = tierDimensionValue(tier, "duration_seconds");
      if (declared !== undefined && Number(declared) !== duration) return false;
    }
    return true;
  });
  return matches[0] ?? null;
}


/** 同组合多档的收敛口径(v1.4 七.3):价格最低优先,同价按 tier_id 稳定排序
 *  (沿用 v1.3.1 兜底;切比例/清晰度与默认档反查共用)。
 *  计价键 = 单次生成总价 demoEstimatePoints(档):图片 档价×张数、视频/音频 档价×秒数。
 *  若按裸 price.points 比,按秒计价的同单价档(如音频 3 积分/秒)会全平手,
 *  时长档只能靠 tier_id 字典序决胜 → 10s(总价 30)反而压过 3s(总价 9),
 *  用户切音质/格式时被静默抬高 3 倍费用。总价口径下最短=最省,默认落 3s。 */
export function cheapestActiveTier(tiers: readonly CapabilityTier[]): CapabilityTier | undefined {
  return [...tiers].sort((a, b) => demoEstimatePoints(a) - demoEstimatePoints(b) || a.tier_id.localeCompare(b.tier_id))[0];
}

/** 默认档反查(v1.4 七.3 决策 1):策略 model_key 精确命中 → 再按清晰度/比例维度过滤 →
 *  多档取最便宜;无命中回落最便宜 active 档;空列表 null(调用方兜底)。resolveLiteTier 同款口径。 */
export function pickLiteDefaultTier(
  active: readonly CapabilityTier[],
  strat: GenerationDefaultStrategy | null,
): CapabilityTier | null {
  if (active.length === 0) return null;
  const byKey = strat?.model_key ? active.filter((t) => t.tier_id === strat.model_key) : [];
  if (byKey.length > 0) {
    const resolution = textParam(strat?.parameters.resolution) ?? textParam(strat?.parameters.size);
    const ratio = textParam(strat?.parameters.ratio);
    const matched = byKey.filter((t) => {
      if (resolution) {
        const r = tierResolutionOf(t);
        if (r !== undefined && r !== resolution) return false;
      }
      if (ratio) {
        const declared = typeof t.params.aspect_ratio === "string" ? t.params.aspect_ratio : null;
        if (declared !== null && declared !== ratio) return false;
      }
      return true;
    });
    const pool = matched.length > 0 ? matched : byKey;
    return cheapestActiveTier(pool)!;
  }
  return cheapestActiveTier(active)!;
}

/* ---------- 生视频档池切分（2026-08-19 裁定：正式=seedance / 预览=快乐马） ----------
   正式生成只能用 seedance(火山方舟视频档);预览只能用快乐马预览档(params.preview=true)。
   池切分是前端硬闸:正式级联/默认档反查/提交兜底全部只在正式池内取值,预览弹窗只在
   预览池内取值,两池不混。seedance 识别用安全投影 provider_label(ark 视频模型即
   seedance);DB 快乐马标签=「快乐马」、DEMO 快乐马标签=「阿里云百炼」,均非「火山方舟」,
   双保险排除。active 之外的档(experimental/retired)一律不进任何池。 */
export function isFormalSeedanceVideoTier(tier: CapabilityTier): boolean {
  return tier.media_type === "video" && !isPreviewTier(tier) && tier.provider_label?.trim() === "火山方舟";
}

/** 正式生视频档池（active + 非预览 + 火山方舟）；空 = 无可提交档，按钮禁用给原因。 */
export function formalVideoTiers(tiers: readonly CapabilityTier[]): CapabilityTier[] {
  return activeTiers(tiers).filter(isFormalSeedanceVideoTier);
}

/** 预览档池（active 视频 + 快乐马预览档 params.preview=true）；空 = 无预览能力，预览入口禁用。 */
export function previewVideoTiers(tiers: readonly CapabilityTier[]): CapabilityTier[] {
  return activeTiers(tiers).filter((tier) => tier.media_type === "video" && isPreviewTier(tier));
}

/* ---------- 快乐马预览参数化（2026-08-19 裁定） ----------
   预览弹窗在快乐马能力内开放分辨率/画幅/时长三参。选项矩阵后端唯一真源
   = v01Contract.ts VIDEO_CAPABILITIES 快乐马条目（设计文档 §1.1）：分辨率
   480p/720p/1080p、画幅 9 种、时长 3–15 整数秒。单注册预览档（params 只有
   480p/9:16/5s）推不出选项集，故前端硬编码矩阵并注释指回后端真源；后端
   requireEffectiveProjectTier / requireCurrentTier 已接受快乐马预览档参数覆盖，
   前端只发覆盖值 + 档位断言（preview:true 身份键随档参数带过去）。 */
export const HAPPYHORSE_PREVIEW_RESOLUTIONS: readonly string[] = ["480p", "720p", "1080p"];
export const HAPPYHORSE_PREVIEW_RATIOS: readonly string[] = ["16:9", "9:16", "3:4", "4:3", "4:5", "5:4", "1:1", "9:21", "21:9"];
export const HAPPYHORSE_PREVIEW_MIN_DURATION = 3;
export const HAPPYHORSE_PREVIEW_MAX_DURATION = 15;
/** 快乐马预览档缺省时长（设计文档 §1.1 与 DB 快乐马预览档 duration_seconds=5）。 */
export const HAPPYHORSE_PREVIEW_DEFAULT_DURATION = 5;

/** 预览时长 = 分镜时长收敛到快乐马能力（3–15 整数秒）；缺值/非数字回落 fallback。 */
export function clampPreviewDuration(
  value: number | null | undefined,
  fallback: number = HAPPYHORSE_PREVIEW_DEFAULT_DURATION,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(HAPPYHORSE_PREVIEW_MIN_DURATION, Math.min(HAPPYHORSE_PREVIEW_MAX_DURATION, Math.round(value)));
}

/** 预览估价 = 时长 × 快乐马 per_second 档单价。档 params.duration_seconds 是登记值(5s),
    覆盖时长后仍按 demoEstimatePoints 会给 5s 价,故预览弹窗按真实覆盖时长重算。 */
export function previewEstimatePoints(tier: CapabilityTier, durationSeconds: number): number {
  return tier.price.unit === "per_second" ? tier.price.points * durationSeconds : demoEstimatePoints(tier);
}

/* ---------- 分镜媒体（候选图/视频） ---------- */

export interface LiteShotMedia {
  items: MediaVersion[];
  /** 单行读取失败不连坐整表：该行详情区给重试入口。 */
  error?: string;
}

export async function loadShotMediaMap(shots: readonly Shot[]): Promise<Record<string, LiteShotMedia>> {
  const entries = await Promise.all(shots.map(async (shot) => {
    try {
      const list = await api.shotMedia(shot.id);
      return [shot.id, { items: list.items }] as const;
    } catch (reason) {
      return [shot.id, { items: [] as MediaVersion[], error: humanErrorMessage(reason, "读取失败") }] as const;
    }
  }));
  return Object.fromEntries(entries);
}

/** 参考素材提交被供应商拒的识别（422 + InvalidParameter；见 LITE_REFERENCE_REJECT_MESSAGE 边界注释）。 */
export function isLiteReferenceRejection(reason: unknown): boolean {
  return reason instanceof ApiClientError
    && reason.status === 422
    && /invalidparameter/i.test(`${reason.code} ${reason.message}`);
}

/**
 * 生视频 references 组装（全能参考，#186）：本镜定稿图的登记产物排首位，参考控制包
 * 里的素材按点名顺序跟后，全部 usage_mode="reference"；同素材自动去重（后端同素材
 * 跨槽必 422）。参考上限不写死（原型 §9.2）：读不到配额时不猜不夹取，超限交给后端
 * 拒绝并原样展示人话。
 */
export function buildLiteVideoReferences(primaryReferenceMediaId: string, referenceMediaIds: readonly string[]): LiteReferenceInput[] {
  const seen = new Set<string>();
  const references: LiteReferenceInput[] = [];
  const push = (mediaId: string): void => {
    if (seen.has(mediaId)) return;
    seen.add(mediaId);
    references.push({ media_id: mediaId, usage_mode: "reference" });
  };
  push(primaryReferenceMediaId);
  for (const mediaId of referenceMediaIds) push(mediaId);
  return references;
}

/** 候选图 = 生成候选图片行（素材库选用条目 provider_result_key=null 也算——
    能被完整版定稿过来的图不丢），且带有可展示地址（持久化完成的行才有）。 */
export function imageCandidatesOf(media: LiteShotMedia | undefined): MediaVersion[] {
  return (media?.items ?? []).filter((item) => item.media_kind === "image" && typeof item.storage_url === "string" && item.storage_url.length > 0);
}

export function videoMediaOf(media: LiteShotMedia | undefined): MediaVersion[] {
  return (media?.items ?? []).filter((item) => item.media_kind === "video");
}

/** 视频前置 = 该行有 is_primary 图片 media（点选定稿图即 set-primary）。 */
export function primaryImageOf(media: LiteShotMedia | undefined): MediaVersion | null {
  return (media?.items ?? []).find((item) => item.media_kind === "image" && item.is_primary === true) ?? null;
}

/* ---------- 进行中的生成任务（行内状态机） ---------- */

export interface TrackedLiteTask {
  requestId: string;
  shotId: string;
  kind: GenerationMediaKind;
  /** 2026-08-19：预览弹窗提交的任务为 true，settle 提示/版本归属据此分流。 */
  preview?: boolean;
  task: GenerationTask;
  /** 首次开始轮询的时间；超过 30 分钟转超时态（不自动重发）。 */
  firstPollAt: number;
  pollCount: number;
  pollFailures: number;
  nextPollAt: number;
  timedOut: boolean;
}

export function isActiveTask(tracked: TrackedLiteTask): boolean {
  return ACTIVE_GENERATION_STATUSES.includes(tracked.task.status);
}

/** 轮询目标 = 进行中且未超时（失败/取消/成功都是终态，不再轮询）。 */
export function isPollingTarget(tracked: TrackedLiteTask): boolean {
  return isActiveTask(tracked) && !tracked.timedOut;
}

/** 指数退避：3s → 6s → 12s → 15s 封顶。 */
export function pollDelayMs(pollCount: number): number {
  return Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** pollCount);
}
