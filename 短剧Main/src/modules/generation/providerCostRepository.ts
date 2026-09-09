import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  configEntries,
  generationAttempts,
  generationRequests,
  providerCosts,
} from "../../db/schema.js";
import type { ProviderResultSnapshot } from "./types.js";
import {
  calculateProviderCost,
  type ProviderCostRecordOutcome,
} from "./providerCost.js";

export interface RecordProviderCostInput {
  attemptId: string;
  result: ProviderResultSnapshot;
}

/**
 * The provider-cost write is an independent audit transaction. Callers must
 * catch its errors: a broken ledger must alert, never roll back generation.
 */
export class PostgresProviderCostRepository {
  constructor(private readonly db: Database) {}

  async record(input: RecordProviderCostInput): Promise<ProviderCostRecordOutcome> {
    return this.db.transaction(async (transaction) => {
      const existing = (await transaction.select().from(providerCosts)
        .where(eq(providerCosts.generationAttemptId, input.attemptId))
        .limit(1))[0];
      if (existing) {
        await projectAttemptCost(transaction as unknown as Database, existing);
        return outcome(existing);
      }

      const context = (await transaction.select({
        request: generationRequests,
        attempt: generationAttempts,
      }).from(generationAttempts)
        .innerJoin(generationRequests, eq(generationAttempts.requestId, generationRequests.id))
        .where(eq(generationAttempts.id, input.attemptId))
        .limit(1))[0];
      if (!context) throw new Error("provider_cost_attempt_not_found");

      const configRows = await transaction.select({
        id: configEntries.id,
        updatedAt: configEntries.updatedAt,
        payload: configEntries.payload,
      }).from(configEntries).where(and(
        eq(configEntries.kind, "provider_cost_basis"),
        eq(configEntries.status, "published"),
      ));
      const calculation = calculateProviderCost(configRows, {
        provider: context.attempt.provider,
        model: context.attempt.model,
        mediaKind: asMediaKind(context.request.mediaKind),
        parameters: context.attempt.parameters,
        quantity: context.attempt.quantity,
        result: input.result,
      });
      const now = new Date();
      await transaction.insert(providerCosts).values({
        id: randomUUID(),
        generationRequestId: context.request.id,
        generationAttemptId: context.attempt.id,
        projectId: context.request.projectId,
        actorUserId: context.request.userId,
        rateConfigEntryId: calculation.configEntryId,
        provider: context.attempt.provider,
        model: context.attempt.model,
        actualModelId: calculation.actualModelId,
        mediaKind: context.request.mediaKind,
        providerResultStatus: input.result.status,
        calculationStatus: calculation.status,
        usageSource: calculation.usageSource,
        usageUnit: calculation.usageUnit,
        usageQuantity: calculation.usageQuantity,
        billingUnit: calculation.billingUnit,
        unitPriceCnyMicros: calculation.unitPriceCnyMicros,
        unitSize: calculation.unitSize,
        costCnyMicros: calculation.costCnyMicros,
        costFenRounded: calculation.costFenRounded,
        currency: calculation.currency,
        rateConfigUpdatedAt: calculation.configUpdatedAt,
        rateConfigChecksum: calculation.configChecksum,
        calculationVersion: calculation.calculationVersion,
        requiresAttention: calculation.requiresAttention,
        failureCode: calculation.failureCode,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({ target: providerCosts.generationAttemptId });

      const persisted = (await transaction.select().from(providerCosts)
        .where(eq(providerCosts.generationAttemptId, input.attemptId))
        .limit(1))[0];
      if (!persisted) throw new Error("provider_cost_write_missing");
      await projectAttemptCost(transaction as unknown as Database, persisted);
      return outcome(persisted);
    });
  }
}

async function projectAttemptCost(
  db: Database,
  row: typeof providerCosts.$inferSelect,
): Promise<void> {
  await db.update(generationAttempts).set({
    actualCostFen: row.costFenRounded,
    actualCostStatus: row.calculationStatus,
    updatedAt: new Date(),
  }).where(eq(generationAttempts.id, row.generationAttemptId));
}

function outcome(row: typeof providerCosts.$inferSelect): ProviderCostRecordOutcome {
  return {
    status: asCalculationStatus(row.calculationStatus),
    requiresAttention: row.requiresAttention,
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  };
}

function asCalculationStatus(value: string): ProviderCostRecordOutcome["status"] {
  if (value === "confirmed" || value === "estimated" || value === "unavailable") return value;
  throw new Error(`invalid provider cost status: ${value}`);
}

function asMediaKind(value: string): "image" | "video" | "audio" {
  if (value === "image" || value === "video" || value === "audio") return value;
  throw new Error(`invalid provider cost media kind: ${value}`);
}
