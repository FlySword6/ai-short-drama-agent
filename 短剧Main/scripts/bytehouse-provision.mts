#!/usr/bin/env -S npx --no-install tsx
/**
 * S55 ByteHouse 四域 dev-only 初始化执行面。
 *
 * 复用 S55-HW 已验证的私网/固定 loopback tunnel 传输和凭据格式校验。
 * 本脚本不接受 test/prod，不读取历史 endpoint allowlist，也不打印 endpoint、
 * username、password、SQL 响应正文或 grant 正文。
 */
import {
  inspectSchemaState,
  applySchemaMigrationsToExistingTarget,
  isExpectedByteHousePrincipalIdentity,
  loadByteHouseSchema,
  readIdentity,
  verifyGrantBoundary,
  verifySchema,
  type ByteHouseCredentialRole,
  type ByteHouseSchemaBundle,
  type ByteHouseSchemaTarget,
} from "./bytehouse-schema.mts";
import {
  ByteHouseHttpClient,
  loadByteHouseCredentials,
  type ByteHouseCredentials,
  type ByteHouseTarget,
} from "./bytehouse-s55-hw.mts";

type Mode = "dry-run" | "apply" | "verify";

interface Input {
  readonly mode: Mode;
  readonly environment?: string;
  readonly confirm?: string;
  readonly help: boolean;
}

interface SchemaContext {
  readonly bundle: ByteHouseSchemaBundle;
  readonly target: ByteHouseSchemaTarget;
  readonly client: ByteHouseHttpClient;
}

const ENVIRONMENT = "dev";
const DATABASE = "shortdrama_analytics";
const CONFIRMATION = "APPLY_BYTEHOUSE_S55_DOMAINS_DEV";

function takeValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要一个值`);
  return value;
}

function parseArgs(args: readonly string[]): Input {
  let mode: Mode = "dry-run";
  let modeSelected = false;
  let environment: string | undefined;
  let confirm: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--dry-run" || arg === "--apply" || arg === "--verify") {
      if (modeSelected) throw new Error("执行模式互斥，只能选择一个");
      modeSelected = true;
      mode = arg.slice(2) as Mode;
    } else if (arg === "--environment") {
      environment = takeValue(args, ++index, arg);
    } else if (arg === "--confirm") {
      confirm = takeValue(args, ++index, arg);
    } else {
      throw new Error(`未知参数:${arg}`);
    }
  }

  return { mode, environment, confirm, help };
}

function requireDev(input: Input): void {
  if (input.environment !== ENVIRONMENT) {
    throw new Error(`拒绝执行:${input.mode} 仅允许显式 --environment dev`);
  }
}

function printDryRun(): void {
  process.stdout.write([
    "S55 ByteHouse domains provision: DEV_READY",
    "environment=dev",
    "database=shortdrama_analytics",
    "domain_tables=7",
    "control_tables=1",
    "consumer_views=10",
    "shortdrama_entity_action=none",
    "test_prod_action=none",
    "network_operations=0",
    "environment_reads=0",
    "write_operations=0",
    "",
    "Apply:",
    "  npx tsx scripts/bytehouse-provision.mts --apply --environment dev \\",
    `    --confirm ${CONFIRMATION}`,
    "Verify:",
    "  npx tsx scripts/bytehouse-provision.mts --verify --environment dev",
  ].join("\n") + "\n");
}

function printHelp(): void {
  process.stdout.write([
    "S55 ByteHouse 四域 dev-only 初始化",
    "",
    "  npx tsx scripts/bytehouse-provision.mts --dry-run",
    "  npx tsx scripts/bytehouse-provision.mts --verify --environment dev",
    "  npx tsx scripts/bytehouse-provision.mts --apply --environment dev \\",
    `    --confirm ${CONFIRMATION}`,
    "",
    "dry-run 不读 env、不联网。apply/verify 复用 S55-HW 私网 tunnel。",
    "test/prod 会在读取 env 或联网前拒绝。",
  ].join("\n") + "\n");
}

function targetFor(
  credentials: ByteHouseCredentials,
  credentialRole: ByteHouseCredentialRole,
): ByteHouseSchemaTarget {
  const credential = credentials[credentialRole] as ByteHouseTarget;
  return {
    environment: ENVIRONMENT,
    database: DATABASE,
    endpointEnv: "BYTEHOUSE_DEV_HTTP_ENDPOINT",
    credentialRole,
    usernameEnv: credentialRole === "app"
      ? "BYTEHOUSE_DEV_APP_USERNAME"
      : "BYTEHOUSE_DEV_READONLY_USERNAME",
    passwordEnv: credentialRole === "app"
      ? "BYTEHOUSE_DEV_APP_PASSWORD"
      : "BYTEHOUSE_DEV_READONLY_PASSWORD",
    endpoint: new URL(credential.endpoint),
    username: credential.username,
    password: credential.password,
  };
}

async function prepareSchemaContext(
  bundle: ByteHouseSchemaBundle,
  credentials: ByteHouseCredentials,
  credentialRole: ByteHouseCredentialRole,
): Promise<SchemaContext> {
  const target = targetFor(credentials, credentialRole);
  const client = new ByteHouseHttpClient(credentials[credentialRole]);
  return { bundle, target, client };
}

async function assertIdentity(
  context: SchemaContext,
  options: { readonly allowTargetGrantOption?: boolean } = {},
): Promise<string> {
  const identity = await readIdentity(context.client);
  if (!isExpectedByteHousePrincipalIdentity(
    identity.current_user,
    context.target.username,
    context.target.environment,
  )) {
    throw new Error(
      `拒绝执行:dev currentUser 与 ${context.target.usernameEnv} 不一致，值不回显`,
    );
  }
  if (!identity.server_version.trim()) {
    throw new Error("拒绝执行:dev 未回读到 ByteHouse server version");
  }
  await verifyGrantBoundary(context.client, context.target, options);
  return identity.current_user;
}

async function queryAllConsumerViews(context: SchemaContext): Promise<void> {
  for (const view of context.bundle.views) {
    await context.client.query(
      `SELECT count() FROM \`${DATABASE}\`.\`${view.name}\` FORMAT JSON`,
    );
  }
}

