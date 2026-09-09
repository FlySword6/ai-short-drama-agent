/* ⚠️ 退役中(块 2,2026-08-03):镜级工作台已从路由摘除,本文件运行时不可达(bundle 树摇不进)。
   保留原因:40+ 测试文件的源码级功能合同仍锚着本页——功能随块 3 迁到段落工作台时逐合同改锚,
   全部迁完才物理归档(命名换代窗口)。禁止新增任何对本文件的 import。 */
import {
  ArrowClockwise,
  Camera,
  CheckCircle,
  Clock,
  Coins,
  CornersOut,
  DownloadSimple,
  FilmStrip,
  Flag,
  FlagCheckered,
  FolderPlus,
  GridFour,
  ImageSquare,
  Lightning,
  PencilSimple,
  Play,
  Sparkle,
  SpinnerGap,
  Translate,
  VideoCamera,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, api, type GenerationQuoteWithTier, type TieredGenerationSubmissionInput } from "../api";
import { newId } from "../uuid";
import {
  FALLBACK_IMAGE_TIER,
  FALLBACK_VIDEO_TIER,
  activeTiers,
  demoEstimatePoints,
  listCapabilityTiers,
  resolveSelectedTier,
  tierLabel,
  tierSubmitInput,
  type CapabilityTier,
} from "../capability-tiers";
import { businessErrorMessage } from "../error-copy";
import { rememberSelectedTierId } from "../tier-selection";
import { AssetMiniThumb, AssetPickDrawer, resolveAssetPrimaryMediaId, segmentedOptionClass } from "../components/asset-pick-drawer";
import { EditComposer } from "../components/edit-composer";
import { GridSplitModal } from "../components/grid-split-modal";
import { AssetChipsRow, MentionTextarea, mentionCandidatesFromRefs } from "../components/mention-input";
import { DEFAULT_PROMOTE_KIND, PromoteToAssetModal, promoteDefaultKind, promoteEntryState } from "../components/promote-asset-modal";
import { ReferenceList, type LaneAction } from "../components/reference-lanes";
import {
  IMAGE_PRESET_GROUPS,
  applyPresetPrompt,
  findImagePreset,
  imageGenerationParameters,
  presetBadgeLabel,
  presetRatioNote,
  presetsInGroup,
  togglePresetSelection,
  type ImagePreset,
} from "../image-presets";
import {
  resolveDimensionPick,
  type GenerationDimensionKey,
  type GenerationDimensionValue,
} from "../generation-dimensions";
import {
  IMAGE_CHIPS,
  IMAGE_EDIT_FEATURES,
  VIDEO_CHIPS,
  VIDEO_EDIT_FEATURES,
  VIDEO_MODES,
} from "../gen-node-capability";
import { AutoValidateSwitch, GenNodeChips, GenNodeEditBar, VideoModeSelector } from "../components/gen-node-features";
import { TierDimensionPopovers } from "../components/gen-params-popover";
import {
  shotTitleCommit,
  taskStateForShot,
  timelineCardTitle,
  type ShotTaskState,
} from "../components/version-modal";
import { demoProjectAssets, demoShotMedia, demoShots } from "../demo";
import {
  forgetGenerationRequest,
  recoverGenerationTask,
  rememberGenerationRequest,
} from "../generation-task-recovery";
import { formatCost, formatQuoteExpiry, quoteIsExpired } from "../generation-quotes";
import { navigate } from "../routing";
import { NextPendingShotEntry, useProductionShotRecords } from "../production-stepper";
import { appendMentionAtCaret } from "../prompt-mentions";
import {
  attachLaneItem,
  detachLaneItem,
  emptyLanesState,
  laneDef,
  loadLanesState,
  saveLanesState,
  seedLanesFromRefs,
  upsertCameraNote,
  type LaneItem,
  type LanesState,
  type ReferenceLaneId,
  type WorkshopId,
} from "../reference-lanes";
import { hasLane, laneEntry } from "../lane-vocabulary";
import { partitionControlPack, refAsset } from "../control-pack";
import { ControlPackSubmitTruth } from "../components/control-pack-truth";
import { formatReadyMark, loadReadyMark, saveReadyMark, type ReadyMark } from "../shot-ready";
import { autosaveDirty, SAVED_FADE_MS, serverPromptTrio } from "../workbench-autosave";
import { splicePromptSections, splitSavedPromptSections } from "../prompt-sections";
import {
  inflightLaneTaskCount,
  laneTaskCardsForLane,
  laneTaskEstimatedDurationText,
  laneTaskIsActive,
  laneTaskQueuePositionText,
  loadLaneTaskRecords,
  registerLaneTask,
  unregisterLaneTask,
  type LaneTaskRecord,
} from "../lane-generation-tracker";

/** 3D 导演台独立分包：three/R3F 依赖链只在进入「3D 导演台」页签时按需加载（与 app.tsx 路由挂法同一 chunk）。 */
const DirectorWorkspaceLazy = lazy(() =>
  import("../components/director").then((module) => ({ default: module.DirectorWorkspace })),
);

/** 音色浏览独立分包（进「音频」页签才加载；S44 起数据来自音色词表 API，不再带 fixture）。 */
const TimbreBrowserLazy = lazy(() =>
  import("../components/timbre-browser").then((module) => ({ default: module.TimbreBrowser })),
);
import type {
  Asset,
  GenerationMediaKind,
  GenerationTask,
  MediaResult,
  MediaVersion,
  ProjectAssetRef,
  Shot,
} from "../types";
import {
  assetKindLabel,
  assetName,
  formatDateTime,
  useResource,
} from "../ui";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { CapabilityStatusBar } from "../components/capability-status";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Badge,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Skeleton,
  Textarea,
  Tooltip,
} from "../components/ui/primitives";
import type { PageRuntimeProps } from "./global-pages";
import { canCreateInProject } from "../operations";
import { capabilityGate, platformRoleForCopy } from "../capabilities-state";
import { CapabilityActionSlot } from "../components/capability-notice";

type QuoteFlowStatus = "ready" | "confirming" | "submitting" | "failed" | "expired";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PendingGenerationQuote {
  quote: GenerationQuoteWithTier;
  mediaKind: GenerationMediaKind;
  operation: "submit" | "retry";
  input?: TieredGenerationSubmissionInput;
  requestId?: string;
  retryIdempotencyKey?: string;
  status: QuoteFlowStatus;
  error?: string;
}

/**
 * 「去工作台查看」目标参考组的短暂高亮样式（S8 衔接流）：按组卡 data-lane
 * 属性定位（reference-lanes.tsx 的 LaneCard section data-lane=组 id,
 * S24-D 起不再依赖中文 aria-label）,配合容器上的
 * [&_section]:transition-colors，2s 后高亮消退有过渡而不是硬跳。
 */
const LANE_FLASH_CLASS: Record<ReferenceLaneId, string> = {
  character: "[&_section[data-lane=character]]:border-accent [&_section[data-lane=character]]:bg-accent-subtle",
  scene: "[&_section[data-lane=scene]]:border-accent [&_section[data-lane=scene]]:bg-accent-subtle",
  prop: "[&_section[data-lane=prop]]:border-accent [&_section[data-lane=prop]]:bg-accent-subtle",
  lighting: "[&_section[data-lane=lighting]]:border-accent [&_section[data-lane=lighting]]:bg-accent-subtle",
  camera_motion: "[&_section[data-lane=camera_motion]]:border-accent [&_section[data-lane=camera_motion]]:bg-accent-subtle",
  reference_video: "[&_section[data-lane=reference_video]]:border-accent [&_section[data-lane=reference_video]]:bg-accent-subtle",
  audio: "[&_section[data-lane=audio]]:border-accent [&_section[data-lane=audio]]:bg-accent-subtle",
};

/* S9-19 槽位感知过滤已随 S24-C 词表化：「从资产库选」的资产类型过滤读
   词表词条 pickKind（020 入库），不再有写死的 LANE_PICK_KIND 映射。 */

