import assert from "node:assert/strict";
import test from "node:test";
import { verifyPassword } from "../../auth/service.js";
import { ConflictError } from "../../../shared/errors.js";
import { AdminUserService, generateTemporaryPassword } from "./service.js";
import type {
  AdminActor,
  AdminUserListRecord,
  AdminUserMutationResult,
  AdminUserRecord,
  AdminUserStore,
} from "./types.js";

const actor: AdminActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
};
const targetId = "33333333-3333-4333-8333-333333333333";
const storedUser: AdminUserRecord = {
  id: targetId,
  username: "artist",
  displayName: "artist",
  role: "member",
  uiMode: "full",
  active: true,
  createdAt: new Date("2026-07-21T00:00:00.000Z"),
  updatedAt: new Date("2026-07-21T00:00:00.000Z"),
};
const listedUser: AdminUserListRecord = {
  ...storedUser,
  email: "artist@example.com",
  emailVerifiedAt: new Date("2026-07-20T23:59:00.000Z"),
  accountCredit: {
    userId: targetId,
    balancePoints: 12_000,
    dailyLimitPoints: 5_000,
    usedTodayPoints: 1_250,
    remainingTodayPoints: 3_750,
    dayDate: "2026-08-04",
    pointToFen: 1,
  },
};

class FakeStore implements AdminUserStore {
  createInput?: {
    username: string;
    displayName: string;
    passwordHash: string;
    role: "admin" | "operator" | "member";
    uiMode: "lite" | "full";
  };
  listActor?: AdminActor;
  resetHash?: string;
  disableCalls = 0;

  async listUsers(listActor: AdminActor): Promise<AdminUserListRecord[]> {
    this.listActor = listActor;
    return [listedUser];
  }

  async createUser(
    _actor: AdminActor,
    input: {
      username: string;
      displayName: string;
      passwordHash: string;
      role: "admin" | "operator" | "member";
      uiMode: "lite" | "full";
    },
  ): Promise<AdminUserRecord> {
    this.createInput = input;
    return { ...storedUser, username: input.username, displayName: input.displayName, uiMode: input.uiMode };
  }

  async updateRole(_actor: AdminActor, _targetUserId: string, role: "admin" | "operator" | "member"): Promise<AdminUserRecord> {
    return { ...storedUser, role };
  }

  async updateUiMode(_actor: AdminActor, _targetUserId: string, uiMode: "lite" | "full"): Promise<AdminUserRecord> {
    return { ...storedUser, uiMode };
  }

  async disableUser(): Promise<AdminUserMutationResult> {
    this.disableCalls += 1;
    return { user: { ...storedUser, active: false }, changed: true, revokedSessionCount: 1 };
  }

  async resetPassword(
    _actor: AdminActor,
    _targetUserId: string,
    passwordHash: string,
  ): Promise<AdminUserMutationResult> {
    this.resetHash = passwordHash;
    return { user: storedUser, changed: true, revokedSessionCount: 3 };
  }
}

test("用户列表原样返回已验证邮箱和账户额度摘要", async () => {
  const store = new FakeStore();
  const service = new AdminUserService(store);

  const result = await service.listUsers(actor);

  assert.deepEqual(result, [listedUser]);
  assert.deepEqual(store.listActor, actor);
});

test("创建账号规范化用户名、生成满足策略的密码并只保存哈希", async () => {
  const store = new FakeStore();
  const service = new AdminUserService(store, { passwordMinLength: 24 });
  const result = await service.createUser(actor, { username: "  Artist.One  " });

  assert.equal(result.user.username, "artist.one");
  assert.equal(store.createInput?.displayName, "artist.one");
  assert.equal(store.createInput?.role, "member");
  assert.equal(store.createInput?.uiMode, "full");
  assert.equal(result.initialPassword.length, 24);
  assert.notEqual(store.createInput?.passwordHash, result.initialPassword);
  assert.equal(await verifyPassword(result.initialPassword, store.createInput?.passwordHash ?? ""), true);
});

test("创建账号透传管理员指定的 ui_mode，updateUiMode 透传新模式", async () => {
  const store = new FakeStore();
  const service = new AdminUserService(store, { passwordMinLength: 8 });
  const created = await service.createUser(actor, { username: "lite.user", uiMode: "lite" });
  assert.equal(store.createInput?.uiMode, "lite");
  assert.equal(created.user.uiMode, "lite");

  const updated = await service.updateUiMode(actor, targetId, "lite");
  assert.equal(updated.uiMode, "lite");
});

test("创建账号把 PostgreSQL 用户名唯一冲突稳定映射为 409", async () => {
  const store = new FakeStore();
  store.createUser = async () => { throw { code: "23505" }; };
  const service = new AdminUserService(store, { passwordMinLength: 8 });
  await assert.rejects(
    service.createUser(actor, { username: "artist" }),
    (error: unknown) => error instanceof ConflictError && error.code === "username_exists",
  );
});

test("管理员不能禁用自己的当前账号", async () => {
  const store = new FakeStore();
  const service = new AdminUserService(store);
  await assert.rejects(
    service.disableUser(actor, actor.userId),
    (error: unknown) => error instanceof ConflictError
      && error.code === "cannot_disable_self"
      && error.message === "停用用户没成：不能停用当前登录账号，请选择其他用户。",
  );
  assert.equal(store.disableCalls, 0);
});

test("重置密码生成一次性临时密码并向存储层只传哈希", async () => {
  const store = new FakeStore();
  const service = new AdminUserService(store, { passwordMinLength: 32 });
  const result = await service.resetPassword(actor, targetId);
  assert.equal(result.temporaryPassword.length, 32);
  assert.notEqual(store.resetHash, result.temporaryPassword);
  assert.equal(await verifyPassword(result.temporaryPassword, store.resetHash ?? ""), true);
  assert.equal(result.revokedSessionCount, 3);
});

test("临时密码长度至少 20 位并可跟随更高的部署策略", () => {
  assert.equal(generateTemporaryPassword(8).length, 20);
  assert.equal(generateTemporaryPassword(128).length, 128);
});
