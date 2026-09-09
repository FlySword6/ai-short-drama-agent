import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRequestError } from "../errors.js";
import type { GenerationReferenceSnapshot, ProviderGenerationRequest } from "../types.js";
import {
  buildHappyHorsePrompt,
  HappyHorseGenerationProvider,
  isApprovedHappyHorseBaseUrl,
} from "./happyhorseGenerationProvider.js";

const BASE_URL = "https://ws-12345.cn-beijing.maas.aliyuncs.com";
const MODEL = "happyhorse-1.1-r2v";

test("isApprovedHappyHorseBaseUrl 只接受五地域 Workspace 级 + 官方遗留 https 域名", () => {
  for (const region of ["cn-beijing", "ap-southeast-1", "us-east-1", "eu-central-1", "ap-northeast-1"]) {
    assert.equal(isApprovedHappyHorseBaseUrl(`https://ws-abc123.${region}.maas.aliyuncs.com`), true);
  }
  // 阿里云文档标注的遗留兼容域名(华北2北京 / 新加坡),仍正常服务。
  assert.equal(isApprovedHappyHorseBaseUrl("https://dashscope.aliyuncs.com"), true);
  assert.equal(isApprovedHappyHorseBaseUrl("https://dashscope-intl.aliyuncs.com"), true);
  assert.equal(isApprovedHappyHorseBaseUrl("http://ws-abc123.cn-beijing.maas.aliyuncs.com"), false);
  assert.equal(isApprovedHappyHorseBaseUrl("https://ws-abc123.cn-shanghai.maas.aliyuncs.com"), false);
  // 地域前缀变体不是官方端点,伪后缀与变体域名一律拒绝。
  assert.equal(isApprovedHappyHorseBaseUrl("https://dashscope.cn-beijing.aliyuncs.com"), false);
  assert.equal(isApprovedHappyHorseBaseUrl("https://dashscope.aliyuncs.com.evil.com"), false);
  assert.equal(isApprovedHappyHorseBaseUrl("https://dashscope-evil.aliyuncs.com"), false);
  assert.equal(isApprovedHappyHorseBaseUrl("https://ws-abc123.cn-beijing.maas.aliyuncs.com.evil.com"), false);
  assert.equal(isApprovedHappyHorseBaseUrl("not a url"), false);
});

test("buildHappyHorsePrompt 追加 [Image N] 映射前缀且不改写用户原 prompt", () => {
  const userPrompt = "陈默站在天台边缘，镜头缓缓推近";
  assert.equal(buildHappyHorsePrompt(userPrompt, 0), userPrompt);
  assert.equal(
    buildHappyHorsePrompt(userPrompt, 2),
    `参考图对应:[Image 1]=图片1、[Image 2]=图片2。${userPrompt}`,
  );
});

test("submit 按 DashScope 异步契约组装请求体与请求头", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        request_id: "req-1",
        output: { task_id: "task-abc", task_status: "PENDING" },
      }), { status: 200 });
    },
  });

  const submission = await provider.submit(videoRequest({
    references: [
      { kind: "image", url: "https://assets.example.com/a.png" },
      { kind: "video", url: "https://assets.example.com/v.mp4" },
      { kind: "image", url: "https://assets.example.com/b.png" },
    ],
    parameters: { resolution: "480p", durationSeconds: 5 },
  }));

  assert.deepEqual(submission, { outcome: "accepted", providerTaskId: "task-abc", rawStatus: "PENDING" });
  assert.equal(calls.length, 1);
  const call = calls.at(0)!;
  assert.equal(
    call.url,
    `${BASE_URL}/api/v1/services/aigc/video-generation/video-synthesis`,
  );
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-test");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers["X-DashScope-Async"], "enable");

  const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, MODEL);
  const input = body.input as Record<string, unknown>;
  // media 顺序 = references 里 image 的顺序;非 image 参考被忽略。
  assert.deepEqual(input.media, [
    { type: "reference_image", url: "https://assets.example.com/a.png" },
    { type: "reference_image", url: "https://assets.example.com/b.png" },
  ]);
  assert.equal(
    input.prompt,
    "参考图对应:[Image 1]=图片1、[Image 2]=图片2。陈默站在天台边缘，镜头缓缓推近",
  );
  const parameters = body.parameters as Record<string, unknown>;
  assert.equal(parameters.resolution, "480P");
  assert.equal(parameters.ratio, "9:16");
  assert.equal(parameters.duration, 5);
  assert.equal(parameters.watermark, false);
  assert.equal("seed" in parameters, false);
});

