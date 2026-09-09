import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const BYTEHOUSE_SCHEMA_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "bytehouse",
  "migrations",
);

export const BYTEHOUSE_ENDPOINT_ALLOWLIST_PATH = path.resolve(
  import.meta.dirname,
  "..",
  "bytehouse",
  "endpoint-allowlist.json",
);

export type ByteHouseEnvironment = "dev" | "test" | "prod";
export type ByteHouseCredentialRole = "app" | "readonly";

export const BYTEHOUSE_DATABASES = [
  {
    environment: "dev",
    database: "shortdrama_analytics",
    endpointEnv: "BYTEHOUSE_DEV_HTTP_ENDPOINT",
    appUsernameEnv: "BYTEHOUSE_DEV_APP_USERNAME",
    appPasswordEnv: "BYTEHOUSE_DEV_APP_PASSWORD",
    readonlyUsernameEnv: "BYTEHOUSE_DEV_READONLY_USERNAME",
    readonlyPasswordEnv: "BYTEHOUSE_DEV_READONLY_PASSWORD",
  },
  {
    environment: "test",
    database: "shortdrama_analytics",
    endpointEnv: "BYTEHOUSE_TEST_HTTP_ENDPOINT",
    appUsernameEnv: "BYTEHOUSE_TEST_APP_USERNAME",
    appPasswordEnv: "BYTEHOUSE_TEST_APP_PASSWORD",
    readonlyUsernameEnv: "BYTEHOUSE_TEST_READONLY_USERNAME",
    readonlyPasswordEnv: "BYTEHOUSE_TEST_READONLY_PASSWORD",
  },
  {
    environment: "prod",
    database: "shortdrama_analytics",
    endpointEnv: "BYTEHOUSE_PROD_HTTP_ENDPOINT",
    appUsernameEnv: "BYTEHOUSE_PROD_APP_USERNAME",
    appPasswordEnv: "BYTEHOUSE_PROD_APP_PASSWORD",
    readonlyUsernameEnv: "BYTEHOUSE_PROD_READONLY_USERNAME",
    readonlyPasswordEnv: "BYTEHOUSE_PROD_READONLY_PASSWORD",
  },
] as const;

export const BYTEHOUSE_REQUIRED_SCHEMA_CAPABILITIES = [
  "cdw_inverted_ngram_2",
  "vector_hnsw_1024_cosine",
] as const;
const HTTP_TIMEOUT_MS = 20_000;

export interface MigrationLedgerEntry {
  readonly file: string;
  readonly sha256: string;
  readonly tables: readonly string[];
  readonly views: readonly string[];
}

interface MigrationLedger {
  readonly version: number;
  readonly database_placeholder: string;
  readonly migrations: readonly MigrationLedgerEntry[];
}

export interface ExpectedColumn {
  readonly name: string;
  readonly type: string;
  readonly comment: string;
}

export interface ExpectedConstraint {
  readonly name: string;
  readonly expression: string;
}

export interface ExpectedIndex {
  readonly name: string;
  readonly definition: string;
}

export interface ExpectedTable {
  readonly name: string;
  readonly source: string;
  readonly columns: readonly ExpectedColumn[];
  readonly engine: string;
  readonly orderBy: string;
  readonly partitionBy: string;
  readonly primaryKey: string;
  readonly ttl: string;
  readonly settings: string;
  readonly comment: string;
  readonly constraints: readonly ExpectedConstraint[];
  readonly indexes: readonly ExpectedIndex[];
}

export interface ExpectedView {
  readonly name: string;
  readonly source: string;
}

export interface ByteHouseSchemaBundle {
  readonly ledger: MigrationLedger;
  readonly manifestSha256: string;
  readonly migrations: ReadonlyArray<{
    readonly file: string;
    readonly sha256: string;
    readonly statements: readonly string[];
  }>;
  readonly tables: readonly ExpectedTable[];
  readonly views: readonly ExpectedView[];
}

export interface ByteHouseSchemaTarget {
  readonly environment: ByteHouseEnvironment;
  readonly database: string;
  readonly endpointEnv: string;
  readonly credentialRole: ByteHouseCredentialRole;
  readonly usernameEnv: string;
  readonly passwordEnv: string;
  readonly endpoint: URL;
  readonly username: string;
  readonly password: string;
}

export interface ApprovedEndpointAllowlist {
  readonly source: string;
  readonly approvals: Readonly<
    Partial<
      Record<
        ByteHouseEnvironment,
        {
          readonly approvedBy: "Fable";
          readonly approvedAt: string;
          readonly fingerprint: string;
          readonly manifestSha256: string;
          readonly capabilities: readonly string[];
          readonly capabilityEvidenceSha256: Readonly<Record<string, string>>;
          readonly applyAuthorization?: {
            readonly approvedBy: "Fable";
            readonly approvedAt: string;
            readonly expiresAt: string;
            readonly manifestSha256: string;
          };
          readonly devVerifiedManifestSha256?: string;
        }
      >
    >
  >;
}

export interface EndpointApprovalMaterial {
  readonly version: 2;
  readonly environment: ByteHouseEnvironment;
  readonly origin_sha256: string;
}

interface ByteHouseJsonResponse<T> {
  readonly data?: readonly T[];
}

interface SystemTableRow {
  readonly name: string;
  readonly engine: string;
  readonly partition_key: string;
  readonly sorting_key: string;
  readonly primary_key: string;
  readonly comment: string;
  readonly create_table_query: string;
}

interface SystemColumnRow {
  readonly table: string;
  readonly name: string;
  readonly type: string;
  readonly comment: string;
}

interface IdentityRow {
  readonly current_user: string;
  readonly current_database: string;
  readonly server_version: string;
}

export interface SchemaVerificationResult {
  readonly environment: string;
  readonly database: string;
  readonly tables: number;
  readonly views: number;
  readonly columns: number;
}

export type SchemaInspectionState = "empty" | "partial" | "complete";

