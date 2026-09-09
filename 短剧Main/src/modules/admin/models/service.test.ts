import assert from "node:assert/strict";
import test from "node:test";
import type { GenerationCapability } from "../../generation/provider/modelProviderRegistry.js";
import type { AdminModelRepository } from "./repository.js";
import { AdminModelService } from "./service.js";
import type { PricingRuleRecord } from "./types.js";

const now = new Date("2026-07-21T00:00:00.000Z");
const configuredPrice = price({
  id: "11111111-1111-4111-8111-111111111111",
  model: "ark-seedream-model-id",
});
const unrelatedPrice = price({
  id: "22222222-2222-4222-8222-222222222222",
  provider: "openai",
  model: "gpt-image-2",
});

test("模型配置状态只来自 fail-closed registry，单价记录不能把未配置模型变为可用", async () => {
  let requestedAt: Date | undefined;
  const repository: AdminModelRepository = {
    listCurrentPricingRules: async (at) => {
      requestedAt = at;
      return [configuredPrice, unrelatedPrice];
    },
    listPricingRules: async () => ({ items: [configuredPrice, unrelatedPrice], total: 2 }),
    replacePricingRule: async () => { throw new Error("not used"); },
  };
  const capabilities: GenerationCapability[] = [
    {
      id: "seedream-5-pro",
      displayName: "Seedream 5 Pro",
      mediaKind: "image",
      availability: "available",
      providerId: "ark",
      actualModelId: "ark-seedream-model-id",
    },
    {
      id: "gpt-image-2",
      displayName: "GPT Image 2",
      mediaKind: "image",
      availability: "unconfigured",
      unavailableReason: "实际模型 ID 尚未配置",
    },
  ];
  const service = new AdminModelService(repository, { listCapabilities: () => capabilities }, () => now);

  const models = await service.listModels();

  assert.equal(requestedAt, now);
  assert.equal(models[0]?.configurationStatus, "configured");
  assert.equal(models[0]?.currentPrice?.id, configuredPrice.id);
  assert.equal(models[1]?.configurationStatus, "unconfigured");
  assert.equal(models[1]?.currentPrice, null);
  assert.equal(models[1]?.unavailableReason, "实际模型 ID 尚未配置");
});

test("保存价格前强制校验 provider、model 与 media kind 的部署绑定", async () => {
  const writes: unknown[] = [];
  const repository: AdminModelRepository = {
    listCurrentPricingRules: async () => [],
    listPricingRules: async () => ({ items: [], total: 0 }),
    replacePricingRule: async (actorId, input) => {
      writes.push({ actorId, input });
      return configuredPrice;
    },
  };
  const capability: GenerationCapability = {
    id: "seedream-5-pro",
    displayName: "Seedream 5 Pro",
    mediaKind: "image",
    availability: "available",
    providerId: "ark",
    actualModelId: "ark-seedream-model-id",
  };
  const service = new AdminModelService(repository, {
    listCapabilities: () => [capability],
    capabilityForModel: (model) => model === capability.actualModelId ? capability : undefined,
  });
  const validInput = {
    provider: "ark",
    model: "ark-seedream-model-id",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 60,
    currency: "CNY",
    expectedActiveRuleId: null,
  } as const;

  assert.throws(
    () => service.replacePricingRule("admin-id", { ...validInput, provider: "minimax" }),
    /供应商、模型和媒体类型必须与当前部署绑定完全一致/,
  );
  assert.throws(
    () => service.replacePricingRule("admin-id", { ...validInput, mediaKind: "video", billingUnit: "second" }),
    /供应商、模型和媒体类型必须与当前部署绑定完全一致/,
  );
  await service.replacePricingRule("admin-id", validInput);
  assert.equal(writes.length, 1);
});

function price(overrides: Partial<PricingRuleRecord>): PricingRuleRecord {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    provider: "ark",
    model: "model-id",
    mediaKind: "image",
    billingUnit: "image",
    unitPriceFen: 60,
    currency: "CNY",
    source: "test",
    active: true,
    effectiveFrom: now,
    effectiveTo: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
