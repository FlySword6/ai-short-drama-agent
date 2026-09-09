/**
 * Dialog — shadcn 结构（Radix Dialog）+ 深色 token 主题。
 * 交互质量由 Radix 保证：focus trap、Esc 关闭、点遮罩关闭、滚动锁、portal。
 * 替代旧 ui.tsx Modal；退出动效走 token 时长（160ms 退场由 data-state 驱动）。
 */
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "@phosphor-icons/react";
import { cn } from "./cn";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    size?: "small" | "medium" | "large" | "wide";
    /** 隐藏右上角关闭钮（强制流程弹窗用）。 */
    hideClose?: boolean;
  }
>(({ className, children, size = "medium", hideClose, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className="fixed inset-0 z-[60] bg-surface-well/70 backdrop-blur-sm data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out"
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-[61] -translate-x-1/2 -translate-y-1/2",
        "flex max-h-[85dvh] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-xl border border-border-2 bg-surface-1 shadow-[0_24px_48px_-16px_oklch(0_0_0/0.60)]",
        "data-[state=open]:animate-fade-up",
        size === "small" && "max-w-sm",
        size === "medium" && "max-w-lg",
        size === "large" && "max-w-2xl",
        size === "wide" && "max-w-5xl",
        className,
      )}
      {...props}
    >
      {children}
      {hideClose ? null : (
        <DialogPrimitive.Close
          className="absolute right-3 top-3 rounded-sm p-1.5 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="关闭"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("flex flex-col gap-1 border-b border-border-1 px-5 py-4", className)} {...props} />;
}

function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("flex-1 overflow-y-auto px-5 py-4", className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("flex items-center justify-end gap-2 border-t border-border-1 px-5 py-3", className)} {...props} />;
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-base font-semibold text-ink-1", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-ink-2", className)} {...props} />
));
DialogDescription.displayName = "DialogDescription";

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription };
