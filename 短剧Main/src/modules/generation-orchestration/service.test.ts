import assert from "node:assert/strict";
import test from "node:test";
import { AppError, NotFoundError } from "../../shared/errors.js";
import type { GenerationPricingRule } from "../generation/cost.js";
import { normalizeV01Parameters } from "../generation/v01Contract.js";
import {
  ARK_SEEDANCE_2_FAST_MODEL,
  ARK_SEEDREAM_5_PRO_MODEL,
} from "../generation/v01Contract.js";
import type {
  GenerationMediaKind,
  GenerationParameters,
  GenerationReferenceSnapshot,
} from "../generation/types.js";
import {
  MockGenerationOperationExecutor,
} from "./executors.js";
import { DeterministicGenerationIntentInterpreter } from "./interpreter.js";
import { ArkByteProviderReplica } from "./providerReplica.js";
import { MockGenerationQuoteAdapter } from "./quoteAdapters.js";
import { GenerationOrchestrationService } from "./service.js";
import type {
  GenerationIntentClarification,
  GenerationIntentInterpreter,
  GenerationOperationExecutor,
  GenerationOperationReceipt,
  GenerationOrchestrationSession,
  GenerationOrchestrationStore,
  GenerationOrchestrationTier,
  GenerationQuoteAdapter,
  GenerationReferenceResolver,
  GenerationTierCatalog,
  GenerationTurnContext,
  GenerationTurnContextAuthorizer,
  GenerationVoiceResolver,
  StoredGenerationOperation,
} from "./types.js";

const ids = {
  actor: "10000000-0000-4000-8000-000000000001",
  session: "10000000-0000-4000-8000-000000000002",
  project: "10000000-0000-4000-8000-000000000003",
  episode: "10000000-0000-4000-8000-000000000004",
  scene: "10000000-0000-4000-8000-000000000005",
  shot: "10000000-0000-4000-8000-000000000006",
  imageAsset: "10000000-0000-4000-8000-000000000007",
  imageMedia: "10000000-0000-4000-8000-000000000008",
  videoAsset: "10000000-0000-4000-8000-000000000009",
  videoMedia: "10000000-0000-4000-8000-000000000010",
  audioAsset: "10000000-0000-4000-8000-000000000011",
  audioMedia: "10000000-0000-4000-8000-000000000012",
};

test("mock 编排覆盖文生图、改图、文生视频、图生视频、改视频和文本转音频", async () => {
  const harness = createHarness();
  const cases = [
    {
      message: "给这个镜头生成一张雨夜巷口的图",
      expectedMode: "text_to_image",
      expectedAction: "generate",
      expectedMedia: "image",
      selected: undefined,
    },
    {
      message: "把这张图改亮一点，保留人物构图",
      expectedMode: "image_to_image",
      expectedAction: "edit",
      expectedMedia: "image",
      selected: selectedImage(),
    },
    {
      message: "给这个镜头生成一个雨夜巷口的视频",
      expectedMode: "text_to_video",
      expectedAction: "generate",
      expectedMedia: "video",
      selected: undefined,
    },
    {
      message: "让这张图动起来，镜头缓慢推进",
      expectedMode: "image_to_video",
      expectedAction: "generate",
      expectedMedia: "video",
      selected: selectedImage(),
    },
    {
      message: "把这个视频改成雨更大的版本",
      expectedMode: "video_to_video",
      expectedAction: "edit",
      expectedMedia: "video",
      selected: selectedVideo(),
    },
    {
      message: "生成 3 秒男声旁白：今晚必须找到他",
      expectedMode: "text_to_audio",
      expectedAction: "generate",
      expectedMedia: "audio",
      selected: undefined,
    },
  ] as const;

  for (const item of cases) {
    const result = await harness.service.createTurn({
      actorId: ids.actor,
      sessionId: ids.session,
      message: item.message,
      context: context(item.selected),
    });
    if (result.status !== "confirmation_required") {
      assert.fail(`未生成操作卡：${JSON.stringify(result)}`);
    }
    assert.equal(result.operationCard.inputMode, item.expectedMode);
    assert.equal(result.operationCard.operationType, item.expectedAction);
    assert.equal(result.operationCard.mediaKind, item.expectedMedia);
    assert.equal(result.operationCard.quote.mode, "mock");
    assert.equal(result.operationCard.quote.generationQuoteId, null);
    assert.equal(result.operationCard.parameterGroups.length, 4);

    const receipt = await harness.service.confirm({
      actorId: ids.actor,
      sessionId: ids.session,
      operationId: result.operationCard.operationId,
    });
    assert.equal(receipt.executionMode, "mock");
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.ledger.chargedCostFen, 0);
    assert.equal(receipt.ledger.pointsSpent, 0);
    assert.equal(receipt.artifact.storageState, "simulated");
    assert.equal(receipt.artifact.storageUrl, null);
  }

  assert.ok(harness.provider.calls.some((call) => call.pathname.endsWith("/images/generations")));
  assert.ok(harness.provider.calls.some((call) => call.pathname.endsWith("/contents/generations/tasks")));
  assert.ok(harness.provider.calls.some((call) => call.pathname === "/api/v3/tts/create"));
});

