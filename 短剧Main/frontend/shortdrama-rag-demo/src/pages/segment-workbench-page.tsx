/* ============================================================
   segment-workbench-page.tsx — 段落工作台(批次二 P-04)

   SPEC(475:2 P-04,Fable 逐字转录):三栏=参考控制包/段落结构/编译稿+段落头带;
   段落=场(scene),共 N 镜整段一次生成(R119);壳=rail+二级条(生产 current,壳层自动);
   首带标题含「参考控制包」(s46 改锚点,Fable 在合流批翻转守卫)。

   子卡 1(骨架,KIMI-FE-B2-P04-SKELETON-DONE):三栏+头带+路由。
   子卡 2(本版,编译稿两层+段落表):
   - 控制包接 lanes 真源:laneDefs() 词表驱动行位(词表不冻结,不写死八条);
     资产条目=项目资产实时分桶(seedLanesFromRefs,与镜头级工作台同一真源链);
     workshop 条目按 sceneId 落 localStorage(load/saveLanesState 同构复用,与镜头级命名空间不撞);
     「从项目资产选」=AssetPickDrawer(browse),真实栈先 addProjectAsset 再自动分桶进栏
     (与镜头级同语义:选入=加入项目资产;本卡不做资产条目摘除,走项目资产管理);
   - 就位计数=非空 lane 数/词表总条数(真实,随操作自动涨);
   - 编译稿两层:包级·自动=按 lanes 条目组织的控制包语义汇总(纯函数,前端诚实版;
     论文级编译在服务端,k3 包 2 落地后换源行为不变);镜头结构·逐镜=本场每镜
     生成依据(镜号+标题+提示词现状;R144③ 镜号无时间戳,时长只在 UI 展示层);
   - 段落表:中栏行可点选,与右栏逐镜区联动高亮;补充段输入区随子卡 3。
   R144 ④:音频行默认语义=音效(标注随行);R144 禁小作文:包级汇总只列条目组织,
   不发挥。accent 账:主动作 1 处=头带「开拍」(SPEC:主动作 1)。
   子卡 3b(整段开拍+先出样片,FABLE-B2-S3B-RULING):
   - 链路=batch-estimate→人工确认→batch-confirm→授权提交;样片/正片二选一不叠加(确认区一处切换,
     真相行只显选中一价);批幂等=段落级一键 client_idempotency_key 覆盖整批;
     超阈值(requires_manual_review)二次确认沿用 3a 同部件同阈值;
   - 0.6×=展示口径:现网无「样片档」、档原子不可拆参,样片价=服务端正式总价 Y×0.6 显示
     并标注口径;expected_total_estimated_cost_fen 仍取 Y(服务端真值,不编)。
   ============================================================ */
import * as React from "react";
import { ThinkingOrb } from "thinking-orbs";
import { ArrowLeft, Plus, ArrowCounterClockwise, DownloadSimple, FilmStrip, Images, Play, Sparkle, Translate, X } from "@phosphor-icons/react";
import { ApiClientError, api, type ShotMediaItem, type TieredBatchEstimateItemInput, type TieredGenerationSubmissionInput } from "../api";
import { navigate, projectScriptBreakdownPath, projectStoryboardPath, sceneWorkbenchPath } from "../routing";
import { formatDateTime, useResource } from "../ui";
import { ErrorState, Skeleton, Select, Textarea } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { AssetPickDrawer } from "../components/asset-pick-drawer";
import { activeTiers, listCapabilityTiers, resolveProjectDefaultTier, tierSubmitInput, type CapabilityTier } from "../capability-tiers";
import { newId } from "../uuid";
import { partitionControlPack } from "../control-pack";
import { ControlPackSubmitTruth } from "../components/control-pack-truth";
import { ProjectStyleBar } from "../components/project-style-bar";
import {
  EMPTY_PROJECT_CONFIG,
  projectGenerationConfigFromUnknown,
  projectTierPreference,
  type ProjectGenerationConfig,
} from "../project-config";
import { BatchGenerateDrawer, submitBatchEstimate, type BatchKindView } from "./batch-generate-drawer";
import { ShotImageResults } from "./shot-image-results";
import { PromptPrecheckCard } from "../components/prompt-precheck-card";
import { SegmentConsumptionBar } from "../components/segment-consumption-bar";
import { formatCost } from "../generation-quotes";
import { businessErrorMessage, generationFailureCopy } from "../error-copy";
import {
  attachLaneItem,
  detachLaneItem,
  emptyLanesState,
  laneDefs,
  loadLanesState,
  saveLanesState,
  seedLanesFromRefs,
  type LaneItem,
  type LanesState,
} from "../reference-lanes";
import type { AccountCreditSummary } from "../operations";
import { DEMO_EPISODE_SCENES, DEMO_SHOT_SCENES, demoProjectAssetsForProject, demoShots } from "../demo";
import type { Asset, BatchEstimateResult, GenerationTask, ProjectAssetRef, Scene, Shot } from "../types";
import type { PageRuntimeProps } from "./global-pages";

function laneDomainLabel(domain: string): string {
  if (domain === "entity") return "实体";
  if (domain === "style") return "风格";
  return "媒介";
}

/* ---------- GENDOMAIN 连续生成(V-50 后半)·本场排除清单 ----------
   asset 条目=项目资产共享,摘除语义=「本场不带」(不解除项目引用,不伤其他场/镜);
   排除清单按 sceneId 落 localStorage,seed 后过滤不回流。workshop 条目摘除=detachLaneItem。 */
const EXCLUDED_LANES_PREFIX = "shortdrama_lanes_excluded_v1:";

interface ExcludedAssetItem {
  id: string;
  name: string;
}

