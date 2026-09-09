/**
 * Narrow S55-HW ByteHouse implementation.
 *
 * The exported query-client seam lets tests exercise the exact SQL protocol
 * without a provider call. The production client uses the ByteHouse HTTP
 * contract and deliberately suppresses endpoint, credential, SQL and response
 * body values from all errors.
 */

import { request as httpsRequest } from "node:https";

export const S55_HW_ENVIRONMENT = "dev";
export const S55_HW_DATABASE = "shortdrama_analytics";
export const S55_HW_TABLE = "s55_hello_world";
export const S55_HW_ROW_KEY = "s55-hw-v1";
export const S55_HW_OWNER = "shortdrama";

const TENANT_ID = "2100701382";
const HTTP_TIMEOUT_MS = 30_000;
const SSH_TUNNEL_PORT = 18_123;

export interface ByteHouseQueryClient {
  query(sql: string): Promise<string>;
}

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface FetchInitLike {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type FetchLike = (
  input: string,
  init?: FetchInitLike,
) => Promise<FetchResponseLike>;

export interface ByteHouseTarget {
  readonly environment: "dev";
  readonly endpoint: string;
  readonly username: string;
  readonly password: string;
  readonly sshTunnelPort?: 18123;
}

export interface ByteHouseCredentials {
  readonly endpoint: string;
  readonly app: ByteHouseTarget;
  readonly readonly: ByteHouseTarget;
}

export interface S55HelloWorldResult {
  readonly environment: "dev";
  readonly database: "shortdrama_analytics";
  readonly table: "s55_hello_world";
  readonly rowCount: 1;
  readonly appWriteVerified: true;
  readonly readonlyReadVerified: true;
  readonly replayIdempotent: true;
  readonly schemaVerified: true;
}

interface HelloWorldRow {
  readonly hello_key: string;
  readonly owner_project: string;
  readonly created_at: string;
}

interface SystemTableRow {
  readonly engine: string;
  readonly primary_key: string;
}

interface SystemColumnRow {
  readonly name: string;
  readonly type: string;
}

interface JsonResponse<T> {
  readonly data: readonly T[];
}

function requiredEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name];
  if (!value) throw new Error(`拒绝执行:缺少受控环境变量 ${name}，值不回显`);
  if (/[\r\n\0]/u.test(value)) {
    throw new Error(`拒绝执行:${name} 含非法控制字符，值不回显`);
  }
  return value;
}

function validateEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("拒绝执行:ByteHouse endpoint 格式无效，值不回显");
  }

  const publicDev =
    /^tenant-2100701382-(?:[a-z0-9]+-)+dev-public\.bytehouse\.volces\.com$/u;
  const privateDev =
    /^tenant-2100701382-(?:[a-z0-9]+-)+dev\.bytehouse\.ivolces\.com$/u;
  const endpointShapeIsSafe =
    url.protocol === "https:"
    && url.port === "8123"
    && !url.username
    && !url.password
    && (url.pathname === "" || url.pathname === "/")
    && !url.search
    && !url.hash
    && (publicDev.test(url.hostname) || privateDev.test(url.hostname));

  if (!endpointShapeIsSafe) {
    throw new Error("拒绝执行:ByteHouse endpoint 未命中 S55-HW dev allowlist，值不回显");
  }
}

function validateDatabaseUsername(username: string, envName: string): void {
  const expected = new RegExp(
    `^${TENANT_ID}::[A-Za-z0-9_.-]+::${S55_HW_ENVIRONMENT}$`,
    "u",
  );
  if (!expected.test(username)) {
    throw new Error(`拒绝执行:${envName} 未命中租户/dev 数据库用户格式，值不回显`);
  }
}

function validatePassword(password: string, envName: string): void {
  if (password.length < 12) {
    throw new Error(`拒绝执行:${envName} 长度不足，值不回显`);
  }
}

function optionalSshTunnelPort(
  env: Readonly<Record<string, string | undefined>>,
): 18123 | undefined {
  const value = env.BYTEHOUSE_DEV_SSH_TUNNEL_PORT;
  if (!value) return undefined;
  if (value !== String(SSH_TUNNEL_PORT)) {
    throw new Error(
      "拒绝执行:BYTEHOUSE_DEV_SSH_TUNNEL_PORT 只允许固定 loopback 端口，值不回显",
    );
  }
  return SSH_TUNNEL_PORT;
}

