/* ============================================================
   lite-projects-page.tsx — Lite 项目列表（任务 E 真页面，替换占位 stub）
   props 契约 = PageRuntimeProps（与完整版全局页同源），app.tsx 挂载不变。

   口径：
   - 数据源 api.projects()（Lite 用户只看分配给自己的项目，服务端已按成员过滤）；
   - 徽记唯一判据 = lite_episode_id（后端 toProject 透出的容器集指针，非空即
     已初始化的 Lite 项目；为空 = 还没走过 Lite 剧本提交，显示「未初始化」）；
   - 整卡可点 → 制作页（liteProjectPath 唯一拼法）；「编辑」打开项目弹窗(信息/成员/删除)；
     「配置」为次要动作 → config 页；
   - 新建项目入口与完整版同源：canCreateProject 锁驱动显隐（admin / 开了
     allowMemberCreateProject 的 member 可见）；新建/编辑共用 LiteProjectDialog；
   - 加载骨架屏（不用居中 spinner）、错误 ErrorState 带 retry、空态三段式，
     均照 useResource 模式（src/ui.tsx:289）。
   ============================================================ */
import { ArrowClockwise, FolderOpen, GearSix, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { api } from "../../api";
import { demoProjects } from "../../demo";
import { navigate } from "../../routing";
import type { Project } from "../../types";
import { Button } from "../../components/ui/button";
import { Badge, Skeleton } from "../../components/ui/primitives";
import { EmptyState, ErrorState, formatDateTime, useResource } from "../../ui";
import { capabilityGate } from "../../capabilities-state";
import { canCreateProject } from "../../operations";
import { humanErrorMessage, useSlowLoading } from "../batch-generate-drawer";
import type { PageRuntimeProps } from "../global-pages";
import { TrashPage } from "../operations-pages";
import { liteProjectPath } from "./lite-shell";
import { LiteProjectDialog } from "./lite-project-dialog";

/** config 不在 LiteNavKey 六项流水线内，壳导航用不上；卡片区入口共用这一个拼法。 */
function liteProjectConfigPath(projectId: string): string {
  return `/lite/projects/${encodeURIComponent(projectId)}/config`;
}

/** demo 值：让两种徽记（轻量版/未初始化）在离线演示里都可见，不改共享 fixture。 */
const DEMO_LITE_PROJECTS: Project[] = demoProjects.map((project, index) =>
  index === 0 ? { ...project, lite_episode_id: "demo-lite-episode" } : project,
);

/** 项目弹窗状态：null=关；new=新建；edit=编辑指定项目。 */
type DialogState = null | { mode: "new" } | { mode: "edit"; project: Project };

export function LiteProjectsPage({ demoMode, notify, user, capabilities, onLogout }: PageRuntimeProps): React.JSX.Element {
  const allowCreate = capabilityGate(capabilities, canCreateProject) === "allowed";
  const { data, loading, error, retry, setData } = useResource(
    () => api.projects(),
    { items: DEMO_LITE_PROJECTS, count: DEMO_LITE_PROJECTS.length },
    demoMode,
    [],
  );
  const slowLoading = useSlowLoading(loading);
  const projects = data?.items ?? [];
  const [dialog, setDialog] = useState<DialogState>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashKind, setTrashKind] = useState<"" | "project" | "asset">("");

  function handleCreated(project: Project): void {
    setData((current) => ({ items: [project, ...(current?.items ?? [])], count: (current?.count ?? 0) + 1 }));
  }
  function handleProjectSaved(projectId: string, patch: { name: string; description: string }): void {
    setData((current) => current
      ? { ...current, items: current.items.map((project) => project.id === projectId ? { ...project, name: patch.name, description: patch.description } : project) }
      : current);
  }
  function handleDeleted(projectId: string): void {
    setData((current) => current
      ? { items: current.items.filter((project) => project.id !== projectId), count: Math.max(0, current.count - 1) }
      : current);
  }

  if (trashOpen) {
    return (
      <div className="mx-auto flex w-full max-w-[1440px] 2xl:max-w-[1920px] min-h-0 flex-1 flex-col overflow-y-auto">
        <TrashPage
          demoMode={demoMode}
          notify={notify}
          user={user}
          capabilities={capabilities}
          onLogout={onLogout}
          kind={trashKind || undefined}
          onKindChange={setTrashKind}
          onBack={() => setTrashOpen(false)}
        />
      </div>
    );
  }

  return (
    <section className="mx-auto flex w-full max-w-[1440px] 2xl:max-w-[1920px] flex-1 min-h-0 flex-col gap-5 overflow-y-auto">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-ink-1 text-page-title">我的项目</h1>
          <p className="text-sm text-ink-2">这里是分配给你的全部项目。点卡片进入项目的「制作」页，贴入剧本即可一键生成分镜。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" icon={<Trash />} onClick={() => setTrashOpen(true)}>回收站</Button>
          {allowCreate ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setDialog({ mode: "new" })}>新建项目</Button>
          ) : null}
        </div>
      </header>
      {loading ? (
        <div className="flex flex-col items-start gap-4" aria-busy="true" aria-label="正在读取项目">
          <div className="grid w-full grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4" aria-hidden="true">
            {["sk-a", "sk-b", "sk-c", "sk-d", "sk-e", "sk-f", "sk-g", "sk-h"].map((key) => <Skeleton className="h-44" key={key} />)}
          </div>
          <p className="text-sm text-ink-2" role="status">正在读取项目…</p>
          {slowLoading ? <Button icon={<ArrowClockwise />} onClick={retry}>仍在加载 · 重试</Button> : null}
        </div>
      ) : error ? (
        <ErrorState message={humanErrorMessage(error, "项目列表读取失败，请重试")} onRetry={retry} />
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderOpen />}
          title={allowCreate ? "还没有项目" : "还没有分配给你的项目"}
          description={allowCreate
            ? "建一个项目开始吧：输入剧名就能进入制作页，贴入剧本一键生成分镜。"
            : "这里列出的是分配给你的 Lite 项目；列表为空，是因为管理员还没有在完整版里创建并分配项目给你。下一步：联系统筹或管理员开通后再来。"}
          action={allowCreate ? <Button icon={<Plus />} onClick={() => setDialog({ mode: "new" })}>新建项目</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {projects.map((project) => (
            <article
              key={project.id}
              className="group relative flex min-h-44 flex-col gap-2 rounded-lg border border-border-1 bg-surface-1 p-4 transition-all duration-150 ease-out-quart hover:-translate-y-0.5 hover:border-border-2 focus-within:border-accent"
            >
              {/* 整卡可点（覆盖层按钮），进剧本页——流水线第一步 */}
              <button
                type="button"
                className="absolute inset-0 z-10 cursor-pointer rounded-lg"
                aria-label={`打开项目「${project.name}」`}
                onClick={() => navigate(liteProjectPath(project.id, "workspace"))}
              />
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-ink-1 text-section-title">{project.name}</h2>
                {project.lite_episode_id ? (
                  <Badge tone="accent" className="shrink-0">轻量版</Badge>
                ) : (
                  <Badge tone="neutral" className="shrink-0" title="还没提交过剧本：在剧本页贴入剧本并确认解析后，项目即完成 Lite 初始化">未初始化</Badge>
                )}
              </div>
              {project.description?.trim() ? <p className="line-clamp-2 text-sm text-ink-2">{project.description}</p> : null}
              <div className="flex flex-wrap items-center gap-1.5">
                {project.genre ? <Badge tone="neutral" className="shrink-0">{project.genre}</Badge> : null}
                <span className="text-xs text-ink-3">
                  {project.episode_count != null ? `${project.episode_count} 集` : ""}
                  {project.shot_count != null ? ` · ${project.shot_count} 分镜` : ""}
                  {project.asset_count != null ? ` · ${project.asset_count} 素材` : ""}
                </span>
              </div>
              <footer className="mt-auto flex items-center justify-between gap-2 pt-2">
                <span className="text-xs text-ink-4">
                  {project.created_at ? `创建于 ${formatDateTime(project.created_at)}` : ""}
                </span>
                <div className="relative z-20 flex items-center gap-1">
                  <Button variant="ghost" size="sm" icon={<PencilSimple />} onClick={() => setDialog({ mode: "edit", project })}>编辑</Button>
                  <Button variant="outline" size="sm" icon={<GearSix />} onClick={() => navigate(liteProjectConfigPath(project.id))}>配置</Button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}
      {dialog ? (
        <LiteProjectDialog
          mode={dialog.mode}
          project={dialog.mode === "edit" ? dialog.project : undefined}
          demoMode={demoMode}
          notify={notify}
          currentUserId={user.id}
          onClose={() => setDialog(null)}
          onCreated={handleCreated}
          onSaved={handleProjectSaved}
          onDeleted={handleDeleted}
        />
      ) : null}
    </section>
  );
}
