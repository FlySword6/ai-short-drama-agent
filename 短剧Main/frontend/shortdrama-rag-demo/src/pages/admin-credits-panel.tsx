/* ============================================================
   admin-credits-panel.tsx — S65 超管「账户与邀请码」面板
   （合同 v0.2.0/self-registration-and-account-credits；后端 S57 已合流）

   四块，全部只是 S57 API 的调用方，不拥有另一套规则（合同 §6）：
   1. 自注册策略：无码注册赠送 0 积分（固定），日额度可调，只影响之后注册的账号；
   2. 邀请码档位：列表 + 新建/改/停用；删除=停用，已发出的码保存发放当刻快照；
   3. 邀请码：按档位生成（明文只显示一次）+ 列表（已用/剩余/状态）+ 停用；
   4. 人工调账：选人 → 增减额 + 必填原因 → 二次确认（大额额外提示）→ 提交。
      调账接口无上限，确认弹窗是唯一风控位，别把大额提示做没。
   显式 React import：node:test + tsx classic JSX 渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Copy, Key, PencilSimple, Plus, Stop, Ticket, Users, Wallet } from "@phosphor-icons/react";
import { ApiClientError, api } from "../api";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Badge, EmptyState, ErrorState, Field, Input, LoadingState, Select, Switch } from "../components/ui/primitives";
import { UserSearchInput, resolveDirectoryUser } from "../components/user-search-input";
import { COST_UNIT_LABEL, formatCredits } from "../cost-units";
import {
  DEMO_INVITE_CODES,
  DEMO_INVITE_TIERS,
  DEMO_SELF_REGISTRATION_POLICY,
  INVITE_CODE_STATUS_LABEL,
  inviteCodeRemaining,
  inviteCodeStatus,
  type AccountCreditAdjustment,
  type InviteCode,
  type InviteTier,
  type SelfRegistrationCreditPolicy,
  type UserDirectoryRecord,
  type InviteCodeStatus,
} from "../operations";
import { formatDateTime } from "../ui";
import { businessErrorMessage } from "../error-copy";
import type { PageRuntimeProps } from "./global-pages";

/** 大额调账阈值：100,000 积分 = ¥1,000（1 积分 = 1 分）。达到即出额外警告。 */
export const LARGE_ADJUSTMENT_POINTS = 100_000;

/** 大额提示文案（渲染断言锚点；null=不提示）。 */
export function adjustmentLargeNote(amountPoints: number): string | null {
  if (!Number.isInteger(amountPoints) || Math.abs(amountPoints) < LARGE_ADJUSTMENT_POINTS) return null;
  return `这是一笔大额调账（${formatCredits(Math.abs(amountPoints))} ${COST_UNIT_LABEL}，约合 ¥${(Math.abs(amountPoints) / 100).toLocaleString("zh-CN")}），提交后立即入账且不可自动撤回，请再次核对金额与原因`;
}

function denied(reason: unknown, notify: PageRuntimeProps["notify"], fallback: string): void {
  notify(reason instanceof ApiClientError && reason.status === 403 ? "只有管理员能调整账户与邀请码（运营角色只读）。" : businessErrorMessage(reason, fallback), "error");
}

const STATUS_TONE: Record<InviteCodeStatus, "success" | "warning" | "neutral" | "danger"> = {
  active: "success",
  exhausted: "warning",
  expired: "neutral",
  revoked: "danger",
};

function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return "长期有效";
  const time = new Date(expiresAt).getTime();
  return Number.isNaN(time) ? "长期有效" : `${formatDateTime(expiresAt)} 截止`;
}

/* ============================================================
   1. 自注册策略
   ============================================================ */

