/**
 * 3D 导演台 · 工作台顶层组件（features/director 的顶层导出）
 *
 * props：{ projectId?: string | null }——显式传入，禁止自动选择项目；
 * 无 projectId 显示空态（不挂载 3D 编辑区，不读写任何项目数据）。
 *
 * 数据流：
 * - 挂载 / projectId 变化：GET scene 装载已存版本（404 无已存版本 → 空台）；
 *   快照里 ephemeral 标记的本地临时对象跳过并横幅提示。
 * - 保存：PUT scene（带 sceneVersion 乐观锁与 sourceAction 留痕）；
 *   409 冲突 → 顶部横幅提示「刷新/加载最新」，用户确认后 reload。
 * - 导出归组（P0 衔接流）：TopBar 导出菜单「保存并归组」→ 渲染 PNG → POST captures
 *   入资产库（端点同事务自动挂当前项目）→ onExported 归参考清单对应组。
 * - 模版：GET templates 列表，「应用」POST apply 后把 objects/cameras 合入当前场景，
 *   sourceAction 记 template:apply:<id> 供保存留痕。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { listDirectorTemplates, applyDirectorTemplate } from "./api";
import type { DirectorTemplateSummary } from "./api";
import { DirectorShell } from "./DirectorShell";
import { isDirectorDemoMode } from "./assets-library";
import { loadDirectorScene, saveDirectorSceneState } from "./persistence";
import { clearDirectorCommandHistory } from "./commands";
import { mergeTemplateScene, parseTemplateApplyScene } from "./templates";
import { useDirectorStore } from "./store";
import { DirectorWorkspaceProvider } from "./workspace-context";
import type { DirectorWorkspaceApi } from "./workspace-context";

import "./director.css";
import "./workspace.css";

type Phase = "loading" | "ready" | "error";

export interface DirectorWorkspaceProps {
  /** 项目 id（显式传入；空值显示空态，绝不自动选择项目） */
  projectId?: string | null;
  /** 宿主应用的全局 toast 通道（Fable 外壳 notify）；缺省用工作台内联 toast */
  notify?: (message: string, kind?: "info" | "success" | "error") => void;
  /** 导出完成回调（工作台页签挂法：把机位图/宫格/深度图/运镜小样归入参考清单对应组） */
  onExported?: (event: {
    kind: "shot" | "grid" | "capture" | "depth" | "motion";
    label: string;
    assetId?: string;
    thumbUrl?: string;
  }) => void;
}

/**
 * 工作台高度自校准：Fable 外壳的高度链是 min-height 驱动的 flex（无确定高度祖先），
 * 纯 CSS 的 height:100% 会退化为内容撑高（实测画布被右栏内容撑到 2277px 溢出视口）。
 * 这里直接量 workspace 的视口 top 偏移，把高度钉在「视口剩余高度」上：
 * 3D 视口按画布尺寸渲染，左右栏内部滚动。body 尺寸变化（离线横幅挂载等）与
 * 窗口 resize 都会触发重算。
 */
