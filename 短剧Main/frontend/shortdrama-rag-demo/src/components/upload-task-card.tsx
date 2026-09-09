/* ============================================================
   upload-task-card.tsx — 图片上传入库任务的等待期卡片(S42;S46 B-3 抽出)

   从 app.tsx 的提醒 Dock 抽出,以便组件渲染断言:
   - 文件名走 uploadDisplayFileName——机器串文件名(UUID/长哈希)不裸露原文;
   - 服务端给不出 ETA 时不显示耗时行(不摆「暂无估计」状态自述);
   - 无排位也无 ETA 时兜底「已提交,等待入库」。
   显式 React import:仓根门禁用 node:test + tsx(classic JSX 运行时)渲染本组件,
   与 Vite 的 react-jsx 自动运行时双兼容。
   ============================================================ */
import * as React from "react";
import { SpinnerGap } from "@phosphor-icons/react";
import { uploadTaskCardModel } from "../asset-upload-tracker";
import type { AssetUploadTask } from "../types";

export function UploadTaskCard({ task }: { task: AssetUploadTask }): React.JSX.Element {
  const card = uploadTaskCardModel(task);
  return (
    <section className="glass-panel flex gap-3 rounded-md border border-border-1 px-4 py-3 shadow-[var(--shadow-1)]">
      <SpinnerGap aria-hidden="true" className="mt-0.5 size-5 shrink-0 animate-spin text-accent" />
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm text-ink-1">{card.statusLabel}：{card.fileName}</strong>
        <p className="mt-0.5 text-xs text-ink-2">
          {[card.queuePositionText, card.estimatedDurationText].filter(Boolean).join(" · ") || "已提交，等待入库"}
        </p>
      </div>
    </section>
  );
}