export function PolicyCard({ policy, saving, onSave }: {
  policy: SelfRegistrationCreditPolicy;
  saving: boolean;
  onSave: (dailyLimitPoints: number) => Promise<void>;
}): React.JSX.Element {
  const [value, setValue] = useState(String(policy.dailyLimitPoints));
  const [error, setError] = useState("");
  useEffect(() => { setValue(String(policy.dailyLimitPoints)); }, [policy.dailyLimitPoints]);

  async function submit(): Promise<void> {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 0) { setError("日额度须为不小于 0 的整数"); return; }
    setError("");
    await onSave(next);
  }

  return (
    <section className="flex flex-col gap-3" aria-label="自注册策略">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-ink-1">自注册策略</h2>
        <p className="text-xs text-ink-2">不填邀请码的注册：赠送 <strong>0 {COST_UNIT_LABEL}</strong>（固定），日额度按这里发。只影响之后注册的账号，已有账号不回写。</p>
      </header>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={`新账号日额度（${COST_UNIT_LABEL}）`} hint={value.trim() && Number(value) !== policy.dailyLimitPoints ? `当前 ${formatCredits(policy.dailyLimitPoints)} ${COST_UNIT_LABEL}` : undefined} error={error || undefined} className="w-56">
          <Input inputMode="numeric" value={value} onChange={(event) => setValue(event.target.value)} aria-label="新账号日额度" />
        </Field>
        <Button icon={<Wallet />} loading={saving} onClick={() => void submit()}>保存策略</Button>
      </div>
    </section>
  );
}

/* ============================================================
   2. 邀请码档位
   ============================================================ */

export function TierList({ tiers, busy, onEdit, onDeactivate }: {
  tiers: InviteTier[];
  busy: boolean;
  onEdit: (tier: InviteTier) => void;
  onDeactivate: (tier: InviteTier) => void;
}): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="邀请码档位列表">
      {tiers.map((tier) => (
        <li key={tier.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2">
          <strong className="text-sm text-ink-1">{tier.name}</strong>
          <span className="font-mono text-xs text-ink-4">{tier.code}</span>
          <span className="text-xs text-ink-2">注册送 <strong className="font-mono">{formatCredits(tier.grantPoints)}</strong> {COST_UNIT_LABEL} · 日额度 <strong className="font-mono">{formatCredits(tier.dailyLimitPoints)}</strong></span>
          <span className="ml-auto flex items-center gap-1">
            <Badge tone={tier.active ? "success" : "neutral"}>{tier.active ? "启用中" : "已停用"}</Badge>
            <Button size="sm" variant="ghost" icon={<PencilSimple />} disabled={busy} onClick={() => onEdit(tier)}>编辑</Button>
            {tier.active ? (
              <Button size="sm" variant="ghost" icon={<Stop />} disabled={busy} onClick={() => onDeactivate(tier)}>停用</Button>
            ) : null}
          </span>
        </li>
      ))}
      {tiers.length === 0 ? <li className="py-2 text-xs text-ink-4">还没有档位。先建一个，比如「开发者」。</li> : null}
    </ul>
  );
}

