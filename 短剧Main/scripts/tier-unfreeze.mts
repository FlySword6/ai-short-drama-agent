#!/usr/bin/env node
/**
 * Controlled generation-tier activation.
 *
 * Default mode is a read-only dry-run. A write requires the exact batch name,
 * an explicit confirmation, a reviewed evidence file and the fingerprinted
 * development database. The script never submits a provider request.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { settings } from "../src/config/env.js";
import { buildDatabasePoolConfig } from "../src/db/client.js";
import {
  arkTierPriceDefinition,
  assessTierPricingRule,
  pricingVerificationMetadata,
  type ArkTierPriceDefinition,
} from "../src/modules/generation/tierPricingGuard.js";
import { assertFable007DeploymentIdentity } from "./fable007-provider-smoke.mjs";
import {
  assertTierUnfreezeDatabaseTransport,
  assertTierUnfreezeTargetIdentity,
  databaseIdentityParts,
  TIER_UNFREEZE_BATCH_ID,
  TIER_UNFREEZE_LITE_B2_BATCH_ID,
  TIER_UNFREEZE_TEST_ENV_BATCH_ID,
  type TierUnfreezeTarget,
} from "./tier-unfreeze-target.mjs";

export {
  assertTierUnfreezeDatabaseTransport,
  assertTierUnfreezeTargetIdentity,
  TIER_UNFREEZE_BATCH_ID,
  TIER_UNFREEZE_TEST_ENV_BATCH_ID,
  tierUnfreezeTargetIdentitySha256,
} from "./tier-unfreeze-target.mjs";

export const TIER_UNFREEZE_MAX_CUMULATIVE_SPEND_FEN = 5_000;

export interface TierUnfreezeBatchItem {
  tierId: string;
  smokeBillableUnits: number;
  finalParams: Readonly<Record<string, string | number | boolean>>;
}

export const TIER_UNFREEZE_BATCH: readonly TierUnfreezeBatchItem[] = [
  {
    tierId: "img-seedream5pro-169-1k-1",
    smokeBillableUnits: 1,
    finalParams: {
      aspect_ratio: "16:9",
      resolution: "1K",
      watermark: false,
      sequential_image_generation: "disabled",
      quantity: 1,
    },
  },
  {
    tierId: "img-seedream5pro-916-1k-1",
    smokeBillableUnits: 1,
    finalParams: {
      aspect_ratio: "9:16",
      resolution: "1K",
      watermark: false,
      sequential_image_generation: "disabled",
      quantity: 1,
    },
  },
  {
    tierId: "vid-seedance20fast-169-480p",
    smokeBillableUnits: 4,
    finalParams: {
      aspect_ratio: "16:9",
      resolution: "480p",
      duration_seconds: 4,
      watermark: false,
      generate_audio: false,
      quantity: 1,
    },
  },
  {
    tierId: "vid-seedance20fast-916-480p",
    smokeBillableUnits: 4,
    finalParams: {
      aspect_ratio: "9:16",
      resolution: "480p",
      duration_seconds: 4,
      watermark: false,
      generate_audio: false,
      quantity: 1,
    },
  },
];

export interface TierUnfreezeApprovedBatch {
  batchId: string;
  target: TierUnfreezeTarget;
  items: readonly TierUnfreezeBatchItem[];
}

const TIER_UNFREEZE_DEV_BATCH: TierUnfreezeApprovedBatch = {
  batchId: TIER_UNFREEZE_BATCH_ID,
  target: "dev",
  items: TIER_UNFREEZE_BATCH,
};

export const TIER_UNFREEZE_TEST_ENV_BATCH: TierUnfreezeApprovedBatch = {
  batchId: TIER_UNFREEZE_TEST_ENV_BATCH_ID,
  target: "test-env",
  items: [TIER_UNFREEZE_BATCH[1]!],
};

/**
 * Lite 批次二(2026-08-08 DC 拍板):2.5 专用接入点档。
 */
export const TIER_UNFREEZE_LITE_B2_BATCH: TierUnfreezeApprovedBatch = {
  batchId: TIER_UNFREEZE_LITE_B2_BATCH_ID,
  target: "dev",
  items: [
    {
      tierId: "vid-seedance25-ep-916-720p-4s",
      smokeBillableUnits: 4,
      finalParams: {
        aspect_ratio: "9:16",
        resolution: "720p",
        duration_seconds: 4,
        watermark: false,
        quantity: 1,
      },
    },
  ],
};