export function loadByteHouseCredentials(
  env: Readonly<Record<string, string | undefined>>,
): ByteHouseCredentials {
  const endpoint = requiredEnv(env, "BYTEHOUSE_DEV_HTTP_ENDPOINT");
  const appUsername = requiredEnv(env, "BYTEHOUSE_DEV_APP_USERNAME");
  const appPassword = requiredEnv(env, "BYTEHOUSE_DEV_APP_PASSWORD");
  const readonlyUsername = requiredEnv(env, "BYTEHOUSE_DEV_READONLY_USERNAME");
  const readonlyPassword = requiredEnv(env, "BYTEHOUSE_DEV_READONLY_PASSWORD");
  const sshTunnelPort = optionalSshTunnelPort(env);

  validateEndpoint(endpoint);
  validateDatabaseUsername(appUsername, "BYTEHOUSE_DEV_APP_USERNAME");
  validateDatabaseUsername(readonlyUsername, "BYTEHOUSE_DEV_READONLY_USERNAME");
  validatePassword(appPassword, "BYTEHOUSE_DEV_APP_PASSWORD");
  validatePassword(readonlyPassword, "BYTEHOUSE_DEV_READONLY_PASSWORD");
  if (appUsername === readonlyUsername) {
    throw new Error("拒绝执行:app 与 readonly 必须使用不同数据库用户，值不回显");
  }
  if (appPassword === readonlyPassword) {
    throw new Error("拒绝执行:app 与 readonly 不得共用密码，值不回显");
  }

  return {
    endpoint,
    app: {
      environment: S55_HW_ENVIRONMENT,
      endpoint,
      username: appUsername,
      password: appPassword,
      sshTunnelPort,
    },
    readonly: {
      environment: S55_HW_ENVIRONMENT,
      endpoint,
      username: readonlyUsername,
      password: readonlyPassword,
      sshTunnelPort,
    },
  };
}

function createLoopbackTunnelFetcher(port: 18123): FetchLike {
  return async (input, init = {}) => {
    const url = new URL(input);
    return new Promise<FetchResponseLike>((resolve, reject) => {
      const request = httpsRequest({
        protocol: "https:",
        hostname: "127.0.0.1",
        port,
        servername: url.hostname,
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: {
          ...init.headers,
          Host: url.host,
        },
      });
      const chunks: Buffer[] = [];
      const abort = () => request.destroy(new Error("aborted"));

      init.signal?.addEventListener("abort", abort, { once: true });
      request.setTimeout(HTTP_TIMEOUT_MS, () => {
        request.destroy(new Error("timeout"));
      });
      request.on("response", (response) => {
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            async text() {
              return Buffer.concat(chunks).toString("utf8");
            },
          });
        });
      });
      request.on("error", reject);
      request.on("close", () => {
        init.signal?.removeEventListener("abort", abort);
      });
      if (init.body) request.write(init.body);
      request.end();
    });
  };
}

function classifyProviderError(body: string): string {
  const normalized = body.toUpperCase();
  const category =
    normalized.includes("NOT ENOUGH PRIVILEGES") ? "NOT_ENOUGH_PRIVILEGES"
    : normalized.includes("CANNOT_PARSE") ? "INPUT_PARSE_ERROR"
    : normalized.includes("CONSTRAINT") ? "CONSTRAINT_ERROR"
    : normalized.includes("TTL") ? "TTL_ERROR"
    : normalized.includes("UNKNOWN SETTING") ? "UNKNOWN_SETTING"
    : normalized.includes("UNKNOWN DATA TYPE") ? "UNKNOWN_DATA_TYPE"
    : normalized.includes("UNKNOWN IDENTIFIER") ? "UNKNOWN_IDENTIFIER"
    : normalized.includes("SYNTAX ERROR") ? "SYNTAX_ERROR"
    : normalized.includes("ILLEGAL TYPE OF ARGUMENT") ? "ILLEGAL_ARGUMENT"
    : normalized.includes("BAD ARGUMENTS") ? "BAD_ARGUMENTS"
    : normalized.includes("TABLE ALREADY EXISTS") ? "TABLE_ALREADY_EXISTS"
    : normalized.includes("UNKNOWN DATABASE") ? "UNKNOWN_DATABASE"
    : "PROVIDER_ERROR";
  const code = body.match(/\bCode:\s*([0-9]+)/iu)?.[1];
  const safeCategory = code === "27" ? "INPUT_PARSE_ERROR" : category;
  const safeFields = [
    "run_id",
    "source",
    "resource_scope",
    "cache_date",
    "request_kind",
    "source_status",
    "requested_by_subject_key",
    "snapshot_id",
    "rank_date",
    "started_at",
    "completed_at",
    "fetched_at",
    "duration_ms",
    "item_count",
    "error_code",
    "source_contract_version",
    "source_version",
    "raw_payload_sha256",
    "source_updated_at",
    "synced_at",
    "retention_until",
  ] as const;
  const field = safeFields.find((candidate) =>
    new RegExp(`(?:column|field)[^\\n]{0,80}\\b${candidate}\\b`, "iu").test(body));
  return [
    safeCategory,
    ...(code ? [`code=${code}`] : []),
    ...(field ? [`field=${field}`] : []),
  ].join(":");
}

