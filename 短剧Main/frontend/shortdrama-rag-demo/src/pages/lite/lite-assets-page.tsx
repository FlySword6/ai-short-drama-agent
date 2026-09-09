/* ============================================================
   lite-assets-page.tsx — Lite 素材页（任务 S5 真页面，替换 batch 1 只读 stub）
   props 契约 = PageRuntimeProps & { projectId }；app.tsx 挂载不变。

   页面 = 项目资产分组卡（人物/场景/道具/其他）+ 每卡参考图区与「生参考图」
   （严格两段 estimate→confirm→submit）+ 候选图网格（每张可「登记素材」，登记链
   复用 lite-registration.ts 共享状态机）+ 进行态轮询恢复。

   已实读的契约事实（写请求体前全部核过真源，不凭印象）：
   - 实体化：POST /lite/assets/materialize 无请求体、幂等（重复调用不重复建行），
     wire = { created, existed, assets: [{ asset_entity_id, asset_kind, name, outcome }] }
     （lite/routes.test.ts:412/447）；未确认过解析 → 409 lite_breakdown_not_confirmed
     （lite/service.ts:121/125），页面引导去剧本页。
   - 候选产物：GET /lite/assets/:asset_entity_id/media → { items: [...] } 倒序
     （lite/routes.test.ts:525-533）；只回本项目目标资产的产物。
   - 生参考图走资产生成链：estimate/submit 的 zod 形状（generation/routes.ts:85-124）
     要求 shot_id 与 target_asset_entity_id 至少其一（:183/:197 refine）；本页只发
     target_asset_entity_id=资产实体 id + supplement_prompt=配置页选中图片模板内容
     （引用键 parameters.prompt_template_id，客户端解析模板表内容后提交，≤5000 字；
     id 缺失/软删回落系统默认不发——docs/design/prd-v2/lite-model-defaults.md §4.3）。
     档是原子的
     （capabilityTiers.ts requireTierMatchesInput）：quantity 与归一化参数必须与档全等，
     V0.1 合同下档 quantity 恒 1，故提交参数 = tierSubmitInput(档) 整档透传。
   - 报价必须显式确认后才能被消费（POST /generation-quotes/:id/confirm）：业务人员点
     这一次按钮 = 认可本次报价（AGENTS.md §4 前台不逐次估价）；缺这一步 submit 必被
     GENERATION_QUOTE_UNCONFIRMED 拒（2026-08-07 真付费冒烟实测）。
   - 幂等键 newId()，提交前落 sessionStorage。键前缀 lite-asset-gen: 与分镜页的
     lite-gen: 刻意不同——分镜页恢复会扫它自己的前缀把键归到分镜行，两页台账不能串。
   - 轮询规范（计划 §5.2②）：起始 3s、指数退避上限 15s、单任务 30 分钟总上限
     （超时提示不自动重发）、document.hidden 暂停 + visibilitychange 恢复即查、卸载清理。
   - 恢复：挂载时 api.projectGenerations(projectId) 过滤 pending/running，按
     sessionStorage 台账映射回资产卡；generationData 无 target_asset_entity_id
     （generation/routes.ts:1306-1347 不输出），映射缺失的进行中任务不强行归属，
     页顶提示「有 N 个生成任务仍在进行中」（与分镜页同口径）。
   - 登记：提升实体缺省 usage_mode=reference，登记 active 即「可引用」，不需要任何
     用途 PATCH（2026-08-10 #186 全能参考口径；登记状态机已抽共享 lite-registration.ts）。
   - 复制件声明：生成轮询 effect、档反查（resolveLiteTier）、提示词模板读取
     （promptTemplateOf）与 lite-shots-page.tsx 同口径原样复制——抽共享件要动分镜页，
     分镜页归另一个 agent，统一收口留给分镜页 owner；登记状态机已抽共享
     （lite-registration.ts），本页直接用。
   - demoMode：fixture 资产/候选图照常展示，写操作（建资产/生参考图/登记）一律 toast 不调用。
   ============================================================ */
import {
  ArrowClockwise,
  ImageSquare,
  Plus,
  SpeakerHigh,
  SpinnerGap,
  Trash,
  User,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, api, type LiteAssetMediaItem, type LiteAssetListResult } from "../../api";
import {
  FALLBACK_IMAGE_TIER,
  activeTiers,
  listCapabilityTiers,
  type CapabilityTier,
} from "../../capability-tiers";
import { tierDimensionValue } from "../../generation-dimensions";
import { navigate } from "../../routing";
import { audioKindLabel } from "../../asset-kind-labels";
import type { Asset, GenerationDefaultStrategy, GenerationTask, ProjectAssetRef, PromptTemplate } from "../../types";
import { effectivePromptTemplate } from "../../lite-prompt-templates";
import { demoProjectAssets } from "../../demo";
import { humanErrorMessage } from "../batch-generate-drawer";
import type { PageRuntimeProps } from "../global-pages";
import { EmptyState, ErrorState, assetKindLabel, useResource } from "../../ui";
import { Button } from "../../components/ui/button";
import { Badge, Card, Skeleton } from "../../components/ui/primitives";
import { cn } from "../../components/ui/cn";
import { liteProjectPath, readCurrentEpisodeId } from "./lite-shell";
import { LiteConfirmDialog, type LiteConfirmState } from "./lite-confirm-dialog";
import { useLiteRegistrations } from "./lite-registration";
import { LiteAssetCreateDialog } from "./lite-asset-create-dialog";
import { liteAssetDetailPath } from "./lite-asset-detail-page";

