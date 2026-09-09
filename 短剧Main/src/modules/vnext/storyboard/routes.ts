import type { FastifyInstance } from "fastify";
import type { Database } from "../../../db/client.js";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import { StoryboardService } from "./service.js";
import { storyboardCellParamsSchema, storyboardGenerateSchema, storyboardLoadQuerySchema, storyboardProjectParamsSchema, storyboardRedrawSchema } from "./schema.js";
import type { StoryboardBoard } from "./types.js";

export interface StoryboardRouteDependencies {
  createService?: (database: Database) => StoryboardService;
}

/** Register from the vNext composition root; kept local until its parent route is wired. */
export async function registerStoryboardRoutes(app: FastifyInstance, getDatabase: () => Database, dependencies: StoryboardRouteDependencies = {}): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase()) ?? new StoryboardService(getDatabase());
  app.get("/api/vnext/projects/:project_id/storyboard", async (request) => {
    const { project_id } = parseRequest(storyboardProjectParamsSchema, request.params);
    const { confirmation_id } = parseRequest(storyboardLoadQuerySchema, request.query);
    return success(toWorkbench(await service().workbench(requireCurrentUser(request), project_id, confirmation_id)));
  });
  app.post("/api/vnext/projects/:project_id/storyboard", { config: { agentAccess: "human_only" } }, async (request, reply) => {
    const { project_id } = parseRequest(storyboardProjectParamsSchema, request.params);
    const input = parseRequest(storyboardGenerateSchema, request.body);
    const result = await service().generate(requireCurrentUser(request), {
      projectId: project_id, confirmationId: input.confirmation_id, clientIdempotencyKey: input.client_idempotency_key, paidConfirmation: input.paid_confirmation,
    });
    return reply.code(result.created ? 201 : 200).send(success({ board: toBoard(result.board), outcome: result.created ? "created" : "replayed" }));
  });
  app.post("/api/vnext/projects/:project_id/storyboard/cells/:cell_id/redraw", { config: { agentAccess: "human_only" } }, async (request, reply) => {
    const params = parseRequest(storyboardCellParamsSchema, request.params);
    const input = parseRequest(storyboardRedrawSchema, request.body);
    const result = await service().redraw(requireCurrentUser(request), {
      projectId: params.project_id, confirmationId: input.confirmation_id, cellId: params.cell_id, prompt: input.prompt, clientIdempotencyKey: input.client_idempotency_key, paidConfirmation: input.paid_confirmation,
    });
    return reply.code(result.created ? 201 : 200).send(success({ board: toBoard(result.board), outcome: result.created ? "created" : "replayed" }));
  });
}

function toWorkbench(state: Awaited<ReturnType<StoryboardService["workbench"]>>) { return { board: state.board ? toBoard(state.board) : null }; }
export function toBoard(board: StoryboardBoard) {
  return {
    id: board.id, project_id: board.projectId, confirmation_id: board.confirmationId, version: board.version,
    source_kind: board.sourceKind, base_board_id: board.baseBoardId, redrawn_cell_id: board.redrawnCellId, redrawn_cell_version_id: board.redrawnCellVersionId,
    created_at: board.createdAt.toISOString(),
    cells: board.cells.map((cell) => ({ id: cell.id, shot_id: cell.shotId, position: cell.position, version: {
      id: cell.version.id, cell_id: cell.version.cellId, version: cell.version.version, prompt: cell.version.prompt, source: cell.version.source,
      media_url: cell.version.mediaUrl, media_sha256: cell.version.mediaSha256, provider: cell.version.provider, model: cell.version.model, billing_receipt_id: cell.version.billingReceiptId, created_at: cell.version.createdAt.toISOString(),
    } })),
  };
}