export interface ByteHouseSchemaQueryClient {
  query(sql: string): Promise<string>;
  queryJson<T>(sql: string): Promise<readonly T[]>;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text">>;

function sha256(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ByteHouse schema ledger 字段 ${field} 非法`);
  }
  return value;
}

function parseLedger(source: string): MigrationLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error("ByteHouse schema ledger 不是合法 JSON");
  }
  if (!raw || typeof raw !== "object") throw new Error("ByteHouse schema ledger 结构非法");
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.database_placeholder !== "{{database}}") {
    throw new Error("ByteHouse schema ledger 版本或数据库占位符不受支持");
  }
  if (!Array.isArray(candidate.migrations) || candidate.migrations.length !== 6) {
    throw new Error("ByteHouse schema ledger 必须登记六个不可变迁移文件");
  }
  const migrations = candidate.migrations.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`ByteHouse schema ledger migrations[${index}] 结构非法`);
    }
    const row = entry as Record<string, unknown>;
    if (!Array.isArray(row.tables)) {
      throw new Error(`ByteHouse schema ledger migrations[${index}].tables 必须是数组`);
    }
    const rawViews = row.views ?? [];
    if (!Array.isArray(rawViews)) {
      throw new Error(`ByteHouse schema ledger migrations[${index}].views 必须是数组`);
    }
    if (row.tables.length === 0 && rawViews.length === 0) {
      throw new Error(`ByteHouse schema ledger migrations[${index}] 未登记任何对象`);
    }
    return {
      file: requireString(row.file, `migrations[${index}].file`),
      sha256: requireString(row.sha256, `migrations[${index}].sha256`),
      tables: row.tables.map((table, tableIndex) =>
        requireString(table, `migrations[${index}].tables[${tableIndex}]`)),
      views: rawViews.map((view, viewIndex) =>
        requireString(view, `migrations[${index}].views[${viewIndex}]`)),
    };
  });
  return { version: 1, database_placeholder: "{{database}}", migrations };
}

export function parseEndpointAllowlist(
  source: string,
  requiredEnvironments: readonly ByteHouseEnvironment[] = BYTEHOUSE_DATABASES.map(
    ({ environment }) => environment,
  ),
  expectedManifestSha256?: string,
  applyEnvironment?: ByteHouseEnvironment,
  now = new Date(),
): ApprovedEndpointAllowlist {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new Error("拒绝执行:ByteHouse endpoint allowlist 不是合法 JSON");
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("拒绝执行:ByteHouse endpoint allowlist 结构非法");
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.version !== 2) {
    throw new Error("拒绝执行:ByteHouse endpoint allowlist 版本不受支持");
  }
  if (typeof candidate.source !== "string" || !candidate.source.trim()) {
    throw new Error("拒绝执行:ByteHouse endpoint allowlist source 非法");
  }
  const sourceName = candidate.source;
  if (!candidate.environments || typeof candidate.environments !== "object") {
    throw new Error("拒绝执行:ByteHouse endpoint allowlist environments 非法");
  }
  const environments = candidate.environments as Record<string, unknown>;
  const approvals: ApprovedEndpointAllowlist["approvals"] = {};
  for (const environment of requiredEnvironments) {
    const rawEnvironment = environments[environment];
    if (!rawEnvironment || typeof rawEnvironment !== "object") {
      throw new Error(`拒绝执行:ByteHouse endpoint allowlist 缺少 ${environment}`);
    }
    const entry = rawEnvironment as Record<string, unknown>;
    if (entry.status !== "approved") {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${environment} 尚未由 Fable 独立批准`,
      );
    }
    if (entry.approved_by !== "Fable") {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${environment} 缺少 Fable 批准`,
      );
    }
    if (
      typeof entry.approved_at !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
        entry.approved_at,
      )
    ) {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${environment} 批准时间非法`,
      );
    }
    const fingerprint = entry.origin_sha256;
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${environment} 指纹非法，值不回显`,
      );
    }
    const manifestSha256 = entry.schema_manifest_sha256;
    if (
      typeof manifestSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(manifestSha256)
      || (
        expectedManifestSha256 !== undefined
        && manifestSha256 !== expectedManifestSha256
      )
    ) {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${environment} 未绑定当前 schema manifest`,
      );
    }
    const capabilities = entry.approved_capabilities;
    const requiredCapabilities = [...BYTEHOUSE_REQUIRED_SCHEMA_CAPABILITIES].sort();
    if (
      !Array.isArray(capabilities)
      || capabilities.some((value) => typeof value !== "string")
      || JSON.stringify([...capabilities].sort()) !== JSON.stringify(requiredCapabilities)
    ) {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${environment} 未批准当前全文/HNSW 能力集`,
      );
    }
    const rawCapabilityEvidence = entry.capability_evidence_sha256;
    if (
      !rawCapabilityEvidence
      || typeof rawCapabilityEvidence !== "object"
    ) {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${environment} 缺少能力验证证据摘要`,
      );
    }
    const capabilityEvidence = rawCapabilityEvidence as Record<string, unknown>;
    const evidenceKeys = Object.keys(capabilityEvidence).sort();
    if (
      JSON.stringify(evidenceKeys) !== JSON.stringify(requiredCapabilities)
      || requiredCapabilities.some(
        (capability) =>
          typeof capabilityEvidence[capability] !== "string"
          || !/^[a-f0-9]{64}$/.test(capabilityEvidence[capability] as string),
      )
    ) {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${environment} 能力验证证据摘要非法`,
      );
    }
    let applyAuthorization:
      | NonNullable<
        NonNullable<ApprovedEndpointAllowlist["approvals"][ByteHouseEnvironment]>[
          "applyAuthorization"
        ]
      >
      | undefined;
    if (applyEnvironment === environment) {
      const rawAuthorization = entry.apply_authorization;
      if (!rawAuthorization || typeof rawAuthorization !== "object") {
        throw new Error(
          `拒绝执行:ByteHouse endpoint allowlist ${environment} 缺少当次 apply 授权`,
        );
      }
      const authorization = rawAuthorization as Record<string, unknown>;
      if (
        authorization.status !== "approved"
        || authorization.approved_by !== "Fable"
        || typeof authorization.approved_at !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
          authorization.approved_at,
        )
        || typeof authorization.expires_at !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
          authorization.expires_at,
        )
        || authorization.schema_manifest_sha256 !== manifestSha256
      ) {
        throw new Error(
          `拒绝执行:ByteHouse endpoint allowlist ${environment} 当次 apply 授权非法`,
        );
      }
      const applyApprovedAt = Date.parse(authorization.approved_at);
      const applyExpiresAt = Date.parse(authorization.expires_at);
      if (
        applyExpiresAt <= applyApprovedAt
        || applyExpiresAt - applyApprovedAt > 4 * 60 * 60 * 1000
        || applyApprovedAt > now.getTime() + 5 * 60 * 1000
      ) {
        throw new Error(
          `拒绝执行:ByteHouse endpoint allowlist ${environment} 当次 apply 授权窗口非法`,
        );
      }
      if (applyExpiresAt <= now.getTime()) {
        throw new Error(
          `拒绝执行:ByteHouse endpoint allowlist ${environment} 当次 apply 授权已过期`,
        );
      }
      applyAuthorization = {
        approvedBy: "Fable",
        approvedAt: authorization.approved_at,
        expiresAt: authorization.expires_at,
        manifestSha256,
      };
    }
    let devVerifiedManifestSha256: string | undefined;
    if (environment !== "dev") {
      if (entry.dev_verified_manifest_sha256 !== manifestSha256) {
        throw new Error(
          `拒绝执行:ByteHouse endpoint allowlist ${environment} 未绑定 dev 同 manifest 验证收据`,
        );
      }
      devVerifiedManifestSha256 = manifestSha256;
    }
    approvals[environment] = {
      approvedBy: "Fable",
      approvedAt: entry.approved_at,
      fingerprint,
      manifestSha256,
      capabilities: requiredCapabilities,
      capabilityEvidenceSha256: Object.fromEntries(
        requiredCapabilities.map((capability) => [
          capability,
          capabilityEvidence[capability] as string,
        ]),
      ),
      ...(applyAuthorization ? { applyAuthorization } : {}),
      ...(devVerifiedManifestSha256
        ? { devVerifiedManifestSha256 }
        : {}),
    };
  }
  const fingerprints = Object.values(approvals).map(
    (approval) => approval?.fingerprint,
  );
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("拒绝执行:ByteHouse endpoint allowlist 已选环境指纹必须互不相同");
  }
  return {
    source: candidate.source,
    approvals,
  };
}

export async function loadEndpointAllowlist(
  requiredEnvironments: readonly ByteHouseEnvironment[],
  expectedManifestSha256: string,
  applyEnvironment?: ByteHouseEnvironment,
  allowlistPath = BYTEHOUSE_ENDPOINT_ALLOWLIST_PATH,
): Promise<ApprovedEndpointAllowlist> {
  try {
    return parseEndpointAllowlist(
      await readFile(allowlistPath, "utf8"),
      requiredEnvironments,
      expectedManifestSha256,
      applyEnvironment,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("拒绝执行:")) throw error;
    throw new Error("拒绝执行:ByteHouse endpoint allowlist 无法读取");
  }
}

/**
 * 受控 DDL 分句器。只在不处于单引号、反引号、行注释或块注释时把分号当终止符，
 * 避免中文注释或未来默认表达式里的符号误拆。
 */
export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let singleQuoted = false;
  let backtickQuoted = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (!singleQuoted && !backtickQuoted && char === "-" && next === "-") {
      current += `${char}${next}`;
      index += 1;
      lineComment = true;
      continue;
    }
    if (!singleQuoted && !backtickQuoted && char === "/" && next === "*") {
      current += `${char}${next}`;
      index += 1;
      blockComment = true;
      continue;
    }
    if (!backtickQuoted && char === "'") {
      current += char;
      if (singleQuoted && next === "'") {
        current += next;
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }
    if (!singleQuoted && char === "`") {
      backtickQuoted = !backtickQuoted;
      current += char;
      continue;
    }
    if (!singleQuoted && !backtickQuoted && char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (singleQuoted || backtickQuoted || blockComment) {
    throw new Error("ByteHouse DDL 存在未闭合的引号或注释");
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function parseClause(source: string, clause: string): string {
  const match = source.match(new RegExp(`\\n${clause}\\s+(.+?)(?=\\n[A-Z][A-Z ]+\\s|$)`, "s"));
  const value = match?.[1];
  if (!value) throw new Error(`ByteHouse DDL 缺少 ${clause}`);
  return value.trim();
}

export function parseExpectedTable(source: string): ExpectedTable {
  source = source.replace(/\r\n?/g, "\n");
  const nameMatch = source.match(
    /^CREATE TABLE IF NOT EXISTS \{\{database\}\}\.`([a-z][a-z0-9_]*)`/,
  );
  if (!nameMatch) throw new Error("ByteHouse DDL 表头必须使用 {{database}} 与受控表名");
  const name = nameMatch[1]!;
  const engineMatch = source.match(/\nENGINE\s*=\s*([A-Za-z0-9_]+)(?:\(\))?/);
  const tableCommentMatch = source.match(/\nCOMMENT\s*=\s*'([^']+)'$/);
  if (!engineMatch || !tableCommentMatch) {
    throw new Error(`${name}:引擎或中文表注释缺失`);
  }
  const columns = source
    .split("\n")
    .map((line) => line.match(/^\s+`([a-z][a-z0-9_]*)`\s+(.+?)\s+COMMENT\s+'([^']+)'[,]?$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      name: match[1]!,
      type: match[2]!.trim(),
      comment: match[3]!,
    }));
  if (columns.length === 0) throw new Error(`${name}:没有可解析的字段`);
  const constraints = source
    .split("\n")
    .map((line) =>
      line.match(
        /^\s+CONSTRAINT\s+`([a-z][a-z0-9_]*)`\s+CHECK\s+(.+?)[,]?$/,
      ))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      name: match[1]!,
      expression: match[2]!,
    }));
  const indexes = source
    .split("\n")
    .map((line) =>
      line.match(
        /^\s+INDEX\s+`?([a-z][a-z0-9_]*)`?\s+(.+?)[,]?$/,
      ))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      name: match[1]!,
      definition: match[2]!.trim(),
    }));
  return {
    name,
    source,
    columns,
    engine: engineMatch[1]!,
    orderBy: parseClause(source, "ORDER BY"),
    partitionBy: parseClause(source, "PARTITION BY"),
    primaryKey: parseClause(source, "PRIMARY KEY"),
    ttl: parseClause(source, "TTL"),
    settings: parseClause(source, "SETTINGS"),
    comment: tableCommentMatch[1]!,
    constraints,
    indexes,
  };
}

