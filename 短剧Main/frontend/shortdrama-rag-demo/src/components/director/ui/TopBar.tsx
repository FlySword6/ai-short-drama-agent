/**
 * 3D 导演台 · 顶栏（V0.1.1 Vite 移植版）
 *
 * 左：「3D 导演台」标题（旧仓「← 资产库」<a href> 硬跳已按移植约定移除，
 *     返回导航由应用外壳/路由收口）；
 * 中：视角 segmented（导演视角/机位视角）+ 机位下拉（选中即设为活动机位并切机位视角）
 *     +「＋」新增机位；
 * 右：环境分组菜单（ENV_PRESET_MENU 十档，室内/室外/风格化三组两列网格，当前档高亮）、
 *    画幅比例选择器（LibTV §7.2 弹层，7 档
 *    4+3 网格：Auto/21:9/16:9/4:3/1:1/3:4/9:16，当前档高亮）、gizmo 模式（平移/旋转/缩放，
 *    字母标 G/R/S 与 StageCanvas 热键契约一致）、「?」快捷键帮助浮层（DIRECTOR_SHORTCUTS）、
 *    「＋ 添加对象」菜单（对齐 LibTV SPEC §7.1：本地上传 / 人体素体 8 行（BODY_TYPES
 *    全量，各带体型入场）/ 群众阵列 / 几何模型▸六种）、
 *    「模版」菜单（GET templates 清单按 category 中文分组，点「应用」POST apply 合入场景，保存留痕）、
 *    「保存场景」按钮（PUT 乐观锁；仅在 DirectorWorkspace 上下文内显示）、
 *    「导出」菜单（P0 衔接流：静态三类主按钮=保存并归组——渲染 PNG 入资产库
 *    （captures 端点同事务自动挂当前项目）+ 经 onExported 归参考清单对应组；
 *    运镜小样录 WebM 归「运镜」组并下载（captures 仅收 PNG，视频暂不入资产库）；
 *    「下载到本地」降为次要小字项；保存结果用顶栏内联 toast 反馈，busy 期间防重复点击）。
 *
 * 菜单点击外部或 Escape 关闭；新对象落位移植原型 findFreeSpot（黄金角螺旋找空位）。
 */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";

import { useDirectorStore } from "../store";
import { useDirectorWorkspace } from "../workspace-context";
import { BODY_TYPES, isCameraObject } from "../types";
import type {
  AspectRatio,
  BodyTypeId,
  CameraObject,
  GeometryShape,
  GizmoMode,
  ObjectKind,
  SceneObject,
  Vec3,
} from "../types";
import { downloadBlob, exportCameraShot, timestamp } from "../export/captureShot";
import { exportCameraGrid } from "../export/exportGrid";
import { renderStaticExport, saveBlobToLibrary } from "../export/saveCapture";
import type { StaticExportKind } from "../export/saveCapture";
import { exportDepthMap } from "../export/depthMap";
import { ENV_PRESET_LABELS, ENV_PRESET_MENU } from "../env-presets";
import { isDirectorDemoMode } from "../assets-library";
import { DIRECTOR_SHORTCUTS, groupTemplatesByCategory } from "./topbar-helpers";
import { MOTION_DURATIONS, MOTION_PRESETS } from "../export/cameraMotions";
import type { MotionPresetId } from "../export/cameraMotions";
import { startCameraMotionRun } from "../export/recordMotion";
import type { MotionRunHandle } from "../export/recordMotion";

import "./TopBar.css";

/* ──────────────────────────── 常量 ──────────────────────────── */

/** 新增素模的轮换配色：移植原型 FIGURE_COLORS（统一大写 hex 约定） */
const MANNEQUIN_COLORS = [
  "#9AA0A8",
  "#6B9BD8",
  "#D88AA0",
  "#C96A5E",
  "#7FB98A",
  "#D8B96A",
  "#9A86D8",
  "#6AC6C6",
];

/**
 * 基础几何子菜单（顺序按任务书：立方体·球体·圆柱·圆锥·圆环·平面）。
 * size 语义按 types.ts：box=[宽,高,深]、sphere 以 x 为直径、cylinder/cone=[直径,高,直径]、
 * torus=[外径,管径,-]、plane=[宽,-,深]（未用槽位给参考值，具体映射归 GeometryNode）。
 */
