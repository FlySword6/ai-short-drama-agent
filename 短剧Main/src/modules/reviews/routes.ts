import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { PostgresMediaReviewRepository } from "./mediaRepository.js";
import { MediaReviewService } from "./mediaService.js";
import { mediaReviewStatuses } from "./mediaTypes.js";
import { PostgresReviewRepository } from "./repository.js";
import { ReviewService } from "./service.js";
import { reviewDefaultStrategies, reviewMediaKinds } from "./types.js";

const uuid = z.string().uuid();
const projectParams = z.object({ project_id: uuid });
const policyParams = z.object({ project_id: uuid, media_kind: z.enum(reviewMediaKinds) });
const assetParams = z.object({ project_id: uuid, asset_id: uuid });
const putPolicySchema = z.object({
  default_strategy: z.enum(reviewDefaultStrategies),
  reviewer_user_id: uuid.nullable().optional(),
  expected_version: z.coerce.number().int().min(0),
}).strict();
const submitAssetsSchema = z.object({
  asset_ids: z.array(uuid).min(1).max(50),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, assetId] of value.asset_ids.entries()) {
    if (seen.has(assetId)) {
      context.addIssue({ code: "custom", message: "批量提审的资产不能重复", path: ["asset_ids", index] });
    }
    seen.add(assetId);
  }
});
const decisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  rejection_reason: z.string().trim().min(1).max(4_000).optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "reject" && !value.rejection_reason) {
    context.addIssue({ code: "custom", message: "拒绝审核时必须填写原因", path: ["rejection_reason"] });
  }
  if (value.action === "approve" && value.rejection_reason !== undefined) {
    context.addIssue({ code: "custom", message: "通过审核时无需填写拒绝原因", path: ["rejection_reason"] });
  }
});

const mediaReviewQueueQuery = z.object({
  status: z.enum(mediaReviewStatuses).default("needs_review"),
  episode_id: uuid.optional(),
  page: z.coerce.number().int().min(1).max(100).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
});
const mediaReviewParams = z.object({ project_id: uuid, media_result_id: uuid });
const mediaDecisionsSchema = z.object({
  decisions: z.array(z.object({
    media_result_id: uuid,
    action: z.enum(["approve", "reject"]),
    rejection_reason: z.string().trim().min(1).max(4_000).optional(),
  }).strict()).min(1).max(200),
}).strict();

export interface ReviewRouteDependencies {
  createService?: () => Pick<ReviewService, "listPolicies" | "getPolicy" | "putPolicy" | "submitAssets" | "decideAsset" | "listActions">;
  createMediaReviewService?: () => Pick<MediaReviewService, "listQueue" | "decide" | "listActions">;
}

/**
 * Integration owner registers this module in `src/http/routes.ts`.
 * Every endpoint is non-generative: it cannot quote, submit, retry, or invoke a provider.
 */
export async function registerReviewRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: ReviewRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.()
    ?? new ReviewService(new PostgresReviewRepository(getDatabase()));
  const mediaReviewService = () => dependencies.createMediaReviewService?.()
    ?? new MediaReviewService(new PostgresMediaReviewRepository(getDatabase()));

  app.get("/api/v1/projects/:project_id/review-policies", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const items = await service().listPolicies(requireCurrentUser(request), params.project_id);
    return success({ items, count: items.length });
  });

  app.get("/api/v1/projects/:project_id/review-policies/:media_kind", async (request) => {
    const params = parseRequest(policyParams, request.params);
    return success(await service().getPolicy(requireCurrentUser(request), params.project_id, params.media_kind));
  });

  app.put("/api/v1/projects/:project_id/review-policies/:media_kind", async (request) => {
    const params = parseRequest(policyParams, request.params);
    const input = parseRequest(putPolicySchema, request.body);
    return success(await service().putPolicy(requireCurrentUser(request), params.project_id, {
      mediaKind: params.media_kind,
      defaultStrategy: input.default_strategy,
      reviewerUserId: input.reviewer_user_id,
      expectedVersion: input.expected_version,
    }));
  });

  app.post("/api/v1/projects/:project_id/reviews/submit", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(submitAssetsSchema, request.body);
    const items = await service().submitAssets(requireCurrentUser(request), params.project_id, input.asset_ids);
    return success({ items, count: items.length });
  });

  app.post("/api/v1/projects/:project_id/reviews/assets/:asset_id/decision", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const params = parseRequest(assetParams, request.params);
    const input = parseRequest(decisionSchema, request.body);
    return success(await service().decideAsset(requireCurrentUser(request), params.project_id, params.asset_id, {
      action: input.action,
      rejectionReason: input.rejection_reason,
    }));
  });

  /** Frontend can use the first record for the status hover, or show the whole explanation trail. */
  app.get("/api/v1/projects/:project_id/reviews/assets/:asset_id/actions", async (request) => {
    const params = parseRequest(assetParams, request.params);
    const items = await service().listActions(requireCurrentUser(request), params.project_id, params.asset_id);
    return success({ items, count: items.length });
  });

  app.get("/api/v1/projects/:project_id/media-reviews", async (request) => {
    const params = parseRequest(projectParams, request.params);
    const query = parseRequest(mediaReviewQueueQuery, request.query);
    const page = await mediaReviewService().listQueue(requireCurrentUser(request), params.project_id, {
      status: query.status,
      episodeId: query.episode_id,
      page: query.page,
      pageSize: query.page_size,
    });
    return success(page);
  });

  app.post("/api/v1/projects/:project_id/media-reviews/decisions", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    const params = parseRequest(projectParams, request.params);
    const input = parseRequest(mediaDecisionsSchema, request.body);
    const items = await mediaReviewService().decide(
      requireCurrentUser(request),
      params.project_id,
      input.decisions.map((decision) => ({
        mediaResultId: decision.media_result_id,
        action: decision.action,
        rejectionReason: decision.rejection_reason,
      })),
    );
    return success({ items, count: items.length });
  });

  /** Per-product audit trail: who, when, from/to status and the rejection reason. */
  app.get("/api/v1/projects/:project_id/media-reviews/:media_result_id/actions", async (request) => {
    const params = parseRequest(mediaReviewParams, request.params);
    const items = await mediaReviewService().listActions(
      requireCurrentUser(request),
      params.project_id,
      params.media_result_id,
    );
    return success({ items, count: items.length });
  });
}
