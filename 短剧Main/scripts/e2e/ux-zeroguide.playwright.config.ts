import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "@playwright/test";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharedRoot = path.resolve(worktreeRoot, "../..");

// 与 ux-baseline 同一套加载:共享根 .env(MIDSCENE_* 在这层)给默认,worktree .env 覆盖。
for (const envFile of [path.join(sharedRoot, ".env"), path.join(worktreeRoot, ".env")]) {
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: true, quiet: true });
}
process.env.MIDSCENE_RUN_DIR ??= path.join(worktreeRoot, "artifacts", "ux-zeroguide", "midscene-run");

const artifactDir = path.resolve(
  process.env.UX_ZEROGUIDE_ARTIFACT_DIR ?? path.join(worktreeRoot, "artifacts", "ux-zeroguide"),
);

export default defineConfig({
  testDir: ".",
  testMatch: "ux-zeroguide.smoke.spec.ts",
  // 零指导:AI 自主多步规划,单跑最慢(T1 含真实拆解)约 6 分钟;单 test 三跑上限 25 分钟。
  timeout: 1_500_000,
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
