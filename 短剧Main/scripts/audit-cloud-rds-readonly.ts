#!/usr/bin/env -S npx --no-install tsx

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { Client, type ClientConfig } from "pg";
import { resolvePostgresTls } from "../src/db/tls.js";

export const READ_ONLY_SESSION_OPTIONS = [
  "-c default_transaction_read_only=on",
  "-c statement_timeout=15000",
  "-c lock_timeout=3000",
  "-c idle_in_transaction_session_timeout=15000",
].join(" ");

const DATABASE_ENV_KEYS = [
  "DATABASE_URL",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_SCHEMA",
  "POSTGRES_SSL_MODE",
  "POSTGRES_SSL_ROOT_CERT",
] as const;

const migrationFilePattern = /^\d+_[a-z0-9_]+\.sql$/;
const safeSchemaPattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const targetFingerprintPattern = /^sha256:[a-f0-9]{64}$/;
const connectionUrlOverrideParameters = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"] as const;
export const V011_EXPECTED_MIGRATION_VERSIONS = [
  "001_v01_core.sql",
  "002_generation_quotes.sql",
  "003_cli_compat.sql",
  "004_director_scenes.sql",
  "005_generation_default_strategies.sql",
  "006_agent_message_audit.sql",
  "007_review_domain.sql",
  "008_reference_tests.sql",
  "009_global_asset_review_actions.sql",
  "010_admin_user_actions.sql",
  "011_feedback_events_and_asset_copy.sql",
  "012_shot_media_asset_registration.sql",
] as const;

type DatabaseEnvironment = Partial<Record<(typeof DATABASE_ENV_KEYS)[number], string>>;

export interface AuditCliOptions {
  envFile?: string;
  expectedFingerprint?: string;
  help?: boolean;
  migrationsDirectory: string;
  schema?: string;
  scope: "cloud" | "dev-test";
}

interface ExpectedMigration {
  version: string;
  checksum: string;
}

interface AppliedMigration extends ExpectedMigration {
  appliedAt: string;
}

interface TableInventory {
  schema: string;
  table: string;
  persistence: string;
  estimatedRows: string;
  totalBytes: string;
}

interface ExactRowCount {
  schema: string;
  table: string;
  /** 精确行数；无 SELECT 权限时为 "unreadable"，见 accessError。 */
  rowCount: string;
  reason: "target_schema" | "asset_or_media_source";
  /** 仅权限不足（42501）时降级记录；其他错误仍 fail-closed。 */
  accessError?: "permission_denied";
}

export type AuditPhase =
  | "preflight"
  | "client_config"
  | "connect"
  | "begin_read_only"
  | "assert_read_only"
  | "instance_inventory"
  | "schema_inventory"
  | "table_inventory"
  | "exact_row_counts"
  | "migration_inventory"
  | "snapshot_inventory"
  | "rollback";

export type AuditFailureCategory =
  | "PREFLIGHT_POLICY"
  | "READ_ONLY_INVARIANT"
  | "TLS_CERTIFICATE"
  | "AUTHENTICATION"
  | "NETWORK_DNS"
  | "NETWORK_REFUSED"
  | "NETWORK_TIMEOUT"
  | "PERMISSION"
  | "QUERY"
  | "CONNECTION_CLOSED"
  | "UNCLASSIFIED";

interface SafeAuditFailureDiagnosis {
  category: AuditFailureCategory;
}

export class SafeAuditError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SafeAuditError";
  }
}

export class SafeAuditRuntimeError extends Error {
  public constructor(
    public readonly phase: AuditPhase,
    public readonly category: AuditFailureCategory,
  ) {
    super(`Cloud RDS read-only audit failed safely (phase=${phase},category=${category})`);
    this.name = "SafeAuditRuntimeError";
  }
}