export interface TierUnfreezeEvidenceEntry {
  tierId: string;
  providerTaskFingerprint: string;
  artifactSha256: string;
  artifactWidthPx?: number;
  artifactHeightPx?: number;
  smokeCompletedAt: string;
  accountCheckedAt: string;
  platformListPriceFen: number;
  providerBilledFen: number;
  providerBillingReference: string;
}

export interface TierUnfreezeEvidence {
  batchId: string;
  target: TierUnfreezeTarget;
  entries: TierUnfreezeEvidenceEntry[];
  sha256: string;
}

export interface TierUnfreezeRow {
  id: string;
  provider: string;
  model: string;
  mediaKind: "image" | "video" | "audio";
  billingUnit: string;
  unitPriceFen: number;
  active: boolean;
  source: string;
  metadata: Record<string, unknown>;
}

export type TierUnfreezeAction =
  | {
      kind: "activate";
      rowId: string;
      tierId: string;
      source: string;
      metadata: Record<string, unknown>;
    }
  | { kind: "skip"; rowId: string; tierId: string }
  | { kind: "pending_evidence"; rowId: string; tierId: string }
  | { kind: "pending_deployment"; rowId: string; tierId: string }
  | { kind: "conflict"; tierId: string; reasons: string[] };

export interface TierUnfreezeCliOptions {
  apply: boolean;
  batchId: string;
  target: TierUnfreezeTarget;
  schema: string;
  confirmBatch?: string;
  confirmTarget?: "test-env";
  evidenceFile?: string;
  deploymentBaseUrl?: string;
  guardCommit?: string;
}

export interface TierUnfreezeDeploymentProof {
  baseUrl: string;
  commitSha: string;
}

interface DbPricingRuleRow {
  id: string;
  provider: string;
  model: string;
  media_kind: "image" | "video" | "audio";
  billing_unit: string;
  unit_price_fen: number;
  active: boolean;
  source: string;
  metadata: unknown;
}

function approvedTierUnfreezeBatch(
  target: TierUnfreezeTarget,
  batchId: string | undefined,
): TierUnfreezeApprovedBatch {
  const approved = target === "dev"
    ? [TIER_UNFREEZE_DEV_BATCH, TIER_UNFREEZE_LITE_B2_BATCH]
    : [TIER_UNFREEZE_TEST_ENV_BATCH];
  const batch = approved.find((candidate) => candidate.batchId === batchId);
  if (!batch) {
    throw new Error(
      `拒绝执行:批次 ${batchId ?? "<missing>"} 不在目标 ${target} 的白名单；`
      + `只允许 ${approved.map((candidate) => candidate.batchId).join(" / ")}`,
    );
  }
  return batch;
}

function tierUnfreezeSource(batchId: string): string {
  return `tier-unfreeze:${batchId}`;
}

