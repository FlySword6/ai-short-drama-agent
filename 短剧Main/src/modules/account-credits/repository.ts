import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../shared/errors.js";
import { generateInviteCode } from "./service.js";
import { CREDIT_POINT_TO_FEN, type AccountCreditActor, type AccountCreditAdjustment, type AccountCreditStore, type AccountCreditSummary, type AdjustAccountCreditInput, type CreateInvitationTierInput, type CreateInviteCodeInput, type InvitationTier, type InviteCodeRecord, type SelfRegistrationCreditPolicy, type UpdateInvitationTierInput, type UpdateInviteCodeInput, type UpdateSelfRegistrationCreditPolicyInput } from "./types.js";

type SqlResult<T> = { rows: T[] };
const users = table("users");
const accounts = table("user_credit_accounts");
const dailyUsage = table("user_credit_daily_usage");
const tiers = table("invite_tiers");
const inviteCodes = table("invite_codes");
const policy = table("account_credit_policies");
const ledger = table("user_credit_ledger_entries");
const operationActions = table("admin_operation_actions");

interface AccountRow { user_id: string; balance_points: number | string; daily_limit_points: number | string; }
interface UsageRow { charged_points: number | string; }
interface TierRow { id: string; tier_key: string; display_name: string; grant_points: number | string; daily_limit_points: number | string; active: boolean; created_at: Date | string; updated_at: Date | string; }
interface InviteCodeRow { id: string; code_prefix: string; tier_id: string; tier_key: string; grant_points: number | string; daily_limit_points: number | string; max_uses: number | string; used_count: number | string; expires_at: Date | string | null; status: string; created_at: Date | string; updated_at: Date | string; }
interface PolicyRow { policy_key: "self_registration"; daily_limit_points: number | string; updated_at: Date | string; }

/**
 * Uses schema-qualified raw SQL so this module can land independently from the
 * integrator-owned Drizzle schema update. Every administrator mutation writes
 * admin_operation_actions within the same transaction.
 */
export class AccountCreditRepository implements AccountCreditStore {
  constructor(private readonly db: Database) {}

  async getSummary(userId: string): Promise<AccountCreditSummary> {
    return readAccountCreditSummary(this.db, userId);
  }

  async listInvitationTiers(actor: AccountCreditActor): Promise<InvitationTier[]> {
    await assertAdmin(this.db, actor.userId);
    return (await query<TierRow>(this.db, sql`
      SELECT id, tier_key, display_name, grant_points, daily_limit_points, active, created_at, updated_at
      FROM ${tiers} ORDER BY active DESC, tier_key ASC
    `)).map(toTier);
  }

