import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectCostSummary, type ProjectCostRow } from "./projectCosts.js";

function row(input: Partial<ProjectCostRow> = {}): ProjectCostRow {
  return {
    entryId: "entry-1",
    sourceTable: "generation_requests",
    sourceId: "request-1",
    kind: "generation",
    userId: "user-1",
    userName: "Alice",
    model: "seedance",
    chargedPoints: 800,
    isUnpriced: false,
    createdAt: new Date("2026-07-20T10:00:00.000Z"),
    ...input,
  };
}

test("按用户、日期和模型汇总成本账本积分", () => {
  const summary = buildProjectCostSummary([
    row(),
    row({
      entryId: "entry-2",
      sourceId: "request-2",
      userId: "user-2",
      userName: "Bob",
      model: "seedream",
      chargedPoints: 50,
      createdAt: new Date("2026-07-21T01:00:00.000Z"),
    }),
  ]);

  assert.equal(summary.totals.imageEstimatedCostFen, null);
  assert.equal(summary.totals.videoEstimatedCostFen, null);
  assert.equal(summary.totals.totalEstimatedCostFen, 850);
  assert.equal(summary.totals.chargedPoints, 850);
  assert.equal(summary.totals.actualCostFen, null);
  assert.deepEqual(summary.byUser.map((item) => item.userId), ["user-1", "user-2"]);
  assert.deepEqual(summary.byDate.map((item) => item.date), ["2026-07-20", "2026-07-21"]);
  assert.deepEqual(summary.byModel.map((item) => item.model), ["seedance", "seedream"]);
  assert.deepEqual(summary.byEpisode, []);
});

test("未计价账本条目仍被追踪，但不虚构实际费用", () => {
  const summary = buildProjectCostSummary([
    row(),
    row({
      entryId: "entry-2",
      sourceId: "ai-call-2",
      kind: "ai_call",
      model: "pi",
      chargedPoints: 0,
      isUnpriced: true,
    }),
  ]);

  assert.equal(summary.totals.tasks, 2);
  assert.equal(summary.totals.chargedPoints, 800);
  assert.equal(summary.totals.unpricedCount, 1);
  assert.equal(summary.totals.actualCostFen, null);
  assert.match(summary.compatibilityGaps.join("\n"), /media_kind/);
});

test("异常账本积分不进入金额聚合", () => {
  const summary = buildProjectCostSummary([
    row({
      chargedPoints: Number.NaN,
    }),
  ]);

  assert.equal(summary.totals.totalEstimatedCostFen, 0);
  assert.equal(summary.totals.otherEstimatedCostFen, null);
});
