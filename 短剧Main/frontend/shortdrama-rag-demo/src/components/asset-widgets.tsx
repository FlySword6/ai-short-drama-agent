/* ============================================================
   asset-widgets.tsx — W5.5 资产域共享 UI（Dario #3/#4/#8）
   - AssetKindThumb：按类型图标 + 色调的设计占位图（05 稿），无图资产也可点；
   - ReviewLegend：审核四态色点图例行（06 稿：待审核悬停看审核人；已拒绝悬停看拒绝理由）；
   - TagFilterInput：Tag 筛选 combobox 建议下拉（bug6，纯逻辑在 asset-shared）；
   - AssetDetailModal：资产中心详情宽弹窗（global 域无项目上下文，不走 /projects 路由），
     复用板12 信息密度（主图/占位 + 名称 + 类型 + 标签 + 简介 + 媒体版本列表），
     动作：导入为个人资产（Sol 侧接口未接通时人话降级）/ 引用到项目（项目选择 + 图片版本护栏）。
   纯逻辑全部在 asset-shared.tsx（node:test 只 import 那个文件）；本文件不引样式：
   视图层走 Tailwind utility + components/ui 原语（色调渐变沿用 styles.css 的 .asset-tone-*，
   ReviewPill 复用 review-panels，其样式随该组件链加载）。
   ============================================================ */

import {
  Bank,
  Camera,
  Check,
  Cube,
  Diamond,
  ImageSquare,
  Images,
  Mountains,
  MusicNote,
  PawPrint,
  ShareNetwork,
  Sparkle,
  SpeakerHigh,
  SpinnerGap,
  Sun,
  TShirt,
  User,
  UserPlus,
  VideoCamera,
} from "@phosphor-icons/react";
import * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { ApiClientError, api, type TieredGenerationSubmissionInput } from "../api";
import { newId } from "../uuid";
import { isImageReferenceMedia } from "../asset-media";
import { demoProjects, demoVersions } from "../demo";
import { listCapabilityTiers, resolveSelectedTier, tierLabel, tierSubmitInput, type CapabilityTier } from "../capability-tiers";
import { formatCreditsWithUnit } from "../cost-units";
import type { Asset, MediaVersion, Project } from "../types";
import { assetKindLabel, assetKindRawTitle, assetName, findImageUrl, useResource } from "../ui";
import { businessErrorMessage } from "../error-copy";
import { assetTypeLine } from "./asset-upload-modal";
import {
  IMPORT_PERSONAL_PENDING_MESSAGE,
  NO_IMAGE_MEDIA_MESSAGE,
  REVIEW_BUCKET_EXPLAIN,
  REVIEW_LEGEND_BUCKETS,
  REVIEW_LEGEND_NOTE,
  applyTagSuggestion,
  assetDetailPreviewVersion,
  assetRawNameNote,
  importPersonalFailureMessage,
  primaryImageVersion,
  referencedToProjectMessage,
} from "./asset-shared";
import { ReviewPill } from "./review-panels";
import { reviewBucketLabel, type AssetReviewBucket } from "./review-actions";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Badge, Field, Input, Select, Textarea } from "./ui/primitives";

type Notify = (message: string, kind?: "info" | "success" | "error") => void;

/* ---------- 按类型的占位图标（05 稿：角色/服装/场景/道具/声效各有图形，不给裸灰块） ---------- */

const KIND_ICONS: Record<string, typeof User> = {
  character: User,
  scene: Mountains,
  prop: Diamond,
  costume: TShirt,
  clothing: TShirt,
  lighting: Sun,
  camera: Camera,
  video: VideoCamera,
  audio: SpeakerHigh,
  sound: SpeakerHigh,
  music: MusicNote,
  animal: PawPrint,
  keyword: Images,
  keyframe: Images,
  reference: Bank,
  other: Bank,
  model_3d: Cube,
};

function kindIcon(kind?: string | null): typeof User {
  return KIND_ICONS[(kind ?? "").trim()] ?? ImageSquare;
}

function assetTone(asset?: Asset): number {
  const value = asset?.id || asset?.name || "asset";
  return Array.from(value).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5;
}

/**
 * 卡片/详情主图：有图出图，无图出「类型图标 + 色调」占位（可配一行说明，如「主图 · 共 3 张」）。
 * 占位也是 button 内容的一部分——无图不等于不可点（任务 4.1）。
 * 填满父容器（父级给定高/宽高比）；渐变占位沿用 styles.css 的 .asset-tone-*。
 */
