/* ============================================================
   shot-image-results.tsx — #164 G10 镜头图片产物与选定稿(P-17a 语义,1079:146)

   语义真源=PRD 生产章 §十 + Figma P-17a(2026-08-07 改版):
   - 定稿=镜头级指针:点「选用这张」把某张设为本镜定稿;其余版本不删、可改判;
     改判=对另一张再点一次「选用」,不需要先取消(§10.1)。
   - 两种定稿来源必须视觉区分(§10.3):人点过的=实心 teal「定稿 · 手选」;
     系统默认的=描边 teal「定稿 · 默认(最新)」;没人选时默认最新成功的一张,
     失败图永不当默认(服务端 resolveEffectiveShotMedia 只收 succeeded+persisted)。
   - 「定稿」与「存进资产库」是两个独立动作、两个独立标记,可同时挂(§10.2):
     定稿只管本镜用哪张;入库=以后别的镜头也能拿它当参考(registerMediaResultAsset)。
   - 失败图不算完成:不占位、永不可选,给原因与下一步(换个说法重试/看看提示词);
     在途图「出完才能选」,等待态必须有动效(issue #164:thinking-orbs,working 态)。
   ============================================================ */
import * as React from "react";
import { ThinkingOrb } from "thinking-orbs";
import { ArrowSquareOut, FolderPlus, Images } from "@phosphor-icons/react";
import { api, type ShotMediaItem } from "../api";
import type { GenerationTask, Shot } from "../types";
import { formatDateTime, useResource } from "../ui";
import { ErrorState, Skeleton, Textarea } from "../components/ui/primitives";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { businessErrorMessage } from "../error-copy";
import type { PageRuntimeProps } from "./global-pages";

/** 图片版本清单:只取图片条目,按生成时间正序(卡号 01 起编,与 P-17a 一致)。 */
export function shotImageVersions(items: readonly ShotMediaItem[]): ShotMediaItem[] {
  return items
    .filter((item) => item.media_kind === "image")
    .sort((a, b) => {
      const byTime = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
      return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
    });
}

/** 定稿徽章分型:manual=实心「定稿 · 手选」;latest_default=描边「定稿 · 默认(最新)」;历史版本=null。 */
export function shotImageFinalBadge(item: ShotMediaItem): "manual" | "default" | null {
  if (!item.is_primary) return null;
  return item.selection_source === "manual" ? "manual" : "default";
}

/** 定稿状态条(P-17a):当前定稿是哪张、哪种来源;没有定稿时明说规则。 */
export function shotImageFinalStatusLine(items: readonly ShotMediaItem[]): string {
  const versions = shotImageVersions(items);
  const index = versions.findIndex((item) => item.is_primary);
  if (index < 0) return "本镜还没有定稿——出图后默认用最新成功的一张,失败图永不当定稿。";
  const no = String(index + 1).padStart(2, "0");
  const source = versions[index]!.selection_source === "manual" ? "手选" : "默认 · 最新";
  return `本镜定稿:${no}(${source})。没人选时默认用最新成功的一张;换定稿=对另一张再点一次「选用」。`;
}

/** 画幅与尺寸如实呈现(有原始像素就说真的,没有就不编)。 */
export function shotImageGeometryLabel(item: ShotMediaItem): string {
  const { width_px: w, height_px: h } = item;
  if (!w || !h) return "图片";
  const orientation = h > w ? "竖屏" : w > h ? "横屏" : "方图";
  return `${orientation} · ${w}×${h}`;
}

/** 本镜图片任务分型:在途(排队/生成中)与确定失败(成功产物走 shot-media,不在这里)。 */
export function splitShotImageTasks(tasks: readonly GenerationTask[], shotId: string): {
  inflight: GenerationTask[];
  failed: GenerationTask[];
} {
  const own = tasks.filter((task) => task.shot_id === shotId && task.media_kind === "image");
  return {
    inflight: own.filter((task) => task.status === "pending" || task.status === "running"),
    failed: own.filter((task) => task.status === "failed"),
  };
}

