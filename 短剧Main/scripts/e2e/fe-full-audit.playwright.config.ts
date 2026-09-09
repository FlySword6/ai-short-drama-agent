import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "@playwright/test";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharedRoot = path.resolve(worktreeRoot, "../..");

// 与 sgoal06 同链:共享根 .env 打底,worktree .env 覆盖;两者都不会被报告打印。
for (const envFile of [path.join(sharedRoot, ".env"), path.join(worktreeRoot, ".env")]) {
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: true, quiet: true });
}

const artifactDir = path.resolve(
  process.env.FE_FULL_AUDIT_ARTIFACT_DIR ?? path.join(worktreeRoot, "artifacts", "fe-full-audit"),
);
process.env.MIDSCENE_RUN_DIR ??= path.join(artifactDir, "midscene");

export default defineConfig({
  testDir: ".",
  testMatch: "fe-full-audit.smoke.spec.ts",
  timeout: 600_000,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(artifactDir, "playwright-results.json") }],
    ["@midscene/web/playwright-reporter", { type: "merged", outputFormat: "single-html" }],
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
