import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import type { UiMode } from "../../db/schema.js";
import {
  AppError,
  BadRequestError,
  ConflictError,
  isPostgresUniqueViolation,
  NotFoundError,
  UnauthorizedError,
} from "../../shared/errors.js";
import { hashInviteCode, normalizeInviteCode } from "../account-credits/repository.js";
import type { AccountCreditSummary } from "../account-credits/types.js";
import {
  AuthRepository,
  type AgentCredentialRecord,
  type AuthenticatedSession,
  type EmailRegistrationFailure,
  type RegistrationGrant,
} from "./repository.js";
import {
  platformRoleOrMember,
  uiModeOrFull,
  type ActiveCredentialSource,
  type HumanCredentialSource,
  type PlatformRole,
} from "./types.js";

const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const derivedKeyLength = 64;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const INTERNAL_PILOT_INVITATION_CODE = "COLTECH";

export interface PublicUser {
  id: string;
  username: string;
  display_name: string;
  role: PlatformRole;
  ui_mode: UiMode;
}

export interface RegistrationResult {
  user: PublicUser;
  accountCredit: AccountCreditSummary;
  registrationGrant: RegistrationGrant;
}

export interface CredentialActor {
  userId: string;
  sessionId: string;
  source: ActiveCredentialSource;
}

export interface IssuedAgentCredential {
  credentialId: string;
  token: string;
  source: "agent";
  agentType: string;
  label: string;
  expiresAt: Date;
}

/** Retained only as a source-compatible type for older callers. */
export interface RegistrationPolicy {
  enabled: boolean;
  inviteCodes: readonly string[];
}

export class AuthService {
  private readonly repository: AuthRepository;

  constructor(db: Database, repository = new AuthRepository(db)) {
    this.repository = repository;
  }

  /**
   * Email is the public self-registration identity. In this first phase the
   * code is deliberately written only to a development log; production fails
   * closed until an approved mail provider is wired in a later package.
   */
  async requestEmailVerification(input: { email: string }): Promise<{
    email: string;
    expiresAt: Date;
    devLogCode: string;
  }> {
    const email = normalizeEmail(input.email);
    if (settings.appEnvironment === "production" || settings.authEmailDeliveryMode !== "dev_log") {
      throw new AppError(
        503,
        "email_delivery_unavailable",
        "发送验证码没成：邮件服务暂未准备好，请联系管理员处理。",
        false,
      );
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + settings.authEmailVerificationTtlSeconds * 1_000);
    await this.repository.issueEmailVerificationCode({
      email,
      codeHash: await hashPassword(code),
      expiresAt,
      maxAttempts: settings.authEmailVerificationMaxAttempts,
    });
    return { email, expiresAt, devLogCode: code };
  }

  async register(input: {
    email: string;
    password: string;
    verificationCode: string;
    displayName?: string;
    invitationCode?: string;
  }): Promise<RegistrationResult> {
    const email = normalizeEmail(input.email);
    if (input.password.length < settings.authPasswordMinLength) {
      throw new BadRequestError(`注册没成：密码至少需要 ${settings.authPasswordMinLength} 位，请修改后再试。`);
    }
    const verificationCode = input.verificationCode.trim();
    if (!/^\d{6}$/.test(verificationCode)) {
      throw new BadRequestError("注册没成：验证码格式不对，请填写 6 位数字后再试。");
    }
    const username = usernameForEmail(email);
    const displayName = input.displayName?.trim() || defaultDisplayName(email);
    if (displayName.length > 128) throw new BadRequestError("注册没成：显示名过长，请缩短后再试。");
    assertRegistrationAllowed(input.invitationCode);
    const invitationCode = normalizeInviteCode(input.invitationCode ?? "");
    try {
      const outcome = await this.repository.registerVerifiedEmail({
        email,
        username,
        displayName,
        passwordHash: await hashPassword(input.password),
        verificationCode,
        invitationCodeHash: hashInviteCode(invitationCode),
        verifyCode: verifyPassword,
      });
      if (outcome.kind === "rejected") {
        throw new AppError(422, outcome.failure.code, registrationFailureMessage(outcome.failure.code), false);
      }
      return {
        user: toPublicUser(outcome.user),
        accountCredit: outcome.accountCredit,
        registrationGrant: outcome.registrationGrant,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new AppError(
          503,
          "account_credit_unavailable",
          "注册没成：积分账户暂未准备好，请稍后重试。",
          true,
        );
      }
      if (isPostgresUniqueViolation(error)) {
        throw new ConflictError("注册没成：这个邮箱已经注册，请直接登录。", "email_exists");
      }
      throw error;
    }
  }

