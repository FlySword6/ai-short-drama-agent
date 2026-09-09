import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderRequestError } from "../../src/modules/generation/errors.js";
import type { FetchLike } from "../../src/modules/generation/provider/arkGenerationProvider.js";
import { SeedAudioProvider } from "../../src/modules/generation/provider/seedAudioProvider.js";
import type { ProviderGenerationRequest } from "../../src/modules/generation/types.js";

const ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/create";

describe("SeedAudioProvider", () => {
  it("maps the v3 request, single-header credential and billed original duration", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const provider = new SeedAudioProvider({
      apiKey: "test-seed-audio-key",
      endpoint: ENDPOINT,
      fetchImpl: async (input, init) => {
        assert.equal(String(input), ENDPOINT);
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers["X-Api-Key"], "test-seed-audio-key");
        assert.match(headers["X-Api-Request-Id"], /^[0-9a-f-]{36}$/);
        assert.equal(headers.Authorization, undefined);
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          code: 0,
          audio: Buffer.from("seed-audio-bytes").toString("base64"),
          duration: 2.4,
          original_duration: 3.1,
          subtitle: {
            text: "你好",
            sentences: [{
              start_time: 0,
              end_time: 2400,
              text: "你好",
              words: [
                { start_time: 0, end_time: 1000, text: "你" },
                { start_time: 1000, end_time: 2400, text: "好" },
              ],
            }],
          },
        }, 200, { "X-Tt-Logid": "seed-log-1" });
      },
    });

    const result = await provider.submit(audioRequest());
    assert.equal(result.outcome, "succeeded");
    assert.deepEqual(seenBody, {
      model: "seed-audio-1.0",
      text_prompt: "你好",
      references: [],
      audio_config: {
        format: "mp3",
        sample_rate: 48000,
        speech_rate: 25,
        loudness_rate: -10,
        pitch_rate: 2,
        enable_subtitle: true,
      },
      watermark: {
        aigc_watermark: false,
        aigc_metadata: { enable: false },
      },
    });
    if (result.outcome === "succeeded") {
      assert.equal(result.result.providerTaskId, "seed-log-1");
      assert.deepEqual(result.result.usage, { original_duration_ms: 3100 });
      assert.equal(result.result.media[0]?.actualDurationMs, 2400);
      assert.equal(result.result.media[0]?.durationSeconds, 2.4);
      assert.deepEqual(result.result.media[0]?.audioDurationPolicy, {
        source: "provider_reported",
        maxDurationMs: 120_000,
      });
      assert.equal(
        Buffer.from(
          result.result.media[0]?.inlineContent?.contentBase64 ?? "",
          "base64",
        ).toString(),
        "seed-audio-bytes",
      );
      assert.deepEqual(result.result.media[0]?.subtitle, {
        cues: [
          { text: "你", start: 0, end: 1 },
          { text: "好", start: 1, end: 2.4 },
        ],
      });
      assert.equal(result.result.metadata?.logId, "seed-log-1");
      assert.equal(result.result.metadata?.providerAigcMetadataRequested, false);
    }
  });

  it("uses audio references and accepts a temporary URL response", async () => {
    let references: unknown;
    const provider = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      fetchImpl: async (_input, init) => {
        references = (JSON.parse(String(init?.body)) as { references: unknown }).references;
        return jsonResponse({
          url: "https://provider.example.test/audio.mp3",
          duration: 5,
          original_duration: 5.25,
        });
      },
    });
    const result = await provider.submit(audioRequest({
      parameters: {
        originalDurationSeconds: 10,
        format: "mp3",
        enableSubtitle: true,
        aigcMetadataEnabled: true,
        aigcWatermarkEnabled: false,
      },
      references: [
        { kind: "audio", role: "reference_audio", url: "https://tos.example.test/ref-1.mp3" },
        { kind: "audio", role: "reference_audio", url: "https://tos.example.test/ref-2.wav" },
      ],
    }));
    assert.deepEqual(references, [
      { audio_url: "https://tos.example.test/ref-1.mp3" },
      { audio_url: "https://tos.example.test/ref-2.wav" },
    ]);
    assert.equal(result.outcome, "succeeded");
    if (result.outcome === "succeeded") {
      assert.equal(result.result.media[0]?.temporaryUrl, "https://provider.example.test/audio.mp3");
      assert.equal(result.result.media[0]?.inlineContent, undefined);
      assert.deepEqual(result.result.usage, { original_duration_ms: 5250 });
    }
  });

  it("supports pure text and a single image reference without inventing a speaker", async () => {
    const seenReferences: unknown[] = [];
    const provider = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      fetchImpl: async (_input, init) => {
        seenReferences.push((JSON.parse(String(init?.body)) as { references: unknown }).references);
        return jsonResponse({
          audio: Buffer.from("bytes").toString("base64"),
          duration: 1,
          original_duration: 1,
        });
      },
    });
    await provider.submit(audioRequest({
      parameters: {
        originalDurationSeconds: 10,
        format: "mp3",
        enableSubtitle: true,
        aigcMetadataEnabled: true,
        aigcWatermarkEnabled: false,
      },
    }));
    await provider.submit(audioRequest({
      parameters: {
        originalDurationSeconds: 10,
        format: "mp3",
        enableSubtitle: true,
        aigcMetadataEnabled: true,
        aigcWatermarkEnabled: false,
      },
      references: [
        { kind: "image", role: "reference_image", url: "https://tos.example.test/ref.png" },
      ],
    }));
    assert.deepEqual(seenReferences, [[], [{ image_url: "https://tos.example.test/ref.png" }]]);
  });

  it("keeps provider watermark metadata disabled until it has real output evidence", async () => {
    let watermark: unknown;
    const provider = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      fetchImpl: async (_input, init) => {
        watermark = (JSON.parse(String(init?.body)) as { watermark: unknown }).watermark;
        return jsonResponse({
          audio: Buffer.from("bytes").toString("base64"),
          duration: 1,
          original_duration: 1,
        });
      },
    });
    const result = await provider.submit(audioRequest());
    assert.equal(result.outcome, "succeeded");
    const metadata = (watermark as {
      aigc_metadata: Record<string, unknown>;
    }).aigc_metadata;
    assert.equal(metadata.enable, false);
    if (result.outcome === "succeeded") {
      assert.equal(result.result.media[0]?.complianceMetadata, undefined);
      assert.equal(result.result.metadata?.providerAigcMetadataRequested, false);
    }
  });

  it("fails closed when a successful response omits original_duration", async () => {
    const provider = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      fetchImpl: async () => jsonResponse({
        code: 0,
        audio: Buffer.from("bytes").toString("base64"),
        duration: 2,
      }),
    });
    await assert.rejects(
      () => provider.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "unknown"
        && error.retryable === false
        && error.message.includes("缺少计费原始时长"),
    );
  });

  it("classifies provider, HTTP and network failures without retrying inside the adapter", async () => {
    const cases: Array<{
      response: Response;
      outcome: "rejected" | "unknown";
      retryable: boolean;
      providerCode?: string;
    }> = [
      {
        response: jsonResponse({ code: 45001125, message: "blocked" }, 400),
        outcome: "rejected",
        retryable: false,
        providerCode: "SEEDAUDIO_45001125",
      },
      {
        response: jsonResponse({ code: 55001309, message: "internal" }, 500),
        outcome: "unknown",
        retryable: true,
        providerCode: "SEEDAUDIO_55001309",
      },
      {
        response: jsonResponse({ message: "busy" }, 429),
        outcome: "rejected",
        retryable: true,
      },
    ];
    for (const expected of cases) {
      let calls = 0;
      const provider = new SeedAudioProvider({
        apiKey: "test-key",
        endpoint: ENDPOINT,
        fetchImpl: async () => {
          calls += 1;
          return expected.response;
        },
      });
      await assert.rejects(
        () => provider.submit(audioRequest()),
        (error: unknown) => error instanceof ProviderRequestError
          && error.outcome === expected.outcome
          && error.retryable === expected.retryable
          && error.providerCode === expected.providerCode,
      );
      assert.equal(calls, 1);
    }

    const network = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    await assert.rejects(
      () => network.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "unknown"
        && error.retryable,
    );

    for (const status of [401, 403]) {
      for (const response of [
        new Response("permission denied", { status }),
        jsonResponse({ code: 55001309, message: "misleading server error" }, status),
      ]) {
        const provider = new SeedAudioProvider({
          apiKey: "test-key",
          endpoint: ENDPOINT,
          fetchImpl: async () => response.clone(),
        });
        await assert.rejects(
          () => provider.submit(audioRequest()),
          (error: unknown) => error instanceof ProviderRequestError
            && error.outcome === "rejected"
            && error.retryable === false
            && error.httpStatus === status,
        );
      }
    }
  });

  it("fails before fetch for unsafe configuration and overlong text", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({});
    };
    for (const options of [
      { apiKey: "", endpoint: ENDPOINT },
      { apiKey: "test-key", endpoint: undefined },
      { apiKey: "test-key", endpoint: "http://openspeech.bytedance.com/api/v3/tts/create" },
      { apiKey: "test-key", endpoint: "https://127.0.0.1/api/v3/tts/create" },
      { apiKey: "test-key", endpoint: "https://openspeech.bytedance.com/api/v1/tts" },
      { apiKey: "test-key", endpoint: `${ENDPOINT}?unsafe=true` },
    ]) {
      const provider = new SeedAudioProvider({ ...options, fetchImpl });
      await assert.rejects(
        () => provider.submit(audioRequest()),
        (error: unknown) => error instanceof ProviderRequestError
          && error.outcome === "rejected",
      );
    }
    const overlong = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      fetchImpl,
    });
    await assert.rejects(
      () => overlong.submit(audioRequest({ prompt: "字".repeat(3001) })),
      (error: unknown) => error instanceof ProviderRequestError
        && error.providerCode === "INVALID_PROVIDER_INPUT",
    );
    assert.equal(calls, 0);
  });

  it("maps trimmed speakerId to the single Seed Audio v3 speaker reference", async () => {
    let references: unknown;
    const provider = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      fetchImpl: async (_input, init) => {
        references = (JSON.parse(String(init?.body)) as { references: unknown }).references;
        return jsonResponse({
          audio: Buffer.from("bytes").toString("base64"),
          duration: 1,
          original_duration: 1,
        });
      },
    });
    await provider.submit(audioRequest({
      parameters: { ...audioRequest().parameters, speakerId: "  voice-public-1  " },
    }));
    assert.deepEqual(references, [{ speaker: "voice-public-1" }]);
  });

  it("rejects speaker mixed with audio or image references before fetch", async () => {
    let calls = 0;
    const provider = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    for (const reference of [
      { kind: "audio" as const, role: "reference_audio" as const, url: "https://tos.example.test/ref.mp3" },
      { kind: "image" as const, role: "reference_image" as const, url: "https://tos.example.test/ref.png" },
    ]) {
      await assert.rejects(
        () => provider.submit(audioRequest({
          parameters: { ...audioRequest().parameters, speakerId: "voice-public-1" },
          references: [reference],
        })),
        (error: unknown) => error instanceof ProviderRequestError
          && error.providerCode === "INVALID_PROVIDER_INPUT",
      );
    }
    assert.equal(calls, 0);
  });

  it("marks a timed-out submission as unknown without retrying inside the adapter", async () => {
    let calls = 0;
    const provider = new SeedAudioProvider({
      apiKey: "test-key",
      endpoint: ENDPOINT,
      timeoutMs: 5,
      fetchImpl: async (_input, init) => {
        calls += 1;
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    });

    await assert.rejects(
      () => provider.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "unknown"
        && error.retryable,
    );
    assert.equal(calls, 1);
  });
});

function audioRequest(
  overrides: Partial<ProviderGenerationRequest> = {},
): ProviderGenerationRequest {
  return {
    mediaKind: "audio",
    model: "seed-audio-1.0",
    prompt: "你好",
    quantity: 1,
    parameters: {
      originalDurationSeconds: 10,
      format: "mp3",
      sampleRate: 48000,
      speechRate: 25,
      loudnessRate: -10,
      pitchRate: 2,
      enableSubtitle: true,
      aigcMetadataEnabled: true,
      aigcWatermarkEnabled: false,
    },
    references: [],
    ...overrides,
  };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
