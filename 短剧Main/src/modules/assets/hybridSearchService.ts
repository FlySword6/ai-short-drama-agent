import type { AssetSearchItem } from "../../domain/assets/types.js";
import type { Database } from "../../db/client.js";
import type { EmbeddingClient } from "../../integrations/embeddingClient.js";
import { DoubaoEmbeddingClient } from "../../integrations/embeddingClient.js";
import type { VectorHit } from "../../integrations/milvusVectorStore.js";
import { MilvusVectorStore } from "../../integrations/milvusVectorStore.js";
import { parseAssetVectorId } from "../../domain/assets/vectorKeys.js";
import type {
  HybridLexicalCandidate,
  HybridSearchKey,
  HybridSearchRepositoryPort,
  HybridSearchScope,
} from "./hybridSearchRepository.js";
import { HybridAssetSearchRepository } from "./hybridSearchRepository.js";

const SEMANTIC_SCORE_WEIGHT = 0.95;
const LEXICAL_SCORE_WEIGHT = 0.05;
// This protects one request without copying the old catalog's hidden 500-item
// truncation. The recall window always grows with the requested page.
const MAX_PAGE = 100;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;

export type HybridSearchDiagnosis =
  | "ranking_issue"
  | "retriever_no_recall"
  | "query_expression_problem"
  | "true_absence";

export interface HybridSearchInput extends HybridSearchScope {
  query: string;
  page?: number;
  pageSize?: number;
}

export interface HybridSearchDiagnostics {
  status: "results" | "no_results";
  /** Present when an empty page needs an operationally useful explanation. */
  reason?: HybridSearchDiagnosis;
  lexicalAvailable: true;
  semanticAvailable: boolean;
  /** Only an intent prefix may be removed, and only once after no initial hit. */
  relaxedOnce: boolean;
}

export interface HybridSearchResult {
  items: AssetSearchItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  diagnostics: HybridSearchDiagnostics;
}

export interface HybridSearchServiceDependencies {
  repository?: HybridSearchRepositoryPort;
  embedding?: EmbeddingClient;
  vectors?: Pick<MilvusVectorStore, "search">;
  lexicalTokenizer?: HybridSearchLexicalTokenizer;
}

export interface HybridSearchLexicalTokenizerInput extends HybridSearchScope {
  query: string;
}

export interface HybridSearchLexicalTokenizer {
  tokenize(input: HybridSearchLexicalTokenizerInput): Promise<string[]>;
}

interface SemanticRecall {
  candidates: HybridSemanticCandidate[];
  available: boolean;
}

interface HybridSemanticCandidate extends HybridSearchKey {
  semanticScore?: number | null;
}

interface RankedCandidate extends HybridSearchKey {
  score: number;
  lexicalScore?: number | null;
  semanticScore?: number | null;
  lexicalRank?: number | null;
  semanticRank?: number | null;
}

/**
 * New v0.2 hybrid search deliberately does not call an LLM. Query rewriting
 * would be an AI action and must go through /api/v1/ai/* with an ai_calls
 * record; this first version keeps retrieval deterministic and auditable.
 */
export class HybridAssetSearchService {
  private readonly repository: HybridSearchRepositoryPort;
  private readonly embedding: EmbeddingClient;
  private readonly vectors: Pick<MilvusVectorStore, "search">;
  private readonly lexicalTokenizer: HybridSearchLexicalTokenizer | undefined;

  constructor(db: Database, dependencies: HybridSearchServiceDependencies = {}) {
    this.repository = dependencies.repository ?? new HybridAssetSearchRepository(db);
    this.embedding = dependencies.embedding ?? new DoubaoEmbeddingClient();
    this.vectors = dependencies.vectors ?? new MilvusVectorStore();
    this.lexicalTokenizer = dependencies.lexicalTokenizer;
  }