export function parseTierUnfreezeArgs(args: readonly string[]): TierUnfreezeCliOptions {
  let apply = false;
  let batchId: string | undefined;
  let target: string | undefined;
  let schema: string | undefined;
  let confirmBatch: string | undefined;
  let confirmTarget: string | undefined;
  let evidenceFile: string | undefined;
  let deploymentBaseUrl: string | undefined;
  let guardCommit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--apply") apply = true;
    else if (key === "--dry-run") apply = false;
    else if (key === "--batch") {
      batchId = requireArgValue(args, ++index, "--batch");
    } else if (key === "--target") {
      target = requireArgValue(args, ++index, "--target");
    } else if (key === "--schema") {
      schema = requireArgValue(args, ++index, "--schema");
    } else if (key === "--confirm-batch") {
      confirmBatch = requireArgValue(args, ++index, "--confirm-batch");
    } else if (key === "--confirm-target") {
      confirmTarget = requireArgValue(args, ++index, "--confirm-target");
    } else if (key === "--evidence-file") {
      evidenceFile = requireArgValue(args, ++index, "--evidence-file");
    } else if (key === "--deployment-base-url") {
      deploymentBaseUrl = requireArgValue(args, ++index, "--deployment-base-url");
    } else if (key === "--guard-commit") {
      guardCommit = requireArgValue(args, ++index, "--guard-commit");
    } else {
      throw new Error(`未知参数:${key}`);
    }
  }
  if (target !== "dev" && target !== "test-env") {
    throw new Error("拒绝执行:档位解冻只允许 --target dev；测试环境使用 --target test-env");
  }
  const approvedBatch = approvedTierUnfreezeBatch(target, batchId);
  if (!schema || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error("拒绝执行:--schema 必须是合法 PostgreSQL schema");
  }
  if (/(^|[_-])(prod|production|test|testing)($|[_-])/iu.test(schema)) {
    throw new Error(
      target === "dev"
        ? "拒绝执行:dev 解冻不能指向 production/test schema"
        : "拒绝执行:test-env 解冻不能指向 production/test schema",
    );
  }
  if (apply) {
    if (confirmBatch !== approvedBatch.batchId) {
      throw new Error("拒绝执行:--apply 必须用 --confirm-batch 重复确认精确批次");
    }
    if (target === "test-env" && confirmTarget !== "test-env") {
      throw new Error("拒绝执行:test-env apply 必须额外使用 --confirm-target test-env");
    }
    if (target === "dev" && confirmTarget) {
      throw new Error("拒绝执行:--confirm-target 只用于 test-env");
    }
    if (!evidenceFile) throw new Error("拒绝执行:--apply 必须提供 --evidence-file");
    if (!deploymentBaseUrl || !guardCommit) {
      throw new Error("拒绝执行:--apply 必须提供部署地址和价格守卫 commit");
    }
  } else if (confirmBatch || confirmTarget) {
    throw new Error("拒绝执行:dry-run 不接受确认参数");
  }
  if ((deploymentBaseUrl && !guardCommit) || (!deploymentBaseUrl && guardCommit)) {
    throw new Error("拒绝执行:部署地址与价格守卫 commit 必须成对提供");
  }
  if (guardCommit && !/^[0-9a-f]{7,40}$/u.test(guardCommit)) {
    throw new Error("拒绝执行:--guard-commit 必须是 7-40 位小写 git SHA");
  }
  return {
    apply,
    batchId: approvedBatch.batchId,
    target,
    schema,
    ...(confirmBatch ? { confirmBatch } : {}),
    ...(confirmTarget === "test-env" ? { confirmTarget } : {}),
    ...(evidenceFile ? { evidenceFile } : {}),
    ...(deploymentBaseUrl ? { deploymentBaseUrl } : {}),
    ...(guardCommit ? { guardCommit } : {}),
  };
}

export function planTierUnfreeze(
  rows: readonly TierUnfreezeRow[],
  evidence?: TierUnfreezeEvidence,
  deploymentProof?: TierUnfreezeDeploymentProof,
  batch: TierUnfreezeApprovedBatch = TIER_UNFREEZE_DEV_BATCH,
): TierUnfreezeAction[] {
  if (batch.items.length > 4) {
    throw new Error("拒绝执行:单批档位数超过 4 个安全上限");
  }
  if (evidence) validateTierUnfreezeEvidence(evidence, batch);
  const evidenceByTier = new Map(evidence?.entries.map((entry) => [entry.tierId, entry]));
  return batch.items.map((item) => {
    const matches = rows.filter((row) => readTierId(row.metadata) === item.tierId);
    if (matches.length !== 1) {
      return {
        kind: "conflict",
        tierId: item.tierId,
        reasons: [`预期恰好 1 行，实际 ${matches.length} 行`],
      };
    }
    const row = matches[0]!;
    const definition = requireVerifiedDefinition(item.tierId);
    const reasons = validateRowIdentity(row, item, definition);
    if (reasons.length > 0) return { kind: "conflict", tierId: item.tierId, reasons };

    const currentAssessment = assessTierPricingRule({
      provider: row.provider,
      model: row.model,
      mediaKind: row.mediaKind,
      billingUnit: row.billingUnit,
      unitPriceFen: row.unitPriceFen,
      metadata: row.metadata,
      active: row.active,
    }, {
      companyProviderAllowlist: ["ark"],
      allowDevSmoke: true,
    });
    const entry = evidenceByTier.get(item.tierId);
    const currentFormal = row.active
      && row.source === tierUnfreezeSource(batch.batchId)
      && readEvidenceBatchId(row.metadata) === batch.batchId;
    if (currentFormal) {
      if (!evidence || !entry || !deploymentProof) {
        return {
          kind: "conflict",
          tierId: item.tierId,
          reasons: ["正式行重跑必须提供原证据与已部署守卫 commit"],
        };
      }
      const expectedMetadata = formalMetadata(
        row.metadata,
        item,
        definition,
        entry,
        evidence.sha256,
        deploymentProof.commitSha,
        batch.batchId,
      );
      if (!currentAssessment.quoteable || !sameJson(row.metadata, expectedMetadata)) {
        return {
          kind: "conflict",
          tierId: item.tierId,
          reasons: ["现有正式行与本次证据或部署守卫 commit 不一致"],
        };
      }
      return { kind: "skip", rowId: row.id, tierId: item.tierId };
    }
    const approvedDevSmoke = batch.target === "dev"
      && row.active
      && row.metadata.activation_scope === "dev_smoke_only"
      && currentAssessment.quoteable;
    if (row.active && !approvedDevSmoke) {
      return {
        kind: "conflict",
        tierId: item.tierId,
        reasons: ["现有 active 行不是已知开发冒烟档，也不是本批正式档"],
      };
    }
    if (!evidence) return { kind: "pending_evidence", rowId: row.id, tierId: item.tierId };
    if (!entry) {
      return { kind: "conflict", tierId: item.tierId, reasons: ["缺少本档实测证据"] };
    }
    if (!deploymentProof) {
      return { kind: "pending_deployment", rowId: row.id, tierId: item.tierId };
    }
    return {
      kind: "activate",
      rowId: row.id,
      tierId: item.tierId,
      source: tierUnfreezeSource(batch.batchId),
      metadata: formalMetadata(
        row.metadata,
        item,
        definition,
        entry,
        evidence.sha256,
        deploymentProof.commitSha,
        batch.batchId,
      ),
    };
  });
}

