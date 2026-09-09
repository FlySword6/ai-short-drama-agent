import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { generationAttempts } from "../../db/schema.js";

/**
 * Canonical projection for a generation request's current state.
 *
 * A retry appends an attempt; it does not create another task. Consumers that
 * count tasks or current cost must therefore read only the greatest attempt_no
 * for each request. Attempt-history screens intentionally query the base table.
 */
export function currentAttempts(db: Database) {
  const latest = db
    .select({
      requestId: generationAttempts.requestId,
      maxAttemptNo: sql<number>`max(${generationAttempts.attemptNo})`.as("max_attempt_no"),
    })
    .from(generationAttempts)
    .groupBy(generationAttempts.requestId)
    .as("latest_generation_attempt_no");

  return db
    .select({
      requestId: generationAttempts.requestId,
      attemptNo: generationAttempts.attemptNo,
      status: generationAttempts.status,
      phase: generationAttempts.phase,
      provider: generationAttempts.provider,
      model: generationAttempts.model,
      estimatedCostFen: generationAttempts.estimatedCostFen,
      actualCostFen: generationAttempts.actualCostFen,
      actualCostStatus: generationAttempts.actualCostStatus,
      errorMessage: generationAttempts.errorMessage,
      providerTaskId: generationAttempts.providerTaskId,
      createdAt: generationAttempts.createdAt,
      updatedAt: generationAttempts.updatedAt,
    })
    .from(generationAttempts)
    .innerJoin(latest, and(
      eq(generationAttempts.requestId, latest.requestId),
      eq(generationAttempts.attemptNo, latest.maxAttemptNo),
    ))
    .as("current_generation_attempt");
}

export type CurrentAttempts = ReturnType<typeof currentAttempts>;
