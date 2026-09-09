import assert from "node:assert/strict";
import test from "node:test";
import { toHttpErrorResponse } from "../../http/errorResponse.js";
import { GenerationError } from "./errors.js";
import {
  configuredArkModelIds,
  configuredGenerationModelFrom,
  createGenerationProviderRegistry,
  requireGenerationRequestConfigured,
} from "./factory.js";
import { openAiCompatibleBaseUrlSha256 } from "./provider/openAiCompatibleImageProvider.js";

test("模型 ID 存在但 API key 缺失时能力登记保持 fail-closed", () => {
  const registry = createGenerationProviderRegistry({
    arkApiKey: undefined,
    arkBaseUrl: "https://ark.example.com/api/v3",
    arkImageModel: "seedream-model-id",
    arkVideoModel: "seedance-model-id",
  });

  const capabilities = registry.listCapabilities();
  assert.equal(capabilities.find((item) => item.id === "seedream-5-pro")?.availability, "unconfigured");
  assert.equal(capabilities.find((item) => item.id === "seedance-2-0")?.availability, "unconfigured");
});

test("API key、适配器和实际模型 ID 同时存在时 Ark 能力才标记已配置", () => {
  const registry = createGenerationProviderRegistry({
    arkApiKey: "test-only-key",
    arkBaseUrl: "https://ark.example.com/api/v3",
    arkImageModel: "seedream-model-id",
    arkVideoModel: "seedance-model-id",
  });

  const capabilities = registry.listCapabilities();
  assert.equal(capabilities.find((item) => item.id === "seedream-5-pro")?.availability, "available");
  assert.equal(capabilities.find((item) => item.id === "seedance-2-0")?.availability, "available");
});

test("Seedance 2.5 专用接入点独立成档：配了 arkVideoModel25 才可用，缺省 fail-closed", () => {
  const endpointModel = "ep-20260807153339-f6bp4";
  const base = {
    arkApiKey: "test-only-key",
    arkBaseUrl: "https://ark.example.com/api/v3",
    arkImageModel: "seedream-model-id",
    arkVideoModel: "seedance-model-id",
  };

  const withoutEndpoint = createGenerationProviderRegistry(base);
  const unconfigured = withoutEndpoint.listCapabilities()
    .find((item) => item.id === "seedance-2-5");
  assert.equal(unconfigured?.availability, "unconfigured");
  assert.equal(unconfigured?.actualModelId, undefined);
  assert.equal(withoutEndpoint.capabilityForModel(endpointModel), undefined);
  assert.throws(
    () => requireGenerationRequestConfigured(
      { mediaKind: "video", model: endpointModel },
      base,
    ),
    /模型与当前配置模型不一致/,
  );

  const withEndpoint = createGenerationProviderRegistry({
    ...base,
    arkVideoModel25: endpointModel,
  });
  const configured = withEndpoint.listCapabilities()
    .find((item) => item.id === "seedance-2-5");
  assert.equal(configured?.availability, "available");
  assert.equal(configured?.providerId, "ark");
  assert.equal(configured?.actualModelId, endpointModel);
  assert.equal(withEndpoint.capabilityForModel(endpointModel)?.id, "seedance-2-5");
  assert.doesNotThrow(() => requireGenerationRequestConfigured(
    { mediaKind: "video", model: endpointModel },
    { ...base, arkVideoModel25: endpointModel },
  ));
  // 2.0 绑定不受 2.5 接入点影响。
  assert.equal(
    withEndpoint.listCapabilities().find((item) => item.id === "seedance-2-0")?.availability,
    "available",
  );
});

test("FABLE-016: MiniMax 私人凭据、allowlist 和旧直连开关都不能恢复运行时路由", () => {
  const privateAccountConfiguration = {
    minimaxApiKey: "private-test-only-key",
    minimaxImageModels: "image-01",
    minimaxVideoModels: "MiniMax-H3",
    minimaxAudioModels: "speech-2.8-turbo",
  };
  const disabled = createGenerationProviderRegistry(privateAccountConfiguration).listCapabilities();
  for (const id of ["minimax-image", "minimax-video-h3", "minimax-voice"]) {
    assert.equal(disabled.find((item) => item.id === id)?.availability, "unconfigured", id);
    assert.equal(
      disabled.find((item) => item.id === id)?.unavailableReason,
      "该供应商未开通公司账户",
      id,
    );
  }
  const legacyEnabledConfiguration = {
    ...privateAccountConfiguration,
    minimaxDirectApiEnabled: true,
  };
  const explicitlyEnabled = createGenerationProviderRegistry(
    legacyEnabledConfiguration,
  ).listCapabilities();
  for (const id of ["minimax-image", "minimax-video-h3", "minimax-voice"]) {
    assert.equal(explicitlyEnabled.find((item) => item.id === id)?.availability, "unconfigured", id);
  }
  assert.equal(configuredGenerationModelFrom(legacyEnabledConfiguration, "image"), undefined);
  assert.equal(configuredGenerationModelFrom(legacyEnabledConfiguration, "video"), undefined);
  assert.throws(
    () => requireGenerationRequestConfigured({
      mediaKind: "image",
      model: "image-01",
    }, legacyEnabledConfiguration, "minimax"),
    (error: unknown) => error instanceof GenerationError
      && error.code === "PROVIDER_COMPANY_ACCOUNT_NOT_ENABLED"
      && error.message === "该供应商未开通公司账户",
  );
});

