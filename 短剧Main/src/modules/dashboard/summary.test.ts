import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardSummary, type DashboardCostRow } from "./summary.js";

function row(input: Partial<DashboardCostRow> = {}): DashboardCostRow {
  return {
    projectId: "p1",
    projectName: "杀穿女频",
    userId: "u1",
    userName: "Alice",
    kind: "generation",
    chargedPoints: 1250,
    isUnpriced: false,
    createdAt: new Date("2026-07-14T12:00:00.000Z"),
    ...input,
  };
}

test("只按成本账本聚合任务与积分，不伪造状态或媒体类型", () => {
  const summary = buildDashboardSummary([
    row(),
    row({ kind: "ai_call", chargedPoints: 50 }),
    row({ chargedPoints: 800, isUnpriced: true }),
  ]);
  assert.equal(summary.totalTasks, 3);
  assert.equal(summary.succeededTasks, null);
  assert.equal(summary.activeTasks, null);
  assert.equal(summary.failedTasks, null);
  assert.equal(summary.imageEstimatedCostFen, null);
  assert.equal(summary.videoEstimatedCostFen, null);
  assert.equal(summary.totalEstimatedCostFen, 2100);
  assert.equal(summary.unpricedCount, 1);
});

test("按项目、用户和日期生成明细", () => {
  const summary = buildDashboardSummary([
    row(),
    row({ projectId: "p2", projectName: "老公诈死", userId: "u2", userName: "Bob", chargedPoints: 2000, createdAt: new Date("2026-07-15T01:00:00.000Z") }),
  ]);
  assert.equal(summary.byProject[0]?.projectId, "p2");
  assert.equal(summary.byUser[0]?.userId, "u2");
  assert.deepEqual(summary.byDate.map((item) => item.date), ["2026-07-14", "2026-07-15"]);
});

test("异常费用不进入聚合", () => {
  const summary = buildDashboardSummary([row({ chargedPoints: Number.NaN })]);
  assert.equal(summary.totalEstimatedCostFen, 0);
  assert.equal(summary.notice, "已记账积分，来源于成本账本");
});
