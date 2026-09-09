import assert from "node:assert/strict";
import test from "node:test";
import { defaultAssetClearance } from "../src/db/schema.js";
import {
  renderClearanceAuditReport,
  summarizeClearanceAudit,
  type ClearanceAuditRow,
} from "../scripts/check-asset-clearance.mts";

// S40 存量体检(scripts/check-asset-clearance.mts)的纯逻辑:分桶、分组、报告。
// 体检与写入路径共用同一份校验(src/db/schema.ts),这里只锁报告层语义。

const row = (id: string, clearance: unknown, deleted = false): ClearanceAuditRow => ({ id, clearance, deleted });

test("体检汇总: 合法/缺省/不合法分桶正确,一行多问题出现在每个对应分组", () => {
  const summary = summarizeClearanceAudit([
    row("a", { ...defaultAssetClearance }),
    row("b", { search: true }),
    row("c", {}),
    row("d", { search: "false", derivatives: 1 }, true),
    row("e", [1, 2]),
  ]);

  assert.equal(summary.total, 5);
  assert.equal(summary.valid, 3);
  assert.equal(summary.invalid, 2);
  assert.equal(summary.validWithDefaultedBits, 2);
  // b 缺 3 位、c 全缺省:各已知位缺省行数逐位统计。
  assert.deepEqual(summary.defaultedBitCounts, {
    search: 1,
    gen_reference: 2,
    commercial_publish: 2,
    model_training: 2,
  });

  assert.deepEqual(
    summary.groups.map((group) => group.label),
    ["non_boolean_bit:search", "not_object", "unknown_bit:derivatives"],
  );
  const unknown = summary.groups.find((group) => group.label === "unknown_bit:derivatives");
  const nonBoolean = summary.groups.find((group) => group.label === "non_boolean_bit:search");
  const notObject = summary.groups.find((group) => group.label === "not_object");
  assert.equal(unknown?.rows[0]?.id, "d");
  assert.equal(unknown?.rows[0]?.deleted, true);
  assert.equal(nonBoolean?.rows[0]?.id, "d");
  assert.equal(notObject?.rows[0]?.id, "e");
});

test("体检报告: FAIL 结论、分组行数、超出样例上限时的截断提示", () => {
  const rows: ClearanceAuditRow[] = [row("ok", { ...defaultAssetClearance })];
  for (let index = 0; index < 55; index += 1) {
    rows.push(row(`bad-${String(index).padStart(3, "0")}`, { oops: true }));
  }
  const report = renderClearanceAuditReport("common", summarizeClearanceAudit(rows));

  assert.match(report, /共 56 行/);
  assert.match(report, /不合法 55 行/);
  assert.match(report, /\[unknown_bit:oops\] 55 行/);
  assert.match(report, /另有 5 行未列出/);
  assert.match(report, /结论: FAIL/);
  // 报告必须如实声明:不做任何修改,处置需 DC 授权。
  assert.match(report, /本脚本不做任何修改/);
  assert.match(report, /DC 授权/);
});

test("体检报告: 全部合法时结论 PASS 并给出缺省位分布", () => {
  const report = renderClearanceAuditReport("common", summarizeClearanceAudit([
    row("a", {}),
    row("b", { ...defaultAssetClearance }),
  ]));
  assert.match(report, /结论: PASS/);
  assert.match(report, /缺省位分布: search×1, gen_reference×1, commercial_publish×1, model_training×1/);
});
