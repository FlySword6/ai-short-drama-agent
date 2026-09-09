import { settings } from "../../../config/env.js";
import { sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { ProjectAccessActor } from "../../project-access/types.js";
import { VnextProjectRepository } from "../repository.js";
import { assertGenerationPilotCreditAccess } from "../../account-credits/generationAccess.js";
import { VnextProjectService } from "../service.js";
import { ControlledStoryboardImageAdapter } from "./adapter.js";
import { StoryboardRepository } from "./repository.js";
import type { StoryboardImageAdapter, StoryboardWorkbenchState } from "./types.js";

export type StoryboardGenerationAccessGate = (database: Database, actorId: string) => Promise<void>;

export class StoryboardService {
  private readonly repository: StoryboardRepository;
  private readonly projects: VnextProjectService;
  private readonly projectRepository: VnextProjectRepository;

  constructor(
    private readonly db: Database,
    private readonly images: StoryboardImageAdapter = new ControlledStoryboardImageAdapter(),
    private readonly authorizeGeneration: StoryboardGenerationAccessGate = (database, actorId) => assertGenerationPilotCreditAccess(database, actorId, { enabled: settings.generationPilotCreditGateEnabled }),
  ) {
    this.repository = new StoryboardRepository(db);
    this.projects = new VnextProjectService(db);
    this.projectRepository = new VnextProjectRepository(db);
  }

  async workbench(actor: ProjectAccessActor, projectId: string, confirmationId: string): Promise<StoryboardWorkbenchState> {
    await this.projects.getProject(actor, projectId);
    return { board: await this.repository.latest(projectId, confirmationId) };
  }

  async generate(actor: ProjectAccessActor, input: { projectId: string; confirmationId: string; clientIdempotencyKey: string; paidConfirmation: true }) {
    await this.requireWrite(actor, input.projectId);
    await this.authorizeGeneration(this.db, actor.id);
    const confirmation = await this.db.execute<{ id: string }>(sql`SELECT id FROM vnext.script_confirmations WHERE id = ${input.confirmationId}::uuid AND project_id = ${input.projectId}::uuid`);
    if (!confirmation.rows[0]) throw new NotFoundError("Confirmed shot plan does not belong to this project");
    return this.repository.createInitial({
      projectId: input.projectId, confirmationId: input.confirmationId, actorId: actor.id, key: input.clientIdempotencyKey,
      generate: (cellId, prompt, source) => this.images.generate({ projectId: input.projectId, cellId, actorId: actor.id, idempotencyKey: `storyboard-initial:${input.confirmationId}:${String(source.shot_id)}`, prompt, source, paidConfirmation: input.paidConfirmation }),
    });
  }

  async redraw(actor: ProjectAccessActor, input: { projectId: string; confirmationId: string; cellId: string; prompt: string; clientIdempotencyKey: string; paidConfirmation: true }) {
    await this.requireWrite(actor, input.projectId);
    const current = await this.repository.latest(input.projectId, input.confirmationId);
    await this.authorizeGeneration(this.db, actor.id);
    if (!current) throw new ConflictError("请先生成完整故事板再重绘单格", "storyboard_not_generated");
    if (!current.cells.some((cell) => cell.id === input.cellId)) throw new NotFoundError("故事板单元不存在或不属于当前版本");
    return this.repository.redraw({
      confirmationId: input.confirmationId,
      projectId: input.projectId, cellId: input.cellId, actorId: actor.id, key: input.clientIdempotencyKey, prompt: input.prompt,
      generate: (source) => this.images.generate({ projectId: input.projectId, cellId: input.cellId, actorId: actor.id, idempotencyKey: `storyboard-redraw:${input.projectId}:${input.clientIdempotencyKey}`, prompt: input.prompt, source, paidConfirmation: input.paidConfirmation }),
    });
  }

  private async requireWrite(actor: ProjectAccessActor, projectId: string): Promise<void> {
    await this.projects.getProject(actor, projectId);
    if (await this.projectRepository.findMemberRole(projectId, actor.id) === "viewer") {
      throw new ForbiddenError("你没有在这个 vNext 项目中生成或重绘故事板的权限");
    }
  }
}
