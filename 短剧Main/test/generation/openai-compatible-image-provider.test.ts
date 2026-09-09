import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRequestError } from "../../src/modules/generation/errors.js";
import {
  isApprovedOpenAiCompatibleBaseUrl,
  openAiCompatibleBaseUrlSha256,
  OpenAiCompatibleImageProvider,
} from "../../src/modules/generation/provider/openAiCompatibleImageProvider.js";
import type { ProviderGenerationRequest } from "../../src/modules/generation/types.js";
import { PRICING_TIER_SEEDS } from "../../scripts/seed-pricing-tiers.mts";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nLkAAAAASUVORK5CYII=";

function approvedBaseUrl(baseUrl: string): {
  baseUrl: string;
  approvedBaseUrlSha256: string;
  approvedModelIds: readonly string[];
} {
  const approvedBaseUrlSha256 = openAiCompatibleBaseUrlSha256(baseUrl);
  assert.ok(approvedBaseUrlSha256);
  return {
    baseUrl,
    approvedBaseUrlSha256,
    approvedModelIds: ["gpt-image-2", "gemini-3.1-pro-image"],
  };
}

function imageRequest(
  overrides: Partial<ProviderGenerationRequest> = {},
): ProviderGenerationRequest {
  return {
    mediaKind: "image",
    model: "gpt-image-2",
    prompt: "一只纸雕小鹿",
    parameters: { size: "1024x1024", quality: "low" },
    references: [],
    quantity: 1,
    ...overrides,
  };
}

test("OpenAI-compatible 图片适配器使用可配置 /v1 endpoint 并只发送已审核字段", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const provider = new OpenAiCompatibleImageProvider({
    apiKey: "test-only-key",
    ...approvedBaseUrl("https://newapi.company.example/gateway/v1/"),
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        model: "gpt-image-2",
        data: [{ b64_json: PNG_1X1_BASE64 }],
        usage: { input_tokens: 7, output_tokens: 11, vendor_secret: 99 },
      });
    },
  });

  const submission = await provider.submit(imageRequest());
  assert.equal(capturedUrl, "https://newapi.company.example/gateway/v1/images/generations");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  assert.equal((capturedInit?.headers as Record<string, string>).Authorization, "Bearer test-only-key");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    model: "gpt-image-2",
    prompt: "一只纸雕小鹿",
    n: 1,
    size: "1024x1024",
    quality: "low",
  });
  assert.equal(submission.outcome, "succeeded");
  if (submission.outcome === "succeeded") {
    assert.deepEqual(submission.result.media, [{
      kind: "image",
      inlineContent: {
        contentBase64: PNG_1X1_BASE64,
        contentType: "image/png",
      },
      providerResultKey: "data-0",
    }]);
    assert.deepEqual(submission.result.usage, { input_tokens: 7, output_tokens: 11 });
    assert.deepEqual(submission.result.metadata, {});
  }
});

test("根 base_url 自动补 /v1，HTTPS 临时 URL 作为受控下载句柄返回", async () => {
  let capturedUrl = "";
  const provider = new OpenAiCompatibleImageProvider({
    apiKey: "test-only-key",
    ...approvedBaseUrl("https://newapi.company.example"),
    fetchImpl: async (input) => {
      capturedUrl = String(input);
      return Response.json({
        data: [{ url: "https://cdn.company.example/generated/result.png" }],
      });
    },
  });
  const submission = await provider.submit(imageRequest({ model: "gemini-3.1-pro-image" }));
  assert.equal(capturedUrl, "https://newapi.company.example/v1/images/generations");
  assert.equal(submission.outcome, "succeeded");
  if (submission.outcome === "succeeded") {
    assert.equal(
      submission.result.media[0]?.temporaryUrl,
      "https://cdn.company.example/generated/result.png",
    );
  }
});

