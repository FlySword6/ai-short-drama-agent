/* ============================================================
   prep-stage-page.tsx — P-03b 备戏台(批次二收官卡,149:649 定稿)

   SPEC(Fable 逐字转录):Lane Row(实体×2/抽象×1/动态×1)+Button Primary(送入这场戏)/Ghost;
   交互=检索 tab→P-03a、送入这场戏→P-04(0.3s);字段=备戏单{已拉N件→场M},
   就位状态=中性色(V-51),还缺=虚位教学;壳=rail(资产中心 current);accent:主动作 1+壳导航 2,装饰 0。
   随单裁定:
   ① 送入这场戏=备戏单条目写入该场段落级 lanes(P-04 子卡 2 同一真源 seedLanesFromRefs 链)
     ——真栈=api.addProjectAsset(入项目资产实时分桶),demo=该场 lanes localStorage 归入
     (workshop 同款);送完 navigate 到该场工作台,就位数应当涨(端到端真链,不做假搬运);
   ② 还缺=虚位教学:空位行给具体建议(词表 emptyHint 同源,R95 杠杆语气),不是灰框摆设;
   ③ 备戏单暂存=sceneId 命名空间 localStorage(shortdrama_prep_v1:),跨页存活;
   ④ 检索 tab↔备戏 tab=URL 导航(/assets?scope=common ↔ /assets/prep),不玩 JS 态切换。
   备戏行=词表四条(character/scene/lighting/reference_video,词表驱动不写死文案)。
   ============================================================ */
import { ArrowRight, CheckCircle, Package, Plus, X } from "@phosphor-icons/react";
import * as React from "react";
import { api } from "../api";
import { AssetPickDrawer } from "../components/asset-pick-drawer";
import { Badge, ErrorState, Select, Skeleton } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import {
  attachLaneItem,
  laneDefs,
  loadLanesState,
  saveLanesState,
  seedLanesFromRefs,
  type LaneItem,
  type LanesState,
} from "../reference-lanes";
import { laneIdForAssetKind } from "../lane-vocabulary";
import { DEMO_EPISODE_SCENES, demoEpisodes, demoProjectAssetsForProject, demoProjects } from "../demo";
import { navigate, sceneWorkbenchPath } from "../routing";
import { useResource } from "../ui";
import type { Asset, Episode, Project, Scene } from "../types";
import type { PageRuntimeProps } from "./global-pages";

/* 备戏行=SPEC 实体×2/抽象×1/动态×1(词表 id,词表撤词条自动缺席不炸)。 */
const PREP_LANE_IDS = ["character", "scene", "lighting", "reference_video"] as const;

/** 备戏单条目(暂存=资产快照;送入时真栈走 addProjectAsset,demo 走 lanes 归入)。 */
interface PrepItem {
  assetId: string;
  name: string;
  lane: string;
  thumbUrl?: string;
}

const PREP_STORAGE_PREFIX = "shortdrama_prep_v1:";
const PREP_CURRENT_KEY = "shortdrama_prep_current_v1";

