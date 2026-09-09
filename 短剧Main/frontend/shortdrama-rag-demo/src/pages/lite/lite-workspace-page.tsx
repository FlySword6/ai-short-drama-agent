/* ============================================================
   lite-workspace-page.tsx — Lite 制作页（workspace）
   整部剧本逐集推进的一集工作台（合并 lite-script-page 的 5 态剧本机
   + lite-shots-page v1.4 收敛后的分镜列表卡 + 分镜卡段⑤ LiteShotVideos）。

   布局（docs/design/prd-v2/lite-ui-rework.md §4.2，定稿）：
  - 无页头（§3.2，2026-08-17 页头退役）：壳单条（lite-shell）承担剧名 /
    制作·资产导航 / ⚙配置；「导入剧本」在左栏剧集头（R2-14，2026-08-17
    起不再独占页顶一整行）。
  - 左栏 = 剧集列表（overflow-y-auto 自己滚）：集号/集名 + 状态点
    （○ 无剧本 / ● 已确认），当前集高亮；hover ✏ 行内改名
    （updateEpisode({ name }) 失焦保存）、⋯ 删除本集（软删确认弹窗）、
    拖动排序（HTML5 dnd → updateEpisode({ sort_order })，R2-13）；
    集名本身即集号标题（第N集 / EPISODE N）时只显示一行，不再叠固定
    「第 N 集」（R2-12）；底部 [+ 新建集]。
  - 右栏 = flex flex-col 固定高：① 状态动作条（5 态机）→ ② 当前集内容
    （固定高）→ ③ 本集资产引用（只读 chips + [去资产页]）→ ④ 分镜区
    （**唯一滚动区** `flex-1 min-h-0 overflow-y-auto`，头部「打包本集成片」）。
  - 全局 ?ep= 跟随：左栏切集即换右栏全部内容。

  付费红线（生图/生视频 = 付费动作）：
  - 一键生成本集（1 次任务）、修改后重新生成（1 次任务）明示次数，
    estimate→confirm→submit 链在 lite-generation / 详情页；本页无卡片级
    出图/出片按钮——卡片只做 v1.4 列表卡 + 段⑤ 成片收纳（看片/定成片/
    下载），重新出片/片段编辑在分镜详情页（lite-shot-detail-page）。
  - 整部导入入口 = 本页两处「导入剧本」按钮（左栏剧集头 + 空项目空态卡）
    共用 openBulkImportPicker → 隐藏文件选择；内容卡不放文件导入按钮（§4.2.2）。
    2026-08-17 修复：空态卡分支也要挂隐藏 input——原先只挂主工作台分支，
    新建项目（0 集）点导入时 ref 为 null，点击无反应。

   状态机（每态完整渲染，数据一律 useResource）：
     进页先读项目 lite_episode_id / URL ?ep=；非空拉该集 script-breakdowns
     取最新 run：queued/running 轮询 / draft 待确认 / confirmed 摘要 + 分镜
     卡网格 / failed 人话原因 + 重新生成 / discarded、superseded 原因 + 重贴。
   幂等键走 newId()（uuid.ts 全站唯一 UUID 入口）；409 lite_script_locked
   → 显眼提示不 crash。
  demoMode 给 1 集已确认 + 2 镜分镜（第 2 镜已出片）的 fixture，离线不读写
  真实数据。
   ============================================================ */
import {
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  ImageSquare,
  LockSimple,
  Note,
  Package,
  PencilSimple,
  Plus,
  Sparkle,
  SpinnerGap,
  Trash,
  UploadSimple,
  Warning,
  WarningCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiClientError,
  api,
  type LiteReferenceAssetItem,
  type ScriptBreakdownAssetCandidate,
  type ScriptBreakdownConfirmResult,
  type ScriptBreakdownRun,
  type ScriptBreakdownRunDetail,
  type ScriptBreakdownShotCandidate,
  type ScriptVersion,
} from "../../api";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Textarea,
} from "../../components/ui/primitives";
import { navigate } from "../../routing";
import { audioKindLabel } from "../../asset-kind-labels";
import type { Episode, GenerationMediaKind, GenerationTask, ListData, MediaVersion, Project, ProjectReviewPolicy, Scene, Shot } from "../../types";
import { EmptyState, useResource } from "../../ui";
import { demoProjectById } from "../../demo";
import { newId } from "../../uuid";
import type { CapabilityGate } from "../../capabilities-state";
import { capabilityGate, capabilityReload } from "../../capabilities-state";
import type { PageRuntimeProps } from "../global-pages";
import { humanErrorMessage, useSlowLoading } from "../batch-generate-drawer";
import type { ProjectMember } from "../../operations";
import { LiteImage, liteImageDisplaySrc } from "./lite-image";
import { mediaDownloadable } from "./lite-media-entries";
import { canDecideLiteReview, liteReviewerNames } from "./lite-review";
import { LiteShotImages } from "./lite-shot-images";
import { LiteShotVideos, type LiteVideoTaskView } from "./lite-shot-videos";
import { liteShotMeta } from "./lite-shot-detail-page";
import { liteProjectPath, liteShotDetailPath, readCurrentEpisodeId } from "./lite-shell";
import {
  forgetPendingLiteRun,
  readPendingLiteRun,
  rememberPendingLiteRun,
  trackLiteEvent,
  type PendingLiteRun,
} from "./lite-telemetry";
import {
  ACTIVE_GENERATION_STATUSES,
  POLL_BASE_MS,
  POLL_FAILURE_NOTICE_THRESHOLD,
  POLL_TOTAL_CAP_MS,
  forgetLiteGenMarker,
  imageCandidatesOf,
  isActiveTask,
  isPollingTarget,
  loadShotMediaMap,
  pollDelayMs,
  primaryImageOf,
  readLiteGenMarkers,
  videoMediaOf,
  type LiteShotMedia,
  type TrackedLiteTask,
} from "./lite-generation";

/** 与 Lite BFF 的 raw_text 上限一致（1–60000 字符）。 */
const MAX_SCRIPT_CHARS = 60_000;

const EMPTY_RUNS: ListData<ScriptBreakdownRun> = { items: [], count: 0 };
const EMPTY_VERSIONS: ListData<ScriptVersion> = { items: [], count: 0 };

/** 集名本身即集号标题（中文「第N集/话」、英文「EPISODE N」）——整剧导入时集名
 *  就是原文标题，左栏只显示这一行，不再叠固定「第 N 集」（R2-12）。 */
const EPISODE_HEADING_NAME_PATTERN = /^(?:第[ \t]*[零〇一二两三四五六七八九十百\d]+[ \t]*[集话]|EPISODE[ \t]*\d+)/iu;

/** 左栏集项两行文案：集名自带集号标题时单行显示集名；否则首行 = 按集名语言
 *  取集号标题（中文名 → 第 N 集，英文名 → EPISODE N），次行 = 集名。 */
export function episodeDisplayLabel(episode: { episode_no: number; name?: string | null }): { primary: string; secondary: string | null; title: string } {
  const name = episode.name?.trim() ?? "";
  /* 空集名走中文默认「第 N 集」（手动建集的产品默认语境）；有集名时按集名语言取标题。 */
  const chinese = /[\u4e00-\u9fff]/u.test(name);
  const marker = !name || chinese ? `第 ${episode.episode_no} 集` : `EPISODE ${episode.episode_no}`;
  if (!name) return { primary: marker, secondary: null, title: marker };
  if (EPISODE_HEADING_NAME_PATTERN.test(name)) return { primary: name, secondary: null, title: name };
  return { primary: marker, secondary: name, title: `${marker} · ${name}` };
}

/** 资产引用条分组标签（asset_kind → 中文；未登记类型原样展示）。 */
const ASSET_KIND_LABELS: Record<string, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  costume: "服装",
  audio: "音频",
};

/** 资产引用条/候选条的类型分组顺序(五类可解析资产;§2 P4)。 */
const ASSET_REF_BAR_GROUPS: Array<{ label: string; kind: "characters" | "scenes" | "props" | "costumes" | "audios" }> = [
  { label: "角色", kind: "characters" },
  { label: "场景", kind: "scenes" },
  { label: "道具", kind: "props" },
  { label: "服装", kind: "costumes" },
  { label: "音频", kind: "audios" },
];

/* ============================================================
   demo fixture：第 1 集已确认（1 人物 1 场景 2 分镜，第 2 镜已出片），
   第 2 集无剧本；离线不读写真实数据。
   ============================================================ */

const DEMO_LITE_EPISODE_ID = "demo-lite-episode";

const DEMO_SCRIPT_TEXT = `夜·内 旧宅客厅
林晚推开门，愣住。
林晚：你怎么会在这里？
林舟：姐，我回来了。`;

const DEMO_RUN: ScriptBreakdownRun = {
  id: "demo-lite-run",
  episodeId: DEMO_LITE_EPISODE_ID,
  scriptVersionId: "demo-lite-version",
  status: "confirmed",
  currentStage: null,
  modelName: null,
  promptVersion: "",
  targetDurationSec: null,
  errorCode: null,
  displayReason: null,
  confirmedAt: "2026-08-10T08:20:00.000Z",
  discardedAt: null,
  supersededByRunId: null,
  createdAt: "2026-08-10T08:00:00.000Z",
  updatedAt: "2026-08-10T08:20:00.000Z",
};

const DEMO_DETAIL: ScriptBreakdownRunDetail = {
  run: DEMO_RUN,
  draft: {
    storySummary: "林晚深夜回到旧宅，意外撞见多年未见的弟弟林舟；姐弟俩在客厅里把当年的误会说开。",
    sceneDivisions: [
      { sceneIndex: 0, name: "旧宅客厅", summary: "重逢与对峙", startLineIndex: 0, endLineIndex: 3 },
    ],
    assetCandidates: {
      characters: [{ candidateId: "demo-c-1", name: "林晚", description: "女主，短发，神情疲惫", gender: "女", ageValue: null, ageStage: "adult", appearance: null, personalityTags: [], prelinkedAsset: null }],
      scenes: [{ candidateId: "demo-s-1", name: "旧宅客厅", description: "夜晚，老式沙发与吊扇" }],
      props: [],
      costumes: [],
      audios: [{ candidateId: "demo-a-1", name: "雨声", description: "夜雨环境声", audioKind: "ambience" }],
    },
    shotCandidates: [
      {
        candidateId: "demo-shot-1",
        shotNo: 1,
        sceneIndex: 0,
        lineIndices: [0, 1],
        elements: null,
        directorPrompt: "全景俯拍：林晚推开旧宅大门，愣在门口",
        imagePrompt: "",
        videoPrompt: "",
        durationSec: 6,
        characterNames: ["林晚"],
        sceneNames: ["旧宅客厅"],
        propNames: [],
        costumeNames: [],
      },
      {
        candidateId: "demo-shot-2",
        shotNo: 2,
        sceneIndex: 0,
        lineIndices: [2, 3],
        elements: null,
        directorPrompt: "近景：林晚看清客厅里的人，惊愕转为愤怒",
        imagePrompt: "",
        videoPrompt: "",
        durationSec: 4,
        characterNames: ["林晚"],
        sceneNames: ["旧宅客厅"],
        propNames: [],
        costumeNames: [],
      },
    ],
  },
  validation: { status: "pass", issues: [], unmatchedAssets: [], duplicateCoverage: [], shotCount: 2, totalDurationSec: 10 },
  stages: [],
};

const DEMO_RUNS: ListData<ScriptBreakdownRun> = { items: [DEMO_RUN], count: 1 };

