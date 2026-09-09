/* ============================================================
   config-option-chips.tsx — 配置项 chips 选择器（卡 #151）

   用途：新建项目弹窗与项目设置里的「画幅 / 清晰度」选择。
   铁律（goal 边界 ②）：可选项一律由后端能力矩阵渲染——
   options 来自 capability-tiers 推导（project-config.ts 的 listConfigOptions），
   本组件不写死任何取值；冻结值置灰并写明为什么灰。
   ============================================================ */
import * as React from "react";
import { cn } from "./ui/cn";
import type { ConfigOption } from "../project-config";

export function ConfigOptionChips({ label, options, value, onChange, disabled, hint, ariaLabel }: {
  label: string;
  options: readonly ConfigOption[];
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 选项下方的一行说明（说人话）；不传不渲染。 */
  hint?: string;
  ariaLabel?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-2">{label}</span>
      {options.length === 0 ? (
        <p className="m-0 text-xs text-ink-4">可选清单正在读取，或后端还没配好档位——先建项目也行，建好后在「项目设置 → 画面与风格」里补。</p>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={ariaLabel ?? label}>
          {options.map((option) => {
            const selected = value === option.value;
            const blocked = !option.available;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={blocked || disabled}
                title={blocked ? `还没开通${option.frozenReason ? `：${option.frozenReason}` : ""}` : option.value}
                className={cn(
                  "rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                  selected ? "border-accent bg-accent-subtle text-accent-text" : "border-border-1 bg-surface-1 text-ink-1",
                  blocked ? "cursor-not-allowed border-dashed text-ink-3" : disabled ? "cursor-not-allowed opacity-60" : "hover:border-border-2 hover:bg-surface-2",
                )}
                onClick={() => {
                  if (blocked || disabled) return;
                  onChange(option.value);
                }}
              >
                {option.value}
                {blocked ? <span className="ml-1 text-xs text-ink-4">· 还没开通</span> : null}
              </button>
            );
          })}
        </div>
      )}
      {renderBlockedHint(options)}
      {hint ? <p className="m-0 text-xs text-ink-4">{hint}</p> : null}
    </div>
  );
}

/** 有置灰项时给一行汇总说明（models.md §三/§五：灰掉要给理由）。 */
function renderBlockedHint(options: readonly ConfigOption[]): React.ReactNode {
  const blocked = options.filter((option) => !option.available);
  if (blocked.length === 0) return null;
  const text = blocked
    .map((option) => `${option.value} 还没开通${option.frozenReason ? `（${option.frozenReason}）` : ""}`)
    .join("；");
  return <p className="m-0 text-xs text-ink-4">{text}。能选哪几档由模型自己的能力决定，这份清单是读出来的，不是写死的。</p>;
}
