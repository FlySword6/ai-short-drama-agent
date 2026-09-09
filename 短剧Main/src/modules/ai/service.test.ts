import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import type { EmbeddingClient } from "../../integrations/embeddingClient.js";
import { VectorProjectionUnavailableError } from "../../services/searchService.js";
import { AppError, ExternalServiceError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import type { ProjectAccessRecord } from "../project-access/types.js";
import { generationDefaultStrategies, projects, promptDefaultTemplates, promptTemplates } from "../../db/schema.js";
import { DEFAULT_IMAGE_PROMPT_TEMPLATE, DEFAULT_VIDEO_PROMPT_TEMPLATE } from "../generation/promptCompiler.js";
import { AiDailyCallLimitError } from "./repository.js";
import {
  AI_PURPOSE_TIMEOUT_OVERRIDES,
  aiGatewayConfiguration,
  AiGatewayService,
  AiProductionAssistService,
  ArkAiCompletionProvider,
  DatabaseAssetMatchRetriever,
  DatabaseAiProductionAssistAccess,
  type AiGatewayConfiguration,
} from "./service.js";
import { ArkChatClient, type ArkFetch } from "../../integrations/arkClient.js";
import { AiCompletionValidationError } from "./types.js";
import type {
  AiCallRepository,
  AiCompletionProvider,
  AiProviderCompletion,
  AiProductionAssistAccessPort,
  AssetMatchCandidate,
  AssetMatchRetriever,
} from "./types.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const fixedNow = new Date("2026-07-23T10:00:00.000Z");

const configuredGateway: AiGatewayConfiguration = {
  enabled: true,
  apiKeyConfigured: true,
  dailyCallLimit: 10,
  defaultModel: "doubao-test",
  embeddingModel: "doubao-embedding-test",
  promptModels: {
    quality: "doubao-quality-test",
    fast: "doubao-fast-test",
  },
};

function candidate(overrides: Partial<AssetMatchCandidate> = {}): AssetMatchCandidate {
  return {
    candidateId: "asset_entities:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    assetVariantId: null,
    assetKind: "image",
    role: "character_identity",
    usageMode: "reference",
    name: "雨夜男主角色板",
    description: "冷色调雨夜中的黑发男主",
    ...overrides,
  };
}

function completion(content: string, overrides: Partial<AiProviderCompletion> = {}): AiProviderCompletion {
  return {
    content,
    model: "doubao-test",
    inputTokens: 31,
    outputTokens: 47,
    durationMs: 125,
    ...overrides,
  };
}

function repository(overrides: Partial<AiCallRepository> = {}) {
  const calls: {
    reserve: unknown[];
    complete: unknown[];
    fail: unknown[];
  } = { reserve: [], complete: [], fail: [] };
  const value: AiCallRepository = {
    reserve: async (input) => {
      calls.reserve.push(input);
      return { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    },
    complete: async (input) => { calls.complete.push(input); },
    fail: async (input) => { calls.fail.push(input); },
    ...overrides,
  };
  return { value, calls };
}

function provider(result: AiProviderCompletion | Error) {
  const calls: Array<{
    system: string;
    prompt: string;
    model?: string;
    thinking?: "enabled" | "disabled" | "auto";
    maxTokens: number;
  }> = [];
  const value: AiCompletionProvider = {
    complete: async (input) => {
      calls.push(input);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { value, calls };
}

function embedding(result: number[] | Error) {
  const calls: string[] = [];
  const value: EmbeddingClient = {
    embedImage: async () => [0.1, 0.2], embedText: async (text) => {
      calls.push(text);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { value, calls };
}

function access(overrides: Partial<AiProductionAssistAccessPort> = {}) {
  const calls: {
    project: Array<{ actor: ProjectAccessActor; projectId: string }>;
    candidates: Array<{ actorId: string; candidates: AssetMatchCandidate[] }>;
  } = { project: [], candidates: [] };
  const value: AiProductionAssistAccessPort = {
    assertProjectCreate: async (actor, projectId) => { calls.project.push({ actor, projectId }); },
    assertRelatedObjectAccess: async () => undefined,
    resolvePromptDraftAssets: async (_currentActorId, assets) => assets.map((asset) => ({
      ...asset,
      name: "数据库资产",
      type: "character",
      description: "来自数据库的资产描述",
      usageMode: "reference",
    })),
    filterVisibleCandidates: async (currentActorId, candidates) => {
      calls.candidates.push({ actorId: currentActorId, candidates });
      return candidates;
    },
    getProjectImageStyle: async () => ({ styleDescription: null }),
    getProjectImageTemplate: async () => null,
    getProjectVideoStyle: async () => ({ styleDescription: null }),
    getProjectVideoTemplate: async () => null,
    ...overrides,
  };
  return { value, calls };
}

function gateway(
  callRepository: AiCallRepository,
  completionProvider: AiCompletionProvider,
  configuration: AiGatewayConfiguration = configuredGateway,
  embeddingClient?: EmbeddingClient,
) {
  return new AiGatewayService(callRepository, completionProvider, configuration, () => fixedNow, embeddingClient);
}

function matcher(candidates: AssetMatchCandidate[], retrievalMode: "hybrid" | "structured_fallback" = "hybrid") {
  const calls: Array<{ actorId: string; description: string }> = [];
  const value: AssetMatchRetriever = {
    retrieve: async (currentActorId, description) => {
      calls.push({ actorId: currentActorId, description });
      return { candidates, retrievalMode };
    },
  };
  return { value, calls };
}

const aiDraftText = "男主站在雨夜巷口，街灯侧逆光与细雨反光，冷蓝灰为主保留暖黄街灯，中景缓慢推进胶片颗粒感；不要字幕、水印、额外人物或畸形手部。";

test("网关关闭时返回 503，且不会预留审计记录或调用模型", async () => {
  const audit = repository();
  const ark = provider(completion("{}"));
  const service = gateway(audit.value, ark.value, { ...configuredGateway, enabled: false });

  await assert.rejects(
    service.complete({ actorId, purpose: "prompt_draft", system: "system", prompt: "prompt", maxTokens: 800 }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 503
      && error.code === "ai_gateway_disabled",
  );
  assert.equal(audit.calls.reserve.length, 0);
  assert.equal(ark.calls.length, 0);
});

test("缺少 Ark 凭据时在预留额度前返回 503", async () => {
  const audit = repository();
  const ark = provider(completion("{}"));
  const service = gateway(audit.value, ark.value, { ...configuredGateway, apiKeyConfigured: false });

  await assert.rejects(
    service.complete({ actorId, purpose: "prompt_draft", system: "system", prompt: "prompt", maxTokens: 800 }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 503
      && error.code === "ai_gateway_not_configured"
      && error.message === "使用 AI 辅助没成：服务暂未准备好，请联系管理员处理。",
  );
  assert.equal(audit.calls.reserve.length, 0);
  assert.equal(ark.calls.length, 0);
});

test("向量模型或凭据未配置时不预留审计也不调用向量服务", async (context) => {
  const cases = [
    { name: "模型缺失", configuration: { ...configuredGateway, embeddingModel: null } },
    { name: "凭据缺失", configuration: { ...configuredGateway, apiKeyConfigured: false } },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const audit = repository();
      const ark = provider(completion("{}"));
      const vector = embedding([0.1, 0.2]);
      const service = gateway(audit.value, ark.value, scenario.configuration, vector.value);
      await assert.rejects(
        service.embeddingClient(actorId).embedText("雨夜巷口"),
        (error: unknown) => error instanceof AppError
          && error.statusCode === 503
          && error.code === "ai_gateway_not_configured",
      );
      assert.equal(audit.calls.reserve.length, 0);
      assert.equal(vector.calls.length, 0);
      assert.equal(ark.calls.length, 0);
    });
  }
});

test("向量调用通过网关预留、完成并单独记审计", async () => {
  const audit = repository();
  const ark = provider(completion("{}"));
  const vector = embedding([0.1, 0.2, 0.3]);
  const service = gateway(audit.value, ark.value, configuredGateway, vector.value);

  const result = await service.embeddingClient(actorId).embedText("雨夜巷口");

  assert.deepEqual(result, [0.1, 0.2, 0.3]);
  assert.deepEqual(vector.calls, ["雨夜巷口"]);
  assert.equal(ark.calls.length, 0);
  assert.deepEqual(audit.calls.reserve, [{
    actorId,
    purpose: "asset_match_embedding",
    provider: "ark",
    requestedModel: "doubao-embedding-test",
    projectId: null,
    relatedObject: null,
    dailyLimit: 10,
    now: fixedNow,
  }]);
  assert.equal(audit.calls.complete.length, 1);
  assert.deepEqual(audit.calls.complete[0], {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    model: "doubao-embedding-test",
    inputTokens: null,
    outputTokens: null,
    durationMs: (audit.calls.complete[0] as { durationMs: number }).durationMs,
    now: fixedNow,
  });
  assert.ok((audit.calls.complete[0] as { durationMs: number }).durationMs >= 0);
  assert.equal(audit.calls.fail.length, 0);
});

test("向量调用达到每日限额时不触发实际嵌入", async () => {
  const audit = repository({ reserve: async () => { throw new AiDailyCallLimitError(); } });
  const ark = provider(completion("{}"));
  const vector = embedding([0.1, 0.2]);
  const service = gateway(audit.value, ark.value, configuredGateway, vector.value);

  await assert.rejects(
    service.embeddingClient(actorId).embedText("雨夜巷口"),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 429
      && error.code === "ai_daily_limit_exceeded",
  );
  assert.equal(vector.calls.length, 0);
  assert.equal(audit.calls.complete.length, 0);
  assert.equal(audit.calls.fail.length, 0);
});

test("向量服务失败时标记同一审计记录为失败", async () => {
  const audit = repository();
  const ark = provider(completion("{}"));
  const vector = embedding(new Error("embedding offline"));
  const service = gateway(audit.value, ark.value, configuredGateway, vector.value);

  await assert.rejects(service.embeddingClient(actorId).embedText("雨夜巷口"), /embedding offline/);

  assert.equal(audit.calls.reserve.length, 1);
  assert.equal(audit.calls.complete.length, 0);
  assert.equal(audit.calls.fail.length, 1);
  assert.deepEqual(audit.calls.fail[0], {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    errorCode: "provider_error",
    model: "doubao-embedding-test",
    inputTokens: null,
    outputTokens: null,
    durationMs: (audit.calls.fail[0] as { durationMs: number }).durationMs,
    now: fixedNow,
  });
  assert.ok((audit.calls.fail[0] as { durationMs: number }).durationMs >= 0);
});

test("向量审计失败时 fail-closed，不把 running 记录静默吞掉", async () => {
  let failCalls = 0;
  const audit = repository({
    fail: async () => {
      failCalls += 1;
      throw new Error("database write unavailable");
    },
  });
  const ark = provider(completion("{}"));
  const vector = embedding(new Error("embedding offline"));
  const service = gateway(audit.value, ark.value, configuredGateway, vector.value);

  await assert.rejects(
    service.embeddingClient(actorId).embedText("雨夜巷口"),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 503
      && error.code === "ai_audit_unavailable",
  );
  assert.equal(failCalls, 1);
  assert.equal(vector.calls.length, 1);
});

test("每日限额达到时返回 429，且不会调用模型", async () => {
  const audit = repository({ reserve: async () => { throw new AiDailyCallLimitError(); } });
  const ark = provider(completion("{}"));
  const service = gateway(audit.value, ark.value);

  await assert.rejects(
    service.complete({ actorId, purpose: "prompt_draft", system: "system", prompt: "prompt", maxTokens: 800 }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 429
      && error.code === "ai_daily_limit_exceeded",
  );
  assert.equal(ark.calls.length, 0);
  assert.equal(audit.calls.complete.length, 0);
  assert.equal(audit.calls.fail.length, 0);
});

test("真实模型完成后只记录用量和耗时，不记录提示词或输出正文", async () => {
  const audit = repository();
  const ark = provider(completion("{\"ok\":true}"));
  const service = gateway(audit.value, ark.value);

  const result = await service.complete({
    actorId,
    purpose: "prompt_draft",
    system: "system-only",
    prompt: "private-prompt",
    projectId: "22222222-2222-4222-8222-222222222222",
    relatedObject: { type: "shot", id: "G01" },
    maxTokens: 800,
  });

  assert.equal(result.model, "doubao-test");
  assert.deepEqual(audit.calls.reserve, [{
    actorId,
    purpose: "prompt_draft",
    provider: "ark",
    requestedModel: "doubao-test",
    projectId: "22222222-2222-4222-8222-222222222222",
    relatedObject: { type: "shot", id: "G01" },
    dailyLimit: 10,
    now: fixedNow,
  }]);
  assert.deepEqual(audit.calls.complete, [{
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    model: "doubao-test",
    inputTokens: 31,
    outputTokens: 47,
    durationMs: 125,
    now: fixedNow,
  }]);
  assert.equal(audit.calls.fail.length, 0);
  assert.deepEqual(ark.calls, [{ system: "system-only", prompt: "private-prompt", model: "doubao-test", maxTokens: 800 }]);
});

test("拆解阶段②用途带网关下发的超时覆盖;调用方自己传的超时被作废(#282)", async () => {
  const audit = repository();
  const captured: Array<{ timeoutMs?: number }> = [];
  const recordingProvider: AiCompletionProvider = {
    complete: async (input) => {
      captured.push({ timeoutMs: input.timeoutMs });
      return completion("ok");
    },
  };
  const service = gateway(audit.value, recordingProvider);

  await service.complete({
    actorId,
    purpose: "script_breakdown_storyboard",
    system: "system",
    prompt: "prompt",
    maxTokens: 800,
    timeoutMs: 999,
  });

  assert.deepEqual(captured, [{ timeoutMs: AI_PURPOSE_TIMEOUT_OVERRIDES.script_breakdown_storyboard }],
    "调用方传的 999 被网关作废,换成用途级超时;超时归网关按用途决定");
});

test("Ark 单请求超时映射成可重试的 ai_request_timeout,不冒成「服务不可用」(#282)", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit): Promise<never> => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      });
    });
    throw new Error("unreachable");
  }) as unknown as ArkFetch;
  const audit = repository();
  const arkProvider = new ArkAiCompletionProvider(
    new ArkChatClient("test-key", "doubao-test", "https://ark.example.invalid/api/v3", fetchImpl, 5),
  );
  const service = gateway(audit.value, arkProvider);

  await assert.rejects(
    service.complete({ actorId, purpose: "prompt_draft", system: "system", prompt: "prompt", maxTokens: 800 }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 504
      && error.code === "ai_request_timeout"
      && error.retryable
      && error.message === "AI 处理超时了，这次没有完成，请稍后重试。",
  );
  assert.equal(audit.calls.fail.length, 1);
  assert.equal((audit.calls.fail[0] as { errorCode: string }).errorCode, "provider_timeout");
});

