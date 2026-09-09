import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  commonAssetReviewRejection,
  commonAssetReviewRejectionMessage,
} from "./productionReviewGate.js";

test("通用资产只有 approved 可进入生产，个人资产继续免审", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "雨夜主角",
    visibility: "common",
  };

  assert.equal(commonAssetReviewRejectionMessage(
    { ...base, status: "approved" },
    "付费生成",
  ), null);
  assert.match(commonAssetReviewRejectionMessage(
    { ...base, status: "automatic_review" },
    "付费生成",
  ) ?? "", /雨夜主角.*自动审核中.*付费生成/);
  assert.match(commonAssetReviewRejectionMessage(
    { ...base, status: "pending_review" },
    "参考控制包",
  ) ?? "", /雨夜主角.*待审核.*参考控制包/);
  assert.match(commonAssetReviewRejectionMessage(
    { ...base, status: "rejected" },
    "参考控制包",
  ) ?? "", /雨夜主角.*已拒绝.*参考控制包/);
  assert.match(commonAssetReviewRejectionMessage(
    { ...base, status: "unexpected" },
    "付费生成",
  ) ?? "", /状态异常/);
  assert.equal(commonAssetReviewRejectionMessage(
    { ...base, visibility: "personal", status: "pending_review" },
    "付费生成",
  ), null);
});

test("未过审拒绝给出点名资产且可直接展示的稳定字段", () => {
  const rejection = commonAssetReviewRejection({
    id: "11111111-1111-4111-8111-111111111111",
    name: "雨夜主角",
    visibility: "common",
    status: "pending_review",
  }, "付费生成", "22222222-2222-4222-8222-222222222222");
  assert.ok(rejection);
  assert.equal(rejection.details.kind, "reference_asset_review_required");
  assert.equal(rejection.details.asset_name, "雨夜主角");
  assert.equal(rejection.details.review_status_label, "待审核");
  assert.equal(rejection.details.destination, "付费生成");
  assert.equal(rejection.details.display_message, rejection.message);
  assert.match(rejection.details.display_message, /雨夜主角.*待审核.*付费生成/);
});

test("050 在 worker 付费提交窗口冻结通用资产审核态且不冻结个人资产", async () => {
  const source = await readFile(
    path.resolve("migrations/050_reference_review_paid_submission_guard.sql"),
    "utf8",
  );
  assert.match(source, /ADD COLUMN IF NOT EXISTS failure_status_code integer/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS failure_details jsonb/);
  assert.match(source, /BEFORE UPDATE OF status, visibility ON \{\{schema\}\}\.asset_entities/);
  assert.match(source, /OLD\.visibility = 'personal' AND NEW\.visibility = 'personal'/);
  assert.match(source, /attempt\.status = 'running'/);
  assert.match(source, /attempt\.phase = 'submitting'/);
  assert.match(source, /request\.reference_media_ids \? media\.id::text/);
  assert.match(source, /MESSAGE = 'asset_review_change_in_progress'/);
});