test("base_url、请求类型和参考素材都在联网前 fail-closed", async () => {
  for (const url of [
    "http://newapi.company.example/v1",
    "https://user:pass@newapi.company.example/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://newapi.company.example/v1?unsafe=true",
    "https://newapi.company.example/unreviewed",
  ]) {
    assert.equal(isApprovedOpenAiCompatibleBaseUrl(
      url,
      openAiCompatibleBaseUrlSha256("https://newapi.company.example/v1"),
    ), false, url);
    assert.throws(() => new OpenAiCompatibleImageProvider({
      apiKey: "test-only-key",
      baseUrl: url,
      approvedBaseUrlSha256:
        openAiCompatibleBaseUrlSha256("https://newapi.company.example/v1")!,
      approvedModelIds: ["gpt-image-2"],
    }), /not approved/);
  }
  const approved = openAiCompatibleBaseUrlSha256("https://newapi.company.example/v1");
  assert.equal(isApprovedOpenAiCompatibleBaseUrl(
    "https://newapi.company.example/v1",
    approved,
  ), true);
  assert.equal(isApprovedOpenAiCompatibleBaseUrl(
    "https://newapi.other-company.example/v1",
    approved,
  ), false);

  let calls = 0;
  const provider = new OpenAiCompatibleImageProvider({
    apiKey: "test-only-key",
    ...approvedBaseUrl("https://newapi.company.example/v1"),
    fetchImpl: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  await assert.rejects(
    provider.submit(imageRequest({ mediaKind: "video" })),
    (error: unknown) => isProviderFailure(error, "rejected"),
  );
  await assert.rejects(
    provider.submit(imageRequest({
      references: [{ kind: "image", url: "https://media.example/ref.png" }],
    })),
    (error: unknown) => isProviderFailure(error, "rejected"),
  );
  await assert.rejects(
    provider.submit(imageRequest({ model: "expensive-or-unreviewed-model" })),
    (error: unknown) => isProviderFailure(error, "rejected"),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.submit(imageRequest(), controller.signal),
    (error: unknown) => isProviderFailure(error, "rejected"),
  );
  assert.equal(calls, 0);
});

test("公司网关模型 allowlist 只接受两条裁决 alias，额外模型在联网前拒绝", async () => {
  const base = approvedBaseUrl("https://newapi.company.example/v1");
  assert.throws(() => new OpenAiCompatibleImageProvider({
    apiKey: "test-only-key",
    ...base,
    approvedModelIds: ["gpt-image-2", "expensive-or-unreviewed-model"],
  }), /model allowlist is not approved/);
  assert.throws(() => new OpenAiCompatibleImageProvider({
    apiKey: "test-only-key",
    ...base,
    approvedModelIds: [],
  }), /model allowlist is not approved/);
});

test("非法/超限响应保持提交结果未知，且不泄露供应商 message", async () => {
  const cases = [
    () => Response.json({ data: [{ b64_json: "@@@=" }], message: "raw-provider-secret" }),
    () => Response.json({
      data: [{ b64_json: Buffer.from("not-an-image").toString("base64") }],
      message: "raw-provider-secret",
    }),
    () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(96 * 1024 * 1024 + 1) },
    }),
    () => Response.json({ data: [{ url: "http://insecure.example/result.png" }] }),
  ];
  for (const response of cases) {
    const provider = new OpenAiCompatibleImageProvider({
      apiKey: "test-only-key",
      ...approvedBaseUrl("https://newapi.company.example/v1"),
      fetchImpl: async () => response(),
    });
    await assert.rejects(provider.submit(imageRequest()), (error: unknown) => {
      assert.ok(isProviderFailure(error, "unknown"));
      assert.doesNotMatch((error as Error).message, /raw-provider-secret/);
      return true;
    });
  }
});

test("同步图片接口不伪造异步 query 能力", async () => {
  const provider = new OpenAiCompatibleImageProvider({
    apiKey: "test-only-key",
    ...approvedBaseUrl("https://newapi.company.example/v1"),
    fetchImpl: async () => Response.json({}),
  });
  await assert.rejects(provider.query("task-1"), (error: unknown) => (
    error instanceof ProviderRequestError
    && error.outcome === "query_failed"
    && error.providerCode === "PROVIDER_NOT_CONFIGURED"
  ));
});

test("newapi 实验档参数可直接送入适配器，1K/1:1 映射为 OpenAI-compatible 尺寸", async () => {
  const seed = PRICING_TIER_SEEDS.find((item) => (
    item.tier.tierId === "img-newapi-gptimage2-11-1k-low"
  ));
  assert.ok(seed);
  let capturedBody: Record<string, unknown> = {};
  const provider = new OpenAiCompatibleImageProvider({
    apiKey: "test-only-key",
    ...approvedBaseUrl("https://newapi.company.example/v1"),
    fetchImpl: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return Response.json({ data: [{ b64_json: PNG_1X1_BASE64 }] });
    },
  });
  await provider.submit(imageRequest({
    model: seed.model,
    parameters: seed.tier.params,
  }));
  assert.equal(capturedBody.size, "1024x1024");
  assert.equal(capturedBody.quality, "low");
});

function isProviderFailure(error: unknown, outcome: "rejected" | "unknown"): boolean {
  return error instanceof ProviderRequestError && error.outcome === outcome;
}
