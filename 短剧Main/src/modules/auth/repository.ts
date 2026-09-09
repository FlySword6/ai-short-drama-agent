import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import {
  adminOperationActions,
  emailVerificationCodes,
  sessions,
  users,
  wecomAuthTransactions,
  wecomUserIdentities,
  type UiMode,
  type UserRow,
} from "../../db/schema.js";
import { isPostgresUniqueViolation } from "../../shared/errors.js";
import { readAccountCreditSummary } from "../account-credits/repository.js";
import type { AccountCreditSummary } from "../account-credits/types.js";
import {
  isActiveCredentialSource,
  platformRoleOrMember,
  type ActiveCredentialSource,
  type HumanCredentialSource,
  type PlatformRole,
} from "./types.js";

export interface AuthenticatedSession {
  sessionId: string;
  user: Pick<UserRow, "id" | "username" | "displayName"> & { role: PlatformRole };
  credential: {
    source: ActiveCredentialSource;
    agentType: string | null;
    userAgent: string | null;
    expiresAt: Date;
  };
}

export interface AgentCredentialRecord {
  id: string;
  agentType: string;
  label: string;
  userAgent: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface EmailRegistrationInput {
  email: string;
  username: string;
  displayName: string;
  passwordHash: string;
  verificationCode: string;
  invitationCodeHash?: string;
  verifyCode: (code: string, encoded: string) => Promise<boolean>;
}

export interface EmailRegistrationFailure {
  code:
    | "email_verification_invalid"
    | "email_verification_expired"
    | "email_verification_attempts_exhausted"
    | "invite_code_required"
    | "invite_code_invalid";
  message: string;
}

export interface RegistrationGrant {
  source: "self_registration" | "invitation";
  grantedPoints: number;
}

export type EmailRegistrationOutcome =
  | {
    kind: "registered";
    user: UserRow;
    accountCredit: AccountCreditSummary;
    registrationGrant: RegistrationGrant;
  }
  | { kind: "rejected"; failure: EmailRegistrationFailure };

export type WecomTransactionFailure = "invalid" | "expired" | "replayed";

export type ConsumeWecomCallbackOutcome =
  | { kind: "consumed"; transactionId: string; returnPath: string }
  | { kind: WecomTransactionFailure };

export type ResolveWecomIdentityOutcome =
  | { kind: "resolved"; user: UserRow; created: boolean }
  | { kind: "transaction_invalid" | "identity_conflict" };

export type ExchangeWecomResultOutcome =
  | { kind: "exchanged"; sessionId: string; user: UserRow }
  | { kind: WecomTransactionFailure | "account_disabled" };

export interface WecomPrebindActor {
  userId: string;
  sessionId: string;
}

export type PrebindWecomIdentityOutcome = "bound" | "target_unavailable" | "identity_conflict";

interface VerificationCodeRow {
  id: string;
  code_hash: string;
  attempt_count: number | string;
  max_attempts: number | string;
  expires_at: Date | string;
}

interface InviteCodeRow {
  id: string;
  grant_points: number | string;
  daily_limit_points: number | string;
  max_uses: number | string;
  used_count: number | string;
  status: string;
  expires_at: Date | string | null;
}

interface CreditAccountRow {
  balance_points: number | string;
}

const verificationCodeTable = table("email_verification_codes");
const inviteCodeTable = table("invite_codes");
const creditAccountTable = table("user_credit_accounts");
const creditLedgerTable = table("user_credit_ledger_entries");
const invitationRedemptionTable = table("invite_code_redemptions");

export class AuthRepository {
  constructor(
    private readonly db: Database,
    /**
     * 同一账号是否只留一处人工登录。默认按运行环境推导：生产只留一处，开发与
     * 测试允许多处（见 config/env.ts）。传参是为了让回归测试能直接钉住两种行为。
     */
    private readonly singleActiveSession: boolean = settings.authSingleActiveSession,
  ) {}

