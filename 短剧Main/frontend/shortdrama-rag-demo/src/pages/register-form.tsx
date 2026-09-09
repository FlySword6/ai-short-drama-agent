/* ============================================================
   register-form.tsx — 邮箱自注册表单（issue #26 合同 internal-pilot-registration-p0）

   口径：
   - 邀请码第一栏(F06:它要线下找管理员拿,是最贵的往返,先于邮箱验证码暴露);
     邮箱 + 六位验证码 + 密码 + 邀请码必填（内部试点只认固定码）；显示名可选；
   - 缺码/错码后端 422 拒绝，界面不给「去掉邀请码继续注册」的出路（合同硬规则）；
     验证码已发出时邀请码报错补一句「验证码仍有效」,不逼人重发重等(F06)；
   - 密码前端真校验(至少 8 位,与后端默认一致),不把 400 留给用户猜；
   - 界面不印固定码值——码由管理员在公司内部发放（错误文案不回显共享码）；
   - 验证码发送/倒计时/重发完整态；发新码会让旧码失效；
   - 错误全部说人话（稳定错误码表），不抛英文码/HTTP 状态;
     登录失败同口径(loginErrorMessage),不裸透传后端原文。
   显式 React import：node:test + tsx classic JSX 渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { useEffect, useState } from "react";
import { EnvelopeSimple, LockKey, Ticket } from "@phosphor-icons/react";
import { ApiClientError } from "../api";
import { businessErrorMessage } from "../error-copy";
import { Button } from "../ui";

/** 重发倒计时（秒）。只约束界面节奏，不改变服务端限流口径。 */
export const RESEND_COUNTDOWN_SECONDS = 60;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_PATTERN = /^\d{6}$/;

export interface RegisterInput {
  email: string;
  password: string;
  verificationCode: string;
  invitationCode: string;
  displayName?: string;
}

/** 发验证码失败的人话（合同 §4）。 */
export function sendCodeErrorMessage(reason: unknown): string {
  if (reason instanceof ApiClientError) {
    if (reason.code === "email_delivery_unavailable") return "验证码暂时发不出，请联系管理员开通邮件通道后再注册";
    if (reason.code === "network_error") return "连不上服务，请确认网络后再试";
    if (reason.status === 400) return reason.message || "请输入有效的邮箱地址";
  }
  return reason instanceof Error ? reason.message : "验证码发送失败，请重试";
}

/** 密码最小长度——与后端默认 AUTH_PASSWORD_MIN_LENGTH=8 对齐;服务端配置不同时以后端 400 人话为准。 */
export const PASSWORD_MIN_LENGTH = 8;

/** 登录失败的人话（稳定码映射,不裸透传后端原文;未知错误走 businessErrorMessage 双保险）。 */
export function loginErrorMessage(reason: unknown): string {
  if (reason instanceof ApiClientError) {
    if (reason.code === "unauthorized" || reason.status === 401) return "账号或密码不正确，请检查后再试";
    if (reason.code === "network_error") return "连不上服务，请确认网络后再试";
    if (reason.status === 400) return reason.message || "填写内容有误，请检查后重试";
  }
  return businessErrorMessage(reason, "登录失败，请重试");
}

/** 注册失败的人话（issue #26 稳定错误码；邀请码问题必须持码重试，没有绕过出路）。
    codeSent=true（验证码已发出）时邀请码报错补一句「验证码仍有效」,免得用户以为要重发重等(F06)。 */
export function registerErrorMessage(reason: unknown, options?: { codeSent?: boolean }): string {
  if (reason instanceof ApiClientError) {
    switch (reason.code) {
      case "email_verification_invalid":
        return "验证码不对，请核对后重试；重新发送会让旧验证码失效";
      case "email_verification_expired":
        return "验证码已过期，请重新发送一个";
      case "email_verification_attempts_exhausted":
        return "这个验证码错太多次了，请重新发送一个新的";
      case "email_exists":
        return "这个邮箱已经注册过，直接登录就好";
      case "invite_code_required":
        return `公司内部试点需要邀请码，请填写后再试；没有邀请码找管理员领取${options?.codeSent ? "；已发的验证码在有效期内仍然有效，填上邀请码直接提交即可" : ""}`;
      case "invite_code_invalid":
        return `邀请码不正确或暂不可用，请向管理员确认后再试${options?.codeSent ? "；已发的验证码在有效期内仍然有效，改对邀请码后直接重新提交即可" : ""}`;
      case "account_credit_unavailable":
        return "积分账户暂未就绪，请稍后重试；反复出现请联系管理员";
      default:
        if (reason.code === "network_error") return "连不上服务，请确认网络后再试";
        if (reason.status === 400) return reason.message || "填写内容有误，请检查后重试";
    }
  }
  return reason instanceof Error ? reason.message : "注册失败，请重试";
}

