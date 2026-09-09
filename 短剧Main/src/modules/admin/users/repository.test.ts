import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../../db/client.js";
import { PostgresAdminUserRepository } from "./repository.js";
import type { AdminActor } from "./types.js";

const actor: AdminActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
};
const newestUserId = "33333333-3333-4333-8333-333333333333";
const legacyUserId = "44444444-4444-4444-8444-444444444444";

test("列表用一次批量查询返回已验证邮箱和账户额度，并保持安全排序与原审计", async () => {
  const rows = [
    {
      id: newestUserId,
      username: "new-user",
      displayName: "新用户",
      role: "member" as const,
      uiMode: "lite" as const,
      active: true,
      createdAt: new Date("2026-08-04T08:00:00.000Z"),
      updatedAt: new Date("2026-08-04T08:00:00.000Z"),
      email: "new-user@example.com",
      emailVerifiedAt: new Date("2026-08-04T07:59:00.000Z"),
      accountUserId: newestUserId,
      balancePoints: 20_000,
      dailyLimitPoints: 8_000,
      usedTodayPoints: null,
    },
    {
      id: legacyUserId,
      username: "legacy",
      displayName: "旧账号",
      role: "operator" as const,
      uiMode: "full" as const,
      active: true,
      createdAt: new Date("2026-07-01T08:00:00.000Z"),
      updatedAt: new Date("2026-07-01T08:00:00.000Z"),
      email: null,
      emailVerifiedAt: null,
      accountUserId: null,
      balancePoints: null,
      dailyLimitPoints: null,
      usedTodayPoints: null,
    },
  ];
  const harness = createDatabaseHarness(rows);
  const repository = new PostgresAdminUserRepository(
    harness.database,
    () => new Date("2026-08-04T16:30:00.000Z"),
  );

  const result = await repository.listUsers(actor);

  assert.equal(harness.selectCalls, 1, "用户与额度必须一次批量读取，不能按用户追加查询");
  assert.equal(harness.leftJoinCalls, 2);
  assert.equal(harness.orderByArgumentCount, 2, "继续按 created_at、id 双键稳定排序");
  assert.equal(harness.selectedKeys.includes("passwordHash"), false);
  assert.deepEqual(harness.selectedKeys, [
    "id",
    "username",
    "displayName",
    "role",
    "uiMode",
    "active",
    "createdAt",
    "updatedAt",
    "email",
    "emailVerifiedAt",
    "accountUserId",
    "balancePoints",
    "dailyLimitPoints",
    "usedTodayPoints",
  ]);
  assert.deepEqual(result, [
    {
      id: newestUserId,
      username: "new-user",
      displayName: "新用户",
      role: "member",
      uiMode: "lite",
      active: true,
      createdAt: new Date("2026-08-04T08:00:00.000Z"),
      updatedAt: new Date("2026-08-04T08:00:00.000Z"),
      email: "new-user@example.com",
      emailVerifiedAt: new Date("2026-08-04T07:59:00.000Z"),
      accountCredit: {
        userId: newestUserId,
        balancePoints: 20_000,
        dailyLimitPoints: 8_000,
        usedTodayPoints: 0,
        remainingTodayPoints: 8_000,
        dayDate: "2026-08-05",
        pointToFen: 1,
      },
    },
    {
      id: legacyUserId,
      username: "legacy",
      displayName: "旧账号",
      role: "operator",
      uiMode: "full",
      active: true,
      createdAt: new Date("2026-07-01T08:00:00.000Z"),
      updatedAt: new Date("2026-07-01T08:00:00.000Z"),
      email: null,
      emailVerifiedAt: null,
      accountCredit: null,
    },
  ]);
  assert.equal(harness.auditValues.length, 1);
  assert.equal(harness.auditValues[0]?.action, "users_listed");
  assert.deepEqual(harness.auditValues[0]?.metadata, { result_count: 2 });
  assert.equal(harness.auditValues[0]?.actorUserId, actor.userId);
  assert.equal(harness.auditValues[0]?.actorSessionId, actor.sessionId);
});

function createDatabaseHarness(rows: readonly Record<string, unknown>[]): {
  database: Database;
  readonly selectCalls: number;
  readonly leftJoinCalls: number;
  readonly orderByArgumentCount: number;
  readonly selectedKeys: string[];
  readonly auditValues: Array<Record<string, unknown>>;
} {
  let selectCalls = 0;
  let leftJoinCalls = 0;
  let orderByArgumentCount = 0;
  let selectedKeys: string[] = [];
  const auditValues: Array<Record<string, unknown>> = [];

  const query = {
    from: () => query,
    leftJoin: () => {
      leftJoinCalls += 1;
      return query;
    },
    orderBy: (...args: unknown[]) => {
      orderByArgumentCount = args.length;
      return Promise.resolve(rows);
    },
  };
  const transaction = {
    select: (projection: Record<string, unknown>) => {
      selectCalls += 1;
      selectedKeys = Object.keys(projection);
      return query;
    },
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        auditValues.push(values);
      },
    }),
  };
  const database = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction),
  } as unknown as Database;

  return {
    database,
    get selectCalls() { return selectCalls; },
    get leftJoinCalls() { return leftJoinCalls; },
    get orderByArgumentCount() { return orderByArgumentCount; },
    get selectedKeys() { return selectedKeys; },
    auditValues,
  };
}