export function AssetKindThumb({ asset, large, note }: { asset: Asset; large?: boolean; note?: string }): React.JSX.Element {
  const url = findImageUrl(asset);
  if (url) return <img className={cn("h-full w-full", large ? "object-contain" : "object-cover")} src={url} alt={assetName(asset)} loading="lazy" />;
  const fallback = <AssetKindPlaceholder asset={asset} large={large} note={note} />;
  const videoMedia = assetVideoPreviewMedia(asset);
  const videoUrl = videoMedia ? assetVideoPreviewUrl(videoMedia) : "";
  if (videoMedia && videoUrl) {
    return (
      <AssetPlayableElement
        asset={asset}
        className={cn("h-full w-full bg-black", large ? "object-contain" : "object-cover")}
        kind="video"
        media={videoMedia}
        muted
        playsInline
        preload="metadata"
        sourceUrl={videoUrl}
        label={`视频预览：${assetName(asset)}`}
        fallback={fallback}
      />
    );
  }
  return fallback;
}

function AssetKindPlaceholder({ asset, large, note }: { asset: Asset; large?: boolean; note?: string }): React.JSX.Element {
  const Icon = kindIcon(asset.asset_kind);
  return (
    <div className={`flex h-full w-full flex-col items-center justify-center gap-1 text-ink-2 asset-tone-${assetTone(asset)}`}>
      <Icon className={large ? "size-10" : "size-6"} aria-hidden="true" />
      <span className="text-xs" title={assetKindRawTitle(asset.asset_kind)}>{assetKindLabel(asset.asset_kind)}</span>
      {note ? <span className="text-xs text-success">{note}</span> : null}
    </div>
  );
}

function assetVideoPreviewMedia(asset: Asset): MediaVersion | null {
  const media = asset.current_media ?? asset.selected_media ?? null;
  if (mediaVersionKind(media ?? { id: "" }) !== "video") return null;
  return media;
}

function assetVideoPreviewUrl(media: MediaVersion): string {
  return mediaVersionPlayableUrl(media?.storage_url, media?.thumbnail_url, media?.source_file_url, media?.download_url);
}

