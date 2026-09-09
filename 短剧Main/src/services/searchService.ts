import type { Database } from "../db/client.js";
import type { AssetEntityRow } from "../db/schema.js";
import type { AssetSearchItem, JsonObject } from "../domain/assets/types.js";
import { parseAssetVectorId } from "../domain/assets/vectorKeys.js";
import { ArkChatClient } from "../integrations/arkClient.js";
import type { EmbeddingClient } from "../integrations/embeddingClient.js";
import { DoubaoEmbeddingClient } from "../integrations/embeddingClient.js";
import type { VectorHit } from "../integrations/milvusVectorStore.js";
import { MilvusVectorStore } from "../integrations/milvusVectorStore.js";
import { AssetEntityRepository } from "../repositories/assetEntityRepository.js";
import { AssetSearchRepository } from "../repositories/assetSearchRepository.js";
import { AssetVariantRepository } from "../repositories/assetVariantRepository.js";
import { ExternalServiceError } from "../shared/errors.js";
import { isRecord, parseJsonValue } from "../shared/json.js";
import { unique } from "../shared/values.js";

/**
 * Search only needs the text-completion capability. Keeping this as a narrow
 * port lets a request use the audited AI gateway without changing the legacy
 * search route's default Ark adapter.
 */
export interface TextCompletionPort {
  completeText(prompt: string, system?: string): Promise<string>;
}

export interface QueryUnderstanding {
  sourceProjectNameHint: string | null;
  assetKindHint: string | null;
  nameHint: string | null;
  displayNameHint: string | null;
  introTerms: string[];
  appearanceTerms: string[];
  ageValueHint: number | null;
  heightCmHint: number | null;
  genderHint: string | null;
  categoryHint: string | null;
  styleTags: string[];
  rewrites: string[];
}

type RecallSource = "vector_original" | "vector_rewrite" | "structured_sql";

interface RecallSignal {
  source: RecallSource;
  rank: number;
  score: number;
  recallQuery?: string;
  matchedFields?: string[];
}

interface RecallCandidate {
  key: string;
  source: RecallSource;
  score: number;
  rank: number;
  vectorText: string | null;
  metadata: JsonObject;
  recallSignals: RecallSignal[];
  structuredScore: number;
  matchedFields: string[];
  finalScore?: number;
  rawFusionScore?: number;
}

export interface VectorProjectionFallback {
  source: "embedding" | "milvus";
  /** A stable public code. Never expose provider response text here. */
  reason: "vector_projection_unavailable";
}

/**
 * The asset catalog lives in PostgreSQL. Embeddings and Milvus are only a
 * rebuildable projection, so callers that own a PostgreSQL fallback must be
 * able to distinguish a projection outage from an ordinary empty result.
 */
export interface AssetSearchProjectionResult {
  items: AssetSearchItem[];
  projectionStatus: "available" | "unavailable";
  projectionFallbacks: VectorProjectionFallback[];
}

/**
 * A stable, retryable signal for callers such as the AI asset matcher. It is
 * intentionally an ExternalServiceError so the existing PostgreSQL failover
 * boundary can switch to the source-of-record without importing HTTP code.
 */
export class VectorProjectionUnavailableError extends ExternalServiceError {
  constructor() {
    super("资产语义索引", "暂不可用，已切换到结构化检索");
    this.name = "VectorProjectionUnavailableError";
  }
}

export interface SearchServiceDependencies {
  llm?: TextCompletionPort;
  /** Use the raw query directly. Useful when another bounded AI step owns the
   * request's only model call, such as the AI gateway asset reranker. */
  skipQueryUnderstanding?: boolean;
  embedding?: EmbeddingClient;
  vectors?: MilvusVectorStore;
}

export class AssetSearchService {
  private readonly understanding: QueryUnderstandingService;
  private readonly skipQueryUnderstanding: boolean;
  private readonly embedding: EmbeddingClient;
  private readonly vectors: MilvusVectorStore;
  private readonly entities: AssetEntityRepository;
  private readonly variants: AssetVariantRepository;
  private readonly structured: AssetSearchRepository;

