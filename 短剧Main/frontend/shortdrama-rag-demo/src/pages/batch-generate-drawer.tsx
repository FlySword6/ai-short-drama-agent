import {
  ArrowClockwise,
  CheckCircle,
  Sparkle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TieredBatchEstimateItemInput } from "../api";
import { newId } from "../uuid";
import { demoEstimatePoints, FALLBACK_TIERS, listCapabilityTiers, resolveSelectedTier, tierLabel, tierSubmitInput, type CapabilityTier, type ProjectTierPreference } from "../capability-tiers";
import { COST_UNIT_LABEL } from "../cost-units";
import { recallSelectedTierId } from "../tier-selection";
import { isRecord } from "../generation-quotes";
import { businessErrorMessage } from "../error-copy";
import { EMPTY_PROJECT_CONFIG, projectGenerationConfigFromUnknown, projectTierPreference } from "../project-config";
import { rememberGenerationRequest, type GenerationTaskStorage } from "../generation-task-recovery";
import type {
  BatchEstimateResult,
  BatchSubmitInput,
  BatchSubmitItemResult,
  BatchSubmitResult,
  Episode,
  GenerationMediaKind,
  MediaVersion,
  Project,
  ProjectAssetRef,
  Shot,
} from "../types";
import type { PageRuntimeProps } from "./global-pages";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";

/* ============================================================
   P1 共享逻辑（板01 项目管理页 + 板03 分镜管理页 + 批量清单抽屉）
   纯函数集中在本文件，方便 src/p1-pages.test.ts 直接覆盖；
   页面文件只负责渲染与事件编排。
   板14 状态助手（慢加载升级 / 人话错误）也放这里：
   global-pages / version-modal 都从这里取（S11-4：/video 孤儿页已下线）。
   ============================================================ */

/* ---------- 积分口径 ---------- */

/**
 * 单位字样取自费用文案唯一出口 cost-units.ts（COST_UNIT_LABEL）；
 * 显示格式（fen 原值、千分位、不缩写）保持板01/03 既有口径，
 * global-pages.tsx 与 p1-pages.test.ts 均依赖本签名与输出。
 */
export function formatCredits(fen: number): string {
  return `${Math.max(0, Math.round(fen)).toLocaleString("zh-CN")} ${COST_UNIT_LABEL}`;
}

/* ---------- 板14 状态助手：慢加载升级 / 人话错误 ---------- */

/** 加载超过该阈值必须出现「仍在加载 · 重试」，禁止无限转圈（板14 加载态红线）。 */
export const LOADING_SLOW_THRESHOLD_MS = 8000;

export type LoadingEscalation = "loading" | "slow";

/** 纯判定：加载已持续 elapsedMs 时显示普通加载还是慢加载升级。 */
export function loadingEscalation(elapsedMs: number): LoadingEscalation {
  return elapsedMs >= LOADING_SLOW_THRESHOLD_MS ? "slow" : "loading";
}