test("结构校验失败记 failed 审计，且内部异常序列化不泄露 provider 正文", async () => {
  const marker = "PRIVATE-PROVIDER-CONTENT";
  const audit = repository();
  const ark = provider(completion(`{"value":"${marker}"}`));
  const service = gateway(audit.value, ark.value);
  let caught: unknown;

  await assert.rejects(
    service.completeValidated(
      { actorId, purpose: "script_breakdown_enrich", system: "system", prompt: "prompt", maxTokens: 800 },
      (result) => {
        throw new AiCompletionValidationError("schema_validation_failed", "模型返回结构不符合约定", result);
      },
    ),
    (error: unknown) => {
      caught = error;
      return error instanceof AiCompletionValidationError
        && error.code === "schema_validation_failed";
    },
  );

  assert.equal(audit.calls.complete.length, 0);
  assert.equal(audit.calls.fail.length, 1);
  assert.deepEqual(audit.calls.fail[0], {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    errorCode: "schema_validation_failed",
    model: "doubao-test",
    inputTokens: 31,
    outputTokens: 47,
    durationMs: 0,
    now: fixedNow,
  });
  assert.ok(!JSON.stringify(caught).includes(marker));
});

test("模型失败时将同一调用标为失败并保留错误码", async () => {
  const audit = repository();
  const ark = provider(new Error("Ark unavailable"));
  const service = gateway(audit.value, ark.value);

  await assert.rejects(
    service.complete({ actorId, purpose: "prompt_draft", system: "system", prompt: "prompt", maxTokens: 800 }),
    (error: unknown) => error instanceof AppError
      && error.code === "ai_service_unavailable"
      && error.message === "AI 暂时没有完成这次处理，请稍后重试。"
      && error.cause instanceof Error
      && error.cause.message === "Ark unavailable",
  );
  assert.equal(audit.calls.complete.length, 0);
  assert.deepEqual(audit.calls.fail, [{
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    errorCode: "provider_error",
    durationMs: 0,
    now: fixedNow,
  }]);
});