export function parseExpectedView(source: string): ExpectedView {
  source = source.replace(/\r\n?/g, "\n");
  const match = source.match(
    /^CREATE VIEW IF NOT EXISTS \{\{database\}\}\.`([a-z][a-z0-9_]*)`\s+AS\s+/,
  );
  if (!match) {
    throw new Error("ByteHouse VIEW DDL 必须使用 {{database}} 与受控视图名");
  }
  return { name: match[1]!, source };
}

export async function loadByteHouseSchema(
  root = BYTEHOUSE_SCHEMA_ROOT,
): Promise<ByteHouseSchemaBundle> {
  const ledger = parseLedger(await readFile(path.join(root, "ledger.json"), "utf8"));
  const databases = [...new Set(BYTEHOUSE_DATABASES.map(({ database }) => database))];
  if (databases.length !== 1) {
    throw new Error("ByteHouse schema manifest 要求三个 environment 使用同一逻辑数据库");
  }
  const manifestSha256 = sha256(JSON.stringify({
    version: 1,
    database: databases[0],
    ledger,
    requiredCapabilities: BYTEHOUSE_REQUIRED_SCHEMA_CAPABILITIES,
  }));
  const migrations: Array<{ file: string; sha256: string; statements: string[] }> = [];
  const tables: ExpectedTable[] = [];
  const views: ExpectedView[] = [];
  for (const entry of ledger.migrations) {
    const source = (await readFile(path.join(root, entry.file), "utf8")).replace(/\r\n?/g, "\n");
    const actualSha = sha256(source);
    if (actualSha !== entry.sha256) {
      throw new Error(`${entry.file}:checksum 与 ledger 不一致，拒绝 apply`);
    }
    const statements = splitSqlStatements(source);
    const parsedTables = statements
      .filter((statement) => /^CREATE TABLE IF NOT EXISTS /u.test(statement))
      .map(parseExpectedTable);
    const parsedViews = statements
      .filter((statement) => /^CREATE VIEW IF NOT EXISTS /u.test(statement))
      .map(parseExpectedView);
    if (parsedTables.length + parsedViews.length !== statements.length) {
      throw new Error(`${entry.file}:含未登记的非 TABLE/VIEW DDL`);
    }
    if (
      JSON.stringify(parsedTables.map((table) => table.name))
      !== JSON.stringify(entry.tables)
    ) {
      throw new Error(`${entry.file}:表清单与 ledger 不一致`);
    }
    if (
      JSON.stringify(parsedViews.map((view) => view.name))
      !== JSON.stringify(entry.views)
    ) {
      throw new Error(`${entry.file}:视图清单与 ledger 不一致`);
    }
    migrations.push({ file: entry.file, sha256: actualSha, statements });
    tables.push(...parsedTables);
    views.push(...parsedViews);
  }
  const uniqueNames = new Set(tables.map((table) => table.name));
  if (uniqueNames.size !== tables.length) throw new Error("ByteHouse DDL 出现重复表名");
  const uniqueViewNames = new Set(views.map((view) => view.name));
  if (uniqueViewNames.size !== views.length) throw new Error("ByteHouse DDL 出现重复视图名");
  for (const view of views) {
    if (uniqueNames.has(view.name)) throw new Error(`ByteHouse 对象重名:${view.name}`);
  }
  return { ledger, manifestSha256, migrations, tables, views };
}

