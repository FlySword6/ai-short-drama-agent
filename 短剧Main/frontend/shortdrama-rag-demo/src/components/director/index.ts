/**
 * 3D 导演台 · barrel export（V0.1.1 Vite 移植版）
 *
 * 顶层导出 DirectorWorkspace（props { projectId }，路由 /projects/:projectId/director 挂载）；
 * 命令执行器（executeDirectorCommand / undoDirectorCommand）是 Pi SSE 将来的稳定调用点。
 * 注意：引入本 barrel 会拉入 three/R3F 依赖链，路由侧如需分包请对
 * DirectorWorkspace 做 React.lazy（见集成者 patch 清单）。
 */
export { DirectorWorkspace } from "./DirectorWorkspace";
export type { DirectorWorkspaceProps } from "./DirectorWorkspace";
export { DirectorShell } from "./DirectorShell";

/* 领域类型与 store（旧仓 types.ts/store.ts 移植） */
export * from "./types";
export type { NewSceneObject, AddCameraInit, DirectorState, SceneStateSlice } from "./store";
export { useDirectorStore, createSeedSceneState } from "./store";
export type { DirectorRuntimeContext } from "./runtime";
export { directorRuntime } from "./runtime";

/* 快照序列化（store ⇄ 后端 SceneSnapshot，ephemeral 标记） */
export {
  toSceneSnapshot,
  fromSceneSnapshot,
  backendAspectOf,
  currentUiStash,
  noteObjectExtras,
} from "./snapshot";
export type { DirectorSceneSnapshot, DirectorUiStash } from "./snapshot";

/* 后端 API 客户端与装载/保存编排（乐观锁 / 409 分支） */
export {
  ApiClientError,
  getDirectorScene,
  putDirectorScene,
  postDirectorCapture,
  listDirectorTemplates,
  applyDirectorTemplate,
  validateDirectorCommands,
} from "./api";
export type { DirectorTemplateSummary, FetchLike } from "./api";
export { loadDirectorScene, saveDirectorSceneState } from "./persistence";
export type { LoadDirectorSceneResult, SaveDirectorSceneResult } from "./persistence";

/* 模版合入 */
export { mergeTemplateScene, parseTemplateApplyScene } from "./templates";
export type { MergeTemplateResult, TemplateApplyScene } from "./templates";

/* 命令执行器 + 撤销（与后端同构；Pi SSE 稳定调用点） */
export {
  executeDirectorCommand,
  undoDirectorCommand,
  directorUndoDepth,
  clearDirectorCommandHistory,
} from "./commands";
export type { DirectorCommand, DirectorCommandType, CommandInverse } from "./contracts";
export { DIRECTOR_COMMAND_TYPES } from "./contracts";

/* 渲染层（StageCanvas / scene/ presentational 组件） */
export { SceneObjectNode } from "./scene/SceneObjectNode";
export { StageCanvas } from "./StageCanvas";
export { Mannequin } from "./scene/Mannequin";
// 组件与 types.ts 的 GeometryObject 接口重名，barrel 内以 Node 后缀导出
export { GeometryObject as GeometryObjectNode } from "./scene/GeometryObject";
export { CrowdArray, crowdMemberName } from "./scene/CrowdArray";
export { UploadedModel } from "./scene/UploadedModel";
export { StageCamera, focalToVfov } from "./scene/StageCamera";
export { CameraViewController } from "./scene/CameraViewController";
export { JOINTS, JOINT_GROUPS, POSE_JOINT_MAP, POSE_PELVIS_Y, POSE_PRESETS, resolvePoseId } from "./scene/poses";
export type { JointDef, JointGroupDef, JointId, PoseId, PosePreset } from "./scene/poses";
export { BODIES, resolveBodyType } from "./scene/bodies";
export type { BodyProportions } from "./scene/bodies";

/* ui/（顶栏 / 左栏页签坞与面板 / 画幅遮幅叠加层） */
export { TopBar } from "./ui/TopBar";
export { LeftDock } from "./ui/LeftDock";
export { ObjectListPanel } from "./ui/ObjectListPanel";
export { AssetsPanel } from "./ui/AssetsPanel";
export { PropertyPanel } from "./ui/PropertyPanel";
export { FrameOverlays } from "./ui/FrameOverlays";

/* 资产库 3D 资产（W5.5：过滤/分组/搜索纯逻辑 + 内置 fixture + 加载状态） */
export {
  DIRECTOR_ASSET_KINDS,
  ASSET_KIND_LABELS,
  BUILTIN_ASSETS,
  assetGlbUrl,
  isDirector3dAsset,
  assetDisplayName,
  groupAssetsByKind,
  filterAssetsByQuery,
  humanModelLoadError,
} from "./assets-library";
export type { AssetGroup, DirectorAssetKind } from "./assets-library";
export { useAssetLoadStore } from "./asset-load-store";
export type { ModelLoadEntry } from "./asset-load-store";
export { ModelGuard } from "./scene/ModelGuard";

/* export/（机位截图 / 分镜宫格 / 入资产库，依赖 directorRuntime 渲染上下文） */
export { exportCameraShot, renderCameraShot, renderCameraPreview } from "./export/captureShot";
export type { RenderedCameraShot } from "./export/captureShot";
export { exportCameraGrid, gridCellSize } from "./export/exportGrid";
export { saveCameraShotToLibrary } from "./export/saveCapture";
export type { SaveCameraShotResult } from "./export/saveCapture";

/* 工作台上下文（集成者如需自定义 chrome 可消费） */
export { useDirectorWorkspace } from "./workspace-context";
export type { DirectorWorkspaceApi } from "./workspace-context";