test("newapi 图片能力要求显式开关、公司网关 URL、凭据和精确模型 alias 全部到位", () => {
  const approvedBaseUrl = "https://newapi.company.example/v1";
  const common = {
    companyProviderAllowlist: ["ark", "newapi"],
    newapiBaseUrl: approvedBaseUrl,
    newapiApprovedBaseUrlSha256: openAiCompatibleBaseUrlSha256(approvedBaseUrl),
    newapiApiKey: "company-test-only-key",
    newapiGptImageModels: "gpt-image-2",
    newapiGeminiImageModels: "gemini-3.1-pro-image",
  };
  for (const incomplete of [
    common,
    { ...common, newapiGenerationEnabled: true, newapiApiKey: undefined },
    { ...common, newapiGenerationEnabled: true, newapiApprovedBaseUrlSha256: undefined },
    { ...common, newapiGenerationEnabled: true, newapiBaseUrl: "http://localhost/v1" },
    { ...common, newapiGenerationEnabled: true, newapiGptImageModels: undefined },
  ]) {
    const capabilities = createGenerationProviderRegistry(incomplete).listCapabilities();
    if (incomplete.newapiGptImageModels === undefined) {
      assert.equal(capabilities.find((item) => item.id === "gpt-image-2")?.availability, "unconfigured");
    } else {
      assert.ok(capabilities
        .filter((item) => item.id === "gpt-image-2" || item.id === "gemini-image")
        .every((item) => item.availability === "unconfigured"));
    }
  }
  const available = createGenerationProviderRegistry({
    ...common,
    newapiGenerationEnabled: true,
  }).listCapabilities();
  assert.deepEqual(
    available
      .filter((item) => item.id === "gpt-image-2" || item.id === "gemini-image")
      .map((item) => [item.id, item.availability, item.providerId, item.actualModelId]),
    [
      ["gpt-image-2", "available", "newapi", "gpt-image-2"],
      ["gemini-image", "available", "newapi", "gemini-3.1-pro-image"],
    ],
  );
  assert.equal(requireGenerationRequestConfigured({
    mediaKind: "image",
    model: "gemini-3.1-pro-image",
  }, {
    ...common,
    newapiGenerationEnabled: true,
  }, "newapi"), "newapi");
  const enabled = {
    ...common,
    newapiGenerationEnabled: true,
  };
  assert.equal(configuredGenerationModelFrom(enabled, "image"), "gpt-image-2");
  assert.equal(configuredGenerationModelFrom({
    ...enabled,
    arkApiKey: "ark-key",
    arkImageModel: "doubao-seedream-5-0-pro-260628",
  }, "image"), "doubao-seedream-5-0-pro-260628");

  const blockedByCompanyAccount = {
    ...enabled,
    companyProviderAllowlist: ["ark"],
  };
  const blockedCapability = createGenerationProviderRegistry(blockedByCompanyAccount)
    .listCapabilities()
    .find((item) => item.id === "gpt-image-2");
  assert.equal(blockedCapability?.availability, "unconfigured");
  assert.equal(blockedCapability?.unavailableReason, "该供应商未开通公司账户");
  assert.equal(configuredGenerationModelFrom(blockedByCompanyAccount, "image"), undefined);
  assert.throws(
    () => requireGenerationRequestConfigured({
      mediaKind: "image",
      model: "gpt-image-2",
    }, blockedByCompanyAccount, "newapi"),
    (error: unknown) => {
      assert.ok(error instanceof GenerationError);
      assert.equal(error.code, "PROVIDER_COMPANY_ACCOUNT_NOT_ENABLED");
      assert.deepEqual(toHttpErrorResponse(error), {
        statusCode: 503,
        body: {
          code: "PROVIDER_COMPANY_ACCOUNT_NOT_ENABLED",
          message: "该供应商未开通公司账户",
          retryable: false,
          details: null,
        },
      });
      return true;
    },
  );

  const unsafe = createGenerationProviderRegistry({
    ...enabled,
    newapiBaseUrl: "https://127.0.0.1/v1",
  }).listCapabilities();
  assert.equal(unsafe.find((item) => item.id === "gpt-image-2")?.availability, "unconfigured");

  for (const invalidAliases of [
    { newapiGptImageModels: "expensive-or-unreviewed-model" },
    { newapiGptImageModels: "gpt-image-2,expensive-or-unreviewed-model" },
    { newapiGeminiImageModels: "gpt-image-2" },
  ]) {
    assert.throws(() => createGenerationProviderRegistry({
      ...enabled,
      ...invalidAliases,
    }), /只允许精确 alias/);
  }
});