test("改图和改视频把选中媒体冻结为参考，并把结果指回原资产", async () => {
  const harness = createHarness();
  for (const item of [
    { message: "把这张图改亮一点", selected: selectedImage(), mode: "image_to_image" },
    { message: "把这个视频改成夜景", selected: selectedVideo(), mode: "video_to_video" },
  ] as const) {
    const result = await harness.service.createTurn({
      actorId: ids.actor,
      sessionId: ids.session,
      message: item.message,
      context: context(item.selected),
    });
    if (result.status !== "confirmation_required") assert.fail(`应返回操作卡：${JSON.stringify(result)}`);
    assert.equal(result.operationCard.inputMode, item.mode);
    assert.equal(result.operationCard.target.placement, "replace_asset_variant");
    assert.equal(result.operationCard.target.assetEntityId, item.selected.assetEntityId);
    assert.deepEqual(result.operationCard.references.mediaIds, [item.selected.mediaId]);
    const stored = harness.store.operations.get(result.operationCard.operationId);
    assert.equal(stored?.referenceMedia[0]?.kind, item.selected.mediaKind);
    const group = result.operationCard.parameterGroups.find(
      (candidate) => candidate.key === (item.selected.mediaKind === "image" ? "visual" : "motion"),
    );
    const countKey = item.selected.mediaKind === "image"
      ? "reference_images"
      : "reference_videos";
    assert.equal(
      group?.controls.find((control) => control.key === countKey)?.value,
      1,
    );
  }
});

test("选中配音换男声时继承可信原台词、冻结已登记音色并替换原变体", async () => {
  const harness = createHarness();
  const result = await harness.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "这段配音换成男声再生成一遍",
    context: context(selectedAudio()),
  });
  if (result.status !== "confirmation_required") {
    assert.fail(`应返回音频替换操作卡：${JSON.stringify(result)}`);
  }
  assert.equal(result.operationCard.operationType, "edit");
  assert.equal(result.operationCard.inputMode, "text_to_audio");
  assert.equal(result.operationCard.prompt, "今晚必须找到他");
  assert.equal(result.operationCard.defaults.speakerId, "zh_male_company_voice");
  assert.equal(result.operationCard.target.placement, "replace_asset_variant");
  assert.equal(result.operationCard.target.assetEntityId, ids.audioAsset);
  assert.equal(result.operationCard.references.selectedMediaId, ids.audioMedia);
  assert.deepEqual(result.operationCard.references.mediaIds, []);

  const refreshed = await harness.service.requote({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: result.operationCard.operationId,
    requestedParameters: { speechRate: 20 },
  });
  if (refreshed.status !== "confirmation_required") {
    assert.fail(`音频变体重新报价应返回新卡：${JSON.stringify(refreshed)}`);
  }
  assert.equal(refreshed.operationCard.prompt, "今晚必须找到他");
  assert.equal(refreshed.operationCard.defaults.speakerId, "zh_male_company_voice");
  assert.equal(refreshed.operationCard.defaults.speechRate, 20);

  await harness.service.confirm({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: refreshed.operationCard.operationId,
  });
  const call = harness.provider.calls.find((item) => item.pathname === "/api/v3/tts/create");
  assert.equal(call?.body?.text_prompt, "今晚必须找到他");
  assert.deepEqual(call?.body?.references, [{ speaker: "zh_male_company_voice" }]);
  assert.doesNotMatch(String(call?.body?.text_prompt), /换成男声/u);
});

