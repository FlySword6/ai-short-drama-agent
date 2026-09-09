import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGenerationProviderRegistry,
  effectivePaidBudgetFen,
  generationExecutionEnabled,
  requireAudioGenerationConfigured,
  requireGenerationRequestConfigured,
  requireGenerationSubmissionReady,
  workerDependenciesReady,
} from "../../src/modules/generation/factory.js";

describe("generation worker readiness", () => {
  const ready = {
    allowPaidGeneration: true,
    paidGenerationBudgetFen: 1_000,
    paidGenerationReviewThresholdFen: 1_000,
    arkApiKey: "ark-key",
    arkImageModel: "doubao-seedream-5-0-pro-260628",
    tosBucket: "bucket",
    tosEndpoint: "https://tos.example.com",
    tosAccessKey: "access-key",
    tosSecretKey: "secret-key",
    tosPublicBaseUrl: "https://media.example.com",
    aigcLabelingRuntimeReady: () => true,
  };

  it("requires paid execution authorization before a worker can start", () => {
    assert.equal(workerDependenciesReady(ready), true);
    assert.equal(generationExecutionEnabled(ready), true);
    assert.equal(generationExecutionEnabled({ ...ready, allowPaidGeneration: false }), false);
    assert.equal(generationExecutionEnabled({ ...ready, paidGenerationBudgetFen: 0 }), false);
    assert.equal(generationExecutionEnabled({ ...ready, tosPublicBaseUrl: undefined }), false);
    assert.equal(generationExecutionEnabled({ ...ready, aigcLabelingRuntimeReady: () => false }), false);
  });

  it("uses the lower configuration budget as the effective paid limit", () => {
    assert.equal(effectivePaidBudgetFen({ paidGenerationBudgetFen: 5_000, paidGenerationReviewThresholdFen: 1_200 }), 1_200);
    assert.equal(effectivePaidBudgetFen({ paidGenerationBudgetFen: 1_200, paidGenerationReviewThresholdFen: 5_000 }), 1_200);
    assert.equal(effectivePaidBudgetFen({ paidGenerationBudgetFen: 1_200, paidGenerationReviewThresholdFen: 0 }), 0);
    assert.equal(effectivePaidBudgetFen({}), 0);
  });

  it("rejects paid submission until Ark and every required TOS setting are ready", () => {
    assert.doesNotThrow(() => requireGenerationSubmissionReady({
      ...ready,
      allowPaidGeneration: true,
    }));
    assert.throws(
      () => requireGenerationSubmissionReady({
        ...ready,
        allowPaidGeneration: true,
        tosPublicBaseUrl: undefined,
      }),
      (error: unknown) => hasError(error, "generation_service_unavailable", 503),
    );
    assert.throws(
      () => requireGenerationSubmissionReady({
        ...ready,
        allowPaidGeneration: false,
      }),
      (error: unknown) => hasError(error, "paid_generation_disabled", 403),
    );
  });

  it("requires a verified audio model, trusted endpoint and credential pair before quote or task creation", () => {
    const audio = {
      openspeechTtsModel: "deployment-selected-audio-model",
      openspeechTtsEndpoint: "https://openspeech.bytedance.com/api/v1/tts",
      openspeechTtsToken: "tts-token",
      openspeechTtsAppId: "tts-appid",
    };
    assert.doesNotThrow(() => requireAudioGenerationConfigured(audio));
    for (const missing of [
      { ...audio, openspeechTtsModel: undefined },
      { ...audio, openspeechTtsEndpoint: undefined },
      { ...audio, openspeechTtsEndpoint: "https://unapproved.example.test/v1/tts" },
      { ...audio, openspeechTtsEndpoint: "http://openspeech.bytedance.com/api/v1/tts" },
      { ...audio, openspeechTtsToken: undefined },
      { ...audio, openspeechTtsToken: "   " },
      { ...audio, openspeechTtsAppId: undefined },
    ]) {
      assert.throws(
        () => requireAudioGenerationConfigured(missing),
        (error: unknown) => hasError(error, "GENERATION_CAPABILITY_UNAVAILABLE", 503),
      );
    }
    // 部署侧显式白名单可以放行官方以外的公网 host;环回永远不行。
    assert.doesNotThrow(() => requireAudioGenerationConfigured({
      ...audio,
      openspeechTtsEndpoint: "https://unapproved.example.test/v1/tts",
      openspeechTtsAllowedHosts: ["unapproved.example.test"],
    }));
    assert.throws(
      () => requireAudioGenerationConfigured({
        ...audio,
        openspeechTtsEndpoint: "https://localhost/v1/tts",
        openspeechTtsAllowedHosts: ["localhost"],
      }),
      (error: unknown) => hasError(error, "GENERATION_CAPABILITY_UNAVAILABLE", 503),
    );
    assert.doesNotThrow(() => requireGenerationRequestConfigured({
      mediaKind: "audio",
      model: "deployment-selected-audio-model",
    }, audio));
    assert.throws(
      () => requireGenerationRequestConfigured({ mediaKind: "audio", model: "stale-price-rule-model" }, audio),
      (error: unknown) => hasError(error, "GENERATION_CAPABILITY_UNAVAILABLE", 503),
    );
    assert.throws(
      () => requireGenerationRequestConfigured({ mediaKind: "image", model: "any-image-model" }, {}),
      (error: unknown) => hasError(error, "GENERATION_CAPABILITY_UNAVAILABLE", 503),
    );
    assert.doesNotThrow(() => requireGenerationRequestConfigured({
      mediaKind: "image",
      model: "configured-image-model",
    }, {
      arkApiKey: "ark-key",
      arkImageModel: "configured-image-model",
    }));
  });

  it("does not advertise audio until every verified provider setting is present", () => {
    const common = {
      arkApiKey: "test-key",
      arkBaseUrl: "https://ark.example.test/v3",
      openspeechTtsModel: "deployment-selected-audio-model",
      openspeechTtsEndpoint: "https://openspeech.bytedance.com/api/v1/tts",
      openspeechTtsToken: "tts-token",
    };
    const incomplete = createGenerationProviderRegistry(common).listCapabilities()
      .find((item) => item.id === "voice-synthesis");
    assert.equal(incomplete?.availability, "unconfigured");
    const complete = createGenerationProviderRegistry({
      ...common,
      openspeechTtsAppId: "tts-appid",
    }).listCapabilities().find((item) => item.id === "voice-synthesis");
    assert.equal(complete?.availability, "available");
    assert.equal(complete?.providerId, "openspeech");
    assert.equal(complete?.actualModelId, "deployment-selected-audio-model");
  });

  it("selects the temporary async gateway explicitly and never falls back across routes", () => {
    const selected = {
      companyProviderAllowlist: ["ark", "suchuang"],
      suchuangGenerationEnabled: true,
      suchuangBaseUrl: "https://gateway.company.example/vendor",
      suchuangApiKey: "company-test-key",
    };
    const capabilities = createGenerationProviderRegistry(selected).listCapabilities();
    for (const id of ["gpt-image-2", "nanobanana-2", "nanobanana-lite"] as const) {
      const capability = capabilities.find((item) => item.id === id);
      assert.equal(capability?.availability, "available");
      assert.equal(capability?.providerId, "suchuang");
    }
    assert.doesNotThrow(() => requireGenerationRequestConfigured({
      mediaKind: "image",
      model: "gpt-image-2-suchuang",
    }, selected, "suchuang"));

    const incomplete = createGenerationProviderRegistry({
      ...selected,
      suchuangApiKey: undefined,
      newapiGenerationEnabled: true,
      newapiBaseUrl: "https://newapi.company.example/v1",
      newapiApiKey: "newapi-key",
      newapiGptImageModels: "gpt-image-2",
    }).listCapabilities().find((item) => item.id === "gpt-image-2");
    assert.equal(incomplete?.availability, "unconfigured");
    assert.equal(incomplete?.providerId, undefined);
  });

  it("keeps the temporary gateway unavailable until the company account allowlist opts in", () => {
    const capability = createGenerationProviderRegistry({
      suchuangGenerationEnabled: true,
      suchuangBaseUrl: "https://gateway.company.example",
      suchuangApiKey: "company-test-key",
    }).listCapabilities().find((item) => item.id === "nanobanana-lite");
    assert.equal(capability?.availability, "unconfigured");
    assert.equal(capability?.unavailableReason, "该供应商未开通公司账户");
  });

  it("selects Seed Audio v3 only when all v3 settings are complete", () => {
    const completeV3 = {
      arkApiKey: "test-key",
      arkBaseUrl: "https://ark.example.test/v3",
      seedAudioModel: "seed-audio-1.0",
      seedAudioEndpoint: "https://openspeech.bytedance.com/api/v3/tts/create",
      seedAudioApiKey: "seed-audio-key",
    };
    assert.doesNotThrow(() => requireAudioGenerationConfigured(completeV3));
    const capability = createGenerationProviderRegistry(completeV3).listCapabilities()
      .find((item) => item.id === "voice-synthesis");
    assert.equal(capability?.availability, "available");
    assert.equal(capability?.actualModelId, "seed-audio-1.0");
    assert.equal(capability?.providerId, "openspeech");
  });

  it("allows an audio-only worker without Ark and still rejects image readiness", () => {
    const audioOnly = {
      allowPaidGeneration: true,
      paidGenerationBudgetFen: 1_000,
      paidGenerationReviewThresholdFen: 1_000,
      seedAudioModel: "seed-audio-1.0",
      seedAudioEndpoint: "https://openspeech.bytedance.com/api/v3/tts/create",
      seedAudioApiKey: "seed-audio-key",
      tosBucket: "bucket",
      tosEndpoint: "https://tos.example.com",
      tosAccessKey: "access-key",
      tosSecretKey: "secret-key",
      tosPublicBaseUrl: "https://media.example.com",
      aigcLabelingRuntimeReady: () => true,
    };
    assert.equal(workerDependenciesReady(audioOnly, "audio"), true);
    assert.equal(workerDependenciesReady(audioOnly, "image"), false);
    assert.doesNotThrow(() => requireGenerationSubmissionReady(audioOnly, "audio"));
    assert.throws(
      () => requireGenerationSubmissionReady(audioOnly, "image"),
      (error: unknown) => hasError(error, "generation_service_unavailable", 503),
    );
  });

  it("does not let a MiniMax key without an audio allowlist mask a configured Seed Audio route", () => {
    const seedAudio = {
      seedAudioModel: "seed-audio-1.0",
      seedAudioEndpoint: "https://openspeech.bytedance.com/api/v3/tts/create",
      seedAudioApiKey: "seed-audio-key",
    };
    assert.equal(requireAudioGenerationConfigured({
      ...seedAudio,
      minimaxApiKey: "minimax-key-only",
    }), "seed-audio-1.0");
    assert.equal(createGenerationProviderRegistry({
      ...seedAudio,
      minimaxApiKey: "minimax-key-only",
    }).listCapabilities().find((item) => item.id === "minimax-voice")?.availability, "unconfigured");
  });

  it("fails closed when any Seed Audio v3 setting is present instead of falling back to legacy TTS", () => {
    const legacy = {
      openspeechTtsModel: "legacy-model",
      openspeechTtsEndpoint: "https://openspeech.bytedance.com/api/v1/tts",
      openspeechTtsToken: "legacy-token",
      openspeechTtsAppId: "legacy-appid",
    };
    for (const incompleteV3 of [
      { seedAudioModel: "seed-audio-1.0" },
      { seedAudioEndpoint: "https://openspeech.bytedance.com/api/v3/tts/create" },
      { seedAudioApiKey: "seed-audio-key" },
    ]) {
      const configuration = { ...legacy, ...incompleteV3 };
      assert.throws(
        () => requireAudioGenerationConfigured(configuration),
        (error: unknown) => hasError(error, "GENERATION_CAPABILITY_UNAVAILABLE", 503),
      );
      const capability = createGenerationProviderRegistry({
        arkBaseUrl: "https://ark.example.test/v3",
        ...configuration,
      }).listCapabilities().find((item) => item.id === "voice-synthesis");
      assert.equal(capability?.availability, "unconfigured");
    }
    for (const badEndpoint of [
      "https://openspeech.bytedance.com/api/v1/tts",
      "https://openspeech.bytedance.com/api/v3/tts/create?unsafe=true",
    ]) {
      assert.throws(
        () => requireAudioGenerationConfigured({
          seedAudioModel: "seed-audio-1.0",
          seedAudioEndpoint: badEndpoint,
          seedAudioApiKey: "seed-audio-key",
        }),
        (error: unknown) => hasError(error, "GENERATION_CAPABILITY_UNAVAILABLE", 503),
      );
    }
  });
});

function hasError(error: unknown, code: string, statusCode: number): boolean {
  return error instanceof Error
    && "code" in error
    && "statusCode" in error
    && error.code === code
    && error.statusCode === statusCode;
}
