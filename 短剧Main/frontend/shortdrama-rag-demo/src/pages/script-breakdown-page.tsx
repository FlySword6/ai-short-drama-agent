/* ============================================================
   script-breakdown-page.tsx — P-06 剧本分镜(批次二第 2 卡,168:816 定稿)

   SPEC(Fable 逐字转录):左剧本原文右拆解草稿(6 场)+待确认态;
   组件=Button Primary(确认分镜表)/Ghost(重新拆解/导入 docx);
   交互=确认分镜表→本页刷新为「已确认·只读分镜表」(块 3 欠件④承接位),
   去 P-07(项目资产)的出口在只读表脚(裁定⑤);壳=rail+二级条(剧本 current);
   字段=docs/contracts/v0.2.0/script-import-enhancements.md——拆解只到场/镜结构,
   提示词在资产与生产环节组装(本页不展示/不组装生成提示词);
   accent 账:主动作 1(确认分镜表)+进行中 1(running badge),装饰 0。

   裁定(FABLE-B2-P06-RELEASE):②xlsx 导入线本卡不碰不集成;「导入 docx」后端
   无端点(Sol 包未落地)→钮在场禁用+如实 title(不做假按钮,合同入口不假装可用);
   ③window.confirm→页内确认条(与 3a/3b 确认区同构);④页面身份「剧本分镜」
   (home-next-step 锚已授权随迁)。
   左栏原文=ScriptVersion.scriptText(后端加字段中,缺口已报;未落地前如实空态)。
   ============================================================ */
import {
  ArrowClockwise,
  ArrowRight,
  CheckCircle,
  FileArrowDown,
  FileText,
  FilmStrip,
  Plus,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  ApiClientError,
  api,
  type ScriptBreakdownRun,
  type ScriptBreakdownRunDetail,
  type ScriptBreakdownRunStatus,
  type ScriptBreakdownShotCandidate,
  type ScriptVersion,
} from "../api";
import { capabilityErrorCopy } from "../capability-status";
import { platformRoleForCopy } from "../capabilities-state";
import { CapabilityStatusBar } from "../components/capability-status";
import { Button } from "../components/ui/button";
import { cn } from "../components/ui/cn";
import { CreateEpisodeButton } from "../components/create-episode-button";
import {
  Badge,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
  Skeleton,
  Textarea,
} from "../components/ui/primitives";
import { DEMO_SCRIPT_RUN_DETAIL, DEMO_SCRIPT_RUNS, DEMO_SCRIPT_VERSIONS, demoEpisodes } from "../demo";
import { navigate, projectAssetsPath, projectScriptBreakdownPath } from "../routing";
import { formatDateTime, useResource } from "../ui";
import { businessErrorMessage } from "../error-copy";
import { clearLocalDraft, readLocalDraft, scriptDraftKey, writeLocalDraft } from "../local-drafts";
import type { PageRuntimeProps } from "./global-pages";

const RUN_STATUS_META: Record<ScriptBreakdownRunStatus, { label: string; tone: "accent" | "success" | "warning" | "danger" | "neutral" }> = {
  queued: { label: "排队中", tone: "neutral" },
  running: { label: "拆解中", tone: "accent" },
  draft: { label: "待确认", tone: "warning" },
  failed: { label: "拆解失败", tone: "danger" },
  confirmed: { label: "已确认", tone: "success" },
  discarded: { label: "已放弃", tone: "neutral" },
  superseded: { label: "已被替换", tone: "neutral" },
};

const STAGE_STATUS_META: Record<string, { label: string; tone: "accent" | "success" | "warning" | "danger" | "neutral" }> = {
  pending: { label: "等待", tone: "neutral" },
  running: { label: "进行中", tone: "accent" },
  succeeded: { label: "完成", tone: "success" },
  failed: { label: "失败", tone: "danger" },
};

function stageLabel(stageKey: string): string {
  if (stageKey === "structure") return "整体结构";
  if (stageKey === "assets") return "资产候选";
  const scene = stageKey.match(/^shots:scene:(\d+)$/);
  if (scene) return `分镜 · 第 ${Number(scene[1]) + 1} 场`;
  return stageKey;
}

const EMPTY_VERSIONS = { items: [] as ScriptVersion[], count: 0 };
const EMPTY_RUNS = { items: [] as ScriptBreakdownRun[], count: 0 };

type BusyAction = "save-version" | "start" | "confirm" | "discard" | "resume" | null;

