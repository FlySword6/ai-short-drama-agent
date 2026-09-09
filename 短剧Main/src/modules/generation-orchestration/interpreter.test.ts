import assert from "node:assert/strict";
import test from "node:test";
import type { AiGatewayService } from "../ai/service.js";
import {
  AiGenerationIntentInterpreter,
  DeterministicGenerationIntentInterpreter,
} from "./interpreter.js";
import type {
  GenerationIntentInterpreterInput,
  GenerationOrchestrationTier,
} from "./types.js";

test("real 解释器复用 AI Gateway 的 generation_orchestration 审计目的且不下发 model id", async () => {
  let captured: Record<string, unknown> | undefined;
  const gateway = {
    async completeValidated(
      input: Record<string, unknown>,
      validate: (completion: {
        content: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        durationMs: number;
      }) => unknown,
    ) {
      captured = input;
      return validate({
        content: JSON.stringify({
          decision: "operation",
          operation_type: "generate",
          media_kind: "video",
          prompt: "人物在雨夜巷口缓慢前行",
          requested_tier_id: "vid-public",
          requested_parameters: {
            duration_seconds: 8,
            resolution: "720p",
            generate_audio: false,
          },
        }),
        model: "server-only-model",
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 30,
      });
    },
  } as unknown as Pick<AiGatewayService, "completeValidated">;

  const decision = await new AiGenerationIntentInterpreter(gateway).interpret(baseInput());
  assert.equal(captured?.purpose, "generation_orchestration");
  assert.equal(captured?.thinking, "disabled");
  assert.doesNotMatch(String(captured?.prompt), /internal-provider-model/u);
  assert.deepEqual(decision, {
    decision: "operation",
    operationType: "generate",
    mediaKind: "video",
    prompt: "人物在雨夜巷口缓慢前行",
    requestedTierId: "vid-public",
    requestedParameters: {
      durationSeconds: 8,
      resolution: "720p",
      generateAudio: false,
    },
  });
});

test("real 解释器拒绝非 JSON 或越权结构，原始模型输出不进入错误文案", async () => {
  const raw = "```json\n{\"provider\":\"private-key\"}\n```";
  const gateway = {
    async completeValidated(
      _input: Record<string, unknown>,
      validate: (completion: {
        content: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        durationMs: number;
      }) => unknown,
    ) {
      return validate({
        content: raw,
        model: "server-only-model",
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
      });
    },
  } as unknown as Pick<AiGatewayService, "completeValidated">;
  await assert.rejects(
    new AiGenerationIntentInterpreter(gateway).interpret(baseInput()),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "generation_intent_invalid"
      && !error.message.includes("private-key"),
  );
});

test("mock 解释器不依赖 AI Gateway，并能区分改图与图生视频", async () => {
  const interpreter = new DeterministicGenerationIntentInterpreter();
  const edit = await interpreter.interpret({
    ...baseInput(),
    message: "把这张图调亮一点",
    context: {
      ...baseInput().context,
      selectedAsset: {
        assetEntityId: "50000000-0000-4000-8000-000000000004",
        mediaId: "50000000-0000-4000-8000-000000000005",
        mediaKind: "image",
      },
    },
  });
  assert.equal(edit.decision, "operation");
  if (edit.decision === "operation") {
    assert.equal(edit.operationType, "edit");
    assert.equal(edit.mediaKind, "image");
  }
  const animate = await interpreter.interpret({
    ...baseInput(),
    message: "让这张图动起来",
    context: {
      ...baseInput().context,
      selectedAsset: {
        assetEntityId: "50000000-0000-4000-8000-000000000004",
        mediaId: "50000000-0000-4000-8000-000000000005",
        mediaKind: "image",
      },
    },
  });
  assert.equal(animate.decision, "operation");
  if (animate.decision === "operation") {
    assert.equal(animate.operationType, "generate");
    assert.equal(animate.mediaKind, "video");
  }
});

test("mock 解释器把选中配音的男声重生成识别为音频替换意图", async () => {
  const decision = await new DeterministicGenerationIntentInterpreter().interpret({
    ...baseInput(),
    message: "这段配音换成男声再生成一遍",
    context: {
      ...baseInput().context,
      selectedAsset: {
        assetEntityId: "50000000-0000-4000-8000-000000000006",
        mediaId: "50000000-0000-4000-8000-000000000007",
        mediaKind: "audio",
      },
    },
  });
  assert.equal(decision.decision, "operation");
  if (decision.decision === "operation") {
    assert.equal(decision.operationType, "edit");
    assert.equal(decision.mediaKind, "audio");
    assert.equal(decision.requestedVoiceGender, "male");
  }
});

function baseInput(): GenerationIntentInterpreterInput {
  return {
    actorId: "50000000-0000-4000-8000-000000000001",
    message: "生成 8 秒 720p 无声视频",
    context: {
      projectId: "50000000-0000-4000-8000-000000000002",
      shotId: "50000000-0000-4000-8000-000000000003",
      referenceMediaIds: [],
    },
    tiers: [tier()],
  };
}

function tier(): GenerationOrchestrationTier {
  return {
    tierId: "vid-public",
    mediaKind: "video",
    providerAccount: "ark",
    providerLabel: "火山方舟",
    modelLabel: "已核价视频模型",
    displayName: "视频 720p · 8秒",
    isDefault: true,
    model: "internal-provider-model",
    quantity: 1,
    parameters: {
      resolution: "720p",
      ratio: "9:16",
      durationSeconds: 8,
      watermark: false,
      generateAudio: false,
    },
    pricingRule: {
      id: "50000000-0000-4000-8000-000000000010",
      provider: "ark",
      model: "internal-provider-model",
      mediaKind: "video",
      billingUnit: "second",
      unitPriceFen: 80,
      metadata: {},
    },
  };
}
