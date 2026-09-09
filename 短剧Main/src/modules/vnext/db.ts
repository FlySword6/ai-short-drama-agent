import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { settings } from "../../config/env.js";
import { buildDatabasePoolConfig, type DatabaseHandle } from "../../db/client.js";
import * as schema from "../../db/schema.js";

/**
 * vNext 运行时连接的合同角色:最小权限,只持有 vnext schema 的
 * USAGE 与 SELECT/INSERT/UPDATE(见 src/db/migrations/vnext/001、003)。
 */
export const VNEXT_RUNTIME_ROLE = "vnext_app";
export const VNEXT_OWNER_ROLE = "vnext_owner";

/**
 * vNext 数据面的专用连接池。每条连接在启动时把 `role` GUC 钉成 vnext_app:
 * 独立的 NOINHERIT 登录身份只用来认证与 SET ROLE,真正执行 SQL 的角色永远是
 * 最小权限的 vnext_app——成员资格缺失时连接直接失败(fail-closed),
 * 跨 schema 读写与 DELETE 在数据库层被拒绝,不靠应用层自觉。
 */
export function createVnextDatabase(databaseUrl = settings.vnextDatabaseUrl): DatabaseHandle {
  if (!databaseUrl) {
    throw new Error("VNEXT_DATABASE_URL is required for vNext database operations");
  }
  const pool = new Pool({
    ...buildDatabasePoolConfig(databaseUrl),
    options: `-c role=${VNEXT_RUNTIME_ROLE}`,
  });
  return { db: drizzle(pool, { schema: schema.databaseSchema }), pool };
}