export function TierEditDialog({ tier, busy, onClose, onSave }: {
  tier: InviteTier;
  busy: boolean;
  onClose: () => void;
  onSave: (input: { name: string; grantPoints: number; dailyLimitPoints: number; active: boolean }) => Promise<void>;
}): React.JSX.Element {
  const [name, setName] = useState(tier.name);
  const [grant, setGrant] = useState(String(tier.grantPoints));
  const [daily, setDaily] = useState(String(tier.dailyLimitPoints));
  const [active, setActive] = useState(tier.active);
  const [error, setError] = useState("");

  async function submit(): Promise<void> {
    const grantPoints = Number(grant);
    const dailyLimitPoints = Number(daily);
    if (!name.trim()) { setError("档位名称必填"); return; }
    if (!Number.isInteger(grantPoints) || grantPoints < 0 || !Number.isInteger(dailyLimitPoints) || dailyLimitPoints < 0) {
      setError(`赠送与日额度须为不小于 0 的整数（${COST_UNIT_LABEL}）`);
      return;
    }
    setError("");
    await onSave({ name: name.trim(), grantPoints, dailyLimitPoints, active });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>编辑档位「{tier.name}」</DialogTitle>
          <DialogDescription>档位编码 {tier.code} 不可改；已发出的邀请码保存发放当刻快照，改档不回写。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Field label="档位名称"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label={`注册赠送（${COST_UNIT_LABEL}）`}><Input inputMode="numeric" value={grant} onChange={(event) => setGrant(event.target.value)} /></Field>
          <Field label={`日额度（${COST_UNIT_LABEL}）`}><Input inputMode="numeric" value={daily} onChange={(event) => setDaily(event.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm text-ink-1">
            <Switch label="启用档位" checked={active} onChange={() => setActive((value) => !value)} />
            启用（停用后不能再用它发新码）
          </label>
          {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
          <Button loading={busy} onClick={() => void submit()}>保存档位</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TierCreateForm({ busy, onCreate }: {
  busy: boolean;
  onCreate: (input: { code: string; name: string; grantPoints: number; dailyLimitPoints: number }) => Promise<void>;
}): React.JSX.Element {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [grant, setGrant] = useState("");
  const [daily, setDaily] = useState("");
  const [error, setError] = useState("");

  async function submit(): Promise<void> {
    const grantPoints = Number(grant);
    const dailyLimitPoints = Number(daily);
    if (!code.trim() || !name.trim()) { setError("档位编码与名称必填"); return; }
    if (!Number.isInteger(grantPoints) || grantPoints < 0 || !Number.isInteger(dailyLimitPoints) || dailyLimitPoints < 0) {
      setError(`赠送与日额度须为不小于 0 的整数（${COST_UNIT_LABEL}）`);
      return;
    }
    setError("");
    await onCreate({ code: code.trim(), name: name.trim(), grantPoints, dailyLimitPoints });
    setCode(""); setName(""); setGrant(""); setDaily("");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="档位编码" hint="小写字母/数字/下划线" className="w-40"><Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="如 partner" /></Field>
        <Field label="名称" className="w-40"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="如 合作方" /></Field>
        <Field label={`注册赠送（${COST_UNIT_LABEL}）`} className="w-36"><Input inputMode="numeric" value={grant} onChange={(event) => setGrant(event.target.value)} placeholder="50000" /></Field>
        <Field label={`日额度（${COST_UNIT_LABEL}）`} className="w-36"><Input inputMode="numeric" value={daily} onChange={(event) => setDaily(event.target.value)} placeholder="50000" /></Field>
        <Button icon={<Plus />} loading={busy} onClick={() => void submit()}>新建档位</Button>
      </div>
      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

/* ============================================================
   3. 邀请码
   ============================================================ */

export function CodeList({ codes, busy, onDeactivate }: {
  codes: InviteCode[];
  busy: boolean;
  onDeactivate: (code: InviteCode) => void;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm" aria-label="邀请码列表">
        <thead>
          <tr className="border-b border-border-1 text-left text-xs text-ink-4">
            <th className="py-2 pr-3 font-medium">邀请码</th>
            <th className="py-2 pr-3 font-medium">档位</th>
            <th className="py-2 pr-3 font-medium">赠送 / 日额度</th>
            <th className="py-2 pr-3 font-medium">已用 / 上限</th>
            <th className="py-2 pr-3 font-medium">剩余</th>
            <th className="py-2 pr-3 font-medium">状态</th>
            <th className="py-2 pr-3 font-medium">有效期</th>
            <th className="py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {codes.map((code) => {
            const status = inviteCodeStatus(code);
            return (
              <tr key={code.id} className="border-b border-border-1/60">
                <td className="py-2 pr-3 font-mono text-ink-1">{code.prefix}</td>
                <td className="py-2 pr-3 font-mono text-xs text-ink-2">{code.tierCode}</td>
                <td className="py-2 pr-3 font-mono text-xs">{formatCredits(code.grantPoints)} / {formatCredits(code.dailyLimitPoints)}</td>
                <td className="py-2 pr-3 font-mono">{code.usedRedemptions} / {code.maxRedemptions}</td>
                <td className="py-2 pr-3 font-mono">{inviteCodeRemaining(code)}</td>
                <td className="py-2 pr-3"><Badge tone={STATUS_TONE[status]}>{INVITE_CODE_STATUS_LABEL[status]}</Badge></td>
                <td className="py-2 pr-3 text-xs text-ink-2">{expiryLabel(code.expiresAt)}</td>
                <td className="py-2">
                  {status === "active" ? (
                    <Button size="sm" variant="ghost" icon={<Stop />} disabled={busy} onClick={() => onDeactivate(code)}>停用</Button>
                  ) : <span className="text-xs text-ink-4">—</span>}
                </td>
              </tr>
            );
          })}
          {codes.length === 0 ? <tr><td colSpan={8} className="py-6 text-center text-xs text-ink-4">还没有邀请码。选个档位生成第一张。</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

/** 新码明文只显示这一次（后端只存哈希，之后谁也读不回来）。 */
export function PlaintextCodeCard({ plaintext, onDismiss }: {
  plaintext: string;
  onDismiss: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Key className="size-4 text-warning" aria-hidden="true" />
        <strong className="text-sm text-ink-1">新邀请码（只显示这一次，请立即保存）</strong>
        <code className="rounded-sm bg-surface-1 px-2 py-1 font-mono text-sm text-ink-1">{plaintext}</code>
        <Button size="sm" variant="secondary" icon={<Copy />} onClick={() => void copy()}>{copied ? "已复制" : "复制"}</Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>我已保存</Button>
      </div>
      <p className="text-xs text-ink-2">关闭后系统里只剩掩码，谁都读不回明文；弄丢了只能重新生成。</p>
    </div>
  );
}

function CodeGenerateForm({ tiers, busy, onGenerate }: {
  tiers: InviteTier[];
  busy: boolean;
  onGenerate: (input: { tierId: string; maxRedemptions: number; expiresAt: string | null }) => Promise<void>;
}): React.JSX.Element {
  const activeTiers = tiers.filter((tier) => tier.active);
  const [tierId, setTierId] = useState("");
  const [count, setCount] = useState("1");
  const [expires, setExpires] = useState("");
  const [error, setError] = useState("");
  const effectiveTierId = tierId || activeTiers[0]?.id || "";

  async function submit(): Promise<void> {
    const maxRedemptions = Number(count);
    if (!effectiveTierId) { setError("没有可用档位，先新建一个档位"); return; }
    if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) { setError("可用次数须为不小于 1 的整数"); return; }
    let expiresAt: string | null = null;
    if (expires) {
      const time = new Date(expires).getTime();
      if (Number.isNaN(time)) { setError("有效期格式不对"); return; }
      expiresAt = new Date(time).toISOString();
    }
    setError("");
    await onGenerate({ tierId: effectiveTierId, maxRedemptions, expiresAt });
    setCount("1"); setExpires("");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="档位" className="w-44">
          <Select value={effectiveTierId} onChange={(event) => setTierId(event.target.value)} aria-label="选择档位">
            {activeTiers.map((tier) => <option key={tier.id} value={tier.id}>{tier.name}（送 {formatCredits(tier.grantPoints)}）</option>)}
            {activeTiers.length === 0 ? <option value="">无可用档位</option> : null}
          </Select>
        </Field>
        <Field label="可用次数" hint="一张码可被几人用" className="w-32">
          <Input inputMode="numeric" value={count} onChange={(event) => setCount(event.target.value)} />
        </Field>
        <Field label="有效期（可选）" className="w-52">
          <Input type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} />
        </Field>
        <Button icon={<Ticket />} loading={busy} onClick={() => void submit()}>生成邀请码</Button>
      </div>
      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

/* ============================================================
   4. 人工调账
   ============================================================ */

export interface AdjustmentRecord extends AccountCreditAdjustment {
  targetLabel: string;
}

/** 确认弹窗的明细体（纯展示；Radix Dialog 走 portal，SSR 渲染断言落在本组件）。 */
export function AdjustConfirmSummary({ targetLabel, amountPoints, reason }: {
  targetLabel: string;
  amountPoints: number;
  reason: string;
}): React.JSX.Element {
  const largeNote = adjustmentLargeNote(amountPoints);
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-1.5 text-sm">
        <div className="flex gap-2"><dt className="w-20 shrink-0 text-ink-4">用户</dt><dd className="text-ink-1">{targetLabel}</dd></div>
        <div className="flex gap-2"><dt className="w-20 shrink-0 text-ink-4">增减额</dt><dd className={`font-mono font-semibold ${amountPoints > 0 ? "text-success" : "text-danger"}`}>{`${amountPoints > 0 ? "+" : ""}${formatCredits(amountPoints)} ${COST_UNIT_LABEL}`}</dd></div>
        <div className="flex gap-2"><dt className="w-20 shrink-0 text-ink-4">原因</dt><dd className="text-ink-1">{reason}</dd></div>
      </dl>
      {amountPoints < 0 ? <p className="rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-2">扣减后余额不能为负；不足时后端会整笔拒绝，不会部分扣减。</p> : null}
      {largeNote ? <p className="rounded-sm bg-danger/10 px-3 py-2 text-xs font-medium text-danger" role="alert">{largeNote}</p> : null}
    </div>
  );
}

export function AdjustConfirmDialog({ targetLabel, amountPoints, reason, busy, onConfirm, onClose }: {
  targetLabel: string;
  amountPoints: number;
  reason: string;
  busy: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const largeNote = adjustmentLargeNote(amountPoints);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>确认调账</DialogTitle>
          <DialogDescription>提交后立即写入积分台账与审计记录，不能自动撤回；反向调账需再提交一笔。</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <AdjustConfirmSummary targetLabel={targetLabel} amountPoints={amountPoints} reason={reason} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>再想想</Button>
          <Button variant={largeNote ? "danger" : "primary"} loading={busy} onClick={() => void onConfirm()}>确认提交调账</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdjustmentLog({ records }: { records: AdjustmentRecord[] }): React.JSX.Element | null {
  if (records.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" aria-label="本次调账记录">
      <h3 className="text-xs font-medium text-ink-2">本次打开后台以来的调账（{records.length} 笔）</h3>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {records.map((record, index) => (
          <li key={`${record.createdAt}-${index}`} className="flex flex-wrap items-center gap-2 rounded-md border border-border-1/60 px-3 py-1.5 text-xs">
            <span className="text-ink-1">{record.targetLabel}</span>
            <span className={`font-mono font-semibold ${record.amountPoints > 0 ? "text-success" : "text-danger"}`}>{`${record.amountPoints > 0 ? "+" : ""}${formatCredits(record.amountPoints)}`}</span>
            <span className="text-ink-2">余额 {formatCredits(record.balancePoints)}</span>
            <span className="text-ink-4">{record.reason}</span>
            <span className="ml-auto text-ink-4">{formatDateTime(record.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdjustPanel({ demoMode, notify, busy, onAdjust }: {
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  busy: boolean;
  onAdjust: (target: UserDirectoryRecord, amountPoints: number, reason: string) => Promise<void>;
}): React.JSX.Element {
  const [userText, setUserText] = useState("");
  const [directory, setDirectory] = useState<UserDirectoryRecord[]>([]);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const target = resolveDirectoryUser(directory, userText);
  const amountPoints = Number(amount);
  const amountValid = Number.isInteger(amountPoints) && amountPoints !== 0;

  function openConfirm(): void {
    if (!target) { setError("先选一个用户（从搜索结果点选，或输入完整用户名）"); return; }
    if (!amountValid) { setError("增减额须为非零整数（正数充值、负数扣减）"); return; }
    if (!reason.trim()) { setError("调账原因必填，会写进台账与审计"); return; }
    setError("");
    setConfirming(true);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid items-end gap-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.6fr)_auto]">
        <Field label="用户" hint={target ? `@${target.username}` : "搜索后点选，或输入完整用户名"}>
          <UserSearchInput value={userText} onChange={setUserText} onResolve={(users) => setDirectory((current) => [...current.filter((item) => !users.some((user) => user.id === item.id)), ...users])} demoMode={demoMode} ariaLabel="调账用户" />
        </Field>
        <Field label={`增减额（${COST_UNIT_LABEL}）`} hint="正数充值、负数扣减">
          <Input inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="如 5000 或 -200" aria-label="调账增减额" />
        </Field>
        <Field label="原因（必填）">
          <Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="如 内测补偿 / 误充值回收" aria-label="调账原因" />
        </Field>
        <Button icon={<Wallet />} disabled={busy} onClick={openConfirm}>提交调账</Button>
      </div>
      {target && amountValid && Math.abs(amountPoints) >= LARGE_ADJUSTMENT_POINTS ? (
        <p className="rounded-sm bg-warning/10 px-3 py-2 text-xs text-warning" role="status">{adjustmentLargeNote(amountPoints)}</p>
      ) : null}
      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
      {confirming && target ? (
        <AdjustConfirmDialog
          targetLabel={`${target.displayName}（@${target.username}）`}
          amountPoints={amountPoints}
          reason={reason.trim()}
          busy={busy}
          onClose={() => setConfirming(false)}
          onConfirm={async () => {
            await onAdjust(target, amountPoints, reason.trim());
            setConfirming(false);
            setAmount("");
            setReason("");
          }}
        />
      ) : null}
    </div>
  );
}

/* ============================================================
   面板容器
   ============================================================ */

export function AdminCreditsPanel({ demoMode, notify }: {
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
}): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [policy, setPolicy] = useState<SelfRegistrationCreditPolicy | null>(null);
  const [tiers, setTiers] = useState<InviteTier[]>([]);
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [plaintext, setPlaintext] = useState("");
  const [editingTier, setEditingTier] = useState<InviteTier | null>(null);
  const [busy, setBusy] = useState(false);
  const [records, setRecords] = useState<AdjustmentRecord[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setForbidden(false);
    if (demoMode) {
      setPolicy(DEMO_SELF_REGISTRATION_POLICY);
      setTiers(DEMO_INVITE_TIERS);
      setCodes(DEMO_INVITE_CODES);
      setLoading(false);
      return;
    }
    try {
      const [nextPolicy, nextTiers, nextCodes] = await Promise.all([
        api.selfRegistrationPolicy(),
        api.adminInviteTiers(),
        api.adminInviteCodes(),
      ]);
      setPolicy(nextPolicy);
      setTiers(nextTiers);
      setCodes(nextCodes);
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 403) setForbidden(true);
      else setLoadError(businessErrorMessage(reason, "账户与邀请码读取失败"));
    } finally {
      setLoading(false);
    }
  }, [demoMode]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    setBusy(true);
    try { await action(); } catch (reason) { denied(reason, notify, fallback); } finally { setBusy(false); }
  }

  const demoNote = () => notify("离线演示：改动只留在本页，不会写入服务", "info");

  if (loading) return <LoadingState label="正在读取账户与邀请码" />;
  if (forbidden) return <EmptyState title="账户与邀请码只有管理员能调" description="你可以看成本、团队与用户分组页签；需要调参请联系管理员。" icon={<Users />} />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;
  if (!policy) return <ErrorState message="自注册策略读取为空，请重试" onRetry={() => void load()} />;

  return (
    <div className="flex flex-col gap-5">
      <PolicyCard
        policy={policy}
        saving={busy}
        onSave={async (dailyLimitPoints) => run(async () => {
          if (demoMode) { setPolicy({ ...policy, dailyLimitPoints }); demoNote(); return; }
          setPolicy(await api.updateSelfRegistrationPolicy(dailyLimitPoints));
          notify("自注册策略已保存，之后注册的账号按新额度发", "success");
        }, "策略保存失败")}
      />

      <section className="flex flex-col gap-3 border-t border-border-1 pt-5 first:border-t-0 first:pt-0" aria-label="邀请码档位">
        <header className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-ink-1">邀请码档位</h2>
          <p className="text-xs text-ink-2">每档决定一张码送多少{COST_UNIT_LABEL}、日额度多少。改档不影响已发出的码；停用档位后不能再用它发新码。</p>
        </header>
        <TierList
          tiers={tiers}
          busy={busy}
          onEdit={(tier) => setEditingTier(tier)}
          onDeactivate={(tier) => {
            if (!window.confirm(`停用档位「${tier.name}」？已发出的邀请码不受影响，但之后不能再用它发新码。`)) return;
            void run(async () => {
              if (demoMode) { setTiers((current) => current.map((item) => (item.id === tier.id ? { ...item, active: false } : item))); demoNote(); return; }
              await api.deactivateInviteTier(tier.id);
              setTiers(await api.adminInviteTiers());
              notify(`档位「${tier.name}」已停用`, "success");
            }, "停用档位失败");
          }}
        />
        <TierCreateForm
          busy={busy}
          onCreate={async (input) => run(async () => {
            if (demoMode) {
              setTiers((current) => [...current, { id: `demo-tier-${Date.now()}`, code: input.code, name: input.name, grantPoints: input.grantPoints, dailyLimitPoints: input.dailyLimitPoints, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
              demoNote();
              return;
            }
            await api.createInviteTier(input);
            setTiers(await api.adminInviteTiers());
            notify(`档位「${input.name}」已创建`, "success");
          }, "新建档位失败")}
        />
      </section>

      <section className="flex flex-col gap-3 border-t border-border-1 pt-5 first:border-t-0 first:pt-0" aria-label="邀请码">
        <header className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-ink-1">邀请码</h2>
          <p className="text-xs text-ink-2">新码明文只显示一次；注册时填有效码才送{COST_UNIT_LABEL}，不填也能注册（不送）。</p>
        </header>
        {plaintext ? <PlaintextCodeCard plaintext={plaintext} onDismiss={() => setPlaintext("")} /> : null}
        <CodeGenerateForm
          tiers={tiers}
          busy={busy}
          onGenerate={async (input) => run(async () => {
            if (demoMode) {
              const tier = tiers.find((item) => item.id === input.tierId);
              const demoPlaintext = `SD-DEMO-${String(Date.now()).slice(-6)}`;
              setCodes((current) => [{ id: `demo-code-${Date.now()}`, prefix: `${demoPlaintext.slice(0, 5)}••••`, tierId: input.tierId, tierCode: tier?.code ?? "", grantPoints: tier?.grantPoints ?? 0, dailyLimitPoints: tier?.dailyLimitPoints ?? 0, maxRedemptions: input.maxRedemptions, usedRedemptions: 0, expiresAt: input.expiresAt, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ...current]);
              setPlaintext(demoPlaintext);
              demoNote();
              return;
            }
            const created = await api.createInviteCode(input);
            setPlaintext(created.plaintextCode);
            setCodes(await api.adminInviteCodes());
            notify("邀请码已生成，明文只在上方显示一次", "success");
          }, "生成邀请码失败")}
        />
        <CodeList
          codes={codes}
          busy={busy}
          onDeactivate={(code) => {
            if (!window.confirm(`停用邀请码 ${code.prefix}？已注册的账号不受影响，但这张码之后不能再核销。`)) return;
            void run(async () => {
              if (demoMode) { setCodes((current) => current.map((item) => (item.id === code.id ? { ...item, active: false } : item))); demoNote(); return; }
              await api.deactivateInviteCode(code.id);
              setCodes(await api.adminInviteCodes());
              notify("邀请码已停用", "success");
            }, "停用邀请码失败");
          }}
        />
      </section>

      <section className="flex flex-col gap-3 border-t border-border-1 pt-5 first:border-t-0 first:pt-0" aria-label="人工调账">
        <header className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-ink-1">人工调账</h2>
          <p className="text-xs text-ink-2">给用户充值或扣减{COST_UNIT_LABEL}，原因必填并写台账。提交前有二次确认；大额（≥{formatCredits(LARGE_ADJUSTMENT_POINTS)} {COST_UNIT_LABEL}）会额外提示。</p>
        </header>
        <AdjustPanel
          demoMode={demoMode}
          notify={notify}
          busy={busy}
          onAdjust={async (target, amountPoints, reason) => run(async () => {
            if (demoMode) {
              setRecords((current) => [{ userId: target.id, targetLabel: `${target.displayName}（@${target.username}）`, balancePoints: 0, amountPoints, reason, createdAt: new Date().toISOString() }, ...current]);
              demoNote();
              return;
            }
            const adjustment = await api.adjustAccountCredits(target.id, { amountPoints, reason });
            setRecords((current) => [{ ...adjustment, targetLabel: `${target.displayName}（@${target.username}）` }, ...current]);
            notify(`已为 ${target.displayName} 调账 ${amountPoints > 0 ? "+" : ""}${formatCredits(amountPoints)} ${COST_UNIT_LABEL}`, "success");
          }, "调账失败")}
        />
        <AdjustmentLog records={records} />
      </section>

      {editingTier ? (
        <TierEditDialog
          tier={editingTier}
          busy={busy}
          onClose={() => setEditingTier(null)}
          onSave={async (input) => run(async () => {
            if (demoMode) {
              setTiers((current) => current.map((item) => (item.id === editingTier.id ? { ...item, ...input } : item)));
              setEditingTier(null);
              demoNote();
              return;
            }
            await api.updateInviteTier(editingTier.id, input);
            setTiers(await api.adminInviteTiers());
            setEditingTier(null);
            notify("档位已保存", "success");
          }, "保存档位失败")}
        />
      ) : null}
    </div>
  );
}
