import assert from "node:assert/strict";
import test from "node:test";
import {
  assetMatchesPick,
  pickRefAsset,
  refAssetKey,
} from "./components/asset-pick-drawer";
import {
  generationModeLabel,
  normalizeShotTitle,
  timelineCardTitle,
  partitionModelCards,
  prefillFromStrategy,
  putInputFromPrefill,
  shotTitleCommit,
  taskStateForShot,
  unconfiguredModelsLabel,
  workbenchFixedParameters,
  type ShotTaskState,
} from "./components/version-modal";
import type { Asset, GenerationDefaultStrategy, GenerationTask, ProjectAssetRef } from "./types";

/* ============================================================
   W5.5 任务5：模型卡收敛（可用平铺，待配置默认折叠成一行小字）
   ============================================================ */

const IMAGE_MODEL_CARDS = [
  { key: "configured", name: "当前配置模型", available: true },
  { key: "gpt-image-2", name: "GPT Image 2", available: false },
  { key: "gemini-image", name: "Gemini 图像模型", available: false },
  { key: "seedream-5-pro", name: "Seedream 5 Pro", available: false },
] as const;

const VIDEO_MODEL_CARDS = [
  { key: "configured", name: "当前配置模型", available: true },
  { key: "seedance-2-0", name: "Seedance 2.0", available: false },
  { key: "happyhorse-1-1", name: "HappyHorse 1.1", available: false },
] as const;

test("模型卡收敛：可用卡平铺，待配置卡折叠且保持原顺序", () => {
  const image = partitionModelCards(IMAGE_MODEL_CARDS);
  assert.deepEqual(image.configured.map((card) => card.key), ["configured"]);
  assert.deepEqual(image.pending.map((card) => card.key), ["gpt-image-2", "gemini-image", "seedream-5-pro"]);
  const video = partitionModelCards(VIDEO_MODEL_CARDS);
  assert.equal(video.configured.length, 1);
  assert.equal(video.pending.length, 2);
  // 全部可用时没有折叠行
  assert.equal(partitionModelCards([{ key: "a", available: true }]).pending.length, 0);
  // 无可用卡时 configured 为空（折叠行显示全部待配置）
  assert.equal(partitionModelCards([{ key: "a", available: false }]).configured.length, 0);
});

test("折叠行小字：「其余 N 个模型待配置」", () => {
  assert.equal(unconfiguredModelsLabel(3), "其余 3 个模型待配置");
  assert.equal(unconfiguredModelsLabel(1), "其余 1 个模型待配置");
});

/* ============================================================
   W5.5 任务5：generation-defaults 预填映射与「固定为默认」PUT 输入
   ============================================================ */

const strategyFixture: GenerationDefaultStrategy = {
  id: "default-9",
  project_id: "project-1",
  media_kind: "image",
  mode: "direct_reference",
  model_key: "configured",
  parameters: { ratio: "16:9", size: "2K" },
  version: 5,
};

test("默认策略预填：无策略 → 兜底 mode/configured/expected_version=0", () => {
  assert.deepEqual(prefillFromStrategy(null), {
    mode: "material_to_prompt",
    modelKey: "configured",
    expectedVersion: 0,
    persisted: false,
  });
});

test("默认策略预填：已持久化策略带出 mode/model_key/version", () => {
  assert.deepEqual(prefillFromStrategy(strategyFixture), {
    mode: "direct_reference",
    modelKey: "configured",
    expectedVersion: 5,
    persisted: true,
  });
  // model_key 空白 / version 缺失时安全回落
  assert.deepEqual(prefillFromStrategy({ ...strategyFixture, model_key: "  ", version: 0 }), {
    mode: "direct_reference",
    modelKey: "configured",
    expectedVersion: 0,
    persisted: true,
  });
});

test("「固定为默认」PUT 输入：mode/model_key/固定参数/expected_version 齐全", () => {
  const prefill = prefillFromStrategy(strategyFixture);
  assert.deepEqual(putInputFromPrefill("image", prefill, "configured"), {
    mode: "direct_reference",
    model_key: "configured",
    parameters: { ratio: "16:9", size: "2K", watermark: false, sequential_image_generation: "disabled" },
    expected_version: 5,
  });
  // 视频固定参数与参数卡/生成链一致；model_key 空白回落 configured
  assert.deepEqual(putInputFromPrefill("video", prefillFromStrategy(null), "  "), {
    mode: "material_to_prompt",
    model_key: "configured",
    parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 4 },
    expected_version: 0,
  });
  assert.deepEqual(workbenchFixedParameters("video"), { ratio: "9:16", resolution: "720p", duration_seconds: 4 });
});

test("默认策略 mode 展示文案", () => {
  assert.equal(generationModeLabel("direct_reference"), "直接引用");
  assert.equal(generationModeLabel("material_to_prompt"), "素材转提示词参考");
});

/* ============================================================
   W5.5 任务5：生成中状态按分镜隔离（切分镜不残留旧任务）
   ============================================================ */

function makeTask(id: string, status = "running"): GenerationTask {
  return { generation_request_id: id, status };
}

test("切分镜：旧分镜的 imageTask/videoTask 全部清空", () => {
  const prev: ShotTaskState = { shotId: "shot-a", imageTask: makeTask("req-a1"), videoTask: makeTask("req-a2") };
  const next = taskStateForShot(prev, "shot-b");
  assert.deepEqual(next, { shotId: "shot-b", imageTask: null, videoTask: null });
});

