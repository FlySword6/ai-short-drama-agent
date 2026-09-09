import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerCapabilityTierRoutes } from "./routes.js";
import type { CapabilityTierRepository } from "./types.js";

test("登录用户读取对应媒体类型的能力档目录", async () => {
  const app = await testApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/generation/capability-tiers?media_type=image",
    });
    assert.equal(response.statusCode, 200, response.body);
    const payload = response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.data.tiers.length, 2);
    assert.deepEqual(payload.data.tiers.find(
      (tier: { tier_id: string }) => tier.tier_id === "img-seedream5pro-169-2k-1",
    ), {
          tier_id: "img-seedream5pro-169-2k-1",
          media_type: "image",
          display_name: "seedream 5 0 pro",
          provider_label: "火山方舟",
          model_label: "seedream 5 0 pro",
          is_default: false,
          availability: "available",
          availability_reason: "已完成官方价格核验、逐档实测与账单核对",
          capabilities: ["image", "aspect_ratio", "resolution", "sequential_image_generation"],
          official_price_source: "https://www.volcengine.com/docs/82379/1544106",
          params: {
            aspect_ratio: "16:9",
            resolution: "2K",
            watermark: false,
            sequential_image_generation: "disabled",
            quantity: 1,
          },
          price: { unit: "per_image", points: 60 },
          status: "active",
    });
    assert.deepEqual(payload.data.tiers.find(
      (tier: { tier_id: string }) => tier.tier_id === "img-seedream5pro-916-1k-1",
    ), {
      tier_id: "img-seedream5pro-916-1k-1",
      media_type: "image",
      display_name: "seedream 5 0 pro",
      provider_label: "火山方舟",
      model_label: "seedream 5 0 pro",
      is_default: true,
      availability: "available",
      availability_reason: "已完成官方价格核验、逐档实测与账单核对",
      capabilities: ["image", "aspect_ratio", "resolution", "sequential_image_generation"],
      official_price_source: "https://www.volcengine.com/docs/82379/1544106",
      params: {
        aspect_ratio: "9:16",
        resolution: "1K",
        watermark: false,
        sequential_image_generation: "disabled",
        quantity: 1,
      },
      price: { unit: "per_image", points: 30 },
      status: "active",
    });
    const seedream = payload.data.parameter_models.find(
      (model: { model_label: string }) => model.model_label === "seedream 5 0 pro",
    );
    assert.equal(seedream.anchor_tier_id, "img-seedream5pro-916-1k-1");
    assert.deepEqual(seedream.parameter_options.map((option: { key: string }) => option.key), [
      "aspect_ratio",
      "resolution",
      "quantity",
      "sequential_image_generation",
    ]);
    assert.deepEqual(seedream.parameter_options[0].values, [
      {
        value: "16:9",
        availability: "available",
        availability_reason: "已完成官方价格核验、逐档实测与账单核对",
        selectable: true,
      },
      {
        value: "9:16",
        availability: "available",
        availability_reason: "已完成官方价格核验、逐档实测与账单核对",
        selectable: true,
      },
    ]);
    assert.deepEqual(
      seedream.parameter_options[1].values.map(
        (option: { value: string; selectable: boolean }) => ({
          value: option.value,
          selectable: option.selectable,
        }),
      ),
      [
        { value: "2K", selectable: true },
        { value: "1K", selectable: true },
      ],
    );
    assert.deepEqual(
      seedream.combinations.find(
        (combination: { tier_id: string }) => (
          combination.tier_id === "img-seedream5pro-916-1k-1"
        ),
      ),
      {
        tier_id: "img-seedream5pro-916-1k-1",
        params: {
          aspect_ratio: "9:16",
          resolution: "1K",
          watermark: false,
          sequential_image_generation: "disabled",
          quantity: 1,
        },
        price: { unit: "per_image", points: 30 },
        status: "active",
        availability: "available",
        availability_reason: "已完成官方价格核验、逐档实测与账单核对",
        selectable: true,
      },
    );
  } finally {
    await app.close();
  }
});

test("冻结档必须显式请求，既有客户端不会把灰档算成可用档", async () => {
  const app = await testApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/generation/capability-tiers?media_type=image&include_frozen=true",
    });
    assert.equal(response.statusCode, 200, response.body);
    const tiers = response.json().data.tiers as Array<{
      tier_id: string;
      status: string;
      availability: string;
      availability_reason: string;
    }>;
    assert.equal(tiers.length, 3);
    const frozen = tiers.find((tier) => tier.tier_id === "img-newapi-gptimage2-11-1k-low");
    assert.equal(frozen?.status, "experimental");
    assert.equal(frozen?.availability, "provider_not_enabled");
    assert.equal(frozen?.availability_reason, "该供应商未开通公司账户");
    const frozenModel = response.json().data.parameter_models.find(
      (model: { model_label: string }) => model.model_label === "gpt image 2",
    );
    assert.equal(frozenModel.selectable, false);
    assert.equal(frozenModel.anchor_tier_id, null);
    assert.equal(frozenModel.parameter_options[0].values[0].selectable, false);
    assert.equal(
      frozenModel.parameter_options[0].values[0].availability_reason,
      "该供应商未开通公司账户",
    );
  } finally {
    await app.close();
  }
});