/** 发送/倒计时/重发三态按钮（纯展示组件，渲染断言直接喂 props）。 */
export function SendCodeButton({ sending, countdown, sentOnce, disabled, onSend }: {
  sending: boolean;
  countdown: number;
  sentOnce: boolean;
  disabled?: boolean;
  onSend: () => void;
}): React.JSX.Element {
  const label = countdown > 0 ? `${countdown} 秒后重发` : sentOnce ? "重新发送" : "发送验证码";
  return (
    <Button type="button" loading={sending} disabled={disabled || countdown > 0} onClick={onSend}>
      {label}
    </Button>
  );
}

/** 发送成功提示：按服务端 expires_at 算剩余分钟，不硬编码 TTL。 */
export function codeSentNote(expiresAt: string | undefined, now: number = Date.now()): string {
  const expires = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  if (Number.isFinite(expires) && expires > now) {
    return `验证码已发出，${Math.max(1, Math.round((expires - now) / 60000))} 分钟内有效`;
  }
  return "验证码已发出，请尽快填写";
}

export function RegisterForm({ sendCode, register }: {
  /** 发送验证码；成功时返回后端给的过期时间（用于提示有效分钟数）。 */
  sendCode: (email: string) => Promise<{ expiresAt?: string } | void>;
  /** 提交注册；成功后的登录态与跳转由父层完成，这里只兜失败文案。 */
  register: (input: RegisterInput) => Promise<void>;
}): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [sentOnce, setSentOnce] = useState(false);
  const [codeNote, setCodeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown((value) => (value > 0 ? value - 1 : 0)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown > 0]);

  async function handleSendCode(): Promise<void> {
    setError("");
    const target = email.trim();
    if (!EMAIL_PATTERN.test(target)) { setError("请输入有效的邮箱地址"); return; }
    setSending(true);
    try {
      const result = await sendCode(target);
      setSentOnce(true);
      setCountdown(RESEND_COUNTDOWN_SECONDS);
      setCodeNote(codeSentNote(result && "expiresAt" in result ? result.expiresAt : undefined));
    } catch (reason) {
      setCodeNote("");
      setError(sendCodeErrorMessage(reason));
    } finally {
      setSending(false);
    }
  }

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    if (!invitationCode.trim()) { setError("请填写公司内部试点邀请码；没有邀请码找管理员领取"); return; }
    const target = email.trim();
    if (!EMAIL_PATTERN.test(target)) { setError("请输入有效的邮箱地址"); return; }
    if (!CODE_PATTERN.test(code.trim())) { setError("请输入 6 位数字验证码"); return; }
    if (!password) { setError("请输入密码"); return; }
    if (password.length < PASSWORD_MIN_LENGTH) { setError(`密码至少 ${PASSWORD_MIN_LENGTH} 位，请改长一点再试`); return; }
    setBusy(true);
    try {
      await register({
        email: target,
        password,
        verificationCode: code.trim(),
        invitationCode: invitationCode.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
    } catch (reason) {
      setError(registerErrorMessage(reason, { codeSent: sentOnce }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login-form" onSubmit={(event) => void handleSubmit(event)}>
      {/* F06:邀请码提到第一栏——它要线下找管理员拿,是最贵的往返,别让用户填完整表才撞它 */}
      <label>
        <span>邀请码</span>
        <div className="input-with-icon">
          <Ticket aria-hidden="true" />
          <input value={invitationCode} onChange={(event) => setInvitationCode(event.target.value)} autoComplete="off" placeholder="公司内部试点邀请码，找管理员领取" />
        </div>
      </label>
      <label>
        <span>邮箱</span>
        <div className="input-with-icon">
          <EnvelopeSimple aria-hidden="true" />
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="name@example.com" />
        </div>
      </label>
      <label>
        <span>验证码</span>
        <div className="login-code-row">
          <input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder="6 位数字" />
          <SendCodeButton sending={sending} countdown={countdown} sentOnce={sentOnce} disabled={!EMAIL_PATTERN.test(email.trim())} onSend={() => void handleSendCode()} />
        </div>
        {codeNote ? <small className="login-field-note">{codeNote}</small> : null}
      </label>
      <label>
        <span>密码</span>
        <div className="input-with-icon">
          <LockKey aria-hidden="true" />
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder={`至少 ${PASSWORD_MIN_LENGTH} 位`} />
        </div>
      </label>
      <label>
        <span>显示名称（可选）</span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" placeholder="不填就用邮箱前缀" />
      </label>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <Button variant="primary" loading={busy} type="submit">注册并登录</Button>
    </form>
  );
}
