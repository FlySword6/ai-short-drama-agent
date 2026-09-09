/* ============================================================
   capability-status.tsx — 「AI 能力状态」状态条（S46-A / 走查 P0-1）

   一处状态条收敛,四处共用：工作台(图片/视频)、实验室、剧本拆解页。
   - 模型 × 档位 × 开关三维逐项亮灯,缺哪项写哪项,不再三种矛盾红字;
   - admin/operator 给「去配置」直达（→ 全局设置）,member 写明缺项找管理员;
   - 全部就绪时不渲染（参数行/页面本身已是就绪证据,不添噪音）;
   - 读取失败给「重试」,不虚构配置状态。
   ============================================================ */

import { ArrowClockwise, ArrowRight, CheckCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { api } from "../api";
import {
  capabilityReady,
  capabilityStatusCopy,
  dimensionLabel,
  resolveCapabilityStatus,
  type CapabilityKind,
  type CapabilityStatus,
  type DimensionState,
} from "../capability-status";
import type { PlatformRoleForCopy } from "../operations";
import { navigate } from "../routing";
import { cn } from "./ui/cn";

/* ---------- 取数 hook：模型(config-status) × 档位(capability-tiers) × 开关(ai_gateway) ---------- */

export function useCapabilityStatus(kind: CapabilityKind, demoMode: boolean): {
  status: CapabilityStatus | null;
  loading: boolean;
  reload: () => void;
} {
  const [status, setStatus] = useState<CapabilityStatus | null>(null);
  const [loading, setLoading] = useState(!demoMode);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (demoMode) {
      // 离线演示：能力槽位按全部就绪示例（与 demo 初始档 fixture 口径一致）。
      setStatus({
        kind,
        model: "ok",
        tier: kind === "ai_assist" ? "na" : "ok",
        switch: kind === "ai_assist" ? "ok" : "na",
        modelName: null,
      });
      setLoading(false);
      return () => {};
    }
    let cancelled = false;
    setLoading(true);
    const configQuery = api.configStatus();
    const tierQuery = kind === "ai_assist" ? Promise.resolve(null) : api.capabilityTiers(kind);
    void Promise.allSettled([configQuery, tierQuery]).then(([configResult, tierResult]) => {
      if (cancelled) return;
      const config = configResult.status === "fulfilled" ? configResult.value : null;
      const tiers = kind === "ai_assist"
        ? null
        : tierResult.status === "fulfilled" ? tierResult.value : null;
      setStatus(resolveCapabilityStatus({
        kind,
        slots: config?.slots ?? null,
        aiGatewayEnabled: config ? config.aiGatewayEnabled : null,
        tiers,
      }));
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [kind, demoMode, revision]);

  return { status, loading, reload: () => setRevision((value) => value + 1) };
}

/* ---------- 维度灯 ---------- */

const DIMENSION_ORDER: Array<"model" | "tier" | "switch"> = ["model", "tier", "switch"];

function DimensionChip({ dimension, state }: { dimension: "model" | "tier" | "switch"; state: DimensionState }): React.JSX.Element | null {
  if (state === "na") return null;
  if (state === "ok") {
    return (
      <span className="inline-flex items-center gap-1 text-success">
        <CheckCircle className="size-3.5" aria-hidden="true" />{dimensionLabel(dimension)}
      </span>
    );
  }
  if (state === "unknown") {
    return (
      <span className="inline-flex items-center gap-1 text-ink-3">
        <WarningCircle className="size-3.5" aria-hidden="true" />{dimensionLabel(dimension)}读取失败
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-danger">
      <XCircle className="size-3.5" aria-hidden="true" />{dimensionLabel(dimension)}{state === "off" ? "未开启" : "未配置"}
    </span>
  );
}

/* ---------- 状态条 ---------- */

export function CapabilityStatusBar({ kind, role, demoMode, onRetry, className }: {
  kind: CapabilityKind;
  role: PlatformRoleForCopy;
  demoMode: boolean;
  /** 父级附带重试（如工作台重拉档位选择器）;状态条自身一定重拉三维。 */
  onRetry?: () => void;
  className?: string;
}): React.JSX.Element | null {
  const { status, loading, reload } = useCapabilityStatus(kind, demoMode);

  if (loading && !status) {
    return (
      <div className={cn("flex items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs text-ink-4", className)}>
        能力状态读取中…
      </div>
    );
  }
  if (!status || capabilityReady(status)) return null;

  const copy = capabilityStatusCopy(status, role);
  const retry = () => { reload(); onRetry?.(); };
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs",
        className,
      )}
    >
      <strong className="text-danger">{copy.title}</strong>
      <span className="inline-flex items-center gap-2.5" aria-label="能力维度">
        {DIMENSION_ORDER.map((dimension) => (
          <DimensionChip key={dimension} dimension={dimension} state={status[dimension]} />
        ))}
      </span>
      <span className="text-ink-2">{copy.detail}</span>
      <span className="inline-flex items-center gap-2">
        {copy.action === "configure" ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-sm px-1 text-accent-text underline underline-offset-4 outline-none transition-colors hover:bg-accent-subtle focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => navigate("/settings")}
          >去配置<ArrowRight className="size-3" aria-hidden="true" /></button>
        ) : null}
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-sm px-1 text-accent-text underline underline-offset-4 outline-none transition-colors hover:bg-accent-subtle focus-visible:ring-2 focus-visible:ring-accent"
          onClick={retry}
        ><ArrowClockwise className="size-3" aria-hidden="true" />重新读取</button>
      </span>
    </div>
  );
}