  async search(input: HybridSearchInput): Promise<HybridSearchResult> {
    const request = normalizeInput(input);
    // Request one candidate beyond the requested page. This makes pagination
    // honest even when one recall source has more material than the other.
    // There is deliberately no fixed 500-candidate ceiling.
    const candidateLimit = request.page * request.pageSize + 1;

    const [initialLexical, semantic] = await Promise.all([
      this.lexicalRecall(request.query, request.scope, candidateLimit),
      this.semanticRecall(request.query, candidateLimit, request.scope),
    ]);

    let lexical = initialLexical;
    let relaxedOnce = false;
    const relaxedQuery = relaxLowConfidenceIntentPrefix(request.query);
    // A visible semantic hit is already enough to avoid changing the user's
    // expression. When nothing recalls, retry just one low-confidence prefix;
    // explicit object, style, authorization and safety words are untouched.
    if (!lexical.length && !semantic.candidates.length && relaxedQuery) {
      lexical = await this.lexicalRecall(relaxedQuery, request.scope, candidateLimit);
      relaxedOnce = true;
    }

    const ranked = rankWithWeightedSemanticLexical(lexical, semantic.candidates);
    const hydrated = await this.repository.hydrate(ranked, request.scope);
    const items = orderHydratedItems(ranked, hydrated);
    const rankedByKey = new Map(ranked.map((candidate) => [candidateKey(candidate), candidate]));
    const pageStart = (request.page - 1) * request.pageSize;
    const pageItems = items.slice(pageStart, pageStart + request.pageSize).map((item) => {
      const rankedItem = rankedByKey.get(candidateKey(item));
      return {
        ...item,
        score: rankedItem?.score ?? null,
        lexicalHit: rankedItem?.lexicalScore !== null && rankedItem?.lexicalScore !== undefined,
        semanticHit: rankedItem?.semanticScore !== null && rankedItem?.semanticScore !== undefined,
      };
    });

    return {
      items: pageItems,
      page: request.page,
      pageSize: request.pageSize,
      hasMore: hasMoreResults({
        itemCount: items.length,
        pageStart,
        pageSize: request.pageSize,
        lexicalCandidateCount: lexical.length,
        semanticCandidateCount: semantic.candidates.length,
        candidateLimit,
      }),
      diagnostics: diagnosticsFor({
        itemCount: items.length,
        rankedCount: ranked.length,
        pageStart,
        semanticAvailable: semantic.available,
        relaxedOnce,
      }),
    };
  }

  private async semanticRecall(query: string, limit: number, scope: HybridSearchScope): Promise<SemanticRecall> {
    try {
      const vector = await this.embedding.embedText(query);
      const hits = await this.vectors.search(vector, limit, vectorFilterForScope(scope));
      return { candidates: vectorCandidates(hits), available: true };
    } catch (error) {
      if (!isRebuildableVectorDependencyFailure(error)) throw error;
      // Milvus and embedding are rebuildable projections. PostgreSQL lexical
      // search remains available; do not leak provider errors to the route.
      return { candidates: [], available: false };
    }
  }

  private async lexicalRecall(
    query: string,
    scope: HybridSearchScope,
    limit: number,
  ): Promise<HybridLexicalCandidate[]> {
    let lexicalTokens: string[] | undefined;
    if (this.lexicalTokenizer) {
      try {
        const tokens = await this.lexicalTokenizer.tokenize({ query, ...scope });
        lexicalTokens = tokens.length ? tokens : undefined;
      } catch {
        // LLM tokenization is only a precision aid. Formal retrieval must keep
        // working with deterministic Jieba/fallback tokens when the AI gateway,
        // provider, quota or response contract is unavailable.
      }
    }
    return this.repository.lexicalRecall(query, scope, limit, lexicalTokens);
  }
}

function vectorFilterForScope(scope: HybridSearchScope): string | undefined {
  const conditions: string[] = [];
  if (scope.sourceProjectId) {
    conditions.push(`source_project_id == ${JSON.stringify(scope.sourceProjectId)}`);
  }
  return conditions.length ? conditions.join(" and ") : undefined;
}

