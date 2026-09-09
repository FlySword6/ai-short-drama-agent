/* ============================================================
   reference-tests.test.ts — W5-B 测试域（板07）纯函数与 fixture 验收
   覆盖：模式卡文案映射、「当前默认」判定、默认策略版本回退、409 冲突辅助、
   生成入参组装（不改动原测试对象）、demo fixture 形状、结果序号格式化。
   页面文件保持 CSS-free，可直接被本测试 import（同 settings-page 约定）。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { ApiClientError, pageFromUnknown, projectReferenceTestResultFromUnknown, referenceTestFromUnknown } from "./api";
import {
  REFERENCE_MEDIA_LIMIT,
  REFERENCE_TEST_MODE_CARDS,
  RUN_MAX_POLLS,
  RUN_POLL_INTERVAL_MS,
  buildTestGenerationInput,
  defaultStrategyVersion,
  demoReferenceTestDefaults,
  demoReferenceTestResults,
  demoReferenceTests,
  formatResultOrdinal,
  isConflictError,
  mediaKindGoal,
  mediaKindNoun,
  modelKeyLabel,
  referenceTestModeCopy,
  resultIsCurrentDefault,
  runButtonLabel,
} from "./pages/reference-tests-page";
import { FALLBACK_VIDEO_TIER } from "./capability-tiers";
import type { ReferenceTestMediaKind, ReferenceTestMode } from "./types";

/* ---------- 模式卡文案映射（板07 用词） ---------- */

test("两张模式卡：直接@素材生成 / 素材转提示词，文案说清链路差异", () => {
  assert.deepEqual(Object.keys(REFERENCE_TEST_MODE_CARDS).sort(), ["direct_reference", "material_to_prompt"]);
  assert.equal(referenceTestModeCopy("direct_reference").name, "直接@素材生成模式");
  assert.equal(referenceTestModeCopy("material_to_prompt").name, "素材转提示词参考模式");
  assert.match(referenceTestModeCopy("direct_reference").summary, /保留@参考图/);
  assert.match(referenceTestModeCopy("material_to_prompt").summary, /解析参考素材为镜头光线提示词/);
});

test("媒体文案：名词 / 生成目标 / 运行按钮带生成目标", () => {
  assert.equal(mediaKindNoun("image"), "图片");
  assert.equal(mediaKindNoun("video"), "视频");
  assert.equal(mediaKindGoal("image"), "生图片");
  assert.equal(mediaKindGoal("video"), "生视频");
  assert.equal(runButtonLabel("image"), "生成测试图片");
  assert.equal(runButtonLabel("video"), "生成测试视频");
});

test("model_key 展示：configured 映射为当前配置模型，其余原样透出", () => {
  assert.equal(modelKeyLabel("configured"), "当前配置模型");
  assert.equal(modelKeyLabel("seedance-2-0"), "seedance-2-0");
  assert.equal(modelKeyLabel(""), "未选模型");
});

/* ---------- 「当前默认」判定与默认策略版本 ---------- */

const strategies = [
  {
    id: "strategy-image",
    project_id: "p1",
    media_kind: "image" as const,
    mode: "direct_reference" as const,
    model_key: "configured",
    parameters: {},
    source_generation_request_id: "req-01",
    version: 3,
  },
];

test("当前默认：同媒体类型策略的来源请求与结果请求一致才算", () => {
  assert.equal(resultIsCurrentDefault(strategies, { mediaKind: "image", generationRequestId: "req-01" }), true);
  assert.equal(resultIsCurrentDefault(strategies, { mediaKind: "image", generationRequestId: "req-02" }), false);
  // 请求 id 相同但媒体类型不同（策略按 media_kind 各存一份）不算。
  assert.equal(resultIsCurrentDefault(strategies, { mediaKind: "video", generationRequestId: "req-01" }), false);
});

test("当前默认：策略缺少来源请求或策略列表为空时恒为 false", () => {
  const withoutSource = [{ ...strategies[0]!, source_generation_request_id: null }];
  assert.equal(resultIsCurrentDefault(withoutSource, { mediaKind: "image", generationRequestId: "req-01" }), false);
  assert.equal(resultIsCurrentDefault([], { mediaKind: "image", generationRequestId: "req-01" }), false);
});

test("设为默认的乐观锁版本：取同媒体类型策略 version，未持久化回 0", () => {
  assert.equal(defaultStrategyVersion(strategies, "image"), 3);
  assert.equal(defaultStrategyVersion(strategies, "video"), 0);
  assert.equal(defaultStrategyVersion([], "image"), 0);
});

/* ---------- 409 冲突辅助（板14 冲突态） ---------- */

test("409 版本冲突识别：只看 ApiClientError 的 status", () => {
  assert.equal(isConflictError(new ApiClientError("版本冲突", { status: 409, code: "version_conflict" })), true);
  assert.equal(isConflictError(new ApiClientError("服务错误", { status: 500 })), false);
  assert.equal(isConflictError(new Error("版本冲突")), false);
  assert.equal(isConflictError("409"), false);
  assert.equal(isConflictError(null), false);
});

