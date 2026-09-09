import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRequestError } from "../../src/modules/generation/errors.js";
import {
  AsyncImageGatewayProvider,
  isApprovedAsyncImageGatewayBaseUrl,
} from "../../src/modules/generation/provider/asyncImageGatewayProvider.js";
import type { ProviderGenerationRequest } from "../../src/modules/generation/types.js";

function request(
  model: string,
  parameters: ProviderGenerationRequest["parameters"],
  overrides: Partial<ProviderGenerationRequest> = {},
): ProviderGenerationRequest {
  return {
    mediaKind: "image",
    model,
    prompt: "电影感雨夜街道",
    parameters,
    references: [],
    quantity: 1,
    ...overrides,
  };
}

test("异步图片网关按三份模型文档分别构造请求体", async () => {
  const captures: Array<{ url: string; body: unknown }> = [];
  const provider = new AsyncImageGatewayProvider({
    apiKey: "company-test-key",
    baseUrl: "https://gateway.company.example/vendor",
    fetchImpl: async (input, init) => {
      captures.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as unknown,
      });
      assert.equal((init?.headers as Record<string, string>).Authorization, "company-test-key");
      assert.equal(init?.redirect, "error");
      return Response.json({ code: 200, data: { id: `task-${captures.length}` } });
    },
  });

  await provider.submit(request("gpt-image-2-suchuang", { size: "9:21" }, {
    references: [{ kind: "image", url: "https://media.example.com/gpt-ref.png" }],
  }));
  await provider.submit(request("nanobanana-lite", {
    size: "1K",
    aspectRatio: "5:4",
  }));
  await provider.submit(request("nanobanana-2", {
    size: "4K",
    aspectRatio: "1:8",
  }, {
    references: [{ kind: "image", url: "https://media.example.com/nano-ref.png" }],
  }));

  assert.deepEqual(captures, [
    {
      url: "https://gateway.company.example/vendor/api/async/image_gpt",
      body: {
        prompt: "电影感雨夜街道",
        size: "9:21",
        urls: ["https://media.example.com/gpt-ref.png"],
      },
    },
    {
      url: "https://gateway.company.example/vendor/api/async/image_nanoBanana2Lite",
      body: {
        prompt: "电影感雨夜街道",
        size: "1K",
        aspectRatio: "5:4",
      },
    },
    {
      url: "https://gateway.company.example/vendor/api/async/image_nanoBanana2",
      body: {
        prompt: "电影感雨夜街道",
        size: "4K",
        aspectRatio: "1:8",
        urls: ["https://media.example.com/nano-ref.png"],
      },
    },
  ]);
});

test("配置地址已包含供应商 /api 根路径时不重复拼接", async () => {
  const seenUrls: string[] = [];
  const provider = new AsyncImageGatewayProvider({
    apiKey: "company-test-key",
    baseUrl: "https://gateway.company.example/api",
    fetchImpl: async (input) => {
      seenUrls.push(String(input));
      return Response.json({ code: 200, data: { id: "task-ok" } });
    },
  });

  await provider.submit(request("gpt-image-2-suchuang", { size: "auto" }));

  assert.deepEqual(seenUrls, [
    "https://gateway.company.example/api/async/image_gpt",
  ]);
});

test("两款 NanoBanana 保留各自不同的 aspectRatio 白名单", async () => {
  let calls = 0;
  const provider = new AsyncImageGatewayProvider({
    apiKey: "company-test-key",
    baseUrl: "https://gateway.company.example",
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ code: 200, data: { id: "task-ok" } });
    },
  });
  await assert.rejects(
    () => provider.submit(request("nanobanana-lite", {
      size: "1K",
      aspectRatio: "1:8",
    })),
    (error: unknown) => error instanceof ProviderRequestError && error.outcome === "rejected",
  );
  await provider.submit(request("nanobanana-2", {
    size: "1K",
    aspectRatio: "1:8",
  }));
  assert.equal(calls, 1);
});