export function validateTierUnfreezeEvidence(
  evidence: TierUnfreezeEvidence,
  batch: TierUnfreezeApprovedBatch = approvedTierUnfreezeBatch(
    evidence.target,
    evidence.batchId,
  ),
): void {
  if (evidence.batchId !== batch.batchId || evidence.target !== batch.target) {
    throw new Error("实测证据的批次或目标环境不匹配");
  }
  if (!/^[0-9a-f]{64}$/u.test(evidence.sha256)) {
    throw new Error("实测证据缺少有效 SHA-256");
  }
  if (evidence.entries.length !== batch.items.length) {
    throw new Error("实测证据必须逐档一笔，不多不少");
  }
  const seen = new Set<string>();
  const taskFingerprints = new Set<string>();
  const artifactHashes = new Set<string>();
  let cumulativeProviderFen = 0;
  for (const item of batch.items) {
    const entry = evidence.entries.find((candidate) => candidate.tierId === item.tierId);
    if (!entry || seen.has(item.tierId)) throw new Error(`${item.tierId}:缺少唯一实测证据`);
    seen.add(item.tierId);
    const definition = requireVerifiedDefinition(item.tierId);
    if (!/^[0-9a-f]{16,64}$/u.test(entry.providerTaskFingerprint)) {
      throw new Error(`${item.tierId}:provider task 指纹无效`);
    }
    if (taskFingerprints.has(entry.providerTaskFingerprint)) {
      throw new Error(`${item.tierId}:provider task 指纹与另一档重复`);
    }
    taskFingerprints.add(entry.providerTaskFingerprint);
    if (!/^[0-9a-f]{64}$/u.test(entry.artifactSha256)) {
      throw new Error(`${item.tierId}:产物 SHA-256 无效`);
    }
    if (artifactHashes.has(entry.artifactSha256)) {
      throw new Error(`${item.tierId}:产物 SHA-256 与另一档重复`);
    }
    artifactHashes.add(entry.artifactSha256);
    if (batch.target === "test-env") {
      assertTestEnvPortraitEvidence(entry, item);
    }
    if (!isIsoTimestamp(entry.smokeCompletedAt) || !isIsoTimestamp(entry.accountCheckedAt)) {
      throw new Error(`${item.tierId}:实测或核账时间无效`);
    }
    if (Date.parse(entry.accountCheckedAt) < Date.parse(entry.smokeCompletedAt)) {
      throw new Error(`${item.tierId}:核账时间早于实测时间`);
    }
    if (!entry.providerBillingReference.trim() || entry.providerBillingReference.length > 240) {
      throw new Error(`${item.tierId}:供应商账单证据引用无效`);
    }
    const expectedPlatformFen = definition.platformUnitPriceFen! * item.smokeBillableUnits;
    if (entry.platformListPriceFen !== expectedPlatformFen) {
      throw new Error(
        `${item.tierId}:平台登记价 ${entry.platformListPriceFen} 与档价 ${expectedPlatformFen} 不一致`,
      );
    }
    const expectedProviderFen = definition.officialCostFenPerUnit! * item.smokeBillableUnits;
    const toleranceFen = Math.max(1, expectedProviderFen * 0.02);
    if (!Number.isFinite(entry.providerBilledFen)
      || entry.providerBilledFen <= 0
      || Math.abs(entry.providerBilledFen - expectedProviderFen) > toleranceFen) {
      throw new Error(`${item.tierId}:供应商实扣与官方公式不一致`);
    }
    cumulativeProviderFen += entry.providerBilledFen;
  }
  if (cumulativeProviderFen > TIER_UNFREEZE_MAX_CUMULATIVE_SPEND_FEN) {
    throw new Error("拒绝执行:整单累计供应商实扣超过 50 元");
  }
}