test("real 解释器误把选中配音重生成判成 generate 时服务端仍强制走可信替换", async () => {
  const interpreter: GenerationIntentInterpreter = {
    async interpret() {
      return {
        decision: "operation",
        operationType: "generate",
        mediaKind: "audio",
        prompt: "这段配音换成男声再生成一遍",
        requestedVoiceGender: "female",
        requestedParameters: {
          originalDurationSeconds: 1,
          format: "pcm",
          sampleRate: 8_000,
        },
      };
    },
  };
  const harness = createHarness("mock", interpreter);
  const result = await harness.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "这段配音换成男声再生成一遍",
    context: context(selectedAudio()),
  });
  if (result.status !== "confirmation_required") {
    assert.fail(`应返回可信音频替换卡：${JSON.stringify(result)}`);
  }
  assert.equal(result.operationCard.operationType, "edit");
  assert.equal(result.operationCard.prompt, "今晚必须找到他");
  assert.equal(result.operationCard.defaults.speakerId, "zh_male_company_voice");
  assert.equal(result.operationCard.defaults.originalDurationSeconds, 3);
  assert.equal(result.operationCard.defaults.format, "mp3");
  assert.equal(result.operationCard.defaults.sampleRate, 48_000);
});

test("音频重生成缺少可信原台词或登记音色时只澄清，不报价不调用", async () => {
  const missingScript = createHarness();
  missingScript.contextAuthorizer.audioSource = undefined;
  const scriptResult = await missingScript.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "这段配音换成男声再生成一遍",
    context: context(selectedAudio()),
  });
  assert.equal(scriptResult.status, "clarification_required");
  if (scriptResult.status === "clarification_required") {
    assert.equal(scriptResult.clarification.code, "trusted_script_required");
  }
  assert.equal(missingScript.store.operations.size, 0);

  const missingVoice = createHarness();
  missingVoice.voiceResolver.enabled = false;
  const voiceResult = await missingVoice.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "这段配音换成男声再生成一遍",
    context: context(selectedAudio()),
  });
  assert.equal(voiceResult.status, "clarification_required");
  if (voiceResult.status === "clarification_required") {
    assert.equal(voiceResult.clarification.code, "registered_male_speaker_required");
  }
  assert.equal(missingVoice.store.operations.size, 0);
  assert.equal(missingVoice.provider.calls.length, 0);

  const unpricedDuration = createHarness();
  unpricedDuration.contextAuthorizer.audioSource = {
    prompt: "这是一段十二秒的可信原台词",
    parameters: {
      originalDurationSeconds: 12,
      format: "wav",
      sampleRate: 48_000,
      speakerId: "legacy_voice",
    },
  };
  const durationResult = await unpricedDuration.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "这段配音换成男声再生成一遍",
    context: context(selectedAudio()),
  });
  assert.equal(durationResult.status, "clarification_required");
  if (durationResult.status === "clarification_required") {
    assert.equal(durationResult.clarification.code, "tier_not_priced");
  }
});

test("重新报价不能注入未登记供应商音色", async () => {
  const harness = createHarness();
  const card = await operationCard(harness, "生成 3 秒旁白音频：今晚必须找到他", undefined);
  const result = await harness.service.requote({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: card.operationId,
    requestedParameters: { speakerId: "unregistered-private-voice" },
  });
  assert.equal(result.status, "clarification_required");
  if (result.status === "clarification_required") {
    assert.equal(result.clarification.code, "request_ambiguous");
    assert.match(result.clarification.question, /未登记或已停用/u);
  }
  assert.equal(harness.provider.calls.length, 0);
});

