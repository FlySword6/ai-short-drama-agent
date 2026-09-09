import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetKindVocabulary,
  assetRoleVocabulary,
  assetTags,
  genreSuggestions,
  referenceLaneVocabulary,
  tagVocabulary,
} from "../../db/schema.js";
import type {
  AssetKindEntry,
  AssetKindVocabularyRepository,
  AssetTagRepository,
  CreateAssetKindInput,
  CreateGenreSuggestionInput,
  CreateTagInput,
  CreateVocabularyEntryInput,
  GenreSuggestion,
  LaneRecommendation,
  TagEntry,
  TagVocabularyRepository,
  VocabularyDomain,
  VocabularyEntry,
  VocabularyRepository,
} from "./types.js";

interface EntryRow {
  id: string;
  displayName: string;
  domain: string;
  pickKind: string | null;
  sort: number;
  active: boolean;
  recommended?: LaneRecommendation[] | null;
}

function toEntry(row: EntryRow): VocabularyEntry {
  return { ...row, domain: row.domain as VocabularyDomain, recommended: row.recommended ?? [] };
}

function toTagEntry(row: typeof tagVocabulary.$inferSelect): TagEntry {
  return {
    id: row.id,
    canonicalId: row.canonicalId,
    domain: row.domain,
    displayName: row.displayName,
    sort: row.sort,
    active: row.active,
  };
}

function toAssetKindEntry(row: typeof assetKindVocabulary.$inferSelect): AssetKindEntry {
  return {
    id: row.id,
    canonicalId: row.canonicalId,
    displayName: row.displayName,
    sort: row.sort,
    active: row.active,
  };
}

