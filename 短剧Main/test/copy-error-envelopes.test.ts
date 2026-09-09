import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { toHttpErrorResponse } from "../src/http/errorResponse.js";
import { parseRequest } from "../src/http/response.js";
import {
  AppError,
  ExternalServiceError,
  ForbiddenError,
  errorBody,
  publicStoredMessage,
} from "../src/shared/errors.js";
import { GenerationError } from "../src/modules/generation/errors.js";
import {
  fieldLabel,
  normalisePublicFieldDetails,
} from "../src/shared/fieldLabels.js";

const forbiddenPublicCopy = /\b(?:TOS|Ark|Pi|Milvus|HTTP|Provider|upstream|request|response|status|error|failed)\b|project_id|episode_id/iu;

test("平台 parseRequest 快照：Zod issues 收口为中文 fields", () => {
  const schema = z.object({
    project_id: z.string().uuid(),
    registration: z.object({
      role_name: z.string().trim().min(1),
    }),
  });

  let result: ReturnType<typeof toHttpErrorResponse> | undefined;
  try {
    parseRequest(schema, {
      project_id: "not-a-uuid",
      registration: { role_name: "" },
    });
  } catch (error) {
    result = toHttpErrorResponse(error);
  }

  assert.deepEqual(result, {
    statusCode: 400,
    body: {
      code: "invalid_request",
      message: "请求没能处理：请检查标出的填写内容后重试。",
      retryable: false,
      details: { fields: ["项目", "角色名"] },
    },
  });
  assertBusinessMessage(result!.body.message);
});

test("前后端 fieldLabels 共用投影：驼峰、蛇形和旧 issues 都不泄露字段名", () => {
  assert.equal(fieldLabel("projectId"), "项目");
  assert.equal(fieldLabel(["registration", "role_name"]), "角色名");
  assert.equal(fieldLabel(["breakdown_elements", "action"]), "动作");
  assert.equal(fieldLabel(["body", "breakdown_elements", 0, "action"]), "动作");
  assert.deepEqual(normalisePublicFieldDetails([
    { path: ["episode_id"], code: "invalid_type" },
    { path: ["unknown_internal_field"], code: "required" },
  ]), { fields: ["剧集", "填写内容"] });
});

test("非 AppError 4xx 快照：框架原文与 HTTP 数字被遮住", () => {
  const frameworkError = Object.assign(
    new Error("Body cannot be parsed as JSON: HTTP 400"),
    { statusCode: 400, code: "FST_ERR_CTP_INVALID_JSON_BODY" },
  );
  const response = toHttpErrorResponse(frameworkError);

  assert.deepEqual(response, {
    statusCode: 400,
    body: {
      code: "invalid_request",
      message: "请求没能处理：填写内容有误，请检查后重试。",
      retryable: false,
      details: null,
    },
  });
  assertBusinessMessage(response.body.message);
});

test("GenerationError 走 AppError 信封：422 业务真因保留，内部细节仍为空", () => {
  const error = new GenerationError(
    "control_asset_invalid_usage",
    "参考图边长不能小于 300 像素，请重新选择素材",
    422,
  );

  assert.ok(error instanceof AppError);
  assert.deepEqual(toHttpErrorResponse(error), {
    statusCode: 422,
    body: {
      code: "control_asset_invalid_usage",
      message: "参考图边长不能小于 300 像素，请重新选择素材",
      retryable: false,
      details: null,
    },
  });
  assertBusinessMessage(error.message);
});

test("GenerationError 走 AppError 信封：402 预算原因和稳定错误码不再被改写", () => {
  const error = new GenerationError(
    "GENERATION_BUDGET_EXCEEDED",
    "当前预算不足，未创建这项生成任务",
    402,
  );

  assert.deepEqual(toHttpErrorResponse(error), {
    statusCode: 402,
    body: {
      code: "GENERATION_BUDGET_EXCEEDED",
      message: "当前预算不足，未创建这项生成任务",
      retryable: false,
      details: null,
    },
  });
  assertBusinessMessage(error.message);
});

