/* ============================================================
   p1-costs.test.ts — 板09 消耗看板验收断言（S75 聚合契约版）
   纯逻辑：全局 byUser/byDate 聚合映射、合计行、空态/降级分支、
   演示数据三视图推导、token 格式化（cost-units 唯一出口）。
   真渲染：三视图聚合组件与整页 demo 走 renderToStaticMarkup
   （硬规矩：文案与交互类改动禁止只用源码字符串断言）。
   源码级：页面只从 cost-units 出单位文案、四态与口径文案在位、
   旧契约推导（attempts/by_episode）删净、api 契约形状守卫。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  aggregateHasNoConsumption,
  buildAggregateDayBars,
  buildDateBars,
  globalTotalCards,
  mapGlobalDateCosts,
  mapGlobalUserCosts,
  resolveUserCostRows,
  sumUserCostRows,
  type UserCostRow,
} from "./cost-board";
import {
  COST_UNIT_LABEL,
  FEN_PER_CREDIT,
  fenToCredits,
  formatCredits,
  formatCreditsWithUnit,
} from "./cost-units";
import { demoUser } from "./demo";
import {
  DEMO_ADMIN_COSTS_PROJECT,
  DEMO_CAPABILITIES,
  demoProjectCostsPage,
  type CostAggregatePage,
} from "./operations";
import {
  ProjectCostAggregateView,
  ProjectCostsPage,
  type ProjectCostPages,
} from "./pages/operations-pages";
import type { DashboardCostSummary } from "./types";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** 剥注释（块注释+行注释）：「符号不存在」类断言只看可执行代码，不被考古注释误伤。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** SSR 会在相邻文本节点间插 <!-- -->，断言可见文案前先归一。 */
function textOf(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

const operationsPage = readSource("./pages/operations-pages.tsx");
const apiSource = readSource("./api.ts");

const globalCosts: DashboardCostSummary = {
  notice: "预估消耗，非云平台实际账单",
  total_tasks: 3,
  succeeded_tasks: 2,
  active_tasks: 1,
  failed_tasks: 0,
  image_estimated_cost_fen: 1_000,
  video_estimated_cost_fen: 2_000,
  total_estimated_cost_fen: 3_000,
  by_project: [],
  by_user: [
    { user_id: "u1", user_name: "Alice", image_estimated_cost_fen: 600, video_estimated_cost_fen: 1_400, total_estimated_cost_fen: 2_000 },
    { user_id: "u2", user_name: "Bob", image_estimated_cost_fen: 400, video_estimated_cost_fen: 600, total_estimated_cost_fen: 1_000 },
  ],
  by_date: [
    { date: "2026-07-14", tasks: 1, estimated_cost_fen: 1_000 },
    { date: "2026-07-15", tasks: 2, estimated_cost_fen: 2_000 },
  ],
};

/* ---------- token 格式化：积分唯一出口（DC 拍板 1 积分 = 1 分钱） ---------- */

test("cost-units：口径 1 积分 = 1 分，单位名为积分", () => {
  assert.equal(COST_UNIT_LABEL, "积分");
  assert.equal(FEN_PER_CREDIT, 1);
  assert.equal(fenToCredits(520), 520);
});

test("formatCredits：大额缩写为万，小额千分位", () => {
  assert.equal(formatCredits(53_700), "5.37 万");
  assert.equal(formatCredits(12_300), "1.23 万");
  assert.equal(formatCredits(520), "520");
  assert.equal(formatCredits(0), "0");
});

test("formatCreditsWithUnit：带单位展示（W5-0 后全站费用统一为积分）", () => {
  assert.equal(formatCreditsWithUnit(53_700), "5.37 万 积分");
  assert.equal(formatCreditsWithUnit(120, { approx: true }), "≈120 积分");
});

/* ---------- 全局 byUser 聚合映射与合计行（数据看板，未随 S75 改动） ---------- */

test("mapGlobalUserCosts：全局无「其他」拆分与实际消耗 → null 降级，不造 0", () => {
  const rows = mapGlobalUserCosts(globalCosts.by_user);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.otherFen, null);
  assert.equal(rows[0]?.actualFen, null);
  assert.equal(rows[0]?.imageFen, 600);
  assert.equal(rows[0]?.estimatedFen, 2_000);
});

