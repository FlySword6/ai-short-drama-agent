/**
 * UserPreferenceRepositoryImpl —— UserPreferenceRepository 的 Drizzle 实现
 *
 * 来源：grill-engine-design.md §8 阶段 1 步骤 1.6。
 * 职责：读写 user_preferences 表，供 absorb persist 使用。
 */

import { eq } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { userPreferences } from "../../../db/schema.js";
import type { UserPreferenceRepository } from "./absorb.js";

export class UserPreferenceRepositoryImpl implements UserPreferenceRepository {
  constructor(private readonly db: Database) {}

  async upsert(
    userId: string,
    data: {
      preferredGenre?: string | null;
      preferredTone?: string | null;
      styleTags?: string[];
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const existing = await this.db.select().from(userPreferences)
      .where(eq(userPreferences.userId, userId)).limit(1);
    const now = new Date();

    if (existing.length > 0) {
      const row = existing[0]!;
      await this.db.update(userPreferences).set({
        preferredGenre: data.preferredGenre ?? row.preferredGenre,
        preferredTone: data.preferredTone ?? row.preferredTone,
        styleTags: data.styleTags ?? row.styleTags,
        metadata: data.metadata ?? row.metadata,
        updatedAt: now,
      }).where(eq(userPreferences.userId, userId));
      return;
    }

    await this.db.insert(userPreferences).values({
      userId,
      preferredGenre: data.preferredGenre ?? null,
      preferredTone: data.preferredTone ?? null,
      styleTags: data.styleTags ?? [],
      metadata: data.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });
  }

  async getByUserId(userId: string): Promise<{
    preferredGenre: string | null;
    preferredTone: string | null;
    styleTags: string[];
    metadata: Record<string, unknown>;
  } | null> {
    const rows = await this.db.select().from(userPreferences)
      .where(eq(userPreferences.userId, userId)).limit(1);
    if (rows.length === 0) return null;
    const row = rows[0]!;
    return {
      preferredGenre: row.preferredGenre,
      preferredTone: row.preferredTone,
      styleTags: row.styleTags,
      metadata: row.metadata,
    };
  }

  async hasAnyPreference(userId: string): Promise<boolean> {
    const row = await this.getByUserId(userId);
    if (!row) return false;
    return Boolean(
      row.preferredGenre ||
      row.preferredTone ||
      (Array.isArray(row.styleTags) && row.styleTags.length > 0) ||
      (row.metadata && Object.keys(row.metadata).length > 0),
    );
  }

  async getField(userId: string, fieldName: string): Promise<unknown> {
    const row = await this.getByUserId(userId);
    if (!row) return undefined;
    if (fieldName === "preferred_genre" || fieldName === "genre") return row.preferredGenre;
    if (fieldName === "preferred_tone" || fieldName === "tone") return row.preferredTone;
    if (fieldName === "style_tags") return row.styleTags;
    return row.metadata?.[fieldName];
  }
}
