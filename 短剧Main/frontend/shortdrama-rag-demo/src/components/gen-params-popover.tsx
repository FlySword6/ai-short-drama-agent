/* ============================================================
   gen-params-popover.tsx — S66 参数维度化 popover(libTV/R59:废档位叉乘平铺列表,
   比例/清晰度/时长/数量/生成音频各是独立维度行,收进摘要条点开的浮层)

   行数据 = ../generation-dimensions.ts 的 listGenerationDimensions:
   - 维度与可选值全部从 capability-tiers 的 active 档推导,不硬编码 libTV 全集;
   - 查无档的组合 = 选项置灰(feasible=false),不给选(铁律:没有档的参数组合界面不给选);
   - 全部 active 档只有一个取值的维度 = 固定标签(合同 §4 单值形态,不做假可调控件);
   - 选中值 = 当前档命中;点选项 → onPick(key, value),页面 resolveDimensionPick 反查切档。
   ============================================================ */

import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { CapabilityMediaType, CapabilityTier } from "../capability-tiers";
import { tierModelLabel } from "../capability-tiers";
import {
  dimensionPopoverFooter,
  listGenerationDimensions,
  tierDimensionSummary,
  type GenerationDimension,
  type GenerationDimensionKey,
  type GenerationDimensionValue,
} from "../generation-dimensions";
import { cn } from "./ui/cn";

/**
 * 维度 popover(libTV 底条的「模型选择」「16:9 · 720P · 4 秒」摘要钮)。
 * 向上弹出(底条贴着生成卡下沿);Esc / 点外部关闭;选完不收起,可连续调多个维度。
 */
export function DimensionPopover({ trigger, dimensions, onPick, footer, ariaLabel }: {
  /** 触发钮文案(模型短名,或 tierDimensionSummary 的参数摘要)。 */
  trigger: string;
  dimensions: readonly GenerationDimension[];
  onPick: (key: GenerationDimensionKey, value: GenerationDimensionValue) => void;
  /** 浮层底部诚实说明(如 MORE_TIERS_NOTE / 单值维度的「更多档规划中」)。 */
  footer?: React.ReactNode;
  ariaLabel: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <span className="relative inline-flex" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="inline-flex max-w-60 items-center gap-1 rounded-sm px-1.5 py-1 text-xs text-ink-1 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate">{trigger}</span>
        <CaretDown aria-hidden="true" className={cn("size-3 shrink-0 text-ink-4 transition-transform", open ? "rotate-180" : "")} />
      </button>
      {open ? (
        <span role="dialog" aria-label={ariaLabel} className="absolute bottom-full left-0 z-40 mb-1 flex w-60 flex-col gap-2.5 rounded-md border border-border-2 bg-surface-1 p-3 shadow-lg">
          {dimensions.map((dimension) => (
            <span key={dimension.key} className="flex flex-col gap-1">
              <span className="text-[11px] text-ink-4">{dimension.label}</span>
              {dimension.single ? (
                /* 合同 §4 单值形态:固定标签,不是看似可调的控件 */
                <span className="text-xs text-ink-1">{dimension.options[0]?.label ?? "—"}</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {dimension.options.map((option) => {
                    const disabled = !option.feasible;
                    return (
                      <button
                        key={String(option.value)}
                        type="button"
                        aria-disabled={disabled}
                        aria-pressed={option.selected}
                        title={disabled ? "当前档其余参数下没有这一组合" : undefined}
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent",
                          option.selected
                            ? "border-accent bg-accent-subtle text-accent-text"
                            : disabled
                              ? "cursor-not-allowed border-border-1 text-ink-3"
                              : "border-border-1 text-ink-2 hover:border-border-2 hover:text-ink-1",
                        )}
                        onClick={() => { if (!disabled) onPick(dimension.key, option.value); }}
                      >{option.label}</button>
                    );
                  })}
                </span>
              )}
            </span>
          ))}
          {footer ? <span className="border-t border-border-1 pt-2 text-[11px] leading-relaxed text-ink-4">{footer}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 工作台底条的两个维度 popover(模型选择 + 生成参数)连同它们的 footer 接线(S83c 抽出,
 * 原在 workbench-page.tsx 内联)。抽出的原因:footer 守卫从字符串断言升级为行为断言
 * (s83-workbench-params.test.ts 用 happy-dom 真渲染本组件),接线必须可被测试真渲染——
 * 哪个浮层拿哪份 dimensions、footer 接哪个判定结果,全部在本组件内,不再散落页面里。
 * 判定口径见 generation-dimensions.ts 的 dimensionPopoverFooter(S83b 验收 R1,S83d 修):
 * 有置灰项或单值维度都要给出路说明;「当前只开放这一档」只吃全量维度判定——模型 popover
 * 的子集只有 model_label 一条,子集单值≠只有一档(S83d 修的假话)。
 */
export function TierDimensionPopovers({ tiers, mediaType, selectedTier, onPick, allowModelSwitch = false }: {
  /** 当前媒介的全量档(组件内只渲染 active 档推导出的维度)。 */
  tiers: readonly CapabilityTier[];
  mediaType: CapabilityMediaType;
  selectedTier: CapabilityTier | null;
  onPick: (key: GenerationDimensionKey, value: GenerationDimensionValue) => void;
  /** 模型行放开「查无组合即置灰」:切模型=换模型族,参数重置为该模型默认档,
      不存在无档态(广场等模型优先的创作台用;工作台保持原纪律)。 */
  allowModelSwitch?: boolean;
}): React.JSX.Element {
  /* 参数维度化(R59 废整档叉乘列表):模型选择只放 model_label 行,参数摘要放其余维度行;
     值域全来自 active 档,查无组合的选项组件内置灰。
     S83d:两个浮层的 footer 由同一次全量判定派生——第一参=各浮层自己的维度子集
     (置灰项/单值行各是各的),第二参=全量 generationDimensions(「只有一档」的唯一真源;
     拿子集判会在模型 popover 上把五档齐开说成「当前只开放这一档」)。 */
  const generationDimensions = listGenerationDimensions(tiers, mediaType, selectedTier);
  const rawModelDimensions = generationDimensions.filter((dimension) => dimension.key === "model_label");
  const paramDimensions = generationDimensions.filter((dimension) => dimension.key !== "model_label");
  /* allowModelSwitch:模型行选项恒可行(同价取最便宜档作切换落点),选中态照旧。 */
  const modelDimensions = allowModelSwitch
    ? rawModelDimensions.map((dimension) => ({
        ...dimension,
        options: dimension.options.map((option) => ({ ...option, feasible: true })),
      }))
    : rawModelDimensions;
  return (
    <>
      <DimensionPopover
        trigger={selectedTier ? tierModelLabel(selectedTier) : "服务端配置"}
        dimensions={modelDimensions}
        onPick={onPick}
        footer={dimensionPopoverFooter(modelDimensions, generationDimensions)}
        ariaLabel="模型选择"
      />
      <DimensionPopover
        trigger={selectedTier ? tierDimensionSummary(selectedTier) : "参数未就绪"}
        dimensions={paramDimensions}
        onPick={onPick}
        footer={dimensionPopoverFooter(paramDimensions, generationDimensions)}
        ariaLabel="生成参数"
      />
    </>
  );
}
