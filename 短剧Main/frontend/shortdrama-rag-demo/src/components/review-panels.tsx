/* ============================================================
   W5-A 资产审核域 UI：四态 pill / 轨迹面板 / 拒绝理由弹窗 / 默认审核档位菜单项
   纯函数与 demo fixture 在 review-actions.tsx；视图层全部 Tailwind v4 + ui 原语
   （Badge / Button / Dialog / Field），无组件级 CSS 文件。
   审核接口都是项目作用域（路径带 project_id），本文件不接收全局页上下文。
   S7-9：入库默认档位自筛选行撤入「更多」菜单（ReviewPolicyMenuItems），
   原 ReviewSwitch/ReviewPolicySwitches 开关行随之退役。
   ============================================================ */

import { Check, Info, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
/* 显式 React import：门禁（node:test + tsx classic JSX）真渲染断言与 Vite react-jsx 双兼容——
   s10-lifen.test.ts D4d 渲染 AssetKindTreeView 会走到本文件的 ReviewPill（同 ui.tsx 等既有模式）。 */
import * as React from "react";
import { api } from "../api";
import { businessErrorMessage } from "../error-copy";
import type { AssetReviewActionRecord, ProjectReviewPolicy, ReviewDefaultStrategy, ReviewMediaKind } from "../types";
import { formatDateTime, useResource } from "../ui";
import {
  DEMO_REVIEW_POLICIES,
  assetReviewBucket,
  demoAssetReviewSessionRevision,
  demoAssetReviewTrail,
  effectiveStrategy,
  isVersionConflict,
  mediaKindLabel,
  policyFor,
  rejectionReasonError,
  reviewActionLabel,
  reviewBucketLabel,
  reviewerLabel,
  sortTrailRecords,
  trailFlowLabel,
  type AssetReviewBucket,
} from "./review-actions";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { DropdownMenuItem } from "./ui/dropdown-menu";
import { Badge, Field, Textarea, type BadgeProps } from "./ui/primitives";

/* ---------- 板14：加载超过 8s 亮出「仍在加载 · 重试」，禁止无限转圈（与 P1/P2 同模式） ---------- */

function useSlowLoading(active: boolean, ms = 8_000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);
  return slow;
}

/* ---------- 四态 pill（板02：自动审核/待审核/已通过/已拒绝） ---------- */

const PILL_TONES: Record<AssetReviewBucket, BadgeProps["tone"]> = {
  auto: "accent",
  pending: "warning",
  approved: "success",
  rejected: "danger",
};

export function ReviewPill({ status }: { status?: string | null }): React.JSX.Element {
  const bucket = assetReviewBucket(status);
  return <Badge tone={PILL_TONES[bucket]} data-bucket={bucket}>{reviewBucketLabel(bucket)}</Badge>;
}

/* ---------- 审核轨迹：info 图标点选展开（卡片上不占常驻面积） ---------- */

export function ReviewTrailToggle({ open, onToggle }: { open: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="inline-flex size-[22px] items-center justify-center rounded-sm text-ink-4 transition-colors duration-150 ease-out-quart hover:bg-surface-2 hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&_svg]:size-3.5"
      aria-label={open ? "收起审核轨迹" : "查看审核轨迹"}
      aria-expanded={open}
      onClick={onToggle}
    ><Info aria-hidden="true" /></button>
  );
}

/* ---------- 轨迹动作配色（提交=warning / 通过=success / 拒绝=danger） ---------- */

const TRAIL_ACTION_COLORS: Record<string, string> = {
  submitted: "text-warning",
  approved: "text-success",
  rejected: "text-danger",
};

/** 轨迹面板三态共享容器（加载/错误/空态同构，板14）。 */
function trailStateClass(error: boolean): string {
  return cn(
    "flex items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-xs",
    error ? "text-danger" : "text-ink-4",
  );
}

const trailRetryClass = "font-semibold text-accent-text hover:underline underline-offset-2";

/** 审核轨迹面板：谁、何时、从哪态到哪态、理由。加载/错误/空态齐全（板14）。
    K2U D-17：demo 轨迹 = 初始 fixture + 会话裁决留痕（demoAssetReviewTrail），
    会话内裁决后展开能看到新记录；sessionRevision 变化触发重读。 */
