import assert from "node:assert/strict";
import test from "node:test";
import type { TieredBatchEstimateItemInput } from "./api";
import {
  FALLBACK_IMAGE_TIER,
  FALLBACK_VIDEO_TIER,
} from "./capability-tiers";
import {
  buildBatchItems,
  batchSubmitIdempotencyForEstimate,
  buildBatchSubmitInput,
  demoBatchEstimate,
  episodeGroup,
  filterProjects,
  formatCredits,
  referenceMediaIdsFromRefs,
  selectedMediaForKind,
  shotDisplayName,
  submitBatchEstimate,
} from "./pages/batch-generate-drawer";
import type { BatchEstimateResult, GenerationQuote, Project, ProjectAssetRef, Shot } from "./types";

const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";

function shot(partial: Partial<Shot> & { id: string }): Shot {
  return { episode_id: episodeId, shot_no: "1", ...partial };
}

/* ---------- 批量抽屉估价流：prompt 组装与 item 形状 ---------- */

test("buildBatchItems 按 video_prompt > director_prompt > script_text 组装 prompt", () => {
  const items = buildBatchItems({
    projectId,
    episodeId,
    mediaKind: "video",
    shots: [
      shot({ id: "s1", video_prompt: "  视频提示词  ", director_prompt: "导演提示词", script_text: "剧本文本" }),
      shot({ id: "s2", video_prompt: "", director_prompt: "导演提示词", script_text: "剧本文本" }),
      shot({ id: "s3", script_text: "  剧本文本  " }),
      shot({ id: "s4", shot_no: "7" }),
    ],
    referenceMediaIds: ["media-1"],
    tier: FALLBACK_VIDEO_TIER,
  });
  assert.equal(items[0]?.prompt, "视频提示词");
  assert.equal(items[1]?.prompt, "导演提示词");
  assert.equal(items[2]?.prompt, "剧本文本");
  assert.equal(items[3]?.prompt, "素材 #7");
});

test("buildBatchItems：item_id 用 shot.id 保序回显，图片走 image_prompt 与图片参数", () => {
  const items = buildBatchItems({
    projectId,
    episodeId,
    mediaKind: "image",
    shots: [shot({ id: "s1", image_prompt: "图片提示词", video_prompt: "视频提示词", scene_id: "scene-9" })],
    referenceMediaIds: ["media-1", "media-2"],
    tier: FALLBACK_IMAGE_TIER,
  });
  const item = items[0]!;
  assert.equal(item.item_id, "s1");
  assert.equal(item.shot_id, "s1");
  assert.equal(item.episode_id, episodeId);
  assert.equal(item.scene_id, "scene-9");
  assert.equal(item.prompt, "图片提示词");
  assert.deepEqual(item.reference_media_ids, ["media-1", "media-2"]);
  assert.equal(item.media_kind, "image");
  assert.equal(item.quantity, 1);
  assert.match(item.client_idempotency_key, /^batch-/);
  assert.ok(item.client_idempotency_key.length >= 8);
});

test("buildBatchItems：档是原子的——参数整档取不随分镜覆盖，tier_id 全链透传（能力档合同）", () => {
  /* 能力档线在途契约（batch-generate-drawer buildBatchItems）：parameters 整档取 tierSubmitInput，
     分镜 duration_seconds 不再覆盖档参数；tier_id 全链必填随项透传（不一致 422）。
     FALLBACK_VIDEO_TIER = 4 秒档。 */
  const items = buildBatchItems({
    projectId,
    episodeId,
    mediaKind: "video",
    shots: [shot({ id: "s1", duration_seconds: 6 }), shot({ id: "s2" })],
    referenceMediaIds: [],
    tier: FALLBACK_VIDEO_TIER,
  });
  assert.equal(items[0]?.parameters.duration_seconds, 4);
  assert.equal(items[1]?.parameters.duration_seconds, 4);
  assert.equal(items[0]?.tier_id, FALLBACK_VIDEO_TIER.tier_id);
  assert.equal(items[1]?.tier_id, FALLBACK_VIDEO_TIER.tier_id);
});

/* ---------- 批量提交：一次人工点击确认后授权提交 ---------- */

function quote(id: string, fen = 100): GenerationQuote {
  return {
    generation_quote_id: id,
    source: "web",
    action: "submit",
    status: "pending_confirmation",
    estimated_cost_fen: fen,
    currency: "CNY",
    expires_at: new Date(Date.now() + 900_000).toISOString(),
  };
}

function estimate(items: BatchEstimateResult["items"]): BatchEstimateResult {
  const available = items.filter((item) => item.availability === "available");
  return {
    items,
    count: items.length,
    available_count: available.length,
    unavailable_count: items.length - available.length,
    total_estimated_cost_fen: available.reduce((sum, item) => sum + (item.quote?.estimated_cost_fen ?? 0), 0),
    currency: "CNY",
    requires_manual_review: false,
    creates_generation_tasks: false,
  };
}

