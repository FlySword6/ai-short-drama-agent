import { boolean, jsonb, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { common, sessions, users } from "../../../db/schema.js";
import { adminUserActionKinds, type AdminUserActionKind } from "./types.js";

const utcTimestamp = (name: string) => timestamp(name, { mode: "date", withTimezone: true });

/**
 * Module-local Drizzle definition. The integration owner will add the same
 * table to the shared schema after assigning the migration number.
 */
export const adminUserActions = common.table("admin_user_actions", {
  id: uuid("id").primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  actorSessionId: uuid("actor_session_id").references(() => sessions.id, { onDelete: "set null" }),
  targetUserId: uuid("target_user_id").references(() => users.id),
  action: varchar("action", { length: 32 }).$type<AdminUserActionKind>().notNull(),
  fromActive: boolean("from_active"),
  toActive: boolean("to_active"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
});

// Keep the runtime list imported by this module so action spellings cannot
// drift silently from the migration SQL copied into the handoff receipt.
export const supportedAdminUserActions: readonly AdminUserActionKind[] = adminUserActionKinds;
