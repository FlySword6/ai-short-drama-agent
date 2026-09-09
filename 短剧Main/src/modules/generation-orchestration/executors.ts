import { AppError } from "../../shared/errors.js";
import type { GenerationReferenceSnapshot } from "../generation/types.js";
import {
  ArkByteProviderReplica,
  executeReplicaProvider,
} from "./providerReplica.js";
import type {
  ExecuteGenerationOperationInput,
  GenerationOperationExecutor,
  GenerationOperationReceipt,
  GenerationTierCatalog,
  RealGenerationSubmit,
} from "./types.js";

export class MockGenerationOperationExecutor implements GenerationOperationExecutor {
  readonly mode = "mock" as const;

  constructor(
    private readonly catalog: GenerationTierCatalog,
    private readonly provider = new ArkByteProviderReplica(),
  ) {}

  async execute(input: ExecuteGenerationOperationInput): Promise<GenerationOperationReceipt> {
    if (input.operation.executionMode !== "mock" || input.operation.quote.mode !== "mock") {
      throw new AppError(409, "orchestration_mode_mismatch", "这不是模拟操作，不能按模拟模式执行");
    }
    const tier = (await this.catalog.list(input.operation.mediaKind))
      .find((item) => item.tierId === input.operation.tier.tierId);
    if (!tier) {
      throw new AppError(409, "tier_not_priced", "原报价档位已经不可用，请重新准备操作");
    }
    const execution = await executeReplicaProvider(this.provider, {
      mediaKind: input.operation.mediaKind,
      model: tier.model,
      prompt: input.operation.prompt,
      parameters: input.operation.defaults,
      references: replicaReferences(input.operation.referenceMedia),
      quantity: tier.quantity,
    });
    return {
      operationId: input.operationId,
      status: "succeeded",
      executionMode: "mock",
      generationRequestId: null,
      attemptId: execution.attemptId,
      target: input.operation.target,
      artifact: {
        mediaKind: input.operation.mediaKind,
        storageState: "simulated",
        storageUrl: null,
      },
      ledger: {
        estimatedCostFen: input.operation.quote.estimatedCostFen,
        chargedCostFen: 0,
        pointsSpent: 0,
        currency: "CNY",
      },
      timeline: execution.timeline,
      message: "模拟生成已完成：未调用真实供应商，未扣费。",
    };
  }
}

export class RealGenerationOperationExecutor implements GenerationOperationExecutor {
  readonly mode = "real" as const;

  constructor(private readonly submit: RealGenerationSubmit) {}

  async execute(input: ExecuteGenerationOperationInput): Promise<GenerationOperationReceipt> {
    if (input.operation.executionMode !== "real" || input.operation.quote.mode !== "real") {
      throw new AppError(409, "orchestration_mode_mismatch", "这不是已核价的真实操作，不能提交");
    }
    const quoteId = input.operation.quote.generationQuoteId;
    if (!quoteId) {
      throw new AppError(409, "generation_quote_missing", "真实报价单缺失，请重新准备操作");
    }
    if (!input.session.projectId) {
      throw new AppError(409, "session_project_missing", "助手会话没有绑定项目，不能提交真实生成");
    }
    const view = await this.submit(input.actorId, input.session, quoteId, input.session.projectId);
    const completed = view.status === "succeeded" && view.media.length > 0;
    return {
      operationId: input.operationId,
      status: completed ? "succeeded" : "queued",
      executionMode: "real",
      generationRequestId: view.requestId,
      attemptId: view.attemptId,
      target: input.operation.target,
      artifact: {
        mediaKind: input.operation.mediaKind,
        storageState: completed ? "persisted" : "pending",
        storageUrl: completed ? view.media[0]?.storageUrl ?? null : null,
      },
      ledger: {
        estimatedCostFen: input.operation.quote.estimatedCostFen,
        chargedCostFen: null,
        pointsSpent: null,
        currency: "CNY",
      },
      timeline: completed
        ? [
            { state: "accepted", offsetMs: 0 },
            { state: "running", offsetMs: 0 },
            { state: "succeeded", offsetMs: 0 },
          ]
        : [{ state: "accepted", offsetMs: 0 }],
      message: completed
        ? "生成已完成，产物已保存。"
        : "生成任务已创建；可在任务进度中查看保存结果。",
    };
  }
}

function replicaReferences(
  references: Array<{ mediaId: string; kind: "image" | "video" | "audio"; role?: string }>,
): GenerationReferenceSnapshot[] {
  return references.map((reference) => ({
    kind: reference.kind,
    mediaId: reference.mediaId,
    url: `https://provider-replica.invalid/references/${reference.mediaId}`,
    ...(reference.role ? { role: reference.role } : {}),
  }));
}
