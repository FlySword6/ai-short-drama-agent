/* ============================================================
   assistant-context-card.tsx — Pi 面板上下文卡(S46 B-5,R44②)

   从 app.tsx AssistantPanel 抽出,以便组件渲染断言:
   - 上下文描述随页面 label 变(assistant-copy.ts),不再万年「我能检索资产」;
   - 付费红线提醒是常量第二行;
   - 建议操作按页面给,收到消息或离线演示时隐藏。
   显式 React import:仓根门禁(node:test + tsx,classic JSX)渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { assistantContextCopy } from "../assistant-copy";

export function AssistantContextCard({ label, suggestions, showSuggestions, busy, onPick }: {
  label: string;
  suggestions: string[];
  showSuggestions: boolean;
  busy: boolean;
  onPick: (suggestion: string) => void;
}): React.JSX.Element {
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-md border border-border-1 bg-surface-2 p-3 text-xs text-ink-2">
      <strong className="text-xs text-ink-1">当前上下文：{label}</strong>
      <span>{assistantContextCopy(label)}</span>
      <span className="text-ink-4">付费生成永远由你亲手点击。</span>
      {showSuggestions ? (
        <div className="flex flex-col gap-1">
          {suggestions.map((suggestion) => (
            <button key={suggestion} type="button" className="rounded-sm border border-border-1 px-3 py-2 text-left text-xs text-ink-2 transition-colors duration-[var(--duration-1)] ease-out-quart enabled:hover:border-border-2 enabled:hover:text-ink-1 disabled:text-ink-3" disabled={busy} onClick={() => onPick(suggestion)}>{suggestion}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