  async login(input: { username: string; password: string }, observedUserAgent?: string): Promise<{
    token: string;
    expires_at: string;
    user: PublicUser;
  }> {
    return this.loginHuman(input, "web", observedUserAgent);
  }

  async loginCli(input: { username: string; password: string }, observedUserAgent?: string): Promise<{
    token: string;
    expires_at: string;
    user: PublicUser;
  }> {
    return this.loginHuman(input, "cli", observedUserAgent);
  }

  async issueAgentCredential(
    actor: CredentialActor,
    input: { agentType: string; label: string },
    observedUserAgent?: string,
  ): Promise<IssuedAgentCredential> {
    assertHumanCredential(actor.source);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + settings.sessionTtlHours * 60 * 60 * 1000);
    const agentType = input.agentType.trim();
    const label = input.label.trim();
    const credentialId = await this.repository.createAgentSession({
      userId: actor.userId,
      issuedBySessionId: actor.sessionId,
      tokenHash: hashSessionToken(token),
      agentType,
      label,
      userAgent: normalizeObservedUserAgent(observedUserAgent),
      expiresAt,
    });
    if (!credentialId) {
      throw new UnauthorizedError("签发 Agent 凭据没成：当前登录已失效，请重新登录后再试。");
    }
    return { credentialId, token, source: "agent", agentType, label, expiresAt };
  }

  async listAgentCredentials(actor: CredentialActor): Promise<Array<AgentCredentialRecord & { active: boolean }>> {
    assertHumanCredential(actor.source);
    const now = new Date();
    return (await this.repository.listAgentSessions(actor.userId)).map((item) => ({
      ...item,
      active: item.revokedAt === null && item.expiresAt > now,
    }));
  }

  async revokeAgentCredential(actor: CredentialActor, credentialId: string): Promise<boolean> {
    assertHumanCredential(actor.source);
    return this.repository.revokeAgentSession(actor.userId, credentialId);
  }

  private async loginHuman(
    input: { username: string; password: string },
    source: HumanCredentialSource,
    observedUserAgent?: string,
  ): Promise<{
    token: string;
    expires_at: string;
    user: PublicUser;
  }> {
    const user = await this.repository.findUserByUsername(input.username.trim().toLowerCase());
    if (!user || !user.active || !user.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      // Keep the legacy-neutral wording: the same endpoint accepts an email
      // or a username, and the message must not reveal which identifier exists.
      throw new UnauthorizedError("登录没成：账号或密码不正确，请检查后再试。");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + settings.sessionTtlHours * 60 * 60 * 1000);
    const sessionId = await this.repository.createHumanSession({
      userId: user.id,
      expectedPasswordHash: user.passwordHash,
      tokenHash: hashSessionToken(token),
      source,
      userAgent: normalizeObservedUserAgent(observedUserAgent),
      expiresAt,
    });
    if (!sessionId) throw new UnauthorizedError("登录没成：账号状态或密码已变化，请重新登录。");
    return { token, expires_at: expiresAt.toISOString(), user: toPublicUser(user) };
  }

  async authenticate(token: string): Promise<AuthenticatedSession> {
    const session = await this.repository.findActiveSession(hashSessionToken(token));
    if (!session) throw new UnauthorizedError("继续操作没成：登录已失效，请重新登录。");
    return session;
  }

  async logout(sessionId: string): Promise<void> {
    await this.repository.revokeSession(sessionId);
  }

  /**
   * 界面模式只认 users 表（红线 R2）。会话校验与本次读取之间账号被删的
   * 极小窗口按迁移默认值 'full' 兜底，不让 /auth/me 因竞态破裂。
   */
  async getUiMode(userId: string): Promise<UiMode> {
    return (await this.repository.findUiModeByUserId(userId)) ?? "full";
  }

  /** 本人切换自己的界面模式；账号已不存在时按会话失效处理。 */
  async updateUiMode(userId: string, uiMode: UiMode): Promise<UiMode> {
    const updated = await this.repository.updateUiMode(userId, uiMode);
    if (!updated) throw new UnauthorizedError("登录已失效，请重新登录");
    return updated;
  }
}