export class ByteHouseHttpClient implements ByteHouseQueryClient {
  readonly #target: ByteHouseTarget;
  readonly #fetcher: FetchLike;

  constructor(
    target: ByteHouseTarget,
    fetcher?: FetchLike,
  ) {
    this.#target = target;
    this.#fetcher =
      fetcher
      ?? (target.sshTunnelPort
        ? createLoopbackTunnelFetcher(target.sshTunnelPort)
        : fetch as unknown as FetchLike);
  }

  async query(sql: string): Promise<string> {
    const url = new URL(this.#target.endpoint);
    // ByteHouse's documented HTTP contract accepts user/password query
    // parameters. This URL is never printed, persisted or included in errors.
    url.searchParams.set("user", this.#target.username);
    url.searchParams.set("password", this.#target.password);

    let response: FetchResponseLike;
    try {
      response = await this.#fetcher(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: sql,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        `ByteHouse ${this.#target.environment} 数据面请求失败，endpoint/凭据/SQL 不回显`,
      );
    }

    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new Error(
        `ByteHouse ${this.#target.environment} 数据面响应读取失败，正文不回显`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `ByteHouse ${this.#target.environment} 数据面返回 HTTP ${response.status} `
          + `(${classifyProviderError(body)})，响应正文不回显`,
      );
    }
    return body;
  }

  async queryJson<T>(sql: string): Promise<readonly T[]> {
    return parseRows<T>(await this.query(sql), "JSON query");
  }
}

function parseRows<T>(source: string, purpose: string): readonly T[] {
  try {
    const parsed = JSON.parse(source) as JsonResponse<T>;
    if (!Array.isArray(parsed.data)) throw new Error("missing data");
    return parsed.data;
  } catch {
    throw new Error(`ByteHouse ${purpose} 不是预期 JSON，响应正文不回显`);
  }
}

function normalizePrimaryKey(value: string): string {
  return value.replaceAll(/[\s()`]/gu, "");
}

function validateTimestamp(timestamp: string): void {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u.test(timestamp)) {
    throw new Error("S55-HW timestamp 必须是 UTC 毫秒格式");
  }
  const iso = `${timestamp.replace(" ", "T")}Z`;
  if (!Number.isFinite(Date.parse(iso))) {
    throw new Error("S55-HW timestamp 不是有效 UTC 时间");
  }
}

function createTableSql(): string {
  return [
    `CREATE TABLE IF NOT EXISTS ${S55_HW_DATABASE}.${S55_HW_TABLE}`,
    "(",
    "  hello_key String COMMENT 'S55-HW 稳定幂等键',",
    "  owner_project String COMMENT '数据归属项目',",
    "  created_at DateTime64(3, 'UTC') COMMENT '首次写入 UTC 时间'",
    ")",
    "ENGINE = CnchMergeTree()",
    "ORDER BY (hello_key)",
    "PRIMARY KEY (hello_key)",
    "COMMENT = 'S55-HW dev 最小真实链路表'",
  ].join("\n");
}

function insertSql(timestamp: string): string {
  return [
    `INSERT INTO ${S55_HW_DATABASE}.${S55_HW_TABLE}`,
    "  (hello_key, owner_project, created_at)",
    `SELECT '${S55_HW_ROW_KEY}', '${S55_HW_OWNER}',`,
    `  toDateTime64('${timestamp}', 3, 'UTC')`,
    "FROM system.one",
    "WHERE NOT EXISTS (",
    `  SELECT 1 FROM ${S55_HW_DATABASE}.${S55_HW_TABLE}`,
    `  WHERE hello_key = '${S55_HW_ROW_KEY}'`,
    ")",
  ].join("\n");
}

function readRowSql(): string {
  return [
    "SELECT hello_key, owner_project, created_at",
    `FROM ${S55_HW_DATABASE}.${S55_HW_TABLE}`,
    `WHERE hello_key = '${S55_HW_ROW_KEY}'`,
    "ORDER BY created_at",
    "FORMAT JSON",
  ].join("\n");
}

function validateSingleRow(
  source: string,
  purpose: "首次写入" | "重放",
): HelloWorldRow {
  const rows = parseRows<HelloWorldRow>(source, `${purpose} readonly 回读`);
  const observedTimestamp = rows[0]?.created_at ?? "";
  const timestampIsValid =
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3,6}$/u.test(observedTimestamp)
    && Number.isFinite(Date.parse(`${observedTimestamp.replace(" ", "T")}Z`));
  const valid =
    rows.length === 1
    && rows[0]?.hello_key === S55_HW_ROW_KEY
    && rows[0]?.owner_project === S55_HW_OWNER
    && timestampIsValid;
  if (!valid) {
    const reason = purpose === "重放" ? "重放幂等验证失败" : "app 写入/readonly 回读验证失败";
    throw new Error(`${reason}，行值与响应正文不回显`);
  }
  return rows[0] as HelloWorldRow;
}

async function verifySchema(client: ByteHouseQueryClient): Promise<void> {
  const tableRows = parseRows<SystemTableRow>(
    await client.query([
      "SELECT engine, primary_key",
      "FROM system.tables",
      `WHERE database = '${S55_HW_DATABASE}'`,
      `  AND name = '${S55_HW_TABLE}'`,
      "FORMAT JSON",
    ].join("\n")),
    "system.tables 校验",
  );
  if (
    tableRows.length !== 1
    || tableRows[0]?.engine !== "CnchMergeTree"
    || normalizePrimaryKey(tableRows[0]?.primary_key ?? "") !== "hello_key"
  ) {
    throw new Error("S55-HW 表引擎或主键校验失败，元数据不回显");
  }

  const columnRows = parseRows<SystemColumnRow>(
    await client.query([
      "SELECT name, type",
      "FROM system.columns",
      `WHERE database = '${S55_HW_DATABASE}'`,
      `  AND table = '${S55_HW_TABLE}'`,
      "ORDER BY position",
      "FORMAT JSON",
    ].join("\n")),
    "system.columns 校验",
  );
  const expected = [
    ["hello_key", "String"],
    ["owner_project", "String"],
    ["created_at", "DateTime64(3, 'UTC')"],
  ];
  const actual = columnRows.map((row) => [row.name, row.type]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("S55-HW 字段校验失败，元数据不回显");
  }
}

export async function executeS55HelloWorld(input: {
  readonly app: ByteHouseQueryClient;
  readonly readonly: ByteHouseQueryClient;
  readonly timestamp: string;
}): Promise<S55HelloWorldResult> {
  validateTimestamp(input.timestamp);
  await input.app.query(
    `CREATE DATABASE IF NOT EXISTS ${S55_HW_DATABASE} ENGINE = Cnch`,
  );
  await input.app.query(createTableSql());
  await verifySchema(input.app);

  const insert = insertSql(input.timestamp);
  await input.app.query(insert);
  const firstRead = validateSingleRow(
    await input.readonly.query(readRowSql()),
    "首次写入",
  );

  // This is a deliberately sequential replay proof for today's Hello World.
  // The WHERE NOT EXISTS insertion is replay-safe for this single controlled
  // run; it is not advertised as a concurrent upsert primitive.
  await input.app.query(insert);
  const replayRead = validateSingleRow(
    await input.readonly.query(readRowSql()),
    "重放",
  );
  if (JSON.stringify(replayRead) !== JSON.stringify(firstRead)) {
    throw new Error("重放幂等验证失败，行值与响应正文不回显");
  }

  return {
    environment: S55_HW_ENVIRONMENT,
    database: S55_HW_DATABASE,
    table: S55_HW_TABLE,
    rowCount: 1,
    appWriteVerified: true,
    readonlyReadVerified: true,
    replayIdempotent: true,
    schemaVerified: true,
  };
}

function utcDateTime64(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("S55-HW now 不是有效时间");
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export async function runS55HelloWorld(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetcher?: FetchLike;
  readonly now?: Date;
}): Promise<S55HelloWorldResult> {
  const credentials = loadByteHouseCredentials(input.env);
  const app = new ByteHouseHttpClient(credentials.app, input.fetcher);
  const readonly = new ByteHouseHttpClient(credentials.readonly, input.fetcher);
  return executeS55HelloWorld({
    app,
    readonly,
    timestamp: utcDateTime64(input.now ?? new Date()),
  });
}

export function formatS55Receipt(
  mode: "apply",
  result: S55HelloWorldResult,
): string {
  return [
    "S55 ByteHouse provision: S55_HW_DONE",
    `mode=${mode}`,
    `environment=${result.environment}`,
    `database=${result.database}`,
    `table=${result.table}`,
    `row_count=${result.rowCount}`,
    `app_write_verified=${result.appWriteVerified}`,
    `readonly_read_verified=${result.readonlyReadVerified}`,
    `replay_idempotent=${result.replayIdempotent}`,
    `schema_verified=${result.schemaVerified}`,
    "idempotency_scope=sequential_controlled_replay",
    "credential_values=redacted",
    "endpoint_value=redacted",
    "provider_response_body=redacted",
  ].join("\n");
}
