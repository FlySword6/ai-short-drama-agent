import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRequestError } from "../../src/modules/generation/errors.js";
import { isApprovedMinimaxBaseUrl, MinimaxGenerationProvider } from "../../src/modules/generation/provider/minimaxGenerationProvider.js";
import { assertAudioProviderMediaIntegrity } from "../../src/modules/generation/service.js";

const provider = (fetchImpl: ConstructorParameters<typeof MinimaxGenerationProvider>[0]["fetchImpl"]) => new MinimaxGenerationProvider({ apiKey: "test-key", fetchImpl });
const TEST_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

test("图片请求使用内联 base64 结果、AIGC 水印，并将 reference_image 映射到 character subject reference", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const imageBase64 = TEST_JPEG_BYTES.toString("base64");
  const result = await provider(async (input, init) => {
    url = String(input); body = JSON.parse(String(init?.body));
    return json({ data: {
      image_base64: [imageBase64],
      usage: {
        total_tokens: 12,
        provider_note: "must-not-persist",
        debug_enabled: true,
        negative_count: -1,
      },
    } });
  }).submit({ mediaKind: "image", model: "image-01", prompt: "雨夜角色设定", quantity: 1,
    parameters: { resolution: "1K", ratio: "9:16" }, references: [{ kind: "image", url: "https://assets.example.test/face.png", role: "reference_image" }] });
  assert.equal(url, "https://api.minimaxi.com/v1/image_generation");
  assert.deepEqual(body, { model: "image-01", prompt: "雨夜角色设定", response_format: "base64", n: 1, aigc_watermark: true, aspect_ratio: "9:16", subject_reference: [{ type: "character", image_file: "https://assets.example.test/face.png" }] });
  assert.equal(result.outcome, "succeeded");
  if (result.outcome === "succeeded") {
    assert.deepEqual(result.result.media[0]?.inlineContent, {
      contentBase64: imageBase64,
      contentType: "image/jpeg",
    });
    assert.equal(result.result.media[0]?.temporaryUrl, undefined);
    assert.deepEqual(result.result.usage, { total_tokens: 12 });
  }
});

test("图片内联结果必须是 canonical base64 且 magic 与 MIME 可核验", async () => {
  for (const imageBase64 of [
    "@@@=",
    Buffer.from("not-an-image").toString("base64"),
  ]) {
    await assert.rejects(
      () => provider(async () => json({
        data: { image_base64: [imageBase64] },
      })).submit(imageRequest()),
      providerError("无法安全解析|格式无法核验", "unknown"),
    );
  }
});

test("图片结果仍兼容供应商返回的临时 URL", async () => {
  const result = await provider(async () => json({
    data: { image_urls: ["https://cdn.example.test/image.png"] },
  })).submit(imageRequest());
  assert.equal(result.outcome, "succeeded");
  if (result.outcome === "succeeded") {
    assert.equal(result.result.media[0]?.temporaryUrl, "https://cdn.example.test/image.png");
    assert.equal(result.result.media[0]?.inlineContent, undefined);
  }
});

test("视频请求保留各类归一 role，并以异步 task_id 接收", async () => {
  let body: Record<string, unknown> = {};
  const result = await provider(async (_input, init) => {
    body = JSON.parse(String(init?.body)); return json({ task_id: "video-task-7", status: "queued" });
  }).submit({ mediaKind: "video", model: "MiniMax-H3", prompt: "角色向镜头走来", quantity: 1,
    parameters: { resolution: "768P", ratio: "9:16", durationSeconds: 4 }, references: [
      { kind: "image", url: "https://assets.example.test/ref.png", role: "reference_image" },
      { kind: "video", url: "https://assets.example.test/ref.mp4", role: "reference_video" },
      { kind: "audio", url: "https://assets.example.test/ref.mp3", role: "reference_audio" },
    ] });
  assert.equal(result.outcome, "accepted");
  assert.deepEqual(body, { model: "MiniMax-H3", content: [
    { type: "text", text: "角色向镜头走来" },
    { type: "image_url", image_url: { url: "https://assets.example.test/ref.png" }, role: "reference_image" },
    { type: "video_url", video_url: { url: "https://assets.example.test/ref.mp4" }, role: "reference_video" },
    { type: "audio_url", audio_url: { url: "https://assets.example.test/ref.mp3" }, role: "reference_audio" },
  ], resolution: "768P", duration: 4, ratio: "9:16", aigc_watermark: true });
});

