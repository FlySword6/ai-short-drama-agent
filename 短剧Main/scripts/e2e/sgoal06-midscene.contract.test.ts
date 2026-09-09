import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const config = read("./sgoal06-midscene.playwright.config.ts");
const smoke = read("./sgoal06-midscene.smoke.spec.ts");
const packageJson = read("../../package.json");

test("S-goal-06 合同：命令、JSON 与 Midscene HTML 报告已注册", () => {
  assert.match(packageJson, /"e2e:sgoal06:midscene"/);
  assert.match(config, /playwright-results\.json/);
  assert.match(config, /@midscene\/web\/playwright-reporter/);
  assert.match(config, /MIDSCENE_RUN_DIR/);
  assert.match(smoke, /smoke-summary\.json/);
});

test("S-goal-06 合同：凭据加载、生产域保护与确定性登录存在", () => {
  assert.match(config, /sharedRoot/);
  assert.match(config, /worktreeRoot/);
  assert.match(smoke, /TEST_ENV_ADMIN_USERNAME/);
  assert.match(smoke, /TEST_ENV_ADMIN_PASSWORD/);
  assert.match(smoke, /MIDSCENE_MODEL_API_KEY/);
  assert.match(smoke, /productionHosts/);
  assert.match(smoke, /assertProductionTargetAllowed/);
  /* 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08),登录选择器改用
     不随之变化的 data-testid(2026-08-05 首跑故障：旧断言锁死 autocomplete="username"，
     产品把默认态切到 "email" 后测试永远等不到元素）。 */
  assert.ok(smoke.includes('getByTestId("login-username-input")'));
  assert.ok(smoke.includes('getByTestId("login-password-input")'));
  assert.ok(smoke.includes('getByTestId("login-submit-button")'));
});

test("S-goal-06 合同：九项路径、页面断言和单次生成保护存在", () => {
  for (const path of ["/projects", "/assets?scope=personal", "/dashboard", "/settings", "/admin", "/director"]) {
    assert.match(smoke, new RegExp(path.replaceAll("?", "\\?")));
  }
  assert.match(smoke, /discoverProjectPath/);
  assert.match(smoke, /assertPageIsNotBlank/);
  assert.match(smoke, /waitForBusinessReady/);
  /* 块 2:旧枢纽页「生成本集」按钮随退役消失(语义归 P-04 整段开拍),生产页(集视图)恒在锚点=「更多」。 */
  assert.match(smoke, /name: \/更多\//);
  assert.match(smoke, /waitForURL\(\(url\) => url\.pathname === `\/projects\/\$\{ids\.projectId\}\/production`/);
  /* sgoal06 块 3:生成环节=段落工作台逐镜重生成(「开拍」=段落工作台恒在锚点),旧镜级单图表单退役。 */
  assert.match(smoke, /name: "开拍", exact: true/);
  assert.match(smoke, /name: "刷新数据"/);
  assert.match(smoke, /name: "导出 CSV"/);
  assert.match(smoke, /\.ds-viewport canvas/);
  assert.match(smoke, /agent\.aiAssert/);
  assert.match(smoke, /segment_generation_once/);
  assert.match(smoke, /getByRole\("button", \{ name: "确认生成", exact: true \}\)/);
  assert.match(smoke, /performWithVisibleFeedback/);
  assert.match(smoke, /DEFAULT_FEEDBACK_MAX_MS = 500/);
  assert.match(smoke, /request_segment_generation/);
  assert.match(smoke, /\(\) => regen\.click\(\)/);
  assert.match(smoke, /getByRole\("button", \{ name: "确认费用并生成", exact: true \}\)/);
  assert.match(smoke, /confirm_segment_generation/);
  assert.match(smoke, /\(\) => review\.click\(\)/);
  assert.match(smoke, /feedback_probes: feedbackProbes/);
  assert.match(smoke, /SGOAL06_REUSE_GENERATION_EVIDENCE/);
  assert.match(smoke, /历史生成证据未证明生成链已到达/);
  assert.match(config, /retries: 0/);
  assert.doesNotMatch(smoke, /retryGeneration/);
});