function useViewportPinnedHeight(hostRef: React.RefObject<HTMLDivElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const update = () => {
      const top = element.getBoundingClientRect().top;
      setHeight(Math.max(360, Math.round(window.innerHeight - top - 8)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [hostRef]);
  return height;
}

export function DirectorWorkspace({ projectId, notify: hostNotify, onExported }: DirectorWorkspaceProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);
  const [sceneVersion, setSceneVersion] = useState(0);
  const [sourceAction, setSourceAction] = useState("manual_save");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ currentVersion: number | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [templates, setTemplates] = useState<DirectorTemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const pinnedHeight = useViewportPinnedHeight(hostRef);
  const hostStyle = pinnedHeight ? { height: `${pinnedHeight}px` } : undefined;

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // toast 通道：宿主应用给了全局 notify（Fable 外壳 bottom-center toast）就走它，
  // 否则用工作台内联 toast（右上角，scratch/独立挂载场景）
  const notify = useCallback(
    (message: string) => {
      if (hostNotify) {
        hostNotify(message, "info");
        return;
      }
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast(message);
      toastTimer.current = setTimeout(() => setToast(null), 3200);
    },
    [hostNotify],
  );
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  /* ── 场景装载（GET scene；404 → 空台） ── */
  const load = useCallback(
    async (targetProjectId: string) => {
      setPhase("loading");
      setLoadError(null);
      setConflict(null);
      setNotice(null);
      clearDirectorCommandHistory();
      // 离线演示：跳过服务端装载，直接进空台（演示模式无后端，401 不应挡人）。
      const result = isDirectorDemoMode()
        ? ({ kind: "seed" } as const)
        : await loadDirectorScene(targetProjectId);
      if (result.kind === "seed") {
        useDirectorStore.getState().resetToSeed();
        setSceneId(null);
        setSceneVersion(0);
        setPhase("ready");
        return;
      }
      if (result.kind === "error") {
        setLoadError(result.message);
        setPhase("error");
        return;
      }
      useDirectorStore.getState().replaceSceneState(result.slice);
      setSceneId(result.sceneId);
      setSceneVersion(result.sceneVersion);
      const skipped = [...result.skippedEphemeral, ...result.skippedUnknown];
      if (skipped.length > 0) {
        setNotice(
          `${skipped.length} 个本地临时对象未随场景恢复（保存场景后不保留 blob 资源）：${skipped.join("、")}`,
        );
      }
      setPhase("ready");
    },
    [],
  );

  useEffect(() => {
    if (!projectId) return;
    // React 18 对卸载后的 setState 静默忽略，无需手动 cancel 守卫
    void load(projectId);
  }, [projectId, load]);

  /* ── 模版清单（GET templates；失败不阻塞编辑） ── */
  useEffect(() => {
    if (!projectId) return;
    // 离线演示无服务端：不拉模版清单（否则 401 刷 console），模版菜单显示空态
    if (isDirectorDemoMode()) {
      setTemplates([]);
      setTemplatesError(null);
      return;
    }
    let cancelled = false;
    setTemplates(null);
    setTemplatesError(null);
    void listDirectorTemplates()
      .then((items) => {
        if (!cancelled) setTemplates(items);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setTemplates([]);
          setTemplatesError(error instanceof Error ? error.message : "模版清单加载失败");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /* ── 保存（PUT，乐观锁；409 → 冲突横幅） ── */
  const save = useCallback(async () => {
    if (!projectId || saving) return;
    if (isDirectorDemoMode()) {
      notify("离线演示不保存场景（刷新后还原为空台）");
      return;
    }
    setSaving(true);
    setConflict(null);
    const result = await saveDirectorSceneState(projectId, { sceneVersion, sourceAction });
    setSaving(false);
    if (result.kind === "saved") {
      setSceneId(result.sceneId);
      setSceneVersion(result.sceneVersion);
      setSourceAction("manual_save");
      notify(`已保存场景 · 版本 v${result.sceneVersion}`);
      return;
    }
    if (result.kind === "conflict") {
      setConflict({ currentVersion: result.currentVersion });
      return;
    }
    notify(`保存失败：${result.message}`);
  }, [projectId, saving, sceneVersion, sourceAction, notify]);

  const reload = useCallback(async () => {
    if (projectId) await load(projectId);
  }, [projectId, load]);

  const dismissConflict = useCallback(() => setConflict(null), []);

  /* ── 模版应用（POST apply → 合入 objects/cameras，留痕 sourceAction） ── */
  const applyTemplate = useCallback(
    async (templateId: string) => {
      if (!projectId || applyingTemplateId) return;
      setApplyingTemplateId(templateId);
      try {
        const raw = await applyDirectorTemplate(templateId, {});
        const scene = parseTemplateApplyScene(raw);
        const merged = mergeTemplateScene(scene);
        setSourceAction(merged.sourceAction);
        notify(
          `已应用模版「${merged.templateName}」：+${merged.addedObjectIds.length} 角色 / +${merged.addedCameraIds.length} 机位（保存后留痕 ${merged.sourceAction}）`,
        );
      } catch (error) {
        notify(`应用模版失败：${error instanceof Error ? error.message : "请稍后重试"}`);
      } finally {
        setApplyingTemplateId(null);
      }
    },
    [projectId, applyingTemplateId, notify],
  );

  /* ── 空态：无 projectId，绝不自动选择项目 ── */
  if (!projectId) {
    return (
      <div ref={hostRef} className="director-workspace director-workspace--empty" style={hostStyle}>
        <div className="director-workspace__empty">
          <h2>3D 导演台</h2>
          <p>尚未选择项目。请从项目页打开导演台（/projects/:projectId/director），导演台不会自动选择项目。</p>
        </div>
      </div>
    );
  }

  if (phase === "loading") {
    return (
      <div ref={hostRef} className="director-workspace director-workspace--empty" style={hostStyle}>
        <div className="director-workspace__empty">
          <p>正在装载导演台场景…</p>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div ref={hostRef} className="director-workspace director-workspace--empty" style={hostStyle}>
        <div className="director-workspace__empty">
          <h2>场景装载失败</h2>
          <p>{loadError}</p>
          <button type="button" className="director-workspace__retry" onClick={() => void reload()}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const workspace: DirectorWorkspaceApi = {
    projectId,
    sceneId,
    sceneVersion,
    sourceAction,
    saving,
    conflict,
    templates,
    templatesError,
    applyingTemplateId,
    save,
    reload,
    dismissConflict,
    applyTemplate,
    notify,
    onExported,
  };

  return (
    <DirectorWorkspaceProvider value={workspace}>
      <div ref={hostRef} className="director-workspace" style={hostStyle}>
        <DirectorShell />

        {conflict ? (
          <div className="director-workspace__conflict" role="alert">
            <span>
              场景已被其他人更新
              {conflict.currentVersion !== null ? `（当前 v${conflict.currentVersion}）` : ""}
              ，请加载最新版本后再保存。
            </span>
            <button type="button" onClick={() => void reload()}>
              加载最新版本
            </button>
            <button type="button" onClick={dismissConflict}>
              继续编辑
            </button>
          </div>
        ) : null}

        {notice ? (
          <div className="director-workspace__notice" role="status">
            <span>{notice}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        ) : null}

        {!hostNotify && toast ? (
          <div className="director-workspace__toast" role="status">
            {toast}
          </div>
        ) : null}
      </div>
    </DirectorWorkspaceProvider>
  );
}