test("sumUserCostRows：逐列求和；某列全缺时合计也为 null", () => {
  const rows: UserCostRow[] = [
    { key: "u1", name: "Alice", imageFen: 100, videoFen: 200, otherFen: 30, estimatedFen: 330, actualFen: 300 },
    { key: "u2", name: "Bob", imageFen: 50, videoFen: 70, otherFen: 0, estimatedFen: 120, actualFen: null },
  ];
  assert.deepEqual(sumUserCostRows(rows), { imageFen: 150, videoFen: 270, otherFen: 30, estimatedFen: 450, actualFen: 300 });

  const globalRows = mapGlobalUserCosts(globalCosts.by_user);
  const totals = sumUserCostRows(globalRows);
  assert.equal(totals.imageFen, 1_000);
  assert.equal(totals.videoFen, 2_000);
  assert.equal(totals.estimatedFen, 3_000);
  assert.equal(totals.otherFen, null);
  assert.equal(totals.actualFen, null);

  assert.deepEqual(sumUserCostRows([]), { imageFen: null, videoFen: null, otherFen: null, estimatedFen: null, actualFen: null });
});

test("resolveUserCostRows：全局有 per-user 聚合就用；缺省 → none 明示降级", () => {
  const global = resolveUserCostRows(globalCosts);
  assert.equal(global.scope, "global");
  assert.equal(global.rows.length, 2);

  const empty = resolveUserCostRows({ by_user: [] });
  assert.equal(empty.scope, "global");
  assert.equal(empty.rows.length, 0);

  assert.equal(resolveUserCostRows(null).scope, "none");
  assert.equal(resolveUserCostRows(undefined).scope, "none");
  assert.deepEqual(resolveUserCostRows(null).rows, []);
});

/* ---------- 总计卡组映射（数据看板） ---------- */

test("globalTotalCards：全局口径「其他」与总消耗拆分恒为 null 降级", () => {
  const cards = globalTotalCards(globalCosts);
  assert.equal(cards.totalFen, null);
  assert.equal(cards.imageFen, 1_000);
  assert.equal(cards.otherFen, null);
  assert.equal(cards.estimatedYuanFen, 3_000);
});

/* ---------- 全局 byDate 聚合映射（数据看板） ---------- */

test("buildDateBars：share 按组内最大值归一，标签取 M/D；null 输入 → null 降级", () => {
  const bars = buildDateBars([
    { date: "2026-07-14", tasks: 1, total_estimated_cost_fen: 500 },
    { date: "2026-07-15", tasks: 2, total_estimated_cost_fen: 2_000 },
  ]);
  assert.ok(bars);
  assert.deepEqual(bars.map((row) => [row.label, row.fen, row.tasks, row.share]), [
    ["7/14", 500, 1, 0.25],
    ["7/15", 2_000, 2, 1],
  ]);
  assert.equal(buildDateBars(null), null);
  assert.equal(buildDateBars(undefined), null);
  assert.deepEqual(buildDateBars([]), []);
});

test("mapGlobalDateCosts：全局字段 1:1 改名为页面桶字段", () => {
  assert.deepEqual(mapGlobalDateCosts(globalCosts.by_date), [
    { date: "2026-07-14", tasks: 1, total_estimated_cost_fen: 1_000 },
    { date: "2026-07-15", tasks: 2, total_estimated_cost_fen: 2_000 },
  ]);
});

/* ---------- S75：聚合契约空态与按日期条形 ---------- */

test("aggregateHasNoConsumption：三视图 totals.entryCount 全 0 才空；按 totals 不按 rows 判", () => {
  const zero = { chargedPoints: 0, unpricedCount: 0, entryCount: 0 };
  assert.equal(aggregateHasNoConsumption([]), true);
  assert.equal(aggregateHasNoConsumption([{ totals: zero }, { totals: zero }, { totals: zero }]), true);
  // 分页边界：rows 可以暂时为空但服务端 entryCount>0，按 rows 判空会误报空态
  assert.equal(aggregateHasNoConsumption([{ totals: { chargedPoints: 0, unpricedCount: 0, entryCount: 3 } }]), false);
  assert.equal(aggregateHasNoConsumption([{ totals: zero }, { totals: { chargedPoints: 10, unpricedCount: 0, entryCount: 1 } }]), false);
});

