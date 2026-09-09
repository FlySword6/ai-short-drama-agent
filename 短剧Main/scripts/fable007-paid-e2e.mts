#!/usr/bin/env node
/**
 * FABLE-007 one-shot paid dev E2E.
 *
 * Contract:
 * - preflight is read-only and reports the exact absolute budget required by
 *   the repository's historical cumulative-budget implementation;
 * - run mode requires explicit paid confirmation, a 30-fen incremental cap,
 *   approved dev DB/provider/TOS identities and the cheapest Ark image tier;
 * - quote and explicit human confirmation go through the real backend
 *   service/repository boundary (the dev sessions table is still pre-047);
 * - only the attempt created by this process may be leased and executed;
 * - provider submission is never retried;
 * - success requires platform AIGC evidence, TOS receipt and PostgreSQL media.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, isNull, sql } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import {
  createDatabase,
  type Database,
  type DatabaseHandle,
} from "../src/db/client.js";
import {
  generationAttempts,
  generationRequests,
  generationTosOrphans,
  mediaResults,
  providerCosts,
} from "../src/db/schema.js";
import { normalizeTosSdkEndpoint } from "../src/integrations/tosStorage.js";
import { DrizzleCapabilityTierRepository } from "../src/modules/capability-tiers/repository.js";
import { CapabilityTierService } from "../src/modules/capability-tiers/service.js";
import {
  createGenerationRepository,
  createGenerationService,
  effectivePaidBudgetFen,
  workerDependenciesReady,
} from "../src/modules/generation/factory.js";
import { AppError } from "../src/shared/errors.js";
import {
  assertApprovedCredential,
  assertFable007DeploymentIdentity,
} from "./fable007-provider-smoke.mjs";

interface CliOptions {
  mode: "preflight" | "run" | "recover";
  target: "dev";
  incrementalBudgetFen: 30;
  confirmPaid: boolean;
  runId?: string;
}

const TIER_ID = "img-seedream5pro-169-1k-1";
const MODEL_ID = "doubao-seedream-5-0-pro-260628";
const E2E_PROMPT = "一盏暖色纸灯置于深蓝桌面，极简产品摄影，无文字。";
const INCREMENTAL_BUDGET_FEN = 30;
const LEASE_SECONDS = 180;
let activeStage = "bootstrap";
let activeRunFingerprint: string | undefined;
let activeAttemptFingerprint: string | undefined;

async function main(): Promise<void> {
  const options = parsePaidE2eArgs(process.argv.slice(2));
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  activeStage = "identity_preflight";
  assertFable007DeploymentIdentity({
    databaseUrl: settings.databaseUrl,
    expectedSha256: settings.pricingSeedDevDatabaseIdentitySha256,
    appEnvironment: settings.appEnvironment,
  });
  if (settings.postgresSchema !== "app") {
    throw new Error("PAID_E2E_SCHEMA_MUST_BE_APP");
  }
  if (options.mode !== "recover") {
    assertApprovedCredential(
      settings.arkApiKey,
      settings.fable007DevArkCredentialSha256,
      "ARK_API_KEY",
    );
    if (!workerDependenciesReady(settings, "image")) {
      throw new Error("PAID_E2E_IMAGE_WORKER_NOT_READY");
    }
  }

  const databaseHandle = createDatabase();
  try {
    activeStage = "database_preflight";
    const reservedFen = await reservedCostFen(databaseHandle.db);
    const requiredAbsoluteBudgetFen = reservedFen + options.incrementalBudgetFen;
    if (options.mode === "recover") {
      const result = await recoverPaidE2e(databaseHandle, options.runId!, reservedFen);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = paidE2eResultExitCode(result);
      return;
    }
    const tosFingerprint = currentTosTargetFingerprint();
    const tier = (await new CapabilityTierService(
      new DrizzleCapabilityTierRepository(databaseHandle.db),
    ).listActive("image")).find((item) => item.tierId === TIER_ID);
    assertCheapestArkImageTier(tier);

    if (options.mode === "preflight") {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        mode: "preflight",
        target: "dev",
        tierId: TIER_ID,
        incrementalBudgetFen: options.incrementalBudgetFen,
        reservedCostFen: reservedFen,
        requiredAbsoluteBudgetFen,
        tosTargetFingerprint: tosFingerprint,
        tosTargetAllowlisted: approvedTosFingerprint() === tosFingerprint,
        workerReady: true,
        providerCalls: 0,
        externalWrites: 0,
      })}\n`);
      return;
    }

    activeStage = "authorization";
    assertRunAuthorization(options, requiredAbsoluteBudgetFen, tosFingerprint);
    const result = await runPaidE2e(databaseHandle, tier!.params, options.runId!);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await databaseHandle.pool.end();
  }
}

async function runPaidE2e(
  databaseHandle: DatabaseHandle,
  tierParameters: Record<string, string | number | boolean>,
  runId: string,
): Promise<Record<string, unknown>> {
  assert.equal(tierParameters.resolution, "1K");
  assert.equal(tierParameters.aspect_ratio, "16:9");
  activeRunFingerprint = sha256(runId).slice(0, 16);
  activeStage = "fixture";
  const fixture = await seedDirectFixture(databaseHandle, runId);
  const repository = createGenerationRepository(databaseHandle.db);
  const service = createGenerationService(repository, {
    // The durable audit below reports the fixed classification without
    // logging raw request/attempt IDs from the generic cost alert.
    costAlertLogger: { warn: () => undefined },
  });
  const actor = { userId: fixture.userId, authorizedProjectId: fixture.projectId };
  const generationInput = {
    projectId: fixture.projectId,
    episodeId: fixture.episodeId,
    targetAssetEntityId: fixture.assetId,
    mediaKind: "image" as const,
    tierId: TIER_ID,
    model: MODEL_ID,
    prompt: E2E_PROMPT,
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    parameters: {
      size: "1K",
      ratio: "16:9",
      watermark: false,
      sequentialImageGeneration: "disabled" as const,
    },
    quantity: 1,
    productionMode: "full" as const,
    clientIdempotencyKey: paidE2eIdempotencyKey(runId),
  };

  activeStage = "quote";
  const quote = await service.quoteSubmission(actor, generationInput, "web");
  assert.equal(quote.status, "pending_confirmation");
  assert.equal(quote.priceSnapshot.tierId, TIER_ID);
  assert.equal(quote.priceSnapshot.provider, "ark");
  assert.equal(quote.priceSnapshot.model, MODEL_ID);
  assert.equal(quote.estimatedCostFen, INCREMENTAL_BUDGET_FEN);

  activeStage = "confirm";
  const confirmed = await service.confirmQuote(actor, quote.id);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmedByUserId, fixture.userId);

  activeStage = "submit";
  const submitted = await service.submit(actor, generationInput, quote.id, "web");
  const requestId = submitted.requestId;
  const attemptId = submitted.attemptId;
  activeAttemptFingerprint = sha256(attemptId).slice(0, 16);
  assert.equal(submitted.status, "pending");
  assert.equal(submitted.phase, "created");

  const workerId = `fable007-paid-e2e-${randomUUID()}`;
  activeStage = "claim";
  const claimed = await claimExactFreshAttempt(databaseHandle.db, attemptId, workerId);
  if (!claimed) throw new Error("PAID_E2E_EXACT_ATTEMPT_NOT_CLAIMED");
  try {
    // Ark image generation is synchronous. This is the one and only provider
    // submission for this attempt; no retry path exists in this script.
    activeStage = "provider_submit_and_persist";
    await service.runRecoverableAttempt(attemptId, undefined, workerId);
  } finally {
    await repository.releaseLease(attemptId, workerId);
  }

  activeStage = "readback";
  const finalView = await service.get(actor, requestId);
  if (finalView.status !== "succeeded" || finalView.phase !== "complete") {
    throw new Error(`PAID_E2E_TERMINAL_${safeToken(String(finalView.status))}`);
  }
  if (finalView.media.length !== 1) throw new Error("PAID_E2E_MEDIA_RESULT_COUNT_INVALID");

  activeStage = "durable_audit";
  const audit = await readDurableAudit(databaseHandle.db, attemptId);
  activeStage = "complete";
  return {
    ok: true,
    mode: "run",
    target: "dev",
    tierId: TIER_ID,
    quote: {
      status: "consumed",
      estimatedCostFen: INCREMENTAL_BUDGET_FEN,
      humanConfirmed: true,
      boundary: "backend_service_repository",
    },
    generation: {
      runFingerprint: activeRunFingerprint,
      requestFingerprint: sha256(requestId).slice(0, 16),
      attemptFingerprint: activeAttemptFingerprint,
      status: "succeeded",
      phase: "complete",
      exactAttemptClaimedLocally: true,
      providerSubmissionsByThisScript: 1,
    },
    artifact: audit.artifact,
    tos: audit.tos,
    providerCost: audit.providerCost,
  };
}

export type PaidE2eRecoveryAction =
  | "audit_terminal_success"
  | "claim_and_resume"
  | "stop_submission_outcome_unknown"
  | "stop_terminal_failure"
  | "stop_unsafe_state";

export function paidE2eResultExitCode(result: Record<string, unknown>): 0 | 2 {
  return result.ok === true && result.recoveryClosed !== false ? 0 : 2;
}

export function paidE2eUnclosedRecoveryResult(
  recoveryAction: PaidE2eRecoveryAction,
  generation: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ok: false,
    mode: "recover",
    target: "dev",
    recoveryAction,
    recoveryClosed: false,
    generation,
  };
}

/**
 * `submitting` means the paid POST may already have left this process. It is
 * therefore a terminal stop for this recovery script, never a resubmit path.
 */
