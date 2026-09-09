import { readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { isPostgresUndefinedTable } from "../../shared/errors.js";

/**
 * /ready 的三段真就绪校验:连通性 → 目标 schema 存在 → 迁移版本追平代码。
 * 只查库,不查密码;任何失败原因都以机器可判读的枚举返回,且响应体只允许
 * 出现版本号、schema 名与原因枚举(未鉴权端点,泄露即事故)。
 */

export type ReadinessFailureReason =
  | "db_unreachable"
  | "schema_missing"
  | "migrations_not_applied"
  | "migration_behind"
  | "expected_unknown";

export interface ReadinessFailure {
  reason: ReadinessFailureReason;
  schema: string;
  dbVersion?: string;
  expected?: string;
}

export interface ExpectedMigration {
  /** schema_migrations.version 里应出现的完整文件名。 */
  fileName: string;
  /** 对外展示与比较用的零填充数字前缀(如 "020")。 */
  version: string;
}

// 与迁移执行器保持同一文件名约定;只读推导,不共享可写逻辑。
const migrationFilePattern = /^(\d+)_[a-z0-9_]+\.sql$/;
// 与 db/migrate.ts 的 schema 名约束一致,用于安全的标识符拼接。
const safeSchemaNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** 期望版本从 migrations/ 目录实际文件推导,绝不硬编码数字。 */
export function resolveExpectedMigration(migrationsDirectory: string): ExpectedMigration | undefined {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDirectory);
  } catch {
    return undefined;
  }
  const candidates = entries
    .filter((fileName) => migrationFilePattern.test(fileName))
    .sort((left, right) => left.localeCompare(right));
  const latest = candidates.at(-1);
  const match = latest?.match(migrationFilePattern);
  if (!latest || !match?.[1]) return undefined;
  return { fileName: latest, version: match[1] };
}

/** schema_migrations.version 对外只展示数字前缀;异常格式原样透出(仍只是版本号)。 */
function displayVersion(fileName: string): string {
  return migrationFilePattern.exec(fileName)?.[1] ?? fileName;
}

export interface ReadinessCheckOptions {
  schemaName: string;
  migrationsDirectory?: string;
}

export async function checkReadiness(
  db: Database,
  options: ReadinessCheckOptions,
): Promise<ReadinessFailure | null> {
  const { schemaName } = options;
  const migrationsDirectory = options.migrationsDirectory ?? path.resolve("migrations");

  // 1. 连通性:select 1。连不上(网络/认证/实例不可达)都归 db_unreachable,
  //    细节只进服务端日志,不进响应体。
  try {
    await db.execute(sql`select 1`);
  } catch {
    return { reason: "db_unreachable", schema: schemaName };
  }

  // 不合法的 schema 名永远不可能成为有效目标(迁移器也会拒绝),按缺失处理。
  if (!safeSchemaNamePattern.test(schemaName)) {
    return { reason: "schema_missing", schema: schemaName };
  }

  // 2. 目标 schema 存在。
  let schemaExists = false;
  try {
    const result = await db.execute<{ exists: boolean }>(
      sql`select exists(select 1 from pg_namespace where nspname = ${schemaName}) as "exists"`,
    );
    schemaExists = result.rows[0]?.exists === true;
  } catch {
    return { reason: "db_unreachable", schema: schemaName };
  }
  if (!schemaExists) {
    return { reason: "schema_missing", schema: schemaName };
  }

  // 3. schema_migrations 最高版本 == 代码期望的最高迁移版本。
  const expected = resolveExpectedMigration(migrationsDirectory);
  if (!expected) {
    // 部署包缺 migrations/ 目录是发布缺陷,探针必须喊出来,不许静默放过。
    return { reason: "expected_unknown", schema: schemaName };
  }
  let dbVersion: string | null;
  try {
    const result = await db.execute<{ max_version: string | null }>(
      sql.raw(`select max("version") as "max_version" from "${schemaName}"."schema_migrations"`),
    );
    dbVersion = result.rows[0]?.max_version ?? null;
  } catch (error) {
    // 表不存在 = schema 建好但从未执行迁移。
    if (isPostgresUndefinedTable(error)) {
      dbVersion = null;
    } else {
      return { reason: "db_unreachable", schema: schemaName };
    }
  }
  if (!dbVersion) {
    return { reason: "migrations_not_applied", schema: schemaName, expected: expected.version };
  }
  if (dbVersion !== expected.fileName) {
    return {
      reason: "migration_behind",
      schema: schemaName,
      dbVersion: displayVersion(dbVersion),
      expected: expected.version,
    };
  }
  return null;
}