test("GenerationError 只公开业务原因：能力配置名和供应商原文继续留在服务端", () => {
  const internalMessage = "音频能力尚未配置 OPENSPEECH_TTS_TOKEN，Provider response 503";
  const error = new GenerationError(
    "GENERATION_CAPABILITY_UNAVAILABLE",
    internalMessage,
    503,
    true,
  );

  assert.equal(error.message, internalMessage);
  assert.deepEqual(toHttpErrorResponse(error), {
    statusCode: 503,
    body: {
      code: "GENERATION_CAPABILITY_UNAVAILABLE",
      message: "所选生成档位暂时不可用，请重新选择或稍后再试。",
      retryable: true,
      details: null,
    },
  });
  assert.doesNotMatch(error.displayMessage ?? "", /OPENSPEECH|TOKEN|Provider|503/iu);
  assertBusinessMessage(error.displayMessage ?? "");
});

test("GenerationError 脱敏不被下划线或点号绕过", () => {
  for (const internalMessage of [
    "请检查 ARK_API_KEY 配置后重试",
    "供应商返回 base_resp.status_code=1002，请调整提示词后重试",
  ]) {
    const error = new GenerationError(
      "INVALID_GENERATION_REQUEST",
      internalMessage,
      422,
    );

    assert.equal(error.message, internalMessage);
    assert.deepEqual(toHttpErrorResponse(error), {
      statusCode: 422,
      body: {
        code: "INVALID_GENERATION_REQUEST",
        message: "生成设置不符合要求，请检查后重试。",
        retryable: false,
        details: null,
      },
    });
  }
});

test("生成引用素材权限拒绝保持稳定 forbidden 机器码", () => {
  assert.deepEqual(toHttpErrorResponse(new ForbiddenError("没有权限使用引用媒体")), {
    statusCode: 403,
    body: {
      code: "forbidden",
      message: "没有权限使用引用媒体",
      retryable: false,
      details: null,
    },
  });
});

test("ExternalServiceError 快照：服务标识保留在日志 Error，公开信封只给业务话", () => {
  const error = new ExternalServiceError("TOS", "request failed with status 503");
  assert.equal(error.message, "TOS: request failed with status 503");
  assert.deepEqual(errorBody(error), {
    code: "external_service_error",
    message: "素材没能保存：存储服务暂时没响应，请稍后重试。",
    retryable: true,
    details: null,
  });
  assertBusinessMessage(errorBody(error).message);
});

test("旧异步任务错误只投影 display_reason，无法清洗的英文串走业务兜底", () => {
  assert.equal(
    publicStoredMessage(
      "ProviderError: Ark request failed with HTTP status 503",
      "图片生成没成：请检查生成设置后重试。",
    ),
    "图片生成没成：请检查生成设置后重试。",
  );
  assert.equal(
    publicStoredMessage("素材上传没成：请重新上传。", "不应使用"),
    "素材上传没成：请重新上传。",
  );
});

test("AppError details 默认收口，仅保留字段提示和冻结机器契约", () => {
  assert.deepEqual(
    errorBody(new AppError(
      409,
      "review_state_conflict",
      "审核没成：状态已经变化，请刷新后重试。",
      false,
      { currentStatus: "pending", targetStatus: "approved" },
    )),
    {
      code: "review_state_conflict",
      message: "审核没成：状态已经变化，请刷新后重试。",
      retryable: false,
      details: null,
    },
  );
  assert.deepEqual(
    errorBody(new AppError(
      400,
      "invalid_request",
      "请求没能处理：请检查标出的填写内容后重试。",
      false,
      { fields: ["media_result_id", "角色名"] },
    )),
    {
      code: "invalid_request",
      message: "请求没能处理：请检查标出的填写内容后重试。",
      retryable: false,
      details: { fields: ["生成素材", "角色名"] },
    },
  );
  assert.deepEqual(
    errorBody(new AppError(
      409,
      "scene_version_conflict",
      "保存场景没成：场景已被更新，请刷新后再试。",
      false,
      { currentVersion: 5 },
    )).details,
    { currentVersion: 5 },
  );
});

function assertBusinessMessage(message: string): void {
  assert.match(message, /[\u3400-\u9fff]/u);
  assert.doesNotMatch(message, forbiddenPublicCopy);
}
