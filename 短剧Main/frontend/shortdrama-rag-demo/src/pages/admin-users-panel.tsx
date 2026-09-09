/* ============================================================
   admin-users-panel.tsx — 后台「用户管理」页签（卡 #152；产品依据 docs/design/prd-v2/admin.md §4）

   这一页做的事：给同事开号、改角色、调积分、停用账号。
   硬规矩：
   - 登录账号是身份锚点，只读（USERNAME_READONLY_REASON），没有编辑入口；
   - 初始密码/临时密码只在创建与重置的那一次响应里回来，界面只显示一次，不落地存储；
   - 停用可逆、不是删除；恢复入口等后端 enable 路由（缺口 2026-08-06 已上报统筹），
     按钮置灰并写明为什么灰——不装成一个能点的假按钮；
   - 积分余额可点，跳到「成本」页签按用户分组看他的账（admin.md §4.2 互相跳得到）；
   - 后端错误原样上屏（错误文案后端已说人话），前端不加兜底盖住。
   ============================================================ */
import * as React from "react";
import { useCallback, useEffect, useState } from "react";
import { Copy, Key, LockSimple, Plus, Prohibit, ArrowCounterClockwise, Wallet } from "@phosphor-icons/react";
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
import { Badge, EmptyState, ErrorState, Field, Input, LoadingState, Select, Tooltip } from "../components/ui/primitives";
import { COST_UNIT_LABEL, formatCredits } from "../cost-units";
import { businessErrorMessage } from "../error-copy";
import {
  DEMO_ADMIN_USER_ACCOUNTS,
  PLATFORM_ROLE_LABEL,
  USERNAME_READONLY_REASON,
  type AdminUserAccount,
  type PlatformRole,
} from "../operations";
import { formatDateTime } from "../ui";
import { AdjustConfirmDialog } from "./admin-credits-panel";
import type { PageRuntimeProps } from "./global-pages";

const PLATFORM_ROLE_ORDER: PlatformRole[] = ["member", "operator", "admin"];
const PLATFORM_ROLE_HINT: Record<PlatformRole, string> = {
  member: "干活的普通账号，进不了后台。",
  operator: "能看后台、导数据，改不了东西。",
  admin: "后台全部功能，包括开号、调积分。给这个角色要慎重。",
};

/** 恢复入口的后端缺口说明（2026-08-06 上报统筹；到位前按钮置灰）。 */
export const RESTORE_PENDING_REASON = "恢复入口还没接上：停用是可逆的，但「恢复」的后端开关还没做出来（已上报，周一验收前到位）。这期间要恢复某个账号，先找后端同事处理。";

function denied(reason: unknown, notify: PageRuntimeProps["notify"], fallback: string): void {
  notify(reason instanceof ApiClientError && reason.status === 403 ? "只有管理员能管用户（运营角色只读）。" : businessErrorMessage(reason, fallback), "error");
}

/* ---------- 一次性密码卡（初始密码/临时密码都只显示这一次） ---------- */

export function SecretOnceCard({ title, secret, note, onDismiss }: {
  title: string;
  secret: string;
  note: string;
  onDismiss: () => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3" role="status">
      <div className="flex flex-wrap items-center gap-2">
        <Key className="size-4 text-warning" aria-hidden="true" />
        <strong className="text-sm text-ink-1">{title}</strong>
        <code className="rounded-sm bg-surface-1 px-2 py-1 font-mono text-sm text-ink-1">{secret}</code>
        <Button size="sm" variant="secondary" icon={<Copy />} onClick={() => void copy()}>{copied ? "已复制" : "复制"}</Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>我已转交</Button>
      </div>
      <p className="text-xs text-ink-2">{note}</p>
    </div>
  );
}

/* ---------- 新增用户弹窗 ---------- */

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