export function ReviewTrailPanel({ projectId, assetId, demoMode, onRecords }: {
  projectId: string;
  assetId: string;
  demoMode: boolean;
  onRecords?: (records: AssetReviewActionRecord[]) => void;
}): React.JSX.Element {
  const sessionRevision = demoAssetReviewSessionRevision();
  const demoRecords = useMemo(() => demoAssetReviewTrail(assetId), [assetId, sessionRevision]);
  const state = useResource(
    () => api.assetReviewActions(projectId, assetId),
    { items: demoRecords, count: demoRecords.length },
    demoMode,
    [projectId, assetId, demoRecords],
  );
  const slow = useSlowLoading(state.loading);
  const records = useMemo(() => sortTrailRecords(state.data?.items ?? []), [state.data]);
  const { loading, error, retry } = state;

  /* 轨迹读完后把「审核人 / 拒绝理由」回授给卡片提示行；回调走 ref，只在数据变化时触发。 */
  const onRecordsRef = useRef(onRecords);
  onRecordsRef.current = onRecords;
  useEffect(() => {
    if (!loading && !error) onRecordsRef.current?.(records);
  }, [loading, error, records]);

  if (loading) {
    return (
      <p className={trailStateClass(false)}>
        <SpinnerGap className="size-3.5 animate-spin" aria-hidden="true" />
        {slow ? <>仍在加载 ·<button type="button" className={trailRetryClass} onClick={retry}>重试</button></> : "读取审核轨迹…"}
      </p>
    );
  }
  if (error) {
    return (
      <p className={trailStateClass(true)} role="alert">
        审核轨迹读取失败
        <button type="button" className={trailRetryClass} onClick={retry}>重试</button>
      </p>
    );
  }
  if (records.length === 0) {
    return <p className={trailStateClass(false)}>还没有审核记录；提审、裁决都会在这里留痕。</p>;
  }
  return (
    <ul className="flex flex-col gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2">
      {records.map((record) => (
        <li className="flex flex-col gap-0.5 border-border-1 text-xs text-ink-2 not-first:border-t not-first:pt-2" key={record.id}>
          <span className="flex items-center gap-2">
            <strong className={cn("font-semibold", TRAIL_ACTION_COLORS[record.action] ?? "text-ink-1")} data-action={record.action}>{reviewActionLabel(record.action)}</strong>
            <span>{trailFlowLabel(record)}</span>
          </span>
          <span className="text-ink-4">{reviewerLabel(record)} · {formatDateTime(record.createdAt)}</span>
          {record.rejectionReason ? <span className="text-danger">拒绝理由:{record.rejectionReason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/* ---------- 拒绝理由弹窗：空理由禁止提交（理由留痕给提交人） ---------- */

export function RejectReasonModal({ assetName, busy, onClose, onSubmit }: {
  assetName: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}): React.JSX.Element {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  function submit(): void {
    const message = rejectionReasonError(reason);
    if (message) {
      setError(message);
      return;
    }
    onSubmit(reason.trim());
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>{`拒绝「${assetName}」`}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field label="拒绝理由（必填，会留痕给提交人）" error={error || undefined}>
            <Textarea
              value={reason}
              maxLength={500}
              autoFocus
              placeholder="例如：服装朝代不符，回参考库重配"
              onChange={(event) => { setReason(event.target.value); setError(""); }}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="danger" loading={busy} onClick={submit}>确认拒绝</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- 新资产默认审核档位：数据 hook + 菜单项（S7-9：开关是策略配置不是筛选，收进「更多」菜单） ---------- */

export interface ReviewPoliciesState {
  policies: ProjectReviewPolicy[];
  loading: boolean;
  error: boolean;
  busyKind: string;
  retry: () => void;
  toggle: (kind: ReviewMediaKind) => Promise<void>;
}

/** 档位数据与切换（乐观锁，409 重新拉取并提示，板14 冲突态）；视图层只剩菜单项一种形态。 */
export function useReviewPolicies(projectId: string, demoMode: boolean, notify: (message: string, kind?: "info" | "success" | "error") => void): ReviewPoliciesState {
  const state = useResource(
    () => api.reviewPolicies(projectId),
    { items: DEMO_REVIEW_POLICIES, count: DEMO_REVIEW_POLICIES.length },
    demoMode,
    [projectId],
  );
  const [busyKind, setBusyKind] = useState("");
  const policies = state.data?.items ?? [];

  async function toggle(kind: ReviewMediaKind): Promise<void> {
    const current = effectiveStrategy(policyFor(policies, kind));
    const next: ReviewDefaultStrategy = current === "pending_review" ? "automatic" : "pending_review";
    if (demoMode) {
      state.setData((existing) => {
        const items = existing?.items ?? [];
        const rest = items.filter((policy) => policy.mediaKind !== kind);
        const previous = policyFor(items, kind);
        const updated: ProjectReviewPolicy = {
          id: previous?.id ?? `demo-policy-${kind}`,
          projectId,
          mediaKind: kind,
          defaultStrategy: next,
          updatedByUserId: "demo-user",
          version: (previous?.version ?? 0) + 1,
          createdAt: previous?.createdAt ?? null,
          updatedAt: null,
        };
        return { items: [...rest, updated], count: rest.length + 1 };
      });
      notify("离线演示不提交审核配置，开关只改当前页面显示", "info");
      return;
    }
    setBusyKind(kind);
    try {
      const updated = await api.putReviewPolicy(projectId, kind, {
        default_strategy: next,
        expected_version: policyFor(policies, kind)?.version ?? 0,
      });
      state.setData((existing) => {
        const rest = (existing?.items ?? []).filter((policy) => policy.mediaKind !== kind);
        return { items: [...rest, updated], count: rest.length + 1 };
      });
      notify(next === "pending_review" ? `${mediaKindLabel(kind)}新资产默认先送审核` : `${mediaKindLabel(kind)}新资产默认自动过审`, "success");
    } catch (reason) {
      if (isVersionConflict(reason)) {
        notify("配置已被他人更新，已刷新", "info");
        state.retry();
      } else {
        notify(businessErrorMessage(reason, "审核配置保存失败"), "error");
      }
    } finally {
      setBusyKind("");
    }
  }

  return { policies, loading: state.loading, error: Boolean(state.error), busyKind, retry: state.retry, toggle };
}

/**
 * 「更多」菜单里的档位项：每行 = 当前档位 + 点击切换（onSelect preventDefault 菜单不关，即时看到翻转）。
 * 勾选标记 = 默认待审（更严的那档），与旧开关 on 态同语义。
 */
export function ReviewPolicyMenuItems({ projectId, demoMode, notify }: {
  projectId: string;
  demoMode: boolean;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}): React.JSX.Element {
  const { policies, loading, error, busyKind, retry, toggle } = useReviewPolicies(projectId, demoMode, notify);
  if (loading) {
    return (
      <DropdownMenuItem disabled onSelect={(event) => event.preventDefault()}>
        <SpinnerGap className="animate-spin" aria-hidden="true" />读取审核配置…
      </DropdownMenuItem>
    );
  }
  if (error) {
    return (
      <DropdownMenuItem onSelect={(event) => { event.preventDefault(); retry(); }}>
        <WarningCircle aria-hidden="true" />审核配置读取失败 · 点击重试
      </DropdownMenuItem>
    );
  }
  return (
    <>
      {(["image", "video"] as const).map((kind) => {
        const pendingReview = effectiveStrategy(policyFor(policies, kind)) === "pending_review";
        return (
          <DropdownMenuItem
            key={kind}
            disabled={busyKind === kind}
            title={`点击切换：新入库${mediaKindLabel(kind)}${pendingReview ? "改为自动过审" : "改为默认待审"}`}
            onSelect={(event) => { event.preventDefault(); void toggle(kind); }}
          >
            <span className="inline-flex size-4 items-center justify-center" aria-hidden="true">{pendingReview ? <Check /> : null}</span>
            {mediaKindLabel(kind)}：{pendingReview ? "默认待审" : "自动过审"}
            <span className="ml-auto text-[11px] text-ink-4">点击切换</span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