export function paidE2eRecoveryAction(input: {
  status: string;
  phase: string;
  errorCode?: string | null;
}): PaidE2eRecoveryAction {
  if (input.status === "succeeded" && input.phase === "complete") {
    return "audit_terminal_success";
  }
  if (input.phase === "submitting" || input.errorCode === "SUBMISSION_OUTCOME_UNKNOWN") {
    return "stop_submission_outcome_unknown";
  }
  if (input.status === "failed" || input.status === "cancelled") {
    return "stop_terminal_failure";
  }
  if (
    (input.status === "pending" || input.status === "running")
    && ["created", "provider_queued", "provider_running", "provider_succeeded", "persisting"]
      .includes(input.phase)
  ) {
    return "claim_and_resume";
  }
  return "stop_unsafe_state";
}

interface PaidE2eRecoveryAnchor {
  requestId: string;
  attemptId: string;
  userId: string;
  projectId: string;
  status: string;
  phase: string;
  errorCode: string | null;
}

async function recoverPaidE2e(
  databaseHandle: DatabaseHandle,
  runId: string,
  reservedFen: number,
): Promise<Record<string, unknown>> {
  activeStage = "recovery_lookup";
  activeRunFingerprint = sha256(runId).slice(0, 16);
  const anchor = await findExactRecoveryAnchor(databaseHandle.db, runId);
  activeAttemptFingerprint = sha256(anchor.attemptId).slice(0, 16);
  const action = paidE2eRecoveryAction(anchor);
  const generationAnchor = {
    runFingerprint: activeRunFingerprint,
    requestFingerprint: sha256(anchor.requestId).slice(0, 16),
    attemptFingerprint: activeAttemptFingerprint,
    initialStatus: safeToken(anchor.status),
    initialPhase: safeToken(anchor.phase),
    providerSubmissionsByThisScript: 0,
  };

  if (action === "audit_terminal_success") {
    activeStage = "recovery_audit";
    const audit = await readDurableAudit(databaseHandle.db, anchor.attemptId);
    activeStage = "complete";
    return {
      ok: true,
      mode: "recover",
      target: "dev",
      recoveryAction: action,
      generation: {
        ...generationAnchor,
        status: "succeeded",
        phase: "complete",
      },
      artifact: audit.artifact,
      tos: audit.tos,
      providerCost: audit.providerCost,
    };
  }
  if (action === "stop_submission_outcome_unknown" || action === "stop_terminal_failure") {
    activeStage = "recovery_stopped";
    return paidE2eUnclosedRecoveryResult(action, {
      ...generationAnchor,
      status: safeToken(anchor.status),
      phase: safeToken(anchor.phase),
      resubmissionRefused: true,
      ...(anchor.errorCode ? { errorCode: safeToken(anchor.errorCode) } : {}),
    });
  }
  if (action === "stop_unsafe_state") {
    throw new Error("PAID_E2E_RECOVERY_STATE_UNSAFE");
  }

  activeStage = "recovery_authorization";
  assertRecoveryAuthorization(reservedFen);
  const repository = createGenerationRepository(databaseHandle.db);
  const service = createGenerationService(repository, {
    costAlertLogger: { warn: () => undefined },
  });
  const workerId = `fable007-paid-recover-${randomUUID()}`;
  activeStage = "recovery_claim";
  const claimed = await claimExactRecoverableAttempt(databaseHandle.db, anchor, workerId);
  if (!claimed) throw new Error("PAID_E2E_RECOVERY_EXACT_ATTEMPT_NOT_CLAIMED");
  try {
    activeStage = "recovery_resume";
    await service.runRecoverableAttempt(anchor.attemptId, undefined, workerId);
  } finally {
    await repository.releaseLease(anchor.attemptId, workerId);
  }

  activeStage = "recovery_readback";
  const finalView = await service.get({
    userId: anchor.userId,
    authorizedProjectId: anchor.projectId,
  }, anchor.requestId);
  const generation = {
    ...generationAnchor,
    status: safeToken(finalView.status),
    phase: safeToken(finalView.phase),
    providerSubmissionsByThisScript: anchor.phase === "created" ? 1 : 0,
  };
  if (finalView.status !== "succeeded" || finalView.phase !== "complete") {
    activeStage = "recovery_stopped";
    return paidE2eUnclosedRecoveryResult(
      paidE2eRecoveryAction({
        status: finalView.status,
        phase: finalView.phase,
        errorCode: finalView.errorCode,
      }),
      generation,
    );
  }

  activeStage = "recovery_audit";
  const audit = await readDurableAudit(databaseHandle.db, anchor.attemptId);
  activeStage = "complete";
  return {
    ok: true,
    mode: "recover",
    target: "dev",
    recoveryAction: "claim_and_resume",
    recoveryClosed: true,
    generation,
    artifact: audit.artifact,
    tos: audit.tos,
    providerCost: audit.providerCost,
  };
}