/** 场级草稿行(SPEC 字段:场号/镜头数/场景/人物/一句话)+镜结构 chips(只结构不组装提示词)。 */
function SceneDraftRow({ sceneIndex, name, summary, shots }: {
  sceneIndex: number;
  name: string | null;
  summary: string;
  shots: ScriptBreakdownShotCandidate[];
}): React.JSX.Element {
  const characters = [...new Set(shots.flatMap((shot) => shot.characterNames))];
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-2">
      <header className="flex flex-wrap items-center gap-2">
        <strong className="text-xs font-semibold text-tk-ink-1">第 {sceneIndex + 1} 场{name ? ` · ${name}` : ""}</strong>
        <span className="font-tkmono text-[11px] text-tk-ink-3">{shots.length} 镜</span>
        {characters.length > 0 ? (
          <span className="ml-auto flex flex-wrap gap-1">
            {characters.map((character) => <Badge key={character} tone="neutral">{character}</Badge>)}
          </span>
        ) : null}
      </header>
      {summary ? <p className="text-[11px] leading-4 text-tk-ink-3">{summary}</p> : null}
      {shots.length > 0 ? (
        <div className="flex flex-wrap gap-1" role="list" aria-label={`第 ${sceneIndex + 1} 场镜头`}>
          {shots.map((shot) => (
            <span role="listitem" key={shot.candidateId} className="rounded-sm bg-tk-panel px-1.5 py-0.5 font-tkmono text-[10px] text-tk-ink-3" title={shot.lineIndices.length > 0 ? `剧本第 ${shot.lineIndices[0]! + 1} 行起` : undefined}>
              #{shot.shotNo} · {shot.durationSec}s
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** F19：5xx 永久故障识别（后端 5xx 信封统一话术=「服务暂时不可用」）——此类故障重试无意义。 */
export function isBreakdownServerFault(message: string): boolean {
  return message.includes("服务暂时不可用");
}

/** F19 错误文案：永久故障说人话+给联系入口，不诱导无效重试；其余(瞬断)如实透传。 */
export function breakdownRunsErrorCopy(message: string): string {
  return isBreakdownServerFault(message) ? "拆解服务出故障了，已记录，请联系管理员" : message;
}

export function ScriptBreakdownPage({ projectId, demoMode, notify, capabilities }: PageRuntimeProps & { projectId: string }): React.JSX.Element {
  const [episodeId, setEpisodeId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("episode"),
  );
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showVersionForm, setShowVersionForm] = useState(false);
  const [versionTitle, setVersionTitle] = useState("");
  const [scriptText, setScriptText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [draftRestored, setDraftRestored] = useState(false);

  /* F01 长文本本地草稿：粘贴的整集剧本随输入落 localStorage(按项目+集隔离),
     401/刷新/误关后重开表单自动恢复;保存成功显式清除。 */
  const draftKey = scriptDraftKey(projectId, episodeId);
  useEffect(() => {
    if (!showVersionForm || demoMode) return;
    if (scriptText || versionTitle) return;
    const raw = readLocalDraft(draftKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { title?: unknown; text?: unknown };
      setVersionTitle(typeof parsed.title === "string" ? parsed.title : "");
      setScriptText(typeof parsed.text === "string" ? parsed.text : "");
      setDraftRestored(Boolean(parsed.text));
    } catch { /* 草稿损坏按没有处理 */ }
    // 仅在打开表单瞬间尝试恢复;输入内容不触发重恢复
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showVersionForm, draftKey, demoMode]);
  useEffect(() => {
    if (!showVersionForm || demoMode) return;
    if (!scriptText && !versionTitle) return;
    writeLocalDraft(draftKey, JSON.stringify({ title: versionTitle, text: scriptText }));
  }, [showVersionForm, scriptText, versionTitle, draftKey, demoMode]);

  const episodesState = useResource(
    () => api.episodes(projectId),
    { items: demoEpisodes, count: demoEpisodes.length },
    demoMode,
    [projectId],
  );
  const episodes = useMemo(() => episodesState.data?.items ?? [], [episodesState.data]);

  useEffect(() => {
    if ((!episodeId || !episodes.some((episode) => episode.id === episodeId)) && episodes.length > 0) {
      setEpisodeId(episodes[0]!.id);
    }
  }, [episodeId, episodes]);

  const versionsState = useResource(
    () => (episodeId ? api.scriptVersions(episodeId) : Promise.resolve(EMPTY_VERSIONS)),
    episodeId ? { items: DEMO_SCRIPT_VERSIONS.get(episodeId) ?? [], count: DEMO_SCRIPT_VERSIONS.get(episodeId)?.length ?? 0 } : EMPTY_VERSIONS,
    demoMode,
    [episodeId],
  );
  const versions = useMemo(() => versionsState.data?.items ?? [], [versionsState.data]);

  useEffect(() => {
    if ((!selectedVersionId || !versions.some((version) => version.id === selectedVersionId)) && versions.length > 0) {
      setSelectedVersionId(versions[0]!.id);
    }
  }, [selectedVersionId, versions]);
  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? null;

  const runsState = useResource(
    () => (episodeId ? api.scriptBreakdowns(episodeId) : Promise.resolve(EMPTY_RUNS)),
    episodeId ? { items: DEMO_SCRIPT_RUNS.get(episodeId) ?? [], count: DEMO_SCRIPT_RUNS.get(episodeId)?.length ?? 0 } : EMPTY_RUNS,
    demoMode,
    [episodeId],
  );
  /* 最新运行在前;默认选中最新一条(两栏常驻草稿,不待人工点选)。 */
  const runs = useMemo(() => [...(runsState.data?.items ?? [])].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), [runsState.data]);

  useEffect(() => {
    if ((!selectedRunId || !runs.some((run) => run.id === selectedRunId)) && runs.length > 0) {
      setSelectedRunId(runs[0]!.id);
    }
  }, [selectedRunId, runs]);

  const detailState = useResource(
    () => (selectedRunId ? api.scriptBreakdown(selectedRunId) : Promise.resolve(null as ScriptBreakdownRunDetail | null)),
    (selectedRunId ? DEMO_SCRIPT_RUN_DETAIL.get(selectedRunId) ?? null : null) as ScriptBreakdownRunDetail | null,
    demoMode,
    [selectedRunId],
  );
  const detail = detailState.data;
  const activeRun = detail?.run ?? runs.find((run) => run.id === selectedRunId) ?? null;
  const draftRun = activeRun?.status === "draft" ? activeRun : null;

  /* 排队中/拆解中的运行每 3s 拉一次,直到出结果(候选生成是异步的)。 */
  const hasActive = runs.some((run) => run.status === "queued" || run.status === "running")
    || (detail ? detail.run.status === "queued" || detail.run.status === "running" : false);
  useEffect(() => {
    if (demoMode || !hasActive) return;
    const timer = window.setInterval(() => {
      runsState.retry();
      if (selectedRunId) detailState.retry();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [demoMode, hasActive, selectedRunId, runsState.retry, detailState.retry]);

  async function saveVersion(): Promise<void> {
    if (!episodeId || busy) return;
    if (demoMode) {
      notify("离线演示不会保存剧本版本", "info");
      return;
    }
    if (!scriptText.trim()) {
      notify("请先粘贴剧本文本", "error");
      return;
    }
    setBusy("save-version");
    try {
      const version = await api.createScriptVersion(episodeId, { title: versionTitle || undefined, scriptText });
      notify(`已保存剧本版本 v${version.versionNo}`, "success");
      clearLocalDraft(draftKey);
      setDraftRestored(false);
      setScriptText("");
      setVersionTitle("");
      setShowVersionForm(false);
      setSelectedVersionId(version.id);
      versionsState.retry();
    } catch (reason) {
      notify(businessErrorMessage(reason, "保存失败，请重试"), "error");
    } finally {
      setBusy(null);
    }
  }

  async function startBreakdown(): Promise<void> {
    if (!episodeId || !selectedVersionId || busy) return;
    if (demoMode) {
      notify("离线演示不会发起真实拆解", "info");
      return;
    }
    setBusy("start");
    setConfirming(false);
    try {
      const created = await api.createScriptBreakdown(episodeId, { scriptVersionId: selectedVersionId });
      setSelectedRunId(created.run.id);
      notify("已开始拆解，完成后请人工确认", "success");
      runsState.retry();
    } catch (reason) {
      /* S46-A：AI 网关类 503 走统一口径（角色感知）,不再原文转述后端「请联系管理员」。 */
      const unified = capabilityErrorCopy(reason instanceof ApiClientError ? reason : null, platformRoleForCopy(capabilities));
      notify(unified ?? businessErrorMessage(reason, "发起失败，请重试"), "error");
    } finally {
      setBusy(null);
    }
  }

  /* 确认采用(裁定③:页内确认条取代 window.confirm;SPEC:确认分镜表→P-07 项目资产)。 */
  async function confirmRun(run: ScriptBreakdownRun): Promise<void> {
    if (busy) return;
    if (demoMode) {
      notify("离线演示不会写入正式分镜", "info");
      return;
    }
    setBusy("confirm");
    try {
      const result = await api.confirmScriptBreakdown(run.id);
      notify(
        result.outcome === "already_confirmed"
          ? "这次拆解此前已经确认过"
          : `已写入正式分镜：${result.sceneCount} 场、${result.shotCount} 个分镜`,
        "success",
      );
      setConfirming(false);
      /* 块 3 欠件④(退役承接表第五项):确认后不再立即跳走——本页刷新成「已确认·只读分镜表」
         (确认后跳转位),用户看清确认出了什么;去 P-07 的出口保留在只读表脚(裁定⑤)。 */
      runsState.retry();
      detailState.retry();
    } catch (reason) {
      notify(businessErrorMessage(reason, "确认失败，请重试"), "error");
    } finally {
      setBusy(null);
    }
  }

  async function discardRun(run: ScriptBreakdownRun): Promise<void> {
    if (busy) return;
    if (demoMode) {
      notify("离线演示不会改动拆解运行", "info");
      return;
    }
    setBusy("discard");
    try {
      await api.discardScriptBreakdown(run.id);
      notify("已放弃这次拆解", "success");
      setConfirming(false);
      runsState.retry();
      detailState.retry();
    } catch (reason) {
      notify(businessErrorMessage(reason, "操作失败，请重试"), "error");
    } finally {
      setBusy(null);
    }
  }

  async function resumeRun(run: ScriptBreakdownRun): Promise<void> {
    if (busy) return;
    if (demoMode) {
      notify("离线演示不会改动拆解运行", "info");
      return;
    }
    setBusy("resume");
    try {
      await api.resumeScriptBreakdown(run.id);
      notify("已从断点继续拆解", "success");
      runsState.retry();
      detailState.retry();
    } catch (reason) {
      notify(businessErrorMessage(reason, "继续拆解失败，请重试"), "error");
    } finally {
      setBusy(null);
    }
  }

  const confirmDisabledReason = !selectedVersionId
    ? "先保存一个剧本版本"
    : !activeRun
      ? "先发起拆解"
      : activeRun.status === "queued" || activeRun.status === "running"
        ? "拆解进行中，完成后可确认"
        : activeRun.status !== "draft"
          ? RUN_STATUS_META[activeRun.status].label
          : null;

  return (
    <div className="flex flex-col gap-4" aria-label="剧本分镜">
      {/* 头带:页名/选集/运行状态;右侧=导入 docx(Ghost,后端端点未落地如实禁用)+
          重新拆解(Ghost)+确认分镜表(Primary,SPEC 主动作 1 处) */}
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-tk-ink-1">剧本分镜</h1>
        {episodes.length > 0 ? (
          <>
            <Select
              aria-label="选择集"
              className="min-w-40"
              value={episodeId ?? ""}
              onChange={(event) => {
                const nextId = event.target.value || null;
                setEpisodeId(nextId);
                setSelectedVersionId(null);
                setSelectedRunId(null);
                setConfirming(false);
                /* R173a-2:与生产页同口径——切集同步 ?episode= 深链(可分享/刷新可复现)。 */
                navigate(`${projectScriptBreakdownPath(projectId)}${nextId ? `?episode=${encodeURIComponent(nextId)}` : ""}`);
              }}
            >
              {episodes.map((episode) => (
                <option key={episode.id} value={episode.id}>
                  {/* R173a-2 统一:name 优先(已含集号不重复前缀),无名退回「第 N 集」——与生产页同口径。 */}
                  {episode.name ?? `第 ${episode.episode_no} 集`}
                </option>
              ))}
            </Select>
            {/* R1:有集后建集收进集切换位(ghost,非 primary,V-24) */}
            <CreateEpisodeButton
              projectId={projectId}
              nextNo={episodes.length + 1}
              variant="ghost"
              label="+ 集"
              notify={notify}
              onCreated={(episode) => { episodesState.retry(); setEpisodeId(episode.id); }}
            />
          </>
        ) : null}
        {activeRun ? <Badge tone={RUN_STATUS_META[activeRun.status].tone}>{RUN_STATUS_META[activeRun.status].label}</Badge> : null}
        {episodes.length > 0 ? (
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={<FileArrowDown />} disabled title="docx 导入稍后开放，先粘贴剧本文本新建版本拆解">导入 docx</Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowClockwise />}
            disabled={!selectedVersionId || busy !== null}
            title={selectedVersionId ? "按选中的剧本版本发起拆解" : "先保存一个剧本版本"}
            loading={busy === "start"}
            onClick={() => void startBreakdown()}
          >
            {/* F22：从没拆过叫「开始拆解」,有过草稿才叫「重新拆解」 */}
            {runs.length > 0 ? "重新拆解" : "开始拆解"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<CheckCircle />}
            disabled={!draftRun || busy !== null}
            title={confirmDisabledReason ?? "确认后写入正式分镜，去项目资产补齐"}
            onClick={() => setConfirming(true)}
          >
            确认分镜表
          </Button>
        </span>
        ) : null}
      </header>

      {/* 页内确认条(裁定③,与 3a/3b 确认区同构):不点开不渲染 */}
      {confirming && draftRun && detail ? (
        <section className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="确认采用拆解">
          <p className="text-xs leading-5 text-tk-ink-2">
            确认采用这次拆解？<strong className="text-tk-ink-1">{detail.draft.sceneDivisions.length} 场、{detail.draft.shotCandidates.length} 个分镜</strong>写入正式分镜。代价清单（按服务端真实行为）：
          </p>
          {/* F20：确认前把「会换下什么/带不走什么/保留什么」说清——只讲破不讲立,没人敢点头 */}
          <ul className="flex flex-col gap-1 text-xs leading-5 text-tk-ink-2">
            <li>· <strong className="text-tk-ink-1">会换下</strong>：本集上一版拆解出的场与分镜（含你在分镜上手改过的提示词），换下后旧分镜不再显示；</li>
            <li>· <strong className="text-tk-ink-1">带不走</strong>：旧分镜上已生成的图片/视频不会挂到新分镜，新分镜要重新生成（会再花积分）；</li>
            <li>· <strong className="text-tk-ink-1">会保留</strong>：剧本版本、项目资产、已产生的积分消耗记录。</li>
          </ul>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>再想想</Button>
            <Button size="sm" variant="primary" loading={busy === "confirm"} disabled={busy !== null} onClick={() => void confirmRun(draftRun)}>看清了，确认写入</Button>
          </div>
        </section>
      ) : null}

      {episodesState.error ? <ErrorState message={episodesState.error} onRetry={episodesState.retry} /> : null}

      {episodesState.loading ? <LoadingState /> : episodes.length === 0 ? (
        <EmptyState
          icon={<FilmStrip />}
          title="这个项目还没有集"
          description="先建第一集，就能往里贴剧本拆解。"
          action={<CreateEpisodeButton projectId={projectId} nextNo={1} notify={notify} onCreated={() => { episodesState.retry(); }} />}
        />
      ) : (
        <>
          {/* S46-A：AI 能力状态条（模型×开关）前置亮灯——网关未开启/模型未配置
              在点「重新拆解」之前就讲清,管理员直达「去配置」,成员写明缺项。 */}
          <CapabilityStatusBar kind="ai_assist" role={platformRoleForCopy(capabilities)} demoMode={demoMode} />

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {/* 左栏:剧本原文(版本 chips+正文;正文=scriptText,后端字段未落地前如实空态) */}
            <aside className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="剧本原文">
              <header className="flex items-center justify-between gap-2">
                <h2 className="text-section-title text-tk-ink-1">剧本原文</h2>
                <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setShowVersionForm((current) => !current)}>新建版本</Button>
              </header>
              {versionsState.loading ? (
                <Skeleton className="h-6 w-40" />
              ) : versions.length === 0 ? (
                <p className="px-1 py-3 text-xs text-tk-ink-3">还没有剧本版本，粘贴整集剧本文本保存后即可发起拆解。</p>
              ) : (
                <div className="flex flex-wrap items-center gap-1" role="group" aria-label="剧本版本">
                  {versions.map((version) => (
                    <button
                      key={version.id}
                      type="button"
                      aria-pressed={version.id === selectedVersionId}
                      title={formatDateTime(version.createdAt)}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors duration-150",
                        version.id === selectedVersionId ? "border-tk-border-2 bg-tk-hover text-tk-ink-1" : "border-tk-border-1 bg-tk-elevated text-tk-ink-3 hover:border-tk-border-2",
                      )}
                      onClick={() => setSelectedVersionId(version.id)}
                    >
                      v{version.versionNo}{version.title ? ` · ${version.title}` : ""}
                    </button>
                  ))}
                </div>
              )}
              {selectedVersion?.scriptText ? (
                <pre className="max-h-[68vh] overflow-auto whitespace-pre-wrap rounded-md bg-tk-elevated px-3 py-2 font-sans text-[13px] leading-6 text-tk-ink-2">{selectedVersion.scriptText}</pre>
              ) : selectedVersion ? (
                <p className="rounded-md bg-tk-elevated px-3 py-2 text-[11px] leading-4 text-tk-ink-2">这版剧本的正文暂时读不到；新建版本保存后可对照原文。</p>
              ) : null}
              {showVersionForm ? (
                <div className="flex flex-col gap-3 rounded-md border border-tk-border-1 bg-tk-elevated p-3">
                  <Field label="版本名（可选）">
                    <Input value={versionTitle} onChange={(event) => setVersionTitle(event.target.value)} placeholder="例如：初稿" maxLength={255} />
                  </Field>
                  <Field label="剧本文本" hint="按行书写：场景行、动作行、角色台词均可。">
                    <Textarea
                      rows={10}
                      value={scriptText}
                      onChange={(event) => setScriptText(event.target.value)}
                      placeholder={"夜·内 旧宅客厅\n林晚推开门，愣住。\n林晚：你怎么会在这里？"}
                    />
                  </Field>
                  {/* F01：草稿恢复明示——粘贴的长文本在本地有底,丢不了 */}
                  {draftRestored ? <p className="text-[11px] text-tk-ink-3">已恢复上次未保存的草稿（自动暂存在本机，保存版本后自动清除）。</p> : null}
                  <div className="flex gap-2">
                    <Button variant="secondary" icon={<CheckCircle />} loading={busy === "save-version"} onClick={() => void saveVersion()}>保存版本</Button>
                    <Button variant="ghost" onClick={() => setShowVersionForm(false)}>取消</Button>
                  </div>
                </div>
              ) : null}
            </aside>

            {/* 右栏:拆解草稿(场/镜结构+待确认态;拆解只到场/镜结构,提示词在资产与生产环节组装) */}
            <section className="flex flex-col gap-2 rounded-lg border border-tk-border-1 bg-tk-panel px-4 py-3" aria-label="拆解草稿">
              <header className="flex items-center justify-between gap-2">
                {/* 块 3 欠件④:已确认态=只读分镜表承接位,栏题如实(不再是「草稿」)。 */}
                <h2 className="text-section-title text-tk-ink-1">{detail?.run.status === "confirmed" ? "分镜表 · 已确认（只读）" : "拆解草稿"}</h2>
                {runs.length > 1 ? (
                  <Select aria-label="拆解运行" className="min-w-36" value={selectedRunId ?? ""} onChange={(event) => { setSelectedRunId(event.target.value || null); setConfirming(false); }}>
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {RUN_STATUS_META[run.status].label} · {formatDateTime(run.createdAt)}
                      </option>
                    ))}
                  </Select>
                ) : null}
              </header>
              {/* F21：报错与空状态不同屏——错误进条件链互斥渲染;
                  F19：5xx 永久故障给「请联系管理员」且不再诱导无效重试(瞬断保留重试)。 */}
              {runsState.loading ? (
                <div className="flex flex-col gap-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
              ) : runsState.error ? (
                <ErrorState
                  message={breakdownRunsErrorCopy(runsState.error)}
                  onRetry={isBreakdownServerFault(runsState.error) ? undefined : runsState.retry}
                />
              ) : runs.length === 0 ? (
                <EmptyState icon={<FileText />} title="还没有拆解草稿" description="左边选好剧本版本，点「开始拆解」；拆解只产出场与镜头结构，确认采用后才写入正式分镜。" />
              ) : detailState.loading ? (
                <LoadingState label="正在读取拆解草稿" />
              ) : detailState.error ? (
                <ErrorState message={detailState.error} onRetry={detailState.retry} />
              ) : detail ? (
                <>
                  {detail.run.displayReason ? (
                    <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{detail.run.displayReason}</p>
                  ) : null}
                  {detail.run.status === "queued" || detail.run.status === "running" || detail.run.status === "failed" ? (
                    <ul className="flex flex-wrap gap-1.5" aria-label="拆解阶段">
                      {detail.stages.map((stage) => {
                        const stageMeta = STAGE_STATUS_META[stage.status] ?? STAGE_STATUS_META.pending!;
                        return (
                          <li key={stage.stageKey} className="flex items-center gap-1.5 rounded-md border border-tk-border-1 px-2 py-1 text-[11px]">
                            <Badge tone={stageMeta.tone}>{stageMeta.label}</Badge>
                            <span className="text-tk-ink-2">{stageLabel(stage.stageKey)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {detail.draft.storySummary ? (
                    <p className="rounded-md bg-tk-elevated px-3 py-2 text-[11px] leading-4 text-tk-ink-2">{detail.draft.storySummary}</p>
                  ) : null}
                  {detail.validation.issues.length > 0 ? (
                    <ul className="flex flex-col gap-1" aria-label="需要留意">
                      {detail.validation.issues.map((issue, index) => (
                        <li key={`${issue.code}-${index}`} className="flex items-start gap-1.5 text-[11px] leading-4 text-tk-ink-2">
                          <WarningCircle className="mt-0.5 size-3.5 flex-none text-tk-ink-3" aria-hidden="true" />
                          <span>{issue.message}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {detail.draft.sceneDivisions.length > 0 ? (
                    <div className="flex flex-col gap-2" aria-label="场次草稿">
                      <p className="font-tkmono text-[11px] text-tk-ink-3">
                        共 {detail.draft.sceneDivisions.length} 场 · {detail.draft.shotCandidates.length} 镜{detail.validation.totalDurationSec > 0 ? ` · 约 ${Math.round(detail.validation.totalDurationSec)} 秒` : ""}
                      </p>
                      {detail.draft.sceneDivisions.map((scene) => (
                        <SceneDraftRow
                          key={scene.sceneIndex}
                          sceneIndex={scene.sceneIndex}
                          name={scene.name}
                          summary={scene.summary}
                          shots={detail.draft.shotCandidates.filter((shot) => shot.sceneIndex === scene.sceneIndex)}
                        />
                      ))}
                    </div>
                  ) : detail.run.status === "draft" ? (
                    <p className="px-1 py-3 text-xs text-tk-ink-3">这次拆解没有拆出场次，请检查剧本文本后重新拆解。</p>
                  ) : null}
                  {/* 运行态动作行:待确认=提示确认路径;失败=继续/放弃;已确认=P-07 出口 */}
                  {detail.run.status === "draft" ? (
                    <p className="border-t border-tk-border-1 pt-2 text-[11px] leading-4 text-tk-ink-3">
                      待确认 · 逐场核对后点头带「确认分镜表」写入正式分镜；不合适可
                      <button type="button" className="ml-1 text-tk-ink-2 underline-offset-2 hover:underline" disabled={busy !== null} onClick={() => void discardRun(detail.run)}>放弃这次拆解</button>
                    </p>
                  ) : null}
                  {detail.run.status === "failed" ? (
                    <div className="flex flex-wrap gap-2 border-t border-tk-border-1 pt-2">
                      {detail.run.errorCode === "prompt_version_outdated" ? (
                        <p className="w-full text-[11px] leading-4 text-tk-ink-3">
                          拆解规则已经更新，请用页面上方的「重新拆解」开始一次新任务。
                        </p>
                      ) : (
                        <Button size="sm" variant="ghost" icon={<ArrowClockwise />} loading={busy === "resume"} disabled={busy !== null} onClick={() => void resumeRun(detail.run)}>继续拆解</Button>
                      )}
                      <Button size="sm" variant="ghost" icon={<XCircle />} loading={busy === "discard"} disabled={busy !== null} onClick={() => void discardRun(detail.run)}>放弃</Button>
                    </div>
                  ) : null}
                  {detail.run.status === "confirmed" ? (
                    <div className="flex flex-wrap items-center gap-2 border-t border-tk-border-1 pt-2">
                      <p className="text-[11px] text-tk-ink-3">已写入正式分镜{detail.run.confirmedAt ? ` · ${formatDateTime(detail.run.confirmedAt)}` : ""}。</p>
                      <Button size="sm" variant="ghost" icon={<ArrowRight />} onClick={() => navigate(projectAssetsPath(projectId))}>去项目资产</Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