test("submit 缺省 resolution 落 720P、watermark 仅 true 时开启、ratio 透传", async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async (_input, init) => {
      calls.push({ init });
      return new Response(JSON.stringify({ output: { task_id: "task-abc", task_status: "PENDING" } }), { status: 200 });
    },
  });

  await provider.submit(videoRequest({
    references: [{ kind: "image", url: "https://assets.example.com/a.png" }],
    parameters: { durationSeconds: 3, ratio: "16:9", watermark: true },
  }));
  const parameters = JSON.parse(String(calls.at(0)!.init?.body)).parameters as Record<string, unknown>;
  assert.equal(parameters.resolution, "720P");
  assert.equal(parameters.ratio, "16:9");
  assert.equal(parameters.watermark, true);
});

test("submit 图片/音频媒体类型被拒绝且不产生网络调用", async () => {
  let called = false;
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async () => {
      called = true;
      return new Response("{}");
    },
  });

  for (const mediaKind of ["image", "audio"] as const) {
    await assert.rejects(
      provider.submit(videoRequest({ mediaKind })),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && error.providerCode === "PROVIDER_NOT_CONFIGURED",
    );
  }
  assert.equal(called, false);
});

const INVALID_SUBMIT_CASES: Array<{ label: string; references: GenerationReferenceSnapshot[]; parameters: Record<string, unknown> }> = [
  { label: "0 张参考图", references: [], parameters: { durationSeconds: 5 } },
  {
    label: "10 张参考图",
    references: Array.from({ length: 10 }, (_, index) => ({ kind: "image" as const, url: `https://assets.example.com/${index}.png` })),
    parameters: { durationSeconds: 5 },
  },
  { label: "时长低于 3 秒", references: [{ kind: "image", url: "https://assets.example.com/a.png" }], parameters: { durationSeconds: 2 } },
  { label: "时长高于 15 秒", references: [{ kind: "image", url: "https://assets.example.com/a.png" }], parameters: { durationSeconds: 16 } },
  { label: "时长非整数", references: [{ kind: "image", url: "https://assets.example.com/a.png" }], parameters: { durationSeconds: 5.5 } },
];

for (const { label, references, parameters } of INVALID_SUBMIT_CASES) {
  test(`submit 拒绝非法输入:${label}`, async () => {
    const provider = new HappyHorseGenerationProvider({
      apiKey: "sk-test",
      baseUrl: BASE_URL,
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });
    await assert.rejects(
      provider.submit(videoRequest({ references, parameters: parameters as ProviderGenerationRequest["parameters"] })),
      (error: unknown) => error instanceof ProviderRequestError
        && error.operation === "submit_video"
        && error.outcome === "rejected"
        && error.retryable === false,
    );
  });
}

test("submit 失败时按 HTTP 状态映射 rejected/unknown", async () => {
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async () => new Response(JSON.stringify({
      code: "InvalidApiKey",
      message: "Invalid API-key provided",
    }), { status: 401 }),
  });
  await assert.rejects(
    provider.submit(videoRequest({ references: [{ kind: "image", url: "https://assets.example.com/a.png" }] })),
    (error: unknown) => error instanceof ProviderRequestError
      && error.outcome === "rejected"
      && error.retryable === false
      && error.providerCode === "InvalidApiKey"
      && error.httpStatus === 401,
  );
});

const QUERY_CASES = [
  { taskStatus: "PENDING", expected: { status: "pending", rawStatus: "PENDING", media: [] } },
  { taskStatus: "RUNNING", expected: { status: "running", rawStatus: "RUNNING", media: [] } },
] as const;

for (const { taskStatus, expected } of QUERY_CASES) {
  test(`query 映射 ${taskStatus} → ${expected.status}`, async () => {
    const provider = new HappyHorseGenerationProvider({
      apiKey: "sk-test",
      baseUrl: BASE_URL,
      fetchImpl: async (input) => {
        assert.equal(String(input), `${BASE_URL}/api/v1/tasks/task-abc`);
        return new Response(JSON.stringify({ output: { task_id: "task-abc", task_status: taskStatus } }), { status: 200 });
      },
    });
    const snapshot = await provider.query("task-abc", { model: MODEL, mediaKind: "video" });
    assert.equal(snapshot.status, expected.status);
    assert.equal(snapshot.rawStatus, expected.rawStatus);
    assert.equal(snapshot.unknownStatus, undefined);
    assert.deepEqual(snapshot.media, expected.media);
  });
}

