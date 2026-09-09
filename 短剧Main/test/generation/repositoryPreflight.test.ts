import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../src/db/client.js";
import { GenerationError } from "../../src/modules/generation/errors.js";
import { PostgresGenerationRepository } from "../../src/modules/generation/repository.js";
import { hashGenerationRequest, normalizeGenerationInput } from "../../src/modules/generation/service.js";

test("未配置音频能力时，报价和单次提交在触碰数据库前失败", async () => {
  const request = normalizeGenerationInput({
    projectId: "11111111-1111-4111-8111-111111111111",
    shotId: "22222222-2222-4222-8222-222222222222",
    mediaKind: "audio",
    model: "deployment-selected-audio-model",
    prompt: "你好",
    parameters: { originalDurationSeconds: 12 },
    referenceAssetSnapshots: [{ kind: "audio", url: "https://assets.example.test/reference.mp3" }],
    quantity: 1,
    clientIdempotencyKey: "audio-preflight-001",
  });
  let databaseTouched = false;
  const repository = new PostgresGenerationRepository({
    transaction: async () => {
      databaseTouched = true;
      throw new Error("database must not be reached");
    },
  } as unknown as Database, 5_000, true, () => {
    throw new GenerationError("GENERATION_CAPABILITY_UNAVAILABLE", "audio is not configured", 503);
  });

  await assert.rejects(
    () => repository.createSubmissionQuote({
      actorId: "33333333-3333-4333-8333-333333333333",
      source: "web",
      requestHash: hashGenerationRequest(request),
      request,
      ttlSeconds: 60,
    }),
    (error: unknown) => error instanceof GenerationError
      && error.code === "GENERATION_CAPABILITY_UNAVAILABLE",
  );
  await assert.rejects(
    () => repository.createSubmission({
      actorId: "33333333-3333-4333-8333-333333333333",
      source: "web",
      quoteId: "44444444-4444-4444-8444-444444444444",
      requestHash: hashGenerationRequest(request),
      request,
      budgetLimitFen: 10_000,
    }),
    (error: unknown) => error instanceof GenerationError
      && error.code === "GENERATION_CAPABILITY_UNAVAILABLE",
  );
  assert.equal(databaseTouched, false);
});

test("报价在事务锁内用当前价格供应商二次校验，错配时零写入", async () => {
  const request = normalizeGenerationInput({
    projectId: "11111111-1111-4111-8111-111111111111",
    mediaKind: "image",
    tierId: "img-seedream5pro-169-2k-1",
    model: "doubao-seedream-5-0-pro-260628",
    prompt: "一张安全测试图片",
    parameters: { size: "2K", ratio: "16:9" },
    referenceAssetSnapshots: [],
    quantity: 1,
    clientIdempotencyKey: "provider-binding-preflight",
  });
  const now = new Date();
  const selectedRows: unknown[][] = [
    [{ id: request.projectId, ownerUserId: "33333333-3333-4333-8333-333333333333" }],
    [{
      id: "44444444-4444-4444-8444-444444444444",
      provider: "ark",
      model: "doubao-seedream-5-0-pro-260628",
      mediaKind: "image",
      billingUnit: "image",
      unitPriceFen: 60,
      currency: "CNY",
      source: "test-only",
      active: true,
      effectiveFrom: new Date(now.getTime() - 60_000),
      effectiveTo: null,
      metadata: {
        price_source_kind: "实测",
        capability_tier: {
          tier_id: "img-seedream5pro-169-2k-1",
          params: {
            resolution: "2K",
            aspect_ratio: "16:9",
            quantity: 1,
            watermark: false,
            sequential_image_generation: "disabled",
          },
          status: "active",
        },
      },
      createdAt: now,
      updatedAt: now,
    }],
  ];
  let writes = 0;
  let lockCalls = 0;
  const transaction = {
    execute: async () => {
      lockCalls += 1;
    },
    select: () => {
      const rows = selectedRows.shift() ?? [];
      const query = {
        from: () => query,
        where: () => query,
        orderBy: async () => rows,
        limit: async () => rows,
      };
      return query;
    },
    insert: () => {
      writes += 1;
      throw new Error("provider mismatch must fail before insert");
    },
  };
  const database = {
    transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  } as unknown as Database;
  const expectedProviders: Array<string | undefined> = [];
  const repository = new PostgresGenerationRepository(database, 5_000, true, (_input, expectedProvider) => {
    expectedProviders.push(expectedProvider);
    if (expectedProvider === "ark") {
      throw new GenerationError(
        "GENERATION_CAPABILITY_UNAVAILABLE",
        "pricing provider does not match the configured route",
        503,
      );
    }
    return "ark";
  });

  await assert.rejects(
    () => repository.createSubmissionQuote({
      actorId: "33333333-3333-4333-8333-333333333333",
      source: "web",
      requestHash: hashGenerationRequest(request),
      request,
      ttlSeconds: 60,
    }),
    (error: unknown) => error instanceof GenerationError
      && error.code === "GENERATION_CAPABILITY_UNAVAILABLE",
  );
  assert.deepEqual(expectedProviders, [undefined, "ark"]);
  assert.equal(lockCalls, 1);
  assert.equal(writes, 0);
  assert.equal(selectedRows.length, 0);
});
