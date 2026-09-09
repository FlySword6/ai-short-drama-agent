import type { AssetSearchItem } from "../../domain/assets/types.js";
import type { Database } from "../../db/client.js";
import type { EmbeddingClient } from "../../integrations/embeddingClient.js";
import { DoubaoEmbeddingClient } from "../../integrations/embeddingClient.js";
import type { VectorHit } from "../../integrations/milvusVectorStore.js";
import { MilvusVectorStore } from "../../integrations/milvusVectorStore.js";
import { parseAssetVectorId } from "../../domain/assets/vectorKeys.js";
import type {
  HybridSearchRepositoryPort,
  HybridSearchScope,
} from "./hybridSearchRepository.js";
import { HybridAssetSearchRepository } from "./hybridSearchRepository.js";
import { isRebuildableSearchDependencyFailure } from "./searchFailover.js";

const MAX_PAGE = 100;
const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_ALPHA = 0.5;

type EntitySourceTable = "asset_entities" | "asset_variants";

export interface VisualSearchInput extends HybridSearchScope {
  imageContent: Buffer;
  imageContentType: string | null;
  query?: string;
  alpha?: number;
  page?: number;
  pageSize?: number;
}

export interface MatchedMedia {
  mediaId: string | null;
  storageUrl: string | null;
  matchScore: number;
}

export interface VisualSearchItem extends AssetSearchItem {
  matchedMedia: MatchedMedia | null;
}

export interface VisualSearchDiagnostics {
  status: "results" | "no_results";
  semanticAvailable: boolean;
  fallbackMode: "caption_text" | null;
}

export interface VisualSearchResult {
  items: VisualSearchItem[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  diagnostics: VisualSearchDiagnostics;
}

export interface VisualSearchServiceDependencies {
  repository?: HybridSearchRepositoryPort;
  embedding?: EmbeddingClient;
  vectors?: Pick<MilvusVectorStore, "search">;
}

interface CandidateEntry {
  sourceTable: EntitySourceTable;
  sourceId: string;
  score: number;
  mediaId: string | null;
  mediaUrl: string | null;
}

/**
 * Visual asset search: embed an image (optionally fused with a text query via
 * early fusion) and retrieve visually similar assets from the shared Milvus
 * projection. Media-level hits are aggregated to entity level before hydration.
 */
export class VisualAssetSearchService {
  private readonly repository: HybridSearchRepositoryPort;
  private readonly embedding: EmbeddingClient;
  private readonly vectors: Pick<MilvusVectorStore, "search">;

  constructor(db: Database, dependencies: VisualSearchServiceDependencies = {}) {
    this.repository = dependencies.repository ?? new HybridAssetSearchRepository(db);
    this.embedding = dependencies.embedding ?? new DoubaoEmbeddingClient();
    this.vectors = dependencies.vectors ?? new MilvusVectorStore();
  }

  async search(input: VisualSearchInput): Promise<VisualSearchResult> {
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);
    const candidateLimit = page * pageSize + 1;
    const alpha = input.alpha ?? DEFAULT_ALPHA;

    const vImage = await this.embedding.embedImage(input.imageContent, input.imageContentType);

    let queryVector: number[];
    if (input.query && alpha > 0) {
      const vText = await this.embedding.embedText(input.query);
      queryVector = fuseVectors(vText, vImage, alpha);
    } else {
      queryVector = vImage;
    }

    let hits: VectorHit[];
    let semanticAvailable = true;
    try {
      hits = await this.vectors.search(queryVector, candidateLimit);
    } catch (error) {
      if (isRebuildableSearchDependencyFailure(error)) {
        semanticAvailable = false;
        hits = [];
      } else {
        throw error;
      }
    }

    const candidates = mapHitsToCandidates(hits);
    const ranked = [...candidates].sort((a, b) => b.score - a.score).slice(0, candidateLimit);

    const candidateMap = new Map(
      ranked.map((c) => [candidateKey(c.sourceTable, c.sourceId), c]),
    );

    const hydrated = await this.repository.hydrate(
      ranked.map((c) => ({ sourceTable: c.sourceTable, sourceId: c.sourceId })),
      input,
    );

    const items: VisualSearchItem[] = hydrated.map((item) => {
      const candidate = candidateMap.get(candidateKey(item.sourceTable, item.sourceId));
      return {
        ...item,
        score: candidate?.score ?? item.score,
        semanticHit: true,
        matchedMedia: candidate
          ? {
              mediaId: candidate.mediaId,
              storageUrl: candidate.mediaUrl,
              matchScore: candidate.score,
            }
          : null,
      };
    });

    const pageStart = (page - 1) * pageSize;
    const pagedItems = items.slice(pageStart, pageStart + pageSize);
    const hasMore = items.length > pageStart + pageSize;

    return {
      items: pagedItems,
      page,
      pageSize,
      hasMore,
      diagnostics: {
        status: pagedItems.length > 0 ? "results" : "no_results",
        semanticAvailable,
        fallbackMode: null,
      },
    };
  }
}

function fuseVectors(vText: number[], vImage: number[], alpha: number): number[] {
  if (vText.length !== vImage.length) {
    return vImage.length >= vText.length ? vImage : vText;
  }
  return vText.map((value, index) => alpha * value + (1 - alpha) * vImage[index]!);
}

function mapHitsToCandidates(hits: VectorHit[]): CandidateEntry[] {
  const byKey = new Map<string, CandidateEntry>();
  for (const hit of hits) {
    const parsed = parseAssetVectorId(hit.id);
    if (!parsed) continue;

    if (parsed.sourceTable === "asset_media") {
      const entityId = readMetadataString(hit.metadata, "entity_id");
      if (!entityId) continue;
      upsertCandidate(byKey, "asset_entities", entityId, hit.score, parsed.sourceId, readMetadataString(hit.metadata, "storage_url"));
    } else if (parsed.sourceTable === "asset_entities") {
      upsertCandidate(byKey, "asset_entities", parsed.sourceId, hit.score, null, null);
    } else if (parsed.sourceTable === "asset_variants") {
      upsertCandidate(byKey, "asset_variants", parsed.sourceId, hit.score, null, null);
    }
  }
  return [...byKey.values()];
}

function upsertCandidate(
  map: Map<string, CandidateEntry>,
  sourceTable: EntitySourceTable,
  sourceId: string,
  score: number,
  mediaId: string | null,
  mediaUrl: string | null,
): void {
  const key = candidateKey(sourceTable, sourceId);
  const existing = map.get(key);
  if (!existing || score > existing.score) {
    map.set(key, { sourceTable, sourceId, score, mediaId, mediaUrl });
  }
}

function candidateKey(sourceTable: string, sourceId: string): string {
  return `${sourceTable}:${sourceId}`;
}

function readMetadataString(metadata: Record<string, unknown>, field: string): string | null {
  const value = metadata[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clampPage(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new Error(`page must be an integer between 1 and ${MAX_PAGE}`);
  }
  return value;
}

function clampPageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new Error(`page_size must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}