import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderRequestError } from "../../src/modules/generation/errors.js";
import { ArkGenerationProvider } from "../../src/modules/generation/provider/arkGenerationProvider.js";
import { normalizeArkVideoStatus } from "../../src/modules/generation/status.js";
import {
  ARK_SEEDANCE_2_FAST_MODEL,
  ARK_SEEDREAM_5_PRO_MODEL,
} from "../../src/modules/generation/v01Contract.js";

describe("ArkGenerationProvider", () => {
  it("submits the frozen V0.1 Seedream request and captures image usage", async () => {
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async (input, init) => {
        assert.match(String(input), /\/images\/generations$/);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, ARK_SEEDREAM_5_PRO_MODEL);
        assert.equal(body.image, "https://media.example.com/reference.png");
        assert.equal(body.size, "2048x1152");
        assert.equal(body.watermark, false);
        // Seedream 5.0 Pro rejects the sequential_image_generation parameter
        // (2026-07-21 live smoke); "disabled" is expressed by omitting it.
        assert.equal("sequential_image_generation" in body, false);
        assert.equal(body.response_format, "url");
        assert.equal(body.stream, false);
        assert.equal("seed" in body, false);
        assert.equal("ratio" in body, false);
        assert.equal("resolution" in body, false);
        assert.equal("sequential_image_generation_options" in body, false);
        return jsonResponse({
          data: [{ imagecontent: [{ url: "https://media.example.com/result.png" }] }],
          usage: { generated_images: 1, output_tokens: 4096, total_tokens: 4096 },
        });
      },
    });
    const result = await provider.submit({
      mediaKind: "image",
      model: ARK_SEEDREAM_5_PRO_MODEL,
      prompt: "test prompt",
      parameters: {
        size: "2K",
        ratio: "16:9",
        resolution: "2K",
        watermark: false,
        sequentialImageGeneration: "disabled",
      },
      references: [{ kind: "image", url: "https://media.example.com/reference.png" }],
      quantity: 1,
    });
    assert.equal(result.outcome, "succeeded");
    if (result.outcome === "succeeded") {
      assert.equal(result.result.media[0]?.temporaryUrl, "https://media.example.com/result.png");
      assert.equal(result.result.metadata?.generatedImages, 1);
      assert.equal(result.result.metadata?.outputTokens, 4096);
      assert.equal(result.result.metadata?.totalTokens, 4096);
      assert.deepEqual(result.result.usage, {
        generated_images: 1,
        output_tokens: 4096,
        total_tokens: 4096,
      });
    }
  });

  it("rejects unsupported Seedream parameters before making a paid request", async () => {
    let calls = 0;
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    await assert.rejects(
      () => provider.submit({ ...imageRequest(), parameters: { ratio: "2:1" } }),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "rejected",
    );
    await assert.rejects(
      () => provider.submit({ ...imageRequest(), quantity: 2 }),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "rejected",
    );
    assert.equal(calls, 0);
  });

  it("treats an HTTP 200 data item error as a known provider rejection", async () => {
    const provider = providerWithResponse(jsonResponse({
      data: [{ error: { code: "OutputBlocked", message: "output blocked" } }],
      usage: { generated_images: 0 },
    }));
    await assert.rejects(
      () => provider.submit(imageRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && error.providerCode === "OutputBlocked",
    );
  });

  it("submits fixed Seedance Fast parameters and gives every reference an explicit role", async () => {
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async (input, init) => {
        assert.match(String(input), /\/contents\/generations\/tasks$/);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, "doubao-seedance-2-0-fast-260128");
        assert.equal(body.resolution, "720p");
        assert.equal(body.ratio, "9:16");
        assert.equal(body.duration, 4);
        assert.equal(body.watermark, false);
        assert.equal("seed" in body, false);
        const content = body.content as Array<Record<string, unknown>>;
        assert.deepEqual(content.slice(1).map((item) => item.role), [
          "reference_image",
          "reference_image",
          "reference_video",
          "reference_video",
          "reference_audio",
        ]);
        return jsonResponse({ id: "task-fixed", status: "queued" });
      },
    });
    const result = await provider.submit({
      ...videoRequest(),
      references: [
        { kind: "image", url: "https://media.example.com/one.png" },
        { kind: "image", url: "https://media.example.com/two.png", role: "reference_image" },
        { kind: "video", url: "https://media.example.com/action.mp4", role: "reference_video" },
        { kind: "video", url: "https://media.example.com/camera.mp4" },
        { kind: "audio", url: "https://media.example.com/bgm.mp3" },
      ],
    });
    assert.equal(result.outcome, "accepted");
  });

  it("rejects mixed anchor frames and multimodal references before making a paid request", async () => {
    let calls = 0;
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    await assert.rejects(
      () => provider.submit({
        ...videoRequest(),
        references: [
          { kind: "image", url: "https://media.example.com/first.png", role: "first_frame" },
          { kind: "image", url: "https://media.example.com/ref.png", role: "reference_image" },
        ],
      }),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "rejected",
    );
    assert.equal(calls, 0);
  });

  it("rejects unsupported Seedance parameters before making a paid request", async () => {
    let calls = 0;
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    for (const parameters of [
      { ...videoRequest().parameters, seed: 1 },
      { ...videoRequest().parameters, resolution: "1080p" },
      { ...videoRequest().parameters, ratio: "2:1" },
      { ...videoRequest().parameters, durationSeconds: 16 },
    ]) {
      await assert.rejects(
        () => provider.submit({ ...videoRequest(), parameters }),
        (error: unknown) => error instanceof ProviderRequestError && error.outcome === "rejected",
      );
    }
    assert.equal(calls, 0);
  });

  it("classifies a non-JSON 5xx submission response as unknown", async () => {
    let calls = 0;
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return new Response("upstream unavailable", { status: 502 });
      },
    });
    await assert.rejects(
      () => provider.submit(imageRequest()),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "unknown",
    );
    assert.equal(calls, 1);
  });

  it("classifies HTTP 429 as a known rejection without automatic POST retry", async () => {
    let calls = 0;
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(
          { error: { code: "QuotaExceeded", message: "queue is full" } },
          429,
        );
      },
    });
    await assert.rejects(
      () => provider.submit(imageRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && error.retryable,
    );
    assert.equal(calls, 1);
  });

  it("treats a successful image response without media as unknown", async () => {
    const provider = providerWithResponse(jsonResponse({ data: [] }));
    await assert.rejects(
      () => provider.submit(imageRequest()),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "unknown",
    );
  });

  it("normalizes a succeeded video task and extracts object content", async () => {
    const provider = providerWithResponse(jsonResponse({
      id: "task-1",
      status: "succeeded",
      content: { video_url: "https://media.example.com/result.mp4" },
      duration: "4",
      usage: { completion_tokens: 86400, total_tokens: 86400 },
    }));
    const result = await provider.query("task-1");
    assert.equal(result.status, "succeeded");
    assert.equal(result.media[0]?.kind, "video");
    assert.equal(result.metadata?.durationSeconds, 4);
    assert.equal(result.metadata?.completionTokens, 86400);
    assert.equal(result.metadata?.totalTokens, 86400);
    assert.deepEqual(result.usage, {
      completion_tokens: 86400,
      total_tokens: 86400,
      duration_seconds: 4,
    });
  });

  it("keeps an unknown provider status non-terminal", async () => {
    const provider = providerWithResponse(jsonResponse({ id: "task-1", status: "warming_up" }));
    const result = await provider.query("task-1");
    assert.equal(result.status, "running");
    assert.equal(result.unknownStatus, true);
    assert.deepEqual(normalizeArkVideoStatus("warming_up"), {
      status: "running",
      rawStatus: "warming_up",
      unknownStatus: true,
    });
  });

  it("does not accept a succeeded video task without media", async () => {
    const provider = providerWithResponse(jsonResponse({ id: "task-1", status: "succeeded", content: {} }));
    await assert.rejects(
      () => provider.query("task-1"),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "query_failed",
    );
  });

  it("returns an HTTP 200 failed video task as a terminal provider failure", async () => {
    const provider = providerWithResponse(jsonResponse({
      id: "task-failed",
      status: "failed",
      error: { code: "ContentPolicyViolation", message: "content rejected" },
      usage: { completion_tokens: 0, total_tokens: 0 },
    }));
    const result = await provider.query("task-failed");
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "ContentPolicyViolation");
    assert.equal(result.errorMessage, "content rejected");
    assert.equal(result.metadata?.completionTokens, 0);
  });

  it("keeps the Ark image/video credential format as `Bearer <key>` with a space", async () => {
    const authorizations: string[] = [];
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async (input, init) => {
        authorizations.push((init?.headers as Record<string, string>).Authorization);
        if (String(input).endsWith("/images/generations")) {
          return jsonResponse({ data: [{ url: "https://media.example.com/result.png" }] });
        }
        return jsonResponse({ id: "task-1", status: "queued" });
      },
    });
    await provider.submit(imageRequest());
    await provider.submit(videoRequest());
    assert.deepEqual(authorizations, ["Bearer test-key", "Bearer test-key"]);
  });

  it("fails closed on audio submit/query without sending any request", async () => {
    let calls = 0;
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    await assert.rejects(
      () => provider.submit({
        mediaKind: "audio",
        model: "configured-seed-audio-id",
        prompt: "你好",
        parameters: { originalDurationSeconds: 12, speakerId: "zh_female_test" },
        references: [],
        quantity: 1,
      }),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && error.providerCode === "PROVIDER_NOT_CONFIGURED",
    );
    await assert.rejects(
      () => provider.query("task-1", { mediaKind: "audio", model: "configured-seed-audio-id" }),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "query_failed"
        && error.providerCode === "PROVIDER_NOT_CONFIGURED",
    );
    assert.equal(calls, 0);
  });
});

function providerWithResponse(response: Response): ArkGenerationProvider {
  return new ArkGenerationProvider({
    apiKey: "test-key",
    fetchImpl: async () => response,
  });
}

function imageRequest() {
  return {
    mediaKind: "image" as const,
    model: ARK_SEEDREAM_5_PRO_MODEL,
    prompt: "test prompt",
    parameters: {
      size: "2K",
      watermark: false,
      sequentialImageGeneration: "disabled" as const,
    },
    references: [],
    quantity: 1,
  };
}

function videoRequest() {
  return {
    mediaKind: "video" as const,
    model: ARK_SEEDANCE_2_FAST_MODEL,
    prompt: "test video",
    parameters: {
      resolution: "720p",
      ratio: "9:16",
      durationSeconds: 4,
      watermark: false,
    },
    references: [],
    quantity: 1,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
