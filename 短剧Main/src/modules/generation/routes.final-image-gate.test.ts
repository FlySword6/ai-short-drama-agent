import assert from "node:assert/strict";
import test from "node:test";
import { GenerationError } from "./errors.js";
import {
  withShotFinalImageReference,
  type GenerationSubmissionBody,
  type ShotFinalReferenceResolution,
} from "./routes.js";

const ids = {
  final: "55555555-5555-4555-8555-555555555555",
  result: "66666666-6666-4666-8666-666666666666",
  reference: "11111111-1111-4111-8111-111111111111",
  first: "22222222-2222-4222-8222-822222222222",
};

function submissionBody(overrides: Partial<GenerationSubmissionBody> = {}): GenerationSubmissionBody {
  return {
    media_kind: "video",
    tier_id: "video-tier",
    project_id: "77777777-7777-4777-8777-777777777777",
    shot_id: "88888888-8888-4888-8888-888888888888",
    use_project_style: true,
    parameters: {},
    quantity: 1,
    client_idempotency_key: "gate-key-123",
    ...overrides,
  };
}

function resolver(resolution: ShotFinalReferenceResolution, onCall?: () => void) {
  return {
    resolveShotFinalReference: async () => {
      onCall?.();
      return resolution;
    },
  };
}

test("没有可复核直链资格时阻止提交，并明确不会丢掉定稿图", async () => {
  const error = await withShotFinalImageReference(
    resolver({ status: "unregistered" }),
    submissionBody(),
    { useRegisteredSeedanceAssetUris: true },
  ).then(() => null, (reason: unknown) => reason);
  assert.ok(error instanceof GenerationError);
  assert.equal(error.code, "shot_final_image_reference_unavailable");
  assert.match(error.displayMessage ?? error.message, /参考资产|纯文字/u);
});

test("已登记定稿图照旧以参考身份放在参考清单最前", async () => {
  const result = await withShotFinalImageReference(
    resolver({ status: "registered", mediaId: ids.final }),
    submissionBody({ reference_media_ids: [ids.reference] }),
    { useRegisteredSeedanceAssetUris: true },
  );
  assert.deepEqual(result.reference_media_ids, [ids.final, ids.reference]);
  assert.equal(result.shotFinalReference, undefined);
});

test("没有定稿图时不误伤文字生视频", async () => {
  const input = submissionBody();
  const result = await withShotFinalImageReference(
    resolver({ status: "absent" }),
    input,
    { useRegisteredSeedanceAssetUris: true },
  );
  assert.equal(result, input);
});

test("显式锚帧时不改写调用方的控制模式", async () => {
  let calls = 0;
  const input = submissionBody({ first_frame_media_id: ids.first });
  const result = await withShotFinalImageReference(
    resolver({ status: "registered", mediaId: ids.final }, () => { calls += 1; }),
    input,
    { useRegisteredSeedanceAssetUris: true },
  );
  assert.equal(result, input);
  assert.equal(calls, 0);
});
