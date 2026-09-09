/**
 * Button — shadcn 结构（cva 变体）+ 本项目深色 token 主题。
 * 变体与旧 ui.tsx Button 语义对齐（primary/secondary/accent/danger/ghost），
 * 外加 outline 与 destructive-outline；全部变体带 :active 按压（scale 0.98，S7-16）与 focus ring。
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { SpinnerGap } from "@phosphor-icons/react";
import { cn } from "./cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 ease-out-quart outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0 disabled:pointer-events-none disabled:text-ink-3 active:scale-[0.98] [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-ink hover:bg-accent-hover active:bg-accent-active disabled:bg-surface-2",
        secondary: "bg-surface-2 text-ink-1 border border-border-1 hover:border-border-2 disabled:border-border-1",
        accent: "bg-accent-subtle text-accent-text border border-accent/30 hover:border-accent/50",
        outline: "border border-border-2 text-ink-1 hover:bg-surface-2",
        danger: "bg-danger text-white hover:brightness-110",
        /* soft 两档（2026-08-17 配置页按钮上色补）：与 Badge 同套 token 浅底（danger/15、warning/15），
           给破坏性/撤回类行级动作一个有底色的独立档，区别于 outline 的无底描边。 */
        "danger-soft": "bg-danger/15 text-danger hover:bg-danger/25 disabled:bg-surface-2",
        "warning-soft": "bg-warning/15 text-warning hover:bg-warning/25 disabled:bg-surface-2",
        "danger-outline": "border border-danger/50 text-danger hover:bg-danger/10",
        ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink-1",
        link: "text-accent-text underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-2.5 text-xs",
        md: "h-9 px-3.5",
        lg: "h-10 px-5",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** 左侧图标（Phosphor 节点）。 */
  icon?: React.ReactNode;
  /** 加载态：替换图标为 spinner，禁用点击。 */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, icon, loading, children, disabled, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <SpinnerGap className="animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

export { Button, buttonVariants };
