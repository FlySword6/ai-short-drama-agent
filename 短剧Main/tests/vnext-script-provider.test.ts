import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/shared/errors.js";
import { ProviderTransportError } from "../src/shared/providerTransportFailure.js";
import type { AiCompletionRequest } from "../src/modules/ai/types.js";
import {
  AiGatewayScriptDraftProvider,
  FixedScriptDraftProvider,
} from "../src/modules/vnext/script/provider.js";
import { validateShotPlanDraft } from "../src/modules/vnext/shot-plan/schema.js";
import {
  ScriptProviderPartialError,
  ScriptProviderTimeoutError,
  ScriptProviderUnavailableError,
} from "../src/modules/vnext/script/types.js";

const fixedScript = [
  "第1场 夜 外 天台",
  "林岚：你终于来了。",
  "顾川转身望向城市灯火。",
  "第2场 日 内 旧书店",
  "顾川：答案一直在这里。",
].join("\n");

const providerInput = {
  scriptContent: fixedScript,
  actorId: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000003",
};

test("真实 provider 通过审计网关调用指定 purpose 并校验 JSON", async () => {
  const expectedDraft = (await new FixedScriptDraftProvider().analyze(providerInput)).draft;
  let request: AiCompletionRequest | undefined;
  const provider = new AiGatewayScriptDraftProvider({
    stageOutputBudgetFor: async (purpose) => {
      assert.equal(purpose, "script_breakdown_enrich");
      return 12_345;
    },
    complete: async (input) => {
      request = input;
      return {
        content: JSON.stringify(expectedDraft),
        model: "test-model",
        inputTokens: 100,
        outputTokens: 200,
        durationMs: 50,
      };
    },
  });
  const result = await provider.analyze(providerInput);
  assert.deepEqual(result.draft, expectedDraft);
  assert.equal(request?.purpose, "script_breakdown_enrich");
  assert.equal(request?.actorId, providerInput.actorId);
  assert.equal(request?.projectId, undefined, "vNext project ids are not foreign keys in the legacy AI ledger");
  assert.deepEqual(request?.relatedObject, { type: "vnext_script_parse_run", id: providerInput.runId });
  assert.equal(request?.maxTokens, 12_345);
  assert.equal(request?.thinking, "disabled");
});

test("真实 provider 精确映射网关不可用与超时", async () => {
  const unavailable = new AiGatewayScriptDraftProvider(failingGateway(
    new AppError(503, "ai_service_unavailable", "unavailable", true),
  ));
  await assert.rejects(
    unavailable.analyze(providerInput),
    ScriptProviderUnavailableError,
  );

  const timeout = new AiGatewayScriptDraftProvider(failingGateway(
    new AppError(504, "ai_request_timeout", "timeout", true),
  ));
  await assert.rejects(
    timeout.analyze(providerInput),
    ScriptProviderTimeoutError,
  );

  const arkTimeout = new AppError(502, "ai_service_unavailable", "unavailable", true);
  (arkTimeout as Error & { cause?: unknown }).cause = new ProviderTransportError(
    "Ark",
    "timeout",
    120_000,
  );
  await assert.rejects(
    new AiGatewayScriptDraftProvider(failingGateway(arkTimeout)).analyze(providerInput),
    ScriptProviderTimeoutError,
  );
});

test("真实 provider 将非 JSON、截断 JSON 与结构错误映射为 partial", async () => {
  for (const content of [
    "not json",
    '{"schemaVersion":1,"characters":[',
    JSON.stringify({ schemaVersion: 1, characters: [], scenes: [], shots: [], warnings: [] }),
  ]) {
    const provider = new AiGatewayScriptDraftProvider(completingGateway(content));
    await assert.rejects(provider.analyze(providerInput), ScriptProviderPartialError);
  }
});

test("真实 provider 将 warnings 和显式诊断作为带有效草稿的 partial", async () => {
  const draft = validateShotPlanDraft(
    (await new FixedScriptDraftProvider().analyze(providerInput)).draft,
  );
  for (const output of [
    { ...draft, warnings: ["第二场缺少环境音说明"] },
    { ...draft, partialDiagnostics: ["第二场需要人工补齐环境音"] },
  ]) {
    const provider = new AiGatewayScriptDraftProvider(completingGateway(JSON.stringify(output)));
    await assert.rejects(
      provider.analyze(providerInput),
      (error: unknown) => {
        assert.ok(error instanceof ScriptProviderPartialError);
        assert.deepEqual(error.draft, {
          ...draft,
          warnings: "warnings" in output ? output.warnings : [],
        });
        assert.ok(error.details.length > 0);
        assert.match(error.message, /第二场/u);
        return true;
      },
    );
  }
});

test("真实 provider 惰性复用构造时注入的网关工厂", async () => {
  const draft = validateShotPlanDraft(
    (await new FixedScriptDraftProvider().analyze(providerInput)).draft,
  );
  let factoryCalls = 0;
  const provider = new AiGatewayScriptDraftProvider(() => {
    factoryCalls += 1;
    return completingGateway(JSON.stringify(draft));
  });
  await provider.analyze(providerInput);
  await provider.analyze(providerInput);
  assert.equal(factoryCalls, 1);
});

test("固定剧本解析器只作为显式测试替身产出确定草稿", async () => {
  const result = await new FixedScriptDraftProvider().analyze(providerInput);
  const draft = validateShotPlanDraft(result.draft);
  assert.deepEqual(draft.characters.map((item) => item.name), ["林岚", "顾川"]);
  assert.equal(draft.scenes.length, 2);
  assert.ok(draft.shots.length >= 3);
  for (const shot of draft.shots) {
    assert.ok(shot.shotSize);
    assert.ok(shot.cameraMovement);
    assert.ok(shot.action);
    assert.ok(shot.rhythm);
    assert.ok(shot.dialogue);
    assert.ok(shot.sound);
  }
});

test("结构校验拒绝镜头引用不存在的场景", () => {
  assert.throws(() => validateShotPlanDraft({
    schemaVersion: 1,
    characters: [{ key: "character_a", name: "A", description: "角色 A" }],
    scenes: [{ key: "scene_a", title: "场景 A", summary: "场景", position: 0 }],
    shots: [{
      key: "shot_a",
      sceneKey: "scene_missing",
      position: 0,
      shotSize: "全景",
      cameraMovement: "推进",
      action: "走入画面",
      rhythm: "平稳",
      dialogue: "无对白",
      sound: "环境声",
    }],
    warnings: [],
  }));
});

test("结构校验拒绝重复场景位置和同场景重复镜头位置", async () => {
  const draft = validateShotPlanDraft(
    (await new FixedScriptDraftProvider().analyze(providerInput)).draft,
  );
  assert.throws(() => validateShotPlanDraft({
    ...draft,
    scenes: draft.scenes.map((scene, index) => (
      index === 1 ? { ...scene, position: draft.scenes[0]!.position } : scene
    )),
  }));
  assert.throws(() => validateShotPlanDraft({
    ...draft,
    shots: draft.shots.map((shot, index) => (
      index === 1
        ? { ...shot, sceneKey: draft.shots[0]!.sceneKey, position: draft.shots[0]!.position }
        : shot
    )),
  }));
});

function completingGateway(content: string) {
  return {
    stageOutputBudgetFor: async () => 2_048,
    complete: async () => ({
      content,
      model: "test-model",
      inputTokens: null,
      outputTokens: null,
      durationMs: 1,
    }),
  };
}

function failingGateway(error: Error) {
  return {
    stageOutputBudgetFor: async () => 2_048,
    complete: async (): Promise<never> => { throw error; },
  };
}
