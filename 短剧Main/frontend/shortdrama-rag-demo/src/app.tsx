import {
  ArrowLeft,
  ChartBar,
  ChatCircleDots,
  GearSix,
  CheckCircle,
  Clock,
  CurrencyCny,
  FilmSlate,
  FolderOpen,
  ImageSquare,
  Notebook,
  PaperPlaneTilt,
  SpinnerGap,
  User,
  VideoCamera,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { StrictMode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError, UNAUTHORIZED_EVENT, api } from "./api";
import { newId } from "./uuid";
import { toolNameLabel, toolNameRawTitle } from "./display-labels";
import { businessErrorMessage } from "./error-copy";
import { track } from "./telemetry";
import {
  ASSET_UPLOAD_ACTIVITY_EVENT,
  ASSET_UPLOAD_SETTLED_EVENT,
  uploadNotificationText,
} from "./asset-upload-tracker";
import { UploadTaskCard } from "./components/upload-task-card";
import { FailureAutoAckSection, GenerationNotificationCard } from "./components/generation-notification-card";
import { GENERATION_NOTIFICATION_POLL_MS, useGenerationNotifications } from "./task-notifications";
import { laneVocabularyFromApi, loadLaneVocabulary } from "./lane-vocabulary";
import { assistantSuggestions } from "./assistant-copy";
import { AssistantContextCard } from "./components/assistant-context-card";
import { CandidateCard } from "./components/candidate-card";
import { currentPlatform, isAssistantToggleEvent, isPaletteToggleEvent, shortcutLabel } from "./shortcut-hint";
import { demoCommandPaletteCopy, demoCommandPaletteGroups, demoEpisodes, demoProjectAssets, demoProjectById, demoProjects, demoShots, demoUser } from "./demo";
import { searchDemoFixtures, type CommandPaletteCopy, type CommandPaletteGroup, type CommandPaletteSearchResults } from "./command-palette";
import { CommandPalette } from "./components/command-palette";
import {
  formatCost,
  formatQuoteExpiry,
  generationQuoteFromMessage,
  quoteIsExpired,
} from "./generation-quotes";
import {
  hasVisitedProject,
  loginEntryPathFor,
  markProjectVisited,
  navigate,
  productionViewPath,
  projectIdFromPath,
  projectStoryboardPath,
  recallProjectLocation,
  rememberProjectLocation,
  routePath,
  shotRedirectTarget,
  storyboardsRedirectTarget,
} from "./routing";
import type {
  AgentMessage,
  AgentStreamEvent,
  AssetUploadNotification,
  AssetUploadTask,
  Candidate,
  GenerationQuote,
  User as UserType,
} from "./types";
import { useResource } from "./ui";
import { Button } from "./components/ui/button";
import { cn } from "./components/ui/cn";
import { EmptyState, LoadingState } from "./components/ui/primitives";
import { AppRail } from "./components/app-rail";
import { PlazaPage } from "./pages/plaza-page";
import { TopicsPage } from "./pages/topics-page";
import { QueuePage } from "./pages/queue-page";
import { SegmentWorkbenchPage } from "./pages/segment-workbench-page";
import { ProductionViewPage } from "./pages/production-view-page";
import { LandingPage } from "./pages/landing-page";
import { consumeWecomCallbackFragment } from "./pages/login-card";
import { DEMO_SESSION_KEY, useAppAuthentication } from "./app-authentication";
import { RegisterGuidePage } from "./pages/register-guide";
import {
  AssetCenterPage,
  ProjectsPage,
  type PageRuntimeProps,
} from "./pages/global-pages";
import { DashboardPage, ProjectCostsPage, TrashPage } from "./pages/operations-pages";
import { AssetDetailPage, ProjectAssetsPage } from "./pages/project-pages";
import { ScriptBreakdownPage } from "./pages/script-breakdown-page";
import { PrepStagePage } from "./pages/prep-stage-page";
import { BreakdownRunPage } from "./pages/breakdown-run-page";
/* Lite 界面模式：同一应用同一库的第二套界面（红线 R3 一等公民），壳与页面集中在 pages/lite/ */
import { LiteShell, liteProjectPath } from "./pages/lite/lite-shell";
import { LiteProjectsPage } from "./pages/lite/lite-projects-page";
import { LiteProjectConfigPage } from "./pages/lite/lite-project-config-page";
import { LiteWorkspacePage } from "./pages/lite/lite-workspace-page";
import { LiteAssetsPage } from "./pages/lite/lite-assets-page";
import { LiteAssetDetailPage } from "./pages/lite/lite-asset-detail-page";
import { LiteShotDetailPage } from "./pages/lite/lite-shot-detail-page";
import { AdminConsolePage } from "./pages/admin-page";
import { CliDownloadPage } from "./pages/cli-download-page";
import { ProjectSettingsDrawer } from "./components/project-settings";
import { canSeeProjectCosts } from "./operations";
import { capabilityGate, useCapabilitiesState, type CapabilitiesState } from "./capabilities-state";
import { CapabilityUnavailableBar } from "./components/capability-notice";
import { SessionReloginModal } from "./components/session-relogin-modal";
import { SettingsPage } from "./pages/settings-page";
import { VnextCanvasPage, VnextProjectsPage } from "./vnext/pages";
import {
  PI_TEASER_ROTATE_MS,
  buildTeaserLines,
  dismissPiTeaser,
  nextTeaserIndex,
  piTeaserDismissed,
} from "./release-plan";
import { ProductionStepper } from "./production-stepper";
/* S78:stepper 样式挂载点收在挂载处——production-stepper.tsx 保持 css-free,
   门禁测试才能直接 import 它做 renderToStaticMarkup 真渲染断言。 */
import "./production-stepper.css";
import "./tw.css";
/* S79：东方诗意主题（定版样例三页；加载顺序在 tw 之后，作用域重指只罩 .or-theme） */
import "./oriental.css";
/* R159/R160:tk- 体系(tokens 真值+基础件+登录页),新页皮唯一源;加载在 tw 之后 */
import "./styles/tokens.css";
import "./styles/tk-base.css";
import "./styles/tk-login.css";
import "./components/user-menu.css";
import "./pages/settings.css";

/** Pi 面板开关记忆（critique P1：默认全开每页抢 25% 宽、移动端全屏遮挡——改默认关+记忆）。 */
const ASSISTANT_OPEN_KEY = "shortdrama_v011_assistant_open";

/* OAuth fragment 必须在 React 根启动前读取并同步清除。不能放进组件 initializer：
   StrictMode 会重放 render，第二次读取会看到已清空的 fragment 并丢掉一次性 result。 */
const STARTUP_WECOM_CALLBACK = consumeWecomCallbackFragment(window);

function initialAssistantOpen(): boolean {
  // 窄屏（手机/小平板）默认关：面板在那里是全屏遮罩，不是侧栏
  if (window.innerWidth < 900) return false;
  try {
    return window.localStorage.getItem(ASSISTANT_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** 3D 导演台独立分包：three/R3F 依赖链只在进入 /projects/:projectId/director 时按需加载 */
const DirectorWorkspace = lazy(() =>
  import("./components/director").then((module) => ({ default: module.DirectorWorkspace })),
);

type AssistantQuotePhase = "ready" | "submitting" | "submitted" | "failed" | "expired";

interface AssistantQuoteUiState {
  phase: AssistantQuotePhase;
  error?: string;
  generationRequestId?: string;
}

/** 流式会话内的工具执行记录：简短状态行，不向用户倾倒内部 JSON。 */
interface ToolRunEntry {
  id: string;
  toolName: string;
  state: "running" | "succeeded" | "failed" | "undone";
}

/** 壳内图标按钮：新 Button 原语 ghost/icon，对齐旧 .icon-button 32px 手感（调用侧 className 给 size-8）。 */
function shellIconButtonProps(label: string) {
  return { variant: "ghost" as const, size: "icon" as const, "aria-label": label, title: label };
}

function App(): React.JSX.Element {
  const {
    wecomCallback,
    markWecomCallbackHandled,
    user,
    setUser,
    demoMode,
    setDemoMode,
    booting,
    handleAuthenticated,
  } = useAppAuthentication(STARTUP_WECOM_CALLBACK, demoUser);
  const [location, setLocation] = useState(routePath());
  /* 每成功一次原地重登 +1。401 小窗里账号可改：换成别人登进来 user.id 会变，
     同一个人重登 id 不变——但那也是新会话，上一次会话读到的权限一律不作数
     （尤其 401 本来就可能是权限接口自己挂了，不重读会一直挂着「没读到」）。 */
  const [signInSeq, setSignInSeq] = useState(0);
  /* S12-1：入口显隐唯一真源=capabilities 接口；demo 走全量 fixture。
     三态（读取中/读不到/已拿到）由 useCapabilitiesState 统一持有——全站页面拿到的
     是同一份三态，谁都别再把「没读到」当成「没权限」。
     权限跟着会话走：会话身份一换，手上那份立刻作废重读。 */
  const capabilities = useCapabilitiesState({ demoMode, sessionKey: user ? `${signInSeq}:${user.id}` : null });
  /* S24-C：参考栏词表接线——登录后从 GET /api/v1/vocabulary/reference-lanes 加载
     （失败由 loadLaneVocabulary 回落内置七条兜底）；snapshot 是模块级,
     加载完成后 bump 一次 state 触发重渲。 */
  const [, setLaneVocabTick] = useState(0);
  useEffect(() => {
    if (demoMode || !user) return;
    let active = true;
    void loadLaneVocabulary({
      fetcher: async () => laneVocabularyFromApi(await api.vocabularyReferenceLanes()),
    }).then(() => { if (active) setLaneVocabTick((tick) => tick + 1); });
    return () => { active = false; };
  }, [demoMode, user]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistantOpen, setAssistantOpenState] = useState(initialAssistantOpen);
  /** 开关写入记忆：用户的选择跨会话保留，不再每次刷新被抢回 25% 宽度。 */
  const setAssistantOpen = useCallback((open: boolean) => {
    setAssistantOpenState(open);
    try {
      window.localStorage.setItem(ASSISTANT_OPEN_KEY, open ? "1" : "0");
    } catch { /* 隐私模式写入失败不影响本次使用 */ }
  }, []);

  const [toast, setToast] = useState<{ message: string; kind: "info" | "success" | "error" } | null>(null);
  /* F01/F02/F04：401 原地重登小窗状态(null=不弹);reason 驱动「过期/别处登录」两种话术。 */
  const [relogin, setRelogin] = useState<{ reason: "expired" | "revoked" } | null>(null);
  const pathname = window.location.pathname;
  /* 创作广场是项目维度全局页:/projects/plaza 不挂项目壳(页内自选项目)。 */
  const projectId = pathname === "/projects/plaza" ? null : projectIdFromPath(pathname);

  useEffect(() => {
    const update = () => setLocation(routePath());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  // 记录项目内位置：再次进入该项目时恢复到上次工作的页面
  useEffect(() => {
    if (projectId && !/^\/projects\/[^/]+\/?$/.test(pathname)) {
      rememberProjectLocation(projectId, routePath());
    }
  }, [projectId, pathname, location]);

  const notify = useCallback((message: string, kind: "info" | "success" | "error" = "info") => {
    setToast({ message, kind });
    /* 埋点(试点开门五类之「错误弹出」):错误 toast 全站唯一出口,在此统一上报;
       demo 离线演示不上报,失败静默不挡主流程(telemetry 纪律)。 */
    if (kind === "error" && !demoMode) track("error_shown", { page: routePath(), message: message.slice(0, 120) });
    window.setTimeout(() => setToast((current) => current?.message === message ? null : current), 3000);
  }, [demoMode]);

  useEffect(() => {
    if (demoMode) return;
    const onUnauthorized = (event: Event) => {
      const reason = (event as CustomEvent<{ reason?: string }>).detail?.reason === "revoked" ? "revoked" : "expired";
      /* F01/F02 会话诚实：原地重登小窗——不清 user、不跳登录页,页面与未提交内容原地保留;
         已在登录页(或无用户态)则只保留 redirect 参数(F03:并发 401 不得抹掉回去地址)。 */
      if (!user || window.location.pathname.startsWith("/login")) {
        setUser(null);
        navigate(loginEntryPathFor(routePath()), { replace: true });
        return;
      }
      setRelogin((current) => current ?? { reason });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [demoMode, notify, user]);

  /* Lite 入口重定向：ui_mode=lite 的用户落在完整版首页/项目列表时送进 /lite（replace 不留历史）。
     其余完整版页面 v1 不强拦——Lite 只服务 Lite 项目，误闯由目标页自身提示。 */
  useEffect(() => {
    if (demoMode || !user) return;
    if (user.ui_mode === "lite" && (pathname === "/" || pathname === "/projects")) navigate("/lite", { replace: true });
  }, [demoMode, user, pathname]);

  /* ---------- S30 ⌘K 命令面板：内容走 config_entries,demo 走同名 fixture ---------- */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteGroups, setPaletteGroups] = useState<CommandPaletteGroup[]>([]);
  const [paletteCopy, setPaletteCopy] = useState<CommandPaletteCopy | null>(null);
  const [paletteGroupsFailed, setPaletteGroupsFailed] = useState(false);
  const loadPaletteConfig = useCallback(() => {
    if (demoMode) {
      setPaletteGroups(demoCommandPaletteGroups);
      setPaletteCopy(demoCommandPaletteCopy);
      setPaletteGroupsFailed(false);
      return;
    }
    if (!user) {
      setPaletteGroups([]);
      setPaletteCopy(null);
      setPaletteGroupsFailed(false);
      return;
    }
    let active = true;
    void api.commandPaletteConfig().then(({ groups, copy }) => {
      if (!active) return;
      setPaletteGroups(groups);
      setPaletteCopy(copy);
      setPaletteGroupsFailed(false);
    }).catch(() => {
      if (!active) return;
      setPaletteGroups([]);
      setPaletteGroupsFailed(true);
    });
    return () => { active = false; };
  }, [demoMode, user]);
  useEffect(() => loadPaletteConfig(), [loadPaletteConfig]);
  /* ⌘K/Ctrl+K=命令面板,⌘J/Ctrl+J=AI 工作区边栏(分平台提示见 shortcut-hint);
     输入框内也生效(面板开着时按一下=关/收)。 */
  useEffect(() => {
    if (!user) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isPaletteToggleEvent(event)) {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }
      if (isAssistantToggleEvent(event)) {
        event.preventDefault();
        setAssistantOpen(!assistantOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [user, assistantOpen, setAssistantOpen]);
  /* 分平台快捷键提示:Mac=⌘K/⌘J,Win/Linux=Ctrl+K/Ctrl+J。 */
  const paletteKbd = shortcutLabel(currentPlatform(), "K");
  const assistantKbd = shortcutLabel(currentPlatform(), "J");
  const paletteSearch = useCallback(async (query: string): Promise<CommandPaletteSearchResults> => {
    if (demoMode) {
      return searchDemoFixtures(query, { projects: demoProjects, episodes: demoEpisodes, shots: demoShots, projectAssets: demoProjectAssets });
    }
    return api.commandPaletteSearch(query);
  }, [demoMode]);
  const paletteCtx = useMemo(() => ({ projectId, capabilities, navigate }), [projectId, capabilities]);

  const [uiModeSwitching, setUiModeSwitching] = useState(false);

  async function logout(): Promise<void> {
    if (!demoMode) {
      try { await api.logout(); } catch { api.setToken(null); }
    }
    api.setToken(null);
    window.sessionStorage.removeItem(DEMO_SESSION_KEY);
    setDemoMode(false);
    setUser(null);
    navigate(loginEntryPathFor("/login"), { replace: true });
  }

  /* 模式切换（红线 R2）：唯一事实源是服务端 users.ui_mode——先 PATCH 成功，再本地同步并跳
     对应界面（lite→/lite、full→/projects）；禁 localStorage/URL 存模式。demo 无服务端，只本地切。 */
  async function switchUiMode(): Promise<void> {
    if (uiModeSwitching || !user) return;
    const nextMode: UserType["ui_mode"] = user.ui_mode === "lite" ? "full" : "lite";
    if (!demoMode) {
      setUiModeSwitching(true);
      try {
        await api.patchMyUiMode(nextMode);
      } catch (reason) {
        notify(businessErrorMessage(reason, "界面模式切换失败，请重试"), "error");
        return;
      } finally {
        setUiModeSwitching(false);
      }
    }
    setUser({ ...user, ui_mode: nextMode });
    navigate(nextMode === "lite" ? "/lite" : "/projects");
  }

  if (booting) return <div className="flex min-h-dvh flex-col items-center justify-center gap-3 text-ink-2"><SpinnerGap className="animate-spin" /><strong>正在恢复登录状态</strong></div>;
  /* V-47 登录形态收口:整页登录退役——/login 换乘落地页(redirect 照传),登录卡=落地页
     弹层唯一载体(任务纯粹不放品牌位);登出/401/未登录深链三条路同落点,登录成功回原位。 */
  if (!user && pathname === "/login") return <RedirectTo path={loginEntryPathFor(routePath())} />;
  if (!user && pathname === "/landing") return <LandingPage onAuthenticated={handleAuthenticated} wecomCallback={wecomCallback} onWecomCallbackHandled={markWecomCallbackHandled} />;
  if (!user && pathname === "/") return <LandingPage onAuthenticated={handleAuthenticated} wecomCallback={wecomCallback} onWecomCallbackHandled={markWecomCallbackHandled} />;
  if (user && (pathname === "/landing" || pathname === "/login")) {
    return <RedirectTo path="/projects" />;
  }
  if (!user) {
    /* 兜底:理论上到不了(未登录深链已在 boot 阶段换乘),守住不渲染内部页。 */
    return <RedirectTo path={loginEntryPathFor(routePath())} />;
  }
  const runtime: PageRuntimeProps = { demoMode, notify, user, capabilities, onLogout: () => void logout() };
  const page = renderRoute(pathname, runtime);
  const isWorkbench = /\/storyboards\/[^/]+\/shots\/[^/]+$/.test(pathname);
  const isSegmentWorkbench = /\/storyboards\/[^/]+\/scenes\/[^/]+$/.test(pathname);
  const isDirector = /^\/projects\/[^/]+\/director$/.test(pathname);
  /* 修订二（2026-08-17）：Lite 配置页满屏布局（lite-config-tabs-and-style.md §4.1.3）——
     main 换 fullBleed 内边距（px-5 py-4），去掉常规页 pb-8 底垫，页面自身吃满视口高。 */
  const isVnextCanvas = /^\/vnext\/projects\/[^/]+$/.test(pathname);
  const fullBleed = isWorkbench || isSegmentWorkbench || isDirector || isVnextCanvas;
  const context = routeContext(pathname);
  /* Lite 壳：/lite/* 路径换 LiteShell（不包 GlobalHeader/ProjectHeader）；项目上下文从路径解析。 */
  const isLitePath = pathname === "/lite" || pathname.startsWith("/lite/");
  const liteProjectId = isLitePath ? pathname.match(/^\/lite\/projects\/([^/]+)/)?.[1] ?? null : null;
  return (
<div className={isLitePath ? "flex h-dvh flex-col overflow-hidden" : "flex min-h-dvh flex-col [overflow-x:clip]"}>{/* S9-12：页面级横向溢出在根裁剪（肇事源=AI 工作区面板收起态 -mr-[340px] 布局盒），内部滚动容器不受影响 */}
      {isLitePath ? (
        /* Lite 壳:/lite/* 换 LiteShell,不挂 AppRail/ProjectHeader,主区不留 72px */
        <LiteShell pathname={pathname} projectId={liteProjectId} demoMode={demoMode} user={user} switching={uiModeSwitching} onSwitchUiMode={() => void switchUiMode()} />
      ) : (
        /* R2 壳:全站 72px 左 rail(品牌/四项导航/队列/AI/命令面板/积分/头像),主区左留 72px */
        <AppRail pathname={pathname} user={user} demoMode={demoMode} onLogout={() => void logout()} onOpenAssistant={() => setAssistantOpen(true)} onOpenPalette={() => setPaletteOpen(true)} capabilities={capabilities} paletteKbd={paletteKbd} assistantKbd={assistantKbd} uiModeSwitching={uiModeSwitching} onSwitchUiMode={() => void switchUiMode()} />
      )}
      {/* R2-4：lite 主区 wrapper 去 min-h-dvh（LiteShell 顶栏在 wrapper 外，min-h-dvh 会把整页撑到 视口+顶栏高，工作台页产生幻影滚动 64px）；flex-1 已足够撑满，正文高内容仍按需增长 */}
<div className={isLitePath ? "flex min-h-0 flex-1 flex-col" : "flex min-h-dvh flex-1 flex-col pl-[72px]"}>
      {projectId && !isLitePath ? <ProjectHeader projectId={projectId} pathname={pathname} demoMode={demoMode} notify={notify} capabilities={capabilities} onOpenSettings={() => setSettingsOpen(true)} /> : null}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={paletteGroups} groupsFailed={paletteGroupsFailed} onRetryGroups={loadPaletteConfig} copy={paletteCopy} ctx={paletteCtx} search={paletteSearch} notify={notify} />
      {projectId && settingsOpen ? <ProjectSettingsDrawer projectId={projectId} demoMode={demoMode} notify={notify} capabilities={capabilities} onClose={() => setSettingsOpen(false)} /> : null}
      {/* 左栏导航项、页签这些地方不适合各挂一个错误位：权限读不到统一在壳层说一次，
          让「入口少了」有个明确出处——不是你没权限，是没读到。 */}
      {capabilities.status === "unavailable" ? <CapabilityUnavailableBar onRetry={capabilities.reload} /> : null}
      {demoMode ? <div className="flex items-center gap-3 border-b border-border-1 bg-warning/14 px-5 py-2 text-xs text-warning"><strong>离线演示</strong><span className="text-ink-2">以下是明确标注的示例数据，不会写入服务、调用助手或提交真实生成。</span><button type="button" className="ml-auto font-medium text-warning underline underline-offset-[3px]" onClick={() => void logout()}>返回登录</button></div> : null}
      {projectId && !fullBleed && pathname.includes("/storyboards") ? <ProductionStepper projectId={projectId} demoMode={demoMode} /> : null}
      {projectId && !fullBleed ? <ProjectOnboarding projectId={projectId} /> : null}
      <div className="flex min-h-0 flex-1 items-stretch">
        <a className="fixed left-3 top-3 z-[var(--z-tooltip)] -translate-y-[200%] rounded-sm border border-border-2 bg-surface-1 px-3 py-2 text-xs text-ink-1 transition-transform duration-[var(--duration-2)] ease-out-quart focus-visible:translate-y-0" href="#main-content">跳到主内容</a>
<main id="main-content" className={fullBleed ? "min-w-0 min-h-0 flex-1 flex flex-col px-5 py-4" : "min-w-0 min-h-0 flex-1 flex flex-col px-4 pb-8 pt-3 max-[900px]:p-3"}>{page}</main>
        <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} demoMode={demoMode} context={context} notify={notify} shortcut={assistantKbd} forceFixed={isLitePath} />
      </div>
      {/* B(2026-08-19)：Lite 顶栏徽标收敛任务提醒，右下 Dock 只保留给完整版——
          生成终态卡与确认逻辑两处共用（task-notifications.ts / generation-notification-card.tsx）。 */}
      {!isLitePath ? <GenerationAttemptNotificationDock enabled={!demoMode} /> : null}
      {!assistantOpen ? <button className="glass-panel fixed bottom-5 right-5 z-[var(--z-float)] inline-flex min-h-10 items-center gap-2 rounded-full border px-4 py-2 font-medium text-agent-text shadow-[var(--shadow-1)] [&_svg]:size-[18px] [&_svg]:text-agent" type="button" title={`打开 AI 工作区（${assistantKbd}）`} onClick={() => setAssistantOpen(true)}><ChatCircleDots /><span>AI 工作区</span></button> : null}
      {toast ? <div className={cn("glass-panel fixed inset-x-0 bottom-6 z-[var(--z-toast)] mx-auto flex w-max animate-fade-up items-center gap-3 rounded-md border px-4 py-3 shadow-[var(--shadow-1)]", toast.kind === "success" && "border-success/14 text-success", toast.kind === "error" && "border-danger/14 text-danger")} role="status"><span className="text-ink-1">{toast.message}</span><Button {...shellIconButtonProps("关闭")} className="size-8" icon={<X />} onClick={() => setToast(null)} /></div> : null}
      {/* F01/F02/F04：401 原地重登小窗——页面与未提交内容原地保留,说清原因,重登后接着干 */}
      {relogin && user ? (
        <SessionReloginModal
          reason={relogin.reason}
          defaultIdentifier={user.username}
          onSuccess={(nextUser) => {
            setRelogin(null);
            setSignInSeq((seq) => seq + 1);
            setUser(nextUser);
            notify("已重新登录，接着刚才的继续", "success");
          }}
          onSwitchAccount={() => {
            setRelogin(null);
            setUser(null);
            navigate(loginEntryPathFor(routePath()), { replace: true });
          }}
        />
      ) : null}
      <span className="hidden" data-location={location} />
      </div>
    </div>
  );
}

/**
 * S29: this is intentionally a durable in-site reminder, not email, SMS or a
 * browser push. It waits while the tab is hidden and refreshes on return, so a
 * creator can keep working elsewhere without losing a completed task.
 *
 * S42: 同一个 Dock 轮询两类来源、同一套等待期口径(排位/ETA/终态提醒):
 * 生成任务提醒 + 图片上传入库任务(活跃进度卡 + 终态提醒)。上传终态提醒出现时
 * 广播 ASSET_UPLOAD_SETTLED_EVENT,让开着的资产库列表自己刷新——不假装列表已最新。
 *
 * 生成终态卡(成功/失败)与失败卡 10s 自动确认(FAILURE_AUTO_ACK_MS)已收敛到
 * components/generation-notification-card.tsx——完整版 Dock 与 Lite 顶栏徽标共用。
 */
function GenerationAttemptNotificationDock({ enabled }: { enabled: boolean }): React.JSX.Element | null {
  /* 生成终态提醒走共享轮询（与 Lite 顶栏徽标同一份：task-notifications.ts）；
     上传入库任务只属于完整版资产库，保留在 Dock 内轮询（S42/S46）。 */
  const { notifications, acknowledge, openResult } = useGenerationNotifications(enabled);
  const [uploadTasks, setUploadTasks] = useState<AssetUploadTask[]>([]);
  const [uploadNotifications, setUploadNotifications] = useState<AssetUploadNotification[]>([]);
  const inFlight = useRef(false);
  const settledUploadIds = useRef<ReadonlySet<string>>(new Set());
  const activeUploadKey = useRef("");

  useEffect(() => {
    if (!enabled) {
      setUploadTasks([]);
      setUploadNotifications([]);
      activeUploadKey.current = "";
      return;
    }
    let active = true;
    const refresh = async (): Promise<void> => {
      if (document.hidden || inFlight.current) return;
      inFlight.current = true;
      try {
        const [uploadTaskResult, uploadNotificationResult] = await Promise.all([
          api.assetUploadTasks(),
          api.assetUploadNotifications(),
        ]);
        if (!active) return;
        setUploadTasks(uploadTaskResult.items);
        setUploadNotifications(uploadNotificationResult.items);
        /* S46 C-2:在途上传数变化时广播,资产库头部「待入库」把在途并入,
           不再出现 toast 说「入库中」、计数却说「0 待入库」。 */
        const uploadKey = uploadTaskResult.items.map((task) => task.id).join(",");
        if (uploadKey !== activeUploadKey.current) {
          activeUploadKey.current = uploadKey;
          window.dispatchEvent(new CustomEvent(ASSET_UPLOAD_ACTIVITY_EVENT, { detail: { active: uploadTaskResult.items.length } }));
        }
        // 只对新出现的终态提醒广播一次;确认过的提醒不再重复触发列表刷新。
        const seen = new Set(settledUploadIds.current);
        let settled = false;
        for (const item of uploadNotificationResult.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          settled = true;
        }
        settledUploadIds.current = seen;
        if (settled) window.dispatchEvent(new Event(ASSET_UPLOAD_SETTLED_EVENT));
      } catch {
        // Notification delivery must not block the creator's current page.
      } finally {
        inFlight.current = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), GENERATION_NOTIFICATION_POLL_MS);
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  async function acknowledgeUpload(notification: AssetUploadNotification): Promise<void> {
    try {
      await api.acknowledgeAssetUploadNotification(notification.id);
      setUploadNotifications((current) => current.filter((item) => item.id !== notification.id));
    } catch {
      // 与生成提醒同规:未确认的提醒不许消失。
    }
  }

  function openAssetLibrary(notification: AssetUploadNotification): void {
    navigate("/assets");
    void acknowledgeUpload(notification);
  }

  const activeUploads = uploadTasks.slice(0, 2);
  const visibleUploadNotifications = uploadNotifications.slice(0, 3);
  const visible = notifications.slice(0, 3);
  const remaining = (notifications.length - visible.length) + (uploadNotifications.length - visibleUploadNotifications.length);
  return (
    <aside className="fixed bottom-20 right-5 z-[var(--z-toast)] flex w-[min(360px,calc(100vw-2.5rem))] flex-col gap-2" aria-label="任务提醒" aria-live="polite">
      {activeUploads.map((task) => <UploadTaskCard key={task.id} task={task} />)}
      {visibleUploadNotifications.map((notification) => {
        const { title, body } = uploadNotificationText(notification);
        const succeeded = notification.status === "succeeded";
        return succeeded ? (
          <section className={cn("glass-panel flex gap-3 rounded-md border px-4 py-3 shadow-[var(--shadow-1)]", "border-success/30")} key={notification.id}>
            <CheckCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <strong className="text-sm text-success">{title}</strong>
              <p className="mt-0.5 text-xs text-ink-2">{body}</p>
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="primary" onClick={() => openAssetLibrary(notification)}>查看资产</Button>
                <Button size="sm" variant="ghost" onClick={() => void acknowledgeUpload(notification)}>知道了</Button>
              </div>
            </div>
          </section>
        ) : (
          <FailureAutoAckSection onAck={() => void acknowledgeUpload(notification)} className={cn("glass-panel flex gap-3 rounded-md border px-4 py-3 shadow-[var(--shadow-1)]", "border-danger/40")} key={notification.id}>
            <WarningCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <strong className="text-sm text-danger">{title}</strong>
              <p className="mt-0.5 text-xs text-ink-2">{body}</p>
              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => openAssetLibrary(notification)}>重新上传</Button>
                <Button size="sm" variant="ghost" onClick={() => void acknowledgeUpload(notification)}>知道了</Button>
              </div>
            </div>
          </FailureAutoAckSection>
        );
      })}
      {visible.map((notification) => (
        <GenerationNotificationCard key={notification.id} notification={notification} onOpen={openResult} onAcknowledge={acknowledge} />
      ))}
      {remaining > 0 ? <p className="px-1 text-xs text-ink-2">还有 {remaining} 条任务更新，处理当前提醒后继续显示。</p> : null}
    </aside>
  );
}

function renderRoute(pathname: string, runtime: PageRuntimeProps): React.JSX.Element {
  if (pathname === "/vnext" || pathname === "/vnext/projects") return <VnextProjectsPage />;
  const vnextProject = pathname.match(/^\/vnext\/projects\/([^/]+)$/);
  if (vnextProject) return <VnextCanvasPage key={vnextProject[1]!} projectId={vnextProject[1]!} />;
  if (pathname === "/" || pathname === "/projects") return <ProjectsPage {...runtime} />;
  if (pathname === "/register-guide") return <RegisterGuidePage {...runtime} />;
  if (pathname === "/assets/prep") return <PrepStagePage {...runtime} />;
  if (pathname === "/assets") {
    const scope = new URLSearchParams(window.location.search).get("scope") === "common" ? "common" : "personal";
    return <AssetCenterPage {...runtime} scope={scope} />;
  }
  if (pathname === "/dashboard") return <DashboardPage {...runtime} />;
  if (pathname === "/queue") return <QueuePage {...runtime} />;
  if (pathname === "/admin") return <AdminConsolePage {...runtime} />;
  if (pathname === "/cli") return <CliDownloadPage />;
  if (pathname === "/settings") return <SettingsPage />;
  if (pathname === "/trash") {
    const kindValue = new URLSearchParams(window.location.search).get("kind");
    const kind = kindValue === "project" || kindValue === "asset" ? kindValue : undefined;
    return <TrashPage {...runtime} kind={kind} />;
  }
  /* ---------- Lite 界面模式（/lite/* 前缀；页面 props 契约：列表=PageRuntimeProps，项目内=+projectId） ---------- */
  if (pathname === "/lite" || pathname === "/lite/projects") return <LiteProjectsPage {...runtime} />;
  const liteProjectRoot = pathname.match(/^\/lite\/projects\/([^/]+)\/?$/);
  if (liteProjectRoot) return <RedirectTo path={liteProjectPath(liteProjectRoot[1]!, "workspace")} />;
  const liteSection = pathname.match(/^\/lite\/projects\/([^/]+)\/(config|workspace|assets)$/);
  if (liteSection) {
    const liteProjectId = liteSection[1]!;
    switch (liteSection[2]) {
      case "config": return <LiteProjectConfigPage {...runtime} projectId={liteProjectId} />;
      case "workspace": return <LiteWorkspacePage {...runtime} projectId={liteProjectId} />;
      case "assets": return <LiteAssetsPage {...runtime} projectId={liteProjectId} />;
      default: return <NotFoundPage />;
    }
  }
  /* 创作广场（Lite 顶栏入口）：项目维度，复用同一 PlazaPage。 */
  const litePlaza = pathname.match(/^\/lite\/projects\/([^/]+)\/plaza$/);
  if (litePlaza) return <PlazaPage {...runtime} projectId={litePlaza[1]!} />;
  /* Lite 分镜详情页:/lite/projects/:id/shots/:shotId(带 ?ep=,v1.4 分镜工作台详情;
     注意放在 liteSection 之后——列表路由 `shots` 是 $ 锚定精确段,详情子路径不冲突)。 */
  const liteShotDetail = pathname.match(/^\/lite\/projects\/([^/]+)\/shots\/([^/]+)$/);
  if (liteShotDetail) {
    return <LiteShotDetailPage {...runtime} projectId={liteShotDetail[1]!} shotId={liteShotDetail[2]!} />;
  }
  /* Lite 资产详情页:/lite/projects/:id/assets/:assetEntityId(Phase 2,独立路由页面) */
  const liteAssetDetail = pathname.match(/^\/lite\/projects\/([^/]+)\/assets\/([^/]+)$/);
  if (liteAssetDetail) {
    return <LiteAssetDetailPage {...runtime} projectId={liteAssetDetail[1]!} assetEntityId={liteAssetDetail[2]!} />;
  }
  /* 创作广场（项目维度）：/projects/plaza 落最近项目；/projects/:id/plaza 直达。 */
  if (pathname === "/projects/plaza") return <PlazaPage {...runtime} />;
  const plaza = pathname.match(/^\/projects\/([^/]+)\/plaza$/);
  if (plaza) return <PlazaPage {...runtime} projectId={plaza[1]!} />;
  const projectRoot = pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (projectRoot) return <ProjectRootRedirect projectId={projectRoot[1]!} />;
  const director = pathname.match(/^\/projects\/([^/]+)\/director$/);
  if (director) {
    return (
      <Suspense fallback={<LoadingState label="正在装载 3D 导演台" />}>
        <DirectorWorkspace projectId={director[1]!} notify={runtime.notify} />
      </Suspense>
    );
  }
  const projectCosts = pathname.match(/^\/projects\/([^/]+)\/costs$/);
  if (projectCosts) return <ProjectCostsPage {...runtime} projectId={projectCosts[1]!} />;
  const scriptBreakdown = pathname.match(/^\/projects\/([^/]+)\/script-breakdown$/);
  if (scriptBreakdown) return <ScriptBreakdownPage {...runtime} projectId={scriptBreakdown[1]!} />;
  const breakdownRun = pathname.match(/^\/projects\/([^/]+)\/requirement-breakdowns\/([^/]+)$/);
  if (breakdownRun) return <BreakdownRunPage {...runtime} projectId={breakdownRun[1]!} runId={breakdownRun[2]!} />;
  /* S11-4：/video 孤儿页下线（全站无入口+定时器假播放，与工作台真连播一真一假两处表达）。
     有价值零件=版本卡/播放切片等纯函数早已抽到 components/version-modal.tsx 由真工作台复用。 */
  /* 块 2:镜级工作台退役——shots URL=换乘口,按归属场 replace 到场级工作台(routing.ts shotWorkbenchPath 注释)。 */
  const workbench = pathname.match(/^\/projects\/([^/]+)\/storyboards\/([^/]+)\/shots\/([^/]+)$/);
  if (workbench) return <ShotWorkbenchRedirect projectId={workbench[1]!} episodeId={workbench[2]!} shotId={workbench[3]!} demoMode={runtime.demoMode} />;
  /* 批次二 P-04:段落工作台(一场 N 镜整段一次生成),子卡 1=骨架三栏+段落头带。 */
  const segmentWorkbench = pathname.match(/^\/projects\/([^/]+)\/storyboards\/([^/]+)\/scenes\/([^/]+)$/);
  if (segmentWorkbench) return <SegmentWorkbenchPage {...runtime} projectId={segmentWorkbench[1]!} episodeId={segmentWorkbench[2]!} sceneId={segmentWorkbench[3]!} />;
  /* 块 1:新「生产」页签=集视图(P-02b);旧 StoryboardPage 不动不删(redirect 与守卫改锚=Fable 亲做件)。 */
  const productionView = pathname.match(/^\/projects\/([^/]+)\/production$/);
  if (productionView) return <ProductionViewPage {...runtime} projectId={productionView[1]!} />;
  const assetDetail = pathname.match(/^\/projects\/([^/]+)\/assets\/([^/]+)$/);
  if (assetDetail) return <AssetDetailPage {...runtime} projectId={assetDetail[1]!} assetId={assetDetail[2]!} />;
  const projectAssets = pathname.match(/^\/projects\/([^/]+)\/assets$/);
  if (projectAssets) return <ProjectAssetsPage {...runtime} projectId={projectAssets[1]!} />;
  // IA 重构：参考测试/素材智能体并入资产中心，旧路由 301 到对应页签
  const referenceTests = pathname.match(/^\/projects\/([^/]+)\/reference-tests$/);
  if (referenceTests) return <RedirectTo path={`/assets?tab=tests&project=${encodeURIComponent(referenceTests[1]!)}`} />;
  const materialAgent = pathname.match(/^\/projects\/([^/]+)\/material-agent$/);
  if (materialAgent) return <RedirectTo path="/assets?tab=ingest" />;
  /* 块 2:旧分镜列表页(枢纽页)退役——列表级职能并入生产页(集视图),深链参数随乘换页。 */
  const storyboard = pathname.match(/^\/projects\/([^/]+)\/storyboards$/);
  if (storyboard) return <StoryboardsRedirect projectId={storyboard[1]!} />;
  /* R2 壳:生产队列页(rail 队列项落点,批次一卡 1;取数走 queue-inflight 换源点)。 */
  if (pathname === "/queue") return <QueuePage {...runtime} />;
  /* 选题雷达榜(批次一卡 6;归属项目管理域,rail 不增项)。 */
  if (pathname === "/topics") return <TopicsPage {...runtime} />;
  return <NotFoundPage />;
}

/** 简单重定向（IA 重构的旧路由兼容层）。 */
function RedirectTo({ path }: { path: string }): React.JSX.Element {
  useEffect(() => {
    navigate(path, { replace: true });
  }, [path]);
  return <LoadingState label="正在跳转" />;
}

/** 块 2:镜级工作台退役后的换乘页——按 shot.scene_id 解析归属场 replace 到场级工作台;
 *  未分场/查不到(旧数据、已删镜)兜底落生产页,不许把旧链接用户丢进错的场。 */
function ShotWorkbenchRedirect({ projectId, episodeId, shotId, demoMode }: { projectId: string; episodeId: string; shotId: string; demoMode: boolean }): React.JSX.Element {
  useEffect(() => {
    let alive = true;
    const fallback = (): void => {
      if (alive) navigate(productionViewPath(projectId), { replace: true });
    };
    if (demoMode) {
      fallback();
      return () => { alive = false; };
    }
    void api.shot(shotId)
      .then((shot) => {
        if (!alive) return;
        navigate(shotRedirectTarget(projectId, episodeId, shot.scene_id, window.location.search), { replace: true });
      })
      .catch(fallback);
    return () => { alive = false; };
  }, [projectId, episodeId, shotId, demoMode]);
  return <LoadingState label="正在跳转" />;
}

/** 块 2:旧分镜列表页退役后的换乘页——深链参数(集/连播/交付/审核)原样带给生产页开对应弹窗。 */
function StoryboardsRedirect({ projectId }: { projectId: string }): React.JSX.Element {
  useEffect(() => {
    navigate(storyboardsRedirectTarget(projectId, window.location.search), { replace: true });
  }, [projectId]);
  return <LoadingState label="正在跳转" />;
}

/** 进入项目根路径时恢复上次工作位置；没有记录则落到分镜生产页。 */
function ProjectRootRedirect({ projectId }: { projectId: string }): React.JSX.Element {
  useEffect(() => {
    const remembered = recallProjectLocation(projectId);
    navigate(remembered ?? projectStoryboardPath(projectId), { replace: true });
  }, [projectId]);
  return <LoadingState label="正在打开项目" />;
}

/**
 * 3D 导演台路由插槽：/projects/:projectId/director。
 * 已由导演台工作包接入 frontend/shortdrama-rag-demo/src/components/director 的
 * DirectorWorkspace（纯客户端组件，three/R3F 只在浏览器侧运行，无 SSR 路径）；
 * 外壳 fullBleed 布局与本文件 isDirector 分支保持不变。
 */

/** 本次会话内已展示引导的项目：抵消 StrictMode 下 effect 双跑对"首次"判断的干扰。 */
const onboardingShownThisSession = new Set<string>();

/** 首次进入项目的三步轻引导；之后不再出现（localStorage 记录）。 */
function ProjectOnboarding({ projectId }: { projectId: string }): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (onboardingShownThisSession.has(projectId) || !hasVisitedProject(projectId)) {
      onboardingShownThisSession.add(projectId);
      setVisible(true);
      markProjectVisited(projectId);
    } else {
      setVisible(false);
    }
  }, [projectId]);
  const dismiss = () => {
    onboardingShownThisSession.delete(projectId);
    setVisible(false);
  };
  if (!visible) return null;
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border-1 bg-surface-1 px-4 py-3" role="note" aria-label="项目三步引导">
      <span className="flex items-center gap-2 text-xs text-ink-2"><b className="inline-flex size-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2 [font-family:var(--font-mono)]">1</b>把角色、场景和参考素材放进项目资产</span>
      <span className="flex items-center gap-2 text-xs text-ink-2"><b className="inline-flex size-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2 [font-family:var(--font-mono)]">2</b>在 3D 导演台搭景、走位、定机位</span>
      <span className="flex items-center gap-2 text-xs text-ink-2"><b className="inline-flex size-5 items-center justify-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2 [font-family:var(--font-mono)]">3</b>检查草稿后，亲手点一次生成</span>
      <Button {...shellIconButtonProps("关闭引导")} className="ml-auto size-8" icon={<X />} onClick={dismiss} />
    </div>
  );
}

/** 项目内导航按钮：图标+文字，active 态 accent 填充。 */
function projectNavButtonClass(active: boolean): string {
  return cn(
    "inline-flex items-center gap-1 rounded-sm px-3 py-2 font-medium transition-all duration-[var(--duration-1)] ease-out-quart active:scale-[0.98] [&_svg]:size-4",
    active ? "bg-accent-subtle text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1",
  );
}

/** 返回上级页的小按钮（二级条配方）。 */
const backButtonClass = "inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-ink-2 transition-colors duration-[var(--duration-1)] ease-out-quart hover:bg-surface-2 hover:text-ink-1";

/** R2 壳:项目内 48px 二级条(返回+剧名+四页签;右组只留项目设置,交付在工作台变体保留)。
    原 GlobalHeader/右组(积分/命令面板/AI/头像)已收进左 rail;页签=生产流序(剧本|资产|生产|消耗,R173a)。 */
function ProjectHeader({ projectId, pathname, demoMode, capabilities, notify, onOpenSettings }: { projectId: string; pathname: string; demoMode: boolean; capabilities: CapabilitiesState; notify: PageRuntimeProps["notify"]; onOpenSettings: () => void }): React.JSX.Element {
  /* K2O/GP-04：项目名按 projectId 查（fixture + 本会话新建登记）；
     都不认识的项目才退回页名占位「项目详情」，不顶别的项目名。 */
  const fallbackProject = demoProjectById(projectId) ?? { id: projectId, name: "项目详情" };
  const projectState = useResource(() => api.project(projectId), fallbackProject, demoMode, [projectId]);
  /* 块 2:页头「交付」按钮与镜级 pager 随镜级工作台退役——交付职能在生产页「更多」(交付本集/导出本集),连播在「预览全集」。 */
  /* R173a(DC 走查):页签序=生产流序「选题→剧本→资产→生产→消耗→投放」;
     选题/投放两工位本版没有,注释预留位不渲染(中期卡另立)。 */
  const tabs = (
    <nav className="flex gap-1" aria-label="项目内导航">
      {/* 预留位:选题(本版无此工位,不渲染) */}
      <button className={projectNavButtonClass(pathname.includes("/script-breakdown"))} onClick={() => navigate(`/projects/${projectId}/script-breakdown`)}><Notebook />剧本</button>
      <button className={projectNavButtonClass(pathname.includes("/assets"))} onClick={() => navigate(`/projects/${projectId}/assets`)}><User />资产</button>
      <button className={projectNavButtonClass(pathname.includes("/storyboards") || pathname.endsWith("/director") || pathname.endsWith("/production"))} onClick={() => navigate(productionViewPath(projectId))}><FilmSlate />生产</button>
      {/* 页签只在查清有权时占位：读取中/读不到都不渲染（顶部导航闪现比缺失更刺眼），
          少了这一枚由壳层那条「权限信息没读到 · 重试」统一交代。 */}
      {capabilityGate(capabilities, (caps) => canSeeProjectCosts(caps, projectId)) === "allowed" ? <button className={projectNavButtonClass(pathname.endsWith("/costs"))} onClick={() => navigate(`/projects/${projectId}/costs`)}><ChartBar />消耗</button> : null}
      {/* 预留位:投放(本版无此工位,不渲染) */}
    </nav>
  );
  return (
    <>
    <div className="sticky top-0 z-[calc(var(--z-float)+1)] border-b border-border-1 bg-surface-0/90 backdrop-blur-sm">
      <header className="flex min-h-12 items-center gap-4 px-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <button className={backButtonClass} onClick={() => navigate("/projects")}><ArrowLeft />返回</button>
          <strong className="truncate text-sm font-semibold text-ink-1">{(() => { const n = projectState.data?.name || "项目详情"; return n.startsWith("《") ? n : `《${n}》`; })()}</strong>
        </div>
        {tabs}
        <div className="flex flex-1 items-center justify-end gap-2">
          <Button {...shellIconButtonProps("项目设置")} className="size-8" icon={<GearSix />} onClick={onOpenSettings} title="项目设置（成员/题材/审核策略）" />
        </div>
      </header>
    </div>
    </>
  );
}

/* 工具名中文标签统一走 display-labels(业务语言化 #18):未知工具显示「工具调用」,
   原始 snake_case 由 toolNameRawTitle 放 title,不再裸显。 */
function toolLabel(name: string): string {
  return toolNameLabel(name);
}

function AssistantPanel({
  open,
  onClose,
  demoMode,
  context,
  notify,
  shortcut,
  forceFixed,
}: {
  open: boolean;
  onClose: () => void;
  demoMode: boolean;
  context: { project_id?: string; vnext_project_id?: string; episode_id?: string; shot_id?: string; label: string };
  notify: PageRuntimeProps["notify"];
  /** 分平台折叠快捷键提示(⌘J / Ctrl+J),悬浮在收起钮上。 */
  shortcut: string;
  /**
   * R2-4：lite 壳专用。LiteShell 顶栏（64px）在 wrapper 外，sticky 面板在 flow 里
   * 以 100dvh-56px 高度撑长 wrapper → 整页 8px 幻影滚动。lite 下改 fixed 抽屉
   * （覆盖式，不挤压主区），彻底脱离 flow。
   */
  forceFixed?: boolean;
}): React.JSX.Element {
  const contextKey = [context.project_id, context.vnext_project_id, context.episode_id, context.shot_id].filter(Boolean).join(":") || "global";
  const storageKey = `shortdrama_agent_session:${contextKey}`;
  const [sessionId, setSessionId] = useState(() => window.sessionStorage.getItem(storageKey) || "");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastInput, setLastInput] = useState("");
  /** Grill Engine offer_candidates 路径：候选卡片渲染状态。 */
  const [pendingCandidates, setPendingCandidates] = useState<Candidate[]>([]);
  const [quoteStates, setQuoteStates] = useState<Record<string, AssistantQuoteUiState>>({});
  const [toolRuns, setToolRuns] = useState<Record<string, ToolRunEntry>>({});

  useEffect(() => {
    const nextSession = window.sessionStorage.getItem(storageKey) || "";
    setSessionId(nextSession);
    setMessages([]);
    setError("");
    setQuoteStates({});
    setToolRuns({});
    if (!nextSession || demoMode) return;
    let active = true;
    void api.agentMessages(nextSession).then((result) => {
      if (!active) return;
      setMessages(result.items);
      setQuoteStates({
        ...historicalQuoteStates(result.items),
        ...storedSubmittedAssistantQuotes(nextSession),
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [contextKey, demoMode, storageKey]);

  async function send(content = input.trim()): Promise<void> {
    if (!content || busy) return;
    if (demoMode) {
      setError("离线演示不会调用助手。登录已启动的服务后可使用受限工具。");
      return;
    }
    setBusy(true);
    setError("");
    setLastInput(content);
    setInput("");
    try {
      await runAssistantMessage(content);
    } catch (reason) {
      setError(businessErrorMessage(reason, "助手这会儿没应答，请重试"));
    } finally {
      setBusy(false);
    }
  }

  async function runAssistantMessage(content: string): Promise<void> {
    const userMessage: AgentMessage = { id: newId(), role: "user", content, status: "complete" };
    const assistantId = newId();
    setMessages((current) => [...current, userMessage, { id: assistantId, role: "assistant", content: "", status: "streaming" }]);
    try {
      let activeSession = sessionId;
      if (!activeSession) {
        const created = await api.createAgentSession(context);
        activeSession = created.session_id;
        setSessionId(activeSession);
        window.sessionStorage.setItem(storageKey, activeSession);
      }
      await api.streamAgentMessage(activeSession, content, (event) => {
        if (event.type === "text_delta") {
          setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: `${message.content}${event.delta}` } : message));
          return;
        }
        // W6-D：远程 runtime 思考过程增量——累积到消息的 thinking 段（渲染为可折叠「思考中」）
        if (event.type === "thinking_delta") {
          setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, thinking: `${message.thinking ?? ""}${event.delta}` } : message));
          return;
        }
        if (event.type === "tool_start") {
          const runId = newId();
          setToolRuns((current) => ({ ...current, [runId]: { id: runId, toolName: event.tool_name, state: "running" } }));
          setMessages((current) => insertBefore(current, assistantId, {
            id: runId,
            role: "tool",
            content: "",
            status: "complete",
            tool_name: event.tool_name,
          }));
          return;
        }
        if (event.type === "tool_end") {
          setToolRuns((current) => {
            const running = Object.values(current).filter((run) => run.toolName === event.tool_name && run.state === "running");
            const target = running[running.length - 1];
            if (!target) return current;
            return { ...current, [target.id]: { ...target, state: event.is_error ? "failed" : "succeeded" } };
          });
          return;
        }
        if (event.type === "generation_quote") {
          addAssistantQuoteMessage(event, assistantId, setMessages, setQuoteStates);
          return;
        }
        // Grill Engine offer_candidates 路径：候选卡片渲染
        if (event.type === "card_delta") {
          setPendingCandidates(event.candidates);
        }
      });
      setMessages((current) => current.map((message) => message.id === assistantId
        ? { ...message, status: "complete", content: message.content || "操作已处理。" }
        : message));
    } catch (reason) {
      const message = businessErrorMessage(reason, "助手这会儿没应答，请重试");
      setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, status: "failed", content: item.content || message } : item));
      throw reason;
    }
  }

  async function submitAssistantQuote(quote: GenerationQuote): Promise<void> {
    const quoteId = quote.generation_quote_id;
    const current = quoteStates[quoteId];
    if (busy || current?.phase === "submitting" || current?.phase === "submitted") return;
    if (!sessionId) {
      setQuoteStates((states) => ({ ...states, [quoteId]: { phase: "failed", error: "助手会话已失效，请重新提出生成需求。" } }));
      return;
    }
    if (quoteIsExpired(quote)) {
      setQuoteStates((states) => ({ ...states, [quoteId]: { phase: "expired", error: "确认卡已过期，请重新向 Pi 发起生成请求。" } }));
      return;
    }
    setBusy(true);
    setError("");
    setQuoteStates((states) => ({ ...states, [quoteId]: { phase: "submitting" } }));
    try {
      const task = await api.submitAssistantGenerationQuote(sessionId, quoteId);
      const nextState: AssistantQuoteUiState = {
        phase: "submitted",
        generationRequestId: task.generation_request_id,
      };
      setQuoteStates((states) => ({ ...states, [quoteId]: nextState }));
      rememberSubmittedAssistantQuote(sessionId, quoteId, task.generation_request_id);
      notify("生成任务已提交，可在工作台查看进度", "success");
    } catch (reason) {
      const expired = reason instanceof ApiClientError
        && ["GENERATION_QUOTE_EXPIRED", "quote_stale", "GENERATION_QUOTE_CONFLICT"].includes(reason.code);
      setQuoteStates((states) => ({
        ...states,
        [quoteId]: {
          phase: expired ? "expired" : "failed",
          error: businessErrorMessage(reason, "提交生成任务失败，请重试"),
        },
      }));
    } finally {
      setBusy(false);
    }
  }

  const suggestions = assistantSuggestions(context.label);

  return (
    <aside className={cn(
      forceFixed
        ? "glass-panel fixed right-0 top-16 bottom-0 z-[var(--z-float)] flex w-[340px] shrink-0 flex-col border-l transition-[transform,opacity] duration-[var(--duration-3)] ease-out-quint"
        : "glass-panel sticky top-14 z-[var(--z-float)] flex h-[calc(100dvh-56px)] w-[340px] shrink-0 flex-col border-l transition-[transform,opacity] duration-[var(--duration-3)] ease-out-quint",
      "max-[900px]:fixed max-[900px]:inset-x-0 max-[900px]:bottom-0 max-[900px]:top-auto max-[900px]:h-[min(70vh,640px)] max-[900px]:w-full max-[900px]:rounded-t-xl max-[900px]:border-l-0 max-[900px]:border-t",
      !open && (forceFixed
        ? "translate-x-full opacity-0 pointer-events-none max-[900px]:translate-x-0 max-[900px]:translate-y-full"
        : "-mr-[340px] translate-x-4 opacity-0 pointer-events-none max-[900px]:mr-0 max-[900px]:translate-x-0 max-[900px]:translate-y-full"),
    )} aria-label="AI 智能工作区">
      <header className="flex items-center justify-between gap-2 border-b border-border-1 px-4 py-3">
        <div className="flex items-center gap-2"><strong className="font-semibold text-agent-text">Pi</strong><span className="inline-flex items-center rounded-full border border-border-1 bg-surface-2 px-2 py-0.5 text-xs text-ink-2">{context.label}</span></div>
        <div><Button {...shellIconButtonProps("关闭 AI 工作区")} className="size-8" icon={<X />} onClick={onClose} title={`收起 AI 工作区（${shortcut}）`} /></div>
      </header>
      <div className="presence-bar" data-working={busy ? "true" : "false"} aria-hidden="true" />
      <div className="flex-1 overflow-y-auto p-4">
        <AssistantContextCard
          label={context.label}
          suggestions={suggestions}
          showSuggestions={messages.length === 0 && !demoMode}
          busy={busy}
          onPick={(suggestion) => void send(suggestion)}
        />
        {messages.length > 0 ? <div className="flex flex-col gap-3">{messages.map((message) => {
          const quote = generationQuoteFromMessage(message);
          if (quote) {
            return <AssistantGenerationQuoteCard
              key={message.id}
              quote={quote}
              state={quoteStates[quote.generation_quote_id]}
              busy={busy}
              onConfirm={() => void submitAssistantQuote(quote)}
            />;
          }
          if (message.role === "tool") {
            const run = toolRuns[message.id];
            const state = run?.state ?? "succeeded";
            return (
              <div className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2" key={message.id}>
                <code className="text-[11px] text-ink-1" title={toolNameRawTitle(message.tool_name)}>{toolLabel(message.tool_name || "工具")}</code>
                <span className={cn(
                  "ml-auto inline-flex items-center gap-1 whitespace-nowrap",
                  state === "running" && "text-accent",
                  state === "succeeded" && "text-success",
                  state === "failed" && "text-danger",
                  state === "undone" && "text-ink-3",
                )}>
                  {state === "running" ? <><SpinnerGap className="animate-spin" />进行中</> : null}
                  {state === "succeeded" ? <><CheckCircle />完成</> : null}
                  {state === "failed" ? <><WarningCircle />失败</> : null}
                  {state === "undone" ? <>已撤销</> : null}
                </span>
              </div>
            );
          }
          return (
            <article className="flex flex-col gap-1" key={message.id}>
              <span className={cn("text-xs font-medium text-ink-2", message.role === "assistant" && "text-agent-text")}>{message.role === "user" ? "你" : "Pi"}</span>
              {message.thinking ? (
                <details className="mb-2 mt-1 rounded-sm bg-agent/10 px-3 py-2 text-xs text-ink-2" open={message.status === "streaming"}>
                  <summary className="cursor-pointer select-none font-semibold text-agent-text">{message.status === "streaming" ? "思考中…" : "思考过程"}</summary>
                  <p className="mt-1 whitespace-pre-wrap">{message.thinking}</p>
                </details>
              ) : null}
              <p className={cn(
                "whitespace-pre-wrap break-words rounded-md border border-border-1 bg-surface-2 px-3 py-2",
                message.role === "assistant" && "border-transparent bg-agent/10",
                message.status === "failed" && "border-danger/14 text-danger",
              )}>{message.content || (message.status === "streaming" && !message.thinking ? "正在想…" : "")}</p>
              {message.status === "streaming" ? <SpinnerGap className="size-3.5 animate-spin text-ink-2" /> : null}
            </article>
          );
        })}</div> : null}
        {pendingCandidates.length > 0 ? (
          <CandidateCard
            candidates={pendingCandidates}
            disabled={busy}
            onPick={(label) => {
              setPendingCandidates([]);
              void send(label);
            }}
            onCustomSubmit={(text) => {
              setPendingCandidates([]);
              void send(text);
            }}
            onDismiss={() => setPendingCandidates([])}
          />
        ) : null}
      </div>
      <NextSeasonTeaser demoMode={demoMode} />
      <footer className="flex flex-col gap-2 border-t border-border-1 px-4 pb-4 pt-3">
        {error ? <div className="flex items-center justify-between gap-2 rounded-sm bg-danger/14 px-3 py-2 text-xs text-danger"><span>{error}</span>{lastInput && !demoMode ? <button className="font-semibold text-danger underline underline-offset-[3px]" disabled={busy} onClick={() => void send(lastInput)}>重试</button> : null}</div> : null}
        <textarea className="min-h-[60px] w-full" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={demoMode ? "离线演示不调用助手" : "告诉 Pi 你想找什么、想生成什么…"} disabled={busy} />
        <Button variant="primary" className="self-end" icon={<PaperPlaneTilt />} loading={busy} disabled={!input.trim()} onClick={() => void send()}>发送</Button>
      </footer>
    </aside>
  );
}

