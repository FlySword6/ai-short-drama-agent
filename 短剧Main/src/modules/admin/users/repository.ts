import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import {
  adminOperationActions,
  sessions,
  userCreditAccounts,
  userCreditDailyUsage,
  users,
  type UiMode,
} from "../../../db/schema.js";
import { ConflictError, NotFoundError } from "../../../shared/errors.js";
import { CREDIT_POINT_TO_FEN } from "../../account-credits/types.js";
import { adminUserActions } from "./table.js";
import type {
  AdminActor,
  AdminUserActionKind,
  AdminUserListRecord,
  AdminUserMutationResult,
  AdminUserRecord,
  AdminUserStore,
} from "./types.js";
import type { PlatformRole } from "../../auth/types.js";

const safeUserProjection = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  uiMode: users.uiMode,
  active: users.active,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

const safeListedUserProjection = {
  ...safeUserProjection,
  email: users.email,
  emailVerifiedAt: users.emailVerifiedAt,
  accountUserId: userCreditAccounts.userId,
  balancePoints: userCreditAccounts.balancePoints,
  dailyLimitPoints: userCreditAccounts.dailyLimitPoints,
  usedTodayPoints: userCreditDailyUsage.chargedPoints,
};

/**
 * PostgreSQL remains the only formal source. Every successful operation and
 * its audit row share one transaction, so an unaudited admin mutation cannot
 * be committed.
 */