async function main(): Promise<void> {
  const options = parseTierUnfreezeArgs(process.argv.slice(2));
  const batch = approvedTierUnfreezeBatch(options.target, options.batchId);
  process.chdir(fileURLToPath(new URL("../", import.meta.url)));
  if (options.schema !== settings.postgresSchema) {
    throw new Error(
      `拒绝执行:--schema=${options.schema} 与运行时 POSTGRES_SCHEMA=${settings.postgresSchema} 不一致`,
    );
  }
  if (options.target === "dev") {
    assertFable007DeploymentIdentity({
      databaseUrl: settings.databaseUrl,
      expectedSha256: settings.pricingSeedDevDatabaseIdentitySha256,
      appEnvironment: settings.appEnvironment,
    });
  }
  const configuredDeploymentBaseUrl = options.target === "dev"
    ? settings.tierUnfreezeDevDeploymentBaseUrl
    : settings.tierUnfreezeTestEnvDeploymentBaseUrl;
  if (options.deploymentBaseUrl
    && options.deploymentBaseUrl !== configuredDeploymentBaseUrl) {
    throw new Error(`拒绝执行:部署地址不是独立配置的 ${options.target} 服务目标`);
  }
  if (options.apply || options.target === "test-env") {
    assertTierUnfreezeTargetIdentity({
      target: options.target,
      databaseUrl: settings.databaseUrl,
      schema: options.schema,
      expectedSha256: options.target === "dev"
        ? settings.tierUnfreezeDevTargetIdentitySha256
        : settings.tierUnfreezeTestEnvTargetIdentitySha256,
      appEnvironment: settings.appEnvironment,
    });
  }
  const deploymentProof = options.deploymentBaseUrl && options.guardCommit
    ? await verifyTierUnfreezeDeployment({
        baseUrl: options.deploymentBaseUrl,
        expectedCommitSha: options.guardCommit,
        target: options.target,
      })
    : undefined;
  const evidence = options.evidenceFile
    ? await readEvidenceFile(path.resolve(options.evidenceFile), batch)
    : undefined;
  assertTierUnfreezeDatabaseTransport({
    target: options.target,
    sslMode: settings.postgresSslMode,
    rootCertPath: settings.postgresSslRootCert,
  });
  if (!settings.databaseUrl) throw new Error("拒绝执行:数据库连接未配置");
  const pool = new Pool({
    ...buildDatabasePoolConfig(settings.databaseUrl),
    application_name: `tier-unfreeze-${batch.batchId}`,
    max: 1,
  });
  try {
    if (options.apply) {
      await runApply(pool, options.schema, evidence!, deploymentProof!, batch);
    } else {
      await runDryRun(pool, options.schema, evidence, deploymentProof, batch);
    }
  } finally {
    await pool.end();
  }
}

async function runDryRun(
  pool: Pool,
  schema: string,
  evidence?: TierUnfreezeEvidence,
  deploymentProof?: TierUnfreezeDeploymentProof,
  batch: TierUnfreezeApprovedBatch = TIER_UNFREEZE_DEV_BATCH,
): Promise<void> {
  const rows = await readRows(pool, schema, false, batch);
  const actions = planTierUnfreeze(rows, evidence, deploymentProof, batch);
  printPlan("DRY-RUN", actions, batch);
  assertNoConflicts(actions);
  process.stdout.write("[result] provider_calls=0 database_writes=0\n");
}

