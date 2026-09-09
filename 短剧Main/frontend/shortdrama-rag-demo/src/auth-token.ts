const SESSION_TOKEN_KEY = "shortdrama_v01_token";
const SESSION_EXPIRES_KEY = "shortdrama_v01_token_expires";

export function readSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(SESSION_TOKEN_KEY);
}

export function writeSessionToken(token: string | null): void {
  if (token) window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  else window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
}

/** 会话到期时间（ISO）随 token 同存同清：401 时据此分辨「过期」与「被顶下线」（F04 前端半）。 */
export function writeSessionExpiry(expiresAtIso: string | null): void {
  if (typeof window === "undefined") return;
  if (expiresAtIso) window.sessionStorage.setItem(SESSION_EXPIRES_KEY, expiresAtIso);
  else window.sessionStorage.removeItem(SESSION_EXPIRES_KEY);
}

export function readSessionExpiry(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(SESSION_EXPIRES_KEY);
}

/**
 * 401 原因分类（纯函数，可测）：
 * 本地记录的到期时间还在未来，服务端却说 401 = 会话被提前吊销（同账号别处登录顶号/管理员清退）；
 * 已过了到期时间 = 自然过期。没存到期时间（旧会话遗留）按过期处理，话术不武断。
 */
export function classifyUnauthorized(expiresAtIso: string | null, now: number = Date.now()): "expired" | "revoked" {
  if (!expiresAtIso) return "expired";
  const expiry = new Date(expiresAtIso).getTime();
  if (Number.isNaN(expiry)) return "expired";
  return expiry > now ? "revoked" : "expired";
}
