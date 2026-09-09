#!/usr/bin/env -S npx --no-install tsx

/**
 * Milvus asset vector projection migration for the current V2 schema.
 *
 * Default mode is read-only:
 *   node --import tsx scripts/migrate-milvus-asset-vectors-v2.ts
 *
 * Apply mode rebuilds the configured asset vector collection from PostgreSQL:
 *   node --import tsx scripts/migrate-milvus-asset-vectors-v2.ts --apply --confirm REBUILD_MILVUS_ASSET_VECTORS_V2
 *
 * Milvus is a rebuildable projection. This script does not try to patch an
 * existing collection in place. If required fields are missing, apply mode
 * drops the collection and repopulates it through VectorSyncService, which is
 * the same runtime writer used by asset ingest and patch flows.
 */

import { createRequire } from "node:module";
import { and, eq, isNull } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import {
  assetEntities,
  assetVariants,
  type AssetEntityRow,
  type AssetVariantRow,
} from "../src/db/schema.js";
import { AssetEntityRepository } from "../src/repositories/assetEntityRepository.js";
import { AssetVariantRepository } from "../src/repositories/assetVariantRepository.js";
import { errorMessage } from "../src/shared/errors.js";
import { VectorSyncService } from "../src/services/vectorSyncService.js";

const require = createRequire(import.meta.url);
const CONFIRMATION = "REBUILD_MILVUS_ASSET_VECTORS_V2";
const EXPECTED_FIELDS = [
  "id",
  "vector",
  "text",
  "source_table",
  "source_id",
  "parent_entity_id",
  "source_project_id",
  "source_project_name",
  "asset_kind",
  "gender",
  "approval_state",
  "status",
  "text_hash",
  "embedding_model",
  "metadata",
] as const;

interface Args {
  apply: boolean;
  confirm?: string;
  forceRebuild: boolean;
}

interface MilvusClient {
  hasCollection(input: { collection_name: string }): Promise<boolean | { value?: boolean }>;
  describeCollection(input: { collection_name: string }): Promise<unknown>;
  releaseCollection?(input: { collection_name: string }): Promise<unknown>;
  dropCollection(input: { collection_name: string }): Promise<unknown>;
  getCollectionStatistics?(input: { collection_name: string }): Promise<unknown>;
  closeConnection?(): Promise<void> | void;
}

interface MilvusModule {
  MilvusClient: new (options: Record<string, unknown>) => MilvusClient;
}

interface CollectionInspection {
  collection: string;
  exists: boolean;
  fieldNames: string[];
  missingFields: string[];
  extraFields: string[];
  rowCount: string | null;
  needsRebuild: boolean;
}

interface RebuildPlan {
  entityRows: AssetEntityRow[];
  variantRows: Array<{ variant: AssetVariantRow; entity: AssetEntityRow }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const collection = settings.milvusCollectionAssetEntity;
  const client = createMilvusClient();
  try {
    const inspection = await inspectCollection(client, collection);
    const plan = await readRebuildPlan();
    if (!args.apply) {
      printJson({
        mode: "check",
        ...inspection,
        expectedFields: EXPECTED_FIELDS,
        postgresPlan: summarizePlan(plan),
        nextStep: inspection.needsRebuild
          ? `run with --apply --confirm ${CONFIRMATION}`
          : "collection already contains the current V2 fields",
      });
      return;
    }

    if (args.confirm !== CONFIRMATION) {
      throw new Error(`--apply requires --confirm ${CONFIRMATION}`);
    }
    if (!inspection.needsRebuild && !args.forceRebuild) {
      printJson({
        mode: "apply",
        action: "no_op",
        ...inspection,
        postgresPlan: summarizePlan(plan),
      });
      return;
    }
    if (summarizePlan(plan).totalSyncRequests === 0) {
      throw new Error("Refusing to rebuild Milvus: PostgreSQL has no active asset entities or variants to sync");
    }

    if (inspection.exists) {
      await releaseCollectionIfLoaded(client, collection);
      await client.dropCollection({ collection_name: collection });
    }

    const result = await syncPlan(plan);
    printJson({
      mode: "apply",
      action: inspection.exists ? "drop_and_rebuild" : "create_and_sync",
      collection,
      previousFields: inspection.fieldNames,
      expectedFields: EXPECTED_FIELDS,
      postgresPlan: summarizePlan(plan),
      ...result,
    });
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await client.closeConnection?.();
  }
}

