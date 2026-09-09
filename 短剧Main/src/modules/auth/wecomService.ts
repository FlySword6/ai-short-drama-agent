import { createHash, randomBytes } from "node:crypto";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { AppError, BadRequestError, ConflictError } from "../../shared/errors.js";
import { WecomAdapter, WecomProviderError } from "../../integrations/wecom.js";
import { AuthRepository, type WecomPrebindActor } from "./repository.js";
import { hashSessionToken, normalizeObservedUserAgent, type PublicUser } from "./service.js";
import { platformRoleOrMember, uiModeOrFull } from "./types.js";

export interface WecomAuthConfiguration {
  enabled: boolean;
  corpId?: string;
  agentId?: string;
  corpSecret?: string;
  callbackUrl?: string;
  stateTtlSeconds: number;
  sessionTtlHours: number;
}

export interface WecomAuthPort {
  status(): { enabled: boolean };
  authorize(returnTo?: string): Promise<{ location: string; nonce: string; expiresInSeconds: number }>;
  callback(input: { code: string; state: string; nonce?: string }): Promise<{ result: string; returnPath: string }>;
  exchange(input: { result: string; nonce?: string; userAgent?: string }): Promise<{ token: string; expires_at: string; user: PublicUser }>;
  prebind(actor: WecomPrebindActor, userId: string, wecomUserId: string): Promise<{ user_id: string; bound: true }>;
}

const resultTtlMs = 60_000;

export class WecomAuthService implements WecomAuthPort {
  private readonly repository: AuthRepository;
  private readonly configuration: WecomAuthConfiguration;
  private readonly adapter?: Pick<WecomAdapter, "authorizationUrl" | "exchangeCode" | "getMemberProfile">;
  private readonly now: () => Date;

  constructor(
    db: Database,
    options: {
      repository?: AuthRepository;
      configuration?: WecomAuthConfiguration;
      adapter?: Pick<WecomAdapter, "authorizationUrl" | "exchangeCode" | "getMemberProfile">;
      now?: () => Date;
    } = {},
  ) {
    this.repository = options.repository ?? new AuthRepository(db);
    this.configuration = options.configuration ?? configurationFromSettings();
    this.adapter = options.adapter ?? this.createConfiguredAdapter();
    this.now = options.now ?? (() => new Date());
  }

  status(): { enabled: boolean } {
    return { enabled: this.isConfigured() };
  }

  async authorize(returnTo = "/projects"): Promise<{ location: string; nonce: string; expiresInSeconds: number }> {
    const adapter = this.requireEnabled();
    const returnPath = normalizeReturnPath(returnTo);
    const state = opaqueValue();
    const nonce = opaqueValue();
    const now = this.now();
    await this.repository.createWecomAuthTransaction({
      stateHash: hashOpaqueValue(state),
      browserNonceHash: hashOpaqueValue(nonce),
      returnPath,
      expiresAt: new Date(now.getTime() + this.configuration.stateTtlSeconds * 1_000),
    }, now);
    return { location: adapter.authorizationUrl(state), nonce, expiresInSeconds: this.configuration.stateTtlSeconds };
  }