test("非法尺寸、额外参数和非图片参考在付费请求前拒绝", async () => {
  let calls = 0;
  const provider = new AsyncImageGatewayProvider({
    apiKey: "company-test-key",
    baseUrl: "https://gateway.company.example",
    fetchImpl: async () => {
      calls += 1;
      return Response.json({});
    },
  });
  for (const invalidRequest of [
    request("gpt-image-2-suchuang", { size: "2K" }),
    request("nanobanana-lite", { size: "2K", aspectRatio: "1:1" }),
    request("nanobanana-2", { size: "1K", aspectRatio: "1:1", ratio: "1:1" }),
    request("nanobanana-2", { size: "1K", aspectRatio: "1:1" }, {
      references: [{ kind: "video", url: "https://media.example.com/ref.mp4" }],
    }),
  ]) {
    await assert.rejects(
      () => provider.submit(invalidRequest),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "rejected",
    );
  }
  assert.equal(calls, 0);
});

test("异步查询映射公开状态并提取安全结果 URL", async () => {
  const statuses = [0, 1, 2, 3, 4, -1, 99];
  let index = 0;
  const seenUrls: string[] = [];
  const provider = new AsyncImageGatewayProvider({
    apiKey: "company-test-key",
    baseUrl: "https://gateway.company.example",
    fetchImpl: async (input, init) => {
      seenUrls.push(String(input));
      assert.equal(init?.method, "GET");
      const status = statuses[index++];
      return Response.json({
        code: 200,
        data: {
          status,
          result: status === 2
            ? ["https://media.example.com/result.png", "http://unsafe.example/result.png"]
            : [],
        },
      });
    },
  });

  const results = [];
  for (let offset = 0; offset < statuses.length; offset += 1) {
    results.push(await provider.query(
      `task ${offset}`,
      { mediaKind: "image", model: "gpt-image-2-suchuang" },
    ));
  }
  assert.deepEqual(results.map((result) => result.status), [
    "pending", "running", "succeeded", "failed", "failed", "failed", "running",
  ]);
  assert.equal(results[2]?.media[0]?.temporaryUrl, "https://media.example.com/result.png");
  assert.deepEqual(results[2]?.usage, { generated_images: 1 });
  assert.equal(results[6]?.unknownStatus, true);
  assert.equal(
    seenUrls[0],
    "https://gateway.company.example/api/async/detail?id=task+0",
  );
});

test("成功结果只读取真实验证过的 data.result 数组", async () => {
  const provider = new AsyncImageGatewayProvider({
    apiKey: "company-test-key",
    baseUrl: "https://gateway.company.example/api",
    fetchImpl: async () => Response.json({
      code: 200,
      data: {
        status: 2,
        result: null,
        image_url: "https://media.example.com/undocumented.png",
      },
    }),
  });

  await assert.rejects(
    () => provider.query(
      "task-contract-drift",
      { mediaKind: "image", model: "gpt-image-2-suchuang" },
    ),
    (error: unknown) => error instanceof ProviderRequestError
      && error.operation === "query"
      && error.providerCode === "PROVIDER_QUERY_FAILED",
  );
});

test("网关地址和错误信息不会泄露公司密钥", async () => {
  for (const invalid of [
    "http://gateway.company.example",
    "https://user:pass@gateway.company.example",
    "https://gateway.company.example?key=unsafe",
    "https://gateway.company.example/#unsafe",
    "https://localhost",
    "https://127.0.0.1",
  ]) {
    assert.equal(isApprovedAsyncImageGatewayBaseUrl(invalid), false, invalid);
  }
  assert.equal(
    isApprovedAsyncImageGatewayBaseUrl("https://gateway.company.example/vendor"),
    true,
  );

  const secret = "company-secret-must-not-leak";
  const provider = new AsyncImageGatewayProvider({
    apiKey: secret,
    baseUrl: "https://gateway.company.example",
    fetchImpl: async () => {
      throw new Error(`upstream rejected ${secret}`);
    },
  });
  await assert.rejects(
    () => provider.submit(request("gpt-image-2-suchuang", { size: "auto" })),
    (error: unknown) => error instanceof ProviderRequestError
      && error.outcome === "unknown"
      && !error.message.includes(secret),
  );
});