  /** Accept an existing username or a verified email as the login identifier. */
  async findUserByUsername(usernameOrEmail: string): Promise<UserRow | undefined> {
    const value = usernameOrEmail.trim().toLowerCase();
    const rows = await this.db.select().from(users).where(or(
      eq(users.username, value),
      sql`lower(${users.email}) = ${value}`,
    )).limit(1);
    return rows[0];
  }

  async createUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    email?: string;
    emailVerifiedAt?: Date | null;
  }): Promise<UserRow> {
    const now = new Date();
    const rows = await this.db.insert(users).values({
      id: randomUUID(),
      username: input.username,
      email: input.email ?? null,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      role: "member",
      active: true,
      createdAt: now,
      updatedAt: now,
    }).returning();
    const user = rows[0];
    if (!user) throw new Error("Failed to create user");
    return user;
  }

  /**
   * 红线 R2：users.ui_mode 是界面模式的唯一事实源，按主键读取。
   * 列上的 CHECK 约束保证读数只会是 'lite' | 'full'。
   */
  async findUiModeByUserId(userId: string): Promise<UiMode | undefined> {
    const rows = await this.db.select({ uiMode: users.uiMode }).from(users).where(eq(users.id, userId)).limit(1);
    return rows[0]?.uiMode;
  }

  /** 本人切换界面模式；returning 为空说明账号在会话校验后已被删除。 */
  async updateUiMode(userId: string, uiMode: UiMode): Promise<UiMode | undefined> {
    const rows = await this.db.update(users)
      .set({ uiMode, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ uiMode: users.uiMode });
    return rows[0]?.uiMode;
  }

  async createWecomAuthTransaction(input: {
    stateHash: string;
    browserNonceHash: string;
    returnPath: string;
    expiresAt: Date;
  }, now = new Date()): Promise<string> {
    const id = randomUUID();
    await this.db.insert(wecomAuthTransactions).values({
      id,
      stateHash: input.stateHash,
      browserNonceHash: input.browserNonceHash,
      returnPath: input.returnPath,
      expiresAt: input.expiresAt,
      callbackConsumedAt: null,
      resultHash: null,
      resultExpiresAt: null,
      resultConsumedAt: null,
      resolvedUserId: null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  /**
   * Physically removes terminal OAuth transactions after their 24-hour
   * evidence window. Identity and session facts live in separate tables and
   * are deliberately outside this delete.
   */
  async deleteTerminalWecomAuthTransactions(cutoff: Date): Promise<number> {
    const deleted = await this.db.delete(wecomAuthTransactions).where(sql`
      (
        ${wecomAuthTransactions.resultHash} IS NULL
        AND (
          ${wecomAuthTransactions.callbackConsumedAt} <= ${cutoff}
          OR ${wecomAuthTransactions.expiresAt} <= ${cutoff}
        )
      )
      OR (
        ${wecomAuthTransactions.resultHash} IS NOT NULL
        AND (
          ${wecomAuthTransactions.resultConsumedAt} <= ${cutoff}
          OR ${wecomAuthTransactions.resultExpiresAt} <= ${cutoff}
        )
      )
    `).returning({ id: wecomAuthTransactions.id });
    return deleted.length;
  }

  /** Atomically consumes one state only when it belongs to the same browser. */
  async consumeWecomCallback(input: {
    stateHash: string;
    browserNonceHash: string;
  }, now = new Date()): Promise<ConsumeWecomCallbackOutcome> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const row = (await tx.select({
        id: wecomAuthTransactions.id,
        browserNonceHash: wecomAuthTransactions.browserNonceHash,
        returnPath: wecomAuthTransactions.returnPath,
        expiresAt: wecomAuthTransactions.expiresAt,
        callbackConsumedAt: wecomAuthTransactions.callbackConsumedAt,
      }).from(wecomAuthTransactions)
        .where(eq(wecomAuthTransactions.stateHash, input.stateHash))
        .limit(1)
        .for("update"))[0];

      if (!row || row.browserNonceHash !== input.browserNonceHash) return { kind: "invalid" };
      if (row.callbackConsumedAt) return { kind: "replayed" };
      if (row.expiresAt <= now) return { kind: "expired" };

      await tx.update(wecomAuthTransactions).set({
        callbackConsumedAt: now,
        updatedAt: now,
      }).where(eq(wecomAuthTransactions.id, row.id));
      return { kind: "consumed", transactionId: row.id, returnPath: row.returnPath };
    });
  }

  async findWecomIdentity(corpId: string, wecomUserId: string): Promise<{ displayName: string } | undefined> {
    return (await this.db.select({ displayName: users.displayName })
      .from(wecomUserIdentities)
      .innerJoin(users, eq(wecomUserIdentities.userId, users.id))
      .where(and(
        eq(wecomUserIdentities.corpId, corpId),
        eq(wecomUserIdentities.wecomUserId, wecomUserId),
      ))
      .limit(1))[0];
  }

  /**
   * Resolves or provisions one platform user and publishes the one-time result
   * in the same transaction. An advisory lock serializes concurrent first
   * logins for one external identity before either contender can create a user.
   */
  async resolveWecomIdentityAndIssueResult(input: {
    transactionId: string;
    corpId: string;
    wecomUserId: string;
    username: string;
    displayName: string;
    resultHash: string;
    resultExpiresAt: Date;
  }, now = new Date()): Promise<ResolveWecomIdentityOutcome> {
    try {
      return await this.db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const authTransaction = (await tx.select({
          id: wecomAuthTransactions.id,
          callbackConsumedAt: wecomAuthTransactions.callbackConsumedAt,
          resultHash: wecomAuthTransactions.resultHash,
        }).from(wecomAuthTransactions)
          .where(eq(wecomAuthTransactions.id, input.transactionId))
          .limit(1)
          .for("update"))[0];
        if (!authTransaction?.callbackConsumedAt || authTransaction.resultHash) {
          return { kind: "transaction_invalid" } as const;
        }

        const identityLockKey = JSON.stringify([input.corpId, input.wecomUserId]);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${identityLockKey}, 0))`);

        const existing = (await tx.select({
          identityId: wecomUserIdentities.id,
          account: users,
        }).from(wecomUserIdentities)
          .innerJoin(users, eq(wecomUserIdentities.userId, users.id))
          .where(and(
            eq(wecomUserIdentities.corpId, input.corpId),
            eq(wecomUserIdentities.wecomUserId, input.wecomUserId),
          ))
          .limit(1)
          .for("update"))[0];

        let user: UserRow;
        let created = false;
        if (existing) {
          user = existing.account;
          await tx.update(wecomUserIdentities).set({
            lastAuthenticatedAt: now,
            updatedAt: now,
          }).where(eq(wecomUserIdentities.id, existing.identityId));
        } else {
          const inserted = await tx.insert(users).values({
            id: randomUUID(),
            username: input.username,
            email: null,
            emailVerifiedAt: null,
            displayName: input.displayName,
            passwordHash: null,
            role: "member",
            uiMode: "full",
            active: true,
            createdAt: now,
            updatedAt: now,
          }).returning();
          user = inserted[0]!;
          await tx.insert(wecomUserIdentities).values({
            id: randomUUID(),
            userId: user.id,
            corpId: input.corpId,
            wecomUserId: input.wecomUserId,
            lastAuthenticatedAt: now,
            createdAt: now,
            updatedAt: now,
          });
          created = true;
        }

        await tx.update(wecomAuthTransactions).set({
          resultHash: input.resultHash,
          resultExpiresAt: input.resultExpiresAt,
          resolvedUserId: user.id,
          updatedAt: now,
        }).where(eq(wecomAuthTransactions.id, input.transactionId));
        return { kind: "resolved", user, created } as const;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) return { kind: "identity_conflict" };
      throw error;
    }
  }

  /** Consumes the one-time result and signs the existing web-session contract atomically. */
  async exchangeWecomResultForSession(input: {
    resultHash: string;
    browserNonceHash: string;
    tokenHash: string;
    userAgent: string | null;
    expiresAt: Date;
  }, now = new Date()): Promise<ExchangeWecomResultOutcome> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const authTransaction = (await tx.select({
        id: wecomAuthTransactions.id,
        browserNonceHash: wecomAuthTransactions.browserNonceHash,
        resultExpiresAt: wecomAuthTransactions.resultExpiresAt,
        resultConsumedAt: wecomAuthTransactions.resultConsumedAt,
        resolvedUserId: wecomAuthTransactions.resolvedUserId,
      }).from(wecomAuthTransactions)
        .where(eq(wecomAuthTransactions.resultHash, input.resultHash))
        .limit(1)
        .for("update"))[0];

      if (!authTransaction || authTransaction.browserNonceHash !== input.browserNonceHash) {
        return { kind: "invalid" };
      }
      if (authTransaction.resultConsumedAt) return { kind: "replayed" };
      if (!authTransaction.resultExpiresAt || authTransaction.resultExpiresAt <= now) {
        return { kind: "expired" };
      }
      if (!authTransaction.resolvedUserId) return { kind: "invalid" };

      const user = (await tx.select().from(users)
        .where(eq(users.id, authTransaction.resolvedUserId))
        .limit(1)
        .for("update"))[0];
      if (!user) return { kind: "invalid" };
      if (!user.active) return { kind: "account_disabled" };

      if (this.singleActiveSession) {
        await tx.update(sessions).set({ revokedAt: now }).where(and(
          eq(sessions.userId, user.id),
          inArray(sessions.credentialSource, ["web", "cli"]),
          isNull(sessions.revokedAt),
        ));
      }
      const sessionId = randomUUID();
      await tx.insert(sessions).values({
        id: sessionId,
        userId: user.id,
        tokenHash: input.tokenHash,
        credentialSource: "web",
        agentType: null,
        userAgent: input.userAgent,
        credentialLabel: null,
        issuedBySessionId: null,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: now,
      });
      await tx.update(wecomAuthTransactions).set({
        resultConsumedAt: now,
        updatedAt: now,
      }).where(eq(wecomAuthTransactions.id, authTransaction.id));
      return { kind: "exchanged", sessionId, user };
    });
  }

  /** Bind one active platform user to one WeCom identity and audit atomically. */
  async prebindWecomIdentity(input: {
    actor: WecomPrebindActor;
    userId: string;
    corpId: string;
    wecomUserId: string;
  }, now = new Date()): Promise<PrebindWecomIdentityOutcome> {
    try {
      return await this.db.transaction(async (transaction) => {
        const tx = transaction as unknown as Database;
        const target = (await tx.select({ id: users.id, active: users.active }).from(users)
          .where(eq(users.id, input.userId)).limit(1).for("update"))[0];
        if (!target?.active) return "target_unavailable" as const;

        const existingForIdentity = (await tx.select({
          id: wecomUserIdentities.id,
          userId: wecomUserIdentities.userId,
        }).from(wecomUserIdentities).where(and(
          eq(wecomUserIdentities.corpId, input.corpId),
          eq(wecomUserIdentities.wecomUserId, input.wecomUserId),
        )).limit(1).for("update"))[0];
        const existingForUser = (await tx.select({
          id: wecomUserIdentities.id,
          corpId: wecomUserIdentities.corpId,
          wecomUserId: wecomUserIdentities.wecomUserId,
        }).from(wecomUserIdentities).where(eq(wecomUserIdentities.userId, input.userId))
          .limit(1).for("update"))[0];

        if (existingForIdentity || existingForUser) {
          const sameBinding = existingForIdentity?.userId === input.userId
            && existingForUser?.corpId === input.corpId
            && existingForUser?.wecomUserId === input.wecomUserId;
          if (!sameBinding) return "identity_conflict" as const;
        } else {
          await tx.insert(wecomUserIdentities).values({
            id: randomUUID(),
            userId: input.userId,
            corpId: input.corpId,
            wecomUserId: input.wecomUserId,
            lastAuthenticatedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        await tx.insert(adminOperationActions).values({
          id: randomUUID(),
          actorUserId: input.actor.userId,
          actorSessionId: input.actor.sessionId,
          action: "wecom_identity_bound",
          targetType: "user",
          targetId: input.userId,
          metadata: { corp_id: input.corpId, changed: !existingForIdentity },
          createdAt: now,
        });
        return "bound" as const;
      });
    } catch (error) {
      if (isPostgresUniqueViolation(error)) return "identity_conflict";
      throw error;
    }
  }

  /**
   * Only hashes are persisted. Issuing a replacement code invalidates any
   * previous unfinished registration code for the same mailbox.
   */
  async issueEmailVerificationCode(input: {
    email: string;
    codeHash: string;
    expiresAt: Date;
    maxAttempts: number;
  }): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const now = new Date();
      await db.update(emailVerificationCodes)
        .set({ consumedAt: now })
        .where(and(
          eq(emailVerificationCodes.email, input.email),
          eq(emailVerificationCodes.purpose, "registration"),
          isNull(emailVerificationCodes.consumedAt),
        ));
      await db.insert(emailVerificationCodes).values({
        id: randomUUID(),
        email: input.email,
        purpose: "registration",
        codeHash: input.codeHash,
        attemptCount: 0,
        maxAttempts: input.maxAttempts,
        expiresAt: input.expiresAt,
        consumedAt: null,
        createdAt: now,
      });
    });
  }

  /**
   * Registration, verification-code consumption and invite-code redemption
   * are deliberately one transaction. The invite row is locked before its
   * use counter moves, preventing concurrent signup over-issue.
   */
  async registerVerifiedEmail(input: EmailRegistrationInput): Promise<EmailRegistrationOutcome> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const now = new Date();
      const verification = (await query<VerificationCodeRow>(db, sql`
        SELECT id, code_hash, attempt_count, max_attempts, expires_at
        FROM ${verificationCodeTable}
        WHERE email = ${input.email}
          AND purpose = 'registration'
          AND consumed_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE
      `))[0];
      if (!verification) {
        return rejected("email_verification_invalid", "请先获取邮箱验证码，再完成注册");
      }
      if (dateValue(verification.expires_at) <= now) {
        return rejected("email_verification_expired", "验证码已过期，请重新获取");
      }
      if (numberValue(verification.attempt_count) >= numberValue(verification.max_attempts)) {
        return rejected("email_verification_attempts_exhausted", "验证码尝试次数已用完，请重新获取");
      }
      if (!(await input.verifyCode(input.verificationCode, verification.code_hash))) {
        await db.execute(sql`
          UPDATE ${verificationCodeTable}
          SET attempt_count = attempt_count + 1
          WHERE id = ${verification.id}
        `);
        return rejected("email_verification_invalid", "验证码不正确，请重试");
      }

      if (!input.invitationCodeHash) {
        return rejected("invite_code_required", "公司内部试点注册必须填写邀请码");
      }
      const invitation = (await query<InviteCodeRow>(db, sql`
        SELECT id, grant_points, daily_limit_points, max_uses, used_count, status, expires_at
        FROM ${inviteCodeTable}
        WHERE code_hash = ${input.invitationCodeHash}
        LIMIT 1
        FOR UPDATE
      `))[0];
      if (!isRedeemable(invitation, now)) {
        return rejected("invite_code_invalid", "邀请码无效、已停用或已用完");
      }

      const inserted = await db.insert(users).values({
        id: randomUUID(),
        username: input.username,
        email: input.email,
        emailVerifiedAt: now,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        role: "member",
        active: true,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const user = inserted[0];
      if (!user) throw new Error("邮箱注册创建用户失败");

      let registrationGrant: RegistrationGrant = {
        source: "self_registration",
        grantedPoints: 0,
      };
      if (invitation) {
        const account = (await query<CreditAccountRow>(db, sql`
          SELECT balance_points
          FROM ${creditAccountTable}
          WHERE user_id = ${user.id}
          FOR UPDATE
        `))[0];
        if (!account) throw new Error("邮箱注册后未创建账户积分账户");
        const grantPoints = numberValue(invitation.grant_points);
        const balanceAfter = numberValue(account.balance_points) + grantPoints;
        const dailyLimitPoints = numberValue(invitation.daily_limit_points);
        registrationGrant = { source: "invitation", grantedPoints: grantPoints };
        await db.execute(sql`
          UPDATE ${creditAccountTable}
          SET balance_points = ${balanceAfter}, daily_limit_points = ${dailyLimitPoints}, updated_at = ${now}
          WHERE user_id = ${user.id}
        `);
        await db.execute(sql`
          UPDATE ${inviteCodeTable}
          SET used_count = used_count + 1, updated_at = ${now}
          WHERE id = ${invitation.id}
        `);
        await db.execute(sql`
          INSERT INTO ${creditLedgerTable}
            (id, user_id, entry_kind, points_delta, balance_after_points, source_type, source_id, generation_request_id, actor_user_id, metadata, created_at)
          VALUES (
            ${randomUUID()}, ${user.id}, 'invite_grant', ${grantPoints}, ${balanceAfter},
            'invite_code', ${invitation.id}, NULL, NULL,
            ${JSON.stringify({ registration: "email" })}::jsonb, ${now}
          )
        `);
        await db.execute(sql`
          INSERT INTO ${invitationRedemptionTable}
            (id, invite_code_id, user_id, grant_points, daily_limit_points, redeemed_at)
          VALUES (${randomUUID()}, ${invitation.id}, ${user.id}, ${grantPoints}, ${dailyLimitPoints}, ${now})
        `);
      }

      await db.execute(sql`
        UPDATE ${verificationCodeTable}
        SET consumed_at = ${now}
        WHERE id = ${verification.id}
      `);
      return {
        kind: "registered",
        user,
        accountCredit: await readAccountCreditSummary(db, user.id, now),
        registrationGrant,
      };
    });
  }

  async createHumanSession(input: {
    userId: string;
    expectedPasswordHash: string;
    tokenHash: string;
    source: HumanCredentialSource;
    userAgent: string | null;
    expiresAt: Date;
  }): Promise<string | undefined> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      // Serialize human logins for this user. The same row lock also closes the
      // reset/disable race before the replacement session is committed.
      const current = (await tx.select({
        passwordHash: users.passwordHash,
        active: users.active,
      }).from(users).where(eq(users.id, input.userId)).limit(1).for("update"))[0];
      if (!current?.active || current.passwordHash !== input.expectedPasswordHash) return undefined;

      const now = new Date();
      // 只有「同一账号只留一处登录」开着时才撤销该账号其余的人工会话。上面的行锁
      // 与密码/停用比对不受这个开关影响：它们关的是「管理员改密或停用」与「签发
      // 新会话」之间的竞态，和「同时能登几处」是两件事。一起摘掉，旧密码就能在
      // 竞态窗口里换出一个活会话。
      if (this.singleActiveSession) {
        await tx.update(sessions).set({ revokedAt: now }).where(and(
          eq(sessions.userId, input.userId),
          inArray(sessions.credentialSource, ["web", "cli"]),
          isNull(sessions.revokedAt),
        ));
      }
      const id = randomUUID();
      await tx.insert(sessions).values({
        id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        credentialSource: input.source,
        agentType: null,
        userAgent: input.userAgent,
        credentialLabel: null,
        issuedBySessionId: null,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: now,
      });
      return id;
    });
  }

  async createAgentSession(input: {
    userId: string;
    issuedBySessionId: string;
    tokenHash: string;
    agentType: string;
    label: string;
    userAgent: string | null;
    expiresAt: Date;
  }, now = new Date()): Promise<string | undefined> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const issuer = (await tx.select({ id: sessions.id })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(and(
          eq(sessions.id, input.issuedBySessionId),
          eq(sessions.userId, input.userId),
          inArray(sessions.credentialSource, ["web", "cli"]),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          eq(users.active, true),
        ))
        .limit(1)
        .for("share"))[0];
      if (!issuer) return undefined;

      const id = randomUUID();
      await tx.insert(sessions).values({
        id,
        userId: input.userId,
        tokenHash: input.tokenHash,
        credentialSource: "agent",
        agentType: input.agentType,
        userAgent: input.userAgent,
        credentialLabel: input.label,
        issuedBySessionId: input.issuedBySessionId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: now,
      });
      return id;
    });
  }

  async listAgentSessions(userId: string): Promise<AgentCredentialRecord[]> {
    const rows = await this.db.select({
      id: sessions.id,
      agentType: sessions.agentType,
      label: sessions.credentialLabel,
      userAgent: sessions.userAgent,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      createdAt: sessions.createdAt,
    }).from(sessions).where(and(
      eq(sessions.userId, userId),
      eq(sessions.credentialSource, "agent"),
    )).orderBy(desc(sessions.createdAt), desc(sessions.id));
    return rows.map((row) => {
      if (!row.agentType || !row.label) throw new Error("Agent credential row violates migration 047 shape");
      return {
        id: row.id,
        agentType: row.agentType,
        label: row.label,
        userAgent: row.userAgent,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        createdAt: row.createdAt,
      };
    });
  }

  async revokeAgentSession(userId: string, credentialId: string, now = new Date()): Promise<boolean> {
    const rows = await this.db.update(sessions).set({ revokedAt: now }).where(and(
      eq(sessions.id, credentialId),
      eq(sessions.userId, userId),
      eq(sessions.credentialSource, "agent"),
      isNull(sessions.revokedAt),
    )).returning({ id: sessions.id });
    return rows.length > 0;
  }

  async findActiveSession(tokenHash: string, now = new Date()): Promise<AuthenticatedSession | undefined> {
    const rows = await this.db
      .select({
        sessionId: sessions.id,
        credentialSource: sessions.credentialSource,
        agentType: sessions.agentType,
        userAgent: sessions.userAgent,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(
        eq(sessions.tokenHash, tokenHash),
        inArray(sessions.credentialSource, ["web", "cli", "agent"]),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, now),
        eq(users.active, true),
      ))
      .limit(1);
    const row = rows[0];
    if (!row || !isActiveCredentialSource(row.credentialSource)) return undefined;
    return {
      sessionId: row.sessionId,
      user: {
        id: row.userId,
        username: row.username,
        displayName: row.displayName,
        role: platformRoleOrMember(row.role),
      },
      credential: {
        source: row.credentialSource,
        agentType: row.agentType,
        userAgent: row.userAgent,
        expiresAt: row.expiresAt,
      },
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
  }
}

function table(name: string) {
  return sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier(name)}`;
}

async function query<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(statement) as unknown as { rows: T[] }).rows;
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function numberValue(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("账户积分数据不是有效整数");
  return parsed;
}

function isRedeemable(row: InviteCodeRow | undefined, now: Date): row is InviteCodeRow {
  if (!row) return false;
  return row.status === "active"
    && numberValue(row.used_count) < numberValue(row.max_uses)
    && (!row.expires_at || dateValue(row.expires_at) > now);
}

function rejected(
  code: EmailRegistrationFailure["code"],
  message: string,
): EmailRegistrationOutcome {
  return { kind: "rejected", failure: { code, message } };
}