test("文字调用审计失败时 fail-closed，不把审计故障伪装成模型失败", async () => {
  let failCalls = 0;
  const audit = repository({
    fail: async () => {
      failCalls += 1;
      throw new Error("database write unavailable");
    },
  });
  const ark = provider(new Error("Ark unavailable"));
  const service = gateway(audit.value, ark.value);

  await assert.rejects(
    service.complete({ actorId, purpose: "prompt_draft", system: "system", prompt: "prompt", maxTokens: 800 }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 503
      && error.code === "ai_audit_unavailable",
  );
  assert.equal(failCalls, 1);
  assert.equal(ark.calls.length, 1);
});

test("提示词草稿原样返回 AI 文本，supplement 追加在末尾", async () => {
  const audit = repository();
  const ark = provider(completion(aiDraftText));
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, access().value);

  const result = await production.createPromptDraft(actorId, {
    mediaKind: "image",
    description: "雨夜中男主停在巷口回望",
    selectedAssets: [{ assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "男主角色板", type: "角色", usageMode: "reference" }],
    supplement: "图片风格：写实电影质感",
  });

  assert.deepEqual(result, {
    autoPrompt: aiDraftText,
    supplement: "图片风格：写实电影质感",
    promptText: `${aiDraftText}\n图片风格：写实电影质感`,
    modelKey: "quality",
  });
  assert.equal(ark.calls.length, 1);
  assert.match(ark.calls[0]?.prompt ?? "", /雨夜中男主停在巷口回望/);
  assert.match(ark.calls[0]?.prompt ?? "", /不要输出 JSON/);
  assert.equal(ark.calls[0]?.model, "doubao-quality-test");
  assert.equal(ark.calls[0]?.thinking, "disabled");
  assert.equal(ark.calls[0]?.maxTokens, 1_800);
  assert.equal(audit.calls.complete.length, 1);
});

test("提示词模型目录暴露稳定两档，未配置档位不能伪装可用", () => {
  const completeCatalog = gateway(repository().value, provider(completion("{}")).value).promptModelCatalog();
  assert.deepEqual(completeCatalog.items.map((item) => ({
    key: item.key,
    available: item.available,
    isDefault: item.isDefault,
  })), [
    { key: "quality", available: true, isDefault: true },
    { key: "fast", available: true, isDefault: false },
  ]);

  const qualityOnly = gateway(
    repository().value,
    provider(completion("{}")).value,
    { ...configuredGateway, promptModels: { quality: "quality-only", fast: null } },
  );
  assert.equal(qualityOnly.promptModelCatalog().items.find((item) => item.key === "fast")?.available, false);
  assert.throws(
    () => qualityOnly.resolvePromptModel("fast", "quality"),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 422
      && error.code === "ai_model_unavailable"
      && !/Ark|HTTP|provider/i.test(error.message),
  );
  assert.throws(
    () => qualityOnly.resolvePromptModel("client-supplied-model", "quality"),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 422
      && error.code === "ai_model_unavailable"
      && !/Ark|HTTP|provider/i.test(error.message),
  );
});

test("生产模型目录只接受 Ark allowlist，MiniMax 旧开关也不能恢复私人账户直连", () => {
  const legacyPrivateMiniMaxEnabled = { minimaxDirectApiEnabled: true };
  const legacyPrivateMiniMaxDisabled = { minimaxDirectApiEnabled: false };
  const configuration = aiGatewayConfiguration({
    aiGatewayEnabled: true,
    aiDailyCallLimit: 10,
    arkApiKeyConfigured: true,
    arkLlmModels: [
      "doubao-seed-2-0-mini-260428",
      "doubao-seed-2-0-pro-260215",
    ].join(","),
    arkLlmModel: undefined,
    doubaoLlmModel: undefined,
    doubaoEmbeddingModel: undefined,
    aiPromptLlmQualityModel: undefined,
    aiPromptLlmFastModel: undefined,
    ...legacyPrivateMiniMaxEnabled,
    minimaxApiKey: "configured-test-key",
    minimaxLlmModels: "MiniMax-M3",
  });
  assert.equal(configuration.promptModelBindings?.length, 2);
  assert.equal(configuration.defaultModel, "doubao-seed-2-0-mini-260428");
  for (const binding of configuration.promptModelBindings ?? []) {
    assert.match(binding.key, /^model-[0-9a-f]{24}$/);
    assert.doesNotMatch(binding.key, /ark|minimax|doubao|seed|m3/i);
    assert.equal(binding.providerId, "ark");
  }

  const keyOnly = aiGatewayConfiguration({
    aiGatewayEnabled: true,
    aiDailyCallLimit: 10,
    arkApiKeyConfigured: false,
    arkLlmModels: undefined,
    arkLlmModel: undefined,
    doubaoLlmModel: undefined,
    doubaoEmbeddingModel: undefined,
    aiPromptLlmQualityModel: undefined,
    aiPromptLlmFastModel: undefined,
    ...legacyPrivateMiniMaxEnabled,
    minimaxApiKey: "configured-test-key",
    minimaxLlmModels: undefined,
  });
  assert.deepEqual(keyOnly.promptModelBindings, []);
  assert.equal(keyOnly.defaultModel, null);
  assert.equal(keyOnly.apiKeyConfigured, false);

  const keyOnlyWithUnrelatedArkNames = aiGatewayConfiguration({
    aiGatewayEnabled: true,
    aiDailyCallLimit: 10,
    arkApiKeyConfigured: false,
    arkLlmModels: "doubao-seed-2-0-mini-260428",
    arkLlmModel: "doubao-seed-2-0-mini-260428",
    doubaoLlmModel: "doubao-seed-2-0-pro-260215",
    doubaoEmbeddingModel: undefined,
    aiPromptLlmQualityModel: "doubao-seed-2-0-mini-260428",
    aiPromptLlmFastModel: undefined,
    ...legacyPrivateMiniMaxEnabled,
    minimaxApiKey: "configured-test-key",
    minimaxLlmModels: undefined,
  });
  assert.equal(keyOnlyWithUnrelatedArkNames.apiKeyConfigured, false);
  assert.equal(keyOnlyWithUnrelatedArkNames.defaultModel, null);

  const privateDirectDisabled = aiGatewayConfiguration({
    aiGatewayEnabled: true,
    aiDailyCallLimit: 10,
    arkApiKeyConfigured: false,
    arkLlmModels: undefined,
    arkLlmModel: undefined,
    doubaoLlmModel: undefined,
    doubaoEmbeddingModel: undefined,
    aiPromptLlmQualityModel: undefined,
    aiPromptLlmFastModel: undefined,
    ...legacyPrivateMiniMaxDisabled,
    minimaxApiKey: "private-account-key-must-stay-inert",
    minimaxLlmModels: "MiniMax-M3",
  });
  assert.deepEqual(privateDirectDisabled.promptModelBindings, []);
  assert.equal(privateDirectDisabled.apiKeyConfigured, false);
});

test("公开模型标签来自产品白名单，不能从 Endpoint ID 或部署 UUID 派生", () => {
  const internalEndpoint = "ep-20260804-internal-endpoint-550e8400-e29b-41d4-a716-446655440000";
  const configuration = aiGatewayConfiguration({
    aiGatewayEnabled: true,
    aiDailyCallLimit: 10,
    arkApiKeyConfigured: true,
    arkLlmModels: internalEndpoint,
    arkLlmModel: undefined,
    doubaoLlmModel: undefined,
    doubaoEmbeddingModel: undefined,
    aiPromptLlmQualityModel: undefined,
    aiPromptLlmFastModel: undefined,
    minimaxApiKey: undefined,
    minimaxLlmModels: undefined,
  });
  const catalog = gateway(
    repository().value,
    provider(completion("{}")).value,
    configuration,
  ).promptModelCatalog();
  const dynamic = catalog.items.find((item) => item.key.startsWith("model-"));
  assert.equal(dynamic?.displayName, "火山方舟 · 部署模型 1");
  assert.equal(dynamic?.modelLabel, "部署模型 1");
  assert.doesNotMatch(JSON.stringify(dynamic), /ep-|20260804|internal|550e8400/i);
});

