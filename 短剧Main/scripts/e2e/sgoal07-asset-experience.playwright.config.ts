import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "@playwright/test";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharedRoot = path.resolve(worktreeRoot, "../..");

// 共享根提供测试站凭据；worktree .env 可覆盖。任何值都不写入报告。
for (const envFile of [path.join(sharedRoot, ".env"), path.join(worktreeRoot, ".env")]) {
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: true, quiet: true });
}

const artifactDir = path.resolve(
  process.env.SGOAL07_ASSET_EXPERIENCE_ARTIFACT_DIR
    ?? path.join(worktreeRoot, "artifacts", "sgoal07-asset-experience"),
);
process.env.MIDSCENE_RUN_DIR = path.join(artifactDir, "midscene");

export default defineConfig({
  testDir: ".",
  testMatch: "sgoal07-asset-experience.smoke.spec.ts",
  timeout: 120_000,
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
    /* 2026-08-05 首跑故障：登录步手写的 catch 块截图曾大概率没落地——测试超时收线的那一刻，
       补救截图这句可能还没跑完就被打断（且 .catch(() => undefined) 会把这个失败悄悄吞掉）。
       换成 Playwright 自己的失败留证机制：它是测试生命周期自身收尾的一部分，不用跟已经耗尽
       的测试超时抢时间。screenshot 安全——密码框渲染成掩码圆点，图里不会露明文。 */
    screenshot: "only-on-failure",
    // trace 仍然关着：它会把 DOM 快照和带 Authorization 头的网络请求整份存进 CI 附件——
    // 登录用的是真实测试账号密码和会话令牌，开 trace 等于把这些明文一起上传，维持原作者的判断。
    trace: "off",
  },
});
