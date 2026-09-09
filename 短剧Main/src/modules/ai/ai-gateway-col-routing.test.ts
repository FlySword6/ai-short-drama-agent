import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertCompleteColGatewayConfiguration } from "../../config/env.js";
import {
  isCompanyProviderAllowed,
  normalizeCompanyProviderAllowlist,
} from "../../shared/companyProviderPolicy.js";
import { RoutedAiCompletionProvider } from "./routedCompletionProvider.js";
import {
  aiGatewayConfiguration,
  AiGatewayService,
  textModelRoutes,
} from "./service.js";
import type {
  AiCallRepository,
  AiCompletionProvider,
  ReserveAiCallInput,
} from "./types.js";

const ARK_MODELS = ["doubao-seed-2-1-pro-260628", "doubao-seed-2-1-turbo-260628"];
/** 公司通道登记了火山同名的两个模型,外加火山没有的三个。 */
const COL_MODELS = [...ARK_MODELS, "kimi-k3", "qwen3.8-max", "deepseek-v4-pro"];

const arkChannel = {
  arkApiKeyConfigured: true,
  arkLlmModels: ARK_MODELS.join(","),
  arkLlmModel: ARK_MODELS[0],
  doubaoLlmModel: ARK_MODELS[0],
  aiPromptLlmQualityModel: ARK_MODELS[0],
  aiPromptLlmFastModel: ARK_MODELS[1],
} as const;

const noArkChannel = {
  arkApiKeyConfigured: false,
  arkLlmModels: undefined,
  arkLlmModel: undefined,
  doubaoLlmModel: undefined,
  aiPromptLlmQualityModel: undefined,
  aiPromptLlmFastModel: undefined,
} as const;

const colChannel = {
  colBaseUrl: "https://company-gateway.example.invalid",
  colApiKeyConfigured: true,
  colTextModels: COL_MODELS.join(","),
  colScriptBreakdownModel: "doubao-seed-2-1-pro-260628",
  colPromptDraftModel: "kimi-k3",
  colPromptTranslateModel: "qwen3.8-max",
} as const;

function configurationFor(channels: Record<string, unknown>) {
  return aiGatewayConfiguration({
    aiGatewayEnabled: true,
    aiDailyCallLimit: 200,
    doubaoEmbeddingModel: "embedding-model",
    minimaxApiKey: undefined,
    minimaxLlmModels: undefined,
    ...noArkChannel,
    ...channels,
  } as Parameters<typeof aiGatewayConfiguration>[0]);
}

/** 把配置装进真路由器,证明「哪个模型走哪条通道」不是配置里的自述。 */
function routerFor(source: Parameters<typeof textModelRoutes>[0]) {
  const calls: Array<{ providerId: string; model: string }> = [];
  const adapterFor = (providerId: "ark" | "col"): AiCompletionProvider => ({
    async complete(input) {
      calls.push({ providerId, model: input.model ?? "" });
      return {
        content: "{}",
        model: input.model ?? "",
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
      };
    },
  });
  const routes = textModelRoutes(source);
  const modelsOn = (providerId: "ark" | "col") => routes
    .filter((route) => route.providerId === providerId)
    .map((route) => route.model);
  const router = new RoutedAiCompletionProvider([
    ...(modelsOn("ark").length
      ? [{ providerId: "ark" as const, models: modelsOn("ark"), adapter: adapterFor("ark") }]
      : []),
    ...(modelsOn("col").length
      ? [{ providerId: "col" as const, models: modelsOn("col"), adapter: adapterFor("col") }]
      : []),
  ], { companyProviderAllowlist: ["ark", "col"] });
  return { router, calls };
}

function auditingRepository() {
  const reservations: ReserveAiCallInput[] = [];
  const value: AiCallRepository = {
    async reserve(input) {
      reservations.push(input);
      return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    },
    async complete() {},
    async fail() {},
  };
  return { value, reservations };
}

const actorId = "11111111-1111-4111-8111-111111111111";

