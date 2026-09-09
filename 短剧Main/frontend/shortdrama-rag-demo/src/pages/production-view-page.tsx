/* ============================================================
   production-view-page.tsx — 生产页签·集视图(块 1 大 goal,P-02b 实现)

   视觉真源=Figma 518:2「P-02b 生产·集视图」;语义真源=PRD v2 生产章;
   数据=sol production-status 投影(episodeProductionStatus,七态+x/N);
   样式=tk- 体系(零 legacy)。
   四层:整集时间线带(五态格,置顶)→ 下一步条(唯一 primary,按集状态语义)
        → 场卡列表(七态 Badge/x/N 就位/主版本缩略/Ghost 备戏)
        → 集级操作收「更多」(审核队列/交付本集/导出留位/预览全集)。
   集视图=指挥部:看全集状态、进下一步、审核交付;不做生成(生成在段落工作台)。
   ============================================================ */
import * as React from "react";
import { ArrowRight, CaretDown, FilmStrip, Plus } from "@phosphor-icons/react";
import { api } from "../api";
import { businessErrorMessage } from "../error-copy";
import { DEMO_SCRIPT_VERSIONS, demoShotMedia, demoShots } from "../demo";
import { demoDeliveredEpisodeIds } from "../demo-review-delivery";
import {
  episodeStageStates,
  noScriptExits,
  pickShotFrames,
  pickShotFramesFromRecords,
  shotFrameTarget,
  type ShotFrame,
} from "../episode-frames";
import { EpisodeStageStrip, ShotFrameGrid, type ShotFrameGridItem } from "../episode-restore";
import { laneDefs } from "../reference-lanes";
import type { ProductionShotRecord } from "../production-progress";
import { navigate, prepStagePath, productionViewPath, sceneWorkbenchPath } from "../routing";
import { useResource } from "../ui";
import { Button } from "../components/ui/button";
import { EmptyState, ErrorState, Select } from "../components/ui/primitives";
import { CreateEpisodeButton } from "../components/create-episode-button";
import { EpisodeDeliveryModal, MediaReviewQueueModal } from "../components/review-delivery-panels";
import { EpisodePlaybackModal } from "./operations-pages";
import type {
  Episode,
  EpisodeProductionStatus,
  ProductionStatusCode,
  SceneProductionStatus,
} from "../types";
import type { PageRuntimeProps } from "./global-pages";

const SERIF = { fontFamily: 'var(--tk-font-serif)' } as const;
const PREP_CURRENT_KEY = "shortdrama_prep_current_v1";

/* 七态 Badge 语义:生成中才 accent(呼吸),其余中性(Figma 帧口径)。 */
const BADGE_TONE: Record<ProductionStatusCode, "accent" | "plain" | "weak"> = {
  not_broken_down: "weak",
  broken_down: "plain",
  preparing: "plain",
  ready: "plain",
  generating: "accent",
  has_media: "plain",
  delivered: "plain",
};

/* 下一步条状态机(PRD 二+七态):唯一 primary + 片场话状态句。
   F16:状态分三层说实话——无剧本→去导入;有剧本无分镜→剧本已导入去拆分镜;有分镜→正常进度。
   scriptState 由页面用剧本版本接口实测传入(unknown=还没查完,不许先说「还没有剧本」)。 */