const GEOMETRY_MENU: { shape: GeometryShape; label: string; size: Vec3 }[] = [
  { shape: "box", label: "立方体", size: [0.6, 0.6, 0.6] },
  { shape: "sphere", label: "球体", size: [0.7, 0.7, 0.7] },
  { shape: "cylinder", label: "圆柱体", size: [0.6, 0.8, 0.6] },
  { shape: "cone", label: "圆锥体", size: [0.7, 0.8, 0.7] },
  { shape: "torus", label: "圆环", size: [0.7, 0.24, 0.7] },
  { shape: "plane", label: "平面", size: [2, 0.02, 2] },
];

/** gizmo 档位字母标：与 StageCanvas 热键契约一致（G 平移 / R 旋转 / S 缩放） */
const GIZMO_MODES: { mode: GizmoMode; label: string; hotkey: string }[] = [
  { mode: "translate", label: "平移", hotkey: "G" },
  { mode: "rotate", label: "旋转", hotkey: "R" },
  { mode: "scale", label: "缩放", hotkey: "S" },
];

/**
 * 画幅比例选择器档位（LibTV §7.2：4+3 两行网格，图标+文字）。
 * icon = 档位画幅框的宽高（px，仅作形状示意；auto 用虚线框区分）。
 */
const ASPECT_OPTIONS: { value: AspectRatio; label: string; icon: [number, number] }[] = [
  { value: "auto", label: "Auto", icon: [18, 14] },
  { value: "21:9", label: "21:9", icon: [22, 10] },
  { value: "16:9", label: "16:9", icon: [22, 13] },
  { value: "4:3", label: "4:3", icon: [20, 15] },
  { value: "1:1", label: "1:1", icon: [15, 15] },
  { value: "3:4", label: "3:4", icon: [13, 17] },
  { value: "9:16", label: "9:16", icon: [11, 19] },
];

/* 环境预置清单：数据唯一来源在 ../env-presets（ENV_PRESET_MENU，S8-7 十档三组） */

/* ──────────────────────────── 图标（移植原型内联 SVG） ──────────────────────────── */

const svgProps = {
  viewBox: "0 0 24 24",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
} as const;

const ICON_FIGURE: ReactNode = (
  <svg {...svgProps}>
    <circle cx="12" cy="7" r="3.2" />
    <path d="M5 20c0-3.9 3.1-6.5 7-6.5s7 2.6 7 6.5" />
  </svg>
);

const ICON_GEOMETRY: ReactNode = (
  <svg {...svgProps}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
    <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
  </svg>
);

const ICON_CROWD: ReactNode = (
  <svg {...svgProps}>
    <circle cx="7" cy="8" r="2.2" />
    <circle cx="16.5" cy="8" r="2.2" />
    <path d="M3 19c0-3 1.9-5 4-5s4 2 4 5M12.5 19c0-3 1.9-5 4-5s4 2 4 5" />
  </svg>
);

const ICON_UPLOAD: ReactNode = (
  <svg {...svgProps}>
    <path d="M12 16V4m0 0L7 9m5-5l5 5" />
    <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
  </svg>
);

const ICON_SHOT: ReactNode = (
  <svg {...svgProps}>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <circle cx="12" cy="12.5" r="3.5" />
  </svg>
);

const ICON_GRID: ReactNode = (
  <svg {...svgProps}>
    <rect x="3" y="3" width="8" height="8" rx="1.5" />
    <rect x="13" y="3" width="8" height="8" rx="1.5" />
    <rect x="3" y="13" width="8" height="8" rx="1.5" />
    <rect x="13" y="13" width="8" height="8" rx="1.5" />
  </svg>
);

const ICON_DEPTH: ReactNode = (
  <svg {...svgProps}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
    <path d="M3 17.5l9 5 9-5" opacity="0.5" />
  </svg>
);

const ICON_MOTION: ReactNode = (
  <svg {...svgProps}>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M10 9.5l5 3-5 3v-6z" fill="currentColor" stroke="none" />
  </svg>
);