/**
 * 板16「功能预告」单行轮播：自动 5s 切换或点行手动切换；
 * 可关——关掉后本次会话不再出现（记忆在 sessionStorage）。
 * S23：轮播句随版本计划入库——从接口读取拼装；读不到就不出轮播，不放空炮。
 * 动效按板15：一次性淡入切换（key 重挂载触发），reduced-motion 静止。
 * 样式在 pages/settings.css（pi-teaser 家族），未随壳迁移。
 */
function NextSeasonTeaser({ demoMode }: { demoMode: boolean }): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => piTeaserDismissed(window.sessionStorage));
  const [lines, setLines] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (dismissed || demoMode) return;
    let cancelled = false;
    api.releasePlan()
      .then((plan) => { if (!cancelled) setLines(buildTeaserLines(plan.sections)); })
      .catch(() => { if (!cancelled) setLines([]); });
    return () => { cancelled = true; };
  }, [dismissed, demoMode]);
  useEffect(() => {
    if (dismissed || lines.length === 0) return;
    const timer = window.setInterval(() => setIndex((current) => nextTeaserIndex(current, lines.length)), PI_TEASER_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [dismissed, lines.length]);
  if (dismissed || lines.length === 0) return null;
  const line = lines[index % lines.length] ?? "";
  return (
    <div className="pi-teaser" role="note" aria-label="功能预告">
      <span className="pi-teaser-tag" aria-hidden="true">功能预告</span>
      <button
        key={index}
        className="pi-teaser-line"
        type="button"
        title={`${line}（点击换下一条）`}
        onClick={() => setIndex((current) => nextTeaserIndex(current, lines.length))}
      >{line}</button>
      <Button {...shellIconButtonProps("关闭功能预告")} className="size-8" icon={<X />} onClick={() => { dismissPiTeaser(window.sessionStorage); setDismissed(true); }} />
    </div>
  );
}

/** 把工具记录插入在助手正文消息之前，保持"先执行、后总结"的阅读顺序。 */
function insertBefore(messages: AgentMessage[], anchorId: string, entry: AgentMessage): AgentMessage[] {
  const anchorIndex = messages.findIndex((message) => message.id === anchorId);
  if (anchorIndex < 0) return [...messages, entry];
  return [...messages.slice(0, anchorIndex), entry, ...messages.slice(anchorIndex)];
}

function AssistantGenerationQuoteCard({ quote, state, busy, onConfirm }: {
  quote: GenerationQuote;
  state?: AssistantQuoteUiState;
  busy: boolean;
  onConfirm: () => void;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const phase = state?.phase ?? (quote.status === "consumed" ? "submitted" : quoteIsExpired(quote, now) ? "expired" : "ready");
  const expired = phase === "expired" || quoteIsExpired(quote, now);
  const loading = phase === "submitting";
  const mediaLabel = quote.media_kind === "video" ? "视频" : "图片";
  const stateLabel = expired
    ? "确认卡已过期"
    : phase === "submitted"
      ? "任务已提交"
      : phase === "submitting"
        ? "正在提交任务"
        : phase === "failed" ? "本次提交失败" : "等待你确认";
  const buttonLabel = expired
    ? "已过期，请重新准备"
    : phase === "submitted"
      ? "已提交"
      : phase === "failed" ? "再试一次" : `生成${mediaLabel}`;
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-border-2 bg-surface-2 p-4">
      <header className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 font-semibold text-ink-1">{quote.media_kind === "video" ? <VideoCamera /> : <ImageSquare />}<span>{mediaLabel}生成确认</span></div><strong className="text-ink-1 [font-family:var(--font-mono)]">{formatCost(quote.estimated_cost_fen)}</strong></header>
      <div className="flex flex-col gap-1 text-xs text-ink-2"><span className="inline-flex items-center gap-1"><CurrencyCny />后台自动报价（{quote.currency}），额度内不再打断你</span><span className="inline-flex items-center gap-1"><Clock />参数冻结至 {formatQuoteExpiry(quote.expires_at)}</span></div>
      <p className="text-xs text-ink-2">先估价后人工确认：Pi 只负责准备，点击下方按钮，才会用已冻结的参数创建这一个任务。</p>
      <div className={cn("flex items-center gap-2 text-xs", phase === "submitted" ? "text-success" : expired || phase === "failed" ? "text-danger" : "text-ink-2")} aria-live="polite">{phase === "submitted" ? <CheckCircle /> : expired || phase === "failed" ? <WarningCircle /> : <Clock />}<span>{stateLabel}</span></div>
      {state?.generationRequestId ? <div className="flex items-center gap-2 text-xs text-ink-2"><span>任务编号</span><code className="text-[11px] text-ink-1">{state.generationRequestId}</code></div> : null}
      {state?.error ? <div className="rounded-sm bg-danger/14 px-3 py-2 text-xs text-danger" role="alert">{state.error}</div> : null}
      <Button
        variant="primary"
        icon={phase === "submitted" ? <CheckCircle /> : quote.media_kind === "video" ? <VideoCamera /> : <ImageSquare />}
        loading={loading}
        disabled={busy || expired || phase === "submitted"}
        onClick={onConfirm}
      >{buttonLabel}</Button>
    </article>
  );
}

function addAssistantQuoteMessage(
  event: Extract<AgentStreamEvent, { type: "generation_quote" }>,
  assistantId: string,
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>,
  setQuoteStates: React.Dispatch<React.SetStateAction<Record<string, AssistantQuoteUiState>>>,
): void {
  const quoteId = event.quote.generation_quote_id;
  setMessages((current) => {
    if (current.some((message) => generationQuoteFromMessage(message)?.generation_quote_id === quoteId)) return current;
    const quoteMessage: AgentMessage = {
      id: `generation-quote-${quoteId}`,
      role: "tool",
      content: "",
      status: "complete",
      tool_name: "generate_media",
      generation_quote: event.quote,
    };
    return insertBefore(current, assistantId, quoteMessage);
  });
  setQuoteStates((current) => ({
    ...current,
    [quoteId]: current[quoteId] ?? { phase: quoteIsExpired(event.quote) ? "expired" : "ready" },
  }));
}

function historicalQuoteStates(messages: AgentMessage[]): Record<string, AssistantQuoteUiState> {
  const states: Record<string, AssistantQuoteUiState> = {};
  for (const message of messages) {
    const quote = generationQuoteFromMessage(message);
    if (quote) {
      states[quote.generation_quote_id] = {
        phase: quote.status === "consumed" ? "submitted" : quoteIsExpired(quote) ? "expired" : "ready",
        ...(quote.generation_request_id ? { generationRequestId: quote.generation_request_id } : {}),
      };
    }
  }
  return states;
}

function storedSubmittedAssistantQuotes(sessionId: string): Record<string, AssistantQuoteUiState> {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(assistantQuoteStorageKey(sessionId)) || "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([quoteId, requestId]) => (
      typeof requestId === "string" && requestId
        ? [[quoteId, { phase: "submitted" as const, generationRequestId: requestId }]]
        : []
    )));
  } catch {
    return {};
  }
}

