/**
 * 3D 导演台 · 工作台上下文（DirectorWorkspace 提供，TopBar 等子组件消费）
 *
 * 承载 projectId 相关的数据流状态：场景版本（乐观锁）、保存/冲突状态、
 * 模版清单与应用、 toast 通知。UI 组件经 useDirectorWorkspace() 取用；
 * 不在工作台内（纯 DirectorShell 演示）时返回 null，各组件据此降级隐藏接线按钮。
 */
import { createContext, useContext } from "react";

import type { DirectorTemplateSummary } from "./api";

export interface DirectorWorkspaceApi {
  projectId: string;
  /** 服务端场景 id；从未保存过为 null */
  sceneId: string | null;
  /** 当前持有的场景版本（乐观锁；首次保存传 0） */
  sceneVersion: number;
  /** 下次保存写入版本的来源动作（manual_save / template:apply:<id> 等留痕） */
  sourceAction: string;
  saving: boolean;
  /** PUT 409 冲突态：携带服务端当前版本；非 null 时 UI 显示「刷新/加载最新」横幅 */
  conflict: { currentVersion: number | null } | null;
  /** 模版清单（null = 加载中） */
  templates: DirectorTemplateSummary[] | null;
  templatesError: string | null;
  /** 正在应用的模版 id（busy 防重） */
  applyingTemplateId: string | null;
  save: () => Promise<void>;
  /** 重新 GET 装载最新版本（409 后用户确认刷新） */
  reload: () => Promise<void>;
  dismissConflict: () => void;
  applyTemplate: (templateId: string) => Promise<void>;
  /** 轻量 toast（3.2s 自动消失），与顶栏内联 toast 同款 */
  notify: (message: string) => void;
  /**
   * 导出完成回调（宿主可选，P0 衔接流的归组环节）：机位截图/宫格/深度图「保存并归组」
   * 入资产库成功后、运镜小样录制完成后触发，宿主（工作台页签）据此把产物归入参考清单
   * 对应组（shot/grid/capture→场景组，depth/motion→运镜组）并出「去工作台查看」toast；
   * 不提供（独立导演台路由）则只 toast「已入资产库，可在项目里引入」。
   * thumbUrl = 条目缩略图（已入库产物优先给资产库 storageUrl，本地 dataURL 兜底；
   * object URL 会随会话失效，不传）。
   */
  onExported?: (event: {
    kind: "shot" | "grid" | "capture" | "depth" | "motion";
    label: string;
    assetId?: string;
    thumbUrl?: string;
  }) => void;
}

const DirectorWorkspaceContext = createContext<DirectorWorkspaceApi | null>(null);

export const DirectorWorkspaceProvider = DirectorWorkspaceContext.Provider;

export function useDirectorWorkspace(): DirectorWorkspaceApi | null {
  return useContext(DirectorWorkspaceContext);
}