  async createInvitationTier(actor: AccountCreditActor, input: CreateInvitationTierInput): Promise<InvitationTier> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const now = new Date();
      const id = randomUUID();
      const [row] = await query<TierRow>(db, sql`
        INSERT INTO ${tiers} (id, tier_key, display_name, grant_points, daily_limit_points, active, created_by_user_id, updated_by_user_id, created_at, updated_at)
        VALUES (${id}, ${input.code}, ${input.name}, ${input.grantPoints}, ${input.dailyLimitPoints}, TRUE, ${actor.userId}, ${actor.userId}, ${now}, ${now})
        RETURNING id, tier_key, display_name, grant_points, daily_limit_points, active, created_at, updated_at
      `);
      if (!row) throw new Error("邀请码档位创建失败");
      await writeAudit(db, actor, "invite_tier_created", "invite_tier", id, { code: input.code, grant_points: input.grantPoints, daily_limit_points: input.dailyLimitPoints });
      return toTier(row);
    });
  }

  async updateInvitationTier(actor: AccountCreditActor, tierId: string, input: UpdateInvitationTierInput): Promise<InvitationTier> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const [current] = await query<TierRow>(db, sql`
        SELECT id, tier_key, display_name, grant_points, daily_limit_points, active, created_at, updated_at
        FROM ${tiers} WHERE id = ${tierId} FOR UPDATE
      `);
      if (!current) throw new NotFoundError("修改邀请码档位没成：找不到这个档位，请刷新列表后再试。");
      const now = new Date();
      const [row] = await query<TierRow>(db, sql`
        UPDATE ${tiers}
        SET display_name = ${input.name ?? current.display_name},
            grant_points = ${input.grantPoints ?? numberValue(current.grant_points)},
            daily_limit_points = ${input.dailyLimitPoints ?? numberValue(current.daily_limit_points)},
            active = ${input.active ?? current.active}, updated_by_user_id = ${actor.userId}, updated_at = ${now}
        WHERE id = ${tierId}
        RETURNING id, tier_key, display_name, grant_points, daily_limit_points, active, created_at, updated_at
      `);
      if (!row) throw new Error("邀请码档位更新失败");
      await writeAudit(db, actor, "invite_tier_updated", "invite_tier", tierId, { name: row.display_name, grant_points: numberValue(row.grant_points), daily_limit_points: numberValue(row.daily_limit_points), active: row.active });
      return toTier(row);
    });
  }

  async deactivateInvitationTier(actor: AccountCreditActor, tierId: string): Promise<void> {
    await this.updateInvitationTier(actor, tierId, { active: false });
  }

  async listInviteCodes(actor: AccountCreditActor): Promise<InviteCodeRecord[]> {
    await assertAdmin(this.db, actor.userId);
    return (await query<InviteCodeRow>(this.db, sql`
      SELECT c.id, c.code_prefix, c.tier_id, c.tier_key,
             c.grant_points, c.daily_limit_points, c.max_uses, c.used_count,
             c.expires_at, c.status, c.created_at, c.updated_at
      FROM ${inviteCodes} c
      ORDER BY c.created_at DESC, c.id DESC
    `)).map(toInviteCode);
  }

  async createInviteCode(actor: AccountCreditActor, input: CreateInviteCodeInput): Promise<{ inviteCode: InviteCodeRecord; plaintextCode: string }> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const [tier] = await query<TierRow>(db, sql`
        SELECT id, tier_key, display_name, grant_points, daily_limit_points, active, created_at, updated_at
        FROM ${tiers} WHERE id = ${input.tierId} AND active = TRUE FOR UPDATE
      `);
      if (!tier) throw new NotFoundError("新建邀请码没成：找不到可用的档位，请刷新列表后再试。");
      const plaintextCode = generateInviteCode();
      const now = new Date();
      const id = randomUUID();
      const [row] = await query<InviteCodeRow>(db, sql`
        INSERT INTO ${inviteCodes}
          (id, code_hash, code_prefix, tier_id, tier_key, grant_points, daily_limit_points, max_uses, used_count, expires_at, status, issued_by_user_id, created_at, updated_at)
        VALUES
          (${id}, ${hashInviteCode(plaintextCode)}, ${maskPrefix(plaintextCode)}, ${tier.id}, ${tier.tier_key},
           ${numberValue(tier.grant_points)}, ${numberValue(tier.daily_limit_points)},
           ${input.maxRedemptions ?? 1}, 0, ${input.expiresAt ?? null}, 'active', ${actor.userId}, ${now}, ${now})
        RETURNING id, code_prefix, tier_id, tier_key,
          grant_points, daily_limit_points, max_uses, used_count, expires_at, status, created_at, updated_at
      `);
      if (!row) throw new Error("邀请码创建失败");
      await writeAudit(db, actor, "invite_code_created", "invite_code", id, { tier_id: tier.id, code_prefix: maskPrefix(plaintextCode), max_redemptions: input.maxRedemptions ?? null, expires_at: input.expiresAt?.toISOString() ?? null });
      return { inviteCode: toInviteCode(row), plaintextCode };
    });
  }

  async updateInviteCode(actor: AccountCreditActor, codeId: string, input: UpdateInviteCodeInput): Promise<InviteCodeRecord> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const [current] = await query<InviteCodeRow>(db, sql`
        SELECT c.id, c.code_prefix, c.tier_id, c.tier_key,
               c.grant_points, c.daily_limit_points, c.max_uses, c.used_count,
               c.expires_at, c.status, c.created_at, c.updated_at
        FROM ${inviteCodes} c WHERE c.id = ${codeId} FOR UPDATE
      `);
      if (!current) throw new NotFoundError("修改邀请码没成：找不到这张邀请码，请刷新列表后再试。");
      const requestedMax = input.maxRedemptions === undefined ? numberValue(current.max_uses) : input.maxRedemptions;
      if (numberValue(requestedMax) < numberValue(current.used_count)) {
        throw new ConflictError("修改邀请码没成：可用次数不能少于已使用次数，请提高次数后再试。", "invite_code_usage_conflict");
      }
      const now = new Date();
      const [row] = await query<InviteCodeRow>(db, sql`
        UPDATE ${inviteCodes}
        SET max_uses = ${requestedMax}, expires_at = ${input.expiresAt === undefined ? current.expires_at : input.expiresAt},
            status = ${input.active === undefined ? current.status : input.active ? "active" : "revoked"}, updated_at = ${now}
        WHERE id = ${codeId}
        RETURNING id, code_prefix, tier_id, tier_key,
          grant_points, daily_limit_points, max_uses, used_count, expires_at, status, created_at, updated_at
      `);
      if (!row) throw new Error("邀请码更新失败");
      await writeAudit(db, actor, "invite_code_updated", "invite_code", codeId, { code_prefix: row.code_prefix, max_uses: row.max_uses, expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at, status: row.status });
      return toInviteCode(row);
    });
  }

  async deactivateInviteCode(actor: AccountCreditActor, codeId: string): Promise<void> {
    await this.updateInviteCode(actor, codeId, { active: false });
  }

  async getSelfRegistrationPolicy(actor: AccountCreditActor): Promise<SelfRegistrationCreditPolicy> {
    await assertAdmin(this.db, actor.userId);
    const [row] = await query<PolicyRow>(this.db, sql`
      SELECT policy_key, daily_limit_points, updated_at FROM ${policy} WHERE policy_key = 'self_registration' LIMIT 1
    `);
    if (!row) throw new NotFoundError("查看注册积分规则没成：规则暂未准备好，请联系管理员处理。");
    return toPolicy(row);
  }

  async updateSelfRegistrationPolicy(actor: AccountCreditActor, input: UpdateSelfRegistrationCreditPolicyInput): Promise<SelfRegistrationCreditPolicy> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const now = new Date();
      const [row] = await query<PolicyRow>(db, sql`
        UPDATE ${policy} SET daily_limit_points = ${input.dailyLimitPoints}, updated_by_user_id = ${actor.userId}, updated_at = ${now}
        WHERE policy_key = 'self_registration'
        RETURNING policy_key, daily_limit_points, updated_at
      `);
      if (!row) throw new NotFoundError("修改注册积分规则没成：规则暂未准备好，请联系管理员处理。");
      await writeAudit(db, actor, "self_registration_credit_policy_updated", "account_credit_policy", null, { policy_key: "self_registration", daily_limit_points: input.dailyLimitPoints });
      return toPolicy(row);
    });
  }

  async adjustBalance(actor: AccountCreditActor, userId: string, input: AdjustAccountCreditInput): Promise<AccountCreditAdjustment> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await assertAdmin(db, actor.userId);
      const [user] = await query<{ id: string }>(db, sql`SELECT id FROM ${users} WHERE id = ${userId} AND active = TRUE LIMIT 1`);
      if (!user) throw new NotFoundError("调整积分没成：找不到可用用户，请刷新列表后再试。");
      const [account] = await query<AccountRow>(db, sql`
        SELECT user_id, balance_points, daily_limit_points FROM ${accounts} WHERE user_id = ${userId} FOR UPDATE
      `);
      if (!account) throw new NotFoundError("调整积分没成：该用户的积分账户暂未就绪，请稍后重试。");
      const current = numberValue(account.balance_points);
      const next = current + input.amountPoints;
      if (next < 0) throw new ConflictError("调整积分没成：扣减后积分会不足，请减少扣减数量后再试。", "account_credit_insufficient");
      const now = new Date();
      await db.execute(sql`UPDATE ${accounts} SET balance_points = ${next}, updated_at = ${now} WHERE user_id = ${userId}`);
      await db.execute(sql`
        INSERT INTO ${ledger} (id, user_id, entry_kind, points_delta, balance_after_points, source_type, source_id, generation_request_id, actor_user_id, metadata, created_at)
        VALUES (${randomUUID()}, ${userId}, 'admin_adjustment', ${input.amountPoints}, ${next}, 'admin_adjustment', NULL, NULL, ${actor.userId}, ${JSON.stringify({ reason: input.reason })}::jsonb, ${now})
      `);
      await writeAudit(db, actor, "account_credit_adjusted", "user_credit_account", userId, { amount_points: input.amountPoints, balance_after_points: next, reason: input.reason });
      return { userId, balancePoints: next, amountPoints: input.amountPoints, reason: input.reason, createdAt: now };
    });
  }
}

