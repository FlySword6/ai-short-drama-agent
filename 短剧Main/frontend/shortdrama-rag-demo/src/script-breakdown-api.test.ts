/* ============================================================
   script-breakdown-api.test.ts — S20 剧本拆解前端解析回归

   病根:后端 success() 把响应递归转成 snake_case,首版前端解析只读
   camelCase,真机冒烟时 draft/validation/stages 全部静默解析为空。
   这里用与真机等形的 snake_case wire 载荷锁定解析,并锁请求路径与
   请求体键(幂等键必带)。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import {
  api,
  scriptBreakdownConfirmFromUnknown,
  scriptBreakdownRunDetailFromUnknown,
  scriptVersionFromUnknown,
} from "./api";

const episodeId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";

/* 与真机 /api/v1/script-breakdowns/:id 等形的 snake_case 载荷。 */
const wireRun = {
  id: runId,
  episode_id: episodeId,
  script_version_id: versionId,
  status: "draft",
  current_stage: null,
  model_name: "fake-breakdown-model",
  prompt_version: "script-breakdown.v5",
  target_duration_sec: 90,
  input_sha256: "deadbeef",
  draft: {
    story_summary: "林晚雨夜归家,与旧人重逢。",
    scene_divisions: [
      { scene_index: 0, name: "旧宅客厅", summary: "重逢", start_line_index: 0, end_line_index: 2 },
    ],
    asset_candidates: {
      characters: [{
        candidate_id: "char_1",
        name: "林晚",
        description: "女主",
        gender: "女",
        age_value: 28,
        age_stage: "adult",
        appearance: "短发",
        personality_tags: ["果断"],
        prelinked_asset: {
          asset_entity_id: "asset-1",
          name: "林晚",
          matched_by: "exact_name",
        },
      }],
      scenes: [{ candidate_id: "scene_1", name: "旧宅客厅", description: null }],
      props: [],
    },
    shot_candidates: [
      {
        candidate_id: "shot_1",
        shot_no: 1,
        scene_index: 0,
        line_indices: [0, 1],
        elements: {
          subject: "林晚",
          action: "推门后愣住",
          visual: "雨夜客厅，暖光",
          camera_language: "中景定格",
        },
        duration_sec: 6,
        character_names: ["林晚"],
        scene_names: ["旧宅客厅"],
        prop_names: [],
      },
    ],
  },
  validation: {
    status: "pass_with_warnings",
    issues: [{ code: "unmatched_asset", message: "林晚 未匹配到项目资产", path: "assets" }],
    unmatched_assets: [{ kind: "character", name: "林晚", shot_candidate_ids: ["shot_1"] }],
    duplicate_coverage: [{ line_index: 1, shot_candidate_ids: ["shot_1", "shot_2"] }],
    shot_count: 1,
    total_duration_sec: 6,
  },
  usage: { call_count: 4, total_input_tokens: 100, total_output_tokens: 50 },
  error_code: null,
  error_message: null,
  display_reason: null,
  confirmed_by_user_id: null,
  confirmed_at: null,
  discarded_by_user_id: null,
  discarded_at: null,
  superseded_by_run_id: null,
  created_by_user_id: "user-1",
  created_at: "2026-07-25T09:00:00.000Z",
  updated_at: "2026-07-25T09:01:00.000Z",
};

const wireStages = [
  {
    stage_key: "structure",
    stage_order: 1,
    status: "succeeded",
    attempt_count: 1,
    validation: { issues: [] },
    usage: { calls: [] },
    error_code: null,
    error_message: null,
    display_reason: null,
    started_at: "2026-07-25T09:00:01.000Z",
    completed_at: "2026-07-25T09:00:02.000Z",
  },
  {
    stage_key: "shots:scene:0",
    stage_order: 3,
    status: "failed",
    attempt_count: 2,
    validation: { issues: [] },
    usage: { calls: [] },
    error_code: "upstream_error",
    display_reason: "分镜没整理完整：镜头顺序或场次归属没有对上，请检查后重试。",
    started_at: "2026-07-25T09:00:03.000Z",
    completed_at: "2026-07-25T09:00:04.000Z",
  },
];

