/* ============================================================
   version-modal.tsx — P1 包④ 分镜视频版本弹窗（板06）
   同时承载板05/板06 共享的纯逻辑（默认参数卡、时间线游标、版本状态机），
   供真工作台（pages/workbench-page.tsx）与 src/p1-video.test.ts 复用（S11-4：/video 孤儿页已下线）。
   W5.5 起追加两个工作台共享的纯逻辑（模型卡折叠、默认策略预填、
   分镜任务隔离、分镜改名判定），供 pages/workbench-page.tsx、
   真工作台（pages/workbench-page.tsx）与 src/workbench-w55.test.ts 复用（S11-4）。
   视图层：Tailwind utility + ui 原语（Dialog/Badge/Button/Textarea）；
   本模块不 import 任何 CSS，保证 node:test 可直接 import。
   后端缺口（2026-07 核实，src/modules/shot-media/）：
   - shot media 无备注/删除接口：人工备注与「删除所选」仅本地态。
   ============================================================ */
import {
  ArrowClockwise,
  CheckCircle,
  FolderPlus,
  GridFour,
  ImageSquare,
  Trash,
  VideoCamera,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { ApiClientError, api } from "../api";
import { formatCreditsWithUnit } from "../cost-units";
import { humanErrorMessage } from "../pages/batch-generate-drawer";
import { promoteEntryState } from "./promote-asset-modal";
import type {
  DeliverableItem,
  GenerationDefaultMode,
  GenerationDefaultStrategy,
  GenerationMediaKind,
  GenerationTask,
  JsonRecord,
  MediaVersion,
  PutGenerationDefaultInput,
} from "../types";
import { formatDateTime } from "../ui";
import type { PageRuntimeProps } from "../pages/global-pages";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Badge, EmptyState, Textarea } from "./ui/primitives";
/* ============================================================
   纯逻辑：生成默认策略参数卡（板05 右栏）
   ============================================================ */

export interface VideoDefaultDraft {
  mode: GenerationDefaultMode;
  modelKey: string;
  ratio: string;
  resolution: string;
  durationSeconds: number;
}

/** 后端尚无该项目默认策略（404）时的前端兜底草稿，对齐 v4 参数卡。 */
export const FALLBACK_VIDEO_DEFAULT_DRAFT: VideoDefaultDraft = {
  mode: "material_to_prompt",
  modelKey: "sd2",
  ratio: "9:16",
  resolution: "720p",
  durationSeconds: 4,
};

