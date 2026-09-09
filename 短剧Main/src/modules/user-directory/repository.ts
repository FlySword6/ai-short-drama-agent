import { and, asc, eq, ilike, or } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { users } from "../../db/schema.js";
import type { DirectoryUser, UserDirectoryStore } from "./types.js";

export const USER_DIRECTORY_RESULT_LIMIT = 20;

/**
 * Read model for the project-member picker. The database remains the source
 * of truth; this module deliberately does not reuse the broader admin-user
 * read model because that response contains role and lifecycle details.
 */
export class UserDirectoryRepository implements UserDirectoryStore {
  constructor(private readonly db: Database) {}

  async searchActiveUsers(query: string, requestedLimit: number): Promise<DirectoryUser[]> {
    const limit = Math.min(Math.max(1, requestedLimit), USER_DIRECTORY_RESULT_LIMIT);
    const trimmed = query.trim();
    const pattern = `%${escapeLikePattern(trimmed)}%`;
    const rows = await this.db.select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      active: users.active,
    }).from(users).where(and(
      eq(users.active, true),
      ...(trimmed ? [or(ilike(users.username, pattern), ilike(users.displayName, pattern))] : []),
    )).orderBy(
      asc(users.displayName),
      asc(users.username),
      asc(users.id),
    ).limit(limit);

    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      active: row.active,
    }));
  }
}

/** Treat `%`, `_`, and `\\` as ordinary user input rather than LIKE syntax. */
export function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