/* ---------- 轮询与配置常量（与 lite-shots-page.tsx 同口径复制件，收口归分镜页 owner） ---------- */

/** 轮询节奏（计划 §5.2②）：起始 3s，指数退避到 15s 上限，单任务 30 分钟总上限。 */
const POLL_BASE_MS = 3000;
const POLL_MAX_MS = 15_000;
const POLL_TOTAL_CAP_MS = 30 * 60 * 1000;

const ACTIVE_GENERATION_STATUSES: ReadonlyArray<string> = ["pending", "running"];

/* ---------- Lite 提交体（后端 zod 形状） ---------- */
/* Phase 2 保留：生参考图提交体类型，详情抽屉 + 弹窗 B 上线后启用。
type LiteAssetSubmissionInput = Omit<TieredGenerationSubmissionInput, "prompt" | "reference_media_ids"> & {
  supplement_prompt?: string;
}; */

/* ---------- sessionStorage 幂等键台账（lite-asset-gen:{assetEntityId} → { key, requestId? }） ---------- */

/* 前缀刻意不同于分镜页 lite-gen:——分镜页恢复只扫自己的前缀，两页台账互不误归。 */
const LITE_ASSET_GEN_MARKER_PREFIX = "lite-asset-gen:";

interface LiteAssetGenMarker {
  key: string;
  requestId?: string;
}

function liteAssetGenMarkerKey(assetEntityId: string): string {
  return `${LITE_ASSET_GEN_MARKER_PREFIX}${assetEntityId}`;
}

function forgetLiteAssetGenMarker(storage: Storage, assetEntityId: string): void {
  storage.removeItem(liteAssetGenMarkerKey(assetEntityId));
}

/** 扫描本标签页的资产页幂等键台账（恢复用）；脏行跳过不放大。 */
function readLiteAssetGenMarkers(storage: Storage): Array<{ assetEntityId: string; marker: LiteAssetGenMarker }> {
  const found: Array<{ assetEntityId: string; marker: LiteAssetGenMarker }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const storageKey = storage.key(index);
    if (!storageKey || !storageKey.startsWith(LITE_ASSET_GEN_MARKER_PREFIX)) continue;
    const assetEntityId = storageKey.slice(LITE_ASSET_GEN_MARKER_PREFIX.length);
    if (!assetEntityId) continue;
    try {
      const parsed = JSON.parse(storage.getItem(storageKey) ?? "") as Partial<LiteAssetGenMarker> | null;
      if (typeof parsed?.key !== "string" || parsed.key.length < 8) continue;
      found.push({
        assetEntityId,
        marker: { key: parsed.key, ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}) },
      });
    } catch {
      /* 单行损坏不影响其它行的恢复 */
    }
  }
  return found;
}

/* ---------- 分组与 tab 型素材页（第一阶段：tab bar + 简化列表卡 + 新建入口） ---------- */
/* ---------- tab 型素材页（第一阶段：tab bar + 简化列表卡 + 新建入口） ---------- *//** tab 定义：「全部」+ 五类可解析资产 + 三类纯上传参考通道。 */
const LITE_ASSET_TABS: ReadonlyArray<{ key: string; label: string; newLabel: string }> = [
  { key: "all", label: "全部", newLabel: "新建资产" },
  { key: "character", label: "角色", newLabel: "新建角色" },
  { key: "scene", label: "场景", newLabel: "新建场景" },
  { key: "prop", label: "道具", newLabel: "新建道具" },
  { key: "costume", label: "服装", newLabel: "新建服装" },
  { key: "audio", label: "音频", newLabel: "新建音频" },
  { key: "light_ref", label: "光线参考", newLabel: "新建光线参考" },
  { key: "photo_ref", label: "摄影参考", newLabel: "新建摄影参考" },
  { key: "video_ref", label: "视频参考", newLabel: "新建视频参考" },
];

/** tab 持久化：读写 URL query `asset_tab`（不用 localStorage，刷新与分享即对）。 */
function readCurrentAssetTab(): string {
  return new URLSearchParams(window.location.search).get("asset_tab") ?? "all";
}

function writeCurrentAssetTab(tab: string): void {
  const url = new URL(window.location.href);
  if (tab === "all" || !tab) {
    url.searchParams.delete("asset_tab");
  } else {
    url.searchParams.set("asset_tab", tab);
  }
  // replaceState：不触发导航/重新挂载，只更新地址栏。
  window.history.replaceState(null, "", url.toString());
}

/** 行模型：asset 是展示解包结果，entityId 是生成/候选取数认的资产实体 id。 */
interface LiteAssetRow {
  entityId: string;
  asset: Asset;
}