function batchItems(ids: string[]): TieredBatchEstimateItemInput[] {
  return buildBatchItems({
    projectId,
    episodeId,
    mediaKind: "video",
    shots: ids.map((id) => shot({ id, script_text: `剧本 ${id}` })),
    referenceMediaIds: ["media-1"],
    tier: FALLBACK_VIDEO_TIER,
  });
}

test("批量提交：只带已报价行，合计取同一批报价快照", () => {
  const input = buildBatchSubmitInput({
    projectId,
    clientIdempotencyKey: "batch-key-1",
    estimate: estimate([
      { itemId: "s1", availability: "available", quote: quote("q1", 120) },
      { itemId: "s2", availability: "unavailable", error: { message: "模型不可用" } },
      { itemId: "s3", availability: "available", quote: quote("q3", 80) },
    ]),
  });
  assert.deepEqual(input, {
    project_id: projectId,
    client_idempotency_key: "batch-key-1",
    expected_total_estimated_cost_fen: 200,
    items: [{ item_id: "s1", generation_quote_id: "q1" }, { item_id: "s3", generation_quote_id: "q3" }],
  });
});

test("批量提交：一次点击先确认后提交，第二步不重传报价清单", async () => {
  const calls: string[] = [];
  const result = await submitBatchEstimate({
    projectId,
    clientIdempotencyKey: "batch-key-2",
    estimate: estimate([
      { itemId: "s1", availability: "available", quote: quote("q1", 100) },
      { itemId: "s2", availability: "available", quote: quote("q2", 200) },
    ]),
    client: {
      async batchConfirm(input) {
        calls.push("confirm");
      assert.equal(input.expected_total_estimated_cost_fen, 300);
        return { authorization_id: "auth-1" };
      },
      async submitGenerationBatch(authorizationId) {
        calls.push(`submit:${authorizationId}`);
        assert.equal(authorizationId, "auth-1");
      return {
        authorization_id: "auth-1", status: "partial", authorized_total_estimated_cost_fen: 300,
        submitted_total_estimated_cost_fen: 100, currency: "CNY", created_count: 1, failed_count: 1,
        items: [
          { item_id: "s1", generation_quote_id: "q1", estimated_cost_fen: 100, status: "created", queue_position: 2, estimated_duration_seconds: 90 },
          { item_id: "s2", generation_quote_id: "q2", estimated_cost_fen: 200, status: "expired", error: { code: "quote_expired", message: "报价已过期", retryable: true } },
        ],
      };
      },
    },
  });
  assert.deepEqual(calls, ["confirm", "submit:auth-1"]);
  assert.equal(result.items[0]?.queue_position, 2);
  assert.equal(result.items[1]?.error?.message, "报价已过期");
});

test("批量提交：同一份冻结清单重试复用幂等键，重估后才换新键", () => {
  const first = batchSubmitIdempotencyForEstimate(null, "estimate-a", projectId, () => "uuid-1");
  const replay = batchSubmitIdempotencyForEstimate(first, "estimate-a", projectId, () => "uuid-ignored");
  const refreshed = batchSubmitIdempotencyForEstimate(replay, "estimate-b", projectId, () => "uuid-2");
  assert.equal(first.clientIdempotencyKey, `batch-submit-${projectId}-uuid-1`);
  assert.equal(replay.clientIdempotencyKey, first.clientIdempotencyKey);
  assert.equal(refreshed.clientIdempotencyKey, `batch-submit-${projectId}-uuid-2`);
});

/* ---------- 估价结果合计与阈值（demo 合成器与后端 batchEstimateData 同构；K2S 起行价随档） ---------- */

test("demoBatchEstimate：逐项估价随档取价、合计只算可行行、超阈值触发复核提示", () => {
  const result = demoBatchEstimate(batchItems(["s1", "s2", "s3"]), FALLBACK_VIDEO_TIER);
  assert.equal(result.count, 3);
  assert.equal(result.available_count, 3);
  assert.equal(result.total_estimated_cost_fen, 960); // 档价 320 × 3 镜（80 积分/秒 × 4 秒）
  assert.equal(result.creates_generation_tasks, false);
  assert.equal(result.requires_manual_review, true);
});

test("demoBatchEstimate：无提示词文本的分镜标为不可行，不拖垮整批", () => {
  const items = buildBatchItems({
    projectId,
    episodeId,
    mediaKind: "video",
    shots: [shot({ id: "s1", script_text: "有文本" }), shot({ id: "s2", shot_no: "9" })],
    referenceMediaIds: [],
  });
  const result = demoBatchEstimate(items, FALLBACK_VIDEO_TIER);
  assert.equal(result.available_count, 1);
  assert.equal(result.unavailable_count, 1);
  assert.equal(result.items[1]?.availability, "unavailable");
  assert.equal(result.total_estimated_cost_fen, 320);
});

