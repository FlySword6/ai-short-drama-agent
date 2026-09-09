/**
 * Card / Badge / Input / Textarea / Skeleton / Tabs / Tooltip / States — 常用原语集。
 * 全部走 tw.css @theme 的 token 映射，深色生产主题。
 */
import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cva, type VariantProps } from "class-variance-authority";
import { SpinnerGap } from "@phosphor-icons/react";
import { assetRoleMeta } from "../../control-assets";
import { XiaoheiMark, type XiaoheiPose } from "./brand-mark";
import { cn } from "./cn";

/* ---------- Card ---------- */

export function Card({ className, interactive, ...props }: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-lg border border-border-1 bg-surface-1",
        interactive && "transition-all duration-150 ease-out-quart hover:-translate-y-0.5 hover:border-border-2 hover:shadow-[0_8px_24px_-12px_oklch(0_0_0/0.5)]",
        className,
      )}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("flex flex-col gap-1 px-4 pt-4", className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return <h3 className={cn("text-base font-semibold text-ink-1", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn("text-xs text-ink-2", className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn("flex items-center gap-2 px-4 pb-4", className)} {...props} />;
}

/* ---------- Badge ---------- */

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-4",
  {
    variants: {
      tone: {
        neutral: "bg-surface-2 text-ink-2",
        accent: "bg-accent-subtle text-accent-text",
        success: "bg-success/15 text-success",
        danger: "bg-danger/15 text-danger",
        warning: "bg-warning/15 text-warning",
        agent: "bg-agent/10 text-agent-text",
        outline: "border border-border-2 text-ink-2",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}
export function Badge({ className, tone, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/* ---------- Input / Textarea / Select（原生控件统一井字底） ---------- */

export const inputClasses = "h-9 w-full rounded-md border border-border-1 bg-surface-0 px-3 text-sm text-ink-1 placeholder:text-ink-4 outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:text-ink-3";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(inputClasses, className)} {...props} />,
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(inputClasses, "h-auto min-h-20 py-2 leading-relaxed", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(inputClasses, "appearance-none pr-8", className)} {...props} />
  ),
);
Select.displayName = "Select";

/* ---------- Switch（通用开关：pill 轨道 + 滑块，peer 驱动；S7-9 自 review-panels 收编为原语） ---------- */

export function Switch({ checked, disabled, ariaDisabled, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  /** S66 纪律(S73 落地):灰显但仍要可聚焦/可悬浮出 tooltip 时用 aria-disabled;
      disabled 的 input 不吃 hover/focus,tooltip 会永远出不来。 */
  ariaDisabled?: boolean;
  label: string;
  onChange: () => void;
}): React.JSX.Element {
  return (
    <span className="relative inline-flex h-5 w-[34px] shrink-0">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-disabled={ariaDisabled || undefined}
        aria-label={label}
        onChange={ariaDisabled ? () => undefined : onChange}
        onClick={ariaDisabled ? (event) => event.preventDefault() : undefined}
        className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed aria-disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none relative h-5 w-full rounded-full border border-border-2 bg-surface-2 transition-colors duration-150 ease-out-quart",
          "after:absolute after:left-[2px] after:top-1/2 after:size-3.5 after:-translate-y-1/2 after:rounded-full after:bg-ink-2 after:transition-transform after:duration-150 after:ease-out-quart",
          "peer-checked:border-accent peer-checked:bg-accent peer-checked:after:translate-x-[14px] peer-checked:after:bg-accent-ink",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-0",
          "peer-aria-disabled:opacity-60",
        )}
      />
    </span>
  );
}

export function Field({ label, hint, error, children, className }: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {error ? <span role="alert" className="text-xs text-danger">{error}</span>
        : hint ? <span className="text-xs text-ink-4">{hint}</span> : null}
    </label>
  );
}

/* ---------- Skeleton ---------- */

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-surface-2", className)} {...props} />;
}

/* ---------- RoleBadge（G1：控制资产职责徽章，token 语义色） ---------- */

export function RoleBadge({ role, className }: { role?: string | null; className?: string }): React.JSX.Element | null {
  const meta = assetRoleMeta(role);
  if (!meta) return null;
  return <Badge tone={meta.tone as "accent" | "success" | "warning" | "danger" | "agent" | "neutral"} className={className}>{meta.label}</Badge>;
}

/* ---------- Tabs ---------- */

export const Tabs = TabsPrimitive.Root;
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List ref={ref} className={cn("inline-flex items-center gap-1 rounded-md bg-surface-0 p-1 border border-border-1", className)} {...props} />
));
TabsList.displayName = "TabsList";
export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-sm text-ink-2 outline-none transition-all active:scale-[0.98]",
      "hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent",
      "data-[state=active]:bg-surface-2 data-[state=active]:text-ink-1 data-[state=active]:shadow-sm",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";
/** 页签切换进场淡入（S7-15：切换有 160ms 反馈，不瞬切）。 */
export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("data-[state=active]:animate-fade-in", className)} {...props} />
));
TabsContent.displayName = "TabsContent";

/* ---------- Tooltip ---------- */

export function Tooltip({ content, children, side = "top", delayDuration = 300 }: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className="z-[70] max-w-64 rounded-md border border-border-2 bg-surface-1 px-2.5 py-1.5 text-xs leading-relaxed text-ink-2 shadow-lg data-[state=delayed-open]:animate-fade-in"
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-surface-1" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/* ---------- States（空/加载/错误三态，板14） ---------- */

export function LoadingState({ label = "正在读取数据", onRetry }: { label?: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div role="status" className="flex flex-col items-center gap-3 py-16 text-sm text-ink-2">
      <SpinnerGap className="size-5 animate-spin text-accent-text" />
      <span>{label}</span>
      {onRetry ? (
        <span className="flex animate-fade-up items-center gap-2">
          {/* W7-A：慢加载升级位的小黑奔跑（板14：骨架为主，小黑只在 8s 升级分支） */}
          <XiaoheiMark pose="run" size={26} />
          <button type="button" onClick={onRetry} className="text-xs text-accent-text underline underline-offset-4">仍在加载？点击重试</button>
        </span>
      ) : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-16 text-center">
      {/* W7-A：加载失败小黑（摊手/歪头），替换通用警告图标 */}
      <span className="flex size-12 items-center justify-center rounded-full bg-surface-2">
        <XiaoheiMark pose="shrug" size={30} />
      </span>
      <p className="max-w-md text-sm text-ink-2">{message}</p>
      {onRetry ? <button type="button" onClick={onRetry} className="text-xs text-accent-text underline underline-offset-4">重试</button> : null}
    </div>
  );
}

export function EmptyState({ title, description, action, icon, mascot }: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  /** W7-A：空态家族小黑（开机祈愿 sit / 翻找 search）；icon 优先，其次 mascot，再通用圆标 */
  mascot?: XiaoheiPose;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      {icon || mascot ? (
        <div className="flex size-12 items-center justify-center rounded-full bg-surface-2 text-ink-2 [&_svg]:size-6">
          {icon ?? <XiaoheiMark pose={mascot} size={30} />}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <strong className="text-base text-ink-1">{title}</strong>
        {description ? <p className="max-w-md text-sm text-ink-2">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
