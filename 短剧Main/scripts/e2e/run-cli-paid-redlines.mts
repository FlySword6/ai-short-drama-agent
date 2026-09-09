import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
  });
}

async function main(): Promise<void> {
  const output = path.resolve(
    process.env.E2E_CLI_PAID_REDLINE_SUMMARY_PATH
      ?? path.join(repoRoot, "artifacts", "cli-product-e2e", "paid-redlines.json"),
  );
  const cliRepository = path.resolve(
    process.env.E2E_CLI_REPOSITORY_DIR
      ?? path.join(path.dirname(repoRoot), "zhongwen-shortdrama-cli"),
  );
  const quoteTest = await readFile(
    path.join(repoRoot, "tests", "generation-quotes-db.test.ts"),
    "utf8",
  );
  const expectedCodes = [
    "GENERATION_QUOTE_UNCONFIRMED",
    "GENERATION_QUOTE_EXPIRED",
    "GENERATION_QUOTE_CONFLICT",
  ];
  for (const code of expectedCodes) {
    if (!quoteTest.includes(code)) throw new Error(`报价真库测试缺少红线断言：${code}`);
  }
  const cliSourceRoot = path.join(cliRepository, "src", "shortdrama_cli");
  const cliSourceFiles = (await readdir(cliSourceRoot, {
    recursive: true,
    withFileTypes: true,
  }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
    .map((entry) => path.join(entry.parentPath, entry.name));
  const cliSource = (await Promise.all(
    cliSourceFiles.map((file) => readFile(file, "utf8")),
  )).join("\n");
  if (cliSource.includes("--yes")) {
    throw new Error("CLI 发行命令面出现 --yes，付费红线不通过。");
  }
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const exitCode = await run(
    executable,
    ["run", "test:generation-quotes-db"],
    repoRoot,
  );
  const summary = {
    schema_version: "cli-paid-redlines.v1",
    generated_at: new Date().toISOString(),
    ok: exitCode === 0,
    pending_quote_rejected: exitCode === 0,
    expired_quote_rejected: exitCode === 0,
    mismatched_quote_rejected: exitCode === 0,
    no_yes_path: !cliSource.includes("--yes"),
    postgres_test_exit_code: exitCode,
    evidence: {
      postgres_test: path.join(repoRoot, "tests", "generation-quotes-db.test.ts"),
      cli_repository: cliRepository,
    },
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`CLI 付费红线摘要：${output}\n`);
  if (!summary.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`CLI 付费红线没通过：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
