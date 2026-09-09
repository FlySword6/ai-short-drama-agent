import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../shared/errors.js";
import { initialAssetReviewStatus, ReviewService, type ReviewStore } from "./service.js";
import type {
  AssetReviewActionRecord,
  AssetReviewItem,
  AssetReviewStatus,
  ProjectReviewPolicy,
  PutProjectReviewPolicyInput,
  ReviewActor,
} from "./types.js";

const actorId = "33333333-3333-4333-8333-333333333333";
const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "11111111-1111-4111-8111-111111111111";

class MemoryReviewStore implements ReviewStore {
  policy?: ProjectReviewPolicy;
  statuses = new Map<string, AssetReviewStatus>([[assetId, "pending_review"]]);
  actions: AssetReviewActionRecord[] = [];

  async listPolicies(): Promise<ProjectReviewPolicy[]> { return this.policy ? [this.policy] : []; }
  async getPolicy(): Promise<ProjectReviewPolicy | undefined> { return this.policy; }
  async putPolicy(actor: ReviewActor, incomingProjectId: string, input: PutProjectReviewPolicyInput): Promise<ProjectReviewPolicy> {
    if (this.policy && input.expectedVersion !== this.policy.version) {
      throw new AppError(409, "project_review_policy_version_conflict", "冲突");
    }
    if (!this.policy && input.expectedVersion !== 0) {
      throw new AppError(409, "project_review_policy_version_conflict", "冲突");
    }
    const now = new Date();
    const policy: ProjectReviewPolicy = {
      id: "44444444-4444-4444-8444-444444444444",
      projectId: incomingProjectId,
      mediaKind: input.mediaKind,
      defaultStrategy: input.defaultStrategy,
      reviewerUserId: input.reviewerUserId ?? this.policy?.reviewerUserId ?? null,
      updatedByUserId: typeof actor === "string" ? actor : actor.id,
      version: (this.policy?.version ?? 0) + 1,
      createdAt: this.policy?.createdAt ?? now,
      updatedAt: now,
    };
    this.policy = policy;
    return policy;
  }

  async submitAssets(_actor: ReviewActor, _projectId: string, ids: string[]): Promise<AssetReviewItem[]> {
    return ids.map((id) => {
      const current = this.statuses.get(id);
      if (!current) throw new AppError(404, "not_found", "不存在");
      if (current === "pending_review") return { assetId: id, status: current, changed: false, reason: "already_pending_review" };
      if (current === "approved") return { assetId: id, status: current, changed: false, reason: "already_approved" };
      this.statuses.set(id, "pending_review");
      return { assetId: id, status: "pending_review", changed: true, reason: "submitted" };
    });
  }

  async decideAsset(_actor: ReviewActor, _projectId: string, id: string, input: { action: "approved" | "rejected"; rejectionReason?: string }): Promise<AssetReviewItem> {
    const current = this.statuses.get(id);
    if (!current) throw new AppError(404, "not_found", "不存在");
    if (current === "approved" || current === "rejected") {
      if (current === input.action) {
        return { assetId: id, status: current, changed: false, reason: current === "approved" ? "already_approved" : "already_rejected" };
      }
      throw new AppError(409, "asset_review_terminal_state", "资产已完成审核");
    }
    this.statuses.set(id, input.action);
    return { assetId: id, status: input.action, changed: true, reason: "submitted" };
  }

  async listActions(): Promise<AssetReviewActionRecord[]> { return this.actions; }
}

test("审核域策略用版本保护创建和编辑", async () => {
  const store = new MemoryReviewStore();
  const service = new ReviewService(store);
  const created = await service.putPolicy(actorId, projectId, {
    mediaKind: "image", defaultStrategy: "automatic", expectedVersion: 0,
  });
  assert.equal(created.version, 1);
  assert.equal(created.defaultStrategy, "automatic");

  const updated = await service.putPolicy(actorId, projectId, {
    mediaKind: "image", defaultStrategy: "pending_review", expectedVersion: 1,
  });
  assert.equal(updated.version, 2);
  await assert.rejects(
    () => service.putPolicy(actorId, projectId, {
      mediaKind: "image", defaultStrategy: "automatic", expectedVersion: 1,
    }),
    (error: unknown) => error instanceof AppError && error.code === "project_review_policy_version_conflict",
  );
});

test("审核域拒绝必须写原因，且已完成审核的资产不能被直接反向裁决", async () => {
  const store = new MemoryReviewStore();
  const service = new ReviewService(store);
  await assert.rejects(
    () => service.decideAsset(actorId, projectId, assetId, { action: "reject" }),
    (error: unknown) => error instanceof AppError && error.code === "invalid_request",
  );
  const rejected = await service.decideAsset(actorId, projectId, assetId, {
    action: "reject", rejectionReason: "人物造型不符合设定",
  });
  assert.equal(rejected.status, "rejected");
  await assert.rejects(
    () => service.decideAsset(actorId, projectId, assetId, { action: "approve" }),
    (error: unknown) => error instanceof AppError && error.code === "asset_review_terminal_state",
  );
});

test("批量提审去重，拒绝的资产可回到待审，已通过资产保持审核完成状态", async () => {
  const store = new MemoryReviewStore();
  const service = new ReviewService(store);
  store.statuses.set(assetId, "rejected");
  const submitted = await service.submitAssets(actorId, projectId, [assetId]);
  assert.deepEqual(submitted[0], {
    assetId, status: "pending_review", changed: true, reason: "submitted",
  });
  await assert.rejects(
    () => service.submitAssets(actorId, projectId, [assetId, assetId]),
    (error: unknown) => error instanceof AppError && error.code === "invalid_request",
  );
  store.statuses.set(assetId, "approved");
  const alreadyApproved = await service.submitAssets(actorId, projectId, [assetId]);
  assert.equal(alreadyApproved[0]?.reason, "already_approved");
});

test("审核默认策略明确映射资产初始四态中的两个入口态", () => {
  assert.equal(initialAssetReviewStatus("automatic"), "automatic_review");
  assert.equal(initialAssetReviewStatus("pending_review"), "pending_review");
});
