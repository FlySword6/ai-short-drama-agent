import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "@playwright/test";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharedRoot = path.resolve(worktreeRoot, "../..");

// 与 fe-block1 同一套凭据加载:共享根给默认值,worktree .env 覆盖;都不打印进报告。
for (const envFile of [path.join(sharedRoot, ".env"), path.join(worktreeRoot, ".env")]) {
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: true, quiet: true });
}

const artifactDir = path.resolve(
  process.env.UX_BASELINE_ARTIFACT_DIR ?? path.join(worktreeRoot, "artifacts", "ux-baseline"),
);

export default defineConfig({
  testDir: ".",
  testMatch: "ux-baseline.smoke.spec.ts",
  // T1 三遍各含一次真实 AI 拆解(本地 ARK 网关),单遍最长 ~5 分钟;单 test 上限 25 分钟。
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