  constructor(db: Database, dependencies: SearchServiceDependencies = {}) {
    this.skipQueryUnderstanding = dependencies.skipQueryUnderstanding ?? false;
    this.understanding = new QueryUnderstandingService(
      dependencies.llm,
      this.skipQueryUnderstanding,
    );
    this.embedding = dependencies.embedding ?? new DoubaoEmbeddingClient();
    this.vectors = dependencies.vectors ?? new MilvusVectorStore();
    this.entities = new AssetEntityRepository(db);
    this.variants = new AssetVariantRepository(db);
    this.structured = new AssetSearchRepository(db);
  }

  async search(query: string, limit = 10, userId?: string): Promise<AssetSearchItem[]> {
    const result = await this.searchWithProjectionStatus(query, limit, userId);
    // A projection outage is never an ordinary empty semantic result. Surface
    // a typed application signal so the caller's explicit PostgreSQL fallback
    // runs. Consumers that deliberately own another fallback policy can use
    // searchWithProjectionStatus() instead of this convenience method.
    if (result.projectionStatus === "unavailable") {
      throw new VectorProjectionUnavailableError();
    }
    return result.items;
  }

  /**
   * Application-level search port for consumers that need to decide their own
   * fallback policy. This does not depend on, or return, HTTP route types.
   */
  async searchWithProjectionStatus(query: string, limit = 10, userId?: string): Promise<AssetSearchProjectionResult> {
    const understanding = await this.understanding.understand(query);
    const queries = unique([query, ...understanding.rewrites].filter(Boolean));
    const candidates = new Map<string, RecallCandidate>();
    const internalLimit = Math.min(Math.max(limit * 5, 20), 50);

    const projectionFallbacks = await recallAssetVectors(
      queries,
      internalLimit,
      this.embedding,
      this.vectors,
      (hits, queryIndex, searchQuery) => {
        this.addVectorHits(candidates, hits, queryIndex === 0 ? "vector_original" : "vector_rewrite", searchQuery);
      },
    );

    // The service reports projection unavailability through a pure
    // application result. In the skip-query-understanding path there are no
    // extracted SQL anchors, so avoid constructing a misleading empty hybrid
    // candidate set; the explicit PostgreSQL fallback will run at the caller.
    if (this.skipQueryUnderstanding && projectionFallbacks.length) {
      return {
        items: [],
        projectionStatus: "unavailable",
        projectionFallbacks,
      };
    }

    // 结构化召回只使用 query understanding 提取出的身份锚点，避免把整句自由文本当成 SQL 模糊查询。
    const structuredQueries = unique([
      understanding.nameHint,
      understanding.displayNameHint,
      understanding.sourceProjectNameHint,
      ...understanding.styleTags,
      ...(projectionFallbacks.length ? postgresFallbackTerms(query) : []),
    ].filter((value): value is string => Boolean(value)));
    for (const structuredQuery of structuredQueries.slice(0, 8)) {
      const entityRows = await this.structured.searchEntities(structuredQuery, Math.max(limit * 2, 40), userId);
      entityRows.forEach((row, index) => {
        const match = scoreStructuredMatch(row, understanding);
        if (match.score < 0.12) return;
        this.addStructuredCandidate(candidates, `asset_entities:${row.id}`, index + 1, {
          source_table: "asset_entities",
          source_id: row.id,
          asset_kind: row.assetKind,
          name: row.name,
          display_name: row.displayName,
          parent_entity_id: null,
          source_project_name: row.sourceProjectName,
          gender: row.gender,
          age_value: row.ageValue,
          height_cm: row.heightCm,
          style_tags: row.styleTags,
        }, match.score, match.fields);
      });
    }

    const scored = [...candidates.values()]
      .map((candidate) => ({ candidate, raw: this.computeFusionScore(candidate, query, understanding) }))
      .sort((left, right) => right.raw - left.raw);

    const seenParentIds = new Set<string>();
    const kept: RecallCandidate[] = [];
    for (const item of scored) {
      const parentId = typeof item.candidate.metadata.parent_entity_id === "string" && item.candidate.metadata.parent_entity_id
        ? item.candidate.metadata.parent_entity_id
        : item.candidate.key.split(":")[1] ?? item.candidate.key;
      const diversityPenalty = seenParentIds.has(parentId) ? 0.20 : 0;
      seenParentIds.add(parentId);
      item.candidate.rawFusionScore = item.raw;
      item.candidate.finalScore = item.raw - diversityPenalty;
      const semanticRelevance = calibrateRelevance(item.candidate.finalScore);
      const postgresFallbackRelevance = projectionFallbacks.length && item.candidate.structuredScore > 0
        ? Math.min(0.7, 0.45 + item.candidate.structuredScore)
        : 0;
      const relevance = Math.max(semanticRelevance, postgresFallbackRelevance);
      if (relevance < 0.45) continue;
      item.candidate.score = relevance;
      kept.push(item.candidate);
      if (kept.length >= Math.max(limit * 2, limit)) break;
    }
    return {
      items: await this.hydrate(kept.slice(0, limit), understanding, userId, projectionFallbacks),
      projectionStatus: projectionFallbacks.length ? "unavailable" : "available",
      projectionFallbacks,
    };
  }

