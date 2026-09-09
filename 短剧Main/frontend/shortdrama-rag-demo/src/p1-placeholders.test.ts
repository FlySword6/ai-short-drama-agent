/* ============================================================
   p1-placeholders.test.ts — 版本预告呈现红线 + 确认卡文案统一 验收断言
   S23 改版:版本计划内容已入库(迁移 023 config_entries),前端不再携带内容数组——
   内容合同由 test/config-entries-release-plan.test.ts 冻结,机制单测在 release-plan.test.ts。
   本文件守呈现红线:
   ① 防债守卫:设置页与 release-plan.ts 不得再写死版本计划内容;读不到有人话降级,不回退旧数据
   ② Pi 面板「功能预告」轮播接线:接口取数拼装、可关(sessionStorage)、动效/reduced-motion
   ③ 无禁词「敬请期待」类空炮话术;无锁图标灰按钮
   ④ 确认卡文案统一「先估价后人工确认」
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const settingsPageSource = readSource("./pages/settings-page.tsx");
const releasePlanSource = readSource("./release-plan.ts");
const settingsCss = readSource("./pages/settings.css");
const appSource = readSource("./app.tsx");
const batchDrawerSource = readSource("./pages/batch-generate-drawer.tsx");
const projectPagesSource = readSource("./pages/project-pages.tsx");

/* ---------- ① 防债守卫:内容一律接口读,读不到如实降级 ---------- */

test("S23:设置页不再写死版本计划内容(段/卡/历史数组与卡片 id 一律不存在)", () => {
  for (const banned of [
    "RELEASE_SECTIONS",
    "RELEASE_HISTORY",
    "TEASER_LINES",
    "pro-polish",
    "director-embed",
    "pi-collab",
    "ip-plaza",
    "导演台直通工作台",
    "拍法技能库",
  ]) {
    assert.ok(!settingsPageSource.includes(banned), `设置页仍写死「${banned}」——内容债长回来了`);
    assert.ok(!releasePlanSource.includes(banned), `release-plan.ts 仍写死「${banned}」——内容债长回来了`);
  }
});

test("S23:设置页从接口读版本计划,读不到说人话并可重试,不回退写死内容", () => {
  assert.ok(settingsPageSource.includes("api.releasePlan"), "设置页未从接口读取版本计划");
  assert.ok(settingsPageSource.includes("版本计划暂时加载不出来，请稍后重试"), "缺人话降级文案");
  assert.ok(settingsPageSource.includes("重试"), "降级缺重试入口");
  assert.ok(settingsPageSource.includes("离线演示不展示版本计划"), "离线演示缺如实说明");
});

test("S23:版本历史折叠块仍在预告页顶部、默认收起、带 aria-expanded;已上线段收进折叠区", () => {
  assert.ok(settingsPageSource.includes("aria-label=\"版本历史\""), "缺「版本历史」折叠块");
  assert.ok(settingsPageSource.includes("aria-expanded"), "折叠块缺 aria-expanded");
  assert.ok(settingsPageSource.includes("historyOpen") && settingsPageSource.includes("useState(false)"), "版本历史未默认收起");
  // 折叠块在版本段列表之前(页顶)
  assert.ok(
    settingsPageSource.indexOf("<ReleaseHistory history=") < settingsPageSource.indexOf("upcomingSections.map"),
    "版本历史折叠块不在预告段列表之前",
  );
  // 已上线段不进预告主体,已上线卡片在折叠区内渲染
  assert.ok(settingsPageSource.includes('section.status !== "live"'), "预告主体未过滤已上线段");
  assert.ok(settingsPageSource.includes("liveSection.cards.map"), "已上线卡片未收进版本历史折叠区");
});

/* ---------- ② Pi 面板「功能预告」轮播接线 ---------- */