async function runApply(
  pool: Pool,
  schema: string,
  evidence: TierUnfreezeEvidence,
  deploymentProof: TierUnfreezeDeploymentProof,
  batch: TierUnfreezeApprovedBatch = TIER_UNFREEZE_DEV_BATCH,
): Promise<void> {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await assertConnectedTierUnfreezeTarget(client, schema, settings.databaseUrl);
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SELECT pg_advisory_xact_lock($1)", [1_724_017]);
    await client.query(
      `LOCK TABLE ${qualifiedTable(schema)} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const rows = await readRows(client, schema, true, batch);
    const actions = planTierUnfreeze(rows, evidence, deploymentProof, batch);
    printPlan("APPLY", actions, batch);
    assertNoConflicts(actions);
    for (const action of actions) {
      if (action.kind !== "activate") continue;
      const result = await client.query(
        `UPDATE ${qualifiedTable(schema)}
            SET active = TRUE,
                source = $2,
                metadata = $3::jsonb,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1::uuid`,
        [action.rowId, action.source, JSON.stringify(action.metadata)],
      );
      if (result.rowCount !== 1) throw new Error(`${action.tierId}:更新行数异常`);
    }
    const actual = planTierUnfreeze(
      await readRows(client, schema, false, batch),
      evidence,
      deploymentProof,
      batch,
    );
    if (actual.some((action) => action.kind !== "skip")) {
      throw new Error("写后回读未达到幂等正式状态，事务已回滚");
    }
    await client.query("COMMIT");
    transactionStarted = false;
    process.stdout.write(
      `[result] activated=${actions.filter((action) => action.kind === "activate").length}`
      + ` skipped=${actions.filter((action) => action.kind === "skip").length}`
      + " provider_calls=0 apply_committed=true\n",
    );
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readRows(
  client: Pool | PoolClient,
  schema: string,
  lockRows: boolean,
  batch: TierUnfreezeApprovedBatch = TIER_UNFREEZE_DEV_BATCH,
): Promise<TierUnfreezeRow[]> {
  const ids = batch.items.map((item) => item.tierId);
  const result = await client.query<DbPricingRuleRow>(
    `SELECT id::text AS id,
            provider,
            model,
            media_kind,
            billing_unit,
            unit_price_fen,
            active,
            source,
            metadata
       FROM ${qualifiedTable(schema)}
      WHERE metadata->'capability_tier'->>'tier_id' = ANY($1::text[])
      ORDER BY metadata->'capability_tier'->>'tier_id'`
      + (lockRows ? " FOR UPDATE" : ""),
    [ids],
  );
  return result.rows.map((row) => {
    if (!isRecord(row.metadata)) throw new Error(`${row.id}:metadata 不是对象`);
    return {
      id: row.id,
      provider: row.provider,
      model: row.model,
      mediaKind: row.media_kind,
      billingUnit: row.billing_unit,
      unitPriceFen: row.unit_price_fen,
      active: row.active,
      source: row.source,
      metadata: row.metadata,
    };
  });
}

async function readEvidenceFile(
  file: string,
  batch: TierUnfreezeApprovedBatch,
): Promise<TierUnfreezeEvidence> {
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("实测证据不是合法 JSON");
  }
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("实测证据缺少 batch_id / target / entries");
  }
  const evidence: TierUnfreezeEvidence = {
    batchId: String(value.batch_id ?? ""),
    target: value.target === "dev" || value.target === "test-env"
      ? value.target
      : (() => {
          throw new Error("实测证据 target 必须是 dev 或 test-env");
        })(),
    entries: value.entries.map(parseEvidenceEntry),
    sha256,
  };
  validateTierUnfreezeEvidence(evidence, batch);
  return evidence;
}

export async function verifyTierUnfreezeDeployment(
  input: {
    baseUrl: string;
    expectedCommitSha: string;
    target?: TierUnfreezeTarget;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TierUnfreezeDeploymentProof> {
  if (!/^[0-9a-f]{7,40}$/u.test(input.expectedCommitSha)) {
    throw new Error("拒绝执行:价格守卫 commit 不是有效 git SHA");
  }
  const target = input.target ?? "dev";
  const baseUrl = normalizedDeploymentBaseUrl(input.baseUrl, target);
  const health = await readDeploymentProofEndpoint(
    new URL("api/v1/health", baseUrl).toString(),
    fetchImpl,
    target,
  );
  const healthData = isRecord(health.data) ? health.data : null;
  if (health.ok !== true
    || healthData?.status !== "ok"
    || healthData.sha !== input.expectedCommitSha) {
    throw new Error(`拒绝执行:${target} 服务尚未部署指定价格守卫 commit`);
  }
  const ready = await readDeploymentProofEndpoint(
    new URL("api/v1/ready", baseUrl).toString(),
    fetchImpl,
    target,
  );
  const readyData = isRecord(ready.data) ? ready.data : null;
  if (ready.ok !== true || readyData?.status !== "ready") {
    throw new Error(`拒绝执行:${target} 服务尚未就绪`);
  }
  return { baseUrl, commitSha: input.expectedCommitSha };
}

async function readDeploymentProofEndpoint(
  url: string,
  fetchImpl: typeof fetch,
  target: TierUnfreezeTarget,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json" },
    });
  } catch {
    throw new Error(`拒绝执行:无法核验 ${target} 服务部署状态`);
  }
  if (!response.ok) throw new Error(`拒绝执行:${target} 服务部署状态不可用`);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > 32 * 1024) {
    throw new Error(`拒绝执行:${target} 服务部署状态响应异常`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`拒绝执行:${target} 服务部署状态不是 JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`拒绝执行:${target} 服务部署状态格式无效`);
  return parsed;
}