function rememberSubmittedAssistantQuote(sessionId: string, quoteId: string, requestId: string): void {
  const current = storedSubmittedAssistantQuotes(sessionId);
  const values = Object.fromEntries(Object.entries(current).flatMap(([id, state]) => (
    state.generationRequestId ? [[id, state.generationRequestId]] : []
  )));
  window.sessionStorage.setItem(assistantQuoteStorageKey(sessionId), JSON.stringify({ ...values, [quoteId]: requestId }));
}

function assistantQuoteStorageKey(sessionId: string): string {
  return `shortdrama_agent_submitted_quotes:${sessionId}`;
}

function routeContext(pathname: string): { project_id?: string; vnext_project_id?: string; episode_id?: string; shot_id?: string; label: string } {
  const vnextProject = pathname.match(/^\/vnext\/projects\/([^/]+)$/);
  if (vnextProject) return { vnext_project_id: vnextProject[1], label: "vNext 画布" };
  if (pathname === "/projects/plaza") return { label: "创作广场" };
  /* 块 2:镜级工作台退役,助手上下文按场级工作台识别(scene 级无 shot_id)。 */
  const sceneWorkbench = pathname.match(/^\/projects\/([^/]+)\/storyboards\/([^/]+)\/scenes\/([^/]+)$/);
  if (sceneWorkbench) return { project_id: sceneWorkbench[1], episode_id: sceneWorkbench[2], label: "工作台" };
  const projectId = projectIdFromPath(pathname);
  if (projectId) {
    if (pathname.endsWith("/director")) return { project_id: projectId, label: "3D 导演台" };
    if (pathname.endsWith("/reference-tests")) return { project_id: projectId, label: "参考测试" };
    if (pathname.endsWith("/material-agent")) return { project_id: projectId, label: "素材智能体" };
    return { project_id: projectId, label: pathname.endsWith("/costs") ? "消耗看板" : pathname.includes("/storyboards") ? "生产" : "资产面板" };
  }
  return { label: pathname === "/dashboard" ? "数据看板" : pathname === "/settings" ? "设置" : pathname === "/assets" ? "资产面板" : "项目面板" };
}

function NotFoundPage(): React.JSX.Element {
  return <section className="mx-auto flex max-w-[1200px] flex-col gap-5"><EmptyState title="页面不存在" description="返回项目管理继续工作。" action={<Button variant="primary" onClick={() => navigate("/projects")}>返回项目管理</Button>} icon={<FolderOpen />} /></section>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><App /></StrictMode>);
