/* 显式 React import:门禁(node:test + tsx classic JSX)渲染断言与 Vite react-jsx 双兼容
   (同 ui.tsx / components/reference-lanes.tsx 的既有写法)。
   本文件保持 css-free:production-stepper.css 由挂载点 app.tsx 引入,
   这样门禁测试可以直接 import 本文件做 renderToStaticMarkup 真渲染断言。 */
import * as React from "react";
import { ArrowRight, Check, CheckCircle, SkipForward } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { demoEpisodesForProject, demoShotMedia, demoShots } from "./demo";
import { demoDeliveredEpisodeIds } from "./demo-review-delivery";
import {
  PRODUCTION_STEPS,
  inferProductionProgress,
  type ProductionProgress,
  type ProductionShotRecord,
  type ProductionStepKey,
} from "./production-progress";
import { navigate, productionViewPath, shotWorkbenchPath } from "./routing";
import { Button } from "./ui";

export function ProductionStepper({ projectId, demoMode }: { projectId: string; demoMode: boolean }): React.JSX.Element {
  const { records, deliveredEpisodeIds, error, loading, refresh } = useProductionShotRecords(projectId, demoMode);
  const progress = records ? inferProductionProgress(records, deliveredEpisodeIds) : null;

  if (error) return <section className="production-stepper production-stepper-error"><span>生产进度暂时无法读取</span><button type="button" onClick={() => void refresh()}>重试</button></section>;
  if (!progress) return <section className="production-stepper production-stepper-loading" aria-busy={loading}><span>正在读取生产进度…</span></section>;

  return (
    <section className="production-stepper" aria-label="项目生产进度">
      <ol>{PRODUCTION_STEPS.map((step, index) => {
        const state = index < progress.currentIndex ? "complete" : index === progress.currentIndex ? "current" : "upcoming";
        /* S46 C-3：每步都署名（DC walkthrough P2-5：③④⑤ 匿名圆圈不知道后续是什么）；
           仍保持 C1 单行紧凑条，窄屏（<1180px）才回落为只显示当前步名。 */
        return (
          <li className={state} key={step.key}>
            <span className="step-dot">{state === "complete" ? <Check /> : index + 1}</span>
            <span className="step-name">{state === "current" ? <strong>{step.label}</strong> : step.label}</span>
          </li>
        );
      })}</ol>
      <div className="production-stepper-next"><span>{progress.description}</span><Button variant="primary" icon={<ArrowRight />} onClick={() => navigate(progressTarget(projectId, progress))}>{progress.actionLabel}</Button></div>
    </section>
  );
}

/** 跨集生产记录取数 + 刷新触发器:「production-progress-changed」事件 + 15s 轮询。
    15s 轮询全站只在这一个 hook——两个消费方 ProductionStepper(分镜列表页)与
    工作台内 S78 入口按路由互斥挂载(fullBleed 工作台不渲染 stepper),任何时刻
    最多一个在跑,不会双份轮询。
    EPISODE-RESTORE 起,集详情页(production-view-page,/production 路由)另挂
    同名事件监听做取数刷新,但不挂轮询;与本 hook 消费方路由互斥
    (/production 不含 /storyboards),任何时刻最多一处生效。 */
export function useProductionShotRecords(projectId: string, demoMode: boolean): {
  records: ProductionShotRecord[] | null;
  /** 每集至少一条交付记录的集 id 集合(「已交付」终态的事实来源)。 */
  deliveredEpisodeIds: ReadonlySet<string> | undefined;
  error: string;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [records, setRecords] = useState<ProductionShotRecord[] | null>(null);
  const [deliveredEpisodeIds, setDeliveredEpisodeIds] = useState<ReadonlySet<string> | undefined>(undefined);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (demoMode) {
        /* K2O/GP-04：demo 进度按 projectId 门控；交付集合与记录同门控——
           空记录的项目不给交付集，免得空记录撞上 demo-project-2 的交付记录被误判「已交付」。 */
        const records = demoRecords(projectId);
        setRecords(records);
        setDeliveredEpisodeIds(records.length > 0 ? demoDeliveredEpisodeIds() : new Set());
      } else {
        const loaded = await loadProductionRecords(projectId);
        setRecords(loaded);
        setDeliveredEpisodeIds(await loadDeliveredEpisodeIds(loaded));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "生产进度读取失败");
    } finally {
      setLoading(false);
    }
  }, [demoMode, projectId]);

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener("production-progress-changed", onChanged);
    window.addEventListener("episode-delivered", onChanged);
    const timer = window.setInterval(onChanged, 15_000);
    return () => {
      window.removeEventListener("production-progress-changed", onChanged);
      window.removeEventListener("episode-delivered", onChanged);
      window.clearInterval(timer);
    };
  }, [refresh]);

  return { records, deliveredEpisodeIds, error, loading, refresh };
}

