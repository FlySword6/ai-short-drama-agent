import assert from "node:assert/strict";
import test from "node:test";
import { Seedance25Provider } from "../src/modules/vnext/providers/seedance/seedance25Provider.js";
import { VnextProviderRequestError } from "../src/modules/vnext/generation/errors.js";
import { Seedance25ContractViolationError } from "../src/modules/vnext/generation/seedance25Constraints.js";

// ─── Fake fetch helpers ────────────────────────────────────────────────────────

function okJson(body: unknown) {
  return (_url: unknown, _init?: RequestInit): Promise<Response> => Promise.resolve(
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

function statusJson(status: number, body: unknown) {
  return (_url: unknown, _init?: RequestInit): Promise<Response> => Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
}

function networkError() {
  return (_url: unknown, _init?: RequestInit): Promise<Response> => Promise.reject(new Error("network error"));
}

function makeProvider(overrides: {
  apiKey?: string;
  endpointModel?: string;
  fetchImpl?: (url: unknown, init?: RequestInit) => Promise<Response>;
} = {}) {
  return new Seedance25Provider({
    apiKey: overrides.apiKey ?? "test-api-key",
    endpointModel: overrides.endpointModel ?? "ep-seedance25",
    baseUrl: "https://fake.ark/api/v3",
    timeoutMs: 5_000,
    fetchImpl: (overrides.fetchImpl ?? okJson({})) as typeof fetch,
  });
}

const baseReq = {
  prompt: "雨夜巷口，人物回望",
  ratio: "9:16",
  resolution: "720p",
  durationSeconds: 4,
  nativeAudio: true,
  references: [] as [],
};

// ─── submit ───────────────────────────────────────────────────────────────────

test("seedance25: submit returns providerTaskId from response id", async () => {
  const provider = makeProvider({ fetchImpl: okJson({ id: "task-abc-123", status: "queued" }) });
  const result = await provider.submit(baseReq);
  assert.equal(result.providerTaskId, "task-abc-123");
  assert.equal(result.rawStatus, "queued");
});

test("seedance25: submit without apiKey throws rejected error before network call", async () => {
  const provider = makeProvider({ apiKey: "" });
  await assert.rejects(
    () => provider.submit(baseReq),
    (error: unknown) => {
      assert.ok(error instanceof VnextProviderRequestError);
      assert.equal(error.outcome, "rejected");
      assert.equal(error.providerCode, "PROVIDER_NOT_CONFIGURED");
      return true;
    },
  );
});

test("seedance25: submit without endpointModel throws rejected error before network call", async () => {
  const provider = makeProvider({ endpointModel: "" });
  await assert.rejects(
    () => provider.submit(baseReq),
    (error: unknown) => {
      assert.ok(error instanceof VnextProviderRequestError);
      assert.equal(error.outcome, "rejected");
      assert.equal(error.providerCode, "PROVIDER_NOT_CONFIGURED");
      return true;
    },
  );
});

test("seedance25: 429 response results in rejected outcome (no auto-retry)", async () => {
  const provider = makeProvider({ fetchImpl: statusJson(429, { error: { message: "rate limited" } }) });
  await assert.rejects(
    () => provider.submit(baseReq),
    (error: unknown) => {
      assert.ok(error instanceof VnextProviderRequestError);
      assert.equal(error.outcome, "rejected");
      assert.equal(error.providerCode, "RATE_LIMITED");
      assert.equal(error.httpStatus, 429);
      return true;
    },
  );
});

test("seedance25: network error on submit results in unknown outcome", async () => {
  const provider = makeProvider({ fetchImpl: networkError() });
  await assert.rejects(
    () => provider.submit(baseReq),
    (error: unknown) => {
      assert.ok(error instanceof VnextProviderRequestError);
      assert.equal(error.outcome, "unknown");
      return true;
    },
  );
});

test("seedance25: submit sends generate_audio=true when nativeAudio is true", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "task-999", status: "queued" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const provider = makeProvider({ fetchImpl: fetchImpl as typeof fetch });
  await provider.submit(baseReq);
  assert.equal(capturedBody?.generate_audio, true);
  assert.equal(capturedBody?.watermark, false);
});

test("seedance25: submit assigns explicit roles to every reference", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const provider = makeProvider({
    fetchImpl: async (_url: unknown, init?: RequestInit): Promise<Response> => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "task-references", status: "queued" }), { status: 200 });
    },
  });

  await provider.submit({
    ...baseReq,
    ratio: "adaptive",
    durationSeconds: -1,
    references: [
      { kind: "image", url: "https://signed.example/image.png" },
      { kind: "video", url: "https://signed.example/video.mp4", durationSeconds: 4 },
    ],
  });

  assert.deepEqual(capturedBody?.content, [
    { type: "text", text: baseReq.prompt },
    { type: "image_url", image_url: { url: "https://signed.example/image.png" }, role: "reference_image" },
    { type: "video_url", video_url: { url: "https://signed.example/video.mp4" }, role: "reference_video" },
  ]);
});

test("seedance25: invalid contract is rejected before any provider request", async () => {
  let calls = 0;
  const provider = makeProvider({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "must-not-submit" }), { status: 200 });
    },
  });

  await assert.rejects(
    provider.submit({
      ...baseReq,
      resolution: "1080p",
      durationSeconds: 3,
      references: [{ kind: "video", url: "https://signed.example/video.mp4", durationSeconds: 4 }],
    }),
    (error: unknown) => error instanceof Seedance25ContractViolationError
      && error.code === "SEEDANCE25_RESOLUTION_UNSUPPORTED",
  );
  assert.equal(calls, 0);
});

