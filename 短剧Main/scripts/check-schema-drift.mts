#!/usr/bin/env tsx
/**
 * schema.ts 与 migrations/*.sql 的漂移检测。S22 数据库工程护栏 B 包。
 *
 * 项目有两份结构真源:Drizzle 定义(src/db/schema.ts)和 SQL 迁移(migrations/)。
 * 本检查把迁移全量重放到一个临时 schema,把结果与 schema.ts 期望的表/列/类型/
 * 可空性逐一比对,不一致就报。只连本机/本地 Compose PostgreSQL,拒绝任何云库。
 *
 * 用法:
 *   tsx scripts/check-schema-drift.mts --database-url postgresql://…
 *   SCHEMA_DRIFT_DATABASE_URL=postgresql://… tsx scripts/check-schema-drift.mts
 *   scripts/check-schema-drift-docker.sh   # 无本地库时起一个一次性 postgres:14 容器
 *
 * 目标 schema 默认 s22_drift_check,每次运行都 DROP … CASCADE 后重放(它只属于
 * 本检查);真实业务 schema 名(app/common/public/prod/shortdrama_test)一律拒绝。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { isTable } from "drizzle-orm";

export const defaultDriftSchema = "s22_drift_check";
const localHosts = new Set(["127.0.0.1", "localhost", "::1", "db", "postgres"]);
const protectedSchemas = new Set(["app", "common", "public", "prod", "shortdrama_test"]);

/** 迁移创建但刻意不进 Drizzle schema 的对象——每一项都要有理由。 */
export const sqlOwnedObjects = new Map<string, string>([
  ["schema_migrations", "迁移器自建的应用台账(runMigrations),不属于业务结构"],
  ["admin_user_actions", "迁移 010 遗留管理审计表,src/modules/admin/users/table.ts 用原生 SQL 访问"],
  ["control_packages", "迁移 013 控制包,src/modules/control-packages/repository.ts 用原生 SQL 访问"],
  ["control_package_refs", "迁移 013 控制包引用栏,同上"],
  ["director_scenes", "迁移 004 导演台场景,src/modules/director/scene/repository.ts 用原生 SQL 访问"],
  ["director_scene_versions", "迁移 004 导演台场景版本,同上"],
  ["legacy_identity_crosswalk", "迁移 023 合流 ETL 的身份对照表,scripts/legacy-merge-etl 用原生 SQL 访问,不属于应用运行时结构"],
  ["legacy_import_runs", "迁移 023 合流 ETL 运行账,同上"],
  ["legacy_import_closures", "迁移 023 合流 ETL 实体闭包记录,同上"],
  ["seedance_self_produced_trust", "迁移 035 建表、073 退役删除,非当前运行时结构"],
]);

export function assertLocalDatabaseUrl(databaseUrl: string): void {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("数据库连接串无法解析");
  }
  if (!localHosts.has(host)) {
    throw new Error(`漂移检测只允许本机或本地 Compose PostgreSQL(主机 ${host} 被拒绝),绝不连云库`);
  }
}

export function assertDriftSchemaName(schema: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(`漂移检测 schema 名非法: ${schema}`);
  }
  if (protectedSchemas.has(schema)) {
    throw new Error(`漂移检测拒绝触碰真实业务 schema: ${schema}——本检查会 DROP 目标 schema 后重放`);
  }
}

export interface DriftReport {
  issues: string[];
  stats: { tablesCompared: number; columnsCompared: number; viewsCompared: number; migrationsApplied: number };
}

interface ExpectedColumn { type: string; notNull: boolean }
interface ActualColumn { dataType: string; charMaxLength: number | null; isNullable: boolean }

function normalizeExpectedType(sqlType: string): string {
  const lowered = sqlType.trim().toLowerCase();
  const varchar = /^varchar\((\d+)\)$/.exec(lowered);
  if (varchar) return `character varying(${varchar[1]})`;
  if (lowered === "timestamp") return "timestamp without time zone";
  // PostgreSQL exposes serial pseudo-types through information_schema as
  // their underlying integer type; the sequence/default is verified by the
  // migration replay itself, not as a distinct column data_type.
  if (lowered === "bigserial") return "bigint";
  return lowered;
}

function normalizeActualType(column: ActualColumn): string {
  if (column.dataType === "character varying") return `character varying(${column.charMaxLength})`;
  return column.dataType;
}

/** PgView(含 existing()):名字挂在 ViewBaseConfig 符号下;表走 isTable。 */
export function getDrizzleViewName(value: unknown): string | undefined {
  const config = (value as Record<symbol, { name?: string }> | null | undefined)?.[Symbol.for("drizzle:ViewBaseConfig")];
  return config?.name;
}

function isDrizzleView(value: unknown): boolean {
  return getDrizzleViewName(value) !== undefined;
}

