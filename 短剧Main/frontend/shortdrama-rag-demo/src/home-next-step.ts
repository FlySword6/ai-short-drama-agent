/* ============================================================
   home-next-step.ts — 首页「我该去哪」推导逻辑（K2G，纯函数层）

   数据真源（全部是前端已有数据，零新造）：
   - 项目列表：updated_at / created_at（哪个项目最近被碰过）
   - 项目内位置记忆 recallProjectLocation（routing.ts，上次看到哪）
   - 生产进度 inferProductionProgress（production-progress.ts，下一步干什么）
   - 任务提醒 generation-attempt-notifications + asset-upload-notifications
     （与 app.tsx 通知 Dock 同一对既有接口，不新造动态形状）

   降级纪律：推不出就如实降级（只说项目名/上次页面），绝不编进度。
   ============================================================ */
import { uploadNotificationText } from "./asset-upload-tracker";
import { demoEpisodes, demoShots } from "./demo";
import { projectStatusBucket } from "./pages/batch-generate-drawer";
import type { ProductionProgress, ProductionShotRecord } from "./production-progress";
import { nextPendingTarget } from "./production-stepper";
import { notificationResultPath, projectStoryboardPath, visitedProjectIds } from "./routing";
import type { AssetUploadNotification, GenerationAttemptNotification } from "./types";

/* ---------- 继续上次工作 ---------- */