function demoLiteStill(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="568"><rect width="320" height="568" fill="hsl(${hue},24%,18%)"/><text x="160" y="290" font-size="24" fill="hsl(${hue},30%,72%)" text-anchor="middle" font-family="sans-serif">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const DEMO_LITE_EPISODES: Episode[] = [
  { id: DEMO_LITE_EPISODE_ID, project_id: "p-demo-lite", episode_no: 1, name: "旧宅重逢", synopsis: "" },
  { id: "demo-lite-episode-2", project_id: "p-demo-lite", episode_no: 2, name: "祠堂夜话", synopsis: "" },
];

const DEMO_LITE_SCENES: Scene[] = [
  { id: "demo-lite-scene-1", episode_id: DEMO_LITE_EPISODE_ID, name: "旧宅大门口", sort_order: 1 },
  { id: "demo-lite-scene-2", episode_id: DEMO_LITE_EPISODE_ID, name: "祠堂内", sort_order: 2 },
];

const DEMO_LITE_SHOTS: Shot[] = [
  { id: "demo-lite-shot-1", episode_id: DEMO_LITE_EPISODE_ID, scene_id: "demo-lite-scene-1", shot_no: "1", title: "旧宅门口 · 林晚愣住", script_text: "林晚：你怎么会在这里？", director_prompt: "全景俯拍：林晚推开旧宅大门，愣在门口，吊扇缓慢转动。", duration_seconds: 6, sort_order: 1 },
  { id: "demo-lite-shot-2", episode_id: DEMO_LITE_EPISODE_ID, scene_id: "demo-lite-scene-2", shot_no: "2", title: "客厅 · 姐弟对峙", script_text: "林舟：姐，我回来了。", director_prompt: "近景：林晚看清客厅里的人，惊愕转为愤怒。", duration_seconds: 4, sort_order: 2 },
];

const DEMO_LITE_MEDIA: Record<string, LiteShotMedia> = {
  "demo-lite-shot-1": {
    items: [
      { id: "demo-lite-img-1a", media_kind: "image", storage_url: demoLiteStill("第 1 镜 · 候选 01", 205), is_primary: false, persistence_status: "persisted", review_status: "needs_review", provider_result_key: "image-0", created_at: "2026-08-10T08:30:00.000Z" },
    ],
  },
  "demo-lite-shot-2": {
    items: [
      { id: "demo-lite-img-2a", media_kind: "image", storage_url: demoLiteStill("第 2 镜 · 定稿图", 150), is_primary: true, persistence_status: "persisted", review_status: "accepted", provider_result_key: "image-0", created_at: "2026-08-10T08:20:00.000Z" },
      { id: "demo-lite-vid-2a", media_kind: "video", storage_url: "https://storage.example/demo/lite/shot-2-a.mp4", is_primary: true, persistence_status: "persisted", review_status: "accepted", provider_result_key: "video-0", duration_seconds: 4, created_at: "2026-08-10T08:40:00.000Z" },
      { id: "demo-lite-vid-2b", media_kind: "video", storage_url: "https://storage.example/demo/lite/shot-2-b.mp4", is_primary: false, persistence_status: "persisted", review_status: "accepted", provider_result_key: "video-1", duration_seconds: 4, created_at: "2026-08-10T09:10:00.000Z" },
    ],
  },
};

const DEMO_LITE_REFERENCE_ASSETS: LiteReferenceAssetItem[] = [
  { asset_entity_id: "demo-lite-asset-1", name: "林晚（女主）", kind: "character", asset_media_id: "demo-lite-asset-media-1", storage_url: demoLiteStill("林晚", 205), registered_at: "2026-08-10T09:00:00.000Z" },
  { asset_entity_id: "demo-lite-asset-2", name: "旧宅客厅", kind: "scene", asset_media_id: "demo-lite-asset-media-2", storage_url: demoLiteStill("旧宅客厅", 262), registered_at: "2026-08-10T09:05:00.000Z" },
];

type BusyAction = "submit" | "confirm" | "discard" | null;
type LiteScriptView = "paste" | "processing" | "review" | "confirmed" | "failed";

export function LiteWorkspacePage({ demoMode, notify, user, capabilities, projectId }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  /* ---------- 剧本 5 态机的录入态 ---------- */
  const [rawText, setRawText] = useState("");
  const [submitKey, setSubmitKey] = useState<{ text: string; key: string } | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [lockedMessage, setLockedMessage] = useState("");
  const [confirmResult, setConfirmResult] = useState<ScriptBreakdownConfirmResult | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [justSubmittedRunId, setJustSubmittedRunId] = useState<string | null>(null);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [rerunDialogOpen, setRerunDialogOpen] = useState(false);
  const [creatingEpisode, setCreatingEpisode] = useState(false);
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkPendingFile, setBulkPendingFile] = useState<File | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Episode | null>(null);
  const [deletingEpisode, setDeletingEpisode] = useState(false);
  const [editUnlocked, setEditUnlocked] = useState(false);
  /* 剧本原文默认展开（2026-08-17 用户反馈）：各视图默认可见原文；点卡标题
     左侧的折叠开关可收起（小屏分镜区挤压时用）。 */
  const [scriptDetailsOpen, setScriptDetailsOpen] = useState(true);
  const [autoGenerating, setAutoGenerating] = useState(false);
  const [autoGenStage, setAutoGenStage] = useState<"parsing" | "confirming">("parsing");
  const bulkFileInputRef = useRef<HTMLInputElement>(null);
  const telemetryPendingRunRef = useRef<PendingLiteRun | null>(null);

  /* ---------- 左栏：集名行内改名 ---------- */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /* ---------- 左栏：集拖动排序（R2-13） ---------- */
  const [dragEpisodeId, setDragEpisodeId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  /* 拖拽排序开关（2026-08-17 用户反馈）：默认关——集项不挂 draggable，避免
     误拖；点左栏「拖拽」开启后才可拖，按钮变「完成」，切集自动关闭。 */
  const [dragArmed, setDragArmed] = useState(false);

  /* ---------- 分镜列表卡：编辑弹窗与删除确认 ---------- */
  const [deleteShotTarget, setDeleteShotTarget] = useState<Shot | null>(null);

  const [deletingShot, setDeletingShot] = useState(false);
  const [packing, setPacking] = useState(false);
  const [creatingShot, setCreatingShot] = useState(false);
  const [editShotTarget, setEditShotTarget] = useState<Shot | null>(null);
  const [editShotTitle, setEditShotTitle] = useState("");
  const [editShotPrompt, setEditShotPrompt] = useState("");
  const [savingShotEdit, setSavingShotEdit] = useState(false);

  /* ---------- 进行中任务跟踪（恢复 + 轮询 + 状态徽记；提交本体在详情页） ---------- */
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [primaryBusyId, setPrimaryBusyId] = useState<string | null>(null);
  const [downloadBusyId, setDownloadBusyId] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Record<string, TrackedLiteTask>>({});
  const [pollKick, setPollKick] = useState(0);
  const tasksRef = useRef(tasks);
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const tasksByShot = useMemo(() => {
    const map = new Map<string, TrackedLiteTask[]>();
    for (const tracked of Object.values(tasks)) {
      const list = map.get(tracked.shotId) ?? [];
      list.push(tracked);
      map.set(tracked.shotId, list);
    }
    return map;
  }, [tasks]);

  /* ---------- 数据：项目 → 集 → 分镜 → 逐行媒体 ---------- */
  const demoProject = useMemo<Project>(() => ({ id: projectId, name: demoProjectById(projectId)?.name ?? "演示短剧项目", lite_episode_id: DEMO_LITE_EPISODE_ID }), [projectId]);
  const projectState = useResource(() => api.project(projectId), demoProject, demoMode, [projectId]);
  const project = projectState.data;

  const demoEpisodes = useMemo<ListData<Episode>>(() => ({ items: DEMO_LITE_EPISODES, count: DEMO_LITE_EPISODES.length }), []);
  const episodesState = useResource(() => api.episodes(projectId), demoEpisodes, demoMode, [projectId]);
  /* 显示顺序 = sort_order（拖动排序的持久化字段，R2-13），缺省回落集号。 */
  const episodes = useMemo(
    () => [...(episodesState.data?.items ?? [])].sort(
      (a, b) => (a.sort_order ?? a.episode_no ?? 0) - (b.sort_order ?? b.episode_no ?? 0) || (a.episode_no ?? 0) - (b.episode_no ?? 0),
    ),
    [episodesState.data],
  );

  /* 当前集：URL ?ep= 优先，回退 project.lite_episode_id，再回退列表首集。 */
  const urlEp = readCurrentEpisodeId();
  const episodeId = urlEp ?? project?.lite_episode_id ?? episodes[0]?.id ?? null;

  useEffect(() => {
    if (demoMode || !episodeId) return;
    telemetryPendingRunRef.current = readPendingLiteRun(window.sessionStorage, projectId, episodeId);
    trackLiteEvent({ event: "lite_episode_opened", projectId, episodeId });
  }, [demoMode, projectId, episodeId]);

  const demoRuns = useMemo<ListData<ScriptBreakdownRun>>(
    () => (episodeId === DEMO_LITE_EPISODE_ID ? DEMO_RUNS : EMPTY_RUNS),
    [episodeId],
  );
  const runsState = useResource(
    () => (episodeId ? api.scriptBreakdowns(episodeId) : Promise.resolve(EMPTY_RUNS)),
    demoRuns,
    demoMode,
    [episodeId],
  );
  const runs = useMemo(() => runsState.data?.items ?? [], [runsState.data]);
  const latestRun = useMemo(
    () => [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    [runs],
  );

  const versionsState = useResource(
    () => (episodeId ? api.scriptVersions(episodeId) : Promise.resolve(EMPTY_VERSIONS)),
    EMPTY_VERSIONS,
    demoMode,
    [episodeId],
  );
  const versions = useMemo(() => versionsState.data?.items ?? [], [versionsState.data]);
  const latestVersion = useMemo(
    () => [...versions].sort((a, b) => b.versionNo - a.versionNo)[0] ?? null,
    [versions],
  );

  /* draft 要展示候选、confirmed 恢复时要拿场/镜计数，这两种状态才拉详情。 */
  const needsDetail = latestRun?.status === "draft" || latestRun?.status === "confirmed";
  const detailState = useResource(
    () => (latestRun && needsDetail ? api.scriptBreakdown(latestRun.id) : Promise.resolve(null as ScriptBreakdownRunDetail | null)),
    DEMO_DETAIL as ScriptBreakdownRunDetail | null,
    demoMode,
    [latestRun?.id, latestRun?.status],
  );
  const detail = detailState.data;

  const demoShots = useMemo<ListData<Shot>>(
    () => (episodeId === DEMO_LITE_EPISODE_ID ? { items: DEMO_LITE_SHOTS, count: DEMO_LITE_SHOTS.length } : { items: [], count: 0 }),
    [episodeId],
  );
  const shotsState = useResource(
    () => (episodeId ? api.shots(episodeId) : Promise.resolve({ items: [] as Shot[], count: 0 })),
    demoShots,
    demoMode,
    [episodeId],
  );
  const shots = useMemo(
    () => [...(shotsState.data?.items ?? [])].sort(
      (left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0) || left.shot_no.localeCompare(right.shot_no, "zh-Hans-CN", { numeric: true }),
    ),
    [shotsState.data],
  );
  const lockedPromptCount = useMemo(
    () => shots.filter((shot) => liteShotMeta(shot)?.prompt_locked === true).length,
    [shots],
  );
  const shotIdsKey = shots.map((shot) => shot.id).join(",");

  const demoMedia = useMemo<Record<string, LiteShotMedia>>(
    () => (episodeId === DEMO_LITE_EPISODE_ID ? DEMO_LITE_MEDIA : {}),
    [episodeId],
  );
  const mediaState = useResource(
    () => (shots.length > 0 ? loadShotMediaMap(shots) : Promise.resolve({} as Record<string, LiteShotMedia>)),
    demoMedia,
    demoMode,
    // shotIdsKey 覆盖分镜集变化；shots 本体由 shotsState.data 派生，同口径。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shotIdsKey, episodeId],
  );
  const setMediaMap = mediaState.setData;

  const demoScenes = useMemo<ListData<Scene>>(
    () => (episodeId === DEMO_LITE_EPISODE_ID ? { items: DEMO_LITE_SCENES, count: DEMO_LITE_SCENES.length } : { items: [], count: 0 }),
    [episodeId],
  );
  const scenesState = useResource(
    () => (episodeId ? api.episodeScenes(episodeId) : Promise.resolve({ items: [] as Scene[], count: 0 })),
    demoScenes,
    demoMode,
    [episodeId],
  );
  const sceneById = useMemo(() => new Map((scenesState.data?.items ?? []).map((scene) => [scene.id, scene])), [scenesState.data]);

  const demoReferenceAssets = useMemo(() => ({ items: DEMO_LITE_REFERENCE_ASSETS }), []);
  const referenceAssetsState = useResource(() => api.liteReferenceAssets(projectId), demoReferenceAssets, demoMode, [projectId]);
  const referenceAssets = referenceAssetsState.data?.items ?? [];

  /* ---------- 每集「剧本已确认？」状态点（○ 无剧本 / ● 已确认）。
     当前集以 runsState 为准（权威且实时）；其它集各拉一次 scriptBreakdowns
     缓存进 map，失败静默降级为 ○。demo 固定第 1 集已确认。 ---------- */
  const [episodeScriptState, setEpisodeScriptState] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (demoMode) {
      setEpisodeScriptState({ [DEMO_LITE_EPISODE_ID]: true });
      return;
    }
    if (episodes.length === 0) return;
    let cancelled = false;
    const ids = new Set(episodes.map((episode) => episode.id));
    setEpisodeScriptState((previous) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const key of Object.keys(previous)) {
        if (ids.has(key)) next[key] = previous[key]!;
        else changed = true;
      }
      return changed ? next : previous;
    });
    void Promise.allSettled(episodes.map(async (episode) => {
      const list = await api.scriptBreakdowns(episode.id);
      const latest = [...list.items].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
      return { episodeId: episode.id, confirmed: latest?.status === "confirmed" };
    })).then((results) => {
      if (cancelled) return;
      const next: Record<string, boolean> = {};
      for (const result of results) {
        if (result.status === "fulfilled") next[result.value.episodeId] = result.value.confirmed;
      }
      setEpisodeScriptState(next);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, episodes]);

  /* ---------- 审核人 / 终审权（段⑤ 定成片需要） ---------- */
  const reviewPoliciesState = useResource(
    () => api.reviewPolicies(projectId),
    { items: [] as ProjectReviewPolicy[], count: 0 },
    demoMode,
    [projectId],
  );
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  useEffect(() => {
    if (demoMode) return;
    let cancelled = false;
    api.projectMembers(projectId).then((items) => {
      if (!cancelled) setProjectMembers(items);
    }).catch(() => { /* 普通成员读不到成员列表：等审核条退通称「项目审核人」 */ });
    return () => { cancelled = true; };
  }, [demoMode, projectId]);

  const reviewerUserIdOf = useCallback((kind: GenerationMediaKind): string | null => {
    const policies = reviewPoliciesState.data?.items ?? [];
    return policies.find((policy) => policy.mediaKind === kind)?.reviewerUserId ?? null;
  }, [reviewPoliciesState.data]);

  const reviewerHintOf = useCallback((kind: GenerationMediaKind): string => {
    const names = liteReviewerNames(projectMembers, reviewerUserIdOf(kind));
    return names.length > 0 ? names.join(" / ") : "项目审核人";
  }, [projectMembers, reviewerUserIdOf]);

  /* 段⑤ 终审权四值闸门：demo 演示有一侧终审权；真栈镜像后端 canDecideProjectReview。 */
  const reviewGateImage: CapabilityGate = demoMode
    ? "allowed"
    : capabilityGate(capabilities, (caps) => canDecideLiteReview(caps, projectId, user.id, reviewerUserIdOf("image")));

  const reviewGateVideo: CapabilityGate = demoMode
    ? "allowed"
    : capabilityGate(capabilities, (caps) => canDecideLiteReview(caps, projectId, user.id, reviewerUserIdOf("video")));
  const onReloadCapabilities = capabilityReload(capabilities) ?? (() => {});

  /* ---------- 列表刷新追上刚提交的 run 后，摘掉「等列表」标记 ---------- */
  useEffect(() => {
    if (justSubmittedRunId && latestRun?.id === justSubmittedRunId) setJustSubmittedRunId(null);
  }, [justSubmittedRunId, latestRun]);

  const waitingForSubmittedRun = justSubmittedRunId != null && latestRun?.id !== justSubmittedRunId;
  const runActive = latestRun?.status === "queued" || latestRun?.status === "running";

  /* 切集时清空录入态：每集有独立的剧本与解析状态，上一集的文本不能泄到下一集。 */
  useEffect(() => {
    setRawText("");
    setConfirmResult(null);
    setDismissedRunId(null);
    setSubmitKey(null);
    setLockedMessage("");
    setEditUnlocked(false);
    setAutoGenerating(false);
    setScriptDetailsOpen(true);
    setDragArmed(false);
  }, [episodeId]);

  /* demo 回填：切到 demo 已确认集时把剧本原文填进文本框（真栈走下面的回填 effect）。 */
  useEffect(() => {
    if (demoMode && episodeId === DEMO_LITE_EPISODE_ID && !rawText.trim()) {
      setRawText(DEMO_SCRIPT_TEXT);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, episodeId]);

  /* 原文回填：切集后从最新版本把文本放回剧本框（整剧导入只建 version 不解析，靠这里回显）。
     关键守卫——本会话刚提交的 run（justSubmittedRunId === latestRun.id）期间不回填：
     rawText 就是用户刚输入的原文，若此时用 latestVersion 覆盖，而 versionsState 尚未
     刷新（latestVersion 停在旧 version），会把新原文覆盖成旧原文。解析失败时尤其致命。 */
  useEffect(() => {
    if (!episodeId || demoMode || runActive) return;
    if (editUnlocked || autoGenerating) return;
    if (latestRun && justSubmittedRunId === latestRun.id) return;
    if (latestVersion?.scriptText) setRawText(latestVersion.scriptText);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId, latestVersion?.id, latestRun?.id, latestRun?.status, runActive, editUnlocked, demoMode, autoGenerating, justSubmittedRunId, latestRun]);

  /* 一键生成采用是服务端行为(§2 P2):提交带 auto_confirm,拆解定稿后服务端直接
     确认(run → confirmed),前端只轮询 runs;run 落 confirmed/draft/failed 即摘掉
     处理态(view 判定不再依赖内存态 autoGenerating)。只有服务端确认失败回落 draft
     时才保留手动确认兜底。 */
  useEffect(() => {
    if (!autoGenerating || !latestRun) return;
    if (latestRun.status === "confirmed") {
      setAutoGenerating(false);
      runsState.retry();
      shotsState.retry();
      scenesState.retry();
      versionsState.retry();
      referenceAssetsState.retry();
      notify("一键生成完成", "success");
    } else if (latestRun.status === "draft") {
      // 服务端确认失败回落:客户端兜底尝试一次,失败交手动确认。
      setAutoGenStage("confirming");
      void api.confirmScriptBreakdown(latestRun.id).then((result) => {
        if (episodeId) {
          trackLiteEvent({
            event: "lite_script_confirmed",
            projectId,
            episodeId,
            runId: latestRun.id,
            mode: "auto",
            outcome: result.outcome,
            sceneCount: result.sceneCount,
            shotCount: result.shotCount,
          });
          forgetPendingLiteRun(window.sessionStorage, projectId, episodeId);
          telemetryPendingRunRef.current = null;
        }
        setAutoGenerating(false);
        setConfirmResult(result);
        notify("一键生成完成", "success");
      }).catch(() => {
        setAutoGenerating(false);
        notify("自动确认失败，请在草稿页手动确认", "error");
      });
    } else if (latestRun.status === "failed") {
      setAutoGenerating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoGenerating, latestRun?.status, latestRun?.id]);

  /* 排队中/解析中每 3s 拉一次 runs 列表，直到出结果（解析是异步的）。 */
  useEffect(() => {
    if (demoMode || (!waitingForSubmittedRun && !runActive)) return;
    const timer = window.setInterval(() => {
      runsState.retry();
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, waitingForSubmittedRun, runActive, runsState.retry]);

  const dismissed = latestRun != null && dismissedRunId === latestRun.id;
  const view: LiteScriptView = confirmResult
    ? "confirmed"
    : autoGenerating || waitingForSubmittedRun
      ? "processing"
      : !latestRun || dismissed
        ? "paste"
        : latestRun.status === "queued" || latestRun.status === "running"
          ? "processing"
          : latestRun.status === "draft"
            ? "review"
            : latestRun.status === "confirmed"
              ? "confirmed"
              : latestRun.status === "failed"
                ? "failed"
                : "paste";

  let pasteNotice: string | null = null;
  if (view === "paste" && latestRun) {
    if (latestRun.status === "discarded") pasteNotice = "上一份解析结果已放弃，没有写入任何正式内容；剧本修改后可以重新解析。";
    else if (latestRun.status === "superseded") pasteNotice = "上一份解析已被更新的结果替换；可以重新粘贴再解析。";
    else if (latestRun.status === "failed" && dismissed) pasteNotice = "剧本原文还留着，可以直接修改后重新解析。";
  }

  const confirmedCounts = confirmResult
    ? { scenes: confirmResult.sceneCount, shots: confirmResult.shotCount }
    : detail
      ? { scenes: detail.draft.sceneDivisions.length, shots: detail.validation.shotCount || detail.draft.shotCandidates.length }
      : null;

  useEffect(() => {
    const pending = telemetryPendingRunRef.current;
    if (demoMode || !episodeId || !pending || latestRun?.id !== pending.runId) return;
    if (latestRun.status === "failed") {
      trackLiteEvent({
        event: "lite_script_failed",
        projectId,
        episodeId,
        runId: pending.runId,
        completedAt: latestRun.updatedAt,
      });
      forgetPendingLiteRun(window.sessionStorage, projectId, episodeId);
      telemetryPendingRunRef.current = null;
      return;
    }
    if (latestRun.status !== "confirmed" || detail?.run.id !== pending.runId) return;
    trackLiteEvent({
      event: "lite_script_confirmed",
      projectId,
      episodeId,
      runId: pending.runId,
      mode: "auto",
      outcome: "confirmed",
      sceneCount: detail.draft.sceneDivisions.length,
      shotCount: detail.validation.shotCount,
      completedAt: latestRun.confirmedAt ?? latestRun.updatedAt,
    });
    forgetPendingLiteRun(window.sessionStorage, projectId, episodeId);
    telemetryPendingRunRef.current = null;
  }, [demoMode, detail, episodeId, latestRun?.confirmedAt, latestRun?.id, latestRun?.status, latestRun?.updatedAt, projectId]);

  const currentEpisode = episodes.find((episode) => episode.id === episodeId) ?? null;
  const episodeNo = currentEpisode?.episode_no ?? 1;

  /* ============================================================
     剧本机动作
     ============================================================ */

  async function confirmDraft(): Promise<void> {
    const run = detail?.run ?? latestRun;
    if (!run || busy) return;
    if (demoMode) {
      notify("离线演示不会写入正式分镜", "info");
      return;
    }
    setBusy("confirm");
    try {
      const result = await api.confirmScriptBreakdown(run.id);
      if (episodeId) {
        trackLiteEvent({
          event: "lite_script_confirmed",
          projectId,
          episodeId,
          runId: run.id,
          mode: "manual",
          outcome: result.outcome,
          sceneCount: result.sceneCount,
          shotCount: result.shotCount,
        });
        forgetPendingLiteRun(window.sessionStorage, projectId, episodeId);
        telemetryPendingRunRef.current = null;
      }
      setConfirmResult(result);
      notify(
        result.outcome === "already_confirmed"
          ? "这份解析此前已经采用过"
          : `已采用：${result.sceneCount} 场、${result.shotCount} 个分镜`,
        "success",
      );
      // 确认后统一刷新各数据源(§2 P3):只刷 runs 会让分镜区渲染确认前的旧数据。
      runsState.retry();
      shotsState.retry();
      scenesState.retry();
      versionsState.retry();
      referenceAssetsState.retry();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "采用失败，请重试", "error");
    } finally {
      setBusy(null);
    }
  }

  async function discardDraft(): Promise<void> {
    const run = detail?.run ?? latestRun;
    if (!run || busy) return;
    if (demoMode) {
      setDiscardDialogOpen(false);
      notify("离线演示不会改动解析结果", "info");
      return;
    }
    setBusy("discard");
    try {
      await api.discardScriptBreakdown(run.id);
      if (episodeId) {
        trackLiteEvent({ event: "lite_script_discarded", projectId, episodeId, runId: run.id });
        forgetPendingLiteRun(window.sessionStorage, projectId, episodeId);
        telemetryPendingRunRef.current = null;
      }
      setDiscardDialogOpen(false);
      setConfirmResult(null);
      setDismissedRunId(run.id);
      notify("已放弃这份解析，可以修改剧本后重新解析", "success");
      runsState.retry();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "操作失败，请重试", "error");
    } finally {
      setBusy(null);
    }
  }

  /** 新建集：按 max(episode_no)+1 建，建完导航到新集（demo 本地建，方便探索）。 */
  async function handleCreateEpisode(): Promise<void> {
    if (creatingEpisode) return;
    setCreatingEpisode(true);
    try {
      if (demoMode) {
        const nextNo = episodes.length > 0 ? Math.max(...episodes.map((ep) => ep.episode_no)) + 1 : 1;
        const created: Episode = { id: `demo-lite-episode-${Date.now()}`, project_id: projectId, episode_no: nextNo, name: `第${nextNo}集`, synopsis: "" };
        episodesState.setData((previous) => (previous ? { items: [...previous.items, created], count: previous.count + 1 } : previous));
        navigate(liteProjectPath(projectId, "workspace", created.id));
        return;
      }
      const nextNo = episodes.length > 0 ? Math.max(...episodes.map((ep) => ep.episode_no)) + 1 : 1;
      const created = await api.createEpisode(projectId, { title: `第${nextNo}集`, episode_no: nextNo });
      episodesState.retry();
      setRawText("");
      setConfirmResult(null);
      setDismissedRunId(null);
      navigate(liteProjectPath(projectId, "workspace", created.id));
      notify(`已新建第 ${nextNo} 集`, "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "新建集失败，请重试", "error");
    } finally {
      setCreatingEpisode(false);
    }
  }

  /** 删集（软删；当前产品没有集恢复入口）。 */
  async function handleDeleteEpisode(): Promise<void> {
    if (!deleteTarget) return;
    if (demoMode) {
      setDeleteTarget(null);
      notify("离线演示不会删除集", "info");
      return;
    }
    setDeletingEpisode(true);
    try {
      await api.deleteEpisode(deleteTarget.id);
      setDeleteTarget(null);
      episodesState.retry();
      const remaining = episodes.filter((ep) => ep.id !== deleteTarget.id);
      const next = remaining[0]?.id ?? null;
      navigate(next ? liteProjectPath(projectId, "workspace", next) : liteProjectPath(projectId, "workspace"));
      notify(`第 ${deleteTarget.episode_no} 集已删除，当前没有恢复入口`, "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "删除失败，请重试", "error");
    } finally {
      setDeletingEpisode(false);
    }
  }

  /** 集名行内改名（失焦自动保存，同剧本正文保存模式）。 */
  async function saveEpisodeRename(episode: Episode): Promise<void> {
    const next = renameValue.trim();
    setRenamingId(null);
    const current = episode.name?.trim() ?? "";
    if (!next || next === current) return;
    if (demoMode) {
      notify("离线演示不会保存集名", "info");
      return;
    }
    try {
      const updated = await api.updateEpisode(episode.id, { name: next });
      episodesState.setData((previous) => (previous ? { items: previous.items.map((item) => (item.id === episode.id ? updated : item)), count: previous.count } : previous));
    } catch (reason) {
      notify(humanErrorMessage(reason, "保存集名失败"), "error");
    }
  }

  /** 集拖动排序（R2-13）：落点 = 被拖集移到目标集的位置。本地乐观重排，
   *  逐集 PATCH sort_order（只提交变化的集）；失败重拉回滚。demo 只本地排。 */
  async function handleEpisodeDrop(targetId: string): Promise<void> {
    const sourceId = dragEpisodeId;
    setDragEpisodeId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId) return;
    const fromIndex = episodes.findIndex((ep) => ep.id === sourceId);
    const toIndex = episodes.findIndex((ep) => ep.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextOrder = [...episodes];
    const [moved] = nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, moved!);
    const applyOrder = (): void => {
      episodesState.setData((previous) => (previous ? {
        items: nextOrder.map((ep, index) => ({ ...ep, sort_order: index + 1 })),
        count: previous.count,
      } : previous));
    };
    applyOrder();
    if (demoMode) return;
    try {
      for (const [index, episode] of nextOrder.entries()) {
        if ((episode.sort_order ?? episode.episode_no) !== index + 1) {
          await api.updateEpisode(episode.id, { sort_order: index + 1 });
        }
      }
    } catch (reason) {
      episodesState.retry();
      notify(humanErrorMessage(reason, "保存集顺序失败"), "error");
    }
  }

  /** 整剧导入选文件入口：项目已有集时先弹覆盖确认（导入会替换现有全部集），空项目直接导入。 */
  function pickBulkFile(file: File): void {
    if (demoMode) {
      notify("离线演示不会上传整部剧本", "info");
      return;
    }
    if (episodes.length > 0) {
      setBulkPendingFile(file);
      return;
    }
    void handleImportBulk(file);
  }

  /** 页内「导入剧本」按钮统一入口（左栏剧集头 + 空项目空态卡）：直接点隐藏
   *  文件选择。2026-08-17 起 R2-11 的壳按钮已并入本页，事件中转退役，按钮直调。 */
  function openBulkImportPicker(): void {
    if (bulkImporting) return;
    bulkFileInputRef.current?.click();
  }

  /** 整部剧本导入：上传一个大文件 → 后端按集标题拆分 → 覆盖现有集后逐集建 episode + 剧本版本。 */
  async function handleImportBulk(file: File): Promise<void> {
    if (demoMode) {
      notify("离线演示不会上传整部剧本", "info");
      return;
    }
    if (bulkImporting) return;
    setBulkImporting(true);
    try {
      const result = await api.liteImportBulkScript(projectId, file);
      episodesState.retry();
      versionsState.retry();
      runsState.retry();
      const first = result.episodes[0];
      if (first) navigate(liteProjectPath(projectId, "workspace", first.episode_id));
      const imported = result.episodes.length === 1
        ? "文件没有集标题，已作为一集导入"
        : `已导入 ${result.episodes.length} 集`;
      notify(result.replaced > 0 ? `${imported}（已覆盖原来的 ${result.replaced} 集）` : imported, "success");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "整部剧本导入失败，请重试", "error");
    } finally {
      setBulkImporting(false);
    }
  }

  /** 一键生成本集：提交 → 轮询解析 → 自动确认 → 留在本页切到已确认 + 分镜卡。 */
  async function autoGenerate(): Promise<void> {
    if (busy || autoGenerating) return;
    if (!rawText.trim()) {
      notify("请先粘贴剧本原文", "error");
      return;
    }
    if (demoMode) {
      notify("离线演示不会一键生成", "info");
      return;
    }
    if (!episodeId) {
      notify("请先选择或新建一集", "error");
      return;
    }
    setAutoGenerating(true);
    setAutoGenStage("parsing");
    setBusy("submit");
    setLockedMessage("");
    try {
      const key = submitKey && submitKey.text === rawText ? submitKey.key : newId();
      setSubmitKey({ text: rawText, key });
      const rework = latestRun !== null || shots.length > 0;
      const result = await api.liteSubmitScript(projectId, { episode_id: episodeId, raw_text: rawText, client_idempotency_key: key, auto_confirm: true });
      telemetryPendingRunRef.current = { runId: result.run_id };
      rememberPendingLiteRun(window.sessionStorage, projectId, episodeId, { runId: result.run_id });
      trackLiteEvent({
        event: "lite_script_submitted",
        projectId,
        episodeId,
        runId: result.run_id,
        rework,
        outcome: result.outcome,
      });
      setSubmitKey(null);
      setConfirmResult(null);
      setDismissedRunId(null);
      setJustSubmittedRunId(result.run_id);
      projectState.retry();
      runsState.retry();
      /* 同步刷新 script versions：否则回填 effect 会拿到 stale 的旧 version，
         在 run failed 时用它覆盖 rawText（丢失用户刚提交的原文）。 */
      versionsState.retry();
      notify("剧本已提交，正在解析…", "success");
      /* 服务端 auto_confirm 定稿即确认;轮询到 confirmed 后由 effect 收尾(§2 P2)。 */
    } catch (reason) {
      setAutoGenerating(false);
      if (reason instanceof ApiClientError && reason.code === "lite_run_in_flight") {
        setLockedMessage("这一集正在解析中，请稍候");
      } else if (reason instanceof ApiClientError && (reason.code === "lite_script_locked" || reason.status === 409)) {
        setLockedMessage("这一集已经有成片了，不能重新解析。");
      } else {
        notify(reason instanceof Error ? reason.message : "提交失败，请重试", "error");
      }
    } finally {
      setBusy(null);
    }
  }

  /* ============================================================
     分镜卡动作（卡片不做生成；成片收纳 + 就地审核 + 下载）
     ============================================================ */

  /** 单行媒体刷新（生成成功/恢复后）；失败保留旧数据并把错误摆到该行。 */
  const refreshShotMedia = useCallback(async (shotId: string): Promise<void> => {
    if (demoMode) return;
    try {
      const list = await api.shotMedia(shotId);
      setMediaMap((previous) => ({ ...(previous ?? {}), [shotId]: { items: list.items } }));
    } catch (reason) {
      setMediaMap((previous) => ({
        ...(previous ?? {}),
        [shotId]: { items: previous?.[shotId]?.items ?? [], error: humanErrorMessage(reason, "读取失败") },
      }));
    }
  }, [demoMode, setMediaMap]);

  const patchTask = useCallback((requestId: string, patch: (current: TrackedLiteTask) => TrackedLiteTask | null): void => {
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

  const handleTaskSettled = useCallback((tracked: TrackedLiteTask, next: GenerationTask): void => {
    forgetLiteGenMarker(window.sessionStorage, tracked.shotId, tracked.kind);
    if (next.status === "succeeded") {
      patchTask(tracked.requestId, () => null);
      void refreshShotMedia(tracked.shotId);
      notify(tracked.kind === "image" ? "候选图已生成，可直接在卡片上挑一张定为首帧" : "视频已生成，可到分镜详情页查看", "success");
      return;
    }
    if (next.status === "cancelled") {
      patchTask(tracked.requestId, () => null);
      return;
    }
    /* failed：留卡展示人话原因 + 去详情处理。 */
    patchTask(tracked.requestId, (current) => ({ ...current, task: next }));
  }, [notify, patchTask, refreshShotMedia]);

  const handleTaskGone = useCallback((tracked: TrackedLiteTask): void => {
    /* 403/404 = 任务已不可见（环境重置/越权）：摘除台账与卡片，不留永远的假「生成中」。 */
    forgetLiteGenMarker(window.sessionStorage, tracked.shotId, tracked.kind);
    patchTask(tracked.requestId, () => null);
  }, [patchTask]);

  /* 轮询 effect 经 ref 调最新回调（回调依赖 notify 等渲染域值，不进轮询依赖）。 */
  const handleTaskSettledRef = useRef(handleTaskSettled);
  useEffect(() => { handleTaskSettledRef.current = handleTaskSettled; }, [handleTaskSettled]);
  const handleTaskGoneRef = useRef(handleTaskGone);
  useEffect(() => { handleTaskGoneRef.current = handleTaskGone; }, [handleTaskGone]);

  /* ---------- 轮询 hook：3s 起始、指数退避 15s 封顶、30 分钟总上限、
     标签页隐藏暂停 + 恢复即查、卸载清理。kick 变化（新任务/手动刷新）时重新布防。 ---------- */
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

  /* ---------- 挂载恢复：projectGenerations 进行中清单 × sessionStorage 台账 → 回行；
     台账外的进行中任务不强行归属（generationData 无 shot_id），页顶计数提示。 ---------- */
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
      const markers = readLiteGenMarkers(window.sessionStorage);
      const now = Date.now();
      const restored: Record<string, TrackedLiteTask> = {};
      const mappedRequestIds = new Set<string>();
      for (const { shotId, kind, marker } of markers) {
        if (!marker.requestId) continue;
        const activeTask = inflight.find((task) => task.generation_request_id === marker.requestId);
        if (activeTask) {
          mappedRequestIds.add(activeTask.generation_request_id);
          restored[activeTask.generation_request_id] = {
            requestId: activeTask.generation_request_id,
            shotId,
            kind,
            task: activeTask,
            firstPollAt: now,
            pollCount: 0,
            pollFailures: 0,
            nextPollAt: now + POLL_BASE_MS,
            timedOut: false,
          };
          continue;
        }
        /* 台账里的任务不在本项目进行中清单：查一次真态——成功刷新该行候选、失败留卡可重试、
           取消/查不到摘除；仍在进行中 = 别的项目的任务（同一标签页台账跨项目共存），原样保留。 */
        try {
          const settled = await api.generation(marker.requestId);
          if (cancelled) return;
          if (settled.status === "succeeded") {
            forgetLiteGenMarker(window.sessionStorage, shotId, kind);
            void refreshShotMedia(shotId);
          } else if (settled.status === "failed") {
            restored[marker.requestId] = {
              requestId: marker.requestId,
              shotId,
              kind,
              task: settled,
              firstPollAt: now,
              pollCount: 0,
              pollFailures: 0,
              nextPollAt: now,
              timedOut: false,
            };
            forgetLiteGenMarker(window.sessionStorage, shotId, kind);
          } else if (settled.status === "cancelled") {
            forgetLiteGenMarker(window.sessionStorage, shotId, kind);
          }
        } catch (reason) {
          if (reason instanceof ApiClientError && (reason.status === 403 || reason.status === 404)) {
            forgetLiteGenMarker(window.sessionStorage, shotId, kind);
          }
        }
      }
      if (cancelled) return;
      /* 合并而非覆盖：恢复是异步的，期间本页新任务（在 previous 里）不能被清掉。 */
      setTasks((previous) => ({ ...restored, ...previous }));
      setPollKick((value) => value + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [demoMode, projectId, refreshShotMedia]);

  /** 超时/疑似掉线后的手动刷新：查一次真态；仍在进行中则重开一轮轮询窗口（不自动重发任务）。 */
  async function refreshTaskNow(tracked: TrackedLiteTask): Promise<void> {
    if (demoMode || refreshingId !== null) return;
    setRefreshingId(tracked.requestId);
    try {
      const next = await api.generation(tracked.requestId);
      if (!ACTIVE_GENERATION_STATUSES.includes(next.status)) {
        handleTaskSettled(tracked, next);
        return;
      }
      const now = Date.now();
      patchTask(tracked.requestId, (current) => ({
        ...current,
        task: next,
        firstPollAt: now,
        pollCount: 0,
        pollFailures: 0,
        nextPollAt: now + POLL_BASE_MS,
        timedOut: false,
      }));
      setPollKick((value) => value + 1);
    } catch (reason) {
      if (reason instanceof ApiClientError && (reason.status === 403 || reason.status === 404)) {
        handleTaskGone(tracked);
        return;
      }
      notify(humanErrorMessage(reason, "刷新失败，请稍后再试"), "error");
    } finally {
      setRefreshingId(null);
    }
  }

  /** 「通过并选用」/「改用这张」/「定成这一镜的片」共用一个动作：
      产物待审 → 先裁决通过（media-reviews/decisions），再 set-primary；已自动过审
      （accepted）直接 set-primary。中间任一步失败只报一句人话 + 可重试。 */
  async function approveAndSelect(shot: Shot, media: MediaVersion): Promise<void> {
    if (media.is_primary === true) return;
    if (demoMode) {
      notify("离线演示不写入选用结果", "info");
      return;
    }
    if (primaryBusyId !== null) return;
    setPrimaryBusyId(media.id);
    try {
      if (media.review_status === "needs_review") {
        await api.decideMediaReviews(projectId, [{ media_result_id: media.id, action: "approve" }]);
      }
      await api.setShotPrimary(shot.id, media.id);
      await refreshShotMedia(shot.id);
      const mediaKind = media.media_kind === "video"
        ? "video"
        : media.media_kind === "audio"
          ? "audio"
          : media.media_kind === "image"
            ? "image"
            : null;
      if (episodeId && mediaKind) {
        trackLiteEvent({
          event: "lite_media_selected",
          projectId,
          episodeId,
          shotId: shot.id,
          mediaId: media.id,
          mediaKind,
          approvedInAction: media.review_status === "needs_review",
        });
      }
      notify(media.media_kind === "video" ? `第 ${shot.shot_no} 镜定了这条成片` : `第 ${shot.shot_no} 镜定了这张`, "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "没有定成，请重试"), "error");
    } finally {
      setPrimaryBusyId(null);
    }
  }

  /** 下载（Bearer 鉴权 fetch → blob 保存；后端只认 Authorization 头）。 */
  async function downloadMedia(media: MediaVersion): Promise<void> {
    if (demoMode) {
      notify("离线演示模式，不下载真实文件", "info");
      return;
    }
    if (downloadBusyId !== null) return;
    setDownloadBusyId(media.id);
    try {
      await api.downloadMedia(media.id);
      notify("已开始下载", "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "下载失败，请重试"), "error");
    } finally {
      setDownloadBusyId(null);
    }
  }


  /** 删除分镜：软删 + 确认弹窗；当前产品没有分镜恢复入口。 */
  async function handleDeleteShot(): Promise<void> {
    const shot = deleteShotTarget;
    if (!shot) return;
    if (demoMode) {
      setDeleteShotTarget(null);
      notify("离线演示不会删除分镜", "info");
      return;
    }
    setDeletingShot(true);
    try {
      await api.request(`/shots/${encodeURIComponent(shot.id)}`, { method: "DELETE" });
      setDeleteShotTarget(null);
      shotsState.setData((previous) => (previous ? { items: previous.items.filter((item) => item.id !== shot.id), count: Math.max(0, previous.count - 1) } : previous));
      if (episodeId) {
        trackLiteEvent({ event: "lite_shot_mutated", projectId, episodeId, shotId: shot.id, action: "deleted" });
      }
      notify(`第 ${shot.shot_no} 镜已删除，当前没有恢复入口`, "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "删除分镜失败，请重试"), "error");
    } finally {
      setDeletingShot(false);
    }
  }

  /** 新建分镜：按 max(sort_order)+1 排到末尾，镜号取 max(shot_no 数值)+1。
      建完留在制作页，用户可直接编辑画面描述或去详情页出图。 */
  async function handleCreateShot(): Promise<void> {
    if (creatingShot) return;
    if (!episodeId) return;
    setCreatingShot(true);
    try {
      if (demoMode) {
        const nextNo = shots.length > 0
          ? Math.max(...shots.map((s) => parseInt(s.shot_no, 10)).filter(Number.isFinite)) + 1
          : 1;
        const nextSort = shots.length > 0
          ? Math.max(...shots.map((s) => s.sort_order ?? 0)) + 1
          : 1;
        const created: Shot = {
          id: `demo-lite-shot-${Date.now()}`,
          episode_id: episodeId,
          shot_no: String(nextNo),
          title: null,
          director_prompt: "",
          sort_order: nextSort,
        };
        shotsState.setData((previous) => (previous ? { items: [...previous.items, created], count: previous.count + 1 } : previous));
        notify(`已新建第 ${nextNo} 镜`, "success");
        return;
      }
      const nextNo = shots.length > 0
        ? Math.max(...shots.map((s) => parseInt(s.shot_no, 10)).filter(Number.isFinite)) + 1
        : 1;
      const nextSort = shots.length > 0
        ? Math.max(...shots.map((s) => s.sort_order ?? 0)) + 1
        : 1;
      const created = await api.createShot(episodeId, {
        shot_no: String(nextNo),
        sort_order: nextSort,
        title: null,
        director_prompt: "",
      });
      shotsState.setData((previous) => (previous ? { items: [...previous.items, created], count: previous.count + 1 } : previous));
      trackLiteEvent({ event: "lite_shot_mutated", projectId, episodeId, shotId: created.id, action: "created" });
      notify(`已新建第 ${nextNo} 镜`, "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "新建分镜失败，请重试"), "error");
    } finally {
      setCreatingShot(false);
    }
  }

  /** 集级打包：收集当前 ?ep= 下所有已定稿（is_primary）且转存完成（mediaDownloadable）
      的成片，逐条下载。服务端过滤持久化（persisted）才可下载，复用闸门不另抄判定。 */
  async function handlePackEpisode(): Promise<void> {
    if (demoMode) {
      notify("离线演示不会写入下载", "info");
      return;
    }
    const downloadable: MediaVersion[] = [];
    for (const shot of shots) {
      const media = mediaState.data?.[shot.id];
      for (const video of videoMediaOf(media)) {
        if (video.is_primary === true && mediaDownloadable(video)) downloadable.push(video);
      }
    }
    if (downloadable.length === 0) {
      notify("本集还没有已定稿且转存完成的成片，先到分镜卡出片、定成片后再打包", "info");
      return;
    }
    if (packing) return;
    setPacking(true);
    try {
      for (const video of downloadable) await api.downloadMedia(video.id);
      notify(`已开始下载本集 ${downloadable.length} 条成片`, "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "打包下载失败，请重试"), "error");
    } finally {
      setPacking(false);
    }
  }

  /* ============================================================
     渲染
     ============================================================ */
  const slowLoading = useSlowLoading(projectState.loading);

  function episodeHasConfirmedScript(episode: Episode): boolean {
    if (episode.id === episodeId && latestRun) return latestRun.status === "confirmed";
    return episodeScriptState[episode.id] === true;
  }

  /** 左栏单集：状态点 + 集号/集名 + 行内改名 + ⋯删除 + 拖动排序（需先点「拖拽」开启）。 */
  function renderEpisodeItem(episode: Episode): React.JSX.Element {
    const active = episode.id === episodeId;
    const confirmed = episodeHasConfirmedScript(episode);
    const renaming = renamingId === episode.id;
    const label = episodeDisplayLabel(episode);
    const dropTarget = dragOverId === episode.id && dragEpisodeId !== null && dragEpisodeId !== episode.id;
    return (
      <div
        key={episode.id}
        draggable={dragArmed && !renaming}
        onDragStart={(event) => {
          setDragEpisodeId(episode.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", episode.id);
        }}
        onDragOver={(event) => {
          if (dragEpisodeId && dragEpisodeId !== episode.id) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            if (dragOverId !== episode.id) setDragOverId(episode.id);
          }
        }}
        onDragLeave={() => {
          if (dragOverId === episode.id) setDragOverId(null);
        }}
        onDrop={(event) => {
          event.preventDefault();
          void handleEpisodeDrop(episode.id);
        }}
        onDragEnd={() => {
          setDragEpisodeId(null);
          setDragOverId(null);
        }}
        className={cn(
          "group relative flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors",
          dragArmed ? "cursor-grab active:cursor-grabbing" : "",
          active ? "bg-accent-subtle" : "hover:bg-surface-2",
          dragEpisodeId === episode.id ? "opacity-50" : "",
          dropTarget ? "outline outline-2 outline-offset-[-2px] outline-accent" : "",
        )}
      >
        <span
          className={cn("size-1.5 shrink-0 rounded-full", confirmed ? "bg-success" : "bg-ink-4")}
          title={confirmed ? "剧本已确认" : "还没有剧本"}
          aria-hidden="true"
        />
        {renaming ? (
          <Input
            autoFocus
            value={renameValue}
            aria-label={`第 ${episode.episode_no} 集集名`}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={() => void saveEpisodeRename(episode)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void saveEpisodeRename(episode); }
              if (event.key === "Escape") setRenamingId(null);
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-border-1 bg-surface-1 px-2 py-2 text-sm text-ink-1 outline-none transition-colors focus:border-accent/60"
          />
        ) : (
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
            title={label.title}
            onClick={() => navigate(liteProjectPath(projectId, "workspace", episode.id))}
          >
            <span className={cn("w-full truncate text-sm leading-5", active ? "text-accent-text" : "text-ink-1")}>
              {label.primary}
            </span>
            {label.secondary !== null ? (
              <span className={cn("w-full truncate text-sm leading-5", active ? "text-accent-text/80" : "text-ink-2")}>
                {label.secondary}
              </span>
            ) : null}
          </button>
        )}
        {!renaming ? (
          <div className="absolute right-1 top-0.5 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <button
              type="button"
              aria-label={`重命名第 ${episode.episode_no} 集`}
              className="rounded p-2 text-ink-3 transition-colors hover:text-ink-1"
              onClick={() => { setRenamingId(episode.id); setRenameValue(episode.name ?? ""); }}
            >
              <PencilSimple className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`删除第 ${episode.episode_no} 集`}
              className="rounded p-2 text-ink-3 transition-colors hover:text-danger"
              onClick={() => setDeleteTarget(episode)}
            >
              <Trash className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  /** 右栏 ① 状态动作条（5 态机；付费动作明示次数）。 */
  function renderActionBar(): React.JSX.Element | null {
    if (!episodeId) return null;
    if (view === "review") {
      const confirming = busy === "confirm";
      return (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-1 bg-surface-1 px-4 py-3">
          <Button variant="primary" icon={<CheckCircle />} loading={confirming} onClick={() => void confirmDraft()}>采用这份草稿</Button>
          <Button variant="danger-outline" disabled={confirming} onClick={() => setDiscardDialogOpen(true)}>重来</Button>
          <span className="text-xs text-ink-3">核对草稿后点「采用」，才会写入正式分镜与素材。</span>
        </div>
      );
    }
    if (view === "confirmed") {
      /* 编辑态的一键生成在内容卡标题行（剧本原文旁，R2-15 二轮）；锁定态保留动作条。 */
      if (editUnlocked) return null;
      return (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border-1 bg-surface-1 px-4 py-3">
          <Button variant="outline" size="sm" icon={<PencilSimple />} disabled={busy !== null} onClick={() => setEditUnlocked(true)}>编辑剧本</Button>
          {confirmedCounts ? (
            <span className="text-xs text-ink-3">已生成 {confirmedCounts.scenes} 场、{confirmedCounts.shots} 个分镜；卡片直接看候选图与成片。</span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            icon={<Sparkle />}
            disabled={busy !== null || shotsState.loading || shotsState.data === null}
            onClick={() => setRerunDialogOpen(true)}
            title="按当前已采用的剧本重新生成分镜与素材"
          >
            重新生成本集
          </Button>
        </div>
      );
    }
    /* paste / failed：一键生成在内容卡标题行（剧本原文旁，R2-15 二轮），不再占独立动作条。 */
    return null;
  }

  /** 右栏 ② 当前集内容（固定高；内容卡不放文件导入按钮，§4.2.2）。 */
  function renderContentArea(): React.JSX.Element | null {
    if (!episodeId) return null;
    /* 折叠开关（2026-08-17 用户反馈三轮）：整行可点（标题行即开关），caret
       icon 放行首；右侧动作独立于开关按钮，不被整行点击误触。 */
    const collapseRow = (title: string): React.JSX.Element => (
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-surface-2"
        aria-expanded={scriptDetailsOpen}
        aria-label={scriptDetailsOpen ? `折叠${title}` : `展开${title}`}
        title={scriptDetailsOpen ? "折叠剧本原文" : "展开剧本原文"}
        onClick={() => setScriptDetailsOpen(!scriptDetailsOpen)}
      >
        <CaretDown className={cn("size-4 shrink-0 transition-transform", scriptDetailsOpen ? "rotate-180" : "")} aria-hidden="true" />
        <span className="truncate text-base font-semibold text-ink-1">{title}</span>
      </button>
    );
    if (view === "processing") {
      const running = latestRun?.status === "running";
      const title = autoGenerating
        ? autoGenStage === "confirming" ? "正在生成分镜" : "一键生成中"
        : "正在解析剧本";
      return (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <CardTitle>{title}</CardTitle>
              <Badge tone={running ? "accent" : "warning"}>{running ? "解析中" : "排队中"}</Badge>
            </div>
            <CardDescription>
              解析期间不会改动你的剧本。下面就是你刚才提交的原文，解析完成前不可修改。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {runsState.error ? (
              <div className="flex items-center gap-2 text-xs text-danger">
                <span>进度刷新失败：{runsState.error}</span>
                <button type="button" className="text-accent-text underline underline-offset-4" onClick={runsState.retry}>重试</button>
              </div>
            ) : null}
            <Field label="剧本原文">
              <Textarea rows={10} readOnly value={rawText} placeholder={rawText ? undefined : "正在解析，原文暂不可见。"} className="text-xs" />
            </Field>
          </CardContent>
        </Card>
      );
    }
    if (view === "review") {
      if (detailState.error) return <ErrorState message={detailState.error} onRetry={detailState.retry} />;
      if (detailState.loading || !detail) {
        return (
          <Card aria-label="正在读取解析草稿">
            <CardContent className="flex flex-col gap-3 py-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        );
      }
      const { draft } = detail;
      return (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              {collapseRow("解析结果草稿")}
              <Badge tone="warning">待确认</Badge>
            </div>
            <CardDescription>核对下面的内容：点「采用这份草稿」才会生成正式分镜；点「重来」整份放弃后可以重新粘贴。草稿本身不会改动任何正式内容。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {scriptDetailsOpen ? (
              <Textarea disabled value={rawText} rows={8} placeholder={rawText ? undefined : "原文暂不可见"} className="text-xs" />
            ) : null}
            {draft.storySummary ? (
              <section aria-label="故事梗概">
                <h3 className="mb-2 text-sm font-medium text-ink-1">故事梗概</h3>
                <p className="whitespace-pre-wrap text-sm text-ink-2">{draft.storySummary}</p>
              </section>
            ) : null}
            <section aria-label="资产候选">
              <h3 className="mb-2 text-sm font-medium text-ink-1">识别出的资产</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <AssetCandidateGroup title="角色" items={draft.assetCandidates.characters} />
                <AssetCandidateGroup title="场景" items={draft.assetCandidates.scenes} />
                <AssetCandidateGroup title="道具" items={draft.assetCandidates.props} />
                <AssetCandidateGroup title="服装" items={draft.assetCandidates.costumes} />
                <AssetCandidateGroup title="音频" items={draft.assetCandidates.audios} />
              </div>
            </section>
          </CardContent>
        </Card>
      );
    }
    if (view === "confirmed") {
      return (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              {collapseRow(editUnlocked ? "编辑剧本" : "剧本已采用")}
              <Badge tone={editUnlocked ? "warning" : "success"}>{editUnlocked ? "编辑中" : "已采用"}</Badge>
              <div className="ml-auto flex items-center gap-2">
                {editUnlocked ? (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Sparkle />}
                      loading={autoGenerating}
                      disabled={!rawText.trim() || busy !== null}
                      title={!rawText.trim() ? "先粘贴剧本原文，才能一键生成" : undefined}
                      onClick={() => void autoGenerate()}
                    >
                      一键生成本集（1 次任务）
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setEditUnlocked(false)}>取消</Button>
                  </>
                ) : (
                  <Button variant="secondary" size="sm" icon={<PencilSimple />} onClick={() => setEditUnlocked(true)}>编辑</Button>
                )}
              </div>
            </div>
            <CardDescription>
              {editUnlocked
                ? "修改后点「一键生成本集」会重新生成分镜与素材，已有分镜、素材和锁定提示词都会随旧分镜失效。"
                : `${confirmedCounts ? `已生成 ${confirmedCounts.scenes} 场、${confirmedCounts.shots} 个分镜。` : "分镜已生成。"}`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {editUnlocked ? (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
                <Warning className="mt-0.5 size-4 shrink-0 text-warning" />
                <span className="text-xs text-ink-2">修改剧本后重新解析，将清除当前集已有的分镜和素材，无法撤销。</span>
              </div>
            ) : null}
            {scriptDetailsOpen || editUnlocked ? (
              <div className="flex flex-col gap-2">
                <Textarea
                  rows={5}
                  maxLength={MAX_SCRIPT_CHARS}
                  value={rawText}
                  disabled={!editUnlocked}
                  onChange={(event) => setRawText(event.target.value)}
                  placeholder={editUnlocked ? "编辑剧本原文…" : ""}
                  className="max-h-40 text-xs"
                />
                {!editUnlocked ? (
                  <div className="flex items-center gap-1.5 text-xs text-ink-4">
                    <LockSimple className="size-3.5" />
                    <span>剧本已锁定，点右上「编辑」后可编辑</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      );
    }
    if (view === "failed") {
      const reason = latestRun?.displayReason?.trim() || "服务没有返回具体原因，可以稍后重新解析。";
      return (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              {collapseRow("解析没有完成")}
              <Badge tone="danger">失败</Badge>
              <div className="ml-auto flex items-center gap-2">
                <span className={cn("text-xs tabular-nums", rawText.length >= MAX_SCRIPT_CHARS ? "text-warning" : "text-ink-3")}>
                  {rawText.length} / {MAX_SCRIPT_CHARS} 字
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Sparkle />}
                  loading={autoGenerating}
                  disabled={!rawText.trim() || busy !== null}
                  title={!rawText.trim() ? "先粘贴剧本原文，才能重新生成" : undefined}
                  onClick={() => void autoGenerate()}
                >
                  修改后重新生成（1 次任务）
                </Button>
              </div>
            </div>
            <CardDescription>{reason}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {scriptDetailsOpen ? (
              <Textarea
                rows={5}
                maxLength={MAX_SCRIPT_CHARS}
                value={rawText}
                onChange={(event) => setRawText(event.target.value)}
                placeholder={"夜·内 旧宅客厅\n林晚推开门，愣住。\n林晚：你怎么会在这里？"}
                className="max-h-40 text-xs"
              />
            ) : null}
          </CardContent>
        </Card>
      );
    }
    /* paste */
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            {collapseRow(pasteNotice ? "重新粘贴剧本" : "粘贴剧本原文")}
            <div className="ml-auto flex items-center gap-2">
              <span className={cn("text-xs tabular-nums", rawText.length >= MAX_SCRIPT_CHARS ? "text-warning" : "text-ink-3")}>
                {rawText.length} / {MAX_SCRIPT_CHARS} 字
              </span>
              <Button
                variant="primary"
                size="sm"
                icon={<Sparkle />}
                loading={autoGenerating}
                disabled={!rawText.trim() || busy !== null}
                title={!rawText.trim() ? "先粘贴剧本原文，才能一键生成" : undefined}
                onClick={() => void autoGenerate()}
              >
                一键生成本集（1 次任务）
              </Button>
              {editUnlocked ? (
                <Button variant="primary" size="sm" icon={<CheckCircle />} onClick={() => setEditUnlocked(false)}>保存</Button>
              ) : (
                <Button variant="secondary" size="sm" icon={<PencilSimple />} disabled={lockedMessage.length > 0} onClick={() => setEditUnlocked(true)}>编辑</Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {lockedMessage ? (
            <div role="alert" className="flex flex-col gap-1 rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
              <strong className="text-sm font-medium text-danger">{lockedMessage}</strong>
              <span className="text-xs text-ink-2">{lockedMessage === "这一集正在解析中，请稍候" ? "请等待当前解析完成后再试。" : "这一集已有成片，不能再重新解析。可以在左栏新建一集，继续录新的剧本。"}</span>
            </div>
          ) : null}
          {pasteNotice && !lockedMessage ? (
            <div className="rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-sm text-ink-2">{pasteNotice}</div>
          ) : null}
          {scriptDetailsOpen || editUnlocked ? (
            <div className="flex flex-col gap-2">
              <Textarea
                rows={5}
                maxLength={MAX_SCRIPT_CHARS}
                value={rawText}
                disabled={!editUnlocked}
                onChange={(event) => setRawText(event.target.value)}
                placeholder={editUnlocked ? "夜·内 旧宅客厅\n林晚推开门，愣住。\n林晚：你怎么会在这里？" : ""}
                className="max-h-40 text-xs"
              />
              {!editUnlocked ? (
                <div className="flex items-center gap-1.5 text-xs text-ink-4">
                  <LockSimple className="size-3.5" />
                  <span>点右上「编辑」后可编辑剧本原文</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  /** 右栏 ③ 本集资产引用（R2-15 二轮：按类型分组横排「角色：A、B；场景：C」，
   *  高度固定两行，资产多时横排滚动，不再纵向撑高挤压分镜区；review 态显示候选）。 */
  function renderAssetRefBar(): React.JSX.Element | null {
    if (!episodeId) return null;
    const goAssets = (
      <Button variant="ghost" size="sm" icon={<ImageSquare />} onClick={() => navigate(liteProjectPath(projectId, "assets", episodeId))}>去资产页</Button>
    );
    if (view === "review" && detail) {
      const reviewGroups = ASSET_REF_BAR_GROUPS.map(({ label, kind }) => ({
        label,
        names: detail.draft.assetCandidates[kind].map((candidate) => candidate.name),
      })).filter((group) => group.names.length > 0);
      return (
        <div className="flex flex-col gap-2 rounded-xl border border-border-1 bg-surface-1 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink-3">资产候选 · 待确认</span>
            <span className="ml-auto">{goAssets}</span>
          </div>
          {reviewGroups.length === 0 ? (
            <span className="text-xs text-ink-4">这次没有识别出资产候选</span>
          ) : (
            <div className="flex items-center gap-4 overflow-x-auto">
              {reviewGroups.map((group) => (
                <span key={group.label} className="shrink-0 whitespace-nowrap text-xs text-ink-2">
                  <span className="text-ink-3">{group.label}：</span>
                  {group.names.join("、")}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }
    if (view === "confirmed" && detail) {
      // §2 P4:读本集已确认 run 的解析资产候选按类型分组(五类),不再只依赖物化后的登记资产。
      const draftGroups = ASSET_REF_BAR_GROUPS.map(({ label, kind }) => ({
        label,
        names: [...new Set(detail.draft.assetCandidates[kind].map((candidate) => candidate.name))],
      })).filter((group) => group.names.length > 0);
      return (
        <div className="flex flex-col gap-2 rounded-xl border border-border-1 bg-surface-1 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink-3">本集资产引用</span>
            <span className="ml-auto">{goAssets}</span>
          </div>
          {draftGroups.length === 0 ? (
            <span className="text-xs text-ink-4">这次解析没有识别出资产;可以去资产页手动新建。</span>
          ) : (
            <div className="flex items-center gap-4 overflow-x-auto">
              {draftGroups.map((group) => (
                <span key={group.label} className="shrink-0 whitespace-nowrap text-xs text-ink-2">
                  <span className="text-ink-3">{group.label}：</span>
                  {group.names.join("、")}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }
    const groups: Array<{ label: string; names: string[] }> = [];
    for (const asset of referenceAssets) {
      const label = ASSET_KIND_LABELS[asset.kind] ?? (asset.kind || "其他");
      const group = groups.find((item) => item.label === label);
      if (group) group.names.push(asset.name);
      else groups.push({ label, names: [asset.name] });
    }
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-border-1 bg-surface-1 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-ink-3">本集资产引用</span>
          <span className="ml-auto">{goAssets}</span>
        </div>
        {referenceAssets.length === 0 ? (
          <span className="text-xs text-ink-4">还没有资产引用；确认剧本解析后会列出分镜用到的资产。</span>
        ) : (
          <div className="flex items-center gap-4 overflow-x-auto">
            {groups.map((group) => (
              <span key={group.label} className="shrink-0 whitespace-nowrap text-xs text-ink-2">
                <span className="text-ink-3">{group.label}：</span>
                {group.names.join("、")}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  /** 右栏 ④ 分镜区（唯一滚动区）：review = 候选表；confirmed = 分镜卡网格；其余空态/骨架。 */
  function renderShotsArea(): React.JSX.Element {
    if (view === "review") {
      const shotCandidates = detail ? [...detail.draft.shotCandidates].sort((a, b) => a.shotNo - b.shotNo) : [];
      if (shotCandidates.length === 0) {
        return (
          <EmptyState
            title="没有识别出分镜"
            description="剧本里场次和动作描述比较少；可以点「重来」补充后重新解析。"
            icon={<Note />}
          />
        );
      }
      return <ShotCandidateTable shots={shotCandidates} />;
    }
    if (view === "confirmed") {
      if (shotsState.error) return <ErrorState message={shotsState.error} onRetry={shotsState.retry} />;
      if (shotsState.loading && shots.length === 0) {
        return (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex flex-col gap-2 rounded-xl border border-border-1 bg-surface-2 p-0">
                <Skeleton className="aspect-video w-full rounded-t-xl bg-surface-1" />
                <div className="flex flex-col gap-2 px-4 pb-4">
                  <Skeleton className="h-4 w-1/3 bg-surface-1" />
                  <Skeleton className="h-4 w-2/3 bg-surface-1" />
                </div>
              </div>
            ))}
          </div>
        );
      }
      if (shots.length === 0) return renderShotsEmptyHint();
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {shots.map((shot) => <div key={shot.id}>{renderShotCard(shot)}</div>)}
        </div>
      );
    }
    if (view === "processing") {
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex flex-col gap-2 rounded-xl border border-border-1 bg-surface-2 p-0">
              <Skeleton className="aspect-video w-full rounded-t-xl bg-surface-1" />
              <div className="flex flex-col gap-2 px-4 pb-4">
                <Skeleton className="h-4 w-1/3 bg-surface-1" />
                <Skeleton className="h-4 w-2/3 bg-surface-1" />
              </div>
            </div>
          ))}
        </div>
      );
    }
    /* paste / failed：手动建过镜直接列出。 */
    if (shots.length === 0) return renderShotsEmptyHint();
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        {shots.map((shot) => <div key={shot.id}>{renderShotCard(shot)}</div>)}
      </div>
    );
  }

  /** 分镜空态提示：创建入口已上移到分镜标题行，这里只给一句指引。 */
  function renderShotsEmptyHint(): React.JSX.Element {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-2 px-4 py-8 text-center">
        <ImageSquare className="size-5 text-ink-4" aria-hidden="true" />
        <span className="text-sm text-ink-3">当前集还没有分镜</span>
        <span className="text-xs text-ink-4">点右上角「创建分镜」手动新建空分镜，或贴入剧本后点「一键生成本集」。</span>
      </div>
    );
  }
  /** 分镜卡：v1.4 列表卡 + 段⑤ LiteShotVideos（看片/定成片/下载；重新出片去详情页）。
      卡片无出图/出片按钮——付费动作只在详情页弹窗，一次点击一次任务。 */
  function renderShotCard(shot: Shot): React.JSX.Element {
    const media = mediaState.data?.[shot.id];
    const candidates = imageCandidatesOf(media);
    const videos = videoMediaOf(media);
    const primaryImage = primaryImageOf(media);
    const rowTasks = tasksByShot.get(shot.id) ?? [];
    const videoTasks: LiteVideoTaskView[] = rowTasks
      .filter((tracked) => tracked.kind === "video")
      .map((tracked) => ({ requestId: tracked.requestId, task: tracked.task, timedOut: tracked.timedOut }));
    const failedTask = rowTasks.find((tracked) => tracked.task.status === "failed") ?? null;
    const activeTask = rowTasks.find(isActiveTask) ?? null;

    /* 状态徽记优先级：失败 > 生成中 > 已出片 > 首帧已定 > 待选首帧 > 无图 */
    let badge: { label: string; tone: "danger" | "accent" | "success" | "warning" | "neutral"; title?: string };
    if (failedTask) {
      badge = { label: "✕失败", tone: "danger", title: humanErrorMessage(failedTask.task.display_reason, "服务没有返回具体原因") };
    } else if (activeTask) {
      badge = { label: "◌生成中", tone: "accent" };
    } else if (videos.length > 0) {
      badge = { label: `●已出片 ${videos.length}`, tone: "success" };
    } else if (primaryImage) {
      badge = { label: "●首帧已定", tone: "success" };
    } else if (candidates.length > 0) {
      badge = { label: "◐待选首帧", tone: "warning" };
    } else {
      badge = { label: "○无图", tone: "neutral" };
    }

    const scene = shot.scene_id ? (sceneById.get(shot.scene_id) ?? null) : null;
    const sceneName = scene?.name?.trim() ?? "";
    const sceneShort = sceneName.length > 0 ? sceneName.slice(0, 4) : "空镜";
    const shotCode = `${episodeNo}-${shot.shot_no}-${sceneShort}`;

    /* 封面优先级：人为已定首帧图 → 默认视频版本首帧（video preload="metadata"）→ 占位。 */
    const latestVideo = videos.length > 0
      ? [...videos].sort((left, right) => (right.created_at ?? "").localeCompare(left.created_at ?? ""))[0]
      : null;
    const thumbnail = primaryImage ? (
      <LiteImage src={liteImageDisplaySrc(primaryImage, demoMode)} alt={`第 ${shot.shot_no} 镜定稿画面`} className="size-full object-cover" />
    ) : latestVideo ? (
      <video src={latestVideo.storage_url ?? undefined} muted playsInline preload="metadata" className="size-full object-cover" aria-label={`第 ${shot.shot_no} 镜成片预览`} />
    ) : (
      <div className="flex size-full items-center justify-center gap-1.5 bg-surface-2 text-ink-3">
        <ImageSquare className="size-4" aria-hidden="true" />
        <span className="text-xs">暂无画面</span>
      </div>
    );

    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`第 ${episodeNo} 集 · 第 ${shot.shot_no} 镜`}
        onClick={() => navigate(liteShotDetailPath(projectId, shot.id, episodeId))}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            navigate(liteShotDetailPath(projectId, shot.id, episodeId));
          }
        }}
        className="group flex cursor-pointer flex-col gap-2 overflow-hidden rounded-xl border border-border-1 bg-surface-2 p-0 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 hover:border-accent/50"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-surface-1">
          <div className="size-full">{thumbnail}</div>
          <Badge tone={badge.tone} title={badge.title} className="absolute left-2 top-2 shadow-sm backdrop-blur-sm">{badge.label}</Badge>
          <span className="absolute right-2 top-2 rounded-md bg-surface-1/80 px-2 py-0.5 text-aux text-ink-2 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">⇄ 详情</span>
        </div>
        <div className="flex flex-col gap-1.5 px-3 pb-3 pt-1.5">
          <div className="flex items-center gap-1">
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <code className="shrink-0 font-mono text-xs leading-5 text-ink-3">{shotCode}</code>
              {shot.title?.trim() ? <span className="truncate text-xs leading-5 text-ink-2">{shot.title}</span> : null}
            </span>
            <button
              type="button"
              aria-label={`编辑第 ${shot.shot_no} 镜`}
              title="编辑名称与画面描述"
              className="shrink-0 rounded p-1.5 text-ink-3 opacity-0 transition-opacity hover:bg-surface-1 hover:text-ink-1 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={(event) => { event.stopPropagation(); openShotEditDialog(shot); }}
            >
              <PencilSimple className="size-3.5" />
            </button>
            <button
              type="button"
              aria-label={`删除第 ${shot.shot_no} 镜`}
              title="删除这一镜"
              className="shrink-0 rounded p-1.5 text-ink-3 opacity-0 transition-opacity hover:bg-surface-1 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={(event) => { event.stopPropagation(); setDeleteShotTarget(shot); }}
            >
              <Trash className="size-3.5" />
            </button>
          </div>
          <p className="line-clamp-2 text-sm leading-5 text-ink-2">
            {/* P6：一键生成 v7 起每镜成文提示词落 video_prompt，卡片优先预览；
                旧拆解的 director_prompt 兜底。两者皆无才是空态。 */}
            {shot.video_prompt?.trim()
              ? shot.video_prompt
              : shot.director_prompt?.trim()
                ? shot.director_prompt
                : <span className="text-ink-4">暂无画面描述，点上方铅笔图标补充。</span>}
          </p>
          <div onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <LiteShotImages
              shotNo={shot.shot_no}
              images={candidates}
              reviewGate={reviewGateImage}
              onReloadCapabilities={onReloadCapabilities}
              reviewerHint={reviewerHintOf("image")}
              busyId={primaryBusyId}
              demoMode={demoMode}
              onSelect={(image) => void approveAndSelect(shot, image)}
            />
          </div>
          <div>{renderTaskNotices(shot, rowTasks)}</div>
          {/* 段⑤：这一镜出过的片（看片/定成片/下载都不离开分镜区；重新出片去详情页）。
              包一层 stopPropagation，避免卡内交互误触整卡跳详情。 */}
          <div onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <LiteShotVideos
              shotNo={shot.shot_no}
              hideWhenEmpty
              videos={videos}
              tasks={videoTasks}
              reviewGate={reviewGateVideo}
              onReloadCapabilities={onReloadCapabilities}
              reviewerHint={reviewerHintOf("video")}
              busyId={primaryBusyId ?? downloadBusyId}
              demoMode={demoMode}
              onSetPrimary={(video) => void approveAndSelect(shot, video)}
              onDownload={(video) => void downloadMedia(video)}
              onRetryTask={() => navigate(liteShotDetailPath(projectId, shot.id, episodeId))}
              onRefreshTask={(requestId) => {
                const tracked = rowTasks.find((item) => item.requestId === requestId);
                if (tracked) void refreshTaskNow(tracked);
              }}
            />
          </div>
        </div>
      </div>
    );
  }


  /** 编辑分镜：打开弹窗并回填当前名称与画面描述（卡片本身只读）。 */
  function openShotEditDialog(shot: Shot): void {
    setEditShotTarget(shot);
    setEditShotTitle(shot.title ?? "");
    setEditShotPrompt(shot.director_prompt ?? "");
  }

  /** 弹窗保存：名称 + 画面描述一次 PATCH 写入；demo 模式只改本地态。 */
  async function saveShotEdits(): Promise<void> {
    const shot = editShotTarget;
    if (!shot || savingShotEdit) return;
    setSavingShotEdit(true);
    try {
      const nextTitle = editShotTitle.trim();
      const nextPrompt = editShotPrompt.trim();
      if (demoMode) {
        shotsState.setData((previous) => (previous ? {
          items: previous.items.map((item) => (item.id === shot.id ? { ...item, title: nextTitle || null, director_prompt: nextPrompt } : item)),
          count: previous.count,
        } : previous));
      } else {
        const updated = await api.updateShot(shot.id, { title: nextTitle || null, director_prompt: nextPrompt });
        shotsState.setData((previous) => (previous ? { items: previous.items.map((item) => (item.id === shot.id ? updated : item)), count: previous.count } : previous));
        if (episodeId) {
          trackLiteEvent({ event: "lite_shot_mutated", projectId, episodeId, shotId: shot.id, action: "updated" });
        }
      }
      setEditShotTarget(null);
      notify(demoMode ? "已保存（离线演示不写入服务）" : `第 ${shot.shot_no} 镜已保存`, "success");
    } catch (reason) {
      notify(humanErrorMessage(reason, "保存失败，请重试"), "error");
    } finally {
      setSavingShotEdit(false);
    }
  }

  /** 进行中/失败任务提示条（卡片点击仍可进详情；失败卡给「去详情」下一步）。 */
  function renderTaskNotices(shot: Shot, rowTasks: TrackedLiteTask[]): React.JSX.Element | null {
    const failed = rowTasks.find((tracked) => tracked.task.status === "failed") ?? null;
    const active = rowTasks.find(isActiveTask) ?? null;
    if (failed) {
      return (
        <div role="alert" className="flex items-center gap-2 rounded-md border border-danger/50 bg-danger/10 px-2.5 py-1.5 text-xs">
          <WarningCircle className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-ink-2">{failed.kind === "image" ? "图片" : "视频"}生成失败：{humanErrorMessage(failed.task.display_reason, "服务没有返回具体原因")}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={(event) => { event.stopPropagation(); navigate(liteShotDetailPath(projectId, shot.id, episodeId)); }}
          >
            去详情
          </Button>
        </div>
      );
    }
    if (!active) return null;
    if (active.timedOut) {
      return (
        <div role="status" className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-ink-2">
          <WarningCircle className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1">{active.kind === "image" ? "图片" : "视频"}任务仍在处理，可去详情页查看。</span>
          <Button size="sm" variant="outline" icon={<ArrowClockwise />} loading={refreshingId === active.requestId} onClick={(event) => { event.stopPropagation(); void refreshTaskNow(active); }}>立即刷新</Button>
        </div>
      );
    }
    const needsManualRefresh = active.pollFailures >= POLL_FAILURE_NOTICE_THRESHOLD;
    return (
      <div role="status" className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-1 px-2.5 py-1.5 text-xs text-ink-2">
        <SpinnerGap className="size-3.5 shrink-0 animate-spin text-accent-text" aria-hidden="true" />
        <span className="min-w-0 flex-1">{active.kind === "image" ? "图片" : "视频"}{active.task.status === "pending" ? "已提交，等待处理" : "正在生成"}{needsManualRefresh ? "；状态可能偏旧" : ""}…可离开本页，回来后进度自动恢复。</span>
        {needsManualRefresh ? (
          <Button size="sm" variant="outline" icon={<ArrowClockwise />} loading={refreshingId === active.requestId} onClick={(event) => { event.stopPropagation(); void refreshTaskNow(active); }}>立即刷新</Button>
        ) : null}
      </div>
    );
  }

  /* 整剧导入的隐藏文件选择：挂在每个出现「导入剧本」按钮的分支里（空项目
     空态卡 + 主工作台），ref 才点得到——2026-08-17 修复空项目点击无反应。 */
  const bulkImportFileInput = (
    <input
      ref={bulkFileInputRef}
      type="file"
      accept=".txt,.md,.docx,.pdf"
      className="hidden"
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) pickBulkFile(file);
        event.target.value = "";
      }}
    />
  );

  /* ---------- 整页分支 ---------- */
  if (projectState.error) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-[1440px] 2xl:max-w-[1920px] flex-1 items-center justify-center px-4 py-2">
        <ErrorState message={projectState.error} onRetry={projectState.retry} />
      </div>
    );
  }
  if (!projectState.data || slowLoading) {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-[1440px] 2xl:max-w-[1920px] flex-1 flex-col items-center justify-center gap-3 px-4 py-2">
        <div className="flex items-center justify-center gap-3 rounded-xl border border-border-1 bg-surface-1 px-4 py-10 text-sm text-ink-3">
          <SpinnerGap className="size-5 animate-spin text-accent-text" aria-hidden="true" />
          <span>加载中…</span>
        </div>
        {slowLoading ? (
          <Button variant="outline" icon={<ArrowClockwise />} onClick={() => { projectState.retry(); episodesState.retry(); }}>仍在加载 · 重试</Button>
        ) : null}
      </div>
    );
  }
  if (!episodeId) {
    return (
      <>
        <div className="mx-auto flex min-h-0 w-full max-w-[1440px] 2xl:max-w-[1920px] flex-1 items-center justify-center px-4 py-2">
          <EmptyState
            title="还没有可工作的剧集"
            description="新建第 1 集，粘贴剧本开始制作；或导入剧本，自动拆分为多集。"
            icon={<Note />}
            action={
              <div className="flex items-center gap-2">
                <Button variant="primary" icon={<Plus />} loading={creatingEpisode} onClick={() => void handleCreateEpisode()}>新建第 1 集</Button>
                <Button variant="accent" icon={<UploadSimple />} disabled={bulkImporting} onClick={openBulkImportPicker}>导入剧本</Button>
              </div>
            }
          />
        </div>
        {/* 空项目（无集）走 pickBulkFile 直接导入、不弹覆盖确认；input 必须随本分支挂载才点得到。 */}
        {bulkImportFileInput}
      </>
    );
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1440px] 2xl:max-w-[1920px] flex-1 flex-col gap-4 px-4 py-2">
      {/* 「导入剧本」在左栏剧集头（R2-14，2026-08-17）：不再独占页顶一整行，
          页顶动作位退役，纵向空间全还给右栏工作台。 */}
      <div className="flex min-h-0 flex-1 gap-4">
      {/* 左栏：剧集列表（自己滚，当前集高亮；✏ 改名 / ⋯ 删除 / 拖动排序 / [+ 新建集]） */}
      <aside className="flex w-56 shrink-0 flex-col gap-3 rounded-xl border border-border-1 bg-surface-1 p-3">
        <div className="flex items-center justify-between gap-2 px-2">
          <span className="text-xs font-medium text-ink-3">剧集</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className={cn(
                "rounded-md px-2 py-1.5 text-xs text-accent-text transition-colors hover:bg-accent-subtle",
                dragArmed ? "bg-accent-subtle" : "",
              )}
              title={dragArmed ? "完成拖拽排序" : "点击后可拖动调整集顺序"}
              aria-pressed={dragArmed}
              onClick={() => setDragArmed(!dragArmed)}
            >
              {dragArmed ? "完成" : "拖拽"}
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-accent-text transition-colors hover:bg-accent-subtle"
              title="导入剧本（替换现有全部集）"
              disabled={bulkImporting}
              onClick={openBulkImportPicker}
            >
              <UploadSimple className="size-3.5" aria-hidden="true" />
              导入剧本
            </button>
          </div>
        </div>
        {dragArmed ? (
          <p className="px-2 text-xs text-ink-4">按住某一集，拖到目标位置松开即可调整顺序。</p>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {episodes.map((episode) => renderEpisodeItem(episode))}
          {episodes.length === 0 ? (
            <p className="px-2 py-2 text-xs text-ink-4">还没有集，先新建一集。</p>
          ) : null}
        </div>
        <Button variant="outline" size="sm" icon={<Plus />} loading={creatingEpisode} onClick={() => void handleCreateEpisode()}>新建集</Button>
      </aside>

      {/* 右栏：状态动作条 → 当前集内容 → 本集资产引用 → 分镜区（唯一滚动区） */}
      <div className="flex min-w-0 min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
        <div className="shrink-0">{renderActionBar()}</div>
        <div className="shrink-0">{renderContentArea()}</div>
        <div className="shrink-0">{renderAssetRefBar()}</div>
        <section className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl border border-border-1 bg-surface-1 p-3">
          <div className="flex shrink-0 items-center justify-between gap-3">
            <h2 className="text-section-title text-ink-2">分镜</h2>
            <div className="flex items-center gap-2">
              <Button variant="accent" size="sm" icon={<Plus />} loading={creatingShot} onClick={() => void handleCreateShot()}>创建分镜</Button>
              <Button variant="primary" size="sm" icon={<Package />} loading={packing} onClick={() => void handlePackEpisode()}>打包本集成片</Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pr-2">
            {renderShotsArea()}
          </div>
        </section>
      </div>
      </div>

      {/* 「重来」二次确认：显式点击才放弃草稿，绝不自动 discard/confirm。 */}
      <Dialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>放弃这份解析结果？</DialogTitle>
            <DialogDescription>放弃后这份草稿不会写入正式分镜，也不能再恢复。你粘贴的剧本原文还留着，可以修改后重新解析。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDiscardDialogOpen(false)}>再想想</Button>
            <Button variant="danger" loading={busy === "discard"} onClick={() => void discardDraft()}>确认放弃</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重跑二次确认：已生成集再次重新生成前，明确告知覆盖分镜/只补素材。 */}
      <Dialog open={rerunDialogOpen} onOpenChange={setRerunDialogOpen}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>重新生成本集？</DialogTitle>
            <DialogDescription>
              {confirmedCounts
                ? `本集已生成 ${confirmedCounts.scenes} 场、${confirmedCounts.shots} 个分镜。`
                : "本集已生成过分镜与素材。"}
              重新生成将按当前剧本重新解析：现有分镜会被覆盖（软删重建），素材只补缺失、不覆盖不删除。此操作不可撤销。
              {lockedPromptCount > 0 ? (
                <span className="mt-2 block font-medium text-warning">
                  本集有 {lockedPromptCount} 条你锁定的提示词，重新生成会一并清除，锁定不保护这一步。
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={autoGenerating} onClick={() => setRerunDialogOpen(false)}>再想想</Button>
            <Button
              variant="accent"
              icon={<Sparkle />}
              loading={autoGenerating}
              onClick={() => {
                setRerunDialogOpen(false);
                void autoGenerate();
              }}
            >
              确认重新生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删集二次确认：如实说明当前没有恢复入口。 */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !deletingEpisode) setDeleteTarget(null); }}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>删除第 {deleteTarget?.episode_no} 集？</DialogTitle>
            <DialogDescription>删除后，本集剧本、分镜与已生成内容都会隐藏，当前没有恢复入口；需要时只能重新创建。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={deletingEpisode} onClick={() => setDeleteTarget(null)}>再想想</Button>
            <Button variant="danger" loading={deletingEpisode} onClick={() => void handleDeleteEpisode()}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除分镜二次确认：如实说明当前没有恢复入口。 */}
      <Dialog open={deleteShotTarget !== null} onOpenChange={(open) => { if (!open && !deletingShot) setDeleteShotTarget(null); }}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>删除第 {deleteShotTarget?.shot_no} 镜？</DialogTitle>
            <DialogDescription>删除后，这一镜及其成片与素材都会隐藏，当前没有恢复入口；需要时只能重新创建。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={deletingShot} onClick={() => setDeleteShotTarget(null)}>再想想</Button>
            <Button variant="danger" loading={deletingShot} onClick={() => void handleDeleteShot()}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑分镜：名称 + 画面描述一个弹窗（卡片悬停铅笔图标打开）。 */}
      <Dialog open={editShotTarget !== null} onOpenChange={(open) => { if (!open) setEditShotTarget(null); }}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>编辑第 {editShotTarget?.shot_no} 镜</DialogTitle>
            <DialogDescription>名称与画面描述一起保存，卡片实时回显。</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field label="分镜名称">
              <Input
                value={editShotTitle}
                onChange={(event) => setEditShotTitle(event.target.value)}
                placeholder={`第 ${episodeNo} 集 · 第 ${editShotTarget?.shot_no} 镜 · 空镜`}
              />
            </Field>
            <Field label="画面描述">
              <Textarea
                rows={4}
                value={editShotPrompt}
                onChange={(event) => setEditShotPrompt(event.target.value)}
                placeholder="写一句画面描述…"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditShotTarget(null)}>取消</Button>
            <Button variant="primary" loading={savingShotEdit} onClick={() => void saveShotEdits()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 整剧导入覆盖确认：重新导入会替换现有全部集，显式点击才继续。 */}
      <Dialog open={bulkPendingFile !== null} onOpenChange={(open) => { if (!open && !bulkImporting) setBulkPendingFile(null); }}>
        <DialogContent size="small">
          <DialogHeader>
            <DialogTitle>导入将覆盖现有的 {episodes.length} 集？</DialogTitle>
            <DialogDescription>导入后，现在的 {episodes.length} 集及它们的分镜、素材都会被新剧本替换，不会再显示。确认要继续吗？</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={bulkImporting} onClick={() => setBulkPendingFile(null)}>再想想</Button>
            <Button
              variant="danger"
              loading={bulkImporting}
              onClick={() => {
                const file = bulkPendingFile;
                setBulkPendingFile(null);
                if (file) void handleImportBulk(file);
              }}
            >
              覆盖导入
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 整剧导入的隐藏文件选择（左栏剧集头按钮直点；与空态卡共用同一份）。 */}
      {bulkImportFileInput}
    </div>
  );
}

export function AssetCandidateGroup({ title, items }: { title: string; items: ScriptBreakdownAssetCandidate[] }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border-1 p-3">
      <h4 className="mb-2 text-xs font-medium text-ink-3">{title}（{items.length}）</h4>
      {items.length === 0 ? (
        <p className="text-xs text-ink-4">没有识别出{title}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li key={item.candidateId} className="text-sm">
              <span className="text-ink-1">{item.name}</span>
              {item.audioKind ? <span className="ml-2 rounded-sm bg-surface-2 px-1.5 text-xs text-ink-3">{audioKindLabel(item.audioKind)}</span> : null}
              {item.description ? <span className="ml-2 text-xs text-ink-3">{item.description}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 分镜候选只读表格：镜号 / 画面描述 / 时长 / 角色（Lite 不暴露 prompt 三层编辑）。
    占据分镜滚动区，动作条给「采用草稿」/「重来」。 */
function ShotCandidateTable({ shots }: { shots: ScriptBreakdownShotCandidate[] }): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-md border border-border-1">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border-1 bg-surface-2 text-left text-xs text-ink-3">
            <th className="px-3 py-2 font-medium">镜号</th>
            <th className="px-3 py-2 font-medium">画面描述</th>
            <th className="px-3 py-2 font-medium">时长</th>
            <th className="px-3 py-2 font-medium">角色</th>
          </tr>
        </thead>
        <tbody>
          {shots.map((shot) => (
            <tr key={shot.candidateId} className="border-b border-border-1 last:border-b-0">
              <td className="px-3 py-2 font-mono text-xs tabular-nums text-ink-3">#{shot.shotNo}</td>
              <td className="px-3 py-2 text-ink-1">{shot.directorPrompt || "（无画面描述）"}</td>
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-ink-2">{shot.durationSec} 秒</td>
              <td className="px-3 py-2 text-ink-2">{shot.characterNames.length > 0 ? shot.characterNames.join("、") : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