/** 读取 Drizzle 期望:表→列(类型/可空),以及 existing() 视图名。输入为 schema 模块的全部导出值。 */
export function readDrizzleExpectations(exportedValues: unknown[]): {
  tables: Map<string, Map<string, ExpectedColumn>>;
  views: Set<string>;
} {
  const tables = new Map<string, Map<string, ExpectedColumn>>();
  const views = new Set<string>();
  for (const value of exportedValues) {
    if (isTable(value)) {
      const config = getTableConfig(value as PgTable);
      const columns = new Map<string, ExpectedColumn>();
      for (const column of config.columns) {
        columns.set(column.name, { type: normalizeExpectedType(column.getSQLType()), notNull: column.notNull });
      }
      tables.set(config.name, columns);
      continue;
    }
    const viewName = getDrizzleViewName(value);
    if (viewName) views.add(viewName);
  }
  return { tables, views };
}

interface AppModules {
  Pool: typeof import("pg").Pool;
  createDatabase: typeof import("../src/db/client.js").createDatabase;
  quoteIdentifier: typeof import("../src/db/migrate.js").quoteIdentifier;
  runMigrations: typeof import("../src/db/migrate.js").runMigrations;
  schemaModule: Record<string, unknown> & { databaseSchema: Record<string, unknown> };
}

/** settings 在 import 时冻结,必须先钉 schema 再加载应用模块。 */
async function loadAppModules(schema: string): Promise<AppModules> {
  process.env.POSTGRES_SCHEMA = schema;
  const [pg, client, migrate, schemaModule] = await Promise.all([
    import("pg"),
    import("../src/db/client.js"),
    import("../src/db/migrate.js"),
    import("../src/db/schema.js"),
  ]);
  return {
    Pool: pg.Pool,
    createDatabase: client.createDatabase,
    quoteIdentifier: migrate.quoteIdentifier,
    runMigrations: migrate.runMigrations,
    schemaModule: schemaModule as AppModules["schemaModule"],
  };
}

