/* ============================================================
   session-relogin-modal.tsx — 401 原地重登小窗（F01/F02/F04 会话诚实包核心件）

   铁规矩（UIUX 审计第一批 A 组）：
   - 登录失效时页面原地弹小窗，正在填的表单/粘贴的剧本一个字不丢（不清 user、不跳走）；
   - 说清原因：过期 vs 账号在别处登录（本地到期时间还在未来却 401 = 被顶/被吊销）；
   - 重登成功原地接着干；「换个账号」才去登录页（带 redirect,回来还落这）。

   实现要点（实证血训）：必须复用 Radix Dialog——下层若有开的 Dialog/抽屉，
   其焦点陷阱会把焦点拽回去，自定义小窗的输入框打不进字（playwright 实证）。
   Radix 栈式弹窗后挂的 FocusScope 优先,输入正常。z 用 --z-toast(80) 压过一切弹层。
   ============================================================ */
import * as React from "react";
import { useState } from "react";
import { LockKey, User as UserIcon } from "@phosphor-icons/react";
import { api } from "../api";
import { businessErrorMessage } from "../error-copy";
import type { User } from "../types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export type SessionEndReason = "expired" | "revoked";

export function sessionEndCopy(reason: SessionEndReason): { title: string; body: string } {
  return reason === "revoked"
    ? { title: "账号在别处登录", body: "你的账号刚在别的地方登录（或被管理员要求重新登录）。别担心：当前页面和你填到一半的内容都还在，重新登录后接着干。如非本人操作，登录后请改密码。" }
    : { title: "登录已过期", body: "别担心：当前页面和你填到一半的内容都还在，重新登录后接着干。" };
}

export function SessionReloginModal({ reason, defaultIdentifier, onSuccess, onSwitchAccount }: {
  reason: SessionEndReason;
  defaultIdentifier: string;
  onSuccess: (user: User) => void;
  onSwitchAccount: () => void;
}): React.JSX.Element {
  const copy = sessionEndCopy(reason);
  const [identifier, setIdentifier] = useState(defaultIdentifier);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setError("请输入账号和密码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.login(identifier.trim(), password);
      onSuccess(result.user);
    } catch (cause) {
      setError(businessErrorMessage(cause, "登录没成，请检查账号和密码"));
    } finally {
      setBusy(false);
    }
  }

  return (
    /* 不可误关:重登前不收起(换账号走显式按钮);z-toast(80) 压过一切弹层(含下层 Dialog 的裸 60/61)。 */
    <Dialog open onOpenChange={() => { /* 强制流程:点遮罩/Esc 不关,重登或换账号二选一 */ }}>
      <DialogContent size="small" hideClose className="z-[var(--z-toast)]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3 px-5 py-4" onSubmit={(event) => void submit(event)} aria-label="重新登录">
          <label className="flex flex-col gap-1 text-xs text-ink-2">账号
            <div className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-2">
              <UserIcon aria-hidden="true" className="size-4 shrink-0 text-ink-4" />
              <input className="w-full bg-transparent text-sm text-ink-1 outline-none" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoComplete="username" />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-2">密码
            <div className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-0 px-3 py-2">
              <LockKey aria-hidden="true" className="size-4 shrink-0 text-ink-4" />
              <input type="password" autoFocus className="w-full bg-transparent text-sm text-ink-1 outline-none" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            </div>
          </label>
          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={busy} type="submit">重新登录，接着刚才干</Button>
            <Button variant="ghost" type="button" onClick={onSwitchAccount}>换个账号</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