export interface HomeProjectRef {
  id: string;
  name: string;
  status?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/** 选出「继续上次工作」呈现的项目（F13 认人版）：
    本人足迹（本机位置记忆/进入登记）里挑最近被碰的；足迹里一个没有才按全局更新时间降级——
    降级时调用方必须把标题换成「最近更新的项目」（resumeCardTitle），不冒充「上次工作」。 */
export function pickResumeProject<T extends HomeProjectRef>(projects: readonly T[], visited: ReadonlySet<string> = visitedProjectIds()): T | null {
  const candidates = projects.filter((project) => projectStatusBucket(project.status) !== "archived");
  if (candidates.length === 0) return null;
  const mine = candidates.filter((project) => visited.has(project.id));
  const pool = mine.length > 0 ? mine : candidates;
  return [...pool].sort((a, b) => activityTimestamp(b) - activityTimestamp(a))[0]!;
}

/** F13 卡标题：本人足迹里的项目才配叫「继续上次工作」，否则如实叫「最近更新的项目」。 */
export function resumeCardTitle(projectId: string, visited: ReadonlySet<string> = visitedProjectIds()): string {
  return visited.has(projectId) ? "继续上次工作" : "最近更新的项目";
}

function activityTimestamp(project: HomeProjectRef): number {
  const time = new Date(project.updated_at ?? project.created_at ?? "").getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** 项目内记忆路径 → 人话位置（与全站既有叫法一致）；认不出的路径回 null，调用方整段不说。 */
export function rememberedPlaceLabel(path: string | null): string | null {
  if (!path) return null;
  if (/\/shots\/[^/]+/.test(path)) return "工作台";
  if (path.includes("/storyboards")) return "生产页";
  if (path.includes("/assets")) return "资产面板";
  if (path.includes("/director")) return "导演台";
  if (path.includes("/script-breakdown")) return "剧本分镜";
  if (path.includes("/costs")) return "消耗看板";
  return null;
}

export interface ResumeWorkModel {
  projectId: string;
  projectName: string;
  /** 卡标题（F13）：「继续上次工作」/「最近更新的项目」,由调用方按本人足迹给。 */
  title: string;
  /** 推导出的下一步一句人话；算不出为 null——界面只字不提下一步，不编。 */
  nextStepText: string | null;
  /** 「上次看到：X · 更新于 Y」；有哪个说哪个，都没有回空串整行隐藏。 */
  contextText: string;
  actionLabel: string;
  targetPath: string;
}

/** 继续卡的完整视图模型：有进度推导 → 下一步动作直达；没有 → 如实降级到上次页面/生产页。 */
export function buildResumeWorkModel(input: {
  projectId: string;
  projectName: string;
  rememberedPath: string | null;
  progress: ProductionProgress | null;
  updatedLabel: string;
  /** F13：是否本人足迹项目（缺省=true 保持旧口径）。 */
  personal?: boolean;
}): ResumeWorkModel {
  const place = rememberedPlaceLabel(input.rememberedPath);
  const title = input.personal === false ? "最近更新的项目" : "继续上次工作";
  const contextText = [
    place ? `上次看到：${place}` : "",
    input.updatedLabel ? `更新于 ${input.updatedLabel}` : "",
  ].filter(Boolean).join(" · ");
  if (input.progress) {
    return {
      projectId: input.projectId,
      projectName: input.projectName,
      title,
      nextStepText: input.progress.description,
      contextText,
      actionLabel: input.progress.actionLabel,
      targetPath: nextPendingTarget(input.projectId, input.progress, input.progress.episodeId ?? ""),
    };
  }
  if (input.rememberedPath && place) {
    return {
      projectId: input.projectId,
      projectName: input.projectName,
      title,
      nextStepText: null,
      contextText,
      actionLabel: `回到${place}`,
      targetPath: input.rememberedPath,
    };
  }
  return {
    projectId: input.projectId,
    projectName: input.projectName,
    title,
    nextStepText: null,
    contextText,
    actionLabel: "打开生产页",
    targetPath: projectStoryboardPath(input.projectId),
  };
}

/* ---------- demo 生产数据归属（GP-04 教训：fixture 不许跨项目串） ---------- */

/** demo 里有该项目的集/分镜 fixture 时才允许推导；没有就如实降级，不拿别的项目的数据硬算。 */
export function hasDemoProductionData(projectId: string): boolean {
  return demoEpisodes.some((episode) => episode.project_id === projectId);
}

export function demoRecordsForProject(projectId: string): ProductionShotRecord[] {
  const episodes = demoEpisodes.filter((episode) => episode.project_id === projectId);
  const byId = new Map(episodes.map((episode) => [episode.id, episode]));
  return demoShots
    .filter((shot) => byId.has(shot.episode_id))
    .map((shot) => ({ episode: byId.get(shot.episode_id)!, shot, media: [] }));
}

/* ---------- 新用户三步起步指引（剧本幕一：建项目 → 导剧本 → 拆分镜） ---------- */

export interface HomeStartStep {
  key: "create" | "import" | "shots";
  title: string;
  note: string;
}

export const HOME_START_STEPS: readonly HomeStartStep[] = [
  { key: "create", title: "新建项目", note: "给剧起个名字，就能开工" },
  { key: "import", title: "导入剧本", note: "项目建好后，到生产页导入第 1 集剧本 Excel" },
  { key: "shots", title: "拆分镜", note: "剧本自动拆成粗剪素材，之后逐镜生成图片和视频" },
];

/* ---------- 最近动态（生成/入库终态提醒，与通知 Dock 同源） ---------- */

/** 首屏最多铺开的条数；超出的收成一行计数。 */
export const HOME_ACTIVITY_VISIBLE = 3;

export interface HomeActivityItem {
  id: string;
  tone: "success" | "danger";
  title: string;
  body: string;
  targetPath: string;
  createdAt: string;
}

/** 两类提醒合并按时间倒序；文案与 Dock 同一套口径（uploadNotificationText / 同构标题）。 */
export function toHomeActivityItems(
  generation: readonly GenerationAttemptNotification[],
  uploads: readonly AssetUploadNotification[],
  projectName: (projectId: string) => string | null,
): HomeActivityItem[] {
  const generationItems: HomeActivityItem[] = generation.map((notification) => {
    const kind = notification.media_kind === "video" ? "视频" : "图片";
    const succeeded = notification.status === "succeeded";
    const name = projectName(notification.project_id);
    const detail = succeeded ? "结果已保存" : notification.display_reason?.trim() || "生成没成：请打开任务查看详情后重试";
    return {
      id: `generation-${notification.id}`,
      tone: succeeded ? "success" : "danger",
      title: `${kind}任务${succeeded ? "已完成" : "失败"}`,
      body: name ? `《${name}》 · ${detail}` : detail,
      targetPath: notificationResultPath(notification),
      createdAt: notification.created_at,
    };
  });
  const uploadItems: HomeActivityItem[] = uploads.map((notification) => {
    const { title, body } = uploadNotificationText(notification);
    return {
      id: `upload-${notification.id}`,
      tone: notification.status === "succeeded" ? "success" : "danger",
      title,
      body,
      targetPath: "/assets",
      createdAt: notification.created_at,
    };
  });
  return [...generationItems, ...uploadItems]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
