/* ============================================================
   app-rail.tsx — 全站 72px 左 rail(R2 壳层,批次一卡 1)

   原型基准:Figma 4JDL0kKz1VxOUNKDqoyEAL「05 · Prototype」SPEC 壳层卡
   (left-rail:logo/导航四项/队列/积分/头像;current 三态=elevated 底+
   accent 图标+亮字;积分/队列收 rail 底部,二级条不许堆成三明治)。
   色板走工程 token(surface/ink/accent 语义类),不硬编 hex。
   ============================================================ */
import * as React from "react";
import {
  ArrowsLeftRight,
  ChartBar,
  ChatCircleDots,
  Folders,
  GearSix,
  MagnifyingGlass,
  Package,
  Queue,
  ShieldCheck,
  SquaresFour,
  Sparkle,
  SpinnerGap,
} from "@phosphor-icons/react";
import { navigate } from "../routing";
import { canSeeAdminConsole, DEMO_CREDIT_SUMMARY } from "../operations";
import { capabilityGate, type CapabilitiesState } from "../capabilities-state";
import type { User } from "../types";
import { cn } from "./ui/cn";
import { BrandMark } from "./ui/brand-mark";
import { UserMenu } from "./user-menu";
import { AccountCreditsMenuRow, creditsPillTitle, useAccountCredits } from "./credits-pill";
import { formatCredits } from "../cost-units";
import { useInFlightCount } from "../queue-inflight";

interface AppRailProps {
  pathname: string;
  user: User;
  demoMode: boolean;
  onLogout: () => void;
  onOpenAssistant: () => void;
  onOpenPalette: () => void;
  capabilities: CapabilitiesState;
  paletteKbd: string;
  assistantKbd: string;
  /** Lite 界面模式切换（红线 R2：写服务端 users.ui_mode；LiteShell 右侧同枚，两处同一回调）。 */
  uiModeSwitching: boolean;
  onSwitchUiMode: () => void;
}

interface RailNavItem {
  key: string;
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  active: (pathname: string) => boolean;
  adminOnly?: boolean;
}

const NAV_ITEMS: RailNavItem[] = [
  { key: "projects", label: "项目管理", path: "/projects", icon: Folders, active: (p) => (p === "/projects" || p === "/" || p === "/trash" || p.startsWith("/projects/")) && p !== "/projects/plaza" && !/^\/projects\/[^/]+\/plaza$/.test(p) },
  { key: "plaza", label: "创作广场", path: "/projects/plaza", icon: SquaresFour, active: (p) => p === "/projects/plaza" || /^\/projects\/[^/]+\/plaza$/.test(p) },
  { key: "assets", label: "资产中心", path: "/assets?scope=personal", icon: Package, active: (p) => p === "/assets" || p.startsWith("/assets/") },
  { key: "dashboard", label: "数据看板", path: "/dashboard", icon: ChartBar, active: (p) => p === "/dashboard" },
  { key: "vnext", label: "vNext", path: "/vnext/projects", icon: Sparkle, active: (p) => p === "/vnext" || p.startsWith("/vnext/") },
  { key: "admin", label: "管理后台", path: "/admin", icon: ShieldCheck, active: (p) => p.startsWith("/admin"), adminOnly: true },
];

/** rail 导航项:图标方块托+9px 标签(Figma P-02 分阶:current=accent 实心方块+ink 图标+亮字,
   默认=elevated 弱底方块+ink-3;hover=tk-hover)。 */
function RailNavButton({ item, activeNow }: { item: RailNavItem; activeNow: boolean }): React.JSX.Element {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-current={activeNow ? "page" : undefined}
      title={item.label}
      onClick={() => navigate(item.path)}
      className={cn(
        "flex w-14 flex-col items-center gap-1 rounded-lg px-1 py-1.5 transition-colors duration-[var(--duration-1)] ease-out-quart",
        activeNow ? "text-ink-1" : "text-ink-3 hover:text-ink-2",
      )}
    >
      <span className={cn(
        "flex size-8 items-center justify-center rounded-md transition-colors duration-[var(--duration-1)] ease-out-quart",
        activeNow ? "bg-accent text-accent-ink" : "bg-tk-elevated hover:bg-tk-hover",
      )}>
        <Icon className="size-[18px]" aria-hidden={true} />
      </span>
      <span className="text-[9px] leading-none">{item.label}</span>
    </button>
  );
}

/** 底组弱图标钮(AI 工作区/命令面板/设置):elevated 方块托,不占导航层级,title 带快捷键。 */
function RailIconButton({ label, title, onClick, children }: {
  label: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-md bg-tk-elevated text-ink-3 transition-colors duration-[var(--duration-1)] ease-out-quart hover:bg-tk-hover hover:text-ink-2"
    >
      {children}
    </button>
  );
}

/** rail 积分位:mono 小数字+「积分」小字;demo 用示例值,真栈读取失败时静默不摆数字。
    hover 给三数明细(余额/今日剩余/日额度/结算日,与账户菜单行同一口径);失败给方向不裸错。 */