/**
 * Shared by self-registration so the user, grant and account snapshot are
 * committed atomically. Passing the registration transaction keeps a missing
 * account trigger/result from becoming a partially successful signup.
 */
export async function readAccountCreditSummary(
  db: Database,
  userId: string,
  at = new Date(),
): Promise<AccountCreditSummary> {
  return readAccountCreditSummaryWithLock(db, userId, at, false);
}

/**
 * Authorization reads use the account row as the serialization point shared
 * with admin adjustments and migration 034 generation debits. Callers must
 * pass their current transaction; the lock is released with that transaction.
 */
export async function readAccountCreditSummaryForUpdate(
  db: Database,
  userId: string,
  at = new Date(),
): Promise<AccountCreditSummary> {
  return readAccountCreditSummaryWithLock(db, userId, at, true);
}

async function readAccountCreditSummaryWithLock(
  db: Database,
  userId: string,
  at: Date,
  lockAccount: boolean,
): Promise<AccountCreditSummary> {
  const [account] = await query<AccountRow>(db, lockAccount
    ? sql`
      SELECT user_id, balance_points, daily_limit_points
      FROM ${accounts} WHERE user_id = ${userId} LIMIT 1
      FOR UPDATE
    `
    : sql`
      SELECT user_id, balance_points, daily_limit_points
      FROM ${accounts} WHERE user_id = ${userId} LIMIT 1
    `);
  if (!account) throw new NotFoundError("查看积分没成：积分账户暂未就绪，请稍后重试。");
  const dayDate = chinaDate(at);
  const [usage] = await query<UsageRow>(db, sql`
    SELECT charged_points FROM ${dailyUsage} WHERE user_id = ${userId} AND usage_date = ${dayDate} LIMIT 1
  `);
  const balancePoints = numberValue(account.balance_points);
  const dailyLimitPoints = numberValue(account.daily_limit_points);
  const usedTodayPoints = numberValue(usage?.charged_points);
  return {
    userId,
    balancePoints,
    dailyLimitPoints,
    usedTodayPoints,
    remainingTodayPoints: Math.max(0, dailyLimitPoints - usedTodayPoints),
    dayDate,
    pointToFen: CREDIT_POINT_TO_FEN,
  };
}

