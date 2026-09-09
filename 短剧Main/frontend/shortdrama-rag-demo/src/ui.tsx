import {
  ArrowClockwise,
  CheckCircle,
  ImageSquare,
  SpinnerGap,
  VideoCamera,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
/* 显式 React import：门禁（node:test + tsx classic JSX）渲染断言与 Vite react-jsx 双兼容
   （S65 注册表单复用本文件的 Button，全量门禁在 classic transform 下需要值级 React）。 */
import * as React from "react";
import type { DependencyList, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useState } from "react";
import type { Asset, GenerationStatus } from "./types";
import { assetMediaIsNonImage, isDisplayableImageUrl } from "./asset-media";
import { businessErrorMessage } from "./error-copy";

export type ButtonVariant = "primary" | "secondary" | "accent" | "danger" | "ghost";

export function Button({
  children,
  variant = "secondary",
  className = "",
  icon,
  loading = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
  icon?: ReactNode;
  loading?: boolean;
}): React.JSX.Element {
  return (
    <button className={`button button-${variant} ${className}`} {...props} disabled={loading || props.disabled}>
      {loading ? <SpinnerGap className="spin" aria-hidden="true" /> : icon}
      <span>{children}</span>
    </button>
  );
}

export function IconButton({ label, className = "", children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <button className={`icon-button ${className}`} aria-label={label} title={label} {...props}>
      {children}
    </button>
  );
}

export function Modal({ title, children, onClose, footer, size = "medium" }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; size?: "small" | "medium" | "large" | "wide" }): React.JSX.Element {
  const titleId = useId();
  // 板15：弹窗退 160ms——先播退出动画再真正卸载
  const [closing, setClosing] = useState(false);
  const requestClose = useCallback(() => {
    setClosing((current) => {
      if (!current) window.setTimeout(onClose, 160);
      return true;
    });
  }, [onClose]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [requestClose]);
  return (
    <div className={closing ? "modal-layer modal-layer--closing" : "modal-layer"} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <IconButton label="关闭" onClick={requestClose}><X /></IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </section>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): React.JSX.Element {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span className="field-label">{label}</span>
      {typeof children === "string" ? <input id={id} value={children} readOnly /> : children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

export function StatusBadge({ status, children }: { status?: string | null; children?: ReactNode }): React.JSX.Element {
  const value = status || "pending";
  const kind = ["ready", "succeeded", "complete", "已完成", "已入库"].includes(value)
    ? "success"
    : ["failed", "error", "失败", "超时"].includes(value)
      ? "danger"
      : ["running", "进行中"].includes(value)
        ? "info"
        : "warning";
  return <span className={`status-badge status-${kind}`}>{children ?? statusLabel(value)}</span>;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "待处理",
    running: "执行中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
    ready: "已入库",
    draft: "待入库",
    approved: "已入库",
    pending_review: "待审核",
    imported: "已导入",
    active: "进行中",
    archived: "已归档",
    previewed: "已预览",
    confirmed: "已确认",
    rejected: "已拒绝",
    submitting: "提交中",
    provider_queued: "排队中",
    provider_running: "生成中",
    provider_succeeded: "生成完成",
    persisting: "保存中",
    complete: "已完成",
  };
  // 未知的英文内部状态不直接暴露给用户，兜底显示中性词。
  return labels[status] ?? (/^[\x20-\x7e]+$/.test(status) ? "处理中" : status);
}

export function TaskState({ status, failureReason, onRetry, busy, mediaKind }: { status: GenerationStatus; failureReason?: string | null; onRetry?: () => void; busy?: boolean; mediaKind?: "image" | "video" }): React.JSX.Element {
  if (status === "failed") {
    return (
      <div className="task-state task-failed">
        <WarningCircle aria-hidden="true" />
        <div><strong>生成失败</strong><p>{failureReason || "服务没有返回具体原因"}</p></div>
        {onRetry ? <Button variant="danger" icon={<ArrowClockwise />} loading={busy} onClick={onRetry}>重试</Button> : null}
      </div>
    );
  }
  if (status === "succeeded") {
    return <div className="task-state task-success"><CheckCircle aria-hidden="true" /><strong>生成完成，结果已保存</strong></div>;
  }
  return (
    <div className="task-state task-running">
      <SpinnerGap className="spin" aria-hidden="true" />
      <div><strong>{status === "pending" ? "已提交，等待处理" : "正在生成"}</strong><p>{mediaKind === "video" ? "视频生成通常需要几分钟。" : ""}可离开当前页，刷新后会从服务端恢复进度。</p></div>
    </div>
  );
}

export function LoadingState({ label = "正在读取数据", onRetry }: { label?: string; onRetry?: () => void }): React.JSX.Element {
  // 板14：超过 8s 必须给出「仍在加载 · 重试」，禁止无限转圈
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="state-panel">
      <SpinnerGap className="spin state-icon" aria-hidden="true" />
      <strong>{slow ? "仍在加载" : label}</strong>
      {slow && onRetry ? <Button icon={<ArrowClockwise />} onClick={onRetry}>重试</Button> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="state-panel state-error">
      <WarningCircle className="state-icon" aria-hidden="true" />
      <strong>暂时无法读取</strong>
      <p>{message}</p>
      {onRetry ? <Button icon={<ArrowClockwise />} onClick={onRetry}>重新加载</Button> : null}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description: string; action?: ReactNode; icon?: ReactNode }): React.JSX.Element {
  return (
    <div className="state-panel state-empty">
      <div className="state-icon-box">{icon ?? <ImageSquare aria-hidden="true" />}</div>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

/** 相对时间：「刚刚 / N 分钟前 / N 小时前 / N 天前 / N 个月前 / N 年前」；无值或非法日期回空串，调用方整段隐藏。
 *  K2G：自 pages/global-pages.tsx 迁入 ui（首页「继续上次工作」也要用），实现与口径一字未改。 */
export function relativeTimeLabel(value: string | null | undefined, now: number = Date.now()): string {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

export function AssetThumb({ asset, kind = "image", className = "" }: { asset?: Asset; kind?: "image" | "video"; className?: string }): React.JSX.Element {
  const url = findImageUrl(asset);
  if (url) return <img className={`asset-thumb-image ${className}`} src={url} alt={asset?.display_name || asset?.name || "资产图片"} loading="lazy" />;
  const Icon = kind === "video" ? VideoCamera : ImageSquare;
  return <div className={`asset-thumb-placeholder asset-tone-${assetTone(asset)} ${className}`}><Icon aria-hidden="true" /></div>;
}

/** 展示名兜底链：display_name → name → 父实体名 → source_id。入参放宽到 Pick，便于只拿到部分字段的纯函数复用。 */
export function assetName(asset?: Pick<Asset, "display_name" | "name" | "parent_entity_name" | "source_id">): string {
  return text(asset?.display_name) || text(asset?.name) || text(asset?.parent_entity_name) || text(asset?.source_id) || "未命名资产";
}

/* 资产类型中文标签已迁 ./asset-kind-labels（纯逻辑模块,command-palette 等零 DOM 方复用）;
   此处原样 re-export,既有 ../ui 引用方零改动。 */
export { assetKindLabel, assetKindRawTitle } from "./asset-kind-labels";

export function findImageUrl(asset?: Asset): string {
  if (!asset) return "";
  /* S46 C-0：3D 素模（.glb）等非图片媒体的 URL 进 <img> 必裂；
     返回空串，调用方（AssetKindThumb 等）走「类型图标 + 色调」占位。 */
  if (assetMediaIsNonImage(asset)) return "";
  const direct = [asset.storage_url, asset.source_file_url, asset.thumbnail_url].find(
    (value) => typeof value === "string" && /^https?:\/\//.test(value) && isDisplayableImageUrl(value),
  );
  if (direct) return direct;
  const metadata = asset.metadata;
  if (!metadata || typeof metadata !== "object") return "";
  for (const key of ["storage_url", "source_file_url", "image_url", "thumbnail_url", "cover_url"]) {
    const value = metadata[key];
    if (typeof value === "string" && /^https?:\/\//.test(value) && isDisplayableImageUrl(value)) return value;
  }
  return "";
}

export function useResource<T>(loader: () => Promise<T>, demoValue: T, demoMode: boolean, dependencies: DependencyList): { data: T | null; loading: boolean; error: string; retry: () => void; setData: React.Dispatch<React.SetStateAction<T | null>> } {
  const [data, setData] = useState<T | null>(demoMode ? demoValue : null);
  const [loading, setLoading] = useState(!demoMode);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    if (demoMode) {
      setData(demoValue);
      setLoading(false);
      setError("");
      return () => { active = false; };
    }
    setLoading(true);
    setError("");
    void loader().then((result) => {
      if (active) setData(result);
    }).catch((reason: unknown) => {
      /* 业务语言化（#18）：ErrorState 取数源头统一过业务话术——中文透传，
         英文/技术串映射或兜底中文，原文进 console 留排障 detail，不再裸上屏。 */
      if (active) setError(businessErrorMessage(reason, "读取失败，请重试"));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
    // The caller controls the exact reload keys via dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demoMode, revision, ...dependencies]);

  return { data, loading, error, retry, setData };
}

export function stopForm(event: FormEvent): void {
  event.preventDefault();
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function assetTone(asset?: Asset): number {
  const value = asset?.id || asset?.name || "asset";
  return Array.from(value).reduce((sum, character) => sum + character.charCodeAt(0), 0) % 5;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