test("音频请求默认系统音色、同步 hex 内联结果且拒绝参考素材", async () => {
  let body: Record<string, unknown> = {};
  const audioBytes = Buffer.from("ID3test-only-audio");
  const result = await provider(async (_input, init) => {
    body = JSON.parse(String(init?.body)); return json({
      data: { audio: audioBytes.toString("hex") },
      extra_info: { audio_length: 1_850, usage_characters: 24 },
    });
  }).submit({ mediaKind: "audio", model: "speech-2.8-turbo", prompt: "你好，欢迎来到短剧工坊。", quantity: 1,
    parameters: { originalDurationSeconds: 5 }, references: [] });
  assert.equal(result.outcome, "succeeded");
  assert.deepEqual(body, {
    model: "speech-2.8-turbo",
    text: "你好，欢迎来到短剧工坊。",
    stream: false,
    output_format: "hex",
    subtitle_enable: true,
    subtitle_type: "sentence",
    voice_setting: { voice_id: "male-qn-qingse" },
    audio_setting: { format: "mp3", sample_rate: 32000, channel: 1 },
    aigc_watermark: true,
  });
  if (result.outcome === "succeeded") {
    assert.deepEqual(result.result.media[0]?.inlineContent, {
      contentBase64: audioBytes.toString("base64"),
      contentType: "audio/mpeg",
    });
    assert.equal(result.result.media[0]?.temporaryUrl, undefined);
    assert.equal(result.result.media[0]?.actualDurationMs, 1_850);
    assert.deepEqual(result.result.media[0]?.audioDurationPolicy, {
      source: "provider_reported",
      maxDurationMs: 120_000,
    });
    assert.deepEqual(result.result.usage, {
      usage_characters: 24,
      audio_length_ms: 1_850,
    });
    assert.deepEqual(assertAudioProviderMediaIntegrity({
      mediaKind: "audio",
      model: "speech-2.8-turbo",
      parameters: { originalDurationSeconds: 5 },
    }, result.result.media[0]!), {
      actualDurationMs: 1_850,
      durationDeltaMs: -3_150,
    });
  }
  await assert.rejects(() => provider(async () => json({})).submit({ mediaKind: "audio", model: "speech-2.8-hd", prompt: "测试", quantity: 1,
    parameters: { originalDurationSeconds: 1 }, references: [{ kind: "image", url: "https://assets.example.test/a.png" }] }), providerError("参考素材", "rejected"));
});

test("音频结果仍兼容供应商返回的临时 URL", async () => {
  const result = await provider(async () => json({
    data: { audio_url: "https://cdn.example.test/speech.mp3" },
    extra_info: { audio_length: 1_000, usage_characters: 2 },
  })).submit({
    mediaKind: "audio",
    model: "speech-2.8-turbo",
    prompt: "测试",
    quantity: 1,
    parameters: { originalDurationSeconds: 1 },
    references: [],
  });
  assert.equal(result.outcome, "succeeded");
  if (result.outcome === "succeeded") {
    assert.equal(result.result.media[0]?.temporaryUrl, "https://cdn.example.test/speech.mp3");
    assert.equal(result.result.media[0]?.inlineContent, undefined);
  }
});

test("WAV 内联结果按请求与供应商回报登记正确 MIME", async () => {
  const wav = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.alloc(4),
    Buffer.from("WAVE"),
    Buffer.from([1, 2, 3]),
  ]);
  const result = await provider(async () => json({
    data: { audio: wav.toString("hex") },
    extra_info: { audio_length: 1_000, audio_format: "wav" },
  })).submit({
    mediaKind: "audio",
    model: "speech-2.8-turbo",
    prompt: "测试",
    quantity: 1,
    parameters: { originalDurationSeconds: 1, format: "wav" },
    references: [],
  });
  assert.equal(result.outcome, "succeeded");
  if (result.outcome === "succeeded") {
    assert.equal(result.result.media[0]?.inlineContent?.contentType, "audio/wav");
    assert.deepEqual(
      Buffer.from(result.result.media[0]!.inlineContent!.contentBase64, "base64"),
      wav,
    );
  }
});

test("PCM 在联网前拒绝，供应商回报格式与请求不一致时保持未知态", async () => {
  let calls = 0;
  await assert.rejects(
    () => provider(async () => {
      calls += 1;
      return json({});
    }).submit({
      mediaKind: "audio",
      model: "speech-2.8-turbo",
      prompt: "测试",
      quantity: 1,
      parameters: { originalDurationSeconds: 1, format: "pcm" },
      references: [],
    }),
    providerError("不支持 PCM", "rejected"),
  );
  assert.equal(calls, 0);

  await assert.rejects(
    () => provider(async () => json({
      data: { audio: Buffer.from("ID3audio").toString("hex") },
      extra_info: { audio_length: 1_000, audio_format: "wav" },
    })).submit({
      mediaKind: "audio",
      model: "speech-2.8-turbo",
      prompt: "测试",
      quantity: 1,
      parameters: { originalDurationSeconds: 1, format: "mp3" },
      references: [],
    }),
    providerError("格式与请求不一致", "unknown"),
  );
});