async function assertConnectedTierUnfreezeTarget(
  client: PoolClient,
  schema: string,
  databaseUrl: string | undefined,
): Promise<void> {
  const expected = databaseIdentityParts(databaseUrl);
  const result = await client.query<{
    database_name: string;
    user_name: string;
    target_schema: string | null;
  }>(
    `SELECT current_database()::text AS database_name,
            current_user::text AS user_name,
            to_regnamespace($1)::text AS target_schema`,
    [schema],
  );
  const actual = result.rows[0];
  if (!actual
    || actual.database_name !== decodeURIComponent(expected.database)
    || actual.user_name !== decodeURIComponent(expected.username)
    || actual.target_schema !== schema) {
    throw new Error("拒绝执行:连接后的数据库用户、库名或 schema 与批准目标不一致");
  }
}

function normalizedDeploymentBaseUrl(
  value: string,
  target: TierUnfreezeTarget,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`拒绝执行:${target} 部署地址无效`);
  }
  if (url.protocol !== "https:"
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error(`拒绝执行:${target} 部署地址必须是无凭据、无查询参数的 HTTPS 地址`);
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url.toString();
}

function parseEvidenceEntry(value: unknown): TierUnfreezeEvidenceEntry {
  if (!isRecord(value)) throw new Error("实测证据 entry 不是对象");
  return {
    tierId: String(value.tier_id ?? ""),
    providerTaskFingerprint: String(value.provider_task_fingerprint ?? ""),
    artifactSha256: String(value.artifact_sha256 ?? ""),
    ...(value.artifact_width_px !== undefined
      ? { artifactWidthPx: Number(value.artifact_width_px) }
      : {}),
    ...(value.artifact_height_px !== undefined
      ? { artifactHeightPx: Number(value.artifact_height_px) }
      : {}),
    smokeCompletedAt: String(value.smoke_completed_at ?? ""),
    accountCheckedAt: String(value.account_checked_at ?? ""),
    platformListPriceFen: Number(value.platform_list_price_fen),
    providerBilledFen: Number(value.provider_billed_fen),
    providerBillingReference: String(value.provider_billing_reference ?? ""),
  };
}

function formalMetadata(
  current: Record<string, unknown>,
  item: TierUnfreezeBatchItem,
  definition: ArkTierPriceDefinition,
  evidence: TierUnfreezeEvidenceEntry,
  evidenceSha256: string,
  guardDeployedCommit: string,
  batchId: string,
): Record<string, unknown> {
  const currentTier = isRecord(current.capability_tier) ? current.capability_tier : {};
  const valueSources = isRecord(current.value_sources) ? current.value_sources : {};
  const next: Record<string, unknown> = {
    ...current,
    capability_tier: {
      ...currentTier,
      tier_id: item.tierId,
      params: { ...item.finalParams },
      status: "active",
      official_price_source: definition.sourceUrl,
    },
    value_sources: {
      ...valueSources,
      activation:
        `${batchId}:逐档实测、供应商核账、价格目录`
        + ` ${definition.catalogVersion} 三证齐全`,
    },
    price_source_kind: "实测",
    pricing_verification: pricingVerificationMetadata(definition),
    activation_evidence: {
      batch_id: batchId,
      evidence_sha256: evidenceSha256,
      provider_task_fingerprint: evidence.providerTaskFingerprint,
      artifact_sha256: evidence.artifactSha256,
      ...(evidence.artifactWidthPx !== undefined
        ? { artifact_width_px: evidence.artifactWidthPx }
        : {}),
      ...(evidence.artifactHeightPx !== undefined
        ? { artifact_height_px: evidence.artifactHeightPx }
        : {}),
      smoke_completed_at: evidence.smokeCompletedAt,
      account_checked_at: evidence.accountCheckedAt,
      platform_list_price_fen: evidence.platformListPriceFen,
      provider_billed_fen: evidence.providerBilledFen,
      provider_billing_reference: evidence.providerBillingReference,
      guard_deployed_commit: guardDeployedCommit,
    },
    tier_availability: {
      code: "available",
      reason: "已完成官方价格核验、逐档实测与账单核对",
    },
  };
  delete next.activation_scope;
  return next;
}