/** 静态导出三类（「保存并归组」主按钮与「下载到本地」次要项共用同一份清单） */
const STATIC_EXPORT_MENU: { kind: StaticExportKind; label: string; downloadLabel: string }[] = [
  { kind: "shot", label: "当前机位截图", downloadLabel: "截图 PNG" },
  { kind: "grid", label: "分镜宫格", downloadLabel: "宫格 PNG" },
  { kind: "depth", label: "深度图（空间关系）", downloadLabel: "深度图 PNG" },
];

const STATIC_EXPORT_ICONS: Record<StaticExportKind, ReactNode> = {
  shot: ICON_SHOT,
  grid: ICON_GRID,
  depth: ICON_DEPTH,
};

/* ──────────────────────────── 落位工具 ──────────────────────────── */

/**
 * 绕原点螺旋找空位（移植原型 findFreeSpot）：黄金角步进、半径渐扩，
 * 避开 1.2m 内的既有非机位对象，边界 ±9m；找不到回退原点。
 */
function findFreeSpot(objects: SceneObject[], radius = 2.2): [number, number] {
  const solids = objects.filter((object) => object.type !== "camera");
  for (let i = 0; i < 24; i++) {
    const angle = i * 2.399963;
    const x = Math.cos(angle) * radius * (1 + i * 0.12);
    const z = Math.sin(angle) * radius * (1 + i * 0.12);
    const clash = solids.some(
      (object) => Math.hypot(object.transform.position[0] - x, object.transform.position[2] - z) < 1.2,
    );
    if (!clash && Math.abs(x) < 9 && Math.abs(z) < 9) return [x, z];
  }
  return [0, 0];
}

/* ──────────────────────────── 顶栏主体 ──────────────────────────── */

type MenuId = "add" | "export" | "motion" | "aspect" | "templates" | "env" | "help";