function collectErrorSignals(error: unknown, depth = 0): { codes: string[]; messages: string[] } {
  if (depth > 2 || typeof error !== "object" || error === null) return { codes: [], messages: [] };
  const record = error as Record<string, unknown>;
  const codes = typeof record.code === "string" ? [record.code] : [];
  const messages = typeof record.message === "string" ? [record.message] : [];
  const nested = [record.cause, ...(Array.isArray(record.errors) ? record.errors : [])];
  for (const value of nested) {
    const child = collectErrorSignals(value, depth + 1);
    codes.push(...child.codes);
    messages.push(...child.messages);
  }
  return { codes, messages };
}

export function diagnoseAuditFailure(error: unknown): SafeAuditFailureDiagnosis {
  const signals = collectErrorSignals(error);
  const normalizedCodes = signals.codes.map((code) => code.toUpperCase());
  const message = signals.messages.join(" ").toLowerCase();
  if (
    /certificate|self[- ]signed|unable to verify|hostname\/ip does not match|altname|tls|ssl/.test(message) ||
    normalizedCodes.some((code) => code.startsWith("ERR_TLS_") || code.startsWith("CERT_"))
  ) {
    return { category: "TLS_CERTIFICATE" };
  }
  if (normalizedCodes.includes("28P01") || /password authentication failed|authentication failed/.test(message)) {
    return { category: "AUTHENTICATION" };
  }
  if (normalizedCodes.includes("ENOTFOUND") || normalizedCodes.includes("EAI_AGAIN") || /getaddrinfo/.test(message)) {
    return { category: "NETWORK_DNS" };
  }
  if (normalizedCodes.includes("ECONNREFUSED")) {
    return { category: "NETWORK_REFUSED" };
  }
  if (
    normalizedCodes.some((code) => code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") ||
    /timeout|timed out/.test(message)
  ) {
    return { category: "NETWORK_TIMEOUT" };
  }
  if (normalizedCodes.includes("42501") || /permission denied|insufficient privilege/.test(message)) {
    return { category: "PERMISSION" };
  }
  if (normalizedCodes.some((code) => /^42[A-Z0-9]{3}$/.test(code))) {
    return { category: "QUERY" };
  }
  if (/connection (?:terminated|closed)|client has already been closed/.test(message)) {
    return { category: "CONNECTION_CLOSED" };
  }
  return { category: "UNCLASSIFIED" };
}

function assertCloudCredentials(environment: DatabaseEnvironment): void {
  if (environment.DATABASE_URL) {
    const parsed = new URL(environment.DATABASE_URL);
    if (!parsed.username || !parsed.password) {
      throw new SafeAuditError("Cloud audit requires explicit credentials in the isolated env file");
    }
    return;
  }
  if (!environment.POSTGRES_USER || !environment.POSTGRES_PASSWORD) {
    throw new SafeAuditError("Cloud audit requires explicit credentials in the isolated env file");
  }
}

export function parseCliArgs(args: string[], cwd = process.cwd()): AuditCliOptions {
  const result: AuditCliOptions = {
    migrationsDirectory: path.resolve(cwd, "migrations"),
    scope: "cloud",
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new SafeAuditError(`Missing value for ${argument}`);
    }

    switch (argument) {
      case "--env-file":
        result.envFile = path.resolve(cwd, value);
        break;
      case "--expected-fingerprint":
        result.expectedFingerprint = assertTargetFingerprint(value);
        break;
      case "--migrations-dir":
        result.migrationsDirectory = path.resolve(cwd, value);
        break;
      case "--schema":
        result.schema = assertSafeSchema(value);
        break;
      case "--scope":
        if (value !== "cloud" && value !== "dev-test") {
          throw new SafeAuditError("--scope must be cloud or dev-test");
        }
        result.scope = value;
        break;
      default:
        throw new SafeAuditError(`Unknown argument: ${argument}`);
    }
    index += 1;
  }

  if (!result.help && result.scope === "cloud") {
    if (!result.envFile) {
      throw new SafeAuditError("Cloud audit requires an explicit --env-file to isolate the approved target connection");
    }
    if (!result.expectedFingerprint) {
      throw new SafeAuditError("Cloud audit requires --expected-fingerprint sha256:<64 lowercase hex characters>");
    }
  }

  return result;
}

