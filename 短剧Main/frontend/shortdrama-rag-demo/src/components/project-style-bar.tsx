/* ============================================================
   project-style-bar.tsx — 生成确认区的「这次出片」条（卡 #151；project.md §4.1/§4.2）

   两件事：
   1. 参数痕迹：当前档的画幅/清晰度是「项目默认」还是「这次改过」——
      改过的要看得出来（这次用的是项目默认,还是我改过了）；
   2. 项目风格：这次生成自动带上项目风格（描述+参考图），
      「这次不带」一键取消——只影响这一次，不回写项目配置。

   取消时提交体带 skip_project_defaults: true（后端 #149 接缝）；
   默认路径不带这个键，后端未合入前现状行为不变。
   ============================================================ */
import * as React from "react";
import { cn } from "./ui/cn";
import type { CapabilityTier } from "../capability-tiers";
import {
  aspectRatioLabel,
  defaultTraceLabel,
  projectStyleSummary,
  styleConfigured,
  type ProjectGenerationConfig,
} from "../project-config";

export function ProjectStyleBar({ config, kind, tier, skipped, onToggleSkip, className }: {
  config: ProjectGenerationConfig;
  kind: "image" | "video";
  /** 当前选中档；为 null（档未就绪）时只显示风格段。 */
  tier: CapabilityTier | null;
  skipped: boolean;
  onToggleSkip: (skip: boolean) => void;
  className?: string;
}): React.JSX.Element | null {
  const set = kind === "image" ? config.styleImage : config.styleVideo;
  const hasStyle = styleConfigured(set);
  const tierRatio = typeof tier?.params.aspect_ratio === "string" ? tier.params.aspect_ratio : null;
  const tierResolution = typeof tier?.params.resolution === "string" ? tier.params.resolution : null;
  const defaultRatio = config.aspectRatio;
  const defaultResolution = kind === "image" ? config.imageResolution : config.videoResolution;
  const traces = [
    tierRatio ? defaultTraceLabel(aspectRatioLabel(tierRatio), defaultRatio ? aspectRatioLabel(defaultRatio) : null) : "",
    tierResolution ? defaultTraceLabel(tierResolution, defaultResolution) : "",
  ].filter(Boolean);

  if (traces.length === 0 && !hasStyle) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-tk-border-1 bg-tk-elevated px-3 py-1.5 text-[11px]", className)} data-testid="project-style-bar">
      <span className="text-tk-ink-3">这次出片</span>
      {traces.map((trace) => (
        <span key={trace} className={trace.includes("这次改过") ? "text-tk-danger" : "text-tk-ink-2"}>{trace}</span>
      ))}
      {hasStyle ? (
        skipped ? (
          <span className="ml-auto flex items-center gap-2 text-tk-ink-3">
            这次不带项目风格（只影响这一次）
            <button
              type="button"
              className="rounded-sm px-1.5 py-0.5 text-tk-accent underline underline-offset-2 outline-none hover:bg-tk-hover focus-visible:ring-2 focus-visible:ring-tk-accent"
              onClick={() => onToggleSkip(false)}
            >重新带上</button>
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-2 text-tk-accent">
            带了项目风格：{projectStyleSummary(set)}
            <button
              type="button"
              className="rounded-sm px-1.5 py-0.5 text-tk-ink-2 underline underline-offset-2 outline-none hover:bg-tk-hover focus-visible:ring-2 focus-visible:ring-tk-accent"
              onClick={() => onToggleSkip(true)}
            >这次不带</button>
          </span>
        )
      ) : null}
    </div>
  );
}