export function rankWithWeightedSemanticLexical(
  lexical: HybridLexicalCandidate[],
  semantic: HybridSemanticCandidate[],
): RankedCandidate[] {
  const combined = new Map<string, RankedCandidate>();
  addRanked(combined, lexical.map((candidate) => ({ ...candidate })), "lexical");
  addRanked(combined, semantic, "semantic");
  for (const candidate of combined.values()) {
    candidate.score = weightedSemanticLexicalScore(candidate.semanticScore, candidate.lexicalScore);
  }
  return [...combined.values()].sort((left, right) => (
    right.score - left.score
    || rankSortValue(left.semanticRank) - rankSortValue(right.semanticRank)
    || rankSortValue(left.lexicalRank) - rankSortValue(right.lexicalRank)
    || left.sourceTable.localeCompare(right.sourceTable)
    || left.sourceId.localeCompare(right.sourceId)
  ));
}

export function rankWithReciprocalRankFusion(
  lexical: HybridLexicalCandidate[],
  semantic: HybridSearchKey[],
): RankedCandidate[] {
  const combined = new Map<string, RankedCandidate>();
  lexical.forEach((candidate, index) => {
    const key = candidateKey(candidate);
    combined.set(key, {
      ...candidate,
      score: reciprocalRankScore(index + 1),
      lexicalScore: candidate.relevance,
      lexicalRank: index + 1,
    });
  });
  semantic.forEach((candidate, index) => {
    const key = candidateKey(candidate);
    const current = combined.get(key) ?? { ...candidate, score: 0 };
    current.score += reciprocalRankScore(index + 1);
    current.semanticRank = index + 1;
    combined.set(key, current);
  });
  return [...combined.values()].sort((left, right) => (
    right.score - left.score
    || rankSortValue(left.semanticRank) - rankSortValue(right.semanticRank)
    || rankSortValue(left.lexicalRank) - rankSortValue(right.lexicalRank)
    || left.sourceTable.localeCompare(right.sourceTable)
    || left.sourceId.localeCompare(right.sourceId)
  ));
}

function addRanked(
  combined: Map<string, RankedCandidate>,
  candidates: Array<HybridSearchKey & { relevance?: number; semanticScore?: number | null }>,
  source: "lexical" | "semantic",
): void {
  candidates.forEach((candidate, index) => {
    const key = candidateKey(candidate);
    const current = combined.get(key) ?? { ...candidate, score: 0 };
    if (source === "lexical") {
      current.lexicalScore = numberOrNull(candidate.relevance);
      current.lexicalRank = index + 1;
    }
    if (source === "semantic") {
      current.semanticScore = numberOrNull(candidate.semanticScore);
      current.semanticRank = index + 1;
    }
    combined.set(key, current);
  });
}

function weightedSemanticLexicalScore(
  semanticScore: number | null | undefined,
  lexicalScore: number | null | undefined,
): number {
  return (semanticScore ?? 0) * SEMANTIC_SCORE_WEIGHT
    + (lexicalScore ?? 0) * LEXICAL_SCORE_WEIGHT;
}

function reciprocalRankScore(rank: number): number {
  return 1 / (60 + rank);
}

function vectorCandidates(hits: VectorHit[]): HybridSemanticCandidate[] {
  const keys = new Map<string, HybridSemanticCandidate>();
  for (const hit of hits) {
    const key = parseVectorHitKey(hit);
    const parsed = parseKey(key);
    if (parsed && !keys.has(key)) keys.set(key, { ...parsed, semanticScore: numberOrNull(hit.score) });
  }
  return [...keys.values()];
}

export function parseVectorHitKey(hit: VectorHit): string {
  const compound = parseAssetVectorId(hit.id);
  const sourceTable = compound?.sourceTable
    ?? (typeof hit.metadata.source_table === "string" ? hit.metadata.source_table : "asset_entities");
  return `${sourceTable}:${compound?.sourceId ?? hit.id}`;
}

export function isRebuildableVectorDependencyFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === "ExternalServiceError") return true;
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
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