export function pickDatabaseEnvironment(source: NodeJS.ProcessEnv | Record<string, string>): DatabaseEnvironment {
  const picked: DatabaseEnvironment = {};
  for (const key of DATABASE_ENV_KEYS) {
    const value = source[key]?.trim();
    if (value) picked[key] = value;
  }
  return picked;
}

export function mergeDatabaseEnvironment(
  inherited: NodeJS.ProcessEnv | Record<string, string>,
  envFileContents?: string,
): DatabaseEnvironment {
  const fromProcess = pickDatabaseEnvironment(inherited);
  if (envFileContents === undefined) return fromProcess;
  // Keep an explicit env file isolated. Mixing it with inherited connection
  // fields could silently point the audit at an unintended database.
  return pickDatabaseEnvironment(parseDotenv(envFileContents));
}

export function assertSafeSchema(value: string): string {
  if (!safeSchemaPattern.test(value)) {
    throw new SafeAuditError("Schema must contain only letters, digits, and underscores and start with a letter or underscore");
  }
  return value;
}

export function assertTargetFingerprint(value: string): string {
  if (!targetFingerprintPattern.test(value)) {
    throw new SafeAuditError("--expected-fingerprint must be sha256:<64 lowercase hex characters>");
  }
  return value;
}

export function quotePgIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function connectionTarget(environment: DatabaseEnvironment): { host: string; port: string; database: string } {
  if (environment.DATABASE_URL) {
    let parsed: URL;
    try {
      parsed = new URL(environment.DATABASE_URL);
    } catch {
      throw new SafeAuditError("DATABASE_URL is not a valid URL");
    }
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      throw new SafeAuditError("DATABASE_URL must use postgres:// or postgresql://");
    }
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!database) throw new SafeAuditError("DATABASE_URL must name a database");
    return {
      host: parsed.hostname,
      port: parsed.port || "5432",
      database,
    };
  }

  const host = environment.POSTGRES_HOST;
  const database = environment.POSTGRES_DB;
  if (!host || !database || !environment.POSTGRES_USER) {
    throw new SafeAuditError("Provide DATABASE_URL or POSTGRES_HOST, POSTGRES_DB, and POSTGRES_USER");
  }
  const port = environment.POSTGRES_PORT || "5432";
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535) {
    throw new SafeAuditError("POSTGRES_PORT must be a valid TCP port");
  }
  return { host, port, database };
}

export function classifyTarget(host: string): "local" | "managed_rds_dns" | "cloud_unconfirmed" {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized === "host.docker.internal" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  ) {
    return "local";
  }
  if (/\.rds\.amazonaws\.com(?:\.cn)?$/.test(normalized) || /\.rds-pg\.volces\.com$/.test(normalized)) {
    return "managed_rds_dns";
  }
  return "cloud_unconfirmed";
}

export function assertTargetAllowed(
  scope: AuditCliOptions["scope"],
  targetClass: ReturnType<typeof classifyTarget>,
): void {
  if (scope === "cloud" && targetClass !== "managed_rds_dns") {
    throw new SafeAuditError(
      "Cloud audit requires a direct managed RDS DNS target; use --scope dev-test for local or unconfirmed hosts and never treat that result as cloud evidence",
    );
  }
}

export function targetFingerprint(target: { host: string; port: string; database: string }): string {
  return `sha256:${createHash("sha256")
    .update(`${target.host.toLowerCase()}:${target.port}/${target.database}`)
    .digest("hex")}`;
}

export function assertCloudInvocationPolicy(
  options: Pick<AuditCliOptions, "scope" | "envFile" | "expectedFingerprint">,
  target: { host: string; port: string; database: string },
): void {
  if (options.scope !== "cloud") return;
  if (!options.envFile) {
    throw new SafeAuditError("Cloud audit requires an explicit --env-file to isolate the approved target connection");
  }
  if (!options.expectedFingerprint) {
    throw new SafeAuditError("Cloud audit requires --expected-fingerprint sha256:<64 lowercase hex characters>");
  }
  const expected = assertTargetFingerprint(options.expectedFingerprint);
  if (targetFingerprint(target) !== expected) {
    throw new SafeAuditError("Approved target fingerprint does not match the supplied cloud connection; audit aborted before client construction");
  }
}

