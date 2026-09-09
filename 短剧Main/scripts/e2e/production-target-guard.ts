export const E2E_PRODUCTION_OPT_IN_ENV = "E2E_ALLOW_PRODUCTION_TARGET";

export const E2E_PRODUCTION_HOSTS: ReadonlySet<string> = new Set([
  "shortdrama-main.col.com",
  "shortdrama.col.com",
  "shortdrama-main-prod.col.com",
]);

export function assertProductionTargetAllowed(
  url: URL,
  productionHosts: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    productionHosts.has(url.hostname.toLowerCase())
    && env[E2E_PRODUCTION_OPT_IN_ENV] !== "1"
  ) {
    throw new Error(
      `拒绝生产域名：${url.hostname}；如已取得生产测评授权，请显式设置 ${E2E_PRODUCTION_OPT_IN_ENV}=1`,
    );
  }
}

export function resolveCliE2eTarget(
  configured: string | undefined,
  productionHosts: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = configured?.trim();
  if (!value) {
    if (env[E2E_PRODUCTION_OPT_IN_ENV] === "1") {
      throw new Error(
        "生产测评包含 CLI 时必须显式设置 SHORTDRAMA_API_BASE 或 CLI_E2E_BASE_URL；不能沿用 CLI 的测试环境默认值",
      );
    }
    return undefined;
  }
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("CLI E2E 目标必须是 http(s) 地址");
  }
  assertProductionTargetAllowed(url, productionHosts, env);
  return url.origin;
}

export function resolveEffectiveCliE2eTarget(
  productionHosts: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
  envFileText = "",
): string | undefined {
  const fileShortdramaBase = readEnvFileValue(envFileText, "SHORTDRAMA_API_BASE");
  const fileCliBase = readEnvFileValue(envFileText, "CLI_E2E_BASE_URL");
  return resolveCliE2eTarget(
    env.SHORTDRAMA_API_BASE
      ?? fileShortdramaBase
      ?? env.CLI_E2E_BASE_URL
      ?? fileCliBase,
    productionHosts,
    env,
  );
}

function readEnvFileValue(source: string, wanted: string): string | undefined {
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    if (line.slice(0, separator).trim() !== wanted) continue;
    const rawValue = line.slice(separator + 1).trim();
    if (
      rawValue.length >= 2
      && (rawValue[0] === "'" || rawValue[0] === "\"")
      && rawValue.at(-1) === rawValue[0]
    ) {
      return rawValue.slice(1, -1);
    }
    return rawValue;
  }
  return undefined;
}