function AssetPlayableElement({
  asset,
  media,
  sourceUrl,
  className,
  controls,
  kind,
  muted,
  playsInline,
  preload,
  label,
  fallback = null,
}: {
  asset: Asset;
  media: MediaVersion;
  sourceUrl: string;
  className: string;
  controls?: boolean;
  kind: "video" | "audio";
  muted?: boolean;
  playsInline?: boolean;
  preload?: "none" | "metadata" | "auto";
  label: string;
  fallback?: React.JSX.Element | null;
}): React.JSX.Element | null {
  const [signedUrl, setSignedUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const needsSignedUrl = isProtectedAssetMediaDownloadUrl(sourceUrl);

  useEffect(() => {
    let alive = true;
    setSignedUrl("");
    setFailed(false);
    if (!needsSignedUrl) return () => {
      alive = false;
    };
    api.assetMediaPreviewUrl(asset.id, media.id)
      .then((url) => {
        if (alive) setSignedUrl(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [asset.id, media.id, needsSignedUrl, sourceUrl]);

  const playableUrl = needsSignedUrl ? signedUrl : sourceUrl;
  if (!playableUrl || failed) return fallback;
  if (kind === "audio") {
    return (
      <audio
        className={className}
        src={playableUrl}
        controls={controls}
        preload={preload}
        aria-label={label}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <video
      className={className}
      src={playableUrl}
      controls={controls}
      muted={muted}
      playsInline={playsInline}
      preload={preload}
      aria-label={label}
      onError={() => setFailed(true)}
    />
  );
}

function isProtectedAssetMediaDownloadUrl(value: string): boolean {
  return /^\/api\/v1\/assets\/[^/]+\/media\/[^/]+\/download(?:[?#].*)?$/u.test(value);
}

/* ---------- 审核四态图例行（06 稿：四色点 + 尾注；每点 tooltip 解释该态含义） ---------- */

const BUCKET_DOT: Record<AssetReviewBucket, string> = {
  auto: "bg-accent",
  pending: "bg-warning",
  approved: "bg-success",
  rejected: "bg-danger",
};

export function ReviewLegend(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2" aria-label="审核状态说明">
      <span className="text-ink-4">审核状态</span>
      {REVIEW_LEGEND_BUCKETS.map((bucket) => (
        <span className="inline-flex cursor-help items-center gap-1" key={bucket} title={REVIEW_BUCKET_EXPLAIN[bucket]} aria-label={REVIEW_BUCKET_EXPLAIN[bucket]}>
          <i className={cn("size-1.5 shrink-0 rounded-full", BUCKET_DOT[bucket])} aria-hidden="true" />
          {reviewBucketLabel(bucket)}
        </span>
      ))}
      <span className="text-ink-4">{REVIEW_LEGEND_NOTE}</span>
    </div>
  );
}

/* ---------- HelpHint：标题旁「?」帮助浮层（说明收敛，不常驻刷屏） ---------- */

export function HelpHint({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  return (
    <span className="relative inline-flex" ref={hostRef}>
      <button
        type="button"
        className="inline-flex size-5 items-center justify-center rounded-full border border-border-1 text-[11px] text-ink-4 outline-none transition-colors hover:border-border-2 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((value) => !value)}
      >?</button>
      {open ? (
        <span className="absolute left-0 top-full z-40 mt-1 block w-80 max-w-[calc(100vw-2rem)] animate-fade-in rounded-md border border-border-2 bg-surface-1 p-3 text-xs leading-relaxed text-ink-2 shadow-lg" role="tooltip">
          {children}
        </span>
      ) : null}
    </span>
  );
}

/** 审核状态说明收进「?」浮层（S3 语言大扫除：四行说明不常驻）。 */
export function ReviewLegendHelp(): React.JSX.Element {
  return (
    <HelpHint label="审核状态说明">
      <span className="flex flex-col gap-2">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {REVIEW_LEGEND_BUCKETS.map((bucket) => (
            <span className="inline-flex items-center gap-1" key={bucket}>
              <i className={cn("size-1.5 shrink-0 rounded-full", BUCKET_DOT[bucket])} aria-hidden="true" />
              {reviewBucketLabel(bucket)}
            </span>
          ))}
        </span>
        <span>{REVIEW_LEGEND_NOTE}</span>
      </span>
    </HelpHint>
  );
}

/* ---------- Tag 筛选输入（bug6：「输入/选择 Tag」——combobox 建议下拉） ---------- */

/**
 * Tag 筛选 combobox：聚焦/输入展开建议，click/Enter 选中，↑↓ 导航，Esc 或外部 pointerdown 关闭。
 * suggestions 由调用方 useMemo 算好（tagSuggestionsFor(collectAssetTags(全量资产), value)），
 * 组件不重复过滤；选中即替换当前编辑段（applyTagSuggestion）并闭合，再敲逗号继续挑下一个。
 * Enter 只在有高亮建议时拦截——global 检索页输入框在 <form> 里，无高亮时表单提交照常。
 */
export function TagFilterInput({ icon, value, onChange, suggestions, placeholder, ariaLabel, className }: {
  icon?: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly string[];
  placeholder: string;
  ariaLabel: string;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const hostRef = useRef<HTMLSpanElement>(null);
  const listboxId = useId();
  const visible = open && suggestions.length > 0;

  /* 外部 pointerdown 关闭（捕获阶段，与 HelpHint 同手法） */
  useEffect(() => {
    if (!visible) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [visible]);

  /* 建议集随输入收窄时，把高亮夹回有效范围，防悬空 */
  useEffect(() => {
    setActiveIndex((current) => (current >= suggestions.length ? -1 : current));
  }, [suggestions]);

  function choose(tag: string): void {
    onChange(applyTagSuggestion(value, tag));
    setActiveIndex(-1);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + delta + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === "Enter") {
      const picked = visible && activeIndex >= 0 ? suggestions[activeIndex] : undefined;
      if (picked) {
        event.preventDefault();
        choose(picked);
      }
      return;
    }
    if (event.key === "Escape" && visible) {
      event.preventDefault();
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  return (
    <span className={cn("relative inline-flex items-center", className)} ref={hostRef}>
      {icon ? <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-4 [&_svg]:size-4" aria-hidden="true">{icon}</span> : null}
      <Input
        className={icon ? "pl-9" : undefined}
        value={value}
        role="combobox"
        aria-expanded={visible}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={visible && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
        onChange={(event) => { onChange(event.target.value); setOpen(true); setActiveIndex(-1); }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => { if (!hostRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false); }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      {visible ? (
        <span
          className="absolute left-0 top-full z-40 mt-1 flex max-h-64 w-full min-w-40 animate-fade-in flex-col gap-0.5 overflow-y-auto rounded-md border border-border-2 bg-surface-1 p-1 shadow-lg"
          role="listbox"
          id={listboxId}
          aria-label="Tag 建议"
        >
          {suggestions.map((tag, index) => (
            <button
              type="button"
              role="option"
              id={`${listboxId}-${index}`}
              aria-selected={index === activeIndex}
              className={cn(
                "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm transition-colors duration-150",
                index === activeIndex ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1",
              )}
              key={tag}
              /* mousedown 拦默认：点选项时输入框不丢焦，选择后还能继续敲 */
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(tag)}
              onMouseEnter={() => setActiveIndex(index)}
            >#{tag}</button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/* ---------- 条 11①：个人资产「生成图片」直达（不用先进项目；项目内归账仍要选一个项目） ---------- */

export function AssetGenerateDialog({ asset, demoMode, notify, onClose }: {
  asset: Asset;
  demoMode: boolean;
  notify: Notify;
  onClose: () => void;
}): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [prompt, setPrompt] = useState(asset.visual_prompt ?? "");
  const [tier, setTier] = useState<CapabilityTier | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateText, setEstimateText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  /* GENDOMAIN/X7 参考位:当前资产主图默认勾选作参考(可摘);勾选即带进 reference_media_ids。
     与详情弹窗同真源(assetVersions+primaryImageVersion),无图版本不渲染参考位。 */
  const versionState = useResource(
    () => api.assetVersions(asset.id),
    { items: demoVersions, count: demoVersions.length },
    demoMode,
    [asset.id],
  );
  const primaryVersion = primaryImageVersion(versionState.data?.items ?? []);
  const [usePrimaryAsRef, setUsePrimaryAsRef] = useState(true);
  const referenceMediaIds = usePrimaryAsRef && primaryVersion ? [primaryVersion.id] : [];
  /* S46 C-1：标题用展示名（与资产中心卡片一致）；name 字段不同才标注，防「两个名字像 bug」。 */
  const rawNameNote = assetRawNameNote(asset);

  useEffect(() => {
    if (demoMode) { setProjects(demoProjects); setProjectId(demoProjects[0]?.id ?? ""); return; }
    void api.projects().then((list) => {
      setProjects(list.items);
      setProjectId(list.items[0]?.id ?? "");
    }).catch(() => notify("项目列表读取失败，生成需要先选一个项目归账", "error"));
    void listCapabilityTiers("image", demoMode)
      .then((result) => setTier(resolveSelectedTier(result.tiers, null)))
      .catch(() => notify("生成档位读取失败，请稍后重试", "error"));
  }, [asset.id, demoMode, notify]);

  /* 红线不变：先估价（展示价格）→ 人工点「确认生成」才创建；一次点击只创建一个任务。 */
  async function estimate(): Promise<void> {
    if (!projectId || !tier || !prompt.trim()) { notify("先选项目并写一句画面描述", "error"); return; }
    if (demoMode) { setEstimateText("离线演示估价示例：60 积分"); return; }
    setEstimating(true);
    try {
      const { parameters, quantity } = tierSubmitInput(tier);
      const quote = await api.quoteGeneration({
        media_kind: "image",
        tier_id: tier.tier_id,
        project_id: projectId,
        target_asset_entity_id: asset.id,
        prompt: prompt.trim(),
        reference_media_ids: referenceMediaIds,
        parameters,
        quantity,
        client_idempotency_key: `asset-${asset.id}-image-${newId()}`,
      });
      setEstimateText(`估价 ${formatCreditsWithUnit(quote.estimated_cost_fen)}（确认才创建任务）`);
    } catch (reason) {
      notify(businessErrorMessage(reason, "估价失败，请重试"), "error");
    } finally { setEstimating(false); }
  }

  async function confirmAndCreate(): Promise<void> {
    if (!projectId || !tier || !prompt.trim()) return;
    if (demoMode) { notify("离线演示不会提交真实生成", "info"); return; }
    setSubmitting(true);
    try {
      const { parameters, quantity } = tierSubmitInput(tier);
      const input: TieredGenerationSubmissionInput = {
        media_kind: "image",
        tier_id: tier.tier_id,
        project_id: projectId,
        target_asset_entity_id: asset.id,
        prompt: prompt.trim(),
        reference_media_ids: referenceMediaIds,
        parameters,
        quantity,
        client_idempotency_key: `asset-${asset.id}-image-${newId()}`,
      };
      const quote = await api.quoteGeneration(input);
      const confirmed = await api.confirmGenerationQuote(quote.generation_quote_id);
      if (confirmed.generation_request_id) await api.generation(confirmed.generation_request_id);
      else await api.createGeneration(input, quote.generation_quote_id);
      notify(`生成任务已创建，产物会自动挂到「${assetName(asset)}」，进度在队列里看`, "success");
      onClose();
    } catch (reason) {
      notify(reason instanceof ApiClientError && reason.status === 403 ? "当前账号没有该项目创作权限，联系项目负责人授权" : businessErrorMessage(reason, "创建生成任务失败"), "error");
    } finally { setSubmitting(false); }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="small" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>给「{assetName(asset)}」生成图片</DialogTitle>
          <DialogDescription>
            估价后确认才创建任务；产物归到所选项目并挂回这个资产。
            {rawNameNote ? `（资产名称：${rawNameNote}）` : null}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4">
            <Field label="归账项目（产物挂这里）">
              <Select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </Select>
            </Field>
            <Field label="画面描述">
              <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="补充这版想要的画面；留资产默认描述也行" />
            </Field>
            {primaryVersion ? (
              <label className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-1" data-testid="asset-image-ref-slot">
                <input
                  type="checkbox"
                  checked={usePrimaryAsRef}
                  onChange={(event) => setUsePrimaryAsRef(event.target.checked)}
                />
                <img alt="" className="size-8 shrink-0 rounded-sm object-cover" src={primaryVersion.thumbnail_url || primaryVersion.storage_url || ""} />
                <span>带上当前主图作参考（去掉勾选则纯按文字生成）</span>
              </label>
            ) : null}
            <p className="text-xs text-ink-2">档位：{tier ? tierLabel(tier) : "读取中…"}</p>
            {estimateText ? <p className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-1" role="status">{estimateText}</p> : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" loading={estimating} onClick={() => void estimate()}>先估价</Button>
          <Button variant="primary" loading={submitting} disabled={!estimateText && !demoMode} title={!estimateText && !demoMode ? "先估价再确认生成" : undefined} onClick={() => void confirmAndCreate()}>确认生成</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- 资产中心详情弹窗（任务 4.1/4.2） ---------- */

export function AssetDetailModal({ asset, demoMode, notify, onClose, onImported }: {
  asset: Asset;
  demoMode: boolean;
  notify: Notify;
  onClose: () => void;
  /** 导入个人资产成功后回授，列表卡片据此更新状态（不打断当前查看）。 */
  onImported?: (asset: Asset) => void;
}): React.JSX.Element {
  const versionState = useResource(
    () => api.assetVersions(asset.id),
    { items: demoVersions, count: demoVersions.length },
    demoMode,
    [asset.id],
  );
  const versions = versionState.data?.items ?? [];
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [importError, setImportError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const tags = (asset.style_tags ?? []).filter(Boolean);
  const intro = asset.intro || asset.description || "";

  /** 导入为个人资产：成功 → toast + 卡片状态回授；404/501/网络错 → Sol 侧接入中人话（禁假装成功）。 */
  async function importToPersonal(): Promise<void> {
    if (importing || imported) return;
    if (demoMode) {
      notify("离线演示不会写入资产库；正式环境将复制一份到你的个人资产", "info");
      return;
    }
    setImporting(true);
    setImportError("");
    try {
      const created = await api.importAssetToPersonal(asset.id);
      setImported(true);
      onImported?.(created);
      notify(`已导入个人资产「${assetName(created)}」`, "success");
    } catch (reason) {
      setImportError(importPersonalFailureMessage(reason));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="wide" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{assetName(asset)}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="grid grid-cols-1 items-start gap-4 min-[860px]:grid-cols-[minmax(0,1fr)_300px]">
            <AssetDetailMediaViewer
              asset={asset}
              versions={versions}
              loading={versionState.loading}
              error={versionState.error}
              onRetry={versionState.retry}
            />
            <aside className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-ink-4">{assetTypeLine(asset)}</span>
                {asset.scope === "common" ? <ReviewPill status={asset.status} /> : null}
              </div>
              {tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {tags.slice(0, 6).map((tag) => <Badge tone="neutral" key={tag}>#{tag}</Badge>)}
                </div>
              ) : null}
              <p className="text-sm leading-relaxed text-ink-2">{intro || "暂无资产简介"}</p>
              <div className="flex flex-wrap gap-2">
                {asset.scope === "common" ? (
                  imported ? (
                    <span className="inline-flex items-center gap-1 py-2 text-sm text-success"><Check className="size-4" aria-hidden="true" />已导入个人资产</span>
                  ) : (
                    <Button icon={<UserPlus />} loading={importing} onClick={() => void importToPersonal()}>导入为个人资产</Button>
                  )
                ) : null}
                {asset.scope === "personal" ? (
                  <Button variant="outline" icon={<Sparkle />} onClick={() => setGenerateOpen(true)} title="不用先进项目：选好归账项目，估价确认后生成">生成图片</Button>
                ) : null}
                <Button variant="primary" icon={<ShareNetwork />} onClick={() => setPickerOpen((open) => !open)} aria-expanded={pickerOpen}>引用到项目</Button>
              </div>
              {importError ? (
                <p className="flex flex-wrap items-center gap-2 text-xs text-danger" role="alert">
                  {importError}
                  {importError === IMPORT_PERSONAL_PENDING_MESSAGE ? null : (
                    <button className="text-accent-text underline underline-offset-4" type="button" onClick={() => void importToPersonal()}>重试</button>
                  )}
                </p>
              ) : null}
              {pickerOpen ? (
                <ReferenceProjectPicker
                  asset={asset}
                  versions={versions}
                  versionsLoading={versionState.loading}
                  demoMode={demoMode}
                  notify={notify}
                  onDone={onClose}
                />
              ) : null}
              {asset.scope === "common" ? (
                <p className="text-xs text-ink-4">通用资产已锁定不可编辑；导入个人资产或引用到项目后可在对应上下文编辑。</p>
              ) : null}
            </aside>
          </div>
        </DialogBody>
      </DialogContent>
      {generateOpen ? <AssetGenerateDialog asset={asset} demoMode={demoMode} notify={notify} onClose={() => setGenerateOpen(false)} /> : null}
    </Dialog>
  );
}

export function AssetDetailMediaViewer({ asset, versions, loading, error, onRetry }: {
  asset: Asset;
  versions: MediaVersion[];
  loading: boolean;
  error: string;
  onRetry: () => void;
}): React.JSX.Element {
  const [previewVersionId, setPreviewVersionId] = useState("");
  const previewVersion = assetDetailPreviewVersion(versions, previewVersionId);

  useEffect(() => {
    setPreviewVersionId("");
  }, [asset.id]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="aspect-[16/10] overflow-hidden rounded-lg border border-border-1 bg-surface-well">
        {previewVersion ? (
          <AssetDetailPreview version={previewVersion} asset={asset} />
        ) : (
          <AssetKindThumb asset={asset} large note={`共 ${versions.length} 个媒体版本`} />
        )}
      </div>
      {loading ? (
        <p className="flex items-center gap-1 text-xs text-ink-4">
          <SpinnerGap className="size-3.5 animate-spin" aria-hidden="true" />
          读取媒体版本…
        </p>
      ) : error ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-danger" role="alert">
          媒体版本读取失败
          <button className="text-accent-text underline underline-offset-4" type="button" onClick={onRetry}>重试</button>
        </p>
      ) : versions.length === 0 ? (
        <p className="text-xs text-ink-4">还没有媒体版本；上传图片后会显示在这里。</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2" role="list" aria-label="媒体版本列表">
          {versions.map((version, index) => (
            <figure
              className={cn(
                "m-0 overflow-hidden rounded-md border bg-surface-2",
                previewVersionId === version.id ? "border-accent ring-1 ring-accent" : "border-border-1",
              )}
              key={version.id}
              role="listitem"
            >
              <button
                className="block w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                type="button"
                aria-label={`预览${version.title?.trim() || `版本 ${index + 1}`}`}
                aria-pressed={previewVersionId === version.id}
                onClick={() => setPreviewVersionId(version.id)}
              >
                <VersionThumb version={version} asset={asset} />
              </button>
              <figcaption className="flex items-center justify-between gap-1 truncate px-2 py-1 text-xs text-ink-2">
                {version.title?.trim() || `版本 ${index + 1}`}
                {version.is_primary ? <em className="shrink-0 font-semibold not-italic text-accent-text">主图</em> : null}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

function AssetDetailPreview({ version, asset }: { version: MediaVersion; asset: Asset }): React.JSX.Element {
  const kind = mediaVersionKind(version);
  const sourceUrl = mediaVersionPlayableUrl(version.storage_url, version.source_file_url, version.download_url);
  const imageUrl = mediaVersionPlayableUrl(
    version.storage_url,
    version.thumbnail_url,
    version.source_file_url,
    version.download_url,
  );
  const title = version.title?.trim() || assetName(asset);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [version.id, sourceUrl, imageUrl]);

  if (failed) return <MediaVersionPlaceholder version={version} asset={asset} />;
  if (kind === "image" && isImageReferenceMedia(version)) {
    if (!imageUrl) return <MediaVersionPlaceholder version={version} asset={asset} />;
    return (
      <img
        className="h-full w-full object-contain"
        src={imageUrl}
        alt={title}
        onError={() => setFailed(true)}
      />
    );
  }
  if (kind === "video" && sourceUrl) {
    return (
      <AssetPlayableElement
        asset={asset}
        className="h-full w-full object-contain"
        kind="video"
        media={version}
        controls
        preload="metadata"
        sourceUrl={sourceUrl}
        label={`预览视频：${title}`}
        fallback={<MediaVersionPlaceholder version={version} asset={asset} />}
      />
    );
  }
  if (kind === "audio" && sourceUrl) {
    return (
      <div className={`flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-ink-2 asset-tone-${assetTone(asset)}`}>
        <SpeakerHigh className="size-10" aria-hidden="true" />
        <span className="text-sm">{title}</span>
        <AssetPlayableElement
          asset={asset}
          className="w-full max-w-lg"
          kind="audio"
          media={version}
          controls
          preload="none"
          sourceUrl={sourceUrl}
          label={`播放音频：${title}`}
          fallback={<span className="text-xs text-ink-4">音频预览地址暂不可用</span>}
        />
      </div>
    );
  }
  return <MediaVersionPlaceholder version={version} asset={asset} />;
}

function mediaVersionPlayableUrl(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const value = candidate?.trim() ?? "";
    if (
      /^https?:\/\//i.test(value)
      || value.startsWith("/")
      || value.startsWith("blob:")
      || /^data:(?:image|video|audio)\//i.test(value)
    ) {
      return value;
    }
  }
  return "";
}

function mediaVersionKind(version: MediaVersion): "image" | "video" | "audio" | "model_3d" | "other" {
  const mediaKind = version.media_kind?.trim().toLowerCase();
  const format = version.format?.trim().toLowerCase();
  if (mediaKind === "model_3d" || format === "glb") return "model_3d";
  if (mediaKind === "video") return "video";
  if (mediaKind === "audio") return "audio";
  if (!mediaKind || mediaKind === "image") return "image";
  return "other";
}

function mediaVersionPresentation(version: MediaVersion, asset: Asset): { Icon: typeof User; label: string } {
  const kind = mediaVersionKind(version);
  if (kind === "model_3d") return { Icon: Cube, label: "3D 素模" };
  if (kind === "video") return { Icon: VideoCamera, label: "视频" };
  if (kind === "audio") return { Icon: SpeakerHigh, label: "音频" };
  if (kind === "image") return { Icon: ImageSquare, label: "图片" };
  return { Icon: kindIcon(asset.asset_kind), label: "媒体版本" };
}

function MediaVersionPlaceholder({ version, asset }: { version: MediaVersion; asset: Asset }): React.JSX.Element {
  const { Icon, label } = mediaVersionPresentation(version, asset);
  const title = version.title?.trim() || label;
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center gap-2 text-ink-2 asset-tone-${assetTone(asset)}`}
      role="img"
      aria-label={`${label}：${title}`}
    >
      <Icon className="size-10" aria-hidden="true" />
      <span className="text-sm">{title}</span>
      <span className="text-xs text-ink-4">{label}</span>
    </div>
  );
}

function VersionThumb({ version, asset }: { version: MediaVersion; asset: Asset }): React.JSX.Element {
  /* S46 C-0：非图片媒体版本（glb 等）不出 <img>，走资产类型图标（3D 素模→Cube）。 */
  const url = isImageReferenceMedia(version)
    ? mediaVersionPlayableUrl(version.storage_url, version.thumbnail_url, version.source_file_url, version.download_url)
    : "";
  if (url) return <img className="aspect-[4/3] w-full object-cover" src={url} alt={version.title || assetName(asset)} loading="lazy" />;
  const { Icon } = mediaVersionPresentation(version, asset);
  return (
    <div className={`flex aspect-[4/3] w-full items-center justify-center text-ink-2 asset-tone-${assetTone(asset)}`}>
      <Icon className="size-4" aria-hidden="true" />
    </div>
  );
}

/** 引用到项目：项目选择（用户项目列表）→ 确认后 addProjectAsset；无图片版本时明示并禁止提交。 */
function ReferenceProjectPicker({ asset, versions, versionsLoading, demoMode, notify, onDone }: {
  asset: Asset;
  versions: MediaVersion[];
  versionsLoading: boolean;
  demoMode: boolean;
  notify: Notify;
  onDone: () => void;
}): React.JSX.Element {
  const projectState = useResource(
    () => api.projects(),
    { items: demoProjects, count: demoProjects.length },
    demoMode,
    [],
  );
  const [selectedId, setSelectedId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const projects = projectState.data?.items ?? [];
  const primary = primaryImageVersion(versions);
  const selected = projects.find((project) => project.id === selectedId) ?? null;

  async function submit(): Promise<void> {
    if (!selected || submitting) return;
    if (demoMode) {
      notify("离线演示不会创建项目引用；正式环境将挂到所选项目", "info");
      return;
    }
    // 护栏：3D 素模/声效等无图片媒体版本的资产不能提交（后端要求图片媒体，否则 asset_media_required）。
    if (!primary) return;
    setSubmitting(true);
    try {
      await api.addProjectAsset(selected.id, asset.id, primary.id);
      notify(referencedToProjectMessage(selected.name), "success");
      onDone();
    } catch (reason) {
      notify(businessErrorMessage(reason, "引用到项目失败，请重试"), "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-1 bg-surface-2 p-3">
      <strong className="text-sm text-ink-1">选择要引用的项目</strong>
      {projectState.loading ? (
        <p className="flex items-center gap-1 text-xs text-ink-4">
          <SpinnerGap className="size-3.5 animate-spin" aria-hidden="true" />
          读取项目列表…
        </p>
      ) : projectState.error ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-danger" role="alert">
          项目列表读取失败
          <button className="text-accent-text underline underline-offset-4" type="button" onClick={projectState.retry}>重试</button>
        </p>
      ) : projects.length === 0 ? (
        <p className="text-xs text-ink-4">还没有项目；先到项目管理建一部剧。</p>
      ) : (
        <div className="flex max-h-[220px] flex-col gap-1 overflow-y-auto" role="radiogroup" aria-label="选择项目">
          {projects.map((project: Project) => (
            <button
              type="button"
              role="radio"
              aria-checked={selectedId === project.id}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors duration-150",
                selectedId === project.id ? "border-accent bg-accent-subtle" : "border-transparent hover:border-border-2",
              )}
              key={project.id}
              onClick={() => setSelectedId(project.id)}
            >
              <strong className="text-sm font-medium text-ink-1">{project.name}</strong>
              <span className="shrink-0 text-xs text-ink-4">{project.episode_count ?? 0} 集 · {project.status || "进行中"}</span>
            </button>
          ))}
        </div>
      )}
      {versionsLoading ? null : primary ? null : (
        <p className="text-xs text-warning" role="status">{NO_IMAGE_MEDIA_MESSAGE}</p>
      )}
      <div className="flex justify-end">
        <Button
          variant="primary"
          icon={<ShareNetwork />}
          loading={submitting}
          disabled={!selected || versionsLoading || !primary}
          title={!primary ? NO_IMAGE_MEDIA_MESSAGE : selected ? `引用到 ${selected.name}` : "先选择一个项目"}
          onClick={() => void submit()}
        >确认引用</Button>
      </div>
    </div>
  );
}