export function buildClientConfig(
  environment: DatabaseEnvironment,
  scope: AuditCliOptions["scope"] = "dev-test",
): ClientConfig {
  if (scope === "cloud") assertCloudCredentials(environment);
  const shared: ClientConfig = {
    application_name: "v011_cloud_rds_readonly_audit",
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 15_000,
    lock_timeout: 3_000,
    idle_in_transaction_session_timeout: 15_000,
    options: READ_ONLY_SESSION_OPTIONS,
  };

  if (environment.DATABASE_URL) {
    // node-postgres lets connection-string query parameters override top-level
    // config. Replace every safety-relevant parameter in the URL as well, so a
    // stale `options=-c default_transaction_read_only=off` cannot weaken the
    // startup guard before BEGIN READ ONLY runs.
    const connectionUrl = new URL(environment.DATABASE_URL);
    if (scope === "cloud") {
      // Never give a cloud URL to node-postgres: its query parameters can
      // override authority or TLS fields during connection-string parsing.
      // The approved authority is parsed once and passed as explicit fields.
      const target = connectionTarget(environment);
      return {
        ...shared,
        host: target.host,
        port: Number(target.port),
        database: target.database,
        user: connectionUrl.username ? decodeURIComponent(connectionUrl.username) : undefined,
        password: connectionUrl.password ? decodeURIComponent(connectionUrl.password) : undefined,
        ssl: cloudTlsConfig(environment, target.host),
      };
    }
    for (const parameter of connectionUrlOverrideParameters) {
      connectionUrl.searchParams.delete(parameter);
    }
    connectionUrl.searchParams.set("options", READ_ONLY_SESSION_OPTIONS);
    connectionUrl.searchParams.set("application_name", "v011_cloud_rds_readonly_audit");
    connectionUrl.searchParams.set("statement_timeout", "15000");
    connectionUrl.searchParams.set("lock_timeout", "3000");
    connectionUrl.searchParams.set("idle_in_transaction_session_timeout", "15000");
    return { ...shared, connectionString: connectionUrl.toString() };
  }
  return {
    ...shared,
    host: environment.POSTGRES_HOST,
    port: environment.POSTGRES_PORT ? Number(environment.POSTGRES_PORT) : 5432,
    database: environment.POSTGRES_DB,
    user: environment.POSTGRES_USER,
    password: environment.POSTGRES_PASSWORD,
    ...(scope === "cloud" ? { ssl: cloudTlsConfig(environment, connectionTarget(environment).host) } : {}),
  };
}

/**
 * The cloud audit never weakens certificate validation. Some managed RDS
 * instances publish a private CA, so an explicitly allowlisted CA file may be
 * supplied by the isolated audit env file. The file content never reaches the
 * audit report or command output.
 */
function cloudTlsConfig(environment: DatabaseEnvironment, host: string): NonNullable<ClientConfig["ssl"]> {
  const rootCertPath = environment.POSTGRES_SSL_ROOT_CERT;
  if (!rootCertPath) return { rejectUnauthorized: true, servername: host };
  if (environment.POSTGRES_SSL_MODE && environment.POSTGRES_SSL_MODE !== "verify-full") {
    throw new SafeAuditError("Cloud audit requires verify-full when a TLS root certificate is configured");
  }
  try {
    const tls = resolvePostgresTls({
      mode: "verify-full",
      rootCertPath,
      servername: host,
    });
    if (!tls) throw new SafeAuditError("Cloud audit TLS configuration is unexpectedly empty");
    return tls;
  } catch {
    throw new SafeAuditError("Cloud audit could not load the configured TLS root certificate");
  }
}