  private addVectorHits(
    map: Map<string, RecallCandidate>,
    hits: VectorHit[],
    source: Exclude<RecallSource, "structured_sql">,
    recallQuery: string,
  ): void {
    hits.forEach((hit, index) => {
      const key = parseVectorHitKey(hit);
      const signal: RecallSignal = { source, rank: index + 1, score: hit.score, recallQuery };
      const previous = map.get(key);
      if (!previous) {
        map.set(key, {
          key,
          source,
          score: hit.score,
          rank: index + 1,
          vectorText: hit.text,
          metadata: hit.metadata,
          recallSignals: [signal],
          structuredScore: 0,
          matchedFields: [],
        });
        return;
      }
      previous.recallSignals.push(signal);
      if (hit.score > previous.score) {
        previous.score = hit.score;
        previous.rank = index + 1;
        previous.vectorText = hit.text;
        previous.source = source;
      }
    });
  }

  private addStructuredCandidate(
    map: Map<string, RecallCandidate>,
    key: string,
    rank: number,
    metadata: JsonObject,
    structuredScore: number,
    matchedFields: string[],
  ): void {
    const signal: RecallSignal = { source: "structured_sql", rank, score: structuredScore, matchedFields };
    const previous = map.get(key);
    if (!previous) {
      map.set(key, {
        key,
        source: "structured_sql",
        score: structuredScore,
        rank,
        vectorText: null,
        metadata,
        recallSignals: [signal],
        structuredScore,
        matchedFields,
      });
      return;
    }
    previous.recallSignals.push(signal);
    previous.structuredScore = Math.max(previous.structuredScore, structuredScore);
    previous.matchedFields = unique([...previous.matchedFields, ...matchedFields]);
    previous.metadata = { ...previous.metadata, ...metadata };
  }

  private computeFusionScore(candidate: RecallCandidate, query: string, understanding: QueryUnderstanding): number {
    let score = 0;
    for (const signal of candidate.recallSignals) {
      const weight = signal.source === "vector_original" ? 1 : signal.source === "vector_rewrite" ? 0.97 : 0.4;
      const rrf = 60 / (60 + signal.rank);
      const cosine = signal.source.startsWith("vector_") ? Math.max(0, Math.min(signal.score, 1)) : 0;
      score += weight * 2 * (0.6 * cosine + 0.4 * rrf);
    }
    if (candidate.recallSignals.length >= 2) {
      score += 0.15 * Math.min(candidate.recallSignals.length - 1, 3);
    }
    if (candidate.structuredScore > 0) score += candidate.structuredScore * 0.4;
    const nameBonus = nameMatchBonus(candidate.metadata, query, understanding);
    if (nameBonus) score += nameBonus;
    return score;
  }

