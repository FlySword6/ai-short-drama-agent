/* ============================================================
  lite-shell.tsx — Lite 界面模式单条顶栏（Lite 界面重做 §2.2，2026-08-17 用户裁定）
  一条自适应导航条（所有 /lite 页同一结构，修订 R2-11 两层结构）：
  左起 logo 标（BrandMark，不带品牌文字排；点回项目列表 /lite，兼任原
  「〈 全部项目」职责）→ 返回按钮（2026-08-17 二次裁定：项目内每页常驻
  且带文字说明——工作页/配置页 ‹ 返回项目列表 固定回 /lite；分镜详情
  ‹ 返回项目详情 固定回制作页（2026-08-18 裁定：切镜 tab 会压历史栈，
  历史返回会退回上一镜，故走确定性去向）；资产详情 ‹ 返回素材 历史返回，
  无历史回落对应列表页；文字常显，不因窄屏藏成纯箭头）→ 名称区（《剧名》；
  最后一段字重最重）→ 右组 制作/资产 两工作页入口（✓/●/○，§5.5，不锁
  跳转）+ ⚙ 项目配置 │ 模式切换 + 用户名（恒在）。
  内层容器与内容容器（§3.1）同宽同内边距，两端对齐；项目列表页
  （projectId 为 null）只渲染 logo 标 + 模式切换 + 用户名。
  [导入剧本] 不在壳内，放制作页左栏剧集头（R2-14，2026-08-17）。
  Lite 与完整版同一应用同一库，壳不引第二套路由/状态。视觉守 DESIGN.md：
  深色四层、薄荷青唯一强调色、语义 token 类、字重 400/500/600。
   ============================================================ */
import { useEffect, useMemo, useRef } from "react";
import {
  ArrowLeft,
  FilmSlate,
  GearSix,
  Images,
  SquaresFour,
} from "@phosphor-icons/react";
import { navigate } from "../../routing";
import { demoProjectById } from "../../demo";
import { api, type LiteAssetDetail } from "../../api";
import type { Project, User as UserType, Episode, Scene, Shot } from "../../types";
import { useResource, assetKindLabel } from "../../ui";
import { Button } from "../../components/ui/button";
import { BrandMark } from "../../components/ui/brand-mark";
import { DEMO_EPISODES, DEMO_PROJECT, DEMO_SCENES, DEMO_SHOTS } from "./lite-demo-fixtures";
import { LiteTaskNotificationBadge } from "./lite-task-notification-badge";
import { cn } from "../../components/ui/cn";

/** Lite 项目内 2 个工作页导航（§2.2：剧本+分镜合并为「制作」，资产独立；成品不占页签）。
 *  完成态标记（✓/●/○）在渲染时按 §5.5 计算，不锁跳转。 */
const LITE_NAV_ITEMS = [
  { key: "workspace", label: "制作", icon: FilmSlate },
  { key: "assets", label: "资产", icon: Images },
] as const;

export type LiteNavKey = (typeof LITE_NAV_ITEMS)[number]["key"];

/** Lite 项目内页面路径唯一拼法（壳导航与页面「下一步」入口共用，不许两处各写一套）。
 *  多集模式：有 episodeId 则拼 `?ep=<id>`，集维度全局跟随。 */
export function liteProjectPath(projectId: string, key: LiteNavKey, episodeId?: string | null): string {
  const base = `/lite/projects/${encodeURIComponent(projectId)}/${key}`;
  return episodeId ? `${base}?ep=${encodeURIComponent(episodeId)}` : base;
}

/** 项目配置页唯一拼法（壳顶栏 ⚙ 与项目卡「配置」同一入口的两种出现位；不进工作页导航）。 */
export function liteConfigPath(projectId: string): string {
  return `/lite/projects/${encodeURIComponent(projectId)}/config`;
}
/** 创作广场（项目维度）唯一拼法：Lite 顶栏入口与路由共用。 */
export function litePlazaPath(projectId: string): string {
  return `/lite/projects/${encodeURIComponent(projectId)}/plaza`;
}

/** v1.4 分镜详情页唯一拼法（列表卡片/详情内顶部镜 tab 共用，不许两处各写一套）：
 *  `/lite/projects/:id/shots/:shotId` + 可选 `?ep=`（集维度跟随，返回列表页回显原集）。 */
export function liteShotDetailPath(projectId: string, shotId: string, episodeId?: string | null): string {
  const base = `/lite/projects/${encodeURIComponent(projectId)}/shots/${encodeURIComponent(shotId)}`;
  return episodeId ? `${base}?ep=${encodeURIComponent(episodeId)}` : base;
}

/** 从当前 URL search 读全局当前集 ep 参数（多集模式：切集后其他页自动跟随）。 */
export function readCurrentEpisodeId(): string | null {
  return new URLSearchParams(window.location.search).get("ep");
}