test("同一个现有配置字段可显式登记多个 Ark 模型，单值配置保持兼容", () => {
  assert.deepEqual(configuredArkModelIds(" image-a, image-b ,image-a "), ["image-a", "image-b"]);
  const configuration = {
    arkApiKey: "test-only-key",
    arkImageModel: "image-a,image-b",
    arkVideoModel: "video-a,video-b",
  };
  assert.doesNotThrow(() => requireGenerationRequestConfigured({
    mediaKind: "image", model: "image-b",
  }, configuration));
  assert.doesNotThrow(() => requireGenerationRequestConfigured({
    mediaKind: "video", model: "video-b",
  }, configuration));
  assert.throws(() => requireGenerationRequestConfigured({
    mediaKind: "image", model: "image-c",
  }, configuration), /模型与当前配置模型不一致/);
});

test("voice-synthesis 单配置字段登记多个 Seed Audio 模型，缺任一档位模型即 fail-closed", () => {
  const configuration = {
    seedAudioModel: "seed-audio-1.0,seed-audio-1.0-multilingual",
    seedAudioEndpoint: "https://openspeech.bytedance.com/api/v3/tts/create",
    seedAudioApiKey: "test-only-key",
  };
  const registry = createGenerationProviderRegistry(configuration);
  for (const model of ["seed-audio-1.0", "seed-audio-1.0-multilingual"]) {
    const capability = registry.capabilityForModel(model);
    assert.equal(capability?.id, "voice-synthesis");
    assert.equal(capability?.availability, "available");
    assert.equal(capability?.providerId, "openspeech");
    assert.doesNotThrow(() => requireGenerationRequestConfigured({
      mediaKind: "audio",
      model,
      parameters: { format: "mp3" },
    }, configuration));
  }
  assert.equal(configuredGenerationModelFrom(configuration, "audio"), "seed-audio-1.0");
  // 单值配置保持兼容：未登记的多语言档位模型不可用（回归：Lite 音频默认档 503 真因）。
  const single = createGenerationProviderRegistry({
    ...configuration,
    seedAudioModel: "seed-audio-1.0",
  });
  assert.equal(single.capabilityForModel("seed-audio-1.0")?.availability, "available");
  assert.equal(single.capabilityForModel("seed-audio-1.0-multilingual"), undefined);
});

test("价格行供应商必须与 registry 的模型绑定一致，图片参数不会误套音频格式门", () => {
  const configuration = {
    arkApiKey: "test-only-key",
    arkImageModel: "image-a",
  };
  assert.equal(requireGenerationRequestConfigured({
    mediaKind: "image",
    model: "image-a",
    parameters: { size: "1024x1024" },
  }, configuration, "ark"), "ark");
  assert.throws(() => requireGenerationRequestConfigured({
    mediaKind: "image",
    model: "image-a",
  }, configuration, "minimax"), /供应商与当前模型绑定不一致/);
});

test("音频格式不支持时返回可操作的 422 真因，不伪装成服务未配置", () => {
  const configuration = {
    openspeechTtsModel: "audio-model",
    openspeechTtsEndpoint: "https://openspeech.bytedance.com/api/v1/tts",
    openspeechTtsToken: "test-only-token",
    openspeechTtsAppId: "test-only-appid",
  };

  assert.throws(
    () => requireGenerationRequestConfigured({
      mediaKind: "audio",
      model: "audio-model",
      parameters: { format: "wav" },
    }, configuration),
    (error: unknown) => {
      assert.ok(error instanceof GenerationError);
      assert.deepEqual(toHttpErrorResponse(error), {
        statusCode: 422,
        body: {
          code: "INVALID_GENERATION_REQUEST",
          message: "音频隐式标识当前仅支持 MP3，请把音频格式改为 MP3 后重试",
          retryable: false,
          details: null,
        },
      });
      return true;
    },
  );
});
