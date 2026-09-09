/**
 * 3D 导演台 · 页面壳（V0.1.1 Vite 移植版）
 *
 * 四区布局（.director-root grid：顶栏 48px / 左栏 240px / 右栏 300px / 中央视口）：
 * - 顶栏 <TopBar />：标题、视角切换、机位管理、环境/画幅/gizmo、添加对象、模版/保存/导出
 * - 左栏 <LeftDock />：页签坞——场景对象清单（选中/显隐/重命名/删除/清空）/ 资产库面板
 * - 中央 <main className="ds-viewport">：<StageCanvas /> + 兄弟节点 <FrameOverlays />
 *   （FrameOverlays 是纯 DOM 遮幅/构图线覆盖层，必须挂在 StageCanvas 之后；
 *   .ds-viewport 已 position:relative，见 ./director.css）
 * - 右栏 <PropertyPanel />：随选中对象类型分发的属性面板
 *
 * Vite 适配：旧仓用 next/dynamic ssr:false 隔离 three 的 SSR；本前端是纯客户端 SPA，
 * 无 SSR 路径，StageCanvas 直接静态引入。
 */
import { FrameOverlays } from "./ui/FrameOverlays";
import { LeftDock } from "./ui/LeftDock";
import { PropertyPanel } from "./ui/PropertyPanel";
import { TopBar } from "./ui/TopBar";
import { StageCanvas } from "./StageCanvas";

export function DirectorShell() {
  return (
    <div className="director-root">
      <TopBar />
      <LeftDock />
      <main className="ds-viewport">
        <StageCanvas />
        <FrameOverlays />
      </main>
      <PropertyPanel />
    </div>
  );
}