/** 导航按钮：图标+文字，active 态 accent 填充（与完整版 projectNavButtonClass 同配方）。 */
function liteNavButtonClass(active: boolean): string {
  return cn(
    /* v1.6 反馈①：工作页 tab 字体收敛；2026-08-18 再收敛——text-sm(14px)→text-xs(12px)；
       active 态去 font-medium 防字宽跳动。 */
    "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-4 py-2 text-xs transition-all duration-[var(--duration-1)] ease-out-quart active:scale-[0.98] [&_svg]:size-4",
    active ? "bg-accent-subtle font-medium text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1",
  );
}

/** 返回按钮（壳上详情页返回 / 与完整版 backButtonClass 同配方）。 */
const liteBackButtonClass = "inline-flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-2 text-xs text-ink-2 transition-colors duration-[var(--duration-1)] ease-out-quart hover:bg-surface-2 hover:text-ink-1";

/** 场景短名：去掉「第N集」类前缀后取前 6 字（决策 3 编码 {集号}-{镜号}-{场景短名}）。
   v1.6 反馈①追加：分镜切换 tab 上壳顶栏后，编码函数随渲染处迁入壳。 */
function sceneNameShort(name: string): string {
  const stripped = name.replace(/^第\s*\d+\s*集?[·\-—_ ]*/, "").trim();
  return stripped.slice(0, 6);
}

/** 分镜编码（只读展示）：{集号}-{镜号}-{场景短名}。v1.5 反馈①起只用于面包屑/
    悬停/版本弹窗标题；顶部 tab 用纯镜号数字（渲染处见壳顶栏 nav）。 */
export function shotCode(shot: Shot, episode: Episode | null | undefined, scene: Scene | null | undefined): string {
  const parts = [String(episode?.episode_no ?? ""), shot.shot_no];
  if (scene?.name) parts.push(sceneNameShort(scene.name));
  return parts.filter(Boolean).join("-");
}

/** 详情页返回（§2.2）：分镜详情固定回制作页（项目详情，带 ?ep=）——2026-08-18
 *  用户裁定：顶栏切镜 tab 会压历史栈，历史返回会退回上一镜，返回去向必须确定；
 *  资产详情仍历史返回，无历史回落素材列表。（2026-08-17 上移至壳单条。） */
function shellDetailBack(projectId: string, target: "shots" | "assets", episodeId: string | null): void {
  if (target === "shots") {
    navigate(liteProjectPath(projectId, "workspace", episodeId));
    return;
  }
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  navigate(liteProjectPath(projectId, "assets"));
}