export class PostgresAdminUserRepository implements AdminUserStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listUsers(actor: AdminActor): Promise<AdminUserListRecord[]> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const dayDate = chinaDate(this.now());
      const rows = await tx.select(safeListedUserProjection).from(users)
        .leftJoin(userCreditAccounts, eq(userCreditAccounts.userId, users.id))
        .leftJoin(userCreditDailyUsage, and(
          eq(userCreditDailyUsage.userId, users.id),
          eq(userCreditDailyUsage.usageDate, dayDate),
        ))
        .orderBy(desc(users.createdAt), desc(users.id));
      const items: AdminUserListRecord[] = rows.map((row) => {
        const usedTodayPoints = row.usedTodayPoints ?? 0;
        return {
          id: row.id,
          username: row.username,
          displayName: row.displayName,
          role: row.role,
          uiMode: row.uiMode,
          active: row.active,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          email: row.email,
          emailVerifiedAt: row.emailVerifiedAt,
          accountCredit: row.accountUserId === null
            ? null
            : {
              userId: row.id,
              balancePoints: row.balancePoints ?? 0,
              dailyLimitPoints: row.dailyLimitPoints ?? 0,
              usedTodayPoints,
              remainingTodayPoints: Math.max(0, (row.dailyLimitPoints ?? 0) - usedTodayPoints),
              dayDate,
              pointToFen: CREDIT_POINT_TO_FEN,
            },
        };
      });
      await insertAudit(tx, {
        actor,
        action: "users_listed",
        metadata: { result_count: items.length },
      });
      return items;
    });
  }

  async createUser(
    actor: AdminActor,
    input: { username: string; displayName: string; passwordHash: string; role: PlatformRole; uiMode: UiMode },
  ): Promise<AdminUserRecord> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const now = new Date();
      const rows = await tx.insert(users).values({
        id: crypto.randomUUID(),
        username: input.username,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
        role: input.role,
        uiMode: input.uiMode,
        active: true,
        createdAt: now,
        updatedAt: now,
      }).returning(safeUserProjection);
      const user = rows[0];
      if (!user) throw new Error("管理员创建用户失败");
      await insertAudit(tx, {
        actor,
        targetUserId: user.id,
        action: "user_created",
        toActive: true,
        metadata: { role: input.role, ui_mode: input.uiMode },
      });
      return user;
    });
  }

  async updateRole(actor: AdminActor, targetUserId: string, role: PlatformRole): Promise<AdminUserRecord> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const current = (await tx.select(safeUserProjection).from(users)
        .where(eq(users.id, targetUserId)).limit(1).for("update"))[0];
      if (!current) throw new NotFoundError("修改用户没成：找不到该用户，请刷新列表后再试。");
      if (current.role === "admin" && role !== "admin") {
        const [admins] = await tx.select({ count: count() }).from(users).where(and(
          eq(users.role, "admin"),
          eq(users.active, true),
        ));
        if (Number(admins?.count ?? 0) <= 1) {
          throw new ConflictError("修改用户没成：至少要保留一位启用的管理员，请先启用其他管理员。", "last_admin_required");
        }
      }
      const updated = (await tx.update(users).set({ role, updatedAt: new Date() })
        .where(eq(users.id, targetUserId)).returning(safeUserProjection))[0];
      if (!updated) throw new Error("管理员更新用户角色失败");
      await tx.insert(adminOperationActions).values({
        id: crypto.randomUUID(),
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        action: "user_role_changed",
        targetType: "user",
        targetId: targetUserId,
        metadata: { from_role: current.role, to_role: role },
        createdAt: new Date(),
      });
      return updated;
    });
  }

  async updateUiMode(actor: AdminActor, targetUserId: string, uiMode: UiMode): Promise<AdminUserRecord> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const current = (await tx.select(safeUserProjection).from(users)
        .where(eq(users.id, targetUserId)).limit(1).for("update"))[0];
      if (!current) throw new NotFoundError("用户不存在");
      const updated = (await tx.update(users).set({ uiMode, updatedAt: new Date() })
        .where(eq(users.id, targetUserId)).returning(safeUserProjection))[0];
      if (!updated) throw new Error("管理员更新用户界面模式失败");
      await tx.insert(adminOperationActions).values({
        id: crypto.randomUUID(),
        actorUserId: actor.userId,
        actorSessionId: actor.sessionId,
        action: "user_ui_mode_changed",
        targetType: "user",
        targetId: targetUserId,
        metadata: { from_ui_mode: current.uiMode, to_ui_mode: uiMode },
        createdAt: new Date(),
      });
      return updated;
    });
  }

  async disableUser(actor: AdminActor, targetUserId: string): Promise<AdminUserMutationResult> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const current = (await tx.select(safeUserProjection).from(users)
        .where(eq(users.id, targetUserId)).limit(1).for("update"))[0];
      if (!current) throw new NotFoundError("停用用户没成：找不到该用户，请刷新列表后再试。");

      const now = new Date();
      const changed = current.active;
      const user = changed
        ? (await tx.update(users).set({ active: false, updatedAt: now })
          .where(eq(users.id, targetUserId)).returning(safeUserProjection))[0]
        : current;
      if (!user) throw new Error("管理员禁用用户失败");

      const revoked = await tx.update(sessions).set({ revokedAt: now }).where(and(
        eq(sessions.userId, targetUserId),
        isNull(sessions.revokedAt),
      )).returning({ id: sessions.id });

      await insertAudit(tx, {
        actor,
        targetUserId,
        action: "user_disabled",
        fromActive: current.active,
        toActive: false,
        metadata: { changed, revoked_session_count: revoked.length },
      });
      return { user, changed, revokedSessionCount: revoked.length };
    });
  }

  async resetPassword(
    actor: AdminActor,
    targetUserId: string,
    passwordHash: string,
  ): Promise<AdminUserMutationResult> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const current = (await tx.select(safeUserProjection).from(users)
        .where(eq(users.id, targetUserId)).limit(1).for("update"))[0];
      if (!current) throw new NotFoundError("重置密码没成：找不到该用户，请刷新列表后再试。");

      const now = new Date();
      const user = (await tx.update(users).set({ passwordHash, updatedAt: now })
        .where(eq(users.id, targetUserId)).returning(safeUserProjection))[0];
      if (!user) throw new Error("管理员重置密码失败");
      const revoked = await tx.update(sessions).set({ revokedAt: now }).where(and(
        eq(sessions.userId, targetUserId),
        isNull(sessions.revokedAt),
      )).returning({ id: sessions.id });

      await insertAudit(tx, {
        actor,
        targetUserId,
        action: "password_reset",
        fromActive: current.active,
        toActive: current.active,
        metadata: { revoked_session_count: revoked.length },
      });
      return { user, changed: true, revokedSessionCount: revoked.length };
    });
  }
}

async function insertAudit(
  db: Database,
  input: {
    actor: AdminActor;
    action: AdminUserActionKind;
    targetUserId?: string;
    fromActive?: boolean;
    toActive?: boolean;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(adminUserActions).values({
    id: crypto.randomUUID(),
    actorUserId: input.actor.userId,
    actorSessionId: input.actor.sessionId,
    targetUserId: input.targetUserId ?? null,
    action: input.action,
    fromActive: input.fromActive ?? null,
    toActive: input.toActive ?? null,
    metadata: input.metadata,
    createdAt: new Date(),
  });
}

function chinaDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