test("buildAggregateDayBars：key 升序、label 取 M/D、entryCount→次数、share 归一、负数夹 0", () => {
  const bars = buildAggregateDayBars([
    { key: "2026-07-15", label: "2026-07-15", chargedPoints: 200, unpricedCount: 0, entryCount: 4 },
    { key: "2026-07-13", label: "2026-07-13", chargedPoints: 400, unpricedCount: 1, entryCount: 5 },
    { key: "2026-07-14", label: "2026-07-14", chargedPoints: -50, unpricedCount: 0, entryCount: 2 },
  ]);
  assert.deepEqual(bars.map((row) => [row.key, row.label, row.fen, row.tasks, row.share]), [
    ["2026-07-13", "7/13", 400, 5, 1],
    ["2026-07-14", "7/14", 0, 2, 0],
    ["2026-07-15", "7/15", 200, 4, 0.5],
  ]);
  assert.deepEqual(buildAggregateDayBars([]), []);
});

/* ---------- S75：demo 三视图 fixture 与后台按项目聚合同账 ---------- */

test("demoProjectCostsPage：三视图 totals 与 DEMO_ADMIN_COSTS_PROJECT 同账（排行点进来数字对得上）", () => {
  const adminRowByProject = new Map(DEMO_ADMIN_COSTS_PROJECT.rows.map((row) => [row.key, row]));
  for (const projectId of ["demo-project-1", "demo-project-2", "demo-project-3"]) {
    const adminRow = adminRowByProject.get(projectId);
    assert.ok(adminRow, `DEMO_ADMIN_COSTS_PROJECT 缺 ${projectId}`);
    for (const groupBy of ["day", "member", "model"] as const) {
      const page = demoProjectCostsPage(projectId, groupBy);
      assert.equal(page.groupBy, groupBy);
      assert.equal(page.page, 1);
      assert.equal(page.pageSize, 100);
      assert.equal(page.total, page.rows.length);
      assert.deepEqual(
        page.totals,
        { chargedPoints: adminRow.chargedPoints, unpricedCount: adminRow.unpricedCount, entryCount: adminRow.entryCount },
        `${projectId}/${groupBy} 与后台总账不一致`,
      );
    }
  }
  // 未列项目 → 空页 0 值，不编造
  const unknown = demoProjectCostsPage("demo-project-404", "day");
  assert.deepEqual(unknown.rows, []);
  assert.deepEqual(unknown.totals, { chargedPoints: 0, unpricedCount: 0, entryCount: 0 });
});

/* ---------- S75 真渲染：三视图聚合组件 ---------- */

function demoCostPages(projectId: string): ProjectCostPages {
  return {
    day: demoProjectCostsPage(projectId, "day"),
    member: demoProjectCostsPage(projectId, "member"),
    model: demoProjectCostsPage(projectId, "model"),
    projectName: "《杀穿女频》",
  };
}

test("渲染·按日期视图：聚合行走条形，label M/D、次数与金额在（数值一律 formatCredits 现算）", () => {
  const html = textOf(renderToStaticMarkup(React.createElement(ProjectCostAggregateView, { view: "day", pages: demoCostPages("demo-project-2") })));
  assert.ok(html.includes("7/13"), "日期标签缺失");
  assert.ok(html.includes("5 次"), "笔数缺失");
  assert.ok(html.includes(formatCredits(500)), "当日金额缺失");
  const raw = renderToStaticMarkup(React.createElement(ProjectCostAggregateView, { view: "day", pages: demoCostPages("demo-project-2") }));
  assert.ok(raw.includes("scaleX("), "条形进度缺失");
});

test("渲染·按成员视图：四列聚合表，未计价>0 单独标明，末行服务端 totals 合计", () => {
  const html = textOf(renderToStaticMarkup(React.createElement(ProjectCostAggregateView, { view: "member", pages: demoCostPages("demo-project-2") })));
  assert.ok(html.includes("Alice"), "成员名缺失");
  assert.ok(html.includes("陈默"), "成员名缺失");
  assert.ok(html.includes("1 笔"), "未计价标注缺失（陈默 unpricedCount=1）");
  assert.ok(html.includes("合计"), "合计行缺失");
  assert.ok(html.includes(formatCredits(1_500)), "合计消耗缺失");
  assert.ok(html.includes(`消耗（${COST_UNIT_LABEL}）`), "单位列头缺失");
});

