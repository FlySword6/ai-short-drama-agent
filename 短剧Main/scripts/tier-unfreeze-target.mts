import { createHash } from "node:crypto";

export const TIER_UNFREEZE_BATCH_ID = "ark-common-cheapest-v1";
export const TIER_UNFREEZE_TEST_ENV_BATCH_ID = "ark-test-env-portrait-image-v1";
/** Lite 批次二 2.5 专用接入点的 dev 解冻批次。 */
export const TIER_UNFREEZE_LITE_B2_BATCH_ID = "ark-lite-b2-video-v1";
export type TierUnfreezeTarget = "dev" | "test-env";

export function assertTierUnfreezeDatabaseTransport(input: {
  target: TierUnfreezeTarget;
  sslMode: string;
  rootCertPath?: string;
}): void {
  if (input.target !== "test-env") return;
  if (input.sslMode !== "verify-full") {
    throw new Error("拒绝执行:test-env 档位解冻必须使用 PostgreSQL verify-full");
  }
  if (!input.rootCertPath?.trim()) {
    throw new Error("拒绝执行:test-env 档位解冻必须配置 PostgreSQL CA");
  }
}

export function tierUnfreezeTargetIdentitySha256(
  databaseUrl: string | undefined,
  schema: string,
): string {
  const identity = databaseIdentityParts(databaseUrl);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error("拒绝执行:目标 schema 无效");
  }
  return createHash("sha256").update([
    identity.protocol,
    identity.username,
    identity.hostname,
    identity.port,
    identity.database,
    schema,
  ].join("|")).digest("hex");
}

export function assertTierUnfreezeTargetIdentity(input: {
  target: TierUnfreezeTarget;
  databaseUrl?: string;
  schema: string;
  expectedSha256?: string;
  appEnvironment: string;
}): void {
  if (input.target === "dev" && input.appEnvironment !== "development") {
    throw new Error("拒绝执行:档位解冻只允许 development 运行时");
  }
  if (input.target === "test-env" && input.appEnvironment !== "production") {
    throw new Error("拒绝执行:test-env 档位解冻只允许测试部署的 production 运行时");
  }
  if (/(^|[_-])(prod|production|test|testing)($|[_-])/iu.test(input.schema)) {
    throw new Error(`拒绝执行:${input.target} 解冻不能指向 production/test schema`);
  }
  if (!input.expectedSha256) {
    throw new Error(`拒绝执行:缺少包含 schema 的 ${input.target} 解冻目标指纹`);
  }
  if (tierUnfreezeTargetIdentitySha256(input.databaseUrl, input.schema) !== input.expectedSha256) {
    throw new Error(`拒绝执行:数据库或 schema 不是已批准的 ${input.target} 解冻目标`);
  }
}

export function databaseIdentityParts(databaseUrl: string | undefined): {
  protocol: string;
  username: string;
  hostname: string;
  port: string;
  database: string;
} {
  if (!databaseUrl) throw new Error("拒绝执行:数据库连接未配置");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("拒绝执行:数据库连接地址无效");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("拒绝执行:数据库连接必须使用 PostgreSQL");
  }
  const database = url.pathname.replace(/^\/+/u, "");
  if (!url.username || !url.hostname || !database) {
    throw new Error("拒绝执行:数据库身份字段不完整");
  }
  return {
    protocol: url.protocol,
    username: url.username,
    hostname: url.hostname.toLowerCase(),
    port: url.port || "5432",
    database,
  };
}