  private async hydrate(
    candidates: RecallCandidate[],
    understanding: QueryUnderstanding,
    userId?: string,
    projectionFallbacks: VectorProjectionFallback[] = [],
  ): Promise<AssetSearchItem[]> {
    const projectionFallbackMetadata: JsonObject[] = projectionFallbacks.map((fallback): JsonObject => ({
      source: fallback.source,
      reason: fallback.reason,
    }));
    const entityIds = candidates.filter((candidate) => candidate.key.startsWith("asset_entities:")).map((candidate) => candidate.key.split(":")[1] ?? "");
    const variantIds = candidates.filter((candidate) => candidate.key.startsWith("asset_variants:")).map((candidate) => candidate.key.split(":")[1] ?? "");
    const [entityRows, variantRows] = await Promise.all([
      this.entities.getByIds(entityIds),
      this.variants.getByIds(variantIds),
    ]);
    const parentIds = variantRows.map((row) => row.assetEntityId);
    const parentRows = await this.entities.getByIds(unique(parentIds));
    const entityMap = new Map([...entityRows, ...parentRows].map((row) => [row.id, row]));
    const variantMap = new Map(variantRows.map((row) => [row.id, row]));

    return (await Promise.all(candidates.map(async (candidate): Promise<AssetSearchItem | null> => {
      const [sourceTable, sourceId] = candidate.key.split(":");
      const entity = sourceTable === "asset_entities" ? entityMap.get(sourceId ?? "") : undefined;
      const variant = sourceTable === "asset_variants" ? variantMap.get(sourceId ?? "") : undefined;
      const parent = variant ? entityMap.get(variant.assetEntityId) : undefined;
      if (!entity && !variant) return null;
      const owningEntity = entity ?? parent;
      if (owningEntity && owningEntity.visibility !== "common" && owningEntity.ownerUserId !== userId) return null;
      if (owningEntity?.visibility === "common" && owningEntity.status !== "approved") return null;
      if (owningEntity?.deletedAt) return null;
      const media = entity
        ? await this.structured.primaryMedia({ assetEntityId: entity.id })
        : variant
          ? (await this.structured.primaryMedia({ assetEntityId: variant.assetEntityId, assetVariantId: variant.id }))
            ?? (await this.structured.primaryMedia({ assetEntityId: variant.assetEntityId }))
          : undefined;
      const primaryImage = media ? {
        storage_bucket: media.storageBucket,
        storage_path: media.storagePath,
        storage_url: media.storageUrl,
        media_kind: media.mediaKind,
        width: media.widthPx,
        height: media.heightPx,
        format: media.format,
        sha256: media.sha256,
        is_primary: media.isPrimary,
      } : undefined;
      const sourceMetadata = entity?.metadata ?? parent?.metadata ?? variant?.metadata ?? {};
      const metadata: JsonObject = {
        ...sourceMetadata,
        ...(primaryImage && !sourceMetadata.primary_image ? { primary_image: primaryImage } : {}),
        multi_query_hit_count: candidate.recallSignals.length,
        search_debug: {
          query_understanding: JSON.parse(JSON.stringify(understanding)),
          recall_source: candidate.source,
          vector_rank: candidate.rank,
          recall_signals: JSON.parse(JSON.stringify(candidate.recallSignals)) as JsonObject,
          structured_score: candidate.structuredScore,
          matched_fields: candidate.matchedFields,
          raw_fusion_score: candidate.rawFusionScore ?? 0,
          final_score: candidate.finalScore ?? candidate.score,
          same_parent_penalty: candidate.finalScore !== candidate.rawFusionScore,
          projection_fallback: projectionFallbackMetadata.length ? projectionFallbackMetadata : null,
        },
      };
      return {
        score: candidate.score,
        sourceTable: sourceTable ?? "",
        sourceId: sourceId ?? "",
        assetKind: entity?.assetKind ?? parent?.assetKind ?? "variant",
        name: entity?.name ?? variant?.name ?? null,
        displayName: entity?.displayName ?? variant?.name ?? parent?.displayName ?? null,
        parentEntityId: parent?.id ?? null,
        parentEntityName: parent?.name ?? null,
        intro: entity?.intro ?? null,
        appearance: entity?.appearance ?? null,
        description: variant?.description ?? null,
        usageContext: variant?.usageContext ?? null,
        visualPrompt: variant?.visualPrompt ?? null,
        sourceFileUrl: entity?.sourceFileUrl ?? variant?.sourceFileUrl ?? media?.storageUrl ?? parent?.sourceFileUrl ?? null,
        metadata,
        vectorText: candidate.vectorText,
      };
    }))).filter((item): item is AssetSearchItem => item !== null);
  }
}