  async callback(input: { code: string; state: string; nonce?: string }): Promise<{ result: string; returnPath: string }> {
    const adapter = this.requireEnabled();
    if (!input.nonce || !input.state) throw wecomError("wecom_transaction_invalid");
    const consumed = await this.repository.consumeWecomCallback({
      stateHash: hashOpaqueValue(input.state),
      browserNonceHash: hashOpaqueValue(input.nonce),
    });
    if (consumed.kind !== "consumed") throw transactionError(consumed.kind);
    if (!input.code || input.code === "authdeny") throw wecomError("wecom_authorization_cancelled");
    const returnPath = normalizeReturnPath(consumed.returnPath);

    let wecomUserId: string;
    try {
      const identity = await adapter.exchangeCode(input.code);
      wecomUserId = identity.userId;
    } catch (error) {
      throwProviderError(error);
    }
    const existingIdentity = await this.repository.findWecomIdentity(this.configuration.corpId!, wecomUserId);
    let displayName = existingIdentity?.displayName;
    if (!displayName) {
      try {
        const profile = await adapter.getMemberProfile(wecomUserId);
        displayName = normalizeDisplayName(profile.displayName);
      } catch (error) {
        throwProviderError(error);
      }
    }
    const result = opaqueValue();
    const outcome = await this.repository.resolveWecomIdentityAndIssueResult({
      transactionId: consumed.transactionId,
      corpId: this.configuration.corpId!,
      wecomUserId,
      username: wecomUsername(this.configuration.corpId!, wecomUserId),
      displayName,
      resultHash: hashOpaqueValue(result),
      resultExpiresAt: new Date(this.now().getTime() + resultTtlMs),
    });
    if (outcome.kind === "identity_conflict") throw wecomError("wecom_identity_conflict");
    if (outcome.kind !== "resolved") throw wecomError("wecom_transaction_invalid");
    return { result, returnPath };
  }

  async exchange(input: { result: string; nonce?: string; userAgent?: string }): Promise<{ token: string; expires_at: string; user: PublicUser }> {
    this.requireEnabled();
    if (!input.nonce) throw wecomError("wecom_transaction_invalid");
    const token = opaqueValue();
    const expiresAt = new Date(this.now().getTime() + this.configuration.sessionTtlHours * 60 * 60 * 1_000);
    const outcome = await this.repository.exchangeWecomResultForSession({
      resultHash: hashOpaqueValue(input.result),
      browserNonceHash: hashOpaqueValue(input.nonce),
      tokenHash: hashSessionToken(token),
      userAgent: normalizeObservedUserAgent(input.userAgent),
      expiresAt,
    });
    if (outcome.kind !== "exchanged") {
      if (outcome.kind === "account_disabled") throw wecomError("wecom_account_disabled");
      throw transactionError(outcome.kind);
    }
    return {
      token,
      expires_at: expiresAt.toISOString(),
      user: {
        id: outcome.user.id,
        username: outcome.user.username,
        display_name: outcome.user.displayName,
        role: platformRoleOrMember(outcome.user.role),
        ui_mode: uiModeOrFull(outcome.user.uiMode),
      },
    };
  }

  async prebind(actor: WecomPrebindActor, userId: string, wecomUserId: string): Promise<{ user_id: string; bound: true }> {
    const corpId = this.configuration.corpId;
    if (!corpId) throw wecomError("wecom_login_disabled");
    const normalizedUserId = wecomUserId.trim();
    if (!normalizedUserId) throw new BadRequestError("企业微信成员标识不能为空");
    const outcome = await this.repository.prebindWecomIdentity({
      actor,
      userId,
      corpId,
      wecomUserId: normalizedUserId,
    });
    if (outcome === "target_unavailable") {
      throw new AppError(404, "user_not_found", "绑定没成：目标用户不存在或已停用。", false);
    }
    if (outcome === "identity_conflict") {
      throw new ConflictError("绑定没成：企业微信身份或平台用户已被绑定。", "wecom_identity_conflict");
    }
    return { user_id: userId, bound: true };
  }

  private requireEnabled(): Pick<WecomAdapter, "authorizationUrl" | "exchangeCode" | "getMemberProfile"> {
    if (!this.isConfigured() || !this.adapter) throw wecomError("wecom_login_disabled");
    return this.adapter;
  }

  private isConfigured(): boolean {
    const c = this.configuration;
    return c.enabled && Boolean(c.corpId && c.agentId && c.corpSecret && c.callbackUrl);
  }

  private createConfiguredAdapter(): WecomAdapter | undefined {
    if (!this.isConfigured()) return undefined;
    return new WecomAdapter({
      corpId: this.configuration.corpId!,
      agentId: this.configuration.agentId!,
      corpSecret: this.configuration.corpSecret!,
      callbackUrl: this.configuration.callbackUrl!,
    });
  }
}

