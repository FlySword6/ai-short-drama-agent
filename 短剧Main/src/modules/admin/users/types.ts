import type { UiMode } from "../../../db/schema.js";
import type { PlatformRole } from "../../auth/types.js";
import type { AccountCreditSummary } from "../../account-credits/types.js";

export const adminUserActionKinds = [
  "users_listed",
  "user_created",
  "user_disabled",
  "password_reset",
] as const;

export type AdminUserActionKind = (typeof adminUserActionKinds)[number];

export interface AdminActor {
  userId: string;
  sessionId: string;
}

export interface AdminUserRecord {
  id: string;
  username: string;
  displayName: string;
  role: PlatformRole;
  uiMode: UiMode;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserListRecord extends AdminUserRecord {
  email: string | null;
  emailVerifiedAt: Date | null;
  accountCredit: AccountCreditSummary | null;
}

export interface AdminUserMutationResult {
  user: AdminUserRecord;
  changed: boolean;
  revokedSessionCount: number;
}

export interface AdminUserStore {
  listUsers(actor: AdminActor): Promise<AdminUserListRecord[]>;
  createUser(
    actor: AdminActor,
    input: { username: string; displayName: string; passwordHash: string; role: PlatformRole; uiMode: UiMode },
  ): Promise<AdminUserRecord>;
  updateRole(actor: AdminActor, targetUserId: string, role: PlatformRole): Promise<AdminUserRecord>;
  updateUiMode(actor: AdminActor, targetUserId: string, uiMode: UiMode): Promise<AdminUserRecord>;
  disableUser(actor: AdminActor, targetUserId: string): Promise<AdminUserMutationResult>;
  resetPassword(
    actor: AdminActor,
    targetUserId: string,
    passwordHash: string,
  ): Promise<AdminUserMutationResult>;
}