test("未登录、缺失或错误 media_type 均不返回能力档", async () => {
  const anonymous = Fastify({ logger: false });
  await registerCapabilityTierRoutes(anonymous, () => ({}) as never, { createRepository: () => repository });
  const authenticated = await testApp();
  try {
    assert.equal((await anonymous.inject({
      method: "GET", url: "/api/v1/generation/capability-tiers?media_type=video",
    })).statusCode, 401);
    assert.equal((await authenticated.inject({
      method: "GET", url: "/api/v1/generation/capability-tiers",
    })).statusCode, 400);
    const audio = await authenticated.inject({
      method: "GET", url: "/api/v1/generation/capability-tiers?media_type=audio",
    });
    assert.equal(audio.statusCode, 200);
    assert.deepEqual(audio.json().data.tiers, [{
      tier_id: "aud-seedaudio10-30s",
      media_type: "audio",
      display_name: "seed audio 1.0 multilingual",
      provider_label: "火山语音",
      model_label: "seed audio 1.0 multilingual",
      is_default: true,
      availability: "available",
      availability_reason: "已完成官方价格核验、逐档实测与账单核对",
      capabilities: ["audio", "original_duration_seconds"],
      params: { original_duration_seconds: 30 },
      price: { unit: "per_second", points: 12 },
      status: "active",
    }]);
    assert.equal((await authenticated.inject({
      method: "GET", url: "/api/v1/generation/capability-tiers?media_type=text",
    })).statusCode, 400);
  } finally {
    await anonymous.close();
    await authenticated.close();
  }
});

const repository: CapabilityTierRepository = {
  async listCurrentPricingRules(mediaType) {
    if (mediaType === "audio") return [{
      id: "audio-rule-id",
      provider: "openspeech",
      model: "seed-audio-1.0-multilingual",
      mediaKind: "audio",
      billingUnit: "second",
      unitPriceFen: 12,
      effectiveFrom: new Date("2026-07-23T00:00:00.000Z"),
      metadata: {
        price_source_kind: "内部定价",
        capability_tier: {
          tier_id: "aud-seedaudio10-30s",
          params: { original_duration_seconds: 30 },
          status: "active",
        },
      },
    }];
    if (mediaType === "video") return [];
    return [{
      id: "rule-id",
      provider: "ark",
      model: "doubao-seedream-5-0-pro-260628",
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 60,
      effectiveFrom: new Date("2026-07-23T00:00:00.000Z"),
      metadata: {
        price_source_kind: "实测",
        capability_tier: {
          tier_id: "img-seedream5pro-169-2k-1",
          params: {
            aspect_ratio: "16:9",
            resolution: "2K",
            watermark: false,
            sequential_image_generation: "disabled",
            quantity: 1,
          },
          status: "active",
        },
      },
    }, {
      id: "portrait-rule-id",
      provider: "ark",
      model: "doubao-seedream-5-0-pro-260628",
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 30,
      active: true,
      effectiveFrom: new Date("2026-08-06T00:00:00.000Z"),
      metadata: {
        price_source_kind: "实测",
        activation_evidence: {
          batch_id: "ark-common-cheapest-v1",
          evidence_sha256: "a".repeat(64),
          provider_task_fingerprint: "b".repeat(16),
          artifact_sha256: "c".repeat(64),
          provider_billing_reference: "ark-billing:portrait-1k",
          guard_deployed_commit: "d".repeat(40),
          smoke_completed_at: "2026-08-06T01:00:00.000Z",
          account_checked_at: "2026-08-06T01:05:00.000Z",
          platform_list_price_fen: 30,
          provider_billed_fen: 30,
        },
        tier_availability: {
          code: "available",
          reason: "已完成官方价格核验、逐档实测与账单核对",
        },
        capability_tier: {
          tier_id: "img-seedream5pro-916-1k-1",
          params: {
            aspect_ratio: "9:16",
            resolution: "1K",
            watermark: false,
            sequential_image_generation: "disabled",
            quantity: 1,
          },
          status: "active",
        },
      },
    }, {
      id: "frozen-rule-id",
      provider: "newapi",
      model: "gpt-image-2",
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 0,
      active: false,
      effectiveFrom: new Date("2026-07-23T00:00:00.000Z"),
      metadata: {
        capability_tier: {
          tier_id: "img-newapi-gptimage2-11-1k-low",
          params: { aspect_ratio: "1:1", resolution: "1K", quantity: 1 },
          status: "experimental",
        },
      },
    }];
  },
};

async function testApp() {
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: "artist-id", username: "artist", displayName: "制作人" };
  });
  await registerCapabilityTierRoutes(app, () => ({}) as never, { createRepository: () => repository });
  return app;
}
