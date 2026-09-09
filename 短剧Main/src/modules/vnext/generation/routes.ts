import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import type { VnextGenerationService } from "./service.js";
import type { VnextGenerationAttemptView, VnextGenerationTask, VnextTosMediaItem } from "./types.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id }).strict();
const taskParams = z.object({ project_id: id, task_id: id }).strict();

const confirmIntentBody = z.object({
  intent_id: id,
  client_idempotency_key: z.string().trim().min(1).max(128),
}).strict();

export interface VnextGenerationRouteDependencies {
  generationService: () => VnextGenerationService;
}

/** HTTP surface for vNext generation task confirm + status. */
export async function registerVnextGenerationRoutes(
  app: FastifyInstance,
  deps: VnextGenerationRouteDependencies,
): Promise<void> {
  /**
   * POST /api/vnext/projects/:project_id/generation-tasks
   * Confirm a pending intent; creates a task (idempotent) and enqueues the first attempt.
   */
  app.post("/api/vnext/projects/:project_id/generation-tasks", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const body = parseRequest(confirmIntentBody, request.body);
    const actor = requireCurrentUser(request);
    const view = await deps.generationService().confirmIntent(
      actor.id,
      project_id,
      body.intent_id,
      body.client_idempotency_key,
    );
    const created = view.latestAttempt?.attemptNo === 1
      && view.task.status === "created"
      && view.latestAttempt.status === "created";
    return reply
      .code(created ? 201 : 200)
      .send(success({ task: toTaskResponse(view.task), latest_attempt: view.latestAttempt ? toAttemptResponse(view.latestAttempt) : null }));
  });

  /**
   * GET /api/vnext/projects/:project_id/generation-tasks/:task_id
   * Poll task and attempt status; used for recovery/status surface.
   */
  app.get("/api/vnext/projects/:project_id/generation-tasks/:task_id", async (request) => {
    const { project_id, task_id } = parseRequest(taskParams, request.params);
    const actor = requireCurrentUser(request);
    const view = await deps.generationService().getTaskStatus(actor.id, project_id, task_id);
    return success({ task: toTaskResponse(view.task), latest_attempt: view.latestAttempt ? toAttemptResponse(view.latestAttempt) : null });
  });
}

// ─── Wire mappers ─────────────────────────────────────────────────────────────

function toTaskResponse(task: VnextGenerationTask) {
  return {
    id: task.id,
    project_id: task.projectId,
    intent_id: task.intentId,
    control_package_id: task.controlPackageId,
    control_package_version: task.controlPackageVersion,
    references: task.references.map((reference) => ({
      reference_id: reference.referenceId,
      reference_version_id: reference.referenceVersionId,
      label: reference.label,
      reason: reference.reason,
      position: reference.position,
      capability_snapshot: {
        version: reference.capabilitySnapshot.version,
        captured_at: reference.capabilitySnapshot.capturedAt,
        capabilities: reference.capabilitySnapshot.capabilities,
      },
    })),
    provider: task.provider,
    model: task.model,
    prompt: task.prompt,
    no_bgm: task.noBgm,
    parameters: task.parameters,
    estimated_cost_fen: task.estimatedCostFen,
    status: task.status,
    created_at: task.createdAt,
  };
}

function toAttemptResponse(attempt: VnextGenerationAttemptView) {
  return {
    id: attempt.id,
    attempt_no: attempt.attemptNo,
    status: attempt.status,
    provider_task_id: attempt.providerTaskId,
    tos_media: attempt.tosMedia.map(toTosMediaResponse),
    error_code: attempt.errorCode,
    error_message: attempt.errorMessage,
    created_at: attempt.createdAt,
    updated_at: attempt.updatedAt,
  };
}

function toTosMediaResponse(item: VnextTosMediaItem) {
  return {
    provider_result_key: item.providerResultKey,
    storage_bucket: item.storageBucket,
    object_key: item.objectKey,
    storage_url: item.storageUrl,
    mime_type: item.mimeType,
    sha256: item.sha256,
    duration_seconds: item.durationSeconds ?? null,
    copied_at: item.copiedAt,
  };
}
