/* ============================================================
   lite-shot-storyboard-detail-dialog.tsx — P6 storyboard_detail 只读高级查看弹窗
   （§2 P6 D / §3.4.6 E）：只读展示 skill 单次结构化拆镜全量——
   剧情单元内 N Shot 四模块 / 光影 / sfx / 对白 / @ 引用资产 / 画风·色调·运镜策略。
   降级态 storyboard_detail 为 null 时由调用方隐藏入口；本组件直接返回 null。
   独立成模块的原因：lite-shot-detail-page 的源码口径测试对该页做禁词扫描
   （退役的片段编辑功能），弹窗的 wire 字段名不得回流到页面源码。
   ============================================================ */
import * as React from "react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Badge } from "../../components/ui/primitives";
import { Button } from "../../components/ui/button";
import type { ShotStoryboardDetail } from "../../types";
import { assetKindLabel } from "../../asset-kind-labels";

const h = React.createElement;

export function LiteShotStoryboardDetailDialog(props: {
  detail: ShotStoryboardDetail | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactNode {
  const detail = props.detail;
  if (!detail) return null;
  return h(Dialog, { open: props.open, onOpenChange: props.onOpenChange },
    h(DialogContent, { size: "large" },
      h(DialogHeader, null,
        h(DialogTitle, null, "拆镜详情（skill 结构化全量）"),
        h(DialogDescription, null, "一键生成本集阶段②的单次结构化拆镜输出；成文提示词由它渲染而来，这里只读。"),
      ),
      h(DialogBody, { className: "max-h-[60vh] space-y-4 overflow-y-auto" },
        detail.segment_title ? h("p", { className: "text-sm font-medium text-ink-1" }, `剧情单元：${detail.segment_title}`) : null,
        detail.style.art_style || detail.style.color_tone || detail.style.camera_strategy ? h("div", { className: "rounded-lg border border-border-1 bg-surface-2 p-3 text-xs text-ink-2" },
          detail.style.art_style ? h("p", null, `画风：${detail.style.art_style}`) : null,
          detail.style.color_tone ? h("p", null, `色调：${detail.style.color_tone}`) : null,
          detail.style.camera_strategy ? h("p", null, `运镜策略：${detail.style.camera_strategy}`) : null,
        ) : null,
        detail.shots.length > 0 ? h("section", null,
          h("h3", { className: "mb-2 text-xs font-medium text-ink-3" }, `N Shot（${detail.shots.length} 段）`),
          h("div", { className: "space-y-2" },
            detail.shots.map((item, index) => h("div", { key: index, className: "rounded-lg border border-border-1 bg-surface-0 p-3 text-xs text-ink-2" },
              h("p", { className: "mb-2 font-medium text-ink-1" }, `Shot ${index + 1}`),
              item.subject_action ? h("p", null, `主体动作：${item.subject_action}`) : null,
              item.physics_detail ? h("p", null, `物理细节：${item.physics_detail}`) : null,
              item.camera_language ? h("p", null, `镜头语言：${item.camera_language}`) : null,
              item.lighting ? h("p", null, `光影：${item.lighting}`) : null,
            )),
          ),
        ) : null,
        detail.lighting ? h("p", { className: "text-xs text-ink-2" }, `整段光影：${detail.lighting}`) : null,
        detail.sfx_layers.length > 0 ? h("p", { className: "text-xs text-ink-2" }, `音效分层：${detail.sfx_layers.join("；")}`) : null,
        detail.dialogue.length > 0 ? h("section", null,
          h("h3", { className: "mb-2 text-xs font-medium text-ink-3" }, "对白"),
          detail.dialogue.map((line, index) => h("p", { key: index, className: "text-xs text-ink-2" },
            `${line.speaker ? `${line.speaker}：` : ""}${line.text}${line.lip_sync ? "（对口型）" : ""}`)),
        ) : null,
        detail.asset_definitions.length > 0 ? h("section", null,
          h("h3", { className: "mb-2 text-xs font-medium text-ink-3" }, "@ 引用资产"),
          h("div", { className: "flex flex-wrap gap-1.5" },
            detail.asset_definitions.map((asset, index) => h(Badge, { key: index, tone: "neutral" },
              `${assetKindLabel(asset.kind)}·${asset.name}`)),
          ),
        ) : null,
      ),
      h(DialogFooter, null,
        h(Button, { variant: "secondary", size: "sm", onClick: () => props.onOpenChange(false) }, "关闭"),
      ),
    ),
  );
}
