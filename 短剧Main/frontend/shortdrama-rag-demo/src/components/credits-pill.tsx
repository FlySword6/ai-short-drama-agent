/* ============================================================
   credits-pill.tsx — S65「我的积分」顶栏余额 pill

   落点史：A3 拍板「接口就位前只在离线演示显示示例值，真栈不出现占位」；
   S57 接口（GET /account-credits/me）已合流，本组件把真值点亮：
   - 真栈：余额一眼可见，hover 给出今日剩余/日额度/结算日（Asia/Shanghai 自然日）；
   - 离线演示：固定示例值并明示「示例」；
   - 读取失败：不裸技术错误，给「点一下重试」的出路（错误态否决清单 #7）。
   显式 React import：node:test + tsx classic JSX 渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Coins } from "@phosphor-icons/react";
import { api } from "../api";
import { COST_UNIT_LABEL, formatCredits } from "../cost-units";
import { DEMO_CREDIT_SUMMARY, type AccountCreditSummary } from "../operations";

/** hover 明细（渲染断言锚点）：余额 + 今日剩余/日额度 + 结算日，口径与后端一致。 */
export function creditsPillTitle(summary: AccountCreditSummary): string {
  return `余额 ${formatCredits(summary.balancePoints)} ${COST_UNIT_LABEL} · 今日剩余 ${formatCredits(summary.remainingTodayPoints)} / ${formatCredits(summary.dailyLimitPoints)} ${COST_UNIT_LABEL}（${summary.dayDate}，按自然日重置）`;
}

/** S73:顶栏三组(品牌/导航/右组)在 901–1180px 被 pill+搜索框挤爆——nav 钮内文字折成两行
    (S65 验收隔离:藏掉 110px pill 后 nav 58px→37px)。修法=pill 窄屏收进账户菜单:
    pill 只在 >1180px 显示,≤1180px 由 AccountCreditsMenuRow 在账户菜单里给同一口径。 */
const pillClass = "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border-1 bg-surface-1 px-3 py-1 text-xs text-ink-2 max-[1180px]:hidden";

/** 纯展示四态（渲染断言直接喂 props）。 */
export function CreditsPillView({ state, summary, onRetry }: {
  state: "loading" | "ready" | "error" | "demo";
  summary?: AccountCreditSummary | null;
  onRetry?: () => void;
}): React.JSX.Element {
  if (state === "loading") {
    return (
      <span className={pillClass} aria-label="积分读取中">
        <Coins className="size-4 text-accent-text" aria-hidden="true" />
        <span className="text-ink-4">…</span>
      </span>
    );
  }
  if (state === "error") {
    return (
      <button type="button" className={pillClass} title="积分信息暂时读不到，点一下重试" onClick={onRetry}>
        <Coins className="size-4 text-accent-text" aria-hidden="true" />
        <span>积分读取失败 · 重试</span>
      </button>
    );
  }
  const value = state === "demo" ? DEMO_CREDIT_SUMMARY : summary;
  if (!value) {
    /* 真栈读不到数据时不摆占位数字（A3 口径）：与 error 同位给重试。 */
    return (
      <button type="button" className={pillClass} title="积分信息暂时读不到，点一下重试" onClick={onRetry}>
        <Coins className="size-4 text-accent-text" aria-hidden="true" />
        <span>积分读取失败 · 重试</span>
      </button>
    );
  }
  return (
    <span className={pillClass} title={creditsPillTitle(value)} aria-label={`我的积分：${creditsPillTitle(value)}`}>
      <Coins className="size-4 text-accent-text" aria-hidden="true" />
      <strong className="font-mono font-semibold text-ink-1">{formatCredits(value.balancePoints)}</strong>
      {COST_UNIT_LABEL}
      {state === "demo" ? "（示例）" : ""}
    </span>
  );
}

/** 取数状态源(pill 与窄屏菜单行共用):真栈挂载即拉取,失败给重试出路。
    R2 壳:导出供 app-rail 底部积分位复用(同一取数源,不另起炉灶)。 */
export function useAccountCredits(demoMode: boolean): {
  state: "loading" | "ready" | "error";
  summary: AccountCreditSummary | null;
  retry: () => void;
} {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [summary, setSummary] = useState<AccountCreditSummary | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setSummary(await api.accountCreditsMe());
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (demoMode) return;
    void load();
  }, [demoMode, load]);

  return { state, summary, retry: () => void load() };
}

/** 顶栏容器：真栈挂载即拉取，失败可点 pill 重试；离线演示显示示例值。 */
export function AccountCreditsPill({ demoMode }: { demoMode: boolean }): React.JSX.Element {
  const { state, summary, retry } = useAccountCredits(demoMode);
  if (demoMode) return <CreditsPillView state="demo" />;
  return <CreditsPillView state={state} summary={summary} onRetry={retry} />;
}

/** 账户菜单积分行：余额 + 今日剩余/日额度三数同见（issue #26「登录后可见余额/日额度/当日剩余」落点）。
    曾按 S73 只在 ≤1180px 显示（宽屏由顶栏 pill 承担）；R2 壳后 pill 退役、rail 只剩余额快览，
    本行升级为全宽度的唯一明细位，与 rail 快览同一取数源同一口径。
    F09/F11:提菜单顶部+正文亮度;下挂一行口径解释（怎么扣/何时重置）,不再让人猜两个数的关系。 */
export function AccountCreditsMenuRow({ demoMode }: { demoMode: boolean }): React.JSX.Element {
  const { state, summary, retry } = useAccountCredits(demoMode);
  const value = demoMode ? DEMO_CREDIT_SUMMARY : summary;
  return (
    <span
      className="flex flex-col gap-0.5 px-3 py-2 text-xs text-ink-1"
      title={value ? creditsPillTitle(value) : undefined}
      aria-label={value ? `我的积分：${creditsPillTitle(value)}` : "我的积分读取中"}
    >
      <span className="flex items-center gap-2">
        <Coins className="size-4 shrink-0 text-accent-text" aria-hidden="true" />
        {demoMode || state === "ready" ? (
          value ? (
            <span>
              余额 <strong className="font-mono font-semibold text-ink-1">{formatCredits(value.balancePoints)}</strong> {COST_UNIT_LABEL}
              <span className="text-ink-3"> · 今日剩余 </span>
              <strong className="font-mono font-semibold text-ink-1">{formatCredits(value.remainingTodayPoints)}</strong>
              <span className="text-ink-3">/{formatCredits(value.dailyLimitPoints)}{demoMode ? "（示例）" : ""}</span>
            </span>
          ) : null
        ) : state === "error" ? (
          <button type="button" className="text-accent-text underline underline-offset-2" onClick={retry}>积分读取失败 · 重试</button>
        ) : (
          <span className="text-ink-4">积分读取中…</span>
        )}
      </span>
      {value ? <span className="pl-6 text-[11px] text-ink-3">生成按报价扣积分 · 今日剩余每天 0 点重置</span> : null}
    </span>
  );
}