function parseArgs(args: string[]): Args {
  const result: Args = { apply: false, forceRebuild: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--apply") {
      result.apply = true;
      continue;
    }
    if (arg === "--force-rebuild") {
      result.forceRebuild = true;
      continue;
    }
    if (arg === "--confirm") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--confirm requires a value");
      result.confirm = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function printUsage(): void {
  process.stdout.write([
    "Usage:",
    "  node --import tsx scripts/migrate-milvus-asset-vectors-v2.ts",
    `  node --import tsx scripts/migrate-milvus-asset-vectors-v2.ts --apply --confirm ${CONFIRMATION}`,
    "",
    "Default mode only checks the configured Milvus collection schema and PostgreSQL rebuild plan.",
    "--apply drops and rebuilds the Milvus asset vector projection when fields are missing.",
    "--force-rebuild also rebuilds when the collection already contains the expected fields.",
  ].join("\n"));
  process.stdout.write("\n");
}

function createMilvusClient(): MilvusClient {
  if (!settings.milvusUri) throw new Error("Missing MILVUS_URI");
  const moduleValue = require("@zilliz/milvus2-sdk-node") as MilvusModule;
  return new moduleValue.MilvusClient({
    address: settings.milvusUri.replace(/^https?:\/\//, ""),
    username: settings.milvusUser,
    password: settings.milvusPassword,
    timeout: 8_000,
  });
}

async function inspectCollection(client: MilvusClient, collection: string): Promise<CollectionInspection> {
  const rawExists = await client.hasCollection({ collection_name: collection });
  const exists = typeof rawExists === "boolean" ? rawExists : rawExists.value === true;
  if (!exists) {
    return {
      collection,
      exists: false,
      fieldNames: [],
      missingFields: [...EXPECTED_FIELDS],
      extraFields: [],
      rowCount: null,
      needsRebuild: true,
    };
  }
  const [description, statistics] = await Promise.all([
    client.describeCollection({ collection_name: collection }),
    client.getCollectionStatistics?.({ collection_name: collection }).catch(() => undefined),
  ]);
  const fieldNames = collectionFieldNames(description);
  const actual = new Set(fieldNames);
  const expected = new Set<string>(EXPECTED_FIELDS);
  const missingFields = EXPECTED_FIELDS.filter((field) => !actual.has(field));
  const extraFields = fieldNames.filter((field) => !expected.has(field));
  return {
    collection,
    exists: true,
    fieldNames,
    missingFields,
    extraFields,
    rowCount: collectionRowCount(statistics),
    needsRebuild: missingFields.length > 0,
  };
}

function collectionFieldNames(description: unknown): string[] {
  const record = objectRecord(description);
  const schema = objectRecord(record.schema);
  const candidates = [
    schema.fields,
    record.fields,
    objectRecord(record.collectionSchema).fields,
  ];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    const names = value.flatMap((field) => {
      const fieldRecord = objectRecord(field);
      return typeof fieldRecord.name === "string" ? [fieldRecord.name] : [];
    });
    if (names.length > 0) return names;
  }
  return [];
}

function collectionRowCount(statistics: unknown): string | null {
  const record = objectRecord(statistics);
  const stats = Array.isArray(record.stats) ? record.stats : Array.isArray(record.data) ? record.data : [];
  for (const item of stats) {
    const stat = objectRecord(item);
    if (stat.key === "row_count" && (typeof stat.value === "string" || typeof stat.value === "number")) {
      return String(stat.value);
    }
  }
  return null;
}

async function readRebuildPlan(): Promise<RebuildPlan> {
  const handle = createDatabase();
  try {
    const entityRows = await handle.db
      .select()
      .from(assetEntities)
      .where(isNull(assetEntities.deletedAt));
    const variantRows = await activeVariantRows(handle.db);
    return { entityRows, variantRows };
  } finally {
    await handle.pool.end();
  }
}

async function activeVariantRows(db: Database): Promise<Array<{ variant: AssetVariantRow; entity: AssetEntityRow }>> {
  return db
    .select({ variant: assetVariants, entity: assetEntities })
    .from(assetVariants)
    .innerJoin(assetEntities, eq(assetVariants.assetEntityId, assetEntities.id))
    .where(and(isNull(assetVariants.deletedAt), isNull(assetEntities.deletedAt)));
}

function summarizePlan(plan: RebuildPlan): {
  activeEntities: number;
  activeVariants: number;
  totalSyncRequests: number;
} {
  return {
    activeEntities: plan.entityRows.length,
    activeVariants: plan.variantRows.length,
    totalSyncRequests: plan.entityRows.length + plan.variantRows.length,
  };
}

async function releaseCollectionIfLoaded(client: MilvusClient, collection: string): Promise<void> {
  try {
    await client.releaseCollection?.({ collection_name: collection });
  } catch {
    // Releasing is best-effort. Some deployments allow drop without release,
    // and some SDK/server combinations report "not loaded" as an error.
  }
}

async function syncPlan(plan: RebuildPlan): Promise<{ synced: number; failed: number }> {
  const vectors = new VectorSyncService();
  const entityRepository = new AssetEntityRepository({} as Database);
  const variantRepository = new AssetVariantRepository({} as Database);
  let synced = 0;
  let failed = 0;

  for (const [index, row] of plan.entityRows.entries()) {
    try {
      await vectors.syncEntity(entityRepository.toData(row));
      synced += 1;
    } catch (error) {
      failed += 1;
      process.stderr.write(`[milvus-v2] entity ${row.id} failed: ${errorMessage(error)}\n`);
    }
    writeProgress(index + 1, plan.entityRows.length, "entities", failed);
  }

  for (const [index, row] of plan.variantRows.entries()) {
    try {
      await vectors.syncVariant(variantRepository.toData(row.variant), entityRepository.toData(row.entity));
      synced += 1;
    } catch (error) {
      failed += 1;
      process.stderr.write(`[milvus-v2] variant ${row.variant.id} failed: ${errorMessage(error)}\n`);
    }
    writeProgress(index + 1, plan.variantRows.length, "variants", failed);
  }
  return { synced, failed };
}

function writeProgress(done: number, total: number, label: string, failed: number): void {
  if (total === 0) return;
  if (done % 100 === 0 || done === total) {
    process.stderr.write(`[milvus-v2] ${label} ${done}/${total} failed=${failed}\n`);
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error) || "Milvus V2 migration failed"}\n`);
  process.exitCode = 1;
});