function nextStepOf(status: EpisodeProductionStatus, scriptState: "unknown" | "none" | "has" = "unknown"): { label: string; hint: string; action: () => void } {
  const go = (path: string) => () => navigate(path);
  const pid = status.project_id;
  const nextScene = status.next_scene_id ? status.scenes.find((s) => s.scene_id === status.next_scene_id) : undefined;
  const nextNo = nextScene?.scene_no;
  switch (status.production_status) {
    case "not_broken_down":
      if (scriptState === "has") {
        return { label: "去拆分镜", hint: "剧本已导入,拆出场和分镜就能备戏开拍", action: go(`/projects/${pid}/script-breakdown`) };
      }
      if (scriptState === "unknown") {
        return { label: "去拆剧本", hint: "正在确认这一集有没有剧本…", action: go(`/projects/${pid}/script-breakdown`) };
      }
      return { label: "去拆剧本", hint: "这一集还没有剧本,去粘贴或导入,拆完镜就能开拍", action: go(`/projects/${pid}/script-breakdown`) };
    case "broken_down":
    case "preparing":
      /* F15：去备戏必须带项目/集/场参数直达来源场——裸跳曾开成别部剧的场,送入即写错场 */
      return { label: "去备戏", hint: `第 ${status.scene_count} 场备戏中,备齐就能开拍`, action: go(prepStagePath(pid, status.episode_id, status.next_scene_id)) };
    case "ready":
    case "has_media": {
      /* 块 2:旧 /storyboards 兜底退役——无指定下一场时落第一个可开拍的场;全无则本页场卡自明,CTA 不跳。 */
      const fallbackScene = status.scenes.find((s) => s.production_status === "ready" || s.production_status === "has_media");
      const targetSceneId = status.next_scene_id ?? fallbackScene?.scene_id ?? null;
      return {
        label: "进工作台",
        hint: nextNo ? `第 ${nextNo} 场备好了,进工作台开拍` : "可以开拍",
        action: targetSceneId ? go(sceneWorkbenchPath(pid, status.episode_id, targetSceneId)) : () => undefined,
      };
    }
    case "generating":
      return { label: "查看队列", hint: "有任务在生成,去队列看进度", action: go(`/queue`) };
    case "delivered":
      return { label: "送审交付", hint: "本集已备好,可以送审交付", action: () => undefined };
    default:
      /* 七态全覆盖,此分支只防投影新增态——本页即生产页,原地不跳。 */
      return { label: "进工作台", hint: "", action: () => undefined };
  }
}

/* 场卡 Ghost 备戏→P-03b 备戏台带场参数(Fable 评审④:备戏=拉料去,开拍才进工作台)。
   F15:URL 深链带项目/集/场直达(记忆写入留作兜底),不再裸跳。 */
function gotoPrep(projectId: string, episodeId: string, sceneId: string): void {
  try {
    window.localStorage.setItem(PREP_CURRENT_KEY, JSON.stringify({ projectId, episodeId, sceneId }));
  } catch { /* 私密模式静默降级 */ }
  navigate(prepStagePath(projectId, episodeId, sceneId));
}

/* 缩略源顺位(Fable 评审①):图片主版本(书封剧照,deliverables image 产物按 shot→scene 归场)→视频首帧(cover_media)→状态底。
   deliverables image 的 storage_url 可直接显示(shotMedia 只给要 auth 的 download_url,不可取)。 */
function useSceneImages(episodeId: string | null, demoMode: boolean): Record<string, string> {
  const [map, setMap] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!episodeId || demoMode) return;
    let cancelled = false;
    void (async () => {
      try {
        const shots = (await api.shots(episodeId)).items;
        const shotToScene = new Map(shots.filter((s) => s.scene_id).map((s) => [s.id, s.scene_id as string]));
        const manifest = await api.episodeDeliverables(episodeId);
        if (cancelled) return;
        const acc: Record<string, string> = {};
        for (const item of manifest.items) {
          if (item.media_kind !== "image" || !item.storage_url) continue;
          const sceneId = item.shot_id ? shotToScene.get(item.shot_id) : undefined;
          if (sceneId && !acc[sceneId]) acc[sceneId] = item.storage_url;
        }
        setMap(acc);
      } catch { /* 静默回落视频首帧/状态底 */ }
    })();
    return () => { cancelled = true; };
  }, [episodeId, demoMode]);
  return map;
}

/* EPISODE-RESTORE:集级「已拍画面 + 流程阶段」取数。
   阶段判定复用 inferProductionProgress(真源唯一,records 喂给它);真栈 records 的 media 恒空——
   shotMedia wire 不下发 storage_url(只给需 Bearer 头的 download_url,<img> 带不上),
   hasPersistedMedia 在真栈恒 false,逐镜拉 media 与传空结果恒等,省 N 次请求;
   判定信号=shots 的 selected_*_result_id(production-progress 既有口径)。
   demo 走 demoShotMedia fixture(有 storage_url,与 stepper demo 口径同源)。
   缩略图真源=projectGenerations 的 media_results.storage_url(持久化 TOS 可展示 URL,
   未过审/未选定的已生成产物也照实进网格=「有多少显示多少」)。
   刷新=切集/挂载 + 「production-progress-changed」「episode-delivered」事件;不挂轮询
   (15s 轮询仍只在 stepper 共享 hook 一处,本页与其消费方按路由互斥)。 */