/** 与完整版 refAsset 同一条解包链（asset → snapshot → version_snapshot.entity → 兜底）。 */
function liteRefAsset(ref: ProjectAssetRef): Asset {
  return ref.asset ?? ref.snapshot ?? ref.version_snapshot?.entity ?? { id: ref.asset_entity_id || ref.asset_id || ref.id, name: "未命名项目资产" };
}

/** 资产实体 id 以 ref 上的 asset_entity_id 为准（wire 恒有），逐层兜底到 ref 行 id。 */
function liteAssetEntityId(ref: ProjectAssetRef): string {
  return ref.asset_entity_id || ref.asset_id || liteRefAsset(ref).id || ref.id;
}

/* ---------- 生成配置（图片档 + 项目默认策略；与 lite-shots-page.tsx 同口径复制件） ---------- */

interface LiteImageConfig {
  tiers: CapabilityTier[];
  /** null = 从未配置过（404），按钮禁用并指向配置页。 */
  strategy: GenerationDefaultStrategy | null;
  /** 本项目自建图片模板库（生成期解析 prompt_template_id → 内容用）。 */
  library: PromptTemplate[];
}

/** 读图片媒介的 active 档与已存默认策略 + 自建模板库；404 不算错（未配置过），其余错误原样抛给页头条。
    模板库读不到按空回落：引用按系统默认执行，照常可生成。 */
async function loadLiteImageConfig(projectId: string): Promise<LiteImageConfig> {
  const { tiers } = await listCapabilityTiers("image", false);
  const strategy = await api.generationDefault(projectId, "image").catch((reason) => {
    if (reason instanceof ApiClientError && reason.status === 404) return null;
    throw reason;
  });
  const library = await api.promptTemplates(projectId, "image").catch(() => ({ items: [] }));
  return { tiers, strategy, library: library.items };
}