test("ai-gateway-col-配置缺项会点名键且能力模型必须来自已核验清单", () => {
  assert.throws(
    () => assertCompleteColGatewayConfiguration({
      baseUrlConfigured: true,
      apiKeyConfigured: true,
    }),
    (error: unknown) => error instanceof Error
      && error.message.includes("COL_TEXT_MODELS")
      && error.message.includes("COL_SCRIPT_BREAKDOWN_MODEL")
      && error.message.includes("COL_PROMPT_DRAFT_MODEL")
      && error.message.includes("COL_PROMPT_TRANSLATE_MODEL"),
  );

  assert.throws(
    () => assertCompleteColGatewayConfiguration({
      baseUrlConfigured: true,
      apiKeyConfigured: true,
      textModels: "verified-model",
      scriptBreakdownModel: "unverified-model",
      promptDraftModel: "verified-model",
      promptTranslateModel: "verified-model",
    }),
    /COL_SCRIPT_BREAKDOWN_MODEL 必须列在 COL_TEXT_MODELS 中/,
  );

  assert.doesNotThrow(() => assertCompleteColGatewayConfiguration({
    baseUrlConfigured: true,
    apiKeyConfigured: true,
    textModels: "shared-model",
    scriptBreakdownModel: "shared-model",
    promptDraftModel: "shared-model",
    promptTranslateModel: "shared-model",
  }));

  assert.throws(
    () => assertCompleteColGatewayConfiguration({
      baseUrlConfigured: true,
      apiKeyConfigured: false,
    }),
    /COL_APIKEY/,
  );

  // 「不配公司通道」必须是合法状态,否则火山单通道部署起不来。
  assert.doesNotThrow(() => assertCompleteColGatewayConfiguration({
    baseUrlConfigured: false,
    apiKeyConfigured: false,
  }));
});

test("ai-gateway-col-只配火山时全部文字模型走火山", async () => {
  const configuration = configurationFor(arkChannel);

  assert.deepEqual(textModelRoutes({ ...noArkChannel, ...arkChannel }), [
    { model: ARK_MODELS[0], providerId: "ark" },
    { model: ARK_MODELS[1], providerId: "ark" },
  ]);
  assert.deepEqual(
    configuration.promptModelBindings?.map((binding) => binding.providerId),
    ["ark", "ark"],
  );
  // 有没有配公司通道,不改变火山这边每项能力用哪个模型。
  assert.deepEqual(configuration.purposeModels, {
    prompt_draft: ARK_MODELS[0],
    prompt_translate: ARK_MODELS[1],
    script_breakdown: ARK_MODELS[0],
    script_breakdown_enrich: ARK_MODELS[0],
    script_breakdown_storyboard: ARK_MODELS[0],
  });
  assert.equal(configuration.promptModels?.quality, ARK_MODELS[0]);
  assert.equal(configuration.promptModels?.fast, ARK_MODELS[1]);

  const audit = auditingRepository();
  const { router, calls } = routerFor({ ...noArkChannel, ...arkChannel });
  await new AiGatewayService(audit.value, router, configuration).complete({
    actorId,
    purpose: "script_breakdown_enrich",
    system: "system",
    prompt: "prompt",
    maxTokens: 32,
  });
  assert.deepEqual(calls, [{ providerId: "ark", model: ARK_MODELS[0] }]);
  assert.equal(audit.reservations[0]?.provider, "ark");
});

test("ai-gateway-col-只配公司通道时全部文字模型走公司通道", async () => {
  const configuration = configurationFor(colChannel);

  assert.deepEqual(
    textModelRoutes({ ...noArkChannel, ...colChannel }),
    COL_MODELS.map((model) => ({ model, providerId: "col" })),
  );
  assert.deepEqual(
    configuration.promptModelBindings?.map((binding) => binding.providerId),
    COL_MODELS.map(() => "col"),
  );
  assert.equal(configuration.purposeModels?.script_breakdown_enrich, "doubao-seed-2-1-pro-260628");
  assert.equal(configuration.promptModels?.quality, "kimi-k3");
  assert.equal(configuration.promptModels?.fast, "qwen3.8-max");

  const audit = auditingRepository();
  const { router, calls } = routerFor({ ...noArkChannel, ...colChannel });
  await new AiGatewayService(audit.value, router, configuration).complete({
    actorId,
    purpose: "script_breakdown_enrich",
    system: "system",
    prompt: "prompt",
    maxTokens: 32,
  });
  // 同一个模型 ID:火山缺席时它只能走公司通道。
  assert.deepEqual(calls, [{ providerId: "col", model: "doubao-seed-2-1-pro-260628" }]);
  assert.equal(audit.reservations[0]?.provider, "col");
});