export function ShotImageResults({ shot, tasks, demoMode, notify, refreshKey, onChanged, onOpenBatch }: {
  shot: Shot;
  /** 本场全部生成任务(父层 6s 轮询同源);本面板自取本镜图片态的在途/失败。 */
  tasks: readonly GenerationTask[];
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  /** 在途任务全落终态的边沿由父层 +1,驱动本面板重拉(回图不用刷新页面)。 */
  refreshKey: number;
  /** 定稿/提示词写动 shots 后的回调:父层重拉 shots(行态与编译稿同版)。 */
  onChanged: () => void;
  /** 「再出一批」/失败卡「换个说法重试」出口:单镜批量生图抽屉(付费动作仍在抽屉内经人工确认)。 */
  onOpenBatch: (shot: Shot) => void;
}): React.JSX.Element {
  const mediaState = useResource(
    () => api.shotMediaItems(shot.id),
    { items: [] as ShotMediaItem[], count: 0 },
    demoMode,
    [shot.id, refreshKey],
  );
  const versions = React.useMemo(() => shotImageVersions(mediaState.data?.items ?? []), [mediaState.data]);
  const { inflight, failed } = React.useMemo(() => splitShotImageTasks(tasks, shot.id), [tasks, shot.id]);
  const [filter, setFilter] = React.useState<"all" | "final">("all");
  const [selectingId, setSelectingId] = React.useState<string | null>(null);
  const [registeringId, setRegisteringId] = React.useState<string | null>(null);
  const [promptViewTaskId, setPromptViewTaskId] = React.useState<string | null>(null);
  const [retryDraft, setRetryDraft] = React.useState<{ taskId: string; text: string } | null>(null);
  const [retrySaving, setRetrySaving] = React.useState(false);
  const selectButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());
  /* 换镜/清单刷新后收拢临时态,不把上一镜的草稿带过来。 */
  React.useEffect(() => {
    setFilter("all");
    setPromptViewTaskId(null);
    setRetryDraft(null);
  }, [shot.id, mediaState.data]);

  const visibleVersions = filter === "final" ? versions.filter((item) => item.is_primary) : versions;

  async function selectFinal(item: ShotMediaItem): Promise<void> {
    if (selectingId) return; // 一次一个,防连点重复写指针
    setSelectingId(item.id);
    try {
      await api.setShotPrimary(shot.id, item.id);
      notify(`已把这张设为本镜定稿,下游默认用它`, "success");
      mediaState.retry();
      onChanged();
    } catch (reason) {
      notify(businessErrorMessage(reason, "设定稿失败,请重试"), "error");
    } finally {
      setSelectingId(null);
    }
  }

  async function registerToLibrary(item: ShotMediaItem): Promise<void> {
    if (registeringId) return;
    setRegisteringId(item.id);
    try {
      await api.registerMediaResultAsset(item.id);
      notify("已存进资产库,以后别的镜头也能拿它当参考", "success");
      mediaState.retry();
    } catch (reason) {
      notify(businessErrorMessage(reason, "存进资产库失败,请重试"), "error");
    } finally {
      setRegisteringId(null);
    }
  }

  /** 「换成别的」:不改数据,把注意力引到第一张可选的卡上(P-17a 同名钮)。 */
  function focusFirstSelectable(): void {
    const target = versions.find((item) => !item.is_primary);
    const button = target ? selectButtonRefs.current.get(target.id) : undefined;
    button?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    button?.focus();
  }

  /** 失败卡「换个说法重试」:新说法先落 image_prompt(批量抽屉的图片提示词取数源),
      再开单镜抽屉走估价→人工确认——付费闸门不变,AI 不替人提交。 */
  async function saveRetryPrompt(): Promise<void> {
    if (!retryDraft || retrySaving) return;
    setRetrySaving(true);
    try {
      if (!demoMode) await api.updateShot(shot.id, { image_prompt: retryDraft.text });
      onChanged();
      setRetryDraft(null);
      onOpenBatch(shot);
    } catch (reason) {
      notify(businessErrorMessage(reason, "提示词保存失败,请重试"), "error");
    } finally {
      setRetrySaving(false);
    }
  }

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-2" aria-label={`镜头 #${shot.shot_no} 图片产物`} data-testid={`shot-image-results-${shot.shot_no}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-tk-ink-2">本镜图片</span>
        {versions.length > 0 ? <span className="font-tkmono text-[10px] text-tk-ink-3">{versions.length} 版</span> : null}
        {/* 过滤 chips(P-17a):全部/定稿。「这一批/之前出的」需要批次字段,wire 没有,不编。 */}
        <div className="flex items-center gap-1" role="group" aria-label="图片过滤">
          {([["all", "全部"], ["final", "定稿"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] transition-colors duration-150",
                filter === key ? "border-tk-border-2 bg-tk-hover text-tk-ink-1" : "border-tk-border-1 text-tk-ink-3 hover:border-tk-border-2",
              )}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          icon={<Images />}
          title="按本镜当前提示词与控制包再出一批图:先估价后人工确认,确认才创建任务"
          onClick={() => onOpenBatch(shot)}
        >再出一批</Button>
      </div>

      {/* 定稿状态条(P-17a):两种来源分得开;规则说死,不靠猜。 */}
      <p className="text-[11px] leading-4 text-tk-ink-3" data-testid="final-status-line">{shotImageFinalStatusLine(versions)}</p>

      {mediaState.loading ? (
        <Skeleton className="h-28 w-full" />
      ) : mediaState.error ? (
        <ErrorState message="图片产物读取失败,请重试" onRetry={mediaState.retry} />
      ) : versions.length === 0 && inflight.length === 0 && failed.length === 0 ? (
        <p className="text-[11px] text-tk-ink-3">这镜还没有图片产物。点「再出一批」或头带「批量生图」,先估价后人工确认,回图后这里直接选。</p>
      ) : visibleVersions.length === 0 && filter === "final" ? (
        <p className="text-[11px] text-tk-ink-3">本镜还没有定稿。切回「全部」对任意一张点「选用这张」。</p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2" aria-label="图片版本">
          {visibleVersions.map((item) => {
            const badge = shotImageFinalBadge(item);
            const no = String(versions.indexOf(item) + 1).padStart(2, "0");
            const fromLibrary = item.origin_label === "从素材库选用";
            const registered = item.registered_asset_media_id !== null;
            return (
              <li
                key={item.id}
                className={cn(
                  "flex flex-col gap-1 rounded-md border p-1.5",
                  badge ? "border-tk-accent/60" : "border-tk-border-1 bg-tk-panel",
                )}
                data-testid={`shot-image-card-${no}`}
              >
                <div className="relative">
                  {item.storage_url ? (
                    <img alt={`${no} · 镜头 ${shot.shot_no} 图片版本`} className="aspect-[3/4] w-full rounded-sm object-cover" src={item.storage_url} />
                  ) : (
                    <div className="flex aspect-[3/4] w-full items-center justify-center rounded-sm bg-tk-hover text-[10px] text-tk-ink-3">无缩略图</div>
                  )}
                  {/* 徽章区:定稿(手选实心/默认描边)与已入资产库各自独立,可同时挂(§10.2)。 */}
                  <div className="absolute left-1 top-1 flex flex-col items-start gap-0.5">
                    {badge === "manual" ? (
                      <span className="rounded-sm bg-tk-accent px-1 py-0.5 text-[10px] font-medium text-tk-accent-ink" data-testid="badge-final-manual">定稿 · 手选</span>
                    ) : badge === "default" ? (
                      <span className="rounded-sm border border-tk-accent/70 px-1 py-0.5 text-[10px] text-tk-accent" data-testid="badge-final-default">定稿 · 默认(最新)</span>
                    ) : null}
                    {registered ? (
                      <span className="rounded-sm border border-tk-border-1 bg-tk-panel/80 px-1 py-0.5 text-[10px] text-tk-ink-3" data-testid="badge-registered">已入资产库</span>
                    ) : null}
                    {fromLibrary ? (
                      <span className="rounded-sm border border-tk-border-1 bg-tk-panel/80 px-1 py-0.5 text-[10px] text-tk-ink-3">从素材库选用</span>
                    ) : null}
                  </div>
                </div>
                <span className="font-tkmono text-[10px] text-tk-ink-3">{no} · {shotImageGeometryLabel(item)}</span>
                {item.created_at ? <span className="font-tkmono text-[9px] text-tk-ink-3">{formatDateTime(item.created_at)}</span> : null}
                <div className="flex items-center gap-1">
                  {badge === "manual" ? (
                    <button
                      type="button"
                      className="rounded-sm border border-tk-border-1 px-1.5 py-0.5 text-[10px] text-tk-ink-3 hover:border-tk-border-2 hover:text-tk-ink-1"
                      title="这张已经是定稿;想换,对另一张点「选用这张」"
                      onClick={focusFirstSelectable}
                    >换成别的</button>
                  ) : (
                    <button
                      type="button"
                      ref={(node) => {
                        if (node) selectButtonRefs.current.set(item.id, node);
                        else selectButtonRefs.current.delete(item.id);
                      }}
                      disabled={selectingId !== null}
                      className="rounded-sm border border-tk-border-2 px-1.5 py-0.5 text-[10px] text-tk-ink-1 hover:border-tk-accent/60 disabled:opacity-50"
                      title="设为本镜定稿:下游(生视频/拼片/交付)默认取这张;其余版本仍在,可再改判"
                      data-testid={`select-final-${no}`}
                      onClick={() => void selectFinal(item)}
                    >
                      {selectingId === item.id ? "设置中…" : "选用这张"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-0.5 rounded-sm px-1 py-0.5 text-[10px] text-tk-ink-3 hover:text-tk-ink-1"
                    title="看大图:打开我们自己存下来的原文件,不是厂商临时地址"
                    onClick={() => {
                      if (item.storage_url) window.open(item.storage_url, "_blank", "noopener");
                    }}
                  >
                    <ArrowSquareOut aria-hidden="true" className="size-3" />看大图
                  </button>
                </div>
                {/* 存进资产库=第二个独立动作:只对本镜生成且未登记的图开放;失败/在途图根本不进本清单。 */}
                {!fromLibrary && !registered ? (
                  <button
                    type="button"
                    disabled={registeringId !== null}
                    className="inline-flex items-center gap-0.5 self-start rounded-sm border border-tk-border-2 px-1.5 py-0.5 text-[10px] text-tk-ink-1 hover:border-tk-accent/60 disabled:opacity-50"
                    title="存进资产库:生视频要靠它保住人物一致——不入库,生出来的人可能跟这张不是同一个;顺带以后别的镜头也能引用。与定稿互不影响,两个标记可同时成立"
                    data-testid={`register-asset-${no}`}
                    onClick={() => void registerToLibrary(item)}
                  >
                    <FolderPlus aria-hidden="true" className="size-3" />
                    {registeringId === item.id ? "存入中…" : "存进资产库"}
                  </button>
                ) : null}
              </li>
            );
          })}

          {/* 在途卡:等待态必须有动效(issue #164)——working 态 orb+如实状态,出完才能选。 */}
          {filter === "all" ? inflight.map((task) => (
            <li key={task.generation_request_id} className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-tk-border-1 p-1.5" data-testid="shot-image-inflight">
              <ThinkingOrb state="working" size={64} aria-label="正在出图" />
              <span className="text-[10px] text-tk-ink-2">
                正在出图{typeof task.queue_position === "number" && task.queue_position > 0 ? ` · 排队第 ${task.queue_position}` : ""}
              </span>
              <span className="rounded-sm border border-tk-border-1 px-1.5 py-0.5 text-[10px] text-tk-ink-3" aria-disabled="true">出完才能选</span>
            </li>
          )) : null}

          {/* 失败卡:不算完成、永不可选;给原因与下一步(换个说法重试/看看提示词)。 */}
          {filter === "all" ? failed.map((task) => (
            <li key={task.generation_request_id} className="flex flex-col gap-1 rounded-md border border-dashed border-tk-border-1 p-1.5" data-testid="shot-image-failed">
              <span className="text-[10px] leading-3 text-tk-ink-2">
                这张没出来{task.display_reason ? ` —— ${task.display_reason}` : ""}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="rounded-sm border border-tk-border-2 px-1.5 py-0.5 text-[10px] text-tk-ink-1 hover:border-tk-accent/60"
                  onClick={() => setRetryDraft((current) => (current?.taskId === task.generation_request_id ? null : {
                    taskId: task.generation_request_id,
                    text: shot.image_prompt?.trim() || task.prompt?.trim() || "",
                  }))}
                >换个说法重试</button>
                {task.prompt ? (
                  <button
                    type="button"
                    className="rounded-sm px-1 py-0.5 text-[10px] text-tk-ink-3 hover:text-tk-ink-1"
                    onClick={() => setPromptViewTaskId((current) => (current === task.generation_request_id ? null : task.generation_request_id))}
                  >看看提示词</button>
                ) : null}
              </div>
              {promptViewTaskId === task.generation_request_id && task.prompt ? (
                <p className="max-h-20 overflow-y-auto rounded-sm bg-tk-panel px-1.5 py-1 text-[10px] leading-3 text-tk-ink-3">{task.prompt}</p>
              ) : null}
              {retryDraft?.taskId === task.generation_request_id ? (
                <div className="flex flex-col gap-1" data-testid="retry-prompt-editor">
                  <Textarea
                    aria-label="换个说法(写回本镜图片提示词)"
                    rows={3}
                    value={retryDraft.text}
                    onChange={(event) => setRetryDraft({ ...retryDraft, text: event.target.value })}
                  />
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setRetryDraft(null)}>取消</Button>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={retrySaving}
                      disabled={retrySaving || !retryDraft.text.trim()}
                      title="先把新说法存为本镜图片提示词,再开批量抽屉:先估价后人工确认,确认才创建任务"
                      onClick={() => void saveRetryPrompt()}
                    >保存并重试</Button>
                  </div>
                </div>
              ) : null}
            </li>
          )) : null}
        </ul>
      )}

      {/* 说明(P-17a 底部四条压缩为两条,语义不丢):选用≠入库;失败不算完成。 */}
      <p className="text-[10px] leading-4 text-tk-ink-3">
        选用=设为本镜定稿,下游默认用它;存进资产库=生视频靠它保住人物一致,顺带别的镜头也能引用——两码事,可同时成立。
        没出来的不算完成、不占位;看大图/入库拿到的都是我们自己存的原文件,不是厂商临时地址。
      </p>
    </div>
  );
}