/* ---------- S78:工作台内「去下一个待生成分镜」一键入口(统筹裁决 R68;S77 回执 §2① 记的缺口) ---------- */

/** 各待生成阶段的一句人话,只服务入口的目标描述;「什么算待生成」的判定不在这里。 */
const NEXT_PENDING_STAGE_COPY: Partial<Record<ProductionStepKey, string>> = {
  image: "还缺图片",
  video: "还缺视频",
  primary: "待选主版本",
};

/** 把扫描顺序重排到当前分镜之后(尾部绕回开头),让 inferProductionProgress 的
    「第一个待生成」=「从当前位置往后数的下一个待生成」。只是输入顺序重排,
    判定规则零复制;当前分镜不在列表时原样返回。 */
export function recordsStartingAfterCurrent(records: ProductionShotRecord[], currentShotId: string): ProductionShotRecord[] {
  const index = records.findIndex((record) => record.shot.id === currentShotId);
  if (index < 0) return records;
  return [...records.slice(index + 1), ...records.slice(0, index + 1)];
}

/** 跳转目标与 stepper CTA 同语义:缺图/缺视频→该分镜工作台(shots URL=换乘口,按归属场落场级工作台);
   待选主版本→带 ?library=1;交付态→生产页整集连播;已交付→生产页交付历史深链(K2-A)。
   块 2 起列表级落点=生产页(集视图),不再产旧 /storyboards 列表 URL。 */
export function nextPendingTarget(projectId: string, progress: ProductionProgress, currentEpisodeId: string): string {
  if (progress.current === "delivered") {
    const episode = currentEpisodeId || progress.episodeId || "";
    return `${productionViewPath(projectId)}?episode=${encodeURIComponent(episode)}&delivery=history`;
  }
  if (progress.current === "delivery") {
    return `${productionViewPath(projectId)}?episode=${encodeURIComponent(currentEpisodeId)}&playback=1`;
  }
  if (!progress.episodeId || !progress.shotId) return productionViewPath(projectId);
  const workbench = shotWorkbenchPath(projectId, progress.episodeId, progress.shotId);
  return progress.current === "primary" ? `${workbench}?library=1` : workbench;
}

/** S78:工作台内「去下一个待生成分镜」入口。纯展示组件——取数与刷新由调用方
   (workbench-page 的 WorkbenchNextPending)走 useProductionShotRecords,
   本组件不挂任何事件监听或定时器。
   形态=与时间线细带同款的单行:有待生成=整行一个活按钮;没有待生成=连播活按钮;
   当前这条是唯一待生成=非交互提示(指向自己是死按钮,不渲染)。 */
