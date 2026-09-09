import { randomBytes } from "node:crypto";
import { settings } from "../../../config/env.js";
import type { UiMode } from "../../../db/schema.js";
import { hashPassword, normalizeUsername } from "../../auth/service.js";
import { BadRequestError, ConflictError, isPostgresUniqueViolation } from "../../../shared/errors.js";
import type {
  AdminActor,
  AdminUserListRecord,
  AdminUserMutationResult,
  AdminUserRecord,
  AdminUserStore,
} from "./types.js";
import type { PlatformRole } from "../../auth/types.js";

const usernamePattern = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

export interface AdminUserServiceOptions {
  passwordMinLength?: number;
}

export class AdminUserService {
  private readonly passwordMinLength: number;

  constructor(
    private readonly store: AdminUserStore,
    options: AdminUserServiceOptions = {},
  ) {
    this.passwordMinLength = options.passwordMinLength ?? settings.authPasswordMinLength;
  }

  async listUsers(actor: AdminActor): Promise<AdminUserListRecord[]> {
    return this.store.listUsers(actor);
  }

  async createUser(
    actor: AdminActor,
    input: { username: string; displayName?: string; role?: PlatformRole; uiMode?: UiMode },
  ): Promise<{ user: AdminUserRecord; initialPassword: string }> {
    const username = normalizeUsername(input.username);
    if (!usernamePattern.test(username)) {
      throw new BadRequestError("新建用户没成：用户名格式不对，请用 3 至 64 位小写字母、数字、点、横线或下划线。");
    }
    const displayName = input.displayName?.trim() || username;
    if (displayName.length > 128) throw new BadRequestError("新建用户没成：显示名称过长，请缩短后再试。");

    const initialPassword = generateTemporaryPassword(this.passwordMinLength);
    try {
      const user = await this.store.createUser(actor, {
        username,
        displayName,
        passwordHash: await hashPassword(initialPassword),
        role: input.role ?? "member",
        uiMode: input.uiMode ?? "full",
      });
      return { user, initialPassword };
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError("新建用户没成：这个用户名已被使用，请换一个再试。", "username_exists");
      throw error;
    }
  }

  async updateRole(
    actor: AdminActor,
    targetUserId: string,
    role: PlatformRole,
  ): Promise<AdminUserRecord> {
    return this.store.updateRole(actor, targetUserId, role);
  }

  async updateUiMode(
    actor: AdminActor,
    targetUserId: string,
    uiMode: UiMode,
  ): Promise<AdminUserRecord> {
    return this.store.updateUiMode(actor, targetUserId, uiMode);
  }

  async disableUser(actor: AdminActor, targetUserId: string): Promise<AdminUserMutationResult> {
    if (actor.userId === targetUserId) {
      throw new ConflictError("停用用户没成：不能停用当前登录账号，请选择其他用户。", "cannot_disable_self");
    }
    return this.store.disableUser(actor, targetUserId);
  }

  async resetPassword(
    actor: AdminActor,
    targetUserId: string,
  ): Promise<AdminUserMutationResult & { temporaryPassword: string }> {
    const temporaryPassword = generateTemporaryPassword(this.passwordMinLength);
    const result = await this.store.resetPassword(
      actor,
      targetUserId,
      await hashPassword(temporaryPassword),
    );
    return { ...result, temporaryPassword };
  }
}

/** Generated password is returned once and never written to audit or logs. */
export function generateTemporaryPassword(minLength: number): string {
  const length = Math.max(20, minLength);
  const bytes = Math.ceil((length * 3) / 4) + 2;
  return randomBytes(bytes).toString("base64url").slice(0, length);
}
