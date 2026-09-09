import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { registerReviewRoutes } from "./routes.js";
import type { AssetReviewActionRecord, AssetReviewItem, ProjectReviewPolicy } from "./types.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const assetId = "11111111-1111-4111-8111-111111111111";

const policy: ProjectReviewPolicy = {
  id: "44444444-4444-4444-8444-444444444444",
  projectId,
  mediaKind: "image",
  defaultStrategy: "pending_review",
  reviewerUserId: actorId,
  updatedByUserId: actorId,
  version: 2,
  createdAt: new Date("2026-07-21T00:00:00.000Z"),
  updatedAt: new Date("2026-07-21T00:01:00.000Z"),
};

const action: AssetReviewActionRecord = {
  id: "55555555-5555-4555-8555-555555555555",
  projectId,
  assetId,
  action: "rejected",
  fromStatus: "pending_review",
  toStatus: "rejected",
  reviewerUserId: actorId,
  reviewerDisplayName: "审核人",
  assignedReviewerUserId: actorId,
  rejectionReason: "人物服装不符合设定",
  createdAt: new Date("2026-07-21T00:02:00.000Z"),
};

async function createTestApp() {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actorId, username: "tester", displayName: "测试用户", role: "member" };
  });
  const calls: unknown[] = [];
  const item: AssetReviewItem = { assetId, status: "pending_review", changed: true, reason: "submitted", latestAction: action };
  await registerReviewRoutes(app, () => ({} as Database), {
    createService: () => ({
      listPolicies: async () => [policy],
      getPolicy: async () => policy,
      putPolicy: async (...args: unknown[]) => { calls.push({ type: "policy", args }); return policy; },
      submitAssets: async (...args: unknown[]) => { calls.push({ type: "submit", args }); return [item]; },
      decideAsset: async (...args: unknown[]) => { calls.push({ type: "decision", args }); return item; },
      listActions: async () => [action],
    }),
  });
  return { app, calls };
}

test("审核接口使用稳定 snake_case，并把审核人和拒绝原因回显给前端", async () => {
  const { app, calls } = await createTestApp();
  try {
    const listed = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/review-policies` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.items[0].default_strategy, "pending_review");
    assert.equal(listed.json().data.items[0].reviewer_user_id, actorId);

    const policyUpdate = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/review-policies/image`,
      payload: { default_strategy: "pending_review", reviewer_user_id: actorId, expected_version: 2 },
    });
    assert.equal(policyUpdate.statusCode, 200);
    assert.deepEqual(calls.at(-1), {
      type: "policy",
      args: [{ id: actorId, username: "tester", displayName: "测试用户", role: "member" }, projectId, {
        mediaKind: "image", defaultStrategy: "pending_review", reviewerUserId: actorId, expectedVersion: 2,
      }],
    });

    const actionResponse = await app.inject({
      method: "GET", url: `/api/v1/projects/${projectId}/reviews/assets/${assetId}/actions`,
    });
    assert.equal(actionResponse.statusCode, 200);
    assert.equal(actionResponse.json().data.items[0].reviewer_display_name, "审核人");
    assert.equal(actionResponse.json().data.items[0].assigned_reviewer_user_id, actorId);
    assert.equal(actionResponse.json().data.items[0].rejection_reason, "人物服装不符合设定");

    const decision = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/reviews/assets/${assetId}/decision`,
      payload: { action: "reject", rejection_reason: "人物服装不符合设定" },
    });
    assert.equal(decision.statusCode, 200);
    assert.deepEqual(calls.at(-1), {
      type: "decision",
      args: [{ id: actorId, username: "tester", displayName: "测试用户", role: "member" }, projectId, assetId, { action: "reject", rejectionReason: "人物服装不符合设定" }],
    });
  } finally {
    await app.close();
  }
});

test("审核接口拒绝不完整输入、未知策略和重复批量资产", async () => {
  const { app } = await createTestApp();
  try {
    const rejectedWithoutReason = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/reviews/assets/${assetId}/decision`, payload: { action: "reject" },
    });
    assert.equal(rejectedWithoutReason.statusCode, 400);

    const unknownStrategy = await app.inject({
      method: "PUT", url: `/api/v1/projects/${projectId}/review-policies/image`,
      payload: { default_strategy: "manual", expected_version: 0 },
    });
    assert.equal(unknownStrategy.statusCode, 400);

    const duplicate = await app.inject({
      method: "POST", url: `/api/v1/projects/${projectId}/reviews/submit`,
      payload: { asset_ids: [assetId, assetId] },
    });
    assert.equal(duplicate.statusCode, 400);
  } finally {
    await app.close();
  }
});