async function findExactRecoveryAnchor(
  db: Database,
  runId: string,
): Promise<PaidE2eRecoveryAnchor> {
  const idempotencyKey = paidE2eIdempotencyKey(runId);
  const rows = await db.select({
    requestId: generationRequests.id,
    attemptId: generationAttempts.id,
    userId: generationRequests.userId,
    projectId: generationRequests.projectId,
    mediaKind: generationRequests.mediaKind,
    prompt: generationRequests.prompt,
    requestParameters: generationRequests.parameters,
    requestQuantity: generationRequests.quantity,
    clientIdempotencyKey: generationRequests.clientIdempotencyKey,
    attemptNo: generationAttempts.attemptNo,
    retryIdempotencyKey: generationAttempts.retryIdempotencyKey,
    provider: generationAttempts.provider,
    model: generationAttempts.model,
    attemptParameters: generationAttempts.parameters,
    attemptQuantity: generationAttempts.quantity,
    status: generationAttempts.status,
    phase: generationAttempts.phase,
    errorCode: generationAttempts.errorCode,
    estimatedCostFen: generationAttempts.estimatedCostFen,
    priceSnapshot: generationAttempts.priceSnapshot,
  }).from(generationRequests)
    .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
    .where(eq(generationRequests.clientIdempotencyKey, idempotencyKey))
    .limit(2);
  if (rows.length !== 1) throw new Error("PAID_E2E_RECOVERY_ANCHOR_NOT_UNIQUE");
  const row = rows[0]!;
  const requestParameters = row.requestParameters ?? {};
  const attemptParameters = row.attemptParameters ?? {};
  const priceSnapshot = row.priceSnapshot ?? {};
  if (
    row.clientIdempotencyKey !== idempotencyKey
    || row.mediaKind !== "image"
    || row.prompt !== E2E_PROMPT
    || row.requestQuantity !== 1
    || row.attemptNo !== 1
    || row.retryIdempotencyKey !== null
    || row.provider !== "ark"
    || row.model !== MODEL_ID
    || row.attemptQuantity !== 1
    || row.estimatedCostFen !== INCREMENTAL_BUDGET_FEN
    || requestParameters.size !== "1K"
    || requestParameters.ratio !== "16:9"
    || requestParameters.watermark !== false
    || attemptParameters.size !== "1K"
    || attemptParameters.ratio !== "16:9"
    || attemptParameters.watermark !== false
    || priceSnapshot.tierId !== TIER_ID
    || priceSnapshot.provider !== "ark"
    || priceSnapshot.model !== MODEL_ID
    || priceSnapshot.estimatedCostFen !== INCREMENTAL_BUDGET_FEN
    || priceSnapshot.currency !== "CNY"
  ) {
    throw new Error("PAID_E2E_RECOVERY_ANCHOR_DRIFT");
  }
  return {
    requestId: row.requestId,
    attemptId: row.attemptId,
    userId: row.userId,
    projectId: row.projectId,
    status: row.status,
    phase: row.phase,
    errorCode: row.errorCode,
  };
}