async function assertReadonlyCannotWrite(context: SchemaContext): Promise<void> {
  try {
    await context.client.query(`
INSERT INTO \`${DATABASE}\`.\`sync_watermarks\`
  (domain, batch_id, source_cursor, source_version, row_count, synced_at, retention_until)
VALUES (
  '__readonly_negative_check__',
  'readonly-negative-check',
  '{}',
  0,
  0,
  now64(3),
  now64(3) + INTERVAL 90 DAY
)
    `.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("(NOT_ENOUGH_PRIVILEGES")) return;
    if (message.includes("(CONSTRAINT_ERROR")) {
      throw new Error(
        "拒绝执行:readonly 身份拥有 INSERT；安全探针被表约束拒绝且未落行",
      );
    }
    throw new Error("拒绝执行:readonly 写权限负向探针结果不可判定");
  }
  throw new Error(
    "拒绝执行:readonly 身份可写入且绕过了水位表 domain 约束",
  );
}

async function verifyReadonly(context: SchemaContext): Promise<{
  readonly tables: number;
  readonly views: number;
  readonly columns: number;
}> {
  await assertIdentity(context);
  const result = await verifySchema(context.target, context.client, context.bundle);
  await queryAllConsumerViews(context);
  await assertReadonlyCannotWrite(context);
  return result;
}

async function runVerify(): Promise<void> {
  const bundle = await loadByteHouseSchema();
  const credentials = loadByteHouseCredentials(process.env);
  const readonlyContext = await prepareSchemaContext(bundle, credentials, "readonly");
  const result = await verifyReadonly(readonlyContext);
  process.stdout.write(
    `[verify] environment=dev database=${DATABASE} domain_tables=7 `
      + `control_tables=1 views=${result.views} columns=${result.columns} `
      + "readonly_views=OK readonly_write=DENIED status=OK\n",
  );
}

async function runApply(confirm: string | undefined): Promise<void> {
  if (confirm !== CONFIRMATION) {
    throw new Error(`拒绝执行:dev 写操作需要 --confirm ${CONFIRMATION}`);
  }

  const bundle = await loadByteHouseSchema();
  const credentials = loadByteHouseCredentials(process.env);
  const appContext = await prepareSchemaContext(bundle, credentials, "app");
  const readonlyContext = await prepareSchemaContext(bundle, credentials, "readonly");
  const appIdentity = await assertIdentity(
    appContext,
    { allowTargetGrantOption: true },
  );
  const readonlyIdentity = await assertIdentity(readonlyContext);
  if (appIdentity === readonlyIdentity) {
    throw new Error("拒绝执行:app 与 readonly 回读为同一 ByteHouse principal，值不回显");
  }
  const state = await inspectSchemaState(
    appContext.target,
    appContext.client,
    appContext.bundle,
  );

  let stateLabel = "already_complete";
  if (state !== "complete") {
    try {
      await applySchemaMigrationsToExistingTarget(
        appContext.target,
        appContext.client,
        appContext.bundle,
      );
      stateLabel = state === "empty" ? "initialized" : "resumed_partial";
    } catch (error) {
      const reason = error instanceof Error ? error.message : "未知安全错误";
      throw new Error(
        "[apply] environment=dev 初始化中断；可能留下部分 CREATE 结果，"
          + `禁止自动清理，可安全重放同一 IF NOT EXISTS 迁移。原因:${reason}`,
      );
    }
  }

  const result = await verifyReadonly(readonlyContext);
  process.stdout.write(
    `[apply] environment=dev database=${DATABASE} state=${stateLabel} `
      + `domain_tables=7 control_tables=1 views=${result.views} columns=${result.columns} `
      + "readonly_views=OK readonly_write=DENIED status=OK\n",
  );
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  if (input.help) return printHelp();
  if (input.mode === "dry-run") return printDryRun();
  requireDev(input);
  if (input.mode === "verify") return runVerify();
  return runApply(input.confirm);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "bytehouse-provision failed");
  process.exitCode = 1;
});
