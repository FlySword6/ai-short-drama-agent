import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestError } from "../../shared/errors.js";
import { AccountCreditService } from "./service.js";
import type { AccountCreditStore, InvitationTier } from "./types.js";

const actor = { userId: "11111111-1111-4111-8111-111111111111" };
const tier: InvitationTier = {
  id: "22222222-2222-4222-8222-222222222222", code: "developer", name: "开发者",
  grantPoints: 100_000, dailyLimitPoints: 100_000, active: true, createdAt: new Date(), updatedAt: new Date(),
};

test("邀请码档位服务标准化编码，并允许管理员显式关闭档位额度", async () => {
  let received: unknown;
  const service = new AccountCreditService(fakeStore({
    createInvitationTier: async (_actor, input) => { received = input; return tier; },
  }));
  await service.createInvitationTier(actor, { code: " Developer ", name: " 开发者 ", grantPoints: 100_000, dailyLimitPoints: 100_000 });
  assert.deepEqual(received, { code: "developer", name: "开发者", grantPoints: 100_000, dailyLimitPoints: 100_000 });
  await service.createInvitationTier(actor, { code: "developer", name: "开发者", grantPoints: 0, dailyLimitPoints: 0 });
  assert.deepEqual(received, { code: "developer", name: "开发者", grantPoints: 0, dailyLimitPoints: 0 });
  await assert.rejects(() => service.createInvitationTier(actor, { code: "developer", name: "开发者", grantPoints: -1, dailyLimitPoints: 0 }), (error: unknown) => error instanceof BadRequestError);
});

test("管理员调账必须有非零整数和可追溯原因", async () => {
  let received: unknown;
  const service = new AccountCreditService(fakeStore({
    adjustBalance: async (_actor, _userId, input) => { received = input; return { userId: "user", balancePoints: 1, amountPoints: input.amountPoints, reason: input.reason, createdAt: new Date() }; },
  }));
  await service.adjustBalance(actor, "33333333-3333-4333-8333-333333333333", { amountPoints: -10, reason: "  人工补正  " });
  assert.deepEqual(received, { amountPoints: -10, reason: "人工补正" });
  assert.throws(
    () => service.adjustBalance(actor, "33333333-3333-4333-8333-333333333333", { amountPoints: 0, reason: "no" }),
    (error: unknown) => error instanceof BadRequestError,
  );
});

function fakeStore(overrides: Partial<AccountCreditStore>): AccountCreditStore {
  const unavailable = async (): Promise<never> => { throw new Error("not used"); };
  return {
    getSummary: unavailable,
    listInvitationTiers: unavailable,
    createInvitationTier: unavailable,
    updateInvitationTier: unavailable,
    deactivateInvitationTier: unavailable,
    listInviteCodes: unavailable,
    createInviteCode: unavailable,
    updateInviteCode: unavailable,
    deactivateInviteCode: unavailable,
    getSelfRegistrationPolicy: unavailable,
    updateSelfRegistrationPolicy: unavailable,
    adjustBalance: unavailable,
    ...overrides,
  };
}