export class DrizzleVocabularyRepository implements VocabularyRepository,
  TagVocabularyRepository, AssetKindVocabularyRepository, AssetTagRepository {
  constructor(private readonly db: Database) {}

  async listReferenceLanes(): Promise<VocabularyEntry[]> {
    const rows = await this.db.select()
      .from(referenceLaneVocabulary)
      .orderBy(asc(referenceLaneVocabulary.sort), asc(referenceLaneVocabulary.id));
    return rows.map(toEntry);
  }

  async listAssetRoles(): Promise<VocabularyEntry[]> {
    const rows = await this.db.select()
      .from(assetRoleVocabulary)
      .orderBy(asc(assetRoleVocabulary.sort), asc(assetRoleVocabulary.id));
    return rows.map(toEntry);
  }

  async listGenres(): Promise<GenreSuggestion[]> {
    const rows = await this.db.select({
      id: genreSuggestions.id,
      sort: genreSuggestions.sort,
      active: genreSuggestions.active,
    })
      .from(genreSuggestions)
      .orderBy(asc(genreSuggestions.sort), asc(genreSuggestions.id));
    return rows;
  }

  async createReferenceLane(input: CreateVocabularyEntryInput): Promise<VocabularyEntry> {
    const [row] = await this.db.insert(referenceLaneVocabulary).values({
      id: input.id,
      displayName: input.displayName,
      domain: input.domain,
      pickKind: input.pickKind ?? null,
      sort: input.sort ?? 0,
      recommended: input.recommended ?? [],
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
    }).returning();
    if (!row) throw new Error("Failed to create reference lane");
    return toEntry(row);
  }

  async createAssetRole(input: CreateVocabularyEntryInput): Promise<VocabularyEntry> {
    const [row] = await this.db.insert(assetRoleVocabulary).values({
      id: input.id,
      displayName: input.displayName,
      domain: input.domain,
      pickKind: input.pickKind ?? null,
      sort: input.sort ?? 0,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
    }).returning();
    if (!row) throw new Error("Failed to create asset role");
    return toEntry(row);
  }

  async createGenre(input: CreateGenreSuggestionInput): Promise<GenreSuggestion> {
    const [row] = await this.db.insert(genreSuggestions).values({
      id: input.id,
      sort: input.sort ?? 0,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
    }).returning({
      id: genreSuggestions.id,
      sort: genreSuggestions.sort,
      active: genreSuggestions.active,
    });
    if (!row) throw new Error("Failed to create genre suggestion");
    return row;
  }

  /* ---------------- S41 标签词表(自指 canonical) ---------------- */

  async listTags(): Promise<TagEntry[]> {
    const rows = await this.db.select()
      .from(tagVocabulary)
      .orderBy(asc(tagVocabulary.sort), asc(tagVocabulary.id));
    return rows.map(toTagEntry);
  }

  async findTag(id: string): Promise<TagEntry | null> {
    const [row] = await this.db.select()
      .from(tagVocabulary)
      .where(eq(tagVocabulary.id, id))
      .limit(1);
    return row ? toTagEntry(row) : null;
  }

  async createTag(input: CreateTagInput): Promise<TagEntry> {
    const [row] = await this.db.insert(tagVocabulary).values({
      id: input.id,
      canonicalId: input.canonicalId,
      domain: input.domain ?? "general",
      displayName: input.displayName ?? input.id,
      sort: input.sort ?? 0,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
    }).returning();
    if (!row) throw new Error("Failed to create tag");
    return toTagEntry(row);
  }

  /* ---------------- S41 资产类型词表(自指 canonical) ---------------- */

  async listAssetKinds(): Promise<AssetKindEntry[]> {
    const rows = await this.db.select()
      .from(assetKindVocabulary)
      .orderBy(asc(assetKindVocabulary.sort), asc(assetKindVocabulary.id));
    return rows.map(toAssetKindEntry);
  }

  async findAssetKind(id: string): Promise<AssetKindEntry | null> {
    const [row] = await this.db.select()
      .from(assetKindVocabulary)
      .where(eq(assetKindVocabulary.id, id))
      .limit(1);
    return row ? toAssetKindEntry(row) : null;
  }

  async createAssetKind(input: CreateAssetKindInput): Promise<AssetKindEntry> {
    const [row] = await this.db.insert(assetKindVocabulary).values({
      id: input.id,
      canonicalId: input.canonicalId,
      displayName: input.displayName ?? input.id,
      sort: input.sort ?? 0,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
    }).returning();
    if (!row) throw new Error("Failed to create asset kind");
    return toAssetKindEntry(row);
  }

  /* ---------------- S41 资产标签关联 ---------------- */

  async listByAsset(assetEntityId: string): Promise<TagEntry[]> {
    const rows = await this.db.select({ entry: tagVocabulary })
      .from(assetTags)
      .innerJoin(tagVocabulary, eq(assetTags.tagId, tagVocabulary.id))
      .where(eq(assetTags.assetEntityId, assetEntityId))
      .orderBy(asc(tagVocabulary.sort), asc(tagVocabulary.id));
    return rows.map((row) => toTagEntry(row.entry));
  }

  async attach(input: { assetEntityId: string; tagId: string; createdBy?: string | null }): Promise<boolean> {
    const rows = await this.db.insert(assetTags).values({
      assetEntityId: input.assetEntityId,
      tagId: input.tagId,
      createdBy: input.createdBy ?? null,
      createdAt: new Date(),
    }).onConflictDoNothing().returning({ tagId: assetTags.tagId });
    return rows.length > 0;
  }

  async detach(assetEntityId: string, tagId: string): Promise<void> {
    await this.db.delete(assetTags)
      .where(and(eq(assetTags.assetEntityId, assetEntityId), eq(assetTags.tagId, tagId)));
  }

  async listTagIdsByAssetIds(assetEntityIds: string[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    if (assetEntityIds.length === 0) return result;
    const rows = await this.db.select({
      assetEntityId: assetTags.assetEntityId,
      tagId: assetTags.tagId,
    }).from(assetTags).where(inArray(assetTags.assetEntityId, assetEntityIds));
    for (const row of rows) {
      const set = result.get(row.assetEntityId) ?? new Set<string>();
      set.add(row.tagId);
      result.set(row.assetEntityId, set);
    }
    return result;
  }
}
