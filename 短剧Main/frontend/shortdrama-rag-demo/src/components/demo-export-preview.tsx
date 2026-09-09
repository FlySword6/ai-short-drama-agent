/* ============================================================
   demo-export-preview.tsx — K2U D-19:三处导出入口共用的「落文件前一格」

   原判(幕四片段断点 8):生产页导出弹窗、工作台顶栏「交付」、连播页脚三处
   在 demo 下只弹「离线演示不会下载真实文件」,CSV/JSON 内容无法核对。
   本组件把三处统一成同一形态:内容在内存按交付合同真生成(demo-delivery.ts),
   弹窗展示全文 + 可复制 + 如实标注「离线演示不落盘」,口径三处一致。
   只在 demo 分支渲染;真栈三处仍走 api.downloadEpisodeJson/Csv,本组件不参与。
   ============================================================ */

import { BracketsCurly, Copy, FileText, WarningCircle } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import * as React from "react";
import { formatCreditsWithUnit } from "../cost-units";
import { buildDemoDeliveryPreview, demoDeliveryGapText } from "../demo-delivery";
import { EmptyState } from "../ui";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export type DemoExportKind = "json" | "csv";

const noteClass = "rounded-sm border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-2";
const gapClass = "flex items-start gap-1.5 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink-2";

export function DemoExportPreviewDialog({ episodeId, kind, notify, onClose }: {
  episodeId: string;
  kind: DemoExportKind;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
  onClose: () => void;
}): React.JSX.Element {
  const preview = useMemo(() => buildDemoDeliveryPreview(episodeId), [episodeId]);
  const content = preview ? (kind === "json" ? preview.jsonText : preview.csvText) : "";
  const [copying, setCopying] = useState(false);

  /** 复制 = 给用户看到内容的另一半;成功/失败都如实 toast,不假装落盘。 */
  async function copyContent(): Promise<void> {
    if (!content) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(content);
      notify(`${kind.toUpperCase()} 内容已复制到剪贴板（离线演示不落盘）`, "success");
    } catch {
      notify("复制失败，可直接在预览框里全选内容手动复制", "error");
    } finally {
      setCopying(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent size="large">
        <DialogHeader>
          <DialogTitle>{`交付清单预览（${kind.toUpperCase()} · 离线演示）`}</DialogTitle>
          {preview ? <DialogDescription>{`${preview.projectName} · 第 ${preview.episodeNo} 集`}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <p className={noteClass}>
            离线演示不下载真实文件：以下内容已在内存按交付合同生成，可复制核对，不会写入服务。
            口径 = 已过审的已选中持久化视频主版本（与审核队列同一闸门），本次会话里的裁决会真影响这份内容。
          </p>
          {preview ? (
            <>
              <p className="text-xs text-ink-2">
                {`共 ${preview.itemCount} 项产物（主图 ${preview.imageCount} + 粗剪 ${preview.videoCount}）· 预估合计 ${formatCreditsWithUnit(preview.estimatedCostFen)}（离线示例估价）`}
              </p>
              {preview.gaps.length > 0 ? (
                <p className={gapClass}>
                  <WarningCircle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden="true" />
                  <span>{`未交齐 ${preview.gaps.length} 镜：${preview.gaps.map(demoDeliveryGapText).join("；")}。真栈下这份内容对应「先交已就绪镜头」的 partial 口径。`}</span>
                </p>
              ) : null}
              <pre className="max-h-[46vh] overflow-auto whitespace-pre rounded-md border border-border-1 bg-surface-well p-3 font-mono text-xs leading-5 text-ink-1">{content}</pre>
            </>
          ) : (
            <EmptyState
              title="本集还没有可交付的主版本"
              description="离线演示数据里这一集还没有已过审的已选中持久化视频主版本；真栈下同口径请求会被如实拦下。"
              icon={kind === "json" ? <BracketsCurly /> : <FileText />}
            />
          )}
        </DialogBody>
        <DialogFooter>
          <span className="mr-auto text-xs text-ink-4">内容只在内存生成，不落盘。</span>
          <Button onClick={onClose}>关闭</Button>
          {preview ? <Button variant="primary" icon={<Copy />} loading={copying} onClick={() => void copyContent()}>{`复制 ${kind.toUpperCase()} 内容`}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
