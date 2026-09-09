import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { settings } from "../config/env.js";
import { parseAssetVectorId } from "../domain/assets/vectorKeys.js";
import { ExternalServiceError } from "../shared/errors.js";
import type { JsonObject, JsonValue } from "../domain/assets/types.js";

export interface VectorHit {
  id: string;
  score: number;
  text: string | null;
  metadata: JsonObject;
}

const V2_OUTPUT_FIELDS = [
  "id",
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

const DEFAULT_SEARCH_LIMIT = 10;
const HNSW_SEARCH_EF_FLOOR = 64;
const HNSW_SEARCH_EF_SOFT_MAX = 512;
const HNSW_SEARCH_EF_MULTIPLIER = 2;

interface MilvusClientLike {
  hasCollection(input: { collection_name: string } | string): Promise<boolean | { value: boolean }> | boolean | { value: boolean };
  loadCollection(input: { collection_name: string } | string): Promise<unknown>;
  createCollection(input: Record<string, unknown>): Promise<unknown>;
  upsert(input: Record<string, unknown>): Promise<unknown>;
  search(input: Record<string, unknown>): Promise<unknown>;
  deleteEntities(input: Record<string, unknown>): Promise<unknown>;
}

interface MilvusModuleLike {
  MilvusClient?: new (options: Record<string, unknown>) => MilvusClientLike;
  DataType?: Record<string, unknown>;
  MetricType?: Record<string, unknown>;
}

/**
 * Test seam only. Production uses the configured Milvus endpoint and lazy SDK
 * loading; callers never need to provide these dependencies.
 */
export interface MilvusVectorStoreDependencies {
  uri?: string;
  client?: MilvusClientLike;
  moduleValue?: MilvusModuleLike;
}

const require = createRequire(import.meta.url);

export class MilvusVectorStore {
  private client: MilvusClientLike | undefined;
  private moduleValue: MilvusModuleLike | undefined;
  private initialized = false;

  constructor(
    private readonly collectionName = settings.milvusCollectionAssetEntity,
    private readonly dependencies: MilvusVectorStoreDependencies = {},
  ) {
    this.client = dependencies.client;
    this.moduleValue = dependencies.moduleValue;
  }

  async upsert(vectorId: string, vector: number[], text: string, metadata: JsonObject): Promise<void> {
    const client = await this.getReadyClient({ createIfMissing: true, vectorDimension: vector.length });
    await client.upsert({
      collection_name: this.collectionName,
      data: [toV2MilvusRecord(vectorId, vector, text, metadata)],
    });
  }

  async search(vector: number[], limit = DEFAULT_SEARCH_LIMIT, filter?: string): Promise<VectorHit[]> {
    // Search must never provision a collection. Milvus is a rebuildable
    // projection; a missing or unavailable projection is handled by the
    // caller's PostgreSQL fallback and must not become an accidental cloud
    // write simply because a user searched for an asset.
    const client = await this.getReadyClient({ createIfMissing: false });
    const searchLimit = normalizeSearchLimit(limit);
    const result: unknown = await client.search({
      collection_name: this.collectionName,
      data: [vector],
      limit: searchLimit,
      output_fields: [...V2_OUTPUT_FIELDS],
      metric_type: "COSINE",
      params: { ef: hnswSearchEfForLimit(searchLimit) },
      ...(filter ? { expr: filter } : {}),
    });
    const searchRows = isJsonObject(result) && Array.isArray(result.results)
      ? result.results
      : Array.isArray(result) && Array.isArray(result[0])
        ? result[0]
        : [];
    return searchRows.flatMap((raw): VectorHit[] => {
      if (typeof raw !== "object" || raw === null) return [];
      const value = raw as Record<string, unknown>;
      const entity = typeof value.entity === "object" && value.entity !== null
        ? value.entity as Record<string, unknown>
        : value;
      const id = typeof value.id === "string" ? value.id : String(value.id ?? "");
      const score = typeof value.distance === "number" ? value.distance : Number(value.score ?? value.distance ?? 0);
      if (!id) return [];
      const metadata = isJsonObject(entity.metadata) ? entity.metadata : {};
      return [{
        id,
        score: Number.isFinite(score) ? score : 0,
        text: typeof entity.text === "string" ? entity.text : null,
        metadata: mergeV2FieldsIntoMetadata(metadata, entity),
      }];
    });
  }

  async deleteByIds(vectorIds: string[]): Promise<void> {
    const ids = [...new Set(vectorIds.map((id) => id.trim()).filter(Boolean))];
    if (!ids.length) return;
    // Deleting from a missing projection is not a reason to provision one.
    let client: MilvusClientLike;
    try {
      client = await this.getReadyClient({ createIfMissing: false });
    } catch (error) {
      // Milvus is a rebuildable projection. A collection that does not exist
      // has no entries to remove, and must not stop PostgreSQL/TOS deletion
      // from completing or leave an asset stuck in `purging`.
      if (isUnavailableCollectionError(error)) return;
      throw error;
    }
    await client.deleteEntities({
      collection_name: this.collectionName,
      expr: milvusIdFilter(ids),
    });
  }

  private async getReadyClient(options: { createIfMissing: boolean; vectorDimension?: number }): Promise<MilvusClientLike> {
    const uri = this.dependencies.uri ?? settings.milvusUri;
    if (!uri) throw new ExternalServiceError("Milvus", "Missing MILVUS_URI");
    if (!this.client) {
      let moduleValue = this.moduleValue;
      if (!moduleValue) {
        try {
          moduleValue = require("@zilliz/milvus2-sdk-node") as MilvusModuleLike;
          this.moduleValue = moduleValue;
        } catch {
          throw new ExternalServiceError("Milvus", "@zilliz/milvus2-sdk-node is not available");
        }
      }
      if (!moduleValue.MilvusClient) throw new ExternalServiceError("Milvus", "MilvusClient is unavailable");
      this.client = new moduleValue.MilvusClient({
        address: uri.replace(/^https?:\/\//, ""),
        username: settings.milvusUser,
        password: settings.milvusPassword,
        // gRPC 挂起（如容器出公网被静默丢包）不能拖死检索请求：
        // 超时后由混合检索降级到 PostgreSQL 词法召回。
        timeout: 8_000,
      });
    }
    const client = this.client;
    if (!this.initialized) {
      const existsResponse = await client.hasCollection({ collection_name: this.collectionName });
      const exists = typeof existsResponse === "boolean"
        ? existsResponse
        : isJsonObject(existsResponse) && existsResponse.value === true;
      if (!exists) {
        if (!options.createIfMissing) {
          throw new ExternalServiceError("Milvus", "Configured vector collection is unavailable");
        }
        const vectorDimension = options.vectorDimension;
        if (typeof vectorDimension !== "number" || !Number.isInteger(vectorDimension) || vectorDimension < 1) {
          throw new ExternalServiceError("Milvus", "Vector dimension is unavailable for collection provisioning");
        }
        const moduleValue = await this.getModuleValue();
        const dataType = moduleValue.DataType ?? {};
        const metricType = moduleValue.MetricType ?? {};
        await client.createCollection({
          collection_name: this.collectionName,
          fields: [
            { name: "id", data_type: dataType.VarChar ?? "VarChar", is_primary_key: true, max_length: 128 },
            { name: "vector", data_type: dataType.FloatVector ?? "FloatVector", dim: vectorDimension },
            { name: "text", data_type: dataType.VarChar ?? "VarChar", max_length: 8192 },
            { name: "source_table", data_type: dataType.VarChar ?? "VarChar", max_length: 32 },
            { name: "source_id", data_type: dataType.VarChar ?? "VarChar", max_length: 64 },
            { name: "parent_entity_id", data_type: dataType.VarChar ?? "VarChar", max_length: 64 },
            { name: "source_project_id", data_type: dataType.VarChar ?? "VarChar", max_length: 64 },
            { name: "source_project_name", data_type: dataType.VarChar ?? "VarChar", max_length: 128 },
            { name: "asset_kind", data_type: dataType.VarChar ?? "VarChar", max_length: 32 },
            { name: "gender", data_type: dataType.VarChar ?? "VarChar", max_length: 16 },
            { name: "approval_state", data_type: dataType.VarChar ?? "VarChar", max_length: 16 },
            { name: "status", data_type: dataType.VarChar ?? "VarChar", max_length: 32 },
            { name: "text_hash", data_type: dataType.VarChar ?? "VarChar", max_length: 64 },
            { name: "embedding_model", data_type: dataType.VarChar ?? "VarChar", max_length: 128 },
            { name: "metadata", data_type: dataType.JSON ?? "JSON" },
          ],
          index_params: [{ field_name: "vector", index_type: "HNSW", metric_type: metricType.COSINE ?? "COSINE", params: { M: 16, efConstruction: 200 } }],
        });
      }
      await client.loadCollection({ collection_name: this.collectionName });
      this.initialized = true;
    }
    return client;
  }

  private async getModuleValue(): Promise<MilvusModuleLike> {
    if (!this.moduleValue) {
      try {
        this.moduleValue = require("@zilliz/milvus2-sdk-node") as MilvusModuleLike;
      } catch {
        throw new ExternalServiceError("Milvus", "@zilliz/milvus2-sdk-node is not available");
      }
    }
    return this.moduleValue;
  }
}

export function milvusIdFilter(ids: string[]): string {
  const quoted = ids.map((id) => JSON.stringify(id)).join(", ");
  return `id in [${quoted}]`;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toV2MilvusRecord(vectorId: string, vector: number[], text: string, metadata: JsonObject): Record<string, unknown> {
  const parsed = parseAssetVectorId(vectorId);
  const sourceTable = stringValue(metadata.source_table) ?? parsed?.sourceTable ?? "asset_entities";
  const sourceId = stringValue(metadata.source_id) ?? parsed?.sourceId ?? vectorId;
  const parentEntityId = stringValue(metadata.parent_entity_id) ?? "";
  const sourceProjectId = stringValue(metadata.source_project_id) ?? "";
  const sourceProjectName = stringValue(metadata.source_project_name) ?? "";
  const assetKind = stringValue(metadata.asset_kind) ?? "";
  const gender = stringValue(metadata.gender) ?? "";
  const approvalState = approvalStateValue(metadata.approval_state);
  const status = stringValue(metadata.status) ?? "";
  const textHash = stringValue(metadata.text_hash) ?? createHash("sha256").update(text, "utf8").digest("hex");
  const embeddingModel = stringValue(metadata.embedding_model) ?? settings.doubaoEmbeddingModel ?? "";
  const enrichedMetadata: JsonObject = {
    ...metadata,
    source_table: sourceTable,
    source_id: sourceId,
    parent_entity_id: parentEntityId || null,
    source_project_id: sourceProjectId || null,
    source_project_name: sourceProjectName || null,
    asset_kind: assetKind || null,
    gender: gender || null,
    approval_state: approvalState,
    status: status || null,
    text_hash: textHash,
    embedding_model: embeddingModel,
    facet: stringValue(metadata.facet) ?? parsed?.facet ?? null,
  };
  return {
    id: vectorId,
    vector,
    text,
    source_table: sourceTable,
    source_id: sourceId,
    parent_entity_id: parentEntityId,
    source_project_id: sourceProjectId,
    source_project_name: sourceProjectName,
    asset_kind: assetKind,
    gender,
    approval_state: approvalState,
    status,
    text_hash: textHash,
    embedding_model: embeddingModel,
    metadata: enrichedMetadata,
  };
}

function mergeV2FieldsIntoMetadata(metadata: JsonObject, entity: Record<string, unknown>): JsonObject {
  const result: JsonObject = { ...metadata };
  for (const field of V2_OUTPUT_FIELDS) {
    if (field === "id" || field === "text" || field === "metadata") continue;
    const value = entity[field];
    if (typeof value === "string") result[field] = value || null;
  }
  return result;
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function approvalStateValue(value: JsonValue | undefined): "approved" | "rejected" | "unknown" {
  return value === "approved" || value === "rejected" || value === "unknown" ? value : "unknown";
}

export function hnswSearchEfForLimit(limit: number): number {
  const searchLimit = normalizeSearchLimit(limit);
  const expanded = Math.max(HNSW_SEARCH_EF_FLOOR, searchLimit * HNSW_SEARCH_EF_MULTIPLIER);
  const softCapped = Math.min(expanded, HNSW_SEARCH_EF_SOFT_MAX);
  return Math.max(searchLimit, softCapped);
}

function normalizeSearchLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.max(1, Math.ceil(limit));
}

function isUnavailableCollectionError(error: unknown): boolean {
  return error instanceof ExternalServiceError
    && error.message === "Milvus: Configured vector collection is unavailable";
}
