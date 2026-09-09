import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_PRODUCTION_HOSTS, resolveEffectiveCliE2eTarget } from "./production-target-guard.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const productionHosts = E2E_PRODUCTION_HOSTS;

function run(command: string, args: string[], cwd: string): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", reject);
  child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  return promise;
}

async function main(): Promise<void> {
  const cliRepository = path.resolve(
    process.env.E2E_CLI_REPOSITORY_DIR
      ?? path.join(path.dirname(repoRoot), "zhongwen-shortdrama-cli"),
  );
  const envFile = path.resolve(
    process.env.E2E_ENV_FILE?.trim() || path.join(repoRoot, ".env"),
  );
  const artifactDir = path.resolve(
    process.env.E2E_CLI_ARTIFACT_DIR
      ?? path.join(repoRoot, "artifacts", "cli-product-e2e"),
  );
  const summaryPath = path.resolve(
    process.env.E2E_CLI_SUMMARY_PATH ?? path.join(artifactDir, "cli-summary.json"),
  );
  const paidSummaryPath = path.resolve(
    process.env.E2E_CLI_PAID_REDLINE_SUMMARY_PATH
      ?? path.join(artifactDir, "paid-redlines.json"),
  );
  const envFileText = await readFile(envFile, "utf8").catch(() => "");
  const cliTarget = resolveEffectiveCliE2eTarget(
    productionHosts,
    process.env,
    envFileText,
  );
  if (cliTarget) {
    process.env.CLI_E2E_BASE_URL = cliTarget;
    process.env.SHORTDRAMA_API_BASE = cliTarget;
  }
  const releaseTag = process.env.CLI_E2E_RELEASE_TAG?.trim();
  if (!releaseTag) throw new Error("缺少 CLI_E2E_RELEASE_TAG，无法从真实 Release 包安装。");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const paidExit = await run(
    npx,
    ["--no-install", "tsx", "scripts/e2e/run-cli-paid-redlines.mts"],
    repoRoot,
  );
  if (paidExit !== 0) {
    process.exitCode = paidExit;
    return;
  }
  const python = process.env.PYTHON_BIN?.trim() || (process.platform === "win32" ? "python" : "python3");
  const cliExit = await run(
    python,
    [
      "scripts/e2e/run_cli_product_e2e.py",
      "--release-tag",
      releaseTag,
      "--env-file",
      envFile,
      "--summary",
      summaryPath,
      "--artifact-dir",
      artifactDir,
      "--paid-redline-summary",
      paidSummaryPath,
    ],
    cliRepository,
  );
  process.exitCode = cliExit;
}

main().catch((error) => {
  process.stderr.write(`CLI 产品 E2E 没跑起来：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