/** 加载中的页面/区块挂载本 hook：超过 8s 仍未完成返回 true，驱动「仍在加载 · 重试」。 */
export function useSlowLoading(active: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    setSlow(false);
    const startedAt = Date.now();
    const timer = window.setTimeout(() => {
      if (loadingEscalation(Date.now() - startedAt) === "slow") setSlow(true);
    }, LOADING_SLOW_THRESHOLD_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  return slow;
}

/**
 * 板14 错误态：统一走正式版业务话术映射。已知英文错误先翻成中文，
 * 已有人话中文则保留，未知技术串退调用方中文 fallback；不把堆栈或厂商原文上屏。
 */
export function humanErrorMessage(reason: unknown, fallback = "操作失败，请重试"): string {
  return businessErrorMessage(reason, fallback);
}

function mediaKindOf(media: MediaVersion): GenerationMediaKind {
  return media.media_kind === "video" ? "video" : "image";
}

/** 取分镜某媒体类型的代表版本：选中主版本优先，其次 is_primary，再其次第一条。 */
export function selectedMediaForKind(shot: Shot, media: MediaVersion[], kind: GenerationMediaKind): MediaVersion | null {
  const selectedId = kind === "image" ? shot.selected_image_result_id : shot.selected_video_result_id;
  if (selectedId) {
    const hit = media.find((item) => item.id === selectedId);
    if (hit) return hit;
  }
  const ofKind = media.filter((item) => mediaKindOf(item) === kind);
  return ofKind.find((item) => item.is_primary) ?? ofKind[0] ?? null;
}

/* ---------- 板01：项目筛选（全部/进行中/已归档） ---------- */

/* 裁决 2：「已完成」tab/分桶已摘除——后端项目无可靠「已完成」状态来源（S10 死字段口径），
   completed/已完成 状态不再归桶（随未识别状态只在「全部」出现，不虚构一个过滤维度）。
   union 里的 "completed" 仅为 global-pages 旧 tab 兼容暂留（tab UI 摘除归 global-pages 所属线）。 */
export type ProjectFilterTab = "all" | "active" | "completed" | "archived";

/** 状态归桶；未识别状态归入 other，只在"全部"出现（与旧版行为一致）。 */
export function projectStatusBucket(status: string | null | undefined): ProjectFilterTab | "other" {
  const value = (status ?? "").trim().toLowerCase();
  if (["active", "进行中", "draft"].includes(value)) return "active";
  if (["archived", "已归档"].includes(value)) return "archived";
  return "other";
}

/** 名称/说明/负责人匹配搜索；负责人名由调用方解析（owner_id 无名字段时由页面兜底）。 */
export function filterProjects(
  projects: Project[],
  tab: ProjectFilterTab,
  query: string,
  ownerLabel: (project: Project) => string,
): Project[] {
  const keyword = query.trim().toLowerCase();
  return projects.filter((project) => {
    const bucket = projectStatusBucket(project.status);
    if (tab !== "all" && bucket !== tab) return false;
    if (!keyword) return true;
    const haystack = `${project.name} ${project.description ?? ""} ${ownerLabel(project)}`.toLowerCase();
    return haystack.includes(keyword);
  });
}

/* ---------- R2 看板列归组(批次一卡 3,Fable 放行单③) ---------- */

/** 看板四列;列序即生产流向。 */
export type ProjectBoardColumn = "prepare" | "shooting" | "review" | "delivered";

export const PROJECT_BOARD_COLUMNS: ReadonlyArray<{ value: ProjectBoardColumn; label: string }> = [
  { value: "prepare", label: "备戏" },
  { value: "shooting", label: "在拍" },
  { value: "review", label: "送审" },
  { value: "delivered", label: "已交" },
];

/**
 * 看板列归组(可推导口径,写死注释防语义漂移):
 * - delivered(已交)=status 归档(归档=交付后收档);
 * - prepare(备戏)=active 且 episode_count==0(还没剧本/没开拍);
 * - shooting(在拍)=active 且 episode_count>0;
 * - review(送审)=**无数据源恒空**——项目模型无 review 状态字段,不伪造;
 *   sol 交付「项目送审状态」字段后在此接入,接入前送审列如实空态。
 */
export function projectBoardColumn(project: Project): ProjectBoardColumn {
  if (projectStatusBucket(project.status) === "archived") return "delivered";
  if ((project.episode_count ?? 0) <= 0) return "prepare";
  return "shooting";
}

/* ---------- 板03：集分组与分镜命名 ---------- */

/**
 * 集分组：剧本集（导入 Excel 建立）与空白集（纯手动）。
 * 后端 Episode 无来源字段，按名称/状态启发式归类：手动创建的空白集命名带"空白集"。
 */
export function episodeGroup(episode: Episode): "script" | "blank" {
  // 裁决 8：Episode.status 真值域收敛 active|archived（manual/draft 死值已删），分组=名称启发式
  const name = (episode.name ?? "").trim();
  if (!name) return "blank";
  if (/空白|未命名|手动/.test(name)) return "blank";
  return "script";
}

/** 命名规则：集-分镜-场景-版本（1-1-客厅-v1）。场景/版本后端暂无字段时的兜底见回执。 */
export function shotDisplayName(episodeNo: number, shot: Shot, sceneName?: string): string {
  const shotNo = shot.shot_no?.trim() || (typeof shot.sort_order === "number" ? String(shot.sort_order) : "?");
  const scene = sceneName?.trim() || "未分场";
  return `${episodeNo}-${shotNo}-${scene}-v1`;
}

/** 生成引用：项目资产选定的媒体 id（与 workbench 的 reference_media_ids 同一语义），去重，最多 4 条。 */
export function referenceMediaIdsFromRefs(refs: ProjectAssetRef[]): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    const metadataPrimary = ref.asset?.metadata?.primary_image;
    const id = ref.asset_media_id
      ?? ref.asset?.selected_media_id
      ?? ref.asset?.current_media?.id
      ?? (isRecord(metadataPrimary) && typeof metadataPrimary.id === "string" ? metadataPrimary.id : null);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= 4) break;
  }
  return ids;
}