test("渲染·按模型视图：型号走能力中文名（厂商原串不裸显，#18）；空 rows 走空态不编数", () => {
  const html = textOf(renderToStaticMarkup(React.createElement(ProjectCostAggregateView, { view: "model", pages: demoCostPages("demo-project-2") })));
  assert.ok(html.includes("视频生成模型"), "模型能力中文名缺失");
  assert.ok(!html.includes("Seedance"), "厂商型号原串不该裸显（业务语言化 #18）");
  assert.ok(html.includes("模型"), "列头缺失");

  const empty = textOf(renderToStaticMarkup(React.createElement(ProjectCostAggregateView, { view: "member", pages: demoCostPages("demo-project-404") })));
  assert.ok(empty.includes("还没有按成员的消耗"), "成员空态缺失");
});

test("渲染·截断如实注明：total>rows.length 时给出「仅展示前 N 条」", () => {
  const page: CostAggregatePage = {
    groupBy: "member",
    rows: [
      { key: "u1", label: "Alice", chargedPoints: 800, unpricedCount: 0, entryCount: 12 },
      { key: "u2", label: "Bob", chargedPoints: 300, unpricedCount: 0, entryCount: 5 },
    ],
    totals: { chargedPoints: 1_100, unpricedCount: 0, entryCount: 17 },
    total: 30,
    page: 1,
    pageSize: 2,
  };
  const html = textOf(renderToStaticMarkup(React.createElement(ProjectCostAggregateView, {
    view: "member",
    pages: { day: page, member: page, model: page, projectName: "" },
  })));
  assert.ok(html.includes("仅展示前 2 条（共 30 条，按消耗降序）。"), "截断注明缺失");
});

/* ---------- S75 真渲染：整页 demo 与 viewer 门控 ---------- */

test("渲染·整页 demo：页头/总计卡/三视图切换/明细区都在，无未替换占位", () => {
  const html = textOf(renderToStaticMarkup(React.createElement(ProjectCostsPage, {
    projectId: "demo-project-1",
    demoMode: true,
    notify: () => {},
    user: demoUser,
    capabilities: { status: "ready", capabilities: DEMO_CAPABILITIES },
  })));
  assert.ok(html.includes("《老公诈死》 · 消耗看板"), "页头项目名缺失");
  assert.ok(html.includes("按成员"), "按成员切换缺失");
  assert.ok(html.includes("按模型"), "按模型切换缺失");
  assert.ok(html.includes(formatCredits(920)), "总消耗卡缺失");
  assert.ok(html.includes("消耗明细"), "逐笔明细区缺失");
  assert.ok(!html.includes("undefined") && !html.includes("NaN"), "出现未替换占位");
});

/* 原来这里只有一条「capabilities=null 整页人话」——它把「权限没读到」和「你是 viewer」
   钉成了同一件事，正是三态改造要修的病。拆成两条：确实无权照旧给拒绝文案；读不到
   给「权限信息没读到 + 重试」（断言在 capabilities-three-state.test.ts 一并覆盖）。 */
test("渲染·viewer 门控：查清了确实无权才给整页人话，不露数据区", () => {
  const html = textOf(renderToStaticMarkup(React.createElement(ProjectCostsPage, {
    projectId: "demo-project-1",
    demoMode: true,
    notify: () => {},
    user: demoUser,
    capabilities: { status: "ready", capabilities: { platformRole: "member", allowMemberCreateProject: false, projects: [], permissions: [] } },
  })));
  assert.ok(html.includes("成本视图仅查看不可见"), "viewer 人话缺失");
  assert.ok(!html.includes("消耗明细"), "viewer 不应看到数据区");
});