test("query SUCCEEDED 返回成片、计费 usage 与任务 metadata", async () => {
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async () => new Response(JSON.stringify({
      request_id: "req-1",
      output: {
        task_id: "task-abc",
        task_status: "SUCCEEDED",
        video_url: "https://dashscope-result.oss-cn-beijing.aliyuncs.com/out.mp4",
        submit_time: "2026-08-18 10:00:00",
        end_time: "2026-08-18 10:02:00",
        ratio: "9:16",
        SR: "720P",
      },
      usage: { duration: 5, output_video_duration: 5, SR: 720, ratio: 1.78 },
    }), { status: 200 }),
  });

  const snapshot = await provider.query("task-abc", { model: MODEL, mediaKind: "video" });
  assert.equal(snapshot.status, "succeeded");
  assert.deepEqual(snapshot.media, [{
    kind: "video",
    temporaryUrl: "https://dashscope-result.oss-cn-beijing.aliyuncs.com/out.mp4",
    providerResultKey: "video-0",
  }]);
  assert.deepEqual(snapshot.usage, { duration: 5, output_video_duration: 5, SR: 720, ratio: 1.78 });
  assert.deepEqual(snapshot.metadata, {
    submitTime: "2026-08-18 10:00:00",
    endTime: "2026-08-18 10:02:00",
    ratio: "9:16",
    SR: "720P",
  });
});

test("query SUCCEEDED 缺少 video_url 时报可重试查询失败", async () => {
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async () => new Response(JSON.stringify({
      output: { task_id: "task-abc", task_status: "SUCCEEDED" },
    }), { status: 200 }),
  });
  await assert.rejects(
    provider.query("task-abc", { model: MODEL, mediaKind: "video" }),
    (error: unknown) => error instanceof ProviderRequestError
      && error.outcome === "query_failed"
      && error.retryable === true,
  );
});

test("query FAILED 携带供应商 code/message", async () => {
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async () => new Response(JSON.stringify({
      output: {
        task_id: "task-abc",
        task_status: "FAILED",
        code: "InvalidParameter",
        message: "prompt too long",
      },
    }), { status: 200 }),
  });
  const snapshot = await provider.query("task-abc", { model: MODEL, mediaKind: "video" });
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.unknownStatus, undefined);
  assert.equal(snapshot.errorCode, "InvalidParameter");
  assert.equal(snapshot.errorMessage, "prompt too long");
});

test("query CANCELED 映射为 failed", async () => {
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async () => new Response(JSON.stringify({
      output: { task_id: "task-abc", task_status: "CANCELED" },
    }), { status: 200 }),
  });
  const snapshot = await provider.query("task-abc", { model: MODEL, mediaKind: "video" });
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.rawStatus, "CANCELED");
});

test("query UNKNOWN 标记 unknownStatus 且不翻成终态成功", async () => {
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async () => new Response(JSON.stringify({
      output: { task_id: "task-abc", task_status: "UNKNOWN" },
    }), { status: 200 }),
  });
  const snapshot = await provider.query("task-abc", { model: MODEL, mediaKind: "video" });
  assert.equal(snapshot.unknownStatus, true);
  assert.equal(snapshot.status, "failed");
  assert.deepEqual(snapshot.media, []);
});

test("query 网络错误报可重试查询失败", async () => {
  const provider = new HappyHorseGenerationProvider({
    apiKey: "sk-test",
    baseUrl: BASE_URL,
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });
  await assert.rejects(
    provider.query("task-abc", { model: MODEL, mediaKind: "video" }),
    (error: unknown) => error instanceof ProviderRequestError
      && error.operation === "query_video"
      && error.outcome === "query_failed"
      && error.retryable === true,
  );
});

function videoRequest(overrides: Partial<ProviderGenerationRequest> = {}): ProviderGenerationRequest {
  return {
    mediaKind: "video",
    model: MODEL,
    prompt: "陈默站在天台边缘，镜头缓缓推近",
    parameters: { durationSeconds: 5 },
    references: [{ kind: "image", url: "https://assets.example.com/a.png" }],
    quantity: 1,
    ...overrides,
  };
}
