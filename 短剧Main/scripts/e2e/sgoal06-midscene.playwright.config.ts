import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "@playwright/test";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharedRoot = path.resolve(worktreeRoot, "../..");

// 共享根提供默认联调凭据；worktree 的 .env 可以用来覆盖，且两者都不会被报告打印。
for (const envFile of [path.join(sharedRoot, ".env"), path.join(worktreeRoot, ".env")]) {
  if (existsSync(envFile)) loadDotenv({ path: envFile, override: true, quiet: true });
}

const artifactDir = path.resolve(
  process.env.SGOAL06_ARTIFACT_DIR ?? path.join(worktreeRoot, "artifacts", "sgoal06-midscene"),
);
process.env.MIDSCENE_RUN_DIR ??= path.join(artifactDir, "midscene");

export default defineConfig({
  testDir: ".",
  testMatch: "sgoal06-midscene.smoke.spec.ts",
  /* sgoal06 块 3:段落生成回填窗口(默认 360s)+九页走动>120s;单测超时放宽到 15 分钟。 */
  timeout: 900_000,
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
    // 与 S50-E5 探针一致，复用开发机已有 Chrome，避免首次冒烟还需另跑浏览器下载命令。
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
    /* 2026-08-05 首跑故障：登录步手写的 catch 块截图曾大概率没落地——测试超时收线的那一刻，
       补救截图这句可能还没跑完就被打断（且 .catch(() => undefined) 会把这个失败悄悄吞掉）。
       换成 Playwright 自己的失败留证机制：它是测试生命周期自身收尾的一部分，不用跟已经耗尽
       的测试超时抢时间。screenshot 安全——密码框渲染成掩码圆点，图里不会露明文。
       trace 仍然不开：它会把 DOM 快照和网络请求（含 Authorization 头）整份存进 CI 附件，
       登录用的是真实测试账号密码和会话令牌，开 trace 等于把这些明文一起上传，风险大于收益。 */
    screenshot: "only-on-failure",
    trace: "off",
  },
});
