import type { GenerationAttemptNotification } from "./types";

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState({}, "", path);
  else window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function routePath(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function vnextProjectsPath(): string {
  return "/vnext/projects";
}

export function vnextProjectPath(projectId: string): string {
  return `/vnext/projects/${encodeURIComponent(projectId)}`;
}

/** 块 2 起 /storyboards 列表页已退役:此函数只作 URL 前缀构件(scenes 工作台沿用该前缀,
 *  URL 换代排命名换代窗口)与「换乘口」目标——直接 navigate 到它的,路由层会 redirect 到生产页。 */
export function projectStoryboardPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/storyboards`;
}

/** 生产页(P-02b 集视图)——块 2 起生产域的唯一列表级入口,旧 /storyboards 与镜级工作台均并入。 */
export function productionViewPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/production`;
}

/** 块 2:旧分镜列表页深链的换乘目标(纯函数供 redirect 组件与测试)。
 *  旧页五种深链全承接:?episode= 选集、?playback=1 整集连播、?delivery=1 交付、
 *  ?delivery=history 交付历史、?review=1 审核队列;未知参数不随乘。 */
export function storyboardsRedirectTarget(projectId: string, search: string): string {
  const query = new URLSearchParams(search);
  const carried = new URLSearchParams();
  const episode = query.get("episode");
  if (episode) carried.set("episode", episode);
  if (query.get("playback") === "1") carried.set("playback", "1");
  const delivery = query.get("delivery");
  if (delivery === "1" || delivery === "history") carried.set("delivery", delivery);
  if (query.get("review") === "1") carried.set("review", "1");
  const suffix = carried.toString();
  return `${productionViewPath(projectId)}${suffix ? `?${suffix}` : ""}`;
}

/** 块 2:镜级 URL 的换乘目标——有归属场→场级工作台(?library=1 选主版本深链随乘);
 *  未分场/查不到→生产页(不许把旧链接用户丢进错的场)。 */
export function shotRedirectTarget(projectId: string, episodeId: string, sceneId: string | null | undefined, search: string): string {
  if (!sceneId) return productionViewPath(projectId);
  const suffix = new URLSearchParams(search).get("library") === "1" ? "?library=1" : "";
  return `${sceneWorkbenchPath(projectId, episodeId, sceneId)}${suffix}`;
}

export function projectDirectorPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/director`;
}

/** F15：备戏台深链必须带来源上下文(项目/集/场)——裸跳会让备戏台按记忆/兜底开成别部剧的场,
    「送入这场戏」就把料写进错场。 */
export function prepStagePath(projectId: string, episodeId: string, sceneId?: string | null): string {
  const query = new URLSearchParams({ project: projectId, episode: episodeId });
  if (sceneId) query.set("scene", sceneId);
  return `/assets/prep?${query.toString()}`;
}

export function projectScriptBreakdownPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/script-breakdown`;
}

/** 项目资产(P-07);P-06「确认分镜表→P-07」落点。 */
export function projectAssetsPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/assets`;
}

/** 需求拆解统一运行页（K2 彩排包：以 run 为中心，作用域从 run 读）。 */
export function projectRequirementBreakdownPath(projectId: string, runId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/requirement-breakdowns/${encodeURIComponent(runId)}`;
}

/** 块 2 起镜级工作台已退役,shots URL 语义=「换乘口」:手头只有 shotId 的入口(通知/命令面板/任务队列)
 *  继续产这个 URL,路由层按 shot.scene_id 解析归属场后 replace 到场级工作台;未分场兜底落生产页。
 *  手头已有 sceneId 的组件必须直接产 sceneWorkbenchPath,不许绕换乘多一跳。 */
export function shotWorkbenchPath(projectId: string, episodeId: string, shotId: string): string {
  return `${projectStoryboardPath(projectId)}/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(shotId)}`;
}

/** 段落工作台（批次二 P-04）：一场 N 镜、整段一次生成的工作页；段落=场(scene)。 */
export function sceneWorkbenchPath(projectId: string, episodeId: string, sceneId: string): string {
  return `${projectStoryboardPath(projectId)}/${encodeURIComponent(episodeId)}/scenes/${encodeURIComponent(sceneId)}`;
}

/** 生成视频工作台（板05）：图片工作台的同级独立页。 */
export function projectIdFromPath(pathname: string): string | null {
  return pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
}

/** 任务提醒的查看去处：归栏资产→资产详情页；分镜产物→对应工作台；其余→项目生产页。
 *  app.tsx 通知 Dock 与首页「最近动态」共用这一个出口，不许两处各写一套。
 *  跳转目标跟随当前界面模式：Lite（/lite/* 页面）用户落 Lite 对应页（资产详情/分镜详情/制作页），
 *  完整版落 /projects/* 对应页——Lite 生图/生音频后点「查看」不能跳到完整版资产页。 */
export function notificationResultPath(notification: GenerationAttemptNotification): string {
  const { project_id: projectId, episode_id: episodeId, shot_id: shotId, target_asset_entity_id: targetAssetEntityId } = notification;
  const lite = typeof window !== "undefined" && window.location.pathname.startsWith("/lite");
  if (targetAssetEntityId) {
    return lite
      ? `/lite/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(targetAssetEntityId)}`
      : `/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(targetAssetEntityId)}`;
  }
  if (episodeId && shotId) {
    return lite
      ? `/lite/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}`
      : `/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(episodeId)}/shots/${encodeURIComponent(shotId)}`;
  }
  return lite
    ? `/lite/projects/${encodeURIComponent(projectId)}/workspace`
    : projectStoryboardPath(projectId);
}