/**
 * Milvus and embeddings are rebuildable projections. Their unavailability must
 * not stop the following PostgreSQL structured recall, but malformed or
 * database errors must still surface to callers.
 */
export async function recallAssetVectors(
  queries: string[],
  limit: number,
  embedding: EmbeddingClient,
  vectors: Pick<MilvusVectorStore, "search">,
  onHits: (hits: VectorHit[], queryIndex: number, query: string) => void,
): Promise<VectorProjectionFallback[]> {
  const fallbacks: VectorProjectionFallback[] = [];
  for (const [queryIndex, query] of queries.entries()) {
    let vector: number[];
    try {
      vector = await embedding.embedText(query);
    } catch (error) {
      if (!isRebuildableVectorDependencyFailure(error)) throw error;
      fallbacks.push({ source: "embedding", reason: publicProjectionFailureReason(error) });
      continue;
    }
    try {
      onHits(await vectors.search(vector, limit), queryIndex, query);
    } catch (error) {
      if (!isRebuildableVectorDependencyFailure(error)) throw error;
      fallbacks.push({ source: "milvus", reason: publicProjectionFailureReason(error) });
    }
  }
  return fallbacks;
}

export function isRebuildableVectorDependencyFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === "ExternalServiceError") return true;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  // @grpc/grpc-js reports transient transport failures with numeric status
  // codes.  They are projection outages, not a reason to fail a PostgreSQL
  // backed search. Keep this list deliberately narrow: malformed requests and
  // authorization errors still surface rather than being hidden as fallback.
  if (code === 4 || code === 14) return true; // DEADLINE_EXCEEDED / UNAVAILABLE
  return typeof code === "string" && [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "DEADLINE_EXCEEDED",
    "UNAVAILABLE",
  ].includes(code);
}

function publicProjectionFailureReason(_error: unknown): "vector_projection_unavailable" {
  // Integration clients can contain raw HTTP response text in Error.message.
  // This value is serialized through search_debug, therefore it must remain a
  // stable public enum rather than a provider-derived string.
  return "vector_projection_unavailable";
}

class QueryUnderstandingService {
  constructor(
    private readonly llm: TextCompletionPort = new ArkChatClient(),
    private readonly skipped = false,
  ) {}

  async understand(query: string): Promise<QueryUnderstanding> {
    if (this.skipped) return emptyQueryUnderstanding();
    const prompt = [
      "你是短剧资产检索的 query understanding 模块。请把自然语言 query 转换为严格 JSON。",
      "不要编造用户没说的信息；rewrites 最多生成 2 条适合向量检索的中文短句。",
      `用户 query：${query}`,
      JSON.stringify({
        source_project_name_hint: null,
        asset_kind_hint: "未知",
        name_hint: null,
        display_name_hint: null,
        intro_terms: [],
        appearance_terms: [],
        age_value_hint: null,
        height_cm_hint: null,
        gender_hint: null,
        category_hint: null,
        style_tags: [],
        rewrites: [],
      }),
    ].join("\n");
    let raw: unknown;
    try {
      raw = parseJsonValue(await this.llm.completeText(prompt));
    } catch {
      raw = {};
    }
    const value = isRecord(raw) ? raw : {};
    return {
      sourceProjectNameHint: stringOrNull(value.source_project_name_hint),
      assetKindHint: stringOrNull(value.asset_kind_hint),
      nameHint: stringOrNull(value.name_hint),
      displayNameHint: stringOrNull(value.display_name_hint),
      introTerms: stringArray(value.intro_terms),
      appearanceTerms: stringArray(value.appearance_terms),
      ageValueHint: numberOrNull(value.age_value_hint),
      heightCmHint: numberOrNull(value.height_cm_hint),
      genderHint: stringOrNull(value.gender_hint),
      categoryHint: stringOrNull(value.category_hint),
      styleTags: stringArray(value.style_tags),
      rewrites: stringArray(value.rewrites).slice(0, 2),
    };
  }
}

