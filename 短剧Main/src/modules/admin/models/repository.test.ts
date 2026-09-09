import assert from "node:assert/strict";
import test from "node:test";
import { DrizzleAdminModelRepository } from "./repository.js";

const inaccessibleDatabase = new Proxy({}, {
  get() {
    throw new Error("无效价格不应访问数据库");
  },
});

test("价格写入在访问数据库前拒绝非正整数和错误计费单位", async () => {
  const repository = new DrizzleAdminModelRepository(inaccessibleDatabase as never);
  for (const unitPriceFen of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      repository.replacePricingRule("admin-id", {
        provider: "ark",
        model: "seedream-model-id",
        mediaKind: "image",
        billingUnit: "image",
        unitPriceFen,
        currency: "CNY",
        expectedActiveRuleId: null,
      }),
      (error: unknown) => hasError(error, "invalid_request", 400, "保存单价没成：单价必须是大于 0 的整数，请修改后再试。"),
    );
  }
  await assert.rejects(
    repository.replacePricingRule("admin-id", {
      provider: "ark",
      model: "seedance-model-id",
      mediaKind: "video",
      billingUnit: "image",
      unitPriceFen: 80,
      currency: "CNY",
      expectedActiveRuleId: null,
    }),
    (error: unknown) => hasError(error, "invalid_request", 400, "保存单价没成：图片按张填写，视频按秒填写，请修改后再试。"),
  );
});

test("价格写入拒绝非 CNY 和低于 V0.1 下限的 Ark 视频单价", async () => {
  const repository = new DrizzleAdminModelRepository(inaccessibleDatabase as never);
  await assert.rejects(
    repository.replacePricingRule("admin-id", {
      provider: "ark",
      model: "seedream-model-id",
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 60,
      currency: "USD" as never,
      expectedActiveRuleId: null,
    }),
    (error: unknown) => hasError(error, "invalid_request", 400, "保存单价没成：当前只支持人民币计价，请修改后再试。"),
  );
  await assert.rejects(
    repository.replacePricingRule("admin-id", {
      provider: "ark",
      model: "seedance-model-id",
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 79,
      currency: "CNY",
      expectedActiveRuleId: null,
    }),
    (error: unknown) => hasError(error, "invalid_request", 400, "保存视频单价没成：单价低于当前允许的最低值，请提高到每秒 80 分后再试。"),
  );
  await assert.rejects(
    repository.replacePricingRule("admin-id", {
      provider: "openspeech",
      model: "unverified-audio-model",
      mediaKind: "audio",
      billingUnit: "second",
      unitPriceFen: 1,
      currency: "CNY",
      expectedActiveRuleId: null,
    }),
    (error: unknown) => hasError(error, "invalid_request", 400),
  );
});

test("价格仓储本身也拒绝能力档，不能绕过 HTTP 受控脚本门禁", async () => {
  const repository = new DrizzleAdminModelRepository(inaccessibleDatabase as never);
  await assert.rejects(
    repository.replacePricingRule("admin-id", {
      provider: "ark",
      model: "doubao-seedance-2-0-fast-260128",
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 40,
      currency: "CNY",
      expectedActiveRuleId: null,
      metadata: {
        activation_scope: "dev_smoke_only",
        capability_tier: {
          tier_id: "vid-seedance20fast-169-480p",
          status: "active",
          params: {},
        },
      },
    }),
    (error: unknown) => hasError(
      error,
      "invalid_request",
      400,
      "保存单价没成：能力档只能使用受控解冻脚本逐档维护。",
    ),
  );
});

function hasError(error: unknown, code: string, statusCode: number, message?: string): boolean {
  return error instanceof Error
    && "code" in error
    && "statusCode" in error
    && error.code === code
    && error.statusCode === statusCode
    && (message === undefined || error.message === message);
}