test("MP3 内联结果必须带 ID3 或合法 frame sync magic", async () => {
  await assert.rejects(
    () => provider(async () => json({
      data: { audio: Buffer.from("not-an-mp3").toString("hex") },
      extra_info: { audio_length: 1_000, audio_format: "mp3" },
    })).submit({
      mediaKind: "audio",
      model: "speech-2.8-turbo",
      prompt: "测试",
      quantity: 1,
      parameters: { originalDurationSeconds: 1, format: "mp3" },
      references: [],
    }),
    providerError("MP3 内容无法核验", "unknown"),
  );
});

test("MiniMax 不支持的采样率在联网前被本地拒绝", async () => {
  let called = false;
  await assert.rejects(
    () => provider(async () => {
      called = true;
      return json({});
    }).submit({
      mediaKind: "audio",
      model: "speech-2.8-turbo",
      prompt: "测试",
      quantity: 1,
      parameters: { originalDurationSeconds: 1, sampleRate: 48_000 },
      references: [],
    }),
    providerError("不支持所选采样率", "rejected"),
  );
  assert.equal(called, false);
});

test("音频结果缺少官方 extra_info.audio_length 时付费结果保持未知态，不伪造冻结时长", async () => {
  await assert.rejects(
    () => provider(async () => json({
      data: { audio_url: "https://cdn.example.test/speech.mp3" },
    })).submit({
      mediaKind: "audio",
      model: "speech-2.8-turbo",
      prompt: "测试",
      quantity: 1,
      parameters: { originalDurationSeconds: 1 },
      references: [],
    }),
    providerError("实测时长", "unknown"),
  );
});

test("认证、网络和供应商错误均返回稳定公开错误，不带供应商 message", async () => {
  await assert.rejects(() => new MinimaxGenerationProvider({ apiKey: "", fetchImpl: async () => json({}) }).submit(imageRequest()), providerError("尚未配置", "rejected"));
  await assert.rejects(() => provider(async () => { throw new Error("socket down secret"); }).submit(imageRequest()), providerError("暂时无法确认", "unknown"));
  await assert.rejects(() => provider(async () => json({ error: { message: "vendor-private-detail", code: "secret-code" } }, 400)).submit(imageRequest()), (error: unknown) => {
    assert.ok(error instanceof ProviderRequestError); assert.equal(error.outcome, "rejected"); assert.doesNotMatch(error.message, /vendor-private-detail|secret-code/); return true;
  });
});

test("供应商 JSON 响应体超限时不读取并保持提交结果未知", async () => {
  await assert.rejects(
    () => provider(async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(96 * 1024 * 1024 + 1),
      },
    })).submit(imageRequest()),
    providerError("安全读取", "unknown"),
  );
});

test("仅接受 HTTPS 的 MiniMax 官方主机，明确拒绝旧 minimax.io", async () => {
  assert.equal(isApprovedMinimaxBaseUrl("https://api.minimaxi.com"), true);
  assert.equal(isApprovedMinimaxBaseUrl("https://api-bj.minimaxi.com/v1"), false);
  for (const url of ["http://api.minimaxi.com", "https://api.minimax.io", "https://api.minimaxi.com.evil.test", "https://user@api.minimaxi.com"]) assert.equal(isApprovedMinimaxBaseUrl(url), false);
  await assert.rejects(() => new MinimaxGenerationProvider({ apiKey: "key", baseUrl: "https://api.minimax.io", fetchImpl: async () => json({}) }).submit(imageRequest()), providerError("未获批准", "rejected"));
});

test("视频 query 解析完成 URL，且 query 失败不泄露供应商 message", async () => {
  const result = await provider(async (url, init) => {
    assert.equal(String(url), "https://api.minimaxi.com/v2/query/video_generation/task-1"); assert.equal(init?.method, "GET");
    return json({ task: {
      id: "task-1",
      model: "MiniMax-H3",
      status: "succeeded",
      content: { url: "https://cdn.example.test/movie.mp4" },
      duration: 4,
      usage: { output_seconds: 4 },
    } });
  }).query("task-1", { mediaKind: "video", model: "MiniMax-H3" });
  assert.equal(result.status, "succeeded"); assert.equal(result.media[0]?.temporaryUrl, "https://cdn.example.test/movie.mp4"); assert.deepEqual(result.usage, { output_seconds: 4 });
  await assert.rejects(() => provider(async () => json({ error: { message: "do not expose" } }, 503)).query("task-1", { mediaKind: "video", model: "MiniMax-H3" }), providerError("进度暂时无法读取", "query_failed"));
});

function imageRequest() { return { mediaKind: "image" as const, model: "image-01", prompt: "测试图片", quantity: 1, parameters: { resolution: "1K" }, references: [] }; }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function providerError(message: string, outcome: ProviderRequestError["outcome"]) { return (error: unknown) => { assert.ok(error instanceof ProviderRequestError); assert.equal(error.outcome, outcome); assert.match(error.message, new RegExp(message)); return true; }; }