/* ---------- 生成入参组装 ---------- */

test("生成入参：项目级生成，parameters=整档参数（mode/model_key 留存登记不进提交），tier_id 透传", () => {
  const test = {
    mediaKind: "video" as const,
    mode: "material_to_prompt" as const,
    modelKey: "configured",
    prompt: "  镜头推进  ",
    parameters: { ratio: "9:16", duration_seconds: 4 },
    referenceMediaIds: ["media-1", "media-2"],
  };
  const input = buildTestGenerationInput(test, "project-1", "idem-1", FALLBACK_VIDEO_TIER);
  assert.equal(input.media_kind, "video");
  assert.equal(input.project_id, "project-1");
  assert.equal(input.episode_id, null);
  assert.equal(input.scene_id, null);
  assert.equal(input.shot_id, null);
  assert.equal(input.quantity, 1);
  assert.equal(input.client_idempotency_key, "idem-1");
  assert.equal(input.tier_id, FALLBACK_VIDEO_TIER.tier_id);
  // 提交参数=整档（tierSubmitInput）：resolution/duration 随档,mode/model_key 不进提交（档外组合 422）
  assert.deepEqual(input.parameters, {
    ratio: "9:16",
    resolution: "720p",
    duration_seconds: 4,
  });
  assert.deepEqual(input.reference_media_ids, ["media-1", "media-2"]);
  // 不改动原测试对象（编辑态继续用原 version 走乐观锁）。
  assert.deepEqual(test.parameters, { ratio: "9:16", duration_seconds: 4 });
  input.reference_media_ids.push("media-3");
  assert.equal(test.referenceMediaIds.length, 2);
});

/* ---------- 结果序号格式化 ---------- */

test("结果序号：#01 起两位数补齐，越界输入安全兜底", () => {
  assert.equal(formatResultOrdinal(1), "#01");
  assert.equal(formatResultOrdinal(9), "#09");
  assert.equal(formatResultOrdinal(10), "#10");
  assert.equal(formatResultOrdinal(123), "#123");
  assert.equal(formatResultOrdinal(0), "#01");
  assert.equal(formatResultOrdinal(2.9), "#02");
});

/* ---------- demo fixture 形状 ---------- */

test("fixture：≥2 个测试且字段完整，乐观锁 version 齐备", () => {
  assert.ok(demoReferenceTests.length >= 2);
  const kinds = new Set<ReferenceTestMediaKind>();
  const modes = new Set<ReferenceTestMode>();
  for (const item of demoReferenceTests) {
    assert.ok(item.id && item.name.trim(), "测试缺 id 或名称");
    assert.ok(item.modelKey, "测试缺 modelKey");
    assert.ok(Number.isInteger(item.version), "测试缺乐观锁 version");
    assert.ok(Array.isArray(item.referenceMediaIds));
    assert.ok(item.referenceMediaIds.length <= REFERENCE_MEDIA_LIMIT);
    kinds.add(item.mediaKind);
    modes.add(item.mode);
  }
  assert.deepEqual([...kinds].sort(), ["image", "video"]);
  assert.deepEqual([...modes].sort(), ["direct_reference", "material_to_prompt"]);
});

test("fixture：4 条结果覆盖两模式 × 两媒体类型，且都挂在存在的测试上", () => {
  assert.equal(demoReferenceTestResults.length, 4);
  const testIds = new Set(demoReferenceTests.map((item) => item.id));
  const combos = new Set<string>();
  for (const result of demoReferenceTestResults) {
    assert.ok(testIds.has(result.referenceTestId), `结果 ${result.id} 挂到不存在的测试`);
    assert.ok(result.generationRequestId && result.mediaResultId, `结果 ${result.id} 缺请求或产物 id`);
    assert.ok(result.referenceTestName.trim(), `结果 ${result.id} 缺测试名快照`);
    assert.equal("reviewStatus" in (result.mediaResult ?? {}), false, "参考测试结果不能伪造媒体审核状态");
    combos.add(`${result.mediaKind}:${result.mode}`);
  }
  assert.deepEqual([...combos].sort(), [
    "image:direct_reference",
    "image:material_to_prompt",
    "video:direct_reference",
    "video:material_to_prompt",
  ]);
});

test("fixture：恰好一条「当前默认」，由默认策略的来源请求指认", () => {
  const defaults = demoReferenceTestResults.filter((result) => resultIsCurrentDefault(demoReferenceTestDefaults, result));
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0]?.id, "demo-rtr-1");
  // 视频类型没有持久化策略：「设为默认」走 version=0 路径。
  assert.equal(defaultStrategyVersion(demoReferenceTestDefaults, "video"), 0);
  assert.equal(defaultStrategyVersion(demoReferenceTestDefaults, "image"), demoReferenceTestDefaults[0]?.version);
});

/* ---------- 轮询节奏合同（3s × 100 ≈ 5 分钟） ---------- */

