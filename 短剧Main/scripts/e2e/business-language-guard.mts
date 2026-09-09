import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BusinessLanguageSummary } from "./ux-metrics.mts";

const guardFiles = [
  "frontend/shortdrama-rag-demo/src/s17-dev-copy-guard.test.ts",
  "test/copy-error-envelopes.test.ts",
  "test/copy-batch2-error-language.test.ts",
];

async function productionFiles(directory: string, options: { excludeDirector?: boolean } = {}): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || (options.excludeDirector && entry.name === "director")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await productionFiles(absolute, options));
    } else if (
      entry.isFile()
      && /\.(?:ts|tsx)$/u.test(entry.name)
      && !entry.name.endsWith(".test.ts")
    ) {
      files.push(absolute);
    }
  }
  return files;
}

async function backendGuardDirectories(repoRoot: string): Promise<string[]> {
  const source = await readFile(
    path.join(repoRoot, "test", "copy-batch2-error-language.test.ts"),
    "utf8",
  );
  const match = source.match(/const batchTwoModulePaths = \[([\s\S]*?)\] as const;/u);
  if (!match?.[1]) throw new Error("无法从业务话守卫读取后端模块清单");
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((item) => (
    path.join(repoRoot, "src", "modules", item[1]!)
  ));
}

async function assessedFileCount(repoRoot: string): Promise<number> {
  const frontendFiles = await productionFiles(
    path.join(repoRoot, "frontend", "shortdrama-rag-demo", "src"),
    { excludeDirector: true },
  );
  const backendDirectories = await backendGuardDirectories(repoRoot);
  const backendFiles = (await Promise.all(backendDirectories.map((directory) => productionFiles(directory)))).flat();
  return new Set([...frontendFiles, ...backendFiles]).size;
}

async function runGuards(repoRoot: string): Promise<{ exitCode: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", ...guardFiles],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const exitCode = signal ? 1 : code ?? 1;
      const raw = Buffer.concat(output).toString("utf8").replaceAll(/\u001B\[[0-9;]*m/g, "");
      const error = exitCode === 0
        ? undefined
        : raw.split(/\r?\n/u).filter(Boolean).slice(-12).join(" ").slice(0, 2_000);
      resolve({ exitCode, error });
    });
  });
}

export async function runBusinessLanguageGuard(
  repoRoot: string,
  outputPath: string,
  generatedAt = new Date(),
): Promise<BusinessLanguageSummary> {
  const assessedFiles = await assessedFileCount(repoRoot);
  const result = await runGuards(repoRoot);
  const summary: BusinessLanguageSummary = {
    schema_version: "business-language-guard.v1",
    generated_at: generatedAt.toISOString(),
    ok: result.exitCode === 0,
    assessed_files: assessedFiles,
    compliant_files: result.exitCode === 0 ? assessedFiles : null,
    rate_pct: result.exitCode === 0 ? 100 : null,
    guard_files: guardFiles,
    ...(result.error ? { error: result.error } : {}),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return summary;
}
