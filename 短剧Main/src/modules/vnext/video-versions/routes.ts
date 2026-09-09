import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import { toControlPackage, toPendingIntent } from "../generation-intents/routes.js";
import type { VnextVideoVersionService } from "./service.js";
import type { VnextVideoChangeDraft, VnextVideoVersion } from "./types.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id }).strict();
const versionParams = z.object({ project_id: id, version_id: id }).strict();

const attachBody = z.object({
  task_id: id,
}).strict();

// Same reviewed-input shape as the generation control package: the page seeds
// it from the origin version and the human edits before drafting.
const capabilitySnapshot = z.object({ version: z.string().trim().min(1).max(128), captured_at: z.string().datetime(), capabilities: z.array(z.string().trim().min(1).max(128)).min(1).max(64) }).strict();
const reference = z.object({ reference_id: z.string().uuid(), reference_version_id: z.string().uuid(), label: z.string().trim().min(1).max(255), reason: z.string().trim().min(1).max(1_000), capability_snapshot: capabilitySnapshot }).strict();
const changeDraftBody = z.object({
  change_type: z.enum(["modify", "extend"]),
  client_idempotency_key: z.string().trim().min(1).max(128),
  references: z.array(reference).max(50),
  final_prompt: z.string().trim().min(1).max(20_000),
  model: z.string().trim().min(1).max(255),
  parameters: z.record(z.string(), z.unknown()),
  no_bgm: z.boolean().default(true),
  model_availability: z.object({ status: z.enum(["available", "unavailable"]), checked_at: z.string().datetime(), reason: z.string().trim().min(1).max(1_000).optional() }).strict(),
  estimated_cost_fen: z.number().int().min(0),
}).strict();

export interface VnextVideoVersionRouteDependencies {
  videoVersionService: () => VnextVideoVersionService;
}

/**
 * HTTP surface for vNext video segment versions.
 * Reads are member-gated; both mutations stay human-only paid-flow gates —
 * draft creation writes reviewable rows only, attach only reads the succeeded
 * task. Neither performs a provider call.
 */
export async function registerVnextVideoVersionRoutes(
  app: FastifyInstance,
  deps: VnextVideoVersionRouteDependencies,
): Promise<void> {
  /**
   * GET /api/vnext/projects/:project_id/video-versions
   * Refresh recovery: every chain's versions with task/cost/TOS media facts.
   */
  app.get("/api/vnext/projects/:project_id/video-versions", async (request) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const { items } = await deps.videoVersionService().listVersions(actor.id, project_id);
    return success({ items: items.map(toVersionResponse) });
  });

  /**
   * POST /api/vnext/projects/:project_id/video-versions
   * Append a version from a succeeded generation task (register or chain growth).
   * Idempotent on (project, source_attempt).
   */
  app.post("/api/vnext/projects/:project_id/video-versions", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const body = parseRequest(attachBody, request.body);
    const actor = requireCurrentUser(request);
    const result = await deps.videoVersionService().attachSucceededTask(actor.id, project_id, body.task_id);
    return reply.code(result.created ? 201 : 200).send(success({
      version: toVersionResponse(result.version),
      outcome: result.created ? "created" : "replayed",
    }));
  });

  /**
   * POST /api/vnext/projects/:project_id/video-versions/:version_id/change-drafts
   * Start a modify/extend draft on a saved version: new control package
   * snapshot + pending intent + linkage. Zero provider calls; the human
   * confirms later via the existing generation-tasks endpoint.
   */
  app.post("/api/vnext/projects/:project_id/video-versions/:version_id/change-drafts", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const { project_id, version_id } = parseRequest(versionParams, request.params);
    const body = parseRequest(changeDraftBody, request.body);
    const actor = requireCurrentUser(request);
    const result = await deps.videoVersionService().createChangeDraft(actor.id, project_id, version_id, {
      changeType: body.change_type,
      clientIdempotencyKey: body.client_idempotency_key,
      references: body.references.map((item, position) => ({
        referenceId: item.reference_id,
        referenceVersionId: item.reference_version_id,
        label: item.label,
        reason: item.reason,
        position,
        capabilitySnapshot: {
          version: item.capability_snapshot.version,
          capturedAt: item.capability_snapshot.captured_at,
          capabilities: item.capability_snapshot.capabilities,
        },
      })),
      finalPrompt: body.final_prompt,
      model: body.model,
      parameters: body.parameters,
      noBgm: body.no_bgm,
      modelAvailability: {
        status: body.model_availability.status,
        checkedAt: body.model_availability.checked_at,
        ...(body.model_availability.reason ? { reason: body.model_availability.reason } : {}),
      },
      estimatedCostFen: body.estimated_cost_fen,
    });
    return reply.code(result.created ? 201 : 200).send(success({
      draft: toDraftResponse(result.draft),
      pending_intent: toPendingIntent(result.intent),
      control_package: result.controlPackage ? toControlPackage(result.controlPackage) : null,
      outcome: result.created ? "created" : "replayed",
    }));
  });
}

// ─── Wire mappers ─────────────────────────────────────────────────────────────

function toVersionResponse(version: VnextVideoVersion) {
  return {
    id: version.id,
    project_id: version.projectId,
    chain_id: version.chainId,
    version_no: version.versionNo,
    change_type: version.changeType,
    origin_version_id: version.originVersionId,
    source_task_id: version.sourceTaskId,
    source_attempt_id: version.sourceAttemptId,
    control_package_id: version.controlPackageId,
    control_package_version: version.controlPackageVersion,
    provider: version.provider,
    model: version.model,
    prompt: version.prompt,
    parameters: version.parameters,
    tos_media: version.tosMedia.map((item) => ({
      provider_result_key: item.providerResultKey,
      storage_bucket: item.storageBucket,
      object_key: item.objectKey,
      storage_url: item.storageUrl,
      mime_type: item.mimeType,
      sha256: item.sha256,
      duration_seconds: item.durationSeconds ?? null,
      copied_at: item.copiedAt,
    })),
    estimated_cost_fen: version.estimatedCostFen,
    actual_cost_fen: version.actualCostFen,
    created_at: version.createdAt,
  };
}

function toDraftResponse(draft: VnextVideoChangeDraft) {
  return {
    id: draft.id,
    origin_version_id: draft.originVersionId,
    change_type: draft.changeType,
    intent_id: draft.intentId,
    created_at: draft.createdAt,
  };
}
