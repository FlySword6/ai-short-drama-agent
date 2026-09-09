import assert from "node:assert/strict";
import test from "node:test";
import {
  errorBody,
  isPostgresUniqueViolation,
  knownDatabaseBusinessError,
  UnprocessableEntityError,
} from "./errors.js";

test("账户积分数据库触发器错误映射为稳定的人话 API 错误", () => {
  const error = Object.assign(new Error("account_credit_insufficient"), { code: "P0001" });
  const mapped = knownDatabaseBusinessError(error);
  assert.ok(mapped);
  assert.equal(mapped.statusCode, 422);
  assert.deepEqual(errorBody(error), {
    code: "account_credit_insufficient",
    message: "账户积分不足，请使用邀请码或联系管理员充值后再发起生成",
    retryable: false,
    details: null,
  });
});

test("未知数据库业务异常不被误包装", () => {
  const error = Object.assign(new Error("some_other_rule"), { code: "P0001" });
  assert.equal(knownDatabaseBusinessError(error), undefined);
});

test("重复消费同一生成尝试不会变成第二笔扣费", () => {
  const error = Object.assign(new Error("account_credit_duplicate_generation_attempt"), { code: "P0001" });
  const mapped = knownDatabaseBusinessError(error);
  assert.ok(mapped);
  assert.equal(mapped.statusCode, 409);
  assert.equal(mapped.code, "account_credit_duplicate_generation_attempt");
});

test("付费提交窗口内的审核态写入冲突映射为稳定中文 409", () => {
  const error = Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("asset_review_change_in_progress"), { code: "P0001" }),
  });
  const mapped = knownDatabaseBusinessError(error);
  assert.ok(mapped);
  assert.equal(mapped.statusCode, 409);
  assert.equal(mapped.code, "asset_review_change_in_progress");
  assert.match(mapped.message, /供应商提交中.*提交结果明确/);
});

test("Drizzle 包装后的 PostgreSQL 唯一冲突仍可识别", () => {
  assert.equal(isPostgresUniqueViolation({ cause: { code: "23505" } }), true);
  assert.equal(isPostgresUniqueViolation({ cause: { code: "23503" } }), false);
});

test("未过审参考资产只公开白名单展示字段，其他 422 details 仍隐藏", () => {
  const details = {
    kind: "reference_asset_review_required",
    asset_entity_id: "11111111-1111-4111-8111-111111111111",
    asset_media_id: "22222222-2222-4222-8222-222222222222",
    asset_name: "待审核主角",
    review_status: "pending_review",
    review_status_label: "待审核",
    destination: "付费生成",
    display_message: "资产《待审核主角》尚未通过审核",
    internal_note: "不得公开",
  };
  const body = errorBody(new UnprocessableEntityError(details.display_message, details));
  const displayMessage = "资产《待审核主角》尚未通过审核（当前：待审核），不能用于付费生成，请先完成通用资产审核";
  assert.equal(body.message, displayMessage);
  assert.deepEqual(body.details, {
    kind: "reference_asset_review_required",
    asset_entity_id: details.asset_entity_id,
    asset_media_id: details.asset_media_id,
    asset_name: details.asset_name,
    review_status: details.review_status,
    review_status_label: details.review_status_label,
    destination: details.destination,
    display_message: displayMessage,
  });
  assert.equal(errorBody(new UnprocessableEntityError("普通 422", {
    internal_note: "不得公开",
  })).details, null);
});

test("未过审资产展示字段重建公开文案，不透传名称中的 URL 或密钥标记", () => {
  const body = errorBody(new UnprocessableEntityError("原始内部文案", {
    kind: "reference_asset_review_required",
    asset_entity_id: "11111111-1111-4111-8111-111111111111",
    asset_name: "https://internal.example/token=secret",
    review_status: "pending_review",
    review_status_label: "伪造状态",
    destination: "参考控制包",
    display_message: "伪造展示文案",
  }));
  assert.equal(body.message, "资产《该资产》尚未通过审核（当前：待审核），不能用于参考控制包，请先完成通用资产审核");
  assert.deepEqual(body.details, {
    kind: "reference_asset_review_required",
    asset_entity_id: "11111111-1111-4111-8111-111111111111",
    asset_name: "该资产",
    review_status: "pending_review",
    review_status_label: "待审核",
    destination: "参考控制包",
    display_message: body.message,
  });
});