function table(name: string) { return sql`${sql.identifier(settings.postgresSchema)}.${sql.identifier(name)}`; }
async function query<T>(db: Database, statement: ReturnType<typeof sql>): Promise<T[]> { return (await db.execute(statement) as unknown as SqlResult<T>).rows; }
async function assertAdmin(db: Database, userId: string): Promise<void> {
  const [actor] = await query<{ role: string | null }>(db, sql`SELECT role FROM ${users} WHERE id = ${userId} AND active = TRUE LIMIT 1`);
  if (!actor) throw new UnauthorizedError("继续操作没成：登录已失效，请重新登录。");
  if (actor.role !== "admin") throw new ForbiddenError("管理积分没成：当前账号没有权限，请联系管理员处理。");
}
async function writeAudit(db: Database, actor: AccountCreditActor, action: string, targetType: string, targetId: string | null, metadata: Record<string, unknown>): Promise<void> {
  await db.execute(sql`INSERT INTO ${operationActions} (id, actor_user_id, actor_session_id, action, target_type, target_id, metadata, created_at)
    VALUES (${randomUUID()}, ${actor.userId}, ${actor.sessionId ?? null}, ${action}, ${targetType}, ${targetId}, ${JSON.stringify(metadata)}::jsonb, ${new Date()})`);
}
/** Shared with auth registration so issued codes and redemptions use one hash. */
export function hashInviteCode(value: string): string {
  return createHash("sha256").update(normalizeInviteCode(value)).digest("hex");
}

export function normalizeInviteCode(value: string): string { return value.trim().toUpperCase(); }
function maskPrefix(value: string): string { return `${value.slice(0, 5)}••••`; }
function chinaDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function numberValue(value: number | string | null | undefined): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function dateValue(value: Date | string): Date { return value instanceof Date ? value : new Date(value); }
function toTier(row: TierRow): InvitationTier { return { id: row.id, code: row.tier_key, name: row.display_name, grantPoints: numberValue(row.grant_points), dailyLimitPoints: numberValue(row.daily_limit_points), active: row.active, createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) }; }
function toInviteCode(row: InviteCodeRow): InviteCodeRecord { return { id: row.id, prefix: row.code_prefix, tierId: row.tier_id, tierCode: row.tier_key, grantPoints: numberValue(row.grant_points), dailyLimitPoints: numberValue(row.daily_limit_points), maxRedemptions: numberValue(row.max_uses), usedRedemptions: numberValue(row.used_count), expiresAt: row.expires_at === null ? null : dateValue(row.expires_at), active: row.status === "active", createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) }; }
function toPolicy(row: PolicyRow): SelfRegistrationCreditPolicy { return { policyKey: "self_registration", dailyLimitPoints: numberValue(row.daily_limit_points), updatedAt: dateValue(row.updated_at) }; }
