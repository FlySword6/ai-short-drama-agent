/* ============================================================
   cost-terms.test.ts — 计量口径统一（S46-A / 走查 P0-2）
   全站唯一展示单位=积分;「费用/消耗」二选一=消耗;
   人民币（元/分/¥/CNY 图标）不进用户界面;换算唯一出口=cost-units.ts。
   S59 地盘（生成确认弹窗/批量抽屉/复核弹窗）不在本组扫描范围。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("S46-A 数据看板：卡名/表头/面板标题全部统一为「消耗」", () => {
  const page = readSource("./pages/operations-pages.tsx");
  for (const copy of ["图片消耗", "视频消耗", `预估消耗 · `, "消耗结构", "项目消耗排行", "还没有消耗记录"]) {
    assert.ok(page.includes(copy), `看板缺统一用词：${copy}`);
  }
  for (const banned of ["图片费用", "视频费用", "预估费用", "费用结构", "项目费用排行", "费用复核", "分钱", "CurrencyCny"]) {
    assert.ok(!page.includes(banned), `看板残留旧口径：${banned}`);
  }
});

test("S46-A 图表换算唯一出口：cost-charts 不再有本地 ÷100（与总计卡同口径）", () => {
  const charts = readSource("./components/cost-charts.tsx");
  assert.ok(charts.includes('from "../cost-units"'), "图表未从 cost-units 取换算");
  assert.ok(!charts.includes("/ 100"), "图表本地 ÷100 仍在（与积分卡自相矛盾的计量 bug）");
});

test("S46-A 散点格式化收编：版本弹窗/资产快捷估价走 formatCreditsWithUnit", () => {
  const versionModal = readSource("./components/version-modal.tsx");
  assert.ok(versionModal.includes("formatCreditsWithUnit"), "版本弹窗未走统一格式化");
  assert.ok(!versionModal.includes("费用以报价为准"), "版本弹窗残留「费用」");
  const widgets = readSource("./components/asset-widgets.tsx");
  assert.ok(widgets.includes("formatCreditsWithUnit(quote.estimated_cost_fen)"), "资产快捷估价未走统一格式化");
});

test("S46-A 页面级「费用」清场（S59 确认弹窗地盘除外）", () => {
  for (const [path, banned] of [
    ["./pages/global-pages.tsx", "费用历史"],
    ["./pages/project-pages.tsx", "费用以清单合计为准"],
    ["./demo.ts", "预估费用"],
  ] as const) {
    const source = readSource(path);
    assert.ok(!source.includes(banned), `${path} 残留旧口径：${banned}`);
  }
  const admin = readSource("./pages/admin-page.tsx");
  assert.ok(!admin.includes(">积分</th>"), "后台成本表头仍硬编码「积分」（应走 COST_UNIT_LABEL）");
});

test("S46-A 后端 notice 同口径：预估消耗,不再说预估费用", () => {
  const repository = readSource("../../../src/modules/dashboard/repository.ts");
  assert.ok(repository.includes('"预估消耗，非云平台实际账单"'), "看板 notice 常量未统一为「预估消耗」");
  for (const path of [
    "../../../src/modules/dashboard/repository.ts",
    "../../../src/modules/generation/routes.ts",
    "../../../src/modules/admin/generations/routes.ts",
    "../../../src/modules/delivery/manifest.ts",
  ] as const) {
    const source = readSource(path);
    assert.ok(!source.includes("预估费用，非云平台实际账单"), `${path} 后端文案残留「预估费用」`);
  }
});