test("选中媒体必须真实归属于同一个资产，错配在报价和操作落库前拒绝", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.service.createTurn({
      actorId: ids.actor,
      sessionId: ids.session,
      message: "把这张图改亮一点",
      context: context({
        ...selectedImage(),
        assetEntityId: ids.videoAsset,
      }),
    }),
    (error: unknown) => error instanceof AppError
      && error.code === "selected_asset_mismatch",
  );
  assert.equal(harness.store.operations.size, 0);
  assert.equal(harness.provider.calls.length, 0);
});

test("歧义、缺少修改目标和未核价原生参数只返回澄清，不创建操作", async () => {
  const harness = createHarness();
  const ambiguous = await harness.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "帮我做一下",
    context: context(),
  });
  assert.equal(ambiguous.status, "clarification_required");
  if (ambiguous.status === "clarification_required") {
    assert.equal(ambiguous.clarification.code, "media_kind_required");
  }

  const missingTarget = await harness.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "把这张图改亮一点",
    context: context(),
  });
  assert.equal(missingTarget.status, "clarification_required");
  if (missingTarget.status === "clarification_required") {
    assert.equal(missingTarget.clarification.code, "edit_target_required");
  }

  const unpriced = await harness.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "生成一张 4K 雨夜街道图片",
    context: context(),
  });
  assert.equal(unpriced.status, "clarification_required");
  if (unpriced.status === "clarification_required") {
    assert.equal(unpriced.clarification.code, "tier_not_priced");
    assert.match(unpriced.clarification.question, /没有对应核价档位/u);
  }
  assert.equal(harness.store.operations.size, 0);
  assert.equal(harness.provider.calls.length, 0);
});

test("操作卡分层暴露模型原生范围，但固定核价项变更必须重新报价", async () => {
  const harness = createHarness();
  const image = await operationCard(harness, "生成一张雨夜巷口图片", undefined);
  const visual = image.parameterGroups.find((group) => group.key === "visual");
  assert.deepEqual(
    visual?.controls.find((control) => control.key === "resolution")?.options,
    ["1K", "2K"],
  );
  assert.equal(
    visual?.controls.find((control) => control.key === "size")?.availability,
    "not_priced",
  );
  assert.equal(
    visual?.controls.find((control) => control.key === "reference_images")?.range?.max,
    10,
  );
  assert.equal(
    visual?.controls.find((control) => control.key === "reference_images")?.availability,
    "frozen_context",
  );

  const video = await operationCard(harness, "生成一个 4 秒雨夜视频", undefined);
  const motion = video.parameterGroups.find((group) => group.key === "motion");
  assert.equal(
    motion?.controls.find((control) => control.key === "duration_seconds")?.range?.max,
    15,
  );
  assert.equal(
    motion?.controls.find((control) => control.key === "duration_seconds")?.requiresRequote,
    true,
  );

  const audio = await operationCard(harness, "生成 3 秒旁白音频", undefined);
  const sound = audio.parameterGroups.find((group) => group.key === "audio");
  assert.equal(
    sound?.controls.find((control) => control.key === "original_duration_seconds")?.range?.max,
    120,
  );
  assert.deepEqual(
    sound?.controls.find((control) => control.key === "format")?.options,
    ["mp3", "wav", "pcm"],
  );
  assert.equal(
    sound?.controls.find((control) => control.key === "speech_rate")?.requiresRequote,
    true,
  );
  assert.deepEqual(
    sound?.controls.find((control) => control.key === "speaker_id")?.options,
    [
      "zh_male_company_voice",
      "zh_female_company_voice",
      "legacy_voice",
    ],
  );
  const cost = audio.parameterGroups.find((group) => group.key === "cost");
  assert.equal(
    cost?.controls.find((control) => control.key === "estimated_cost_fen")?.label,
    "预计费用（人民币分）",
  );
});

