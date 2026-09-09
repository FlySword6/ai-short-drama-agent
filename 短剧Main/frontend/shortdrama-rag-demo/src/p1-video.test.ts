import assert from "node:assert/strict";
import test from "node:test";
import { ApiClientError } from "./api";
import {
  FALLBACK_VIDEO_DEFAULT_DRAFT,
  applyPrimaryToList,
  buildVersionRows,
  comparePair,
  defaultSaveReducer,
  draftFromStrategy,
  formatPlaybackClock,
  isDefaultVersionConflict,
  latestCandidateId,
  playbackCursorAt,
  playbackSlices,
  putInputFromDraft,
  sortVideoVersions,
  timelineCardState,
  totalPlaybackSeconds,
  type DefaultSaveState,
} from "./components/version-modal";
import type { DeliverableItem, GenerationDefaultStrategy, MediaVersion } from "./types";

/* ============================================================
   板05 参数卡：生成默认策略读写（GET → 草稿；PUT 带 expected_version）
   ============================================================ */

const serverStrategy: GenerationDefaultStrategy = {
  id: "default-1",
  project_id: "project-1",
  media_kind: "video",
  mode: "material_to_prompt",
  model_key: "sd2",
  parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 6 },
  version: 7,
  created_at: "2026-07-18T09:00:00.000Z",
  updated_at: "2026-07-19T09:00:00.000Z",
};

test("默认策略读入参数卡草稿；缺省字段回落 v4 兜底", () => {
  assert.deepEqual(draftFromStrategy(serverStrategy), {
    mode: "material_to_prompt",
    modelKey: "sd2",
    ratio: "9:16",
    resolution: "720p",
    durationSeconds: 6,
  });
  assert.deepEqual(draftFromStrategy(null), FALLBACK_VIDEO_DEFAULT_DRAFT);
  // parameters 缺字段时按兜底值补齐
  assert.deepEqual(draftFromStrategy({ ...serverStrategy, parameters: {} }), {
    ...FALLBACK_VIDEO_DEFAULT_DRAFT,
    mode: "material_to_prompt",
    modelKey: "sd2",
  });
});

test("参数卡草稿写回 PUT 输入：mode/model_key/parameters/expected_version 齐全", () => {
  const draft = draftFromStrategy(serverStrategy);
  assert.deepEqual(putInputFromDraft(draft, 7), {
    mode: "material_to_prompt",
    model_key: "sd2",
    parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 6 },
    expected_version: 7,
  });
  // 首次保存（后端 404 后）：expected_version = 0
  assert.equal(putInputFromDraft(FALLBACK_VIDEO_DEFAULT_DRAFT, 0).expected_version, 0);
  // model_key 空白时回落兜底，避免提交空串
  assert.equal(putInputFromDraft({ ...draft, modelKey: "   " }, 7).model_key, "sd2");
});

test("保存状态机：编辑→保存→已保存（version 跟随服务端前进）", () => {
  let state: DefaultSaveState = { status: "clean", version: 7, message: "" };
  state = defaultSaveReducer(state, { type: "edit" });
  assert.equal(state.status, "dirty");
  state = defaultSaveReducer(state, { type: "save" });
  assert.equal(state.status, "saving");
  // saving 中重复保存/编辑不产生新状态
  assert.equal(defaultSaveReducer(state, { type: "save" }).status, "saving");
  state = defaultSaveReducer(state, { type: "saved", version: 8 });
  assert.deepEqual({ status: state.status, version: state.version }, { status: "saved", version: 8 });
});

test("409 分支：乐观锁冲突提示重新读取；普通错误走失败态", () => {
  const conflict = new ApiClientError("默认策略版本冲突", { status: 409, code: "generation_default_version_conflict" });
  assert.equal(isDefaultVersionConflict(conflict), true);
  assert.equal(isDefaultVersionConflict(new ApiClientError("服务端错误", { status: 500 })), false);
  assert.equal(isDefaultVersionConflict(new Error("network")), false);

  const saving: DefaultSaveState = { status: "saving", version: 7, message: "" };
  const conflicted = defaultSaveReducer(saving, { type: "save-error", error: conflict });
  assert.equal(conflicted.status, "conflict");
  assert.match(conflicted.message, /重新读取/);
  // 冲突后 version 不前移，用户重新读取后再保存
  assert.equal(conflicted.version, 7);

  const failed = defaultSaveReducer(saving, { type: "save-error", error: new ApiClientError("保存失败", { status: 500 }) });
  assert.equal(failed.status, "failed");
  assert.equal(failed.message, "保存失败");
});

/* ============================================================
   板06 版本弹窗状态机：版本号、pill、主版本迁移、候选对比
   ============================================================ */

const v1: MediaVersion = { id: "m-v1", media_kind: "video", is_primary: false, created_at: "2026-07-18T09:00:00.000Z" };
const v2: MediaVersion = { id: "m-v2", media_kind: "video", is_primary: false, created_at: "2026-07-18T10:00:00.000Z" };
const v3: MediaVersion = { id: "m-v3", media_kind: "video", is_primary: true, created_at: "2026-07-18T11:00:00.000Z" };
const v4: MediaVersion = { id: "m-v4", media_kind: "video", is_primary: false, created_at: "2026-07-19T08:30:00.000Z" };