test("轮播接线(app.tsx):接口取数拼装,挂在 AI 工作区面板底部,动效一次性淡入,reduced-motion 静止", () => {
  assert.ok(appSource.includes("NextSeasonTeaser"), "app.tsx 未挂轮播");
  assert.ok(appSource.includes("api.releasePlan") && appSource.includes("buildTeaserLines"), "轮播未从接口取数拼装");
  assert.ok(appSource.includes("piTeaserDismissed") && appSource.includes("dismissPiTeaser"), "轮播未接 sessionStorage 关闭");
  assert.ok(appSource.includes("功能预告"), "缺「功能预告」标识");
  assert.ok(!appSource.includes("下一季预告"), "「下一季预告」中二词仍在");
  assert.ok(settingsCss.includes("pi-teaser-fade"), "缺一次性淡入关键帧");
  assert.ok(settingsCss.includes("prefers-reduced-motion"), "缺 reduced-motion 静止");
});

/* ---------- ③ 禁词与呈现红线 ---------- */

test("无禁词:导语与源码均不出现「敬请期待」类空炮话术", () => {
  const banned = /敬请期待|即将上线|coming\s*soon/i;
  assert.ok(!banned.test("每个版本聚焦解决一类真实痛点，做好一个上线一个。"));
  for (const [name, source] of [
    ["pages/settings-page.tsx", settingsPageSource],
    ["release-plan.ts", releasePlanSource],
    ["pages/settings.css", settingsCss],
    ["app.tsx", appSource],
  ] as const) {
    assert.ok(!banned.test(source), `${name} 出现禁词`);
  }
});

test("版本语口径与片场中二词清场(「已定档」是附录二正式用词,不在清场列)", () => {
  assert.ok(releasePlanSource.includes("预计"), "版本语缺「预计」");
  for (const bannedWord of ["下一景", "拍摄中", "上映", "概念片", "排片", "已定版", "解锁条件", "检查更新", "定版", "基线"]) {
    assert.ok(!settingsPageSource.includes(bannedWord), `设置页仍出现「${bannedWord}」`);
    assert.ok(!releasePlanSource.includes(bannedWord), `release-plan.ts 仍出现「${bannedWord}」`);
  }
});

test("呈现红线:设置页无锁图标、无灰按钮占位(无 Lock 图标、无 disabled)", () => {
  assert.ok(!settingsPageSource.includes("Lock"), "设置页出现锁图标");
  assert.ok(!settingsPageSource.includes("disabled"), "设置页出现灰按钮占位");
});

/* ---------- ④ 确认卡文案统一「先估价后人工确认」 ---------- */

test("四个确认面统一为「先估价后人工确认」", () => {
  for (const [name, source] of [
    ["app.tsx（Pi 生成确认卡）", appSource],
    ["pages/batch-generate-drawer.tsx（批量清单抽屉）", batchDrawerSource],
    ["pages/project-pages.tsx（分镜管理页）", projectPagesSource],
  ] as const) {
    assert.ok(source.includes("先估价后人工确认"), `${name} 未统一为「先估价后人工确认」`);
  }
});

test("批量清单明确为单次授权，超阈值仍逐项走服务端护栏", () => {
  assert.ok(batchDrawerSource.includes("本次确认仍是整份清单的一次人工授权"), "批量抽屉缺单次授权说明");
  assert.ok(batchDrawerSource.includes("服务端会继续逐项核验价格与预算"), "批量抽屉缺逐项护栏说明");
  assert.ok(batchDrawerSource.includes("报价合计（本次授权金额）"), "批量抽屉缺授权总额说明");
  assert.ok(!batchDrawerSource.includes("≈{formatCredits(totalFen)}"), "授权总额不应显示为近似值");
  // 批量入口不采用“常规项一次过 + 超额项二次确认”的混合模式。
  assert.ok(!batchDrawerSource.includes("后台自动报价，超阈值再追加一次费用复核"), "批量抽屉仍暗示二次确认");
  assert.ok(!appSource.includes("后台已完成报价"), "Pi 确认卡仍是旧说法");
  assert.ok(!batchDrawerSource.includes("逐项估价后才可确认"), "批量抽屉仍是旧说法");
  assert.ok(!projectPagesSource.includes("逐项估价，确认后才创建任务"), "分镜管理页仍是旧说法");
});
