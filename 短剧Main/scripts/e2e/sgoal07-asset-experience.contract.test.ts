import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const config = read("./sgoal07-asset-experience.playwright.config.ts");
const smoke = read("./sgoal07-asset-experience.smoke.spec.ts");
const packageJson = read("../../package.json");

test("S-goal-07 资产体验合同：独立命令、Midscene HTML 与脱敏 JSON 报告已注册", () => {
  assert.match(packageJson, /"e2e:sgoal07:asset-experience"/);
  assert.match(config, /sgoal07-asset-experience\.smoke\.spec\.ts/);
  assert.match(config, /playwright-results\.json/);
  assert.match(config, /@midscene\/web\/playwright-reporter/);
  assert.match(config, /trace: "off"/);
  assert.match(smoke, /experience-summary\.json/);
  assert.doesNotMatch(smoke, /playwright_trace/);
});

test("S-goal-07 资产体验合同：三项阈值可配置且默认口径冻结", () => {
  assert.match(smoke, /DEFAULT_FIRST_SCREEN_MAX_MS = 3_000/);
  assert.match(smoke, /DEFAULT_MEDIA_READ_MAX_MS = 1_500/);
  assert.match(smoke, /DEFAULT_MEDIA_SWITCH_MAX_MS = 500/);
  assert.match(smoke, /SGOAL07_ASSET_FIRST_SCREEN_MAX_MS/);
  assert.match(smoke, /SGOAL07_MEDIA_READ_MAX_MS/);
  assert.match(smoke, /SGOAL07_MEDIA_SWITCH_MAX_MS/);
  assert.match(smoke, /observed_ms/);
  assert.match(smoke, /max_ms/);
});

test("S-goal-07 资产体验合同：验证真分页、媒体读取和可见切换，不触发生成或写接口", () => {
  assert.match(smoke, /scope=common/);
  assert.match(smoke, /pageSizes\[0\] === "24"/);
  assert.match(smoke, /request_count/);
  assert.match(smoke, /returned_item_count/);
  assert.match(smoke, /媒体版本列表/);
  assert.match(smoke, /aria-pressed/);
  assert.match(smoke, /main_preview_changed/);
  assert.match(smoke, /agent\.aiAssert/);
  assert.doesNotMatch(smoke, /生成图片/);
  assert.doesNotMatch(smoke, /confirm\.click/);
  assert.doesNotMatch(smoke, /method:\s*["'](?:POST|PUT|PATCH|DELETE)/);
  assert.match(smoke, /productionHosts/);
  assert.match(smoke, /assertProductionTargetAllowed/);
});