function readExcludedAssetItems(storage: Storage, sceneId: string): ExcludedAssetItem[] {
  try {
    const raw = storage.getItem(`${EXCLUDED_LANES_PREFIX}${sceneId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ExcludedAssetItem =>
      Boolean(item) && typeof item === "object" && typeof (item as ExcludedAssetItem).id === "string" && typeof (item as ExcludedAssetItem).name === "string",
    );
  } catch {
    return [];
  }
}

function writeExcludedAssetItems(storage: Storage, sceneId: string, items: readonly ExcludedAssetItem[]): void {
  try {
    storage.setItem(`${EXCLUDED_LANES_PREFIX}${sceneId}`, JSON.stringify(items));
  } catch { /* 私密模式/满,排除仅本次会话可见 */ }
}

function filterExcludedFromLanes(lanes: LanesState, excluded: readonly ExcludedAssetItem[]): LanesState {
  if (excluded.length === 0) return lanes;
  const ids = new Set(excluded.map((item) => item.id));
  const next: LanesState = { ...lanes };
  for (const lane of Object.keys(next)) {
    next[lane] = (next[lane] ?? []).filter((item) => !ids.has(item.id));
  }
  return next;
}

/** 包级·自动编译稿(前端诚实版):按 lane 组织条目名清单,不发挥(R144 禁小作文);
    服务端编译器(k3 包 2)落地后换源,呈现两层结构不变。 */
function buildPackAutoSection(lanes: LanesState, sceneName: string): string {
  const parts: string[] = [];
  for (const def of laneDefs()) {
    const items = lanes[def.id] ?? [];
    if (items.length === 0) continue;
    parts.push(`${def.label}:${items.map((item) => item.name).join("、")}`);
  }
  if (parts.length === 0) return "";
  return `段落《${sceneName}》参考控制包——${parts.join(";")}。整段共用以上参考。`;
}

function shotMediaStateLabel(shot: Shot): string {
  if (shot.selected_video_result_id) return "已有视频";
  if (shot.selected_image_result_id) return "已有图";
  return "未生成";
}

/* ---------- #164 G9:段级批量生图(本段 N 镜一次提交) ----------
   抽屉=batch-generate-drawer 共享壳(估价→人工确认→授权提交三段链不变);
   段级视图=标题/范围口径换「本段」,行内元信息沿用图片模态(提示词来源行)。 */
const SEGMENT_IMAGE_BATCH_VIEW: BatchKindView = {
  title: "批量生成图片（本段）",
  scopeNote: (count) => `共 ${count} 个镜头 · 图片按张计价`,
  rowMeta: (shot) => (shot ? (shot.image_prompt?.trim() ? "用本镜图片提示词" : "提示词兜底：剧本文本") : null),
};

/* G10:单镜「再出一批/换个说法重试」的抽屉视图(P-17a 右上同名钮)——同一共享抽屉,
   清单只带本镜;估价→人工确认→授权提交三段链不变。 */
function shotImageBatchView(shot: Shot): BatchKindView {
  return {
    title: `再出一批 · #${shot.shot_no} ${shot.title?.trim() || `镜头 ${shot.shot_no}`}`,
    scopeNote: () => "只出本镜 · 图片按张计价",
    rowMeta: SEGMENT_IMAGE_BATCH_VIEW.rowMeta,
  };
}

/** 段级清单行名:镜号+标题(段级无集号语境,不编)。 */
function segmentShotName(shot: Shot): string {
  return `#${shot.shot_no} ${shot.title?.trim() || `镜头 ${shot.shot_no}`}`;
}

/** 逐镜生成依据:镜号+标题+提示词现状(R144③ 镜号无时间戳;时长仅 UI 展示层)。 */
function shotBasisText(shot: Shot): string {
  const text = (shot.video_prompt ?? shot.image_prompt ?? shot.script_text ?? "").trim();
  return text || "还没有写这镜的生成依据";
}

export function SegmentWorkbenchPage({ projectId, episodeId, sceneId, demoMode, notify }: PageRuntimeProps & { projectId: string; episodeId: string; sceneId: string }): React.JSX.Element {
  const sceneState = useResource(
    () => api.episodeScenes(episodeId),
    { items: DEMO_EPISODE_SCENES.get(episodeId) ?? [], count: DEMO_EPISODE_SCENES.get(episodeId)?.length ?? 0 },
    demoMode,
    [episodeId],
  );
  const shotState = useResource(
    () => api.shots(episodeId),
    { items: demoShots.filter((shot) => shot.episode_id === episodeId), count: demoShots.filter((shot) => shot.episode_id === episodeId).length },
    demoMode,
    [episodeId],
  );
  /* 控制包 lanes 真源:资产条目=项目资产实时分桶(与镜头级同一真源);
     workshop 条目按 sceneId 落 localStorage(与镜头级 shotId 命名空间不撞)。 */
  const refsState = useResource(
    () => api.projectAssets(projectId),
    { items: demoProjectAssetsForProject(projectId), count: demoProjectAssetsForProject(projectId).length },
    demoMode,
    [projectId],
  );
  /* #151：项目级生成配置——生成确认区的「这次出片」条（默认痕迹+项目风格）读它；
     后端 #149 未合入前 wire 无这些字段,归一空配置=条不显示,不伪造。 */
  const projectConfigState = useResource(
    async () => projectGenerationConfigFromUnknown(await api.project(projectId)),
    {
      ...EMPTY_PROJECT_CONFIG,
      aspectRatio: "9:16",
      imageResolution: "1K",
      videoResolution: "720p",
      styleImage: { description: "港风黑帮、霓虹夜景、胶片颗粒、低饱和", referenceMediaIds: [] },
      styleVideo: { description: "手持轻晃、运动幅度中等、节奏偏慢、雨声垫底", referenceMediaIds: [] },
    } satisfies ProjectGenerationConfig,
    demoMode,
    [projectId],
  );
  const projectConfig = projectConfigState.data ?? EMPTY_PROJECT_CONFIG;
  /** 「这次不带」项目风格=只影响这一次,不回写项目配置（提交带 skip_project_defaults,后端 #149 接缝）。 */
  const [skipProjectStyle, setSkipProjectStyle] = React.useState(false);
  const [lanesState, setLanesState] = React.useState<LanesState>(() => emptyLanesState());
  /* 装载闸门(hydrated 用 state 不用 ref):首趟 load 完成前不 save——
     StrictMode 双跑=load→save→load→save,若 save 不在闸内,首趟空态 save 会把
     别的页面(P-03b 送入这场戏)预先写好的 workshop 条目冲掉(P-03b 实证抓出)。 */
  const [lanesHydrated, setLanesHydrated] = React.useState(false);
  /* GENDOMAIN·减参考:本场排除清单(asset 条目);变化即重 seed,lanesState 自动过滤不回流。 */
  const [excludedAssetItems, setExcludedAssetItems] = React.useState<ExcludedAssetItem[]>(() => readExcludedAssetItems(window.localStorage, sceneId));
  React.useEffect(() => { writeExcludedAssetItems(window.localStorage, sceneId, excludedAssetItems); }, [excludedAssetItems, sceneId]);
  React.useEffect(() => {
    const seeded = filterExcludedFromLanes(seedLanesFromRefs(refsState.data?.items ?? []), excludedAssetItems);
    setLanesState(loadLanesState(window.localStorage, sceneId, seeded));
    setLanesHydrated(true);
  }, [refsState.data, sceneId, excludedAssetItems]);
  React.useEffect(() => {
    if (!lanesHydrated) return;
    saveLanesState(window.localStorage, sceneId, lanesState);
  }, [lanesState, sceneId, lanesHydrated]);

  /** 减参考:workshop 条目=本场私有直删;asset 条目=「本场不带」进排除清单(不伤项目引用)。 */
  function removeLaneItem(lane: string, item: LaneItem): void {
    if (item.origin === "asset") {
      setExcludedAssetItems((current) => (current.some((entry) => entry.id === item.id) ? current : [...current, { id: item.id, name: item.name }]));
      return;
    }
    setLanesState((current) => detachLaneItem(current, lane, item.id));
  }

  function restoreExcludedAsset(itemId: string): void {
    setExcludedAssetItems((current) => current.filter((entry) => entry.id !== itemId));
  }

  const scene: Scene | undefined = sceneState.data?.items.find((item) => item.id === sceneId);
  const sceneName = scene?.name?.trim() || "未分场";
  /* L1 分镜切换条(P-04b §9.2 顶层):同集段落按 sort_order 直切,不用退回段落列表。 */
  const siblingScenes = React.useMemo(
    () => [...(sceneState.data?.items ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [sceneState.data],
  );
  /* #164:shots 派生数组必须 memo——批量抽屉以它为报价输入(项级幂等键随构建轮换),
     每次渲染新数组会让抽屉反复失效重估(估价风暴)。 */
  const shots = React.useMemo(
    () => (shotState.data?.items ?? [])
      .filter((shot) => (demoMode ? scene ? DEMO_SHOT_SCENES[shot.id] === scene.name : false : shot.scene_id === sceneId))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [shotState.data, demoMode, scene, sceneId],
  );

  const laneList = laneDefs();
  const readyLaneCount = laneList.filter((def) => (lanesState[def.id] ?? []).length > 0).length;
  /* V-29 软引导缺类清单(话术对齐 P-04b):缺哪几类点名,不硬闸。 */
  const missingLanes = laneList.filter((def) => (lanesState[def.id] ?? []).length === 0);
  const missingLaneLabels = missingLanes.map((def) => def.label).join("、");
  const packAutoSection = buildPackAutoSection(lanesState, sceneName);
  /* X3 补漏:包级编译稿旁的参考条目缩略图——与编译稿同源(lanesState 全 lane 摊平),有图出图。 */
  const packEntries = laneList.flatMap((def) => (lanesState[def.id] ?? []).map((item) => ({ item, laneLabel: def.label })));
  /* 块 3 欠件①:真相条取数=渲染期一次分层(submitted/excluded 同源),
     确认区两处共用;提交函数仍取提交时点快照(路径不动)。 */
  const packPartition = partitionControlPack(lanesState, refsState.data?.items ?? []);

  /* L1「重新生成」(P-04b §9.2):重算派生物=重拉最新剧本(镜头)/资产并重匹配控制包
     (lanes 随 refsState.data 变化自动重 seed),编译稿=派生渲染随之重汇;忙态如实=
     两个资源任一个在拉取(retry 返回 void,不伪造进度)。
     铁律:只重算派生物,不触碰任何生成/估价端点,不扣积分;付费生成仍须人点开拍。 */
  const derivRefreshing = refsState.loading || shotState.loading;
  function regenerateDerivatives(): void {
    refsState.retry();
    shotState.retry();
    notify("正在按最新剧本与资产重算提示词与控制包匹配（不扣积分）", "info");
  }

  /* #164 G9:段级批量生图——参考集=段落控制包 submitted 层(与逐镜/整段视频同一取数源);
     memo 依赖保持稳定(lanesState/refsState.data),抽屉清单的项级幂等键才不会随父层重渲染重建。
     G10:抽屉清单按调用方给——头带=本场全部镜头;镜头图片面板「再出一批/换个说法重试」=单镜。 */
  const [batchImageShots, setBatchImageShots] = React.useState<Shot[] | null>(null);
  const batchImageReferenceIds = React.useMemo(
    () => [...new Set(partitionControlPack(lanesState, refsState.data?.items ?? []).submitted.map((option) => option.mediaId))],
    [lanesState, refsState.data],
  );

  const [selectedShotId, setSelectedShotId] = React.useState<string | null>(null);
  /* G10:选中镜的产物面板分页签——图片(选定稿,默认)/视频(G11/G12),与 P-04b 逐镜行
     「视频/图片」入口同义;换镜回到图片签。 */
  const [shotPanel, setShotPanel] = React.useState<"image" | "video">("image");
  React.useEffect(() => { setShotPanel("image"); }, [selectedShotId]);
  const [pickLane, setPickLane] = React.useState<string | null>(null);

  /* GENDOMAIN/V-13:逐镜提示词行内编辑+AI 触点(起草/优化+中英互译,模型可选)。
     编辑目标=video_prompt(视频生成依据);保存后 setData 局部更新不整页刷;
     AI 结果只回填编辑框,落库必须人点「保存」——AI 不替人确认。 */
  const [editingShotId, setEditingShotId] = React.useState<string | null>(null);
  const [editingText, setEditingText] = React.useState("");
  const [promptSaving, setPromptSaving] = React.useState(false);
  const [promptSaveError, setPromptSaveError] = React.useState("");
  const [promptAiBusy, setPromptAiBusy] = React.useState<"" | "draft" | "zh" | "en">("");
  const [promptAiError, setPromptAiError] = React.useState("");
  const [promptModelKey, setPromptModelKey] = React.useState("");
  const promptModelsState = useResource(
    () => api.listPromptModels(),
    { items: [] as { key: string; displayName: string; description?: string; available: boolean; isDefault?: boolean }[], defaultKey: undefined as string | undefined },
    demoMode,
    [],
  );
  const promptModels = promptModelsState.data?.items ?? [];

  function startEditShotPrompt(shot: Shot): void {
    setEditingShotId(shot.id);
    setEditingText(shot.video_prompt ?? "");
    setPromptSaveError("");
    setPromptAiError("");
  }

  async function saveShotPrompt(shot: Shot): Promise<void> {
    setPromptSaving(true);
    setPromptSaveError("");
    try {
      if (demoMode) {
        shotState.setData((current) => (current ? { ...current, items: current.items.map((item) => (item.id === shot.id ? { ...item, video_prompt: editingText } : item)) } : current));
      } else {
        const updated = await api.updateShot(shot.id, { video_prompt: editingText });
        shotState.setData((current) => (current ? { ...current, items: current.items.map((item) => (item.id === shot.id ? updated : item)) } : current));
      }
      setEditingShotId(null);
    } catch (error) {
      setPromptSaveError(businessErrorMessage(error, "提示词保存失败，请重试"));
    } finally {
      setPromptSaving(false);
    }
  }

  async function runPromptAi(kind: "draft" | "zh" | "en", shot: Shot): Promise<void> {
    setPromptAiBusy(kind);
    setPromptAiError("");
    try {
      const modelKey = promptModelKey || undefined;
      const next = kind === "draft"
        ? (await api.draftPrompt({
            mediaKind: "video",
            description: editingText.trim() || `${sceneName}第 ${shot.shot_no} 镜:${shot.script_text?.trim() || shot.title?.trim() || "新镜头"}`,
            selectedAssetIds: packPartition.submitted.map((entry) => entry.mediaId),
            modelKey,
            projectId,
          })).promptText
        : await api.translatePrompt({ auto: editingText, targetLanguage: kind, modelKey, projectId });
      if (next.trim()) {
        setEditingText(next);
      } else {
        setPromptAiError("AI 没有给出可用文本，请重试或改用手写");
      }
    } catch (error) {
      setPromptAiError(businessErrorMessage(error, "AI 暂时不可用，请稍后再试或改用手写"));
    } finally {
      setPromptAiBusy("");
    }
  }

  /* ---------- 子卡 3:段落版本条+时间轴+逐镜重生成 ----------
     付费纪律(V-25/SPEC):每镜一次显式点击只创建一个任务(submitting 闸门);
     幂等=client_idempotency_key(每次展开新造);提交前真相行=参考集统计+档位+估价,
     确认即按正式报价扣费;超复核阈值(requires_manual_review)再经一次人工确认。
     先出样片(0.6×)与整段开拍=子卡 3b(见下,已落地)。 */
  const [genTick, setGenTick] = React.useState(0);
  const genState = useResource(
    () => api.projectGenerations(projectId),
    { items: [] as GenerationTask[], count: 0 },
    demoMode,
    [projectId, genTick],
  );
  /* 本场任务按时间正序=版本 v1 起编;进行中=「生成中」语义。
     (任务视图无 scene_id 输出,按本场 shot_id 集合过滤——与提交时写入的 shot_id 同链。) */
  const sceneShotIds = React.useMemo(() => new Set(shots.map((shot) => shot.id)), [shots]);
  const sceneVersions = React.useMemo(() => (genState.data?.items ?? [])
    .filter((task) => task.shot_id !== null && task.shot_id !== undefined && sceneShotIds.has(task.shot_id))
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))), [genState.data, sceneShotIds]);

  /* GENDOMAIN·连续生成(V-50 后半):有在途任务时 6s 轮询任务区;在途→全落终态的边沿
     镜头区重拉(selected_* 回填)——不刷新页面就能看到「生成中→已回」。 */
  const hasInflight = sceneVersions.some((task) => task.status === "pending" || task.status === "running");
  const genRetryRef = React.useRef(genState.retry);
  genRetryRef.current = genState.retry;
  const shotRetryRef = React.useRef(shotState.retry);
  shotRetryRef.current = shotState.retry;
  const wasInflightRef = React.useRef(false);
  /* #164 G11/G12:在途→全落终态的边沿,镜头产物面板同步重拉(视频回片后不用刷新页面)。 */
  const [mediaTick, setMediaTick] = React.useState(0);
  React.useEffect(() => {
    if (demoMode || !hasInflight) return;
    const timer = window.setInterval(() => { genRetryRef.current(); }, 6000);
    return () => window.clearInterval(timer);
  }, [demoMode, hasInflight]);
  React.useEffect(() => {
    if (wasInflightRef.current && !hasInflight) {
      shotRetryRef.current();
      setMediaTick((tick) => tick + 1);
    }
    wasInflightRef.current = hasInflight;
  }, [hasInflight]);

  /* GENDOMAIN·余额感知(判据 4):确认区可见「本单多少/余额多少」,不够说真话。 */
  const creditsState = useResource<AccountCreditSummary | null>(() => api.accountCreditsMe(), null, demoMode, []);
  const balancePoints = creditsState.data?.balancePoints ?? null;
  /* #172：单镜重生成/段级批量视频的默认档跟项目设定走（与批量生图弹窗同一选档来源）——
     项目设了画幅/清晰度按项目匹配（清晰度查无档保画幅取最便宜可提交档）；
     项目没设定/配置读取失败维持现状=首个 active 档。配置未就绪期间按「档位未就绪」处理,
     不先亮首档再跳档。 */
  const [videoTiers, setVideoTiers] = React.useState<readonly CapabilityTier[] | null>(null);
  const [tierFailed, setTierFailed] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    setTierFailed(false);
    void listCapabilityTiers("video", demoMode)
      .then((result) => { if (active) setVideoTiers(result.tiers); })
      .catch(() => { if (active) { setVideoTiers(null); setTierFailed(true); } });
    return () => { active = false; };
  }, [demoMode]);
  const projectConfigSettled = demoMode || projectConfigState.data !== null || projectConfigState.error !== "";
  const videoTier = videoTiers !== null && projectConfigSettled
    ? resolveProjectDefaultTier(videoTiers, projectTierPreference(projectConfig, "video")) ?? activeTiers(videoTiers)[0] ?? null
    : null;

  /** 逐镜重生成展开态:shotId+本次意图的幂等键(收起丢弃,重开新造)。 */
  const [regen, setRegen] = React.useState<{ shotId: string; key: string } | null>(null);
  const [regenSubmitting, setRegenSubmitting] = React.useState(false);
  const [regenError, setRegenError] = React.useState("");
  const [regenReview, setRegenReview] = React.useState(false);
  /* R223 知情继续:定稿图没存进资产库时后端会挡住(不入库,生出来的人物跟定稿图对不上)。
     独立于 regenReview——费用复核和人物一致性是两件事,合用一个状态会让用户点掉一个
     顺手把另一个也点掉。 */
  const [finalImageBlocked, setFinalImageBlocked] = React.useState("");
  const [finalImageConfirmed, setFinalImageConfirmed] = React.useState(false);

  function openRegen(shotId: string): void {
    setRegen((current) => (current?.shotId === shotId ? null : { shotId, key: newId() }));
    setRegenError("");
    setRegenReview(false);
    setFinalImageBlocked("");
    setFinalImageConfirmed(false);
  }

  /** 提交参考集=段落控制包全量(partitionControlPack submitted 层,与镜头级同一取数源);
      提示词=包级编译稿+该镜生成依据(整段同版,R144③ 镜号无时间戳)。 */
  async function submitRegen(shot: Shot): Promise<void> {
    if (demoMode) { notify("离线演示不会提交真实生成。", "info"); return; }
    if (!videoTier || regenSubmitting) return; // 闸门:一次提交未完成前再点不重复创建
    const prompt = [packAutoSection, shotBasisText(shot)].filter((part) => part && !part.startsWith("还没有")).join("\n").trim();
    if (!prompt) { setRegenError("先备控制包或写这镜的生成依据"); return; }
    const referenceIds = [...new Set(partitionControlPack(lanesState, refsState.data?.items ?? []).submitted.map((option) => option.mediaId))];
    const input: TieredGenerationSubmissionInput = {
      media_kind: "video",
      project_id: projectId,
      episode_id: episodeId,
      scene_id: sceneId,
      shot_id: shot.id,
      prompt,
      reference_media_ids: referenceIds,
      parameters: videoTier.params as Record<string, string | number | boolean>,
      quantity: 1,
      /* #151：「这次不带」项目风格时告知后端（只影响这一次）；默认路径不带键。 */
      ...(skipProjectStyle ? { skip_project_defaults: true } : {}),
      /* R223：只有用户在告知区明确点过「仍要生成」才带上;默认不带,让后端照常挡。 */
      ...(finalImageConfirmed ? { unregistered_final_image_confirmed: true } : {}),
      client_idempotency_key: regen?.key ?? newId(),
      tier_id: videoTier.tier_id,
    };
    setRegenError("");
    setRegenSubmitting(true);
    try {
      const quote = await api.quoteGeneration(input);
      if (quote.requires_manual_review === true && !regenReview) {
        // 超复核阈值:不停提交,界面转为「费用需复核」待人工再确认一次
        setRegenReview(true);
        return;
      }
      const confirmed = quote.status === "confirmed" ? quote : await api.confirmGenerationQuote(quote.generation_quote_id);
      await api.createGeneration(input, confirmed.generation_quote_id);
      notify(`镜头 #${shot.shot_no} 已提交,队列处理中`, "success");
      setRegen(null);
      setRegenReview(false);
      setFinalImageBlocked("");
      setFinalImageConfirmed(false);
      setGenTick((tick) => tick + 1);
      /* GENDOMAIN·余额感知:扣费后刷新余额行——连续第二次确认看到的是新余额。 */
      creditsState.retry();
    } catch (reason) {
      /* R223:定稿图没入库被挡住时不当普通报错——那句红字用户看不出该干什么。
         转成告知区:说清后果 + 给「去存进资产库」和「仍要生成」两条出路。 */
      if (reason instanceof ApiClientError && reason.code === "shot_final_image_unregistered") {
        setFinalImageBlocked(reason.message);
        setRegenError("");
        return;
      }
      /* GENDOMAIN:余额不足说真话带数(缺多少+去哪充),其余走业务映射。 */
      setRegenError(generationFailureCopy(reason, {
        costPoints: videoTier ? videoTier.price.points * (shot.duration_seconds ?? (Number(videoTier.params.duration_seconds ?? 0) || 4)) : null,
        balancePoints,
      }));
    } finally {
      setRegenSubmitting(false);
    }
  }

  /* ---------- 子卡 3b:整段开拍+先出样片(FABLE-B2-S3B-RULING) ----------
     链路=batch-estimate→人工确认→batch-confirm→授权提交;样片/正片二选一不叠加(确认区一处切换,
     真相行只显选中一价);批幂等=段落级一键 client_idempotency_key 覆盖整批(裁定②);
     超阈值(requires_manual_review)二次确认沿用 3a 同部件同阈值(裁定③)。
     0.6×=展示口径(裁定①落法):现网无「样片档」、档原子不可拆参,样片价=服务端正式总价
     Y×0.6 显示并标注「试样 0.6× 口径,实收以服务端结算为准」;提交 expected_total 仍取 Y
     (服务端真值,不编);后端将来有样片计费规则时前端换源。 */
  type SegMode = "sample" | "full";
  type SegEstimate =
    | { state: "loading" }
    | { state: "ready"; result: BatchEstimateResult }
    | { state: "demo"; seconds: number; totalPoints: number }
    | { state: "error"; message: string };
  const [seg, setSeg] = React.useState<{ mode: SegMode; key: string } | null>(null);
  const [segEstimate, setSegEstimate] = React.useState<SegEstimate | null>(null);
  const [segSubmitting, setSegSubmitting] = React.useState(false);
  const [segReview, setSegReview] = React.useState(false);
  const [segError, setSegError] = React.useState("");

  /** 整段 items:段落语义「所见=所发」——提示词=包级编译稿+该镜生成依据(与 3a submitRegen
      同构),参考=控制包 submitted 层 mediaId 去重,参数=档原子(tierSubmitInput);
      项级幂等键由批级键派生,批级键=段落级一键(裁定②)。 */
  function buildSegmentItems(batchKey: string, tier: CapabilityTier): TieredBatchEstimateItemInput[] {
    const referenceIds = [...new Set(partitionControlPack(lanesState, refsState.data?.items ?? []).submitted.map((option) => option.mediaId))];
    const { parameters, quantity } = tierSubmitInput(tier);
    return shots.map((shot) => ({
      item_id: shot.id,
      media_kind: "video",
      project_id: projectId,
      episode_id: episodeId,
      scene_id: sceneId,
      shot_id: shot.id,
      prompt: [packAutoSection, shotBasisText(shot)].filter((part) => part && !part.startsWith("还没有")).join("\n").trim(),
      reference_media_ids: referenceIds,
      parameters,
      quantity,
      /* #151：与逐镜同口径——「这次不带」项目风格时告知后端（只影响这一次）。 */
      ...(skipProjectStyle ? { skip_project_defaults: true } : {}),
      client_idempotency_key: `${batchKey}-${shot.id}`,
      tier_id: tier.tier_id,
    }));
  }

  function openSeg(mode: SegMode): void {
    if (seg) { setSeg({ ...seg, mode }); return; } // 已开=只切模式,不重复估价(裁定①:二选一只切显示价)
    const key = newId();
    setSeg({ mode, key });
    setSegError("");
    setSegReview(false);
    if (demoMode) {
      // 离线演示无服务端报价:按 fixture 档积分单价×时长展示(演示口径,不伪造 fen 金额)
      const seconds = shots.reduce((sum, shot) => sum + (shot.duration_seconds ?? (Number(videoTier?.params.duration_seconds ?? 0) || 0)), 0);
      setSegEstimate({ state: "demo", seconds, totalPoints: (videoTier?.price.points ?? 0) * seconds });
      return;
    }
    if (!videoTier) return; // 钮已禁用,防御
    setSegEstimate({ state: "loading" });
    void api.batchEstimate(buildSegmentItems(key, videoTier))
      .then((result) => setSegEstimate({ state: "ready", result }))
      .catch((reason) => setSegEstimate({ state: "error", message: reason instanceof Error ? reason.message : "估价失败，请稍后重试" }));
  }

  function closeSeg(): void {
    setSeg(null);
    setSegEstimate(null);
    setSegReview(false);
    setSegError("");
  }

  async function submitSegment(): Promise<void> {
    if (demoMode) { notify("离线演示不会提交真实生成。", "info"); return; }
    if (!seg || segSubmitting || segEstimate?.state !== "ready") return;
    const estimate = segEstimate.result;
    // 超复核阈值:第一次点击只转「费用需复核」态,再点一次才提交(裁定③,3a 同部件同阈值)
    if (estimate.requires_manual_review && !segReview) { setSegReview(true); return; }
    setSegError("");
    setSegSubmitting(true);
    try {
      const result = await submitBatchEstimate({ projectId, clientIdempotencyKey: seg.key, estimate });
      if (result.status === "failed") {
        setSegError(result.notice ?? "整批提交失败，请稍后重试");
        return;
      }
      notify(
        result.status === "partial"
          ? `已提交 ${result.created_count} 个任务,${result.failed_count} 个失败,可稍后在队列重试`
          : `${seg.mode === "sample" ? "样片" : "整段"}已提交,共 ${result.created_count} 个任务,队列处理中`,
        result.status === "partial" ? "info" : "success",
      );
      closeSeg();
      setGenTick((tick) => tick + 1);
      /* GENDOMAIN·余额感知:扣费后刷新余额行。 */
      creditsState.retry();
      /* GENDOMAIN·连续生成:提交后留在本页(版本条+6s 轮询闭环),不再送用户去 /queue。 */
    } catch (reason) {
      setSegError(generationFailureCopy(reason, {
        costPoints: segEstimate?.state === "ready" ? Math.round(segEstimate.result.total_estimated_cost_fen * (seg?.mode === "sample" ? 0.6 : 1)) : null,
        balancePoints,
      }));
    } finally {
      setSegSubmitting(false);
    }
  }

  const segDisabled = shots.length === 0 || segSubmitting || (!demoMode && !videoTier);
  const segDisabledTitle = shots.length === 0
    ? "这场还没有镜头，回段落列表先排镜"
    : !demoMode && !videoTier
      ? tierFailed ? "视频档位未配置，稍后再试" : "正在读取档位"
      : undefined;

  /** 从项目资产选入控制包:真实栈=加入项目资产后自动分桶进栏(与镜头级同语义);
      demo=会话内挂条目(不持久,离线口径)。 */
  async function addAssetToLane(lane: string, asset: Asset): Promise<boolean> {
    if (demoMode) {
      setLanesState((current) => attachLaneItem(current, lane, {
        id: `asset:${asset.id}`,
        name: asset.display_name || asset.name || "未命名资产",
        kind: (asset.asset_kind ?? "").toLowerCase().includes("audio") ? "audio" : "image",
        thumbUrl: asset.thumbnail_url || asset.storage_url || undefined,
        origin: "asset",
      }));
      notify("离线示例资产只保存在当前页面，未写入服务", "info");
      return true;
    }
    try {
      await api.addProjectAsset(projectId, asset.id);
      refsState.retry();
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "加入项目资产失败", "error");
      return false;
    }
  }

  async function removeProjectRef(ref: ProjectAssetRef): Promise<void> {
    if (demoMode) return;
    try {
      await api.removeProjectAsset(projectId, ref.id);
      refsState.retry();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "移出项目资产失败", "error");
    }
  }

  return (
    <div className="flex flex-col gap-4" aria-label="段落工作台">
      {/* 段落头带:←段落列表(SPEC 交互:→P-07 域)/场名/共 N 镜/就位计数/保存态;
          右侧=先出样片(Ghost)+开拍(Primary,SPEC 主动作 1 处)——档未配置禁用并说明(裁决 4) */}
      <header className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" icon={<ArrowLeft />} onClick={() => navigate(projectStoryboardPath(projectId))}>段落列表</Button>
        {sceneState.loading ? (
          <Skeleton className="h-6 w-32" />
        ) : (
          <h1 className="text-lg font-semibold text-tk-ink-1">{sceneName}</h1>
        )}
        <span className="font-tkmono text-xs text-tk-ink-3">共 {shots.length} 镜</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="font-tkmono text-xs text-tk-ink-3">控制包 {readyLaneCount}/{laneList.length} 就位</span>
          {/* s16 语义:无编辑=已保存(本页控制包操作即存,无未保存态) */}
          <span className="text-xs text-tk-ink-2">已自动保存</span>
          {/* #164 G9:本段镜头批量生图入口——抽屉估价→人工确认→授权提交;无镜禁用并说明。 */}
          <Button
            size="sm"
            variant="ghost"
            icon={<Images />}
            disabled={shots.length === 0}
            title={shots.length === 0 ? "这场还没有镜头，回段落列表先排镜" : "本段镜头一次提交批量生图：先估价后人工确认，确认才创建任务"}
            onClick={() => setBatchImageShots(shots)}
          >批量生图</Button>
          <Button size="sm" variant="ghost" icon={<FilmStrip />} disabled={segDisabled} title={segDisabledTitle} onClick={() => openSeg("sample")}>先出样片</Button>
          <Button size="sm" variant="primary" icon={<Play />} disabled={segDisabled} title={segDisabledTitle ?? "整段一次生成（R119）；确认报价后扣费"} onClick={() => openSeg("full")}>开拍</Button>
        </span>
      </header>

      {/* L1 分镜切换条(P-04b §9.2 顶层):同集段落直切,不用退回段落列表;>1 段才渲染。 */}
      {siblingScenes.length > 1 ? (
        <nav className="flex flex-wrap items-center gap-1" aria-label="分镜切换" data-testid="scene-switcher">
          {siblingScenes.map((item, index) => {
            const current = item.id === sceneId;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={current ? "page" : undefined}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-150",
                  current ? "border-tk-accent/70 text-tk-accent" : "border-tk-border-1 text-tk-ink-3 hover:border-tk-border-2 hover:text-tk-ink-1",
                )}
                title={current ? "当前段落" : `切到 ${item.name?.trim() || `段落 ${index + 1}`}`}
                onClick={() => {
                  if (!current) navigate(sceneWorkbenchPath(projectId, episodeId, item.id));
                }}
              >
                {index + 1} · {item.name?.trim() || `段落 ${index + 1}`}
              </button>
            );
          })}
        </nav>
      ) : null}

      {/* L1 剧本片段条+「重新生成」(P-04b 第二层,本期口径):剧本编辑仍在剧本页(剧本只有一份,
          这里改=剧本页改,直达链接不复制一套编辑面);重新生成只重算派生物,不扣积分(§9.2)。 */}
      <section className="flex flex-wrap items-center gap-3 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-2" aria-label="剧本片段与派生物">
        <span className="text-xs text-tk-ink-2">剧本片段 · {sceneName}</span>
        <button
          type="button"
          className="text-[11px] text-tk-ink-3 underline-offset-2 hover:text-tk-ink-1 hover:underline"
          onClick={() => navigate(projectScriptBreakdownPath(projectId))}
        >在剧本页打开 →</button>
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={derivRefreshing}
            title="重算派生物:按最新剧本与资产重算提示词与控制包匹配;不创建生成任务,不扣积分"
            data-testid="regenerate-derivatives"
            onClick={regenerateDerivatives}
          >
            {derivRefreshing ? <ThinkingOrb state="composing" size={20} aria-label="重算中" /> : <ArrowCounterClockwise aria-hidden="true" />}
            重新生成
          </Button>
          <span className="text-[10px] text-tk-ink-3">重算提示词与匹配，不扣积分</span>
        </span>
      </section>

      {/* L2 三页签骨架(P-04b 第三层,§9.6 拍板):本期只做工作台;参考图/生成视频留灰
          并写明为什么灰(待模型接线/待拍板),不实现、不假点。 */}
      <div className="flex flex-wrap items-stretch gap-2" role="group" aria-label="工作台页签" data-testid="workbench-tabs">
        <span className="flex flex-col rounded-md border border-tk-accent/60 bg-tk-panel px-3 py-1.5" aria-current="page">
          <span className="text-xs font-semibold text-tk-ink-1">工作台</span>
          <span className="text-[10px] text-tk-ink-3">参考控制包+编译稿，生成在这里发生</span>
        </span>
        <span className="flex flex-col rounded-md border border-tk-border-1 px-3 py-1.5 opacity-70" aria-disabled="true" data-testid="tab-reference-images-disabled">
          <span className="text-xs text-tk-ink-3">参考图</span>
          <span className="text-[10px] text-warning">本期不做 · 图像处理与宫格分镜，待模型接线</span>
        </span>
        <span className="flex flex-col rounded-md border border-tk-border-1 px-3 py-1.5 opacity-70" aria-disabled="true" data-testid="tab-video-disabled">
          <span className="text-xs text-tk-ink-3">生成视频</span>
          <span className="text-[10px] text-warning">本期不做 · 视频提示词与模型选择，待拍板</span>
        </span>
      </div>

      {/* 整段生成确认区(子卡 3b):点开拍/先出样片展开——样片/正片二选一切换+
          提交前真相行(参考集统计/档/N 镜/选中价)+确认/取消;不点开不渲染(无假按钮)。 */}
      {seg ? (
        <section className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="整段生成确认">
          {/* #151：这次出片条——项目默认 vs 这次改过的痕迹 + 项目风格带/不带（§4.1/§4.2）。 */}
          <ProjectStyleBar config={projectConfig} kind="video" tier={videoTier} skipped={skipProjectStyle} onToggleSkip={setSkipProjectStyle} />
          {/* Phase 3: 场景消耗汇总条(开拍前展示已花多少) */}
          <SegmentConsumptionBar projectId={projectId} sceneId={sceneId} demoMode={demoMode} genTick={genTick} />
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xs font-semibold text-tk-ink-2">整段生成</h2>
            <div className="flex items-center gap-1" role="group" aria-label="生成模式">
              {([["sample", "先出样片 0.6×"], ["full", "开拍正片"]] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={seg.mode === mode}
                  className={cn(
                    "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors duration-150",
                    seg.mode === mode ? "border-tk-border-2 bg-tk-hover text-tk-ink-1" : "border-tk-border-1 bg-tk-elevated text-tk-ink-3 hover:border-tk-border-2",
                  )}
                  onClick={() => setSeg({ ...seg, mode })}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="ml-auto font-tkmono text-xs text-tk-ink-3">共 {shots.length} 镜{videoTier ? ` · 档 ${videoTier.tier_id}` : ""}</span>
          </div>
          {/* 提交真相条(块 3 欠件①接线,GP-11/16/17):随提交计数+模式人话+媒体分计,
              不随提交逐项带原因;段落提交无确认图参数→byImage=false=多模态参考(与 payload 一致)。
              档位见头行右侧 mono,价格见下行——确认即按报价扣费。 */}
          <ControlPackSubmitTruth options={packPartition.submitted} excluded={packPartition.excluded} byImage={false} />
          {/* V-29「备好再拍」软引导(PRD 生产章二):就位不足可开拍,但确认区亮缺口,不硬闸。
              话术对齐 P-04b:缺哪几类点名+「仍可开拍」,按钮不降级不弹窗。 */}
          {missingLanes.length > 0 ? (
            <p className="text-[11px] leading-4 text-warning" data-testid="prep-shortfall-note">还缺 {missingLanes.length} 类参考（{missingLaneLabels}），通过率会低。仍可开拍。</p>
          ) : null}
          {/* 价格行:只显选中模式一价(裁定①) */}
          {segEstimate?.state === "loading" ? (
            <Skeleton className="h-5 w-48" />
          ) : segEstimate?.state === "error" ? (
            <p className="text-[11px] text-danger" role="alert">{segEstimate.message}</p>
          ) : segEstimate?.state === "demo" ? (
            <p className="text-[11px] leading-4 text-tk-ink-2">
              {seg.mode === "sample"
                ? `演示口径：${videoTier?.price.points ?? 0} 积分/秒 × ${segEstimate.seconds}s × 0.6 = ${Math.round(segEstimate.totalPoints * 0.6)} 积分（试样）`
                : `演示口径：${videoTier?.price.points ?? 0} 积分/秒 × ${segEstimate.seconds}s = ${segEstimate.totalPoints} 积分`}
              <span className="text-tk-ink-2">；离线演示不出服务端报价</span>
            </p>
          ) : segEstimate?.state === "ready" ? (
            <p className="text-[11px] leading-4 text-tk-ink-2">
              {seg.mode === "sample" ? (
                <>
                  试样价 <strong className="text-tk-ink-1">{formatCost(Math.round(segEstimate.result.total_estimated_cost_fen * 0.6))}</strong>
                  <span className="text-tk-ink-2">（试样 0.6× 口径，正片价 {formatCost(segEstimate.result.total_estimated_cost_fen)}，实收以服务端结算为准）</span>
                </>
              ) : (
                <>
                  正片价 <strong className="text-tk-ink-1">{formatCost(segEstimate.result.total_estimated_cost_fen)}</strong>
                  <span className="text-tk-ink-2">（{segEstimate.result.available_count}/{segEstimate.result.count} 镜可估，确认即按正式报价扣费）</span>
                </>
              )}
            </p>
          ) : null}
          {segEstimate?.state === "ready" && segEstimate.result.unavailable_count > 0 ? (
            <p className="text-[11px] text-tk-ink-3">{segEstimate.result.unavailable_count} 镜暂不可估，提交只含可估的 {segEstimate.result.available_count} 镜。</p>
          ) : null}
          {/* GENDOMAIN 余额感知(判据 4):本单花多少/余额还有多少;不够说真话(缺多少+去哪充)。 */}
          {segEstimate?.state === "ready" && balancePoints !== null ? (
            (() => {
              const cost = Math.round(segEstimate.result.total_estimated_cost_fen * (seg.mode === "sample" ? 0.6 : 1));
              const short = cost - balancePoints;
              return short > 0 ? (
                <p className="text-[11px] leading-4 text-danger" data-testid="credit-shortfall-line" role="alert">
                  本单 {cost} 积分 · 余额 {balancePoints} 积分 · 还差 {short} 积分，请充值或兑换邀请码后再试
                </p>
              ) : (
                <p className="text-[11px] leading-4 text-tk-ink-3" data-testid="credit-awareness-line">本单 {cost} 积分 · 余额 {balancePoints} 积分</p>
              );
            })()
          ) : null}
          {/* Phase 3: 提示词预检卡(提交前展示提示词完备度评分,不阻止提交) */}
          <PromptPrecheckCard
            projectId={projectId}
            sceneId={sceneId}
            tierId={videoTier?.tier_id ?? ""}
            mediaKind="video"
            parameters={(videoTier?.params as Record<string, string | number | boolean>) ?? {}}
            referenceMediaIds={[...new Set(partitionControlPack(lanesState, refsState.data?.items ?? []).submitted.map((option) => option.mediaId))]}
            referenceLaneCount={readyLaneCount}
            demoMode={demoMode}
          />
          {segReview ? <p className="text-[11px] text-danger" role="alert">这次生成超出复核阈值，请再确认一次费用。</p> : null}
          {segError ? <p className="text-[11px] text-danger" role="alert">{segError}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={closeSeg}>取消</Button>
            <Button
              size="sm"
              variant="primary"
              loading={segSubmitting}
              disabled={segSubmitting || (!demoMode && segEstimate?.state !== "ready") || (segEstimate?.state === "ready" && segEstimate.result.available_count === 0)
                || (segEstimate?.state === "ready" && balancePoints !== null && Math.round(segEstimate.result.total_estimated_cost_fen * (seg.mode === "sample" ? 0.6 : 1)) > balancePoints)}
              title={segEstimate?.state === "ready" && balancePoints !== null && Math.round(segEstimate.result.total_estimated_cost_fen * (seg.mode === "sample" ? 0.6 : 1)) > balancePoints
                ? "积分不够：请充值或兑换邀请码后再试"
                : "确认即按正式报价扣费生成；一次确认只创建一批任务"}
              onClick={() => void submitSegment()}
            >
              {segReview ? "确认费用并生成" : seg.mode === "sample" ? "确认出样片" : "确认开拍"}
            </Button>
          </div>
        </section>
      ) : null}

      {/* 段落版本条(segment-versions,SPEC 手搭件)+时间轴:整段生成版本按时间正序 v1 起,
          进行中=「生成中」;时间轴=本场镜头时长序列(时间码仅 UI 展示层,R144③)。 */}
      <section className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="段落版本与时间轴">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-semibold text-tk-ink-2">段落版本</h2>
          {genState.loading ? (
            <Skeleton className="h-5 w-24" />
          ) : sceneVersions.length === 0 ? (
            <span className="text-[11px] text-tk-ink-2">还没有整段生成的版本</span>
          ) : (
            <ol className="flex flex-wrap items-center gap-1">
              {sceneVersions.map((task, index) => {
                const inflight = task.status === "pending" || task.status === "running";
                return (
                  <li
                    key={task.generation_request_id}
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-2 py-0.5 font-tkmono text-[10px]",
                      inflight ? "border-tk-accent/40 bg-tk-accent-subtle text-tk-accent" : "border-tk-border-1 text-tk-ink-3",
                    )}
                    title={task.status}
                  >
                    {/* 等待态必须有动效(issue #164):在途版本 pill 带 working orb,不是静态文字。 */}
                    {inflight ? <ThinkingOrb state="working" size={20} aria-label="生成中" /> : null}
                    v{index + 1}{inflight ? " · 生成中" : ""}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        {shots.length > 0 ? (
          <div className="flex items-stretch gap-0.5" role="list" aria-label="镜头时间轴">
            {shots.map((shot) => (
              <div
                key={shot.id}
                role="listitem"
                className="flex min-w-8 flex-col items-center rounded-sm bg-tk-elevated px-1 py-1"
                style={{ flexGrow: Math.max(shot.duration_seconds ?? 0, 1), flexBasis: 0 }}
                title={`#${shot.shot_no} · ${shot.duration_seconds ?? "—"}s`}
              >
                <span className="font-tkmono text-[10px] text-tk-ink-2">#{shot.shot_no}</span>
                <span className="font-tkmono text-[9px] text-tk-ink-2">{shot.duration_seconds ?? "—"}s</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)_minmax(300px,360px)]">
        {/* 左栏:参考控制包(首带)——词表驱动行位;整段共用,换镜不重备 */}
        <aside className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="参考控制包">
          <header className="flex items-center justify-between gap-2">
            <h2 className="text-section-title text-tk-ink-1">
              参考控制包
              {/* 术语(P-04b):未满叫「备料中」,不提「锁定」;满了不加戏。 */}
              {missingLanes.length > 0 ? (
                <span className="ml-1.5 rounded-sm border border-warning/50 px-1 py-0.5 align-middle text-[10px] font-normal text-warning" data-testid="pack-prepping-tag">备料中</span>
              ) : null}
            </h2>
            <span className="font-tkmono text-xs text-tk-ink-3">
              {readyLaneCount}/{laneList.length} 就位{missingLanes.length > 0 ? ` · 还差 ${missingLanes.length} 件` : ""}
            </span>
          </header>
          {laneList.map((def) => {
            const items = lanesState[def.id] ?? [];
            return (
              <div className="flex flex-col gap-1 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-2" key={def.id}>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-tk-ink-2">{laneDomainLabel(def.id === "character" || def.id === "scene" || def.id === "prop" ? "entity" : def.id === "reference_video" || def.id === "audio" ? "media" : "style")}</span>
                  <strong className="text-xs font-semibold text-tk-ink-1">{def.label}</strong>
                  {def.id === "audio" ? <span className="text-[11px] text-tk-ink-2">默认按音效参考</span> : null}
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-tk-ink-3 underline-offset-2 hover:text-tk-ink-1 hover:underline"
                    aria-label={`从项目资产选${def.label}`}
                    onClick={() => setPickLane(def.id)}
                  >
                    <Plus aria-hidden="true" className="size-3" />选
                  </button>
                </div>
                {items.length === 0 ? (
                  <span className="text-[11px] text-tk-ink-2">{def.emptyHint || "未加入"}</span>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {items.map((item) => (
                      <li className="group flex items-center gap-1.5 text-[11px] text-tk-ink-2" key={item.id}>
                        {item.thumbUrl ? (
                          <img alt="" className="size-4 shrink-0 rounded-sm object-cover" src={item.thumbUrl} />
                        ) : null}
                        <span className="truncate">{item.name}</span>
                        <button
                          type="button"
                          aria-label={`本场不带${item.name}`}
                          className="ml-auto shrink-0 rounded-sm px-0.5 text-tk-ink-3 opacity-0 transition-opacity duration-150 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                          title={item.origin === "asset" ? "本场不带（可在下方恢复，不伤项目资产）" : "从本场控制包摘除"}
                          onClick={() => removeLaneItem(def.id, item)}
                        >
                          <X aria-hidden="true" className="size-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          <p className="text-[11px] leading-4 text-tk-ink-2">身份、场景、道具、光影、运镜、音频一次备包,整段共用,换镜不重备。</p>
          {excludedAssetItems.length > 0 ? (
            <div className="flex flex-col gap-1 rounded-md border border-dashed border-tk-border-1 px-3 py-2" data-testid="excluded-asset-restore">
              <span className="text-[11px] text-tk-ink-3">本场不带的资产（项目资产仍在，点恢复即回包）</span>
              <ul className="flex flex-col gap-0.5">
                {excludedAssetItems.map((item) => (
                  <li className="flex items-center gap-2 text-[11px] text-tk-ink-2" key={item.id}>
                    <span className="truncate">{item.name}</span>
                    <button
                      type="button"
                      className="ml-auto shrink-0 text-[11px] text-tk-ink-3 underline-offset-2 hover:text-tk-ink-1 hover:underline"
                      onClick={() => restoreExcludedAsset(item.id)}
                    >
                      恢复
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>

        {/* 中栏:段落结构(段落表)——本场镜头行可点选,与右栏逐镜区联动 */}
        <section className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="段落结构">
          <header className="flex items-center justify-between gap-2">
            <h2 className="text-section-title text-tk-ink-1">段落结构</h2>
            <span className="font-tkmono text-xs text-tk-ink-3">{shots.length} 镜</span>
          </header>
          {shotState.loading ? (
            <div className="flex flex-col gap-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          ) : shotState.error ? (
            <ErrorState message="镜头列表读取失败，请重试" onRetry={shotState.retry} />
          ) : shots.length === 0 ? (
            <p className="px-1 py-4 text-xs text-tk-ink-3">这场还没有镜头，回段落列表先排镜。</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {shots.map((shot) => {
                const selected = selectedShotId === shot.id;
                const regenOpen = regen?.shotId === shot.id;
                return (
                  <li key={shot.id}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-150",
                        selected ? "border-tk-border-2 bg-tk-hover" : "border-tk-border-1 bg-tk-elevated hover:border-tk-border-2",
                      )}
                      onClick={() => setSelectedShotId((current) => (current === shot.id ? null : shot.id))}
                    >
                      <span className="font-tkmono text-xs text-tk-ink-3">#{shot.shot_no}</span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <strong className="truncate text-xs font-semibold text-tk-ink-1">{shot.title?.trim() || `镜头 ${shot.shot_no}`}</strong>
                        {shot.script_text ? <span className="truncate text-[11px] text-tk-ink-3">{shot.script_text}</span> : null}
                      </div>
                      {shot.duration_seconds ? <span className="font-tkmono text-[11px] text-tk-ink-3">{shot.duration_seconds}s</span> : null}
                      <span className="text-[11px] text-tk-ink-2">{shotMediaStateLabel(shot)}</span>
                    </button>
                    {/* 局部重生成(页内交互,SPEC):每镜显式一次点击=一个任务;档未配置禁用并说明 */}
                    <div className="mt-1 flex justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<ArrowCounterClockwise />}
                        disabled={Boolean(regenSubmitting) || (!demoMode && !videoTier)}
                        title={!demoMode && !videoTier ? (tierFailed ? "视频档位未配置，稍后再试" : "正在读取档位") : undefined}
                        onClick={() => openRegen(shot.id)}
                      >
                        {shot.selected_video_result_id ? "重生成" : "生成"}
                      </Button>
                    </div>
                    {regenOpen ? (
                      <div className="mt-1 flex flex-col gap-2 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-2" aria-label={`镜头 #${shot.shot_no} 重生成确认`}>
                        {/* #151：这次出片条——与整段区同组件同口径。 */}
                        <ProjectStyleBar config={projectConfig} kind="video" tier={videoTier} skipped={skipProjectStyle} onToggleSkip={setSkipProjectStyle} />
                        {/* 提交真相条(块 3 欠件①接线,与整段区同组件同取数);
                            档位信息本区无别处显示,保留档价行。 */}
                        <ControlPackSubmitTruth options={packPartition.submitted} excluded={packPartition.excluded} byImage={false} />
                        {/* #164 G11:拿定稿生视频——已定稿的镜,定稿图由后端自动补进本次视频参考清单
                            (PRD 生产章 §10.1 下游一律默认用定稿),此处如实告知,不算控制包条目。 */}
                        {shot.selected_image_result_id ? (
                          <p className="text-[11px] leading-4 text-tk-ink-3" data-testid="final-image-auto-reference">本次自动带本镜定稿图作视频参考。</p>
                        ) : null}
                        {/* V-29 软引导:逐镜确认区同款(与整段区同口径,缺类点名不硬闸)。 */}
                        {missingLanes.length > 0 ? (
                          <p className="text-[11px] leading-4 text-warning" data-testid="prep-shortfall-note">还缺 {missingLanes.length} 类参考（{missingLaneLabels}），通过率会低。仍可生成。</p>
                        ) : null}
                        {videoTier ? (
                          <p className="text-[11px] leading-4 text-tk-ink-2">
                            档 {videoTier.tier_id}（{videoTier.price.points} 积分/{videoTier.price.unit === "per_second" ? "秒" : "张"}）· 确认即按正式报价扣费
                          </p>
                        ) : null}
                        {/* GENDOMAIN 余额感知:逐镜本单=档单价×时长;不够说真话。 */}
                        {videoTier && balancePoints !== null ? (
                          (() => {
                            const cost = videoTier.price.points * (shot.duration_seconds ?? (Number(videoTier.params.duration_seconds ?? 0) || 4));
                            const short = cost - balancePoints;
                            return short > 0 ? (
                              <p className="text-[11px] leading-4 text-danger" data-testid="credit-shortfall-line" role="alert">
                                本单 {cost} 积分 · 余额 {balancePoints} 积分 · 还差 {short} 积分，请充值或兑换邀请码后再试
                              </p>
                            ) : (
                              <p className="text-[11px] leading-4 text-tk-ink-3" data-testid="credit-awareness-line">本单 {cost} 积分 · 余额 {balancePoints} 积分</p>
                            );
                          })()
                        ) : null}
                        <p className="rounded-sm bg-tk-panel px-2 py-1 text-[11px] leading-4 text-tk-ink-3">{[packAutoSection, shotBasisText(shot)].filter((part) => part && !part.startsWith("还没有")).join("\n")}</p>
                        {regenReview ? <p className="text-[11px] text-warning" role="alert">这次生成超出复核阈值，请再确认一次费用。</p> : null}
                        {/* R223 定稿图没入库:说清后果 + 两条出路。实测对照见 R223——不入库
                            生出来的人物跟定稿图对不上,所以这里挡住而不是静默按纯文字生成。 */}
                        {finalImageBlocked ? (
                          <div
                            className="flex flex-col gap-1.5 rounded-sm border border-warning/60 bg-warning/10 px-2 py-1.5"
                            data-testid="unregistered-final-image-notice"
                            role="alert"
                          >
                            <p className="text-[11px] leading-4 text-tk-ink-1">{finalImageBlocked}</p>
                            <p className="text-[11px] leading-4 text-tk-ink-3">
                              在下方「图片」页签里点这张定稿图的「存进资产库」,存好再回来生成;人物就能跟定稿图对上。
                            </p>
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                data-testid="unregistered-final-image-dismiss"
                                onClick={() => setFinalImageBlocked("")}
                              >
                                先去存进资产库
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                loading={regenSubmitting}
                                data-testid="unregistered-final-image-proceed"
                                title="人物可能跟定稿图不是同一个人,仍然按现在这样生成"
                                onClick={() => {
                                  setFinalImageConfirmed(true);
                                  setFinalImageBlocked("");
                                }}
                              >
                                知道了,仍要继续生成
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        {finalImageConfirmed ? (
                          <p className="text-[11px] leading-4 text-warning" data-testid="unregistered-final-image-acknowledged" role="status">
                            已确认:定稿图没入库,这次生成的人物可能跟定稿图不是同一个人。
                          </p>
                        ) : null}
                        {regenError ? <p className="text-[11px] text-danger" role="alert">{regenError}</p> : null}
                        <div className="flex items-center justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => { setRegen(null); setRegenReview(false); setFinalImageBlocked(""); setFinalImageConfirmed(false); }}>取消</Button>
                          <Button
                            size="sm"
                            variant="primary"
                            loading={regenSubmitting}
                            disabled={Boolean(regenSubmitting) || (!demoMode && !videoTier)
                              || (videoTier !== null && balancePoints !== null && videoTier.price.points * (shot.duration_seconds ?? (Number(videoTier.params.duration_seconds ?? 0) || 4)) > balancePoints)}
                            title={videoTier && balancePoints !== null && videoTier.price.points * (shot.duration_seconds ?? (Number(videoTier.params.duration_seconds ?? 0) || 4)) > balancePoints
                              ? "积分不够：请充值或兑换邀请码后再试"
                              : "确认即按正式报价扣费生成；一次点击只创建一个任务"}
                            onClick={() => void submitRegen(shot)}
                          >
                            {regenReview ? "确认费用并生成" : "确认生成"}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {/* #164 G10/G11/G12:选中镜的产物落点——页签切换图片(选定稿,P-17a 语义)
                        与视频(播放/下载);与 P-04b 逐镜行「视频/图片」入口同义,不另开页面。 */}
                    {selected ? (
                      <div className="mt-1 flex flex-col gap-1">
                        <div className="flex items-center gap-1" role="group" aria-label={`镜头 #${shot.shot_no} 产物页签`}>
                          {([["image", "图片"], ["video", "视频"]] as const).map(([key, label]) => (
                            <button
                              key={key}
                              type="button"
                              aria-pressed={shotPanel === key}
                              data-testid={`shot-panel-tab-${key}`}
                              className={cn(
                                "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors duration-150",
                                shotPanel === key ? "border-tk-border-2 bg-tk-hover text-tk-ink-1" : "border-tk-border-1 text-tk-ink-3 hover:border-tk-border-2",
                              )}
                              onClick={() => setShotPanel(key)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        {shotPanel === "image" ? (
                          <ShotImageResults
                            shot={shot}
                            tasks={sceneVersions}
                            demoMode={demoMode}
                            notify={notify}
                            refreshKey={mediaTick}
                            onChanged={() => shotState.retry()}
                            onOpenBatch={(target) => setBatchImageShots([target])}
                          />
                        ) : (
                          /* G11/G12:页面内播放(storage_url 直显)+下载(走鉴权 download_url,
                             服务端代理我们自己的 TOS 存储)。 */
                          <ShotVideoResults shot={shot} demoMode={demoMode} notify={notify} refreshKey={mediaTick} />
                        )}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* 右栏:编译稿——两层(包级·自动+镜头结构·逐镜,R119) */}
        <aside className="flex flex-col gap-3 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="编译稿">
          <h2 className="text-section-title text-tk-ink-1">编译稿</h2>
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold text-tk-ink-2">包级 · 自动</h3>
            {packAutoSection ? (
              <p className="rounded-md bg-tk-elevated px-3 py-2 text-[11px] leading-4 text-tk-ink-2">{packAutoSection}</p>
            ) : (
              <p className="rounded-md bg-tk-elevated px-3 py-2 text-[11px] leading-4 text-tk-ink-2">控制包就位后，这里自动汇出整段共用的编译稿。</p>
            )}
            {packEntries.length > 0 ? (
              <ul className="flex flex-wrap gap-1" data-testid="pack-entry-chips">
                {packEntries.map(({ item, laneLabel }) => (
                  <li
                    className="flex items-center gap-1 rounded-sm border border-tk-border-1 bg-tk-elevated px-1 py-0.5"
                    key={item.id}
                    title={`${laneLabel} · ${item.name}`}
                  >
                    {item.thumbUrl ? (
                      <img alt={item.name} className="size-5 rounded-[2px] object-cover" src={item.thumbUrl} />
                    ) : null}
                    <span className="max-w-24 truncate text-[10px] text-tk-ink-3">{item.name}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-semibold text-tk-ink-2">镜头结构 · 逐镜</h3>
            {shots.length === 0 ? (
              <p className="rounded-md bg-tk-elevated px-3 py-2 text-[11px] leading-4 text-tk-ink-2">每个镜头的生成依据按镜列出，与控制包同版。</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {shots.map((shot) => (
                  <li
                    className={cn(
                      "rounded-md px-3 py-2 text-[11px] leading-4 transition-colors duration-150",
                      selectedShotId === shot.id ? "bg-tk-hover text-tk-ink-1" : "bg-tk-elevated text-tk-ink-3",
                    )}
                    key={shot.id}
                  >
                    {editingShotId === shot.id ? (
                      <div className="flex flex-col gap-2" data-testid={`shot-prompt-editor-${shot.shot_no}`}>
                        <Textarea
                          aria-label={`镜头 #${shot.shot_no} 视频提示词`}
                          rows={4}
                          value={editingText}
                          onChange={(event) => setEditingText(event.target.value)}
                        />
                        <div className="flex flex-wrap items-center gap-1.5">
                          {promptModels.length > 0 ? (
                            <Select
                              aria-label="AI 提示词模型"
                              className="h-7 w-auto px-1.5 text-[11px]"
                              value={promptModelKey}
                              onChange={(event) => setPromptModelKey(event.target.value)}
                            >
                              <option value="">默认模型</option>
                              {promptModels.map((model) => (
                                <option disabled={!model.available} key={model.key} value={model.key}>
                                  {model.displayName}{model.isDefault ? "（默认）" : ""}
                                </option>
                              ))}
                            </Select>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={promptAiBusy !== "" || demoMode}
                            loading={promptAiBusy === "draft"}
                            title={demoMode ? "演示态不连 AI 网关" : "按当前文本与控制包参考起草/优化，结果回填编辑框，确认后再保存"}
                            onClick={() => void runPromptAi("draft", shot)}
                          >
                            <Sparkle aria-hidden="true" className="size-3" />AI 起草/优化
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={promptAiBusy !== "" || demoMode || !editingText.trim()}
                            loading={promptAiBusy === "en"}
                            title={demoMode ? "演示态不连 AI 网关" : "把编辑框内容译成英文，回填后确认再保存"}
                            onClick={() => void runPromptAi("en", shot)}
                          >
                            <Translate aria-hidden="true" className="size-3" />中→英
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={promptAiBusy !== "" || demoMode || !editingText.trim()}
                            loading={promptAiBusy === "zh"}
                            title={demoMode ? "演示态不连 AI 网关" : "把编辑框内容译成中文，回填后确认再保存"}
                            onClick={() => void runPromptAi("zh", shot)}
                          >
                            <Translate aria-hidden="true" className="size-3" />英→中
                          </Button>
                        </div>
                        {promptAiError ? <p className="text-[11px] text-danger" role="alert">{promptAiError}</p> : null}
                        {promptSaveError ? <p className="text-[11px] text-danger" role="alert">{promptSaveError}</p> : null}
                        <div className="flex items-center justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setEditingShotId(null)}>取消</Button>
                          <Button size="sm" variant="primary" loading={promptSaving} disabled={promptSaving} onClick={() => void saveShotPrompt(shot)}>保存</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <strong className="font-tkmono text-tk-ink-2">#{shot.shot_no}</strong> {shotBasisText(shot)}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 text-[11px] text-tk-ink-3 underline-offset-2 hover:text-tk-ink-1 hover:underline"
                          data-testid={`edit-shot-prompt-${shot.shot_no}`}
                          onClick={() => startEditShotPrompt(shot)}
                        >
                          编辑
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      {pickLane ? (
        <AssetPickDrawer
          demoMode={demoMode}
          notify={notify}
          refs={refsState.data?.items ?? []}
          mode="browse"
          kind={laneDefs().find((def) => def.id === pickLane)?.kinds[0] ?? ""}
          onAdd={(asset) => addAssetToLane(pickLane, asset)}
          onRemove={(ref) => removeProjectRef(ref)}
          onClose={() => setPickLane(null)}
        />
      ) : null}

      {/* #164 G9:段级批量生图抽屉——清单=本场全部镜头(可移出),参考=控制包 submitted 层;
          提交成功=任务入队,genTick+1 接上本页 6s 轮询,顶栏任务队列同步可见。
          G10:清单=单镜时(图片面板「再出一批/换个说法重试」)换单镜视图,三段链不变。 */}
      {batchImageShots ? (
        <BatchGenerateDrawer
          projectId={projectId}
          episodeId={episodeId}
          episodeLabel={`段落·${sceneName}`}
          shots={batchImageShots}
          mediaKind="image"
          kindView={batchImageShots.length === 1 && batchImageShots[0] ? shotImageBatchView(batchImageShots[0]) : SEGMENT_IMAGE_BATCH_VIEW}
          referenceMediaIds={batchImageReferenceIds}
          demoMode={demoMode}
          notify={notify}
          shotName={segmentShotName}
          onClose={() => setBatchImageShots(null)}
          onCreated={() => {
            window.dispatchEvent(new Event("production-progress-changed"));
            setGenTick((tick) => tick + 1);
          }}
        />
      ) : null}
    </div>
  );
}


/* ---------- #164 G11/G12:镜头视频产物(页面播放+下载) ----------
   数据源=shot-media 全字段条目(ShotMediaItem);播放走 storage_url(TOS 直显),
   下载走 api.downloadMedia → /media/:id/download(鉴权代理我们自己的存储,
   不是厂商临时地址)。G10 选定稿界面=shot-image-results.tsx(P-17a 语义),
   两面板共用同一 shot-media 数据源与定稿署名口径。 */

/** 可播视频清单:只取有存储地址的视频条目;定稿优先,其余最新在前。 */
export function shotVideoPlaylist(items: ShotMediaItem[]): ShotMediaItem[] {
  return items
    .filter((item) => item.media_kind === "video" && typeof item.storage_url === "string" && item.storage_url.length > 0)
    .sort((a, b) => {
      if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      return String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
    });
}

/** 定稿署名(§10.3 要分得开,措辞与 P-17a 徽章同源):手选 vs 系统默认最新;历史版本不署名。 */
export function shotMediaSelectionLabel(item: ShotMediaItem): string | null {
  if (!item.is_primary) return null;
  return item.selection_source === "manual" ? "定稿 · 手选" : "定稿 · 默认(最新)";
}

function ShotVideoResults({ shot, demoMode, notify, refreshKey }: {
  shot: Shot;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  /** 在途任务全落终态的边沿由父层 +1,驱动本面板重拉(回片不用刷新页面)。 */
  refreshKey: number;
}): React.JSX.Element {
  const mediaState = useResource(
    () => api.shotMediaItems(shot.id),
    { items: [] as ShotMediaItem[], count: 0 },
    demoMode,
    [shot.id, refreshKey],
  );
  const videos = React.useMemo(() => shotVideoPlaylist(mediaState.data?.items ?? []), [mediaState.data]);
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  /* 换镜或清单刷新后回到首位(定稿优先),不悬空指已不在清单里的版本。 */
  React.useEffect(() => { setPlayingId(null); }, [shot.id, mediaState.data]);
  const playing = videos.find((item) => item.id === playingId) ?? videos[0] ?? null;

  async function download(item: ShotMediaItem): Promise<void> {
    if (downloadingId) return; // 一次一个,防连点重复拉流
    setDownloadingId(item.id);
    try {
      await api.downloadMedia(item.id);
    } catch (reason) {
      notify(businessErrorMessage(reason, "下载失败，请重试"), "error");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-2" aria-label={`镜头 #${shot.shot_no} 视频产物`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-tk-ink-2">本镜视频</span>
        {videos.length > 0 ? <span className="font-tkmono text-[10px] text-tk-ink-3">{videos.length} 版</span> : null}
      </div>
      {mediaState.loading ? (
        <Skeleton className="h-24 w-full" />
      ) : mediaState.error ? (
        <ErrorState message="视频产物读取失败，请重试" onRetry={mediaState.retry} />
      ) : videos.length === 0 ? (
        <p className="text-[11px] text-tk-ink-3">这镜还没有视频产物。点上方「生成」，确认报价后队列处理，回片后这里直接播。</p>
      ) : (
        <>
          {playing ? (
            <video
              key={playing.id}
              className="w-full rounded-md border border-tk-border-1 bg-black"
              controls
              preload="metadata"
              src={playing.storage_url ?? undefined}
            />
          ) : null}
          <ul className="flex flex-col gap-1">
            {videos.map((item, index) => {
              const selectionLabel = shotMediaSelectionLabel(item);
              const isPlaying = playing?.id === item.id;
              return (
                <li className="flex items-center gap-2 text-[11px] text-tk-ink-2" key={item.id}>
                  <button
                    type="button"
                    aria-pressed={isPlaying}
                    className={cn(
                      "shrink-0 font-tkmono underline-offset-2 hover:underline",
                      isPlaying ? "text-tk-ink-1" : "text-tk-ink-3",
                    )}
                    title={isPlaying ? "正在播放这一版" : "播放这一版"}
                    onClick={() => setPlayingId(item.id)}
                  >v{videos.length - index}</button>
                  {selectionLabel ? (
                    <span className="shrink-0 rounded-sm border border-tk-accent/40 bg-tk-accent-subtle px-1 py-0.5 text-[10px] text-tk-accent">{selectionLabel}</span>
                  ) : null}
                  <span className="truncate text-tk-ink-3">
                    {item.duration_seconds ? `${item.duration_seconds}s` : ""}{item.created_at ? ` · ${formatDateTime(item.created_at)}` : ""}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto shrink-0 text-xs"
                    icon={<DownloadSimple />}
                    loading={downloadingId === item.id}
                    disabled={downloadingId !== null}
                    title="下载到本地：服务端代理我们自己的存储，不是厂商临时地址"
                    onClick={() => void download(item)}
                  >下载</Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
