/* ============================================================
   login-card.tsx — 登录/注册卡(V-47 登录形态收口)

   形态(设计线 2026-08-04 拍定):
   - 全站唯一登录载体=落地页弹层;整页 LoginPage 已退役(海报标题/页脚版本号随葬);
   - 弹窗保持任务纯粹:不放品牌位/kicker/副文案(落地页页脚已有「© 中文在线」),
     标题只留「登录 / 创建账号」;
   - 落地页三入口、登出、401 换乘、未登录深链全部落到这里,redirect 由
     loginEntryPathFor(routing.ts)带来,登录成功 safeRedirectTarget 回原位。
   显式 React import:node:test + tsx classic JSX 渲染断言与 Vite react-jsx 双兼容。
   ============================================================ */
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { ChatCircleDots, LockKey, SignIn, User } from "@phosphor-icons/react";
import { api, ApiClientError } from "../api";
import { registrationEnabled } from "../feature-flags";
import { navigate, safeRedirectTarget, wecomAuthorizePath, wecomPostLoginPath } from "../routing";
import type { User as UserType } from "../types";
import { Button as LegacyButton } from "../ui";
import { RegisterForm, loginErrorMessage, type RegisterInput } from "./register-form";

export type WecomCallback =
  | { kind: "result"; result: string; returnTo: string | null }
  | { kind: "error"; code: string };

const WECOM_ERROR_MESSAGES = new Map<string, string>([
  ["wecom_login_disabled", "企业微信登录当前未开放，请使用邮箱登录。"],
  ["wecom_transaction_invalid", "本次企业微信登录已失效，请重新发起登录。"],
  ["wecom_transaction_expired", "本次企业微信登录已过期，请重新发起登录。"],
  ["wecom_transaction_replayed", "本次企业微信登录已使用，请重新发起登录。"],
  ["wecom_authorization_cancelled", "你已取消企业微信授权，可以重新尝试或使用邮箱登录。"],
  ["wecom_member_not_allowed", "当前企业成员不在应用可见范围，请联系管理员。"],
  ["wecom_profile_incomplete", "企业微信资料不完整，请联系管理员预先绑定账号。"],
  ["wecom_identity_conflict", "该企业微信身份存在绑定冲突，请联系管理员处理。"],
  ["wecom_account_disabled", "该平台账号已停用，请联系管理员。"],
  ["wecom_provider_unavailable", "企业微信服务暂时不可用，请稍后重试或使用邮箱登录。"],
]);

export function wecomErrorMessage(reason: unknown): string {
  const code = typeof reason === "string"
    ? reason
    : reason instanceof ApiClientError
      ? reason.code
      : "";
  return (typeof code === "string" ? WECOM_ERROR_MESSAGES.get(code) : undefined)
    ?? "企业微信登录未完成，请重新尝试或使用邮箱登录。";
}

/** 读取后同步清除完整 fragment；opaque result 从不进入 query 或 Web Storage。 */
export function consumeWecomCallbackFragment(target: Pick<Window, "location" | "history">): WecomCallback | null {
  const raw = target.location.hash.startsWith("#") ? target.location.hash.slice(1) : target.location.hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const hasResult = params.has("wecom_result");
  const hasError = params.has("wecom_error");
  const result = params.get("wecom_result");
  const error = params.get("wecom_error");
  if (!hasResult && !hasError) return null;
  target.history.replaceState(target.history.state, "", `${target.location.pathname}${target.location.search}`);
  if (hasResult && !hasError && result) return { kind: "result", result, returnTo: params.get("redirect") };
  if (hasError && !hasResult && error) return { kind: "error", code: error };
  return { kind: "error", code: "wecom_transaction_invalid" };
}