test("ai-gateway-col-两个通道都开时同名模型走火山,火山没有的才走公司通道", async () => {
  const source = { ...noArkChannel, ...arkChannel, ...colChannel };
  const configuration = configurationFor({ ...arkChannel, ...colChannel });

  assert.deepEqual(textModelRoutes(source), [
    { model: "doubao-seed-2-1-pro-260628", providerId: "ark" },
    { model: "doubao-seed-2-1-turbo-260628", providerId: "ark" },
    { model: "kimi-k3", providerId: "col" },
    { model: "qwen3.8-max", providerId: "col" },
    { model: "deepseek-v4-pro", providerId: "col" },
  ]);

  // 公司通道配齐了也不再顶掉火山的默认档:拆解、起草、翻译的默认模型都从火山这边取,
  // 公司通道自己登记的 kimi/qwen 只有被点名时才出场。
  assert.equal(configuration.promptModels?.quality, ARK_MODELS[0]);
  assert.equal(configuration.promptModels?.fast, ARK_MODELS[1]);
  assert.deepEqual(configuration.purposeModels, {
    prompt_draft: ARK_MODELS[0],
    prompt_translate: ARK_MODELS[1],
    script_breakdown: ARK_MODELS[0],
    script_breakdown_enrich: ARK_MODELS[0],
    script_breakdown_storyboard: ARK_MODELS[0],
  });

  const audit = auditingRepository();
  const { router, calls } = routerFor(source);
  const gateway = new AiGatewayService(audit.value, router, configuration);
  for (const purpose of ["script_breakdown_enrich", "prompt_draft", "prompt_translate"] as const) {
    await gateway.complete({ actorId, purpose, system: "system", prompt: "prompt", maxTokens: 32 });
  }
  assert.deepEqual(calls, [
    { providerId: "ark", model: ARK_MODELS[0] },
    { providerId: "ark", model: ARK_MODELS[0] },
    { providerId: "ark", model: ARK_MODELS[1] },
  ]);
  assert.deepEqual(audit.reservations.map((reservation) => reservation.provider), ["ark", "ark", "ark"]);

  // 点名火山没有的模型时才走公司通道,而且不会因为用途默认值在另一条通道上被打回。
  const picked = configuration.promptModelBindings?.find((binding) => binding.model === "kimi-k3");
  assert.equal(picked?.providerId, "col");
  await gateway.complete({
    actorId,
    purpose: "prompt_draft",
    system: "system",
    prompt: "prompt",
    model: picked!.model,
    maxTokens: 32,
  });
  assert.deepEqual(calls.at(-1), { providerId: "col", model: "kimi-k3" });
  assert.equal(audit.reservations.at(-1)?.provider, "col");
});

test("ai-gateway-col-供应商白名单和剧本拆解装配都使用统一网关", () => {
  const allowlist = normalizeCompanyProviderAllowlist(["ark", "col"]);
  assert.equal(isCompanyProviderAllowed("col", allowlist), true);
  assert.equal(isCompanyProviderAllowed("col", normalizeCompanyProviderAllowlist(["ark"])), false);

  const routeSource = readFileSync(
    new URL("../script-breakdown/routes.ts", import.meta.url),
    "utf8",
  );
  assert.match(routeSource, /createAiGatewayService\(db\)/);
  assert.doesNotMatch(routeSource, /new ArkAiCompletionProvider/);
});