async function claimExactRecoverableAttempt(
  db: Database,
  anchor: PaidE2eRecoveryAnchor,
  workerId: string,
): Promise<boolean> {
  const claimed = await db.update(generationAttempts).set({
    leaseOwner: workerId,
    leaseUntil: sql`now() + (${LEASE_SECONDS} * interval '1 second')`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(generationAttempts.id, anchor.attemptId),
    eq(generationAttempts.status, anchor.status),
    eq(generationAttempts.phase, anchor.phase),
    isNull(generationAttempts.leaseOwner),
  )).returning({ id: generationAttempts.id });
  return claimed.length === 1;
}

function assertRecoveryAuthorization(reservedFen: number): void {
  if (!settings.allowPaidGeneration) throw new Error("PAID_E2E_PAID_GATE_DISABLED");
  if (effectivePaidBudgetFen() < reservedFen) {
    throw new Error("PAID_E2E_RECOVERY_BUDGET_BELOW_RESERVED");
  }
  assertApprovedCredential(
    settings.arkApiKey,
    settings.fable007DevArkCredentialSha256,
    "ARK_API_KEY",
  );
  if (!workerDependenciesReady(settings, "image")) {
    throw new Error("PAID_E2E_IMAGE_WORKER_NOT_READY");
  }
  const tosFingerprint = currentTosTargetFingerprint();
  const approved = approvedTosFingerprint();
  if (!approved || !safeHashEqual(approved, tosFingerprint)) {
    throw new Error("PAID_E2E_TOS_TARGET_NOT_APPROVED");
  }
}