/* ---------- 批量清单：估价输入组装 ---------- */

/** 每 shot 组装 prompt：video → video_prompt/director_prompt/script_text；image → image_prompt/director_prompt/script_text。 */
export function batchPrompt(shot: Shot, kind: GenerationMediaKind): string {
  const primary = kind === "video" ? shot.video_prompt : shot.image_prompt;
  return primary?.trim()
    || shot.director_prompt?.trim()
    || shot.script_text?.trim()
    || `素材 #${shot.shot_no}`;
}

export function buildBatchItems(input: {
  projectId: string;
  episodeId: string;
  mediaKind: GenerationMediaKind;
  shots: Shot[];
  referenceMediaIds: string[];
  /** 提交档（capability-tiers 接口真源）：档是原子的,参数整档取;tier_id 全链必填（不一致 422）。
      缺省=初始档 fixture——仅供 demo/既有测试兼容路径;生产调用方（抽屉）必传接口档。 */
  tier?: CapabilityTier;
}): TieredBatchEstimateItemInput[] {
  const tier = input.tier ?? FALLBACK_TIERS[input.mediaKind][0]!;
  return input.shots.map((shot) => {
    const { parameters, quantity } = tierSubmitInput(tier);
    return {
      item_id: shot.id,
      media_kind: input.mediaKind,
      tier_id: tier.tier_id,
      project_id: input.projectId,
      episode_id: input.episodeId,
      scene_id: shot.scene_id ?? null,
      shot_id: shot.id,
      prompt: batchPrompt(shot, input.mediaKind),
      reference_media_ids: [...input.referenceMediaIds],
      parameters: { ...parameters },
      quantity,
      client_idempotency_key: `batch-${input.projectId}-${shot.id}-${input.mediaKind}-${newId()}`,
    };
  });
}

/* ---------- 批量清单：一次人工授权确认并提交 ---------- */

export type BatchSubmitClient = Pick<typeof api, "batchConfirm" | "submitGenerationBatch">;

/** 只把已报价行带入确认请求；报价失败行保留在清单中，绝不绕过估价。 */
export function buildBatchSubmitInput(input: {
  projectId: string;
  clientIdempotencyKey: string;
  estimate: BatchEstimateResult;
}): BatchSubmitInput {
  const items = input.estimate.items.flatMap((item) => item.availability === "available" && item.quote ? [{
    item_id: item.itemId,
    generation_quote_id: item.quote.generation_quote_id,
  }] : []);
  return {
    project_id: input.projectId,
    client_idempotency_key: input.clientIdempotencyKey,
    expected_total_estimated_cost_fen: items.reduce((sum, item) => {
      const estimated = input.estimate.items.find((estimateItem) => estimateItem.itemId === item.item_id)?.quote?.estimated_cost_fen ?? 0;
      return sum + estimated;
    }, 0),
    items,
  };
}

/**
 * 单次人工点击顺序完成确认与提交。确认请求带冻结报价清单；提交请求只带
 * authorization_id，避免客户端在第二步重传或替换报价项。
 */
export async function submitBatchEstimate(input: {
  projectId: string;
  clientIdempotencyKey: string;
  estimate: BatchEstimateResult;
  client?: BatchSubmitClient;
}): Promise<BatchSubmitResult> {
  const client = input.client ?? api;
  const confirmation = await client.batchConfirm(buildBatchSubmitInput(input));
  return client.submitGenerationBatch(confirmation.authorization_id);
}

/**
 * K2J：批量提交成功后逐项登记恢复台账（与单镜生成同一机制，见 workbench acceptGenerationTask）。
 * 登记后：进任一镜工作台 recoverGenerationTask 自动恢复任务卡；素材卡读同一台账显示进度徽标。
 * item_id 即分镜 id（buildBatchItems 合同）；只登记服务端真建任务的行。
 */
export function registerBatchGenerationRequests(
  storage: GenerationTaskStorage,
  projectId: string,
  mediaKind: GenerationMediaKind,
  items: BatchSubmitItemResult[],
): number {
  let registered = 0;
  for (const item of items) {
    if (item.status !== "created" || !item.generation_request_id) continue;
    rememberGenerationRequest(storage, projectId, item.item_id, mediaKind, item.generation_request_id);
    registered += 1;
  }
  return registered;
}

export interface BatchSubmitIdempotencyState {
  estimateKey: string;
  clientIdempotencyKey: string;
}

/**
 * A lost HTTP response is not permission to create another authorization. Keep
 * the key stable for the exact frozen estimate/list, and rotate it only after
 * the list or its quotes have been recomputed.
 */