/* ---------- 板01：筛选与四态计数聚合 ---------- */

test("filterProjects：状态 tab 过滤 + 名称/负责人搜索", () => {
  const projects: Project[] = [
    { id: "p1", name: "《老公诈死》", status: "进行中", description: "备料对照" },
    { id: "p2", name: "《她从火光中来》", status: "已归档" },
    { id: "p3", name: "《迷局》", status: "active", owner_id: "other-user" },
    { id: "p4", name: "《未知态》", status: "weird-status" },
  ];
  const owner = (project: Project) => (project.owner_id === "other-user" ? "李四" : "Alice");
  assert.deepEqual(filterProjects(projects, "all", "", owner).map((p) => p.id), ["p1", "p2", "p3", "p4"]);
  assert.deepEqual(filterProjects(projects, "active", "", owner).map((p) => p.id), ["p1", "p3"]);
  assert.deepEqual(filterProjects(projects, "archived", "", owner).map((p) => p.id), ["p2"]);
  assert.deepEqual(filterProjects(projects, "completed", "", owner), []);
  assert.deepEqual(filterProjects(projects, "all", "诈死", owner).map((p) => p.id), ["p1"]);
  assert.deepEqual(filterProjects(projects, "all", "李四", owner).map((p) => p.id), ["p3"]);
  assert.deepEqual(filterProjects(projects, "archived", "诈死", owner), []);
});

test("selectedMediaForKind：优先 shot 选中的媒体，缺失时回退同类型 is_primary", () => {
  const withSelection = shot({ id: "a", selected_image_result_id: "m2" });
  const mediaList = [
    { id: "m1", media_kind: "image", is_primary: true },
    { id: "m2", media_kind: "image" },
  ];
  assert.equal(selectedMediaForKind(withSelection, mediaList, "image")?.id, "m2");
  const withoutSelection = shot({ id: "b" });
  assert.equal(selectedMediaForKind(withoutSelection, mediaList, "image")?.id, "m1");
  assert.equal(selectedMediaForKind(withoutSelection, mediaList, "video"), null);
});

/* ---------- 板03：命名、集分组、引用媒体 ---------- */

test("shotDisplayName：集-分镜-场景-版本，缺场景回退未分场", () => {
  assert.equal(shotDisplayName(1, shot({ id: "s1", shot_no: "1" }), "客厅"), "1-1-客厅-v1");
  assert.equal(shotDisplayName(2, shot({ id: "s2", shot_no: "12" }), "北疆战场"), "2-12-北疆战场-v1");
  assert.equal(shotDisplayName(3, shot({ id: "s3", shot_no: "4" })), "3-4-未分场-v1");
  assert.equal(shotDisplayName(1, shot({ id: "s4", shot_no: "", sort_order: 5 })), "1-5-未分场-v1");
});

test("episodeGroup：剧本集与空白集分组", () => {
  const base = { id: "e", project_id: projectId, episode_no: 1 };
  // 裁决 8：Episode.status 真值域收敛 active|archived（manual/draft/imported 已删），分组=名称启发式
  assert.equal(episodeGroup({ ...base, name: "第1集", status: "active" }), "script");
  assert.equal(episodeGroup({ ...base, name: "空白集 4", status: "active" }), "blank");
  assert.equal(episodeGroup({ ...base, name: "", status: "active" }), "blank");
  assert.equal(episodeGroup({ ...base, name: "未命名集 2", status: "archived" }), "blank");
});

test("referenceMediaIdsFromRefs：取资产选定媒体 id，去重，上限 4 条", () => {
  const refs = [
    { id: "r1", asset_media_id: "m1" },
    { id: "r2", asset: { id: "a2", selected_media_id: "m2" } },
    { id: "r3", asset: { id: "a3", current_media: { id: "m3" } } },
    { id: "r4", asset_media_id: "m1" },
    { id: "r5", asset_media_id: "m5" },
    { id: "r6", asset_media_id: "m6" },
  ] as ProjectAssetRef[];
  assert.deepEqual(referenceMediaIdsFromRefs(refs), ["m1", "m2", "m3", "m5"]);
});

/* ---------- 积分口径 ---------- */

test("formatCredits：1 积分 = 1 分（fen 原值），千分位显示", () => {
  assert.equal(formatCredits(12_400), "12,400 积分");
  assert.equal(formatCredits(200), "200 积分");
  assert.equal(formatCredits(0), "0 积分");
});