export function episodeIdFromPath(pathname: string): string | null {
  return pathname.match(/\/storyboards\/([^/]+)/)?.[1] ?? null;
}

export function shotIdFromPath(pathname: string): string | null {
  return pathname.match(/\/shots\/([^/]+)/)?.[1] ?? null;
}

/* ---------- 登录跳转：保存当前地址，成功后回原位置 ----------
   V-47:整页登录退役——登录入口统一=落地页+自动展开登录卡(redirect 照传,登录成功回原位)。 */

export function loginEntryPathFor(currentPath: string): string {
  /* 旧 /login 深链换乘到 /landing:带 redirect 原样保留(F03:并发第二个 401 不得把回去地址
     抹成默认页),裸 /login 给默认去向。 */
  if (currentPath.startsWith("/login")) {
    const suffix = currentPath.slice("/login".length);
    if (suffix && safeRedirectTarget(suffix)) return `/landing${suffix}`;
    return "/landing?redirect=/projects";
  }
  /* 已在 /landing:带 redirect 原样保留(401 事件与 boot catch 会连着跳两次,第二跳不得抹参)。 */
  if (currentPath.startsWith("/landing")) {
    const suffix = currentPath.slice("/landing".length);
    if (suffix && safeRedirectTarget(suffix)) return currentPath;
    return "/landing?redirect=/projects";
  }
  if (!currentPath || currentPath === "/") return "/landing?redirect=/projects";
  return `/landing?redirect=${encodeURIComponent(currentPath)}`;
}

/** 只接受站内相对地址，拒绝协议/双斜杠开头的外部跳转。 */
export function safeRedirectTarget(search: string): string | null {
  const raw = new URLSearchParams(search).get("redirect");
  return safeInternalPath(raw);
}

/**
 * 企业微信回跳只能复用与服务端 ui_mode 相容的站内地址。认证入口本身不是业务落点，
 * 反斜杠、控制字符和协议相对地址一律失败关闭，避免浏览器规范化成外站跳转。
 */
export function wecomPostLoginPath(uiMode: "lite" | "full", returnTo: string | null): string {
  const safe = safeInternalPath(returnTo);
  const isAuthEntry = safe === "/" || safe === "/landing" || safe?.startsWith("/landing?")
    || safe === "/login" || safe?.startsWith("/login?");
  if (safe && !isAuthEntry) {
    const isLite = safe === "/lite" || safe.startsWith("/lite/");
    if ((uiMode === "lite" && isLite) || (uiMode === "full" && !isLite)) return safe;
  }
  return uiMode === "lite" ? "/lite/projects" : "/projects";
}

export function wecomAuthorizePath(search: string): string {
  const returnTo = safeRedirectTarget(search);
  if (!returnTo) return "/api/v1/auth/wecom/authorize";
  return `/api/v1/auth/wecom/authorize?${new URLSearchParams({ return_to: returnTo }).toString()}`;
}

function safeInternalPath(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

/* ---------- 项目内位置记忆：再次进入项目时恢复上次工作位置 ---------- */

const PROJECT_LOCATION_KEY = "shortdrama_v011_project_location";
const PROJECT_VISITED_KEY = "shortdrama_v011_project_visited";

function readRecord(key: string): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "{}") as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as Record<string, string>;
    }
  } catch {
    // 存储损坏时按空记录处理
  }
  return {};
}

function writeRecord(key: string, record: Record<string, string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // 隐私模式等写入失败不影响导航
  }
}

export function rememberProjectLocation(projectId: string, path: string): void {
  if (!projectId || !path.startsWith(`/projects/${encodeURIComponent(projectId)}`)) return;
  writeRecord(PROJECT_LOCATION_KEY, { ...readRecord(PROJECT_LOCATION_KEY), [projectId]: path });
}

export function recallProjectLocation(projectId: string): string | null {
  const path = readRecord(PROJECT_LOCATION_KEY)[projectId];
  return path && path.startsWith("/projects/") ? path : null;
}

/** 是否已进入过该项目（纯读，供三步轻引导判断；StrictMode 下可安全重复调用）。 */
export function hasVisitedProject(projectId: string): boolean {
  return Boolean(readRecord(PROJECT_VISITED_KEY)[projectId]);
}

/** 记录已进入过该项目（幂等写）。 */
export function markProjectVisited(projectId: string): void {
  const visited = readRecord(PROJECT_VISITED_KEY);
  if (visited[projectId]) return;
  writeRecord(PROJECT_VISITED_KEY, { ...visited, [projectId]: "1" });
}

/** F13：本人在本机真实进入/停留过的项目集合（位置记忆 + 进入登记两源并集）——
    「继续上次工作」只许从这里挑,挑不到就降级叫「最近更新的项目」,不拿别人的项目冒充。 */
export function visitedProjectIds(): ReadonlySet<string> {
  return new Set([...Object.keys(readRecord(PROJECT_LOCATION_KEY)), ...Object.keys(readRecord(PROJECT_VISITED_KEY))]);
}
