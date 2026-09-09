import assert from "node:assert/strict";
import test from "node:test";
import { GenerationError } from "./errors.js";
import {
  normalizeControlReferenceError,
  normalizeControlReferences,
  withShotFinalImageReference,
  type GenerationSubmissionBody,
  type ShotFinalReferenceResolution,
} from "./routes.js";

const ids = {
  reference: "11111111-1111-4111-8111-111111111111",
  first: "22222222-2222-4222-8222-222222222222",
  last: "33333333-3333-4333-8333-333333333333",
};

test("控制资产引用兼容旧字段，并保持原有槽位语义", () => {
  assert.deepEqual(normalizeControlReferences({
    reference_media_ids: [ids.reference],
    first_frame_media_id: ids.first,
    last_frame_media_id: ids.last,
  }), {
    referenceMediaIds: [ids.reference],
    firstFrameMediaId: ids.first,
    lastFrameMediaId: ids.last,
  });
});

test("控制资产引用接受新 references 形状并转换为既有仓储槽位", () => {
  assert.deepEqual(normalizeControlReferences({
    references: [
      { media_id: ids.reference, usage_mode: "reference" },
      { media_id: ids.first, usage_mode: "first_frame" },
      { media_id: ids.last, usage_mode: "last_frame" },
    ],
  }), {
    referenceMediaIds: [ids.reference],
    firstFrameMediaId: ids.first,
    lastFrameMediaId: ids.last,
  });
});

test("控制资产引用拒绝新旧双形状、重复槽位和未知 usage_mode", () => {
  assertControlUsageError(() => normalizeControlReferences({
    references: [{ media_id: ids.reference, usage_mode: "reference" }],
    reference_media_ids: [],
  }));
  assertControlUsageError(() => normalizeControlReferences({
    references: [
      { media_id: ids.first, usage_mode: "first_frame" },
      { media_id: ids.last, usage_mode: "first_frame" },
    ],
  }));
  assertControlUsageError(() => normalizeControlReferences({
    references: [{ media_id: ids.reference, usage_mode: "unknown" }],
  }));
});

test("仓储层既有 422 控制错误向外收敛为稳定错误码", () => {
  const normalized = normalizeControlReferenceError(new GenerationError(
    "INVALID_GENERATION_REQUEST",
    "3D 素模仅供导演台使用，不能作为生成参考",
    422,
  ));
  assert.ok(normalized instanceof GenerationError);
  assert.equal(normalized.code, "control_asset_invalid_usage");
  assert.equal(normalized.statusCode, 422);
});

function assertControlUsageError(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof GenerationError
    && error.code === "control_asset_invalid_usage"
    && error.statusCode === 422);
}

/* ---------- #164 拿定稿生视频:定稿图补进视频参考清单 ---------- */

const finalImageMediaId = "55555555-5555-4555-8555-555555555555";

function submissionBody(overrides: Partial<GenerationSubmissionBody>): GenerationSubmissionBody {
  return {
    media_kind: "video",
    tier_id: "video-tier",
    project_id: "66666666-6666-4666-8666-666666666666",
    shot_id: "77777777-7777-4777-8777-777777777777",
    use_project_style: true,
    parameters: {},
    quantity: 1,
    client_idempotency_key: "batch-key-123",
    ...overrides,
  };
}

/** R223 解析器改判别联合后,老用例的「null」语义拆成「本镜无定稿图」(absent)。 */
function finalReferenceRepository(mediaId: string | null, onCall?: () => void) {
  return {
    resolveShotFinalReference: async (): Promise<ShotFinalReferenceResolution> => {
      onCall?.();
      return mediaId ? { status: "registered", mediaId } : { status: "absent" };
    },
  };
}

test("视频生成带镜头时,定稿图的登记资产媒体补到参考清单最前", async () => {
  const existing = ids.reference;
  const result = await withShotFinalImageReference(
    finalReferenceRepository(finalImageMediaId),
    submissionBody({ reference_media_ids: [existing] }),
    { useRegisteredSeedanceAssetUris: true },
  );
  assert.deepEqual(result.reference_media_ids, [finalImageMediaId, existing]);
});

test("定稿参考已在清单里不重复补;清单缺省时自成一项", async () => {
  const deduped = await withShotFinalImageReference(
    finalReferenceRepository(finalImageMediaId),
    submissionBody({ reference_media_ids: [finalImageMediaId] }),
    { useRegisteredSeedanceAssetUris: true },
  );
  assert.deepEqual(deduped.reference_media_ids, [finalImageMediaId]);
  const created = await withShotFinalImageReference(
    finalReferenceRepository(finalImageMediaId),
    submissionBody({}),
    { useRegisteredSeedanceAssetUris: true },
  );
  assert.deepEqual(created.reference_media_ids, [finalImageMediaId]);
});

test("references 新形状同款:补在最前,usage_mode=reference", async () => {
  const result = await withShotFinalImageReference(
    finalReferenceRepository(finalImageMediaId),
    submissionBody({ references: [{ media_id: ids.reference, usage_mode: "reference" }] }),
    { useRegisteredSeedanceAssetUris: true },
  );
  assert.deepEqual(result.references, [
    { media_id: finalImageMediaId, usage_mode: "reference" },
    { media_id: ids.reference, usage_mode: "reference" },
  ]);
  assert.equal(result.reference_media_ids, undefined);
});

test("显式锚帧、非视频、无镜头、定稿未登记——四种情况一律原样不补", async () => {
  let calls = 0;
  const repository = finalReferenceRepository(finalImageMediaId, () => { calls += 1; });
  const anchored = submissionBody({ first_frame_media_id: ids.first });
  assert.equal(await withShotFinalImageReference(repository, anchored, { useRegisteredSeedanceAssetUris: true }), anchored);
  const image = submissionBody({ media_kind: "image" });
  assert.equal(await withShotFinalImageReference(repository, image, { useRegisteredSeedanceAssetUris: false }), image);
  const noShot = submissionBody({ shot_id: null });
  assert.equal(await withShotFinalImageReference(repository, noShot, { useRegisteredSeedanceAssetUris: true }), noShot);
  assert.equal(calls, 0);
  const unregistered = submissionBody({ reference_media_ids: [ids.reference] });
  let fallbackCalls = 0;
  const result = await withShotFinalImageReference(
    finalReferenceRepository(null, () => { fallbackCalls += 1; }),
    unregistered,
    { useRegisteredSeedanceAssetUris: true },
  );
  assert.equal(result, unregistered);
  assert.equal(fallbackCalls, 1);
});