function RailCredits({ demoMode }: { demoMode: boolean }): React.JSX.Element {
  const { state, summary } = useAccountCredits(demoMode);
  const value = demoMode ? DEMO_CREDIT_SUMMARY : summary;
  const title = value ? creditsPillTitle(value) : state === "error" ? "积分读取失败，打开账号菜单可重试" : undefined;
  return (
    <span className="flex flex-col items-center gap-0.5" title={title} aria-label={value ? `我的积分：${creditsPillTitle(value)}` : "我的积分"}>
      <strong className="font-mono text-[10px] leading-none text-ink-2">
        {value ? formatCredits(value.balancePoints) : state === "loading" ? "…" : "—"}
      </strong>
      <span className="text-[9px] leading-none text-ink-3">积分</span>
    </span>
  );
}

export function AppRail(props: AppRailProps): React.JSX.Element {
  const { pathname, user, demoMode, onLogout, onOpenAssistant, onOpenPalette, capabilities, paletteKbd, assistantKbd, uiModeSwitching, onSwitchUiMode } = props;
  const inflight = useInFlightCount(demoMode);
  const queueActive = pathname === "/queue";
  /* z 走 z-float 阶梯计算档:rail-z-tokens.test.ts 钉死,不裸写数字;
     结构 token 已挂 styles/tokens.css :root(运行时必载),--z-float 30+2=32 生效。 */
  return (
    <nav aria-label="全站导航" className="fixed inset-y-0 left-0 z-[calc(var(--z-float)+2)] flex w-[72px] flex-col items-center gap-1.5 bg-tk-panel px-2 py-4">
      <button type="button" aria-label="回到项目管理" onClick={() => navigate("/projects")} className="mb-3 rounded-lg p-1 transition-colors hover:bg-surface-2/60">
        <BrandMark size="md" />
      </button>
      {/* 权限没读到时后台项不渲染;左栏不摆错误条,由壳层那条「权限信息没读到 · 重试」交代。 */}
      {NAV_ITEMS.filter((item) => !item.adminOnly || capabilityGate(capabilities, canSeeAdminConsole) === "allowed").map((item) => (
        <RailNavButton key={item.key} item={item} activeNow={item.active(pathname)} />
      ))}
      <div className="mt-auto flex flex-col items-center gap-3">
        <button
          type="button"
          aria-current={queueActive ? "page" : undefined}
          aria-label={inflight.count != null && inflight.count > 0 ? `生产队列,${inflight.count} 个在途任务` : "生产队列"}
          title="生产队列"
          onClick={() => navigate("/queue")}
          className={cn(
            "flex w-14 flex-col items-center gap-1 rounded-lg px-1 py-1.5 transition-colors duration-[var(--duration-1)] ease-out-quart",
            queueActive ? "text-ink-1" : "text-ink-3 hover:text-ink-2",
          )}
        >
          <span className={cn(
            "relative flex size-8 items-center justify-center rounded-md transition-colors duration-[var(--duration-1)] ease-out-quart",
            queueActive ? "bg-accent text-accent-ink" : "bg-tk-elevated hover:bg-tk-hover",
          )}>
            <Queue className="size-[18px]" aria-hidden="true" />
            {inflight.count != null && inflight.count > 0 ? (
              <b className="absolute -right-2 -top-1 font-mono text-[9px] font-semibold leading-none text-accent-text">{inflight.count}</b>
            ) : null}
          </span>
          <span className="text-[9px] leading-none">队列</span>
        </button>
        <RailIconButton label="打开 AI 工作区" title={`打开 AI 工作区(${assistantKbd})`} onClick={onOpenAssistant}>
          <ChatCircleDots className="size-5" aria-hidden="true" />
        </RailIconButton>
        <RailIconButton label="命令面板" title={`命令面板(${paletteKbd})`} onClick={onOpenPalette}>
          <MagnifyingGlass className="size-5" aria-hidden="true" />
        </RailIconButton>
        {/* s14 条 12:头像旁保留全局设置直达(UserMenu 里也有同落点,双保险)。 */}
        <RailIconButton label="全局设置" title="全局设置(API/提示词/版本预告)" onClick={() => navigate("/settings")}>
          <GearSix className="size-5" aria-hidden="true" />
        </RailIconButton>
        {/* Lite 模式切换入口(R2:写服务端 users.ui_mode;LiteShell 右侧同枚,两处同一回调)。 */}
        <RailIconButton
          label={user.ui_mode === "lite" ? "切换到完整版界面" : "切换到精简版界面"}
          title={user.ui_mode === "lite" ? "切换到完整版界面" : "切换到精简版界面"}
          onClick={() => { if (!uiModeSwitching) onSwitchUiMode(); }}
        >
          {uiModeSwitching
            ? <SpinnerGap className="size-5 animate-spin" aria-hidden="true" />
            : <ArrowsLeftRight className="size-5" aria-hidden="true" />}
        </RailIconButton>
        <RailCredits demoMode={demoMode} />
        <UserMenu user={user} compact menuSide="right" onLogout={onLogout} creditsRow={<AccountCreditsMenuRow demoMode={demoMode} />} />
      </div>
    </nav>
  );
}