function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`拒绝执行:环境变量 ${name} 未设置`);
  return value;
}

function parseEnvironmentEndpoint(raw: string, variable: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error(`拒绝执行:${variable} 不是合法 HTTPS URL，值不回显`);
  }
  if (endpoint.protocol !== "https:") {
    throw new Error(`拒绝执行:${variable} 必须使用 HTTPS，值不回显`);
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`拒绝执行:${variable} 不得内嵌账号、密码、query 或 fragment`);
  }
  if (endpoint.pathname !== "/" && endpoint.pathname !== "") {
    throw new Error(`拒绝执行:${variable} 必须指向 ByteHouse 原生 HTTP 根路径`);
  }
  if (endpoint.port !== "8123") {
    throw new Error(`拒绝执行:${variable} 必须显式使用端口 8123`);
  }
  return endpoint;
}

function endpointOriginFingerprint(endpoint: URL): string {
  return sha256(endpoint.origin);
}

function targetConfiguration(environment: ByteHouseEnvironment) {
  const target = BYTEHOUSE_DATABASES.find(
    (candidate) => candidate.environment === environment,
  );
  if (!target) throw new Error(`拒绝执行:不支持的 ByteHouse environment ${environment}`);
  return target;
}

export function createEndpointApprovalMaterial(
  env: Readonly<Record<string, string | undefined>>,
  environment: ByteHouseEnvironment,
): EndpointApprovalMaterial {
  const target = targetConfiguration(environment);
  const endpoint = parseEnvironmentEndpoint(
    requireEnv(env, target.endpointEnv),
    target.endpointEnv,
  );
  return {
    version: 2,
    environment,
    origin_sha256: endpointOriginFingerprint(endpoint),
  };
}