test("切分镜后恢复：只带当前分镜恢复出的任务", () => {
  const prev: ShotTaskState = { shotId: "shot-a", imageTask: makeTask("req-a1"), videoTask: makeTask("req-a2") };
  const restored = makeTask("req-b1");
  const next = taskStateForShot(prev, "shot-b", { imageTask: restored });
  assert.deepEqual(next, { shotId: "shot-b", imageTask: restored, videoTask: null });
});

test("同一分镜：无恢复结果时原样保留（不误清进行中任务）", () => {
  const prev: ShotTaskState = { shotId: "shot-a", imageTask: makeTask("req-a1"), videoTask: null };
  assert.equal(taskStateForShot(prev, "shot-a"), prev);
});

test("同一分镜：恢复结果只覆盖对应槽位，另一槽位保留", () => {
  const imageTask = makeTask("req-a1");
  const prev: ShotTaskState = { shotId: "shot-a", imageTask, videoTask: null };
  const videoTask = makeTask("req-a2");
  const next = taskStateForShot(prev, "shot-a", { videoTask });
  assert.equal(next.imageTask, imageTask);
  assert.equal(next.videoTask, videoTask);
  // 显式传 null 可以清掉对应槽位（如恢复发现任务已消失）
  assert.equal(taskStateForShot(prev, "shot-a", { imageTask: null }).imageTask, null);
});

/* ============================================================
   W5.5 任务6：分镜改名提交判定
   ============================================================ */

test("改名判定：归一化后为空或与现名相同 → 不提交", () => {
  assert.deepEqual(shotTitleCommit("北疆战场", "   "), { commit: false, title: "北疆战场" });
  assert.deepEqual(shotTitleCommit("北疆战场", "北疆战场"), { commit: false, title: "北疆战场" });
  assert.deepEqual(shotTitleCommit("北疆战场", " 北疆战场 "), { commit: false, title: "北疆战场" });
  assert.deepEqual(shotTitleCommit("", "  "), { commit: false, title: "" });
});

test("改名判定：新名字归一化后提交", () => {
  assert.deepEqual(shotTitleCommit("北疆战场", " 营帐   夜谈 "), { commit: true, title: "营帐 夜谈" });
  assert.equal(normalizeShotTitle("  分镜\n二　特写 "), "分镜 二 特写");
});

/* ============================================================
   W5.5 任务6：台内资产抽屉（类型筛选 / 搜索 / 去重键）
   ============================================================ */

const characterAsset: Asset = { id: "asset-ren", asset_kind: "character", name: "任天野", intro: "钦差官服" };
const sceneAsset: Asset = { id: "asset-harbor", asset_kind: "scene", name: "巷口雨夜", intro: "夜戏外景" };

test("抽屉筛选：类型 + 名称/简介大小写不敏感子串", () => {
  assert.equal(assetMatchesPick(characterAsset, "", ""), true);
  assert.equal(assetMatchesPick(characterAsset, "character", ""), true);
  assert.equal(assetMatchesPick(characterAsset, "scene", ""), false);
  assert.equal(assetMatchesPick(characterAsset, "", "任天"), true);
  assert.equal(assetMatchesPick(characterAsset, "", "官服"), true);
  assert.equal(assetMatchesPick(sceneAsset, "", "官服"), false);
  assert.equal(assetMatchesPick(characterAsset, "scene", "任天"), false);
  assert.equal(assetMatchesPick(sceneAsset, "", "  "), true);
});

test("抽屉去重键：asset_entity_id 优先，其次 asset_id，最后引用 id", () => {
  const ref: ProjectAssetRef = { id: "ref-1", asset_id: "asset-1", asset_entity_id: "entity-1" };
  assert.equal(refAssetKey(ref), "entity-1");
  assert.equal(refAssetKey({ id: "ref-2", asset_id: "asset-2" }), "asset-2");
  assert.equal(refAssetKey({ id: "ref-3" }), "ref-3");
});

test("抽屉引用解析：缺快照时回落到占位资产实体", () => {
  assert.equal(pickRefAsset({ id: "ref-1", asset: characterAsset }).name, "任天野");
  const fallback = pickRefAsset({ id: "ref-9", asset_id: "asset-9" });
  assert.equal(fallback.id, "asset-9");
  assert.equal(fallback.name, "未命名项目资产");
});

test("timelineCardTitle：title 已带编号前缀不重复，缺前缀补「#N」，空标题回退编号", () => {
  assert.equal(timelineCardTitle({ shot_no: "1", title: "#1 · 中景 · 平视" }), "#1 · 中景 · 平视");
  // 旧数据里的「分镜N」前缀原样保留（用户数据不改写）
  assert.equal(timelineCardTitle({ shot_no: "1", title: "分镜1 · 中景 · 平视" }), "分镜1 · 中景 · 平视");
  assert.equal(timelineCardTitle({ shot_no: "3", title: "雨夜追杀" }), "#3 · 雨夜追杀");
  assert.equal(timelineCardTitle({ shot_no: "2", title: "" }), "#2");
  assert.equal(timelineCardTitle({ shot_no: "2", title: null }), "#2");
  assert.equal(timelineCardTitle({ title: "空镜" }), "空镜");
  assert.equal(timelineCardTitle({}), "#—");
});