function useEpisodeFrames(projectId: string, episode: Episode | null, demoMode: boolean): {
  records: ProductionShotRecord[] | null;
  frames: Map<string, ShotFrame>;
  delivered: boolean;
  error: string;
} {
  const [state, setState] = React.useState<{
    records: ProductionShotRecord[] | null;
    frames: Map<string, ShotFrame>;
    delivered: boolean;
    error: string;
  }>({ records: null, frames: new Map(), delivered: false, error: "" });
  const episodeId = episode?.id ?? null;

  React.useEffect(() => {
    if (!episode || !episodeId) {
      setState({ records: null, frames: new Map(), delivered: false, error: "" });
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        if (demoMode) {
          const records: ProductionShotRecord[] = demoShots
            .filter((shot) => shot.episode_id === episodeId)
            .map((shot) => ({ episode, shot, media: demoShotMedia[shot.id] ?? [] }));
          if (cancelled) return;
          setState({
            records,
            frames: pickShotFramesFromRecords(records),
            delivered: demoDeliveredEpisodeIds().has(episodeId),
            error: "",
          });
          return;
        }
        const [shots, generations, deliveries] = await Promise.all([
          api.shots(episodeId),
          api.projectGenerations(projectId),
          /* 交付史查不动按未交付计(进度留在交付前一步,不说谎),与 stepper 同口径。 */
          api.episodeDeliveries(episodeId, 1, 1).catch(() => null),
        ]);
        if (cancelled) return;
        const records: ProductionShotRecord[] = shots.items.map((shot) => ({ episode, shot, media: [] }));
        setState({
          records,
          frames: pickShotFrames(generations.items, episodeId),
          delivered: (deliveries?.total ?? 0) > 0,
          error: "",
        });
      } catch (reason) {
        if (cancelled) return;
        setState({
          records: null,
          frames: new Map(),
          delivered: false,
          error: reason instanceof Error ? reason.message : "生产画面读取失败",
        });
      }
    };
    void load();
    const onChanged = () => void load();
    window.addEventListener("production-progress-changed", onChanged);
    window.addEventListener("episode-delivered", onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("production-progress-changed", onChanged);
      window.removeEventListener("episode-delivered", onChanged);
    };
    /* episode 对象内容按 id 稳定(集列表取数而来),依赖只跟 id 走,避免集列表刷新引发多余重取。 */
  }, [projectId, episodeId, demoMode]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

/* 时间线带一格:顺位=图片主版本→视频首帧→状态底(备戏=中性/未拆=虚线);生成中 accent 呼吸点。 */
function TimelineCell({ scene, image, active, onClick }: { scene: SceneProductionStatus; image?: string; active: boolean; onClick: () => void }) {
  const dashed = scene.production_status === "not_broken_down";
  const cover = scene.cover_media;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${scene.scene_no} · ${scene.name} · ${scene.status_label}`}
      className={[
        "flex w-24 shrink-0 flex-col gap-1.5 text-left",
        active ? "opacity-100" : "opacity-80 hover:opacity-100",
      ].join(" ")}
    >
      <span
        className={[
          "flex h-14 items-center justify-center overflow-hidden rounded-md",
          dashed ? "border border-dashed border-tk-border-2" : image || cover ? "" : "bg-tk-elevated",
        ].join(" ")}
      >
        {image ? (
          <img className="h-full w-full object-cover" src={image} alt={scene.name} loading="lazy" />
        ) : cover ? (
          cover.media_kind === "video" ? (
            <video className="h-full w-full object-cover" src={cover.storage_url} muted playsInline preload="metadata" />
          ) : (
            <img className="h-full w-full object-cover" src={cover.storage_url} alt={scene.name} loading="lazy" />
          )
        ) : (
          <span className="px-1 text-center text-[11px] text-tk-ink-3">{dashed ? "" : scene.name}</span>
        )}
      </span>
      <span className="flex items-center gap-1.5">
        {scene.production_status === "generating" ? <span className="size-1.5 animate-pulse rounded-full bg-tk-accent" /> : null}
        <span className={`font-tkmono text-[10px] ${scene.production_status === "generating" ? "text-tk-accent" : "text-tk-ink-3"}`}>
          {scene.scene_no}
        </span>
      </span>
    </button>
  );
}

export function ProductionViewPage({ projectId, demoMode, notify }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  const episodes = useResource(() => api.episodes(projectId), { items: [], count: 0 }, demoMode, [projectId]);
  /* 块 2:旧 /storyboards 深链换乘到本页——?episode= 选集;playback/delivery/review 开对应弹窗(旧页五种深链全承接)。 */
  const initialQuery = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const queryEpisodeId = initialQuery.get("episode");
  /* R173a-2 集切换器:页内切集=state 先行+URL 深链同步(深链可分享/刷新可复现);
     深链入页只在挂载时读一次,此后以页内选择为准。 */
  const [episodeOverride, setEpisodeOverride] = React.useState<string | null>(null);
  const sortedEpisodes = React.useMemo(
    () => [...(episodes.data?.items ?? [])].sort((a, b) => a.episode_no - b.episode_no),
    [episodes.data],
  );
  const episode = React.useMemo(() => {
    return sortedEpisodes.find((item) => item.id === episodeOverride)
      ?? sortedEpisodes.find((item) => item.id === queryEpisodeId)
      ?? sortedEpisodes[0]
      ?? null;
  }, [sortedEpisodes, queryEpisodeId, episodeOverride]);
  const status = useResource(
    () => (episode ? api.episodeProductionStatus(episode.id) : Promise.resolve(null as EpisodeProductionStatus | null)),
    null,
    demoMode,
    [episode?.id],
  );
  const [activeSceneId, setActiveSceneId] = React.useState<string | null>(null);

  /* R173a-2:切集=换 override+同步 ?episode= 深链;时间线高亮场随集失效清零。 */
  function switchEpisode(nextEpisodeId: string): void {
    if (!nextEpisodeId || nextEpisodeId === episode?.id) return;
    setEpisodeOverride(nextEpisodeId);
    setActiveSceneId(null);
    navigate(`${productionViewPath(projectId)}?episode=${encodeURIComponent(nextEpisodeId)}`);
  }
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(initialQuery.get("review") === "1");
  const [deliveryOpen, setDeliveryOpen] = React.useState(initialQuery.get("delivery") === "1" || initialQuery.get("delivery") === "history");
  const [playbackOpen, setPlaybackOpen] = React.useState(initialQuery.get("playback") === "1");
  const deliveryInitialTab: "deliver" | "history" = initialQuery.get("delivery") === "history" ? "history" : "deliver";
  const sceneImages = useSceneImages(episode?.id ?? null, demoMode);
  /* EPISODE-RESTORE:已拍画面网格 + 流程阶段条的数据(切集/生成终态/交付事件驱动重取)。 */
  const episodeFrames = useEpisodeFrames(projectId, episode, demoMode);
  /* F16:仅当服务端状态说「未拆解」时才需分辨「无剧本 vs 有剧本无分镜」——按集实测剧本版本,
     查完前(scriptState=unknown)提示条不许抢答「还没有剧本」。 */
  const needsScriptCheck = status.data?.production_status === "not_broken_down";
  const scriptVersionsState = useResource(
    () => (needsScriptCheck && episode ? api.scriptVersions(episode.id) : Promise.resolve(null)),
    null,
    demoMode,
    [episode?.id, needsScriptCheck],
  );
  const scriptState: "unknown" | "none" | "has" = !needsScriptCheck
    ? "unknown"
    : demoMode
      ? (episode && (DEMO_SCRIPT_VERSIONS.get(episode.id)?.length ?? 0) > 0 ? "has" : "none")
      : scriptVersionsState.loading
        ? "unknown"
        : (scriptVersionsState.data?.items.length ?? 0) > 0 ? "has" : "none";

  /* MANUAL-ENTRY:手动加分镜——不依赖 AI 剧本解析的平行通路(产品负责人走查:
     "我就是不想拆分镜,也没必要在这个平台拆分镜")。镜号取本集当前最大值+1,
     与死代码 project-pages.tsx addShot() 同一口径(不 import 死文件,逻辑抄一份)。
     没有场时先自动建一场兜底:场卡列表按场分组渲染(status.data.scenes 来自后端
     INNER JOIN scenes),scene_id 缺省的分镜在这个视图里进不了任何场卡——
     "加了看不见"是真坑,不能只留提示,必须让它有地方落。 */
  const [addingShot, setAddingShot] = React.useState(false);
  const [manualSceneId, setManualSceneId] = React.useState("");
  const scenesForManualAdd = status.data?.scenes ?? [];
  React.useEffect(() => {
    /* 切集后旧集的场 id 必须失效——否则跨集残留会把新分镜挂到别集的场上(后端拒
       「场和分镜不属于同一集」)。以本集场列表是否含当前选中项为唯一判据。 */
    if (!scenesForManualAdd.some((scene) => scene.scene_id === manualSceneId)) {
      setManualSceneId(scenesForManualAdd[0]?.scene_id ?? "");
    }
  }, [scenesForManualAdd, manualSceneId]);

  async function addShot(): Promise<void> {
    if (!episode) return;
    if (demoMode) {
      notify("离线演示只更新当前页面，未写入服务", "info");
      return;
    }
    setAddingShot(true);
    try {
      let targetSceneId: string | null = scenesForManualAdd.some((scene) => scene.scene_id === manualSceneId)
        ? manualSceneId
        : scenesForManualAdd[0]?.scene_id ?? null;
      if (!targetSceneId) {
        /* 0 场兜底:先建一场,不然分镜没处落——按场分组的场卡视图会把它吞掉。 */
        const scene = await api.createScene(episode.id, { scene_no: 1, name: "第 1 场" });
        targetSceneId = scene.id;
      }
      const existingShots = await api.shots(episode.id);
      const nextNo = existingShots.items.reduce((max, shot) => {
        const value = Number.parseInt(shot.shot_no, 10);
        return Number.isFinite(value) ? Math.max(max, value) : max;
      }, 0) + 1;
      await api.createShot(episode.id, { shot_no: String(nextNo), scene_id: targetSceneId, sort_order: nextNo, title: null });
      status.retry();
      window.dispatchEvent(new Event("production-progress-changed"));
      notify("已添加分镜，可进入工作台补文字描述与参考包", "success");
    } catch (reason) {
      notify(businessErrorMessage(reason, "添加分镜失败"), "error");
    } finally {
      setAddingShot(false);
    }
  }

  if (episodes.loading || status.loading) {
    return <div className="p-10 text-sm text-tk-ink-2">正在读取本集生产状态…</div>;
  }
  if (episodes.error) {
    return (
      <div className="p-10">
        <ErrorState message={episodes.error} onRetry={episodes.retry} />
      </div>
    );
  }
  /* R1(PRD v1.1「集的产生」):0 集空态唯一 primary=「建第一集」,建成 retry 入常规动线;
     不再指路去剧本页(两处空态互不指路)。 */
  if (!episode) {
    return (
      <div className="p-10">
        <EmptyState
          icon={<FilmStrip />}
          title="这个项目还没有集"
          description="先建第一集，就能排场、备戏、开拍。"
          action={<CreateEpisodeButton projectId={projectId} nextNo={1} notify={notify} onCreated={() => { episodes.retry(); }} />}
        />
      </div>
    );
  }
  if (status.error || !status.data) {
    return (
      <div className="p-10">
        <ErrorState message={status.error || "本集生产状态读取失败，请重试"} onRetry={status.retry} />
      </div>
    );
  }

  const data = status.data;
  const step = nextStepOf(data, scriptState);
  const scenes = [...data.scenes].sort((a, b) => a.sort_order - b.sort_order);
  const epLabel = episode.name ?? `第 ${episode.episode_no} 集`;
  const totalShots = scenes.reduce((sum, s) => sum + s.shot_summary.total, 0);
  /* EPISODE-RESTORE 判据②:六步流程阶段(判定走 inferProductionProgress 单一真源);
     records 还没读到时条位给「正在读取」占位,不抢答。 */
  const stageStates = episodeFrames.records
    ? episodeStageStates(episodeFrames.records, {
      scriptHas: scriptState === "has",
      deliveredEpisodeIds: episodeFrames.delivered ? new Set([episode.id]) : undefined,
    })
    : null;
  /* EPISODE-RESTORE 判据①:已生成镜头缩略图有多少显示多少;场名按场状态投影反查,
     点击落点=对应分场段落工作台(shotFrameTarget)。 */
  const gridItems: ShotFrameGridItem[] = (episodeFrames.records ?? []).flatMap((record) => {
    const frame = episodeFrames.frames.get(record.shot.id);
    if (!frame) return [];
    const sceneName = record.shot.scene_id
      ? scenes.find((scene) => scene.scene_id === record.shot.scene_id)?.name ?? null
      : null;
    return [{ shot: record.shot, frame, sceneName }];
  });
  /* EPISODE-RESTORE 判据③:无剧本空状态的次级出路(主行动仍是下一步条「去拆剧本」)。 */
  const otherEpisode = sortedEpisodes.find((item) => item.id !== episode.id) ?? null;
  const emptyExits = scriptState === "none"
    ? noScriptExits(projectId, otherEpisode ? { id: otherEpisode.id, label: otherEpisode.name ?? `第 ${otherEpisode.episode_no} 集` } : null)
    : [];

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5 px-10 pb-10 pt-6">
      {/* 集标题行(项目名由壳层 ProjectHeader 显示,此处=集名+集级进度语)
          R173a-2:多集时集名=可点下拉(列全部集+当前高亮,切换走 ?episode= 深链);单集静态标题。 */}
      <div className="flex items-baseline gap-3">
        {sortedEpisodes.length > 1 ? (
          <h1 className="m-0 text-xl font-semibold text-tk-text" style={SERIF}>
            <span className="relative inline-flex items-center">
              <Select
                aria-label="切换集"
                className="h-auto w-auto min-w-52 rounded-lg py-1.5 text-xl font-semibold"
                value={episode.id}
                onChange={(event) => switchEpisode(event.target.value)}
              >
                {sortedEpisodes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {/* 集名=episode.name 优先(种子/建集 name 已含集号,不重复前缀);无名退回「第 N 集」。 */}
                    {item.name ?? `第 ${item.episode_no} 集`}
                  </option>
                ))}
              </Select>
              <CaretDown className="pointer-events-none absolute right-2.5 size-4 text-tk-ink-3" aria-hidden="true" />
            </span>
          </h1>
        ) : (
          <h1 className="text-xl font-semibold text-tk-text" style={SERIF}>{epLabel}</h1>
        )}
        {/* MANUAL-ENTRY:新建集入口——不依赖 AI 解析随时能加集,单集/多集两种形态共用同一处接线,
            不像死代码(project-pages.tsx)那样各写一遍。建成自动切到新集(switchEpisode 已同步
            ?episode= 深链)+ 刷新集列表,不需要用户手动刷新页面。 */}
        <CreateEpisodeButton
          projectId={projectId}
          nextNo={sortedEpisodes.length + 1}
          variant="ghost"
          label="+ 集"
          notify={notify}
          onCreated={(created) => { episodes.retry(); switchEpisode(created.id); }}
        />
        <span className="ml-auto font-tkmono text-xs text-tk-ink-2">
          第 {data.delivered_scene_count}/{data.scene_count} 场已交付
        </span>
      </div>

      {/* ① 整集时间线带(置顶) */}
      <section aria-label="整集时间线" className="flex items-center gap-2.5 overflow-x-auto pb-1">
        {scenes.map((scene) => (
          <TimelineCell
            key={scene.scene_id}
            scene={scene}
            image={sceneImages[scene.scene_id]}
            active={activeSceneId === scene.scene_id}
            onClick={() => {
              setActiveSceneId(scene.scene_id);
              document.getElementById(`scene-card-${scene.scene_id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
          />
        ))}
      </section>

      {/* ② 流程阶段条 + 下一步条(唯一 primary)
          阶段条只读展示(哪几步做完/卡在哪一步),动作仍只有下一步条一个 primary;
          无剧本空状态在 primary 旁给次级出路(先去备素材/看看别集),不是单一出口死路。 */}
      <section aria-label="下一步" className="flex flex-col gap-4 rounded-2xl bg-tk-elevated px-7 py-5">
        <EpisodeStageStrip states={stageStates} error={episodeFrames.error} />
        <div className="flex items-center justify-between gap-4 border-t border-tk-border-1 pt-4">
          <p className="text-[15px] text-tk-text">{step.hint}</p>
          <div className="flex shrink-0 items-center gap-4">
            {emptyExits.map((exit) => (
              <button
                key={exit.key}
                type="button"
                title={exit.hint}
                className="text-[13px] text-tk-ink-2 transition-colors hover:text-tk-text"
                onClick={() => {
                  if (exit.path) navigate(exit.path);
                  else if (exit.episodeId) switchEpisode(exit.episodeId);
                }}
              >
                {exit.label}
              </button>
            ))}
            <Button variant="primary" icon={<ArrowRight />} onClick={step.action}>{step.label} →</Button>
          </div>
        </div>
      </section>

      {/* ②·5 已拍画面:这一集已生成成功的镜头缩略图有多少显示多少,点击进对应分场;
          一镜都还没有时整节不渲染(时间线带/场卡的状态底已交代进度,不摆空网格占地方)。 */}
      {gridItems.length > 0 ? (
        <ShotFrameGrid
          items={gridItems}
          onOpen={(shot) => navigate(shotFrameTarget(projectId, data.episode_id, shot))}
        />
      ) : null}

      {/* ③ 场卡列表 */}
      <section aria-label="场列表" className="flex flex-col gap-3">
        {scenes.map((scene) => {
          const tone = BADGE_TONE[scene.production_status];
          return (
            <article
              key={scene.scene_id}
              id={`scene-card-${scene.scene_id}`}
              role="button"
              tabIndex={0}
              aria-label={`进 ${scene.name} 段落工作台`}
              className="flex cursor-pointer items-center justify-between gap-5 rounded-2xl bg-tk-panel px-5 py-4 transition-colors hover:bg-tk-elevated"
              onClick={() => navigate(sceneWorkbenchPath(projectId, data.episode_id, scene.scene_id))}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); navigate(sceneWorkbenchPath(projectId, data.episode_id, scene.scene_id)); } }}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-tkmono text-[10px] text-tk-ink-3">{scene.scene_no}</span>
                <h3 className="text-[17px] font-semibold text-tk-text" style={SERIF}>{scene.name}</h3>
              </div>
              <div className="flex items-center gap-5">
                <span
                  className={[
                    "rounded-md px-2.5 py-1 text-[11px]",
                    tone === "accent" ? "bg-tk-accent/10 font-medium text-tk-accent" : tone === "weak" ? "bg-tk-elevated text-tk-ink-3" : "bg-tk-elevated text-tk-ink-2",
                  ].join(" ")}
                >
                  {scene.status_label}
                </span>
                {/* F17：裸数字不猜谜——带上「控制包」名,悬浮列七类明细 */}
                <span
                  className="font-tkmono text-[11px] text-tk-ink-2"
                  title={scene.shot_summary.total === 0 ? undefined : `控制包=${laneDefs().map((def) => def.label).join("/")} 七类参考；本场已就位 ${scene.control_package_summary.filled_lane_count}/${scene.control_package_summary.enabled_lane_count} 类`}
                >
                  {scene.shot_summary.total === 0 ? "—" : `控制包 ${scene.control_package_summary.filled_lane_count}/${scene.control_package_summary.enabled_lane_count} 就位`}
                </span>
                {scene.attempt_summary.queue_position != null ? (
                  <span className="text-[11px] text-tk-ink-3">排队第 {scene.attempt_summary.queue_position} · 已自动保存</span>
                ) : null}
                <span className="flex h-14 w-24 items-center justify-center overflow-hidden rounded-md bg-tk-elevated">
                  {sceneImages[scene.scene_id] ? (
                    <img className="h-full w-full object-cover" src={sceneImages[scene.scene_id]} alt={scene.name} loading="lazy" />
                  ) : scene.cover_media ? (
                    scene.cover_media.media_kind === "video" ? (
                      <video className="h-full w-full object-cover" src={scene.cover_media.storage_url} muted playsInline preload="metadata" />
                    ) : (
                      <img className="h-full w-full object-cover" src={scene.cover_media.storage_url} alt={scene.name} loading="lazy" />
                    )
                  ) : (
                    <span className="text-[10px] text-tk-ink-3">尚无版本</span>
                  )}
                </span>
                <button
                  type="button"
                  className="text-[13px] text-tk-ink-2 transition-colors hover:text-tk-text"
                  onClick={(event) => { event.stopPropagation(); gotoPrep(projectId, data.episode_id, scene.scene_id); }}
                >
                  备戏
                </button>
              </div>
            </article>
          );
        })}
      </section>

      {/* ③·5 手动加分镜:次要动作,不抢场卡列表的位置,放在场卡下方与「更多」之间。
          多场时给场选择器(否则新分镜默认落第一场,产品负责人后续想分场理不清);
          0 场时不显场选择器,addShot 内部自动建默认场兜底。 */}
      <section aria-label="手动加分镜" className="flex items-center justify-end gap-2">
        {scenesForManualAdd.length > 1 ? (
          <Select
            aria-label="加分镜目标场"
            className="h-8 w-auto min-w-32 text-xs"
            value={manualSceneId}
            onChange={(event) => setManualSceneId(event.target.value)}
          >
            {scenesForManualAdd.map((scene) => (
              <option key={scene.scene_id} value={scene.scene_id}>{scene.name}</option>
            ))}
          </Select>
        ) : null}
        <Button variant="ghost" size="sm" icon={<Plus />} loading={addingShot} onClick={() => void addShot()}>手动加分镜</Button>
      </section>

      {/* ④ 集级操作(收「更多」):审核队列/交付本集=review-delivery-panels 平移接线(Fable 评审⑤),导出/预览留位 */}
      <section aria-label="集级操作" className="relative flex justify-end">
        <button
          type="button"
          className="text-[13px] text-tk-ink-2 transition-colors hover:text-tk-text"
          onClick={() => setMoreOpen((open) => !open)}
          aria-expanded={moreOpen}
        >
          更多 ▾
        </button>
        {moreOpen ? (
          <div className="absolute bottom-8 right-0 z-10 flex w-48 flex-col rounded-xl bg-tk-elevated py-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
            <button type="button" className="px-4 py-2 text-left text-[13px] text-tk-text hover:bg-tk-panel" onClick={() => { setMoreOpen(false); setReviewOpen(true); }}>审核队列</button>
            <button type="button" className="px-4 py-2 text-left text-[13px] text-tk-text hover:bg-tk-panel" onClick={() => { setMoreOpen(false); setDeliveryOpen(true); }}>交付本集</button>
            {/* F18：「留位」黑话不见客——未实现功能如实标注「即将上线」并置灰 */}
            <button type="button" className="px-4 py-2 text-left text-[13px] text-tk-ink-3 opacity-60" disabled title="导出本集功能预计后续版本开放">导出本集（即将上线）</button>
            {/* 块 2:整集连播从旧枢纽页承接(EpisodePlaybackModal 平移接线,弹窗页脚可下载交付清单)。 */}
            <button type="button" className="px-4 py-2 text-left text-[13px] text-tk-text hover:bg-tk-panel" onClick={() => { setMoreOpen(false); setPlaybackOpen(true); }}>预览全集</button>
          </div>
        ) : null}
      </section>

      {reviewOpen ? (
        <MediaReviewQueueModal
          projectId={projectId}
          episodes={episodes.data?.items ?? []}
          initialEpisodeId={episode.id}
          demoMode={demoMode}
          canWrite
          notify={notify}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}
      {deliveryOpen ? (
        <EpisodeDeliveryModal
          projectId={projectId}
          episode={episode}
          totalShots={totalShots}
          demoMode={demoMode}
          canWrite
          notify={notify}
          initialTab={deliveryInitialTab}
          onClose={() => setDeliveryOpen(false)}
          onDelivered={() => status.retry()}
        />
      ) : null}
      {playbackOpen ? (
        <EpisodePlaybackModal episodeId={episode.id} demoMode={demoMode} notify={notify} onClose={() => setPlaybackOpen(false)} />
      ) : null}
    </div>
  );
}
