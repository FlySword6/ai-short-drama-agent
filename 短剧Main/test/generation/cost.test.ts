import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateGenerationCost, isWithinBudget } from "../../src/modules/generation/cost.js";

describe("generation cost", () => {
  it("allows the exact 500 yuan boundary and rejects one fen over", () => {
    assert.equal(isWithinBudget(49_999, 1, 50_000), true);
    assert.equal(isWithinBudget(50_000, 0, 50_000), true);
    assert.equal(isWithinBudget(50_000, 1, 50_000), false);
  });

  it("freezes the user charge at 80 fen per second without embedding supplier rates", () => {
    const estimate = estimateGenerationCost(
      {
        id: "seedance-per-second",
        provider: "ark",
        model: "doubao-seedance-2-0-fast-260128",
        mediaKind: "video",
        billingUnit: "second",
        unitPriceFen: 80,
      },
      {
        mediaKind: "video",
        model: "doubao-seedance-2-0-fast-260128",
        quantity: 1,
        parameters: { durationSeconds: 4, resolution: "720p", ratio: "9:16" },
        referenceAssetSnapshots: [],
      },
    );
    assert.equal(estimate.billableUnits, 4);
    assert.equal(estimate.estimatedCostFen, 320);
    assert.equal(estimate.provider, "ark");
    assert.equal(estimate.unitPriceFen, 80);
    assert.equal(estimate.pricingBasis?.estimatedTokens, undefined);
    assert.equal(estimate.pricingBasis?.providerYuanPerMillionTokens, undefined);
    assert.equal(estimate.pricingBasis?.contractVersion, "v0.1-ark-fixed");
  });

  it("discounts a video sample with ceiling rounding while retaining the full-price snapshot", () => {
    const estimate = estimateGenerationCost({
      id: "sample-video", provider: "ark", model: "doubao-seedance-2-0-fast-260128",
      mediaKind: "video", billingUnit: "second", unitPriceFen: 81,
    }, {
      mediaKind: "video", model: "doubao-seedance-2-0-fast-260128", quantity: 1,
      parameters: { durationSeconds: 4, resolution: "720p", ratio: "9:16" },
      referenceAssetSnapshots: [], productionMode: "sample",
    });
    assert.equal(estimate.fullEstimatedCostFen, 324);
    assert.equal(estimate.estimatedCostFen, 195);
    assert.equal(estimate.productionMode, "sample");
    assert.equal(estimate.priceMultiplierBps, 6_000);
    assert.equal(estimate.discountNumerator, 3);
    assert.equal(estimate.discountDenominator, 5);
  });

  it("rejects sample mode for non-video generation", () => {
    assert.throws(() => estimateGenerationCost({
      id: "sample-image", provider: "ark", model: "doubao-seedream-5-0-pro-260628",
      mediaKind: "image", billingUnit: "image", unitPriceFen: 1,
    }, {
      mediaKind: "image", model: "doubao-seedream-5-0-pro-260628", quantity: 1,
      parameters: { size: "2048x1152", ratio: "16:9" }, referenceAssetSnapshots: [], productionMode: "sample",
    }), /only available for video/);
  });

  it("refuses a Seedance quote below the conservative frozen rate", () => {
    assert.throws(() => estimateGenerationCost(
      {
        id: "unsafe-seedance-price",
        provider: "ark",
        model: "doubao-seedance-2-0-fast-260128",
        mediaKind: "video",
        billingUnit: "second",
        unitPriceFen: 79,
      },
      {
        mediaKind: "video",
        model: "doubao-seedance-2-0-fast-260128",
        quantity: 1,
        parameters: { durationSeconds: 4, resolution: "720p", ratio: "9:16" },
        referenceAssetSnapshots: [],
      },
    ), /at least 80 fen/);
  });

  it("uses the registered price for a non-legacy Seedance capability tier", () => {
    const estimate = estimateGenerationCost(
      {
        id: "seedance-mini-priced-tier",
        provider: "ark",
        model: "doubao-seedance-2-0-mini-260615",
        mediaKind: "video",
        billingUnit: "second",
        unitPriceFen: 50,
        metadata: {
          capability_tier: {
            tier_id: "vid-seedance20mini-916-720p",
          },
        },
      },
      {
        tierId: "vid-seedance20mini-916-720p",
        mediaKind: "video",
        model: "doubao-seedance-2-0-mini-260615",
        quantity: 1,
        parameters: { durationSeconds: 4, resolution: "720p", ratio: "9:16" },
        referenceAssetSnapshots: [],
      },
    );
    assert.equal(estimate.unitPriceFen, 50);
    assert.equal(estimate.estimatedCostFen, 200);
  });

  it("uses the registered per-second tier for MiniMax H3 instead of applying Ark-only admission", () => {
    const estimate = estimateGenerationCost(
      {
        id: "minimax-h3-768p",
        provider: "minimax",
        model: "MiniMax-H3",
        mediaKind: "video",
        billingUnit: "second",
        unitPriceFen: 50,
        metadata: {
          capability_tier: {
            tier_id: "vid-minimax-h3-169-768p-4s",
          },
        },
      },
      {
        tierId: "vid-minimax-h3-169-768p-4s",
        mediaKind: "video",
        model: "MiniMax-H3",
        quantity: 1,
        parameters: { durationSeconds: 4, resolution: "768P", ratio: "16:9" },
        referenceAssetSnapshots: [],
      },
    );
    assert.equal(estimate.billableUnits, 4);
    assert.equal(estimate.estimatedCostFen, 200);
    assert.equal(estimate.pricingBasis?.contractVersion, "v0.4-provider-tier");
  });

  it("fails closed for a video reference until the active price rule covers it", () => {
    const rule = {
      id: "seedance-per-second",
      provider: "ark",
      model: "doubao-seedance-2-0-fast-260128",
      mediaKind: "video" as const,
      billingUnit: "second" as const,
      unitPriceFen: 80,
    };
    const request = {
      mediaKind: "video" as const,
      model: "doubao-seedance-2-0-fast-260128",
      quantity: 1,
      parameters: { durationSeconds: 4, resolution: "720p", ratio: "9:16" },
      referenceAssetSnapshots: [{
        kind: "video" as const,
        url: "https://example.test/action.mp4",
        role: "reference_video",
      }],
    };

    assert.throws(() => estimateGenerationCost(rule, request), /单价未覆盖视频参考/);

    const estimate = estimateGenerationCost({ ...rule, supportsInputVideo: true }, request);
    assert.equal(estimate.pricingBasis?.noInputVideo, undefined);
    assert.equal(estimate.pricingBasis?.inputVideoReferenceCount, 1);
  });

  it("bills audio from original duration seconds using the active rule price", () => {
    const estimate = estimateGenerationCost({
      id: "audio-per-second", provider: "openspeech", model: "configured-seed-audio-id",
      mediaKind: "audio", billingUnit: "second", unitPriceFen: 23,
    }, {
      tierId: "aud-seedaudio10-standard",
      mediaKind: "audio", model: "configured-seed-audio-id", quantity: 1,
      parameters: { originalDurationSeconds: 12, format: "mp3" },
      referenceAssetSnapshots: [{ kind: "audio", url: "https://example.test/ref.mp3", role: "reference_audio" }],
    });
    assert.equal(estimate.billableUnits, 12);
    assert.equal(estimate.estimatedCostFen, 276);
    assert.equal(estimate.pricingBasis?.contractVersion, "v0.2-audio-original-duration");
  });

  // 目录能看见、能选中,但一问价就说「供应商未开通」——用户视角就是开了也用不了。
  // 根因是估价这一处漏传公司账户白名单,于是它按默认的 ark 单条名单判定。
  // 白名单是部署配置,不该由某个调用点自己决定要不要读。
  it("按公司账户白名单估价：已开通的供应商能报出价，未开通的仍然拦住", () => {
    const rule = {
      id: "suchuang-image",
      provider: "suchuang",
      model: "gpt-image-2-suchuang",
      mediaKind: "image" as const,
      billingUnit: "image" as const,
      unitPriceFen: 10,
      metadata: {
        price_source_kind: "内部定价",
        capability_tier: {
          tier_id: "img-suchuang-gptimage2-1x2-1",
          status: "active",
          params: { aspect_ratio: "1:2", quantity: 1 },
        },
      },
    };
    const request = {
      tierId: "img-suchuang-gptimage2-1x2-1",
      mediaKind: "image" as const,
      model: "gpt-image-2-suchuang",
      quantity: 1,
      parameters: { size: "1:2" },
      referenceAssetSnapshots: [],
    };

    const estimate = estimateGenerationCost(rule, request, {
      companyProviderAllowlist: ["ark", "col", "suchuang"],
    });
    assert.equal(estimate.estimatedCostFen, 10);
    assert.equal(estimate.tierId, "img-suchuang-gptimage2-1x2-1");

    assert.throws(
      () => estimateGenerationCost(rule, request, { companyProviderAllowlist: ["ark"] }),
      /该供应商未开通公司账户/u,
    );
  });
});
