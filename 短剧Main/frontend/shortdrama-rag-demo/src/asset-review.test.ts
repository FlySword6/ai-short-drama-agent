/* ============================================================
   asset-review.test.ts — GP-14 资产审核态入口侧纯函数验收

   后端规则真源：src/modules/control-packages/repository.ts assertReferenceAccessible——
   entity status 为 pending_review/rejected 时挂入控制包一律 422（全栏同口径，
   裁决「检索可见可看不可用」）。wire 词表两套：真栈 pending_review/approved/rejected/
   automatic_review；demo fixture pending/ready。徽标文案与 K2A 产物审核映射同口径。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { assetAttachGate, assetReviewLabelOf } from "./asset-review";

test("GP-14/徽标：demo 词表 pending → 待审核；ready → 不标", () => {
  assert.equal(assetReviewLabelOf({ status: "pending" }), "待审核");
  assert.equal(assetReviewLabelOf({ status: "ready" }), null);
});

test("GP-14/徽标：真栈词表 pending_review → 待审核；rejected → 已拒绝；approved/automatic_review → 不标", () => {
  assert.equal(assetReviewLabelOf({ status: "pending_review" }), "待审核");
  assert.equal(assetReviewLabelOf({ status: "rejected" }), "已拒绝");
  assert.equal(assetReviewLabelOf({ status: "approved" }), null);
  assert.equal(assetReviewLabelOf({ status: "automatic_review" }), null);
});

test("GP-14/徽标：空/未知状态不标（不猜）", () => {
  assert.equal(assetReviewLabelOf({ status: "" }), null);
  assert.equal(assetReviewLabelOf({ status: null }), null);
  assert.equal(assetReviewLabelOf({ status: undefined }), null);
  assert.equal(assetReviewLabelOf({ status: "draft" }), null);
});

test("GP-14/闸门：待审核 → 不可挂入 + 人话原因（对齐后端 422 说法）", () => {
  const gate = assetAttachGate({ status: "pending" });
  assert.equal(gate.allowed, false);
  assert.ok(gate.reason.includes("待审核"), "原因要点名状态");
  assert.ok(gate.reason.includes("先在资产审核中通过"), "原因要与后端 422 同一说法");
  const snake = assetAttachGate({ status: "pending_review" });
  assert.equal(snake.allowed, false);
});

test("GP-14/闸门：已拒绝 → 不可挂入 + 人话原因", () => {
  const gate = assetAttachGate({ status: "rejected" });
  assert.equal(gate.allowed, false);
  assert.ok(gate.reason.includes("已拒绝"), "原因要点名状态");
});

test("GP-14/闸门：ready/approved/未知 → 放行且无原因", () => {
  for (const status of ["ready", "approved", "automatic_review", "", null, undefined] as const) {
    const gate = assetAttachGate({ status });
    assert.equal(gate.allowed, true, `status=${String(status)} 应放行`);
    assert.equal(gate.reason, "");
  }
});
