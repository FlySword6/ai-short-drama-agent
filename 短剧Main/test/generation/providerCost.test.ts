import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calculateProviderCost,
  providerCostBasisPayloadSchema,
  type ProviderCostBasisPayload,
  type ProviderCostConfigEntry,
  type ProviderCostObservation,
} from "../../src/modules/generation/providerCost.js";

const UPDATED_AT = new Date("2026-07-28T00:00:00.000Z");

describe("provider cost calculation", () => {
  it("uses provider-reported Seedance tokens and preserves exact CNY micros", () => {
    const calculated = calculateProviderCost(
      [entry("fast", videoBasis("doubao-seedance-2-0-fast-260128", 37_000_000))],
      videoObservation({
        usage: { completion_tokens: 86_400, total_tokens: 86_400 },
      }),
    );

    assert.equal(calculated.status, "confirmed");
    assert.equal(calculated.usageSource, "provider_reported");
    assert.equal(calculated.usageQuantity, 86_400);
    assert.equal(calculated.costCnyMicros, 3_196_800);
    assert.equal(calculated.costFenRounded, 320);
    assert.equal(calculated.requiresAttention, false);
    assert.match(calculated.configChecksum ?? "", /^[a-f0-9]{64}$/);
  });

  it("uses the configured pixel-token formula only as an estimated fallback", () => {
    const calculated = calculateProviderCost(
      [entry("fast", videoBasis("doubao-seedance-2-0-fast-260128", 37_000_000))],
      videoObservation({}),
    );

    assert.equal(calculated.status, "estimated");
    assert.equal(calculated.usageSource, "formula_fallback");
    assert.equal(calculated.usageQuantity, 86_400);
    assert.equal(calculated.costCnyMicros, 3_196_800);
    assert.equal(calculated.costFenRounded, 320);
    assert.equal(calculated.requiresAttention, true);
  });

  it("takes the Mini 23 yuan rate from config and guards multiplication/division", () => {
    const calculated = calculateProviderCost(
      [entry("mini", videoBasis("doubao-seedance-2-0-mini-260615", 23_000_000))],
      videoObservation(
        { usage: { completion_tokens: 86_401 } },
        "doubao-seedance-2-0-mini-260615",
      ),
    );

    assert.equal(calculated.status, "confirmed");
    assert.equal(calculated.costCnyMicros, 1_987_223);
    assert.equal(calculated.costFenRounded, 199);
  });

  it("uses actual generated image count before request-quantity fallback", () => {
    const basis: ProviderCostBasisPayload = {
      provider: "ark",
      model: "doubao-seedream-5-0-pro-260628",
      media_kind: "image",
      parameter_match: { size: ["2K"] },
      billing_unit: "image",
      usage_keys: ["generated_images"],
      unit_price_cny_micros: 600_000,
      unit_size: 1,
      currency: "CNY",
      fallback: { kind: "request_quantity" },
      source_url: "https://www.volcengine.com/docs/82379/1544106",
    };
    const observation: ProviderCostObservation = {
      provider: "ark",
      model: basis.model,
      mediaKind: "image",
      parameters: { size: "2K" },
      quantity: 1,
      result: {
        status: "succeeded",
        media: [],
        actualModelId: basis.model,
        usage: { generated_images: 2 },
      },
    };
    const actual = calculateProviderCost([entry("image", basis)], observation);
    const fallback = calculateProviderCost(
      [entry("image", basis)],
      { ...observation, result: { ...observation.result, usage: undefined } },
    );

    assert.deepEqual(
      [actual.status, actual.usageQuantity, actual.costCnyMicros],
      ["confirmed", 2, 1_200_000],
    );
    assert.deepEqual(
      [fallback.status, fallback.usageQuantity, fallback.costCnyMicros],
      ["estimated", 1, 600_000],
    );
  });

  it("keeps the three company image gateway cost rates separate", () => {
    const cases = [
      ["gpt-image-2-suchuang", 100_000, 10],
      ["nanobanana-lite", 80_000, 8],
      ["nanobanana-2", 100_000, 10],
    ] as const;
    for (const [model, unitPriceCnyMicros, expectedFen] of cases) {
      const basis: ProviderCostBasisPayload = {
        provider: "suchuang",
        model,
        media_kind: "image",
        parameter_match: {},
        billing_unit: "image",
        usage_keys: ["generated_images"],
        unit_price_cny_micros: unitPriceCnyMicros,
        unit_size: 1,
        currency: "CNY",
        fallback: { kind: "request_quantity" },
        source_url: "https://api.wuyinkeji.com/doc/47",
      };
      const calculated = calculateProviderCost([entry(model, basis)], {
        provider: "suchuang",
        model,
        mediaKind: "image",
        parameters: { size: "1K", ratio: "1:1" },
        quantity: 1,
        result: {
          status: "succeeded",
          actualModelId: model,
          usage: { generated_images: 1 },
          media: [],
        },
      });
      assert.deepEqual(
        [calculated.status, calculated.costCnyMicros, calculated.costFenRounded],
        ["confirmed", unitPriceCnyMicros, expectedFen],
      );
    }
  });

  it("records Seed Audio supplier cost for every supported output format", () => {
    const basis: ProviderCostBasisPayload = {
      provider: "openspeech",
      model: "seed-audio-1.0",
      media_kind: "audio",
      parameter_match: { format: ["mp3", "wav", "pcm"] },
      billing_unit: "millisecond",
      usage_keys: ["original_duration_ms"],
      unit_price_cny_micros: 1_000_000,
      unit_size: 60_000,
      currency: "CNY",
      fallback: { kind: "requested_duration_ms" },
      source_url: "https://www.volcengine.com/docs/6561/1359370",
    };
    const observation: ProviderCostObservation = {
      provider: "openspeech",
      model: basis.model,
      mediaKind: "audio",
      parameters: { format: "mp3", originalDurationSeconds: 120 },
      quantity: 1,
      result: {
        status: "succeeded",
        media: [{ kind: "audio", providerResultKey: "audio-1", actualDurationMs: 70_000 }],
        actualModelId: basis.model,
        usage: { original_duration_ms: 82_800 },
      },
    };
    const actual = calculateProviderCost([entry("seed-audio", basis)], observation);
    const fallback = calculateProviderCost(
      [entry("seed-audio", basis)],
      {
        ...observation,
        parameters: { format: "wav", originalDurationSeconds: 120 },
        result: { ...observation.result, usage: undefined },
      },
    );

    assert.deepEqual(
      [
        actual.status,
        actual.usageSource,
        actual.usageQuantity,
        actual.costCnyMicros,
        actual.costFenRounded,
        actual.requiresAttention,
      ],
      ["confirmed", "provider_reported", 82_800, 1_380_000, 138, false],
    );
    assert.deepEqual(
      [
        fallback.status,
        fallback.usageSource,
        fallback.usageQuantity,
        fallback.costFenRounded,
        fallback.requiresAttention,
      ],
      ["estimated", "formula_fallback", 120_000, 200, true],
    );

    const pcm = calculateProviderCost(
      [entry("seed-audio", basis)],
      { ...observation, parameters: { format: "pcm", originalDurationSeconds: 60 } },
    );
    assert.deepEqual(
      [pcm.status, pcm.usageSource, pcm.usageQuantity, pcm.costFenRounded, pcm.requiresAttention],
      ["confirmed", "provider_reported", 82_800, 138, false],
    );
  });

  it("marks missing, ambiguous, and failed-without-usage costs unavailable rather than zero", () => {
    const basis = entry("fast", videoBasis("doubao-seedance-2-0-fast-260128", 37_000_000));
    const missing = calculateProviderCost([], videoObservation({}));
    const ambiguous = calculateProviderCost([basis, { ...basis, id: "duplicate" }], videoObservation({}));
    const failed = calculateProviderCost(
      [basis],
      videoObservation({ status: "failed", errorCode: "PROVIDER_FAILED" }),
    );

    assert.deepEqual(
      [missing.status, missing.costCnyMicros, missing.failureCode],
      ["unavailable", null, "cost_basis_missing"],
    );
    assert.deepEqual(
      [ambiguous.status, ambiguous.costCnyMicros, ambiguous.failureCode],
      ["unavailable", null, "cost_basis_ambiguous"],
    );
    assert.deepEqual(
      [failed.status, failed.costCnyMicros, failed.failureCode],
      ["unavailable", null, "provider_usage_unavailable"],
    );
  });

  it("keeps an explicit provider-reported zero as a confirmed zero-cost fact", () => {
    const calculated = calculateProviderCost(
      [entry("fast", videoBasis("doubao-seedance-2-0-fast-260128", 37_000_000))],
      videoObservation({
        status: "failed",
        usage: { completion_tokens: 0 },
        errorCode: "PROVIDER_REJECTED_BEFORE_OUTPUT",
      }),
    );

    assert.deepEqual(
      [
        calculated.status,
        calculated.usageSource,
        calculated.usageQuantity,
        calculated.costCnyMicros,
        calculated.costFenRounded,
      ],
      ["confirmed", "provider_reported", 0, 0, 0],
    );
  });

  it("rejects a config that mismatches media, divisor, or fallback semantics", () => {
    const invalid = {
      ...videoBasis("doubao-seedance-2-0-fast-260128", 37_000_000),
      unit_size: 1,
      fallback: { kind: "request_quantity" },
    };
    assert.equal(providerCostBasisPayloadSchema.safeParse(invalid).success, false);
  });
});