test("生成测试轮询：3s 间隔、约 5 分钟停止等待", () => {
  assert.equal(RUN_POLL_INTERVAL_MS, 3_000);
  assert.equal(RUN_MAX_POLLS, 100);
  assert.ok(RUN_POLL_INTERVAL_MS * RUN_MAX_POLLS <= 5 * 60 * 1000);
});

/* ---------- H 线 P0-1：api.ts 参考测试域键名归一（wire 全 snake_case，后端 success() 递归 toSnakeCaseJson） ---------- */

test("referenceTestFromUnknown：snake wire 全字段归一（reference_media_ids/model_key/updated_at）", () => {
  const test0 = referenceTestFromUnknown({
    id: "rt-1",
    project_id: "p1",
    name: "夜戏雨巷",
    media_kind: "image",
    mode: "direct_reference",
    model_key: "seedream-4-5",
    prompt: "雨夜巷口",
    parameters: { ratio: "16:9" },
    reference_media_ids: ["m1", "m2"],
    created_by_user_id: "u1",
    version: 2,
    created_at: "2026-07-18T09:30:00.000Z",
    updated_at: "2026-07-19T10:00:00.000Z",
  });
  assert.deepEqual(test0, {
    id: "rt-1",
    projectId: "p1",
    name: "夜戏雨巷",
    mediaKind: "image",
    mode: "direct_reference",
    modelKey: "seedream-4-5",
    prompt: "雨夜巷口",
    parameters: { ratio: "16:9" },
    referenceMediaIds: ["m1", "m2"],
    createdByUserId: "u1",
    version: 2,
    createdAt: "2026-07-18T09:30:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
  });
  // 崩溃点回归：referenceMediaIds 恒为数组（卡片直接 .length，旧读法 snake 未归一为 undefined 崩页）
  assert.deepEqual(referenceTestFromUnknown({ id: "rt-2", reference_media_ids: null }).referenceMediaIds, []);
  assert.deepEqual(referenceTestFromUnknown({ id: "rt-3", reference_media_ids: ["m1", 7, null] }).referenceMediaIds, ["m1"]);
  // 归一后的测试可直接进生成入参组装
  const input = buildTestGenerationInput(referenceTestFromUnknown({ id: "rt-4", media_kind: "video", mode: "material_to_prompt", model_key: "configured", prompt: "推进", parameters: {}, reference_media_ids: ["m9"] }), "p1", "idem-1", FALLBACK_VIDEO_TIER);
  assert.equal(input.media_kind, "video");
  assert.deepEqual(input.reference_media_ids, ["m9"]);
});

test("projectReferenceTestResultFromUnknown：snake wire 归一，media_result 嵌套摘要同步归一", () => {
  const result = projectReferenceTestResultFromUnknown({
    id: "rtr-1",
    reference_test_id: "rt-1",
    reference_test_name: "夜戏雨巷",
    generation_request_id: "req-1",
    media_result_id: "mr-1",
    media_kind: "video",
    mode: "material_to_prompt",
    model_key: "seedance-2-0",
    parameters: { duration_seconds: 5 },
    created_by_user_id: "u1",
    created_at: "2026-07-18T10:05:00.000Z",
    media_result: {
      storage_url: "https://media.example.com/rtr-1.mp4",
      persistence_status: "persisted",
      mime_type: "video/mp4",
      width_px: 720,
      height_px: 1280,
      duration_seconds: 5,
    },
  });
  assert.equal(result.referenceTestId, "rt-1");
  assert.equal(result.referenceTestName, "夜戏雨巷");
  assert.equal(result.generationRequestId, "req-1");
  assert.deepEqual(result.mediaResult, {
    storageUrl: "https://media.example.com/rtr-1.mp4",
    persistenceStatus: "persisted",
    mimeType: "video/mp4",
    widthPx: 720,
    heightPx: 1280,
    durationSeconds: 5,
  });
  // media_result 缺失 → null（不伪造媒体摘要）；「当前默认」判定可直接消费归一结果
  const noMedia = projectReferenceTestResultFromUnknown({ id: "rtr-2", media_result: null });
  assert.equal(noMedia.mediaResult, null);
  assert.equal(resultIsCurrentDefault(demoReferenceTestDefaults, { mediaKind: result.mediaKind, generationRequestId: result.generationRequestId }), false);
});

test("pageFromUnknown：分页信封 has_next/page_size → hasNext/pageSize，缺失不虚构更多页", () => {
  const page = pageFromUnknown(
    { items: [{ id: "rt-1", media_kind: "image" }], page: 2, page_size: 20, has_next: true },
    referenceTestFromUnknown,
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.mediaKind, "image");
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 20);
  assert.equal(page.hasNext, true);
  // has_next 缺失 → false（加载更多按钮不出现，不虚构分页）
  const tail = pageFromUnknown({ items: [], page: 1, page_size: 20 }, referenceTestFromUnknown);
  assert.equal(tail.hasNext, false);
  // 非对象响应防御：空页而非抛错
  const empty = pageFromUnknown(null, referenceTestFromUnknown);
  assert.deepEqual(empty, { items: [], page: 1, pageSize: 0, hasNext: false });
});