test("公司文字通道将已登记的 DeepSeek 模型展示为产品名，其他模型维持现有回退", () => {
  const configuration = aiGatewayConfiguration({
    aiGatewayEnabled: true,
    aiDailyCallLimit: 10,
    arkApiKeyConfigured: true,
    arkLlmModels: "doubao-seed-2-1-pro-260628",
    arkLlmModel: "doubao-seed-2-1-pro-260628",
    doubaoLlmModel: "doubao-seed-2-1-pro-260628",
    doubaoEmbeddingModel: undefined,
    aiPromptLlmQualityModel: "doubao-seed-2-1-pro-260628",
    aiPromptLlmFastModel: undefined,
    minimaxApiKey: undefined,
    minimaxLlmModels: undefined,
    colBaseUrl: "https://company-gateway.example.invalid",
    colApiKeyConfigured: true,
    colTextModels: "deepseek-v4-flash-ga-260731,unmapped-model",
    colScriptBreakdownModel: "deepseek-v4-flash-ga-260731",
    colPromptDraftModel: "deepseek-v4-flash-ga-260731",
    colPromptTranslateModel: "unmapped-model",
  });
  const catalog = gateway(
    repository().value,
    provider(completion("{}")).value,
    configuration,
  ).promptModelCatalog();

  // 公司通道配齐了也不会顶掉火山那一档:目录里两条通道并列，各自标注来源。
  assert.deepEqual(catalog.items.filter((item) => item.key.startsWith("model-")).map((item) => ({
    displayName: item.displayName,
    modelLabel: item.modelLabel,
  })), [
    { displayName: "火山方舟 · 豆包 Seed 2.1 Pro", modelLabel: "豆包 Seed 2.1 Pro" },
    { displayName: "公司文字通道 · DeepSeek V4 Flash", modelLabel: "DeepSeek V4 Flash" },
    { displayName: "公司文字通道 · 部署模型 2", modelLabel: "部署模型 2" },
  ]);

  const arkConfiguration = aiGatewayConfiguration({
    aiGatewayEnabled: true,
    aiDailyCallLimit: 10,
    arkApiKeyConfigured: true,
    arkLlmModels: "doubao-seed-2-1-pro-260628",
    arkLlmModel: "doubao-seed-2-1-pro-260628",
    doubaoLlmModel: "doubao-seed-2-1-pro-260628",
    doubaoEmbeddingModel: undefined,
    aiPromptLlmQualityModel: "doubao-seed-2-1-pro-260628",
    aiPromptLlmFastModel: undefined,
    minimaxApiKey: undefined,
    minimaxLlmModels: undefined,
  });
  const arkCatalog = gateway(
    repository().value,
    provider(completion("{}")).value,
    arkConfiguration,
  ).promptModelCatalog();
  assert.equal(arkCatalog.items.find((item) => item.key.startsWith("model-"))?.modelLabel, "豆包 Seed 2.1 Pro");
});

test("翻译走快速模型并分别保留自动段与补充段，调用进入独立审计用途", async () => {
  const audit = repository();
  const ark = provider(completion(JSON.stringify({
    auto: "A black-haired man turns around in a rainy alley.",
    supplement: "Keep @MaleLead identity and costume unchanged.",
  }), { model: "doubao-fast-test" }));
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, access().value);

  const result = await production.translatePrompt(actorId, {
    prompt: {
      auto: "黑发男主在雨夜巷口回望。",
      supplement: "保持 @男主 的身份和服装一致。",
    },
    targetLanguage: "en",
    modelKey: "fast",
  });

  assert.deepEqual(result, {
    translation: {
      auto: "A black-haired man turns around in a rainy alley.",
      supplement: "Keep @MaleLead identity and costume unchanged.",
    },
    promptText: "A black-haired man turns around in a rainy alley.\nKeep @MaleLead identity and costume unchanged.",
    modelKey: "fast",
  });
  assert.equal(ark.calls[0]?.model, "doubao-fast-test");
  assert.equal(ark.calls[0]?.thinking, "disabled");
  assert.equal(ark.calls[0]?.maxTokens, 2_000);
  assert.match(ark.calls[0]?.system ?? "", /保留段落结构.*@资产名/);
  assert.equal((audit.calls.reserve[0] as { purpose: string }).purpose, "prompt_translate");
  assert.equal(audit.calls.complete.length, 1);
});

test("供应商英文故障只进审计与 cause，用户只收到稳定中文业务说明", async () => {
  const audit = repository();
  const ark = provider(new ExternalServiceError("Ark", "chat completion failed with status 503"));
  const service = gateway(audit.value, ark.value);

  await assert.rejects(
    service.complete({
      actorId,
      purpose: "prompt_draft",
      system: "system",
      prompt: "prompt",
      maxTokens: 800,
    }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 502
      && error.code === "ai_service_unavailable"
      && error.message === "AI 暂时没有完成这次处理，请稍后重试。"
      && error.cause instanceof ExternalServiceError,
  );
  assert.equal((audit.calls.fail[0] as { errorCode: string }).errorCode, "external_service_error");
});

test("提示词草稿返回空文本时返回 502，不伪造草稿", async () => {
  const audit = repository();
  const ark = provider(completion("   \n  "));
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, access().value);

  await assert.rejects(
    production.createPromptDraft(actorId, { mediaKind: "image", description: "雨夜", selectedAssets: [] }),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 502
      && error.code === "ai_invalid_response",
  );
  assert.equal(audit.calls.complete.length, 0);
  assert.deepEqual(audit.calls.fail, [{
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    errorCode: "ai_invalid_response",
    model: "doubao-test",
    inputTokens: 31,
    outputTokens: 47,
    durationMs: 0,
    now: fixedNow,
  }]);
});

test("提示词草稿在模型调用前按项目和数据库资产重建上下文", async () => {
  const audit = repository();
  const ark = provider(completion(aiDraftText));
  let relatedChecked = false;
  const guarded = access({
    assertRelatedObjectAccess: async () => { relatedChecked = true; },
    resolvePromptDraftAssets: async () => [{
      assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "数据库真实角色板", type: "character",
      description: "真实数据库描述", usageMode: "reference",
    }],
  });
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, guarded.value);
  await production.createPromptDraft(actorId, {
    mediaKind: "image",
    description: "雨夜", projectId: "22222222-2222-4222-8222-222222222222",
    relatedObject: { type: "shot", id: "33333333-3333-4333-8333-333333333333" },
    selectedAssets: [{ assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "客户端伪造名称", description: "伪造描述" }],
  });
  assert.equal(relatedChecked, true);
  assert.match(ark.calls[0]?.prompt ?? "", /数据库真实角色板/);
  assert.doesNotMatch(ark.calls[0]?.prompt ?? "", /客户端伪造名称/);
});