export async function readExpectedMigrations(migrationsDirectory: string): Promise<ExpectedMigration[]> {
  const files = (await readdir(migrationsDirectory))
    .filter((fileName) => migrationFilePattern.test(fileName))
    .sort((left, right) => left.localeCompare(right));
  const frozenVersions = new Set(V011_EXPECTED_MIGRATION_VERSIONS);
  const missingFrozenVersion = V011_EXPECTED_MIGRATION_VERSIONS.some((version) => !files.includes(version));
  const unexpectedFrozenVersion = files.some((version) => {
    const sequence = Number(version.slice(0, 3));
    return sequence <= 12 && !frozenVersions.has(version);
  });
  if (missingFrozenVersion || unexpectedFrozenVersion) {
    throw new SafeAuditError("Migration directory does not contain the frozen V011 001-012 sequence");
  }
  return Promise.all(
    V011_EXPECTED_MIGRATION_VERSIONS.map(async (version) => {
      const source = await readFile(path.join(migrationsDirectory, version), "utf8");
      return { version, checksum: createHash("sha256").update(source).digest("hex") };
    }),
  );
}

export function compareMigrations(expected: ExpectedMigration[], applied: AppliedMigration[]) {
  const expectedByVersion = new Map(expected.map((migration) => [migration.version, migration.checksum]));
  const appliedByVersion = new Map(applied.map((migration) => [migration.version, migration.checksum]));
  const missing = expected.filter((migration) => !appliedByVersion.has(migration.version)).map((migration) => migration.version);
  const extra = applied.filter((migration) => !expectedByVersion.has(migration.version)).map((migration) => migration.version);
  const checksumMismatch = applied
    .filter((migration) => {
      const expectedChecksum = expectedByVersion.get(migration.version);
      return expectedChecksum !== undefined && expectedChecksum !== migration.checksum;
    })
    .map((migration) => migration.version);
  return {
    status: missing.length === 0 && extra.length === 0 && checksumMismatch.length === 0 ? "match" : "drift",
    missing,
    extra,
    checksumMismatch,
  } as const;
}

export function usage(): string {
  return [
    "Usage: npx --no-install tsx scripts/audit-cloud-rds-readonly.ts [options]",
    "  --env-file <path>       Required for cloud: read only approved PostgreSQL variables from a gitignored env file",
    "  --expected-fingerprint <sha256:...> Required for cloud: exact approved target fingerprint",
    "  --schema <name>         Target schema; defaults to POSTGRES_SCHEMA or app",
    "  --migrations-dir <path> Local migration directory; defaults to ./migrations",
    "  --scope <cloud|dev-test> Refuse local targets in cloud mode; defaults to cloud",
  ].join("\n");
}

