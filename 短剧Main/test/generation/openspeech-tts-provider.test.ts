import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderRequestError } from "../../src/modules/generation/errors.js";
import { OpenspeechTtsProvider } from "../../src/modules/generation/provider/openspeechTtsProvider.js";
import type { FetchLike } from "../../src/modules/generation/provider/arkGenerationProvider.js";
import type {
  GenerationParameters,
  ProviderGenerationRequest,
} from "../../src/modules/generation/types.js";

const ENDPOINT = "https://openspeech.bytedance.com/api/v1/tts";

describe("OpenspeechTtsProvider", () => {
  it("sends the semicolon credential with the documented body and maps inline audio", async () => {
    const provider = new OpenspeechTtsProvider({
      ...baseOptions(),
      fetchImpl: async (input, init) => {
        assert.equal(String(input), ENDPOINT);
        const headers = init?.headers as Record<string, string>;
        // 供应商事实:openspeech 的鉴权头是 `Bearer;${token}`(分号),
        // 与 Ark 图片/视频路径的 `Bearer ${key}`(空格)是两种格式。
        assert.equal(headers.Authorization, "Bearer;test-token");
        assert.equal(headers["Content-Type"], "application/json");
        const body = JSON.parse(String(init?.body)) as {
          app: Record<string, unknown>;
          user: Record<string, unknown>;
          audio: Record<string, unknown>;
          request: Record<string, unknown>;
        };
        assert.deepEqual(body.app, {
          appid: "test-appid",
          token: "placeholder",
          cluster: "volcano_tts",
        });
        assert.deepEqual(body.user, { uid: "shortdrama" });
        assert.equal(body.audio.voice_type, "zh_female_test");
        assert.equal(body.audio.encoding, "mp3");
        assert.equal("rate" in body.audio, false);
        assert.equal(typeof body.request.reqid, "string");
        assert.equal(body.request.text, "你好,世界");
        assert.equal(body.request.operation, "query");
        assert.equal(body.request.with_timestamp, 1);
        return jsonResponse({
          code: 3000,
          reqid: "vendor-reqid-1",
          data: Buffer.from("fake-mp3").toString("base64"),
          addition: {
            duration: "1960",
            frontend: JSON.stringify([{ text: "你好,世界", start_time: 0, end_time: 1960 }]),
          },
        });
      },
    });
    const result = await provider.submit(audioRequest());
    assert.equal(result.outcome, "succeeded");
    if (result.outcome === "succeeded") {
      assert.equal(result.providerTaskId, "vendor-reqid-1");
      assert.equal(result.result.status, "succeeded");
      assert.equal(result.result.actualModelId, "openspeech-tts-test");
      const media = result.result.media[0];
      assert.equal(media?.kind, "audio");
      assert.equal(media?.temporaryUrl, undefined);
      assert.equal(media?.inlineContent?.contentType, "audio/mpeg");
      assert.equal(
        Buffer.from(media?.inlineContent?.contentBase64 ?? "", "base64").toString(),
        "fake-mp3",
      );
      assert.equal(media?.providerResultKey, "vendor-reqid-1");
      assert.equal(media?.durationSeconds, 1.96);
      assert.equal(media?.actualDurationMs, 1960);
      assert.deepEqual(media?.subtitle, { cues: [{ text: "你好,世界", start: 0, end: 1.96 }] });
      // The verified response contract contains no AIGC receipt field. Do not
      // turn request intent or an invented stub property into compliance proof.
      assert.equal(media?.complianceMetadata, undefined);
      assert.equal(result.result.metadata?.reqid, "vendor-reqid-1");
      assert.equal(result.result.metadata?.durationMs, 1960);
      assert.deepEqual(result.result.usage, { duration_ms: 1960 });
      assert.equal(result.result.parameterSnapshot?.speakerId, "zh_female_test");
    }
  });

  it("honours the configured cluster, sample rate, and encoding content types", async () => {
    const seen: Array<{ cluster: unknown; rate: unknown; encoding: unknown }> = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        app: Record<string, unknown>;
        audio: Record<string, unknown>;
      };
      seen.push({ cluster: body.app.cluster, rate: body.audio.rate, encoding: body.audio.encoding });
      return jsonResponse({ code: 3000, data: Buffer.from("fake").toString("base64") });
    };
    const provider = new OpenspeechTtsProvider({
      ...baseOptions(),
      cluster: "volcano_icl",
      fetchImpl,
    });
    const wav = await provider.submit(audioRequest({
      parameters: { originalDurationSeconds: 12, speakerId: "zh_female_test", format: "wav", sampleRate: 24000 },
    }));
    assert.equal(wav.outcome, "succeeded");
    if (wav.outcome === "succeeded") {
      assert.equal(wav.result.media[0]?.inlineContent?.contentType, "audio/wav");
    }
    const pcm = await provider.submit(audioRequest({
      parameters: { originalDurationSeconds: 12, speakerId: "zh_female_test", format: "pcm" },
    }));
    assert.equal(pcm.outcome, "succeeded");
    if (pcm.outcome === "succeeded") {
      assert.equal(pcm.result.media[0]?.inlineContent?.contentType, "audio/pcm");
      // 供应商不保证回显 reqid;缺失时落回本次请求的 reqid,不伪造供应商任务号。
      assert.equal(typeof pcm.result.media[0]?.providerResultKey, "string");
      assert.equal(pcm.result.media[0]?.durationSeconds, undefined);
    }
    assert.deepEqual(seen, [
      { cluster: "volcano_icl", rate: 24000, encoding: "wav" },
      { cluster: "volcano_icl", rate: undefined, encoding: "pcm" },
    ]);
  });

  it("classifies documented vendor codes instead of trusting HTTP 200", async () => {
    const cases: Array<{ code: number; outcome: string; retryable: boolean }> = [
      { code: 3001, outcome: "rejected", retryable: false },
      { code: 3010, outcome: "rejected", retryable: false },
      { code: 3011, outcome: "rejected", retryable: false },
      { code: 3050, outcome: "rejected", retryable: false },
      { code: 3003, outcome: "unknown", retryable: true },
      { code: 3005, outcome: "unknown", retryable: true },
      { code: 3030, outcome: "unknown", retryable: true },
      { code: 3031, outcome: "unknown", retryable: true },
      { code: 3032, outcome: "unknown", retryable: true },
      { code: 3040, outcome: "unknown", retryable: true },
      // reqid 重复 = 原请求可能已被受理;按未知处理,但相同 reqid 重试注定失败。
      { code: 3006, outcome: "unknown", retryable: false },
      // 未识别的码一律未知、不重试,绝不静默当成功。
      { code: 3999, outcome: "unknown", retryable: false },
    ];
    for (const expected of cases) {
      const provider = providerWithResponse(jsonResponse({
        code: expected.code,
        message: `vendor code ${expected.code}`,
      }));
      await assert.rejects(
        () => provider.submit(audioRequest()),
        (error: unknown) => error instanceof ProviderRequestError
          && error.outcome === expected.outcome
          && error.retryable === expected.retryable
          && error.providerCode === `OPENSPEECH_${expected.code}`,
        `vendor code ${expected.code}`,
      );
    }
  });

  it("treats a code 3000 response without audio data as unknown, not success", async () => {
    const missingData = providerWithResponse(jsonResponse({ code: 3000, reqid: "r-1" }));
    await assert.rejects(
      () => missingData.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "unknown"
        && !error.retryable,
    );
    const emptyData = providerWithResponse(jsonResponse({ code: 3000, reqid: "r-1", data: "  " }));
    await assert.rejects(
      () => emptyData.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "unknown",
    );
  });

  it("treats an unparseable vendor code as unknown without a fabricated provider code", async () => {
    const provider = providerWithResponse(jsonResponse({ code: "not-a-code", data: "xx" }));
    await assert.rejects(
      () => provider.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "unknown"
        && !error.retryable
        && error.providerCode === undefined,
    );
  });

  it("classifies HTTP-level submission failures without retrying the POST", async () => {
    let calls = 0;
    const counting = (response: () => Promise<Response>): FetchLike => async () => {
      calls += 1;
      return response();
    };
    const badGateway = new OpenspeechTtsProvider({
      ...baseOptions(),
      fetchImpl: counting(async () => new Response("upstream unavailable", { status: 502 })),
    });
    await assert.rejects(
      () => badGateway.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "unknown"
        && error.retryable,
    );
    const throttled = new OpenspeechTtsProvider({
      ...baseOptions(),
      fetchImpl: counting(async () => jsonResponse({ message: "slow down" }, 429)),
    });
    await assert.rejects(
      () => throttled.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && error.retryable,
    );
    const badRequest = new OpenspeechTtsProvider({
      ...baseOptions(),
      fetchImpl: counting(async () => jsonResponse({ code: 3001, message: "invalid text" }, 400)),
    });
    await assert.rejects(
      () => badRequest.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && !error.retryable
        && error.providerCode === "OPENSPEECH_3001",
    );
    const socketFailure = new OpenspeechTtsProvider({
      ...baseOptions(),
      fetchImpl: counting(async () => {
        throw new Error("socket hang up");
      }),
    });
    await assert.rejects(
      () => socketFailure.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "unknown"
        && error.retryable,
    );
    assert.equal(calls, 4);
  });

  it("fails closed on incomplete configuration without sending any request", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({});
    };
    for (const options of [
      { ...baseOptions(), token: "" },
      { ...baseOptions(), token: "   " },
      { ...baseOptions(), appId: "" },
      { ...baseOptions(), endpoint: undefined },
    ]) {
      const provider = new OpenspeechTtsProvider({ ...options, fetchImpl });
      await assert.rejects(
        () => provider.submit(audioRequest()),
        (error: unknown) => error instanceof ProviderRequestError
          && error.outcome === "rejected"
          && error.providerCode === "PROVIDER_NOT_CONFIGURED",
      );
    }
    const provider = new OpenspeechTtsProvider({ ...baseOptions(), fetchImpl });
    await assert.rejects(
      () => provider.submit(audioRequest({ prompt: "   " })),
      (error: unknown) => error instanceof ProviderRequestError && error.outcome === "rejected",
    );
    assert.equal(calls, 0);
  });

  it("only sends the credential to approved public hosts", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ code: 3000, data: Buffer.from("fake").toString("base64") });
    };
    const unapproved = new OpenspeechTtsProvider({
      ...baseOptions(),
      endpoint: "https://tts.evil-example.com/api/v1/tts",
      fetchImpl,
    });
    await assert.rejects(
      () => unapproved.submit(audioRequest()),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && error.providerCode === "PROVIDER_ENDPOINT_NOT_ALLOWED",
    );
    assert.equal(calls, 0);

    const allowlisted = new OpenspeechTtsProvider({
      ...baseOptions(),
      endpoint: "https://tts.evil-example.com/api/v1/tts",
      allowedHosts: ["tts.evil-example.com"],
      fetchImpl,
    });
    const result = await allowlisted.submit(audioRequest());
    assert.equal(result.outcome, "succeeded");
    assert.equal(calls, 1);

    // 环回与 IP 字面量永远不在白名单内,即使配置里写了也不放行。
    for (const host of ["localhost", "127.0.0.1"]) {
      const loopback = new OpenspeechTtsProvider({
        ...baseOptions(),
        endpoint: `https://${host}/api/v1/tts`,
        allowedHosts: [host],
        fetchImpl,
      });
      await assert.rejects(
        () => loopback.submit(audioRequest()),
        (error: unknown) => error instanceof ProviderRequestError
          && error.providerCode === "PROVIDER_ENDPOINT_NOT_ALLOWED",
      );
    }
    assert.equal(calls, 1);
  });

  it("maps verified structured controls without mixing them into spoken text", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const provider = new OpenspeechTtsProvider({
      ...baseOptions(),
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { audio: Record<string, unknown>; request: Record<string, unknown> };
        seen.push({ ...body.audio, text: body.request.text });
        return jsonResponse({ code: 3000, data: Buffer.from("fake").toString("base64") });
      },
    });
    const result = await provider.submit(audioRequest({
      prompt: "我不会走的。",
      parameters: audioParameters({ speechRate: 50, loudnessRate: -50 }),
      audioPromptDimensions: {
        voiceReference: "温柔女声",
        performanceEmotion: "悲伤克制",
        paceAndPauses: "慢，句尾留白",
        languageAndAccent: "普通话",
        vocalDistance: "近讲",
        continuity: "承接上一句",
      },
    }));
    assert.deepEqual(seen, [{
      voice_type: "zh_female_test",
      encoding: "mp3",
      speed_ratio: 1.5,
      loudness_ratio: 0.5,
      emotion: "悲伤克制",
      text: "我不会走的。",
    }]);
    assert.equal(result.outcome, "succeeded");
    if (result.outcome === "succeeded") {
      assert.deepEqual(result.result.metadata?.mappedAudioDimensions, ["performanceEmotion->emotion"]);
      assert.deepEqual(result.result.metadata?.unmappedAudioDimensions, [
        "voiceReference",
        "paceAndPauses",
        "languageAndAccent",
        "vocalDistance",
        "continuity",
      ]);
    }
  });

  it("does not treat unverified response fields as AIGC compliance evidence", async () => {
    const provider = providerWithResponse(jsonResponse({
      code: 3000,
      // Regression lock: neither a generic top-level flag nor a made-up
      // addition shape is in the verified OpenSpeech response contract.
      enabled: true,
      data: Buffer.from("fake").toString("base64"),
      addition: {
        duration: 1960,
        frontend: [{ text: "你好", start_time: 0, end_time: 1960 }],
        aigc_metadata: { enabled: true },
      },
    }));
    const result = await provider.submit(audioRequest());
    assert.equal(result.outcome, "succeeded");
    if (result.outcome === "succeeded") {
      assert.equal(result.result.media[0]?.subtitle === undefined, false);
      assert.equal(result.result.media[0]?.complianceMetadata, undefined);
    }
  });

  it("rejects unverified inputs before any paid request", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({});
    };
    const provider = new OpenspeechTtsProvider({ ...baseOptions(), fetchImpl });
    const unsupported: ProviderGenerationRequest[] = [
      // 复刻(参考音频克隆)不在一期范围;宁可拒绝也不静默丢弃参考输入。
      audioRequest({
        parameters: { originalDurationSeconds: 12 },
        references: [{ kind: "audio", url: "https://media.example.com/ref.mp3" }],
      }),
      // 音高供应商明确没有已验证字段，不能悄悄忽略。
      audioRequest({ parameters: audioParameters({ pitchRate: 2 }) }),
      // 采样率只放行文档列出的 8000/16000/24000;合同层允许 44100,Provider 层不放行。
      audioRequest({ parameters: audioParameters({ sampleRate: 44100 }) }),
    ];
    for (const request of unsupported) {
      await assert.rejects(
        () => provider.submit(request),
        (error: unknown) => error instanceof ProviderRequestError
          && error.outcome === "rejected"
          && error.providerCode === "UNSUPPORTED_PROVIDER_INPUT",
      );
    }
    assert.equal(calls, 0);
  });

  it("enforces the 1024 UTF-8 byte text limit, not a character count", async () => {
    let calls = 0;
    const provider = new OpenspeechTtsProvider({
      ...baseOptions(),
      fetchImpl: async (_input, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body)) as { request: Record<string, unknown> };
        assert.equal(body.request.text, "a".repeat(1024));
        return jsonResponse({ code: 3000, data: Buffer.from("fake").toString("base64") });
      },
    });
    const atLimit = await provider.submit(audioRequest({ prompt: "a".repeat(1024) }));
    assert.equal(atLimit.outcome, "succeeded");
    assert.equal(calls, 1);
    // 400 个中文字符只有 400 个字符,但 1200 个 UTF-8 字节:按字节拒绝。
    await assert.rejects(
      () => provider.submit(audioRequest({ prompt: "你".repeat(400) })),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && error.providerCode === "INVALID_PROVIDER_INPUT",
    );
    assert.equal(calls, 1);
  });

  it("refuses non-audio requests and has no query endpoint", async () => {
    let calls = 0;
    const provider = new OpenspeechTtsProvider({
      ...baseOptions(),
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    await assert.rejects(
      () => provider.submit(audioRequest({ mediaKind: "image" })),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "rejected"
        && error.providerCode === "PROVIDER_NOT_CONFIGURED",
    );
    // 同步接口:成功响应在 submit 里已经返回,没有可供轮询的供应商任务。
    await assert.rejects(
      () => provider.query("reqid-1"),
      (error: unknown) => error instanceof ProviderRequestError
        && error.outcome === "query_failed"
        && error.providerCode === "PROVIDER_NOT_CONFIGURED",
    );
    assert.equal(calls, 0);
  });
});

function baseOptions() {
  return {
    token: "test-token",
    appId: "test-appid",
    endpoint: ENDPOINT,
  };
}

function audioParameters(overrides: GenerationParameters = {}): GenerationParameters {
  return { originalDurationSeconds: 12, speakerId: "zh_female_test", ...overrides };
}

function audioRequest(overrides: Partial<ProviderGenerationRequest> = {}): ProviderGenerationRequest {
  return {
    mediaKind: "audio",
    model: "openspeech-tts-test",
    prompt: "你好,世界",
    parameters: audioParameters(),
    references: [],
    quantity: 1,
    ...overrides,
  };
}

function providerWithResponse(response: Response): OpenspeechTtsProvider {
  return new OpenspeechTtsProvider({
    ...baseOptions(),
    fetchImpl: async () => response,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
