import assert from "node:assert/strict";
import test from "node:test";
import { ExternalServiceError, errorBody } from "../shared/errors.js";
import { TosStorage, type TosClientLike } from "./tosStorage.js";

function storage(client: TosClientLike): TosStorage {
  return new TosStorage({
    client,
    config: { bucket: "assets", endpoint: "tos.example.com", accessKey: "not-logged", secretKey: "not-logged", region: "cn-beijing" },
  });
}

test("headObject 使用已配置桶和对象 key，不记录或返回凭据", async () => {
  let received: Record<string, unknown> | undefined;
  const result = await storage({
    async headObject(input) { received = input; return { data: { contentLength: 7, contentType: "image/png", etag: "etag" } }; },
  }).headObject("assets/a.png");

  assert.deepEqual(received, { bucket: "assets", key: "assets/a.png" });
  assert.deepEqual(result, { contentLength: 7, contentType: "image/png", etag: "etag", lastModified: null });
  assert.doesNotMatch(JSON.stringify(result), /not-logged/);
});

test("readObjectBytes 先拒绝超限对象，并以 Range 保护读取上限", async () => {
  let getCalled = false;
  const tooLarge = storage({
    async headObject() { return { data: { contentLength: 11 } }; },
    async getObjectV2() { getCalled = true; return { data: { content: Buffer.from("unexpected") } }; },
  });
  await assert.rejects(() => tooLarge.readObjectBytes("assets/a.png", { maxBytes: 10 }), /exceeds the 10 byte limit/);
  assert.equal(getCalled, false);

  let received: Record<string, unknown> | undefined;
  const content = await storage({
    async headObject() { return { data: { contentLength: 4 } }; },
    async getObjectV2(input) { received = input; return { data: { content: Buffer.from("data") } }; },
  }).readObjectBytes("assets/a.png", { maxBytes: 4 });
  assert.deepEqual(content, Buffer.from("data"));
  assert.deepEqual(received, {
    bucket: "assets",
    key: "assets/a.png",
    dataType: "buffer",
    rangeStart: 0,
    rangeEnd: 3,
  });

  const processedCalls: Record<string, unknown>[] = [];
  const processed = await storage({
    async headObject(input) { processedCalls.push(input); return { data: { contentLength: 100 } }; },
    async getObjectV2(input) { processedCalls.push(input); return { data: { content: Buffer.from("small") } }; },
  }).readObjectBytes("assets/a.png", { bucket: "derived", maxBytes: 5, process: "image/resize,w_320" });
  assert.deepEqual(processed, Buffer.from("small"));
  assert.deepEqual(processedCalls, [
    { bucket: "derived", key: "assets/a.png" },
    { bucket: "derived", key: "assets/a.png", dataType: "buffer", rangeStart: 0, rangeEnd: 4, process: "image/resize,w_320" },
  ]);
});

test("短时下载签名固定为 GET，超过短时上限会失败", async () => {
  let received: Record<string, unknown> | undefined;
  const signed = await storage({
    async getPreSignedUrl(input) { received = input; return "https://tos.example.com/signed"; },
  }).createDownloadUrl("assets/a.png", { bucket: "downloads", expiresSeconds: 60, fileName: "中文 图片.png" });
  assert.equal(signed.url, "https://tos.example.com/signed");
  assert.ok(signed.expiresAt instanceof Date);
  assert.deepEqual(received, {
    bucket: "downloads",
    key: "assets/a.png",
    method: "GET",
    expires: 60,
    response: {
      contentDisposition: "attachment; filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png",
    },
  });
  await assert.rejects(() => storage({ async getPreSignedUrl() { return "https://tos.example.com/signed"; } }).createDownloadUrl("assets/a.png", { expiresSeconds: 901 }), /at most 900 seconds/);
});

test("TOS SDK 错误只保留受控分类和重试语义，不泄露供应商细节", async () => {
  const cases = [
    { statusCode: 403, category: "access_denied", retryable: false },
    { statusCode: 404, category: "object_not_found", retryable: false },
    { statusCode: 500, category: "service_unavailable", retryable: true },
    { statusCode: undefined, category: "request_failed", retryable: true },
  ] as const;
  const sensitive = "endpoint=https://tos.internal.example.com key=private/a.png requestId=req-secret provider-body=do-not-expose";

  for (const expected of cases) {
    const sdkError = Object.assign(new Error(sensitive), expected.statusCode === undefined ? {} : { statusCode: expected.statusCode });
    await assert.rejects(
      () => storage({ async headObject() { throw sdkError; } }).headObject("private/a.png"),
      (error: unknown) => {
        assert.ok(error instanceof ExternalServiceError);
        assert.equal((error as ExternalServiceError & { category?: string }).category, expected.category);
        assert.equal(error.retryable, expected.retryable);
        assert.doesNotMatch(error.message, /tos\.internal|private\/a\.png|req-secret|provider-body/i);
        assert.doesNotMatch(JSON.stringify(error), /tos\.internal|private\/a\.png|req-secret|provider-body/i);
        assert.deepEqual(errorBody(error), {
          code: "external_service_error",
          message: "素材没能保存：存储服务暂时没响应，请稍后重试。",
          retryable: expected.retryable,
          details: null,
        });
        return true;
      },
    );
  }
});

test("下载签名 URL 必须使用 HTTPS", async () => {
  await assert.rejects(
    () => storage({ async getPreSignedUrl() { return "http://tos.example.com/signed"; } }).createDownloadUrl("assets/a.png"),
    (error: unknown) => error instanceof ExternalServiceError && error.message === "TOS: TOS SDK returned an invalid presigned URL",
  );
});