async function seedDirectFixture(
  databaseHandle: DatabaseHandle,
  runKey: string,
): Promise<{
  userId: string;
  projectId: string;
  episodeId: string;
  shotId: string;
  assetId: string;
}> {
  const userId = randomUUID();
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const shotId = randomUUID();
  const assetId = randomUUID();
  const client = await databaseHandle.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO app.users (id, username, display_name, password_hash, active, role)
       VALUES ($1, $2, 'FABLE-007 paid E2E', 'service-boundary-no-login', true, 'member')`,
      [userId, `fable007-${runKey}`],
    );
    const credit = await client.query(
      `UPDATE app.user_credit_accounts
       SET balance_points = 50000, daily_limit_points = 50000, updated_at = now()
       WHERE user_id = $1`,
      [userId],
    );
    if (credit.rowCount !== 1) throw new Error("PAID_E2E_CREDIT_ACCOUNT_MISSING");
    await client.query(
      `INSERT INTO app.projects (id, owner_user_id, name, status)
       VALUES ($1, $2, $3, 'active')`,
      [projectId, userId, `FABLE-007 Ark E2E ${runKey.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO app.episodes (id, project_id, episode_no, name, sort_order, status)
       VALUES ($1, $2, 1, '后端付费验收', 1, 'active')`,
      [episodeId, projectId],
    );
    await client.query(
      `INSERT INTO app.shots (id, episode_id, shot_code, title, script_text, sort_order)
       VALUES ($1, $2, 'F007-IMG-1', 'Ark Seedream 最低档验收',
               '一盏暖色纸灯置于深蓝桌面，极简产品摄影，无文字。', 1)`,
      [shotId, episodeId],
    );
    await client.query(
      `INSERT INTO app.asset_entities (
         id, owner_user_id, visibility, asset_kind, role, usage_mode, name,
         display_name, style_tags, approved, reuse_scope, status, metadata,
         created_at, updated_at, use_count
       ) VALUES (
         $1, $2, 'personal', 'reference', 'character_identity', 'reference',
         'FABLE-007 Ark E2E 目标资产', 'FABLE-007 Ark E2E 目标资产',
         '[]'::jsonb, true, 'all_projects', 'approved', '{}'::jsonb,
         now(), now(), 0
       )`,
      [assetId, userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { userId, projectId, episodeId, shotId, assetId };
}

export function parsePaidE2eArgs(args: readonly string[]): CliOptions {
  let mode: CliOptions["mode"] | undefined;
  let target: string | undefined;
  let incrementalBudgetFen: number | undefined;
  let confirmPaid = false;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--preflight") {
      mode = "preflight";
    } else if (key === "--run") {
      mode = "run";
    } else if (key === "--recover") {
      mode = "recover";
    } else if (key === "--target") {
      target = args[index + 1];
      index += 1;
    } else if (key === "--incremental-budget-fen") {
      incrementalBudgetFen = Number(args[index + 1]);
      index += 1;
    } else if (key === "--confirm-paid") {
      confirmPaid = true;
    } else if (key === "--run-id") {
      runId = args[index + 1];
      index += 1;
    } else {
      throw new Error("PAID_E2E_ARGUMENT_INVALID");
    }
  }
  if (mode === undefined) throw new Error("PAID_E2E_MODE_REQUIRED");
  if (target !== "dev") throw new Error("PAID_E2E_TARGET_MUST_BE_DEV");
  if (incrementalBudgetFen !== INCREMENTAL_BUDGET_FEN) {
    throw new Error("PAID_E2E_INCREMENTAL_BUDGET_MUST_BE_30");
  }
  if ((mode === "run" || mode === "recover") && !confirmPaid) {
    throw new Error("PAID_E2E_CONFIRMATION_REQUIRED");
  }
  if (mode === "preflight" && confirmPaid) throw new Error("PAID_E2E_PREFLIGHT_MUST_NOT_CONFIRM");
  if (mode === "preflight" && runId !== undefined) throw new Error("PAID_E2E_PREFLIGHT_RUN_ID_FORBIDDEN");
  if (
    (mode === "run" || mode === "recover")
    && (typeof runId !== "string" || !/^[a-z0-9][a-z0-9_-]{7,63}$/u.test(runId))
  ) {
    throw new Error("PAID_E2E_RUN_ID_INVALID");
  }
  return {
    mode,
    target: "dev",
    incrementalBudgetFen: INCREMENTAL_BUDGET_FEN,
    confirmPaid,
    ...(runId ? { runId } : {}),
  };
}

export function paidE2eIdempotencyKey(runId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{7,63}$/u.test(runId)) {
    throw new Error("PAID_E2E_RUN_ID_INVALID");
  }
  return `fable007-paid-${runId}`;
}

function assertRunAuthorization(
  options: CliOptions,
  requiredAbsoluteBudgetFen: number,
  tosFingerprint: string,
): void {
  if (options.mode !== "run" || !options.confirmPaid) {
    throw new Error("PAID_E2E_CONFIRMATION_REQUIRED");
  }
  if (!settings.allowPaidGeneration) throw new Error("PAID_E2E_PAID_GATE_DISABLED");
  if (effectivePaidBudgetFen() !== requiredAbsoluteBudgetFen) {
    throw new Error("PAID_E2E_ABSOLUTE_BUDGET_MISMATCH");
  }
  const approved = approvedTosFingerprint();
  if (!approved || !safeHashEqual(approved, tosFingerprint)) {
    throw new Error("PAID_E2E_TOS_TARGET_NOT_APPROVED");
  }
  if (!settings.allowMemberCreateProject) {
    throw new Error("PAID_E2E_MEMBER_PROJECT_CREATION_DISABLED");
  }
}

function assertCheapestArkImageTier(
  tier: {
    tierId: string;
    mediaType: string;
    price: { unit: string; points: number };
    params: Record<string, string | number | boolean>;
  } | undefined,
): void {
  if (!tier) throw new Error("PAID_E2E_ARK_IMAGE_TIER_MISSING");
  if (
    tier.mediaType !== "image"
    || tier.price.unit !== "per_image"
    || tier.price.points !== 30
    || tier.params.aspect_ratio !== "16:9"
    || tier.params.resolution !== "1K"
    || tier.params.watermark !== false
    || tier.params.quantity !== 1
  ) {
    throw new Error("PAID_E2E_ARK_IMAGE_TIER_DRIFT");
  }
}

async function reservedCostFen(db: Database): Promise<number> {
  const row = (await db.select({
    total: sql<number>`coalesce(sum(${generationAttempts.estimatedCostFen}), 0)::integer`,
  }).from(generationAttempts))[0];
  const total = Number(row?.total ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("PAID_E2E_RESERVED_COST_INVALID");
  return total;
}

async function claimExactFreshAttempt(
  db: Database,
  attemptId: string,
  workerId: string,
): Promise<boolean> {
  const claimed = await db.update(generationAttempts).set({
    leaseOwner: workerId,
    leaseUntil: sql`now() + (${LEASE_SECONDS} * interval '1 second')`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(generationAttempts.id, attemptId),
    eq(generationAttempts.status, "pending"),
    eq(generationAttempts.phase, "created"),
    isNull(generationAttempts.leaseOwner),
  )).returning({ id: generationAttempts.id });
  return claimed.length === 1;
}

async function readDurableAudit(db: Database, attemptId: string): Promise<{
  artifact: Record<string, unknown>;
  tos: Record<string, unknown>;
  providerCost: Record<string, unknown>;
}> {
  const attempt = (await db.select({
    status: generationAttempts.status,
    phase: generationAttempts.phase,
    estimatedCostFen: generationAttempts.estimatedCostFen,
    actualCostFen: generationAttempts.actualCostFen,
    actualCostStatus: generationAttempts.actualCostStatus,
  }).from(generationAttempts).where(eq(generationAttempts.id, attemptId)).limit(1))[0];
  if (
    !attempt
    || attempt.status !== "succeeded"
    || attempt.phase !== "complete"
    || attempt.estimatedCostFen !== INCREMENTAL_BUDGET_FEN
  ) throw new Error("PAID_E2E_ATTEMPT_AUDIT_FAILED");

  const rows = await db.select({
    id: mediaResults.id,
    mediaKind: mediaResults.mediaKind,
    persistenceStatus: mediaResults.persistenceStatus,
    storageBucket: mediaResults.storageBucket,
    storagePath: mediaResults.storagePath,
    storageUrl: mediaResults.storageUrl,
    sha256: mediaResults.sha256,
    mimeType: mediaResults.mimeType,
    complianceMetadata: mediaResults.complianceMetadata,
  }).from(mediaResults).where(eq(mediaResults.attemptId, attemptId));
  if (rows.length !== 1) throw new Error("PAID_E2E_MEDIA_AUDIT_COUNT_INVALID");
  const media = rows[0]!;
  const metadata = media.complianceMetadata ?? {};
  if (
    media.mediaKind !== "image"
    || media.persistenceStatus !== "persisted"
    || !media.storageBucket
    || !media.storagePath
    || !media.storageUrl?.startsWith("https://")
    || !/^[0-9a-f]{64}$/.test(media.sha256 ?? "")
    || media.mimeType !== "image/jpeg"
    || metadata.aigcMetadataEnabled !== true
    || metadata.aigcMetadataEvidence !== "platform_applied"
    || typeof metadata.contentId !== "string"
  ) throw new Error("PAID_E2E_MEDIA_AUDIT_FAILED");

  const tosRows = await db.select({
    mediaResultId: generationTosOrphans.mediaResultId,
    cleanupStatus: generationTosOrphans.cleanupStatus,
    objectKey: generationTosOrphans.objectKey,
  }).from(generationTosOrphans).where(eq(generationTosOrphans.attemptId, attemptId));
  if (
    tosRows.length !== 1
    || tosRows[0]!.mediaResultId !== media.id
    || tosRows[0]!.cleanupStatus !== "referenced"
    || !tosRows[0]!.objectKey
  ) throw new Error("PAID_E2E_TOS_RECEIPT_AUDIT_FAILED");

  const cost = (await db.select({
    calculationStatus: providerCosts.calculationStatus,
    usageSource: providerCosts.usageSource,
    usageQuantity: providerCosts.usageQuantity,
    costFenRounded: providerCosts.costFenRounded,
    requiresAttention: providerCosts.requiresAttention,
  }).from(providerCosts).where(eq(providerCosts.generationAttemptId, attemptId)).limit(1))[0];

  return {
    artifact: {
      mediaKind: "image",
      mimeType: media.mimeType,
      persistenceStatus: "persisted",
      sha256: media.sha256,
      platformAigcReadbackEvidence: "platform_applied",
      storageUrlHttps: true,
    },
    tos: {
      uploadReceiptRecorded: true,
      associationEvidence: "upload_receipt_plus_postgres_media_reference",
      remoteObjectReadbackPerformed: false,
      cleanupStatus: "referenced",
      objectKeyFingerprint: sha256(tosRows[0]!.objectKey).slice(0, 16),
    },
    providerCost: cost ? {
      status: cost.calculationStatus,
      usageSource: cost.usageSource,
      usageQuantity: cost.usageQuantity,
      costFenRounded: cost.costFenRounded,
      requiresAttention: cost.requiresAttention,
      attemptProjectionStatus: attempt.actualCostStatus,
      attemptProjectionFen: attempt.actualCostFen,
    } : {
      status: "missing",
      attemptProjectionStatus: attempt.actualCostStatus,
      attemptProjectionFen: attempt.actualCostFen,
    },
  };
}

function currentTosTargetFingerprint(): string {
  const bucket = settings.tosBucket?.trim();
  const sdkEndpointHost = normalizeTosSdkEndpoint(settings.tosEndpoint ?? "");
  const endpoint = safeHttpsUrl(
    sdkEndpointHost ? `https://${sdkEndpointHost}` : undefined,
    "PAID_E2E_TOS_ENDPOINT_INVALID",
  );
  const publicBase = safeHttpsUrl(settings.tosPublicBaseUrl, "PAID_E2E_TOS_PUBLIC_BASE_INVALID");
  if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,126}[a-z0-9]$/.test(bucket)) {
    throw new Error("PAID_E2E_TOS_BUCKET_INVALID");
  }
  return sha256([
    bucket,
    endpoint.origin.toLowerCase(),
    publicBase.origin.toLowerCase(),
    publicBase.pathname.replace(/\/+$/, ""),
  ].join("|"));
}