export function batchSubmitIdempotencyForEstimate(
  current: BatchSubmitIdempotencyState | null,
  estimateKey: string,
  projectId: string,
  nextUuid: () => string = () => newId(),
): BatchSubmitIdempotencyState {
  if (current?.estimateKey === estimateKey) return current;
  return {
    estimateKey,
    clientIdempotencyKey: `batch-submit-${projectId}-${nextUuid()}`,
  };
}

/* ---------- 离线演示：本地合成估价与提交（不调用任何接口） ---------- */

/** demo 估价：提示词为兜底文案（无真实文本）的行标为不可行；可行行按当前选中档取
    demoEstimatePoints(tier)——与单镜估价同一函数同一档（K2S 返工「同镜同档同价」：
    批量总价=档价×可行镜数，复核阈值按真实档价触发，不虚高不低估；1 积分=1 分，
    档价 points 恒等写入 fen 字段，与单镜 formatCost(demoEstimatePoints) 同口径）。
    真栈不走本函数（服务端 batchEstimate 按 tier_id 报价）。 */
export function demoBatchEstimate(items: TieredBatchEstimateItemInput[], tier: CapabilityTier): BatchEstimateResult {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const tierPoints = demoEstimatePoints(tier);
  const rows = items.map((item) => {
    if (item.prompt.startsWith("素材 #")) {
      return {
        itemId: item.item_id,
        availability: "unavailable" as const,
        error: { code: "demo_missing_prompt", message: "该素材缺少可用提示词（离线演示）" },
      };
    }
    return {
      itemId: item.item_id,
      availability: "available" as const,
      quote: {
        generation_quote_id: `demo-quote-${item.item_id}`,
        source: "web" as const,
        action: "submit" as const,
        status: "pending_confirmation" as const,
        estimated_cost_fen: tierPoints,
        currency: "CNY" as const,
        expires_at: expiresAt,
        media_kind: item.media_kind,
      },
    };
  });
  const available = rows.filter((row) => row.availability === "available");
  const total = available.reduce((sum, row) => sum + (row.quote?.estimated_cost_fen ?? 0), 0);
  return {
    items: rows,
    count: rows.length,
    available_count: available.length,
    unavailable_count: rows.length - available.length,
    total_estimated_cost_fen: total,
    currency: "CNY",
    requires_manual_review: total > 500,
    creates_generation_tasks: false,
  };
}

