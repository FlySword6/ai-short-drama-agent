import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestError, NotFoundError } from "../../../shared/errors.js";
import { GenerationDefaultStrategyService, assertSafeParameters } from "./service.js";
import type { GenerationDefaultStrategyStore } from "./service.js";
import type { GenerationDefaultStrategy, PutGenerationDefaultStrategyInput } from "./types.js";

const now = new Date("2026-07-20T00:00:00.000Z");
const fixture: GenerationDefaultStrategy = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  mediaKind: "image",
  mode: "direct_reference",
  modelKey: "gpt-image-2",
  parameters: { ratio: "9:16" },
  sourceGenerationRequestId: null,
  updatedByUserId: "33333333-3333-4333-8333-333333333333",
  version: 1,
  createdAt: now,
  updatedAt: now,
};

function store(overrides: Partial<GenerationDefaultStrategyStore> = {}): GenerationDefaultStrategyStore {
  return {
    listForActor: async () => [fixture],
    getForActor: async () => fixture,
    putForActor: async () => fixture,
    ...overrides,
  };
}

test("默认策略服务仅写策略，不创建生成任务，并完整传递乐观锁版本", async () => {
  const calls: Array<{ actorId: string; projectId: string; input: PutGenerationDefaultStrategyInput }> = [];
  const service = new GenerationDefaultStrategyService(store({
    putForActor: async (actorId, projectId, input) => {
      calls.push({ actorId, projectId, input });
      return { ...fixture, ...input, version: 2 };
    },
  }));
  const result = await service.put(fixture.updatedByUserId, fixture.projectId, {
    mediaKind: "image",
    mode: "material_to_prompt",
    modelKey: "seedream-5-pro",
    parameters: { ratio: "16:9", reference_mode: "material_to_prompt" },
    expectedVersion: 1,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input.expectedVersion, 1);
  assert.equal(calls[0]?.input.modelKey, "seedream-5-pro");
  assert.equal(result.version, 2);
});

test("默认策略服务透传音频默认档(text_to_speech + speaker_id 音色)", async () => {
  const calls: Array<{ actorId: string; projectId: string; input: PutGenerationDefaultStrategyInput }> = [];
  const service = new GenerationDefaultStrategyService(store({
    putForActor: async (actorId, projectId, input) => {
      calls.push({ actorId, projectId, input });
      return { ...fixture, ...input, mediaKind: "audio", mode: "text_to_speech", version: 1 };
    },
  }));
  const result = await service.put(fixture.updatedByUserId, fixture.projectId, {
    mediaKind: "audio",
    mode: "text_to_speech",
    modelKey: "seed-audio-1.0",
    parameters: { speaker_id: "voice-cn-1", prompt_template_id: null },
    expectedVersion: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.input.mediaKind, "audio");
  assert.equal(calls[0]?.input.mode, "text_to_speech");
  assert.equal(calls[0]?.input.modelKey, "seed-audio-1.0");
  assert.equal((calls[0]?.input.parameters as { speaker_id: string }).speaker_id, "voice-cn-1");
  assert.equal((calls[0]?.input.parameters as { prompt_template_id: null }).prompt_template_id, null);
  assert.equal(result.mediaKind, "audio");
  assert.equal(result.mode, "text_to_speech");
});

test("默认策略读取缺失明确返回 404", async () => {
  const service = new GenerationDefaultStrategyService(store({ getForActor: async () => undefined }));
  await assert.rejects(
    service.get(fixture.updatedByUserId, fixture.projectId, "video"),
    (error: unknown) => error instanceof NotFoundError,
  );
});

test("默认策略参数拒绝不能保存的内容，且不暴露原始字段路径", () => {
  assert.doesNotThrow(() => assertSafeParameters({
    ratio: "9:16",
    max_tokens: 4_096,
    reference: { enabled: true, ids: ["media-1"] },
  }));
  assert.throws(
    () => assertSafeParameters({ api_key: "should-not-be-persisted" }),
    (error: unknown) => error instanceof BadRequestError
      && error.message === "默认策略设置包含不能保存的内容，请移除后再试"
      && error.details === null,
  );
  assert.throws(
    () => assertSafeParameters({ nested: { provider_response: { id: "raw" } } }),
    (error: unknown) => error instanceof BadRequestError
      && error.message === "默认策略设置包含不能保存的内容，请移除后再试"
      && !error.message.includes("provider_response")
      && error.details === null,
  );
});

test("默认策略参数过大时使用业务文案，不暴露容量单位", () => {
  assert.throws(
    () => assertSafeParameters({ prompt: "x".repeat(64 * 1024) }),
    (error: unknown) => error instanceof BadRequestError
      && error.message === "默认策略设置内容过多，请精简后再试"
      && !/KB|\d/.test(error.message)
      && error.details === null,
  );
});