function approvedTosFingerprint(): string | undefined {
  const value = process.env.FABLE007_DEV_TOS_TARGET_SHA256?.trim().toLowerCase();
  return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function safeHttpsUrl(value: string | undefined, code: string): URL {
  try {
    const url = new URL(value ?? "");
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(code);
    return url;
  } catch {
    throw new Error(code);
  }
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "UNKNOWN";
}

function safeFailure(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : "";
  const databaseDiagnostic = safeDatabaseDiagnostic(error);
  return {
    name: "FABLE007_PAID_E2E_FAILED",
    stage: activeStage,
    ...(activeRunFingerprint ? { runFingerprint: activeRunFingerprint } : {}),
    ...(activeAttemptFingerprint ? { attemptFingerprint: activeAttemptFingerprint } : {}),
    ...(error instanceof AppError
      ? { code: error.code }
      : /^PAID_E2E_[A-Z0-9_]+$/.test(message)
        ? { code: message }
        : { code: "PAID_E2E_INTERNAL" }),
    ...(databaseDiagnostic ? { databaseDiagnostic } : {}),
  };
}

function safeDatabaseDiagnostic(error: unknown): Record<string, string> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const code = typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code)
    ? value.code
    : undefined;
  if (!code) return undefined;
  const safeIdentifier = (item: unknown) => (
    typeof item === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(item) ? item : undefined
  );
  return {
    code,
    ...(safeIdentifier(value.table) ? { table: safeIdentifier(value.table)! } : {}),
    ...(safeIdentifier(value.column) ? { column: safeIdentifier(value.column)! } : {}),
    ...(safeIdentifier(value.constraint) ? { constraint: safeIdentifier(value.constraint)! } : {}),
    ...(safeIdentifier(value.routine) ? { routine: safeIdentifier(value.routine)! } : {}),
  };
}

const isDirectRun = process.argv[1]?.endsWith("fable007-paid-e2e.mts")
  || process.argv[1]?.endsWith("fable007-paid-e2e");
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeFailure(error) })}\n`);
    process.exitCode = 1;
  });
}
