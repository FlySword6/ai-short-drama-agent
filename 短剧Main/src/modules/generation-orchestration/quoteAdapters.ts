import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { assetMedia, assetVariants } from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";
import { estimateGenerationCost } from "../generation/cost.js";
import {
  createGenerationRepository,
  createGenerationService,
} from "../generation/factory.js";
import { normalizeGenerationInput } from "../generation/service.js";
import type {
  GenerationMediaKind,
  GenerationReferenceSnapshot,
  SubmitGenerationInput,
} from "../generation/types.js";
import type {
  GenerationQuoteAdapter,
  GenerationReferenceResolver,
  PreparedGenerationQuote,
  PrepareGenerationQuoteInput,
  SelectedGenerationAsset,
} from "./types.js";

export class DrizzleGenerationReferenceResolver implements GenerationReferenceResolver {
  constructor(private readonly db: Database) {}

  resolve(
    actorId: string,
    mediaKind: GenerationMediaKind,
    mediaIds: string[],
  ): Promise<GenerationReferenceSnapshot[]> {
    return createGenerationRepository(this.db).resolveReferenceSnapshots(
      actorId,
      mediaKind,
      mediaIds,
    );
  }

  async resolveSelectedAsset(
    selectedAsset: SelectedGenerationAsset,
    resolvedReference: GenerationReferenceSnapshot,
  ): Promise<SelectedGenerationAsset> {
    const row = (await this.db.select({
      mediaId: assetMedia.id,
      directEntityId: assetMedia.assetEntityId,
      variantEntityId: assetVariants.assetEntityId,
    }).from(assetMedia).leftJoin(
      assetVariants,
      eq(assetMedia.assetVariantId, assetVariants.id),
    ).where(and(
      eq(assetMedia.id, selectedAsset.mediaId),
      isNull(assetMedia.deletedAt),
    )).limit(1))[0];
    const assetEntityId = row?.directEntityId ?? row?.variantEntityId;
    if (
      !row
      || !assetEntityId
      || assetEntityId !== selectedAsset.assetEntityId
      || resolvedReference.mediaId !== selectedAsset.mediaId
      || resolvedReference.kind !== selectedAsset.mediaKind
    ) {
      throw selectedAssetMismatch();
    }
    return {
      assetEntityId,
      mediaId: row.mediaId,
      mediaKind: resolvedReference.kind,
    };
  }
}

export class MockGenerationQuoteAdapter implements GenerationQuoteAdapter {
  readonly mode = "mock" as const;

  constructor(private readonly references: GenerationReferenceResolver) {}

  async prepare(input: PrepareGenerationQuoteInput): Promise<PreparedGenerationQuote> {
    const referenceSnapshots = await this.references.resolve(
      input.actorId,
      input.mediaKind,
      input.referenceMediaIds,
    );
    const selectedAsset = await resolveSelectedAsset(
      this.references,
      input,
      referenceSnapshots,
    );
    const normalized = normalizeGenerationInput(generationInput(
      input,
      referenceSnapshots,
      selectedAsset,
    ));
    try {
      const estimate = estimateGenerationCost(input.tier.pricingRule, normalized);
      return {
        referenceSnapshots: normalized.referenceAssetSnapshots,
        ...(selectedAsset ? { selectedAsset } : {}),
        quote: {
          mode: "mock",
          generationQuoteId: null,
          estimatedCostFen: estimate.estimatedCostFen,
          currency: "CNY",
          billingUnit: estimate.billingUnit,
          billableUnits: estimate.billableUnits,
          expiresAt: null,
          notice: "模拟报价，不会扣费或创建真实任务",
        },
      };
    } catch {
      throw new AppError(
        422,
        "tier_not_priced",
        "这组原生参数当前还没有公司核价档位，不能伪造报价。请改选已核价档位。",
      );
    }
  }
}

export class RealGenerationQuoteAdapter implements GenerationQuoteAdapter {
  readonly mode = "real" as const;

  private readonly references: GenerationReferenceResolver;

  constructor(
    private readonly db: Database,
    references?: GenerationReferenceResolver,
  ) {
    this.references = references ?? new DrizzleGenerationReferenceResolver(db);
  }

  async prepare(input: PrepareGenerationQuoteInput): Promise<PreparedGenerationQuote> {
    const repository = createGenerationRepository(this.db);
    const referenceSnapshots = await this.references.resolve(
      input.actorId,
      input.mediaKind,
      input.referenceMediaIds,
    );
    const selectedAsset = await resolveSelectedAsset(
      this.references,
      input,
      referenceSnapshots,
    );
    const normalized = normalizeGenerationInput(generationInput(
      input,
      referenceSnapshots,
      selectedAsset,
    ));
    const quote = await createGenerationService(repository).quoteSubmission(
      { userId: input.actorId },
      normalized,
      "assistant",
      input.sessionId,
    );
    return {
      referenceSnapshots: normalized.referenceAssetSnapshots,
      ...(selectedAsset ? { selectedAsset } : {}),
      quote: {
        mode: "real",
        generationQuoteId: quote.id,
        estimatedCostFen: quote.estimatedCostFen,
        currency: "CNY",
        billingUnit: quote.priceSnapshot.billingUnit,
        billableUnits: quote.priceSnapshot.billableUnits,
        expiresAt: quote.expiresAt,
        notice: "确认后才会创建一次真实生成任务并按冻结报价扣费",
      },
    };
  }
}

function generationInput(
  input: PrepareGenerationQuoteInput,
  referenceSnapshots: GenerationReferenceSnapshot[],
  selectedAsset?: SelectedGenerationAsset,
): SubmitGenerationInput {
  return {
    projectId: input.context.projectId,
    ...(input.context.episodeId ? { episodeId: input.context.episodeId } : {}),
    ...(input.context.sceneId ? { sceneId: input.context.sceneId } : {}),
    ...(input.context.shotId ? { shotId: input.context.shotId } : {}),
    ...(input.operationType === "edit" && selectedAsset
      ? { targetAssetEntityId: selectedAsset.assetEntityId }
      : {}),
    mediaKind: input.mediaKind,
    tierId: input.tier.tierId,
    model: input.tier.model,
    prompt: input.prompt,
    parameters: input.parameters,
    referenceMediaIds: input.referenceMediaIds,
    referenceAssetSnapshots: referenceSnapshots,
    quantity: input.tier.quantity,
    productionMode: "full",
    clientIdempotencyKey: `nl-orchestration:${input.sessionId}:${crypto.randomUUID()}`,
  };
}

async function resolveSelectedAsset(
  references: GenerationReferenceResolver,
  input: PrepareGenerationQuoteInput,
  snapshots: GenerationReferenceSnapshot[],
): Promise<SelectedGenerationAsset | undefined> {
  if (!input.selectedAsset) return undefined;
  const resolved = snapshots.find(
    (snapshot) => snapshot.mediaId === input.selectedAsset?.mediaId,
  ) ?? (await references.resolve(
    input.actorId,
    input.selectedAsset.mediaKind,
    [input.selectedAsset.mediaId],
  ))[0];
  if (!resolved) throw selectedAssetMismatch();
  return references.resolveSelectedAsset(input.selectedAsset, resolved);
}

function selectedAssetMismatch(): AppError {
  return new AppError(
    409,
    "selected_asset_mismatch",
    "当前选中媒体与资产不一致，请刷新后重试。",
  );
}