test("提示词草稿把项目默认图片风格注入创作上下文，显式传入的 visualStyle 优先", async (context) => {
  await context.test("项目默认风格与图片生成模板注入", async () => {
    const audit = repository();
    const ark = provider(completion(aiDraftText));
    const styled = access({
      getProjectImageStyle: async () => ({ styleDescription: "港风黑帮、霓虹夜景、胶片颗粒" }),
      getProjectImageTemplate: async () => ({ source: "project", content: "横构图，主体居中，电影感光线，禁用畸形手部" }),
    });
    const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, styled.value);
    await production.createPromptDraft(actorId, {
      mediaKind: "image",
      description: "雨夜巷口",
      selectedAssets: [],
      projectId: "22222222-2222-4222-8222-222222222222",
    });
    const sent = ark.calls[0]?.prompt ?? "";
    assert.match(sent, /项目默认图片风格（必须体现在输出中/);
    assert.match(sent, /港风黑帮、霓虹夜景、胶片颗粒/);
    assert.match(sent, /项目图片生成模板/);
    assert.match(sent, /横构图，主体居中，电影感光线/);
    assert.doesNotMatch(sent, /未配置/);
  });
  await context.test("未配自定义模板时回落系统默认模板并渲染占位符", async () => {
    const audit = repository();
    const ark = provider(completion(aiDraftText));
    const styled = access({
      getProjectImageStyle: async () => ({ styleDescription: "港风黑帮、霓虹夜景" }),
      getProjectImageTemplate: async () => ({ source: "system_default", content: "片段内容：{{segment_content}}\n角色：{{characters}}\n场景：{{scene}}\n图片风格：{{style_description}}" }),
      resolvePromptDraftAssets: async (_actorId, assets) => assets.map((asset) => ({
        ...asset,
        name: asset.name || "无",
        usageMode: asset.usageMode ?? "reference",
      })),
    });
    const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, styled.value);
    await production.createPromptDraft(actorId, {
      mediaKind: "image",
      description: "雨夜巷口",
      selectedAssets: [{ assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "男主", usageMode: "identity" }],
      projectId: "22222222-2222-4222-8222-222222222222",
    });
    const sent = ark.calls[0]?.prompt ?? "";
    // 占位符用本请求真实值渲染：{{segment_content}}→生产意图，{{characters}}→已选资产，
    // {{style_description}}→项目默认风格，{{scene}} 无值所在行删除。
    // 「角色：角色:男主」前缀重复 = DEFAULT 模板「角色：」前缀 + renderReferenceLanes「角色:」标签，
    // 与生成期 renderProjectPromptTemplate 行为逐字一致。
    assert.match(sent, /片段内容：雨夜巷口/);
    assert.match(sent, /角色：角色:男主/);
    assert.match(sent, /图片风格：港风黑帮、霓虹夜景/);
    assert.doesNotMatch(sent, /\{\{segment_content\}\}/);
    assert.doesNotMatch(sent, /场景：\{\{scene\}\}/);
  });
  await context.test("显式 creativeContext.visualStyle 优先于项目默认风格", async () => {
    const audit = repository();
    const ark = provider(completion(aiDraftText));
    const styled = access({
      getProjectImageStyle: async () => ({ styleDescription: "港风黑帮" }),
    });
    const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, styled.value);
    await production.createPromptDraft(actorId, {
      mediaKind: "image",
      description: "雨夜巷口",
      selectedAssets: [],
      projectId: "22222222-2222-4222-8222-222222222222",
      creativeContext: { visualStyle: "古风水墨" },
    });
    assert.match(ark.calls[0]?.prompt ?? "", /古风水墨/);
    assert.doesNotMatch(ark.calls[0]?.prompt ?? "", /港风黑帮/);
  });
  await context.test("无项目时不查风格与模板", async () => {
    const audit = repository();
    const ark = provider(completion(aiDraftText));
    let styleQueried = false;
    let templateQueried = false;
    const styled = access({
      getProjectImageStyle: async () => { styleQueried = true; return { styleDescription: "不应出现" }; },
      getProjectImageTemplate: async () => { templateQueried = true; return { source: "template", content: "不应出现" }; },
    });
    const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, styled.value);
    await production.createPromptDraft(actorId, {
      mediaKind: "image",
      description: "雨夜巷口",
      selectedAssets: [],
    });
    assert.equal(styleQueried, false);
    assert.equal(templateQueried, false);
    assert.doesNotMatch(ark.calls[0]?.prompt ?? "", /不应出现/);
    assert.match(ark.calls[0]?.prompt ?? "", /未配置/);
  });
});

test("项目上下文先校验创作权限，未授权时不调用模型也不写 AI 审计", async (context) => {
  const cases = [
    { name: "普通非成员", error: new NotFoundError("项目不存在或你没有访问权限"), status: 404 },
    { name: "只读成员", error: new ForbiddenError("你没有在该项目中执行此操作的权限"), status: 403 },
  ];
  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const audit = repository();
      const ark = provider(completion(JSON.stringify({})));
      let relatedChecked = false;
      const projectAccess = access({
        assertProjectCreate: async () => { throw scenario.error; },
        assertRelatedObjectAccess: async () => { relatedChecked = true; },
      });
      const production = new AiProductionAssistService(
        gateway(audit.value, ark.value),
        matcher([]).value,
        projectAccess.value,
      );
      await assert.rejects(
        production.createPromptDraft(actorId, {
          mediaKind: "image",
          description: "雨夜巷口",
          selectedAssets: [],
          projectId: "22222222-2222-4222-8222-222222222222",
          relatedObject: { type: "shot", id: "33333333-3333-4333-8333-333333333333" },
        }),
        (error: unknown) => error instanceof AppError && error.statusCode === scenario.status,
      );
      assert.equal(ark.calls.length, 0);
      assert.equal(audit.calls.reserve.length, 0);
      assert.equal(audit.calls.complete.length, 0);
      assert.equal(audit.calls.fail.length, 0);
      assert.equal(relatedChecked, false, "权限失败前不能查询关联对象，避免泄露项目内容");
    });
  }
});

test("项目上下文草稿复用 ProjectAccess create：非成员隐藏、viewer 拒绝、editor/owner/admin 可创建", async (context) => {
  const otherUserId = "99999999-9999-4999-8999-999999999999";
  const cases: Array<{
    name: string;
    actor: ProjectAccessActor;
    membershipRole: ProjectAccessRecord["membershipRole"];
    expectedStatus?: 404 | 403;
  }> = [
    { name: "普通非成员", actor: { id: actorId, role: "member" }, membershipRole: null, expectedStatus: 404 },
    { name: "viewer", actor: { id: actorId, role: "member" }, membershipRole: "viewer", expectedStatus: 403 },
    { name: "editor", actor: { id: actorId, role: "member" }, membershipRole: "editor" },
    { name: "owner", actor: { id: actorId, role: "member" }, membershipRole: "owner" },
    { name: "admin", actor: { id: actorId, role: "admin" }, membershipRole: null },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const audit = repository();
      const ark = provider(completion(aiDraftText));
      const accessService = new ProjectAccessService({
        findAccessRecord: async () => ({ projectId: "22222222-2222-4222-8222-222222222222", ownerUserId: otherUserId, membershipRole: scenario.membershipRole }),
      });
      const databaseAccess = new DatabaseAiProductionAssistAccess({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
      } as unknown as Database, accessService);
      const production = new AiProductionAssistService(
        gateway(audit.value, ark.value),
        matcher([]).value,
        databaseAccess,
      );

      if (scenario.expectedStatus) {
        await assert.rejects(
          production.createPromptDraft(scenario.actor, { mediaKind: "image", description: "雨夜巷口", selectedAssets: [], projectId }),
          (error: unknown) => error instanceof AppError && error.statusCode === scenario.expectedStatus,
        );
        assert.equal(ark.calls.length, 0);
        assert.equal(audit.calls.reserve.length, 0);
      } else {
        await production.createPromptDraft(scenario.actor, { mediaKind: "image", description: "雨夜巷口", selectedAssets: [], projectId });
        assert.equal(ark.calls.length, 1);
        assert.equal(audit.calls.reserve.length, 1);
      }
    });
  }
});

test("项目上下文在模型调用前校验关联 shot、scene、asset 的项目归属", async (context) => {
  for (const type of ["shot", "scene", "asset"] as const) {
    await context.test(type, async () => {
      const audit = repository();
      const ark = provider(completion(aiDraftText));
      const checked: Array<{ actor: ProjectAccessActor; projectId: string; related: { type: string; id: string } }> = [];
      const guarded = access({
        assertRelatedObjectAccess: async (actor, checkedProjectId, related) => {
          checked.push({ actor, projectId: checkedProjectId, related });
        },
      });
      const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, guarded.value);
      const actor: ProjectAccessActor = { id: actorId, role: "member" };

      await production.createPromptDraft(actor, {
        mediaKind: "image",
        description: "雨夜巷口",
        selectedAssets: [],
        projectId,
        relatedObject: { type, id: "33333333-3333-4333-8333-333333333333" },
      });

      assert.deepEqual(checked, [{
        actor,
        projectId,
        related: { type, id: "33333333-3333-4333-8333-333333333333" },
      }]);
      assert.equal(ark.calls.length, 1);
    });
  }
});