test("seedance25: locked video references require adaptive ratio and duration -1 before request", async () => {
  let calls = 0;
  const provider = makeProvider({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "must-not-submit" }), { status: 200 });
    },
  });

  await assert.rejects(
    provider.submit({
      ...baseReq,
      references: [{ kind: "video", url: "https://signed.example/video.mp4", durationSeconds: 4 }],
    }),
    (error: unknown) => error instanceof Seedance25ContractViolationError
      && error.code === "SEEDANCE25_LOCKED_TASK_PARAMETERS_INVALID",
  );
  assert.equal(calls, 0);
});

test("seedance25: validates all documented reference count and duration limits", async () => {
  const provider = makeProvider();
  const locked = {
    ...baseReq,
    ratio: "adaptive",
    durationSeconds: -1,
    references: [{ kind: "video" as const, url: "https://signed.example/video.mp4", durationSeconds: 31 }],
  };
  await assert.rejects(
    provider.submit(locked),
    (error: unknown) => error instanceof Seedance25ContractViolationError
      && error.code === "SEEDANCE25_REFERENCE_DURATION_INVALID",
  );
  await assert.rejects(
    provider.submit({
      ...baseReq,
      references: Array.from({ length: 31 }, (_, index) => ({ kind: "image" as const, url: `https://signed.example/${index}.png` })),
    }),
    (error: unknown) => error instanceof Seedance25ContractViolationError
      && error.code === "SEEDANCE25_REFERENCE_COUNT_EXCEEDED",
  );
});

test("seedance25: submit sends generate_audio=false when nativeAudio is false", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "task-1", status: "queued" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  };
  const provider = makeProvider({ fetchImpl: fetchImpl as typeof fetch });
  await provider.submit({ ...baseReq, nativeAudio: false });
  assert.equal(capturedBody?.generate_audio, false);
});

// ─── query ────────────────────────────────────────────────────────────────────

test("seedance25: query succeeded returns media URLs from choices", async () => {
  const payload = {
    id: "task-abc-123", status: "succeeded",
    choices: [{ message: { content: [{ type: "video_url", video_url: { url: "https://cdn.example.com/video.mp4" } }] } }],
  };
  const provider = makeProvider({ fetchImpl: okJson(payload) });
  const result = await provider.query("task-abc-123");
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.mediaUrls, ["https://cdn.example.com/video.mp4"]);
});

test("seedance25: query succeeded reads Ark top-level content video URL", async () => {
  const payload = {
    id: "task-content", status: "succeeded",
    content: [{ type: "video_url", video_url: "https://cdn.example.com/content-video.mp4" }],
  };
  const provider = makeProvider({ fetchImpl: okJson(payload) });
  const result = await provider.query("task-content");
  assert.deepEqual(result.mediaUrls, ["https://cdn.example.com/content-video.mp4"]);
});

test("seedance25: unknown provider status is treated as running (not terminal)", async () => {
  const provider = makeProvider({ fetchImpl: okJson({ id: "task-x", status: "mysterious_new_status" }) });
  const result = await provider.query("task-x");
  assert.equal(result.status, "running");
  assert.equal(result.unknownStatus, true);
});

test("seedance25: query failed status returns failed result with error code", async () => {
  const provider = makeProvider({ fetchImpl: okJson({
    id: "task-y", status: "failed", error: { code: "PROVIDER_ERR", message: "insufficient quota" },
  }) });
  const result = await provider.query("task-y");
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "PROVIDER_ERR");
});

test("seedance25: query with empty task id throws without network call", async () => {
  const provider = makeProvider();
  await assert.rejects(
    () => provider.query(""),
    (error: unknown) => {
      assert.ok(error instanceof VnextProviderRequestError);
      assert.equal(error.outcome, "query_failed");
      return true;
    },
  );
});

test("seedance25: query succeeded with no media URLs throws retryable error", async () => {
  const provider = makeProvider({ fetchImpl: okJson({ id: "task-z", status: "succeeded", choices: [] }) });
  await assert.rejects(
    () => provider.query("task-z"),
    (error: unknown) => {
      assert.ok(error instanceof VnextProviderRequestError);
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("seedance25: pending/running statuses map correctly", async () => {
  for (const rawStatus of ["queued", "pending", "running", "in_progress", "processing"]) {
    const provider = makeProvider({ fetchImpl: okJson({ id: "t", status: rawStatus }) });
    const result = await provider.query("t");
    const expected = ["queued", "pending"].includes(rawStatus) ? "pending" : "running";
    assert.equal(result.status, expected, `expected ${expected} for rawStatus "${rawStatus}"`);
    assert.equal(result.unknownStatus, false);
  }
});

test("seedance25: failed statuses map correctly", async () => {
  for (const rawStatus of ["failed", "cancelled", "expired"]) {
    const provider = makeProvider({ fetchImpl: okJson({ id: "t", status: rawStatus }) });
    const result = await provider.query("t");
    assert.equal(result.status, "failed", `expected failed for rawStatus "${rawStatus}"`);
    assert.equal(result.unknownStatus, false);
  }
});
