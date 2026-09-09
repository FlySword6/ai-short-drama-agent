import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../shared/errors.js";
import {
  ARK_SEEDANCE_2_FAST_MODEL,
  ARK_SEEDREAM_5_PRO_MODEL,
} from "../generation/v01Contract.js";
import type { ProviderGenerationRequest } from "../generation/types.js";
import {
  ArkByteProviderReplica,
  executeReplicaProvider,
} from "./providerReplica.js";

test("Ark 图片复刻把官方同步 data/usage 形状送进真实 adapter", async () => {
  const provider = new ArkByteProviderReplica();
  const submission = await provider.submit(imageRequest());
  assert.equal(submission.outcome, "succeeded");
  if (submission.outcome !== "succeeded") assert.fail("图片应同步成功");
  assert.equal(submission.result.media[0]?.kind, "image");
  assert.equal(submission.result.usage?.generated_images, 1);
  const call = provider.calls[0];
  assert.equal(call?.pathname, "/api/v3/images/generations");
  assert.equal(call?.body?.size, "2048x1152");
  assert.equal(call?.body?.watermark, false);
  assert.equal("ratio" in (call?.body ?? {}), false);
});

test("Ark 视频复刻按 queued → running → succeeded 时序经过真实 adapter", async () => {
  const provider = new ArkByteProviderReplica();
  const execution = await executeReplicaProvider(provider, videoRequest());
  assert.equal(execution.attemptId, "mock-video-task-1");
  assert.deepEqual(execution.timeline, [
    { state: "accepted", offsetMs: 0 },
    { state: "running", offsetMs: 120 },
    { state: "succeeded", offsetMs: 360 },
  ]);
  assert.deepEqual(
    provider.calls.map((call) => `${call.method} ${call.pathname}`),
    [
      "POST /api/v3/contents/generations/tasks",
      "GET /api/v3/contents/generations/tasks/mock-video-task-1",
      "GET /api/v3/contents/generations/tasks/mock-video-task-1",
    ],
  );
});

test("Seed Audio 复刻把 code/url/duration/original_duration/subtitle 送进真实 adapter", async () => {
  const provider = new ArkByteProviderReplica();
  const submission = await provider.submit(audioRequest());
  assert.equal(submission.outcome, "succeeded");
  if (submission.outcome !== "succeeded") assert.fail("音频应同步成功");
  assert.equal(submission.result.media[0]?.kind, "audio");
  assert.equal(submission.result.media[0]?.actualDurationMs, 3_000);
  assert.equal(submission.result.usage?.original_duration_ms, 3_000);
  assert.ok(submission.result.media[0]?.subtitle);
  const call = provider.calls[0];
  assert.equal(call?.pathname, "/api/v3/tts/create");
  assert.equal(call?.body?.model, "seed-audio-1.0");
  assert.equal((call?.body?.audio_config as Record<string, unknown>)?.sample_rate, 48_000);
});

test("复刻内容安全、认证、限流和成功无产物均转成稳定中文错误", async () => {
  await assert.rejects(
    executeReplicaProvider(new ArkByteProviderReplica("content_safety"), imageRequest()),
    (error: unknown) => error instanceof AppError
      && error.code === "InputTextSensitiveContentDetected"
      && error.statusCode === 422
      && /未被服务接受/u.test(error.message),
  );
  await assert.rejects(
    executeReplicaProvider(new ArkByteProviderReplica("content_safety"), audioRequest()),
    (error: unknown) => error instanceof AppError
      && error.code === "SEEDAUDIO_45001125"
      && /安全检查/u.test(error.message),
  );
  await assert.rejects(
    executeReplicaProvider(new ArkByteProviderReplica("authentication_failed"), imageRequest()),
    (error: unknown) => error instanceof AppError
      && error.code === "AuthenticationError"
      && error.statusCode === 422
      && /未被服务接受/u.test(error.message)
      && !/replica|credential/iu.test(error.message),
  );
  await assert.rejects(
    executeReplicaProvider(new ArkByteProviderReplica("rate_limited"), videoRequest()),
    (error: unknown) => error instanceof AppError
      && error.code === "QuotaExceeded"
      && error.statusCode === 429
      && error.retryable,
  );
  await assert.rejects(
    executeReplicaProvider(new ArkByteProviderReplica("missing_result"), imageRequest()),
    (error: unknown) => error instanceof AppError
      && error.code === "mock_provider_rejected"
      && /未返回可用结果/u.test(error.message),
  );
});

function imageRequest(): ProviderGenerationRequest {
  return {
    mediaKind: "image",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    prompt: "雨夜巷口",
    parameters: {
      size: "2K",
      ratio: "16:9",
      watermark: false,
      sequentialImageGeneration: "disabled",
    },
    references: [],
    quantity: 1,
  };
}

function videoRequest(): ProviderGenerationRequest {
  return {
    mediaKind: "video",
    model: ARK_SEEDANCE_2_FAST_MODEL,
    prompt: "人物走过雨夜巷口",
    parameters: {
      resolution: "720p",
      ratio: "9:16",
      durationSeconds: 4,
      watermark: false,
      generateAudio: true,
    },
    references: [],
    quantity: 1,
  };
}

function audioRequest(): ProviderGenerationRequest {
  return {
    mediaKind: "audio",
    model: "seed-audio-1.0",
    prompt: "今晚必须找到他",
    parameters: {
      originalDurationSeconds: 3,
      format: "mp3",
      sampleRate: 48_000,
      enableSubtitle: true,
      aigcMetadataEnabled: true,
      aigcWatermarkEnabled: false,
    },
    references: [],
    quantity: 1,
  };
}