export function CreateUserDialog({ busy, onClose, onCreate }: {
  busy: boolean;
  onClose: () => void;
  onCreate: (input: { username: string; displayName?: string; role: PlatformRole }) => Promise<void>;
}): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<PlatformRole>("member");
  const [error, setError] = useState("");

  async function submit(): Promise<void> {
    const normalized = username.trim().toLowerCase();
    if (!USERNAME_PATTERN.test(normalized)) {
      setError("登录账号格式不对：3 到 64 位，小写字母或数字开头，可含点、横线、下划线。");
      return;
    }
    setError("");
    await onCreate({ username: normalized, displayName: displayName.trim() || undefined, role });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>新增用户</DialogTitle>
          <DialogDescription>建好他就能用「登录账号 + 初始密码」登录。这里开号不用邀请码。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <Field label="登录账号" hint="3 到 64 位：小写字母、数字、点、横线、下划线。建好后改不了——它是这个人的身份锚点。">
            <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="如 litong" aria-label="登录账号" autoFocus />
          </Field>
          <Field label="显示名（选填）" hint="不填就用登录账号。列表和项目里显示这个名字。">
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="如 李彤" aria-label="显示名" />
          </Field>
          <Field label="角色" hint={PLATFORM_ROLE_HINT[role]}>
            <Select value={role} onChange={(event) => setRole(event.target.value as PlatformRole)} aria-label="角色">
              {PLATFORM_ROLE_ORDER.map((value) => <option key={value} value={value}>{PLATFORM_ROLE_LABEL[value]}</option>)}
            </Select>
          </Field>
          {error ? <p className="text-xs text-danger" role="alert">{error}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
          <Button loading={busy} onClick={() => void submit()}>创建账号</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- 行内角色选择（失败回滚，不留假相） ---------- */

function RoleSelect({ user, busy, onChange }: {
  user: AdminUserAccount;
  busy: boolean;
  onChange: (user: AdminUserAccount, role: PlatformRole) => Promise<void>;
}): React.JSX.Element {
  const [value, setValue] = useState<PlatformRole>(user.platformRole);
  useEffect(() => { setValue(user.platformRole); }, [user.platformRole]);

  return (
    <Select
      aria-label={`${user.displayName} 的角色`}
      value={value}
      disabled={busy}
      className="h-8 w-28"
      onChange={(event) => {
        const next = event.target.value as PlatformRole;
        if (next === user.platformRole) return;
        const previous = value;
        setValue(next);
        void onChange(user, next).catch(() => setValue(previous));
      }}
    >
      {PLATFORM_ROLE_ORDER.map((role) => <option key={role} value={role}>{PLATFORM_ROLE_LABEL[role]}</option>)}
    </Select>
  );
}

/* ---------- 主面板 ---------- */

export function AdminUsersPanel({ demoMode, notify, onShowUserCosts }: {
  demoMode: boolean;
  notify: PageRuntimeProps["notify"];
  /** 点积分列：跳到「成本」页签按用户分组看这个人的账。 */
  onShowUserCosts: (user: AdminUserAccount) => void;
}): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [users, setUsers] = useState<AdminUserAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [secretCard, setSecretCard] = useState<{ title: string; secret: string; note: string } | null>(null);
  const [adjustTarget, setAdjustTarget] = useState<AdminUserAccount | null>(null);
  const [adjustDraft, setAdjustDraft] = useState({ amount: "", reason: "" });
  const [adjustConfirming, setAdjustConfirming] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUserAccount | null>(null);
  const [disableTarget, setDisableTarget] = useState<AdminUserAccount | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    setForbidden(false);
    if (demoMode) {
      setUsers(DEMO_ADMIN_USER_ACCOUNTS);
      setLoading(false);
      return;
    }
    try {
      setUsers(await api.adminUserAccounts());
    } catch (reason) {
      if (reason instanceof ApiClientError && reason.status === 403) setForbidden(true);
      else setLoadError(businessErrorMessage(reason, "用户列表读取失败"));
    } finally {
      setLoading(false);
    }
  }, [demoMode]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<void>, fallback: string): Promise<void> {
    setBusy(true);
    try { await action(); } catch (reason) { denied(reason, notify, fallback); throw reason; } finally { setBusy(false); }
  }

  function replaceUser(next: AdminUserAccount): void {
    setUsers((current) => current.map((item) => (item.id === next.id ? next : item)));
  }

  if (loading) return <LoadingState label="正在读取用户列表" />;
  if (forbidden) return <EmptyState title="用户管理只有管理员能用" description="你可以看成本、团队与用户分组页签；需要开号或调积分请联系管理员。" icon={<LockSimple />} />;
  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;

  const adjustAmount = Number(adjustDraft.amount);
  const adjustValid = Number.isInteger(adjustAmount) && adjustAmount !== 0 && adjustDraft.reason.trim().length > 0;

  return (
    <section className="flex flex-col gap-3" aria-label="用户管理">
      <header className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-ink-2">给同事开号、改角色、调积分、停用账号。停用不是删除，账号产生的数据都保留。</p>
        <Button icon={<Plus />} onClick={() => { setSecretCard(null); setCreating(true); }}>新增用户</Button>
      </header>

      {secretCard ? <SecretOnceCard title={secretCard.title} secret={secretCard.secret} note={secretCard.note} onDismiss={() => setSecretCard(null)} /> : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm" aria-label="用户列表">
          <thead>
            <tr className="border-b border-border-1 text-left text-xs text-ink-4">
              <th className="py-2 pr-3 font-medium">成员</th>
              <th className="py-2 pr-3 font-medium">角色</th>
              <th className="py-2 pr-3 font-medium">状态</th>
              <th className="py-2 pr-3 font-medium">{COST_UNIT_LABEL}余额</th>
              <th className="py-2 pr-3 font-medium">注册时间</th>
              <th className="py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-border-1/60">
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-1.5">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-ink-1">{user.displayName}</span>
                      <span className="truncate font-mono text-xs text-ink-4">@{user.username}{user.email ? ` · ${user.email}` : ""}</span>
                    </div>
                    <Tooltip content={USERNAME_READONLY_REASON}>
                      <span className="inline-flex size-5 shrink-0 cursor-help items-center justify-center rounded-sm text-ink-4 hover:text-ink-2" aria-label="登录账号为什么改不了">
                        <LockSimple className="size-3.5" aria-hidden="true" />
                      </span>
                    </Tooltip>
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <RoleSelect
                    user={user}
                    busy={busy}
                    onChange={async (target, role) => {
                      await run(async () => {
                        if (demoMode) { replaceUser({ ...target, platformRole: role }); notify("离线演示：改动只留在本页，不会写入服务", "info"); return; }
                        replaceUser(await api.adminUpdateUserRole(target.id, role));
                        notify(`已把 ${target.displayName} 改为「${PLATFORM_ROLE_LABEL[role]}」`, "success");
                      }, "改角色失败");
                    }}
                  />
                </td>
                <td className="py-2 pr-3">
                  <Badge tone={user.active ? "success" : "neutral"}>{user.active ? "启用中" : "已停用"}</Badge>
                </td>
                <td className="py-2 pr-3">
                  {user.accountCredit ? (
                    <button
                      type="button"
                      className="font-mono text-ink-1 underline decoration-dotted underline-offset-4 hover:text-accent-text"
                      title={`点一下，去「成本」页看 ${user.displayName} 的账`}
                      onClick={() => onShowUserCosts(user)}
                    >
                      {formatCredits(user.accountCredit.balancePoints)}
                    </button>
                  ) : (
                    <span className="text-xs text-ink-4" title="这个账号还没有积分账户，第一次调积分时会自动建">还没开账户</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-xs text-ink-2">{user.createdAt ? formatDateTime(user.createdAt) : "—"}</td>
                <td className="py-2">
                  <div className="flex flex-wrap items-center gap-1">
                    <Button size="sm" variant="ghost" icon={<Wallet />} disabled={busy} onClick={() => { setAdjustTarget(user); setAdjustDraft({ amount: "", reason: "" }); }}>调积分</Button>
                    <Button size="sm" variant="ghost" icon={<Key />} disabled={busy} onClick={() => setResetTarget(user)}>重置密码</Button>
                    {user.active ? (
                      <Button size="sm" variant="ghost" icon={<Prohibit />} disabled={busy} onClick={() => setDisableTarget(user)}>停用</Button>
                    ) : (
                      <Tooltip content={RESTORE_PENDING_REASON}>
                        <span className="inline-flex">
                          <Button size="sm" variant="ghost" icon={<ArrowCounterClockwise />} disabled>恢复</Button>
                        </span>
                      </Tooltip>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 ? <tr><td colSpan={6} className="py-6 text-center text-xs text-ink-4">没有读到任何用户</td></tr> : null}
          </tbody>
        </table>
      </div>

      {creating ? (
        <CreateUserDialog
          busy={busy}
          onClose={() => setCreating(false)}
          onCreate={async (input) => {
            await run(async () => {
              if (demoMode) {
                const now = new Date().toISOString();
                setUsers((current) => [...current, {
                  id: `demo-u-${Date.now()}`,
                  username: input.username,
                  displayName: input.displayName ?? input.username,
                  platformRole: input.role,
                  active: true,
                  email: null,
                  accountCredit: null,
                  createdAt: now,
                  updatedAt: now,
                }]);
                setCreating(false);
                setSecretCard({
                  title: `初始密码（只显示这一次，请立即转交给 ${input.displayName ?? input.username}）`,
                  secret: "离线演示不产生真实密码",
                  note: "离线演示：正式环境这里会显示系统生成的初始密码，只显示这一次。",
                });
                return;
              }
              const created = await api.adminCreateUser(input);
              setCreating(false);
              setSecretCard({
                title: `初始密码（只显示这一次，请立即转交给 ${created.user.displayName}）`,
                secret: created.initialPassword,
                note: "关闭后系统里谁都读不回这个密码。他用「登录账号 + 初始密码」就能登录，提醒他登录后自己改密码；弄丢了，在列表里给他「重置密码」。",
              });
              await load();
              notify(`账号 ${created.user.username} 已建好`, "success");
            }, "新增用户失败").catch(() => undefined);
          }}
        />
      ) : null}

      {adjustTarget ? (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) { setAdjustTarget(null); setAdjustConfirming(false); } }}>
          <DialogContent size="small">
            <DialogHeader>
              <DialogTitle>给 {adjustTarget.displayName} 调积分</DialogTitle>
              <DialogDescription>正数充值、负数扣减；原因必填，会写进台账与审计。当前余额 {adjustTarget.accountCredit ? formatCredits(adjustTarget.accountCredit.balancePoints) : "0"} {COST_UNIT_LABEL}。</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-3">
              <Field label={`增减额（${COST_UNIT_LABEL}）`} hint="如 5000 或 -200">
                <Input inputMode="numeric" value={adjustDraft.amount} onChange={(event) => setAdjustDraft((draft) => ({ ...draft, amount: event.target.value }))} aria-label="调积分增减额" />
              </Field>
              <Field label="原因（必填）">
                <Input value={adjustDraft.reason} onChange={(event) => setAdjustDraft((draft) => ({ ...draft, reason: event.target.value }))} placeholder="如 内测补偿 / 误充值回收" aria-label="调积分原因" />
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setAdjustTarget(null)}>取消</Button>
              <Button disabled={!adjustValid || busy} onClick={() => setAdjustConfirming(true)}>提交调账</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {adjustTarget && adjustConfirming ? (
        <AdjustConfirmDialog
          targetLabel={`${adjustTarget.displayName}（@${adjustTarget.username}）`}
          amountPoints={adjustAmount}
          reason={adjustDraft.reason.trim()}
          busy={busy}
          onClose={() => setAdjustConfirming(false)}
          onConfirm={async () => {
            await run(async () => {
              if (demoMode) { notify("离线演示：改动只留在本页，不会写入服务", "info"); }
              else await api.adjustAccountCredits(adjustTarget.id, { amountPoints: adjustAmount, reason: adjustDraft.reason.trim() });
              setAdjustConfirming(false);
              setAdjustTarget(null);
              notify(`已为 ${adjustTarget.displayName} 调账 ${adjustAmount > 0 ? "+" : ""}${formatCredits(adjustAmount)} ${COST_UNIT_LABEL}`, "success");
              await load();
            }, "调账失败").catch(() => undefined);
          }}
        />
      ) : null}

      {resetTarget ? (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) setResetTarget(null); }}>
          <DialogContent size="small">
            <DialogHeader>
              <DialogTitle>给 {resetTarget.displayName} 重置密码？</DialogTitle>
              <DialogDescription>他所有已登录的设备会立刻下线，旧密码作废。新密码只显示一次，由你转交。</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setResetTarget(null)}>再想想</Button>
              <Button loading={busy} onClick={() => {
                void run(async () => {
                  if (demoMode) {
                    setResetTarget(null);
                    setSecretCard({ title: `新密码（只显示这一次，请立即转交给 ${resetTarget.displayName}）`, secret: "离线演示不产生真实密码", note: "离线演示：正式环境这里会显示系统生成的新密码，只显示这一次。" });
                    return;
                  }
                  const result = await api.adminResetUserPassword(resetTarget.id);
                  setResetTarget(null);
                  setSecretCard({
                    title: `新密码（只显示这一次，请立即转交给 ${result.user.displayName}）`,
                    secret: result.temporaryPassword,
                    note: `他的 ${result.revokedSessionCount} 个登录会话已下线。关闭后系统里谁都读不回这个密码；弄丢了只能再重置一次。`,
                  });
                }, "重置密码失败");
              }}>确认重置</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {disableTarget ? (
        <Dialog open onOpenChange={(open) => { if (!open && !busy) setDisableTarget(null); }}>
          <DialogContent size="small">
            <DialogHeader>
              <DialogTitle>停用 {disableTarget.displayName}？</DialogTitle>
              <DialogDescription>他会被立刻踢下线、不能再登录。他建过的项目、资产、生成记录全部保留，归属不变——停用不是删除。</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setDisableTarget(null)}>再想想</Button>
              <Button variant="danger" loading={busy} onClick={() => {
                void run(async () => {
                  if (demoMode) { replaceUser({ ...disableTarget, active: false }); notify("离线演示：改动只留在本页，不会写入服务", "info"); }
                  else {
                    const result = await api.adminDisableUser(disableTarget.id);
                    replaceUser(result.user);
                    notify(`已停用 ${disableTarget.displayName}，他的 ${result.revokedSessionCount} 个登录会话已下线`, "success");
                  }
                  setDisableTarget(null);
                }, "停用失败");
              }}>确认停用</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
