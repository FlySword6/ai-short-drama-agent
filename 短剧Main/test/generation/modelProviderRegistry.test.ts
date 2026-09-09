import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProviderRequestError } from "../../src/modules/generation/errors.js";
import { FakeGenerationProvider } from "../../src/modules/generation/provider/fakeGenerationProvider.js";
import { ModelProviderRegistry } from "../../src/modules/generation/provider/modelProviderRegistry.js";

describe("ModelProviderRegistry", () => {
  it("lists every V0.1.1 product capability as unconfigured by default", () => {
    const registry = new ModelProviderRegistry();
    assert.deepEqual(
      registry.listCapabilities().map(({ id, availability }) => ({ id, availability })),
      [
        { id: "gpt-image-2", availability: "unconfigured" },
        { id: "nanobanana-2", availability: "unconfigured" },
        { id: "nanobanana-lite", availability: "unconfigured" },
        { id: "gemini-image", availability: "unconfigured" },
        { id: "seedream-5-pro", availability: "unconfigured" },
        { id: "seedance-2-0", availability: "unconfigured" },
        { id: "seedance-2-5", availability: "unconfigured" },
        { id: "minimax-image", availability: "unconfigured" },
        { id: "minimax-video-h3", availability: "unconfigured" },
        { id: "minimax-voice", availability: "unconfigured" },
        { id: "voice-synthesis", availability: "unconfigured" },
        { id: "happyhorse-1-1", availability: "unconfigured" },
      ],
    );
  });

  it("routes every explicitly configured MiniMax media model to one adapter", async () => {
    const adapter = new FakeGenerationProvider({
      submit: async () => ({ outcome: "accepted", providerTaskId: "minimax-task" }),
    });
    const registry = new ModelProviderRegistry({
      companyProviderAllowlist: ["minimax"],
      adapters: { minimax: adapter },
      capabilities: [
        {
          id: "minimax-image",
          providerId: "minimax",
          actualModelIds: ["image-01", "image-01-live"],
        },
        {
          id: "minimax-video-h3",
          providerId: "minimax",
          actualModelId: "MiniMax-H3",
        },
      ],
    });

    await registry.submit(imageRequest("image-01-live"));
    assert.equal(adapter.submitted[0]?.model, "image-01-live");
    assert.equal(registry.capabilityForModel("MiniMax-H3")?.providerId, "minimax");
  });

  it("keeps the old Seed Audio product id as a configuration alias", () => {
    const adapter = new FakeGenerationProvider();
    const registry = new ModelProviderRegistry({
      adapters: { openspeech: adapter },
      capabilities: [{
        id: "seed-audio-1-0",
        providerId: "openspeech",
        actualModelId: "seed-audio-1.0",
      }],
    });
    const capability = registry.listCapabilities()
      .find((item) => item.id === "voice-synthesis");
    assert.equal(capability?.availability, "available");
    assert.equal(capability?.actualModelId, "seed-audio-1.0");
  });

  it("binds the Seedance 2.5 endpoint id as an independent video capability", async () => {
    const adapter = new FakeGenerationProvider({
      submit: async () => ({ outcome: "accepted", providerTaskId: "ark-video-task" }),
    });
    const registry = new ModelProviderRegistry({
      adapters: { ark: adapter },
      capabilities: [
        {
          id: "seedance-2-0",
          providerId: "ark",
          actualModelId: "doubao-seedance-2-0-fast-260128",
        },
        {
          id: "seedance-2-5",
          providerId: "ark",
          actualModelId: "ep-20260807153339-f6bp4",
        },
      ],
    });

    const capability = registry.listCapabilities()
      .find((item) => item.id === "seedance-2-5");
    assert.equal(capability?.availability, "available");
    assert.equal(capability?.displayName, "Seedance 2.5");
    assert.equal(capability?.actualModelId, "ep-20260807153339-f6bp4");
    assert.equal(registry.capabilityForModel("ep-20260807153339-f6bp4")?.id, "seedance-2-5");

    await registry.submit(videoRequest("ep-20260807153339-f6bp4"));
    assert.equal(adapter.submitted[0]?.model, "ep-20260807153339-f6bp4");
    // 2.0 绑定不受 2.5 接入点影响。
    assert.equal(
      registry.capabilityForModel("doubao-seedance-2-0-fast-260128")?.id,
      "seedance-2-0",
    );
  });

  it("routes only an explicitly configured actual model ID to its adapter", async () => {
    const adapter = new FakeGenerationProvider({
      submit: async () => ({ outcome: "accepted", providerTaskId: "provider-task-1" }),
      query: async () => ({ status: "running", media: [] }),
    });
    const registry = new ModelProviderRegistry({
      companyProviderAllowlist: ["openai"],
      adapters: { openai: adapter },
      capabilities: [{ id: "gpt-image-2", providerId: "openai", actualModelId: "verified-gpt-image-id" }],
    });

    const submission = await registry.submit(imageRequest("verified-gpt-image-id"));
    assert.deepEqual(submission, { outcome: "accepted", providerTaskId: "provider-task-1" });
    assert.equal(adapter.submitted[0]?.model, "verified-gpt-image-id");

    await registry.query("provider-task-1", { model: "verified-gpt-image-id", mediaKind: "image" });
    assert.deepEqual(adapter.queried, [{ providerTaskId: "provider-task-1", model: "verified-gpt-image-id" }]);
  });

  it("fails closed for product names, unknown IDs, and a mismatched media kind", async () => {
    const registry = new ModelProviderRegistry();
    for (const request of [
      imageRequest("gpt-image-2"),
      imageRequest("not-a-configured-model"),
      { ...imageRequest("gpt-image-2"), mediaKind: "video" as const },
    ]) {
      await assert.rejects(
        () => registry.submit(request),
        (error: unknown) => error instanceof ProviderRequestError
          && error.providerCode === "PROVIDER_NOT_CONFIGURED"
          && error.outcome === "rejected",
      );
    }
  });

  it("does not guess an adapter while recovering a task without its model context", async () => {
    const registry = new ModelProviderRegistry();
    await assert.rejects(
      () => registry.query("provider-task-1"),
      (error: unknown) => error instanceof ProviderRequestError
        && error.providerCode === "PROVIDER_NOT_CONFIGURED",
    );
  });

  it("rejects an expanded quantity before it reaches any configured adapter", async () => {
    const adapter = new FakeGenerationProvider();
    const registry = new ModelProviderRegistry({
      companyProviderAllowlist: ["openai"],
      adapters: { openai: adapter },
      capabilities: [{ id: "gpt-image-2", providerId: "openai", actualModelId: "verified-gpt-image-id" }],
    });
    await assert.rejects(
      () => registry.submit({ ...imageRequest("verified-gpt-image-id"), quantity: 2 }),
      (error: unknown) => error instanceof ProviderRequestError
        && error.providerCode === "INVALID_PROVIDER_INPUT",
    );
    assert.equal(adapter.submitted.length, 0);
  });

  it("rejects one actual model ID bound to multiple capabilities", () => {
    const adapter = new FakeGenerationProvider();
    assert.throws(
      () => new ModelProviderRegistry({
        adapters: { ark: adapter, minimax: adapter },
        capabilities: [
          {
            id: "seedream-5-pro",
            providerId: "ark",
            actualModelId: "shared-deployment-id",
          },
          {
            id: "minimax-image",
            providerId: "minimax",
            actualModelId: "shared-deployment-id",
          },
        ],
      }),
      /Duplicate generation model binding/,
    );
  });

  it("R195-5 rejects an unapproved company provider before its adapter runs", async () => {
    const ark = new FakeGenerationProvider({
      submit: async () => ({ outcome: "accepted", providerTaskId: "ark-task" }),
    });
    const newapi = new FakeGenerationProvider({
      submit: async () => ({ outcome: "accepted", providerTaskId: "newapi-task" }),
    });
    const registry = new ModelProviderRegistry({
      companyProviderAllowlist: ["ark"],
      adapters: { ark, newapi },
      capabilities: [
        {
          id: "seedream-5-pro",
          providerId: "ark",
          actualModelId: "ark-image-model",
        },
        {
          id: "gpt-image-2",
          providerId: "newapi",
          actualModelId: "gpt-image-2",
        },
      ],
    });

    const newapiCapability = registry.listCapabilities()
      .find((item) => item.id === "gpt-image-2");
    assert.equal(newapiCapability?.availability, "unconfigured");
    assert.equal(newapiCapability?.unavailableReason, "该供应商未开通公司账户");
    await assert.rejects(
      () => registry.submit(imageRequest("gpt-image-2")),
      (error: unknown) => error instanceof ProviderRequestError
        && error.providerCode === "PROVIDER_COMPANY_ACCOUNT_NOT_ENABLED"
        && error.message === "该供应商未开通公司账户"
        && error.outcome === "rejected",
    );
    assert.equal(newapi.submitted.length, 0);

    await registry.submit(imageRequest("ark-image-model"));
    assert.equal(ark.submitted.length, 1);
  });
});

function imageRequest(model: string) {
  return {
    mediaKind: "image" as const,
    model,
    prompt: "one human-approved image",
    parameters: {},
    references: [],
    quantity: 1,
  };
}

function videoRequest(model: string) {
  return {
    mediaKind: "video" as const,
    model,
    prompt: "one human-approved video",
    parameters: {},
    references: [],
    quantity: 1,
  };
}