test("运行详情把 snake_case wire 完整映射为可渲染结构(嵌套 draft/validation/stages)", () => {
  const detail = scriptBreakdownRunDetailFromUnknown({ run: wireRun, stages: wireStages });
  assert.equal(detail.run.id, runId);
  assert.equal(detail.run.scriptVersionId, versionId);
  assert.equal(detail.run.status, "draft");
  assert.equal(detail.run.modelName, "fake-breakdown-model");
  assert.equal(detail.run.targetDurationSec, 90);
  // draft 嵌套键同样是 snake_case,必须双读
  assert.equal(detail.draft.storySummary, "林晚雨夜归家,与旧人重逢。");
  assert.equal(detail.draft.sceneDivisions.length, 1);
  assert.deepEqual(
    detail.draft.sceneDivisions[0],
    { sceneIndex: 0, name: "旧宅客厅", summary: "重逢", startLineIndex: 0, endLineIndex: 2 },
  );
  assert.equal(detail.draft.assetCandidates.characters[0]?.candidateId, "char_1");
  assert.equal(detail.draft.assetCandidates.characters[0]?.gender, "女");
  assert.equal(detail.draft.assetCandidates.characters[0]?.ageValue, 28);
  assert.deepEqual(detail.draft.assetCandidates.characters[0]?.personalityTags, ["果断"]);
  assert.equal(detail.draft.assetCandidates.characters[0]?.prelinkedAsset?.assetEntityId, "asset-1");
  assert.equal(detail.draft.assetCandidates.scenes[0]?.name, "旧宅客厅");
  const shot = detail.draft.shotCandidates[0]!;
  assert.equal(shot.candidateId, "shot_1");
  assert.equal(shot.shotNo, 1);
  assert.deepEqual(shot.lineIndices, [0, 1]);
  assert.equal(shot.directorPrompt, null);
  assert.equal(shot.elements?.cameraLanguage, "中景定格");
  assert.equal(shot.durationSec, 6);
  assert.deepEqual(shot.characterNames, ["林晚"]);
  // validation 嵌套
  assert.equal(detail.validation.status, "pass_with_warnings");
  assert.equal(detail.validation.issues[0]?.code, "unmatched_asset");
  assert.deepEqual(detail.validation.unmatchedAssets[0], { kind: "character", name: "林晚", shotCandidateIds: ["shot_1"] });
  assert.deepEqual(detail.validation.duplicateCoverage[0], { lineIndex: 1, shotCandidateIds: ["shot_1", "shot_2"] });
  assert.equal(detail.validation.shotCount, 1);
  assert.equal(detail.validation.totalDurationSec, 6);
  // stages
  assert.equal(detail.stages.length, 2);
  assert.equal(detail.stages[1]?.stageKey, "shots:scene:0");
  assert.equal(detail.stages[1]?.status, "failed");
  assert.equal(detail.stages[1]?.displayReason, "分镜没整理完整：镜头顺序或场次归属没有对上，请检查后重试。");
});

test("剧本版本与确认结果按 snake_case 解析", () => {
  const version = scriptVersionFromUnknown({
    id: versionId,
    episode_id: episodeId,
    version_no: 3,
    title: "初稿",
    script_sha256: "beef",
    source: "manual",
    created_by_user_id: "user-1",
    created_at: "2026-07-25T09:00:00.000Z",
  });
  assert.equal(version.versionNo, 3);
  assert.equal(version.title, "初稿");

  const confirmed = scriptBreakdownConfirmFromUnknown({
    run_id: runId,
    outcome: "already_confirmed",
    scene_count: 2,
    shot_count: 5,
    superseded_run_ids: ["55555555-5555-4555-8555-555555555555"],
    unmatched_assets: [{ kind: "prop", name: "油纸伞", shot_candidate_ids: ["shot_2"] }],
  });
  assert.equal(confirmed.runId, runId);
  assert.equal(confirmed.outcome, "already_confirmed");
  assert.equal(confirmed.sceneCount, 2);
  assert.equal(confirmed.shotCount, 5);
  assert.equal(confirmed.supersededRunIds.length, 1);
  assert.equal(confirmed.unmatchedAssets[0]?.name, "油纸伞");
});

test("客户端方法:路径/snake 请求体/幂等键", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { run: wireRun, stages: wireStages, outcome: "created" } });
    const detail = await api.createScriptBreakdown(episodeId, { scriptVersionId: versionId, targetDurationSec: 90 });
    assert.equal(detail.run.id, runId);
    assert.equal(detail.draft.shotCandidates.length, 1);
    const createRequest = requests.items[0]!;
    assert.equal(createRequest.url, `/api/v1/episodes/${episodeId}/script-breakdowns`);
    const body = JSON.parse(String(createRequest.init.body)) as Record<string, unknown>;
    assert.equal(body.script_version_id, versionId);
    assert.equal(body.target_duration_sec, 90);
    assert.equal(typeof body.client_idempotency_key, "string");
    assert.ok(String(body.client_idempotency_key).length >= 8);

    requests.respondWith({ ok: true, data: { run: wireRun, stages: wireStages } });
    await api.scriptBreakdown(runId);
    assert.equal(requests.items[1]?.url, `/api/v1/script-breakdowns/${runId}`);

    requests.respondWith({ ok: true, data: { run_id: runId, outcome: "confirmed", scene_count: 1, shot_count: 1, superseded_run_ids: [], unmatched_assets: [] } });
    const confirmed = await api.confirmScriptBreakdown(runId);
    assert.equal(confirmed.outcome, "confirmed");
    assert.equal(requests.items[2]?.url, `/api/v1/script-breakdowns/${runId}/confirm`);
    assert.equal(requests.items[2]?.init.method, "POST");
  });
});

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

async function withMockBrowser(
  run: (requests: {
    items: CapturedRequest[];
    respondWith: (body: unknown, status?: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  const items: CapturedRequest[] = [];
  let responseBody: unknown = { ok: true, data: null };
  let responseStatus = 200;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    items.push({ url: String(input), init });
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  api.setToken("test-token");
  try {
    await run({
      items,
      respondWith: (body, status = 200) => {
        responseBody = body;
        responseStatus = status;
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