export function TopBar() {
  const objects = useDirectorStore((state) => state.objects);
  const order = useDirectorStore((state) => state.order);
  const selectedId = useDirectorStore((state) => state.selectedId);
  const viewMode = useDirectorStore((state) => state.viewMode);
  const activeCameraId = useDirectorStore((state) => state.activeCameraId);
  const aspect = useDirectorStore((state) => state.aspect);
  const environment = useDirectorStore((state) => state.environment);
  const gizmoMode = useDirectorStore((state) => state.gizmoMode);
  const addObject = useDirectorStore((state) => state.addObject);
  const addCamera = useDirectorStore((state) => state.addCamera);
  const select = useDirectorStore((state) => state.select);
  const setViewMode = useDirectorStore((state) => state.setViewMode);
  const setActiveCamera = useDirectorStore((state) => state.setActiveCamera);
  const setAspect = useDirectorStore((state) => state.setAspect);
  const setEnvironment = useDirectorStore((state) => state.setEnvironment);
  const setGizmoMode = useDirectorStore((state) => state.setGizmoMode);

  // 工作台上下文（保存场景/模版/截图入资产接线）；纯 DirectorShell 演示时为 null，相关按钮隐藏
  const workspace = useDirectorWorkspace();

  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 运镜小样：预设/时长选择与运行态（运行中锁导出入口；取消走 handle.cancel）
  const [motionPreset, setMotionPreset] = useState<MotionPresetId>("dolly-in");
  const [motionDuration, setMotionDuration] = useState<number>(3);
  const [motionRunning, setMotionRunning] = useState<"preview" | "record" | null>(null);
  const motionRunRef = useRef<MotionRunHandle | null>(null);

  // 「保存并归组」busy + 结果反馈：工作台内走 workspace.notify（全局 toast 通道），
  // 独立挂载时回落顶栏内联 toast（轻量本地 state）
  const [savingExport, setSavingExport] = useState(false);
  const [captureToast, setCaptureToast] = useState<string | null>(null);
  const captureToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showCaptureToast = (message: string) => {
    if (workspace) {
      workspace.notify(message);
      return;
    }
    if (captureToastTimer.current) clearTimeout(captureToastTimer.current);
    setCaptureToast(message);
    captureToastTimer.current = setTimeout(() => setCaptureToast(null), 3200);
  };

  useEffect(() => {
    return () => {
      if (captureToastTimer.current) clearTimeout(captureToastTimer.current);
    };
  }, []);

  // 菜单：点击顶栏菜单容器之外或按 Escape 关闭
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(".ds-tb__menu-anchor")) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const objectList: SceneObject[] = [];
  const cameraList: CameraObject[] = [];
  for (const id of order) {
    const object = objects[id];
    if (!object) continue;
    objectList.push(object);
    if (isCameraObject(object)) cameraList.push(object);
  }
  const countOf = (type: ObjectKind) => objectList.filter((object) => object.type === type).length;

  /** 跟随预设的目标：当前选中的非机位对象（无则跟随预设禁用） */
  const selectedObject = selectedId ? objects[selectedId] : undefined;
  const followTarget = selectedObject && !isCameraObject(selectedObject) ? selectedObject : undefined;

  /** 模版按 category 中文分组（常用组置顶，未知归「其他」；P1-8） */
  const templateGroups = groupTemplatesByCategory(workspace?.templates ?? []);

  /* ── 添加对象 ── */

  const addMannequin = (bodyType: BodyTypeId) => {
    setOpenMenu(null);
    const [x, z] = findFreeSpot(objectList);
    const seq = countOf("mannequin");
    const id = addObject({
      name: `角色 ${seq + 1}`,
      type: "mannequin",
      visible: true,
      transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] },
      color: MANNEQUIN_COLORS[seq % MANNEQUIN_COLORS.length] ?? "#9AA0A8",
      bodyType,
      pose: "stand",
      joints: {},
    });
    select(id);
  };

  const addGeometry = (shape: GeometryShape, label: string, size: Vec3) => {
    const [x, z] = findFreeSpot(objectList, 2.6);
    const id = addObject({
      name: `${label} ${countOf("geometry") + 1}`,
      type: "geometry",
      visible: true,
      transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] },
      shape,
      color: "#9AA0A8",
      size: [...size],
    });
    select(id);
  };

  const addCrowd = () => {
    setOpenMenu(null);
    const [x, z] = findFreeSpot(objectList, 3.4);
    const id = addObject({
      name: `群众阵列 ${countOf("crowd") + 1}`,
      type: "crowd",
      visible: true,
      transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] },
      rows: 3,
      cols: 4,
      spacing: 1.1,
      color: "#6AC6C6",
    });
    select(id);
  };

  const handleModelFile = (file: File) => {
    const [x, z] = findFreeSpot(objectList);
    const id = addObject({
      name: file.name.replace(/\.(glb|gltf)$/i, "") || "自定义模型",
      type: "model",
      visible: true,
      transform: { position: [x, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] },
      assetUrl: URL.createObjectURL(file),
      fileName: file.name,
    });
    select(id);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) handleModelFile(file);
    event.target.value = "";
  };

  /* ── 机位 / 导出 ── */

  const handleAddCamera = () => {
    const id = addCamera();
    setActiveCamera(id);
    select(id);
  };

  /** 静态导出的归组标签（参考清单条目名；活动机位缺省取第一台） */
  const staticExportLabel = (kind: StaticExportKind): string => {
    const camera = cameraList.find((item) => item.id === activeCameraId) ?? cameraList[0];
    if (kind === "grid") return `机位宫格（${cameraList.length} 个机位）`;
    if (kind === "depth") return `机位「${camera?.name ?? "未命名"}」深度图`;
    return `机位「${camera?.name ?? "未命名"}」截图`;
  };

  /** 静态导出主按钮的说明行：归组目标随宿主路径（工作台内嵌=归参考清单；独立路由=仅入资产库） */
  const staticExportHint = (kind: StaticExportKind): string => {
    if (!workspace) return "下载 PNG 到本地";
    if (!workspace.onExported) return "存入资产库，项目里可引入";
    return kind === "depth" ? "存资产库并归「运镜」组" : "存资产库并归「场景」组";
  };

  /** 下载到本地（次要路径）：原 Wave 2 下载行为，不入资产库、不归组 */
  const runDownload = (kind: StaticExportKind) => {
    setOpenMenu(null);
    const task = kind === "shot" ? exportCameraShot() : kind === "grid" ? exportCameraGrid() : exportDepthMap();
    void task.catch((error: unknown) => console.error("[导演台] 下载失败", error));
  };

  /**
   * 保存并归组（P0 衔接流主路径，一步）：渲染 PNG → POST captures 入资产库
   * （端点同事务自动挂当前项目）→ onExported 归参考清单对应组（shot/grid→「场景」，
   * depth→「运镜」）。独立路由（无 onExported 宿主）只入资产库并提示「可在项目里引入」；
   * demo 模式不 POST（写操作走降级 toast），产物仍归本机参考清单（原型口径）；
   * 纯 DirectorShell 演示（无项目上下文）没有项目可入，退回本地下载。
   */
  const runSaveAndGroup = (kind: StaticExportKind) => {
    setOpenMenu(null);
    if (savingExport) return;
    if (!workspace) {
      runDownload(kind);
      return;
    }
    setSavingExport(true);
    void (async () => {
      const rendered = await renderStaticExport(kind);
      if (!rendered) {
        showCaptureToast("渲染运行时未就绪或机位无效");
        return;
      }
      const label = staticExportLabel(kind);
      if (isDirectorDemoMode()) {
        workspace.onExported?.({ kind, label, thumbUrl: rendered.thumbUrl ?? undefined });
        showCaptureToast("离线演示不写入资产库，已在本机归入参考清单");
        return;
      }
      const saved = await saveBlobToLibrary(workspace.projectId, rendered.blob, rendered.title);
      if (!saved.ok) {
        showCaptureToast(saved.error);
        return;
      }
      workspace.onExported?.({
        kind,
        label,
        assetId: saved.assetId,
        thumbUrl: saved.previewUrl || rendered.thumbUrl || undefined,
      });
      // 无宿主归组回调（独立导演台路由）：成功 toast 明示后续引入路径
      if (!workspace.onExported) {
        showCaptureToast("已入资产库，可在项目里引入");
      }
    })()
      .catch((error: unknown) => {
        console.error("[导演台] 保存并归组失败", error);
        showCaptureToast("保存失败，请稍后重试");
      })
      .finally(() => setSavingExport(false));
  };

  /** 运镜小样：预览在视口播放机位运动；录制 WebM 归参考清单「运镜」组并下载（视频暂不入资产库） */
  const runMotion = (mode: "preview" | "record") => {
    setOpenMenu(null);
    if (motionRunning) return;
    const preset = MOTION_PRESETS.find((item) => item.id === motionPreset);
    if (!preset) return;
    if (preset.needsFollowTarget && !followTarget) {
      showCaptureToast("跟随需要先选中一个对象");
      return;
    }
    const handle = startCameraMotionRun({
      presetId: motionPreset,
      durationSec: motionDuration,
      record: mode === "record",
      followObjectId: preset.needsFollowTarget ? selectedId : undefined,
    });
    motionRunRef.current = handle;
    setMotionRunning(mode);
    void handle.done.then((result) => {
      motionRunRef.current = null;
      setMotionRunning(null);
      if (result.status === "cancelled") return;
      if (result.status === "error") {
        showCaptureToast(result.error);
        return;
      }
      if (mode === "record" && result.blob) {
        const { meta } = result;
        downloadBlob(
          result.blob,
          `导演台-${meta.cameraName}-运镜${meta.presetLabel}-${meta.durationSec}s-${timestamp()}.webm`,
        );
        workspace?.onExported?.({
          kind: "motion",
          label: `运镜小样 · ${meta.presetLabel} ${meta.durationSec}秒（机位「${meta.cameraName}」）`,
          thumbUrl: result.thumbUrl ?? undefined,
        });
      }
    });
  };

  /* ── 渲染 ── */

  return (
    <header className="ds-topbar ds-tb">
      <div className="ds-tb__left">
        <h1 className="ds-tb__title">3D 导演台</h1>
      </div>

      <div className="ds-tb__center">
        <div className="ds-tb__seg">
          <button
            type="button"
            className={viewMode === "director" ? "ds-tb__seg-btn ds-tb__seg-btn--on" : "ds-tb__seg-btn"}
            onClick={() => setViewMode("director")}
          >
            导演视角
          </button>
          <button
            type="button"
            className={viewMode === "camera" ? "ds-tb__seg-btn ds-tb__seg-btn--on" : "ds-tb__seg-btn"}
            onClick={() => setViewMode("camera")}
          >
            机位视角
          </button>
        </div>
        <div className="ds-tb__select-wrap ds-tb__cam-select" title="活动机位">
          <select
            value={activeCameraId ?? ""}
            disabled={cameraList.length === 0}
            onChange={(event) => {
              setActiveCamera(event.target.value);
              setViewMode("camera");
            }}
          >
            {cameraList.length === 0 ? (
              <option value="">无机位</option>
            ) : (
              cameraList.map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {camera.name}
                </option>
              ))
            )}
          </select>
        </div>
        <button type="button" className="ds-tb__btn ds-tb__btn--icon" title="新增机位" onClick={handleAddCamera}>
          ＋
        </button>
      </div>

      <div className="ds-tb__right">
        <div className="ds-tb__menu-anchor" title="环境光照">
          <button
            type="button"
            className="ds-tb__btn"
            onClick={() => setOpenMenu(openMenu === "env" ? null : "env")}
          >
            {ENV_PRESET_LABELS[environment]} ▾
          </button>
          {openMenu === "env" ? (
            <div className="ds-tb-menu ds-tb-env" role="menu">
              {ENV_PRESET_MENU.map((group) => (
                <div key={group.key}>
                  <div className="ds-tb-menu__group">{group.label}</div>
                  <div className="ds-tb-env__grid">
                    {group.items.map((item) => (
                      <button
                        key={item.value}
                        type="button"
                        className={
                          environment === item.value
                            ? "ds-tb-env__cell ds-tb-env__cell--on"
                            : "ds-tb-env__cell"
                        }
                        aria-pressed={environment === item.value}
                        onClick={() => {
                          setEnvironment(item.value);
                          setOpenMenu(null);
                        }}
                      >
                        {item.label}
                        {environment === item.value ? <span className="ds-tb-env__check">✓</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="ds-tb__menu-anchor" title="画幅比例">
          <button
            type="button"
            className="ds-tb__btn"
            onClick={() => setOpenMenu(openMenu === "aspect" ? null : "aspect")}
          >
            画幅 {aspect === "auto" ? "Auto" : aspect} ▾
          </button>
          {openMenu === "aspect" ? (
            <div className="ds-tb-menu ds-tb-ratio" role="menu">
              <div className="ds-tb-ratio__title">比例</div>
              <div className="ds-tb-ratio__grid">
                {ASPECT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={
                      aspect === option.value
                        ? "ds-tb-ratio__cell ds-tb-ratio__cell--on"
                        : "ds-tb-ratio__cell"
                    }
                    onClick={() => {
                      setAspect(option.value);
                      setOpenMenu(null);
                    }}
                  >
                    <i
                      className={
                        option.value === "auto"
                          ? "ds-tb-ratio__frame ds-tb-ratio__frame--auto"
                          : "ds-tb-ratio__frame"
                      }
                      style={{ width: option.icon[0], height: option.icon[1] }}
                    />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="ds-tb__seg ds-tb__seg--gizmo" title="变换模式">
          {GIZMO_MODES.map((item) => (
            <button
              key={item.mode}
              type="button"
              className={gizmoMode === item.mode ? "ds-tb__seg-btn ds-tb__seg-btn--on" : "ds-tb__seg-btn"}
              onClick={() => setGizmoMode(item.mode)}
            >
              {item.label}
              <kbd className="ds-tb__kbd">{item.hotkey}</kbd>
            </button>
          ))}
        </div>

        <span className="ds-tb__vsep" />

        <div className="ds-tb__menu-anchor">
          <button
            type="button"
            className="ds-tb__btn ds-tb__btn--primary"
            onClick={() => setOpenMenu(openMenu === "add" ? null : "add")}
          >
            ＋ 添加对象
          </button>
          {openMenu === "add" ? (
            <div className="ds-tb-menu" role="menu">
              <button
                type="button"
                className="ds-tb-menu__item"
                onClick={() => {
                  setOpenMenu(null);
                  fileInputRef.current?.click();
                }}
              >
                {ICON_UPLOAD}
                本地上传
              </button>
              <div className="ds-tb-menu__sep" />
              {BODY_TYPES.map((bodyType) => (
                <button
                  key={bodyType.id}
                  type="button"
                  className="ds-tb-menu__item"
                  onClick={() => addMannequin(bodyType.id)}
                >
                  {ICON_FIGURE}
                  {bodyType.label}
                </button>
              ))}
              <div className="ds-tb-menu__sep" />
              <button type="button" className="ds-tb-menu__item" onClick={addCrowd}>
                {ICON_CROWD}
                群众阵列
              </button>
              <div className="ds-tb-menu__item ds-tb-menu__item--has-sub">
                {ICON_GEOMETRY}
                几何模型
                <span className="ds-tb-menu__arrow">▸</span>
                <div className="ds-tb-menu__sub">
                  {GEOMETRY_MENU.map((item) => (
                    <button
                      key={item.shape}
                      type="button"
                      className="ds-tb-menu__item"
                      onClick={() => {
                        setOpenMenu(null);
                        addGeometry(item.shape, item.label, item.size);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {workspace ? (
          <div className="ds-tb__menu-anchor">
            <button
              type="button"
              className="ds-tb__btn"
              title="站位镜头模版包"
              onClick={() => setOpenMenu(openMenu === "templates" ? null : "templates")}
            >
              模版 ▾
            </button>
            {openMenu === "templates" ? (
              <div className="ds-tb-menu" role="menu">
                {workspace.templates === null ? (
                  <div className="ds-tb-menu__note">模版加载中…</div>
                ) : null}
                {workspace.templatesError ? (
                  <div className="ds-tb-menu__note">{workspace.templatesError}</div>
                ) : null}
                {workspace.templates !== null && workspace.templates.length === 0 && !workspace.templatesError ? (
                  <div className="ds-tb-menu__note">暂无可用模版</div>
                ) : null}
                {templateGroups.map((group) => (
                  <div key={group.key}>
                    <div className="ds-tb-menu__group">{group.label}</div>
                    {group.items.map((template) => (
                      <button
                        key={template.id}
                        type="button"
                        className="ds-tb-template"
                        disabled={workspace.applyingTemplateId !== null}
                        onClick={() => {
                          setOpenMenu(null);
                          void workspace.applyTemplate(template.id);
                        }}
                      >
                        <span className="ds-tb-template__meta">
                          <span className="ds-tb-template__name">{template.name}</span>
                          <span className="ds-tb-template__info">
                            {template.characterCount} 角色 · {template.cameraCount} 机位
                          </span>
                        </span>
                        <span className="ds-tb-template__apply">
                          {workspace.applyingTemplateId === template.id ? "应用中…" : "应用"}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {workspace ? (
          <button
            type="button"
            className="ds-tb__btn"
            title="保存场景到服务端；版本冲突时会提示你加载最新"
            disabled={workspace.saving}
            onClick={() => void workspace.save()}
          >
            {workspace.saving ? "保存中…" : "保存场景"}
          </button>
        ) : null}

        <div className="ds-tb__menu-anchor">
          <button
            type="button"
            className="ds-tb__btn"
            disabled={motionRunning !== null}
            title={motionRunning !== null ? "运镜运行中，结束后可继续导出" : undefined}
            onClick={() => setOpenMenu(openMenu === "export" || openMenu === "motion" ? null : "export")}
          >
            导出 ▾
          </button>
          {openMenu === "export" ? (
            <div className="ds-tb-menu" role="menu">
              {cameraList.length === 0 ? (
                <div className="ds-tb-menu__note">需要先新增机位（顶栏中间「＋」）</div>
              ) : null}
              <div className="ds-tb-menu__group">静态 · 保存并归组</div>
              {STATIC_EXPORT_MENU.map((entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  className="ds-tb-menu__item ds-tb-menu__item--rich"
                  disabled={cameraList.length === 0 || savingExport}
                  title={cameraList.length === 0 ? "需要先新增机位" : undefined}
                  onClick={() => runSaveAndGroup(entry.kind)}
                >
                  <span className="ds-tb-menu__item-title">
                    {STATIC_EXPORT_ICONS[entry.kind]}
                    {savingExport ? "保存中…" : entry.label}
                  </span>
                  <span className="ds-tb-menu__item-hint">{staticExportHint(entry.kind)}</span>
                </button>
              ))}
              <div className="ds-tb-menu__group">视频</div>
              <button
                type="button"
                className="ds-tb-menu__item"
                disabled={cameraList.length === 0}
                title={cameraList.length === 0 ? "需要先新增机位" : "选预设和时长，预览后录制归组"}
                onClick={() => setOpenMenu("motion")}
              >
                {ICON_MOTION}
                运镜小样
                <span className="ds-tb-menu__arrow">▸</span>
              </button>
              <div className="ds-tb-menu__sep" />
              <div className="ds-tb-menu__group">下载到本地</div>
              {STATIC_EXPORT_MENU.map((entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  className="ds-tb-menu__item ds-tb-menu__item--minor"
                  disabled={cameraList.length === 0 || savingExport}
                  title={cameraList.length === 0 ? "需要先新增机位" : "只下载 PNG，不入资产库不归组"}
                  onClick={() => runDownload(entry.kind)}
                >
                  {entry.downloadLabel}
                </button>
              ))}
            </div>
          ) : null}
          {openMenu === "motion" ? (
            <div className="ds-tb-menu ds-tb-motion" role="menu">
              <button type="button" className="ds-tb-motion__back" onClick={() => setOpenMenu("export")}>
                ‹ 导出
              </button>
              <div className="ds-tb-menu__group">运镜预设</div>
              {MOTION_PRESETS.map((preset) => {
                const followBlocked = preset.needsFollowTarget && !followTarget;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={
                      preset.id === motionPreset
                        ? "ds-tb-menu__item ds-tb-motion__preset ds-tb-motion__preset--on"
                        : "ds-tb-menu__item ds-tb-motion__preset"
                    }
                    disabled={followBlocked}
                    onClick={() => setMotionPreset(preset.id)}
                  >
                    <span className="ds-tb-motion__preset-main">
                      {preset.label}
                      {preset.id === motionPreset ? <span className="ds-tb-motion__check">✓</span> : null}
                    </span>
                    <span className="ds-tb-motion__hint">
                      {followBlocked ? "跟随需要先选中一个对象" : preset.hint}
                    </span>
                  </button>
                );
              })}
              <div className="ds-tb-menu__group">时长</div>
              <div className="ds-tb-motion__durations">
                {MOTION_DURATIONS.map((seconds) => (
                  <button
                    key={seconds}
                    type="button"
                    className={
                      seconds === motionDuration
                        ? "ds-tb-motion__duration ds-tb-motion__duration--on"
                        : "ds-tb-motion__duration"
                    }
                    onClick={() => setMotionDuration(seconds)}
                  >
                    {seconds} 秒
                  </button>
                ))}
              </div>
              <div className="ds-tb-motion__actions">
                <button type="button" className="ds-tb__btn" onClick={() => runMotion("preview")}>
                  预览
                </button>
                <button
                  type="button"
                  className="ds-tb__btn ds-tb__btn--primary"
                  onClick={() => runMotion("record")}
                >
                  {workspace ? "录制并归组" : "导出运镜视频"}
                </button>
              </div>
              <div className="ds-tb-menu__note">
                {workspace
                  ? "白模 WebM，本地渲染；录制完成归参考清单「运镜」组并下载到本地（视频暂不入资产库）"
                  : "白模 WebM，本地渲染"}
              </div>
            </div>
          ) : null}
        </div>

        <span className="ds-tb__vsep" />

        <div className="ds-tb__menu-anchor">
          <button
            type="button"
            className="ds-tb__btn ds-tb__btn--icon"
            title="快捷键"
            aria-label="快捷键帮助"
            onClick={() => setOpenMenu(openMenu === "help" ? null : "help")}
          >
            ?
          </button>
          {openMenu === "help" ? (
            <div className="ds-tb-menu ds-tb-help" role="menu" aria-label="快捷键清单">
              <div className="ds-tb-menu__group">快捷键</div>
              {DIRECTOR_SHORTCUTS.map((item) => (
                <div key={item.keys} className="ds-tb-help__row">
                  <kbd className="ds-tb-help__kbd">{item.keys}</kbd>
                  <span>{item.action}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".glb" className="ds-tb__file" onChange={handleFileChange} />

      {!workspace && captureToast ? (
        <div className="ds-tb__toast" role="status">
          {captureToast}
        </div>
      ) : null}
    </header>
  );
}