function assertTestEnvPortraitEvidence(
  evidence: TierUnfreezeEvidenceEntry,
  item: TierUnfreezeBatchItem,
): void {
  const widthPx = evidence.artifactWidthPx;
  const heightPx = evidence.artifactHeightPx;
  if (!Number.isSafeInteger(widthPx)
    || !Number.isSafeInteger(heightPx)
    || (widthPx ?? 0) <= 0
    || (heightPx ?? 0) <= 0) {
    throw new Error(`${item.tierId}:测试环境实测证据缺少有效产物尺寸`);
  }
  if (heightPx! <= widthPx! || Math.abs((widthPx! / heightPx!) - (9 / 16)) > 0.02) {
    throw new Error(`${item.tierId}:测试环境实测产物不是 9:16 竖屏`);
  }
}

function validateRowIdentity(
  row: TierUnfreezeRow,
  item: TierUnfreezeBatchItem,
  definition: ArkTierPriceDefinition,
): string[] {
  const reasons: string[] = [];
  if (row.provider !== definition.provider) reasons.push(`provider=${row.provider}`);
  if (row.model !== definition.model) reasons.push(`model=${row.model}`);
  if (row.mediaKind !== definition.mediaKind) reasons.push(`media_kind=${row.mediaKind}`);
  if (row.billingUnit !== definition.billingUnit) reasons.push(`billing_unit=${row.billingUnit}`);
  if (row.unitPriceFen !== definition.platformUnitPriceFen) {
    reasons.push(`unit_price_fen=${row.unitPriceFen},应为 ${definition.platformUnitPriceFen}`);
  }
  const tier = isRecord(row.metadata.capability_tier) ? row.metadata.capability_tier : null;
  if (!tier || tier.tier_id !== item.tierId) reasons.push("tier_id 不匹配");
  if (!row.active && tier?.status !== "experimental") {
    reasons.push("inactive 候选的 status 不是 experimental");
  }
  return reasons;
}

function requireVerifiedDefinition(tierId: string): ArkTierPriceDefinition {
  const definition = arkTierPriceDefinition(tierId);
  if (!definition
    || definition.status !== "verified"
    || definition.platformUnitPriceFen === undefined
    || definition.officialCostFenPerUnit === undefined) {
    throw new Error(`${tierId}:官方价格或参数矩阵仍待核`);
  }
  return definition;
}

function printPlan(
  mode: "DRY-RUN" | "APPLY",
  actions: readonly TierUnfreezeAction[],
  batch: TierUnfreezeApprovedBatch,
): void {
  process.stdout.write(
    `[${mode}] batch=${batch.batchId} tier_count=${batch.items.length}\n`,
  );
  for (const item of batch.items) {
    const definition = requireVerifiedDefinition(item.tierId);
    const action = actions.find((candidate) => candidate.tierId === item.tierId);
    process.stdout.write(
      `  ${item.tierId} action=${action?.kind ?? "missing"}`
      + ` price=${definition.platformUnitPriceFen}/${definition.billingUnit}`
      + ` params=${JSON.stringify(item.finalParams)}\n`,
    );
  }
}

function assertNoConflicts(actions: readonly TierUnfreezeAction[]): void {
  const conflicts = actions.filter(
    (action): action is Extract<TierUnfreezeAction, { kind: "conflict" }> =>
      action.kind === "conflict",
  );
  if (conflicts.length > 0) {
    throw new Error(
      `拒绝执行:${conflicts.map((item) => `${item.tierId}[${item.reasons.join(",")}]`).join(";")}`,
    );
  }
}

function readTierId(metadata: Record<string, unknown>): string | null {
  const tier = metadata.capability_tier;
  return isRecord(tier) && typeof tier.tier_id === "string" ? tier.tier_id : null;
}

function readEvidenceBatchId(metadata: Record<string, unknown>): string | null {
  const evidence = metadata.activation_evidence;
  return isRecord(evidence) && typeof evidence.batch_id === "string"
    ? evidence.batch_id
    : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

function qualifiedTable(schema: string): string {
  return `${quoteIdentifier(schema)}."pricing_rules"`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function requireArgValue(args: readonly string[], index: number, key: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${key} 需要一个值`);
  return value;
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && /T/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const directRunPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (directRunPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "TIER_UNFREEZE_FAILED",
      })}\n`,
    );
    process.exitCode = 1;
  });
}