test("服务层限制草稿和匹配输入，超限请求不会触发检索、审计或模型", async () => {
  const audit = repository();
  const ark = provider(completion("{}"));
  const search = matcher([]);
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), search.value, access().value);

  await assert.rejects(
    production.createPromptDraft(actorId, { mediaKind: "image", description: "x".repeat(4_001), selectedAssets: [] }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
  await assert.rejects(
    production.matchAssets(actorId, "x".repeat(2_001)),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
  assert.equal(search.calls.length, 0);
  assert.equal(ark.calls.length, 0);
  assert.equal(audit.calls.reserve.length, 0);
});

test("空候选返回明确空态，不发起二次重排调用", async () => {
  const audit = repository();
  const ark = provider(completion("{\"items\":[]}"));
  const search = matcher([], "structured_fallback");
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), search.value, access().value);

  const result = await production.matchAssets(actorId, "雨夜巷口追逐");

  assert.deepEqual(result, {
    items: [],
    count: 0,
    retrievalMode: "structured_fallback",
    empty: true,
    emptyMessage: "当前可见资产库中没有与这段素材匹配的资产；请先入库或换个描述后重试。",
  });
  assert.equal(search.calls.length, 1);
  assert.equal(ark.calls.length, 0);
  assert.equal(audit.calls.reserve.length, 0);
});

test("网关关闭时不会先做候选召回或触发未审计的嵌入调用", async () => {
  const audit = repository();
  const ark = provider(completion("{}"));
  const search = matcher([candidate()]);
  const production = new AiProductionAssistService(
    gateway(audit.value, ark.value, { ...configuredGateway, enabled: false }),
    search.value,
    access().value,
  );
  await assert.rejects(
    production.matchAssets(actorId, "雨夜巷口"),
    (error: unknown) => error instanceof AppError && error.code === "ai_gateway_disabled",
  );
  assert.equal(search.calls.length, 0);
  assert.equal(ark.calls.length, 0);
  assert.equal(audit.calls.reserve.length, 0);
});

test("资产重排只接受检索白名单，并返回对应资产及一句理由", async () => {
  const selected = candidate();
  const audit = repository();
  const ark = provider(completion(JSON.stringify({
    items: [{ candidate_id: selected.candidateId, reason: "角色造型和雨夜氛围与素材描述一致。" }],
  })));
  const production = new AiProductionAssistService(
    gateway(audit.value, ark.value),
    matcher([selected]).value,
    access().value,
  );

  const result = await production.matchAssets(actorId, "雨夜巷口中的黑发男主");

  assert.deepEqual(result, {
    items: [{
      assetId: selected.assetId,
      assetVariantId: null,
      assetKind: "image",
      role: "character_identity",
      usageMode: "reference",
      name: "雨夜男主角色板",
      description: "冷色调雨夜中的黑发男主",
      reason: "角色造型和雨夜氛围与素材描述一致。",
    }],
    count: 1,
    retrievalMode: "hybrid",
    empty: false,
  });
  assert.equal(audit.calls.reserve.length, 1);
  assert.equal((audit.calls.reserve[0] as { purpose: string }).purpose, "asset_match_rerank");
  assert.equal(ark.calls[0]?.maxTokens, 500);
});

test("候选在送到模型前失去可见性时不调用模型", async () => {
  const audit = repository();
  const ark = provider(completion("{\"items\":[]}"));
  const guarded = access({ filterVisibleCandidates: async () => [] });
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([candidate()]).value, guarded.value);
  const result = await production.matchAssets(actorId, "雨夜巷口");
  assert.equal(ark.calls.length, 0);
  assert.equal(audit.calls.reserve.length, 0);
  assert.equal(result.empty, true);
});

test("模型重排后按当前数据库可见性重验，已失效资产不会返回", async () => {
  const selected = candidate();
  const audit = repository();
  const ark = provider(completion(JSON.stringify({
    items: [{ candidate_id: selected.candidateId, reason: "候选看起来匹配" }],
  })));
  let revalidated = false;
  let visibilityReads = 0;
  const secureAccess = access({
    filterVisibleCandidates: async (_actorId, candidates) => {
      visibilityReads += 1;
      if (visibilityReads === 1) return candidates;
      revalidated = true;
      return [];
    },
  });
  const production = new AiProductionAssistService(
    gateway(audit.value, ark.value),
    matcher([selected]).value,
    secureAccess.value,
  );

  const result = await production.matchAssets(actorId, "雨夜巷口中的黑发男主");

  assert.equal(revalidated, true);
  assert.deepEqual(result, {
    items: [],
    count: 0,
    retrievalMode: "hybrid",
    empty: true,
    emptyMessage: "AI 未从当前候选中找到合适资产；请补充描述或调整资产库。",
  });
  assert.equal(audit.calls.complete.length, 1);
});

test("资产重排拒绝未知候选和重复候选，不把模型幻觉写成推荐", async (context) => {
  const selected = candidate();
  const cases = [
    {
      name: "unknown",
      payload: { items: [{ candidate_id: "asset_entities:unknown", reason: "虚构候选" }] },
    },
    {
      name: "duplicate",
      payload: {
        items: [
          { candidate_id: selected.candidateId, reason: "第一条" },
          { candidate_id: selected.candidateId, reason: "重复条目" },
        ],
      },
    },
  ];

  for (const scenario of cases) {
    await context.test(scenario.name, async () => {
      const audit = repository();
      const ark = provider(completion(JSON.stringify(scenario.payload)));
      const production = new AiProductionAssistService(
        gateway(audit.value, ark.value),
        matcher([selected]).value,
        access().value,
      );
      await assert.rejects(
        production.matchAssets(actorId, "雨夜巷口"),
        (error: unknown) => error instanceof AppError
          && error.statusCode === 502
          && error.code === "ai_invalid_response",
      );
      assert.equal(audit.calls.complete.length, 0);
      assert.equal(audit.calls.fail.length, 1);
      assert.equal((audit.calls.fail[0] as { errorCode: string }).errorCode, "ai_invalid_response");
    });
  }
});

test("AI 资产候选召回语义成功时合并结构化候选，投影故障才降级", async () => {
  const calls: string[] = [];
  const retriever = new DatabaseAssetMatchRetriever({} as Database, {
    hybridSearch: {
      search: async () => {
        calls.push("hybrid");
        return {
          items: [],
          page: 1,
          pageSize: 20,
          hasMore: false,
          diagnostics: {
            status: "no_results",
            lexicalAvailable: true,
            semanticAvailable: true,
            relaxedOnce: false,
          },
        };
      },
    },
  });

  const result = await retriever.retrieve(actorId, "雨夜巷口的黑发男主");

  assert.deepEqual(calls, ["hybrid"]);
  assert.equal(result.retrievalMode, "hybrid");
});

test("AI 资产候选召回仅在向量投影不可用时回落 PostgreSQL", async () => {
  const calls: string[] = [];
  const retriever = new DatabaseAssetMatchRetriever({} as Database, {
    hybridSearch: {
      search: async () => {
        calls.push("hybrid");
        return {
          items: [],
          page: 1,
          pageSize: 20,
          hasMore: false,
          diagnostics: {
            status: "no_results",
            lexicalAvailable: true,
            semanticAvailable: false,
            relaxedOnce: false,
          },
        };
      },
    },
  });
  const result = await retriever.retrieve(actorId, "雨夜巷口");
  assert.deepEqual(calls, ["hybrid"]);
  assert.equal(result.retrievalMode, "structured_fallback");
});