export function schemaTargetsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  allowlist: ApprovedEndpointAllowlist,
  environments: readonly ByteHouseEnvironment[] = BYTEHOUSE_DATABASES.map(
    ({ environment }) => environment,
  ),
  credentialRole: ByteHouseCredentialRole = "app",
): readonly ByteHouseSchemaTarget[] {
  const approvedFingerprints = Object.values(allowlist.approvals)
    .filter((approval) => approval !== undefined)
    .map((approval) => approval.fingerprint);
  if (new Set(approvedFingerprints).size !== approvedFingerprints.length) {
    throw new Error(
      "拒绝执行:已批准 environment 的 endpoint fingerprint 必须互不相同",
    );
  }
  const targetsWithoutCredentials = environments.map(targetConfiguration).map((target) => ({
    ...target,
    endpoint: parseEnvironmentEndpoint(
      requireEnv(env, target.endpointEnv),
      target.endpointEnv,
    ),
  })).map((target) => {
    const approval = allowlist.approvals[target.environment];
    if (!approval) {
      throw new Error(
        `拒绝执行:ByteHouse endpoint allowlist ${target.environment} 未载入批准项`,
      );
    }
    if (
      target.environment !== "dev"
      && (
        !allowlist.approvals.dev
        || approval.devVerifiedManifestSha256 !== approval.manifestSha256
      )
    ) {
      throw new Error(
        `拒绝执行:${target.environment} 缺少 dev-first 同 manifest 验证依赖`,
      );
    }
    if (endpointOriginFingerprint(target.endpoint) !== approval.fingerprint) {
      throw new Error(
        `拒绝执行:${target.endpointEnv} 与已批准 allowlist 不匹配，endpoint 不回显`,
      );
    }
    return target;
  });
  const origins = new Set(
    targetsWithoutCredentials.map((target) => target.endpoint.origin),
  );
  if (origins.size !== targetsWithoutCredentials.length) {
    throw new Error("拒绝执行:dev/test/prod 必须使用三个不同的 ByteHouse environment endpoint");
  }
  const fingerprints = new Set(
    targetsWithoutCredentials.map((target) =>
      endpointOriginFingerprint(target.endpoint)),
  );
  if (fingerprints.size !== targetsWithoutCredentials.length) {
    throw new Error("拒绝执行:已选 environment 的 endpoint fingerprint 必须互不相同");
  }
  return targetsWithoutCredentials.map((target) => {
    const usernameEnv = credentialRole === "app"
      ? target.appUsernameEnv
      : target.readonlyUsernameEnv;
    const passwordEnv = credentialRole === "app"
      ? target.appPasswordEnv
      : target.readonlyPasswordEnv;
    const username = requireEnv(env, usernameEnv);
    const password = requireEnv(env, passwordEnv);
    if (password.length < 12) {
      throw new Error(`拒绝执行:${passwordEnv} 长度不足，值不回显`);
    }
    return {
      environment: target.environment,
      database: target.database,
      endpointEnv: target.endpointEnv,
      credentialRole,
      usernameEnv,
      passwordEnv,
      endpoint: target.endpoint,
      username,
      password,
    };
  });
}

export function maskSecrets(text: string, secrets: readonly string[]): string {
  let masked = text;
  for (const secret of secrets) {
    if (secret.length >= 8) masked = masked.split(secret).join("***");
  }
  return masked;
}

export class ByteHouseHttpClient {
  readonly #target: ByteHouseSchemaTarget;
  readonly #fetch: FetchLike;

  constructor(target: ByteHouseSchemaTarget, fetcher: FetchLike = fetch) {
    this.#target = target;
    this.#fetch = fetcher;
  }

  async query(sql: string): Promise<string> {
    let response: Pick<Response, "ok" | "status" | "text">;
    try {
      response = await this.#fetch(this.#target.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-ClickHouse-User": this.#target.username,
          "X-ClickHouse-Key": this.#target.password,
        },
        body: sql,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        `ByteHouse ${this.#target.environment} 数据面请求失败，endpoint 与凭据不回显`,
      );
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `ByteHouse ${this.#target.environment} 数据面返回 HTTP ${response.status}，响应正文不回显`,
      );
    }
    return body;
  }

  async queryJson<T>(sql: string): Promise<readonly T[]> {
    const source = await this.query(sql);
    try {
      const parsed = JSON.parse(source) as ByteHouseJsonResponse<T>;
      if (!Array.isArray(parsed.data)) throw new Error("missing data");
      return parsed.data;
    } catch {
      throw new Error(
        `ByteHouse ${this.#target.environment} 回读不是预期 JSON，响应正文不回显`,
      );
    }
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`拒绝执行:ByteHouse 标识符不合法:${value}`);
  }
  return `\`${value}\``;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function renderTableSql(source: string, database: string): string {
  const rendered = source.replaceAll("{{database}}", quoteIdentifier(database));
  if (rendered.includes("{{database}}")) throw new Error("ByteHouse DDL 数据库占位符未替换完");
  return rendered;
}

/**
 * 仅供已经通过写前盘点且数据库已由 S55-HW 建好的目标调用。任何 DDL 失败立即停止，
 * 不尝试后续语句，也不做破坏性自动回滚；调用方必须把“可能部分完成”写入失败回执。
 */
export async function applySchemaMigrationsToExistingTarget(
  target: ByteHouseSchemaTarget,
  client: ByteHouseSchemaQueryClient,
  bundle: ByteHouseSchemaBundle,
): Promise<SchemaVerificationResult> {
  const databaseRows = await client.queryJson<{ object_count: string | number }>(
    `SELECT count() AS object_count FROM system.databases `
      + `WHERE name = ${quoteSqlString(target.database)} FORMAT JSON`,
  );
  if (Number(databaseRows[0]?.object_count ?? 0) !== 1) {
    throw new Error("拒绝执行:S55-HW 目标数据库不存在，不自动创建");
  }
  for (const migration of bundle.migrations) {
    for (const statement of migration.statements) {
      await client.query(renderTableSql(statement, target.database));
    }
  }
  return verifySchema(target, client, bundle);
}

function normalizeExpression(value: string): string {
  return value.replaceAll("`", "").replace(/\s+/g, "").replace(/^\((.*)\)$/s, "$1");
}

function normalizeType(value: string): string {
  return value.replace(/\s+/g, "");
}

function normalizedCreateQuery(value: string): string {
  return value.replaceAll("`", "").replace(/\s+/g, "").toLowerCase();
}

export function normalizeByteHouseTtlClause(value: string): string {
  return normalizedCreateQuery(value).replace(/delete$/u, "");
}

const BYTEHOUSE_PROVIDER_OWNED_SETTINGS = new Set([
  "cnch_vw_write",
  "storage_policy",
]);