test("渲染·权限读不到：整页说没读到并给重试，不说成「你只可查看」", () => {
  const html = textOf(renderToStaticMarkup(React.createElement(ProjectCostsPage, {
    projectId: "demo-project-1",
    demoMode: true,
    notify: () => {},
    user: demoUser,
    capabilities: { status: "unavailable", reload: () => {} },
  })));
  assert.ok(html.includes("权限信息没读到"), "读不到必须明说");
  assert.ok(html.includes("重试"), "读不到必须给重试");
  assert.ok(!html.includes("成本视图仅查看不可见"), "接口故障不得说成降权");
});

/* ---------- 源码级：单位唯一出口、四态与口径文案、图标来源 ---------- */

test("operations-pages：费用文案只从 cost-units token 出，全站不再展示 ¥（W5-0）", () => {
  assert.match(operationsPage, /import \{[^}]*COST_UNIT_LABEL[^}]*formatCredits[^}]*\} from "\.\.\/cost-units"/);
  // W5-0：DC 拍板 1 积分 = 1 分钱，人民币换算已从页面与 token 中移除
  assert.equal(operationsPage.includes("¥"), false);
  assert.equal(operationsPage.includes("formatCostYuan"), false);
  // 新页面代码不出现硬编码「积分」字样（一律 COST_UNIT_LABEL）
  assert.equal(operationsPage.includes("积分"), false);
});

test("operations-pages：板09 四态与口径文案在位（S75 聚合契约版），按集文案随旧契约下线", () => {
  for (const copy of [
    "生图生视频后在这里看账",
    "去生产",
    "当前项目的消耗总计、维度汇总与逐笔明细。",
    "超出平台设定的复核阈值",
    "预算不足由服务端拒绝并给出可操作提示",
    "合计",
    "不做推算",
    "按成员",
    "按模型",
    "未计价",
    "按消耗降序",
  ]) {
    assert.ok(operationsPage.includes(copy), `缺少文案：${copy}`);
  }
  assert.equal(operationsPage.includes("按集消耗"), false, "按集视图已随旧契约下线");
  assert.equal(operationsPage.includes("当前项目的消耗总计与参与用户。"), false, "旧页头描述已替换");
});

test("cost-board/operations-pages：旧契约推导与按集视图删净（S75）", () => {
  const strippedBoard = stripComments(readSource("./cost-board.ts"));
  const strippedPage = stripComments(operationsPage);
  for (const dead of ["buildEpisodeBars", "aggregateAttempts", "projectTotalCards", "mapProjectUserCosts", "hasNoConsumption", "ProjectCostsBoard", "by_episode"]) {
    assert.equal(strippedBoard.includes(dead), false, `cost-board 残留旧契约符号：${dead}`);
    assert.equal(strippedPage.includes(dead), false, `operations-pages 残留旧契约符号：${dead}`);
  }
});

test("api：projectCosts 走聚合契约（group_by 必填透传，page_size=100）", () => {
  assert.match(apiSource, /async projectCosts\(projectId: string, groupBy: ProjectCostGroupBy\)/);
  assert.ok(apiSource.includes("group_by: groupBy"), "group_by 未透传到查询串");
});

test("operations-pages：图标唯一来源 @phosphor-icons/react", () => {
  const iconImports = operationsPage.match(/from "[^"]*icon[^"]*"/gi) ?? [];
  assert.deepEqual([...new Set(iconImports)], ['from "@phosphor-icons/react"']);
});

test("operations-pages：视图层已迁 Tailwind + components/ui，旧 ops CSS 全清", () => {
  // ops-costs.css 已删除：页面不再 import 任何 CSS
  assert.equal(operationsPage.includes("ops-costs.css"), false);
  assert.doesNotMatch(operationsPage, /import ["'][^"']*\.css["']/);
  // 旧 BEM 类名清场（布局全部走 utility）
  for (const legacy of ["metric-card", "dashboard-panel", "dashboard-metrics", "ops-bar-fill", "ops-total-row", "cost-notice", "segmented-control", "trash-list", "playback-layout"]) {
    assert.equal(operationsPage.includes(legacy), false, `残留旧类名：${legacy}`);
  }
  // 条形保持 accent 填充 + scaleX 进度（视觉合同不变，动效走 TW utility）
  assert.match(operationsPage, /bg-accent/);
  assert.match(operationsPage, /scaleX\(/);
  assert.match(operationsPage, /ease-out-quart/);
});