test("资产匹配把 raw-query 语义嵌入交给网关，健康时保留 hybrid", async () => {
  const audit = repository();
  const ark = provider(completion("{}"));
  const vector = embedding([0.1, 0.2]);
  const service = gateway(audit.value, ark.value, configuredGateway, vector.value);
  const calls: string[] = [];
  const retriever = new DatabaseAssetMatchRetriever({} as Database, {
    embeddingForActor: (currentActorId) => service.embeddingClient(currentActorId),
    createHybridSearch: (_currentActorId, gatewayEmbedding) => ({
      search: async (input) => {
        calls.push("hybrid");
        await gatewayEmbedding.embedText(input.query);
        return {
          items: [],
          page: 1,
          pageSize: 20,
          hasMore: false,
          diagnostics: {
            status: "no_results",
            lexicalAvailable: true,
            semanticAvailable: true,
            relaxedOnce: false,
          },
        };
      },
    }),
  });

  const result = await retriever.retrieve(actorId, "雨夜巷口的黑发男主");

  assert.equal(result.retrievalMode, "hybrid");
  assert.deepEqual(calls, ["hybrid"]);
  assert.deepEqual(vector.calls, ["雨夜巷口的黑发男主"]);
  assert.equal(audit.calls.reserve.length, 1);
  assert.equal((audit.calls.reserve[0] as { purpose: string }).purpose, "asset_match_embedding");
  assert.equal(audit.calls.complete.length, 1);
  assert.equal(audit.calls.fail.length, 0);
});

test("资产匹配的向量投影失败时审计失败并回落 PostgreSQL", async () => {
  const audit = repository();
  const ark = provider(completion("{}"));
  const vector = embedding(new VectorProjectionUnavailableError());
  const service = gateway(audit.value, ark.value, configuredGateway, vector.value);
  const calls: string[] = [];
  const retriever = new DatabaseAssetMatchRetriever({} as Database, {
    embeddingForActor: (currentActorId) => service.embeddingClient(currentActorId),
    createHybridSearch: (_currentActorId, gatewayEmbedding) => ({
      search: async (input) => {
        calls.push("hybrid");
        try {
          await gatewayEmbedding.embedText(input.query);
        } catch (error) {
          if (!(error instanceof VectorProjectionUnavailableError)) throw error;
          return {
            items: [],
            page: 1,
            pageSize: 20,
            hasMore: false,
            diagnostics: {
              status: "no_results",
              lexicalAvailable: true,
              semanticAvailable: false,
              relaxedOnce: false,
            },
          };
        }
        return {
          items: [],
          page: 1,
          pageSize: 20,
          hasMore: false,
          diagnostics: {
            status: "no_results",
            lexicalAvailable: true,
            semanticAvailable: true,
            relaxedOnce: false,
          },
        };
      },
    }),
  });

  const result = await retriever.retrieve(actorId, "雨夜巷口");

  assert.equal(result.retrievalMode, "structured_fallback");
  assert.deepEqual(calls, ["hybrid"]);
  assert.equal(vector.calls.length, 1);
  assert.equal(audit.calls.reserve.length, 1);
  assert.equal(audit.calls.complete.length, 0);
  assert.equal(audit.calls.fail.length, 1);
  assert.equal((audit.calls.fail[0] as { model: string }).model, "doubao-embedding-test");
});

test("getProjectImageTemplate 真源顺序：项目模板 > 策略模板 > 平台系统模板 > 代码常量", async (context) => {
  const projectTemplate = "项目自定义图片模板";
  const userTemplate = "用户模板库图片模板";
  const platformTemplate = "# ⚠️ 资产生图提示词规范（平台系统默认）";
  const strategyId = "99999999-9999-4999-8999-999999999999";

  const makeAccess = (rows: Map<object, unknown[]>) => new DatabaseAiProductionAssistAccess(
    {
      select: () => ({
        from: (table: object) => ({
          where: () => ({
            limit: async () => rows.get(table) ?? [],
          }),
        }),
      }),
    } as unknown as Database,
    {} as ProjectAccessService,
  );

  await context.test("项目模板优先：非空即返回，不查策略", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ imagePromptTemplate: projectTemplate }]);
    const result = await makeAccess(rows).getProjectImageTemplate(projectId);
    assert.deepEqual(result, { source: "project", content: projectTemplate });
  });

  await context.test("无策略行回落平台系统模板（prompt_default_templates 表）", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ imagePromptTemplate: null }]);
    rows.set(promptDefaultTemplates, [{ content: platformTemplate }]);
    const result = await makeAccess(rows).getProjectImageTemplate(projectId);
    assert.deepEqual(result, { source: "system_default", content: platformTemplate });
  });

  await context.test("策略行无 prompt_template_id 回落平台系统模板", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ imagePromptTemplate: null }]);
    rows.set(generationDefaultStrategies, [{ parameters: {} }]);
    rows.set(promptDefaultTemplates, [{ content: platformTemplate }]);
    const result = await makeAccess(rows).getProjectImageTemplate(projectId);
    assert.deepEqual(result, { source: "system_default", content: platformTemplate });
  });

  await context.test("策略引用有效模板命中模板库", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ imagePromptTemplate: null }]);
    rows.set(generationDefaultStrategies, [{ parameters: { prompt_template_id: strategyId } }]);
    rows.set(promptTemplates, [{ content: userTemplate }]);
    const result = await makeAccess(rows).getProjectImageTemplate(projectId);
    assert.deepEqual(result, { source: "template", content: userTemplate });
  });

  await context.test("策略引用失效回落平台系统模板并标注 missingTemplateId", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ imagePromptTemplate: null }]);
    rows.set(generationDefaultStrategies, [{ parameters: { prompt_template_id: strategyId } }]);
    rows.set(promptTemplates, []);
    rows.set(promptDefaultTemplates, [{ content: platformTemplate }]);
    const result = await makeAccess(rows).getProjectImageTemplate(projectId);
    assert.deepEqual(result, {
      source: "system_default",
      content: platformTemplate,
      missingTemplateId: strategyId,
    });
  });

  await context.test("平台表缺行终极回落代码常量", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ imagePromptTemplate: null }]);
    rows.set(promptDefaultTemplates, []);
    const result = await makeAccess(rows).getProjectImageTemplate(projectId);
    assert.deepEqual(result, { source: "system_default", content: DEFAULT_IMAGE_PROMPT_TEMPLATE });
  });
});

test("getProjectVideoTemplate 真源顺序：项目模板 > 策略模板(video) > 平台系统视频模板 > 代码常量", async (context) => {
  const projectTemplate = "项目自定义视频模板";
  const userTemplate = "用户模板库视频模板";
  const platformTemplate = "# ⚠️ 短剧分镜视频生成规范（平台系统默认）";
  const strategyId = "99999999-9999-4999-8999-999999999999";

  const makeAccess = (rows: Map<object, unknown[]>) => new DatabaseAiProductionAssistAccess(
    {
      select: () => ({
        from: (table: object) => ({
          where: () => ({
            limit: async () => rows.get(table) ?? [],
          }),
        }),
      }),
    } as unknown as Database,
    {} as ProjectAccessService,
  );

  await context.test("项目视频模板优先：非空即返回，不查策略", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ videoPromptTemplate: projectTemplate }]);
    const result = await makeAccess(rows).getProjectVideoTemplate(projectId);
    assert.deepEqual(result, { source: "project", content: projectTemplate });
  });

  await context.test("无策略行回落平台系统视频模板（prompt_default_templates 表）", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ videoPromptTemplate: null }]);
    rows.set(promptDefaultTemplates, [{ content: platformTemplate }]);
    const result = await makeAccess(rows).getProjectVideoTemplate(projectId);
    assert.deepEqual(result, { source: "system_default", content: platformTemplate });
  });

  await context.test("策略行无 prompt_template_id 回落平台系统视频模板", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ videoPromptTemplate: null }]);
    rows.set(generationDefaultStrategies, [{ parameters: {} }]);
    rows.set(promptDefaultTemplates, [{ content: platformTemplate }]);
    const result = await makeAccess(rows).getProjectVideoTemplate(projectId);
    assert.deepEqual(result, { source: "system_default", content: platformTemplate });
  });

  await context.test("video 策略引用有效模板命中模板库", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ videoPromptTemplate: null }]);
    rows.set(generationDefaultStrategies, [{ parameters: { prompt_template_id: strategyId } }]);
    rows.set(promptTemplates, [{ content: userTemplate }]);
    const result = await makeAccess(rows).getProjectVideoTemplate(projectId);
    assert.deepEqual(result, { source: "template", content: userTemplate });
  });

  await context.test("视频策略引用失效回落平台系统模板并标注 missingTemplateId", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ videoPromptTemplate: null }]);
    rows.set(generationDefaultStrategies, [{ parameters: { prompt_template_id: strategyId } }]);
    rows.set(promptTemplates, []);
    rows.set(promptDefaultTemplates, [{ content: platformTemplate }]);
    const result = await makeAccess(rows).getProjectVideoTemplate(projectId);
    assert.deepEqual(result, {
      source: "system_default",
      content: platformTemplate,
      missingTemplateId: strategyId,
    });
  });

  await context.test("平台表缺行终极回落代码常量", async () => {
    const rows = new Map<object, unknown[]>();
    rows.set(projects, [{ videoPromptTemplate: null }]);
    rows.set(promptDefaultTemplates, []);
    const result = await makeAccess(rows).getProjectVideoTemplate(projectId);
    assert.deepEqual(result, { source: "system_default", content: DEFAULT_VIDEO_PROMPT_TEMPLATE });
  });
});