export function normalizeByteHouseSettingsClause(value: string): string {
  return value
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => {
      const key = term.match(/^([a-z_][a-z0-9_]*)\s*=/iu)?.[1]?.toLowerCase();
      return !key || !BYTEHOUSE_PROVIDER_OWNED_SETTINGS.has(key);
    })
    .map(normalizedCreateQuery)
    .sort()
    .join(",");
}

export function extractByteHouseCreateTailClause(
  source: string,
  clause: "TTL" | "SETTINGS",
): string {
  const flat = source.replace(/\s+/g, " ").trim();
  const pattern = clause === "TTL"
    ? /\bTTL\s+(.+?)(?=\s+SETTINGS\s+|\s+COMMENT(?:\s*=)?\s+'|$)/i
    : /\bSETTINGS\s+(.+?)(?=\s+COMMENT(?:\s*=)?\s+'|$)/i;
  const value = flat.match(pattern)?.[1];
  if (!value) throw new Error(`ByteHouse 回读 CREATE DDL 缺少 ${clause}`);
  return value.trim();
}

function extractConstraintExpression(source: string, name: string): string {
  const normalized = normalizedCreateQuery(source);
  const marker = `constraint${normalizedCreateQuery(name)}check`;
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) throw new Error(`约束 ${name} 缺失`);
  const expressionStart = markerIndex + marker.length;
  const nextConstraint = normalized.indexOf(",constraint", expressionStart);
  const engine = normalized.indexOf(")engine=", expressionStart);
  if (engine < 0) throw new Error(`约束 ${name} 后未找到表引擎边界`);
  const expressionEnd = nextConstraint >= 0 && nextConstraint < engine
    ? nextConstraint
    : engine;
  return normalizeExpression(normalized.slice(expressionStart, expressionEnd));
}

function extractConstraintNames(source: string): string[] {
  return [...normalizedCreateQuery(source).matchAll(
    /constraint([a-z][a-z0-9_]*)check/g,
  )].map((match) => match[1]!).sort();
}

function extractCreateDefinitionBody(source: string): string {
  const bodyStart = source.indexOf("(");
  if (bodyStart < 0) throw new Error("ByteHouse 回读 CREATE DDL 缺少字段定义");
  let depth = 1;
  let singleQuoted = false;
  let backtickQuoted = false;
  for (let index = bodyStart + 1; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (singleQuoted) {
      if (char === "\\" && next !== undefined) {
        index += 1;
      } else if (char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (backtickQuoted) {
      if (char === "`") backtickQuoted = false;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
    } else if (char === "`") {
      backtickQuoted = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error("ByteHouse 回读 CREATE DDL 字段定义未闭合");
}

function splitTopLevelDefinitions(source: string): string[] {
  const definitions: string[] = [];
  let current = "";
  let depth = 0;
  let singleQuoted = false;
  let backtickQuoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    current += char;
    if (singleQuoted) {
      if (char === "\\" && next !== undefined) {
        current += next;
        index += 1;
      } else if (char === "'" && next === "'") {
        current += next;
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (backtickQuoted) {
      if (char === "`") backtickQuoted = false;
      continue;
    }
    if (char === "'") {
      singleQuoted = true;
    } else if (char === "`") {
      backtickQuoted = true;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      current = current.slice(0, -1);
      if (current.trim()) definitions.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) definitions.push(current.trim());
  return definitions;
}

function extractIndexDefinitions(source: string): ExpectedIndex[] {
  return splitTopLevelDefinitions(extractCreateDefinitionBody(source))
    .map((definition) =>
      definition.match(
        /^INDEX\s+`?([a-z][a-z0-9_]*)`?\s+([\s\S]+)$/i,
      ))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      name: match[1]!,
      definition: match[2]!.trim(),
    }));
}

function assertEqual(actual: string, expected: string, message: string): void {
  if (actual !== expected) throw new Error(message);
}

export async function readIdentity(
  client: ByteHouseSchemaQueryClient,
): Promise<IdentityRow> {
  const rows = await client.queryJson<IdentityRow>(
    "SELECT currentUser() AS current_user, currentDatabase() AS current_database, version() AS server_version FORMAT JSON",
  );
  if (rows.length !== 1) throw new Error("ByteHouse 身份回读行数不是一");
  return rows[0]!;
}

export function isExpectedByteHousePrincipalIdentity(
  actual: string,
  configured: string,
  environment: ByteHouseEnvironment,
): boolean {
  if (/^[0-9]{6,20}$/u.test(actual)) return true;
  const canonical = /^([^:]+)::([^:]+)::(dev|test|prod)$/u;
  const actualMatch = actual.match(canonical);
  const configuredMatch = configured.match(canonical);
  if (actualMatch && actualMatch[3] !== environment) return false;
  if (configuredMatch && configuredMatch[3] !== environment) return false;
  if (actual === configured) return true;
  if (configuredMatch && actual === configuredMatch[2]) return true;
  if (actualMatch && configured === actualMatch[2]) return true;
  return false;
}

export function assertGrantBoundary(
  grantSnapshot: string,
  target: Pick<
    ByteHouseSchemaTarget,
    "environment" | "database" | "credentialRole"
  >,
  options: { readonly allowTargetGrantOption?: boolean } = {},
): void {
  const normalized = grantSnapshot.replaceAll("`", "").toUpperCase();
  if (!normalized.trim()) {
    throw new Error(
      `拒绝执行:${target.environment}/${target.credentialRole} SHOW GRANTS 为空`,
    );
  }
  if (
    /\b(?:SYSTEM_ADMIN|SYSTEMADMIN|ACCOUNT_ADMIN|ACCOUNTADMIN)\b/.test(normalized)
    || /\bGRANT\s+ALL(?:\s+PRIVILEGES)?\b/.test(normalized)
    || (
      /\bWITH\s+GRANT\s+OPTION\b/.test(normalized)
      && !(target.credentialRole === "app" && options.allowTargetGrantOption)
    )
  ) {
    throw new Error(
      `拒绝执行:${target.environment}/${target.credentialRole} 权限超出最小边界，grant 不回显`,
    );
  }
  const targetDatabase = target.database.toUpperCase();
  const globalPrivileges = target.credentialRole === "app"
    ? new Set(["CREATE DATABASE", "USAGE"])
    : new Set(["USAGE"]);
  const targetPrivileges = target.credentialRole === "app"
    ? new Set([
      "CREATE",
      "CREATE DATABASE",
      "CREATE TABLE",
      "CREATE VIEW",
      "CREATE DICTIONARY",
      "INSERT",
      "SELECT",
      "SHOW",
      "SHOW DATABASES",
      "SHOW TABLES",
      "SHOW COLUMNS",
      "SHOW DICTIONARIES",
      "USAGE",
    ])
    : new Set(["SELECT", "USAGE"]);
  if (target.credentialRole === "app" && options.allowTargetGrantOption) {
    for (const privilege of [
      "ALTER TABLE",
      "ALTER VIEW",
      "DROP DATABASE",
      "DROP TABLE",
      "DROP VIEW",
      "DROP DICTIONARY",
      "TRUNCATE",
      "OPTIMIZE",
      "DICTGET",
    ]) {
      targetPrivileges.add(privilege);
    }
  }
  let hasTargetScope = false;
  let hasTargetSelect = false;
  let hasTargetCreateTable = false;
  let hasTargetCreateView = false;
  let hasTargetInsert = false;

  for (const line of normalized.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    if (!/\sON\s/.test(line) && /^GRANT\s+.+\s+TO\b/.test(line)) {
      throw new Error(
        `拒绝执行:${target.environment}/${target.credentialRole} 存在未展开角色授权，grant 不回显`,
      );
    }

    const parsed = line.match(
      /^GRANT\s+(.+?)\s+ON\s+([A-Z0-9_*.-]+)(?:\s+TO\b.*)?;?$/,
    );
    if (!parsed) {
      throw new Error(
        `拒绝执行:${target.environment}/${target.credentialRole} 存在无法解析的 grant，grant 不回显`,
      );
    }
    const [, privilegeList, scope] = parsed;
    const privileges = splitTopLevelDefinitions(privilegeList!)
      .map((privilege) =>
        privilege
          .replace(/\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*$/, "")
          .replace(/\s+/g, " ")
          .trim()
      );
    if (privileges.length === 0 || privileges.some((privilege) => !privilege)) {
      throw new Error(
        `拒绝执行:${target.environment}/${target.credentialRole} 存在空权限 grant，grant 不回显`,
      );
    }

    if (scope === "*.*") {
      if (privileges.some((privilege) => !globalPrivileges.has(privilege))) {
        throw new Error(
          `拒绝执行:${target.environment}/${target.credentialRole} 存在不在精确白名单内的全局权限，grant 不回显`,
        );
      }
      continue;
    }
    if (scope !== targetDatabase && !scope.startsWith(`${targetDatabase}.`)) {
      throw new Error(
        `拒绝执行:${target.environment}/${target.credentialRole} 存在目标库外权限，grant 不回显`,
      );
    }
    if (privileges.some((privilege) => !targetPrivileges.has(privilege))) {
      throw new Error(
        `拒绝执行:${target.environment}/${target.credentialRole} 存在不在精确白名单内的目标库权限，grant 不回显`,
      );
    }
    hasTargetScope = true;
    hasTargetSelect ||= privileges.includes("SELECT");
    hasTargetCreateTable ||= privileges.includes("CREATE") || privileges.includes("CREATE TABLE");
    hasTargetCreateView ||= privileges.includes("CREATE") || privileges.includes("CREATE VIEW");
    hasTargetInsert ||= privileges.includes("INSERT");
  }
  if (!hasTargetScope) {
    throw new Error(
      `拒绝执行:${target.environment}/${target.credentialRole} 未回读目标库权限，grant 不回显`,
    );
  }
  if (!hasTargetSelect) {
    throw new Error(
      `拒绝执行:${target.environment}/${target.credentialRole} 缺少 SELECT，grant 不回显`,
    );
  }
  if (
    target.credentialRole === "app"
    && (!hasTargetCreateTable || !hasTargetCreateView || !hasTargetInsert)
  ) {
    throw new Error(
      `拒绝执行:${target.environment}/app 缺少受控 CREATE TABLE/CREATE VIEW/INSERT 权限，grant 不回显`,
    );
  }
}

export async function verifyGrantBoundary(
  client: ByteHouseSchemaQueryClient,
  target: Pick<
    ByteHouseSchemaTarget,
    "environment" | "database" | "credentialRole"
  >,
  options: { readonly allowTargetGrantOption?: boolean } = {},
): Promise<void> {
  assertGrantBoundary(await client.query("SHOW GRANTS"), target, options);
}

async function readDomainTableRows(
  target: ByteHouseSchemaTarget,
  client: ByteHouseSchemaQueryClient,
): Promise<readonly SystemTableRow[]> {
  return client.queryJson<SystemTableRow>(`
SELECT name, engine, partition_key, sorting_key, primary_key, comment, create_table_query
FROM system.tables
WHERE database = ${quoteSqlString(target.database)}
ORDER BY name
FORMAT JSON
  `.trim());
}

const COMPATIBILITY_OBJECTS = new Set(["s55_hello_world"]);

function expectedObjectNames(bundle: ByteHouseSchemaBundle): string[] {
  return [
    ...bundle.tables.map((table) => table.name),
    ...bundle.views.map((view) => view.name),
  ].sort();
}

/**
 * 写前盘点。S55-HW 兼容表不属于域对象：只有它存在时仍视为域 schema 空白。
 * 域对象已完整存在则严格验证后跳过；已知对象的严格子集视为可恢复 partial，
 * 调用方只能重放 IF NOT EXISTS 迁移；额外对象或任一已存在结构漂移一律拒绝。
 */
export async function inspectSchemaState(
  target: ByteHouseSchemaTarget,
  client: ByteHouseSchemaQueryClient,
  bundle: ByteHouseSchemaBundle,
): Promise<SchemaInspectionState> {
  const tableRows = await readDomainTableRows(target, client);
  const expectedNames = expectedObjectNames(bundle);
  const relevantRows = tableRows.filter((row) => !COMPATIBILITY_OBJECTS.has(row.name));
  if (relevantRows.length === 0) return "empty";
  const actualNames = relevantRows.map((row) => row.name).sort();
  const expectedNameSet = new Set(expectedNames);
  if (actualNames.some((name) => !expectedNameSet.has(name))) {
    throw new Error(
      `ByteHouse ${target.environment}/${target.database} 写前对象清单漂移，远端名称不回显`,
    );
  }
  if (actualNames.length < expectedNames.length) return "partial";
  await verifySchema(target, client, bundle);
  return "complete";
}

export async function verifySchema(
  target: ByteHouseSchemaTarget,
  client: ByteHouseSchemaQueryClient,
  bundle: ByteHouseSchemaBundle,
): Promise<SchemaVerificationResult> {
  const tableRows = await readDomainTableRows(target, client);
  const expectedNames = expectedObjectNames(bundle);
  const relevantRows = tableRows.filter((row) => !COMPATIBILITY_OBJECTS.has(row.name));
  const actualNames = relevantRows.map((row) => row.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `ByteHouse ${target.environment}/${target.database} 对象清单漂移，远端名称不回显`,
    );
  }
  for (const expectedView of bundle.views) {
    const actual = relevantRows.find((row) => row.name === expectedView.name);
    if (!actual || actual.engine !== "View") {
      throw new Error(`${expectedView.name}:视图缺失或引擎漂移`);
    }
  }

  const columnRows = await client.queryJson<SystemColumnRow>(`
SELECT table, name, type, comment
FROM system.columns
WHERE database = ${quoteSqlString(target.database)}
  AND table IN (${bundle.tables.map(({ name }) => quoteSqlString(name)).join(", ")})
ORDER BY table, position
FORMAT JSON
  `.trim());
  const columnsByTable = new Map<string, SystemColumnRow[]>();
  for (const row of columnRows) {
    const group = columnsByTable.get(row.table) ?? [];
    group.push(row);
    columnsByTable.set(row.table, group);
  }

  for (const expected of bundle.tables) {
    const actual = relevantRows.find((row) => row.name === expected.name);
    if (!actual) throw new Error(`${target.database}.${expected.name}:表缺失`);
    assertEqual(actual.engine, expected.engine, `${expected.name}:引擎漂移`);
    assertEqual(
      normalizeExpression(actual.partition_key),
      normalizeExpression(expected.partitionBy),
      `${expected.name}:分区键漂移`,
    );
    assertEqual(
      normalizeExpression(actual.sorting_key),
      normalizeExpression(expected.orderBy),
      `${expected.name}:排序键漂移`,
    );
    assertEqual(
      normalizeExpression(actual.primary_key),
      normalizeExpression(expected.primaryKey),
      `${expected.name}:主键漂移`,
    );
    assertEqual(actual.comment, expected.comment, `${expected.name}:表注释漂移`);
    assertEqual(
      normalizeByteHouseTtlClause(
        extractByteHouseCreateTailClause(actual.create_table_query, "TTL"),
      ),
      normalizeByteHouseTtlClause(expected.ttl),
      `${expected.name}:TTL 漂移`,
    );
    assertEqual(
      normalizeByteHouseSettingsClause(
        extractByteHouseCreateTailClause(actual.create_table_query, "SETTINGS"),
      ),
      normalizeByteHouseSettingsClause(expected.settings),
      `${expected.name}:SETTINGS 漂移`,
    );
    const expectedConstraintNames = expected.constraints
      .map((constraint) => constraint.name)
      .sort();
    const actualConstraintNames = extractConstraintNames(
      actual.create_table_query,
    );
    if (
      JSON.stringify(actualConstraintNames)
      !== JSON.stringify(expectedConstraintNames)
    ) {
      throw new Error(`${expected.name}:约束集合漂移，远端名称不回显`);
    }
    for (const constraint of expected.constraints) {
      assertEqual(
        extractConstraintExpression(actual.create_table_query, constraint.name),
        normalizeExpression(normalizedCreateQuery(constraint.expression)),
        `${expected.name}:约束 ${constraint.name} 漂移`,
      );
    }
    const actualIndexes = extractIndexDefinitions(actual.create_table_query);
    const expectedIndexNames = expected.indexes.map(({ name }) => name).sort();
    const actualIndexNames = actualIndexes.map(({ name }) => name).sort();
    if (
      new Set(actualIndexNames).size !== actualIndexNames.length
      || JSON.stringify(actualIndexNames) !== JSON.stringify(expectedIndexNames)
    ) {
      throw new Error(`${expected.name}:索引集合漂移，远端名称不回显`);
    }
    for (const expectedIndex of expected.indexes) {
      const actualIndex = actualIndexes.find(
        ({ name }) => name === expectedIndex.name,
      );
      if (
        !actualIndex
        || normalizedCreateQuery(actualIndex.definition)
          !== normalizedCreateQuery(expectedIndex.definition)
      ) {
        throw new Error(`${expected.name}:索引 ${expectedIndex.name} 漂移`);
      }
    }

    const actualColumns = columnsByTable.get(expected.name) ?? [];
    if (actualColumns.length !== expected.columns.length) {
      throw new Error(
        `${expected.name}:字段数量漂移，期望 ${expected.columns.length}，实际 ${actualColumns.length}`,
      );
    }
    for (let index = 0; index < expected.columns.length; index += 1) {
      const expectedColumn = expected.columns[index];
      const actualColumn = actualColumns[index];
      if (!expectedColumn || !actualColumn) {
        throw new Error(`${expected.name}:第 ${index + 1} 字段无法回读`);
      }
      assertEqual(actualColumn.name, expectedColumn.name, `${expected.name}:第 ${index + 1} 字段名漂移`);
      assertEqual(
        normalizeType(actualColumn.type),
        normalizeType(expectedColumn.type),
        `${expected.name}.${expectedColumn.name}:类型漂移`,
      );
      assertEqual(
        actualColumn.comment,
        expectedColumn.comment,
        `${expected.name}.${expectedColumn.name}:注释漂移`,
      );
    }
  }

  return {
    environment: target.environment,
    database: target.database,
    tables: bundle.tables.length,
    views: bundle.views.length,
    columns: columnRows.length,
  };
}
