/* ============================================================
   lite-confirm-dialog.tsx — Lite 破坏性动作的自定义二次确认弹窗
   （v1.9 十.11：取代浏览器原生 window.confirm，视觉与壳层 Dialog 体系一致）。
   用法：页面持有 confirmState（null=关），onConfirm 里做真删除；
   busy 期间禁用两钮、遮罩点击不关。
   ============================================================ */
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";

export interface LiteConfirmState {
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
}

export function LiteConfirmDialog({
  state,
  busy = false,
  onClose,
}: {
  state: LiteConfirmState | null;
  busy?: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>{state?.title ?? ""}</DialogTitle>
          <DialogDescription>{state?.description ?? ""}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="danger" loading={busy} onClick={() => state?.onConfirm()}>
            {state?.confirmLabel ?? "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
