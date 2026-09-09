import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import type { ControlPackageService } from "../control-packages/service.js";
import type { ControlPackage } from "../control-packages/types.js";
import type { GenerationIntentService } from "./service.js";
import type { PendingGenerationIntent } from "./types.js";

const id = z.string().uuid();
const projectParams = z.object({ project_id: id }).strict();
const capabilitySnapshot = z.object({ version: z.string().trim().min(1).max(128), captured_at: z.string().datetime(), capabilities: z.array(z.string().trim().min(1).max(128)).min(1).max(64) }).strict();
const reference = z.object({ reference_id: z.string().uuid(), reference_version_id: z.string().uuid(), label: z.string().trim().min(1).max(255), reason: z.string().trim().min(1).max(1_000), capability_snapshot: capabilitySnapshot }).strict();
const controlPackage = z.object({
  references: z.array(reference).max(50), final_prompt: z.string().trim().min(1).max(20_000), model: z.string().trim().min(1).max(255),
  parameters: z.record(z.string(), z.unknown()), no_bgm: z.boolean().default(true),
  model_availability: z.object({ status: z.enum(["available", "unavailable"]), checked_at: z.string().datetime(), reason: z.string().trim().min(1).max(1_000).optional() }).strict(),
  estimated_cost_fen: z.number().int().min(0),
}).strict();
const pendingIntent = z.object({ client_idempotency_key: z.string().trim().min(1).max(128) }).strict();

export interface GenerationIntentRouteDependencies {
  controlPackages: () => ControlPackageService;
  intents: () => GenerationIntentService;
}

/** Composition-root registration is intentionally separate so no paid action is reachable until explicitly wired. */
export async function registerGenerationIntentRoutes(app: FastifyInstance, dependencies: GenerationIntentRouteDependencies): Promise<void> {
  app.get("/api/vnext/projects/:project_id/generation-workbench", async (request) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const actor = requireCurrentUser(request);
    const [control, pending] = await Promise.all([
      dependencies.controlPackages().workbench(actor.id, project_id),
      dependencies.intents().workbench(actor.id, project_id),
    ]);
    return success({ control_package: control.controlPackage ? toControlPackage(control.controlPackage) : null, pending_intent: pending.pendingIntent ? toPendingIntent(pending.pendingIntent) : null });
  });
  app.put("/api/vnext/projects/:project_id/control-package", { config: { agentAccess: "human_only" } }, async (request) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const body = parseRequest(controlPackage, request.body);
    const saved = await dependencies.controlPackages().save(requireCurrentUser(request).id, project_id, {
      references: body.references.map((item, position) => ({ referenceId: item.reference_id, referenceVersionId: item.reference_version_id, label: item.label, reason: item.reason, position, capabilitySnapshot: { version: item.capability_snapshot.version, capturedAt: item.capability_snapshot.captured_at, capabilities: item.capability_snapshot.capabilities } })),
      finalPrompt: body.final_prompt, model: body.model, parameters: body.parameters, noBgm: body.no_bgm,
      modelAvailability: { status: body.model_availability.status, checkedAt: body.model_availability.checked_at, ...(body.model_availability.reason ? { reason: body.model_availability.reason } : {}) },
      estimatedCostFen: body.estimated_cost_fen,
    });
    return success({ control_package: toControlPackage(saved) });
  });
  app.post("/api/vnext/projects/:project_id/pending-generation-intents", { config: { agentAccess: "human_only" } }, async (request, reply) => {
    const { project_id } = parseRequest(projectParams, request.params);
    const body = parseRequest(pendingIntent, request.body);
    const result = await dependencies.intents().createPending(requireCurrentUser(request).id, project_id, body.client_idempotency_key);
    return reply.code(result.created ? 201 : 200).send(success({ pending_intent: toPendingIntent(result.intent), outcome: result.created ? "created" : "replayed" }));
  });
}

export function toControlPackage(value: ControlPackage) {
  return { id: value.id, project_id: value.projectId, version: value.version, created_by_user_id: value.createdByUserId, created_at: value.createdAt, references: value.references.map((reference) => ({ reference_id: reference.referenceId, reference_version_id: reference.referenceVersionId, label: reference.label, reason: reference.reason, position: reference.position, capability_snapshot: { version: reference.capabilitySnapshot.version, captured_at: reference.capabilitySnapshot.capturedAt, capabilities: reference.capabilitySnapshot.capabilities } })), final_prompt: value.finalPrompt, model: value.model, parameters: value.parameters, no_bgm: value.noBgm, model_availability: { status: value.modelAvailability.status, checked_at: value.modelAvailability.checkedAt, ...(value.modelAvailability.reason ? { reason: value.modelAvailability.reason } : {}) }, estimated_cost_fen: value.estimatedCostFen };
}

export function toPendingIntent(value: PendingGenerationIntent) {
  return { id: value.id, project_id: value.projectId, control_package_id: value.controlPackageId, control_package_version: value.controlPackageVersion, references: toControlPackage({ ...value, version: value.controlPackageVersion, createdByUserId: value.actorId, modelAvailability: { status: "available", checkedAt: value.createdAt } }).references, final_prompt: value.finalPrompt, model: value.model, parameters: value.parameters, no_bgm: value.noBgm, estimated_cost_fen: value.estimatedCostFen, status: value.status, created_at: value.createdAt };
}