test("视频草稿按 mediaKind=video 注入项目默认视频风格与视频模板，成文走生视频文案，不碰图片风格/模板", async () => {
  const audit = repository();
  const ark = provider(completion(aiDraftText));
  let imageStyleQueried = false;
  let imageTemplateQueried = false;
  const styled = access({
    getProjectImageStyle: async () => { imageStyleQueried = true; return { styleDescription: "不应出现" }; },
    getProjectImageTemplate: async () => { imageTemplateQueried = true; return { source: "project", content: "不应出现" }; },
    getProjectVideoStyle: async () => ({ styleDescription: "都市夜戏、冷色调、手持运镜" }),
    getProjectVideoTemplate: async () => ({ source: "project", content: "9:16 竖屏，主体特写，短句节奏，禁用闪白" }),
  });
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, styled.value);
  await production.createPromptDraft(actorId, {
    mediaKind: "video",
    description: "雨夜巷口",
    selectedAssets: [],
    projectId: "22222222-2222-4222-8222-222222222222",
  });
  const sent = ark.calls[0]?.prompt ?? "";
  const system = ark.calls[0]?.system ?? "";
  assert.match(sent, /可直接用于生视频的提示词/);
  assert.match(sent, /中文生视频提示词原文/);
  assert.match(sent, /项目默认视频风格（必须体现在输出中/);
  assert.match(sent, /都市夜戏、冷色调、手持运镜/);
  assert.match(sent, /项目视频生成模板/);
  assert.match(sent, /9:16 竖屏，主体特写，短句节奏，禁用闪白/);
  // 2026-08-18 skills 统一：video 草稿 system 按 P6 skill §八 成文分镜提示词规范书写。
  assert.match(system, /按「生效的视频提示词模板」的格式与规范/);
  assert.match(system, /引用资产写 @资产名/);
  assert.match(system, /对白与音效按 Native Audio 分层写进提示词/);
  assert.match(system, /严禁任何字幕，严禁背景音乐/);
  assert.doesNotMatch(system, /美术指导/);
  assert.doesNotMatch(sent, /生图/);
  assert.doesNotMatch(sent, /项目默认图片风格/);
  assert.doesNotMatch(sent, /项目图片生成模板/);
  assert.doesNotMatch(sent, /未配置/);
  assert.equal(imageStyleQueried, false, "video 草稿不查询图片风格");
  assert.equal(imageTemplateQueried, false, "video 草稿不查询图片模板");
});

test("音频草稿按 mediaKind=audio 走对白/旁白写手文案，不注入图片/视频风格与模板，也不查询", async () => {
  const audit = repository();
  const ark = provider(completion(aiDraftText));
  let imageStyleQueried = false;
  let imageTemplateQueried = false;
  let videoStyleQueried = false;
  let videoTemplateQueried = false;
  const styled = access({
    getProjectImageStyle: async () => { imageStyleQueried = true; return { styleDescription: "不应出现" }; },
    getProjectImageTemplate: async () => { imageTemplateQueried = true; return { source: "project", content: "不应出现" }; },
    getProjectVideoStyle: async () => { videoStyleQueried = true; return { styleDescription: "不应出现" }; },
    getProjectVideoTemplate: async () => { videoTemplateQueried = true; return { source: "project", content: "不应出现" }; },
  });
  const production = new AiProductionAssistService(gateway(audit.value, ark.value), matcher([]).value, styled.value);
  const result = await production.createPromptDraft(actorId, {
    mediaKind: "audio",
    name: "男主哀求",
    description: "男主向女主低声认错",
    selectedAssets: [{ assetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "男主", usageMode: "identity" }],
    supplement: "求你原谅我",
    projectId: "22222222-2222-4222-8222-222222222222",
  });
  const sent = ark.calls[0]?.prompt ?? "";
  const system = ark.calls[0]?.system ?? "";
  assert.match(system, /短剧编剧和对白\/旁白写手/);
  assert.match(system, /可直接用于语音合成（TTS）的中文对白\/旁白原文/);
  assert.match(sent, /生产意图\/背景：男主向女主低声认错/);
  assert.match(sent, /对白初稿（请在此基础上润色，保留原意，优化口语自然度与语气）：求你原谅我/);
  assert.match(sent, /说话角色（台词必须符合角色身份与情绪设定）/);
  assert.doesNotMatch(sent, /生图/);
  assert.doesNotMatch(sent, /生视频/);
  assert.doesNotMatch(sent, /项目默认图片风格/);
  assert.doesNotMatch(sent, /项目图片生成模板/);
  assert.doesNotMatch(sent, /项目默认视频风格/);
  assert.doesNotMatch(sent, /项目视频生成模板/);
  assert.equal(imageStyleQueried, false, "audio 草稿不查询图片风格");
  assert.equal(imageTemplateQueried, false, "audio 草稿不查询图片模板");
  assert.equal(videoStyleQueried, false, "audio 草稿不查询视频风格");
  assert.equal(videoTemplateQueried, false, "audio 草稿不查询视频模板");
  assert.equal(result.promptText, `${aiDraftText.trim()}\n求你原谅我`);
});

test("AI 优化草稿把平台系统模板与默认风格注入「传给模型」的 prompt", async () => {
  const audit = repository();
  const ark = provider(completion(aiDraftText));
  const platformTemplate = [
    "# ⚠️ 资产生图提示词规范（每次创建资产时必须同时填写 image_prompt）",
    "融入全局图片风格：{{style_description}}",
    "角色：[详细的AI生图提示词]",
  ].join("\n");
  const production = new AiProductionAssistService(
    gateway(audit.value, ark.value),
    matcher([]).value,
    access({
      getProjectImageStyle: async () => ({ styleDescription: "港风黑帮、霓虹夜景" }),
      getProjectImageTemplate: async () => ({ source: "system_default", content: platformTemplate }),
    }).value,
  );
  const result = await production.createPromptDraft(
    { id: actorId, role: "member" },
    { mediaKind: "image", name: "男主江承", description: "雨夜巷口", selectedAssets: [], projectId },
  );

  assert.equal(ark.calls.length, 1);
  const sent = ark.calls[0]!;
  assert.ok(sent.prompt.includes("本次要生成的内容"), "prompt 以「要生成的内容」分项呈现");
  assert.ok(sent.prompt.includes("- 名称：男主江承"), "前端「名称」独立传给模型并醒目标注");
  assert.ok(sent.prompt.includes("- 画面描述：雨夜巷口"), "画面描述独立成项");
  assert.ok(sent.prompt.includes("项目图片生成模板"), "prompt 含模板段标题");
  assert.ok(sent.prompt.includes("# ⚠️ 资产生图提示词规范（每次创建资产时必须同时填写 image_prompt）"), "传给模型的 prompt 含平台系统模板原文");
  assert.ok(sent.prompt.includes("融入全局图片风格：港风黑帮、霓虹夜景"), "模板内 {{style_description}} 占位符渲染为项目默认风格后传给模型");
  assert.ok(sent.prompt.includes("项目默认图片风格"), "prompt 含风格指令段标题");
  assert.ok(sent.prompt.includes("港风黑帮、霓虹夜景"), "风格内容注入 prompt");
  assert.ok(!sent.prompt.includes("补充备注"), "无 supplement 时不显示补充备注行");
  assert.ok(sent.system.includes("视觉风格与镜头方向是必须落实的画面基调"), "system 含风格强制句");
  assert.equal(result.promptText, aiDraftText.trim());
});