test("同一 mock 操作重复确认返回同一回执且只执行一次供应商复刻", async () => {
  const harness = createHarness();
  const card = await operationCard(harness, "生成一张雨夜巷口图片", undefined);
  const first = await harness.service.confirm({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: card.operationId,
  });
  const callsAfterFirst = harness.provider.calls.length;
  const second = await harness.service.confirm({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: card.operationId,
  });
  assert.deepEqual(second, first);
  assert.equal(harness.provider.calls.length, callsAfterFirst);
});

test("同一 mock 操作并发确认复用一个执行 Promise，只调用一次供应商复刻", async () => {
  const harness = createHarness();
  const card = await operationCard(harness, "生成一张雨夜巷口图片", undefined);
  const [left, right] = await Promise.all([
    harness.service.confirm({
      actorId: ids.actor,
      sessionId: ids.session,
      operationId: card.operationId,
    }),
    harness.service.confirm({
      actorId: ids.actor,
      sessionId: ids.session,
      operationId: card.operationId,
    }),
  ]);
  assert.deepEqual(right, left);
  assert.equal(
    harness.provider.calls.filter((call) => call.pathname.endsWith("/images/generations")).length,
    1,
  );
});

test("高级设置重新报价生成新冻结卡，未核价组合澄清，已确认卡拒绝改写", async () => {
  const harness = createHarness();
  const original = await operationCard(harness, "生成一张雨夜巷口图片", undefined);
  const refreshed = await harness.service.requote({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: original.operationId,
    requestedParameters: {},
  });
  if (refreshed.status !== "confirmation_required") {
    assert.fail(`同档重新报价应返回新操作卡：${JSON.stringify(refreshed)}`);
  }
  assert.notEqual(refreshed.operationCard.operationId, original.operationId);
  assert.equal(refreshed.operationCard.quote.mode, "mock");
  assert.equal(refreshed.operationCard.tier.tierId, original.tier.tierId);

  const unpriced = await harness.service.requote({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: refreshed.operationCard.operationId,
    requestedParameters: { ratio: "1:1" },
  });
  assert.equal(unpriced.status, "clarification_required");
  if (unpriced.status === "clarification_required") {
    assert.equal(unpriced.clarification.code, "tier_not_priced");
  }

  await harness.service.confirm({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: original.operationId,
  });
  await assert.rejects(
    harness.service.requote({
      actorId: ids.actor,
      sessionId: ids.session,
      operationId: original.operationId,
      requestedParameters: {},
    }),
    (error: unknown) => error instanceof AppError
      && error.code === "generation_operation_already_confirmed",
  );
});

test("会话项目或镜头错位时在解释器与报价前停止", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.service.createTurn({
      actorId: ids.actor,
      sessionId: ids.session,
      message: "生成一张图",
      context: { ...context(), projectId: "20000000-0000-4000-8000-000000000001" },
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "assistant_context_mismatch",
  );
  assert.equal(harness.provider.calls.length, 0);
});

test("创建、重新报价和首次确认共用同一上下文授权闸门", async () => {
  const harness = createHarness();
  const card = await operationCard(harness, "生成一张雨夜巷口图片", undefined);
  assert.equal(harness.contextAuthorizer.calls, 1);
  const refreshed = await harness.service.requote({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: card.operationId,
    requestedParameters: {},
  });
  if (refreshed.status !== "confirmation_required") {
    assert.fail(`重新报价应返回操作卡：${JSON.stringify(refreshed)}`);
  }
  assert.equal(harness.contextAuthorizer.calls, 2);
  await harness.service.confirm({
    actorId: ids.actor,
    sessionId: ids.session,
    operationId: refreshed.operationCard.operationId,
  });
  assert.equal(harness.contextAuthorizer.calls, 3);
});

test("建卡后引用权限被撤销时，mock 确认在供应商复刻前拒绝", async () => {
  const harness = createHarness();
  const result = await harness.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message: "参考这张图生成一张雨夜巷口图片",
    context: {
      ...context(),
      referenceMediaIds: [ids.imageMedia],
    },
  });
  if (result.status !== "confirmation_required") {
    assert.fail(`应先创建操作卡：${JSON.stringify(result)}`);
  }
  harness.contextAuthorizer.referencesRevoked = true;
  await assert.rejects(
    harness.service.confirm({
      actorId: ids.actor,
      sessionId: ids.session,
      operationId: result.operationCard.operationId,
    }),
    (error: unknown) => error instanceof AppError
      && error.code === "generation_reference_access_revoked",
  );
  assert.equal(harness.provider.calls.length, 0);
});

