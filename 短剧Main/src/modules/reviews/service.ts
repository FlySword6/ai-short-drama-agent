import { BadRequestError, ConflictError, NotFoundError } from "../../shared/errors.js";
import type {
  AssetReviewActionRecord,
  AssetReviewItem,
  AssetReviewStatus,
  ProjectReviewPolicy,
  PutProjectReviewPolicyInput,
  ReviewActor,
  ReviewDecisionInput,
  ReviewMediaKind,
} from "./types.js";

export interface ReviewStore {
  listPolicies(actor: ReviewActor, projectId: string): Promise<ProjectReviewPolicy[]>;
  getPolicy(actor: ReviewActor, projectId: string, mediaKind: ReviewMediaKind): Promise<ProjectReviewPolicy | undefined>;
  putPolicy(actor: ReviewActor, projectId: string, input: PutProjectReviewPolicyInput): Promise<ProjectReviewPolicy>;
  submitAssets(actor: ReviewActor, projectId: string, assetIds: string[]): Promise<AssetReviewItem[]>;
  decideAsset(
    actor: ReviewActor,
    projectId: string,
    assetId: string,
    input: { action: "approved" | "rejected"; rejectionReason?: string },
  ): Promise<AssetReviewItem>;
  listActions(actor: ReviewActor, projectId: string, assetId: string): Promise<AssetReviewActionRecord[]>;
}

/**
 * 人工审核域只处理项目内资产的状态和可解释记录；不会创建生成任务、报价或供应商调用。
 */
export class ReviewService {
  constructor(private readonly store: ReviewStore) {}

  listPolicies(actor: ReviewActor, projectId: string): Promise<ProjectReviewPolicy[]> {
    return this.store.listPolicies(actor, projectId);
  }

  async getPolicy(actor: ReviewActor, projectId: string, mediaKind: ReviewMediaKind): Promise<ProjectReviewPolicy> {
    const policy = await this.store.getPolicy(actor, projectId, mediaKind);
    if (!policy) throw new NotFoundError("当前项目还没有该媒体类型的审核默认策略");
    return policy;
  }

  putPolicy(actor: ReviewActor, projectId: string, input: PutProjectReviewPolicyInput): Promise<ProjectReviewPolicy> {
    return this.store.putPolicy(actor, projectId, input);
  }

  async submitAssets(actor: ReviewActor, projectId: string, assetIds: string[]): Promise<AssetReviewItem[]> {
    const uniqueIds = [...new Set(assetIds)];
    if (uniqueIds.length === 0) throw new BadRequestError("至少选择一个资产提审");
    if (uniqueIds.length !== assetIds.length) throw new BadRequestError("批量提审的资产不能重复");
    return this.store.submitAssets(actor, projectId, uniqueIds);
  }

  async decideAsset(
    actor: ReviewActor,
    projectId: string,
    assetId: string,
    input: ReviewDecisionInput,
  ): Promise<AssetReviewItem> {
    if (input.action === "reject") {
      const reason = input.rejectionReason?.trim();
      if (!reason) throw new BadRequestError("拒绝审核时必须填写原因");
      return this.store.decideAsset(actor, projectId, assetId, {
        action: "rejected",
        rejectionReason: reason,
      });
    }
    return this.store.decideAsset(actor, projectId, assetId, { action: "approved" });
  }

  listActions(actor: ReviewActor, projectId: string, assetId: string): Promise<AssetReviewActionRecord[]> {
    return this.store.listActions(actor, projectId, assetId);
  }
}

/** New assets can use this pure mapper after a project policy has been read. */
export function initialAssetReviewStatus(defaultStrategy: "automatic" | "pending_review"): AssetReviewStatus {
  return defaultStrategy === "automatic" ? "automatic_review" : "pending_review";
}

/** Exposed for callers that need an explicit state-machine error without a DB round-trip. */
export function assertDecisionAllowed(current: AssetReviewStatus, _target: "approved" | "rejected"): void {
  if (current === "approved" || current === "rejected") {
    throw new ConflictError(
      "资产已完成审核；如需再次审核，请先重新提审",
      "asset_review_terminal_state",
    );
  }
}
