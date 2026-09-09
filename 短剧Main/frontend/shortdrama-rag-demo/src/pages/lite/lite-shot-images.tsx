/* ============================================================
   lite-shot-images.tsx — Lite 分镜卡候选图网格（#187 图片侧闭环）

   - 有终审权：待审图「通过并选用」一次完成审核与首帧指定；已过审图直接选用。
   - 无终审权：原位说明「等审核 · 谁能过」，不跳其它页面、不摆无效按钮。
   - 权限读取中/不可用分别保留稳定状态与重试入口；当前首帧、忙碌、空态和
     aria-pressed/aria-label 都在组件内统一。
   - demoMode 只决定图片展示地址；写动作仍由页面 approveAndSelect 的离线保护负责。
   ============================================================ */
import type { MediaVersion } from "../../types";
import type { CapabilityGate } from "../../capabilities-state";
import { CapabilityUnavailableInline } from "../../components/capability-notice";
import { Badge } from "../../components/ui/primitives";
import { cn } from "../../components/ui/cn";
import { LiteImage, liteImageDisplaySrc } from "./lite-image";

export function LiteShotImages({
  shotNo,
  images,
  reviewGate,
  reviewerHint,
  busyId,
  demoMode = false,
  onReloadCapabilities,
  onSelect,
}: {
  shotNo: string;
  images: readonly MediaVersion[];
  reviewGate: CapabilityGate;
  reviewerHint: string;
  busyId: string | null;
  demoMode?: boolean;
  onReloadCapabilities: () => void;
  onSelect: (image: MediaVersion) => void;
}): React.JSX.Element {
  const ordered = [...images].sort((left, right) => (left.created_at ?? "").localeCompare(right.created_at ?? ""));

  return (
    <section className="rounded-xl border border-border-1 bg-surface-1 px-3 py-3" aria-label={`第 ${shotNo} 镜候选图`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-sm font-medium text-ink-1">候选图</h4>
        <p className="text-xs text-ink-3">看一张，点一张定为首帧；其余候选继续保留。</p>
      </div>
      {ordered.length === 0 ? (
        <p className="text-xs leading-5 text-ink-3">还没有候选图。生成完成后会自动显示在这里，再挑一张定为首帧。</p>
      ) : (
        <div className="grid grid-cols-2 gap-2" role="list">
          {ordered.map((image, index) => {
            const isPrimary = image.is_primary === true;
            const needsReview = image.review_status === "needs_review";
            const rejected = image.review_status === "rejected";
            const selecting = busyId === image.id;
            const label = `第 ${shotNo} 镜候选图 ${index + 1}${isPrimary ? "（当前首帧）" : "，点选为首帧"}`;
            const tile = (
              <LiteImage
                src={liteImageDisplaySrc(image, demoMode)}
                alt=""
                className="aspect-video w-full bg-surface-2 object-cover"
              />
            );

            if (rejected) {
              return (
                <div
                  key={image.id}
                  role="listitem"
                  aria-label={`第 ${shotNo} 镜候选图 ${index + 1}（未通过审核）`}
                  className="overflow-hidden rounded-lg border border-border-1 bg-surface-2"
                >
                  {tile}
                  <span className="block px-2 py-1.5 text-[11px] leading-4 text-ink-2" role="status">
                    未通过审核，不能选用
                  </span>
                </div>
              );
            }

            if (needsReview && reviewGate === "denied") {
              return (
                <div key={image.id} role="listitem" className="overflow-hidden rounded-lg border border-border-1 bg-surface-2">
                  {tile}
                  <span className="block px-2 py-1.5 text-[11px] leading-4 text-ink-2" role="status">
                    等审核 · {reviewerHint}能过这张
                  </span>
                </div>
              );
            }

            if (needsReview && reviewGate === "unavailable") {
              return (
                <div key={image.id} role="listitem" className="overflow-hidden rounded-lg border border-border-1 bg-surface-2">
                  {tile}
                  <div className="px-2 py-1.5"><CapabilityUnavailableInline onRetry={onReloadCapabilities} /></div>
                </div>
              );
            }

            if (needsReview && reviewGate === "loading") {
              return (
                <div key={image.id} role="listitem" className="overflow-hidden rounded-lg border border-border-1 bg-surface-2">
                  {tile}
                  <span className="block min-h-8 px-2 py-1.5 text-[11px] leading-4 text-ink-3" role="status">
                    正在确认审核权限…
                  </span>
                </div>
              );
            }

            return (
              <div key={image.id} role="listitem">
                <button
                  type="button"
                  aria-pressed={isPrimary}
                  aria-label={label}
                  title={isPrimary ? "当前首帧" : needsReview ? "通过并选用" : "选用这张"}
                  disabled={isPrimary || busyId !== null}
                  className={cn(
                    "group relative size-full overflow-hidden rounded-lg border text-left outline-none transition-colors disabled:cursor-default disabled:opacity-65 focus-visible:ring-2 focus-visible:ring-accent/50",
                    isPrimary ? "border-accent ring-2 ring-accent/40" : "border-border-1 hover:border-accent/60",
                  )}
                  onClick={() => onSelect(image)}
                >
                  {tile}
                  <span className="flex min-h-8 items-center justify-between gap-2 px-2 py-1.5 text-[11px] leading-4 text-ink-2">
                    <span>{isPrimary ? "当前首帧" : needsReview ? "通过并选用" : "选用这张"}</span>
                    {selecting ? <span role="status">正在定稿…</span> : null}
                  </span>
                  {isPrimary ? <Badge tone="accent" className="absolute left-1.5 top-1.5">首帧</Badge> : null}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
