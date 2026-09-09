/* ⚠️ StoryboardPage 退役中(块 2,2026-08-03):旧分镜列表页(枢纽页)已从路由摘除,
   /storyboards 深链由 StoryboardsRedirect 换乘到生产页。本文件其余页面(资产详情/项目资产)仍现役。
   StoryboardPage 及其私有件的源码级合同随块 3 逐功能迁移,迁完才从本文件摘除。禁止新增 StoryboardPage 引用。 */
import {
  Archive,
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  Bank,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  Checks,
  ClipboardText,
  CloudArrowUp,
  Cube,
  Diamond,
  DotsThree,
  DownloadSimple,
  Export,
  FileXls,
  FilmSlate,
  FilmStrip,
  FolderSimple,
  ImageSquare,
  ImagesSquare,
  Info,
  Link,
  ListPlus,
  MagicWand,
  MagnifyingGlass,
  PaperPlaneTilt,
  PlayCircle,
  Plus,
  Sparkle,
  SpeakerHigh,
  Star,
  Sun,
  TShirt,
  Trash,
  UploadSimple,
  User,
  VideoCamera,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
/* 显式 React import：门禁（node:test + tsx classic JSX）渲染断言与 Vite react-jsx 双兼容
   （同 ui.tsx / production-stepper.tsx 的既有写法；K2I 起本文件被 k2i-bible-note.test.ts 直接 import）。 */
import * as React from "react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, api, assetFromUnknown } from "../api";
import { capabilityErrorCopy } from "../capability-status";
import {
  AGE_BAND_OPTIONS,
  ASSET_KIND_OPTIONS,
  AssetKindSelectOptions,
  DOWNLOAD_ALL_LIMIT_NOTE,
  GENDER_OPTIONS,
  PROJECT_ASSET_MENU_ITEMS,
  REVIEW_BUCKET_EXPLAIN,
  SOUND_GENERATE_MESSAGE,
  SOUND_UPLOAD_MESSAGE,
  ageBandMatches,
  assetKindMatches,
  assetPositionLine,
  assetTagMatches,
  assetTextMatches,
  collectAssetTags,
  formatAssetCardSummary,
  genderMatches,
  ingestAssetVerified,
  roleForAssetKind,
  summarizeAssetVersions,
  tagSuggestionsFor,
  type AssetVersionSummary,
  type ProjectAssetMenuItem,
} from "../components/asset-shared";
import { AssetKindThumb, HelpHint, ReviewLegendHelp, TagFilterInput } from "../components/asset-widgets";
import {
  AssetUploadModal,
  assetImagePrompt,
  assetMetadataWithImagePrompt,
  assetReferenceLines,
  assetTypeLine,
  groupAssetVersions,
  introduceAction,
  normalizeStyleTags,
  projectAssetAddReducer,
  projectAssetReferenceLine,
  projectAssetRemoveReducer,
  viewLabelForVersion,
  type AssetUploadInput,
  type AssetVariantGroup,
} from "../components/asset-upload-modal";
import {
  REVIEW_FILTER_OPTIONS,
  SUBMIT_BATCH_LIMIT,
  applyDemoAssetDecision,
  applyDemoAssetSubmissions,
  assetReviewBucket,
  demoReviewHint,
  formatSubmitSummary,
  isTerminalStateConflict,
  reviewFilterMatches,
  reviewHintFromRecords,
  submitBatchError,
  submitResultLine,
  summarizeSubmitResults,
  withDemoReviewStatus,
  type AssetReviewBucket,
  type ReviewHint,
  type SubmitSummary,
} from "../components/review-actions";
import { DemoExportPreviewDialog, type DemoExportKind } from "../components/demo-export-preview";
import {
  RejectReasonModal,
  ReviewPolicyMenuItems,
  ReviewPill,
  ReviewTrailPanel,
  ReviewTrailToggle,
} from "../components/review-panels";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  RoleBadge,
  Select,
  Skeleton,
  Textarea,
  Tooltip,
} from "../components/ui/primitives";
import {
  DEMO_EPISODE_SCENES,
  DEMO_SHOT_SCENES,
  demoBreakdownRequirements,
  demoCommonAssets,
  demoEpisodesForProject,
  demoPersonalAssets,
  demoProjectAssetsForProject,
  demoProjectById,
  demoShotMediaForShot,
  demoShots,
  demoStoryboardImportPreview,
  demoVersions,
} from "../demo";
import { demoDeliveriesPage } from "../demo-review-delivery";
import { EpisodeDeliveryModal, MediaReviewQueueModal } from "../components/review-delivery-panels";
import { isRecord } from "../generation-quotes";
import {
  forgetGenerationRequest,
  listGenerationRequests,
  shotGenerationBadge,
  shotGenerationBadgeText,
  type ShotGenerationBadge,
  type TrackedGenerationRequest,
} from "../generation-task-recovery";
import { createRehearsalRun, newRehearsalIdempotencyKey } from "../requirement-breakdown";
import { navigate, projectDirectorPath, projectRequirementBreakdownPath, projectStoryboardPath, shotWorkbenchPath } from "../routing";
import { loadReadyMarks, type ReadyMark } from "../shot-ready";
import { canConfirmStoryboardImport, sceneBindingTrialKey, storyboardIssues, trialSceneBindings } from "../storyboard";
import type { SceneBindingTrial } from "../storyboard";
import type { Asset, AssetReviewItem, AssetSearchResult, Episode, GenerationMediaKind, GenerationTask, JsonAssetIngestItem, JsonRecord, MediaVersion, ProjectAssetRef, Scene, Shot, StoryboardImportRecord, StoryboardPreviewRow } from "../types";
import {
  AssetThumb,
  Modal,
  StatusBadge,
  assetKindLabel,
  assetKindRawTitle,
  assetName,
  formatDateTime,
  useResource,
} from "../ui";
import { businessErrorMessage } from "../error-copy";
import {
  BatchImageGenerateDrawer,
  BatchVideoGenerateDrawer,
  episodeGroup,
  referenceMediaIdsFromRefs,
  selectedMediaForKind,
  shotDisplayName,
} from "./batch-generate-drawer";
import type { PageRuntimeProps } from "./global-pages";
import { canCreateInProject, canModerateCommonAssets } from "../operations";
import { capabilityGate, platformRoleForCopy } from "../capabilities-state";
import { CapabilityActionSlot } from "../components/capability-notice";
import { EpisodePlaybackModal } from "./operations-pages";
import { ProjectAssetsMakeupSections } from "./project-assets-makeup";
/* 视图层全部 Tailwind v4（tw.css token）+ components/ui 原语，无页面级 CSS 文件；
   AssetKindThumb/ReviewLegend（asset-widgets，他组）同为 Tailwind 版，样式随组件链加载。 */

/** 音色浏览独立分包：TimbreBrowser 真连语音接口，不随主资产页 bundle 一起下发。 */
const TimbreBrowserLazy = lazy(() =>
  import("../components/timbre-browser").then((module) => ({ default: module.TimbreBrowser })),
);

/* ============================================================
   P2 资产域（板12 资产详情与弹窗群 / 板13 项目资产）
   纯函数在 components/asset-upload-modal.tsx（src/p1-assets.test.ts 直接覆盖），
   视图层 = Tailwind v4（tw.css token）+ components/ui 原语。本文件只负责渲染与事件编排。
   ============================================================ */

/* ---------- 板14 加载态：骨架屏超过 8s 显示「仍在加载 · 重试」，禁止无限转圈 ---------- */

function useSlowLoading(active: boolean, ms = 8_000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);
  return slow;
}

function SlowLoadingNote({ show, onRetry }: { show: boolean; onRetry: () => void }): React.JSX.Element | null {
  if (!show) return null;
  return (
    <p className="flex items-center justify-center gap-2 text-xs text-ink-4">
      仍在加载 ·
      <button type="button" className="font-semibold text-accent-text hover:underline" onClick={onRetry}>重试</button>
    </p>
  );
}

/* ---------- 视图层共享配方（旧 styles.css 全局类的 Tailwind 复刻） ---------- */

/** 旧 .inline-note：说明性提示条。 */
const inlineNoteClass = "rounded-sm border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2";

/** 旧 .form-error：表单级错误条。 */
const formErrorClass = "rounded-sm border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger";

/** 旧 .tag：#标签小件。 */
const tagChipClass = "inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2";

/** 带下拉箭头的 Select（Select 原语 appearance-none，箭头由这里补上）。 */
function ChevronSelect({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <Select className="w-full" {...props}>{children}</Select>
      <CaretDown className="pointer-events-none absolute right-2.5 size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
    </span>
  );
}

/** 带图标的搜索输入（旧 .search-input 的 Tailwind 版）。 */
function SearchInput({ icon, value, onChange, placeholder, ariaLabel, className }: {
  icon: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn("relative inline-flex items-center", className)}>
      <span className="pointer-events-none absolute left-3 text-ink-4 [&_svg]:size-4" aria-hidden="true">{icon}</span>
      <Input className="pl-9" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={ariaLabel} />
    </span>
  );
}

/** 旧 .segmented-control 的 active 配方（surface-2 填充）。 */
function segmentedClass(active: boolean): string {
  return cn(
    "rounded-sm px-3 py-1.5 text-sm transition-colors duration-150 ease-out-quart",
    active ? "bg-surface-2 font-semibold text-ink-1" : "text-ink-2 hover:text-ink-1",
  );
}

/** 旧 .p2-picker-tabs 的 active 配方（accent 淡底）。 */
function pickerTabClass(active: boolean): string {
  return cn(
    "rounded-sm px-3 py-1.5 text-sm transition-colors duration-150 ease-out-quart",
    active ? "bg-accent-subtle font-semibold text-accent-text" : "text-ink-2 hover:text-ink-1",
  );
}

const segmentedControlClass = "inline-flex items-center gap-0.5 rounded-md border border-border-1 bg-surface-0 p-0.5";

/* ---------- 板12/13 demo fixture：变体/视图/引用走与真实数据相同的推导路径（metadata 约定） ---------- */

const P2_DEMO_ASSET_PATCH: Record<string, Partial<Asset>> = {
  "asset-ren": {
    intro: "钦差官服装，主角视觉锚点；青年，人族。剑眉星目，银甲外披玄色大氅。",
    style_tags: ["男主参考", "古装", "青年"],
    metadata: {
      category: "男主参考",
      image_prompt: "中国古装战争剧男主，16:9 三视图，银甲玄氅，高反差侧光……",
      reference_bindings: [
        { project_id: "demo-project-2", project_name: "《杀穿女频》", episode_nos: [1, 2], shot_count: 6 },
        { project_name: "《回到1998》", episode_nos: [], shot_count: null },
      ],
    },
  },
  "asset-lin": {
    display_name: "李承瑶",
    status: "ready",
    metadata: {
      reference_bindings: [
        { project_id: "demo-project-2", project_name: "《杀穿女频》", episode_nos: [1], shot_count: 4 },
      ],
    },
  },
  "asset-harbor": {
    display_name: "北疆战场黄昏",
    status: "pending",
    metadata: {
      reference_bindings: [
        { project_id: "demo-project-2", project_name: "《杀穿女频》", episode_nos: [1], shot_count: null },
      ],
    },
  },
};

/** 板12 demo 版本：实体级 5 视图 + 「铠甲染血」「官服」两个变体组，命名走 metadata 约定。 */
const P2_DEMO_VERSIONS: Record<string, MediaVersion[]> = {
  "asset-ren": [
    { id: "demo-v-ren-full", media_kind: "image", title: "骑马 · 全身", is_primary: false, status: "ready", metadata: { view_angle: "骑马 · 全身" } },
    { id: "demo-v-ren-lowlight", media_kind: "image", title: "夜戏 · 低光", is_primary: false, status: "ready", metadata: { view_angle: "夜戏 · 低光" } },
    { id: "demo-v-ren-front", media_kind: "image", title: "三视图 · 正", is_primary: true, status: "ready", metadata: { view_angle: "三视图 · 正" } },
    { id: "demo-v-ren-side", media_kind: "image", title: "三视图 · 侧", is_primary: false, status: "ready", metadata: { view_angle: "三视图 · 侧" } },
    { id: "demo-v-ren-closeup", media_kind: "image", title: "特写", is_primary: false, status: "ready", metadata: { view_angle: "特写" } },
    { id: "demo-v-ren-armor-1", asset_variant_id: "demo-var-armor", media_kind: "image", title: "铠甲染血 · 全身", is_primary: true, status: "ready", metadata: { variant_name: "铠甲染血", view_angle: "全身" } },
    { id: "demo-v-ren-armor-2", asset_variant_id: "demo-var-armor", media_kind: "image", title: "铠甲染血 · 特写", is_primary: false, status: "ready", metadata: { variant_name: "铠甲染血", view_angle: "特写" } },
    { id: "demo-v-ren-robe-1", asset_variant_id: "demo-var-robe", media_kind: "image", title: "官服 · 正", is_primary: true, status: "ready", metadata: { variant_name: "官服", view_angle: "正面" } },
  ],
  /* P-07 验收基准:白发师父只有特写(大头照),缺全身照=1/2。 */
  "demo-asset-master": [
    { id: "demo-v-master-closeup", media_kind: "image", title: "特写", is_primary: true, status: "ready", metadata: { view_angle: "特写" } },
  ],
};

function p2DemoAsset(assetId: string): Asset {
  const base = [...demoPersonalAssets, ...demoCommonAssets].find((item) => item.id === assetId) ?? demoPersonalAssets[0]!;
  const patch = P2_DEMO_ASSET_PATCH[base.id];
  return patch ? { ...base, ...patch } : base;
}

function p2DemoVersions(assetId: string): MediaVersion[] {
  return P2_DEMO_VERSIONS[assetId] ?? demoVersions;
}

/** 板13 demo 项目资产：补 project_reference_id（修正旧版 demo 无法演示移出的问题）+ 引用/名称补丁。 */
function p2DemoProjectAsset(ref: ProjectAssetRef): Asset {
  const base = refAsset(ref);
  const patch = P2_DEMO_ASSET_PATCH[base.id];
  const patched = patch ? { ...base, ...patch } : base;
  return {
    ...patched,
    display_name: patched.id === "asset-ren" ? "任天野（铠甲）" : patched.display_name,
    scope: "project",
    project_id: ref.project_id ?? "demo-project-2",
    project_reference_id: ref.id,
  };
}

/* ============================================================
   板13 项目资产页 — 引入与集绑定 + W5-A 审核四态流转
   开发对照（原型板13 附注）：
   - 引入 = 建立 project_reference（api.addProjectAsset），移出 = DELETE reference（api.removeProjectAsset），不动资产本体；
   - 集级绑定 = 分镜管理页「使用资产」pills 的本页集视图（同一份 projectAssets 数据的两个视角）；
   - 审核域已接真接口（/reviews/*）：批量提审（多选 ≤50）、pending 卡裁决、自动待审开关（乐观锁 409 刷新）、
     轨迹 info 展开；四态 pill/筛选/摘要聚合等纯函数在 components/review-actions.tsx。
   W5.5（Dario #8，对照 06 稿）：类型页签带计数 / 四态图例行 / 「更多」菜单 /
   六条件筛选行 / 卡片定位行+#tag+版本摘要 / 「批量提审」「回收站」入标题行。
   ============================================================ */

/** 「更多」菜单图标（项定义在 components/asset-shared，图标只从 phosphor 取）。 */
const MENU_ITEM_ICONS: Record<string, React.JSX.Element> = {
  "create-character": <User aria-hidden="true" />,
  "create-scene": <Bank aria-hidden="true" />,
  "create-prop": <Diamond aria-hidden="true" />,
  "create-costume": <TShirt aria-hidden="true" />,
  "create-lighting": <Sun aria-hidden="true" />,
  "create-camera": <Camera aria-hidden="true" />,
  "create-video": <VideoCamera aria-hidden="true" />,
  "sound-generate": <SpeakerHigh aria-hidden="true" />,
  "sound-upload": <UploadSimple aria-hidden="true" />,
  refresh: <ArrowClockwise aria-hidden="true" />,
  "download-all": <DownloadSimple aria-hidden="true" />,
};