test("disabled 模式在读取会话、LLM、报价和供应商之前关闭", async () => {
  const harness = createHarness("disabled");
  await assert.rejects(
    harness.service.createTurn({
      actorId: ids.actor,
      sessionId: ids.session,
      message: "生成一张图",
      context: context(),
    }),
    (error: unknown) => error instanceof AppError
      && error.code === "generation_orchestration_disabled"
      && /不会创建报价或任务/u.test(error.message),
  );
  assert.equal(harness.store.operations.size, 0);
  assert.equal(harness.provider.calls.length, 0);
});

function createHarness(
  mode: "mock" | "disabled" = "mock",
  interpreter: GenerationIntentInterpreter = new DeterministicGenerationIntentInterpreter(),
) {
  const store = new InMemoryStore();
  const catalog = new InMemoryCatalog();
  const references = new InMemoryReferenceResolver(new Map([
    [ids.imageMedia, { mediaKind: "image", assetEntityId: ids.imageAsset }],
    [ids.videoMedia, { mediaKind: "video", assetEntityId: ids.videoAsset }],
    [ids.audioMedia, { mediaKind: "audio", assetEntityId: ids.audioAsset }],
  ]));
  const contextAuthorizer = new InMemoryContextAuthorizer();
  const voiceResolver = new InMemoryVoiceResolver();
  const provider = new ArkByteProviderReplica();
  const mockQuote = new MockGenerationQuoteAdapter(references);
  const neverQuote: GenerationQuoteAdapter = {
    mode: "real",
    async prepare() {
      throw new Error("real quote must not run in mock tests");
    },
  };
  const neverExecutor: GenerationOperationExecutor = {
    mode: "real",
    async execute() {
      throw new Error("real executor must not run in mock tests");
    },
  };
  const service = new GenerationOrchestrationService({
    mode,
    store,
    catalog,
    interpreter,
    quoteAdapters: { mock: mockQuote, real: neverQuote },
    executors: {
      mock: new MockGenerationOperationExecutor(catalog, provider),
      real: neverExecutor,
    },
    contextAuthorizer,
    voiceResolver,
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  });
  return {
    service,
    store,
    catalog,
    provider,
    contextAuthorizer,
    voiceResolver,
  };
}

class InMemoryContextAuthorizer implements GenerationTurnContextAuthorizer {
  calls = 0;
  audioSource: {
    prompt: string;
    parameters: GenerationParameters;
  } | undefined = {
    prompt: "今晚必须找到他",
    parameters: {
      originalDurationSeconds: 3,
      format: "mp3",
      sampleRate: 48_000,
      speakerId: "legacy_voice",
      speechRate: 10,
    },
  };
  referencesRevoked = false;

  async authorize(
    _actorId: string,
    context: GenerationTurnContext,
    mediaKind?: GenerationMediaKind,
  ) {
    this.calls += 1;
    if (
      this.referencesRevoked
      && mediaKind
      && context.referenceMediaIds.length > 0
    ) {
      throw new AppError(
        403,
        "generation_reference_access_revoked",
        "参考素材已不可用，请重新选择。",
      );
    }
    return {
      context,
      ...(context.selectedAsset?.mediaKind === "audio" && this.audioSource
        ? { selectedAudioSource: this.audioSource }
        : {}),
    };
  }
}

class InMemoryVoiceResolver implements GenerationVoiceResolver {
  enabled = true;

  async resolveByGender(gender: "male" | "female") {
    if (!this.enabled) return null;
    return {
      speakerId: gender === "male"
        ? "zh_male_company_voice"
        : "zh_female_company_voice",
      displayName: gender === "male" ? "公司男声" : "公司女声",
    };
  }