function entry(id: string, payload: ProviderCostBasisPayload): ProviderCostConfigEntry {
  return { id, updatedAt: UPDATED_AT, payload };
}

function videoBasis(model: string, unitPriceCnyMicros: number): ProviderCostBasisPayload {
  return {
    provider: "ark",
    model,
    media_kind: "video",
    parameter_match: { resolution: ["720p"] },
    billing_unit: "million_output_tokens",
    usage_keys: ["completion_tokens", "output_tokens", "total_tokens"],
    unit_price_cny_micros: unitPriceCnyMicros,
    unit_size: 1_000_000,
    currency: "CNY",
    fallback: {
      kind: "video_token_formula",
      frames_per_second: 24,
      token_divisor: 1024,
      pixel_count_by_resolution_ratio: {
        "720p": { "9:16": 921_600 },
      },
    },
    source_url: "https://www.volcengine.com/docs/82379/1544106",
  };
}

function videoObservation(
  resultPatch: Partial<ProviderCostObservation["result"]>,
  model = "doubao-seedance-2-0-fast-260128",
): ProviderCostObservation {
  return {
    provider: "ark",
    model,
    mediaKind: "video",
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
    quantity: 1,
    result: {
      status: "succeeded",
      media: [],
      actualModelId: model,
      ...resultPatch,
    },
  };
}
