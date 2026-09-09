/* ============================================================
   lite-shot-params.tsx — Lite 分镜卡「出图参数」深挖面板
   （P-18a 段③左半收纳摘要 + P-18b 下半就地展开面板，不弹窗不跳页）。

   口径（原型说明 §五 + lite.md 总纲第 2 条「不阉割模型」）：
   - 选项全部由档位引擎（generation-dimensions）从 active 档推导，不是自由输入；
     查无组合的胶囊置灰给原因，绝不换档静默提交。
   - 画幅行按短剧场景收敛（统筹 R225 实测：引擎折出的比例维度有 20 个选项，
     不整排铺屏）——只留竖屏/横屏/方/4:5/3:4/2:3 短剧画幅。
   - 「这些只管这一镜」：本面板产出的是单镜覆盖档，不动项目默认；
     「恢复项目默认」幽灵按钮一键回到项目配置。
   - 时长不在这儿：时长属于出片（右栏），面板底注记是护栏，不能删。
   ============================================================ */
import { CaretDown, CaretUp } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { CapabilityTier } from "../../capability-tiers";
import {
  listGenerationDimensions,
  resolveDimensionPick,
  tierDimensionValue,
  type GenerationDimensionKey,
} from "../../generation-dimensions";
import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";

/** 短剧画幅白名单（R225：引擎全集 20 项不铺屏；命中的引擎选项才上屏）。 */
const LITE_ASPECT_RATIO_ORDER: readonly string[] = ["9:16", "16:9", "1:1", "4:5", "3:4", "2:3"];

/** 画幅胶囊标签（短剧话术；白名单外值原样透传）。 */
function aspectRatioCapsuleLabel(value: string): string {
  if (value === "9:16") return "竖屏 9:16";
  if (value === "16:9") return "横屏 16:9";
  if (value === "1:1") return "方 1:1";
  return value;
}

/** 深挖面板四行的标签与一句说明（原型 §五控件表；行序固定）。 */
const PANEL_ROWS: ReadonlyArray<{ key: GenerationDimensionKey; title: string; note: string }> = [
  { key: "model_label", title: "模型", note: "换模型出的味道不一样" },
  { key: "aspect_ratio", title: "画幅", note: "短剧默认竖屏" },
  { key: "resolution", title: "清晰度", note: "越高越贵、越慢" },
  { key: "quantity", title: "一次出几张", note: "一次多出几张，挑的余地大" },
];

/** 收纳态摘要（Geist Mono 口径）：「竖屏 9:16 · 2K · 一次出 1 张」——缺维度不虚构。 */
export function liteImageTierSummary(tier: CapabilityTier): string {
  const parts: string[] = [];
  const ratio = tierDimensionValue(tier, "aspect_ratio");
  if (typeof ratio === "string" && ratio) parts.push(aspectRatioCapsuleLabel(ratio));
  const resolution = tierDimensionValue(tier, "resolution");
  if (typeof resolution === "string" && resolution) parts.push(resolution);
  const quantity = tierDimensionValue(tier, "quantity");
  if (typeof quantity === "number" && quantity > 0) parts.push(`一次出 ${quantity} 张`);
  return parts.join(" · ");
}

export function LiteImageParamsPanel({ tiers, tier, disabled, onPickTier, onReset, showReset }: {
  /** 图片媒介全量档（active 由引擎内部过滤）。 */
  tiers: readonly CapabilityTier[];
  /** 当前生效档（单镜覆盖档 ?? 项目默认档）。 */
  tier: CapabilityTier;
  disabled: boolean;
  onPickTier: (tier: CapabilityTier) => void;
  onReset: () => void;
  /** 有单镜覆盖时给「恢复项目默认」。 */
  showReset: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  /* 折叠是常态,而档位维度推导要把全部 active 档扫一遍再互相核对可行性——
     每一镜一个实例、轮询还会反复重渲染,展开了再算。 */
  const dimensions = useMemo(
    () => (expanded ? listGenerationDimensions(tiers, "image", tier) : []),
    [expanded, tiers, tier],
  );
  const capsuleLabel = (key: GenerationDimensionKey, value: string | number | boolean, engineLabel: string): string =>
    key === "aspect_ratio" ? aspectRatioCapsuleLabel(String(value)) : key === "quantity" ? String(Number(value)) : engineLabel;

  return (
    <div className="flex flex-col gap-2">
      {/* 收纳态：一行摘要 + 调参数入口（默认值前置，不点开也知道会出什么）。 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] text-ink-2">{liteImageTierSummary(tier)}</span>
        <Button size="sm" variant="outline" icon={expanded ? <CaretUp /> : <CaretDown />} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "调参数"}
        </Button>
      </div>

      {expanded ? (
        <div className="rounded-xl border border-border-1 bg-surface-1 px-4 py-3" aria-label="出这一镜的图 · 参数">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h4 className="text-sm font-medium text-ink-1">出这一镜的图 · 参数</h4>
            <p className="min-w-0 flex-1 text-xs text-ink-3">不点开也能出图，用的就是下面这些默认值。</p>
          </div>
          <div className="flex flex-col gap-3">
            {PANEL_ROWS.map((row) => {
              const dimension = dimensions.find((item) => item.key === row.key);
              const options = (dimension?.options ?? [])
                .filter((option) => row.key !== "aspect_ratio" || LITE_ASPECT_RATIO_ORDER.includes(String(option.value)))
                .sort((left, right) => row.key === "aspect_ratio"
                  ? LITE_ASPECT_RATIO_ORDER.indexOf(String(left.value)) - LITE_ASPECT_RATIO_ORDER.indexOf(String(right.value))
                  : 0);
              return (
                <div className="flex gap-3" key={row.key}>
                  <div className="w-24 shrink-0">
                    <p className="text-[13px] text-ink-2">{row.title}</p>
                    <p className="mt-0.5 text-[11px] text-ink-4">{row.note}</p>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    {!dimension || options.length === 0 ? (
                      <span className="text-xs text-ink-4">当前参数选项没有这一维度的选择</span>
                    ) : dimension.single ? (
                      <span className="rounded-full border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-1">
                        {capsuleLabel(row.key, options[0]!.value, options[0]!.label)}
                      </span>
                    ) : (
                      options.map((option) => {
                        const selected = option.selected;
                        return (
                          <button
                            key={String(option.value)}
                            type="button"
                            aria-pressed={selected}
                            disabled={disabled || !option.feasible}
                            title={option.feasible ? undefined : "这个组合现在没有可用参数，换一个再试。"}
                            className={cn(
                              "rounded-full border px-3 py-2 text-xs transition-colors disabled:opacity-50",
                              selected
                                ? "border-accent/50 bg-accent/10 text-accent-text"
                                : "border-border-1 text-ink-2 hover:border-border-2",
                            )}
                            onClick={() => {
                              const next = resolveDimensionPick(tiers, tier, "image", row.key, option.value);
                              if (next) onPickTier(next);
                            }}
                          >{capsuleLabel(row.key, option.value, option.label)}</button>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-1 pt-2 text-[11px] text-ink-4">
            <span>这些只管这一镜。要改成全项目默认，去「项目设置 · 画面与风格」。</span>
            <span className="min-w-0 flex-1">时长不在这儿——时长属于出片，在右边「出片」那一栏。</span>
            {showReset ? (
              <Button size="sm" variant="ghost" disabled={disabled} onClick={onReset}>恢复项目默认</Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