  async resolveSpeakerId(speakerId: string) {
    return speakerId === "zh_male_company_voice"
      || speakerId === "zh_female_company_voice"
      || speakerId === "legacy_voice"
      ? speakerId
      : null;
  }

  async listSpeakerIds() {
    return [
      "zh_male_company_voice",
      "zh_female_company_voice",
      "legacy_voice",
    ];
  }
}

class InMemoryStore implements GenerationOrchestrationStore {
  readonly operations = new Map<string, StoredGenerationOperation>();
  readonly receipts = new Map<string, GenerationOperationReceipt>();
  private counter = 100;
  private readonly session: GenerationOrchestrationSession = {
    id: ids.session,
    userId: ids.actor,
    projectId: ids.project,
    shotId: ids.shot,
  };

  async getSession(actorId: string, sessionId: string): Promise<GenerationOrchestrationSession> {
    if (actorId !== ids.actor || sessionId !== ids.session) throw new NotFoundError();
    return this.session;
  }

  async appendUserTurn(): Promise<void> {}

  async saveClarification(
    _sessionId: string,
    _clarification: GenerationIntentClarification,
  ): Promise<string> {
    return this.nextId();
  }

  async saveOperation(_sessionId: string, operation: StoredGenerationOperation): Promise<string> {
    const id = this.nextId();
    this.operations.set(id, operation);
    return id;
  }

  async getOperation(
    _actorId: string,
    _sessionId: string,
    operationId: string,
  ): Promise<StoredGenerationOperation> {
    const operation = this.operations.get(operationId);
    if (!operation) throw new NotFoundError();
    return operation;
  }

  async findReceipt(
    _actorId: string,
    _sessionId: string,
    operationId: string,
  ): Promise<GenerationOperationReceipt | null> {
    return this.receipts.get(operationId) ?? null;
  }

  async saveReceipt(
    _sessionId: string,
    receipt: GenerationOperationReceipt,
  ): Promise<GenerationOperationReceipt> {
    const existing = this.receipts.get(receipt.operationId);
    if (existing) return existing;
    this.receipts.set(receipt.operationId, receipt);
    return receipt;
  }

  private nextId(): string {
    this.counter += 1;
    return `10000000-0000-4000-8000-${String(this.counter).padStart(12, "0")}`;
  }
}

class InMemoryCatalog implements GenerationTierCatalog {
  private readonly tiers = [
    tier({
      tierId: "img-seedream5pro-169-2k-1",
      mediaKind: "image",
      model: ARK_SEEDREAM_5_PRO_MODEL,
      provider: "ark",
      billingUnit: "image",
      unitPriceFen: 60,
      parameters: { size: "2K", ratio: "16:9" },
      displayName: "图片 2K",
    }),
    tier({
      tierId: "vid-seedance20fast-916-720p-4s-input",
      mediaKind: "video",
      model: ARK_SEEDANCE_2_FAST_MODEL,
      provider: "ark",
      billingUnit: "second",
      unitPriceFen: 80,
      parameters: {
        resolution: "720p",
        ratio: "9:16",
        durationSeconds: 4,
        generateAudio: true,
      },
      displayName: "视频 720p · 4秒",
      supportsInputVideo: true,
    }),
    tier({
      tierId: "aud-seedaudio10-3s",
      mediaKind: "audio",
      model: "seed-audio-1.0",
      provider: "openspeech",
      billingUnit: "second",
      unitPriceFen: 3,
      parameters: {
        originalDurationSeconds: 3,
        format: "mp3",
        sampleRate: 48_000,
        enableSubtitle: true,
        aigcMetadataEnabled: true,
        aigcWatermarkEnabled: false,
      },
      displayName: "音频 3秒",
    }),
  ];

  async list(mediaKind: GenerationMediaKind): Promise<GenerationOrchestrationTier[]> {
    return this.tiers.filter((item) => item.mediaKind === mediaKind);
  }
}

class InMemoryReferenceResolver implements GenerationReferenceResolver {
  constructor(private readonly media: Map<string, {
    mediaKind: GenerationMediaKind;
    assetEntityId: string;
  }>) {}