export function WorkbenchPage({
  projectId,
  episodeId,
  shotId,
  demoMode,
  notify,
  user,
  capabilities,
}: PageRuntimeProps & { projectId: string; episodeId: string; shotId: string }): React.JSX.Element {
  /* S12-1：viewer 看不到创作按钮（生成类动作全部隐藏只读）；显隐唯一判据=capabilities。
     四值闸门：只有 denied 才是「你不能创作」，读取中/读不到由按钮位自己交代。 */
  const createGate = capabilityGate(capabilities, (caps) => canCreateInProject(caps, projectId));
  const canCreate = createGate === "allowed";
  const fallbackShot = demoShots.find((item) => item.id === shotId) ?? demoShots[0]!;
  const shotState = useResource(() => api.shot(shotId), fallbackShot, demoMode, [shotId]);
  const assetState = useResource(() => api.projectAssets(projectId), { items: demoProjectAssets, count: demoProjectAssets.length }, demoMode, [projectId]);
  /* K2U D-14：demo 媒体 fallback 与生产页同源(demoShotMedia,K2A 真源表)——视频库/舞台/「整集连播」入口
     在 demo 下读到同一份 5 镜可播+1 镜缺口,不再是 0 版本空态。 */
  const mediaState = useResource(() => api.shotMedia(shotId), { items: demoShotMedia[shotId] ?? [], count: (demoShotMedia[shotId] ?? []).length }, demoMode, [shotId]);
  /* W9 遗留的「整集分镜上提到页面级」已删：消费方都自己取数且更全——
     「去下一个待生成分镜」的判定由 inferProductionProgress 收敛（跨集扫描
     episodes×shots×media）：列表页由 ProductionStepper 承接，S78 起工作台内
     由 WorkbenchNextPending 承接（同一 useProductionShotRecords hook 取数），
     整集时间线由 EpisodeTimeline 自取本集。
     页面级这一份自 W9 链落地（b385fff）起就没被读过,只是每次进工作台多打一次 GET /shots。 */
  const [scriptText, setScriptText] = useState("");
  /* GP-12 两段式提示词（剧本步 6）：自动段=系统预填（只读），补充段=用户手输（可编辑）。
     imagePrompt/videoPrompt 仍是提交与自动保存的唯一全文口径（两段拼接，见 prompt-sections.ts），
     下游（autosave/submit/估价占位）读法零改；编辑入口只写补充段，系统段只能由预填动作整体重写。 */
  const [imageAutoPrompt, setImageAutoPrompt] = useState("");
  const [imageSupplement, setImageSupplement] = useState("");
  const [videoAutoPrompt, setVideoAutoPrompt] = useState("");
  const [videoSupplement, setVideoSupplement] = useState("");
  const imagePrompt = splicePromptSections(imageAutoPrompt, imageSupplement);
  const videoPrompt = splicePromptSections(videoAutoPrompt, videoSupplement);
  // W5.5：任务态按分镜隔离——shotTasks.shotId 标记任务归属分镜；
  // 路由切分镜（组件不重挂载）时旧分镜的任务立即不可见，恢复 effect 再重建当前分镜任务。
  const [shotTasks, setShotTasks] = useState<ShotTaskState>({ shotId, imageTask: null, videoTask: null });
  const imageTask = shotTasks.shotId === shotId ? shotTasks.imageTask : null;
  const videoTask = shotTasks.shotId === shotId ? shotTasks.videoTask : null;
  const setImageTask = useCallback((task: GenerationTask) => {
    setShotTasks((prev) => ({ ...prev, imageTask: task }));
  }, []);
  const setVideoTask = useCallback((task: GenerationTask) => {
    setShotTasks((prev) => ({ ...prev, videoTask: task }));
  }, []);
  const [submitting, setSubmitting] = useState<"image" | "video" | "">("");
  const [pendingQuote, setPendingQuote] = useState<PendingGenerationQuote | null>(null);
  /* K-goal-04 条 4：生成确认抽屉退场——点生成图标直接提交（防手滑=submitting 闸门+按钮即禁），
     确认抽屉原 confirmKind 态一并退役。 */
  const [mode, setMode] = useState<"image" | "video">("image");
  const [generationError, setGenerationError] = useState("");
  const [showLibrary, setShowLibrary] = useState(new URLSearchParams(window.location.search).get("library") === "1");
  const [promptSaveState, setPromptSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  // W5-1：生成图一键入资产库（转为参考资产）弹窗开关
  const [promoteOpen, setPromoteOpen] = useState(false);
  // W6-1：生图预设模板选中态；presetBackupRef 记录选中前的草稿，取消选中时恢复
  const [imagePresetId, setImagePresetId] = useState<string | null>(null);
  const presetBackupRef = useRef<string | null>(null);
  // S59：模板卡从确认抽屉迁到工作台提示词区上方，默认折叠，展开才铺卡片
  const [showImageTemplates, setShowImageTemplates] = useState(false);
  /* S5-2 档位形态（合同 model-capability-and-price-tiers §4）：参数行数据源=capability-tiers
     接口;单档时固定标签（带档价）+「更多档位即将开放」不可点;多档时整档切换,切档实时刷新估价。
     D3 的本地自由拼参数控件全部下线——档外组合界面不给选（「界面可调、后端不认」是假可用）。
     裁决 4：接口已上线,404/501 静默回落本地档退役——加载失败走错误态如实显示+重试;
     接口返回空数组=「档位未配置」错误（报 Sol）;demo 模式仍走初始档 fixture。 */
  const [tierState, setTierState] = useState<{ kind: "image" | "video"; tiers: CapabilityTier[] } | null>(null);
  const [tierError, setTierError] = useState<{ kind: "image" | "video"; message: string } | null>(null);
  const [tierRevision, setTierRevision] = useState(0);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  // W6-2：宫格切分弹窗当前处理的图片产物（null=关闭）
  const [gridMedia, setGridMedia] = useState<MediaResult | null>(null);
  // W5.5：分镜内联改名 / 台内资产抽屉
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState("");
  const renameBlurSkip = useRef(false);
  /* S9-19：资产抽屉两模式分化——match=「匹配 + 选择资产」候选流；
     browse=「从资产库选」浏览选择器，kind 带槽位类型锁定（角色槽只列角色）。 */
  const [assetDrawer, setAssetDrawer] = useState<{ mode: "match" | "browse"; kind: string } | null>(null);
  // W9-C 布局纪律：沉浸模式只留舞台+提示词；版本预览走缩略图轨道点击（不改主版本）。
  // K-goal-04 条 3:「调整」参数与版本抽屉退场(档位=底条维度 popover,视频库=成功态卡入口)。
  const [focusMode, setFocusMode] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  useEffect(() => { setPreviewId(null); }, [shotId]);
  // W9-C：EDIT 组装台的基线视频（版本库「基于此版本编辑」入口）
  const [editBase, setEditBase] = useState<MediaResult | null>(null);
  /* S66：libTV 三段式节点卡——视频生成卡模式选择（null=跟随链路默认：有确认图=按图生成，
     无确认图=全能参考）；画布容器 ref（全屏锚 + 截帧从这里取 video 元素）；
     编辑条「下载」进行态（防连点）。 */
  const [videoModeChoice, setVideoModeChoice] = useState<"omni" | "i2v" | null>(null);
  const stageCardRef = useRef<HTMLDivElement | null>(null);
  const [stageDownloading, setStageDownloading] = useState(false);
  /* S2（DC 去黑话改版）：工作台=五个普通页签「控制包 | 图片 | 视频 | 音频 | 3D 导演台」。
     首页放文字描述（左栏）、参考清单、生成按钮区；四个功能页是一级页签，标签直达。
     S46 C-6：首页页签原名「工作台」与页面自嵌套，改「控制包」（= S9-17 参考控制包）。 */
  const [tab, setTab] = useState<"home" | WorkshopId>("home");
  /** 本次生成归入的参考组（从组卡片点「去X页」带出的上下文；null=快速通道不归组）。 */
  const [attachTarget, setAttachTarget] = useState<ReferenceLaneId | null>(null);
  /** 参考视频组「快抽运镜小样」档位（模型分档等 Sol，UI 先降级明示）。 */
  const [quickDraft, setQuickDraft] = useState(false);
  const [lanesState, setLanesState] = useState<LanesState>(() => emptyLanesState());
  /* K2K（GP-13）：lanesState 的同步可读镜像——attachItemToLane 要在 setState 前算出
     「这次到底归入没有」，不能再在 updater 里设副作用标志位（React 19 updater 只在
     渲染期执行，同步读恒 false，toast/notify 系统性撒谎）。 */
  const lanesStateRef = useRef(lanesState);
  useEffect(() => { lanesStateRef.current = lanesState; }, [lanesState]);
  /** S16 条 2：参考栏任务跟踪——提交时注册(requestId→参考组)，状态轮询进 laneTaskStates。 */
  const [laneTaskRecords, setLaneTaskRecords] = useState<readonly LaneTaskRecord[]>([]);
  const [laneTaskStates, setLaneTaskStates] = useState<Record<string, GenerationTask>>({});
  /** 已挂回 media id 台账：防止轮询重渲染重复挂回/重复通知。 */
  const attachedMediaRef = useRef<Set<string>>(new Set());
  /** 条 4②：本会话提交生成时的 prompt 快照（kind+requestId 键控）——「转为参考资产」简介只取
      本产物的提示词；历史产物/恢复的任务接口不回传 prompt（已报 Fable），预填空不串台。 */
  const lastSubmittedPromptRef = useRef<{ kind: GenerationMediaKind; requestId: string; prompt: string } | null>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  /* S2b-4：「就绪」是人工判断——一次点击标记、记人记时、可撤销（本地存储降级，后端字段等 Sol）。 */
  const [readyMark, setReadyMark] = useState<ReadyMark | null>(null);
  /* S3：3D 导演台页签内嵌——全屏覆盖态 + 导出归组提示（可点「去工作台查看」回首页并高亮目标组）。 */
  const [directorFull, setDirectorFull] = useState(false);
  const [laneToast, setLaneToast] = useState<{ text: string; lane: ReferenceLaneId } | null>(null);
  /** 「去工作台查看」后目标参考组的短暂高亮（~2s 强调，S8 衔接流） */
  const [laneFlash, setLaneFlash] = useState<ReferenceLaneId | null>(null);
  const laneFlashTimer = useRef(0);
  const shot = shotState.data;
  const shotLoadedId = shot?.id;
  const { setData: setShotData } = shotState;

  const acceptGenerationTask = useCallback((kind: GenerationMediaKind, task: GenerationTask) => {
    setGenerationTask(kind, task, setImageTask, setVideoTask);
    if (!demoMode) {
      try {
        rememberGenerationRequest(
          window.sessionStorage,
          projectId,
          shotId,
          kind,
          task.generation_request_id,
        );
      } catch {
        setGenerationError("任务已提交，但浏览器未能保存恢复信息。请暂时不要关闭当前页面。");
      }
    }
  }, [demoMode, projectId, shotId, setImageTask, setVideoTask]);

  useEffect(() => {
    if (!shot) return;
    setScriptText(shot.script_text || "");
    /* GP-12：已存提示词按「同源重算的系统预填」找分界——前缀命中则前=自动段、余=补充段；
       对不上（旧单框改过半截/参考未载齐）如实整段作自动段+空白补充段，不猜切点。 */
    const refsNow = assetState.data?.items ?? [];
    const imageSections = splitSavedPromptSections(shot.image_prompt || "", buildImagePrompt(shot, refsNow));
    const videoSections = splitSavedPromptSections(shot.video_prompt || "", buildVideoPrompt(shot, refsNow));
    setImageAutoPrompt(imageSections.auto);
    setImageSupplement(imageSections.supplement);
    setVideoAutoPrompt(videoSections.auto);
    setVideoSupplement(videoSections.supplement);
    setPromptSaveState("idle");
    setRenaming(false);
    setRenameError("");
    // 图片已选定时默认进入视频模式（PNG 24：图片生成视频工作台）
    setMode(shot.selected_image_result_id ? "video" : "image");
    // 只在切换到另一个分镜时重置输入，避免自动保存回包覆盖正在输入的内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotLoadedId]);

  // 提示词与分镜内容防抖自动保存到分镜（PATCH /shots/:shot_id）。
  // S16 条 1：dirty 判定走 trim 语义（后端 nullableText 一律 trim 存储）——
  // 原样比较时尾随换行会造成"保存→回包已 trim→仍 dirty→再保存"死循环（实测 18s 12 次相同 PATCH）。
  useEffect(() => {
    if (demoMode || !shot) return;
    if (!autosaveDirty({ script: scriptText, image: imagePrompt, video: videoPrompt }, serverPromptTrio(shot))) return;
    const timer = window.setTimeout(() => {
      setPromptSaveState("saving");
      api.updateShot(shot.id, { script_text: scriptText, image_prompt: imagePrompt, video_prompt: videoPrompt })
        .then((next) => {
          setShotData(next);
          setPromptSaveState("saved");
        })
        .catch(() => setPromptSaveState("failed"));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [demoMode, scriptText, imagePrompt, videoPrompt, shot, setShotData]);

  // 「已保存」出现一次后淡出（S16 条 1：不常驻、不闪烁；再次变更时按新一次保存重新亮起）。
  useEffect(() => {
    if (promptSaveState !== "saved") return;
    const timer = window.setTimeout(() => setPromptSaveState("idle"), SAVED_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [promptSaveState]);

  const onPollingLost = useCallback(() => {
    setGenerationError("连续多次查询任务状态失败，可能已断网。任务仍在服务端执行，网络恢复后会自动更新，也可以刷新页面重新查询。");
  }, []);

  useEffect(() => {
    // W5.5：先按分镜隔离任务与派生态（切分镜不残留上一分镜的"生成中"/报价卡），再恢复当前分镜的任务。
    setShotTasks((prev) => taskStateForShot(prev, shotId));
    setSubmitting("");
    setPendingQuote(null);
    setGenerationError("");
    // W6-1：切分镜不残留上一分镜的模板选中态与草稿备份。
    setImagePresetId(null);
    presetBackupRef.current = null;
    if (demoMode) return;
    let active = true;
    const restore = async (kind: GenerationMediaKind): Promise<void> => {
      try {
        const task = await recoverGenerationTask(
          window.sessionStorage,
          projectId,
          shotId,
          kind,
          (requestId) => api.generation(requestId),
        );
        if (active && task) {
          setShotTasks((prev) => taskStateForShot(prev, shotId, kind === "image" ? { imageTask: task } : { videoTask: task }));
        }
      } catch (reason) {
        if (reason instanceof ApiClientError && [403, 404].includes(reason.status)) {
          forgetGenerationRequest(window.sessionStorage, projectId, shotId, kind);
          return;
        }
        if (active) {
          setGenerationError(`未能恢复${kind === "image" ? "图片" : "视频"}任务：${businessErrorMessage(reason, "请刷新页面重试")}`);
        }
      }
    };
    void Promise.all([restore("image"), restore("video")]);
    return () => { active = false; };
  }, [demoMode, projectId, shotId]);

  useTaskPolling(imageTask, setImageTask, demoMode, onPollingLost);
  useTaskPolling(videoTask, setVideoTask, demoMode, onPollingLost);

  useEffect(() => {
    if (imageTask?.status === "succeeded" || videoTask?.status === "succeeded") {
      window.dispatchEvent(new Event("production-progress-changed"));
    }
  }, [imageTask?.status, videoTask?.status]);

  /* ---------- S2：参考清单状态（资产实时分桶 + 本机归入记录合并） ---------- */
  useEffect(() => {
    setLanesState(loadLanesState(window.localStorage, shotId, seedLanesFromRefs(assetState.data?.items ?? [])));
  }, [shotId, assetState.data]);

  /* ---------- S16 条 2：参考栏生成任务跟踪 ----------
     注册表=localStorage（按 shot）；状态=GET /generations/:id 轮询；
     页面可见时 6s 一拍，标签页隐藏暂停（document.hidden 跳过+visibilitychange 恢复即查）；
     终态任务不再轮询（卡片保留：完成=预览+归入 / 失败=人话+重试）。 */
  useEffect(() => {
    if (demoMode) { setLaneTaskRecords([]); setLaneTaskStates({}); return; }
    setLaneTaskRecords(loadLaneTaskRecords(window.localStorage, shotId));
    setLaneTaskStates({});
  }, [demoMode, shotId]);

  const laneTaskStatesRef = useRef<Record<string, GenerationTask>>({});
  useEffect(() => { laneTaskStatesRef.current = laneTaskStates; }, [laneTaskStates]);

  useEffect(() => {
    if (demoMode || laneTaskRecords.length === 0) return;
    let active = true;
    const tick = async (): Promise<void> => {
      if (document.hidden) return;
      const pendingRecords = laneTaskRecords.filter((record) => {
        const known = laneTaskStatesRef.current[record.requestId];
        return !known || laneTaskIsActive(known.status);
      });
      if (pendingRecords.length === 0) return;
      const results = await Promise.allSettled(pendingRecords.map((record) => api.generation(record.requestId)));
      if (!active) return;
      const vanished: string[] = [];
      setLaneTaskStates((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          const requestId = pendingRecords[index]!.requestId;
          if (result.status === "fulfilled") { next[requestId] = result.value; return; }
          // 404/403=任务已不可见（环境重置/越权）——从台账摘除，不展示永远的假「生成中」
          if (result.reason instanceof ApiClientError && [403, 404].includes(result.reason.status)) vanished.push(requestId);
        });
        return next;
      });
      if (vanished.length > 0) {
        let records = laneTaskRecords;
        for (const requestId of vanished) records = unregisterLaneTask(window.localStorage, shotId, requestId);
        setLaneTaskRecords(records);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 6000);
    const onVisibility = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [demoMode, laneTaskRecords, shotId]);

  /** 各栏任务卡（lane id → 卡片模型，注册表顺序=最新在前）。 */
  const laneTaskCards = useMemo(() => {
    const map: Record<string, ReturnType<typeof laneTaskCardsForLane>> = {};
    for (const record of laneTaskRecords) {
      if (!record.lane) continue;
      (map[record.lane] ??= []).push(...laneTaskCardsForLane(record.lane, [record], laneTaskStates));
    }
    return map;
  }, [laneTaskRecords, laneTaskStates]);

  /** 就绪联动：全栏进行中的任务数（非阻断提示；就绪是人工判断——合同铁律只提示不拦）。 */
  const laneInflightCount = useMemo(() => inflightLaneTaskCount(laneTaskRecords, laneTaskStates), [laneTaskRecords, laneTaskStates]);

  /** 任务成功后「归入本栏」：复用既有归入机制（attachLaneItem+本机台账），归入后摘除任务记录。 */
  function attachLaneTaskResult(lane: ReferenceLaneId, requestId: string): void {
    const task = laneTaskStates[requestId];
    const record = laneTaskRecords.find((item) => item.requestId === requestId);
    if (!task || !record) return;
    const media = task.media_results?.find((item) => item.media_kind === record.kind) ?? task.media_results?.[0];
    if (!media) return;
    attachedMediaRef.current.add(media.id);
    const attached = attachItemToLane(lane, {
      id: `workshop:${media.id}`,
      name: `${shot?.title || "粗剪素材"} · ${record.kind === "image" ? "图片" : "视频"}产出`,
      kind: record.kind,
      thumbUrl: media.thumbnail_url || media.storage_url || undefined,
      origin: "workshop",
    });
    notify(attached ? `已归入「${laneDef(lane).label}」组` : `当前结果已在「${laneDef(lane).label}」组`, attached ? "success" : "info");
    setLaneTaskRecords(unregisterLaneTask(window.localStorage, shotId, requestId));
  }

  /** 失败任务重试（条 3：outcome-unknown 同入口）——同样一次点击一个新任务，原样重试。 */
  async function retryLaneTask(kind: GenerationMediaKind, requestId: string): Promise<void> {
    if (demoMode) return;
    setGenerationError("");
    try {
      const quote = await api.quoteGenerationRetry(requestId);
      const pending: PendingGenerationQuote = {
        quote,
        mediaKind: kind,
        operation: "retry",
        requestId,
        retryIdempotencyKey: `retry-${requestId}-${newId()}`,
        status: quoteIsExpired(quote) ? "expired" : "ready",
      };
      if (quote.requires_manual_review === true) {
        setPendingQuote(pending);
        return;
      }
      await settleQuote(pending);
    } catch (reason) {
      setGenerationError(businessErrorMessage(reason, "重试提交失败，请稍后再试"));
    }
  }

  /* ---------- S9-17：提交参考集取数源 = 工作台参考控制包（参考清单六组 lanesState） ----------
     已匹配资产只是候选池；发给模型的参考必须与工作台参考车道同源（界面所见 = submit 所发）。
     K2K（GP-11+GP-16）：分层取数——随提交 submitted + 不随提交 excluded（逐项+原因）;
     K-goal-04 条 4：两层真相挪到主界面常驻（生成卡真相条 + 车道条目弱显徽标），确认抽屉退场。 */
  const controlPackPartition = useMemo(
    () => partitionControlPack(lanesState, assetState.data?.items ?? []),
    [lanesState, assetState.data],
  );
  const controlPackOptions = controlPackPartition.submitted;
  const controlPackExcluded = controlPackPartition.excluded;
  /** 车道条目「不随提交」弱显徽标取数（itemId → 人话原因，与生成卡真相条同一数据源）。 */
  const controlPackExcludedReasons = useMemo(
    () => new Map(controlPackExcluded.map((item) => [item.itemId, item.reason])),
    [controlPackExcluded],
  );

  /* 导演台全屏切换：通知嵌入的 three 视口按新尺寸重钉高度。 */
  useEffect(() => {
    window.dispatchEvent(new Event("resize"));
  }, [directorFull]);

  /* 参考组高亮计时器：卸载时清理（goToLaneOnHome 里每次重启） */
  useEffect(() => () => window.clearTimeout(laneFlashTimer.current), []);

  /* S5-2 档位拉取：切媒体页拉一次（合同 §3 登录即可读）;
     选中档决定提交/估价参数（tierSubmitInput）与 tier_id,切档实时刷新估价。
     裁决 4：失败不回落本地档——tierError 进参数行错误态,「重新读取」重拉。 */
  const tierKind: "image" | "video" = tab === "video" ? "video" : "image";
  useEffect(() => {
    if (tab !== "image" && tab !== "video") return;
    let cancelled = false;
    setTierError(null);
    listCapabilityTiers(tierKind, demoMode)
      .then((result) => { if (!cancelled) setTierState({ kind: tierKind, tiers: result.tiers }); })
      .catch((reason) => {
        if (cancelled) return;
        setTierState(null);
        setTierError({ kind: tierKind, message: businessErrorMessage(reason, "生成档位读取失败") });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, demoMode, tierRevision]);
  const tiersLoading = tab === "image" || tab === "video" ? (tierState?.kind !== tierKind && tierError?.kind !== tierKind) : false;
  const tiers = tierState?.kind === tierKind ? tierState.tiers : [];
  const selectedTier = resolveSelectedTier(tiers, selectedTierId);
  const tierInput = useMemo(() => (selectedTier ? tierSubmitInput(selectedTier) : null), [selectedTier]);
  /* K2S 返工（demo 批量随档,「同镜同档同价」）：demo 模式下把当前选中档 id 记入会话存储,
     批量清单抽屉（板03）按它解析同一档取价——与单镜同一函数 demoEstimatePoints 同一档。
     只写 id、只服务 demo；本页估价/提交逻辑零改动,真栈批量按服务端报价不读该记录。 */
  useEffect(() => {
    if (!demoMode || !selectedTier) return;
    rememberSelectedTierId(window.sessionStorage, tierKind, selectedTier.tier_id);
  }, [demoMode, selectedTier, tierKind]);
  /* S59 + G06/G07 回归吸收：选中模板的设计画幅 ≠ 当前档画幅时在模板区明示变形;
     S66 + V-07:ratio 在值域内时 toggleImagePreset 已按维度反查切档,走到这里的
     不一致只剩「查无档」——必须明示,不能静默按档画幅出宫格图。 */
  const imageTierRatio = selectedTier && typeof selectedTier.params.aspect_ratio === "string" ? selectedTier.params.aspect_ratio : null;
  const imagePresetRatioNote = presetRatioNote(findImagePreset(imagePresetId), imageTierRatio);
  /* S73 + V-07:模板卡副标值域——active 档画幅集合;档位未就绪/读取失败时给 null,
     副标保持中性「预填提示词」,不在不知道值域时断言「无档」。 */
  const imageTierRatioSet = useMemo(() => {
    if (tiers.length === 0) return null;
    return new Set(
      activeTiers(tiers)
        .map((tier) => tier.params.aspect_ratio)
        .filter((ratio): ratio is string => typeof ratio === "string"),
    );
  }, [tiers]);

  /* S3：生成卡底条 ⚡ 实时估价（切档跟着变；红线不动：这里只是「预计」，
     点生成仍走报价→人工确认→创建）。估价请求与提交同链带 tier_id。
     S66：改走 simpleEstimate（无项目上下文、不创建报价行，body 只带
     media_kind/tier_id/parameters/quantity）——不再为页面估价造占位 quote;
     「接口拒绝→UI 如实置灰」：失败带服务方原因 + 重试,发送键禁用。 */
  const [estimate, setEstimate] = useState<{ state: "idle" | "loading" | "ready" | "error"; text: string }>({ state: "idle", text: "" });
  const [estimateRevision, setEstimateRevision] = useState(0);
  useEffect(() => {
    if (tab !== "image" && tab !== "video") return;
    const mediaKind = tab === "video" ? ("video" as const) : ("image" as const);
    if (demoMode) {
      // 离线示例：按当前选中档档价如实推导（S83/V-36：从写死初始档改为随切档刷新;
      // 档位未就绪时回落初始档,与 demo 档表首档同口径）
      const demoTier = selectedTier ?? (mediaKind === "image" ? FALLBACK_IMAGE_TIER : FALLBACK_VIDEO_TIER);
      setEstimate({ state: "ready", text: `预计 ${formatCost(demoEstimatePoints(demoTier))}` });
      return;
    }
    if (!tierInput || !selectedTier) return;
    const { parameters, quantity } = tierInput;
    let cancelled = false;
    setEstimate({ state: "loading", text: "估价中…" });
    const timer = window.setTimeout(() => {
      api.simpleEstimate({ media_kind: mediaKind, tier_id: selectedTier.tier_id, parameters, quantity })
        .then((result) => { if (!cancelled) setEstimate({ state: "ready", text: `预计 ${formatCost(result.estimated_cost_fen)}` }); })
        .catch((reason: unknown) => { if (!cancelled) setEstimate({ state: "error", text: businessErrorMessage(reason, "估价暂不可用，生成前还会再估") }); });
    }, 500);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, demoMode, tierInput, estimateRevision]);

  /* 切粗剪素材：回工作台首页、重读就绪标记（工作台上下文按素材隔离）。 */
  useEffect(() => {
    setTab("home");
    setAttachTarget(null);
    setQuickDraft(false);
    setReadyMark(loadReadyMark(window.localStorage, shotId));
  }, [shotId]);

  function commitLanes(next: LanesState): void {
    setLanesState(next);
    saveLanesState(window.localStorage, shotId, next);
  }

  /** 条目归入目标参考组；已存在返回 false（幂等，不重复通知）。
      K2K（GP-13）：归入结果在 setState 前同步算出——先算 next（attachLaneItem 纯函数，
      同 id 返回原 state 引用=已存在），再落账再 setState；ref 同步跟进，连续两次归入
      第二次能读到第一次的结果。toast/notify 从此说真话：真归入才说「已归入」。 */
  function attachItemToLane(lane: ReferenceLaneId, item: LaneItem): boolean {
    const current = lanesStateRef.current;
    const next = attachLaneItem(current, lane, item);
    if (next === current) return false;
    saveLanesState(window.localStorage, shotId, next);
    lanesStateRef.current = next;
    setLanesState(next);
    return true;
  }

  /* 生成任务成功 → 产出自动归入发起组（参考清单→功能页→产出归组→回工作台 回路的核心一环）。 */
  useEffect(() => {
    if (!attachTarget) return;
    const def = laneDef(attachTarget);
    const kind = def.workshop === "image" ? "image" : def.workshop === "video" ? "video" : null;
    if (!kind) return;
    const task = kind === "image" ? imageTask : videoTask;
    if (task?.status !== "succeeded") return;
    const media = task.media_results?.find((item) => item.media_kind === kind) ?? task.media_results?.[0];
    if (!media || attachedMediaRef.current.has(media.id)) return;
    attachedMediaRef.current.add(media.id);
    const attached = attachItemToLane(attachTarget, {
      id: `workshop:${media.id}`,
      name: `${shot?.title || "粗剪素材"} · ${kind === "image" ? "图片" : "视频"}产出`,
      kind,
      thumbUrl: media.thumbnail_url || media.storage_url || undefined,
      origin: "workshop",
    });
    if (attached) notify(`${kind === "image" ? "图片" : "视频"}已归入「${def.label}」组`, "success");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageTask?.status, videoTask?.status, attachTarget]);

  /* ---------- S2：页签与参考组联动 ---------- */
  function openTab(next: "home" | WorkshopId): void {
    setTab(next);
    if (next === "image") setMode("image");
    if (next === "video") setMode("video");
    // 手动切页与归组上下文不符时清掉（避免「归入角色」tag 挂在视频页误导）
    if (attachTarget && laneDef(attachTarget).workshop !== next) {
      setAttachTarget(null);
      setQuickDraft(false);
    }
  }

  /** 组卡片动作：去生成页/打开 3D 导演台/快抽小样——带上「归入该组」上下文（双通路的一环）。 */
  function handleLaneAction(lane: ReferenceLaneId, action: LaneAction): void {
    const def = laneDef(lane);
    setAttachTarget(lane);
    setQuickDraft(action === "quick_draft");
    openTab(def.workshop);
  }

  /** 手动归入：舞台已有结果归入当前组；demo 下无结果可归入示例（原型回路演示，真实栈不出该按钮）。 */
  function attachCurrentStage(): void {
    if (!attachTarget) return;
    const def = laneDef(attachTarget);
    const kind = def.workshop === "image" ? "image" : def.workshop === "video" ? "video" : null;
    const media = kind ? (kind === "image" ? imageMedia : videoMedia) : undefined;
    if (kind && media) {
      attachedMediaRef.current.add(media.id);
      const attached = attachItemToLane(attachTarget, {
        id: `workshop:${media.id}`,
        name: `${shot?.title || "粗剪素材"} · ${kind === "image" ? "图片" : "视频"}产出`,
        kind,
        thumbUrl: media.thumbnail_url || media.storage_url || undefined,
        origin: "workshop",
      });
      notify(attached ? `已归入「${def.label}」组` : `当前结果已在「${def.label}」组`, attached ? "success" : "info");
      return;
    }
    if (demoMode) {
      const attached = attachItemToLane(attachTarget, {
        id: `workshop:demo-${attachTarget}`,
        name: `示例产出 · ${def.label}（原型占位）`,
        kind: def.workshop === "audio" ? "audio" : def.workshop === "video" ? "video" : "image",
        origin: "workshop",
      });
      notify(attached ? `示例已归入「${def.label}」组（原型演示）` : `示例已在「${def.label}」组`, attached ? "success" : "info");
      return;
    }
    notify("还没有可挂回的产出", "info");
  }

  /** 选为音色参考：写入参考清单「音频」组（本机归组机制，合成接口等 Sol）。 */
  function handleSelectTimbre(timbre: { speaker_id: string; name?: string }): void {
    const label = timbre.name?.trim() || timbre.speaker_id;
    attachItemToLane("audio", {
      id: `workshop:timbre-${timbre.speaker_id}`,
      name: `${label}（音色参考）`,
      kind: "audio",
      origin: "workshop",
    });
    setLaneToast({ text: `${label} 已设为音色参考，归入「音频」组`, lane: "audio" });
  }

  /**
   * 导演台导出完成归组（本机归组机制，控制包接口就位后换真栈）：
   * 机位截图/宫格/入资产库 → 「场景」组；深度图/运镜小样 → 「运镜」组（S6 路由）。
   * 有 assetId（已入资产库）时以其为条目主键——同一资产重复归组幂等。
   */
  function handleDirectorExported(event: {
    kind: "shot" | "grid" | "capture" | "depth" | "motion";
    label: string;
    assetId?: string;
    thumbUrl?: string;
  }): void {
    const lane: ReferenceLaneId = event.kind === "depth" || event.kind === "motion" ? "camera_motion" : "scene";
    const attached = attachItemToLane(lane, {
      id: `workshop:director-${event.assetId ?? Date.now()}`,
      name: event.label,
      kind: event.kind === "motion" ? "video" : "image",
      thumbUrl: event.thumbUrl,
      origin: "workshop",
    });
    if (attached) setLaneToast({ text: `${event.label}已归入「${laneDef(lane).label}」组`, lane });
  }

  /** 归组 toast 的「去工作台查看」：回工作台首页并把目标组短暂高亮（~2s 强调）。 */
  function goToLaneOnHome(lane: ReferenceLaneId): void {
    setLaneToast(null);
    openTab("home");
    window.clearTimeout(laneFlashTimer.current);
    setLaneFlash(lane);
    laneFlashTimer.current = window.setTimeout(() => setLaneFlash(null), 2000);
  }

  /** D5：文字描述 → 提示词草稿（用当前草稿文本而非已保存值；填进对应媒体页提示词框并切过去，可继续编辑）。 */
  function draftPromptFromScript(): void {
    const draftText = scriptText.trim();
    if (!shot || !draftText) {
      notify("先写一段文字描述，再生成提示词草稿", "info");
      return;
    }
    const draftShot = { ...shot, script_text: draftText };
    const kind = activeKind;
    /* GP-12：重新起草只重写自动段（系统预填），补充段的用户手输保留。 */
    if (kind === "image") setImageAutoPrompt(buildImagePrompt(draftShot, refs));
    else setVideoAutoPrompt(buildVideoPrompt(draftShot, refs));
    if (tab !== kind) openTab(kind);
    notify(`已按文字描述生成${kind === "image" ? "图片" : "视频"}提示词草稿，可继续编辑`, "success");
  }

  /** D6：图片产物 → 视频参考（归参考清单「参考视频」组 + 切视频页 + 可点提示）。 */
  function useImageAsVideoReference(media: MediaResult): void {
    if (!shot) return;
    const attached = attachItemToLane("reference_video", {
      id: `workshop:${media.id}`,
      name: `${timelineCardTitle(shot)} · 图片`,
      kind: "image",
      thumbUrl: media.storage_url || media.thumbnail_url || undefined,
      origin: "workshop",
    });
    openTab("video");
    setLaneToast({ text: attached ? "图片已归入「参考视频」组" : "「参考视频」组已有这张图", lane: "reference_video" });
  }

  /* ---------- S2b-4：就绪=人工判断（记人记时、可撤销、本地存储降级） ---------- */
  function toggleReady(): void {
    if (readyMark) {
      saveReadyMark(window.localStorage, shotId, null);
      setReadyMark(null);
      notify("已撤销就绪标记", "info");
    } else {
      const mark: ReadyMark = { by: user.display_name || user.username, at: new Date().toISOString() };
      saveReadyMark(window.localStorage, shotId, mark);
      setReadyMark(mark);
      notify("已标记就绪：素材级「生成视频」已开放", "success");
    }
    window.dispatchEvent(new Event("shot-ready-changed"));
  }

  /** chips 点击：把 `@资产名` 写入当前提示词补充段光标处（序列化契约待 Fable，人读层占位）。
      GP-12：可编辑区=补充段，@提及落在补充段；自动段只读不接受插入。 */
  function insertAssetMention(name: string): void {
    const current = activeKind === "image" ? imageSupplement : videoSupplement;
    const setter = activeKind === "image" ? setImageSupplement : setVideoSupplement;
    const element = promptTextareaRef.current;
    const caret = element ? element.selectionStart ?? current.length : current.length;
    const result = appendMentionAtCaret(current, caret, name);
    setter(result.text);
    requestAnimationFrame(() => {
      const target = promptTextareaRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(result.caret, result.caret);
    });
  }

  const allMedia = useMemo(() => [
    ...(mediaState.data?.items ?? []).map(mediaVersionToResult),
    ...(imageTask?.media_results ?? []),
    ...(videoTask?.media_results ?? []),
  ].filter((item, index, array) => array.findIndex((candidate) => candidate.id === item.id) === index), [imageTask, mediaState.data, videoTask]);
  const imageMedia = imageTask?.media_results?.find((media) => media.media_kind === "image")
    ?? allMedia.find((media) => media.media_kind === "image" && media.is_primary)
    ?? allMedia.find((media) => media.media_kind === "image");
  const videoMedia = videoTask?.media_results?.find((media) => media.media_kind === "video")
    ?? allMedia.find((media) => media.media_kind === "video" && media.is_primary)
    ?? allMedia.find((media) => media.media_kind === "video");

  /** 条 4②：「转为参考资产」简介预填=本产物的提示词——仅当舞台图来自本会话提交的任务
      且捕获到提交时 prompt；历史产物/恢复任务拿不到 → 空，绝不预填别栏残留。 */
  const promotePromptSummary = useMemo(() => {
    if (!imageMedia) return "";
    const capture = lastSubmittedPromptRef.current;
    const fromCurrentTask = capture?.kind === "image"
      && capture.requestId === imageTask?.generation_request_id
      && (imageTask?.media_results ?? []).some((media) => media.id === imageMedia.id);
    return fromCurrentTask ? capture.prompt : "";
  }, [imageMedia, imageTask]);

  /** K-goal-04 条 4：点生成图标直接提交（生成确认抽屉退场——参数/提示词/参考集主界面都已可见，
      抽屉是重复确认）。提交 payload 与抽屉默认开拍一字不改：
      - 提示词=自动段+补充段拼接（GP-12 同一 splice 口径）；全空时先按素材+参考预填自动段；
      - 参考集=工作台控制包全量（partitionControlPack submitted 层）；
      - 视频且有确认图 → 确认图作首帧（=抽屉默认「按图生成」），无图=纯提示词。
      两条保留保证：
      ① 一次点击只创建一个任务——submitting 闸门进函数即拦，按钮点击后立刻禁用直到提交完成；
      ② 费用确认=按钮旁 ⚡ 实时估价（预计 N 积分）常显，点击即按正式报价扣费生成；
         服务端标记超复核阈值时仍另弹一次费用确认（GenerationQuoteModal 保留）。 */
  async function startGeneration(kind: "image" | "video"): Promise<void> {
    if (!shot || submitting) return; // ① 防手滑：一次提交未完成前再点不重复创建
    if (demoMode) {
      notify("离线演示不会提交真实生成。", "info");
      return;
    }
    const refs = assetState.data?.items ?? [];
    let prompt = kind === "image" ? imagePrompt.trim() : videoPrompt.trim();
    if (!prompt) {
      // GP-12：预填只写自动段（系统上下文，只读）；已有内容时两段都保持原样。
      prompt = kind === "image" ? buildImagePrompt(shot, refs) : buildVideoPrompt(shot, refs);
      if (kind === "image") setImageAutoPrompt(prompt);
      else setVideoAutoPrompt(prompt);
    }
    if (!prompt.trim()) {
      setGenerationError(`请先确认${kind === "image" ? "图片" : "视频"}提示词`);
      return;
    }
    /* 参考集口径=抽屉默认开拍：控制包全量 + （视频且有确认图）确认图首帧，按 mediaId 去重。
       K2K（GP-18）：同一媒体只上送一次（去重即互斥的提交口径）。 */
    const referenceIds = [...new Set([
      ...controlPackOptions.map((option) => option.mediaId),
      ...(kind === "video" && imageMedia ? [imageMedia.id] : []),
    ])];
    setGenerationError("");
    setSubmitting(kind);
    try {
      await runGenerationFlow(kind, prompt.trim(), referenceIds);
    } catch (reason) {
      setGenerationError(businessErrorMessage(reason, "生成提交失败，请稍后重试"));
    } finally {
      setSubmitting("");
    }
  }

  /** W5-1：demoMode 下按钮照渲染，点击只提示不发起请求。 */
  function openPromote(): void {
    if (demoMode) {
      notify("离线演示不会写入资产库。", "info");
      return;
    }
    setPromoteOpen(true);
  }

  /**
   * W6-1：模板选中/取消。选中：备份当前草稿 → {content} 替换为当前分镜内容预填；
   * 再点同一枚取消：恢复选中前的草稿（无备份回空白）。预填提示词不触发任何付费/请求。
   * S66 + V-07：模板参数重新参与——设计画幅在档位值域内时按维度反查切到命中档
   * （档仍是原子的，提交参数 = 命中档的 tierSubmitInput）；查无档（如 21:9 全景）
   * 不动档，模板区 presetRatioNote 明示变形警示。取消选中不回切档。
   */
  function toggleImagePreset(preset: ImagePreset): void {
    const nextId = togglePresetSelection(imagePresetId, preset.id);
    if (nextId === preset.id) {
      /* GP-12：模板只替换自动段（备份/恢复都以自动段为单位），补充段手输不动。 */
      if (imagePresetId === null) presetBackupRef.current = imageAutoPrompt;
      setImagePresetId(preset.id);
      setImageAutoPrompt(applyPresetPrompt(preset, shot));
      const presetRatio = imageGenerationParameters(preset).ratio;
      if (selectedTier && typeof presetRatio === "string") {
        const picked = resolveDimensionPick(tiers, selectedTier, "image", "aspect_ratio", presetRatio);
        if (picked && picked.tier_id !== selectedTier.tier_id) setSelectedTierId(picked.tier_id);
      }
      return;
    }
    setImagePresetId(null);
    setImageAutoPrompt(presetBackupRef.current ?? "");
    presetBackupRef.current = null;
  }

  /** W6-2：宫格切分入口；demoMode 下只提示不读图不请求。 */
  function openGridSplit(media: MediaResult): void {
    if (demoMode) {
      notify("离线演示不切分不写入。", "info");
      return;
    }
    setGridMedia(media);
  }

  /* ---------- W5.5：分镜内联改名（Enter/失焦保存，Esc 取消） ---------- */
  function startRename(): void {
    if (!shot) return;
    renameBlurSkip.current = false;
    setRenameDraft(shot.title || "");
    setRenameError("");
    setRenaming(true);
  }

  function cancelRename(): void {
    renameBlurSkip.current = true;
    setRenaming(false);
    setRenameError("");
  }

  async function commitRename(): Promise<void> {
    if (!shot || renameSaving) return;
    const verdict = shotTitleCommit(shot.title || "", renameDraft);
    if (!verdict.commit) {
      setRenaming(false);
      setRenameError("");
      return;
    }
    if (demoMode) {
      setShotData((current) => (current ? { ...current, title: verdict.title } : current));
      setRenaming(false);
      notify("离线演示不写入粗剪素材改名", "info");
      return;
    }
    setRenameSaving(true);
    setRenameError("");
    try {
      const next = await api.updateShot(shot.id, { title: verdict.title });
      setShotData(next);
      setRenaming(false);
      notify("粗剪素材已改名", "success");
    } catch (reason) {
      setRenameError(businessErrorMessage(reason, "改名失败，请重试"));
    } finally {
      setRenameSaving(false);
    }
  }

  /* ---------- W5.5：台内资产抽屉（加入/移出后不离开工作台，刷新已选资产条） ---------- */
  async function addAssetToProject(asset: Asset): Promise<boolean> {
    const exists = (assetState.data?.items ?? []).some((ref) => (ref.asset_entity_id || ref.asset_id) === asset.id);
    if (exists) {
      notify("这个资产已经在项目中", "info");
      return false;
    }
    if (demoMode) {
      assetState.setData((current) => current
        ? { items: [...current.items, { id: `demo-ref-${asset.id}`, project_id: projectId, asset_id: asset.id, asset }], count: current.count + 1 }
        : current);
      notify("离线演示不写入项目资产，已在本地加入", "info");
      return true;
    }
    const mediaId = await resolveAssetPrimaryMediaId(asset);
    if (!mediaId) {
      notify("这个资产还没有已入库的图片版本，请先到资产中心上传并设为主版本", "error");
      return false;
    }
    await api.addProjectAsset(projectId, asset.id, mediaId);
    assetState.retry();
    notify(`「${assetName(asset)}」已加入项目`, "success");
    return true;
  }

  async function removeAssetFromProject(ref: ProjectAssetRef): Promise<void> {
    if (demoMode) {
      assetState.setData((current) => current
        ? { items: current.items.filter((item) => item.id !== ref.id), count: Math.max(0, current.count - 1) }
        : current);
      notify("离线演示不写入项目资产，已在本地移出", "info");
      return;
    }
    await api.removeProjectAsset(projectId, ref.id);
    assetState.retry();
    notify("已移出项目；资产本体仍在资产库", "success");
  }

  /** 确认卡结算：confirm 冻结报价并创建唯一任务。重复确认由服务端幂等保护。 */
  async function settleQuote(pending: PendingGenerationQuote): Promise<void> {
    const confirmed = await api.confirmGenerationQuote(pending.quote.generation_quote_id);
    if (confirmed.status === "consumed") {
      if (confirmed.generation_request_id) {
        const existing = await api.generation(confirmed.generation_request_id);
        acceptGenerationTask(pending.mediaKind, existing);
      }
      notify("这次确认已经提交过，不会重复扣费", "info");
      return;
    }
    let task: GenerationTask;
    if (pending.operation === "submit" && pending.input) {
      task = await api.createGeneration(pending.input, pending.quote.generation_quote_id);
      // 条 4②：捕获提交时 prompt（重试链不重捕——retry 复用原始 prompt，接口不回传）
      lastSubmittedPromptRef.current = { kind: pending.mediaKind, requestId: task.generation_request_id, prompt: pending.input.prompt };
    } else if (pending.operation === "retry" && pending.requestId && pending.retryIdempotencyKey) {
      task = await api.retryGeneration(pending.requestId, pending.quote.generation_quote_id, pending.retryIdempotencyKey);
    } else {
      throw new Error("确认卡缺少完整生成信息，请重新发起");
    }
    acceptGenerationTask(pending.mediaKind, task);
    /* S16 条 2：任务注册进参考组台账（submit 取当前归组上下文；retry 继承原任务的组并替换原记录）。
       lane=null（快速通道）不注册——舞台任务卡已覆盖，参考栏不重复表达。 */
    const laneForTask = pending.operation === "submit"
      ? attachTarget
      : (laneTaskRecords.find((record) => record.requestId === pending.requestId)?.lane ?? null);
    if (laneForTask) {
      let records = registerLaneTask(window.localStorage, shotId, {
        requestId: task.generation_request_id,
        lane: laneForTask,
        kind: pending.mediaKind,
        submittedAt: new Date().toISOString(),
      });
      if (pending.operation === "retry" && pending.requestId) {
        records = unregisterLaneTask(window.localStorage, shotId, pending.requestId);
      }
      setLaneTaskRecords(records);
    }
    notify(`${pending.mediaKind === "image" ? "图片" : "视频"}${pending.operation === "retry" ? "重试" : ""}任务已提交`, "success");
  }

  /**
   * 一次人工点击 → 一个任务：后台自动完成报价与提交；
   * 只有服务端标记 requires_manual_review 时才弹费用复核（PRD 8.7）。
   * 提交参数=选中档（tierSubmitInput）,估价/创建全链带 tier_id（不一致 422）。
   */
  async function runGenerationFlow(kind: "image" | "video", prompt: string, referenceIds: string[]): Promise<void> {
    if (!shot) return;
    if (demoMode) {
      throw new Error("离线演示不会提交真实生成。请登录已启动的服务后再生成。");
    }
    // 提交档=当前页签选中档；跨类型调用（如 IR 直编视频）该类型档未加载时现拉接口,
    // 绝不回落本地档（裁决 4）——本地档不是真档,拿它提交必 422。
    let submitTier = kind === tierKind ? selectedTier : null;
    if (!submitTier) {
      try {
        const result = await listCapabilityTiers(kind, demoMode);
        submitTier = resolveSelectedTier(result.tiers, null);
      } catch (reason) {
        setGenerationError(businessErrorMessage(reason, "生成档位读取失败，请稍后重试"));
        return;
      }
    }
    if (!submitTier) {
      setGenerationError("生成档位未加载，请稍后重试");
      return;
    }
    const { parameters, quantity } = tierSubmitInput(submitTier);
    const input = freezeGenerationInput({
      media_kind: kind,
      tier_id: submitTier.tier_id,
      project_id: projectId,
      episode_id: episodeId,
      scene_id: shot.scene_id ?? null,
      shot_id: shot.id,
      prompt,
      reference_media_ids: referenceIds,
      parameters,
      quantity,
      client_idempotency_key: `${projectId}-${shot.id}-${kind}-${newId()}`,
    });
    const quote = await api.quoteGeneration(input);
    const pending: PendingGenerationQuote = {
      quote,
      mediaKind: kind,
      operation: "submit",
      input,
      status: quoteIsExpired(quote) ? "expired" : "ready",
    };
    if (quote.requires_manual_review === true) {
      setPendingQuote(pending);
      return;
    }
    await settleQuote(pending);
  }

  /** 失败后的原样重试：同样一次点击一个新任务，不覆盖原任务。 */
  async function retryGeneration(kind: "image" | "video"): Promise<void> {
    const task = kind === "image" ? imageTask : videoTask;
    if (!task || demoMode) return;
    setSubmitting(kind);
    try {
      await retryLaneTask(kind, task.generation_request_id);
    } finally {
      setSubmitting("");
    }
  }

  /** 超阈值复核弹窗的确认：沿用冻结报价链。 */
  async function confirmPendingQuote(): Promise<void> {
    const pending = pendingQuote;
    if (!pending || ["confirming", "submitting"].includes(pending.status)) return;
    if (quoteIsExpired(pending.quote)) {
      setPendingQuote({ ...pending, status: "expired", error: "费用确认已过期，请重新发起。" });
      return;
    }
    setPendingQuote({ ...pending, status: "submitting", error: "" });
    try {
      await settleQuote(pending);
      setPendingQuote(null);
    } catch (reason) {
      const message = businessErrorMessage(reason, "确认费用失败，请稍后重试");
      const expired = reason instanceof ApiClientError
        && ["GENERATION_QUOTE_EXPIRED", "quote_stale", "GENERATION_QUOTE_CONFLICT"].includes(reason.code);
      setPendingQuote((current) => current?.quote.generation_quote_id === pending.quote.generation_quote_id
        ? { ...current, status: expired ? "expired" : "failed", error: message }
        : current);
    }
  }

  async function refreshPendingQuote(): Promise<void> {
    const pending = pendingQuote;
    if (!pending || ["confirming", "submitting"].includes(pending.status)) return;
    setPendingQuote({ ...pending, status: "confirming", error: "" });
    try {
      const quote = pending.operation === "submit" && pending.input
        ? await api.quoteGeneration(pending.input)
        : pending.requestId
          ? await api.quoteGenerationRetry(pending.requestId)
          : null;
      if (!quote) throw new Error("报价缺少完整生成信息");
      setPendingQuote({ ...pending, quote, status: quoteIsExpired(quote) ? "expired" : "ready", error: "" });
    } catch (reason) {
      setPendingQuote({ ...pending, status: "failed", error: businessErrorMessage(reason, "重新获取报价失败，请稍后重试") });
    }
  }

  if (shotState.loading) return <LoadingState label="正在读取工作台" />;
  if (shotState.error || !shot) return <ErrorState message={shotState.error || "粗剪素材不存在"} onRetry={shotState.retry} />;
  const refs = assetState.data?.items ?? [];
  /* D6-2/S9-17：视频页「当前引用」缩略条与提交参考集同源——同取工作台参考控制包（六组）的图片项 */
  const imageRefOptions = controlPackOptions.filter((option) => !option.isVideo);
  const activeKind: "image" | "video" = mode;
  const activeTask = activeKind === "image" ? imageTask : videoTask;
  const activeMedia = activeKind === "image" ? imageMedia : videoMedia;
  const scriptDirty = autosaveDirty({ script: scriptText, image: imagePrompt, video: videoPrompt }, serverPromptTrio(shot));
  // 版本轨道预览：点击缩略图只换舞台预览，不动主版本与任务态。
  /* 条 6：版本轨道预览限本媒介——视频页签只看视频，图片页签只看图片（点击行为与产物类型一致） */
  const railMedia = allMedia.filter((item) => item.media_kind === activeKind);
  const stageMedia = previewId ? (railMedia.find((item) => item.id === previewId) ?? activeMedia) : activeMedia;

  /* ---------- S66：libTV 三段式节点卡——派生态与编辑条/chips/维度 popover 接线 ----------
     功能位状态三态(wired/planned/needs_media)的真源在 gen-node-capability.ts;
     灰显项在组件内已拦,这里的 onAction 只接 wired/条件满足的真实能力,不做假按钮。 */

  /** 画布标题行的档参数（比例 · 清晰度，取自当前档实际声明，不编造像素）。 */
  const canvasTierText = selectedTier
    ? [selectedTier.params.aspect_ratio, selectedTier.params.resolution]
        .filter((value): value is string => typeof value === "string")
        .join(" · ")
    : "";
  /* 参数/模型两个维度 popover 连同 footer 接线已收进 TierDimensionPopovers(S83c,
     components/gen-params-popover.tsx)——footer 守卫升级为行为断言后,接线必须可被
     happy-dom 真渲染。判定口径(dimensionPopoverFooter,S83b 验收 R1,S83d 修):
     有置灰项或单值维度都要给出路说明;「当前只开放这一档」按全量维度判定,
     不许拿模型/参数子集判(子集单值≠只有一档)。 */
  /** 视频生成卡生效模式：用户显式选过以选择为准;否则跟随链路默认(有确认图=按图生成,无确认图=全能参考)。 */
  const videoMode = videoModeChoice ?? (imageMedia ? "i2v" : "omni");

  /** 维度 popover 选值 → 反查命中档切档(查无组合的项组件内已置灰,正常点不到 null 分支)。 */
  function handleDimensionPick(key: GenerationDimensionKey, value: GenerationDimensionValue): void {
    if (!selectedTier) return;
    const picked = resolveDimensionPick(tiers, selectedTier, tierKind, key, value);
    if (picked && picked.tier_id !== selectedTier.tier_id) setSelectedTierId(picked.tier_id);
  }

  /** 编辑条「下载」：图片走产物 download_url/storage_url(与原常驻下载同口径);
      视频走 api.downloadMedia(登录校验后下载,与版本库同口径)。 */
  async function downloadStageMedia(): Promise<void> {
    const media = activeKind === "image" ? imageMedia : videoMedia;
    if (!media || stageDownloading) return;
    if (demoMode) {
      notify("离线演示没有可下载的真实媒体。", "info");
      return;
    }
    if (media.media_kind === "video") {
      setStageDownloading(true);
      try {
        await api.downloadMedia(media.id);
        notify("视频已开始下载", "success");
      } catch (reason) {
        notify(businessErrorMessage(reason, "下载失败，请稍后重试"), "error");
      } finally {
        setStageDownloading(false);
      }
      return;
    }
    const url = media.download_url || media.storage_url;
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "";
    anchor.target = "_blank";
    anchor.rel = "noreferrer";
    anchor.click();
  }

  /** 编辑条「全屏」：画布段（stageCardRef）进 Fullscreen;浏览器拒绝时如实提示。 */
  function openStageFullscreen(): void {
    const node = stageCardRef.current;
    if (!node) return;
    const request = node.requestFullscreen?.();
    if (request) void request.catch(() => notify("浏览器拒绝了全屏请求", "error"));
  }

  /** 播放器「截帧」：取当前播放帧下载 PNG;跨域污染画布/画面未就绪时如实提示,不静默。 */
  function captureVideoFrame(): void {
    const video = stageCardRef.current?.querySelector("video");
    if (!video || !video.videoWidth) {
      notify("还没有可截的视频画面。", "info");
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          notify("截帧失败：画面未就绪", "error");
          return;
        }
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${shot?.title || "视频"}-截帧.png`;
        anchor.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    } catch {
      notify("截帧失败：视频源跨域，画布被污染", "error");
    }
  }

  /** 编辑条接线(只接 wired/产物在场的真能力;planned 项在组件内已拦,到不了这里)。 */
  function handleEditBarAction(id: string): void {
    if (id === "grid-split") {
      if (imageMedia) openGridSplit(imageMedia);
      return;
    }
    if (id === "download") {
      void downloadStageMedia();
      return;
    }
    if (id === "fullscreen") {
      openStageFullscreen();
      return;
    }
    if (id === "visual-edit") {
      if (videoMedia) setEditBase(videoMedia);
      return;
    }
  }

  /** 生成卡 chips 接线(同上,只接真能力)。 */
  function handleChipAction(id: string): void {
    if (id === "add-ref") {
      setAssetDrawer({ mode: "browse", kind: "" });
      return;
    }
    if (id === "style") {
      /* S83/V-35：风格 chip = 模板区唯一入口（开/关 toggle;原模板区自带折叠头已退场,
         两个入口并存是 DC 判决 V-35「同一件事两个开关」的根因）。 */
      setShowImageTemplates((value) => !value);
      return;
    }
    if (id === "character-lib") {
      setAssetDrawer({ mode: "browse", kind: "character" });
      return;
    }
    if (id === "camera-move") {
      goToLaneOnHome("camera_motion");
      return;
    }
  }
  return (
    <section className="flex flex-col gap-4">
      <div className={cn("grid grid-cols-1 items-start gap-4", focusMode ? "" : "lg:grid-cols-[minmax(220px,250px)_minmax(0,1fr)]")}>
        {focusMode ? null : (
        <aside className="flex min-w-0 flex-col gap-3">
          <section className="flex flex-col gap-2 rounded-lg border border-border-1 bg-surface-1 px-4 py-3">
            <span className="font-mono text-xs text-ink-2">粗剪素材 #{shot.shot_no ?? "—"}</span>
            {renaming ? (
              <div className="flex flex-col gap-1">
                <Input
                  value={renameDraft}
                  autoFocus
                  disabled={renameSaving}
                  aria-label="粗剪素材名称"
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onFocus={(event) => event.target.select()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); void commitRename(); }
                    if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
                  }}
                  onBlur={() => {
                    if (renameBlurSkip.current) { renameBlurSkip.current = false; return; }
                    void commitRename();
                  }}
                />
                {renameSaving ? <span className="text-xs text-ink-2">保存中…</span> : null}
                {renameError ? <span className="text-xs text-danger" role="alert">{renameError}</span> : null}
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <strong className="min-w-0 truncate text-base text-ink-1">{shot.title || "未命名粗剪素材"}</strong>
                <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="重命名粗剪素材" title="重命名粗剪素材" onClick={startRename}><PencilSimple /></Button>
              </div>
            )}
          </section>
          <section className="flex flex-col gap-3 rounded-lg border border-border-1 bg-surface-1 px-4 py-3">
            <header className="flex items-center justify-between gap-2">
              <h2 className="text-ink-1 text-section-title">已匹配资产</h2>
              <span className="font-mono text-xs text-ink-2">{refs.length} 项</span>
            </header>
            {assetState.loading ? <div className="flex flex-col gap-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div> : assetState.error ? <ErrorState message={assetState.error} onRetry={assetState.retry} /> : refs.length === 0 ? <p className="text-xs text-ink-2">还没有匹配资产，先从项目资产引入。</p> : refs.slice(0, 4).map((ref) => {
              const asset = refAsset(ref);
              return (
                <article className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-2 p-2" key={ref.id}>
                  <AssetMiniThumb asset={asset} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <strong className="truncate text-xs font-semibold text-ink-1">{assetName(asset)}</strong>
                    <span className="text-[11px] text-ink-2">{assetKindLabel(asset.asset_kind)}</span>
                  </div>
                  <CheckCircle aria-label="已选择" className="size-4 shrink-0 text-success" />
                </article>
              );
            })}
            {refs.length > 4 ? <button className="self-start text-xs text-accent-text underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-accent" type="button" onClick={() => navigate(`/projects/${projectId}/assets`)}>查看更多资产（还有 {refs.length - 4} 项）</button> : null}
            <Button icon={<Sparkle />} onClick={() => setAssetDrawer({ mode: "match", kind: "" })}>匹配 + 选择资产</Button>
          </section>
          <section className="flex flex-col gap-2 rounded-lg border border-border-1 bg-surface-1 px-4 py-3">
            <header className="flex items-center justify-between gap-2">
              <h2 className="text-ink-1 text-section-title">文字描述</h2>
              <span className="text-xs text-ink-2">{promptSaveLabel(promptSaveState, demoMode, scriptDirty)}</span>
            </header>
            <Textarea
              className="min-h-[120px] text-sm"
              value={scriptText}
              placeholder="剧本文本…"
              onChange={(event) => setScriptText(event.target.value)}
            />
            {/* D5：文字描述接进生成链——草稿直接填进当前媒体页提示词框（可编辑），文本框不再孤立 */}
            <Button size="sm" icon={<Sparkle />} disabled={!scriptText.trim()} title="把这段文字描述和已选参考喂给 AI 起草稿，填进当前媒体页的提示词框（可再编辑）" onClick={draftPromptFromScript}>生成提示词草稿</Button>
          </section>
        </aside>
        )}
        <main className="flex min-w-0 flex-col gap-4">
                    <div className="inline-flex items-center gap-1 self-start rounded-md border border-border-1 bg-surface-0 p-1" role="tablist" aria-label="工作台页签">
            {([["home", "控制包"], ["image", "图片"], ["video", "视频"], ["audio", "音频"], ["director", "3D 导演台"]] as const).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={segmentedOptionClass(tab === key)} onClick={() => openTab(key)}>{label}</button>
            ))}
          </div>
          {/* S78:工作台内「去下一个待生成分镜」一键入口(R68),挂在页签行下,五个页签都可见 */}
          <WorkbenchNextPending projectId={projectId} episodeId={episodeId} shotId={shotId} demoMode={demoMode} />
          {tab === "home" ? (
            <>
              <h1 className="sr-only">工作台</h1>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* S12-1：viewer 只读，不给就绪标记（创作链入口动作） */}
                {canCreate ? (
                <button
                  type="button"
                  aria-pressed={Boolean(readyMark)}
                  title={readyMark ? `已标记就绪：${formatReadyMark(readyMark)}（点击撤销）` : "标记就绪（人工判断，可撤销）"}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent [&_svg]:size-3.5",
                    readyMark
                      ? "border-success/50 bg-success/10 text-success"
                      : "border-border-1 bg-surface-1 text-ink-2 hover:border-border-2 hover:text-ink-1",
                  )}
                  onClick={toggleReady}
                >
                  {readyMark ? <FlagCheckered aria-hidden="true" /> : <Flag aria-hidden="true" />}
                  {readyMark ? `已就绪 · ${formatReadyMark(readyMark)}` : "标记就绪"}
                </button>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {/* S9-18：素材级唯一主按钮「生成视频」——按图/按提示词不再分入口;
                      K-goal-04 条 4:点击直接提交(确认抽屉退场),生成依据=视频页签模式选择器 */}
                  {/* S12-1：viewer 不显示创作按钮（只读工作台）。
                      就绪标记与权限分两层：没标就绪时这一格本来就空着，不借权限位说话——
                      合在一起判会让「你还没标就绪」被说成「权限没读到」，用户点重试也点不出按钮。 */}
                  {readyMark ? (
                    canCreate ? (
                      <Button variant="primary" icon={<VideoCamera />} loading={submitting === "video"} disabled={Boolean(submitting)} onClick={() => void startGeneration("video")} title="生成这条粗剪素材的视频（点击即按正式报价生成；超复核阈值时会再确认一次费用）">生成视频</Button>
                    ) : <CapabilityActionSlot state={capabilities} label="生成视频" />
                  ) : null}
                </div>
              </div>
              <p className="text-[11px] text-ink-4">标记就绪是人工判断，可撤销 · 标记后开放素材级「生成视频」 · 标记只保存在这台设备上
                {laneInflightCount > 0 ? <span className="ml-2 rounded-full bg-accent-subtle px-2 py-px text-accent-text" role="status">还有 {laneInflightCount} 个参考生成中（不阻塞，可等完成再标记）</span> : null}
              </p>
              <div className={cn("[&_section]:transition-colors", laneFlash ? LANE_FLASH_CLASS[laneFlash] : undefined)}>
                <ReferenceList
                  state={lanesState}
                  demoMode={demoMode}
                  onLaneAction={handleLaneAction}
                  onPickFromLibrary={(lane) => { setAttachTarget(lane); setAssetDrawer({ mode: "browse", kind: (hasLane(lane) ? laneEntry(lane).pickKind : null) ?? "" }); }}
                  onRemoveItem={(lane, itemId) => commitLanes(detachLaneItem(lanesState, lane, itemId))}
                  onSaveCameraNote={(text) => commitLanes(upsertCameraNote(lanesState, text))}
                  laneTasks={laneTaskCards}
                  onLaneTaskAttach={attachLaneTaskResult}
                  onLaneTaskRetry={(kind, requestId) => void retryLaneTask(kind, requestId)}
                  excludedReasons={controlPackExcludedReasons}
                />
              </div>
            </>
          ) : tab === "director" ? (
            /* 页签内直接渲染，零跳转：全屏=同一节点 class 切换（不卸载、WebGL 上下文不丢） */
            <div className={directorFull ? "fixed inset-0 z-[70] flex flex-col gap-2 bg-surface-0 px-3 py-2" : "relative flex flex-col gap-2"}>
              {/* 条 7 修正(DC 7-24):悬浮钮锚进画布视口右上角——越过 48px 顶栏与 300px 右属性面板,不再压住顶栏右端的导出菜单 */}
              {directorFull ? (
                <Button className="absolute right-[312px] top-[60px] z-10" size="sm" variant="outline" onClick={() => setDirectorFull(false)}>返回工作台</Button>
              ) : (
                <Button className="absolute right-[312px] top-[56px] z-10" size="sm" variant="outline" icon={<CornersOut />} title="全屏使用导演台" onClick={() => setDirectorFull(true)}>全屏</Button>
              )}
              <Suspense fallback={<Skeleton className="h-[420px] w-full" />}>
                <DirectorWorkspaceLazy projectId={projectId} notify={notify} onExported={handleDirectorExported} />
              </Suspense>
            </div>
          ) : tab === "audio" ? (
            <section className="flex flex-col gap-3 rounded-lg border border-border-1 bg-surface-1 px-5 py-4" aria-label="音频">
              <h2 className="text-ink-1 text-section-title">音频 · 音色库</h2>
              <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
                <TimbreBrowserLazy onSelect={handleSelectTimbre} />
              </Suspense>
            </section>
          ) : (
            <>
              <header className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="sr-only">{activeKind === "image" ? "图片" : "视频"}</h1>
                  {attachTarget ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent-subtle px-2.5 py-1 text-xs text-accent-text">
                      本次生成归入「{laneDef(attachTarget).label}」{quickDraft ? " · 快抽小样档" : ""}
                      {activeMedia || demoMode ? (
                        <button type="button" className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={attachCurrentStage}>{activeMedia ? "归入当前结果" : "归入示例（原型）"}</button>
                      ) : null}
                      <button
                        type="button"
                        aria-label="取消归入，走快速通道"
                        className="rounded-full p-0.5 outline-none transition-colors hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
                        onClick={() => { setAttachTarget(null); setQuickDraft(false); }}
                      ><X aria-hidden="true" className="size-3" /></button>
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="icon" variant="ghost" aria-label={focusMode ? "退出沉浸模式" : "沉浸模式"} title={focusMode ? "退出沉浸模式（恢复信息栏与时间线）" : "沉浸模式（只看舞台与提示词）"} aria-pressed={focusMode} onClick={() => setFocusMode((value) => !value)}><CornersOut /></Button>
                </div>
              </header>
          {/* S66:libTV 三段式生成节点卡——编辑条(上)/画布(中)/生成卡(下)。
              生成卡=原「生成输入」组(外壳恒定,提示词 textarea 不切页重挂载)整体下移到画布之下,
              构成画布(出)→生成卡(进)流向;图片页签渲染即原提示词卡。 */}
          {/* S79:or-theme/or-gennode 只换皮(墨笺),libTV 三段式结构与类名钩子不动 */}
          <div className="or-theme or-gennode flex flex-col overflow-hidden rounded-lg border border-border-1 bg-surface-1">
          <GenNodeEditBar
            features={activeKind === "image" ? IMAGE_EDIT_FEATURES : VIDEO_EDIT_FEATURES}
            mediaReady={Boolean(activeMedia)}
            onAction={handleEditBarAction}
            ariaLabel={activeKind === "image" ? "图片节点编辑条" : "视频节点编辑条"}
          />
          <div ref={stageCardRef} className="flex flex-col gap-2 bg-surface-1 px-4 pb-1 pt-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-song text-sm font-medium text-ink-1">{shot.title || "未命名粗剪素材"}</span>
              <span className="flex shrink-0 items-center gap-2 text-[11px] text-ink-4">
                {activeKind === "image" && stageMedia ? <span className="rounded-sm bg-accent-subtle px-1 py-px text-[10px] font-medium text-accent-text">AI生成</span> : null}
                {canvasTierText ? <span className="font-mono">{canvasTierText}</span> : null}
              </span>
            </div>
            {tab === "video" ? <h2 className="font-song text-ink-1 text-section-title">生成输出</h2> : null}
            <div className="relative">
              <MediaStage kind={stageMedia?.media_kind === "video" ? "video" : activeKind} media={stageMedia} />
              {tab === "video" && stageMedia?.media_kind === "video" ? (
                <button
                  type="button"
                  className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md border border-border-1 bg-surface-1/90 px-2 py-1 text-xs text-ink-2 outline-none transition-colors hover:border-border-2 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
                  title="截取当前播放帧，下载 PNG"
                  onClick={captureVideoFrame}
                ><Camera aria-hidden="true" className="size-3.5" />截帧</button>
              ) : null}
            </div>
          </div>
          <section className="flex flex-col gap-3 px-4 py-3" aria-label={tab === "video" ? "生成输入" : undefined}>
            {tab === "video" ? (
              <>
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-song text-ink-1 text-section-title">生成输入</h2>
                  <span className="text-[11px] text-ink-4">确认图、引用与提示词共同决定上方输出</span>
                </header>
                {imageMedia ? (
                  <figure className="m-0 flex items-center gap-2">
                    <img src={imageMedia.storage_url || imageMedia.thumbnail_url || ""} alt="当前图片" className="size-14 rounded-md border border-border-1 bg-surface-well object-cover" />
                    <figcaption className="text-xs text-ink-2">当前图片 · 按图生视频的首帧</figcaption>
                  </figure>
                ) : null}
                {/* D6-2：引用缩略条——控制包里的图片参考一眼可见，点击可换 */}
                <div className="flex items-center gap-3">
                  <span className="shrink-0 text-xs text-ink-2">当前引用</span>
                  {imageRefOptions.length === 0 ? (
                    <span className="min-w-0 flex-1 text-[11px] text-ink-4">还没有图片参考，可从资产库选；没有参考也可以文生视频</span>
                  ) : (
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" aria-label="当前引用的图片参考">
                      {imageRefOptions.slice(0, 8).map((option, index) => (
                        <span key={option.mediaId} className="relative size-5 shrink-0">
                          <span title={option.name} className="flex size-full items-center justify-center overflow-hidden rounded-sm border border-border-1 bg-surface-well text-ink-4">
                            {option.url ? <img src={option.url} alt={option.name} className="size-full object-cover" loading="lazy" /> : <ImageSquare aria-hidden="true" className="size-3" />}
                          </span>
                          <span aria-hidden="true" className="absolute -left-1 -top-1 flex size-3 items-center justify-center rounded-full bg-surface-1 text-[8px] leading-none text-ink-2 ring-1 ring-border-1">{index + 1}</span>
                        </span>
                      ))}
                      {imageRefOptions.length > 8 ? <span className="shrink-0 text-[11px] text-ink-4">+{imageRefOptions.length - 8}</span> : null}
                    </div>
                  )}
                  <button
                    type="button"
                    className="shrink-0 rounded-sm px-1.5 py-0.5 text-xs text-accent-text outline-none transition-colors hover:bg-accent-subtle focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={() => setAssetDrawer({ mode: "browse", kind: "" })}
                  >更换</button>
                </div>
              </>
            ) : null}
            {/* S66:视频生成卡——模式选择器(libTV 五模式,未实装灰显「规划中」)+
                高级设置「自动校验素材」(规划中,灰显不做假开关)。 */}
            {tab === "video" ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <VideoModeSelector
                  modes={VIDEO_MODES}
                  mediaReady={Boolean(imageMedia)}
                  value={videoMode}
                  onChange={(id) => setVideoModeChoice(id === "i2v" ? "i2v" : "omni")}
                  ariaLabel="视频生成模式"
                />
                {/* S73:「自动校验素材」开关收进组件(S66 纪律修复:aria-disabled 可悬浮出 tooltip,
                    不再用 disabled 把 tooltip 憋死;文案真源 gen-node-capability.ts)。 */}
                <AutoValidateSwitch />
              </div>
            ) : null}
            {/* S66:生成卡 chips(libTV:图片=+参考/标记/风格;视频=+参考/标记/特效/角色库/运镜);
                状态真源=gen-node-capability.ts,未实装灰显「规划中」。 */}
            <GenNodeChips
              features={activeKind === "image" ? IMAGE_CHIPS : VIDEO_CHIPS}
              mediaReady={Boolean(activeMedia)}
              onAction={handleChipAction}
              ariaLabel={activeKind === "image" ? "图片生成参考操作" : "视频生成参考操作"}
            />
            {/* S66:参考缩略图带序号圆标(libTV 生成卡);与视频页签同取控制包图片项(D6-2 同源)。 */}
            {tab === "image" && imageRefOptions.length > 0 ? (
              <div className="flex items-center gap-1.5 overflow-x-auto" aria-label="当前引用的图片参考">
                {imageRefOptions.slice(0, 6).map((option, index) => (
                  <span key={option.mediaId} className="relative size-8 shrink-0">
                    <span title={option.name} className="flex size-full items-center justify-center overflow-hidden rounded-md border border-border-1 bg-surface-well text-ink-4">
                      {option.url ? <img src={option.url} alt={option.name} className="size-full object-cover" loading="lazy" /> : <ImageSquare aria-hidden="true" className="size-4" />}
                    </span>
                    <span aria-hidden="true" className="absolute -left-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-surface-1 text-[9px] leading-none text-ink-2 ring-1 ring-border-1">{index + 1}</span>
                  </span>
                ))}
                {imageRefOptions.length > 6 ? <span className="shrink-0 text-[11px] text-ink-4">+{imageRefOptions.length - 6}</span> : null}
              </div>
            ) : null}
            {/* K-goal-04 条 4:随提交/不随提交真相条(原确认抽屉分层挪到主界面常驻);
                提交口径 byImage=视频且有确认图(与 startGeneration 组装的 payload 一致)。 */}
            <ControlPackSubmitTruth options={controlPackOptions} excluded={controlPackExcluded} byImage={activeKind === "video" && Boolean(imageMedia)} />
            {/* S59 + S83(V-35)：模板卡在工作台提示词区上方;
                唯一入口 = 生成卡「风格」chip（toggle）,不再自带折叠头——两个开关管同一块区域是
                V-35 判决的去重对象。展开=卡片组;收起且已选=一行 slim 状态;
                变形警示独立于展开态,只要存在就常显。 */}
            {tab === "image" && (showImageTemplates || imagePresetId !== null) ? (
              <div className="flex flex-col gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2">
                {imagePresetRatioNote ? (
                  <p className="m-0 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning" role="alert">{imagePresetRatioNote}</p>
                ) : null}
                {showImageTemplates ? (
                  <div className="flex flex-col gap-3 pt-1">
                    {IMAGE_PRESET_GROUPS.map((group) => (
                      <section className="flex flex-col gap-2" key={group.key}>
                        <h4 className="text-xs font-medium tracking-wide text-ink-4">{group.label}</h4>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
                          {presetsInGroup(group.key).map((preset) => {
                            const selected = imagePresetId === preset.id;
                            return (
                              <button
                                className={cn(
                                  "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent disabled:text-ink-3",
                                  selected ? "border-accent bg-accent-subtle" : "border-border-1 bg-surface-1 hover:border-border-2 hover:bg-surface-2",
                                )}
                                type="button"
                                key={preset.id}
                                aria-pressed={selected}
                                disabled={Boolean(submitting)}
                                title={selected ? `${preset.name} · 点击取消选中` : `${preset.name} · 点击套用模板`}
                                onClick={() => toggleImagePreset(preset)}
                              >
                                <strong className="text-sm font-semibold text-ink-1">{preset.name}</strong>
                                {/* S73 + V-07:副标随行为说全——值域内「预填+切档」,无档如实「无 N:N 档」 */}
                                <span className={selected ? "text-xs text-accent-text" : "text-xs text-ink-2"}>{presetBadgeLabel(preset, imageTierRatioSet)}</span>
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="m-0 text-[11px] text-ink-2">已套「{findImagePreset(imagePresetId)?.name ?? ""}」· 点生成卡「风格」重开模板，再点卡片取消</p>
                )}
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
            <header className="flex items-center justify-between gap-2">
              <h2 className="font-song text-ink-1 text-section-title">提示词</h2>
            </header>
            <AssetChipsRow refs={refs} onPick={insertAssetMention} />
            {/* GP-12 两段式（剧本步 6）：自动段=系统预填上下文，只读呈现；补充段=手输可编辑。
                提交全文=两段拼接（口径同旧单框未编辑态）。 */}
            {(activeKind === "image" ? imageAutoPrompt : videoAutoPrompt).trim() ? (
              <div className="flex flex-col gap-1 rounded-md border border-border-1 bg-surface-2 px-3 py-2" data-testid="prompt-auto-section">
                <span className="text-[11px] font-medium text-ink-4">自动段 · 系统预填（只读）</span>
                <p className="m-0 whitespace-pre-wrap text-sm text-ink-2">{activeKind === "image" ? imageAutoPrompt : videoAutoPrompt}</p>
              </div>
            ) : null}
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-ink-4">补充段 · 手输（可编辑）</span>
            <MentionTextarea
              ref={promptTextareaRef}
              className="min-h-[120px] text-sm"
              candidates={mentionCandidatesFromRefs(refs)}
              value={activeKind === "image" ? imageSupplement : videoSupplement}
              onChange={(value) => (activeKind === "image" ? setImageSupplement(value) : setVideoSupplement(value))}
              placeholder={activeKind === "image" ? "点击 AI 优化生成草稿到自动段，或在这里手输补充画面描述；输入 @ 引用已匹配资产…" : "填写镜头运动、人物动作和环境变化；输入 @ 引用已匹配资产…"}
              aria-label={activeKind === "image" ? "图片提示词" : "视频提示词"}
            />
            </label>
            {/* S66:生成卡底条(libTV 口径)=模型选择 | 参数摘要 | 提示词优化 | 翻译提示词 | ⚡实时估价 | 发送圆钮;
                参数维度化 popover 废整档叉乘列表(R59)——维度与可选值全来自 active 档,查无组合置灰;
                裁决 4:档位接口失败/空档不回落本地档,错误态如实显示+重试。 */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-border-1 bg-surface-2 px-3 py-1.5 text-xs text-ink-2">
              {tierError?.kind === tierKind ? (
                /* S46-A：档错误态收敛到「AI 能力状态」条（模型×档位×开关,角色感知）;
                   重试同时重拉本页档位选择器（onRetry）与状态条三维。 */
                <CapabilityStatusBar
                  className="w-full"
                  kind={tierKind}
                  role={platformRoleForCopy(capabilities)}
                  demoMode={demoMode}
                  onRetry={() => setTierRevision((value) => value + 1)}
                />
              ) : tiersLoading ? (
                <span className="text-ink-4">档位读取中…</span>
              ) : (
                <TierDimensionPopovers
                  tiers={tiers}
                  mediaType={tierKind}
                  selectedTier={selectedTier}
                  onPick={handleDimensionPick}
                />
              )}
              <span className="ml-auto flex flex-wrap items-center gap-x-1 gap-y-1">
                <Tooltip content="按当前文字描述与参考重新起草提示词（写进自动段，补充段手输保留）">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-ink-2 outline-none transition-colors hover:bg-surface-1 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={() => (activeKind === "image" ? setImageAutoPrompt(buildImagePrompt(shot, refs)) : setVideoAutoPrompt(buildVideoPrompt(shot, refs)))}
                  ><Sparkle aria-hidden="true" className="size-3.5" />提示词优化</button>
                </Tooltip>
                <Tooltip content="规划中：提示词中英文互译规划中">
                  <button
                    type="button"
                    aria-disabled="true"
                    className="inline-flex cursor-not-allowed items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-ink-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    onClick={() => undefined}
                  ><Translate aria-hidden="true" className="size-3.5" />翻译提示词</button>
                </Tooltip>
                {/* K-goal-04 条 3:「调整」按钮(参数与版本抽屉)退场——档位切换的唯一入口=底条维度 popover
                    (TierDimensionPopovers),档位/模型摘要=画布标题行 canvasTierText;「视频库与主版本」
                    的唯一入口=生成成功态卡「去视频库选主版本」。 */}
                <span
                  className="flex items-center gap-1 font-mono text-xs"
                  aria-live="polite"
                  title="按当前参数的预估价；点击生成即按正式报价扣费并创建任务，超复核阈值时会再确认一次费用"
                >
                  <Lightning aria-hidden="true" className={cn("size-3.5", estimate.state === "error" ? "text-ink-3" : "text-warning")} />
                  <span className={estimate.state === "error" ? "text-ink-4" : "text-ink-1"}>{estimate.text}</span>
                  {estimate.state === "error" ? (
                    <button
                      type="button"
                      className="rounded-sm px-1 text-accent-text underline underline-offset-4 outline-none transition-colors hover:bg-accent-subtle focus-visible:ring-2 focus-visible:ring-accent"
                      onClick={() => setEstimateRevision((value) => value + 1)}
                    >重试</button>
                  ) : null}
                </span>
                {/* S12-1：viewer 不显示创作按钮（估价行保留只读）;S66:估价被拒=发送键如实禁用（接口拒绝→UI 置灰）;
                    K-goal-04 条 4:点击直接提交不弹窗,submitting 期间按钮禁用(一次点击只创建一个任务) */}
                {canCreate ? (
                <Button
                  variant="primary"
                  size="icon"
                  className="rounded-full"
                  aria-label={activeKind === "image" ? "生成图片" : "生成视频"}
                  icon={activeKind === "image" ? <ImageSquare /> : <VideoCamera />}
                  loading={submitting === activeKind}
                  disabled={Boolean(submitting) || !selectedTier || estimate.state === "error"}
                  title={!selectedTier ? "生成档位未就绪，稍候或点底条「重新读取」" : estimate.state === "error" ? "估价未通过，点 ⚡ 旁「重试」后再发" : "点击即按正式报价生成；超复核阈值时会再确认一次费用"}
                  onClick={() => void startGeneration(activeKind)}
                />
                ) : null}
              </span>
            </div>
            </div>
          </section>
          </div>
          {/* S66:节点卡之外——产物动作行与版本轨道保持原位;
              输出区按媒介归属(视频页签输出=视频,图片产物只在图片页签)。 */}
          {activeKind === "image" && imageMedia ? (
            <div className="flex flex-wrap items-center gap-2">
              {promoteEntryState(imageMedia, demoMode) !== "hidden" ? <Button size="sm" variant="outline" icon={<FolderPlus />} onClick={openPromote} title="把这张图登记为参考资产，下次生成可 @ 引用作 i2v 首帧">转为参考资产</Button> : null}
              {/* D6：跨页流转——图片产物一键归「参考视频」组并切到视频页 */}
              <Button size="sm" variant="outline" icon={<VideoCamera />} onClick={() => useImageAsVideoReference(imageMedia)} title="把这张图挂到参考清单「参考视频」组，并切到视频页">用作视频参考</Button>
              {promoteEntryState(imageMedia, demoMode) !== "hidden" ? <Button size="sm" variant="outline" icon={<GridFour />} onClick={() => openGridSplit(imageMedia)} title="把这张图按宫格等分裁切，逐格入资产库">宫格切分</Button> : null}
              {/* S66:下载/全屏/宫格切分已上移到节点编辑条(libTV 位置);本行留跨页流转动作 */}
              <span className="text-[11px] text-ink-4">产出的图是控制材料：切分或转为参考资产后进参考集</span>
            </div>
          ) : null}
          {railMedia.length > 1 ? (
            <div className="flex items-center gap-2 overflow-x-auto pb-1" aria-label="生成历史版本轨道">
              {railMedia.map((item) => {
                const active = (stageMedia?.id ?? "") === item.id;
                const url = item.thumbnail_url || item.storage_url || "";
                return (
                  <button
                    type="button"
                    className={cn(
                      "relative h-16 w-16 flex-none overflow-hidden rounded-md border bg-surface-well outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-accent",
                      active ? "border-accent ring-2 ring-accent" : "border-border-1 hover:border-border-2",
                    )}
                    key={item.id}
                    title={`${item.media_kind === "video" ? "视频" : "图片"}版本 · 点击预览`}
                    aria-pressed={active}
                    onClick={() => setPreviewId(item.id)}
                  >
                    {item.media_kind === "video" ? (
                      <span className="flex size-full items-center justify-center bg-surface-well text-ink-2">{url ? <img src={url} alt="视频版本" className="size-full object-cover" /> : <VideoCamera className="size-5" aria-hidden="true" />}</span>
                    ) : url ? <img src={url} alt="图片版本" className="size-full object-cover" /> : <span className="flex size-full items-center justify-center text-ink-2"><ImageSquare className="size-5" aria-hidden="true" /></span>}
                    {item.is_primary ? <span className="absolute right-0.5 top-0.5 rounded-full bg-surface-1/85 px-1 text-[10px] text-accent-text">主</span> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {activeTask && activeTask.status !== "succeeded" ? (
            <TaskStateView task={activeTask} busy={submitting === activeKind} mediaKind={activeKind} onRetry={() => void retryGeneration(activeKind)} />
          ) : activeKind === "video" && videoMedia ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-success/40 bg-success/10 px-4 py-3">
              <CheckCircle aria-hidden="true" className="size-5 shrink-0 text-success" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-sm text-ink-1">{videoMedia.is_primary ? "视频主版本已选" : "视频已生成"}</strong>
                <p className="text-xs text-ink-2">{videoMedia.is_primary ? "本集都选好后，可整集连播并下载交付清单。" : "下一步是在视频库选择主版本。"}</p>
              </div>
              {videoMedia.is_primary ? <Button icon={<Play />} onClick={() => navigate(`/projects/${projectId}/storyboards?episode=${episodeId}&playback=1`)}>整集连播</Button> : <Button variant="primary" icon={<FilmStrip />} onClick={() => setShowLibrary(true)}>去视频库选主版本</Button>}
            </div>
          ) : activeKind === "image" && imageMedia ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-success/40 bg-success/10 px-4 py-3">
              <CheckCircle aria-hidden="true" className="size-5 shrink-0 text-success" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <strong className="text-sm text-ink-1">图片已生成</strong>
                <p className="text-xs text-ink-2">确认画面后，切到视频模式继续生成。</p>
              </div>
              <Button variant="primary" icon={<VideoCamera />} onClick={() => openTab("video")}>去生成视频</Button>
            </div>
          ) : null}
            </>
          )}
        </main>
      </div>
      <EpisodeTimeline projectId={projectId} episodeId={episodeId} currentShotId={shotId} demoMode={demoMode} />
      {laneToast ? (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-md border border-success/50 bg-success/10 px-4 py-3 text-xs text-ink-1" role="status">
          <span>{laneToast.text}</span>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => goToLaneOnHome(laneToast.lane)}>去工作台查看</Button>
            <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="关闭提示" title="关闭" onClick={() => setLaneToast(null)}><X /></Button>
          </span>
        </div>
      ) : null}
      {generationError ? (
        <div className="sticky bottom-4 z-10 flex items-center justify-between gap-3 rounded-md border border-danger bg-danger/10 px-4 py-3 text-xs text-danger" role="alert">
          <span>{generationError}</span>
          <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="关闭提示" title="关闭提示" onClick={() => setGenerationError("")}><X /></Button>
        </div>
      ) : null}
      {showLibrary ? <VideoLibrary
        media={allMedia.filter((item) => item.media_kind === "video")}
        shotId={shotId}
        demoMode={demoMode}
        notify={notify}
        onRefresh={mediaState.retry}
        onEditBase={(item) => { setShowLibrary(false); if (new URLSearchParams(window.location.search).has("library")) navigate(window.location.pathname, { replace: true }); setEditBase(item); }}
        onPrimary={(mediaId) => {
          mediaState.setData((current) => current ? { ...current, items: current.items.map((item) => ({ ...item, is_primary: item.id === mediaId })) } : current);
          setShotTasks((current) => current.videoTask
            ? { ...current, videoTask: { ...current.videoTask, media_results: current.videoTask.media_results?.map((item) => ({ ...item, is_primary: item.id === mediaId })) } }
            : current);
          setShotData((current) => current ? { ...current, selected_video_result_id: mediaId } : current);
          window.dispatchEvent(new Event("production-progress-changed"));
        }}
        onClose={() => { setShowLibrary(false); if (new URLSearchParams(window.location.search).has("library")) navigate(window.location.pathname, { replace: true }); }}
      /> : null}
      {assetDrawer ? <AssetPickDrawer
        demoMode={demoMode}
        notify={notify}
        refs={assetState.data?.items ?? []}
        mode={assetDrawer.mode}
        kind={assetDrawer.kind}
        onAdd={addAssetToProject}
        onRemove={removeAssetFromProject}
        onClose={() => setAssetDrawer(null)}
      /> : null}
      {pendingQuote ? <GenerationQuoteModal
        pending={pendingQuote}
        tierLabelText={selectedTier ? tierLabel(selectedTier) : ""}
        onClose={() => {
          if (!["confirming", "submitting"].includes(pendingQuote.status)) setPendingQuote(null);
        }}
        onConfirm={() => void confirmPendingQuote()}
        onRefresh={() => void refreshPendingQuote()}
      /> : null}
      {promoteOpen && imageMedia ? <PromoteToAssetModal
        /* 条 4②：按产物 media id 重挂载——切入口必重置表单，无跨组状态残留 */
        key={imageMedia.id}
        projectId={projectId}
        shot={shot}
        media={imageMedia}
        promptSummary={promotePromptSummary}
        defaultKind={attachTarget ? promoteDefaultKind(laneDef(attachTarget).kinds) : DEFAULT_PROMOTE_KIND}
        sourceLaneLabel={attachTarget ? laneDef(attachTarget).label : null}
        generationRequestId={imageTask?.generation_request_id ?? null}
        demoMode={demoMode}
        notify={notify}
        onClose={() => setPromoteOpen(false)}
        onPromoted={() => {
          notify("已入资产库，下次生成可 @ 引用", "success");
          setPromoteOpen(false);
        }}
      /> : null}
      {gridMedia ? <GridSplitModal
        projectId={projectId}
        shot={shot}
        media={gridMedia}
        demoMode={demoMode}
        notify={notify}
        onClose={() => setGridMedia(null)}
      /> : null}
      {editBase ? <EditComposer
        base={editBase}
        demoMode={demoMode}
        notify={notify}
        submitting={submitting === "video"}
        onSubmit={async (prose, referenceIds) => {
          await runGenerationFlow("video", prose, referenceIds);
          setEditBase(null);
        }}
        onClose={() => setEditBase(null)}
      /> : null}
    </section>
  );
}

/** S78:工作台内「去下一个待生成分镜」入口的取数壳——复用 stepper 同源 hook
   （production-progress-changed 事件 + 15s 轮询，全站独此一处；stepper 不在工作台渲染，
   两者按路由互斥，任何时刻最多一个在跑）。判定与渲染全在 NextPendingShotEntry。 */
function WorkbenchNextPending({ projectId, episodeId, shotId, demoMode }: {
  projectId: string;
  episodeId: string;
  shotId: string;
  demoMode: boolean;
}): React.JSX.Element | null {
  const { records, error, refresh } = useProductionShotRecords(projectId, demoMode);
  return (
    <NextPendingShotEntry
      records={records}
      error={error || undefined}
      onRetry={() => void refresh()}
      projectId={projectId}
      episodeId={episodeId}
      shotId={shotId}
    />
  );
}

/** 整集预览时间线（PNG 24/25 底部）：分镜片段横排，当前分镜高亮，点击切换。 */
function EpisodeTimeline({ projectId, episodeId, currentShotId, demoMode }: {
  projectId: string;
  episodeId: string;
  currentShotId: string;
  demoMode: boolean;
}): React.JSX.Element | null {
  const shotState = useResource(() => api.shots(episodeId), { items: demoShots, count: demoShots.length }, demoMode, [episodeId]);
  const shots = useMemo(
    () => [...(shotState.data?.items ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [shotState.data],
  );
  // W9-C 布局纪律：时间线默认细带（不抢垂直空间），点击展开为完整轨道。
  const [expanded, setExpanded] = useState(false);
  if (shots.length === 0) return null;
  const current = shots.find((shot) => shot.id === currentShotId);
  if (!expanded) {
    return (
      <button
        type="button"
        className="flex items-center justify-between gap-3 rounded-lg border border-border-1 bg-surface-1 px-4 py-2 text-xs text-ink-2 outline-none transition-colors duration-150 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
        aria-expanded={false}
        aria-label="展开整集预览时间线"
        onClick={() => setExpanded(true)}
      >
        <span className="flex items-center gap-2"><FilmStrip aria-hidden="true" className="size-4" />整集预览时间线</span>
        <span>当前 #{current?.shot_no ?? "—"} · 共 {shots.length} 格 · 点击展开</span>
      </button>
    );
  }
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border-1 bg-surface-1 px-4 py-3" aria-label="整集预览时间线">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-2 text-ink-1 text-section-title"><FilmStrip aria-hidden="true" className="size-4" />整集预览时间线</h2>
        <span className="flex items-center gap-3 text-xs text-ink-2">
          当前编辑：粗剪素材 #{current?.shot_no ?? "—"} · 一格对应一段素材视频
          <button type="button" className="text-accent-text underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-expanded={true} onClick={() => setExpanded(false)}>收起</button>
        </span>
      </header>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {shots.map((shot) => {
          const state = timelineShotState(shot);
          const active = shot.id === currentShotId;
          return (
            <button
              className={cn(
                "flex w-[150px] flex-none flex-col gap-1 rounded-md border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                active ? "border-accent bg-accent-subtle" : "border-border-1 bg-surface-2 hover:border-accent/30",
              )}
              type="button"
              key={shot.id}
              onClick={() => shot.id !== currentShotId && navigate(`/projects/${projectId}/storyboards/${episodeId}/shots/${shot.id}`)}
            >
              {/* 有视频才显示播放语义；无视频显示编号块——▷ 不可播时不再误导（critique P2） */}
              <span className={cn("flex h-10 items-center justify-center rounded-sm bg-surface-well", active ? "text-accent-text" : "text-ink-2")} data-has-video={state.kind === "done"}>
                {state.kind === "done" ? <Play aria-hidden="true" className="size-4" /> : <span className="font-mono text-sm">{shot.shot_no ?? "—"}</span>}
              </span>
              <strong className="truncate text-xs font-semibold text-ink-1">{timelineCardTitle(shot)}</strong>
              <small className={cn("text-[11px]", state.kind === "done" ? "text-success" : state.kind === "partial" ? "text-warning" : "text-ink-2")} data-state={state.kind}>{state.label}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function timelineShotState(shot: Shot): { kind: "done" | "partial" | "pending"; label: string } {
  if (shot.selected_video_result_id) return { kind: "done", label: "视频已定" };
  if (shot.selected_image_result_id) return { kind: "partial", label: "图已定 · 待生成视频" };
  return { kind: "pending", label: "待生成" };
}


function GenerationQuoteModal({ pending, tierLabelText, onClose, onConfirm, onRefresh }: {
  pending: PendingGenerationQuote;
  /** 提交链当前选中档标签（含档价）；重试链为空时回落读报价里的 tier_id。 */
  tierLabelText: string;
  onClose: () => void;
  onConfirm: () => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const expired = pending.status === "expired" || quoteIsExpired(pending.quote, now);
  const busy = pending.status === "confirming" || pending.status === "submitting";
  const mediaLabel = pending.mediaKind === "image" ? "1 张图片" : "1 段 4 秒视频";
  const actionLabel = expired
    ? "重新获取费用"
    : pending.status === "failed"
      ? "再次提交"
      : pending.operation === "retry" ? "确认费用并重试" : "确认费用并生成";
  /* 确认卡显示档位与价格（合同 §4）：提交链=选中档标签；重试链=报价透传的 tier_id。
     多模型接缝:price_snapshot 不再带真实 model,档位显示只读 tier_id/选中档标签。 */
  const tierText = pending.operation === "submit" && tierLabelText
    ? tierLabelText
    : pending.quote.tier_id ?? "";
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>本次费用超出复核阈值</DialogTitle>
          <DialogDescription>确认后才会提交付费任务。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <div className="flex items-center gap-3 rounded-md border border-border-1 bg-surface-2 px-3 py-2">
            {pending.mediaKind === "image" ? <ImageSquare className="size-5 shrink-0 text-accent-text" /> : <VideoCamera className="size-5 shrink-0 text-accent-text" />}
            <div className="flex flex-col gap-0.5"><span className="text-xs text-ink-2">{pending.operation === "retry" ? "本次将重试" : "本次将生成"}</span><strong className="text-sm text-ink-1">{mediaLabel}</strong></div>
          </div>
          <div className="flex items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
            <Coins aria-hidden="true" className="size-5 shrink-0 text-warning" />
            <div className="flex flex-col gap-0.5"><span className="text-xs text-ink-2">预估费用</span><strong className="text-sm text-ink-1">{formatCost(pending.quote.estimated_cost_fen)}</strong></div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {tierText ? <><dt className="font-medium text-ink-2">档位</dt><dd className="m-0 font-mono text-ink-1">{tierText}</dd></> : null}
            {typeof pending.quote.price_snapshot?.unit_price_fen === "number" ? <><dt className="font-medium text-ink-2">单价明细</dt><dd className="m-0 font-mono text-ink-1">{formatCost(pending.quote.price_snapshot.unit_price_fen)} / {billingUnitLabel(pending.quote.price_snapshot.billing_unit)} × {pending.quote.price_snapshot.billable_units ?? 1}</dd></> : null}
            <dt className="font-medium text-ink-2">有效时间</dt><dd className="m-0 font-mono text-ink-1">{formatQuoteExpiry(pending.quote.expires_at)}</dd>
            <dt className="font-medium text-ink-2">报价状态</dt><dd className="m-0 font-mono text-ink-1">{expired ? "已过期" : pending.status === "failed" ? "提交失败" : busy ? "正在处理" : "等待确认"}</dd>
          </dl>
          <p className="text-xs leading-relaxed text-ink-2">{pending.quote.notice || "这是预估费用，不是云平台实际账单。"}这次费用超出管理员设置的单次复核阈值，需要你再确认一次；确认后才会提交付费任务。</p>
          {pending.error ? <div className="rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{pending.error}</div> : null}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="primary" icon={expired ? <Clock /> : <CheckCircle />} loading={busy} onClick={expired ? onRefresh : onConfirm}>{actionLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function billingUnitLabel(unit?: "request" | "image" | "second" | "ten_thousand_characters"): string {
  if (unit === "image") return "张";
  if (unit === "second") return "秒";
  if (unit === "ten_thousand_characters") return "万字符";
  return "次";
}

function MediaStage({ kind, media }: { kind: "image" | "video"; media?: MediaResult }): React.JSX.Element {  const url = media?.storage_url || media?.thumbnail_url;
  const well = "flex min-h-[280px] flex-1 items-center justify-center overflow-hidden rounded-lg bg-surface-well";
  if (url && kind === "image") return <div className={well}><img src={url} alt="粗剪素材生成结果" className="max-h-[60vh] max-w-full" /></div>;
  if (url && kind === "video") return <div className={well}><video controls preload="metadata" src={url} className="max-h-[60vh] max-w-full" /></div>;
  const Icon = kind === "image" ? ImageSquare : VideoCamera;
  return (
    <div className={well}>
      <div className="flex flex-col items-center gap-2 p-8 text-center text-ink-3">
        <Icon aria-hidden="true" className="size-6" />
        <strong className="text-sm text-ink-1">{kind === "image" ? "还没有图片" : "暂无视频"}</strong>
        <span className="text-xs">{kind === "image" ? "填写图片提示词后可生成" : "先在图片页签确认一张图，就能按图生成视频；也可以只按提示词生成"}</span>
      </div>
    </div>
  );
}

function VideoLibrary({ media, shotId, demoMode, notify, onRefresh, onPrimary, onEditBase, onClose }: {
  media: MediaResult[];
  shotId: string;
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  onRefresh: () => void;
  onPrimary: (mediaId: string) => void;
  /** W9-C：「基于此版本编辑」入口（EDIT 组装台，基线视频=该版本）。 */
  onEditBase: (item: MediaResult) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [settingPrimary, setSettingPrimary] = useState("");
  const [downloading, setDownloading] = useState("");

  async function setPrimary(item: MediaResult): Promise<void> {
    if (demoMode) return notify("离线演示不会更新主版本。", "info");
    setSettingPrimary(item.id);
    try {
      await api.setShotPrimary(shotId, item.id);
      onPrimary(item.id);
      notify("已设为主版本。本集都选好后，点顶栏「整集连播」预览，点「交付」下载清单。", "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "设置主版本失败", "error");
    } finally {
      setSettingPrimary("");
    }
  }

  async function download(item: MediaResult): Promise<void> {
    if (demoMode) return notify("离线演示没有可下载的真实媒体。", "info");
    setDownloading(item.id);
    try {
      await api.downloadMedia(item.id);
      notify("视频已开始下载", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "下载失败，请稍后重试"), "error");
    } finally {
      setDownloading("");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="large">
        <DialogHeader>
          <DialogTitle>{`视频库（${media.length}/${media.length}）`}</DialogTitle>
          <DialogDescription>选择一个版本设为主版本；下载需通过登录校验。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {media.length === 0 ? <EmptyState title="还没有生成视频" description="真实任务完成并保存后会出现在这里。" icon={<VideoCamera />} /> : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
              {media.map((item) => {
                const downloadable = Boolean(item.storage_url) && UUID_PATTERN.test(item.id);
                return (
                  <article className={cn("flex flex-col gap-2 rounded-md border bg-surface-2 p-2", item.is_primary ? "border-accent" : "border-border-1")} key={item.id}>
                    <video controls preload="metadata" src={item.storage_url || ""} className="aspect-video w-full rounded-sm bg-surface-well object-contain" />
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone={item.is_primary ? "success" : "neutral"}>{item.is_primary ? "当前主版本" : "已保存"}</Badge>
                      <span className="text-xs text-ink-2">{item.created_at ? formatDateTime(item.created_at) : "生成完成"}</span>
                    </div>
                    <footer className="flex flex-wrap gap-2">
                      <Button size="sm" variant={item.is_primary ? "secondary" : "primary"} icon={<CheckCircle />} loading={settingPrimary === item.id} disabled={item.is_primary} onClick={() => void setPrimary(item)}>{item.is_primary ? "当前主版本" : "设为主版本"}</Button>
                      <Button size="sm" variant="outline" icon={<PencilSimple />} title="以这个版本为底做受控编辑，默认全锁，只改你声明的部分" onClick={() => onEditBase(item)}>基于此编辑</Button>
                      <Button size="sm" icon={<DownloadSimple />} loading={downloading === item.id} disabled={!downloadable} title={downloadable ? "通过登录校验后下载" : "结果保存完成后可下载"} onClick={() => void download(item)}>下载</Button>
                    </footer>
                  </article>
                );
              })}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <span className="mr-auto text-xs text-ink-2">{media.length > 0 ? `显示 ${media.length} / ${media.length} 个视频 · 已显示全部视频` : "暂无视频"}</span>
          <Button icon={<ArrowClockwise />} onClick={onRefresh}>刷新</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 任务进行/失败态卡（原 ui.tsx TaskState 的 utility 版，语义与文案保持一致）。 */
function TaskStateView({ task, onRetry, busy, mediaKind }: { task: GenerationTask; onRetry?: () => void; busy?: boolean; mediaKind?: "image" | "video" }): React.JSX.Element {
  const { status, display_reason: displayReason } = task;
  if (status === "failed") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-danger/50 bg-danger/10 px-4 py-3">
        <WarningCircle aria-hidden="true" className="size-5 shrink-0 text-danger" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-sm text-ink-1">生成失败</strong>
          {/* 多模型接缝(FABLE-007):失败原因只读脱敏 display_reason;error-copy 双保险兜底,供应商原文不上屏 */}
          <p className="text-xs text-ink-2">{businessErrorMessage(displayReason, "服务没有返回具体原因，请稍后重试")}</p>
        </div>
        {onRetry ? <Button variant="danger" icon={<ArrowClockwise />} loading={busy} onClick={onRetry}>重试</Button> : null}
      </div>
    );
  }
  if (status === "succeeded") {
    return <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-4 py-3 text-sm text-success"><CheckCircle aria-hidden="true" className="size-5" /><strong>生成完成，结果已保存</strong></div>;
  }
  const queuePositionText = laneTaskQueuePositionText(task);
  const estimatedDurationText = laneTaskEstimatedDurationText(task);
  return (
    <div className="flex items-center gap-3 rounded-md border border-border-1 bg-surface-1 px-4 py-3">
      <SpinnerGap className="size-5 shrink-0 animate-spin text-accent-text" aria-hidden="true" />
      <div className="flex flex-col gap-0.5">
        <strong className="text-sm text-ink-1">{status === "pending" ? "已提交，等待处理" : "正在生成"}</strong>
        <p className="text-xs text-ink-2">{mediaKind === "video" ? "视频生成通常需要几分钟。" : ""}可离开当前页，刷新后会从服务端恢复进度。</p>
        {queuePositionText ? <p className="text-xs text-ink-2">{queuePositionText}</p> : null}
        {estimatedDurationText ? <p className="text-xs text-ink-2">{estimatedDurationText}</p> : null}
      </div>
    </div>
  );
}

function useTaskPolling(task: GenerationTask | null, setTask: (task: GenerationTask) => void, demoMode: boolean, onPollingLost?: () => void): void {
  useEffect(() => {
    if (demoMode || !task || !["pending", "running"].includes(task.status)) return;
    let active = true;
    let failures = 0;
    const timer = window.setInterval(() => {
      void api.generation(task.generation_request_id).then((next) => {
        if (!active) return;
        failures = 0;
        setTask(next);
      }).catch(() => {
        if (!active) return;
        failures += 1;
        // 连续失败不再静默吞掉，提示用户当前状态可能不是最新。
        if (failures === 5) onPollingLost?.();
      });
    }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [demoMode, onPollingLost, setTask, task]);
}

function promptSaveLabel(state: "idle" | "saving" | "saved" | "failed", demoMode: boolean, dirty: boolean): string {
  if (demoMode) return dirty ? " · 离线演示不写入" : "";
  if (state === "idle") return "";
  if (state === "saving") return " · 正在保存…";
  if (state === "saved") return " · 已保存";
  return " · 保存失败，修改后会重试";
}

function buildImagePrompt(shot: Shot, refs: ProjectAssetRef[]): string {
  const names = refs.slice(0, 4).map((ref) => assetName(refAsset(ref))).join("、");
  return `${shot.script_text || shot.title || "画面"}\n使用资产：${names || "未选择"}\n画风：电影级写实，真实光影，人物与服装保持一致。`;
}

function buildVideoPrompt(shot: Shot, refs: ProjectAssetRef[]): string {
  const names = refs.slice(0, 4).map((ref) => assetName(refAsset(ref))).join("、");
  return `[文字描述] ${shot.script_text || shot.title || "人物完成动作"}\n[资产] ${names || "未选择"}\n镜头稳定推进，人物动作连续，保持人物、服装和场景一致。`;
}


function mediaVersionToResult(version: MediaVersion): MediaResult {
  return {
    id: version.id,
    media_kind: version.media_kind || "video",
    storage_url: version.storage_url || version.source_file_url,
    thumbnail_url: version.thumbnail_url,
    download_url: version.download_url || (typeof version.metadata?.download_url === "string" ? version.metadata.download_url : undefined),
    is_primary: version.is_primary,
    created_at: version.created_at,
  };
}

function setGenerationTask(
  kind: GenerationMediaKind,
  task: GenerationTask,
  setImageTask: (task: GenerationTask) => void,
  setVideoTask: (task: GenerationTask) => void,
): void {
  if (kind === "image") setImageTask(task);
  else setVideoTask(task);
}

function freezeGenerationInput(input: TieredGenerationSubmissionInput): TieredGenerationSubmissionInput {
  Object.freeze(input.reference_media_ids);
  Object.freeze(input.parameters);
  Object.freeze(input);
  return input;
}
