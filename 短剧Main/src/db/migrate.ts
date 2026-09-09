import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase, type DatabaseHandle } from "./client.js";
import { settings } from "../config/env.js";

const migrationFilePattern = /^\d+_[a-z0-9_]+\.sql$/;
const schemaNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const migrationLockKey = 1_724_015;
const adminUsernamesMigrationSetting = "shortdrama.admin_usernames";
const vnextSchemaName = "vnext";
const vnextMigrationsDirectory = path.resolve("src/db/migrations/vnext");

/** pg Pool / PoolClient 都结构化满足这个接口;迁移器只依赖最小查询面。 */
export interface MigrationQueryExecutor {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

interface ConnectableMigrationExecutor extends MigrationQueryExecutor {
  connect(): Promise<MigrationQueryExecutor & { release(): void }>;
}

export function assertSafeSchemaName(value: string): string {
  if (!schemaNamePattern.test(value)) {
    throw new Error("POSTGRES_SCHEMA must contain only letters, digits, and underscores and must start with a letter or underscore");
  }
  return value;
}

export function quoteIdentifier(value: string): string {
  return `"${assertSafeSchemaName(value).replaceAll('"', '""')}"`;
}

export function renderMigrationSql(source: string, schemaName: string): string {
  const rendered = source.replaceAll("{{schema}}", quoteIdentifier(schemaName));
  if (rendered.includes("{{schema}}")) throw new Error("Migration contains an unresolved schema placeholder");
  return rendered;
}

export async function runMigrations(
  handle: DatabaseHandle = createDatabase(),
  migrationsDirectory = path.resolve("migrations"),
): Promise<string[]> {
  const schemaName = assertSafeSchemaName(settings.postgresSchema);
  const quotedSchema = quoteIdentifier(schemaName);
  const files = (await readdir(migrationsDirectory))
    .filter((fileName) => migrationFilePattern.test(fileName))
    .sort((left, right) => left.localeCompare(right));
  const client = await handle.pool.connect();
  const applied: string[] = [];

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [migrationLockKey]);
    // 016 uses this transaction-local setting once to promote configured
    // Day-0 bootstrap usernames.  Keeping it in the session avoids hardcoding
    // any deployment identity in a versioned SQL migration.  It disappears on
    // COMMIT/ROLLBACK and is never written to migration history.
    await client.query("SELECT set_config($1, $2, true)", [
      adminUsernamesMigrationSetting,
      settings.adminUsernames.join(","),
    ]);
    // A release account that is allowed to evolve an existing isolated schema
    // should not also need database-wide CREATE permission merely because the
    // generic migrator used `CREATE SCHEMA IF NOT EXISTS` unconditionally.
    const schemaResult = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
      [schemaName],
    );
    if (!schemaResult.rows[0]?.exists) {
      await client.query(`CREATE SCHEMA ${quotedSchema}`);
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quotedSchema}.schema_migrations (
        version varchar(255) PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const fileName of files) {
      const source = (await readFile(path.join(migrationsDirectory, fileName), "utf8")).replace(/\r\n?/g, "\n");
      const checksum = createHash("sha256").update(source).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${quotedSchema}.schema_migrations WHERE version = $1`,
        [fileName],
      );
      const previousChecksum = existing.rows[0]?.checksum;
      if (previousChecksum) {
        if (previousChecksum !== checksum) {
          throw new Error(`Migration ${fileName} has changed after it was applied`);
        }
        continue;
      }

      await client.query(renderMigrationSql(source, schemaName));
      await client.query(
        `INSERT INTO ${quotedSchema}.schema_migrations (version, checksum) VALUES ($1, $2)`,
        [fileName, checksum],
      );
      applied.push(fileName);
    }

    // vNext 独立产品面的迁移链挂进同一条受控迁移链:同事务、同一把 advisory 锁,
    // 账记在自己的 vnext.schema_migrations。干净环境跑完正式迁移后 vNext
    // schema/tables 必须已经存在,不得只靠独立脚本旁路执行。
    for (const vnextFile of await runVnextMigrations(client)) {
      applied.push(`${vnextSchemaName}/${vnextFile}`);
    }

    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * vNext 迁移链(src/db/migrations/vnext/,账在 vnext.schema_migrations)。
 * 正式入口是 runMigrations 内部调用;这里保持导出供独立验收脚本复用。
 */
export async function runVnextMigrations(
  executor: MigrationQueryExecutor,
  migrationsDirectory = vnextMigrationsDirectory,
): Promise<string[]> {
  // pg PoolClient 继承了 Client.connect(),但它已由 pool.connect() 建立连接；
  // `release` 是区分已连接 PoolClient 与 Pool 的稳定结构化信号。
  const connectable = !("release" in executor)
    && typeof (executor as Partial<ConnectableMigrationExecutor>).connect === "function"
    ? executor as ConnectableMigrationExecutor
    : undefined;
  const client = connectable ? await connectable.connect() : executor;
  try {
    if (connectable) await client.query("BEGIN");
    const applied = await runVnextMigrationsOnClient(client, migrationsDirectory);
    if (connectable) await client.query("COMMIT");
    return applied;
  } catch (error) {
    if (connectable) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (connectable && "release" in client && typeof client.release === "function") client.release();
  }
}

async function runVnextMigrationsOnClient(
  executor: MigrationQueryExecutor,
  migrationsDirectory: string,
): Promise<string[]> {
  const files = (await readdir(migrationsDirectory))
    .filter((fileName) => migrationFilePattern.test(fileName))
    .sort((left, right) => left.localeCompare(right));
  // 与主链同一口径:允许只被授权演进既有 schema 的发布账号,不强要库级 CREATE。
  const schemaResult = await executor.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
    [vnextSchemaName],
  );
  if (!schemaResult.rows[0]?.exists) {
    await executor.query(`CREATE SCHEMA ${quoteIdentifier(vnextSchemaName)}`);
  }
  const ledgerResult = await executor.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`${vnextSchemaName}.schema_migrations`],
  );
  if (!ledgerResult.rows[0]?.exists) {
    await executor.query(`
      CREATE TABLE ${quoteIdentifier(vnextSchemaName)}.schema_migrations (
        version varchar(255) PRIMARY KEY,
        checksum varchar(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }
  const applied: string[] = [];
  for (const fileName of files) {
    const source = await readFile(path.join(migrationsDirectory, fileName), "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const existing = await executor.query<{ checksum: string }>(
      `SELECT checksum FROM ${quoteIdentifier(vnextSchemaName)}.schema_migrations WHERE version = $1`,
      [fileName],
    );
    const previousChecksum = existing.rows[0]?.checksum;
    if (previousChecksum) {
      if (previousChecksum !== checksum) {
        throw new Error(`vNext migration ${fileName} has changed after it was applied`);
      }
      continue;
    }
    const ownerResult = await executor.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_namespace n
           JOIN pg_roles r ON r.oid = n.nspowner
          WHERE n.nspname = $1 AND r.rolname = 'vnext_owner'
       ) AS active`,
      [vnextSchemaName],
    );
    // PG14 没有逐成员的 inherit_option。共享迁移/主应用登录身份若永久成为
    // vnext_owner 成员且自身为 INHERIT，主连接会自动取得产品表所有者权限。
    // 因此仅在单条后续迁移的事务内临时授权，执行完立即撤销。
    if (ownerResult.rows[0]?.active) {
      await executor.query("GRANT vnext_owner TO CURRENT_USER");
      await executor.query("SET ROLE vnext_owner");
    }
    await executor.query(source);
    if (ownerResult.rows[0]?.active) {
      await executor.query("RESET ROLE");
      await executor.query("REVOKE vnext_owner FROM CURRENT_USER");
    }
    await executor.query(
      `INSERT INTO ${quoteIdentifier(vnextSchemaName)}.schema_migrations (version, checksum) VALUES ($1, $2)`,
      [fileName, checksum],
    );
    applied.push(fileName);
  }
  return applied;
}

async function main(): Promise<void> {
  const handle = createDatabase();
  try {
    const applied = await runMigrations(handle);
    process.stdout.write(applied.length ? `Applied migrations: ${applied.join(", ")}\n` : "Database is up to date\n");
  } finally {
    await handle.pool.end();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Migration failed"}\n`);
    process.exitCode = 1;
  });
}
