import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "@playwright/test";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharedRoot = path.resolve(worktreeRoot, "../..");

// 与 fe-b1-batch1 同一套凭据加载:共享根给默认值,worktree .env 覆盖;都不打印进报告。
for (const envFile of [path.join(sharedRoot, ".env"), path.join(worktreeRoot, ".env")]) {
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: true, quiet: true });
}

const artifactDir = path.resolve(
  process.env.FE_BLOCK1_PRODVIEW_ARTIFACT_DIR ?? path.join(worktreeRoot, "artifacts", "fe-block1-prodview"),
);

export default defineConfig({
  testDir: ".",
  testMatch: "fe-block1-prodview.smoke.spec.ts",
  timeout: 120_000,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(artifactDir, "playwright-results.json") }],
  ],
  use: {
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "off",
    trace: "off",
  },
});