function textParam(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 档的清晰度取值（图片档 params.resolution 是登记键，params.size 为兼容读法）。 */
function tierResolutionOf(tier: CapabilityTier): string | undefined {
  const value = tierDimensionValue(tier, "resolution") ?? tier.params.size;
  return typeof value === "string" ? value : undefined;
}

/**
 * 由已存策略反查可提交档：model_key 存的是档 id（FABLE-007 后 tier_id 是唯一公开选择键），
 * 只认 active 档里同档、且清晰度（图片 size / 视频 resolution，配置页写入口径）与比例、
 * 时长（视频 ratio ↔ 档 aspect_ratio、duration_seconds）一致者；查不到 = 配置的组合当前
 * 无档可提交，按钮禁用给原因，绝不换档静默提交。
 */
function resolveLiteTier(tiers: readonly CapabilityTier[], kind: "image" | "video", strategy: GenerationDefaultStrategy | null): CapabilityTier | null {
  if (!strategy) return null;
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

/* ---------- 资产候选产物 ---------- */

interface LiteAssetMedia {
  items: LiteAssetMediaItem[];
  /** 单资产读取失败不连坐整页：该卡候选区给重试入口。 */
  error?: string;
}

async function loadAssetMediaMap(projectId: string, rows: readonly LiteAssetRow[]): Promise<Record<string, LiteAssetMedia>> {
  const entries = await Promise.all(rows.map(async (row) => {
    try {
      const list = await api.liteAssetMedia(projectId, row.entityId);
      return [row.entityId, { items: list.items }] as const;
    } catch (reason) {
      return [row.entityId, { items: [] as LiteAssetMediaItem[], error: humanErrorMessage(reason, "读取失败") }] as const;
    }
  }));
  return Object.fromEntries(entries);
}

/** 候选参考图 = 图片类且有可展示地址的产物。 */
function assetImageCandidatesOf(media: LiteAssetMedia | undefined): LiteAssetMediaItem[] {
  return (media?.items ?? []).filter((item) => item.media_kind === "image" && typeof item.storage_url === "string" && item.storage_url.length > 0);
}

/* ---------- 进行中的生成任务（卡内状态机；轮询复制件，收口归分镜页 owner） ---------- */

interface TrackedAssetTask {
  requestId: string;
  assetEntityId: string;
  task: GenerationTask;
  /** 首次开始轮询的时间；超过 30 分钟转超时态（不自动重发）。 */
  firstPollAt: number;
  pollCount: number;
  pollFailures: number;
  nextPollAt: number;
  timedOut: boolean;
}

function isActiveTask(tracked: TrackedAssetTask): boolean {
  return ACTIVE_GENERATION_STATUSES.includes(tracked.task.status);
}

/** 轮询目标 = 进行中且未超时（失败/取消/成功都是终态，不再轮询）。 */
function isPollingTarget(tracked: TrackedAssetTask): boolean {
  return isActiveTask(tracked) && !tracked.timedOut;
}

/** 指数退避：3s → 6s → 12s → 15s 封顶。 */
function pollDelayMs(pollCount: number): number {
  return Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** pollCount);
}

/* ---------- demo fixture（候选图按 demo 资产实体 id  keyed；离线不读写真实数据） ---------- */

function demoLiteAssetStill(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="hsl(${hue},24%,18%)"/><text x="160" y="166" font-size="24" fill="hsl(${hue},30%,72%)" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function demoLiteAssetMediaItem(id: string, label: string, hue: number, createdAt: string): LiteAssetMediaItem {
  return {
    id,
    media_kind: "image",
    storage_url: demoLiteAssetStill(label, hue),
    persistence_status: "persisted",
    review_status: "accepted",
    generation_request_id: null,
    width_px: 1024,
    height_px: 1024,
    created_at: createdAt,
  };
}

/* 键 = demo 资产的实体 id（demoProjectAssets 的 ref.asset_id：asset-ren=任天野、asset-harbor=巷口雨夜）。 */
const DEMO_LITE_ASSET_MEDIA: Record<string, LiteAssetMedia> = {
  "asset-ren": {
    items: [
      demoLiteAssetMediaItem("demo-asset-img-ren-b", "任天野 · 候选 B", 205, "2026-08-07T08:30:05.000Z"),
      demoLiteAssetMediaItem("demo-asset-img-ren-a", "任天野 · 候选 A", 175, "2026-08-07T08:30:00.000Z"),
    ],
  },
  "asset-harbor": {
    items: [demoLiteAssetMediaItem("demo-asset-img-harbor-a", "巷口雨夜 · 候选 A", 150, "2026-08-07T08:20:00.000Z")],
  },
};

/** v0.9 demo 列表:一条音频(带五类分类)+ 一条角色,供离线演示「分类」徽记。 */
const DEMO_LITE_ASSET_LIST: LiteAssetListResult = {
  items: [
    {
      asset_entity_id: "demo-asset-audio",
      name: "雨声",
      intro: "夜雨环境声",
      asset_kind: "audio",
      audio_kind: "ambience",
      primary_media_url: null,
      has_media: false,
      has_primary: false,
      has_pending_generation: false,
      last_modified_at: "2026-08-19T00:00:00.000Z",
    },
    {
      asset_entity_id: "demo-asset-ren",
      name: "任天野",
      intro: "主角",
      asset_kind: "character",
      audio_kind: null,
      primary_media_url: null,
      has_media: false,
      has_primary: false,
      has_pending_generation: false,
      last_modified_at: "2026-08-19T00:00:00.000Z",
    },
  ],
  tab_counts: [{ kind: "audio", count: 1 }, { kind: "character", count: 1 }],
};

/* ============================================================
   页面组件
   ============================================================ */

export function LiteAssetsPage({ demoMode, notify, projectId }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  /* ---------- 数据：项目资产 → 分组行 → 逐资产候选产物 ---------- */
  const assetsState = useResource(
    () => api.projectAssets(projectId),
    { items: demoProjectAssets, count: demoProjectAssets.length },
    demoMode,
    [projectId],
  );
  const rows = useMemo<LiteAssetRow[]>(
    () => (assetsState.data?.items ?? []).map((ref) => ({ entityId: liteAssetEntityId(ref), asset: liteRefAsset(ref) })),
    [assetsState.data],
  );
  const entityIdsKey = rows.map((row) => row.entityId).join(",");

  const mediaState = useResource(
    () => (rows.length > 0 ? loadAssetMediaMap(projectId, rows) : Promise.resolve({} as Record<string, LiteAssetMedia>)),
    DEMO_LITE_ASSET_MEDIA,
    demoMode,
    // entityIdsKey 覆盖资产集变化；rows 本体由 assetsState.data 派生，同口径。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entityIdsKey],
  );
  const setMediaMap = mediaState.setData;

  /* ---------- tab 型素材列表（第一阶段：liteListAssets + tab bar） ---------- */
  const [activeTab, setActiveTab] = useState<string>(() => demoMode ? "all" : readCurrentAssetTab());
  /** 列表数据源:liteListAssets(projectId, kind?),返回列表项 + tab 聚合计数。 */
  const listState = useResource(
    () => api.liteListAssets(projectId, activeTab === "all" ? undefined : activeTab),
    DEMO_LITE_ASSET_LIST,
    demoMode,
    [projectId, activeTab],
  );
  /** 新建弹窗 A:打开时带当前 tab 的 kind（「全部」tab 不带 kind,弹窗里自选)。 */
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const switchTab = useCallback((tab: string): void => {
    setActiveTab(tab);
    if (!demoMode) writeCurrentAssetTab(tab);
  }, [demoMode]);

  /** 新建成功后刷新列表。 */
  const refreshList = useCallback((): void => {
    void listState.retry();
  }, [listState]);
  /** v1.9 十.9/十.11：资产卡删除入口——自定义二次确认弹窗后软删（R1 可逆），删完刷新列表。 */
  const [deletingAssetId, setDeletingAssetId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<LiteConfirmState | null>(null);
  function handleDeleteAssetFromCard(assetId: string, assetName: string): void {
    setDeleteConfirm({
      title: `删除资产「${assetName}」？`,
      description: "其下变体、图片与分镜关联将一并移除。此操作为软删，可在回收站恢复。",
      onConfirm: () => void (async () => {
        setDeletingAssetId(assetId);
        try {
          if (!demoMode) {
            await api.liteDeleteAsset(projectId, assetId);
          }
          notify("已删除资产", "success");
          setDeleteConfirm(null);
          refreshList();
        } catch (reason) {
          notify(humanErrorMessage(reason, "删除资产失败"), "error");
        } finally {
          setDeletingAssetId(null);
        }
      })(),
    });
  }


  /* ---------- 图片生成配置（404 = 未配置，按钮禁用给原因 + 页头条指路配置页） ---------- */
  const demoImageConfig = useMemo<LiteImageConfig>(() => ({
    tiers: [FALLBACK_IMAGE_TIER],
    strategy: {
      id: "demo-lite-image-default",
      project_id: projectId,
      media_kind: "image",
      mode: "material_to_prompt",
      model_key: FALLBACK_IMAGE_TIER.tier_id,
      parameters: { size: "2K", prompt_template_id: null },
      version: 1,
    },
    library: [],
  }), [projectId]);
  const imageConfigState = useResource(() => loadLiteImageConfig(projectId), demoImageConfig, demoMode, [projectId]);

  /* ---------- 素材登记（共享状态机；参考用途不发 PATCH，active 即「可引用」） ---------- */
  const { probeRegistrations } = useLiteRegistrations({ demoMode, notify });

  /* ---------- 实体化与提交态 ---------- */
  const [materializing, setMaterializing] = useState(false);
  const [materializeError, setMaterializeError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Record<string, TrackedAssetTask>>({});
  const [orphanInflightCount, setOrphanInflightCount] = useState(0);
  const [pollKick, setPollKick] = useState(0);
  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  /** 单资产候选刷新（生成成功/单卡重试后）；失败保留旧数据并把错误摆到该卡。 */
  const refreshAssetMedia = useCallback(async (assetEntityId: string): Promise<void> => {
    if (demoMode) return;
    try {
      const list = await api.liteAssetMedia(projectId, assetEntityId);
      setMediaMap((previous) => ({ ...(previous ?? {}), [assetEntityId]: { items: list.items } }));
    } catch (reason) {
      setMediaMap((previous) => ({
        ...(previous ?? {}),
        [assetEntityId]: { items: previous?.[assetEntityId]?.items ?? [], error: humanErrorMessage(reason, "读取失败") },
      }));
    }
  }, [demoMode, projectId, setMediaMap]);

  const patchTask = useCallback((requestId: string, patch: (current: TrackedAssetTask) => TrackedAssetTask | null): void => {
    setTasks((previous) => {
      const current = previous[requestId];
      if (!current) return previous;
      const next = patch(current);
      if (next === null) {
        const copy = { ...previous };
        delete copy[requestId];
        return copy;
      }
      return { ...previous, [requestId]: next };
    });
  }, []);

  const handleTaskSettled = useCallback((tracked: TrackedAssetTask, next: GenerationTask): void => {
    forgetLiteAssetGenMarker(window.sessionStorage, tracked.assetEntityId);
    if (next.status === "succeeded") {
      patchTask(tracked.requestId, () => null);
      void refreshAssetMedia(tracked.assetEntityId);
      notify("参考图已生成，可在候选里点「登记素材」入库后引用", "success");
      return;
    }
    if (next.status === "cancelled") {
      patchTask(tracked.requestId, () => null);
      return;
    }
    /* failed：留卡展示人话原因 + 重试入口（重试=完整重走 estimate→submit、新幂等键）。 */
    patchTask(tracked.requestId, (current) => ({ ...current, task: next }));
  }, [notify, patchTask, refreshAssetMedia]);

  const handleTaskGone = useCallback((tracked: TrackedAssetTask): void => {
    /* 403/404 = 任务已不可见（环境重置/越权）：摘除台账与卡片，不留永远的假「生成中」。 */
    forgetLiteAssetGenMarker(window.sessionStorage, tracked.assetEntityId);
    patchTask(tracked.requestId, () => null);
  }, [patchTask]);

  /* 轮询 effect 经 ref 调最新回调（回调依赖 notify 等渲染域值，不进轮询依赖）。 */
  const handleTaskSettledRef = useRef(handleTaskSettled);
  useEffect(() => { handleTaskSettledRef.current = handleTaskSettled; }, [handleTaskSettled]);
  const handleTaskGoneRef = useRef(handleTaskGone);
  useEffect(() => { handleTaskGoneRef.current = handleTaskGone; }, [handleTaskGone]);

  /* ---------- 轮询 hook（与 lite-shots-page.tsx 同口径复制件）：3s 起始、指数退避 15s 封顶、
     30 分钟总上限、标签页隐藏暂停 + 恢复即查、卸载清理。kick 变化（新任务/手动刷新）时重新布防。 ---------- */
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    let timer = 0;
    const hasWork = (): boolean => Object.values(tasksRef.current).some(isPollingTarget);
    const nextDelay = (): number => {
      const now = Date.now();
      let soonest = Number.POSITIVE_INFINITY;
      for (const tracked of Object.values(tasksRef.current)) {
        if (isPollingTarget(tracked)) soonest = Math.min(soonest, tracked.nextPollAt - now);
      }
      return Number.isFinite(soonest) ? Math.max(250, soonest) : 0;
    };
    const schedule = (ms: number): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void tick(), ms);
    };
    const tick = async (): Promise<void> => {
      if (!active) return;
      /* 标签页隐藏不发请求（document.hidden 暂停），visibilitychange 恢复即查。 */
      if (document.hidden) {
        schedule(POLL_BASE_MS);
        return;
      }
      const now = Date.now();
      const due = Object.values(tasksRef.current).filter((tracked) => isPollingTarget(tracked) && tracked.nextPollAt <= now);
      for (const tracked of due) {
        if (now - tracked.firstPollAt > POLL_TOTAL_CAP_MS) {
          patchTask(tracked.requestId, (current) => ({ ...current, timedOut: true }));
          continue;
        }
        try {
          const next = await api.generation(tracked.requestId);
          if (!active) return;
          patchTask(tracked.requestId, (current) => ({
            ...current,
            task: next,
            pollCount: current.pollCount + 1,
            pollFailures: 0,
            nextPollAt: Date.now() + pollDelayMs(current.pollCount + 1),
          }));
          if (!ACTIVE_GENERATION_STATUSES.includes(next.status)) handleTaskSettledRef.current(tracked, next);
        } catch (reason) {
          if (!active) return;
          if (reason instanceof ApiClientError && (reason.status === 403 || reason.status === 404)) {
            handleTaskGoneRef.current(tracked);
            continue;
          }
          patchTask(tracked.requestId, (current) => ({
            ...current,
            pollFailures: current.pollFailures + 1,
            nextPollAt: Date.now() + pollDelayMs(current.pollCount + 1),
          }));
        }
      }
      if (active && hasWork()) schedule(nextDelay());
    };
    const onVisibility = (): void => {
      if (!document.hidden && hasWork()) schedule(0);
    };
    if (hasWork()) schedule(0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // kick：新任务入列/手动刷新重新布防；回调经 ref 取最新，不进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, pollKick, patchTask]);

  /* ---------- 挂载恢复：projectGenerations 进行中清单 × sessionStorage 台账 → 回资产卡；
     台账外的进行中任务不强行归属（generationData 无 target_asset_entity_id），页顶计数提示。 ---------- */
  useEffect(() => {
    if (demoMode) return;
    let cancelled = false;
    void (async () => {
      let inflight: GenerationTask[];
      try {
        const list = await api.projectGenerations(projectId);
        inflight = list.items.filter((task) => ACTIVE_GENERATION_STATUSES.includes(task.status));
      } catch {
        return; // 恢复失败不阻断页面；手动刷新仍可用
      }
      if (cancelled) return;
      const markers = readLiteAssetGenMarkers(window.sessionStorage);
      const now = Date.now();
      const restored: Record<string, TrackedAssetTask> = {};
      const mappedRequestIds = new Set<string>();
      for (const { assetEntityId, marker } of markers) {
        if (!marker.requestId) continue;
        const activeTask = inflight.find((task) => task.generation_request_id === marker.requestId);
        if (activeTask) {
          mappedRequestIds.add(activeTask.generation_request_id);
          restored[activeTask.generation_request_id] = {
            requestId: activeTask.generation_request_id,
            assetEntityId,
            task: activeTask,
            firstPollAt: now,
            pollCount: 0,
            pollFailures: 0,
            nextPollAt: now + POLL_BASE_MS,
            timedOut: false,
          };
          continue;
        }
        /* 台账里的任务不在本项目进行中清单：查一次真态——成功刷新该卡候选、失败留卡可重试、
           取消/查不到摘除；仍在进行中 = 别的项目的任务（同一标签页台账跨项目共存），原样保留。 */
        try {
          const settled = await api.generation(marker.requestId);
          if (cancelled) return;
          if (settled.status === "succeeded") {
            forgetLiteAssetGenMarker(window.sessionStorage, assetEntityId);
            void refreshAssetMedia(assetEntityId);
          } else if (settled.status === "failed") {
            restored[marker.requestId] = {
              requestId: marker.requestId,
              assetEntityId,
              task: settled,
              firstPollAt: now,
              pollCount: 0,
              pollFailures: 0,
              nextPollAt: now,
              timedOut: false,
            };
            forgetLiteAssetGenMarker(window.sessionStorage, assetEntityId);
          } else if (settled.status === "cancelled") {
            forgetLiteAssetGenMarker(window.sessionStorage, assetEntityId);
          }
        } catch (reason) {
          if (reason instanceof ApiClientError && (reason.status === 403 || reason.status === 404)) {
            forgetLiteAssetGenMarker(window.sessionStorage, assetEntityId);
          }
        }
      }
      if (cancelled) return;
      /* 合并而非覆盖：恢复是异步的，期间本页新提交的任务（在 previous 里）不能被清掉。 */
      setTasks((previous) => ({ ...restored, ...previous }));
      setOrphanInflightCount(inflight.filter((task) => !mappedRequestIds.has(task.generation_request_id)).length);
      setPollKick((value) => value + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [demoMode, projectId, refreshAssetMedia]);

  /* ---------- 挂载/候选刷新恢复：对还没有登记记录的候选逐张 GET 一次还原状态
     （404=未登记，保持无记录；processing/active 由共享 hook 的轮询与分路接管）。 ---------- */
  useEffect(() => {
    if (demoMode) return;
    const mediaMap = mediaState.data;
    if (!mediaMap) return;
    const ids: string[] = [];
    for (const row of rows) {
      for (const item of assetImageCandidatesOf(mediaMap[row.entityId])) ids.push(item.id);
    }
    probeRegistrations(ids);
  }, [demoMode, mediaState.data, rows, probeRegistrations]);

  /* ---------- 动作：从解析结果建资产（幂等；409 引导去剧本页） ---------- */
  async function startMaterialize(): Promise<void> {
    if (demoMode) {
      notify("离线演示不会写入资产", "info");
      return;
    }
    if (materializing) return;
    setMaterializing(true);
    setMaterializeError(null);
    try {
      const result = await api.liteMaterializeAssets(projectId, readCurrentEpisodeId() ?? "");
      if (result.created > 0) notify(`已从解析结果建好 ${result.created} 个资产`, "success");
      else if (result.existed > 0) notify("解析结果里的资产都已在本项目，没有新增", "info");
      else notify("已确认的解析结果里没有可建的角色、场景或道具", "info");
      assetsState.retry();
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 409) {
        /* lite_breakdown_not_confirmed：项目还没确认过剧本解析 → 页内常驻提示，引导去剧本页。 */
        setMaterializeError(humanErrorMessage(reason, "请先在剧本页完成解析并采用"));
      } else {
        notify(humanErrorMessage(reason, "建资产失败，请重试"), "error");
      }
    } finally {
      setMaterializing(false);
    }
  }

  /* ---------- 渲染 ---------- */

  /** 页顶配置条：错误带重试、未配置/无档/模板超长带去配置页（一次说清解法）。 */
  function renderConfigNotice(): React.JSX.Element | null {
    if (demoMode) return null;
    const state = imageConfigState;
    let notice: { tone: "danger" | "warning" | "info"; text: string; retry?: () => void } | null = null;
    if (state.error && !state.data) {
      notice = { tone: "danger", text: `图片生成配置读取失败：${state.error}`, retry: state.retry };
    } else if (state.data) {
      const config = state.data;
      if (!config.strategy) {
        /* 从未配置（GET 404 → strategy null）：明确指配置页，不再调档反查（此前 strategy.model_key 崩）。 */
        notice = { tone: "warning", text: "图片生成默认配置未设置，请到配置页设置后再生成。" };
      } else if (effectivePromptTemplate(config.strategy, config.library, "image").missingTemplateId) {
        notice = { tone: "warning", text: "配置的图片提示词模板已不存在（可能已被删除），本次生成按系统默认模板执行。" };
      } else if (!resolveLiteTier(config.tiers, "image", config.strategy)) {
        notice = { tone: "warning", text: "配置页的图片模型或参数当前没有可用的参数选项，请到配置页重新选择后再生成。" };
      }
    }
    if (!notice) return null;
    const current = notice;
    return (
      <div
        role={current.tone === "danger" ? "alert" : "status"}
        className={
          current.tone === "danger"
            ? "flex flex-wrap items-center gap-3 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger"
            : current.tone === "warning"
              ? "flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-ink-1"
              : "flex flex-wrap items-center gap-3 rounded-md border border-border-1 bg-surface-1 px-3 py-2 text-sm text-ink-2"
        }
      >
        <WarningCircle className={current.tone === "danger" ? "size-4 shrink-0 text-danger" : current.tone === "warning" ? "size-4 shrink-0 text-warning" : "size-4 shrink-0 text-ink-3"} aria-hidden="true" />
        <span className="min-w-0 flex-1">{current.text}</span>
        {current.retry ? (
          <Button size="sm" variant="outline" icon={<ArrowClockwise />} onClick={current.retry}>重试</Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => navigate(`/lite/projects/${encodeURIComponent(projectId)}/config`)}>去配置页</Button>
        )}
      </div>
    );
  }

  /* tab 计数映射:kind → count;「全部」用列表项总数。 */
  const tabCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const tab of listState.data?.tab_counts ?? []) {
      map.set(tab.kind, tab.count);
    }
    return map;
  }, [listState.data?.tab_counts]);

  const listItems = listState.data?.items ?? [];
  const listTotal = listItems.length;
  const currentTabDef = LITE_ASSET_TABS.find((tab) => tab.key === activeTab) ?? LITE_ASSET_TABS[0]!;

  return (
    <section className="mx-auto flex w-full max-w-[1440px] 2xl:max-w-[1920px] flex-1 min-h-0 flex-col gap-5 overflow-y-auto">
      {/* 无页头（§3.2，2026-08-17 退役）：标题/副标题上壳单条；页首即配置提示 + 资产类型 tab，「新建XX」在 tab 内容行右侧。
          v1.8（lite-assets 九.1）：壳 h-dvh overflow-hidden 下本页即内层滚动容器，超一屏内容在页身滚动不被裁切。 */}

      {renderConfigNotice()}

      {orphanInflightCount > 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-border-1 bg-surface-1 px-3 py-2 text-sm text-ink-2" role="status">
          <SpinnerGap className="size-4 shrink-0 animate-spin text-accent-text" aria-hidden="true" />
          <span>有 {orphanInflightCount} 个生成任务仍在进行中（来自其它标签页或本次刷新前）。稍后可刷新本页查看最新结果。</span>
        </div>
      ) : null}

      {/* tab bar:全部 + 五类可解析资产 + 三类纯上传参考通道 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border-1 pb-2" role="tablist" aria-label="资产类型">
        {LITE_ASSET_TABS.map((tab) => {
          const count = tab.key === "all" ? (tabCountMap.values() ? Array.from(tabCountMap.values()).reduce((a, b) => a + b, 0) : 0) : (tabCountMap.get(tab.key) ?? 0);
          return (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              type="button"
              onClick={() => switchTab(tab.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors duration-[var(--duration-1)] ease-out-quart",
                activeTab === tab.key ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1",
              )}
            >
              {tab.label}
              {count > 0 ? <span className="text-xs text-ink-4">{count}</span> : null}
            </button>
          );
        })}
      </div>

      {/* tab 内容:新建按钮 + 列表 */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-3">
          {activeTab === "all" ? `共 ${listTotal} 项` : `${currentTabDef.label}（${listTotal}）`}
        </p>
        <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setCreateDialogOpen(true)}>
          {currentTabDef.newLabel}
        </Button>
      </div>

      {listState.loading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" aria-label="素材读取中">
          {["sk-a", "sk-b", "sk-c", "sk-d", "sk-e", "sk-f"].map((key) => <Skeleton className="aspect-square w-full" key={key} />)}
        </div>
      ) : listState.error ? (
        <ErrorState message={listState.error} onRetry={listState.retry} />
      ) : listTotal === 0 ? (
        <>
          {materializeError ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-ink-1" role="status">
              <WarningCircle className="size-4 shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 flex-1">{materializeError}：建资产前需要先在制作页确认解析结果。</span>
              <Button size="sm" variant="outline" onClick={() => navigate(liteProjectPath(projectId, "workspace"))}>去制作页</Button>
            </div>
          ) : null}
          <EmptyState
            icon={<User />}
            title={activeTab === "all" ? "这里还没有资产" : `${currentTabDef.label}还没有资产`}
            description={activeTab === "all"
              ? "资产来自剧本解析或手动新建：剧本确认后点「从解析结果建资产」一键导入，也可以点右上角「新建」手动添加。"
              : `点右上角「${currentTabDef.newLabel}」手动添加，或切换到「全部」查看所有资产。`}
            action={activeTab === "all" ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="primary" loading={materializing} onClick={() => void startMaterialize()}>从解析结果建资产</Button>
                <Button variant="outline" onClick={() => navigate(liteProjectPath(projectId, "workspace"))}>去制作页</Button>
              </div>
            ) : undefined}
          />
        </>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" aria-label="资产列表">
          {listItems.map((item) => (
            <Card
              key={item.asset_entity_id}
              className="flex cursor-pointer flex-col gap-0 p-0 transition-colors hover:bg-surface-2/50"
              onClick={() => navigate(liteAssetDetailPath(projectId, item.asset_entity_id))}
            >
              {/* 主媒体占位区:音频资产渲染音波图标(主媒体是音频文件,不能 <img>),其余走主图/占位 + 卡上删除入口(v1.9 十.9,二次确认) */}
              <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-t-md bg-surface-well/40">
                {item.primary_media_url ? (
                  item.asset_kind === "audio" ? (
                    <div className="flex flex-col items-center justify-center gap-1 text-ink-3" title="音频资产">
                      <SpeakerHigh className="size-8" weight="duotone" />
                    </div>
                  ) : (
                    <img src={item.primary_media_url} alt={item.name} className="h-full w-full object-cover" />
                  )
                ) : (
                  <ImageSquare className="size-8 text-ink-4" weight="duotone" />
                )}
                <button
                  type="button"
                  className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-surface-0/90 text-ink-3 transition-colors hover:text-error"
                  title={`删除资产「${item.name}」`}
                  aria-label={`删除资产「${item.name}」`}
                  disabled={deletingAssetId === item.asset_entity_id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDeleteAssetFromCard(item.asset_entity_id, item.name);
                  }}
                >
                  {deletingAssetId === item.asset_entity_id ? <SpinnerGap className="size-3.5 animate-spin" /> : <Trash className="size-3.5" />}
                </button>
              </div>
              {/* 文字区 */}
              <div className="flex flex-col gap-1 px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <strong className="truncate text-sm font-medium text-ink-1">{item.name}</strong>
                  <Badge title={item.asset_kind}>{assetKindLabel(item.asset_kind)}</Badge>
                </div>
                {item.audio_kind ? <p className="text-xs text-ink-3">分类：{audioKindLabel(item.audio_kind)}</p> : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* 弹窗 A:新建资产 */}
      {createDialogOpen ? (
        <LiteAssetCreateDialog
          projectId={projectId}
          defaultKind={activeTab === "all" ? null : activeTab}
          demoMode={demoMode}
          onClose={() => setCreateDialogOpen(false)}
          onCreated={() => { setCreateDialogOpen(false); refreshList(); }}
          notify={notify}
        />
      ) : null}
      {/* v1.9 十.11：删除资产自定义二次确认（取代浏览器原生 confirm） */}
      <LiteConfirmDialog state={deleteConfirm} busy={deletingAssetId !== null} onClose={() => setDeleteConfirm(null)} />
    </section>
  );
}
