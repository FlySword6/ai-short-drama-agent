import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { configEntries, type ConfigEntryRow } from "../../db/schema.js";
import type {
  ConfigEntriesRepository,
  ConfigEntry,
  ConfigEntryKind,
  ConfigEntryStatus,
  CreateConfigEntryInput,
  UpdateConfigEntryInput,
} from "./types.js";

function toEntry(row: ConfigEntryRow): ConfigEntry {
  return {
    id: row.id,
    kind: row.kind as ConfigEntryKind,
    entryKey: row.entryKey,
    status: row.status as ConfigEntryStatus,
    sort: row.sort,
    payload: row.payload,
    source: row.source,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleConfigEntriesRepository implements ConfigEntriesRepository {
  constructor(private readonly db: Database) {}

  async listPublishedByKind(kind: ConfigEntryKind): Promise<ConfigEntry[]> {
    const rows = await this.db.select()
      .from(configEntries)
      .where(and(eq(configEntries.kind, kind), eq(configEntries.status, "published")))
      .orderBy(asc(configEntries.sort), asc(configEntries.entryKey));
    return rows.map(toEntry);
  }

  async listByKind(kind: ConfigEntryKind): Promise<ConfigEntry[]> {
    const rows = await this.db.select()
      .from(configEntries)
      .where(eq(configEntries.kind, kind))
      .orderBy(asc(configEntries.sort), asc(configEntries.entryKey));
    return rows.map(toEntry);
  }

  async create(input: CreateConfigEntryInput): Promise<ConfigEntry> {
    const now = new Date();
    const [row] = await this.db.insert(configEntries).values({
      id: randomUUID(),
      kind: input.kind,
      entryKey: input.entryKey,
      status: input.status ?? "published",
      sort: input.sort ?? 0,
      payload: input.payload,
      source: "admin",
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedBy: input.createdBy ?? null,
      updatedAt: now,
    }).returning();
    if (!row) throw new Error("Failed to create config entry");
    return toEntry(row);
  }

  async update(id: string, kind: ConfigEntryKind, input: UpdateConfigEntryInput): Promise<ConfigEntry | null> {
    const patch: Partial<typeof configEntries.$inferInsert> = { updatedAt: new Date() };
    if (input.entryKey !== undefined) patch.entryKey = input.entryKey;
    if (input.status !== undefined) patch.status = input.status;
    if (input.sort !== undefined) patch.sort = input.sort;
    if (input.payload !== undefined) patch.payload = input.payload;
    if (input.updatedBy !== undefined) patch.updatedBy = input.updatedBy;
    const [row] = await this.db.update(configEntries)
      .set(patch)
      .where(and(eq(configEntries.id, id), eq(configEntries.kind, kind)))
      .returning();
    return row ? toEntry(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db.delete(configEntries)
      .where(eq(configEntries.id, id))
      .returning({ id: configEntries.id });
    return rows.length > 0;
  }
}