function demoSubmitClient(): BatchSubmitClient {
  const inputs = new Map<string, BatchSubmitInput>();
  return {
    async batchConfirm(input) {
      await delay(40);
      const authorization_id = `demo-batch-${newId().slice(0, 8)}`;
      inputs.set(authorization_id, input);
      return { authorization_id };
    },
    async submitGenerationBatch(authorizationId) {
      await delay(90);
      const input = inputs.get(authorizationId);
      if (!input) throw new Error("离线演示授权已失效，请重新估价后确认");
      const items: BatchSubmitItemResult[] = input.items.map((item, index) => ({
        item_id: item.item_id,
        generation_quote_id: item.generation_quote_id,
        estimated_cost_fen: input.expected_total_estimated_cost_fen / Math.max(input.items.length, 1),
        status: "created",
        generation_request_id: `demo-request-${index + 1}`,
        generation_attempt_id: `demo-attempt-${index + 1}`,
        queue_position: index + 1,
        estimated_duration_seconds: 45 + index * 10,
      }));
      return {
        authorization_id: authorizationId,
        status: "completed",
        authorized_total_estimated_cost_fen: input.expected_total_estimated_cost_fen,
        submitted_total_estimated_cost_fen: input.expected_total_estimated_cost_fen,
        currency: "CNY",
        created_count: items.length,
        failed_count: 0,
        items,
        notice: `离线演示：已模拟创建 ${items.length} 个任务（未产生真实调用），进度见各镜工作台与右下角提醒`,
      };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/* ---------- 批量清单抽屉 ---------- */

/* ---------- N5(V-23):集级图片/视频拆抽屉——共享壳+各模态真实界面 ----------
   共享壳=估价/授权/清单机制(一套,不复制);各模态抽屉=独立导出,自带标题、
   范围口径与行内元信息(视频按秒计价带时长,图片按张计价带提示词来源),不再只换标题。 */
/** N5:各模态抽屉视图(标题/范围口径/行内元信息);#164 段级宿主可整只换视图。 */
export interface BatchKindView {
  title: string;
  /** 头部范围口径(清单范围+计价口径)。 */
  scopeNote: (shotCount: number) => string;
  /** 行内元信息(视频=时长;图片=提示词来源)。 */
  rowMeta?: (shot: Shot | undefined) => string | null;
}

const BATCH_KIND_VIEWS: Record<"image" | "video", BatchKindView> = {
  image: {
    title: "批量生成图片（本集）",
    scopeNote: (count) => `共 ${count} 个分镜 · 图片按张计价`,
    rowMeta: (shot) => (shot ? (shot.image_prompt?.trim() ? "用本镜图片提示词" : "提示词兜底：剧本文本") : null),
  },
  video: {
    title: "生成本集视频",
    scopeNote: (count) => `已就绪 ${count} 个分镜 · 视频按秒计价`,
    rowMeta: (shot) => (shot?.duration_seconds ? `时长 ${shot.duration_seconds}s` : null),
  },
};

export function BatchGenerateDrawer({
  projectId,
  episodeId,
  episodeNo,
  episodeLabel,
  shots,
  mediaKind,
  kindView = BATCH_KIND_VIEWS[mediaKind],
  referenceMediaIds,
  demoMode,
  notify,
  shotName,
  onClose,
  onCreated,
}: {
  projectId: string;
  episodeId: string;
  /** 集号(集级宿主传);段级宿主(#164)改传 episodeLabel 署名范围,两者至少给其一。 */
  episodeNo?: number;
  /** #164 段级批量:头部范围署名(例「段落·客厅」),优先于「第 N 集」。 */
  episodeLabel?: string;
  shots: Shot[];
  /** 集级批量只有图片/视频两种抽屉(音频无集级批量入口)。 */
  mediaKind: "image" | "video";
  /** N5:各模态真实界面视图(标题/范围口径/行内元信息);缺省按 mediaKind 取,两个独立抽屉显式传。 */
  kindView?: BatchKindView;
  referenceMediaIds: string[];
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  shotName?: (shot: Shot) => string;
  onClose: () => void;
  onCreated?: (createdCount: number) => void;
}): React.JSX.Element {
  /* 批量估价/提交档：与单发生成同一真源（capability-tiers 接口）;单档即唯一档。
     #172：默认档跟项目设定走——真栈把项目生成配置（画幅+该媒介清晰度）与档位同拉同结,
     按「项目精确匹配 → 保画幅取最便宜可提交档 → is_default → 首档」定默认档;项目没设定=全局缺省链不变。
     demo（K2S 返工「同镜同档同价」）：档=工作台当前选中档（会话共享 tier-selection，
     未选过/记录缺失回落缺省链，与单镜缺省同口径;demo 无项目配置真源,归空配置不打接口），
     行价与单镜同一函数 demoEstimatePoints 同一档;真栈批量整批同档（不逐行拼参数,
     服务端按 tier_id 报价，不读会话记录）。裁决 4：读取失败不回落本地档/不静默缺席,
     档位或项目配置任一路失败都进错误态如实显示可重试。 */
  const [tierState, setTierState] = useState<CapabilityTier | null>(null);
  const [tierError, setTierError] = useState("");
  const [tierRevision, setTierRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setTierError("");
    const load = async (): Promise<{ tiers: CapabilityTier[]; preference: ProjectTierPreference }> => {
      const result = await listCapabilityTiers(mediaKind, demoMode);
      const config = demoMode
        ? EMPTY_PROJECT_CONFIG
        : await api.project(projectId)
            .then(projectGenerationConfigFromUnknown)
            .catch((reason: unknown) => {
              throw new Error(`项目生成设定读取失败：${businessErrorMessage(reason, "请重试")}`);
            });
      return { tiers: result.tiers, preference: projectTierPreference(config, mediaKind) };
    };
    load()
      .then(({ tiers, preference }) => {
        if (cancelled) return;
        const persistedId = demoMode ? recallSelectedTierId(window.sessionStorage, mediaKind) : null;
        setTierState(resolveSelectedTier(tiers, persistedId, preference));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setTierState(null);
        setTierError(businessErrorMessage(reason, "生成档位读取失败"));
      });
    return () => { cancelled = true; };
  }, [mediaKind, demoMode, projectId, tierRevision]);
  const allItems = useMemo(
    () => (tierState ? buildBatchItems({ projectId, episodeId, mediaKind, shots, referenceMediaIds, tier: tierState }) : []),
    [projectId, episodeId, mediaKind, shots, referenceMediaIds, tierState],
  );
  const [includedItemIds, setIncludedItemIds] = useState<string[] | null>(null);
  const items = useMemo(
    () => includedItemIds === null ? allItems : allItems.filter((item) => includedItemIds.includes(item.item_id)),
    [allItems, includedItemIds],
  );
  const shotById = useMemo(() => new Map(shots.map((shot) => [shot.id, shot])), [shots]);
  const nameOf = useMemo(
    () => shotName ?? ((shot: Shot) => shotDisplayName(episodeNo ?? 0, shot)),
    [shotName, episodeNo],
  );
  const [estimate, setEstimate] = useState<BatchEstimateResult | null>(null);
  const [estimateError, setEstimateError] = useState("");
  const [estimating, setEstimating] = useState(true);
  const [estimateRevision, setEstimateRevision] = useState(0);
  const [submittedRows, setSubmittedRows] = useState<Record<string, BatchSubmitItemResult>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [closing, setClosing] = useState(false);
  const estimatePromise = useRef<{ key: string; promise: Promise<BatchEstimateResult> } | null>(null);
  const submitIdempotency = useRef<BatchSubmitIdempotencyState | null>(null);
  const closeTimer = useRef(0);

  // 清单内容本身也是报价输入；移出/重试某行后必须失效旧 promise 和旧合计。
  const estimateKey = `${demoMode ? "demo" : "live"}-${estimateRevision}-${JSON.stringify(items)}`;
  useEffect(() => {
    // StrictMode 双跑共享同一 promise：只估价一次，第二个 effect 挂载点复用结果。
    let active = true;
    setEstimating(true);
    setEstimate(null);
    setEstimateError("");
    if (items.length === 0) { setEstimating(false); return; }
    if (!tierState) { setEstimating(false); return; } // items 由 tierState 推导,有 items 必有档;防御性早退
    if (estimatePromise.current?.key !== estimateKey) {
      estimatePromise.current = {
        key: estimateKey,
        promise: demoMode ? Promise.resolve(demoBatchEstimate(items, tierState)) : api.batchEstimate(items),
      };
    }
    void estimatePromise.current.promise.then((result) => {
      if (active) setEstimate(result);
    }).catch((reason: unknown) => {
      if (active) setEstimateError(businessErrorMessage(reason, "批量估价失败，请重试"));
    }).finally(() => {
      if (active) setEstimating(false);
    });
    return () => { active = false; };
  }, [estimateKey, demoMode, items]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  /** 板15：抽屉退 160ms——先播退出动画再通知父层卸载；提交中禁止关闭。 */
  function requestClose(): void {
    if (closing || submitting) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => onClose(), 160);
  }

  // critique P2：Escape 统一关闭抽屉（与中心 modal 一致；提交中/关闭中不响应）
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  });

  const estimateById = useMemo(() => new Map((estimate?.items ?? []).map((item) => [item.itemId, item])), [estimate]);
  const availableCount = estimate?.available_count ?? 0;
  const totalFen = estimate?.total_estimated_cost_fen ?? 0;
  const kindLabel = mediaKind === "video" ? "视频" : "图片";
  const createdCount = Object.values(submittedRows).filter((row) => row.status === "created").length;
  const failedCount = Object.values(submittedRows).filter((row) => row.status !== "created").length;
  // 板14：估价超 8s 必须亮出「仍在加载 · 重试」，不做无限等待。
  const estimateSlow = useSlowLoading(estimating);

  async function confirmBatch(): Promise<void> {
    if (!estimate || submitting || done || availableCount === 0) return;
    setSubmitting(true);
    try {
      const idempotency = batchSubmitIdempotencyForEstimate(
        submitIdempotency.current,
        estimateKey,
        projectId,
      );
      submitIdempotency.current = idempotency;
      const result = await submitBatchEstimate({
        projectId,
        clientIdempotencyKey: idempotency.clientIdempotencyKey,
        estimate,
        client: demoMode ? demoSubmitClient() : api,
      });
      setSubmittedRows(Object.fromEntries(result.items.map((item) => [item.item_id, item])));
      setDone(true);
      /* K2J：批量任务下落——逐项登记会话台账（单镜同款机制），任务不再"提交即失踪"：
         进任一镜工作台自动恢复任务卡，素材卡显示排队/生成中/失败徽标。 */
      try {
        registerBatchGenerationRequests(window.sessionStorage, projectId, mediaKind, result.items);
      } catch {
        notify("任务已入队，但浏览器未能保存恢复信息，请暂时不要关闭当前页面", "error");
      }
      if (demoMode) notify(result.notice ?? `离线演示：已模拟创建 ${result.created_count} 个任务，未产生任何真实调用`, "info");
      else if (result.failed_count > 0) notify(`已创建 ${result.created_count} 个任务（进度见各镜工作台与右下角提醒），${result.failed_count} 个未创建，可重新估价后再次授权`, "error");
      else notify(`${result.created_count} 个任务已入队，进度见各镜工作台与右下角提醒`, "success");
      if (result.created_count > 0) onCreated?.(result.created_count);
    } catch (reason) {
      notify(businessErrorMessage(reason, "批量授权失败，请重新估价后重试"), "error");
    } finally {
      setSubmitting(false);
    }
  }

  function removeItem(itemId: string): void {
    setIncludedItemIds((current) => (current ?? allItems.map((item) => item.item_id)).filter((id) => id !== itemId));
  }

  function retryFailedRows(): void {
    const failedIds = Object.values(submittedRows).filter((row) => row.status !== "created").map((row) => row.item_id);
    if (failedIds.length === 0) return;
    setIncludedItemIds(failedIds);
    setSubmittedRows({});
    setDone(false);
    setEstimate(null);
    setEstimateRevision((value) => value + 1);
  }

  return (
    <>
      <div
        className={cn("fixed inset-0 z-[60] bg-surface-well/70 backdrop-blur-sm", closing ? "animate-fade-out" : "animate-fade-in")}
        role="presentation"
        onMouseDown={(event) => event.target === event.currentTarget && requestClose()}
      />
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-[61] flex w-[min(560px,100vw)] flex-col border-l border-border-2 bg-surface-1 shadow-[0_24px_48px_-16px_oklch(0_0_0/0.60)]",
          closing ? "animate-fade-out" : "animate-fade-up",
        )}
        role="dialog"
        aria-modal="true"
        aria-label={`批量生成${kindLabel}清单`}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-1 px-5 py-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-ink-1 text-section-title">{kindView.title}</h2>
            <p className="text-xs text-ink-2">{episodeLabel ?? (typeof episodeNo === "number" ? `第 ${episodeNo} 集` : "本次清单")} · {kindView.scopeNote(shots.length)}{tierState ? <> · 档位 <span className="font-mono text-ink-1">{tierLabel(tierState)}</span></> : null} · 先估价后人工确认</p>
          </div>
          <Button size="icon" variant="ghost" aria-label="关闭" title="关闭" onClick={requestClose} disabled={submitting || closing}><X /></Button>
        </header>
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {tierError ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center" role="alert">
              <WarningCircle className="size-6 text-danger" />
              <strong className="text-sm text-ink-1">生成档位读取失败</strong>
              <span className="text-xs text-ink-2">{tierError}（不回落本地档，裁决 4）</span>
              <Button icon={<ArrowClockwise />} onClick={() => setTierRevision((value) => value + 1)}>重新读取</Button>
            </div>
          ) : estimating ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center" aria-busy="true">
              <span className="skeleton h-12 w-full rounded-md" aria-hidden="true" />
              <span className="skeleton h-12 w-full rounded-md" aria-hidden="true" />
              <span className="skeleton h-12 w-3/5 rounded-md" aria-hidden="true" />
              <strong className="mt-2 text-sm text-ink-1">正在逐项估价…</strong>
              <span className="text-xs text-ink-2">先看价，不创建任务</span>
              {estimateSlow ? <Button icon={<ArrowClockwise />} onClick={() => setEstimateRevision((value) => value + 1)}>仍在加载 · 重试</Button> : null}
            </div>
          ) : estimateError ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center" role="alert">
              <WarningCircle className="size-6 text-danger" />
              <strong className="text-sm text-ink-1">估价失败</strong>
              <span className="text-xs text-ink-2">{estimateError}</span>
              <Button icon={<ArrowClockwise />} onClick={() => setEstimateRevision((value) => value + 1)}>重新估价</Button>
            </div>
          ) : estimate ? (
            <>
              <p className="text-xs text-ink-2">以下 {availableCount} 个分镜将各创建一个{kindLabel}任务：</p>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {items.map((item) => {
                  const estimateItem = estimateById.get(item.item_id);
                  const shot = shotById.get(item.item_id);
                  const row = submittedRows[item.item_id];
                  const quote = estimateItem?.availability === "available" ? estimateItem.quote : undefined;
                  return (
                    <li
                      className={cn(
                        "flex flex-col gap-1 rounded-md border px-3 py-2",
                        quote ? "border-border-1 bg-surface-2" : "border-danger/40 bg-danger/5",
                      )}
                      key={item.item_id}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-ink-1">{shot ? nameOf(shot) : item.item_id}</span>
                        {quote ? (
                          <span className="shrink-0 font-mono text-xs tabular-nums text-ink-1">{formatCredits(quote.estimated_cost_fen)}</span>
                        ) : null}
                      </div>
                      {kindView.rowMeta?.(shot) ? (
                        <span className="text-[11px] text-ink-3">{kindView.rowMeta(shot)}</span>
                      ) : null}
                      {!quote ? (
                        <span className="flex items-center gap-1 text-xs text-danger">
                          <WarningCircle aria-hidden="true" className="size-3.5 shrink-0" />不可行：{estimateItem?.error ? businessErrorMessage(estimateItem.error, "估价不可用") : "估价不可用"}
                        </span>
                      ) : null}
                      {row ? (
                        <span className={cn(
                          "flex items-center gap-1 text-xs",
                          row.status === "created" ? "text-success" : "text-danger",
                        )}>
                          {row.status === "created" ? <><CheckCircle className="size-3.5" />已进入队列{typeof row.queue_position === "number" ? ` · 第 ${row.queue_position} 位` : ""}{typeof row.estimated_duration_seconds === "number" ? ` · 预计 ${row.estimated_duration_seconds} 秒` : ""}</> : <><WarningCircle className="size-3.5" />{row.error ? businessErrorMessage(row.error, "本项未创建，可移出或重新估价后再次授权") : "本项未创建，可移出或重新估价后再次授权"}</>}
                        </span>
                      ) : null}
                      {!submitting && !done ? <Button size="sm" variant="ghost" className="self-end text-xs" onClick={() => removeItem(item.item_id)}>移出清单</Button> : null}
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center justify-between gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-2">
                <span className="text-xs text-ink-2">报价合计（本次授权金额）</span>
                <strong className="font-mono text-sm tabular-nums text-ink-1">{formatCredits(totalFen)}</strong>
              </div>
              {estimate.requires_manual_review ? (
                <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning" role="note">
                  <WarningCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  本次合计超出平台设定的复核提示阈值；本次确认仍是整份清单的一次人工授权，服务端会继续逐项核验价格与预算。
                </div>
              ) : null}
              {done ? (
                <div
                  className={cn(
                    "rounded-md border px-3 py-2 text-xs",
                    failedCount > 0 ? "border-warning/40 bg-warning/10 text-warning" : "border-success/40 bg-success/10 text-success",
                  )}
                  role="status"
                >
                  已创建 {createdCount} 个任务{failedCount > 0 ? `，${failedCount} 个未创建` : ""}；已创建项已显示队列位置与预计时长。
                  {failedCount > 0 ? <Button size="sm" variant="ghost" className="ml-2" onClick={retryFailedRows}>重新估价并再次授权失败项</Button> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <footer className="flex flex-col gap-2 border-t border-border-1 px-5 py-3">
          <p className="text-xs text-ink-2">先估价后人工确认：一次确认只提交一条批量授权；无人工确认不产生任何付费调用</p>
          <div className="flex items-center justify-end gap-2">
            <Button onClick={requestClose} disabled={submitting || closing}>{done ? "关闭" : "取消"}</Button>
            {!done ? (
              <Button
                variant="primary"
                icon={<Sparkle />}
                loading={submitting}
                disabled={!estimate || estimating || availableCount === 0}
                onClick={() => void confirmBatch()}
              >确认并生成 {availableCount} 项，合计 {formatCredits(totalFen)}</Button>
            ) : null}
          </div>
        </footer>
      </aside>
    </>
  );
}


/** N5(V-23):集级图片批量抽屉——独立界面(按张计价口径+提示词来源行),不再与视频共壳换标题。 */
export function BatchImageGenerateDrawer(props: Omit<React.ComponentProps<typeof BatchGenerateDrawer>, "mediaKind" | "kindView">): React.JSX.Element {
  return <BatchGenerateDrawer {...props} mediaKind="image" kindView={BATCH_KIND_VIEWS.image} />;
}

/** N5(V-23):集级视频批量抽屉——独立界面(按秒计价口径+仅就绪分镜+时长行)。 */
export function BatchVideoGenerateDrawer(props: Omit<React.ComponentProps<typeof BatchGenerateDrawer>, "mediaKind" | "kindView">): React.JSX.Element {
  return <BatchGenerateDrawer {...props} mediaKind="video" kindView={BATCH_KIND_VIEWS.video} />;
}