/** 声明的扩展是 DBA 预置条件:本地临时库里由本检查按 extensions.json 登记预装。 */
async function ensureDeclaredExtensions(
  admin: { query: (sql: string) => Promise<unknown> },
  migrationsDirectory: string,
  quoteIdentifier: (name: string) => string,
): Promise<void> {
  const registry = JSON.parse(
    await readFile(path.join(migrationsDirectory, "extensions.json"), "utf8"),
  ) as { extensions: Array<{ name: string }> };
  for (const entry of registry.extensions) {
    await admin.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(entry.name)}`);
  }
}

/**
 * 重放准备:DROP 目标 schema(它只属于本检查)后按 extensions.json 预装扩展、
 * 全量重放迁移。返回实际应用的迁移数。
 */
export async function prepareDriftSchema(options: {
  databaseUrl: string;
  schema?: string;
  migrationsDirectory?: string;
}): Promise<{ migrationsApplied: number }> {
  const schema = options.schema ?? defaultDriftSchema;
  const migrationsDirectory = options.migrationsDirectory ?? path.resolve("migrations");
  assertLocalDatabaseUrl(options.databaseUrl);
  assertDriftSchemaName(schema);
  const { Pool, createDatabase, quoteIdentifier, runMigrations } = await loadAppModules(schema);

  const admin = new Pool({ connectionString: options.databaseUrl, max: 2 });
  const handle = createDatabase(options.databaseUrl);
  try {
    await ensureDeclaredExtensions(admin, migrationsDirectory, quoteIdentifier);
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    const applied = await runMigrations(handle, migrationsDirectory);
    return { migrationsApplied: applied.length };
  } finally {
    await handle.pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

/** 只比对不重放:把目标 schema 的 information_schema 事实与 schema.ts 期望逐项核对。 */
export async function compareDriftSchema(options: {
  databaseUrl: string;
  schema?: string;
  migrationsApplied?: number;
}): Promise<DriftReport> {
  const schema = options.schema ?? defaultDriftSchema;
  assertLocalDatabaseUrl(options.databaseUrl);
  assertDriftSchemaName(schema);
  const { Pool, schemaModule } = await loadAppModules(schema);

  const admin = new Pool({ connectionString: options.databaseUrl, max: 2 });
  try {
    const tablesResult = await admin.query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1`,
      [schema],
    );
    const columnsResult = await admin.query<{
      table_name: string; column_name: string; data_type: string;
      character_maximum_length: number | null; is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, character_maximum_length, is_nullable
       FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
      [schema],
    );

    const actualTables = new Map<string, string>();
    for (const row of tablesResult.rows) actualTables.set(row.table_name, row.table_type);
    const actualColumns = new Map<string, Map<string, ActualColumn>>();
    for (const row of columnsResult.rows) {
      const columns = actualColumns.get(row.table_name) ?? new Map<string, ActualColumn>();
      columns.set(row.column_name, {
        dataType: row.data_type,
        charMaxLength: row.character_maximum_length,
        isNullable: row.is_nullable,
      });
      actualColumns.set(row.table_name, columns);
    }

    // schema.ts 这份文件是真源:期望取自模块的全部导出,而不是 databaseSchema
    // 注册表——否则"表已声明但漏注册"会被静默吞掉(019 就漏了两张)。
    const exportedEntries = Object.entries(schemaModule).filter(([name]) => name !== "databaseSchema");
    const { tables: expectedTables, views: expectedViews } = readDrizzleExpectations(
      exportedEntries.map(([, value]) => value),
    );
    const issues: string[] = [];
    let columnsCompared = 0;

    const registeredValues = new Set(Object.values(schemaModule.databaseSchema));
    for (const [exportName, value] of exportedEntries) {
      if ((isTable(value) || isDrizzleView(value)) && !registeredValues.has(value)) {
        issues.push(
          `${exportName}: schema.ts 导出了它,却没有注册进 databaseSchema——drizzle 运行时看不到这张表/视图`,
        );
      }
    }

    for (const [table, columns] of [...expectedTables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!actualTables.has(table)) {
        issues.push(`schema.ts 声明的表 ${table} 在迁移重放结果中不存在`);
        continue;
      }
      if (actualTables.get(table) !== "BASE TABLE") {
        issues.push(`${table}: schema.ts 声明为表,但迁移重放结果是 ${actualTables.get(table)}`);
        continue;
      }
      const actual = actualColumns.get(table) ?? new Map<string, ActualColumn>();
      for (const [columnName, expected] of [...columns.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        columnsCompared += 1;
        const found = actual.get(columnName);
        if (!found) {
          issues.push(`${table}.${columnName}: schema.ts 声明的列在迁移重放结果中不存在`);
          continue;
        }
        const actualType = normalizeActualType(found);
        if (actualType !== expected.type) {
          issues.push(`${table}.${columnName}: 类型漂移——schema.ts 期望 ${expected.type},迁移重放结果是 ${actualType}`);
        }
        const actualNotNull = found.isNullable === "NO";
        if (actualNotNull !== expected.notNull) {
          issues.push(
            `${table}.${columnName}: 可空性漂移——schema.ts 期望 ${expected.notNull ? "NOT NULL" : "可空"},迁移重放结果是 ${actualNotNull ? "NOT NULL" : "可空"}`,
          );
        }
      }
      for (const columnName of actual.keys()) {
        if (!columns.has(columnName)) {
          issues.push(`${table}.${columnName}: 迁移重放结果里存在,但 schema.ts 没有声明(两份真源已漂移)`);
        }
      }
    }

    for (const [table, reason] of [...sqlOwnedObjects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (expectedTables.has(table)) {
        issues.push(`${table}: 同时在 schema.ts 与 SQL 自有对象白名单中——白名单条目(${reason})应删除`);
      }
    }
    for (const [table, tableType] of [...actualTables.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (tableType === "BASE TABLE" && !expectedTables.has(table) && !sqlOwnedObjects.has(table)) {
        issues.push(`${table}: 迁移创建的表既不在 schema.ts 也不在 SQL 自有对象白名单——补 schema.ts 或登记白名单`);
      }
      if (tableType === "VIEW" && !expectedViews.has(table)) {
        issues.push(`${table}: 迁移创建的视图未在 schema.ts 以 existing() 声明`);
      }
    }
    for (const view of expectedViews) {
      if (actualTables.get(view) !== "VIEW") {
        issues.push(`${view}: schema.ts 以 existing() 声明的视图在迁移重放结果中不存在`);
      }
    }

    return {
      issues,
      stats: {
        tablesCompared: expectedTables.size,
        columnsCompared,
        viewsCompared: expectedViews.size,
        migrationsApplied: options.migrationsApplied ?? 0,
      },
    };
  } finally {
    await admin.end().catch(() => undefined);
  }
}

export async function runDriftCheck(options: {
  databaseUrl: string;
  schema?: string;
  migrationsDirectory?: string;
}): Promise<DriftReport> {
  const { migrationsApplied } = await prepareDriftSchema(options);
  return compareDriftSchema({ databaseUrl: options.databaseUrl, schema: options.schema, migrationsApplied });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf("--database-url");
  const schemaIndex = args.indexOf("--schema");
  const databaseUrl = urlIndex >= 0 ? args[urlIndex + 1] : process.env.SCHEMA_DRIFT_DATABASE_URL;
  const schema = schemaIndex >= 0 ? args[schemaIndex + 1] : defaultDriftSchema;
  if (!databaseUrl) {
    process.stderr.write(
      "用法: tsx scripts/check-schema-drift.mts --database-url postgresql://user:pass@127.0.0.1:5432/db [--schema s22_drift_check]\n" +
      "没有本地库时可运行 scripts/check-schema-drift-docker.sh 起一次性容器\n",
    );
    process.exitCode = 1;
    return;
  }
  const report = await runDriftCheck({ databaseUrl, schema });
  if (report.issues.length > 0) {
    process.stderr.write(`schema 漂移检测失败(${report.issues.length} 项):\n`);
    for (const issue of report.issues) process.stderr.write(`✖ ${issue}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `schema 漂移检测通过: ${report.stats.tablesCompared} 张表 / ${report.stats.columnsCompared} 列 / ` +
    `${report.stats.viewsCompared} 个视图与迁移重放结果一致(应用 ${report.stats.migrationsApplied} 个迁移,schema ${schema})\n`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