  async resolve(
    _actorId: string,
    _mediaKind: GenerationMediaKind,
    mediaIds: string[],
  ): Promise<GenerationReferenceSnapshot[]> {
    return mediaIds.map((mediaId) => ({
      mediaId,
      kind: this.media.get(mediaId)?.mediaKind ?? "image",
      url: `https://assets.example.test/${mediaId}`,
    }));
  }

  async resolveSelectedAsset(
    selectedAsset: {
      assetEntityId: string;
      mediaId: string;
      mediaKind: GenerationMediaKind;
    },
    resolvedReference: GenerationReferenceSnapshot,
  ) {
    const actual = this.media.get(selectedAsset.mediaId);
    if (
      !actual
      || actual.assetEntityId !== selectedAsset.assetEntityId
      || actual.mediaKind !== selectedAsset.mediaKind
      || resolvedReference.kind !== selectedAsset.mediaKind
    ) {
      throw new AppError(
        409,
        "selected_asset_mismatch",
        "当前选中媒体与资产不一致，请刷新后重试。",
      );
    }
    return { ...selectedAsset };
  }
}

function tier(input: {
  tierId: string;
  mediaKind: GenerationMediaKind;
  model: string;
  provider: string;
  billingUnit: GenerationPricingRule["billingUnit"];
  unitPriceFen: number;
  parameters: GenerationParameters;
  displayName: string;
  supportsInputVideo?: boolean;
}): GenerationOrchestrationTier {
  const pricingRule: GenerationPricingRule = {
    id: `30000000-0000-4000-8000-${String(input.unitPriceFen).padStart(12, "0")}`,
    provider: input.provider,
    model: input.model,
    mediaKind: input.mediaKind,
    billingUnit: input.billingUnit,
    unitPriceFen: input.unitPriceFen,
    metadata: {
      capability_tier: {
        tier_id: input.tierId,
        status: "active",
      },
    },
    ...(input.supportsInputVideo ? { supportsInputVideo: true } : {}),
  };
  return {
    tierId: input.tierId,
    mediaKind: input.mediaKind,
    providerAccount: "ark",
    providerLabel: input.provider === "openspeech" ? "火山引擎语音" : "火山方舟",
    modelLabel: `已核价${input.mediaKind}模型`,
    displayName: input.displayName,
    isDefault: true,
    model: input.model,
    quantity: 1,
    parameters: normalizeV01Parameters({
      mediaKind: input.mediaKind,
      model: input.model,
      parameters: input.parameters,
      quantity: 1,
    }),
    pricingRule,
  };
}

function context(
  selectedAsset?: {
    assetEntityId: string;
    mediaId: string;
    mediaKind: GenerationMediaKind;
  },
) {
  return {
    projectId: ids.project,
    episodeId: ids.episode,
    sceneId: ids.scene,
    shotId: ids.shot,
    ...(selectedAsset ? { selectedAsset } : {}),
    referenceMediaIds: [],
  };
}

function selectedImage() {
  return {
    assetEntityId: ids.imageAsset,
    mediaId: ids.imageMedia,
    mediaKind: "image" as const,
  };
}

function selectedVideo() {
  return {
    assetEntityId: ids.videoAsset,
    mediaId: ids.videoMedia,
    mediaKind: "video" as const,
  };
}

function selectedAudio() {
  return {
    assetEntityId: ids.audioAsset,
    mediaId: ids.audioMedia,
    mediaKind: "audio" as const,
  };
}

async function operationCard(
  harness: ReturnType<typeof createHarness>,
  message: string,
  selected:
    | ReturnType<typeof selectedImage>
    | ReturnType<typeof selectedVideo>
    | ReturnType<typeof selectedAudio>
    | undefined,
) {
  const result = await harness.service.createTurn({
    actorId: ids.actor,
    sessionId: ids.session,
    message,
    context: context(selected),
  });
  if (result.status !== "confirmation_required") {
    assert.fail(`未返回操作卡：${result.assistantMessage}`);
  }
  return result.operationCard;
}
