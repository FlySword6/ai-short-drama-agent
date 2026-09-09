/* ============================================================
   episode-frames.ts — 集详情页「已拍画面 + 流程阶段条」纯函数层(EPISODE-RESTORE 单)

   两件事实的取数口径:
   ① 已拍画面缩略图:项目生成任务列表(api.projectGenerations,既有接口,段落工作台
     版本条同款数据源)按集过滤,每镜挑一帧——图片优先(静态轻量),无图有视频取视频,
     同种取最新。可展示 URL 的唯一真源=generationData 的 media_results.storage_url
     (持久化 TOS);shotMedia wire 不下发 storage_url(toShotMedia 只给需 Bearer 头的
     download_url,<img> 带不上),交付清单 deliverables 只含过审选定产物(有缺口即 409),
     都不是「已生成有多少显示多少」的诚实源。本模块不新增后端接口。
   ② 流程阶段六步状态:判定复用 production-progress.inferProductionProgress
     (进度判定真源唯一,S77 立的收敛规矩),episodeStageStates 只做
     「records + 当前步下标 → 每步三态」映射,不重写任何判定。
   ============================================================ */
import { inferProductionProgress, PRODUCTION_STEPS, type ProductionShotRecord, type ProductionStepKey } from "./production-progress";
import { sceneWorkbenchPath, shotWorkbenchPath } from "./routing";
import type { GenerationTask, Shot } from "./types";

/** 一镜一帧:网格卡片要展示的那一条产物。 */
export interface ShotFrame {
  shotId: string;
  kind: "image" | "video";
  url: string;
  createdAt: string | null;
}

/** 同镜两帧取谁:图片优先(网格静态展示最轻),同种取 createdAt 最新。 */
function betterFrame(next: ShotFrame, prev: ShotFrame): boolean {
  if (next.kind !== prev.kind) return next.kind === "image";
  return (next.createdAt ?? "") > (prev.createdAt ?? "");
}

/** 项目生成任务列表 → 指定集的每镜一帧。
    口径:只收 shot_id 落在本集且 status==="succeeded" 的任务;失败/在途没有可展示产物,
    自然不进网格(有多少显示多少,但不拿半成品凑数)。 */
export function pickShotFrames(tasks: readonly GenerationTask[], episodeId: string): Map<string, ShotFrame> {
  const frames = new Map<string, ShotFrame>();
  for (const task of tasks) {
    if (task.episode_id !== episodeId || !task.shot_id || task.status !== "succeeded") continue;
    for (const media of task.media_results ?? []) {
      const kind = media.media_kind === "image" ? "image" as const : media.media_kind === "video" ? "video" as const : null;
      const url = media.storage_url ?? null;
      if (!kind || !url) continue;
      const candidate: ShotFrame = { shotId: task.shot_id, kind, url, createdAt: media.created_at ?? task.updated_at ?? null };
      const existing = frames.get(task.shot_id);
      if (!existing || betterFrame(candidate, existing)) frames.set(task.shot_id, candidate);
    }
  }
  return frames;
}

/** demo 口径:records 的 media fixture(demoShotMedia)挑每镜一帧,与真栈同一偏好;
    只收 persisted + 有 storage_url(≈真栈「生成成功且可展示」)。 */
export function pickShotFramesFromRecords(records: readonly ProductionShotRecord[]): Map<string, ShotFrame> {
  const frames = new Map<string, ShotFrame>();
  for (const record of records) {
    for (const media of record.media) {
      const kind = media.media_kind === "image" ? "image" as const : media.media_kind === "video" ? "video" as const : null;
      if (!kind || media.persistence_status !== "persisted" || !media.storage_url) continue;
      const candidate: ShotFrame = { shotId: record.shot.id, kind, url: media.storage_url, createdAt: media.created_at ?? null };
      const existing = frames.get(record.shot.id);
      if (!existing || betterFrame(candidate, existing)) frames.set(record.shot.id, candidate);
    }
  }
  return frames;
}

/* ---------- 流程阶段条(六步三态) ---------- */

export type EpisodeStageVisualState = "complete" | "current" | "upcoming";

export interface EpisodeStageStep {
  key: ProductionStepKey;
  label: string;
  state: EpisodeStageVisualState;
}

/** 六步三态:当前步之前的=complete,当前步=current,之后=upcoming。
    records 为空(还没分镜)时 infer 恒落第 0 步;此时若剧本其实已导入(scriptHas),
    第 0 步「导入剧本」如实标 complete 而不是 current,后续步全 upcoming、当前步留空——
    「剧本已导入、待拆分镜」的动作消歧由下一步条(F16 三层口径)承担,本条不复述文案。 */
export function episodeStageStates(
  records: readonly ProductionShotRecord[],
  options: { scriptHas: boolean; deliveredEpisodeIds?: ReadonlySet<string> },
): EpisodeStageStep[] {
  if (records.length === 0) {
    return PRODUCTION_STEPS.map((step, index) => ({
      key: step.key,
      label: step.label,
      state: (index === 0 ? (options.scriptHas ? "complete" : "current") : "upcoming") as EpisodeStageVisualState,
    }));
  }
  const progress = inferProductionProgress([...records], options.deliveredEpisodeIds);
  return PRODUCTION_STEPS.map((step, index) => ({
    key: step.key,
    label: step.label,
    state: (index < progress.currentIndex ? "complete" : index === progress.currentIndex ? "current" : "upcoming") as EpisodeStageVisualState,
  }));
}

/* ---------- 缩略图落点与空状态出路 ---------- */

/** 缩略图点击落点=对应分场段落工作台(goal 判据①);shot 缺 scene_id(旧 demo fixture)退回镜级换乘口。 */
export function shotFrameTarget(projectId: string, episodeId: string, shot: Shot): string {
  return shot.scene_id
    ? sceneWorkbenchPath(projectId, episodeId, shot.scene_id)
    : shotWorkbenchPath(projectId, episodeId, shot.id);
}

export interface EmptyStateExit {
  key: string;
  label: string;
  hint: string;
  /** path=跳路径;episodeId=页内切集。两者恰有一个。 */
  path?: string;
  episodeId?: string;
}

/** 空状态(本集无剧本)的次级出路(goal 判据③):主行动仍是下一步条的「去拆剧本」,
    这里只补「不是死路」的其他可走路——先备素材(资产中心,路径与项目内导航「资产」页签一致);
    项目里还有别集时给「看看别集的做法」(页内切集,不走路由)。 */
export function noScriptExits(projectId: string, otherEpisode: { id: string; label: string } | null): EmptyStateExit[] {
  const exits: EmptyStateExit[] = [
    {
      key: "assets",
      label: "先去备素材",
      hint: "把角色、场景、参考图备进资产中心,剧本到了直接开拍",
      path: `/projects/${projectId}/assets`,
    },
  ];
  if (otherEpisode) {
    exits.push({
      key: "other-episode",
      label: `看看《${otherEpisode.label}》`,
      hint: "参考别集的做法",
      episodeId: otherEpisode.id,
    });
  }
  return exits;
}