export function normalizeReturnPath(value: string): string {
  const raw = value.trim();
  if (raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /%(?:2f|5c|3a|25)/iu.test(raw)) {
    throw new BadRequestError("return_to 必须是站内绝对路径");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, "https://shortdrama.invalid");
  } catch {
    throw new BadRequestError("return_to 必须是站内绝对路径");
  }
  if (parsed.origin !== "https://shortdrama.invalid" || parsed.username || parsed.password || parsed.hash || parsed.pathname.startsWith("//")) {
    throw new BadRequestError("return_to 必须是站内绝对路径");
  }
  return `${parsed.pathname}${parsed.search}`;
}

export function hashOpaqueValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function wecomUsername(corpId: string, wecomUserId: string): string {
  return `wecom_${createHash("sha256").update(corpId).update("\0").update(wecomUserId).digest("hex").slice(0, 58)}`;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 128);
  if (!normalized) throw wecomError("wecom_profile_incomplete");
  return normalized;
}

function throwProviderError(error: unknown): never {
  if (error instanceof WecomProviderError) {
    if (error.reason === "member_not_allowed") throw wecomError("wecom_member_not_allowed");
    if (error.reason === "profile_incomplete") throw wecomError("wecom_profile_incomplete");
  }
  throw wecomError("wecom_provider_unavailable");
}

function opaqueValue(): string {
  return randomBytes(32).toString("base64url");
}

function configurationFromSettings(): WecomAuthConfiguration {
  return {
    enabled: settings.wecomLoginEnabled,
    corpId: settings.wecomCorpId,
    agentId: settings.wecomAgentId,
    corpSecret: settings.wecomCorpSecret,
    callbackUrl: settings.wecomCallbackUrl,
    stateTtlSeconds: settings.wecomStateTtlSeconds,
    sessionTtlHours: settings.sessionTtlHours,
  };
}

export type WecomErrorCode =
  | "wecom_login_disabled"
  | "wecom_transaction_invalid"
  | "wecom_transaction_expired"
  | "wecom_transaction_replayed"
  | "wecom_authorization_cancelled"
  | "wecom_member_not_allowed"
  | "wecom_profile_incomplete"
  | "wecom_identity_conflict"
  | "wecom_account_disabled"
  | "wecom_provider_unavailable";

export function wecomError(code: WecomErrorCode): AppError {
  const status: Record<WecomErrorCode, number> = {
    wecom_login_disabled: 404,
    wecom_transaction_invalid: 400,
    wecom_transaction_expired: 400,
    wecom_transaction_replayed: 409,
    wecom_authorization_cancelled: 400,
    wecom_member_not_allowed: 403,
    wecom_profile_incomplete: 409,
    wecom_identity_conflict: 409,
    wecom_account_disabled: 403,
    wecom_provider_unavailable: 503,
  };
  return new AppError(status[code], code, publicMessage(code), code === "wecom_provider_unavailable");
}

function transactionError(kind: "invalid" | "expired" | "replayed"): AppError {
  return wecomError(`wecom_transaction_${kind}`);
}

function publicMessage(code: WecomErrorCode): string {
  const messages: Record<WecomErrorCode, string> = {
    wecom_login_disabled: "企业微信登录未启用",
    wecom_transaction_invalid: "企业微信登录事务无效，请重新发起登录",
    wecom_transaction_expired: "企业微信登录已过期，请重新发起登录",
    wecom_transaction_replayed: "企业微信登录结果已使用，请重新发起登录",
    wecom_authorization_cancelled: "企业微信授权已取消",
    wecom_member_not_allowed: "当前企业微信成员不可使用此应用",
    wecom_profile_incomplete: "企业微信成员资料不完整，请联系管理员预绑定",
    wecom_identity_conflict: "企业微信身份绑定冲突，请联系管理员处理",
    wecom_account_disabled: "平台账号已停用",
    wecom_provider_unavailable: "企业微信服务暂时不可用，请稍后重试",
  };
  return messages[code];
}
