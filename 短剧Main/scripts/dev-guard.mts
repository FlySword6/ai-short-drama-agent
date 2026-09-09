/**
 * dev 环境防呆护栏（任务 D 验收核心）。
 *
 * 背景：本仓库曾经"配置错了但服务照样起来，错误延迟到用户点登录才暴露"——
 * 本地开发误连云上 RDS 是最坏的一类事故（云上同一实例并存多套数据模型，
 * 连错 schema 会写到别人的活数据）。dev 环境必须 fail fast：数据库目标
 * 不是本机时显眼报错并拒绝继续。
 *
 * 本模块是纯逻辑，不 import src/，供 scripts/dev-up.mts、scripts/dev-reset.mts、
 * `npm run dev`（启动期检查）与 test/ 下的护栏测试共同使用。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** 云上 RDS / 云主机特征：命中即拒绝，报"你指向了云"。 */
const CLOUD_HOST_PATTERNS: readonly RegExp[] = [
  // 火山引擎 RDS PostgreSQL 实例端点（私网/公网），含 configmap 中的真实主机形态。
  /\.rds-pg\.ivolces\.com$/i,
  /\.rds\.ivolces\.com$/i,
  /\.rds\.volces\.com$/i,
  // 其他云厂商 RDS 常见形态，同样不许出现在 dev。
  /\.rds\.amazonaws\.com$/i,
  /\.database\.azure\.com$/i,
];

/** dev 只接受这些数据库主机。不在名单内一律拒绝（fail-closed）。 */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

export interface DevEnvLike {
  readonly [key: string]: string | undefined;
}

/** 从 dev 环境变量中解析出数据库主机：DATABASE_URL 优先，其次 POSTGRES_HOST。 */
export function resolvePostgresHost(env: DevEnvLike): string | undefined {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    let url: URL;
    try {
      url = new URL(databaseUrl);
    } catch {
      throw new Error(`dev 护栏：DATABASE_URL 无法解析（${maskUrl(databaseUrl)}），先修正再启动`);
    }
    return url.hostname.toLowerCase();
  }
  const host = env.POSTGRES_HOST?.trim();
  return host ? host.toLowerCase() : undefined;
}

function maskUrl(value: string): string {
  return value.replace(/\/\/[^@/]*@/, "//***@");
}

function assertNotCloud(host: string): void {
  for (const pattern of CLOUD_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error(
        `dev 护栏拒绝启动：数据库主机 ${host} 是云端 RDS。\n`
        + "dev 环境绝不连云库——云上并存多套数据模型，连错就会写到别人的活数据。\n"
        + "修复：把 .env 的 POSTGRES_HOST 改回 localhost（或删掉 DATABASE_URL），"
        + "然后 npm run dev:up 用本机 Docker 起一套可弃数据库。",
      );
    }
  }
}

/**
 * 校验 dev 数据库目标。任何不满足的情况都抛错（显眼、中文、给修复路径）：
 * - 完全没有数据库配置；
 * - 主机命中云端特征；
 * - 主机不是本机（fail-closed，防"改个名字绕开特征表"）。
 */
export function assertDevDatabaseTarget(env: DevEnvLike): void {
  const host = resolvePostgresHost(env);
  if (!host) {
    throw new Error(
      "dev 护栏：没有找到数据库配置（DATABASE_URL 或 POSTGRES_HOST）。\n"
      + "修复：先跑 npm run dev:up ——它会从 .env.example 生成本机 dev 配置并起好数据库。",
    );
  }
  assertNotCloud(host);
  if (!LOCAL_HOSTNAMES.has(host)) {
    throw new Error(
      `dev 护栏拒绝启动：数据库主机 ${host} 不是本机。\n`
      + "dev 只准连 localhost/127.0.0.1/::1；要联调测试环境请走部署流程，不要在 dev 配置里指过去。",
    );
  }
}

/** 读取 .env 文件内容（不依赖 src/，与 src/config/env.ts 的兼容解析规则一致）。 */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) values[key] = value;
  }
  return values;
}

/**
 * 计算生效配置：.env 提供底值，真实环境变量优先（与 src/config/env.ts 的
 * loadCompatibleDotEnv 语义一致：process.env 已定义的键不被 .env 覆盖）。
 */
export function effectiveDevEnv(
  dotenvValues: Record<string, string>,
  processEnv: DevEnvLike = process.env,
): Record<string, string | undefined> {
  const effective: Record<string, string | undefined> = { ...dotenvValues };
  for (const key of ["DATABASE_URL", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_SCHEMA"]) {
    if (processEnv[key] !== undefined) effective[key] = processEnv[key];
  }
  return effective;
}

/** CLI 入口：`tsx scripts/dev-guard.mts`，被 `npm run dev` 与 dev:up/reset 调用。 */
function main(): void {
  const envPath = path.resolve(".env");
  const dotenvValues = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {};
  if (!existsSync(envPath) && !process.env.DATABASE_URL && !process.env.POSTGRES_HOST) {
    console.error("dev 护栏：没有 .env。先跑 npm run dev:up 生成本机 dev 配置。");
    process.exitCode = 1;
    return;
  }
  const effective = effectiveDevEnv(dotenvValues);
  try {
    assertDevDatabaseTarget(effective);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  console.log(`dev 护栏通过：数据库目标是本机 ${resolvePostgresHost(effective)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main();
}