function loadPrepList(storage: Storage, sceneId: string): PrepItem[] {
  try {
    const raw = storage.getItem(`${PREP_STORAGE_PREFIX}${sceneId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PrepItem => Boolean(item) && typeof item === "object" && typeof (item as PrepItem).assetId === "string" && typeof (item as PrepItem).lane === "string");
  } catch {
    return [];
  }
}

function savePrepList(storage: Storage, sceneId: string, items: PrepItem[]): void {
  try {
    storage.setItem(`${PREP_STORAGE_PREFIX}${sceneId}`, JSON.stringify(items));
  } catch {
    /* 存储满/私密模式静默降级:本场备戏单仅本次会话可见 */
  }
}

interface PrepCurrent {
  projectId: string;
  episodeId: string;
  sceneId: string;
}

function loadPrepCurrent(storage: Storage): PrepCurrent | null {
  try {
    const raw = storage.getItem(PREP_CURRENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PrepCurrent;
    return parsed && typeof parsed.projectId === "string" && typeof parsed.episodeId === "string" && typeof parsed.sceneId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function PrepStagePage({ demoMode, notify }: PageRuntimeProps): React.JSX.Element {
  const projectsState = useResource(
    () => api.projects(),
    { items: demoProjects, count: demoProjects.length },
    demoMode,
    [],
  );
  const projects = projectsState.data?.items ?? [];
  /* F15：当前场初值先读 URL 深链参数(去备戏带来源上下文直达);不带参再走记忆/兜底。 */
  const [projectId, setProjectId] = React.useState(() => new URLSearchParams(window.location.search).get("project") ?? "");
  const [episodeId, setEpisodeId] = React.useState(() => new URLSearchParams(window.location.search).get("episode") ?? "");
  const [sceneId, setSceneId] = React.useState(() => new URLSearchParams(window.location.search).get("scene") ?? "");

  const episodesState = useResource(
    () => (projectId ? api.episodes(projectId) : Promise.resolve({ items: [] as Episode[], count: 0 })),
    { items: projectId ? demoEpisodes.filter((episode) => episode.project_id === projectId) : [], count: projectId ? demoEpisodes.filter((episode) => episode.project_id === projectId).length : 0 },
    demoMode,
    [projectId],
  );
  const episodes = episodesState.data?.items ?? [];
  const scenesState = useResource(
    () => (episodeId ? api.episodeScenes(episodeId) : Promise.resolve({ items: [] as Scene[], count: 0 })),
    { items: episodeId ? DEMO_EPISODE_SCENES.get(episodeId) ?? [] : [], count: episodeId ? DEMO_EPISODE_SCENES.get(episodeId)?.length ?? 0 : 0 },
    demoMode,
    [episodeId],
  );
  const scenes = scenesState.data?.items ?? [];

  /* 当前场默认链:URL 深链参数优先(F15);无效深链如实回兜底;记忆(跨页存活,裁定③)→ 首个项目/集/场。 */
  React.useEffect(() => {
    if (projects.length === 0) return;
    if (projectId && projects.some((project: Project) => project.id === projectId)) return;
    if (!projectId) {
      const memory = loadPrepCurrent(window.localStorage);
      if (memory && projects.some((project: Project) => project.id === memory.projectId)) {
        setProjectId(memory.projectId);
        setEpisodeId(memory.episodeId);
        setSceneId(memory.sceneId);
        return;
      }
    }
    setProjectId(projects[0]!.id);
  }, [projects, projectId]);
  React.useEffect(() => {
    if (episodes.length === 0) return;
    if (!episodeId || !episodes.some((episode) => episode.id === episodeId)) setEpisodeId(episodes[0]!.id);
  }, [episodes, episodeId]);
  React.useEffect(() => {
    if (scenes.length === 0) return;
    if (!sceneId || !scenes.some((scene) => scene.id === sceneId)) setSceneId(scenes[0]!.id);
  }, [scenes, sceneId]);
  React.useEffect(() => {
    if (!projectId || !episodeId || !sceneId) return;
    try {
      window.localStorage.setItem(PREP_CURRENT_KEY, JSON.stringify({ projectId, episodeId, sceneId } satisfies PrepCurrent));
    } catch { /* 静默降级 */ }
  }, [projectId, episodeId, sceneId]);

  const scene = scenes.find((item) => item.id === sceneId);
  const sceneName = scene?.name?.trim() || "未分场";
  /* F15 横条取数:当前项目/集名(深链上下文亮明用)。 */
  const currentProject = projects.find((item: Project) => item.id === projectId);
  const currentEpisode = episodes.find((item) => item.id === episodeId);
  /* 项目名自带《》(demo/用户起名)就不再包一层,避免《《双书名号》》 */
  const currentProjectTitle = currentProject && (currentProject.name.startsWith("《") ? currentProject.name : `《${currentProject.name}》`);

  /* 该场段落级 lanes 真源(P-04 同一取数):项目资产实时分桶=已就位。 */
  const refsState = useResource(
    () => (projectId ? api.projectAssets(projectId) : Promise.resolve({ items: [], count: 0 })),
    { items: projectId ? demoProjectAssetsForProject(projectId) : [], count: projectId ? demoProjectAssetsForProject(projectId).length : 0 },
    demoMode,
    [projectId],
  );
  const refs = refsState.data?.items ?? [];
  const seeded = React.useMemo(() => seedLanesFromRefs(refs), [refs]);

  /* 备戏单(裁定③:sceneId 命名空间 localStorage,跨页存活)。 */
  const [prepItems, setPrepItems] = React.useState<PrepItem[]>([]);
  React.useEffect(() => {
    setPrepItems(sceneId ? loadPrepList(window.localStorage, sceneId) : []);
  }, [sceneId]);
  function persistPrep(next: PrepItem[]): void {
    setPrepItems(next);
    if (sceneId) savePrepList(window.localStorage, sceneId, next);
  }

  const prepLanes = React.useMemo(() => laneDefs().filter((def) => (PREP_LANE_IDS as readonly string[]).includes(def.id)), []);
  const [pickLane, setPickLane] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);

  const stagedCount = prepItems.length;
  const readyCount = prepLanes.reduce((sum, def) => sum + (seeded[def.id] ?? []).length, 0);
  const missingCount = prepLanes.filter((def) => (seeded[def.id] ?? []).length === 0 && !prepItems.some((item) => item.lane === def.id)).length;

  /** R2:资产类型 → 备戏 lane(laneIdForAssetKind 词表闭包判定=s15 唯一消费点口径;
     命中栏不在备戏四栏内(如音频栏)如实 null,回退开抽屉的 lane)。 */
  function laneOfAsset(asset: Asset): string | null {
    const id = laneIdForAssetKind(asset.asset_kind ?? "");
    return id && prepLanes.some((def) => def.id === id) ? id : null;
  }

  /** R2 多选带入:过滤已在单,一次 persist+一次 toast(不逐件响)。 */
  function stageMany(assets: Asset[], fallbackLane: string): void {
    const existing = new Set(prepItems.map((item) => item.assetId));
    const fresh = assets
      .filter((asset) => !existing.has(asset.id))
      .map((asset): PrepItem => ({
        assetId: asset.id,
        name: asset.display_name || asset.name || "未命名资产",
        lane: laneOfAsset(asset) ?? fallbackLane,
        thumbUrl: asset.thumbnail_url || asset.storage_url || undefined,
      }));
    if (fresh.length === 0) {
      notify("选的件都已经在备戏单里", "info");
      return;
    }
    persistPrep([...prepItems, ...fresh]);
    notify(`已拉进备戏单 ${fresh.length} 件 → ${sceneName}`, "success");
  }

  /** 拉一件进备戏单(暂存,不入项目资产——送入才写真源)。 */
  function stageAsset(lane: string, asset: Asset): Promise<boolean> {
    const item: PrepItem = {
      assetId: asset.id,
      name: asset.display_name || asset.name || "未命名资产",
      lane,
      thumbUrl: asset.thumbnail_url || asset.storage_url || undefined,
    };
    if (prepItems.some((existing) => existing.assetId === item.assetId)) {
      notify("这件已经在备戏单里", "info");
      return Promise.resolve(false);
    }
    persistPrep([...prepItems, item]);
    notify(`已拉进备戏单 → ${sceneName}`, "success");
    return Promise.resolve(true);
  }

  function unstage(item: PrepItem): void {
    persistPrep(prepItems.filter((existing) => existing.assetId !== item.assetId));
  }

  /* 送入这场戏(裁定①,端到端真链):真栈=逐件 addProjectAsset(已在项目跳过),
     项目资产实时分桶让该场 lanes 就位涨;demo=归入该场 lanes localStorage(workshop 同款);
     送完清空已送条目并 navigate 到该场工作台。 */
  async function sendToScene(): Promise<void> {
    if (sending || prepItems.length === 0 || !projectId || !episodeId || !sceneId) return;
    setSending(true);
    try {
      if (demoMode) {
        let lanes: LanesState = loadLanesState(window.localStorage, sceneId, seedLanesFromRefs(refs));
        for (const item of prepItems) {
          lanes = attachLaneItem(lanes, item.lane, {
            id: `asset:${item.assetId}`,
            name: item.name,
            kind: item.lane === "reference_video" ? "video" : "image",
            thumbUrl: item.thumbUrl,
            origin: "workshop",
          } satisfies LaneItem);
        }
        saveLanesState(window.localStorage, sceneId, lanes);
        notify(`已送入 ${sceneName}(离线演示只写本机备戏链)`, "info");
      } else {
        const existing = new Set(refs.map((ref) => ref.asset_entity_id || ref.asset_id || ref.asset?.id || ""));
        let added = 0;
        for (const item of prepItems) {
          if (existing.has(item.assetId)) continue;
          await api.addProjectAsset(projectId, item.assetId);
          added += 1;
        }
        notify(added > 0 ? `已送入 ${sceneName}:${added} 件进项目资产,就位随真源涨` : `这些件本就在项目资产里,已在 ${sceneName} 就位`, "success");
      }
      persistPrep([]);
      navigate(sceneWorkbenchPath(projectId, episodeId, sceneId));
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : "送入失败，请稍后重试", "error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" aria-label="备戏台">
      {/* 头带:页名+检索/备戏 tab(URL 导航,裁定④)+当前场三级选择+送入这场戏(主动作 1) */}
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-tk-ink-1">备戏台</h1>
        <span className="inline-flex items-center gap-0.5 rounded-md border border-tk-border-1 bg-tk-bg p-0.5" role="group" aria-label="资产视图">
          <button
            type="button"
            className={cn("inline-flex items-center rounded-sm px-3 py-1.5 text-xs text-tk-ink-2 transition-colors duration-150 hover:text-tk-ink-1")}
            onClick={() => navigate("/assets?scope=common")}
          >
            检索
          </button>
          <button
            type="button"
            aria-pressed="true"
            className={cn("inline-flex items-center rounded-sm px-3 py-1.5 text-xs bg-tk-elevated font-semibold text-tk-ink-1 shadow-sm")}
          >
            备戏
          </button>
        </span>
        <span className="ml-auto">
          <Button
            size="sm"
            variant="primary"
            icon={<CheckCircle />}
            disabled={stagedCount === 0 || sending || !sceneId}
            loading={sending}
            title={stagedCount === 0 ? "先往备戏单拉件" : `把备戏单 ${stagedCount} 件送入 ${sceneName} 的段落控制包`}
            onClick={() => void sendToScene()}
          >
            送入这场戏
          </Button>
        </span>
      </header>

      {/* 当前场三级选择(独立一行,不与头带抢宽) */}
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="选择项目" value={projectId} onChange={(event) => { setProjectId(event.target.value); setEpisodeId(""); setSceneId(""); }}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </Select>
        <Select aria-label="选择集" value={episodeId} onChange={(event) => { setEpisodeId(event.target.value); setSceneId(""); }}>
          {episodes.map((episode) => <option key={episode.id} value={episode.id}>第 {episode.episode_no} 集{episode.name ? ` · ${episode.name}` : ""}</option>)}
        </Select>
        <Select aria-label="选择场" value={sceneId} onChange={(event) => setSceneId(event.target.value)}>
          {scenes.map((item, index) => <option key={item.id} value={item.id}>场 {index + 1}{item.name ? ` · ${item.name}` : ""}</option>)}
        </Select>
      </div>

      {/* F15：备戏上下文横条——「正在为哪场备戏」必须一目了然,料送错场=错误结果;不对先切上面的场 */}
      {currentProject && currentEpisode && scene ? (
        <p className="rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-2 text-xs text-tk-ink-2" aria-label="备戏上下文" role="status">
          正在为 <strong className="text-tk-ink-1">{currentProjectTitle}第 {currentEpisode.episode_no} 集 · {sceneName}</strong> 备戏，送入的料会写进这一场；不对就先切上面的场。
        </p>
      ) : null}

      {/* 备戏单计数行(字段:已拉 N 件→场 M;就位状态=中性色 V-51) */}
      <p className="font-tkmono text-xs text-tk-ink-3" aria-label="备戏单计数">
        已拉 {stagedCount} 件 → {sceneName} · 已就位 {readyCount} · 还缺 {missingCount} 行
      </p>
      {refsState.error ? <ErrorState message="项目资产读取失败，就位计数暂不可用" onRetry={refsState.retry} /> : null}

      {/* 备戏行×4:就位条目(中性色)+待传条目(可撤)+还缺=虚位教学(词表 emptyHint 同源) */}
      <div className="grid items-start gap-3 min-[720px]:grid-cols-2" >
        {prepLanes.map((def) => {
          const ready = seeded[def.id] ?? [];
          const staged = prepItems.filter((item) => item.lane === def.id);
          const empty = ready.length === 0 && staged.length === 0;
          return (
            <section key={def.id} className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label={`备戏 ${def.label}`}>
              <header className="flex items-center gap-2">
                <h2 className="text-xs font-semibold text-tk-ink-1">{def.label}</h2>
                {ready.length > 0 ? <Badge tone="neutral">已就位 {ready.length}</Badge> : null}
                {staged.length > 0 ? <Badge tone="neutral">已拉待传 {staged.length}</Badge> : null}
                <button
                  type="button"
                  className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-tk-ink-3 underline-offset-2 hover:text-tk-ink-1 hover:underline"
                  aria-label={`从资产库选${def.label}进备戏单`}
                  onClick={() => setPickLane(def.id)}
                >
                  <Plus aria-hidden="true" className="size-3" />选
                </button>
              </header>
              {ready.length > 0 ? (
                <ul className="flex flex-wrap gap-1" aria-label={`${def.label}已就位`}>
                  {ready.map((item) => (
                    <li key={item.id} className="rounded-sm bg-tk-elevated px-1.5 py-0.5 text-[11px] text-tk-ink-2">{item.name}</li>
                  ))}
                </ul>
              ) : null}
              {staged.length > 0 ? (
                <ul className="flex flex-wrap gap-1" aria-label={`${def.label}待传`}>
                  {staged.map((item) => (
                    <li key={item.assetId} className="inline-flex items-center gap-1 rounded-sm border border-tk-border-1 bg-tk-elevated px-1.5 py-0.5 text-[11px] text-tk-ink-1">
                      {item.name}
                      <button type="button" aria-label={`撤出 ${item.name}`} className="text-tk-ink-2 hover:text-tk-ink-1" onClick={() => unstage(item)}>
                        <X aria-hidden="true" className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {empty ? (
                /* 还缺=虚位教学(裁定②):词表 emptyHint=R95 杠杆语气(缺什么料、去哪补),不是灰框摆设 */
                <p className="rounded-md border border-dashed border-tk-border-1 px-3 py-2 text-[11px] leading-4 text-tk-ink-3">{def.emptyHint || `还没有${def.label}参考。`}</p>
              ) : null}
            </section>
          );
        })}
      </div>

      <p className="flex items-center gap-1.5 text-[11px] leading-4 text-tk-ink-2">
        <Package aria-hidden="true" className="size-3.5" />
        备戏单只暂存在本机,点「送入这场戏」才写进该场的段落控制包;送完直达工作台接着备。
        <button type="button" className="inline-flex items-center gap-0.5 text-tk-ink-3 underline-offset-2 hover:text-tk-ink-1 hover:underline" onClick={() => { if (projectId && episodeId && sceneId) navigate(sceneWorkbenchPath(projectId, episodeId, sceneId)); }}>
          直达工作台<ArrowRight aria-hidden="true" className="size-3" />
        </button>
      </p>

      {pickLane ? (
        <AssetPickDrawer
          demoMode={demoMode}
          notify={notify}
          refs={refs}
          mode="browse"
          /* R2 多选带入:不锁单 lane 类型,勾选多件一次带入,按资产类型归 lane;
             目标 T2 点击比 ≤1.2(勾选×3+带入×1 取代三次抽屉往返) */
          kind=""
          multi
          onAdd={(asset) => stageAsset(laneOfAsset(asset) ?? pickLane, asset)}
          onAddMany={async (assets) => { stageMany(assets, pickLane); }}
          onRemove={async () => { notify("备戏台只管拉入，移出项目资产请去项目资产页", "info"); }}
          onClose={() => setPickLane(null)}
        />
      ) : null}
      {refsState.loading ? <Skeleton className="h-4 w-24" /> : null}
    </div>
  );
}