async function runAudit(options: AuditCliOptions): Promise<Record<string, unknown>> {
  let phase: AuditPhase = "preflight";
  let client: Client | undefined;
  let transactionStarted = false;

  try {
    const envFileContents = options.envFile ? await readFile(options.envFile, "utf8") : undefined;
    const environment = mergeDatabaseEnvironment(process.env, envFileContents);
    // 兜底必须是主线 schema app(环境治理合同 §2);common 是团队旧系统的活数据 schema。
    const schema = assertSafeSchema(options.schema || environment.POSTGRES_SCHEMA || "app");
    const target = connectionTarget(environment);
    const targetClass = classifyTarget(target.host);
    assertTargetAllowed(options.scope, targetClass);
    assertCloudInvocationPolicy(options, target);
    const expectedMigrations = await readExpectedMigrations(options.migrationsDirectory);
    phase = "client_config";
    client = new Client(buildClientConfig(environment, options.scope));
    phase = "connect";
    await client.connect();
    phase = "begin_read_only";
    await client.query("BEGIN TRANSACTION READ ONLY");
    transactionStarted = true;
    await client.query("SET TRANSACTION READ ONLY");

    phase = "assert_read_only";
    const safetyResult = await client.query<{
      transaction_read_only: string;
      default_transaction_read_only: string;
    }>(`
      SELECT
        current_setting('transaction_read_only') AS transaction_read_only,
        current_setting('default_transaction_read_only') AS default_transaction_read_only
    `);
    const safety = safetyResult.rows[0];
    if (safety?.transaction_read_only !== "on" || safety.default_transaction_read_only !== "on") {
      throw new SafeAuditError("Read-only session assertion failed; audit aborted before inventory queries");
    }

    phase = "instance_inventory";
    const instanceResult = await client.query<{
      database_name: string;
      server_version: string;
      server_version_num: string;
      server_port: string;
      database_size_bytes: string;
      in_recovery: boolean;
    }>(`
      SELECT
        current_database() AS database_name,
        current_setting('server_version') AS server_version,
        current_setting('server_version_num') AS server_version_num,
        inet_server_port()::text AS server_port,
        pg_database_size(current_database())::text AS database_size_bytes,
        pg_is_in_recovery() AS in_recovery
    `);

    phase = "schema_inventory";
    const schemasResult = await client.query<{ schema_name: string }>(`
      SELECT nspname AS schema_name
      FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND nspname <> 'information_schema'
      ORDER BY nspname
    `);

    phase = "table_inventory";
    const tablesResult = await client.query<{
      schema_name: string;
      table_name: string;
      persistence: string;
      estimated_rows: string;
      total_bytes: string;
    }>(`
      SELECT
        namespace.nspname AS schema_name,
        relation.relname AS table_name,
        relation.relpersistence::text AS persistence,
        greatest(relation.reltuples, 0)::bigint::text AS estimated_rows,
        pg_total_relation_size(relation.oid)::text AS total_bytes
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p')
        AND namespace.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
        AND namespace.nspname <> 'information_schema'
      ORDER BY namespace.nspname, relation.relname
    `);
    const tables: TableInventory[] = tablesResult.rows.map((row) => ({
      schema: row.schema_name,
      table: row.table_name,
      persistence: row.persistence,
      estimatedRows: row.estimated_rows,
      totalBytes: row.total_bytes,
    }));

    const exactCountCandidates = tables.filter(
      (table) => table.schema === schema || /(?:asset|media)/i.test(table.table),
    );
    const exactRowCounts: ExactRowCount[] = [];
    phase = "exact_row_counts";
    for (const table of exactCountCandidates) {
      // 云库权限异构是常态（同实例上其他项目的 schema/表对审计账号不可读）。
      // 单表 42501 降级记录而非整体 fail；SAVEPOINT 防单条失败 abort 整个只读事务。
      await client.query("SAVEPOINT exact_count_probe");
      try {
        const countResult = await client.query<{ row_count: string }>(
          `SELECT count(*)::text AS row_count FROM ${quotePgIdentifier(table.schema)}.${quotePgIdentifier(table.table)}`,
        );
        exactRowCounts.push({
          schema: table.schema,
          table: table.table,
          rowCount: countResult.rows[0]?.row_count || "0",
          reason: table.schema === schema ? "target_schema" : "asset_or_media_source",
        });
      } catch (reason) {
        await client.query("ROLLBACK TO SAVEPOINT exact_count_probe");
        if ((reason as { code?: string }).code !== "42501") throw reason;
        exactRowCounts.push({
          schema: table.schema,
          table: table.table,
          rowCount: "unreadable",
          reason: table.schema === schema ? "target_schema" : "asset_or_media_source",
          accessError: "permission_denied",
        });
      } finally {
        await client.query("RELEASE SAVEPOINT exact_count_probe").catch(() => undefined);
      }
    }

    phase = "migration_inventory";
    const hasMigrationTable = tables.some((table) => table.schema === schema && table.table === "schema_migrations");
    const appliedMigrations = hasMigrationTable
      ? (
          await client.query<{ version: string; checksum: string; applied_at: Date | string }>(`
            SELECT version, checksum, applied_at
            FROM ${quotePgIdentifier(schema)}.schema_migrations
            ORDER BY version
          `)
        ).rows.map((row) => ({
          version: row.version,
          checksum: row.checksum,
          appliedAt: row.applied_at instanceof Date ? row.applied_at.toISOString() : new Date(row.applied_at).toISOString(),
        }))
      : [];

    phase = "snapshot_inventory";
    const snapshotResult = await client.query<{
      archive_mode: string | null;
      wal_level: string | null;
      in_recovery: boolean;
      last_archived_at: Date | string | null;
      archived_count: string | null;
      failed_count: string | null;
    }>(`
      SELECT
        current_setting('archive_mode', true) AS archive_mode,
        current_setting('wal_level', true) AS wal_level,
        pg_is_in_recovery() AS in_recovery,
        archiver.last_archived_time AS last_archived_at,
        archiver.archived_count::text AS archived_count,
        archiver.failed_count::text AS failed_count
      FROM pg_stat_archiver archiver
    `);
    const snapshot = snapshotResult.rows[0];

    phase = "rollback";
    await client.query("ROLLBACK");
    transactionStarted = false;

    const instance = instanceResult.rows[0];
    return {
      auditVersion: "v011-cloud-rds-readonly/1",
      capturedAt: new Date().toISOString(),
      requestedScope: options.scope,
      safety: {
        readOnlyEnforced: true,
        transactionReadOnly: safety.transaction_read_only,
        defaultTransactionReadOnly: safety.default_transaction_read_only,
        statementTimeoutMs: 15_000,
        credentialsEmitted: false,
      },
      target: {
        classification: targetClass,
        fingerprint: targetFingerprint(target),
        endpointEmitted: false,
      },
      instance: instance
        ? {
            databaseName: instance.database_name,
            serverVersion: instance.server_version,
            serverVersionNum: instance.server_version_num,
            serverPort: instance.server_port,
            databaseSizeBytes: instance.database_size_bytes,
            role: instance.in_recovery ? "standby" : "primary",
          }
        : null,
      targetSchema: schema,
      schemas: schemasResult.rows.map((row) => row.schema_name),
      tables,
      exactRowCounts,
      migrations: {
        expected: expectedMigrations,
        applied: appliedMigrations,
        comparison: compareMigrations(expectedMigrations, appliedMigrations),
      },
      snapshotStatus: {
        rdsControlPlane: {
          status: "unverified",
          reason: "RDS snapshot and automated-backup state is not exposed by PostgreSQL read-only SQL; require a cloud control-plane read receipt before any migration write window",
        },
        databaseNative: snapshot
          ? {
              archiveMode: snapshot.archive_mode,
              walLevel: snapshot.wal_level,
              inRecovery: snapshot.in_recovery,
              lastArchivedAt:
                snapshot.last_archived_at instanceof Date
                  ? snapshot.last_archived_at.toISOString()
                  : snapshot.last_archived_at,
              archivedCount: snapshot.archived_count,
              failedCount: snapshot.failed_count,
            }
          : null,
      },
    };
  } catch (error) {
    if (error instanceof SafeAuditRuntimeError) throw error;
    if (error instanceof SafeAuditError) {
      throw new SafeAuditRuntimeError(
        phase,
        phase === "assert_read_only" ? "READ_ONLY_INVARIANT" : "PREFLIGHT_POLICY",
      );
    }
    const diagnosis = diagnoseAuditFailure(error);
    throw new SafeAuditRuntimeError(phase, diagnosis.category);
  } finally {
    if (transactionStarted && client) await client.query("ROLLBACK").catch(() => undefined);
    if (client) await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const result = await runAudit(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    if (error instanceof SafeAuditRuntimeError) {
      process.stderr.write(`${error.message}\n`);
    } else if (error instanceof SafeAuditError) {
      process.stderr.write("Cloud RDS read-only audit aborted by a preflight safety policy\n");
    } else {
      process.stderr.write("Cloud RDS read-only audit failed without emitting connection details\n");
    }
    process.exitCode = 1;
  });
}