function assertHumanCredential(source: ActiveCredentialSource): asserts source is HumanCredentialSource {
  if (source === "agent") {
    throw new AppError(
      403,
      "human_confirmation_required",
      "这一步需要由已登录的人确认，Agent 只能准备内容或报价。",
      false,
    );
  }
}

export function normalizeObservedUserAgent(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 512) : null;
}

export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!emailPattern.test(email) || email.length > 320) {
    throw new BadRequestError("提交邮箱没成：邮箱格式不对，请检查后再试。");
  }
  return email;
}

function registrationFailureMessage(code: EmailRegistrationFailure["code"]): string {
  switch (code) {
    case "email_verification_invalid":
      return "注册没成：验证码不正确或尚未获取，请检查后重新获取。";
    case "email_verification_expired":
      return "注册没成：验证码已过期，请重新获取后再试。";
    case "email_verification_attempts_exhausted":
      return "注册没成：验证码尝试次数已用完，请重新获取后再试。";
    case "invite_code_required":
      return "注册没成：公司内部试点需要邀请码，请向管理员确认后再试。";
    case "invite_code_invalid":
      return "注册没成：邀请码不正确或暂不可用，请向管理员确认后再试。";
  }
}

/** Stable opaque legacy username: UI presents the verified email, not this ID. */
export function usernameForEmail(email: string): string {
  return `u-${createHash("sha256").update(email).digest("hex").slice(0, 20)}`;
}

export function normalizeInvitationCode(value: string): string {
  return normalizeInviteCode(value);
}

/** The internal pilot has one shared admission code; legacy generated codes do not grant admission. */
export function assertRegistrationAllowed(invitationCode?: string, _policy?: RegistrationPolicy): void {
  const normalized = invitationCode ? normalizeInviteCode(invitationCode) : "";
  if (!normalized) {
    throw new AppError(
      422,
      "invite_code_required",
      "注册没成：公司内部试点需要邀请码，请向管理员确认后再试。",
      false,
    );
  }
  if (normalized !== INTERNAL_PILOT_INVITATION_CODE) {
    throw new AppError(
      422,
      "invite_code_invalid",
      "注册没成：邀请码不正确或暂不可用，请向管理员确认后再试。",
      false,
    );
  }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt, scryptCost, scryptBlockSize, scryptParallelization);
  return [
    "scrypt",
    String(scryptCost),
    String(scryptBlockSize),
    String(scryptParallelization),
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, costText, blockSizeText, parallelizationText, saltText, keyText] = encoded.split("$");
  if (algorithm !== "scrypt" || !costText || !blockSizeText || !parallelizationText || !saltText || !keyText) return false;
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (![cost, blockSize, parallelization].every(Number.isSafeInteger)) return false;
  try {
    const expected = Buffer.from(keyText, "base64url");
    const actual = await derivePassword(password, Buffer.from(saltText, "base64url"), cost, blockSize, parallelization);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function derivePassword(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, derivedKeyLength, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: 64 * 1024 * 1024,
    }, (error, derivedKey) => error ? reject(error) : resolve(derivedKey));
  });
}

function defaultDisplayName(email: string): string {
  const local = email.slice(0, email.indexOf("@"));
  return local || "新用户";
}

function toPublicUser(user: { id: string; username: string; displayName: string; role?: unknown; uiMode?: unknown }): PublicUser {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    role: platformRoleOrMember(user.role),
    // 登录/注册响应直接带界面模式：Lite 用户登录后前端要立刻据此跳转 /lite。
    ui_mode: uiModeOrFull(user.uiMode),
  };
}