export function LoginCard({
  onAuthenticated,
  wecomCallback = null,
  onWecomCallbackHandled,
  onWecomExchangePendingChange,
}: {
  onAuthenticated: (user: UserType) => void;
  wecomCallback?: WecomCallback | null;
  onWecomCallbackHandled?: () => void;
  onWecomExchangePendingChange?: (pending: boolean) => void;
}): React.JSX.Element {
  const allowRegister = registrationEnabled();
  const [wecomEnabled, setWecomEnabled] = useState(false);
  const [wecomRedirecting, setWecomRedirecting] = useState(false);
  const callbackStarted = useRef(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const effectiveMode = allowRegister ? mode : "login";

  useEffect(() => {
    let active = true;
    let requestSequence = 0;
    const refreshStatus = () => {
      const request = ++requestSequence;
      setWecomEnabled(false);
      void api.wecomStatus()
        .then((status) => { if (active && request === requestSequence) setWecomEnabled(status.enabled); })
        .catch(() => { if (active && request === requestSequence) setWecomEnabled(false); });
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setWecomRedirecting(false);
      refreshStatus();
    };
    refreshStatus();
    window.addEventListener("pageshow", onPageShow);
    return () => {
      active = false;
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  useEffect(() => {
    if (!wecomCallback || callbackStarted.current) return;
    callbackStarted.current = true;
    onWecomCallbackHandled?.();
    if (wecomCallback.kind === "error") {
      setError(wecomErrorMessage(wecomCallback.code));
      return;
    }
    setBusy(true);
    onWecomExchangePendingChange?.(true);
    void api.exchangeWecomResult(wecomCallback.result)
      .then((result) => {
        onAuthenticated(result.user);
        navigate(wecomPostLoginPath(result.user.ui_mode, wecomCallback.returnTo), { replace: true });
      })
      .catch((reason) => setError(wecomErrorMessage(reason)))
      .finally(() => {
        setBusy(false);
        onWecomExchangePendingChange?.(false);
      });
  }, [onAuthenticated, onWecomCallbackHandled, onWecomExchangePendingChange, wecomCallback]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError("");
    if (!username.trim() || !password) {
      setError(allowRegister ? "请输入邮箱和密码" : "请输入账号和密码");
      return;
    }
    setBusy(true);
    try {
      const result = await api.login(username.trim(), password);
      api.setToken(result.token);
      onAuthenticated(result.user);
      navigate(safeRedirectTarget(window.location.search) ?? "/projects", { replace: true });
    } catch (reason) {
      setError(loginErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  /* 注册全链路(issue #26 合同):验证码只在 dev_log 通道可发;通道未接时 RegisterForm
     已把 503 翻成人话。注册成功即登录,与登录提交同一落点。 */
  async function sendCode(email: string): Promise<{ expiresAt: string }> {
    const result = await api.requestEmailVerificationCode(email);
    return { expiresAt: result.expires_at };
  }

  async function register(input: RegisterInput): Promise<void> {
    const result = await api.register(input);
    api.setToken(result.token);
    onAuthenticated(result.user);
    /* 注册成功后走偏好引导页，不回原位——新用户还没有项目可回。
       如果已有 redirect 目标（如深链分享），引导结束后由用户自行跳转。 */
    navigate("/register-guide", { replace: true });
  }

  function startWecomLogin(): void {
    if (wecomRedirecting) return;
    setError("");
    setWecomRedirecting(true);
    window.location.assign(wecomAuthorizePath(window.location.search));
  }

  return (
    <section className="login-panel" aria-labelledby="login-title">
      <div className="login-heading">
        <h1 id="login-title">{effectiveMode === "login" ? "登录" : "创建账号"}</h1>
      </div>
      {effectiveMode === "register" ? (
        <RegisterForm sendCode={sendCode} register={register} />
      ) : (
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          {/* F08:开放自注册的部署形态下用户只有邮箱,「账号」只对管理员代建的遗留账号存在 */}
          {/* 测试用稳定锚点(#141 语义移植):autoComplete 按 allowRegister 合法切换(email/username),
              data-testid 不跟着变——E2E 选择器与这个展示属性解耦,属性再变也不用跟着改测试。 */}
          <label><span>{allowRegister ? "邮箱" : "邮箱或账号"}</span><div className="input-with-icon"><User aria-hidden="true" /><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete={allowRegister ? "email" : "username"} data-testid="login-username-input" /></div></label>
          <label><span>密码</span><div className="input-with-icon"><LockKey aria-hidden="true" /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" data-testid="login-password-input" /></div></label>
          {/* F07:忘记密码的出路——试点期无自助重置,诚实指路,不让人卡死在登录页 */}
          <small className="login-field-note">忘记密码？请联系管理员重置</small>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <LegacyButton variant="primary" loading={busy} icon={<SignIn />} type="submit" data-testid="login-submit-button">登录，开机</LegacyButton>
        </form>
      )}
      {wecomEnabled ? (
        <>
          <div className="login-divider">或</div>
          <LegacyButton
            icon={<ChatCircleDots />}
            loading={wecomRedirecting}
            disabled={busy}
            onClick={startWecomLogin}
            data-testid="wecom-login-button"
          >{wecomRedirecting ? "正在前往企业微信" : "使用企业微信登录"}</LegacyButton>
        </>
      ) : null}
      <div className="login-switch">
        {allowRegister ? (
          <button type="button" onClick={() => { setMode(effectiveMode === "login" ? "register" : "login"); setError(""); }}>
            {effectiveMode === "login" ? "没有账号？注册一个" : "已有账号？返回登录"}
          </button>
        ) : (
          <span className="login-managed-note">当前部署未开放自助注册，账号由管理员创建，如需开通请联系项目负责人。</span>
        )}
      </div>
    </section>
  );
}