function orderHydratedItems(ranked: RankedCandidate[], hydrated: AssetSearchItem[]): AssetSearchItem[] {
  const hydratedByKey = new Map(hydrated.map((item) => [candidateKey(item), item]));
  return ranked.flatMap((candidate) => {
    const item = hydratedByKey.get(candidateKey(candidate));
    return item ? [item] : [];
  });
}

function diagnosticsFor(input: {
  itemCount: number;
  rankedCount: number;
  pageStart: number;
  semanticAvailable: boolean;
  relaxedOnce: boolean;
}): HybridSearchDiagnostics {
  if (input.itemCount > input.pageStart) {
    return {
      status: "results",
      lexicalAvailable: true,
      semanticAvailable: input.semanticAvailable,
      relaxedOnce: input.relaxedOnce,
      ...(input.relaxedOnce ? { reason: "query_expression_problem" as const } : {}),
    };
  }
  let reason: HybridSearchDiagnosis;
  if (input.rankedCount > 0) {
    // A projection can hold a stale key, or a result can be removed after
    // recall. The route exposes this stable diagnosis instead of hidden IDs.
    reason = "ranking_issue";
  } else if (input.relaxedOnce) {
    reason = "query_expression_problem";
  } else if (!input.semanticAvailable) {
    reason = "retriever_no_recall";
  } else {
    reason = "true_absence";
  }
  return {
    status: "no_results",
    reason,
    lexicalAvailable: true,
    semanticAvailable: input.semanticAvailable,
    relaxedOnce: input.relaxedOnce,
  };
}

function hasMoreResults(input: {
  itemCount: number;
  pageStart: number;
  pageSize: number;
  lexicalCandidateCount: number;
  semanticCandidateCount: number;
  candidateLimit: number;
}): boolean {
  if (input.itemCount > input.pageStart + input.pageSize) return true;
  if (input.pageStart >= input.candidateLimit) return false;
  // A source that filled its requested window may have candidates beyond the
  // hydrated set (for example stale semantic keys). Keep continuation honest
  // rather than incorrectly telling the client that the search is exhausted.
  return input.lexicalCandidateCount >= input.candidateLimit
    || input.semanticCandidateCount >= input.candidateLimit;
}

function normalizeInput(input: HybridSearchInput): {
  query: string;
  page: number;
  pageSize: number;
  scope: HybridSearchScope;
} {
  const query = input.query.trim().replace(/\s+/g, " ");
  if (!query) throw new Error("混合检索需要非空 query");
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) throw new Error(`page 必须是 1 到 ${MAX_PAGE} 之间的整数`);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`page_size 必须是 1 到 ${MAX_PAGE_SIZE} 之间的整数`);
  }
  return {
    query,
    page,
    pageSize,
    scope: {
      actorId: input.actorId,
      ...(input.libraryScope ? { libraryScope: input.libraryScope } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.sourceProjectId ? { sourceProjectId: input.sourceProjectId } : {}),
    },
  };
}

/**
 * The only automatic relaxation: remove a human phrasing prefix. It cannot
 * remove terms after the prefix, so explicit asset/style/rights/safety
 * constraints are never silently weakened.
 */
export function relaxLowConfidenceIntentPrefix(query: string): string | null {
  const compact = query.trim();
  const relaxed = compact.replace(/^(?:我想|我需要|帮我)?(?:找一下|搜索|查找|找)/, "").trim();
  return relaxed && relaxed !== compact ? relaxed : null;
}

function parseKey(value: string): HybridSearchKey | null {
  const match = /^(asset_entities|asset_variants):(.+)$/.exec(value);
  const sourceTable = match?.[1];
  const sourceId = match?.[2];
  return sourceTable && sourceId
    ? { sourceTable: sourceTable as HybridSearchKey["sourceTable"], sourceId }
    : null;
}

function candidateKey(candidate: { sourceTable: string; sourceId: string }): string {
  return `${candidate.sourceTable}:${candidate.sourceId}`;
}

function rankSortValue(rank: number | null | undefined): number {
  return rank ?? Number.MAX_SAFE_INTEGER;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