export function ProjectAssetsPage({ projectId, demoMode, notify, user, capabilities }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  const demoAssets = useMemo(
    () => demoProjectAssetsForProject(projectId).map((ref) => {
      const asset = p2DemoProjectAsset(ref);
      return asset.scope === "common" ? withDemoReviewStatus(asset) : asset;
    }),
    [projectId],
  );
  const { data, loading, error, retry, setData } = useResource(
    () => api.assets({ scope: "project", projectId }),
    { items: demoAssets, count: demoAssets.length },
    demoMode,
    [projectId, demoAssets],
  );
  const slowLoading = useSlowLoading(loading);
  const [showAdd, setShowAdd] = useState(false);
  /* 音色浏览弹窗：项目资产页没有生成上下文（没有集/场/镜），选中音色目前只能诚实地
     指引去段落工作台用（onSelect 落在那里才真有归宿——写进「音频」参考组）。 */
  const [showTimbreBrowser, setShowTimbreBrowser] = useState(false);
  const [removingId, setRemovingId] = useState("");
  /* S7-13：动作反馈——引入/裁决/提审回包后目标卡一次性高亮（vw-tl-lit 600ms，复用导演台点亮关键帧） */
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(new Set());
  const [ingesting, setIngesting] = useState(false);
  const ingestInput = useRef<HTMLInputElement>(null);
  /* W5-A 审核域：筛选 / 多选 / 提审结果 / 裁决 / 轨迹展开 / 卡片提示行 */
  const [reviewFilter, setReviewFilter] = useState<AssetReviewBucket | "">("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [submitSummary, setSubmitSummary] = useState<{ summary: SubmitSummary; lines: string[] } | null>(null);
  const [decidingId, setDecidingId] = useState("");
  const [rejectTarget, setRejectTarget] = useState<Asset | null>(null);
  const [openTrailId, setOpenTrailId] = useState("");
  const [reviewHints, setReviewHints] = useState<Record<string, ReviewHint>>(() => (
    demoMode ? Object.fromEntries(
      demoAssets.filter((asset) => asset.scope === "common").map((asset) => [asset.id, demoReviewHint(asset.id)]),
    ) : {}
  ));
  /* W5.5（Dario #8，对照 06 稿）：类型/文本/Tag/性别/年龄段筛选 + 更多菜单 + 版本摘要惰性计数 */
  const [kindFilter, setKindFilter] = useState("");
  const [textQuery, setTextQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const [genderFilter, setGenderFilter] = useState("");
  const [ageBand, setAgeBand] = useState("");
  const [createKind, setCreateKind] = useState<string | null>(null);
  /* K2I（GP-01 放行标注）：生产页「设计圣经」标注按钮的直达目标——?create=1
     自动打开「新建资产」弹窗（类型不锁，角色/场景任选）。 */
  const [createOpen, setCreateOpen] = useState(false);
  const [versionSummaries, setVersionSummaries] = useState<Record<string, AssetVersionSummary | "loading" | "error">>({});
  const summaryInflight = useRef(new Map<string, Promise<AssetVersionSummary>>());
  const [summariesRevision, setSummariesRevision] = useState(0);
  const assets = data?.items ?? [];
  /* 通用素材裁决入口:权限没读到时不渲染,壳层那条全局提示负责说明入口为什么少了。 */
  const canModerateCommon = capabilityGate(capabilities, canModerateCommonAssets) === "allowed";
  const visibleAssets = useMemo(() => assets.filter((asset) => (
    (!reviewFilter || (asset.scope === "common" && reviewFilterMatches(asset.status, reviewFilter)))
      && assetKindMatches(asset.asset_kind, kindFilter)
      && assetTextMatches(asset, textQuery)
      && assetTagMatches(asset, tagQuery)
      && genderMatches(asset.gender, genderFilter)
      && ageBandMatches(asset.age_value, ageBand)
  )), [assets, reviewFilter, kindFilter, textQuery, tagQuery, genderFilter, ageBand]);
  /* bug6：Tag 建议源 = 未过滤的全量 assets（拿筛过的列表算建议会越筛越少） */
  const tagSuggestions = useMemo(() => tagSuggestionsFor(collectAssetTags(assets), tagQuery), [assets, tagQuery]);
  const introducedIds = useMemo(() => new Set(assets.map((asset) => asset.id)), [assets]);
  /* 类型页签计数：按当前资产真实计数（06 稿「角色(8) 场景(1)…」），别名并入主类型。 */
  const kindCounts = useMemo(
    () => ASSET_KIND_OPTIONS
      .map((option) => ({ option, count: assets.filter((asset) => assetKindMatches(asset.asset_kind, option.value)).length }))
      .filter((entry) => entry.count > 0),
    [assets],
  );
  const assetsKey = useMemo(() => assets.map((asset) => asset.id).join(","), [assets]);

  /* 版本摘要惰性计数：沿用项目卡闭环计数的 per-project promise 缓存模式——
     逐资产一次 assetVersions，promise 存 ref（StrictMode 双跑共享），列表不 N+1 轰炸。 */
  useEffect(() => {
    if (demoMode) {
      setVersionSummaries((current) => {
        const next = { ...current };
        for (const asset of assets) {
          if (!next[asset.id]) next[asset.id] = summarizeAssetVersions(p2DemoVersions(asset.id));
        }
        return next;
      });
      return;
    }
    let active = true;
    for (const asset of assets) {
      let promise = summaryInflight.current.get(asset.id);
      if (!promise) {
        promise = api.assetVersions(asset.id).then((result) => summarizeAssetVersions(result.items));
        summaryInflight.current.set(asset.id, promise);
        setVersionSummaries((current) => (current[asset.id] ? current : { ...current, [asset.id]: "loading" }));
      }
      void promise.then((summary) => {
        if (active) setVersionSummaries((current) => ({ ...current, [asset.id]: summary }));
      }).catch(() => {
        if (active) setVersionSummaries((current) => ({ ...current, [asset.id]: "error" }));
      });
    }
    return () => { active = false; };
    // assetsKey 变化时补齐新资产；summariesRevision 用于单卡降级重试。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, assetsKey, summariesRevision]);

  /* K2I：生产页「设计圣经」标注按钮的直达目标——?create=1 自动打开「新建资产」弹窗，
     剥参不污染刷新；ref 防重跑（StrictMode 双跑安全），与 S30 ?addShot=1 同款。 */
  const bibleCreateHandled = useRef(false);
  useEffect(() => {
    if (bibleCreateHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") !== "1") return;
    bibleCreateHandled.current = true;
    params.delete("create");
    const query = params.toString();
    navigate(`/projects/${projectId}/assets${query ? `?${query}` : ""}`, { replace: true });
    setCreateOpen(true);
  }, [projectId]);

  /** 单卡版本摘要降级重试：清缓存 promise 重跑（与项目卡闭环计数同款）。 */
  function retryVersionSummary(assetId: string): void {
    summaryInflight.current.delete(assetId);
    setVersionSummaries((current) => ({ ...current, [assetId]: "loading" }));
    setSummariesRevision((value) => value + 1);
  }

  function mergeHint(assetId: string, hint: ReviewHint): void {
    setReviewHints((current) => {
      const prev = current[assetId] ?? {};
      const next = { reviewerName: hint.reviewerName ?? prev.reviewerName, rejectionReason: hint.rejectionReason ?? prev.rejectionReason };
      if (next.reviewerName === prev.reviewerName && next.rejectionReason === prev.rejectionReason) return current;
      return { ...current, [assetId]: next };
    });
  }

  /** 提审/裁决回包落页：状态写回卡片，latestAction 供提示行；S7-13 目标卡高亮一次。 */
  function applyReviewItem(item: AssetReviewItem): void {
    setData((current) => (current ? { ...current, items: current.items.map((asset) => (asset.id === item.assetId ? { ...asset, status: item.status } : asset)) } : current));
    flashAsset(item.assetId);
    if (item.latestAction) {
      mergeHint(item.assetId, {
        reviewerName: item.latestAction.reviewerDisplayName ?? undefined,
        rejectionReason: item.latestAction.rejectionReason ?? undefined,
      });
    }
  }

  /** S7-13 目标区高亮：动作落点卡闪一次边框辉光（600ms 一次性，不循环）。 */
  function flashAsset(assetId: string): void {
    setFlashIds((current) => new Set(current).add(assetId));
    window.setTimeout(() => {
      setFlashIds((current) => {
        const next = new Set(current);
        next.delete(assetId);
        return next;
      });
    }, 700);
  }

  function toggleSelect(assetId: string): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }

  /** 批量提审：≤50 件；toast 只报汇总，逐条原因进结果摘要区。 */
  async function submitReviews(): Promise<void> {
    if (!canModerateCommon) {
      notify("只有平台管理员可以审核通用资产", "error");
      return;
    }
    const ids = [...selectedIds].filter((id) => (
      introducedIds.has(id) && assets.some((asset) => asset.id === id && asset.scope === "common")
    ));
    const guard = submitBatchError(ids.length);
    if (guard) {
      notify(guard, "error");
      return;
    }
    if (demoMode) {
      /* K2U D-17：demo 提审真翻转——勾选项进待审（终态不重复流转），逐条结果进摘要区，
         留痕入会话仓（轨迹面板可见）；只改当前会话，不提交后端。 */
      const targets = ids.map((id) => assets.find((asset) => asset.id === id)).filter((asset): asset is Asset => Boolean(asset));
      const items = applyDemoAssetSubmissions(targets, user.display_name);
      const flipped = new Map(items.filter((item) => item.changed).map((item) => [item.assetId, item.status]));
      setData((current) => (current ? { ...current, items: current.items.map((asset) => (flipped.has(asset.id) ? { ...asset, status: flipped.get(asset.id)! } : asset)) } : current));
      for (const item of items) if (item.changed) flashAsset(item.assetId);
      const summary = summarizeSubmitResults(items);
      setSubmitSummary({
        summary,
        lines: items.map((item) => {
          const found = assets.find((asset) => asset.id === item.assetId);
          return submitResultLine(item, found ? assetName(found) : item.assetId);
        }),
      });
      setSelectedIds(new Set());
      notify(`${formatSubmitSummary(summary)}（离线演示：只在本次会话，未提交审核）`, summary.submitted > 0 ? "success" : "info");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.submitAssetReviews(projectId, ids);
      const summary = summarizeSubmitResults(result.items);
      setSubmitSummary({
        summary,
        lines: result.items.map((item) => {
          const found = assets.find((asset) => asset.id === item.assetId);
          return submitResultLine(item, found ? assetName(found) : item.assetId);
        }),
      });
      for (const item of result.items) applyReviewItem(item);
      setSelectedIds(new Set());
      notify(formatSubmitSummary(summary), summary.submitted > 0 ? "success" : "info");
    } catch (reason) {
      notify(businessErrorMessage(reason, "批量提审失败，请重试"), "error");
    } finally {
      setSubmitting(false);
    }
  }

  /** 裁决：pending → 通过/拒绝；终态冲突 409 时刷新列表（服务端口径为准）。
      K2U D-17：demo 裁决真翻转——状态/提示行/徽标在会话里真变并入会话仓留痕，
      拒绝理由必填拦截保留（applyDemoAssetDecision 与后端 422 同文案），不提交后端。 */
  async function decideReview(asset: Asset, action: "approve" | "reject", reason?: string): Promise<void> {
    if (!canModerateCommon || asset.scope !== "common") {
      notify("只有平台管理员可以审核通用资产", "error");
      return;
    }
    if (demoMode) {
      const record = applyDemoAssetDecision({ assetId: asset.id, action, fromStatus: asset.status ?? "pending_review", reason, reviewerName: user.display_name });
      setData((current) => (current ? { ...current, items: current.items.map((item) => (item.id === asset.id ? { ...item, status: record.toStatus } : item)) } : current));
      mergeHint(asset.id, { reviewerName: record.reviewerDisplayName ?? user.display_name, rejectionReason: record.rejectionReason ?? undefined });
      flashAsset(asset.id);
      setRejectTarget(null);
      notify(action === "approve"
        ? `「${assetName(asset)}」已通过（离线演示：状态与留痕只在本次会话，未提交审核）`
        : `「${assetName(asset)}」已拒绝，理由已留痕（离线演示：只在本次会话，未提交审核）`, "success");
      return;
    }
    setDecidingId(asset.id);
    try {
      const item = await api.decideAssetReview(projectId, asset.id, action === "reject" ? { action, rejection_reason: reason } : { action });
      applyReviewItem(item);
      if (!item.latestAction) mergeHint(asset.id, { reviewerName: user.display_name, rejectionReason: action === "reject" ? reason : undefined });
      setRejectTarget(null);
      notify(action === "approve" ? `「${assetName(asset)}」已通过，可继续进戏` : `「${assetName(asset)}」已拒绝，理由已留痕`, "success");
    } catch (caught) {
      if (isTerminalStateConflict(caught)) {
        notify("这件资产刚被其他审核人裁决，列表已刷新", "info");
        retry();
      } else {
        notify(businessErrorMessage(caught, "审核操作失败，请重试"), "error");
      }
    } finally {
      setDecidingId("");
    }
  }

  async function addAsset(asset: Asset): Promise<boolean> {
    if (introducedIds.has(asset.id)) {
      notify("这个资产已经在项目中", "info");
      return false;
    }
    if (demoMode) {
      setData((current) => projectAssetAddReducer(current, asset, { projectId, referenceId: `demo-ref-${asset.id}` }));
      flashAsset(asset.id);
      notify("离线演示只更新当前页面，未创建真实项目引用", "info");
      return true;
    }
    const mediaId = await resolvePrimaryMediaId(asset);
    if (!mediaId) {
      throw new Error("这个资产还没有已入库的图片版本，请先上传图片并设为主版本");
    }
    const ref = await api.addProjectAsset(projectId, asset.id, mediaId);
    setData((current) => projectAssetAddReducer(current, asset, { projectId, referenceId: ref.id, mediaId }));
    flashAsset(asset.id);
    retry();
    notify("资产已加入项目，可在卡片上随时移出", "success");
    return true;
  }

  async function removeAsset(asset: Asset): Promise<void> {
    const refId = asset.project_reference_id;
    if (!refId) return notify("这个资产缺少项目引用编号，请刷新后重试", "error");
    if (demoMode) {
      setRemovingId(asset.id);
      setData((current) => projectAssetRemoveReducer(current, asset.id));
      setRemovingId("");
      notify("已移出项目；资产本体仍在资产库（离线演示只更新当前页面）", "info");
      return;
    }
    setRemovingId(asset.id);
    try {
      await api.removeProjectAsset(projectId, refId);
      setData((current) => projectAssetRemoveReducer(current, asset.id));
      notify("已移出项目；资产本体仍在资产库", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "移出项目失败"), "error");
    } finally {
      setRemovingId("");
    }
  }

  /** 音色浏览选中回调：项目资产页没有集/场上下文，不能假装"已加入项目/已保存"——
      如实告知去段落工作台才有归宿（那里才真写进「音频」参考组）。 */
  function handleTimbreSelect(timbre: { speaker_id: string; name?: string }): void {
    const label = timbre.name?.trim() || timbre.speaker_id;
    notify(`已记下「${label}」，去某一集的段落工作台可正式设为音频参考`, "info");
  }

  /** 空态「选择文件」：入到个人资产库（asset-ingest 既有接口），再从资产中心引入本项目。 */
  async function ingestFile(file: File | null): Promise<void> {
    if (!file) return;
    if (demoMode) {
      notify("离线演示不会上传文件；正式环境将先入个人资产库，再从资产中心引入", "info");
      return;
    }
    setIngesting(true);
    try {
      const result = await api.uploadAsset(file, {});
      notify(`已入库 ${result.count} 个资产到个人资产库，点「从资产中心引入」挂到本项目`, "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "上传入库失败"), "error");
    } finally {
      setIngesting(false);
      if (ingestInput.current) ingestInput.current.value = "";
    }
  }

  /** 更多菜单（06 稿）：创建类接现有新建资产弹窗（kind 预填）；声效类能力缺口给片场语诚实 toast。 */
  function runMenuItem(item: ProjectAssetMenuItem): void {
    if (item.action === "create") {
      setCreateKind(item.kind ?? "character");
      return;
    }
    if (item.action === "sound-generate") return notify(SOUND_GENERATE_MESSAGE, "info");
    if (item.action === "sound-upload") return notify(SOUND_UPLOAD_MESSAGE, "info");
    if (item.action === "refresh") {
      retry();
      return;
    }
    void downloadAllPrimaryImages();
  }

  /** 创建角色/场景/道具…：JSON 入库真链（韧性：索引失败的假 500 回查兜底）+ 写职责 +
      产物回家（创建即加入本剧资产，后端接受无媒体引用——S17 实证；补图后即可用于生成）。 */
  async function createKindAsset(input: BlankFormInput): Promise<void> {
    if (demoMode) {
      setCreateKind(null);
      notify("离线演示不会写入资产库；正式环境将创建到个人资产库", "info");
      return;
    }
    const { assetId, indexed } = await ingestAssetVerified(
      {
        asset_kind: input.kind,
        name: input.name,
        display_name: input.name,
        intro: input.intro || null,
        style_tags: input.tags,
        role: roleForAssetKind(input.kind) ?? null,
      },
      {
        ingest: (assets) => api.ingestJsonAssets(assets as JsonAssetIngestItem[], { source_project_id: projectId }),
        lookup: async () => (await api.assets({ scope: "personal", assetKind: input.kind })).items,
      },
    );
    setCreateKind(null);
    if (assetId) {
      try {
        await api.addProjectAsset(projectId, assetId);
        retry();
        notify(`已创建并加入本剧资产；进详情补图后即可用于生成${indexed ? "" : "（搜索索引稍后自动补上）"}`, "success");
        return;
      } catch {
        notify("已创建到个人资产库，但加入项目失败——请从资产中心引入", "error");
        return;
      }
    }
    notify(`已创建到个人资产库，补图后可引入本项目${indexed ? "" : "（搜索索引稍后自动补上）"}`, "success");
  }

  /**
   * 一键下载图片（06 稿）：逐资产取主图媒体 → api.downloadMedia。
   * 浏览器对连续多文件下载有限制（首次会询问「允许下载多个文件」），故串行触发并提前 toast 说明；
   * 用户显式点击才逐资产取版本，不是列表加载时的 N+1。
   */
  async function downloadAllPrimaryImages(): Promise<void> {
    if (demoMode) {
      notify("离线演示不会下载真实文件", "info");
      return;
    }
    const candidates = visibleAssets.length > 0 ? visibleAssets : assets;
    let started = 0;
    let skipped = 0;
    for (const asset of candidates) {
      const mediaId = asset.selected_media_id || (await resolvePrimaryMediaId(asset));
      if (!mediaId) {
        skipped += 1;
        continue;
      }
      try {
        await api.downloadMedia(mediaId);
        started += 1;
      } catch (reason) {
        notify(businessErrorMessage(reason, `「${assetName(asset)}」下载失败，请重试`), "error");
      }
    }
    if (started === 0) {
      notify(skipped > 0 ? "当前列表的资产都没有可下载主图" : "没有可下载的图片", "info");
      return;
    }
    notify(`已触发 ${started} 张主图下载${skipped > 0 ? `，${skipped} 个资产无主图跳过` : ""}；${DOWNLOAD_ALL_LIMIT_NOTE}`, "success");
  }

  return (
    <section className="mx-auto flex w-full max-w-[1920px] flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {/* A6：资产中心 ↔ 本剧资产往返面包屑 */}
          <nav className="mb-1 flex items-center gap-1 text-xs text-ink-4" aria-label="面包屑">
            <button type="button" className="rounded-sm px-0.5 outline-none transition-colors hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent" onClick={() => navigate("/projects")}>项目管理</button>
            <span aria-hidden="true">/</span>
            <button type="button" className="rounded-sm px-0.5 outline-none transition-colors hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent" onClick={() => navigate("/assets?scope=personal")}>资产中心</button>
            <span aria-hidden="true">/</span>
            <span className="text-ink-2">本剧资产</span>
          </nav>
          <span className="flex items-center gap-1.5">
            {/* S10-D3（丽芬批）：页名「项目资产」改「本剧资产」，与资产中心命名区分；旁边给互链出口。
                顶栏项目导航「资产」页签在 app.tsx（他线文件），同步改名列 integration 待修。 */}
            <h1 className="text-page-title text-ink-1">本剧资产</h1>
            {/* S7-7：页头说明书收进标题旁「?」浮层，不常驻占行 */}
            <HelpHint label="本剧资产说明">项目资产沿用个人/通用资产分类；审核状态按图片详情汇总，只要任一主图或变体待审核，列表即显示待审核。</HelpHint>
            <button type="button" className="ml-1 inline-flex items-center gap-0.5 rounded-sm text-xs text-accent-text outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-accent" onClick={() => navigate(`/assets?scope=personal&project=${projectId}`)}>去资产中心</button>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 制片人原话:「资产界面直接能打开生图/生音频/生视频/3D导演台」——3D 导演台与
              音色浏览此前是零入口成品,补成标题行一级按钮,不埋进「更多」三级菜单。 */}
          <Button icon={<Cube />} onClick={() => navigate(projectDirectorPath(projectId))}>3D 导演台</Button>
          <Button icon={<SpeakerHigh />} onClick={() => setShowTimbreBrowser(true)}>音色库</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon={<DotsThree />}>更多</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>创建资产</DropdownMenuLabel>
              {PROJECT_ASSET_MENU_ITEMS.filter((item) => item.action === "create").map((item) => (
                <DropdownMenuItem key={item.id} onSelect={() => runMenuItem(item)}>
                  {MENU_ITEM_ICONS[item.id]}
                  {item.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>声效参考（未上线）</DropdownMenuLabel>
              {PROJECT_ASSET_MENU_ITEMS.filter((item) => item.action === "sound-generate" || item.action === "sound-upload").map((item) => (
                <DropdownMenuItem key={item.id} disabled title={`${item.label}预计 v0.1.2 上线`}>
                  {MENU_ITEM_ICONS[item.id]}
                  {item.label}
                  <span className="ml-auto text-[11px] text-ink-4">v0.1.2</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {PROJECT_ASSET_MENU_ITEMS.filter((item) => item.action === "refresh" || item.action === "download-all").map((item) => (
                <DropdownMenuItem key={item.id} onSelect={() => runMenuItem(item)}>
                  {MENU_ITEM_ICONS[item.id]}
                  {item.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {/* 项目审核策略只管生成产物，不参与个人资产审核。 */}
              <DropdownMenuLabel>生成产物默认审核</DropdownMenuLabel>
              <ReviewPolicyMenuItems projectId={projectId} demoMode={demoMode} notify={notify} />
            </DropdownMenuContent>
          </DropdownMenu>
          {canModerateCommon ? (
            <Button icon={<Checks />} loading={submitting} disabled={selectedIds.size === 0} title="把勾选的通用资产送审" onClick={() => void submitReviews()}>批量提审{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}</Button>
          ) : null}
          <Button icon={<Archive />} onClick={() => navigate("/trash?kind=asset")}>回收站</Button>
          <Button variant="primary" icon={<Plus />} onClick={() => setShowAdd(true)}>从资产中心引入</Button>
        </div>
      </header>
      {/* P-07(批次二):定妆两件套就绪卡+通用库推荐;拉入项目走宿主 addAsset 引用链 */}
      <ProjectAssetsMakeupSections
        projectId={projectId}
        demoMode={demoMode}
        assets={assets}
        introducedIds={introducedIds}
        demoVersionsFor={p2DemoVersions}
        onAddAsset={addAsset}
      />
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput
          icon={<MagnifyingGlass />}
          value={textQuery}
          onChange={setTextQuery}
          placeholder="名称/描述"
          ariaLabel="名称或描述搜索"
          className="min-w-40 flex-1 basis-44"
        />
        <TagFilterInput
          icon={<MagnifyingGlass />}
          value={tagQuery}
          onChange={setTagQuery}
          suggestions={tagSuggestions}
          placeholder="输入/选择 Tag"
          ariaLabel="Tag 筛选"
          className="w-40 min-w-32"
        />
        <ChevronSelect aria-label="类型筛选" className="w-32" value={kindFilter} onChange={(event) => setKindFilter(event.target.value)}>
          <option value="">全部类型</option>
          <AssetKindSelectOptions />
        </ChevronSelect>
        <span className="flex items-center gap-1">
          <ChevronSelect aria-label="审核状态筛选" className="w-32" value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as AssetReviewBucket | "")}>
            <option value="">全部审核状态</option>
            {REVIEW_FILTER_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </ChevronSelect>
          {/* S7-10：帮助触发贴着它解释的控件，不再独占一行悬空白处 */}
          <ReviewLegendHelp />
        </span>
        <ChevronSelect aria-label="性别筛选" className="w-28" value={genderFilter} onChange={(event) => setGenderFilter(event.target.value)}>
          <option value="">全部性别</option>
          {GENDER_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </ChevronSelect>
        <ChevronSelect aria-label="年龄段筛选" className="w-32" value={ageBand} onChange={(event) => setAgeBand(event.target.value)}>
          <option value="">全部年龄段</option>
          {AGE_BAND_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </ChevronSelect>
      </div>
      {kindCounts.length > 0 ? (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="按类型筛选">
          {kindCounts.map(({ option, count }) => {
            const active = kindFilter === option.value;
            return (
              <button
                role="tab"
                aria-selected={active}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm transition-all duration-150 ease-out-quart active:scale-[0.98]",
                  active
                    ? "border-transparent bg-accent-subtle font-semibold text-accent-text"
                    : "border-border-1 bg-surface-1 text-ink-2 hover:border-border-2 hover:text-ink-1",
                )}
                key={option.value}
                type="button"
                onClick={() => setKindFilter((current) => (current === option.value ? "" : option.value))}
              >
                {option.label}
                <span className={cn("font-mono text-xs", active ? "text-accent-text" : "text-ink-4")}>({count})</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {demoMode ? <div className={inlineNoteClass}>离线演示：数据为本地示例，引入/移出只更新当前页面；通用资产审核只在本次会话翻转并留痕，不提交后端。</div> : null}
      {canModerateCommon && selectedIds.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border-1 bg-accent-subtle px-4 py-2 text-sm text-ink-1" role="status">
          <span>已选 {selectedIds.size} 件{selectedIds.size > SUBMIT_BATCH_LIMIT ? `（超过单次上限 ${SUBMIT_BATCH_LIMIT} 件）` : ""}，点标题行「批量提审」提交</span>
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>清除选择</Button>
        </div>
      ) : null}
      {submitSummary ? (
        <Card className="px-4 py-3" role="status">
          <header className="flex items-center justify-between gap-2">
            <strong className="text-sm text-ink-1">{formatSubmitSummary(submitSummary.summary)}</strong>
            <Button variant="ghost" size="icon" className="size-7" aria-label="收起提审结果" onClick={() => setSubmitSummary(null)}><X /></Button>
          </header>
          <ul className="mt-2 flex list-disc flex-col gap-0.5 pl-5 text-xs text-ink-2">
            {submitSummary.lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
          </ul>
        </Card>
      ) : null}
      {loading ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            <Skeleton className="h-56" />
            <Skeleton className="h-56" />
            <Skeleton className="h-56" />
            <Skeleton className="h-56" />
          </div>
          <SlowLoadingNote show={slowLoading} onRetry={retry} />
        </>
      ) : error ? (
        <ErrorState message={error} onRetry={retry} />
      ) : assets.length === 0 ? (
        <EmptyState
          title="把设定图拖进来"
          description="传完即可用，制片事后抽查不挡人；也可以直接从资产中心引入已有资产。"
          icon={<CloudArrowUp />}
          action={(
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon={<UploadSimple />} loading={ingesting} onClick={() => ingestInput.current?.click()}>选择文件</Button>
              {/* R5/V-24:primary 收敛到头带一枚,空态引导钮与「选择文件」同级不再重复 primary */}
              <Button icon={<Plus />} onClick={() => setShowAdd(true)}>从资产中心引入</Button>
            </div>
          )}
        />
      ) : visibleAssets.length === 0 ? (
        <EmptyState
          title="没有符合条件的资产"
          description="当前筛选（类型/审核状态/名称/Tag/性别/年龄段）下没有命中；清空筛选可查看全部。"
          icon={<Checks />}
          action={<Button onClick={() => { setReviewFilter(""); setKindFilter(""); setTextQuery(""); setTagQuery(""); setGenderFilter(""); setAgeBand(""); }}>清空筛选</Button>}
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
          {visibleAssets.map((asset) => {
            const bucket = assetReviewBucket(asset.status);
            const hint = reviewHints[asset.id];
            const referenceLine = projectAssetReferenceLine(asset, projectId);
            const hasReference = !["暂未引用"].includes(referenceLine);
            const selected = selectedIds.has(asset.id);
            const deciding = decidingId === asset.id;
            const summary = versionSummaries[asset.id];
            const loadedSummary = summary && summary !== "loading" && summary !== "error" ? summary : null;
            /* Dario #8 卡片（06 稿）：副标题定位行 + #tag + 底部「N 张图 · N 个变体 · N 待审核」摘要。 */
            const subtitle = assetPositionLine(asset) || assetKindLabel(asset.asset_kind);
            const tags = (asset.style_tags ?? []).filter(Boolean).slice(0, 3);
            /* 四态 pill 悬浮：待审核看审核人、已拒绝看拒绝理由（W5-A 轨迹回授的 reviewHints）。 */
            const pillTooltip = bucket === "pending"
              ? (hint?.reviewerName ? `审核人：${hint.reviewerName}` : REVIEW_BUCKET_EXPLAIN.pending)
              : bucket === "rejected"
                ? (hint?.rejectionReason ? `拒绝理由：${hint.rejectionReason}` : REVIEW_BUCKET_EXPLAIN.rejected)
                : REVIEW_BUCKET_EXPLAIN[bucket];
            return (
              <article
                className={cn(
                  "relative flex flex-col overflow-hidden rounded-lg border bg-surface-1 transition-all duration-150 ease-out-quart hover:-translate-y-0.5 hover:shadow-[0_8px_24px_-12px_oklch(0_0_0/0.5)]",
                  selected ? "border-accent" : "border-border-1 hover:border-border-2",
                  flashIds.has(asset.id) && "vw-tl-lit",
                )}
                key={asset.project_reference_id || asset.id}
              >
                {/* S7-8：整卡主操作 = 点卡片任意处进详情（覆盖层 z-10）；其余交互件抬 z-20 */}
                <button className="absolute inset-0 z-10 cursor-pointer rounded-[inherit]" type="button" aria-label={`打开 ${assetName(asset)} 详情`} onClick={() => navigate(`/projects/${projectId}/assets/${asset.id}`)} />
                {canModerateCommon && asset.scope === "common" ? (
                  <label className="absolute left-2 top-2 z-20 flex size-7 cursor-pointer items-center justify-center rounded-md border border-border-2 bg-surface-1/80 backdrop-blur-sm" title="选中后可批量提审">
                    <input type="checkbox" className="size-3.5 cursor-pointer accent-accent" checked={selected} aria-label={`选择 ${assetName(asset)}`} onChange={() => toggleSelect(asset.id)} />
                  </label>
                ) : null}
                {/* 次要操作收 kebab：移出项目（只解除引用） */}
                <div className="absolute right-2 top-2 z-20">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-7 rounded-md border border-border-2 bg-surface-1/80 backdrop-blur-sm [&_svg]:size-4" aria-label={`${assetName(asset)} 更多操作`} title="更多操作" icon={<DotsThree />} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-40">
                      <DropdownMenuItem destructive disabled={removingId === asset.id} title="只解除引用，资产中心本体不受影响" onSelect={() => void removeAsset(asset)}>
                        <Trash aria-hidden="true" />{removingId === asset.id ? "移出中…" : "移出项目"}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="relative aspect-[16/7] w-full overflow-hidden bg-surface-well">
                  <AssetKindThumb asset={asset} note={loadedSummary ? `主图 · 共 ${loadedSummary.images} 张` : undefined} />
                </div>
                <div className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-ink-1 text-section-title">{assetName(asset)}</h2>
                    {asset.scope === "common" ? (
                      <span className="relative z-20 inline-flex shrink-0 items-center gap-1">
                        <Tooltip content={pillTooltip}>
                          <span className="inline-flex cursor-help">
                            <ReviewPill status={asset.status} />
                          </span>
                        </Tooltip>
                        <ReviewTrailToggle open={openTrailId === asset.id} onToggle={() => setOpenTrailId((current) => (current === asset.id ? "" : asset.id))} />
                      </span>
                    ) : null}
                  </div>
                  <span className="p2-position-line truncate text-xs text-ink-2">{subtitle}</span>
                  <RoleBadge role={asset.role} />
                  {tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1">{tags.map((tag) => <span className={tagChipClass} key={tag}>#{tag}</span>)}</div>
                  ) : null}
                  {loadedSummary ? (
                    <span className="font-mono text-xs text-ink-2">
                      {asset.scope === "common"
                        ? formatAssetCardSummary(loadedSummary)
                        : `${loadedSummary.images} 张图 · ${loadedSummary.variants} 个变体`}
                    </span>
                  ) : summary === "error" ? (
                    <button type="button" className="relative z-20 text-left text-xs text-warning hover:underline underline-offset-2" onClick={() => retryVersionSummary(asset.id)}>图片统计读取失败 · 重试</button>
                  ) : (
                    <span className="font-mono text-xs text-ink-4">图片统计读取中…</span>
                  )}
                  <span className={cn("flex items-center gap-1 text-xs", hasReference ? "text-ink-2" : "text-ink-4")}>
                    <Link className={cn("size-3 shrink-0", hasReference ? "text-accent-text" : "text-ink-4")} aria-hidden="true" />
                    {referenceLine}
                  </span>
                  {asset.scope === "common" && bucket === "pending" && hint?.reviewerName ? <span className="flex items-center gap-1 text-xs text-ink-4"><User className="size-3 shrink-0" aria-hidden="true" />审核人:{hint.reviewerName}</span> : null}
                  {asset.scope === "common" && bucket === "rejected" && hint?.rejectionReason ? <span className="flex items-center gap-1 text-xs text-danger"><WarningCircle className="size-3 shrink-0" aria-hidden="true" />拒绝理由:{hint.rejectionReason}</span> : null}
                  {canModerateCommon && asset.scope === "common" && bucket === "pending" ? (
                    /* S7-8：通过/拒绝只在待审核态出现，收成一对小按钮（主操作仍是点卡进详情） */
                    <div className="relative z-20 flex items-center gap-2 pt-1">
                      <Button size="sm" variant="outline" className="border-success/40 text-success hover:bg-success/10" disabled={deciding} onClick={() => void decideReview(asset, "approve")}>{deciding ? "裁决中…" : "通过"}</Button>
                      <Button size="sm" variant="outline" className="border-danger/40 text-danger hover:bg-danger/10" disabled={deciding} onClick={() => setRejectTarget(asset)}>拒绝</Button>
                    </div>
                  ) : null}
                  {asset.scope === "common" && openTrailId === asset.id ? (
                    <div className="relative z-20">
                      <ReviewTrailPanel projectId={projectId} assetId={asset.id} demoMode={demoMode} onRecords={(records) => mergeHint(asset.id, reviewHintFromRecords(records))} />
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <input
        className="sr-only"
        ref={ingestInput}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,.xlsx,.xlsm"
        onChange={(event) => void ingestFile(event.target.files?.[0] ?? null)}
      />
      {showAdd ? (
        <AssetPickerDrawer
          demoMode={demoMode}
          notify={notify}
          addedIds={introducedIds}
          onAdd={addAsset}
          onClose={() => setShowAdd(false)}
        />
      ) : null}
      {/* 音色库：复用现成 Dialog 原语（不新造抽屉 markup），TimbreBrowser 独立分包按需加载。 */}
      <Dialog open={showTimbreBrowser} onOpenChange={setShowTimbreBrowser}>
        <DialogContent size="wide" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>音色库</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
              <TimbreBrowserLazy onSelect={handleTimbreSelect} />
            </Suspense>
          </DialogBody>
        </DialogContent>
      </Dialog>
      {rejectTarget ? (
        <RejectReasonModal
          assetName={assetName(rejectTarget)}
          busy={decidingId === rejectTarget.id}
          onClose={() => setRejectTarget(null)}
          onSubmit={(reason) => void decideReview(rejectTarget, "reject", reason)}
        />
      ) : null}
      {createKind ? (
        <AssetBlankFormModal
          mode="persona"
          lockedKind={createKind}
          title={`创建${assetKindLabel(createKind)}`}
          footerHint="创建后加入本剧资产（同时在个人资产库建档）；进详情补图后即可用于生成。"
          onClose={() => setCreateKind(null)}
          onSubmit={createKindAsset}
        />
      ) : null}
      {/* K2I：设计圣经标注的直达动作——不锁类型的「新建资产」，角色/场景都在这里手工建。 */}
      {createOpen ? (
        <AssetBlankFormModal
          mode="persona"
          title="新建资产"
          footerHint="角色、场景都可以从这里建；创建后加入本剧资产（同时在个人资产库建档），进详情补图后即可用于生成。"
          onClose={() => setCreateOpen(false)}
          onSubmit={createKindAsset}
        />
      ) : null}
    </section>
  );
}

/**
 * 板13 引入抽屉：双模式 tab（浏览 / 检索）。
 * 浏览 = 个人/通用资产 + 类型/审核筛选；检索 = 混合检索单框（S13，服务端融合无模式概念）。
 * 结果行带「引入 / 已引入」态；关闭后回到原工作区，不打断滚动位置和未提交筛选。
 */
export function AssetPickerDrawer({ demoMode, notify, addedIds, onAdd, onClose }: {
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  addedIds: Set<string>;
  onAdd: (asset: Asset) => Promise<boolean>;
  onClose: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<"browse" | "search">("browse");
  const [scope, setScope] = useState<"personal" | "common">("personal");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [nlInput, setNlInput] = useState("");
  const [nlQuery, setNlQuery] = useState("");
  const [addingId, setAddingId] = useState("");
  useEffect(() => {
    if (scope === "personal" && status) setStatus("");
  }, [scope, status]);
  const demoCandidates = scope === "personal" ? demoPersonalAssets : demoCommonAssets;
  const browseState = useResource(
    () => api.assets({ scope }),
    { items: demoCandidates, count: demoCandidates.length },
    demoMode,
    [scope, demoCandidates],
  );
  /* S13-1：引入抽屉检索同切混合检索单框（服务端已融合，前端无「模式」概念/无降级条）。 */
  const searchState = useResource<AssetSearchResult>(
    () => nlQuery ? api.assetSearch(nlQuery, { scope, pageSize: 24 }) : Promise.resolve({ items: [], count: 0 }),
    { items: demoCandidates, count: demoCandidates.length },
    demoMode,
    [scope, nlQuery, demoCandidates],
  );
  const activeState = tab === "search" && nlQuery ? searchState : browseState;
  const results = (activeState.data?.items ?? []).filter((asset) => {
    // 类型枚举与资产中心同一份（assetKindMatches：clothing 命中服装、other 命中参考）。
    return assetKindMatches(asset.asset_kind, kind)
      && (scope !== "common" || !status || assetReviewBucket(asset.status) === status);
  });

  async function add(asset: Asset): Promise<void> {
    setAddingId(asset.id);
    try {
      await onAdd(asset);
    } catch (reason) {
      notify(businessErrorMessage(reason, "加入资产失败"), "error");
    } finally {
      setAddingId("");
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] animate-fade-in bg-surface-well/60 backdrop-blur-sm" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()} />
      <aside className="fixed inset-y-0 right-0 z-[61] flex w-[min(720px,94vw)] animate-fade-up flex-col border-l border-border-2 bg-surface-1 shadow-[0_24px_48px_-16px_oklch(0_0_0/0.60)]" role="dialog" aria-modal="true" aria-label="从资产中心引入">
        <header className="flex items-start justify-between gap-3 border-b border-border-1 px-5 py-4">
          <div>
            <h2 className="text-ink-1 text-section-title">从资产中心引入</h2>
            <p className="mt-0.5 text-xs text-ink-2">引入 = 建立 project_reference（只挂引用，不复制文件）；关闭后回到刚才的工作。</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="关闭" onClick={onClose}><X /></Button>
        </header>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          <div className={cn(segmentedControlClass, "self-start")} role="tablist" aria-label="引入方式">
            <button role="tab" aria-selected={tab === "browse"} className={pickerTabClass(tab === "browse")} type="button" onClick={() => setTab("browse")}>浏览</button>
            <button role="tab" aria-selected={tab === "search"} className={pickerTabClass(tab === "search")} type="button" onClick={() => setTab("search")}>检索</button>
          </div>
          {tab === "browse" ? (
            <div className="flex flex-wrap items-center gap-3">
              <div className={segmentedControlClass} aria-label="资产范围">
                <button className={segmentedClass(scope === "personal")} type="button" onClick={() => setScope("personal")}>个人资产</button>
                <button className={segmentedClass(scope === "common")} type="button" onClick={() => setScope("common")}>通用资产</button>
              </div>
              <ChevronSelect aria-label="全部类型" className="w-32" value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="">全部类型</option>
                <AssetKindSelectOptions />
              </ChevronSelect>
              {scope === "common" ? (
                <ChevronSelect aria-label="全部审核状态" className="w-32" value={status} onChange={(event) => setStatus(event.target.value)}>
                  <option value="">全部审核状态</option>
                  <option value="approved">已通过</option>
                  <option value="pending">待审核</option>
                  <option value="auto">自动审核</option>
                  <option value="rejected">已拒绝</option>
                </ChevronSelect>
              ) : null}
            </div>
          ) : (
            <form
              className="flex flex-wrap items-center gap-3"
              onSubmit={(event) => { event.preventDefault(); setNlQuery(nlInput.trim()); }}
            >
              <SearchInput
                icon={<MagicWand />}
                value={nlInput}
                onChange={setNlInput}
                placeholder="用一句话描述想要的资产，例如：雨夜巷口、冷色调的黑西装男主"
                ariaLabel="检索资产"
                className="min-w-56 flex-1"
              />
              <Button variant="primary" type="submit" icon={<MagnifyingGlass />}>检索</Button>
              {nlQuery ? <Button type="button" variant="ghost" onClick={() => { setNlQuery(""); setNlInput(""); }}>清空</Button> : null}
            </form>
          )}
          {tab === "search" && !nlQuery ? (
            <EmptyState title="输入关键词开始检索" description="搜角色、场景、道具…支持自然语言。" icon={<MagicWand />} />
          ) : activeState.loading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : activeState.error ? (
            <ErrorState message={activeState.error} onRetry={activeState.retry} />
          ) : results.length === 0 ? (
            <EmptyState title="没有找到资产" description={tab === "search" ? "换个说法试试，或清空后浏览全部资产。" : "这个范围里还没有符合筛选的资产。"} icon={<MagnifyingGlass />} />
          ) : (
            <div className="flex flex-col gap-2">
              {results.map((asset) => {
                const action = introduceAction(asset.id, addedIds, addingId);
                return (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-transparent bg-surface-2 px-3 py-2 transition-colors duration-150 ease-out-quart hover:border-border-2" key={asset.id}>
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="size-10 shrink-0 overflow-hidden rounded-sm [&_.asset-thumb-image]:h-full [&_.asset-thumb-image]:w-full [&_.asset-thumb-image]:rounded-none [&_.asset-thumb-image]:object-cover [&_.asset-thumb-placeholder]:h-full [&_.asset-thumb-placeholder]:w-full [&_.asset-thumb-placeholder]:rounded-none [&_svg]:size-4">
                        <AssetThumb asset={asset} />
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <strong className="truncate text-sm font-medium text-ink-1">{assetName(asset)}</strong>
                        <small className="truncate font-mono text-xs text-ink-4" title={assetKindRawTitle(asset.asset_kind)}>{assetKindLabel(asset.asset_kind)}{asset.intro ? ` · ${asset.intro}` : ""}</small>
                      </div>
                    </div>
                    {action.introduced ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success"><Check aria-hidden="true" />已引入</span>
                    ) : (
                      <button
                        type="button"
                        className="shrink-0 rounded-sm bg-accent-subtle px-3 py-1 text-xs font-semibold text-accent-text transition-colors duration-150 ease-out-quart hover:bg-accent hover:text-accent-ink disabled:opacity-60"
                        disabled={action.disabled}
                        onClick={() => void add(asset)}
                      >{action.busy ? "处理中…" : "引入"}</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <footer className="flex items-center gap-2 border-t border-border-1 px-5 py-3">
          <span className="mr-auto text-xs text-ink-2">引入后出现在左侧网格；可随时移出，不影响资产中心本体。</span>
          <Button variant="secondary" onClick={onClose}>完成</Button>
        </footer>
      </aside>
    </>
  );
}

/** 优先读资产实体上内嵌的主图（metadata.primary_image.id），读不到再查一次版本列表。 */
async function resolvePrimaryMediaId(asset: Asset): Promise<string | null> {
  const embedded = asset.metadata?.primary_image;
  if (isRecord(embedded) && typeof embedded.id === "string" && embedded.id) return embedded.id;
  try {
    const versions = await api.assetVersions(asset.id);
    return versions.items.find((item) => item.is_primary)?.id ?? versions.items[0]?.id ?? null;
  } catch {
    return null;
  }
}

/* ============================================================
   板12 资产详情与弹窗群 — 变体 chips + 视图网格 + 描述/提示词/引用三卡
   ============================================================ */

/** api.ts 无具名 updateAsset 客户端方法；经公共 request 直连后端既有 PATCH /api/v1/assets/:id（api.ts 未改动）。 */
async function patchAsset(assetId: string, input: { intro: string; style_tags: string[]; metadata: JsonRecord }): Promise<Asset> {
  return assetFromUnknown(await api.request(`/assets/${encodeURIComponent(assetId)}`, { method: "PATCH", body: JSON.stringify(input) }));
}

export function AssetDetailPage({ projectId, assetId, demoMode, notify, user, capabilities }: PageRuntimeProps & { projectId: string; assetId: string }): React.JSX.Element {
  const demoAsset = p2DemoAsset(assetId);
  const assetState = useResource(
    () => api.asset(assetId),
    demoAsset.scope === "common" ? withDemoReviewStatus(demoAsset) : demoAsset,
    demoMode,
    [assetId],
  );
  const versionState = useResource(() => api.assetVersions(assetId), { items: p2DemoVersions(assetId), count: p2DemoVersions(assetId).length }, demoMode, [assetId]);
  /* S10-D2（丽芬批）：素材详情补上下文——所属项目名走真 GET /projects/:project_id
     （与生产页面包屑同一兜底模式）；集/分镜/场景使用明细接口未回传，见「上下文」卡诚实缺口行。 */
  const detailProjectState = useResource(() => api.project(projectId), demoProjectById(projectId) ?? { id: projectId, name: "项目" }, demoMode, [projectId]);
  const slowLoading = useSlowLoading(assetState.loading);
  const [activeVariantId, setActiveVariantId] = useState("");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [settingPrimary, setSettingPrimary] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [tagsDraft, setTagsDraft] = useState<string[]>([]);
  const [promptDraft, setPromptDraft] = useState("");
  const [draftingPrompt, setDraftingPrompt] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [tagInputOpen, setTagInputOpen] = useState(false);
  /* W5-A 审核域：裁决 + 轨迹 + 提示行（详情页是审核人工作的主场景） */
  const [deciding, setDeciding] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reviewHint, setReviewHint] = useState<ReviewHint>(() => (demoMode ? demoReviewHint(assetId) : {}));
  const asset = assetState.data;
  const versions = versionState.data?.items ?? [];

  const groups = useMemo(() => groupAssetVersions(versions), [versions]);
  const allGroups = useMemo<AssetVariantGroup[]>(() => groups, [groups]);
  const activeGroup = allGroups.find((group) => group.id === activeVariantId) ?? allGroups[0] ?? { id: "", name: "默认造型", versions: [], primary: null };

  // 资产切换时重置草稿；保存成功后的 setData（同 id）不重置未保存编辑。
  useEffect(() => {
    setDescDraft(asset?.intro ?? "");
    setTagsDraft(asset?.style_tags ?? []);
    setPromptDraft(assetImagePrompt(asset));
    setTagInput("");
    setTagInputOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.id]);

  // 审核提示行跟随资产重置；轨迹读取后会再补全审核人/拒绝理由。
  useEffect(() => {
    setReviewHint(demoMode ? demoReviewHint(assetId) : {});
    setRejectOpen(false);
  }, [assetId, demoMode]);

  const readOnly = asset?.scope === "common";
  const canModerateCommonAsset = asset?.scope === "common" && capabilityGate(capabilities, canModerateCommonAssets) === "allowed";
  const dirty = Boolean(asset) && (
    descDraft !== (asset?.intro ?? "")
    || promptDraft !== assetImagePrompt(asset)
    || normalizeStyleTags(tagsDraft).join(" ") !== normalizeStyleTags(asset?.style_tags ?? []).join(" ")
  );

  function selectVariant(id: string): void {
    setActiveVariantId(id);
    setPreviewIndex(null);
  }

  /** S17-A2：按描述生成提示词（真链接通）——描述取简介草稿；AI 网关未开启给「AI 助手未开启」人话。 */
  async function draftPromptByDescription(): Promise<void> {
    if (!asset) return;
    const description = descDraft.trim() || assetName(asset);
    if (!description.trim()) {
      notify("先在简介里写一句这个资产是什么样的，再让 AI 起草提示词", "info");
      return;
    }
    if (demoMode) {
      setPromptDraft((current) => current || `${description}，电影级写实，真实光影，画面主体突出。`);
      notify("离线演示：示例草稿不扣积分，真实起草需登录服务", "info");
      return;
    }
    setDraftingPrompt(true);
    try {
      const draft = await api.draftPrompt({ mediaKind: "image", description, selectedAssetIds: [asset.id], projectId });
      if (!draft.promptText.trim()) throw new Error("empty");
      setPromptDraft(draft.promptText);
      notify("已按描述起草提示词，可继续修改后保存", "success");
    } catch (reason) {
      /* S46-A：AI 网关类 503 走统一口径（角色感知）,不再对管理员说「请联系管理员」。 */
      const unified = reason instanceof ApiClientError
        ? capabilityErrorCopy(reason, platformRoleForCopy(capabilities))
        : null;
      notify(unified ?? "起草提示词失败，请稍后重试", "error");
    } finally {
      setDraftingPrompt(false);
    }
  }

  /** 裁决（W5-A）：pending → 通过/拒绝（拒绝必填理由）；终态冲突 409 时刷新详情。
      K2U D-17：demo 裁决与本剧资产页同仓——状态真翻转、留痕共享（轨迹面板可见）。 */
  async function decideReview(action: "approve" | "reject", reason?: string): Promise<void> {
    if (!asset || !canModerateCommonAsset) {
      notify("只有平台管理员可以审核通用资产", "error");
      return;
    }
    if (demoMode) {
      const record = applyDemoAssetDecision({ assetId: asset.id, action, fromStatus: asset.status ?? "pending_review", reason, reviewerName: user.display_name });
      assetState.setData((current) => (current ? { ...current, status: record.toStatus } : current));
      setReviewHint({
        reviewerName: record.reviewerDisplayName ?? user.display_name,
        rejectionReason: record.rejectionReason ?? undefined,
      });
      setRejectOpen(false);
      notify(action === "approve" ? "已通过（离线演示：状态与留痕只在本次会话，未提交审核）" : "已拒绝，理由已留痕（离线演示：只在本次会话，未提交审核）", "success");
      return;
    }
    setDeciding(true);
    try {
      const item = await api.decideAssetReview(projectId, asset.id, action === "reject" ? { action, rejection_reason: reason } : { action });
      assetState.setData((current) => (current ? { ...current, status: item.status } : current));
      setReviewHint({
        reviewerName: item.latestAction?.reviewerDisplayName ?? user.display_name,
        rejectionReason: item.latestAction?.rejectionReason ?? (action === "reject" ? reason : undefined),
      });
      setRejectOpen(false);
      notify(action === "approve" ? "已通过，可继续进戏" : "已拒绝，理由已留痕", "success");
    } catch (caught) {
      if (isTerminalStateConflict(caught)) {
        notify("这件资产刚被其他审核人裁决，已刷新最新状态", "info");
        assetState.retry();
      } else {
        notify(businessErrorMessage(caught, "审核操作失败，请重试"), "error");
      }
    } finally {
      setDeciding(false);
    }
  }

  function openPreview(index: number): void {
    if (activeGroup.versions[index]) setPreviewIndex(index);
  }

  async function setPrimary(version: MediaVersion): Promise<void> {
    if (readOnly) {
      notify("通用资产只读，不能修改主图", "info");
      return;
    }
    if (demoMode) {
      versionState.setData((current) => current ? { ...current, items: current.items.map((item) => ({ ...item, is_primary: item.id === version.id })) } : current);
      notify("离线演示只切换当前页面显示，未写入主图", "info");
      return;
    }
    setSettingPrimary(version.id);
    try {
      await api.setAssetPrimary(assetId, version.id);
      versionState.setData((current) => current ? { ...current, items: current.items.map((item) => ({ ...item, is_primary: item.id === version.id })) } : current);
      notify("主图已更新", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "设置主图失败"), "error");
    } finally {
      setSettingPrimary("");
    }
  }

  /** 上传：板12「传完即可用」（后端上传即 approved，上传时不存在待审档——S17-A3 已摘假档）。
   *  S11-5：「资产职责」接上真链路——用户在弹窗改了职责（与资产当前 role 不同）时，
   *  先 PATCH 资产 role（后端 updateAssetSchema 白名单含 role），再传图；改职责失败不硬传。 */
  async function uploadMedia(input: AssetUploadInput): Promise<void> {
    if (demoMode) {
      notify("离线演示不会上传图片", "info");
      return;
    }
    setUploading(true);
    try {
      if (input.role && input.role !== (asset?.role ?? "")) {
        await api.updateAsset(assetId, { role: input.role });
        assetState.retry();
      }
      const created = await api.uploadAssetMedia(assetId, input.file, {
        title: input.title,
        isPrimary: input.setPrimary,
      });
      versionState.setData((current) => {
        const existing = (current?.items ?? []).filter((item) => item.id !== created.id);
        const items = input.setPrimary
          ? [created, ...existing.map((item) => ({ ...item, is_primary: false }))]
          : [created, ...existing];
        return { items, count: items.length };
      });
      setShowUpload(false);
      versionState.retry();
      assetState.retry();
      notify(input.setPrimary ? "图片已上传并设为该变体主图" : "图片已上传，传完即可用", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "上传图片失败"), "error");
      throw reason;
    } finally {
      setUploading(false);
    }
  }

  /** 保存修改：描述 → intro，标签 → style_tags，image_prompt → metadata.image_prompt（后端无一等字段，约定见 components/asset-upload-modal）。 */
  async function saveDetails(): Promise<void> {
    if (!asset || readOnly) return;
    const intro = descDraft.trim();
    const styleTags = normalizeStyleTags(tagsDraft);
    const metadata = assetMetadataWithImagePrompt(asset.metadata, promptDraft);
    if (demoMode) {
      assetState.setData({ ...asset, intro, style_tags: styleTags, metadata });
      notify("离线演示只更新当前页面，未写入资产", "info");
      return;
    }
    setSaving(true);
    try {
      const updated = await patchAsset(asset.id, { intro, style_tags: styleTags, metadata });
      assetState.setData(updated);
      notify("资产描述与提示词已保存", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "保存失败"), "error");
    } finally {
      setSaving(false);
    }
  }

  function downloadVersion(version: MediaVersion | null): void {
    if (!version) {
      notify("该变体还没有图片，先上传一张", "info");
      return;
    }
    if (demoMode) {
      notify("离线演示不会下载真实文件", "info");
      return;
    }
    void api.downloadMedia(version.id).catch((reason: unknown) => notify(businessErrorMessage(reason, "下载失败"), "error"));
  }

  async function deleteAsset(): Promise<void> {
    if (!asset || readOnly) return;
    if (demoMode) {
      setConfirmDelete(false);
      notify("离线演示不会写入回收站", "info");
      navigate(`/projects/${projectId}/assets`);
      return;
    }
    setDeleting(true);
    try {
      await api.deleteAsset(asset.id);
      notify("资产已移入回收站", "success");
      navigate(`/projects/${projectId}/assets`);
    } catch (reason) {
      notify(businessErrorMessage(reason, "删除失败"), "error");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (assetState.loading) {
    return (
      <section className="mx-auto flex w-full max-w-[1920px] flex-col gap-5">
        <LoadingState label="正在读取资产详情" />
        <SlowLoadingNote show={slowLoading} onRetry={assetState.retry} />
      </section>
    );
  }
  if (assetState.error || !asset) return <ErrorState message={assetState.error || "资产不存在"} onRetry={assetState.retry} />;

  const reviewBucket = assetReviewBucket(asset.status);
  const referenceLines = assetReferenceLines(asset);
  const primaryIndex = activeGroup.primary ? activeGroup.versions.findIndex((version) => version.id === activeGroup.primary?.id) : -1;
  const previewVersion = previewIndex != null ? activeGroup.versions[previewIndex] : undefined;
  return (
    <section className="mx-auto flex w-full max-w-[1920px] flex-col gap-5">
      <div className="flex items-center gap-2 text-sm">
        <button type="button" className="inline-flex items-center gap-1 text-accent-text hover:underline [&_svg]:size-4" onClick={() => navigate(`/projects/${projectId}/assets`)}><ArrowLeft aria-hidden="true" />本剧资产</button>
        <span className="text-ink-4">/</span>
        <span className="text-ink-2">{assetKindLabel(asset.asset_kind)}详情</span>
      </div>
      <header className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border-1 bg-surface-1 px-5 py-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-page-title text-ink-1">{assetName(asset)}</h1>
            <RoleBadge role={asset.role} />
            {asset.scope === "common" ? <ReviewPill status={asset.status} /> : null}
          </div>
          <p className="mt-1 text-xs text-ink-4">{assetTypeLine(asset)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {asset.scope === "personal" ? (
            /* S11-6：端点未开——改不可用态+说明（与版本删除按钮同做法），点了没反应的按钮比灰按钮更伤信任 */
            <Button
              icon={<Archive />}
              disabled
              title="转为团队通用资产即将上线"
              onClick={() => undefined}
            >入库转通用</Button>
          ) : null}
          {/* S17-C：下一步去路——补完图去生产页用它（来路=←本剧资产，去路=生产页）。
              「新建人设」旧入口从详情页撤下：创建归列表页「更多→创建角色/场景/道具」一处，不两处重复。 */}
          <Button variant="outline" icon={<FilmStrip />} onClick={() => navigate(`/projects/${projectId}/storyboards`)}>去生产页使用</Button>
        </div>
      </header>
      {readOnly ? <div className={inlineNoteClass}>通用资产只读，可以查看和引用，不能上传图片、编辑描述或修改主图。</div> : null}
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="资产变体">
        {allGroups.map((group) => (
          <button
            key={group.id || "default"}
            role="tab"
            aria-selected={activeGroup.id === group.id}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-3 py-1 text-xs transition-colors duration-150 ease-out-quart",
              activeGroup.id === group.id
                ? "border-transparent bg-accent-subtle font-semibold text-accent-text"
                : "border-border-1 bg-surface-2 text-ink-2 hover:border-border-2 hover:text-ink-1",
            )}
            type="button"
            onClick={() => selectVariant(group.id)}
          >{group.name}</button>
        ))}
        {/* S17-A4：变体写入端点未开（已转后端 k3 包 3）——入口隐藏，不摆永远点不动的死按钮；
            存量变体正常展示，端点开了再放进入口。 */}
      </div>
      <div className="grid items-start gap-5 min-[1100px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          <button
            className="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg border border-border-1 bg-surface-well p-0"
            type="button"
            disabled={!activeGroup.primary}
            title={activeGroup.primary ? "点击图片放大预览" : "该变体还没有图片"}
            onClick={() => openPreview(primaryIndex)}
          >
            {activeGroup.primary
              ? <MediaThumb version={activeGroup.primary} asset={asset} large />
              : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-ink-4">
                  <ImageSquare className="size-10" aria-hidden="true" />
                  <span className="text-xs">{activeGroup.name}还没有图片</span>
                </div>
              )}
            <span className="absolute left-3 top-3 rounded-sm border border-border-2 bg-surface-1/80 px-2 py-0.5 text-xs text-ink-1 backdrop-blur-sm">主图</span>
          </button>
          {versionState.error ? <ErrorState message={versionState.error} onRetry={versionState.retry} /> : null}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
            {activeGroup.versions.map((version, index) => (
              <button
                className={cn(
                  "overflow-hidden rounded-md border bg-surface-1 p-0 text-left transition-colors duration-150 ease-out-quart hover:border-accent",
                  version.is_primary ? "border-accent" : "border-border-1",
                )}
                key={version.id}
                type="button"
                onClick={() => openPreview(index)}
                title="点击放大预览"
              >
                <span className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-surface-well">
                  <MediaThumb version={version} asset={asset} />
                </span>
                <span className="flex items-center justify-between gap-1 px-2 py-1 text-xs text-ink-2">
                  <span className="truncate">{viewLabelForVersion(version, index)}</span>
                  {version.is_primary ? <span className="shrink-0 font-semibold text-accent-text">主图</span> : null}
                </span>
                {/* S10-D2：版本备注——后端 toAssetMediaData 真出 description 字段，有值才展示 */}
                {version.description?.trim() ? (
                  <span className="block truncate px-2 pb-1 text-[11px] text-ink-4" title={version.description}>备注：{version.description}</span>
                ) : null}
              </button>
            ))}
            {!readOnly ? (
              <button type="button" className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border-2 text-xs text-ink-4 transition-colors duration-150 ease-out-quart hover:border-accent hover:text-accent-text" onClick={() => setShowUpload(true)}>
                <CloudArrowUp className="size-5" aria-hidden="true" />
                上传图片
              </button>
            ) : null}
          </div>
          <p className="text-xs text-ink-4">点击图片放大预览；主图用于检索缩略与 @素材引用。</p>
        </div>
        <aside className="flex flex-col gap-3">
          {/* S10-D2（丽芬批）：上下文卡——所属项目（真接口）+ 版本/变体计数（真实状态）；
              属于哪一集/哪个分镜/哪个场景的明细：资产响应无绑定字段（toAssetData 无、Shot 无资产清单、
              generationData 不含 shotId/reference_asset_snapshots），诚实标注缺口，不编造。 */}
          <Card className="flex flex-col gap-2 px-4 py-3" data-testid="asset-context-card">
            <header className="flex items-center justify-between gap-2">
              <h3 className="font-mono text-xs font-medium text-ink-4">上下文</h3>
            </header>
            {detailProjectState.data?.name ? (
              <p className="flex items-center gap-2 text-sm text-ink-2">
                <FolderSimple className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
                所属项目：{detailProjectState.data.name}
              </p>
            ) : null}
            <p className="flex items-center gap-2 text-sm text-ink-2">
              <ImagesSquare className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
              版本：{versions.length} 个版本 · {allGroups.length} 个变体
            </p>
            <p className="flex items-start gap-2 text-xs text-ink-4">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden="true" />
              <span>哪一集、哪个分镜、哪个场景在用它——使用情况功能上线后，在这里就能看到。</span>
            </p>
          </Card>
          {asset.scope === "common" ? (
            <Card className="flex flex-col gap-2 px-4 py-3">
              <header className="flex items-center justify-between gap-2">
                <h3 className="font-mono text-xs font-medium text-ink-4">审核（留痕可追）</h3>
                <ReviewPill status={asset.status} />
              </header>
              {reviewBucket === "pending" && reviewHint.reviewerName ? <span className="flex items-center gap-1 text-xs text-ink-4"><User className="size-3 shrink-0" aria-hidden="true" />审核人:{reviewHint.reviewerName}</span> : null}
              {reviewBucket === "rejected" && reviewHint.rejectionReason ? <span className="flex items-center gap-1 text-xs text-danger"><WarningCircle className="size-3 shrink-0" aria-hidden="true" />拒绝理由:{reviewHint.rejectionReason}</span> : null}
              {reviewBucket === "pending" && canModerateCommonAsset ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" icon={<Check />} loading={deciding} onClick={() => void decideReview("approve")}>通过</Button>
                  <Button variant="danger" icon={<X />} disabled={deciding} onClick={() => setRejectOpen(true)}>拒绝</Button>
                </div>
              ) : (
                <p className="text-xs text-ink-4">
                  {!canModerateCommonAsset
                    ? "通用资产只由平台管理员审核。"
                    : reviewBucket === "auto"
                      ? "自动审核已通过。"
                      : reviewBucket === "approved"
                        ? "已通过终审；资产卡上不再显示裁决按钮。"
                        : "已拒绝留档；平台管理员可重新提审。"}
                </p>
              )}
              <ReviewTrailPanel projectId={projectId} assetId={asset.id} demoMode={demoMode} onRecords={(records) => setReviewHint((current) => {
                const next = reviewHintFromRecords(records);
                const reviewerName = next.reviewerName ?? current.reviewerName;
                const rejectionReason = next.rejectionReason ?? current.rejectionReason;
                if (reviewerName === current.reviewerName && rejectionReason === current.rejectionReason) return current;
                return { reviewerName, rejectionReason };
              })} />
            </Card>
          ) : null}
          <Card className="flex flex-col gap-2 px-4 py-3">
            <header className="flex items-center justify-between gap-2">
              <h3 className="font-mono text-xs font-medium text-ink-4">描述（检索与提示词的原料）</h3>
            </header>
            <Textarea
              value={descDraft}
              maxLength={10_000}
              disabled={readOnly}
              placeholder="这个资产长什么样、什么气质；检索和提示词都会用到它。"
              onChange={(event) => setDescDraft(event.target.value)}
            />
            <div className="flex flex-wrap items-center gap-1">
              {tagsDraft.map((tag) => (
                <span className={tagChipClass} key={tag}>
                  {tag}
                  {!readOnly ? (
                    <button type="button" className="text-ink-4 transition-colors hover:text-danger [&_svg]:size-3" aria-label={`移除标签 ${tag}`} onClick={() => setTagsDraft((current) => current.filter((item) => item !== tag))}><X aria-hidden="true" /></button>
                  ) : null}
                </span>
              ))}
              {!readOnly ? (
                tagInputOpen ? (
                  <Input
                    className="h-6 w-24 rounded-full px-2 text-xs"
                    value={tagInput}
                    autoFocus
                    placeholder="标签名"
                    onChange={(event) => setTagInput(event.target.value)}
                    onBlur={() => { commitTag(tagInput, setTagsDraft); setTagInput(""); setTagInputOpen(false); }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitTag(tagInput, setTagsDraft);
                        setTagInput("");
                        setTagInputOpen(false);
                      }
                    }}
                  />
                ) : (
                  <button type="button" className="inline-flex items-center gap-1 rounded-full border border-dashed border-border-2 px-2 py-0.5 text-xs text-ink-4 transition-colors hover:border-accent hover:text-accent-text [&_svg]:size-3" onClick={() => setTagInputOpen(true)}><Plus aria-hidden="true" />标签</button>
                )
              ) : null}
            </div>
          </Card>
          <Card className="flex flex-col gap-2 px-4 py-3">
            <header className="flex items-center justify-between gap-2">
              <h3 className="font-mono text-xs font-medium text-ink-4">image_prompt（生图用）</h3>
              <button
                type="button"
                disabled={draftingPrompt || readOnly}
                className="inline-flex items-center gap-1 rounded-md border border-agent/40 bg-agent/10 px-2 py-0.5 text-xs text-agent-text transition-colors duration-150 ease-out-quart hover:border-agent disabled:opacity-60 [&_svg]:size-3"
                title="用上面的简介让 AI 起草提示词，可再修改"
                onClick={() => void draftPromptByDescription()}
              ><Sparkle aria-hidden="true" />{draftingPrompt ? "正在起草…" : "按描述生成"}</button>
            </header>
            <Textarea
              value={promptDraft}
              maxLength={10_000}
              disabled={readOnly}
              placeholder="用于生图的提示词；保存后写入资产 metadata.image_prompt。"
              onChange={(event) => setPromptDraft(event.target.value)}
            />
          </Card>
          <Card className="flex flex-col gap-2 px-4 py-3">
            <header className="flex items-center justify-between gap-2">
              <h3 className="font-mono text-xs font-medium text-ink-4">引用情况</h3>
            </header>
            {referenceLines.map((line) => (
              <p
                className={cn(
                  "flex items-center gap-2 text-sm before:size-[5px] before:shrink-0 before:rounded-full before:content-['']",
                  line.active ? "text-ink-2 before:bg-accent" : "text-ink-4 before:bg-ink-3",
                )}
                key={line.text}
              >{line.text}</p>
            ))}
          </Card>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={<Check />}
              loading={saving}
              disabled={readOnly || !dirty}
              title={readOnly ? "通用资产只读" : dirty ? "保存描述、标签与 image_prompt" : "没有待保存的修改"}
              onClick={() => void saveDetails()}
            >保存修改</Button>
            <Button icon={<DownloadSimple />} onClick={() => downloadVersion(activeGroup.primary)}>下载</Button>
            <Button
              variant="danger"
              icon={<Trash />}
              disabled={readOnly}
              title={readOnly ? "通用资产只读" : "移入回收站，可恢复"}
              onClick={() => setConfirmDelete(true)}
            >删除</Button>
          </div>
        </aside>
      </div>
      {showUpload ? (
        <AssetUploadModal
          variantName={activeGroup.name}
          defaultPrimary={activeGroup.versions.length === 0}
          demoMode={demoMode}
          busy={uploading}
          onClose={() => setShowUpload(false)}
          onSubmit={uploadMedia}
        />
      ) : null}
      {previewVersion ? (
        <AssetLightbox
          versions={activeGroup.versions}
          index={previewIndex!}
          label={viewLabelForVersion(previewVersion, previewIndex!)}
          asset={asset}
          readOnly={Boolean(readOnly)}
          settingPrimary={settingPrimary}
          onClose={() => setPreviewIndex(null)}
          onNavigate={(delta) => setPreviewIndex((current) => {
            if (current == null || activeGroup.versions.length === 0) return current;
            return (current + delta + activeGroup.versions.length) % activeGroup.versions.length;
          })}
          onDownload={() => downloadVersion(previewVersion)}
          onSetPrimary={() => void setPrimary(previewVersion)}
        />
      ) : null}
      {confirmDelete ? (
        <Dialog open onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
          <DialogContent size="small">
            <DialogHeader>
              <DialogTitle>{`删除资产「${assetName(asset)}」`}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="text-sm text-ink-2">资产会移入回收站，可恢复；项目里的引用同步失效，资产中心其他资产不受影响。</p>
            </DialogBody>
            <DialogFooter>
              <Button disabled={deleting} onClick={() => setConfirmDelete(false)}>取消</Button>
              <Button variant="danger" icon={<Trash />} loading={deleting} onClick={() => void deleteAsset()}>移入回收站</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {rejectOpen && canModerateCommonAsset ? (
        <RejectReasonModal
          assetName={assetName(asset)}
          busy={deciding}
          onClose={() => setRejectOpen(false)}
          onSubmit={(reason) => void decideReview("reject", reason)}
        />
      ) : null}
    </section>
  );
}

function commitTag(value: string, setTagsDraft: React.Dispatch<React.SetStateAction<string[]>>): void {
  const tag = value.trim();
  if (!tag) return;
  setTagsDraft((current) => (current.includes(tag) ? current : [...current, tag]));
}

/* ---------- 板12 全屏放大层：左右键切换、esc 关闭、右上 下载/设为主图/删除 ---------- */

function AssetLightbox({ versions, index, label, asset, readOnly, settingPrimary, onClose, onNavigate, onDownload, onSetPrimary }: {
  versions: MediaVersion[];
  index: number;
  label: string;
  asset: Asset;
  readOnly: boolean;
  settingPrimary: string;
  onClose: () => void;
  onNavigate: (delta: number) => void;
  onDownload: () => void;
  onSetPrimary: () => void;
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onNavigate(-1);
      if (event.key === "ArrowRight") onNavigate(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate]);
  const version = versions[index];
  const url = version?.storage_url || version?.thumbnail_url || version?.source_file_url;
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-surface-well/90" role="dialog" aria-modal="true" aria-label="图片全屏预览" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <header className="absolute inset-x-5 top-4 flex items-center justify-between gap-3 text-sm text-ink-2">
        <span>{label} · {index + 1} / {versions.length}</span>
        <div className="flex gap-2">
          <Button icon={<DownloadSimple />} onClick={onDownload}>下载</Button>
          <Button
            variant="accent"
            icon={<Star />}
            loading={Boolean(version) && settingPrimary === version!.id}
            disabled={readOnly || version?.is_primary}
            title={readOnly ? "通用资产只读" : version?.is_primary ? "已是主图" : "设为该变体主图"}
            onClick={onSetPrimary}
          >{version?.is_primary ? "当前主图" : "设为主图"}</Button>
          <Button variant="danger" icon={<Trash />} disabled title="该版本可能被引用，删除功能完善后开放">删除</Button>
          <Button variant="ghost" size="icon" aria-label="关闭（Esc）" onClick={onClose}><X /></Button>
        </div>
      </header>
      <button type="button" className="absolute left-5 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-border-2 bg-surface-1/80 text-ink-1 backdrop-blur-sm transition-colors hover:border-accent hover:text-accent-text disabled:opacity-40 [&_svg]:size-5" aria-label="上一张（←）" disabled={versions.length < 2} onClick={() => onNavigate(-1)}><CaretLeft aria-hidden="true" /></button>
      <div className="flex max-h-[86vh] max-w-[86vw] items-center justify-center">
        {url
          ? <img className="max-h-[86vh] max-w-[86vw] rounded-sm object-contain" src={url} alt={label} />
          : <div className="flex aspect-[4/3] w-[min(60vw,560px)] flex-col items-center justify-center gap-2 rounded-md bg-surface-1 text-ink-4"><ImageSquare className="size-10" aria-hidden="true" /><span className="text-sm">{label}</span></div>}
      </div>
      <button type="button" className="absolute right-5 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-border-2 bg-surface-1/80 text-ink-1 backdrop-blur-sm transition-colors hover:border-accent hover:text-accent-text disabled:opacity-40 [&_svg]:size-5" aria-label="下一张（→）" disabled={versions.length < 2} onClick={() => onNavigate(1)}><CaretRight aria-hidden="true" /></button>
    </div>
  );
}

/* ---------- 板12 空表单态弹窗：新建变体 / 新建人设 ---------- */

interface BlankFormInput {
  name: string;
  kind: string;
  tags: string[];
  intro: string;
}

function AssetBlankFormModal({ mode, lockedKind, title, footerHint, onClose, onSubmit }: {
  mode: "variant" | "persona";
  /* S9-20：动作名承诺了对象类型的，类型即锁定（「新建人设」锁 character，
     「更多」菜单「创建角色/场景/道具…」各锁预填值）——锁定时类型显示为不可改说明行；
     不传才给全量类型选择（只配给标题不承诺类型的通用入口）。 */
  lockedKind?: string;
  /** 自定义标题（如「创建角色」）；缺省沿用「新建变体 / 新建人设」。 */
  title?: string;
  /** S17-B：闭环引导——告诉用户创建成功后去哪里、下一步干什么。 */
  footerHint?: string;
  onClose: () => void;
  onSubmit: (input: BlankFormInput) => Promise<void> | void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState(lockedKind ?? "character");
  const [tags, setTags] = useState("");
  const [intro, setIntro] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isVariant = mode === "variant";

  async function submit(): Promise<void> {
    if (!name.trim()) {
      setError(isVariant ? "请给变体起个名字" : "请起个名字");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await onSubmit({
        name: name.trim(),
        kind,
        tags: normalizeStyleTags(tags.split(/[,，]/)),
        intro: intro.trim(),
      });
    } catch (reason) {
      setError(businessErrorMessage(reason, "创建失败，请重试"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="medium">
        <DialogHeader>
          <DialogTitle>{title ?? (isVariant ? "新建变体" : "新建人设")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Field label={isVariant ? "变体名称" : "名称"}>
            <Input value={name} maxLength={128} autoFocus placeholder={isVariant ? "例如：铠甲染血" : "例如：李承瑶"} onChange={(event) => setName(event.target.value)} />
          </Field>
          {!isVariant ? (
            <Field label="类型" hint={lockedKind ? "类型随入口锁定，不可改选" : undefined}>
              {lockedKind ? (
                <p className="py-1 text-sm text-ink-1">{assetKindLabel(lockedKind)}</p>
              ) : (
                <ChevronSelect className="w-full" value={kind} onChange={(event) => setKind(event.target.value)}>
                  <AssetKindSelectOptions />
                </ChevronSelect>
              )}
            </Field>
          ) : null}
          {!isVariant ? (
            <Field label="标签（逗号分隔，可选）">
              <Input value={tags} placeholder="例如：女主，古装，青年" onChange={(event) => setTags(event.target.value)} />
            </Field>
          ) : null}
          <Field label={isVariant ? "说明（可选）" : "简介（可选）"}>
            <Textarea value={intro} maxLength={2000} placeholder={isVariant ? "这个变体与默认造型的差异" : "人物气质、外形锚点"} onChange={(event) => setIntro(event.target.value)} />
          </Field>
          {error ? <div className={formErrorClass} role="alert">{error}</div> : null}
          {footerHint ? <p className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2">{footerHint}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" icon={<Plus />} loading={busy} onClick={() => void submit()}>{isVariant ? "创建变体" : "创建"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MediaThumb({ version, asset, large }: { version?: MediaVersion; asset: Asset; large?: boolean }): React.JSX.Element {
  const url = version?.storage_url || version?.thumbnail_url || version?.source_file_url;
  if (url) return <img className={cn("h-full w-full", large ? "object-contain" : "object-cover")} src={url} alt={version?.title || assetName(asset)} />;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-ink-4">
      <ImageSquare className={large ? "size-10" : "size-6"} aria-hidden="true" />
      <span className="text-xs">{version?.title || assetName(asset)}</span>
    </div>
  );
}

/* ---------- 板03 demo fixture：分镜媒体（空白集 fixture 已迁 demo.ts，按 projectId 隔离） ---------- */

/* K2-A(GP-27):素材媒体 fixture 唯一真源 = demo.ts 的 demoShotMedia
   (含视频产物与审核状态,审核队列/交付/进度条同源,不再各写一份)。 */

/* demo 场景真源已收编 ../demo.ts(批次二 P-04 起唯一真源,本页经 import 消费)。 */

function demoShotsForEpisode(episodeId: string): Shot[] {
  if (episodeId === "demo-episode-1") return demoShots;
  if (episodeId === "demo-episode-2" || episodeId === "demo-episode-3") {
    /* 第 2/3 集保持零基础(媒体 fixture 只覆盖第 1 集),selected_* 一并剥掉,
       不假装这两集也有已选主版本。 */
    return demoShots.map((shot, index) => ({
      ...shot,
      id: `${episodeId}-shot-${index + 1}`,
      episode_id: episodeId,
      selected_image_result_id: null,
      selected_video_result_id: null,
    }));
  }
  return [];
}

/** K2I（GP-01 放行标注）：剧本步 3「导入设计圣经」功能归 k3 包 4（后端），没做出来
    之前的替代路径 = 手工建资产（docs/design/full-flow-screenplay.md 口径：可放行
    测试版但记入发版说明并【标注】；发版说明已记 docs/releases/v0.2.x-test-20260724.md）。
    标注挂在生产页——建完项目后用户到的第一个页面、步 4「导入剧本」同页，
    用户正是在这里需要知道角色/场景从哪来；按钮直达本剧资产页并自动打开
    「新建资产」弹窗（?create=1）。k3 包 4 上线后本组件整段删除。 */
export function BibleImportNote({ projectId }: { projectId: string }): React.JSX.Element {
  return (
    <div className={cn(inlineNoteClass, "flex flex-wrap items-center gap-x-3 gap-y-1")} role="note" aria-label="设计圣经导入说明">
      <span>设计圣经（角色/场景关系表）导入即将上线；上线前请先手工建立本剧的角色和场景。</span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-0.5 rounded-sm font-medium text-accent-text outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-accent [&_svg]:size-3.5"
        onClick={() => navigate(`/projects/${projectId}/assets?create=1`)}
      >
        去新建资产<ArrowRight aria-hidden="true" />
      </button>
    </div>
  );
}

export function StoryboardPage({ projectId, demoMode, notify, capabilities }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  /* S12-1：viewer 看不到创作按钮（生成/导入/新建素材）；显隐唯一判据=capabilities。 */
  const createGate = capabilityGate(capabilities, (caps) => canCreateInProject(caps, projectId));
  const canCreate = createGate === "allowed";
  /* K2O/GP-04：demo fallback 按 projectId 隔离——非 fixture 属主项目如实给空，不串《杀穿女频》的集。 */
  const demoEpisodeList = useMemo(() => demoEpisodesForProject(projectId), [projectId]);
  const episodeState = useResource(() => api.episodes(projectId), { items: demoEpisodeList, count: demoEpisodeList.length }, demoMode, [projectId]);
  /* S7-12：面包屑项目名（与资产页「项目管理 / 资产中心 / 项目资产」同款的来路可回）；
     K2O/GP-04：demo 下按 projectId 查（含本会话新建登记的项目），查不到如实「项目」，不顶别的项目名。 */
  const projectMetaState = useResource(() => api.project(projectId), demoProjectById(projectId) ?? { id: projectId, name: "项目" }, demoMode, [projectId]);
  const demoProjectAssetRefs = useMemo(() => demoProjectAssetsForProject(projectId), [projectId]);
  const projectAssetState = useResource(() => api.projectAssets(projectId), { items: demoProjectAssetRefs, count: demoProjectAssetRefs.length }, demoMode, [projectId]);
  const initialQuery = new URLSearchParams(window.location.search);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState(initialQuery.get("episode") || "");
  const episodes = episodeState.data?.items ?? [];
  const selectedEpisode = episodes.find((item) => item.id === selectedEpisodeId) ?? episodes[0];
  const selectedEpisodeId_ = selectedEpisode?.id ?? "";
  const demoShotList = useMemo(() => (selectedEpisodeId_ ? demoShotsForEpisode(selectedEpisodeId_) : []), [selectedEpisodeId_]);
  const shotState = useResource(
    () => selectedEpisode ? api.shots(selectedEpisode.id) : Promise.resolve({ items: [] as Shot[], count: 0 }),
    { items: demoShotList, count: demoShotList.length },
    demoMode,
    [selectedEpisodeId_, demoShotList],
  );
  /* S11-3：场景真数据（选中集变化即重拉；demo 走本地映射，与 shots 同口径）。 */
  const sceneState = useResource(
    () => selectedEpisode ? api.episodeScenes(selectedEpisode.id) : Promise.resolve({ items: [] as Scene[], count: 0 }),
    { items: [] as Scene[], count: 0 },
    demoMode,
    [selectedEpisodeId_, demoMode],
  );
  const sceneNameOf = useCallback(
    (shot: Shot): string | undefined => {
      if (demoMode) return DEMO_SHOT_SCENES[shot.id];
      if (!shot.scene_id) return undefined;
      return sceneState.data?.items.find((scene) => scene.id === shot.scene_id)?.name?.trim() || undefined;
    },
    [demoMode, sceneState.data],
  );
  const [showImport, setShowImport] = useState(false);
  const [showPlayback, setShowPlayback] = useState(initialQuery.get("playback") === "1");
  const [exportOpen, setExportOpen] = useState(false);
  /* K2U D-19：demo 导出 = 内存生成 JSON/CSV + 预览/复制（不落盘），与连播页脚/工作台顶栏同一弹窗。 */
  const [exportPreview, setExportPreview] = useState<DemoExportKind | null>(null);
  /* K2-A 幕四:产物审核队列与交付弹窗(入口在本页集头,深链 ?review=1 / ?delivery=1|history)。 */
  const [reviewOpen, setReviewOpen] = useState(initialQuery.get("review") === "1");
  const [deliveryView, setDeliveryView] = useState<"deliver" | "history" | null>(
    initialQuery.get("delivery") === "history" ? "history" : initialQuery.get("delivery") === "1" ? "deliver" : null,
  );
  const [deliveredRevision, setDeliveredRevision] = useState(0);
  const [batchKind, setBatchKind] = useState<GenerationMediaKind | null>(null);
  const [addingShot, setAddingShot] = useState(false);
  const [addingEpisode, setAddingEpisode] = useState(false);
  /* S7-5：使用资产是参考信息不是行动区——默认收成摘要行，点开才展开 chips */
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<StoryboardImportRecord | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  /* K2N(GP-07):场景核对取数——后端预览响应没有绑定/候选数据(缺口已挂接缝),
     前端按预览行引用的集拉取已有场景,试算按名命中/候选/未命中给用户核对。 */
  const [sceneTrialScenes, setSceneTrialScenes] = useState<ReadonlyMap<string, Scene[]>>(new Map());
  const [sceneTrialState, setSceneTrialState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  useEffect(() => {
    if (!preview) {
      setSceneTrialScenes(new Map());
      setSceneTrialState("idle");
      return;
    }
    if (demoMode) {
      setSceneTrialScenes(DEMO_EPISODE_SCENES);
      setSceneTrialState("ready");
      return;
    }
    let cancelled = false;
    setSceneTrialState("loading");
    const episodeList = episodeState.data?.items ?? [];
    const episodeNumbers = [...new Set(preview.preview.rows.map((row) => row.episode_no).filter((no): no is number => typeof no === "number"))];
    const targets = episodeNumbers
      .map((no) => episodeList.find((episode) => episode.episode_no === no))
      .filter((episode): episode is Episode => Boolean(episode));
    Promise.all(targets.map(async (episode) => [episode.id, (await api.episodeScenes(episode.id)).items] as const))
      .then((entries) => {
        if (cancelled) return;
        setSceneTrialScenes(new Map(entries));
        setSceneTrialState("ready");
      })
      .catch(() => {
        if (!cancelled) setSceneTrialState("failed");
      });
    return () => {
      cancelled = true;
    };
  }, [preview, demoMode, episodeState.data]);
  const sceneTrials = useMemo(
    () => (preview && sceneTrialState === "ready" ? trialSceneBindings(preview.preview.rows, episodes, sceneTrialScenes) : []),
    [preview, episodes, sceneTrialScenes, sceneTrialState],
  );
  const fileInput = useRef<HTMLInputElement>(null);
  /* S30：命令面板深链 ?addShot=1 只执行一次的防重跑锁（StrictMode 双跑也安全）。 */
  const addShotDeepLinkHandled = useRef(false);

  useEffect(() => {
    if (!selectedEpisodeId && episodes[0]) setSelectedEpisodeId(episodes[0].id);
  }, [episodes, selectedEpisodeId]);

  /* A6：所选集进 URL（replaceState 不堆历史）——进工作台/连播往返后回到同一集 */
  useEffect(() => {
    if (!selectedEpisodeId_) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("episode") === selectedEpisodeId_) return;
    params.set("episode", selectedEpisodeId_);
    navigate(`/projects/${projectId}/storyboards?${params.toString()}`, { replace: true });
  }, [selectedEpisodeId_, projectId]);

  /* K2-A：深链同步——进度条 CTA「查看交付历史」在本页内跳 ?delivery=history 时
     不重挂载本组件,靠 popstate 把弹窗状态对齐到 URL(与 playback 初始读法互补)。 */
  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("review") === "1") setReviewOpen(true);
      const delivery = params.get("delivery");
      if (delivery === "1" || delivery === "history") setDeliveryView(delivery === "history" ? "history" : "deliver");
    };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const shots = useMemo(
    () => [...(shotState.data?.items ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [shotState.data],
  );
  /* K2J：素材卡任务徽标的台账——批量/单镜提交时注册（batch-generate-drawer / workbench），
     渲染时读一次；提交完成 onCreated 重拉分镜、关抽屉都会触发重渲染，台账随之刷新。
     台账不可读（隐私模式等）时徽标退化为不显示，工作台恢复机制不受影响。 */
  const trackedByShot = (() => {
    const grouped = new Map<string, TrackedGenerationRequest[]>();
    try {
      for (const entry of listGenerationRequests(window.sessionStorage, projectId)) {
        grouped.set(entry.shotId, [...(grouped.get(entry.shotId) ?? []), entry]);
      }
    } catch {
      /* sessionStorage 不可用：不显示徽标 */
    }
    return grouped;
  })();
  const scriptEpisodes = useMemo(() => episodes.filter((episode) => episodeGroup(episode) === "script"), [episodes]);
  const blankEpisodes = useMemo(() => episodes.filter((episode) => episodeGroup(episode) === "blank"), [episodes]);
  const referenceMediaIds = useMemo(() => referenceMediaIdsFromRefs(projectAssetState.data?.items ?? []), [projectAssetState.data]);

  const videoDone = shots.filter((shot) => shot.selected_video_result_id).length;
  const episodeVideoStatus = shots.length === 0
    ? "本集还没有粗剪素材"
    : videoDone === 0
      ? "本集视频未生成"
      : videoDone === shots.length
        ? `本集视频已生成 ${videoDone}/${shots.length}`
        : `本集视频已生成 ${videoDone}/${shots.length}，其余待生成`;

  /* K2-A(GP-26):集头如实显示交付事实(次数 + 最近一次时间);未交付不显示这行。 */
  const latestDeliveryState = useResource(
    () => selectedEpisode ? api.episodeDeliveries(selectedEpisode.id, 1, 1) : Promise.resolve({ items: [], total: 0, page: 1, pageSize: 1 }),
    demoDeliveriesPage(selectedEpisode?.id ?? "", 1, 1),
    demoMode,
    [selectedEpisodeId_, deliveredRevision],
  );
  const latestDelivery = latestDeliveryState.data?.items[0] ?? null;
  const deliveryCount = latestDeliveryState.data?.total ?? 0;

  /** 交付落账后:集头行重读 + 通知进度条(episode-delivered)刷新「已交付」终态。 */
  function handleDelivered(): void {
    setDeliveredRevision((value) => value + 1);
    window.dispatchEvent(new Event("episode-delivered"));
  }

  /** 关闭幕四弹窗时剥掉对应深链参数(与 playback 的关法同一路径)。 */
  function closeReviewDeliveryParams(): void {
    const params = new URLSearchParams(window.location.search);
    if (!params.has("review") && !params.has("delivery")) return;
    params.delete("review");
    params.delete("delivery");
    const query = params.toString();
    navigate(`/projects/${projectId}/storyboards${query ? `?${query}` : ""}`, { replace: true });
  }

  function refreshAll(): void {
    episodeState.retry();
    shotState.retry();
    projectAssetState.retry();
  }

  /** 新建空白集（纯手动）：createEpisode，名称带"空白集"供分组识别。 */
  async function addBlankEpisode(): Promise<void> {
    const nextNo = episodes.reduce((max, episode) => Math.max(max, episode.episode_no ?? 0), 0) + 1;
    if (demoMode) {
      const episode: Episode = { id: `demo-blank-${Date.now()}`, project_id: projectId, episode_no: nextNo, name: `空白集 ${nextNo}`, status: "active", shot_count: 0, sort_order: nextNo };
      episodeState.setData((current) => ({ items: [...(current?.items ?? []), episode], count: (current?.count ?? 0) + 1 }));
      setSelectedEpisodeId(episode.id);
      notify("离线演示只更新当前页面，未写入服务", "info");
      return;
    }
    setAddingEpisode(true);
    try {
      const created = await api.createEpisode(projectId, { title: `空白集 ${nextNo}`, episode_no: nextNo });
      episodeState.retry();
      setSelectedEpisodeId(created.id);
      notify("已新建空白集，可手动添加粗剪素材", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "新建空白集失败"), "error");
    } finally {
      setAddingEpisode(false);
    }
  }

  /** 添加粗剪素材（手动）：createShot，镜号取当前最大数字 +1。 */
  async function addShot(): Promise<void> {
    if (!selectedEpisode) return;
    const nextNo = shots.reduce((max, shot) => {
      const value = Number.parseInt(shot.shot_no, 10);
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, 0) + 1;
    if (demoMode) {
      const shot: Shot = { id: `demo-shot-manual-${Date.now()}`, episode_id: selectedEpisode.id, shot_no: String(nextNo), sort_order: nextNo, script_text: "" };
      shotState.setData((current) => ({ items: [...(current?.items ?? []), shot], count: (current?.count ?? 0) + 1 }));
      notify("离线演示只更新当前页面，未写入服务", "info");
      return;
    }
    setAddingShot(true);
    try {
      await api.createShot(selectedEpisode.id, { shot_no: String(nextNo), sort_order: nextNo, title: null });
      shotState.retry();
      notify("已添加粗剪素材，可进入工作台补文字描述与参考包", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "添加粗剪素材失败"), "error");
    } finally {
      setAddingShot(false);
    }
  }

  /* S30：命令面板深链 ?addShot=1 —— 等剧集与本集素材都就绪后，替用户点一次「添加粗剪素材」。
     只执行一次（ref 防重跑），执行前剥参不污染刷新；无权限、无剧集、素材加载失败都如实告知。 */
  useEffect(() => {
    if (addShotDeepLinkHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("addShot") !== "1") return;
    if (!episodeState.data) return;
    if (episodes.length > 0 && !selectedEpisodeId_) return;
    if (selectedEpisode && shotState.loading) return;
    addShotDeepLinkHandled.current = true;
    params.delete("addShot");
    const query = params.toString();
    navigate(`/projects/${projectId}/storyboards${query ? `?${query}` : ""}`, { replace: true });
    if (!canCreate) {
      notify("当前角色不能添加粗剪素材", "info");
      return;
    }
    if (!selectedEpisode) {
      notify("这个项目还没有剧集，先新建一集再添加粗剪素材", "info");
      return;
    }
    if (shotState.error) {
      notify(shotState.error, "error");
      return;
    }
    void addShot();
  }, [episodeState.data, episodes, selectedEpisodeId_, selectedEpisode, shotState.loading, shotState.error, canCreate, projectId, notify]);

  /** 导出：全版本走 CSV 清单，主版本走 JSON 交付清单（既有 deliverables 接口）。
      K2U D-19：demo 不再只弹 toast——内容在内存生成并预览/复制（不落盘）。 */
  async function exportEpisode(mode: "all" | "primary"): Promise<void> {
    if (!selectedEpisode) return;
    if (demoMode) {
      setExportPreview(mode === "all" ? "csv" : "json");
      return;
    }
    try {
      if (mode === "all") await api.downloadEpisodeCsv(selectedEpisode.id);
      else await api.downloadEpisodeJson(selectedEpisode.id);
      notify("导出已开始下载", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "导出失败，请重试"), "error");
    }
  }

  async function previewImport(): Promise<void> {
    if (!file) {
      setImportError("请先选择粗剪素材 Excel 文件");
      return;
    }
    setImportError("");
    if (demoMode) {
      /* K2O/GP-08：demo 不解析文件——预览走诚实形态（示例数据+显著标注），不冒充解析结果。
         行内容 = K2N 十列示例（覆盖绑定试算三种状态），已收进 demo.ts 的 demoStoryboardImportPreview。 */
      setPreview(demoStoryboardImportPreview(projectId, file.name));
      return;
    }
    setImporting(true);
    try {
      setPreview(await api.previewStoryboard(projectId, file));
    } catch (reason) {
      setImportError(businessErrorMessage(reason, "解析粗剪素材失败，请重试"));
    } finally {
      setImporting(false);
    }
  }

  async function confirmImport(): Promise<void> {
    if (!preview || !canConfirmStoryboardImport(preview)) return;
    setImportError("");
    setImporting(true);
    try {
      const confirmed = await api.confirmStoryboard(preview.id);
      const importedCount = confirmed.confirmation_result?.imported_shot_count ?? preview.preview.rows.length;
      notify(`已导入 ${importedCount} 条粗剪素材。点素材卡进入工作台。`, "success");
      closeImport();
      window.dispatchEvent(new Event("production-progress-changed"));
      episodeState.retry();
      shotState.retry();
    } catch (reason) {
      setImportError(businessErrorMessage(reason, "确认导入失败，请重试"));
    } finally {
      setImporting(false);
    }
  }

  /** 关闭导入弹窗并复位其本地状态（取消/确认成功/点遮罩同一路径）。 */
  function closeImport(): void {
    setShowImport(false);
    setPreview(null);
    setFile(null);
    setImportError("");
  }

  const episodeAssets = projectAssetState.data?.items ?? [];
  const firstShot = shots[0];
  /* 就绪=人工判断（Dario 拍板）：「生成本集」只对本集人工标记就绪的粗剪素材依序执行；
     就绪标记读本地存储（后端 ready_marked_by/at 字段等 Sol，合同①已定形状）。 */
  const [readyMarks, setReadyMarks] = useState<Record<string, ReadyMark>>({});
  const shotSlow = useSlowLoading(shotState.loading);
  useEffect(() => {
    const load = () => setReadyMarks(loadReadyMarks(window.localStorage, shots.map((shot) => shot.id)));
    load();
    window.addEventListener("shot-ready-changed", load);
    return () => window.removeEventListener("shot-ready-changed", load);
  }, [shots]);
  const readyShots = shots.filter((shot) => readyMarks[shot.id]);

  return (
    <section className="flex w-full flex-col gap-5 min-[900px]:flex-row min-[900px]:items-start">
      {/* S9-4：左栏层级重做——两个分组大卡收成一个容器：单列表 + 12px 灰字小节头分组，
          「导入剧本 / 新建空白集」降为列表底部入口行（示例文件链接贴近导入入口） */}
      <aside className="flex w-full shrink-0 flex-col min-[900px]:sticky min-[900px]:top-4 min-[900px]:w-[248px]" aria-label="剧集列表">
        <Card className="flex flex-col gap-1 p-3">
          <h2 className="px-1 pb-1 text-xs text-ink-4">剧本集 · {scriptEpisodes.length}</h2>
          <div className="flex flex-row flex-wrap gap-1 min-[900px]:flex-col">
            {episodeState.loading ? <span className="px-1 py-2 text-xs text-ink-4">正在读取剧集…</span> : null}
            {/* H 线：episode.shot_count 在后端 /episodes 响应里不存在（toEpisode 无计数字段，Sol 后端缺口已上报），
                无数据时不显示计数而不是渲染「0 素材」；demo fixture 带真实计数，照常显示。 */}
            {scriptEpisodes.map((episode) => (
              <EpisodeRailItem
                key={episode.id}
                episode={episode}
                active={selectedEpisode?.id === episode.id}
                statusText={typeof episode.shot_count === "number" ? `${episode.shot_count} 素材` : ""}
                onSelect={() => setSelectedEpisodeId(episode.id)}
              />
            ))}
          </div>
          <h2 className="px-1 pb-1 pt-3 text-xs text-ink-4">空白集 · {blankEpisodes.length}</h2>
          <div className="flex flex-row flex-wrap gap-1 min-[900px]:flex-col">
            {blankEpisodes.map((episode) => (
              <EpisodeRailItem
                key={episode.id}
                episode={episode}
                active={selectedEpisode?.id === episode.id}
                statusText={typeof episode.shot_count === "number" ? `${episode.shot_count} 素材` : ""}
                onSelect={() => setSelectedEpisodeId(episode.id)}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-col gap-0.5 border-t border-border-1 pt-2">
            {/* S12-1：viewer 不显示创作入口（导入/新建集）；示例文件下载只读保留 */}
            <div className="flex items-center justify-between gap-2">
              {canCreate ? (
                <button type="button" className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-ink-2 transition-colors duration-150 ease-out-quart hover:bg-surface-2 hover:text-accent-text [&_svg]:size-3.5" title="导入剧本 Excel 自动建集并拆成粗剪素材" onClick={() => setShowImport(true)}>
                  <FileXls aria-hidden="true" />导入剧本
                </button>
              ) : <span />}
              <a className="rounded-sm px-1 text-xs text-ink-4 transition-colors hover:text-accent-text" href="/shortdrama-script-template.xlsx" download title="下载示例 Excel，照表头填写后导入">示例文件</a>
            </div>
            {canCreate ? (
              <button className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-ink-2 transition-colors duration-150 ease-out-quart hover:bg-surface-2 hover:text-accent-text disabled:text-ink-4 [&_svg]:size-3.5" type="button" disabled={addingEpisode} onClick={() => void addBlankEpisode()}>
                <Plus aria-hidden="true" />{addingEpisode ? "正在新建…" : "新建空白集（纯手动）"}
              </button>
            ) : <CapabilityActionSlot state={capabilities} label="新建空白集（纯手动）" className="self-start" />}
          </div>
        </Card>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col gap-4">
        {/* S7-12：生产页面包屑——项目管理 / 《剧名》 / 第 N 集（与资产页同款） */}
        <nav className="flex items-center gap-1 text-xs text-ink-4" aria-label="面包屑">
          <button type="button" className="rounded-sm px-0.5 outline-none transition-colors hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent" onClick={() => navigate("/projects")}>项目管理</button>
          <span aria-hidden="true">/</span>
          <button type="button" className="rounded-sm px-0.5 outline-none transition-colors hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent" onClick={() => navigate(`/projects/${projectId}`)}>{projectMetaState.data?.name || "项目"}</button>
          <span aria-hidden="true">/</span>
          <span className="text-ink-2">{selectedEpisode ? `第 ${selectedEpisode.episode_no} 集` : "生产"}</span>
        </nav>
        {/* K2I（GP-01）：设计圣经导入放行标注——viewer 不能建资产，不显示（与创作入口同门径）。 */}
        {canCreate ? <BibleImportNote projectId={projectId} /> : null}
        {episodeState.error ? <ErrorState message={episodeState.error} onRetry={episodeState.retry} /> : null}
        {!episodeState.error && shotState.error ? <ErrorState message={shotState.error} onRetry={shotState.retry} /> : null}
        {!episodeState.error && !shotState.error && !selectedEpisode ? (
          episodeState.loading
            ? <LoadingState label="正在读取剧集" />
            : (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-border-1 bg-surface-1 px-8 py-12 text-center">
                <span className="flex size-14 items-center justify-center rounded-full bg-accent-subtle text-accent-text [&_svg]:size-7"><FilmSlate aria-hidden="true" /></span>
                <strong className="text-lg font-semibold text-ink-1">从第一集开始</strong>
                <p className="max-w-md text-sm text-ink-2">导入剧本 Excel 自动建集，并把剧本拆成粗剪素材；也可以先建一个空白集纯手动搭建。</p>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                  <Button variant="primary" icon={<FileXls />} onClick={() => setShowImport(true)}>导入剧本 Excel</Button>
                  <Button icon={<Plus />} loading={addingEpisode} onClick={() => void addBlankEpisode()}>新建空白集</Button>
                </div>
              </div>
            )
        ) : null}
        {!episodeState.error && !shotState.error && selectedEpisode ? (
          <>
            <Card className="flex flex-col gap-3 px-5 py-4">
              {/* S7-4：标题区与按钮行垂直居中对齐；生成本集唯一实心主按钮，预览/视频库降 ghost */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <h1 className="text-page-title text-ink-1">第 {selectedEpisode.episode_no} 集</h1>
                  <span className="text-sm text-ink-2">{episodeVideoStatus}</span>
                  {latestDelivery && deliveryCount > 0 ? (
                    <span className="text-xs text-success">已交付 {deliveryCount} 次 · 最近 {formatDateTime(latestDelivery.createdAt)}{latestDelivery.partial ? "（部分交付）" : ""}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* 生成本集=对人工标记就绪的粗剪素材依序执行（与单个生成两个动作两个界面）；
                      没有就绪素材时点击给提示，不硬锁——缺项永远只提示不阻塞（口径 2/3） */}
                  {/* S12-1：viewer 不显示创作按钮（预览/视频库只读保留） */}
                  {canCreate ? (
                  <Button
                    variant="primary"
                    icon={<Sparkle />}
                    title={readyShots.length > 0
                      ? `对本集 ${readyShots.length} 个已就绪粗剪素材依序生成。先估价后人工确认，确认后才创建任务，消耗以清单合计为准`
                      : "还没有人工标记就绪的粗剪素材：进工作台点「标记就绪」"}
                    onClick={() => {
                      if (readyShots.length === 0) {
                        notify("还没有人工标记就绪的粗剪素材。就绪是导演/美术的人工判断：进工作台点「标记就绪」，可撤销。", "info");
                        return;
                      }
                      setBatchKind("video");
                    }}
                  >生成本集（已就绪 {readyShots.length}/{shots.length}）</Button>
                  ) : null}
                  <Button variant="ghost" icon={<PlayCircle />} onClick={() => setShowPlayback(true)}>预览全集</Button>
                  {/* K2-A 幕四:产物审核队列与交付入口放生产页集头(对象=本集生成产物;
                      资产审核在资产页,对象不同,不混)。 */}
                  <Button variant="ghost" icon={<ClipboardText />} title="按集审生成的图片与视频:批量通过、单镜拒绝" onClick={() => setReviewOpen(true)}>审核队列</Button>
                  <Button variant="ghost" icon={<PaperPlaneTilt />} title="部分交付(没通过的镜头后补交)+ 交付历史" onClick={() => setDeliveryView("deliver")}>交付本集</Button>
                  <Button
                    variant="ghost"
                    icon={<ImagesSquare />}
                    disabled={!firstShot}
                    title={firstShot ? "打开本集视频库" : "本集还没有粗剪素材"}
                    onClick={() => firstShot && navigate(`${shotWorkbenchPath(projectId, selectedEpisode.id, firstShot.id)}?library=1`)}
                  >视频库</Button>
                  {/* 3D 导演台唯一入口 = 工作台页签（S3 专业化 B3 拍板），此处不再放按钮 */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button icon={<DotsThree />}>更多</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem title="对本集每个粗剪素材批量生成图片；视频生成走主按钮「生成本集」" onSelect={() => setBatchKind("image")}><Sparkle aria-hidden="true" />批量生成图片（本集）</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setExportOpen(true)}><Export aria-hidden="true" />导出本集…</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={refreshAll}><ArrowClockwise aria-hidden="true" />刷新</DropdownMenuItem>
                      <DropdownMenuItem destructive onSelect={() => notify("删除剧集将在引用检查接入后开放", "info")}><Trash aria-hidden="true" />删除剧集</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </Card>
            <section className="flex flex-col rounded-lg border border-border-1 bg-surface-1" aria-label="使用资产">
              {/* S7-5：整区收成摘要行「使用资产 N 项 ▸」，默认收起；点开显示 chips（提示跟随，不占整行高度） */}
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg px-5 py-3 text-left transition-colors duration-150 ease-out-quart hover:bg-surface-2"
                aria-expanded={assetsOpen}
                onClick={() => setAssetsOpen((open) => !open)}
              >
                <h2 className="text-ink-1 text-section-title">使用资产</h2>
                <span className="text-xs text-ink-4">{episodeAssets.length > 0 ? `${episodeAssets.length} 项` : "暂未引入"}</span>
                <CaretRight className={cn("ml-auto size-3.5 text-ink-4 transition-transform duration-150 ease-out-quart", assetsOpen && "rotate-90")} aria-hidden="true" />
              </button>
              {assetsOpen ? (
                <div className="flex animate-fade-in flex-wrap gap-2 px-5 pb-4">
                  {projectAssetState.loading ? <span className="text-xs text-ink-2">正在读取项目资产…</span> : null}
                  {projectAssetState.error ? <button className="text-xs text-ink-2 underline-offset-2 hover:underline" type="button" onClick={projectAssetState.retry}>项目资产读取失败，点击重试</button> : null}
                  {!projectAssetState.loading && !projectAssetState.error && episodeAssets.length === 0 ? <span className="text-xs text-ink-2">暂未引入资产，可先直接生成；引入后自动进入生成引用。</span> : null}
                  {episodeAssets.map((ref) => {
                    const asset = refAsset(ref);
                    const pillIconClass = asset.asset_kind === "scene" ? "text-accent-text" : asset.asset_kind === "prop" ? "text-warning" : "text-success";
                    return (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border-1 bg-surface-2 px-3 py-1 text-xs text-ink-1 [&_svg]:size-3.5" data-kind={asset.asset_kind ?? ""} key={ref.id}>
                        <Check className={pillIconClass} aria-hidden="true" />
                        {assetName(asset)}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </section>
            {/* S9-6：降噪——命名规则不常驻，收进标题旁 HelpHint；素材区与上方用同一种 border-border-1 分隔线、同一种 gap-4 间距 */}
            <header className="flex items-center gap-3 border-t border-border-1 pt-4">
              <h2 className="flex items-center gap-1.5 text-ink-1 text-section-title">
                粗剪素材 ({shots.length})
                <HelpHint label="素材命名规则">素材按「集-素材-场景-版本」自动命名，例如 1-3-客厅-v1；场景未分时显示「未分场」。命名只用于辨认，不影响生成。</HelpHint>
              </h2>
            </header>
            {shotState.loading ? (
              /* S7-14：素材列表骨架屏（与资产列表同策略），慢加载 8s 亮重试 */
              <div className="flex flex-col gap-3" aria-busy="true" aria-label="正在读取粗剪素材">
                <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4" aria-hidden="true">
                  {["sk-s1", "sk-s2", "sk-s3", "sk-s4", "sk-s5", "sk-s6"].map((key) => <Skeleton className="h-[178px]" key={key} />)}
                </div>
                <SlowLoadingNote show={shotSlow} onRetry={shotState.retry} />
              </div>
            ) : null}
            {!shotState.loading && shots.length === 0 ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-2 px-8 py-10 text-center">
                <strong className="text-lg font-semibold text-ink-1">本集还没有粗剪素材</strong>
                <p className="max-w-md text-sm text-ink-2">{episodeGroup(selectedEpisode) === "blank" ? "空白集纯手动搭建：先添加粗剪素材，再进入工作台补文字描述与参考包。" : "本集没有读到粗剪素材数据，可刷新重试或手动添加。"}</p>
                <Button variant="primary" icon={<ListPlus />} loading={addingShot} onClick={() => void addShot()}>添加粗剪素材（手动）</Button>
              </div>
            ) : null}
            {!shotState.loading && shots.length > 0 ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
                {/* 新建入口：网格首张加号卡（与项目页一致的画布式直觉）；S12-1 viewer 不显示 */}
                {canCreate ? (
                <button
                  type="button"
                  className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-2 text-ink-2 outline-none transition-colors duration-150 hover:border-accent hover:text-accent-text focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label="新建粗剪素材"
                  disabled={addingShot}
                  onClick={() => void addShot()}
                >
                  <Plus className="size-7" aria-hidden="true" />
                  <span className="text-sm">新建粗剪素材</span>
                </button>
                ) : null}
                {shots.map((shot) => (
                  <ShotCard
                    key={shot.id}
                    shot={shot}
                    episodeNo={selectedEpisode.episode_no}
                    sceneName={sceneNameOf(shot)}
                    projectId={projectId}
                    episodeId={selectedEpisode.id}
                    demoMode={demoMode}
                    ready={Boolean(readyMarks[shot.id])}
                    canCreate={canCreate}
                    notify={notify}
                    trackedGenerations={trackedByShot.get(shot.id)}
                    onDeleted={() => {
                      window.dispatchEvent(new Event("production-progress-changed"));
                      episodeState.retry();
                      shotState.retry();
                    }}
                  />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </main>
      {batchKind && selectedEpisode ? (
        /* N5(V-23):图片/视频各走独立抽屉(各带真实界面),不再共壳换标题。 */
        batchKind === "video" ? (
          <BatchVideoGenerateDrawer
            projectId={projectId}
            episodeId={selectedEpisode.id}
            episodeNo={selectedEpisode.episode_no}
            shots={readyShots}
            referenceMediaIds={referenceMediaIds}
            demoMode={demoMode}
            notify={notify}
            shotName={(shot) => shotDisplayName(selectedEpisode.episode_no, shot, sceneNameOf(shot))}
            onClose={() => setBatchKind(null)}
            onCreated={() => {
              window.dispatchEvent(new Event("production-progress-changed"));
              shotState.retry();
            }}
          />
        ) : (
          <BatchImageGenerateDrawer
            projectId={projectId}
            episodeId={selectedEpisode.id}
            episodeNo={selectedEpisode.episode_no}
            shots={shots}
            referenceMediaIds={referenceMediaIds}
            demoMode={demoMode}
            notify={notify}
            shotName={(shot) => shotDisplayName(selectedEpisode.episode_no, shot, sceneNameOf(shot))}
            onClose={() => setBatchKind(null)}
            onCreated={() => {
              window.dispatchEvent(new Event("production-progress-changed"));
              shotState.retry();
            }}
          />
        )
      ) : null}
      {showImport ? (
        <Dialog open onOpenChange={(open) => { if (!open) closeImport(); }}>
          <DialogContent size="wide">
            <DialogHeader>
              <DialogTitle>导入粗剪素材 Excel</DialogTitle>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              {importError ? (
                <div className={cn(formErrorClass, "flex flex-col gap-1")} role="alert">
                  <strong className="text-sm">导入没有完成</strong>
                  <span>{importError}</span>
                </div>
              ) : null}
              {!preview ? (
                <>
                  <button className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-2 px-4 py-8 text-center text-ink-2 transition-colors duration-150 ease-out-quart hover:border-accent hover:text-accent-text" type="button" onClick={() => fileInput.current?.click()}>
                    <CloudArrowUp className="size-7" aria-hidden="true" />
                    <strong className="text-sm text-ink-1">{file?.name || "选择粗剪素材 Excel"}</strong>
                    <span className="text-xs">{demoMode ? "离线演示不解析文件，预览区展示的是示例数据。" : "先预览标准化结果，确认后才会写入项目。"}</span>
                  </button>
                  <input className="sr-only" ref={fileInput} type="file" accept=".xlsx,.xlsm" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setImportError(""); }} />
                  <div className="flex flex-col gap-1 text-xs text-ink-2">
                    <h3 className="text-sm font-semibold text-ink-1">导入规则</h3>
                    {/* K2N(GP-06):十列各自去向写清,不再只说「识别集、场、镜号」 */}
                    <p>按示例模板十列表头识别：集数、场景、镜号、画面描述、运镜、景别·视角、台词、音效、参考图、分镜图。预览逐列呈现，没识别出的格子标「未识别」。</p>
                    {/* K2N(GP-07):绑定口径前置——按名命中才绑定,候选与未命中绝不自动绑定 */}
                    <p>场景按名引用项目里已建的场景：按名命中才绑定，相近名只列候选、绝不自动绑定。导入后请手工核对绑定。</p>
                    <p>有错误时不能确认；重复确认不会重复写入。</p>
                    {/* S9-5：示例文件与左栏入口同一静态文件，表头即后端解析器识别的列 */}
                    <p>没有现成文件？<a className="text-accent-text hover:underline underline-offset-2" href="/shortdrama-script-template.xlsx" download>下载示例 Excel</a>，照表头填写后导入。</p>
                    {demoMode ? <div className={cn(inlineNoteClass, "mt-1")}>离线演示不解析文件，也不允许确认；点「查看示例预览」看到的是示例数据。</div> : null}
                  </div>
                </>
              ) : <ImportPreview preview={preview} sceneTrials={sceneTrials} sceneTrialState={sceneTrialState} />}
            </DialogBody>
            <DialogFooter>
              <Button onClick={closeImport}>取消</Button>
              {preview ? (
                <Button variant="primary" icon={<Check />} loading={importing} disabled={!canConfirmStoryboardImport(preview) || demoMode} onClick={() => void confirmImport()}>确认导入</Button>
              ) : (
                <Button variant="primary" icon={<FileXls />} loading={importing} disabled={!file} onClick={() => void previewImport()}>{demoMode ? "查看示例预览" : "解析并预览"}</Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {showPlayback && selectedEpisode ? <EpisodePlaybackModal episodeId={selectedEpisode.id} demoMode={demoMode} notify={notify} onClose={() => { setShowPlayback(false); if (window.location.search) navigate(`/projects/${projectId}/storyboards`, { replace: true }); }} /> : null}
      {reviewOpen ? (
        <MediaReviewQueueModal
          projectId={projectId}
          episodes={episodes}
          initialEpisodeId={selectedEpisode?.id}
          demoMode={demoMode}
          canWrite={canCreate}
          notify={notify}
          onClose={() => { setReviewOpen(false); closeReviewDeliveryParams(); }}
        />
      ) : null}
      {deliveryView && selectedEpisode ? (
        <EpisodeDeliveryModal
          projectId={projectId}
          episode={selectedEpisode}
          totalShots={shots.length}
          demoMode={demoMode}
          canWrite={canCreate}
          notify={notify}
          initialTab={deliveryView}
          onDelivered={handleDelivered}
          onClose={() => { setDeliveryView(null); closeReviewDeliveryParams(); }}
        />
      ) : null}
      {exportOpen && selectedEpisode ? (
        <Modal title="导出本集" size="small" onClose={() => setExportOpen(false)}>
          <div className="flex flex-col gap-2">
            <Button icon={<Export />} onClick={() => { setExportOpen(false); void exportEpisode("all"); }}>导出全版本（CSV 清单）</Button>
            <Button icon={<DownloadSimple />} onClick={() => { setExportOpen(false); void exportEpisode("primary"); }}>导出主版本（JSON 交付清单）</Button>
          </div>
        </Modal>
      ) : null}
      {exportPreview && selectedEpisode ? <DemoExportPreviewDialog episodeId={selectedEpisode.id} kind={exportPreview} notify={notify} onClose={() => setExportPreview(null)} /> : null}
    </section>
  );
}

function EpisodeRailItem({ episode, active, statusText, onSelect }: { episode: Episode; active: boolean; statusText: string; onSelect: () => void }): React.JSX.Element {
  return (
    <button
      className={cn(
        "flex min-w-[140px] flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-all duration-150 ease-out-quart active:scale-[0.98] min-[900px]:w-full",
        active ? "border-accent bg-surface-2" : "border-transparent hover:bg-surface-2",
      )}
      type="button"
      onClick={onSelect}
    >
      <strong className="text-sm font-semibold text-ink-1">第 {episode.episode_no} 集</strong>
      <small className={cn("text-xs", active ? "text-accent-text" : "text-ink-2")}>{statusText}</small>
    </button>
  );
}

/** 分镜卡：命名（集-分镜-场景-版本）+ 缩略图；整卡可点进工作台。就绪=人工标记（工作台里标，卡片只展示）。
    S9-3：次要操作收右上 kebab——「移入回收站」走 DELETE /shots/:id 软删除；
    S9-6：无图占位不再按 id 取彩色渐变，统一 surface-well 低存在感；
    K2J：台账里有在途任务时缩略图左下显示进度徽标（排队中/生成中/失败·去工作台重试）。 */
export function ShotCard({ shot, episodeNo, sceneName, projectId, episodeId, demoMode, ready, canCreate, notify, onDeleted, trackedGenerations }: {
  shot: Shot;
  episodeNo: number;
  /** S11-3：场景名（真栈=api.episodeScenes 解析，demo=本地映射）；未分场时 undefined。 */
  sceneName?: string;
  projectId: string;
  episodeId: string;
  demoMode: boolean;
  ready?: boolean;
  /** K2 彩排：拆解入口按契约 §9 口径只对 owner|editor 显示（demo 才见，真栈等契约批准）。 */
  canCreate: boolean;
  notify: PageRuntimeProps["notify"];
  onDeleted: () => void;
  /** K2J：本分镜在会话台账里的在途生成任务（批量提交时由抽屉注册；单镜生成同机制）。 */
  trackedGenerations?: TrackedGenerationRequest[];
}): React.JSX.Element {
  /* K2O/GP-04：媒体 fixture 走 projectId 门控 accessor（K2A 真源 demoShotMedia 不绕开）——
     非属主项目/陌生 shot 如实空，不串 demo-project-2 的产物。 */
  const demoMedia = demoShotMediaForShot(projectId, shot.id);
  const mediaState = useResource(() => api.shotMedia(shot.id), { items: demoMedia, count: demoMedia.length }, demoMode, [shot.id]);
  const media = mediaState.data?.items ?? [];
  const selectedImage = selectedMediaForKind(shot, media, "image");
  const selectedVideo = selectedMediaForKind(shot, media, "video");
  // 首帧缩略图：视频主版本的 poster 优先（最贴近最终画面），否则用选定图片；无产物给统一弱化占位
  const thumbUrl = selectedVideo?.thumbnail_url || selectedImage?.storage_url || selectedImage?.thumbnail_url || "";
  const name = shotDisplayName(episodeNo, shot, sceneName);
  const workbenchPath = shotWorkbenchPath(projectId, episodeId, shot.id);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashing, setTrashing] = useState(false);

  /** K2 彩排入口（设计 §1 第一条）：创建 shot 作用域彩排 run 并跳统一运行页。
      契约未批，只在离线演示出现；彩排 run 全内存零网络（fixture=demo.ts）。 */
  function startBreakdownRehearsal(): void {
    const rehearsal = createRehearsalRun({
      idempotencyKey: newRehearsalIdempotencyKey(),
      projectId,
      scope: { kind: "shot", shotId: shot.id },
      scopeLabel: `第 ${episodeNo} 集素材 · ${name}`,
      sourceText: shot.script_text || "",
      requirements: demoBreakdownRequirements(),
      primaryDestination: { label: "去工作台看控制包", path: workbenchPath },
      returnDestination: { label: "回生产页", path: projectStoryboardPath(projectId) },
    });
    navigate(projectRequirementBreakdownPath(projectId, rehearsal.run.id));
  }

  /* ---------- K2J：在途任务徽标（轮询既有 GET /generations/:id，3s 一拍与 workbench 同拍） ---------- */
  const { retry: retryMedia } = mediaState;
  const [trackedTasks, setTrackedTasks] = useState<Record<string, GenerationTask>>({});
  /** 已从台账遗忘的 requestId（终态成功/取消，或服务端 403/404）：本地遮罩，不再轮询/显示。 */
  const [goneRequestIds, setGoneRequestIds] = useState<ReadonlySet<string>>(new Set());
  const activeTracked = useMemo(
    () => (trackedGenerations ?? []).filter((entry) => !goneRequestIds.has(entry.requestId)),
    [trackedGenerations, goneRequestIds],
  );
  const trackedKey = activeTracked.map((entry) => entry.requestId).join(",");
  useEffect(() => {
    if (demoMode || activeTracked.length === 0) return;
    let active = true;
    let timer = 0;
    const entries = activeTracked;
    const tick = async (): Promise<void> => {
      const results = await Promise.allSettled(entries.map((entry) => api.generation(entry.requestId)));
      if (!active) return;
      const fresh: GenerationTask[] = [];
      const gone: TrackedGenerationRequest[] = [];
      const settled: TrackedGenerationRequest[] = [];
      let hasActive = false;
      results.forEach((result, index) => {
        const entry = entries[index]!;
        if (result.status === "rejected") {
          // 服务端已无此任务（403/404）→ 忘记录台；其余失败保留旧态，下一拍再试
          if (result.reason instanceof ApiClientError && [403, 404].includes(result.reason.status)) gone.push(entry);
          else hasActive = true;
          return;
        }
        fresh.push(result.value);
        if (result.value.status === "succeeded" || result.value.status === "cancelled") settled.push(entry);
        else if (result.value.status === "pending" || result.value.status === "running") hasActive = true;
      });
      if (fresh.length > 0) {
        setTrackedTasks((previous) => ({ ...previous, ...Object.fromEntries(fresh.map((task) => [task.generation_request_id, task])) }));
      }
      const forgetEntries = [...gone, ...settled];
      if (forgetEntries.length > 0) {
        try {
          for (const entry of forgetEntries) forgetGenerationRequest(window.sessionStorage, projectId, shot.id, entry.mediaKind);
        } catch { /* 台账清理失败不阻塞展示 */ }
        setGoneRequestIds((previous) => new Set([...previous, ...forgetEntries.map((entry) => entry.requestId)]));
      }
      if (settled.length > 0) {
        // 成功落产物：复用全站唯一刷新触发器 + 重拉本卡缩略图
        window.dispatchEvent(new Event("production-progress-changed"));
        retryMedia();
      }
      if (active && hasActive) timer = window.setTimeout(() => void tick(), 3000);
    };
    void tick();
    return () => { active = false; window.clearTimeout(timer); };
    // trackedKey（台账条目集合）变化才重开轮询；entries/activeTracked 由 trackedKey 派生
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, trackedKey, projectId, shot.id, retryMedia]);
  const trackedBadge = useMemo((): ShotGenerationBadge => {
    if (activeTracked.length === 0) return { kind: "none" };
    // 离线演示不查接口：登记即排队
    if (demoMode) return { kind: "queued", queuePosition: null };
    const tasks = activeTracked
      .map((entry) => trackedTasks[entry.requestId])
      .filter((task): task is GenerationTask => Boolean(task));
    // 首拍未全部返回前给乐观排队态，不闪空
    if (tasks.length < activeTracked.length) return { kind: "queued", queuePosition: null };
    return shotGenerationBadge(tasks);
  }, [activeTracked, demoMode, trackedTasks]);
  const trackedBadgeText = shotGenerationBadgeText(trackedBadge);

  /** 移入回收站 = 后端软删除（列表随之隐藏）。V0.1 回收站列表/恢复仅支持项目和个人资产
      （服务端 trash_kind_not_supported），素材如实提示暂不可恢复，不造假恢复口。 */
  async function moveToTrash(): Promise<void> {
    if (demoMode) {
      setTrashOpen(false);
      notify("离线演示不会写入回收站", "info");
      return;
    }
    setTrashing(true);
    try {
      await api.request(`/shots/${encodeURIComponent(shot.id)}`, { method: "DELETE" });
      setTrashOpen(false);
      notify("粗剪素材已移入回收站", "success");
      onDeleted();
    } catch (reason) {
      notify(businessErrorMessage(reason, "移入回收站失败，请重试"), "error");
    } finally {
      setTrashing(false);
    }
  }

  return (
    <article className="relative flex flex-col overflow-hidden rounded-lg border border-border-1 bg-surface-1 transition-all duration-150 ease-out-quart focus-within:border-accent hover:-translate-y-0.5 hover:border-border-2 hover:shadow-[0_8px_24px_-12px_oklch(0_0_0/0.5)]">
      <button className="absolute inset-0 z-10 rounded-[inherit]" type="button" aria-label={`打开 ${name} 的工作台`} onClick={() => navigate(workbenchPath)} />
      {ready ? <span className="pointer-events-none absolute left-2 top-2 z-20 rounded-full border border-success/40 bg-success/15 px-2 py-0.5 text-[10px] text-success">已就绪</span> : null}
      {/* 次要操作收 kebab（同资产卡口径）：整卡主操作仍是进工作台 */}
      <div className="absolute right-2 top-2 z-20">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 rounded-md border border-border-2 bg-surface-1/80 backdrop-blur-sm [&_svg]:size-4" aria-label={`${name} 更多操作`} title="更多操作" icon={<DotsThree />} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {demoMode && canCreate ? (
              <DropdownMenuItem title="用文字描述拆解控制包需求（离线演示彩排）" onSelect={() => startBreakdownRehearsal()}>
                <Sparkle aria-hidden="true" />拆解控制包需求
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem destructive title="从本集列表隐藏，产物随素材一并隐藏" onSelect={() => setTrashOpen(true)}>
              <Trash aria-hidden="true" />移入回收站
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-surface-well text-ink-4">
        {thumbUrl ? <img className="h-full w-full object-cover" src={thumbUrl} alt={name} loading="lazy" /> : <ImageSquare className="size-6" aria-hidden="true" />}
        {trackedBadgeText ? (
          <span
            className={cn(
              "pointer-events-none absolute bottom-2 left-2 z-20 rounded-full border px-2 py-0.5 text-[10px]",
              trackedBadge.kind === "failed"
                ? "border-danger/40 bg-danger/15 text-danger"
                : trackedBadge.kind === "running"
                  ? "border-accent/40 bg-accent/15 text-accent-text"
                  : "border-warning/40 bg-warning/15 text-warning",
            )}
            role="status"
          >{trackedBadgeText}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <strong className="truncate font-mono text-xs font-semibold text-ink-1">{name}</strong>
        </div>
        <p className="line-clamp-2 min-h-8 text-xs leading-4 text-ink-2">{shot.script_text || "暂无文字描述"}</p>
      </div>
      {trashOpen ? (
        <Dialog open onOpenChange={(open) => { if (!open && !trashing) setTrashOpen(false); }}>
          <DialogContent size="small" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>移入回收站</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <div className="flex items-start gap-3">
                <Trash className="size-6 shrink-0 text-danger" aria-hidden="true" />
                <div className="flex flex-col gap-1">
                  <strong className="text-sm text-ink-1">将“{name}”移入回收站</strong>
                  {media.length > 0 ? (
                    <p className="text-xs text-ink-2">{`本素材已有 ${media.length} 个生成产物，删除后产物随素材一并从本集隐藏。`}</p>
                  ) : null}
                  <p className="text-xs text-ink-2">素材会从本集列表隐藏；当前回收站仅支持项目和资产的查看与恢复，素材删除后暂不可恢复。</p>
                </div>
              </div>
            </DialogBody>
            <DialogFooter>
              <Button disabled={trashing} onClick={() => setTrashOpen(false)}>取消</Button>
              <Button variant="danger" icon={<Trash />} loading={trashing} onClick={() => void moveToTrash()}>确认移入回收站</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </article>
  );
}

/* K2N(GP-06):预览表渲染模板全十列——运镜/景别/音效/参考图/分镜图原先不进预览,
   用户核对不到识别结果;没识别出的单元格如实标「未识别」,不静默留空。
   K2N(GP-07):场景列带绑定试算徽标,表下给场景核对清单(候选绝不自动绑定)。 */
function ImportPreview({ preview, sceneTrials, sceneTrialState }: {
  preview: StoryboardImportRecord;
  sceneTrials: SceneBindingTrial[];
  sceneTrialState: "idle" | "loading" | "ready" | "failed";
}): React.JSX.Element {
  const rows = preview.preview.rows;
  const warnings = storyboardIssues(preview, "warning");
  const errors = storyboardIssues(preview, "error");
  const trialByKey = new Map(sceneTrials.map((trial) => [trial.key, trial]));
  const trialOf = (row: StoryboardPreviewRow): SceneBindingTrial | undefined => {
    if (typeof row.episode_no !== "number" || !row.scene_name?.trim()) return undefined;
    return trialByKey.get(sceneBindingTrialKey(row.episode_no, row.scene_name));
  };
  return (
    <div className="flex flex-col gap-3">
      {/* K2O/GP-08：demo 示例数据必须显著标注，不许冒充用户文件的解析结果。 */}
      {preview.demo_sample ? (
        <div className="rounded-md border border-accent/40 bg-accent-subtle px-3 py-2 text-sm text-ink-1" role="note">
          <strong>示例预览数据</strong>——不是{preview.file_name ? `「${preview.file_name}」的` : "你文件的"}解析结果。离线演示不支持解析 Excel；真机环境点「解析并预览」才会展示你文件的真实内容。
        </div>
      ) : null}
      <div className="flex flex-wrap gap-4 text-xs text-ink-2">
        <strong className="font-mono text-ink-1">{preview.demo_sample ? `${rows.length} 行示例数据（非解析结果）` : `${rows.length} 条标准化粗剪素材`}</strong>
        {errors.length ? <StatusBadge status="failed">{errors.length} 个错误</StatusBadge> : preview.preview.can_confirm ? <StatusBadge status="ready">可以确认</StatusBadge> : <StatusBadge status="pending">暂不能确认</StatusBadge>}
      </div>
      {warnings.map((issue, index) => <div className={inlineNoteClass} key={`warning-${index}`}>{issue.source_row ? `第 ${issue.source_row} 行：` : ""}{issue.message}</div>)}
      {errors.map((issue, index) => <div className={formErrorClass} key={`error-${index}`}>{issue.source_row ? `第 ${issue.source_row} 行：` : ""}{issue.message}</div>)}
      {/* 仓内既有表格模式(consumption-records 同款):横向滚动 + 边框容器,十一列不挤爆弹窗 */}
      <div className="overflow-x-auto rounded-md border border-border-1">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-border-1 bg-surface-2 text-ink-4">
              <th className="whitespace-nowrap px-3 py-2 font-medium">源行</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">集数</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">场景</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">镜号</th>
              <th className="px-3 py-2 font-medium">画面描述</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">运镜</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">景别·视角</th>
              <th className="px-3 py-2 font-medium">台词</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">音效</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">参考图</th>
              <th className="whitespace-nowrap px-3 py-2 font-medium">分镜图</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const trial = trialOf(row);
              return (
                <tr className="border-b border-border-1 last:border-b-0" key={`${row.source_sheet || ""}-${row.source_row ?? index}`}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-ink-2">{row.source_row ?? "-"}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">{row.episode_no ?? <UnrecognizedCell />}</td>
                  <td className="px-3 py-2 text-ink-1">
                    {row.scene_name?.trim() ? (
                      <span className="flex flex-col items-start gap-1">
                        <span className="whitespace-nowrap">{row.scene_name}</span>
                        {trial ? <SceneBindingBadge trial={trial} /> : null}
                      </span>
                    ) : <UnrecognizedCell />}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">{row.shot_no ?? <UnrecognizedCell />}</td>
                  <td className="max-w-[220px] truncate px-3 py-2 text-ink-2" title={row.screen_description ?? undefined}>{row.screen_description?.trim() ? row.screen_description : <UnrecognizedCell />}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">{row.camera_movement?.trim() ? row.camera_movement : <UnrecognizedCell />}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">{row.shot_size_angle?.trim() ? row.shot_size_angle : <UnrecognizedCell />}</td>
                  <td className="max-w-[160px] truncate px-3 py-2 text-ink-2" title={row.dialogue ?? undefined}>{row.dialogue?.trim() ? row.dialogue : <UnrecognizedCell />}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">{row.sound_effect?.trim() ? row.sound_effect : <UnrecognizedCell />}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">{row.reference_image_note?.trim() ? row.reference_image_note : <UnrecognizedCell />}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-ink-2">{row.storyboard_image_note?.trim() ? row.storyboard_image_note : <UnrecognizedCell />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <SceneBindingChecklist trials={sceneTrials} state={sceneTrialState} />
    </div>
  );
}

/** 十列逐格核对:没识别出的单元格如实标注,不静默留空(GP-06)。 */
function UnrecognizedCell(): React.JSX.Element {
  return <span className="text-ink-4">未识别</span>;
}

/** 场景列的绑定试算徽标:按名命中=将绑定;候选/未命中/新集=需人工核对(GP-07)。 */
function SceneBindingBadge({ trial }: { trial: SceneBindingTrial }): React.JSX.Element {
  if (trial.status === "matched") return <StatusBadge status="ready">按名命中·将绑定</StatusBadge>;
  if (trial.status === "candidates") return <StatusBadge status="pending">未命中·候选 {trial.candidates.length} 个</StatusBadge>;
  if (trial.status === "new_episode") return <StatusBadge status="pending">新集·将新建</StatusBadge>;
  return <StatusBadge status="pending">未命中·将新建</StatusBadge>;
}

/** GP-07 界面支点:场景绑定核对清单——每镜场景名的试算结果摆出来,
    相近名只进候选区供人工核对,绝不自动绑定(发版口径:导入后请手工核对绑定)。 */
function SceneBindingChecklist({ trials, state }: { trials: SceneBindingTrial[]; state: "idle" | "loading" | "ready" | "failed" }): React.JSX.Element | null {
  if (state === "failed") {
    return <div className={inlineNoteClass}>项目已有场景读取失败，绑定核对暂缺；确认导入后请手工核对每镜场景。</div>;
  }
  if (state === "loading") {
    return <div className={inlineNoteClass}>正在读取项目已有场景，核对绑定状态…</div>;
  }
  if (state !== "ready" || trials.length === 0) return null;
  const matchedCount = trials.filter((trial) => trial.status === "matched").length;
  const reviewCount = trials.length - matchedCount;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-1 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
        <strong className="text-sm text-ink-1">场景绑定核对</strong>
        <span>按名命中 {matchedCount} 个</span>
        {reviewCount > 0 ? <span>待人工核对 {reviewCount} 个</span> : null}
      </div>
      <ul className="flex max-h-44 flex-col gap-1.5 overflow-y-auto text-xs">
        {trials.map((trial) => (
          <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5" key={trial.key}>
            <SceneBindingBadge trial={trial} />
            <span className="text-ink-1">第 {trial.episode_no} 集 · {trial.scene_name}</span>
            <span className="text-ink-4">{trial.row_count} 镜</span>
            <span className="text-ink-2">{sceneBindingDetail(trial)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-4">试算基于当前项目已有场景按名匹配；相近名只列候选，绝不自动绑定。导入后请手工核对绑定。</p>
    </div>
  );
}

function sceneBindingDetail(trial: SceneBindingTrial): string {
  if (trial.status === "matched") return `将绑定到已有场景「${trial.matched?.name ?? trial.scene_name}」`;
  if (trial.status === "candidates") return `候选：${trial.candidates.map((candidate) => candidate.name).join("、")}——不会自动绑定，请导入后核对`;
  if (trial.status === "new_episode") return "该集还不存在，确认导入将新建该集与该场景";
  return "没有同名或相近场景，确认导入将新建该场景";
}

function refAsset(ref: ProjectAssetRef): Asset {
  return ref.asset ?? ref.snapshot ?? ref.version_snapshot?.entity ?? { id: ref.asset_entity_id || ref.asset_id || ref.id, name: "未命名项目资产", asset_kind: "character" };
}