export function LiteShell({ pathname, projectId, demoMode, user, switching, onSwitchUiMode }: {
  pathname: string;
  /** 项目上下文（/lite/projects/:id/* 由 app.tsx 解析传入）；项目列表页为 null，名称区/返回/导航整段不渲染。 */
  projectId: string | null;
  demoMode: boolean;
  user: UserType;
  /** 模式切换进行中（禁用防重复点击；patchMyUiMode 由 app.tsx 统一调，R2 禁 localStorage 存模式）。 */
  switching: boolean;
  onSwitchUiMode: () => void;
}): React.JSX.Element {
  /* 项目名 + 资产完成度（资产 ✓ = ≥1 资产实体，§5.5）。
     demo 下 api.project 无 mock，用 demoProjectById 兜底让《剧名》在顶栏正常回显（与 app.tsx 页头同法）。 */
  const projectState = useResource<Project | null>(
    () => (projectId ? api.project(projectId) : Promise.resolve(null)),
    /* demo 回落带 lite_episode_id（分镜详情壳顶栏 tab 的集维度与悬停编码需要它）。 */
    projectId ? demoProjectById(projectId) ?? { ...DEMO_PROJECT, id: projectId } : null,
    demoMode,
    [projectId],
  );
  const project = projectState.data;
  /* 集列表：当前 ?ep= 集 + 其剧本确认态（制作 ✓ = 当前集已确认且有分镜，§5.5）。 */
  const episodesState = useResource<{ items: Episode[] }>(() => (projectId ? api.episodes(projectId) : Promise.resolve({ items: [] })), { items: DEMO_EPISODES }, demoMode, [projectId]);
  const episodes = episodesState.data?.items ?? [];
  const effectiveEpisodeId = projectId
    ? readCurrentEpisodeId() ?? project?.lite_episode_id ?? episodes[0]?.id ?? null
    : null;
  const runsState = useResource<{ items: { id: string; status: string }[] }>(
    () => (effectiveEpisodeId ? api.scriptBreakdowns(effectiveEpisodeId) : Promise.resolve({ items: [] })),
    { items: [] },
    demoMode,
    [effectiveEpisodeId],
  );
  const runs = runsState.data?.items ?? [];
  const currentEpConfirmed = runs.some((run) => run.status === "confirmed");
  const currentEp = episodes.find((ep) => ep.id === effectiveEpisodeId) ?? null;
  const workspaceDone = Boolean(currentEp && currentEpConfirmed && (currentEp.shot_count ?? 0) > 0);
  const assetsDone = Boolean(project && (project.asset_count ?? 0) > 0);

  /* 详情页名称区数据（§2.2 具体名称上导航）：分镜详情取镜名（v1.6 反馈①：「分镜详情」
     四字退役，镜名缺失时名称区只留《剧名》）、资产详情取资产名·类型；
     工作页不取（名称区只有《剧名》）。 */
  const shotId = projectId ? pathname.match(/\/shots\/([^/]+)/)?.[1] ?? null : null;
  const assetEntityId = projectId && !shotId ? pathname.match(/\/assets\/([^/]+)/)?.[1] ?? null : null;
  const shotState = useResource<Shot | null>(
    () => (shotId ? api.shot(shotId) : Promise.resolve(null)),
    null,
    demoMode,
    [shotId],
  );
  const assetState = useResource<LiteAssetDetail | null>(
    () => (assetEntityId && projectId ? api.liteGetAsset(projectId, assetEntityId) : Promise.resolve(null)),
    null,
    demoMode,
    [projectId, assetEntityId],
  );
  const detailLabel = shotId
    ? shotState.data?.title?.trim() || null
    : assetEntityId
      ? assetState.data ? `${assetState.data.name} · ${assetKindLabel(assetState.data.asset_kind)}` : "资产详情"
      : null;
  /* v1.6 反馈①追加：分镜切换 tab 上壳顶栏——同集分镜清单 + 场景清单（悬停编码用），
     demo 走共享 fixture（与分镜详情页同一份，lite-demo-fixtures）。 */
  const shotsState = useResource<{ items: Shot[] }>(
    () => (effectiveEpisodeId ? api.shots(effectiveEpisodeId) : Promise.resolve({ items: [] })),
    { items: DEMO_SHOTS },
    demoMode,
    [effectiveEpisodeId],
  );
  const scenesState = useResource<{ items: Scene[] }>(
    () => (effectiveEpisodeId ? api.episodeScenes(effectiveEpisodeId) : Promise.resolve({ items: [] })),
    { items: DEMO_SCENES },
    demoMode,
    [effectiveEpisodeId],
  );
  const shots = useMemo(
    () => [...(shotsState.data?.items ?? [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.shot_no.localeCompare(b.shot_no, "zh-Hans-CN", { numeric: true }),
    ),
    [shotsState.data],
  );
  const shotTabsRef = useRef<HTMLElement | null>(null);
  /* 切镜后把当前镜 tab 滚进可视区（分镜数量多、屏幕窄时不丢当前位）。 */
  useEffect(() => {
    if (!shotId) return;
    const index = shots.findIndex((item) => item.id === shotId);
    if (index < 0) return;
    shotTabsRef.current?.children[index]?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [shotId, shots]);

  /* active 态:制作页 = /workspace 与分镜详情(/shots/:id)都算制作;资产 = /assets 与 /assets/:id */
  const activeKey: LiteNavKey | null = pathname.includes("/workspace") || pathname.includes("/shots/") || pathname.endsWith("/shots")
    ? "workspace"
    : pathname.includes("/assets")
      ? "assets"
      : null;
  const currentEpId = readCurrentEpisodeId();
  const switchTarget = user.ui_mode === "lite" ? "完整版" : "精简版";
  const projectName = project ? (project.name.startsWith("《") ? project.name : `《${project.name}》`) : null;

  return (
    <header className="sticky top-0 z-[calc(var(--z-float)+1)]">
      {/* 单条导航条（§2.2，2026-08-17）：全宽 glass 条，内层容器与内容容器同宽同内边距（§3.1），两端对齐。 */}
      <div className="glass-panel flex min-h-12 items-center px-4">
        <div className="mx-auto flex min-h-12 w-full max-w-[1440px] items-center gap-3 2xl:max-w-[1920px]">
          {/* logo 标（点回项目列表；不带品牌文字排——单条摆得下的前提） */}
          <button className="flex shrink-0 items-center rounded-sm px-2 py-2 text-left transition-colors duration-[var(--duration-1)] ease-out-quart hover:bg-surface-2" type="button" title="回项目列表" onClick={() => navigate("/lite")}><BrandMark size="sm" /></button>
          {projectId ? (
            <>
              {/* 返回（§2.2，2026-08-17 二次裁定：项目内每页常驻且带文字说明）——
                  工作页/配置页固定回项目列表 /lite；分镜详情固定回项目详情（制作页，
                  2026-08-18 裁定：不走历史返回，切镜不污染返回去向）；资产详情历史返回。
                  文字常显，不因窄屏藏成纯箭头。 */}
              <button
                className={cn(liteBackButtonClass, "shrink-0")}
                type="button"
                title={shotId ? "返回项目详情（制作页）" : assetEntityId ? "返回素材列表" : "返回项目列表"}
                onClick={() => (shotId || assetEntityId ? shellDetailBack(projectId, shotId ? "shots" : "assets", currentEpId) : navigate("/lite"))}
              >
                <ArrowLeft />{shotId ? "返回项目详情" : assetEntityId ? "返回素材" : "返回项目列表"}
              </button>
              {/* 名称区：工作页只有《剧名》；资产详情《剧名》·资产名·类型。
                  v1.6 反馈①追加：分镜详情的名称区让位给顶栏分镜切换 tab（镜名进悬停）。 */}
              {!shotId ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("min-w-0 truncate text-sm", detailLabel ? "text-ink-2" : "font-medium text-ink-1")}>{projectName}</span>
                  {detailLabel ? (
                    <>
                      <span className="shrink-0 text-sm text-ink-3">·</span>
                      <span className="min-w-0 truncate text-sm font-medium text-ink-1">{detailLabel}</span>
                    </>
                  ) : null}
                </span>
              ) : null}
              {/* 分镜切换 tab（v1.6 反馈①追加：上壳顶栏；纯镜号数字，悬停显完整场记编码；
                  横向滚动兼容窄屏与多镜） */}
              {shotId ? (
                <nav ref={shotTabsRef} aria-label="同集分镜" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                  {shots.map((item, index) => {
                    const sceneOfItem = (scenesState.data?.items ?? []).find((sceneItem) => sceneItem.id === item.scene_id) ?? null;
                    const isActive = item.id === shotId;
                    const label = String(index + 1);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => navigate(liteShotDetailPath(projectId, item.id, currentEpId))}
                        title={`分镜 ${label} · ${shotCode(item, currentEp, sceneOfItem)}`}
                        className={cn(
                          "whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
                          isActive ? "bg-accent-subtle font-medium text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink-1",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </nav>
              ) : null}
              <div className="ml-auto flex shrink-0 items-center gap-3">
                <nav className="flex gap-1" aria-label="Lite 项目导航">
                  {LITE_NAV_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const active = item.key === activeKey;
                    const done = item.key === "workspace" ? workspaceDone : assetsDone;
                    return (
                      <button key={item.key} type="button" className={liteNavButtonClass(active)} aria-current={active ? "page" : undefined} onClick={() => navigate(liteProjectPath(projectId, item.key, currentEpId))}>
                        <Icon />{item.label}<span className={cn("ml-0.5 text-[11px] leading-none", active ? "text-accent-text" : done ? "text-success" : "text-ink-3")}>{active ? "●" : done ? "✓" : "○"}</span>
                      </button>
                    );
                  })}
                </nav>
                {/* 创作广场：项目维度的生成广场入口（与完整版 rail「创作广场」同源页面）。 */}
                <button type="button" className={liteNavButtonClass(pathname.includes("/plaza"))} aria-current={pathname.includes("/plaza") ? "page" : undefined} onClick={() => navigate(litePlazaPath(projectId))}>
                  <SquaresFour />广场
                </button>
                <button className={liteBackButtonClass} type="button" title="项目配置" onClick={() => navigate(liteConfigPath(projectId))}>
                  <GearSix className="size-4" />项目配置
                </button>
                {/* 项目导航与全局件（用户名）之间的发丝分隔。v1.6 反馈①曾隐藏
                    lite→完整版入口；2026-08-24 裁决恢复全员双向切换。 */}
                <span className="h-4 border-l border-border-1" aria-hidden="true" />
                <Button variant="ghost" size="sm" loading={switching} title={`切换到${switchTarget}界面`} onClick={onSwitchUiMode}>{switchTarget}</Button>
                <span className="text-xs text-ink-2">{user.display_name}</span>
                {/* B(2026-08-19)：任务提醒收敛为顶栏铃铛徽标（完整版右下 Dock 在 Lite 退役）。 */}
                <LiteTaskNotificationBadge demoMode={demoMode} />
              </div>
            </>
          ) : (
            /* 项目列表页：logo 标 + 全员双向模式切换 + 用户名。
               v1.6 反馈①的单向门已被 2026-08-24 裁决取代。 */
            <div className="ml-auto flex shrink-0 items-center gap-3">
              <Button variant="ghost" size="sm" loading={switching} title={`切换到${switchTarget}界面`} onClick={onSwitchUiMode}>{switchTarget}</Button>
              <span className="text-xs text-ink-2">{user.display_name}</span>
              <LiteTaskNotificationBadge demoMode={demoMode} />
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