test("版本号按创建时间升序分配，乱序输入也稳定", () => {
  const sorted = sortVideoVersions([v4, v2, v1, v3]);
  assert.deepEqual(sorted.map((item) => item.id), ["m-v1", "m-v2", "m-v3", "m-v4"]);
  const rows = buildVersionRows([v4, v2, v1, v3]);
  assert.deepEqual(rows.map((row) => row.versionNo), [1, 2, 3, 4]);
});

test("pill 优先级：主版本 > 已弃 > 拟设主版本 > 首版 > 历史版本", () => {
  const rows = buildVersionRows([v1, v2, v3, v4]);
  assert.deepEqual(rows.map((row) => row.pill), ["首版", "历史版本", "主版本", "拟设主版本"]);
  // 最新候选被本地标记已弃后，候选顺位回落到次新非主版本
  const discarded = new Set(["m-v4"]);
  const afterDiscard = buildVersionRows([v1, v2, v3, v4], discarded);
  assert.deepEqual(afterDiscard.map((row) => row.pill), ["首版", "拟设主版本", "主版本", "已弃"]);
  assert.equal(latestCandidateId([v1, v2, v3, v4], discarded), "m-v2");
});

test("候选对比区 = 当前主版本 vs 最新候选", () => {
  const pair = comparePair(buildVersionRows([v1, v2, v3, v4]));
  assert.equal(pair.primary?.media.id, "m-v3");
  assert.equal(pair.candidate?.media.id, "m-v4");
  // 没有主版本时 primary 为空，候选仍取最新
  const pairNoPrimary = comparePair(buildVersionRows([{ ...v3, is_primary: false }, v1]));
  assert.equal(pairNoPrimary.primary, null);
  assert.equal(pairNoPrimary.candidate?.media.id, "m-v3");
});

test("设为主版本：全表恰好一个主版本，可回切", () => {
  const migrated = applyPrimaryToList([v1, v2, v3, v4], "m-v4");
  assert.deepEqual(migrated.map((item) => item.is_primary), [false, false, false, true]);
  const rolledBack = applyPrimaryToList(migrated, "m-v3");
  assert.deepEqual(rolledBack.map((item) => item.is_primary), [false, false, true, false]);
});

/* ============================================================
   板05 中区：全集播放游标与时间线两态
   ============================================================ */

function playbackItem(shotId: string, shotCode: string, sortOrder: number, duration: number | null): DeliverableItem {
  return {
    project_id: "p1",
    project_name: "项目",
    episode_id: "e1",
    episode_no: 1,
    shot_id: shotId,
    shot_code: shotCode,
    shot_sort_order: sortOrder,
    media_id: `media-${shotId}`,
    media_kind: "video",
    storage_url: "",
    storage_path: "",
    mime_type: "video/mp4",
    duration_seconds: duration,
    generation_request_id: `req-${shotId}`,
    generation_attempt_id: `attempt-${shotId}`,
    provider: "ark",
    model: "sd2",
    parameters: {},
    estimated_cost_fen: 120,
  };
}

// 对齐 v4 文案：00:11 / 02:00 · 播放至分镜 #2（累计 8/4/6/12/30/60 = 120 秒）
const demoItems = [
  playbackItem("s1", "1", 1, 8),
  playbackItem("s2", "2", 2, 4),
  playbackItem("s3", "3", 3, 6),
  playbackItem("s4", "4", 4, 12),
  playbackItem("s5", "5", 5, 30),
  playbackItem("s6", "6", 6, 60),
];

test("播放切片按 sort_order 排序，缺时长按 4 秒占位", () => {
  const slices = playbackSlices([playbackItem("s2", "2", 2, 4), playbackItem("s1", "1", 1, null)]);
  assert.deepEqual(slices.map((slice) => slice.shotId), ["s1", "s2"]);
  assert.equal(slices[0]!.durationSeconds, 4);
  assert.equal(totalPlaybackSeconds(playbackSlices(demoItems)), 120);
});

test("播放游标：11 秒落在分镜 #2；边界收敛到首末段", () => {
  const slices = playbackSlices(demoItems);
  assert.deepEqual(playbackCursorAt(slices, 0), { index: 0, shotId: "s1" });
  assert.deepEqual(playbackCursorAt(slices, 11), { index: 1, shotId: "s2" });
  // 8 秒整 = 第一段刚播完，进入第二段
  assert.deepEqual(playbackCursorAt(slices, 8), { index: 1, shotId: "s2" });
  // 超出总时长收敛到最后一段
  assert.deepEqual(playbackCursorAt(slices, 999), { index: 5, shotId: "s6" });
  assert.equal(playbackCursorAt([], 11), null);
});

test("播放时钟：mm:ss 零填充", () => {
  assert.equal(formatPlaybackClock(11), "00:11");
  assert.equal(formatPlaybackClock(120), "02:00");
  assert.equal(formatPlaybackClock(75), "01:15");
  assert.equal(formatPlaybackClock(0), "00:00");
});

test("时间线两态：正在编辑 / 播放至 / 叠加 / 普通", () => {
  assert.equal(timelineCardState("s2", "s2", null), "editing");
  assert.equal(timelineCardState("s2", "s1", "s2"), "playing");
  assert.equal(timelineCardState("s2", "s2", "s2"), "both");
  assert.equal(timelineCardState("s3", "s2", "s2"), "idle");
});
