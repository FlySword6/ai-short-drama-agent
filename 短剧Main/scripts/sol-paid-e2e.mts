#!/usr/bin/env node
/**
 * Ark-only paid E2E for the shared test data plane.
 *
 * Safety contract:
 * - the configured, fingerprinted development/test database is the only target;
 * - image, video and audio use fixed cheapest reviewed Ark-family tiers;
 * - a stable run id anchors every fixture and idempotency key;
 * - each provider submission can happen only from this run's exact `created`
 *   attempt while this process owns its live lease;
 * - `submitting` / unknown outcome is never resubmitted;
 * - persistence failures stop after the first observed failure so a root cause
 *   can be repaired before the existing provider result is resumed;
 * - stdout contains only fingerprints, counts, prices and safe status fields.
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import {
  createDatabase,
  type Database,
  type DatabaseHandle,
} from "../src/db/client.js";
import { quoteIdentifier } from "../src/db/migrate.js";
import {
  audioVersions,
  costEntries,
  generationAttempts,
  generationQuotes,
  generationRequests,
  generationTosOrphans,
  mediaResults,
  providerCosts,
  userCreditAccounts,
  userCreditDailyUsage,
  userCreditLedgerEntries,
} from "../src/db/schema.js";
import { normalizeTosSdkEndpoint } from "../src/integrations/tosStorage.js";
import {
  normalizeCompanyProviderAllowlist,
} from "../src/shared/companyProviderPolicy.js";
import { AppError } from "../src/shared/errors.js";
import {
  createGenerationRepository,
  createGenerationService,
  effectivePaidBudgetFen,
  workerDependenciesReady,
} from "../src/modules/generation/factory.js";
import type { PostgresGenerationRepository } from "../src/modules/generation/repository.js";
import {
  normalizeGenerationInput,
  type GenerationService,
} from "../src/modules/generation/service.js";
import type {
  ScopedGenerationActor,
  GenerationMediaKind,
  GenerationParameters,
  SubmitGenerationInput,
} from "../src/modules/generation/types.js";
import {
  assertApprovedCredential,
  assertFable007DeploymentIdentity,
} from "./fable007-provider-smoke.mjs";

const require = createRequire(import.meta.url);

const TOTAL_INCREMENTAL_BUDGET_FEN = 139;
const FIXTURE_BALANCE_POINTS = 5_000;
const FIXTURE_DAILY_LIMIT_POINTS = 5_000;
const LEASE_SECONDS = 180;
const LEASE_RENEW_INTERVAL_MS = 45_000;
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_MAX_POLLS = 90;
const OTHER_MAX_STEPS = 4;
const MAX_TOS_READBACK_BYTES = 256 * 1024 * 1024;
const REQUIRED_GENERATION_MIGRATION = "045_script_breakdown_enrichment.sql";
const REQUIRED_GENERATION_COLUMNS = [
  ["shots", "breakdown_elements"],
] as const;

const CASES = [
  {
    mediaKind: "image",
    tierId: "img-seedream5pro-169-1k-1",
    model: "doubao-seedream-5-0-pro-260628",
    provider: "ark",
    estimatedCostFen: 30,
    prompt: "一盏暖色纸灯置于深蓝桌面，极简产品摄影，无文字，无人物。",
    parameters: {
      size: "1K",
      ratio: "16:9",
      watermark: false,
      sequentialImageGeneration: "disabled",
    },
  },
  {
    mediaKind: "audio",
    tierId: "aud-seedaudio10-3s",
    model: "seed-audio-1.0",
    provider: "openspeech",
    estimatedCostFen: 9,
    prompt: "今天天气很好。",
    parameters: {
      originalDurationSeconds: 3,
      format: "mp3",
      sampleRate: 48_000,
      enableSubtitle: true,
      aigcMetadataEnabled: true,
      aigcWatermarkEnabled: false,
    },
  },
  {
    mediaKind: "video",
    tierId: "vid-seedance20mini-169-480p",
    model: "doubao-seedance-2-0-mini-260615",
    provider: "ark",
    estimatedCostFen: 100,
    prompt: "固定镜头，一盏暖色纸灯置于深蓝桌面，柔和光线，无文字，无人物。",
    parameters: {
      resolution: "480p",
      ratio: "16:9",
      durationSeconds: 4,
      watermark: false,
      // The promoted tier normalizes omitted values to these exact defaults.
      generateAudio: true,
    },
  },
] as const satisfies ReadonlyArray<{
  mediaKind: GenerationMediaKind;
  tierId: string;
  model: string;
  provider: "ark" | "openspeech";
  estimatedCostFen: number;
  prompt: string;
  parameters: GenerationParameters;
}>;

type PaidCase = typeof CASES[number];
type PaidMediaKind = PaidCase["mediaKind"];

export interface SolPaidE2eCliOptions {
  mode: "preflight" | "run";
  target: "test";
  incrementalBudgetFen: 139;
  confirmPaid: boolean;
  runId?: string;
}

interface Fixture {
  userId: string;
  projectId: string;
  episodeId: string;
  assetId: string;
  shotIds: Record<PaidMediaKind, string>;
}

interface AttemptAnchor {
  requestId: string;
  attemptId: string;
  quoteId: string;
  status: string;
  phase: string;
  errorCode: string | null;
}

interface ArtifactAudit {
  mediaKind: PaidMediaKind;
  requestFingerprint: string;
  attemptFingerprint: string;
  quoteFingerprint: string;
  status: "succeeded";
  phase: "complete";
  chargedPoints: number;
  priceSnapshotFrozen: true;
  ledgerEntry: true;
  costEntry: true;
  media: {
    persistenceStatus: "persisted";
    mimeType: string;
    sha256: string;
    platformAigcReadbackEvidence: "platform_applied";
  };
  tos: {
    uploadReceiptRecorded: true;
    cleanupStatus: "referenced";
    remoteHeadReadback: true;
    remoteGetReadback: true;
    remoteBytesPositive: true;
    remoteSha256Matched: true;
    objectKeyFingerprint: string;
  };
  providerCost: {
    status: string;
    requiresAttention: boolean;
  };
}

interface SafeAttemptResult {
  audit: ArtifactAudit;
  providerSubmissionsByThisProcess: number;
  pollCount: number;
}

let activeStage = "bootstrap";
let activeRunFingerprint: string | undefined;
let activeAttemptFingerprint: string | undefined;

async function main(): Promise<void> {
  const options = parseSolPaidE2eArgs(process.argv.slice(2));
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  activeStage = "identity_preflight";
  assertTestRuntimeIdentity();
  assertArkOnlyProviderPolicy();
  assertApprovedCredential(
    settings.arkApiKey,
    settings.fable007DevArkCredentialSha256,
    "ARK_API_KEY",
  );
  assertApprovedCredential(
    settings.seedAudioApiKey,
    settings.fable007DevSeedAudioCredentialSha256,
    "SEED_AUDIO_API_KEY",
  );
  for (const item of CASES) {
    if (!workerDependenciesReady(settings, item.mediaKind)) {
      throw new Error(`SOL_PAID_E2E_${item.mediaKind.toUpperCase()}_WORKER_NOT_READY`);
    }
  }

  const databaseHandle = createDatabase();
  try {
    const repository = createGenerationRepository(databaseHandle.db);
    activeStage = "database_preflight";
    const schemaEvidence = await assertRequiredGenerationSchema(databaseHandle);
    const tierEvidence = await assertReviewedCheapestTiers(repository);
    const legacyEvidence = await verifyLegacySnapshotReadCompatibility(
      databaseHandle.db,
      repository,
    );
    const tosEvidence = await assertTestTosAnchor(databaseHandle.db);
    const reservedFen = await reservedCostFen(databaseHandle.db);
    const requiredAbsoluteBudgetFen = reservedFen + TOTAL_INCREMENTAL_BUDGET_FEN;

    if (options.mode === "preflight") {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        mode: "preflight",
        target: "test",
        incrementalBudgetFen: TOTAL_INCREMENTAL_BUDGET_FEN,
        reservedCostFen: reservedFen,
        requiredAbsoluteBudgetFen,
        schema: schemaEvidence,
        tiers: tierEvidence,
        legacyPriceSnapshot: legacyEvidence,
        tos: tosEvidence,
        workerReady: { image: true, video: true, audio: true },
        providerCalls: 0,
        externalWrites: 0,
      })}\n`);
      return;
    }

    activeRunFingerprint = sha256(options.runId!).slice(0, 16);
    const existing = await existingAttemptKinds(databaseHandle.db, options.runId!);
    const additionalReservedFen = CASES
      .filter((item) => !existing.has(item.mediaKind))
      .reduce((total, item) => total + item.estimatedCostFen, 0);
    assertRunAuthorization(options, reservedFen, additionalReservedFen);
    activeStage = "fixture";
    const fixture = await ensureFixture(databaseHandle, options.runId!);

    const service = createGenerationService(repository, {
      costAlertLogger: { warn: () => undefined },
    });
    const actor: ScopedGenerationActor = {
      userId: fixture.userId,
      authorizedProjectId: fixture.projectId,
    };
    const results: SafeAttemptResult[] = [];
    for (const item of CASES) {
      activeStage = `${item.mediaKind}_run`;
      results.push(await runOrResumeCase({
        databaseHandle,
        repository,
        service,
        actor,
        fixture,
        item,
        runId: options.runId!,
      }));
    }

    activeStage = "suite_reconciliation";
    const reconciliation = await reconcileSuite(
      databaseHandle.db,
      fixture.userId,
      results.map((item) => item.audit),
    );
    activeStage = "complete";
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: "run",
      target: "test",
      runFingerprint: activeRunFingerprint,
      budget: {
        incrementalAuthorizedFen: TOTAL_INCREMENTAL_BUDGET_FEN,
        chargedPoints: reconciliation.chargedPoints,
      },
      generations: results.map((item) => ({
        ...item.audit,
        providerSubmissionsByThisProcess: item.providerSubmissionsByThisProcess,
        pollCount: item.pollCount,
      })),
      reconciliation,
      providerPolicy: {
        companyAccount: "ark",
        directProviders: ["ark", "openspeech"],
        minimaxRealCalls: 0,
        newapiRealCalls: 0,
      },
    })}\n`);
  } finally {
    await databaseHandle.pool.end();
  }
}

async function assertRequiredGenerationSchema(
  databaseHandle: DatabaseHandle,
): Promise<{
  requiredMigration: string;
  requiredColumns: number;
}> {
  const migration = await databaseHandle.pool.query<{ applied: boolean }>(
    `select exists(
       select 1
       from ${quoteIdentifier(settings.postgresSchema)}.schema_migrations
       where version = $1
     ) as applied`,
    [REQUIRED_GENERATION_MIGRATION],
  );
  if (migration.rows[0]?.applied !== true) {
    throw new Error("SOL_PAID_E2E_REQUIRED_MIGRATION_MISSING");
  }

  const columns = await databaseHandle.pool.query<{
    table_name: string;
    column_name: string;
  }>(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = $1
        and (table_name, column_name) in (
          select required.table_name, required.column_name
          from unnest($2::text[], $3::text[]) as required(table_name, column_name)
        )`,
    [
      settings.postgresSchema,
      REQUIRED_GENERATION_COLUMNS.map(([tableName]) => tableName),
      REQUIRED_GENERATION_COLUMNS.map(([, columnName]) => columnName),
    ],
  );
  const present = new Set(
    columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  if (REQUIRED_GENERATION_COLUMNS.some(
    ([tableName, columnName]) => !present.has(`${tableName}.${columnName}`),
  )) {
    throw new Error("SOL_PAID_E2E_REQUIRED_SCHEMA_COLUMN_MISSING");
  }
  return {
    requiredMigration: REQUIRED_GENERATION_MIGRATION,
    requiredColumns: REQUIRED_GENERATION_COLUMNS.length,
  };
}

function assertTestRuntimeIdentity(): void {
  assertFable007DeploymentIdentity({
    databaseUrl: settings.databaseUrl,
    expectedSha256: settings.pricingSeedDevDatabaseIdentitySha256,
    appEnvironment: settings.appEnvironment,
  });
  if (settings.postgresSchema !== "app") {
    throw new Error("SOL_PAID_E2E_SCHEMA_MUST_BE_APP");
  }
}

function assertArkOnlyProviderPolicy(): void {
  const allowlist = [...normalizeCompanyProviderAllowlist(
    settings.companyProviderAllowlist,
  )].sort();
  if (allowlist.length !== 1 || allowlist[0] !== "ark") {
    throw new Error("SOL_PAID_E2E_PROVIDER_ALLOWLIST_MUST_BE_ARK_ONLY");
  }
  if (settings.newapiGenerationEnabled) {
    throw new Error("SOL_PAID_E2E_NEWAPI_MUST_REMAIN_DISABLED");
  }
}

async function assertReviewedCheapestTiers(
  repository: PostgresGenerationRepository,
): Promise<Array<{
  mediaKind: PaidMediaKind;
  tierId: string;
  provider: string;
  points: number;
}>> {
  const evidence = [];
  for (const item of CASES) {
    const tiers = await repository.listActiveTiers(item.mediaKind);
    const tier = tiers.find((candidate) => candidate.tierId === item.tierId);
    if (!tier
      || tier.rule.provider !== item.provider
      || tier.rule.model !== item.model
      || tier.rule.unitPriceFen * billableUnits(item, tier.parameters) !== item.estimatedCostFen) {
      throw new Error(`SOL_PAID_E2E_${item.mediaKind.toUpperCase()}_TIER_DRIFT`);
    }
    const cheaper = tiers.filter((candidate) => (
      candidate.rule.provider === item.provider
      && candidate.rule.unitPriceFen * billableUnits(item, candidate.parameters)
        < item.estimatedCostFen
    ));
    if (cheaper.length > 0) {
      throw new Error(`SOL_PAID_E2E_${item.mediaKind.toUpperCase()}_TIER_NOT_CHEAPEST`);
    }
    evidence.push({
      mediaKind: item.mediaKind,
      tierId: item.tierId,
      provider: item.provider,
      points: item.estimatedCostFen,
    });
  }
  return evidence;
}

function billableUnits(
  item: PaidCase,
  parameters: GenerationParameters,
): number {
  if (item.mediaKind === "image") return 1;
  if (item.mediaKind === "video") return Number(parameters.durationSeconds ?? 0);
  return Number(parameters.originalDurationSeconds ?? 0);
}

async function verifyLegacySnapshotReadCompatibility(
  db: Database,
  repository: PostgresGenerationRepository,
): Promise<{ emptyRowsObserved: number; sampledReads: number; sentinelTierId: string }> {
  const rows = await db.select({ id: generationAttempts.id })
    .from(generationAttempts)
    .where(sql`${generationAttempts.priceSnapshot} = '{}'::jsonb`)
    .limit(20);
  for (const row of rows) {
    const view = await repository.findViewByAttemptId(row.id);
    if (!view || view.tierId !== "legacy-unpriced") {
      throw new Error("SOL_PAID_E2E_LEGACY_PRICE_SNAPSHOT_READ_FAILED");
    }
  }
  const countRow = (await db.select({
    count: sql<number>`count(*)::integer`,
  }).from(generationAttempts)
    .where(sql`${generationAttempts.priceSnapshot} = '{}'::jsonb`))[0];
  return {
    emptyRowsObserved: Number(countRow?.count ?? 0),
    sampledReads: rows.length,
    sentinelTierId: "legacy-unpriced",
  };
}

async function assertTestTosAnchor(
  db: Database,
): Promise<{
  targetFingerprint: string;
  existingPersistedAnchors: number;
}> {
  const bucket = settings.tosBucket?.trim();
  const endpoint = normalizeTosSdkEndpoint(settings.tosEndpoint ?? "");
  const publicBase = safeHttpsUrl(
    settings.tosPublicBaseUrl,
    "SOL_PAID_E2E_TOS_PUBLIC_BASE_INVALID",
  );
  if (!bucket || !endpoint || !settings.tosAccessKey || !settings.tosSecretKey) {
    throw new Error("SOL_PAID_E2E_TOS_CONFIGURATION_INCOMPLETE");
  }
  const anchors = await db.select({ count: sql<number>`count(*)::integer` })
    .from(mediaResults)
    .where(and(
      eq(mediaResults.persistenceStatus, "persisted"),
      eq(mediaResults.storageBucket, bucket),
      sql`${mediaResults.storageUrl} like ${`${publicBase.toString().replace(/\/+$/, "")}/%`}`,
    ));
  const count = Number(anchors[0]?.count ?? 0);
  if (count < 1) throw new Error("SOL_PAID_E2E_TEST_TOS_ANCHOR_MISSING");
  return {
    targetFingerprint: sha256([
      bucket,
      endpoint.toLowerCase(),
      publicBase.origin.toLowerCase(),
      publicBase.pathname.replace(/\/+$/, ""),
    ].join("|")).slice(0, 16),
    existingPersistedAnchors: count,
  };
}

function assertRunAuthorization(
  options: SolPaidE2eCliOptions,
  reservedFen: number,
  additionalReservedFen: number,
): void {
  if (options.mode !== "run" || !options.confirmPaid) {
    throw new Error("SOL_PAID_E2E_CONFIRMATION_REQUIRED");
  }
  if (!settings.allowPaidGeneration) {
    throw new Error("SOL_PAID_E2E_PAID_GATE_DISABLED");
  }
  const expectedAbsoluteBudgetFen = reservedFen + additionalReservedFen;
  if (effectivePaidBudgetFen() !== expectedAbsoluteBudgetFen) {
    throw new Error("SOL_PAID_E2E_ABSOLUTE_BUDGET_MISMATCH");
  }
}

async function runOrResumeCase(input: {
  databaseHandle: DatabaseHandle;
  repository: PostgresGenerationRepository;
  service: GenerationService;
  actor: ScopedGenerationActor;
  fixture: Fixture;
  item: PaidCase;
  runId: string;
}): Promise<SafeAttemptResult> {
  const idempotencyKey = paidIdempotencyKey(input.runId, input.item.mediaKind);
  let anchor = await findAttemptAnchor(
    input.databaseHandle.db,
    idempotencyKey,
    input.item,
  );
  let providerSubmissionsByThisProcess = 0;

  if (!anchor) {
    const generationInput = generationInputFor(input.fixture, input.item, idempotencyKey);
    activeStage = `${input.item.mediaKind}_normalize`;
    normalizeGenerationInput(generationInput);
    activeStage = `${input.item.mediaKind}_quote`;
    const quote = await input.service.quoteSubmission(input.actor, generationInput, "web");
    activeStage = `${input.item.mediaKind}_quote_validate`;
    if (quote.status !== "pending_confirmation") {
      throw new Error("SOL_PAID_E2E_QUOTE_STATUS_DRIFT");
    }
    if (quote.priceSnapshot.tierId !== input.item.tierId) {
      throw new Error("SOL_PAID_E2E_QUOTE_TIER_DRIFT");
    }
    if (quote.priceSnapshot.provider !== input.item.provider) {
      throw new Error("SOL_PAID_E2E_QUOTE_PROVIDER_DRIFT");
    }
    if (quote.priceSnapshot.model !== input.item.model) {
      throw new Error("SOL_PAID_E2E_QUOTE_MODEL_DRIFT");
    }
    if (quote.estimatedCostFen !== input.item.estimatedCostFen) {
      throw new Error("SOL_PAID_E2E_QUOTE_COST_DRIFT");
    }

    activeStage = `${input.item.mediaKind}_confirm`;
    const confirmed = await input.service.confirmQuote(input.actor, quote.id);
    activeStage = `${input.item.mediaKind}_confirm_validate`;
    if (confirmed.status !== "confirmed") {
      throw new Error("SOL_PAID_E2E_CONFIRM_STATUS_DRIFT");
    }
    if (confirmed.confirmedByUserId !== input.fixture.userId) {
      throw new Error("SOL_PAID_E2E_CONFIRM_ACTOR_DRIFT");
    }

    activeStage = `${input.item.mediaKind}_submit`;
    const submitted = await input.service.submit(
      input.actor,
      generationInput,
      quote.id,
      "web",
    );
    activeStage = `${input.item.mediaKind}_submit_validate`;
    if (submitted.status !== "pending") {
      throw new Error("SOL_PAID_E2E_SUBMIT_STATUS_DRIFT");
    }
    if (submitted.phase !== "created") {
      throw new Error("SOL_PAID_E2E_SUBMIT_PHASE_DRIFT");
    }
    anchor = await findAttemptAnchor(
      input.databaseHandle.db,
      idempotencyKey,
      input.item,
    );
    if (!anchor) throw new Error("SOL_PAID_E2E_ATTEMPT_ANCHOR_MISSING");
  }

  activeAttemptFingerprint = sha256(anchor.attemptId).slice(0, 16);
  const initialAction = paidAttemptAction(anchor);
  if (initialAction === "terminal_failure"
    || initialAction === "submission_outcome_unknown"
    || initialAction === "unsafe") {
    throw new Error(`SOL_PAID_E2E_${initialAction.toUpperCase()}`);
  }

  let pollCount = 0;
  if (initialAction !== "audit_success") {
    const workerId = `sol-paid-e2e-${input.item.mediaKind}-${randomUUID()}`;
    activeStage = `${input.item.mediaKind}_claim`;
    const claimed = await claimExactAttempt(
      input.databaseHandle.db,
      anchor,
      workerId,
    );
    if (!claimed) {
      throw new Error("SOL_PAID_E2E_EXACT_ATTEMPT_NOT_CLAIMED");
    }
    const heartbeat = startLeaseHeartbeat(
      input.repository,
      anchor.attemptId,
      workerId,
    );
    try {
      const maxSteps = input.item.mediaKind === "video" ? VIDEO_MAX_POLLS + 2 : OTHER_MAX_STEPS;
      for (let step = 0; step < maxSteps; step += 1) {
        const before = await input.service.get(input.actor, anchor.requestId);
        if (before.status === "succeeded" && before.phase === "complete") break;
        if (before.phase === "submitting" || before.errorCode === "SUBMISSION_OUTCOME_UNKNOWN") {
          throw new Error("SOL_PAID_E2E_SUBMISSION_OUTCOME_UNKNOWN");
        }
        if (before.status === "failed" || before.status === "cancelled") {
          throw new Error("SOL_PAID_E2E_TERMINAL_FAILURE");
        }
        if (before.errorCode === "PERSISTENCE_FAILED") {
          throw new Error("SOL_PAID_E2E_PERSISTENCE_ROOT_CAUSE_REQUIRED");
        }
        if (before.phase === "created") providerSubmissionsByThisProcess += 1;

        activeStage = `${input.item.mediaKind}_resume`;
        const after = await input.service.runRecoverableAttempt(
          anchor.attemptId,
          heartbeat.signal,
          workerId,
        );
        if (after.status === "succeeded" && after.phase === "complete") break;
        if (after.phase === "submitting" || after.errorCode === "SUBMISSION_OUTCOME_UNKNOWN") {
          throw new Error("SOL_PAID_E2E_SUBMISSION_OUTCOME_UNKNOWN");
        }
        if (after.status === "failed" || after.status === "cancelled") {
          throw new Error("SOL_PAID_E2E_TERMINAL_FAILURE");
        }
        if (after.errorCode === "PERSISTENCE_FAILED") {
          throw new Error("SOL_PAID_E2E_PERSISTENCE_ROOT_CAUSE_REQUIRED");
        }
        if (after.phase === "provider_queued" || after.phase === "provider_running") {
          pollCount += 1;
          await delay(VIDEO_POLL_INTERVAL_MS);
        }
      }
    } finally {
      const leaseHealthy = await heartbeat.stop();
      await input.repository.releaseLease(anchor.attemptId, workerId);
      const view = await input.service.get(input.actor, anchor.requestId);
      if (!leaseHealthy && !(view.status === "succeeded" && view.phase === "complete")) {
        throw new Error("SOL_PAID_E2E_LEASE_LOST");
      }
    }
  }

  activeStage = `${input.item.mediaKind}_readback`;
  const finalView = await input.service.get(input.actor, anchor.requestId);
  if (finalView.status !== "succeeded" || finalView.phase !== "complete") {
    throw new Error("SOL_PAID_E2E_NOT_TERMINAL_SUCCESS");
  }
  activeStage = `${input.item.mediaKind}_audit`;
  const audit = await readArtifactAudit(
    input.databaseHandle.db,
    anchor,
    input.item,
  );
  return { audit, providerSubmissionsByThisProcess, pollCount };
}

function generationInputFor(
  fixture: Fixture,
  item: PaidCase,
  clientIdempotencyKey: string,
): SubmitGenerationInput {
  return {
    projectId: fixture.projectId,
    episodeId: fixture.episodeId,
    shotId: fixture.shotIds[item.mediaKind],
    ...(item.mediaKind === "image" ? { targetAssetEntityId: fixture.assetId } : {}),
    mediaKind: item.mediaKind,
    tierId: item.tierId,
    model: item.model,
    prompt: item.prompt,
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    parameters: { ...item.parameters },
    quantity: 1,
    productionMode: "full",
    clientIdempotencyKey,
  };
}

async function findAttemptAnchor(
  db: Database,
  idempotencyKey: string,
  item: PaidCase,
): Promise<AttemptAnchor | null> {
  const rows = await db.select({
    requestId: generationRequests.id,
    attemptId: generationAttempts.id,
    quoteId: generationQuotes.id,
    mediaKind: generationRequests.mediaKind,
    prompt: generationRequests.prompt,
    provider: generationAttempts.provider,
    model: generationAttempts.model,
    status: generationAttempts.status,
    phase: generationAttempts.phase,
    errorCode: generationAttempts.errorCode,
    attemptNo: generationAttempts.attemptNo,
    estimatedCostFen: generationAttempts.estimatedCostFen,
    priceSnapshot: generationAttempts.priceSnapshot,
  }).from(generationRequests)
    .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
    .innerJoin(generationQuotes, and(
      eq(generationQuotes.generationRequestId, generationRequests.id),
      eq(generationQuotes.generationAttemptId, generationAttempts.id),
      eq(generationQuotes.status, "consumed"),
    ))
    .where(eq(generationRequests.clientIdempotencyKey, idempotencyKey))
    .limit(2);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("SOL_PAID_E2E_ATTEMPT_ANCHOR_NOT_UNIQUE");
  const row = rows[0]!;
  const snapshot = row.priceSnapshot;
  if (row.mediaKind !== item.mediaKind
    || row.prompt !== item.prompt
    || row.provider !== item.provider
    || row.model !== item.model
    || row.attemptNo !== 1
    || row.estimatedCostFen !== item.estimatedCostFen
    || snapshot.tierId !== item.tierId
    || snapshot.provider !== item.provider
    || snapshot.model !== item.model
    || snapshot.estimatedCostFen !== item.estimatedCostFen
    || snapshot.currency !== "CNY") {
    throw new Error("SOL_PAID_E2E_ATTEMPT_ANCHOR_DRIFT");
  }
  return {
    requestId: row.requestId,
    attemptId: row.attemptId,
    quoteId: row.quoteId,
    status: row.status,
    phase: row.phase,
    errorCode: row.errorCode,
  };
}

export function paidAttemptAction(input: {
  status: string;
  phase: string;
  errorCode?: string | null;
}): "audit_success" | "claim_and_resume" | "submission_outcome_unknown" | "terminal_failure" | "unsafe" {
  if (input.status === "succeeded" && input.phase === "complete") return "audit_success";
  if (input.phase === "submitting" || input.errorCode === "SUBMISSION_OUTCOME_UNKNOWN") {
    return "submission_outcome_unknown";
  }
  if (input.status === "failed" || input.status === "cancelled") return "terminal_failure";
  if ((input.status === "pending" || input.status === "running")
    && ["created", "provider_queued", "provider_running", "provider_succeeded", "persisting"]
      .includes(input.phase)) {
    return "claim_and_resume";
  }
  return "unsafe";
}

async function claimExactAttempt(
  db: Database,
  anchor: AttemptAnchor,
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
    or(
      isNull(generationAttempts.leaseUntil),
      sql`${generationAttempts.leaseUntil} <= now()`,
    ),
  )).returning({ id: generationAttempts.id });
  return claimed.length === 1;
}

function startLeaseHeartbeat(
  repository: PostgresGenerationRepository,
  attemptId: string,
  workerId: string,
): {
  signal: AbortSignal;
  stop(): Promise<boolean>;
} {
  const controller = new AbortController();
  let healthy = true;
  let inFlight: Promise<void> | undefined;
  const renew = (): void => {
    if (!healthy || inFlight) return;
    inFlight = repository.renewLease(attemptId, workerId, LEASE_SECONDS)
      .then((renewed) => {
        if (renewed) return;
        healthy = false;
        controller.abort();
      })
      .catch(() => {
        healthy = false;
        controller.abort();
      })
      .finally(() => { inFlight = undefined; });
  };
  const timer = setInterval(renew, LEASE_RENEW_INTERVAL_MS);
  timer.unref();
  return {
    signal: controller.signal,
    stop: async () => {
      clearInterval(timer);
      await inFlight;
      return healthy;
    },
  };
}

async function readArtifactAudit(
  db: Database,
  anchor: AttemptAnchor,
  item: PaidCase,
): Promise<ArtifactAudit> {
  const attempt = (await db.select({
    status: generationAttempts.status,
    phase: generationAttempts.phase,
    provider: generationAttempts.provider,
    model: generationAttempts.model,
    estimatedCostFen: generationAttempts.estimatedCostFen,
    priceSnapshot: generationAttempts.priceSnapshot,
    chargedPoints: generationRequests.chargedPoints,
    requestUserId: generationRequests.userId,
    quoteStatus: generationQuotes.status,
    quoteUserId: generationQuotes.userId,
    confirmedByUserId: generationQuotes.confirmedByUserId,
    consumedAt: generationQuotes.consumedAt,
    quoteRequestId: generationQuotes.generationRequestId,
    quoteAttemptId: generationQuotes.generationAttemptId,
  }).from(generationAttempts)
    .innerJoin(generationRequests, eq(generationRequests.id, generationAttempts.requestId))
    .innerJoin(generationQuotes, eq(generationQuotes.id, anchor.quoteId))
    .where(eq(generationAttempts.id, anchor.attemptId))
    .limit(1))[0];
  if (!attempt
    || attempt.status !== "succeeded"
    || attempt.phase !== "complete"
    || attempt.provider !== item.provider
    || attempt.model !== item.model
    || attempt.estimatedCostFen !== item.estimatedCostFen
    || attempt.chargedPoints !== item.estimatedCostFen
    || attempt.quoteStatus !== "consumed"
    || attempt.requestUserId !== attempt.quoteUserId
    || attempt.confirmedByUserId !== attempt.requestUserId
    || !attempt.consumedAt
    || attempt.quoteRequestId !== anchor.requestId
    || attempt.quoteAttemptId !== anchor.attemptId
    || attempt.priceSnapshot.tierId !== item.tierId
    || attempt.priceSnapshot.provider !== item.provider
    || attempt.priceSnapshot.model !== item.model
    || attempt.priceSnapshot.estimatedCostFen !== item.estimatedCostFen) {
    throw new Error("SOL_PAID_E2E_ATTEMPT_AUDIT_FAILED");
  }

  const ledger = await db.select({
    userId: userCreditLedgerEntries.userId,
    pointsDelta: userCreditLedgerEntries.pointsDelta,
    balanceAfterPoints: userCreditLedgerEntries.balanceAfterPoints,
    sourceType: userCreditLedgerEntries.sourceType,
    sourceId: userCreditLedgerEntries.sourceId,
    requestId: userCreditLedgerEntries.generationRequestId,
    actorId: userCreditLedgerEntries.actorUserId,
    metadata: userCreditLedgerEntries.metadata,
  }).from(userCreditLedgerEntries)
    .where(eq(userCreditLedgerEntries.sourceId, anchor.quoteId));
  if (ledger.length !== 1
    || ledger[0]!.userId !== attempt.requestUserId
    || ledger[0]!.pointsDelta !== -item.estimatedCostFen
    || ledger[0]!.balanceAfterPoints !== expectedBalanceAfterPoints(item.mediaKind)
    || ledger[0]!.sourceType !== "generation_quote"
    || ledger[0]!.requestId !== anchor.requestId
    || ledger[0]!.actorId !== attempt.requestUserId
    || ledger[0]!.metadata.estimated_cost_fen !== item.estimatedCostFen) {
    throw new Error("SOL_PAID_E2E_LEDGER_AUDIT_FAILED");
  }

  const costs = await db.select({
    kind: costEntries.kind,
    userId: costEntries.userId,
    projectId: costEntries.projectId,
    chargedPoints: costEntries.chargedPoints,
    isUnpriced: costEntries.isUnpriced,
    sourceTable: costEntries.sourceTable,
  }).from(costEntries).where(eq(costEntries.sourceId, anchor.requestId));
  if (costs.length !== 1
    || costs[0]!.kind !== "generation"
    || costs[0]!.userId !== attempt.requestUserId
    || !costs[0]!.projectId
    || costs[0]!.chargedPoints !== item.estimatedCostFen
    || costs[0]!.isUnpriced
    || costs[0]!.sourceTable !== "generation_requests") {
    throw new Error("SOL_PAID_E2E_COST_ENTRY_AUDIT_FAILED");
  }

  const media = await db.select({
    id: mediaResults.id,
    mediaKind: mediaResults.mediaKind,
    persistenceStatus: mediaResults.persistenceStatus,
    storageBucket: mediaResults.storageBucket,
    storagePath: mediaResults.storagePath,
    storageUrl: mediaResults.storageUrl,
    sha256: mediaResults.sha256,
    mimeType: mediaResults.mimeType,
    complianceMetadata: mediaResults.complianceMetadata,
  }).from(mediaResults).where(and(
    eq(mediaResults.attemptId, anchor.attemptId),
    isNull(mediaResults.deletedAt),
  ));
  if (media.length !== 1) throw new Error("SOL_PAID_E2E_MEDIA_COUNT_INVALID");
  const artifact = media[0]!;
  const metadata = artifact.complianceMetadata ?? {};
  if (artifact.mediaKind !== item.mediaKind
    || artifact.persistenceStatus !== "persisted"
    || artifact.storageBucket !== settings.tosBucket
    || !artifact.storagePath
    || !artifact.storageUrl
    || !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")
    || !validMimeType(item.mediaKind, artifact.mimeType)
    || metadata.aigcMetadataEnabled !== true
    || metadata.aigcMetadataEvidence !== "platform_applied"
    || typeof metadata.contentId !== "string") {
    throw new Error("SOL_PAID_E2E_MEDIA_AUDIT_FAILED");
  }

  const tos = await db.select({
    mediaResultId: generationTosOrphans.mediaResultId,
    cleanupStatus: generationTosOrphans.cleanupStatus,
    storageBucket: generationTosOrphans.storageBucket,
    objectKey: generationTosOrphans.objectKey,
  }).from(generationTosOrphans)
    .where(eq(generationTosOrphans.attemptId, anchor.attemptId));
  if (tos.length !== 1
    || tos[0]!.mediaResultId !== artifact.id
    || tos[0]!.cleanupStatus !== "referenced"
    || tos[0]!.storageBucket !== settings.tosBucket
    || tos[0]!.objectKey !== artifact.storagePath) {
    throw new Error("SOL_PAID_E2E_TOS_LEDGER_AUDIT_FAILED");
  }
  const remote = await readTosObject(tos[0]!.objectKey);
  if (!Number.isSafeInteger(remote.bytes)
    || remote.bytes <= 0
    || remote.contentType !== artifact.mimeType
    || remote.sha256 !== artifact.sha256) {
    throw new Error("SOL_PAID_E2E_TOS_REMOTE_READBACK_FAILED");
  }

  if (item.mediaKind === "audio") {
    const audio = await db.select({ mediaResultId: audioVersions.mediaResultId })
      .from(audioVersions)
      .where(eq(audioVersions.mediaResultId, artifact.id));
    if (audio.length !== 1) throw new Error("SOL_PAID_E2E_AUDIO_VERSION_AUDIT_FAILED");
  }

  const providerCostRows = await db.select({
    provider: providerCosts.provider,
    mediaKind: providerCosts.mediaKind,
    calculationStatus: providerCosts.calculationStatus,
    requiresAttention: providerCosts.requiresAttention,
  }).from(providerCosts)
    .where(eq(providerCosts.generationAttemptId, anchor.attemptId));
  if (providerCostRows.length !== 1
    || providerCostRows[0]!.provider !== item.provider
    || providerCostRows[0]!.mediaKind !== item.mediaKind) {
    throw new Error("SOL_PAID_E2E_PROVIDER_COST_AUDIT_FAILED");
  }
  const providerCost = providerCostRows[0]!;

  return {
    mediaKind: item.mediaKind,
    requestFingerprint: sha256(anchor.requestId).slice(0, 16),
    attemptFingerprint: sha256(anchor.attemptId).slice(0, 16),
    quoteFingerprint: sha256(anchor.quoteId).slice(0, 16),
    status: "succeeded",
    phase: "complete",
    chargedPoints: item.estimatedCostFen,
    priceSnapshotFrozen: true,
    ledgerEntry: true,
    costEntry: true,
    media: {
      persistenceStatus: "persisted",
      mimeType: artifact.mimeType!,
      sha256: artifact.sha256!,
      platformAigcReadbackEvidence: "platform_applied",
    },
    tos: {
      uploadReceiptRecorded: true,
      cleanupStatus: "referenced",
      remoteHeadReadback: true,
      remoteGetReadback: true,
      remoteBytesPositive: true,
      remoteSha256Matched: true,
      objectKeyFingerprint: sha256(tos[0]!.objectKey).slice(0, 16),
    },
    providerCost: {
      status: providerCost.calculationStatus,
      requiresAttention: providerCost.requiresAttention,
    },
  };
}

async function reconcileSuite(
  db: Database,
  userId: string,
  audits: readonly ArtifactAudit[],
): Promise<{
  chargedPoints: number;
  balanceDeltaPoints: number;
  dailyUsagePoints: number;
  ledgerEntries: number;
  costEntries: number;
  providerCostEntries: number;
  providerActualCostConfirmed: number;
  providerActualCostRequiresAttention: number;
  persistedArtifacts: number;
  allPlatformChargesPriced: true;
}> {
  const chargedPoints = audits.reduce((total, item) => total + item.chargedPoints, 0);
  if (chargedPoints !== TOTAL_INCREMENTAL_BUDGET_FEN) {
    throw new Error("SOL_PAID_E2E_TOTAL_CHARGE_DRIFT");
  }
  const account = (await db.select({
    balancePoints: userCreditAccounts.balancePoints,
    dailyLimitPoints: userCreditAccounts.dailyLimitPoints,
  }).from(userCreditAccounts).where(eq(userCreditAccounts.userId, userId)).limit(1))[0];
  if (!account
    || account.balancePoints !== FIXTURE_BALANCE_POINTS - chargedPoints
    || account.dailyLimitPoints !== FIXTURE_DAILY_LIMIT_POINTS) {
    throw new Error("SOL_PAID_E2E_ACCOUNT_RECONCILIATION_FAILED");
  }
  const usage = (await db.select({
    rows: sql<number>`count(*)::integer`,
    chargedPoints: sql<number>`coalesce(sum(${userCreditDailyUsage.chargedPoints}), 0)::integer`,
  }).from(userCreditDailyUsage).where(eq(userCreditDailyUsage.userId, userId)))[0];
  if (Number(usage?.rows ?? 0) !== 1
    || Number(usage?.chargedPoints ?? 0) !== chargedPoints) {
    throw new Error("SOL_PAID_E2E_DAILY_USAGE_RECONCILIATION_FAILED");
  }
  const ledger = (await db.select({
    count: sql<number>`count(*)::integer`,
    points: sql<number>`coalesce(sum(${userCreditLedgerEntries.pointsDelta}), 0)::integer`,
  }).from(userCreditLedgerEntries).where(and(
    eq(userCreditLedgerEntries.userId, userId),
    eq(userCreditLedgerEntries.entryKind, "generation_debit"),
  )))[0];
  if (Number(ledger?.count ?? 0) !== CASES.length
    || Number(ledger?.points ?? 0) !== -chargedPoints) {
    throw new Error("SOL_PAID_E2E_LEDGER_RECONCILIATION_FAILED");
  }
  const costs = (await db.select({
    count: sql<number>`count(*)::integer`,
    points: sql<number>`coalesce(sum(${costEntries.chargedPoints}), 0)::integer`,
    unpriced: sql<number>`count(*) filter (where ${costEntries.isUnpriced})::integer`,
  }).from(costEntries).where(and(
    eq(costEntries.userId, userId),
    eq(costEntries.kind, "generation"),
  )))[0];
  if (Number(costs?.count ?? 0) !== CASES.length
    || Number(costs?.points ?? 0) !== chargedPoints
    || Number(costs?.unpriced ?? 0) !== 0) {
    throw new Error("SOL_PAID_E2E_COST_ENTRY_RECONCILIATION_FAILED");
  }
  return {
    chargedPoints,
    balanceDeltaPoints: -chargedPoints,
    dailyUsagePoints: Number(usage!.chargedPoints),
    ledgerEntries: Number(ledger!.count),
    costEntries: Number(costs!.count),
    providerCostEntries: audits.length,
    providerActualCostConfirmed: audits.filter(
      (audit) => audit.providerCost.status === "confirmed"
        && !audit.providerCost.requiresAttention,
    ).length,
    providerActualCostRequiresAttention: audits.filter(
      (audit) => audit.providerCost.requiresAttention,
    ).length,
    persistedArtifacts: audits.length,
    allPlatformChargesPriced: true,
  };
}

async function readTosObject(
  objectKey: string,
): Promise<{ bytes: number; contentType: string | undefined; sha256: string }> {
  const moduleValue = require("@volcengine/tos-sdk") as {
    TosClient?: new (options: Record<string, unknown>) => {
      headObject(input: Record<string, unknown>): Promise<unknown>;
      getObjectV2(input: Record<string, unknown>): Promise<unknown>;
    };
    Client?: new (options: Record<string, unknown>) => {
      headObject(input: Record<string, unknown>): Promise<unknown>;
      getObjectV2(input: Record<string, unknown>): Promise<unknown>;
    };
  };
  const Constructor = moduleValue.TosClient ?? moduleValue.Client;
  if (!Constructor) throw new Error("SOL_PAID_E2E_TOS_SDK_UNAVAILABLE");
  const client = new Constructor({
    accessKeyId: settings.tosAccessKey,
    accessKeySecret: settings.tosSecretKey,
    region: settings.tosRegion,
    endpoint: normalizeTosSdkEndpoint(settings.tosEndpoint ?? ""),
  });
  const result = await client.headObject({
    bucket: settings.tosBucket,
    key: objectKey,
  }) as Record<string, unknown>;
  const headers = (
    isRecord(result.headers)
      ? result.headers
      : isRecord(result.data) && isRecord(result.data.headers)
        ? result.data.headers
        : {}
  );
  const raw = headers["content-length"] ?? headers["Content-Length"];
  const contentTypeRaw = headers["content-type"] ?? headers["Content-Type"];
  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_TOS_READBACK_BYTES) {
    throw new Error("SOL_PAID_E2E_TOS_REMOTE_SIZE_INVALID");
  }
  const downloaded = await client.getObjectV2({
    bucket: settings.tosBucket,
    key: objectKey,
    dataType: "buffer",
  }) as Record<string, unknown>;
  const data = downloaded.data;
  const content = isRecord(data) ? data.content : undefined;
  if (!Buffer.isBuffer(content) || content.length !== bytes) {
    throw new Error("SOL_PAID_E2E_TOS_REMOTE_BODY_INVALID");
  }
  return {
    bytes,
    contentType: typeof contentTypeRaw === "string"
      ? contentTypeRaw.split(";")[0]!.trim().toLowerCase()
      : undefined,
    sha256: sha256(content),
  };
}

function expectedBalanceAfterPoints(mediaKind: PaidMediaKind): number {
  let spent = 0;
  for (const item of CASES) {
    spent += item.estimatedCostFen;
    if (item.mediaKind === mediaKind) return FIXTURE_BALANCE_POINTS - spent;
  }
  throw new Error("SOL_PAID_E2E_MEDIA_KIND_INVALID");
}

async function ensureFixture(
  databaseHandle: DatabaseHandle,
  runId: string,
): Promise<Fixture> {
  const fixture = deterministicFixture(runId);
  const client = await databaseHandle.pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM app.users WHERE id = $1 FOR UPDATE",
      [fixture.userId],
    );
    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO app.users (id, username, display_name, password_hash, active, role)
         VALUES ($1, $2, 'SOL Ark paid E2E', 'service-boundary-no-login', true, 'member')`,
        [fixture.userId, `sol-paid-${runId}`],
      );
      const credit = await client.query(
        `UPDATE app.user_credit_accounts
         SET balance_points = $2, daily_limit_points = $3, updated_at = now()
         WHERE user_id = $1`,
        [fixture.userId, FIXTURE_BALANCE_POINTS, FIXTURE_DAILY_LIMIT_POINTS],
      );
      if (credit.rowCount !== 1) throw new Error("SOL_PAID_E2E_CREDIT_ACCOUNT_MISSING");
      await client.query(
        `INSERT INTO app.projects (id, owner_user_id, name, status)
         VALUES ($1, $2, $3, 'active')`,
        [fixture.projectId, fixture.userId, `SOL Ark paid E2E ${runId.slice(0, 12)}`],
      );
      await client.query(
        `INSERT INTO app.episodes (id, project_id, episode_no, name, sort_order, status)
         VALUES ($1, $2, 1, '三模态付费验收', 1, 'active')`,
        [fixture.episodeId, fixture.projectId],
      );
      for (const [index, item] of CASES.entries()) {
        await client.query(
          `INSERT INTO app.shots (
             id, episode_id, shot_code, title, script_text, sort_order
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            fixture.shotIds[item.mediaKind],
            fixture.episodeId,
            `SOL-${item.mediaKind.toUpperCase()}-1`,
            `Ark ${item.mediaKind} 最低档验收`,
            item.prompt,
            index + 1,
          ],
        );
      }
      await client.query(
        `INSERT INTO app.asset_entities (
           id, owner_user_id, visibility, asset_kind, role, usage_mode, name,
           display_name, style_tags, approved, reuse_scope, status, metadata,
           created_at, updated_at, use_count
         ) VALUES (
           $1, $2, 'personal', 'reference', 'character_identity', 'reference',
           'SOL Ark paid E2E target', 'SOL Ark paid E2E target',
           '[]'::jsonb, true, 'all_projects', 'approved', '{}'::jsonb,
           now(), now(), 0
         )`,
        [fixture.assetId, fixture.userId],
      );
    } else {
      const check = await client.query<{
        balance_points: number;
        project_count: number;
        episode_count: number;
        shot_count: number;
        asset_count: number;
      }>(
        `SELECT
           account.balance_points,
           (SELECT count(*)::int FROM app.projects WHERE id = $2 AND owner_user_id = $1) AS project_count,
           (SELECT count(*)::int FROM app.episodes WHERE id = $3 AND project_id = $2) AS episode_count,
           (SELECT count(*)::int FROM app.shots WHERE id = ANY($4::uuid[]) AND episode_id = $3) AS shot_count,
           (SELECT count(*)::int FROM app.asset_entities WHERE id = $5 AND owner_user_id = $1) AS asset_count
         FROM app.user_credit_accounts account
         WHERE account.user_id = $1`,
        [
          fixture.userId,
          fixture.projectId,
          fixture.episodeId,
          Object.values(fixture.shotIds),
          fixture.assetId,
        ],
      );
      const row = check.rows[0];
      if (!row
        || row.project_count !== 1
        || row.episode_count !== 1
        || row.shot_count !== CASES.length
        || row.asset_count !== 1
        || row.balance_points > FIXTURE_BALANCE_POINTS) {
        throw new Error("SOL_PAID_E2E_FIXTURE_DRIFT");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return fixture;
}

function deterministicFixture(runId: string): Fixture {
  return {
    userId: deterministicUuid(runId, "user"),
    projectId: deterministicUuid(runId, "project"),
    episodeId: deterministicUuid(runId, "episode"),
    assetId: deterministicUuid(runId, "asset"),
    shotIds: {
      image: deterministicUuid(runId, "shot-image"),
      audio: deterministicUuid(runId, "shot-audio"),
      video: deterministicUuid(runId, "shot-video"),
    },
  };
}

function deterministicUuid(runId: string, label: string): string {
  const bytes = createHash("sha256").update(`sol-paid-e2e:${runId}:${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function existingAttemptKinds(
  db: Database,
  runId: string,
): Promise<Set<PaidMediaKind>> {
  const keys = CASES.map((item) => paidIdempotencyKey(runId, item.mediaKind));
  const rows = await db.select({
    idempotencyKey: generationRequests.clientIdempotencyKey,
  }).from(generationRequests).where(inArray(generationRequests.clientIdempotencyKey, keys));
  const kinds = new Set<PaidMediaKind>();
  for (const row of rows) {
    const kind = CASES.find(
      (item) => paidIdempotencyKey(runId, item.mediaKind) === row.idempotencyKey,
    )?.mediaKind;
    if (kind) kinds.add(kind);
  }
  return kinds;
}

async function reservedCostFen(db: Database): Promise<number> {
  const row = (await db.select({
    total: sql<number>`coalesce(sum(${generationAttempts.estimatedCostFen}), 0)::integer`,
  }).from(generationAttempts))[0];
  const total = Number(row?.total ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("SOL_PAID_E2E_RESERVED_COST_INVALID");
  }
  return total;
}

export function parseSolPaidE2eArgs(args: readonly string[]): SolPaidE2eCliOptions {
  let mode: SolPaidE2eCliOptions["mode"] | undefined;
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
      throw new Error("SOL_PAID_E2E_ARGUMENT_INVALID");
    }
  }
  if (!mode) throw new Error("SOL_PAID_E2E_MODE_REQUIRED");
  if (target !== "test") throw new Error("SOL_PAID_E2E_TARGET_MUST_BE_TEST");
  if (incrementalBudgetFen !== TOTAL_INCREMENTAL_BUDGET_FEN) {
    throw new Error("SOL_PAID_E2E_INCREMENTAL_BUDGET_MUST_BE_139");
  }
  if (mode === "preflight" && confirmPaid) {
    throw new Error("SOL_PAID_E2E_PREFLIGHT_MUST_NOT_CONFIRM");
  }
  if (mode === "preflight" && runId !== undefined) {
    throw new Error("SOL_PAID_E2E_PREFLIGHT_RUN_ID_FORBIDDEN");
  }
  if (mode === "run" && !confirmPaid) {
    throw new Error("SOL_PAID_E2E_CONFIRMATION_REQUIRED");
  }
  if (mode === "run"
    && (typeof runId !== "string" || !/^[a-z0-9][a-z0-9_-]{7,47}$/u.test(runId))) {
    throw new Error("SOL_PAID_E2E_RUN_ID_INVALID");
  }
  return {
    mode,
    target: "test",
    incrementalBudgetFen: TOTAL_INCREMENTAL_BUDGET_FEN,
    confirmPaid,
    ...(runId ? { runId } : {}),
  };
}

export function paidIdempotencyKey(runId: string, mediaKind: PaidMediaKind): string {
  if (!/^[a-z0-9][a-z0-9_-]{7,47}$/u.test(runId)) {
    throw new Error("SOL_PAID_E2E_RUN_ID_INVALID");
  }
  return `sol-paid-e2e-${runId}-${mediaKind}`;
}

function validMimeType(mediaKind: PaidMediaKind, value: string | null): boolean {
  if (!value) return false;
  if (mediaKind === "image") return value === "image/jpeg" || value === "image/png" || value === "image/webp";
  if (mediaKind === "video") return value === "video/mp4";
  return value === "audio/mpeg";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeFailure(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : "";
  const databaseDiagnostic = safeDatabaseDiagnostic(error);
  const runtimeDiagnostic = safeRuntimeDiagnostic(error);
  const appError = findAppError(error);
  return {
    name: "SOL_PAID_E2E_FAILED",
    stage: activeStage,
    ...(activeRunFingerprint ? { runFingerprint: activeRunFingerprint } : {}),
    ...(activeAttemptFingerprint ? { attemptFingerprint: activeAttemptFingerprint } : {}),
    ...(appError
      ? { code: appError.code }
      : /^SOL_PAID_E2E_[A-Z0-9_]+$/.test(message)
        ? { code: message }
        : { code: "SOL_PAID_E2E_INTERNAL" }),
    ...(databaseDiagnostic ? { databaseDiagnostic } : {}),
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
  };
}

function findAppError(error: unknown, depth = 0): AppError | undefined {
  if (error instanceof AppError) return error;
  if (!error || typeof error !== "object" || depth >= 3) return undefined;
  return findAppError((error as Record<string, unknown>).cause, depth + 1);
}

function safeRuntimeDiagnostic(error: unknown): Record<string, string | number> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const name = typeof value.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(value.name)
    ? value.name
    : undefined;
  const statusCode = typeof value.statusCode === "number"
    && Number.isSafeInteger(value.statusCode)
    && value.statusCode >= 400
    && value.statusCode <= 599
    ? value.statusCode
    : undefined;
  const cause = value.cause && typeof value.cause === "object"
    ? value.cause as Record<string, unknown>
    : undefined;
  const causeName = typeof cause?.name === "string"
    && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(cause.name)
    ? cause.name
    : undefined;
  if (!name && statusCode === undefined && !causeName) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(causeName ? { causeName } : {}),
  };
}

function safeDatabaseDiagnostic(
  error: unknown,
  depth = 0,
): Record<string, string> | undefined {
  if (!error || typeof error !== "object" || depth >= 3) return undefined;
  const value = error as Record<string, unknown>;
  const code = typeof value.code === "string" && /^[0-9A-Z]{5}$/.test(value.code)
    ? value.code
    : undefined;
  if (!code) return safeDatabaseDiagnostic(value.cause, depth + 1);
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

const isDirectRun = process.argv[1]?.endsWith("sol-paid-e2e.mts")
  || process.argv[1]?.endsWith("sol-paid-e2e");
if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeFailure(error) })}\n`);
    process.exitCode = 1;
  });
}