function stringParam(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberParam(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 服务端策略 → 参数卡草稿；缺省字段回落到 v4 默认。 */
export function draftFromStrategy(strategy: GenerationDefaultStrategy | null): VideoDefaultDraft {
  if (!strategy) return { ...FALLBACK_VIDEO_DEFAULT_DRAFT };
  const parameters = strategy.parameters ?? {};
  return {
    mode: strategy.mode,
    modelKey: stringParam(strategy.model_key, FALLBACK_VIDEO_DEFAULT_DRAFT.modelKey),
    ratio: stringParam(parameters.ratio, FALLBACK_VIDEO_DEFAULT_DRAFT.ratio),
    resolution: stringParam(parameters.resolution, FALLBACK_VIDEO_DEFAULT_DRAFT.resolution),
    durationSeconds: numberParam(parameters.duration_seconds, FALLBACK_VIDEO_DEFAULT_DRAFT.durationSeconds),
  };
}

/** 参数卡草稿 → PUT 输入；expected_version 走乐观锁（后端 generation-defaults 合同）。 */
export function putInputFromDraft(draft: VideoDefaultDraft, expectedVersion: number): PutGenerationDefaultInput {
  return {
    mode: draft.mode,
    model_key: draft.modelKey.trim() || FALLBACK_VIDEO_DEFAULT_DRAFT.modelKey,
    parameters: {
      ratio: draft.ratio,
      resolution: draft.resolution,
      duration_seconds: draft.durationSeconds,
    },
    expected_version: expectedVersion,
  };
}

/** 乐观锁冲突（后端 ConflictError → HTTP 409）。 */
export function isDefaultVersionConflict(error: unknown): boolean {
  return error instanceof ApiClientError && error.status === 409;
}

export type DefaultSaveStatus = "clean" | "dirty" | "saving" | "saved" | "conflict" | "failed";

export interface DefaultSaveState {
  status: DefaultSaveStatus;
  /** 当前已知的服务端 version；下一次保存以其为 expected_version。 */
  version: number;
  message: string;
}

export type DefaultSaveEvent =
  | { type: "load"; version: number }
  | { type: "edit" }
  | { type: "save" }
  | { type: "saved"; version: number }
  | { type: "save-error"; error: unknown };

/** 参数卡保存状态机：编辑→保存→已保存/409 冲突（提示刷新）/失败。 */
export function defaultSaveReducer(state: DefaultSaveState, event: DefaultSaveEvent): DefaultSaveState {
  switch (event.type) {
    case "load":
      return { status: "clean", version: event.version, message: "" };
    case "edit":
      return state.status === "saving" ? state : { ...state, status: "dirty", message: "" };
    case "save":
      return state.status === "saving" ? state : { ...state, status: "saving", message: "" };
    case "saved":
      return { status: "saved", version: event.version, message: "默认参数已保存，后续生成沿用这组参数" };
    case "save-error":
      if (isDefaultVersionConflict(event.error)) {
        return { ...state, status: "conflict", message: "默认参数刚被他人更新，请重新读取后再保存" };
      }
      return {
        ...state,
        status: "failed",
        message: event.error instanceof Error ? event.error.message : "保存默认参数失败",
      };
  }
}

/* ============================================================
   纯逻辑：W5.5 两个工作台共享（模型卡折叠 / 默认策略预填 /
   分镜任务隔离 / 分镜改名判定）
   ============================================================ */

export interface ModelCardLike {
  key: string;
  available: boolean;
}

export interface ModelCardPartition<T extends ModelCardLike> {
  /** 已配置、可平铺展示的模型卡。 */
  configured: T[];
  /** 待配置、默认折叠成一行小字的禁用卡。 */
  pending: T[];
}

/** 模型卡收敛：可用卡平铺，未配置卡折叠（保持原顺序，不丢卡）。 */
export function partitionModelCards<T extends ModelCardLike>(cards: readonly T[]): ModelCardPartition<T> {
  const configured: T[] = [];
  const pending: T[] = [];
  for (const card of cards) {
    (card.available ? configured : pending).push(card);
  }
  return { configured, pending };
}

/** 折叠行小字：「其余 N 个模型待配置」。 */
export function unconfiguredModelsLabel(count: number): string {
  return `其余 ${count} 个模型待配置`;
}

export interface GenerationDefaultPrefill {
  mode: GenerationDefaultMode;
  modelKey: string;
  /** 已持久化策略的 version；未持久化（404）为 0，首次 PUT 即创建。 */
  expectedVersion: number;
  persisted: boolean;
}

/** 打开确认抽屉时把服务端默认策略映射成预填；无策略回落「素材转提示词参考 + configured」。 */
export function prefillFromStrategy(strategy: GenerationDefaultStrategy | null): GenerationDefaultPrefill {
  if (!strategy) {
    return { mode: "material_to_prompt", modelKey: "configured", expectedVersion: 0, persisted: false };
  }
  return {
    mode: strategy.mode,
    modelKey: strategy.model_key?.trim() ? strategy.model_key : "configured",
    expectedVersion: typeof strategy.version === "number" && Number.isFinite(strategy.version) && strategy.version > 0
      ? strategy.version
      : 0,
    persisted: true,
  };
}

export function generationModeLabel(mode: GenerationDefaultMode): string {
  return mode === "direct_reference" ? "直接引用" : "素材转提示词参考";
}

/** 「固定为默认」保存的参数与确认抽屉展示的 V0.1.1 固定参数保持一致。 */
export function workbenchFixedParameters(kind: GenerationMediaKind): JsonRecord {
  return kind === "image"
    ? { ratio: "16:9", size: "2K", watermark: false, sequential_image_generation: "disabled" }
    : { ratio: "9:16", resolution: "720p", duration_seconds: 4 };
}

/** 确认抽屉「固定为默认」→ PUT 输入；expected_version 走乐观锁（同参数卡合同）。 */
export function putInputFromPrefill(
  kind: GenerationMediaKind,
  prefill: GenerationDefaultPrefill,
  modelKey: string,
): PutGenerationDefaultInput {
  return {
    mode: prefill.mode,
    model_key: modelKey.trim() || "configured",
    parameters: workbenchFixedParameters(kind),
    expected_version: prefill.expectedVersion,
  };
}

export interface ShotTaskState {
  /** 当前任务归属的分镜 id；与路由 shotId 不一致时任务视为不可见。 */
  shotId: string;
  imageTask: GenerationTask | null;
  videoTask: GenerationTask | null;
}

/**
 * 生成中状态按分镜隔离：
 * - 切到另一个分镜 → 丢弃旧任务，只保留恢复（restored）结果；
 * - 同一分镜 → 无 restored 时原样返回（不误清进行中的任务）。
 */
export function taskStateForShot(
  prev: ShotTaskState,
  shotId: string,
  restored?: { imageTask?: GenerationTask | null; videoTask?: GenerationTask | null },
): ShotTaskState {
  if (prev.shotId !== shotId) {
    return {
      shotId,
      imageTask: restored?.imageTask ?? null,
      videoTask: restored?.videoTask ?? null,
    };
  }
  if (!restored) return prev;
  return {
    shotId,
    imageTask: restored.imageTask !== undefined ? restored.imageTask : prev.imageTask,
    videoTask: restored.videoTask !== undefined ? restored.videoTask : prev.videoTask,
  };
}

/** 改名输入归一化：去首尾空白、压缩连续空白。 */
export function normalizeShotTitle(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/** 时间线卡标题：编号即素材序号（#N）。title 已带「#N」或旧「分镜N」前缀时直接用，避免重复。 */
export function timelineCardTitle(shot: { shot_no?: string; title?: string | null }): string {
  const title = shot.title?.trim() ?? "";
  const no = shot.shot_no?.trim() ?? "";
  if (no && (title.startsWith(`#${no}`) || title.startsWith(`分镜${no}`))) return title;
  if (title) return no ? `#${no} · ${title}` : title;
  return `#${no || "—"}`;
}

/** 改名提交判定：空串或与现名相同 → 不提交（直接退出编辑态）。 */
export function shotTitleCommit(currentTitle: string, draft: string): { commit: boolean; title: string } {
  const title = normalizeShotTitle(draft);
  if (!title || title === currentTitle) return { commit: false, title: currentTitle };
  return { commit: true, title };
}

/* ============================================================
   纯逻辑：全集播放游标与整集预览时间线（板05 中区/底部）
   ============================================================ */

export interface PlaybackSlice {
  shotId: string;
  shotNo: string;
  durationSeconds: number;
  storageUrl: string;
}

/** episodePlayback.playback → 归一化播放切片；无时长时按 4 秒占位。 */
export function playbackSlices(items: DeliverableItem[] | undefined): PlaybackSlice[] {
  return [...(items ?? [])]
    .sort((a, b) => (a.shot_sort_order ?? 0) - (b.shot_sort_order ?? 0))
    .map((item) => ({
      shotId: item.shot_id,
      shotNo: item.shot_code,
      durationSeconds: item.duration_seconds && item.duration_seconds > 0 ? item.duration_seconds : 4,
      storageUrl: item.storage_url || "",
    }));
}

export function totalPlaybackSeconds(slices: PlaybackSlice[]): number {
  return slices.reduce((sum, slice) => sum + slice.durationSeconds, 0);
}

/** 全集播放到 elapsed 秒时落在哪个分镜（累计时长二分语义的线性实现）。 */
export function playbackCursorAt(slices: PlaybackSlice[], elapsedSeconds: number): { index: number; shotId: string } | null {
  if (slices.length === 0) return null;
  const total = totalPlaybackSeconds(slices);
  const clamped = Math.max(0, Math.min(elapsedSeconds, Math.max(total - 0.001, 0)));
  let accumulated = 0;
  for (let index = 0; index < slices.length; index += 1) {
    accumulated += slices[index]!.durationSeconds;
    if (clamped < accumulated) return { index, shotId: slices[index]!.shotId };
  }
  const last = slices.length - 1;
  return { index: last, shotId: slices[last]!.shotId };
}

/** 秒 → mm:ss（全集播放状态行「00:11 / 02:00」）。 */
export function formatPlaybackClock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export type TimelineCardState = "editing" | "playing" | "both" | "idle";

/** 时间线分镜卡两态：正在编辑（路由分镜）/ 播放至（全集游标分镜）。 */
export function timelineCardState(shotId: string, editingShotId: string, playingShotId: string | null): TimelineCardState {
  const editing = shotId === editingShotId;
  const playing = playingShotId !== null && shotId === playingShotId;
  if (editing && playing) return "both";
  if (editing) return "editing";
  if (playing) return "playing";
  return "idle";
}

/* ============================================================
   纯逻辑：视频版本状态机（板06）
   版本号按 created_at 升序分配（最旧 V1），pill 优先级：
   主版本 > 已弃 > 拟设主版本（最新非主版本）> 首版 > 历史版本。
   ============================================================ */

export type VersionPill = "主版本" | "拟设主版本" | "已弃" | "首版" | "历史版本";

export interface VideoVersionRow {
  media: MediaVersion;
  versionNo: number;
  pill: VersionPill;
}

function versionTimestamp(item: MediaVersion): number {
  const parsed = item.created_at ? Date.parse(item.created_at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 版本列表按创建时间升序（最旧在前），时间缺失时按 id 稳定排序。 */
export function sortVideoVersions(items: MediaVersion[]): MediaVersion[] {
  return [...items].sort((a, b) => versionTimestamp(a) - versionTimestamp(b) || a.id.localeCompare(b.id));
}

/** 最新候选 = 最新的非主版本且未被本地标记已弃的版本。 */
export function latestCandidateId(items: MediaVersion[], discardedIds: ReadonlySet<string> = new Set()): string | null {
  const sorted = sortVideoVersions(items);
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const media = sorted[index]!;
    if (!media.is_primary && !discardedIds.has(media.id)) return media.id;
  }
  return null;
}

export function versionPill(
  media: MediaVersion,
  options: { candidateId: string | null; firstId: string | null; discarded: boolean },
): VersionPill {
  if (media.is_primary) return "主版本";
  if (options.discarded) return "已弃";
  if (options.candidateId === media.id) return "拟设主版本";
  if (options.firstId === media.id) return "首版";
  return "历史版本";
}

/** 版本弹窗行模型：版本号 + 状态 pill，一图流描述当前库内格局。 */
export function buildVersionRows(items: MediaVersion[], discardedIds: ReadonlySet<string> = new Set()): VideoVersionRow[] {
  const sorted = sortVideoVersions(items);
  const candidateId = latestCandidateId(items, discardedIds);
  const firstId = sorted[0]?.id ?? null;
  return sorted.map((media, index) => ({
    media,
    versionNo: index + 1,
    pill: versionPill(media, { candidateId, firstId, discarded: discardedIds.has(media.id) }),
  }));
}

/** 候选对比区：当前主版本 vs 最新候选。 */
export function comparePair(rows: VideoVersionRow[]): { primary: VideoVersionRow | null; candidate: VideoVersionRow | null } {
  return {
    primary: rows.find((row) => row.media.is_primary) ?? null,
    candidate: rows.find((row) => row.pill === "拟设主版本") ?? null,
  };
}

/** 设主版本后的列表迁移：保证全表恰好一个主版本。 */
export function applyPrimaryToList(items: MediaVersion[], mediaId: string): MediaVersion[] {
  return items.map((item) => ({ ...item, is_primary: item.id === mediaId }));
}

/* ============================================================
   纯逻辑：审核状态与设主闸门（K2-A,GP-22）
   后端事实:shot-media set-primary 对未过审产物 409(media_review_not_accepted),
   前端必须把规则摆在被拦之前——rejected 版本在入口上明确不可选。
   needs_review 不在前端硬拦(项目策略是否为「先审后交」前端不可知,
   被后端 409 拦时 toast 是后端人话);rejected 任何策略下都不可设主。 
   ============================================================ */

export type ReviewStatusLabel = "待审核" | "已通过" | "已拒绝";

export function reviewStatusLabelOf(media: Pick<MediaVersion, "review_status">): ReviewStatusLabel | null {
  if (media.review_status === "accepted") return "已通过";
  if (media.review_status === "rejected") return "已拒绝";
  if (media.review_status === "needs_review") return "待审核";
  return null;
}

/** 设主闸门:rejected → 不可选并给原因;其余状态放行(未过审被拦由后端人话兜底)。 */
export function setPrimaryGate(media: Pick<MediaVersion, "review_status" | "is_primary">): { allowed: boolean; reason: string } {
  if (media.is_primary) return { allowed: false, reason: "已是当前主版本" };
  if (media.review_status === "rejected") return { allowed: false, reason: "这条产物审核已拒绝，不能设为主版本；可在审核队列看拒绝理由" };
  return { allowed: true, reason: "" };
}

/* ============================================================
   组件：版本弹窗（板06）—— Dialog 原语 + utility 视图
   ============================================================ */

export interface VersionReferenceThumb {
  label: string;
  url: string;
}

interface VersionModalProps {
  shotId: string;
  shotNo: string;
  /** 「1-2-北疆战场」式定位行：集-分镜-场景/标题。 */
  shotLabel: string;
  /** 已按 media_kind=video 过滤的版本列表。 */
  media: MediaVersion[];
  scriptText: string;
  referenceThumbs: VersionReferenceThumb[];
  /** 元数据行（对齐 v4「00:04 · 720p · 120 积分」），由页面按当前参数卡组装。 */
  versionMeta: string;
  estimatedCostFen: number | null;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  onClose: () => void;
  /** 主版本切换后回写页面（demo 下本地切换，真实模式已成功调用 setShotPrimary）。 */
  onPrimaryChanged: (mediaId: string) => void;
  /** 「再来一版」：复用当前参数再开一次生成链（页面侧实现）。 */
  onRegenerate: () => void;
  /**
   * W5-1 图片候选（分镜草图等图片版本）：每个图片候选在对比区下方
   * 出一个小的「转为参考资产」按钮；视频候选不出（后端 media 上传只收图片）。
   */
  imageCandidates?: MediaVersion[];
  /** 点击「转为参考资产」：页面侧打开 PromoteToAssetModal（demoMode 下只提示）。 */
  onPromoteImage?: (media: MediaVersion) => void;
  /** W6-2：点击「宫格切分」：页面侧打开 GridSplitModal（demoMode 下只提示）。 */
  onSplitGridImage?: (media: MediaVersion) => void;
}

/** pill → 四态语义色：主版本=success / 拟设主版本=accent / 已弃=danger / 首版=warning / 历史=neutral。 */
const PILL_TONE: Record<VersionPill, "success" | "accent" | "danger" | "warning" | "neutral"> = {
  主版本: "success",
  拟设主版本: "accent",
  已弃: "danger",
  首版: "warning",
  历史版本: "neutral",
};

export function VersionModal({
  shotId,
  shotNo,
  shotLabel,
  media,
  scriptText,
  referenceThumbs,
  versionMeta,
  estimatedCostFen,
  demoMode,
  notify,
  onClose,
  onPrimaryChanged,
  onRegenerate,
  imageCandidates,
  onPromoteImage,
  onSplitGridImage,
}: VersionModalProps): React.JSX.Element {
  // 已弃标记与人工备注均为本地态：shot-media 后端只有 list / set-primary（见文件头注释）。
  const [discardedIds, setDiscardedIds] = useState<ReadonlySet<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string>("");
  const [busyId, setBusyId] = useState<string>("");

  const rows = useMemo(() => buildVersionRows(media, discardedIds), [media, discardedIds]);
  const pair = useMemo(() => comparePair(rows), [rows]);
  const imageCandidateRows = useMemo(() => buildVersionRows(imageCandidates ?? []), [imageCandidates]);
  const selected = rows.find((row) => row.media.id === selectedId)
    ?? pair.candidate
    ?? pair.primary
    ?? null;
  const costLabel = estimatedCostFen !== null ? formatCreditsWithUnit(estimatedCostFen, { approx: true }) : "消耗以报价为准";

  async function setPrimary(mediaId: string): Promise<void> {
    if (!mediaId || busyId) return;
    if (demoMode) {
      onPrimaryChanged(mediaId);
      notify("离线演示：已在本地切换主版本，不会写入服务。", "info");
      return;
    }
    setBusyId(mediaId);
    try {
      await api.setShotPrimary(shotId, mediaId);
      onPrimaryChanged(mediaId);
      notify("已设为主版本。主版本用于全集预览与导出。", "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "设置主版本失败"), "error");
    } finally {
      setBusyId("");
    }
  }

  function discardSelected(): void {
    if (!selected) return;
    setDiscardedIds((current) => new Set(current).add(selected.media.id));
    notify("已在本地标记「已弃」，服务端数据保留可回切。", "info");
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>分镜 #{shotNo} · 视频版本</DialogTitle>
          <DialogDescription>{shotLabel} · {rows.length} 个版本</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {rows.length === 0 ? (
            <EmptyState
              title="还没有视频版本"
              description="在生成视频工作台点击「生成视频」，结果会进入这个版本弹窗。"
              icon={<VideoCamera />}
            />
          ) : (
            <>
              <section aria-label="候选对比区" className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <ComparePlayer row={pair.primary} role="primary" meta={versionMeta} />
                <ComparePlayer row={pair.candidate} role="candidate" meta={versionMeta} />
              </section>
              {referenceThumbs.length > 0 ? (
                <section aria-label="对照参考" className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold text-ink-2">对照参考</h3>
                  <div className="flex flex-wrap gap-2">
                    {referenceThumbs.map((thumb) => (
                      <figure className="m-0 flex w-24 flex-col gap-1" key={thumb.label}>
                        {thumb.url ? (
                          <img src={thumb.url} alt={thumb.label} className="h-16 w-24 rounded-sm border border-border-1 bg-surface-well object-cover" />
                        ) : (
                          <span className="flex h-16 w-24 items-center justify-center rounded-sm border border-border-1 bg-surface-well text-ink-2">
                            <ImageSquare aria-hidden="true" className="size-5" />
                          </span>
                        )}
                        <figcaption className="truncate text-[11px] text-ink-2">{thumb.label}</figcaption>
                      </figure>
                    ))}
                  </div>
                </section>
              ) : null}
              <blockquote className="m-0 rounded-r-md border-l-2 border-accent bg-surface-2 px-3 py-3">
                <span className="text-[11px] tracking-wider text-accent-text">剧本这一拍</span>
                <p className="mt-1 text-xs leading-relaxed text-ink-1">{scriptText || "暂无剧本文本。"}</p>
              </blockquote>
              <section className="flex flex-col gap-2">
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-xs font-semibold text-ink-2">人工备注{selected ? ` · V${selected.versionNo}` : ""}</h3>
                  <small className="text-[11px] text-ink-4">后端 shot media 暂无备注字段，备注仅本地保存（未接后端）</small>
                </header>
                <Textarea
                  className="min-h-16 text-xs"
                  value={selected ? notes[selected.media.id] ?? "" : ""}
                  disabled={!selected}
                  placeholder={selected ? `给 V${selected.versionNo} 写一句备注，例如「战场氛围对，马蹄穿帮」…` : "先选择一个版本"}
                  onChange={(event) => selected && setNotes((current) => ({ ...current, [selected.media.id]: event.target.value }))}
                />
              </section>
              <section aria-label="版本列表" className="flex flex-col gap-2">
                {rows.map((row) => {
                  const note = notes[row.media.id]?.trim();
                  const gate = setPrimaryGate(row.media);
                  const reviewLabel = reviewStatusLabelOf(row.media);
                  return (
                    <article
                      className={cn(
                        "grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border-1 bg-surface-2 px-3 py-2 transition-colors hover:border-accent/30",
                        selected?.media.id === row.media.id && "border-accent",
                      )}
                      key={row.media.id}
                      onClick={() => setSelectedId(row.media.id)}
                    >
                      <strong className="font-mono text-sm text-ink-1">V{row.versionNo}</strong>
                      <span className="flex items-center gap-1">
                        <Badge tone={PILL_TONE[row.pill]}>{row.pill}</Badge>
                        {/* K2-A(GP-22):审核状态事前可见——rejected 一眼可辨,不再等被拦后猜 */}
                        {reviewLabel ? <Badge tone={reviewLabel === "已拒绝" ? "danger" : reviewLabel === "已通过" ? "success" : "warning"}>{reviewLabel}</Badge> : null}
                      </span>
                      <div className="min-w-0">
                        <span className="block truncate text-xs text-ink-2">{note || row.media.title || (row.media.created_at ? `生成于 ${formatDateTime(row.media.created_at)}` : "已保存版本")}</span>
                        {row.media.review_status === "rejected" ? <span className="block text-[11px] text-danger">审核已拒绝，不能设为主版本</span> : null}
                      </div>
                      <Button
                        size="sm"
                        variant={row.pill === "主版本" ? "secondary" : "primary"}
                        icon={<CheckCircle />}
                        loading={busyId === row.media.id}
                        disabled={row.pill === "主版本" || !gate.allowed}
                        title={gate.allowed ? undefined : gate.reason}
                        onClick={(event) => { event.stopPropagation(); void setPrimary(row.media.id); }}
                      >{row.pill === "主版本" ? "当前主版本" : "设为主版本"}</Button>
                    </article>
                  );
                })}
              </section>
            </>
          )}
          {imageCandidateRows.length > 0 ? (
            <section aria-label="图片候选" className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-ink-2">图片候选 · 可转为参考资产</h3>
              <div className="flex flex-wrap gap-2">
                {imageCandidateRows.map((row) => {
                  const url = row.media.storage_url || row.media.thumbnail_url || "";
                  // 视频候选不出此入口；无 storage_url 时隐藏按钮而不是报错（板14）
                  const promotable = onPromoteImage && promoteEntryState(row.media, demoMode) !== "hidden";
                  const splittable = onSplitGridImage && promoteEntryState(row.media, demoMode) !== "hidden";
                  return (
                    <figure className="m-0 flex w-[132px] flex-col gap-1" key={row.media.id}>
                      {url ? (
                        <img src={url} alt={row.media.title || `图片候选 I${row.versionNo}`} className="h-[74px] w-[132px] rounded-sm border border-border-1 bg-surface-well object-cover" />
                      ) : (
                        <span className="flex h-[74px] w-[132px] items-center justify-center rounded-sm border border-border-1 bg-surface-well text-ink-2">
                          <ImageSquare aria-hidden="true" className="size-6 opacity-60" />
                        </span>
                      )}
                      <figcaption className="flex flex-col gap-1.5 text-[11px] text-ink-2">
                        <span className="truncate">{row.media.title || `图片 I${row.versionNo}`}{row.media.is_primary ? " · 主版本" : ""}</span>
                        {promotable || splittable ? (
                          <div className="flex flex-wrap gap-1.5">
                            {promotable ? (
                              <Button size="sm" icon={<FolderPlus />} onClick={() => onPromoteImage(row.media)}>转为参考资产</Button>
                            ) : null}
                            {splittable ? (
                              <Button size="sm" icon={<GridFour />} title="把这张图按宫格等分裁切，逐格入资产库" onClick={() => onSplitGridImage(row.media)}>宫格切分</Button>
                            ) : null}
                          </div>
                        ) : null}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            </section>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <span className="mr-auto text-xs text-ink-2">主版本用于全集预览与导出；其余版本保留可回切</span>
          <Button variant="danger" icon={<Trash />} disabled={!selected || selected.pill === "主版本" || selected.pill === "已弃"} onClick={discardSelected}>删除所选</Button>
          <Button icon={<ArrowClockwise />} onClick={onRegenerate}>再来一版（复用参数 · {costLabel}）</Button>
          <Button
            variant="primary"
            icon={<CheckCircle />}
            loading={Boolean(busyId) && busyId === selected?.media.id}
            disabled={!selected || selected.pill === "主版本" || !setPrimaryGate(selected.media).allowed}
            title={selected && !setPrimaryGate(selected.media).allowed ? setPrimaryGate(selected.media).reason : undefined}
            onClick={() => selected && void setPrimary(selected.media.id)}
          >{selected ? `确认 V${selected.versionNo} 为主版本` : "确认主版本"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ComparePlayer({ row, role, meta }: { row: VideoVersionRow | null; role: "primary" | "candidate"; meta: string }): React.JSX.Element {
  const roleLabel = role === "primary" ? "当前主版本" : "最新候选";
  const badge = row
    ? role === "candidate"
      ? `V${row.versionNo} · 刚生成 · ${row.pill}`
      : `V${row.versionNo} · ${row.pill}`
    : roleLabel;
  const url = row?.media.storage_url || "";
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1">
      <div className={cn(
        "relative flex aspect-video items-center justify-center overflow-hidden rounded-md border border-border-1 bg-surface-well",
        role === "candidate" && row ? "border-accent" : "",
      )}>
        {url ? <video controls preload="metadata" src={url} className="h-full w-full object-contain" /> : (
          <div className="flex flex-col items-center gap-1 p-3 text-center text-xs text-ink-2">
            <VideoCamera aria-hidden="true" className="size-6 opacity-60" />
            <span>{row ? "暂无真实视频文件，占位画面" : `暂无${roleLabel}`}</span>
          </div>
        )}
        <Badge tone={row ? PILL_TONE[row.pill] : "neutral"} className="absolute left-2 top-2 border border-border-2 bg-surface-1/85">{badge}</Badge>
      </div>
      <figcaption className="flex justify-between gap-2 text-xs text-ink-2">
        <span>{roleLabel}</span>
        <span className="font-mono tabular-nums">{meta}</span>
      </figcaption>
    </figure>
  );
}
