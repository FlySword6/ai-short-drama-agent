import { AppError, NotFoundError, UnprocessableEntityError } from "../../../shared/errors.js";
import type { ControlPackageStore } from "../control-packages/repository.js";
import type { ControlPackageProjectAccess } from "../control-packages/service.js";
import type { PendingIntentStore } from "./repository.js";
import type { PendingGenerationIntent, PendingIntentWorkbench } from "./types.js";

export interface PendingIntentAuthorization {
  assertBudgetAndAccountAccess(actorId: string, projectId: string, estimatedCostFen: number): Promise<void>;
  assertReferenceAssetAccess(actorId: string, projectId: string, referenceVersionIds: string[]): Promise<void>;
}

export class GenerationIntentService {
  constructor(
    private readonly intents: PendingIntentStore,
    private readonly packages: ControlPackageStore,
    private readonly access: ControlPackageProjectAccess,
    private readonly authorization: PendingIntentAuthorization,
  ) {}

  async workbench(actorId: string, projectId: string): Promise<PendingIntentWorkbench> {
    await this.access.assertRead(actorId, projectId);
    return { pendingIntent: await this.intents.latest(projectId, actorId) };
  }

  async createPending(actorId: string, projectId: string, clientIdempotencyKey: string): Promise<{ intent: PendingGenerationIntent; created: boolean }> {
    await this.access.assertWrite(actorId, projectId);
    const key = clientIdempotencyKey.trim();
    if (!key) throw new UnprocessableEntityError("确认前必须提供稳定的幂等键");
    const controlPackage = await this.packages.latest(projectId);
    if (!controlPackage) throw new NotFoundError("请先保存生成控制包");
    if (controlPackage.modelAvailability.status !== "available") {
      throw new AppError(422, "model_unavailable", `模型当前不可用：${controlPackage.modelAvailability.reason ?? "请刷新能力快照后重试"}`);
    }
    await this.authorization.assertReferenceAssetAccess(actorId, projectId, controlPackage.references.map((reference) => reference.referenceVersionId));
    await this.authorization.assertBudgetAndAccountAccess(actorId, projectId, controlPackage.estimatedCostFen);
    // Deliberately stop at persistence. A later, explicit human confirmation owns
    // provider dispatch, input upload, resource reservation, and fee debit.
    return this.intents.create({
      projectId, actorId, clientIdempotencyKey: key, controlPackageId: controlPackage.id,
      controlPackageVersion: controlPackage.version, references: controlPackage.references,
      finalPrompt: controlPackage.finalPrompt, model: controlPackage.model,
      parameters: { ...controlPackage.parameters }, noBgm: controlPackage.noBgm,
      estimatedCostFen: controlPackage.estimatedCostFen, status: "pending_confirmation",
    });
  }
}