export function NextPendingShotEntry({ records, projectId, episodeId, shotId, error, onRetry }: {
  records: ProductionShotRecord[] | null;
  projectId: string;
  episodeId: string;
  shotId: string;
  error?: string;
  onRetry?: () => void;
}): React.JSX.Element | null {
  const stripClass = "flex w-full items-center justify-between gap-3 rounded-lg border border-border-1 bg-surface-1 px-4 py-2 text-xs";
  const stripButtonClass = `${stripClass} text-ink-2 outline-none transition-colors duration-150 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent`;
  if (error) {
    return (
      <div className={`${stripClass} text-ink-2`} role="alert">
        <span>生产进度暂时无法读取，「下一个待生成」稍后自动恢复</span>
        {onRetry ? <button type="button" className="shrink-0 text-accent-text underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={onRetry}>重试</button> : null}
      </div>
    );
  }
  if (!records) {
    return (
      <div className={`${stripClass} text-ink-2`} aria-busy="true" aria-label="下一个待生成分镜">
        <span>正在查找下一个待生成分镜…</span>
      </div>
    );
  }
  const progress = inferProductionProgress(recordsStartingAfterCurrent(records, shotId));
  if (progress.current === "storyboard") return null;
  if (progress.current === "delivery") {
    return (
      <button
        type="button"
        className={stripButtonClass}
        onClick={() => navigate(nextPendingTarget(projectId, progress, episodeId))}
      >
        <span className="flex items-center gap-2"><CheckCircle aria-hidden="true" className="size-4 text-success" />待生成项已清零，没有待生成的分镜了</span>
        <span className="flex shrink-0 items-center gap-1 text-accent-text">{progress.actionLabel}<ArrowRight aria-hidden="true" className="size-3.5" /></span>
      </button>
    );
  }
  const target = records.find((record) => record.shot.id === progress.shotId);
  if (!target) return null;
  const stageCopy = NEXT_PENDING_STAGE_COPY[progress.current] ?? "待生成";
  if (target.shot.id === shotId) {
    return (
      <div className={`${stripClass} text-ink-2`} role="status">
        <span className="flex items-center gap-2"><SkipForward aria-hidden="true" className="size-4 shrink-0 text-accent-text" />当前这条就是最后一个待生成分镜（{stageCopy}）</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={`去下一个待生成分镜：第 ${target.episode.episode_no} 集 #${target.shot.shot_no}`}
      className={stripButtonClass}
      onClick={() => navigate(nextPendingTarget(projectId, progress, episodeId))}
    >
      <span className="flex min-w-0 items-center gap-2"><SkipForward aria-hidden="true" className="size-4 shrink-0 text-accent-text" /><span className="truncate">下一个待生成：第 {target.episode.episode_no} 集 #{target.shot.shot_no} · {stageCopy}</span></span>
      <span className="flex shrink-0 items-center gap-1 text-accent-text">{progress.actionLabel}<ArrowRight aria-hidden="true" className="size-3.5" /></span>
    </button>
  );
}

/** 跨集生产记录取数：集→分镜→产物 全量读一遍（首页「继续上次工作」也用它推导，保持单一真源）。 */
export async function loadProductionRecords(projectId: string): Promise<ProductionShotRecord[]> {
  const episodes = (await api.episodes(projectId)).items;
  const shotsByEpisode = await Promise.all(episodes.map(async (episode) => ({
    episode,
    shots: (await api.shots(episode.id)).items,
  })));
  const records = await Promise.all(shotsByEpisode.flatMap(({ episode, shots }) => shots.map(async (shot) => ({
    episode,
    shot,
    media: (await api.shotMedia(shot.id)).items,
  }))));
  return records;
}

/** 每集至少一条交付记录的集 id 集合;单集查询失败按未交付计(进度留在交付前,不说谎)。 */
async function loadDeliveredEpisodeIds(records: ProductionShotRecord[]): Promise<ReadonlySet<string>> {
  const episodeIds = [...new Set(records.map((record) => record.episode.id))];
  const delivered = await Promise.all(episodeIds.map(async (episodeId) => {
    try {
      const page = await api.episodeDeliveries(episodeId, 1, 1);
      return page.total > 0 ? episodeId : null;
    } catch {
      return null;
    }
  }));
  return new Set(delivered.filter((id): id is string => id !== null));
}

/* K2-A(GP-27):demo 进度与 demo 数据同源——媒体直接读 demoShotMedia,
   不再固定 media: [](旧写法让 stepper 永远停在「素材 #1 还没有可用图片」,
   与素材卡上的已持久化产物自相矛盾)。
   K2O/GP-04:进度 fixture 按 projectId 门控——非属主项目(含陌生 id)如实空记录,
   stepper 落「先导入剧本」空态,不顶 demo-project-2 的集/镜/媒体。 */
function demoRecords(projectId: string): ProductionShotRecord[] {
  const episode = demoEpisodesForProject(projectId)[0];
  if (!episode) return [];
  return demoShots.map((shot) => ({ episode, shot, media: demoShotMedia[shot.id] ?? [] }));
}

function progressTarget(projectId: string, progress: ProductionProgress): string {
  return nextPendingTarget(projectId, progress, progress.episodeId ?? "");
}