function emptyQueryUnderstanding(): QueryUnderstanding {
  return {
    sourceProjectNameHint: null,
    assetKindHint: null,
    nameHint: null,
    displayNameHint: null,
    introTerms: [],
    appearanceTerms: [],
    ageValueHint: null,
    heightCmHint: null,
    genderHint: null,
    categoryHint: null,
    styleTags: [],
    rewrites: [],
  };
}

function scoreStructuredMatch(entity: AssetEntityRow, understanding: QueryUnderstanding): { score: number; fields: string[] } {
  let score = 0;
  const fields: string[] = [];
  if (understanding.nameHint && contains(entity.name, understanding.nameHint) || understanding.nameHint && contains(entity.displayName, understanding.nameHint)) {
    score += 0.15;
    fields.push("name");
  }
  if (understanding.displayNameHint && contains(entity.displayName, understanding.displayNameHint)) {
    score += 0.15;
    fields.push("display_name");
  }
  if (understanding.sourceProjectNameHint && contains(entity.sourceProjectName, understanding.sourceProjectNameHint)) {
    score += 0.08;
    fields.push("source_project_name");
  }
  if (understanding.genderHint && entity.gender === understanding.genderHint) {
    score += 0.06;
    fields.push("gender");
  }
  if (understanding.ageValueHint !== null && entity.ageValue !== null) {
    const distance = Math.abs(entity.ageValue - understanding.ageValueHint);
    if (distance <= 3) {
      score += Math.max(0, 0.08 - distance * 0.02);
      fields.push("age_value");
    }
  }
  if (understanding.heightCmHint !== null && entity.heightCm !== null) {
    const distance = Math.abs(entity.heightCm - understanding.heightCmHint);
    if (distance <= 5) {
      score += Math.max(0, 0.05 - distance * 0.005);
      fields.push("height_cm");
    }
  }
  const tags = new Set((entity.styleTags ?? []).map(normalizeText));
  for (const tag of understanding.styleTags) {
    if (tags.has(normalizeText(tag))) {
      score += 0.05;
      fields.push(`style_tags:${tag}`);
    }
  }
  return { score: Math.min(score, 0.75), fields };
}

function nameMatchBonus(metadata: JsonObject, query: string, understanding: QueryUnderstanding): number {
  const names = [metadata.name, metadata.display_name, metadata.parent_entity_name].filter((value): value is string => typeof value === "string");
  const hints = [understanding.nameHint, understanding.displayNameHint].filter((value): value is string => Boolean(value));
  for (const hint of hints) {
    if (names.some((name) => normalizeText(name) === normalizeText(hint))) return 0.35;
    if (names.some((name) => contains(name, hint))) return 0.25;
  }
  return names.some((name) => normalizeText(query) === normalizeText(name)) ? 0.20 : 0;
}

function contains(value: string | null | undefined, term: string): boolean {
  return Boolean(value && term && normalizeText(value).includes(normalizeText(term)));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[：:()（）\s_\-]/g, "");
}

function calibrateRelevance(rawScore: number): number {
  if (rawScore <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, 1 - Math.exp(-rawScore / 2.75))) * 10000) / 10000;
}

/**
 * 云上 v2 向量集合的主键是复合串 "asset_entities:<uuid>:<facet>"（一个资产按
 * identity/profile/style 多面嵌入）；本地 v1 集合是纯 UUID + metadata.source_table。
 * 统一拆解为 "<table>:<uuid>" 召回 key，同资产多面命中落到同一 key 自然合并。
 */
export function parseVectorHitKey(hit: VectorHit): string {
  const compound = parseAssetVectorId(hit.id);
  const sourceTable = compound?.sourceTable
    ?? (typeof hit.metadata.source_table === "string" ? hit.metadata.source_table : "asset_entities");
  return `${sourceTable}:${compound?.sourceId ?? hit.id}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function postgresFallbackTerms(query: string): string[] {
  const compact = query.trim().replace(/[\s，。！？、；：,!.?;:]/g, "");
  const searchable = compact.replace(/^(想找|搜索|查找|找|需要)/, "");
  const terms: string[] = [];
  for (const length of [2, 3, 4]) {
    for (let start = 0; start + length <= searchable.length; start += 1) {
      terms.push(searchable.slice(start, start + length));
    }
  }
  return unique(terms).slice(0, 12);
}
