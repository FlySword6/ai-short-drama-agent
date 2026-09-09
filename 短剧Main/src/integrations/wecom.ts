import { request as undiciRequest } from "undici";

export type WecomProviderFailure = "member_not_allowed" | "profile_incomplete" | "provider_unavailable";

export class WecomProviderError extends Error {
  constructor(readonly reason: WecomProviderFailure) {
    super(reason);
    this.name = "WecomProviderError";
  }
}

export interface WecomMember {
  userId: string;
  displayName: string;
}

export interface WecomIdentity {
  userId: string;
}

interface WecomResponseBody {
  json(): Promise<unknown>;
  dump(): Promise<void>;
}

export type WecomRequest = (
  url: string | URL,
  options: {
    method: "GET";
    headersTimeout: number;
    bodyTimeout: number;
    signal: AbortSignal;
    idempotent?: false;
  },
) => Promise<{ statusCode: number; body: WecomResponseBody }>;

export interface WecomAdapterOptions {
  corpId: string;
  agentId: string;
  corpSecret: string;
  callbackUrl: string;
  request?: WecomRequest;
  now?: () => number;
  timeoutMs?: number;
}

interface CachedToken {
  value: string;
  refreshAt: number;
}

const apiOrigin = "https://qyapi.weixin.qq.com";
const authorizeOrigin = "https://open.weixin.qq.com/connect/oauth2/authorize";
const defaultTimeoutMs = 5_000;
const tokenRefreshSkewMs = 60_000;

/** The only module allowed to translate WeCom wire responses into application facts. */
export class WecomAdapter {
  private readonly request: WecomRequest;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cachedToken?: CachedToken;
  private tokenFlight?: Promise<string>;

  constructor(private readonly options: WecomAdapterOptions) {
    this.request = options.request ?? (undiciRequest as unknown as WecomRequest);
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  authorizationUrl(state: string): string {
    const url = new URL(authorizeOrigin);
    url.searchParams.set("appid", this.options.corpId);
    url.searchParams.set("redirect_uri", this.options.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "snsapi_base");
    url.searchParams.set("state", state);
    url.searchParams.set("agentid", this.options.agentId);
    return `${url.toString()}#wechat_redirect`;
  }

  /** The authorization code is sent exactly once. Unknown network results are never replayed. */
  async exchangeCode(code: string): Promise<WecomIdentity> {
    const accessToken = await this.accessToken();
    const identity = await this.getJson("/cgi-bin/auth/getuserinfo", {
      access_token: accessToken,
      code,
    }, false);
    const userId = readString(identity, "userid") ?? readString(identity, "UserId");
    if (!userId || userId.length > 64) throw new WecomProviderError("member_not_allowed");
    return { userId };
  }

  async getMemberProfile(userId: string): Promise<WecomMember> {
    const accessToken = await this.accessToken();
    const profile = await this.getJson("/cgi-bin/user/get", {
      access_token: accessToken,
      userid: userId,
    });
    const displayName = (readString(profile, "name") ?? "").trim();
    if (!displayName) throw new WecomProviderError("profile_incomplete");
    return { userId, displayName };
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.refreshAt > this.now()) return this.cachedToken.value;
    if (this.tokenFlight) return this.tokenFlight;
    const flight = this.fetchAccessToken();
    this.tokenFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.tokenFlight === flight) this.tokenFlight = undefined;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const payload = await this.getJson("/cgi-bin/gettoken", {
      corpid: this.options.corpId,
      corpsecret: this.options.corpSecret,
    });
    const token = readString(payload, "access_token");
    const expiresIn = readPositiveNumber(payload, "expires_in");
    if (!token || !expiresIn) throw new WecomProviderError("provider_unavailable");
    this.cachedToken = {
      value: token,
      refreshAt: this.now() + Math.max(0, expiresIn * 1_000 - tokenRefreshSkewMs),
    };
    return token;
  }

  private async getJson(
    path: string,
    query: Record<string, string>,
    idempotent = true,
  ): Promise<Record<string, unknown>> {
    const url = new URL(path, apiOrigin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    try {
      const response = await this.request(url, {
        method: "GET",
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(idempotent ? {} : { idempotent: false as const }),
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        await response.body.dump();
        throw new WecomProviderError("provider_unavailable");
      }
      const payload = await response.body.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new WecomProviderError("provider_unavailable");
      }
      const record = payload as Record<string, unknown>;
      const errcode = typeof record.errcode === "number" ? record.errcode : Number(record.errcode ?? 0);
      if (Number.isFinite(errcode) && errcode !== 0) {
        if (path === "/cgi-bin/user/get" && isProfileIncompleteCode(errcode)) {
          throw new WecomProviderError("profile_incomplete");
        }
        if (isMemberNotAllowedCode(errcode)) throw new WecomProviderError("member_not_allowed");
        throw new WecomProviderError("provider_unavailable");
      }
      return record;
    } catch (error) {
      if (error instanceof WecomProviderError) throw error;
      throw new WecomProviderError("provider_unavailable");
    }
  }
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function readPositiveNumber(value: Record<string, unknown>, key: string): number | undefined {
  const item = Number(value[key]);
  return Number.isFinite(item) && item > 0 ? item : undefined;
}

function isMemberNotAllowedCode(code: number): boolean {
  return new Set([40003, 60011, 60111, 84074]).has(code);
}

function isProfileIncompleteCode(code: number): boolean {
  return new Set([48002, 60011]).has(code);
}
