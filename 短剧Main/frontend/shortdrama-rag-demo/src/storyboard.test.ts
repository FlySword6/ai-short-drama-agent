import assert from "node:assert/strict";
import test from "node:test";
import {
  canConfirmStoryboardImport,
  sceneBindingTrialKey,
  storyboardImportFromUnknown,
  storyboardIssues,
  trialSceneBindings,
} from "./storyboard";
import type { Episode, Scene, StoryboardPreviewRow } from "./types";

const backendRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  project_id: "22222222-2222-4222-8222-222222222222",
  uploaded_by: "33333333-3333-4333-8333-333333333333",
  file_name: "分镜表.xlsx",
  status: "previewed",
  preview: {
    rows: [
      {
        source_sheet: "第一集",
        source_row: 2,
        episode_no: 1,
        scene_name: "夜雨巷口",
        shot_no: "1",
        sort_order: 1,
        screen_description: "任天野骑马入巷",
        camera_movement: "推镜",
        shot_size_angle: "中景平视",
        dialogue: "他来了。",
        sound_effect: "雨声",
        raw_fields: { 集: "1" },
      },
    ],
    issues: [
      { level: "warning", code: "missing_dialogue", message: "第 3 行缺少台词", source_row: 3 },
      { level: "error", code: "missing_shot_no", message: "第 4 行缺少镜号", source_row: 4 },
    ],
    episode_count: 1,
    scene_count: 1,
    shot_count: 1,
    can_confirm: false,
  },
  confirmation_result: null,
  confirmed_at: null,
  created_at: "2026-07-15T08:00:00.000Z",
};

test("后端嵌套形状可以完整映射为导入记录", () => {
  const record = storyboardImportFromUnknown(backendRecord);
  assert.ok(record);
  assert.equal(record.id, backendRecord.id);
  assert.equal(record.preview.rows.length, 1);
  assert.equal(record.preview.rows[0]?.source_row, 2);
  assert.equal(record.preview.rows[0]?.screen_description, "任天野骑马入巷");
  assert.equal(record.preview.rows[0]?.dialogue, "他来了。");
  assert.deepEqual(record.preview.rows[0]?.raw_fields, { 集: "1" });
  assert.equal(record.preview.issues.length, 2);
  assert.equal(storyboardIssues(record, "warning").length, 1);
  assert.equal(storyboardIssues(record, "error")[0]?.message, "第 4 行缺少镜号");
  assert.equal(record.preview.can_confirm, false);
});

test("确认门槛同时看 can_confirm 和 error 级 issue", () => {
  const blocked = storyboardImportFromUnknown(backendRecord)!;
  assert.equal(canConfirmStoryboardImport(blocked), false);

  const confirmable = storyboardImportFromUnknown({
    ...backendRecord,
    preview: { ...backendRecord.preview, issues: [], can_confirm: true },
  })!;
  assert.equal(canConfirmStoryboardImport(confirmable), true);

  const contradictory = storyboardImportFromUnknown({
    ...backendRecord,
    preview: {
      ...backendRecord.preview,
      can_confirm: true,
      issues: [{ level: "error", message: "仍有错误" }],
    },
  })!;
  assert.equal(canConfirmStoryboardImport(contradictory), false);
});

test("确认后的记录带回导入统计", () => {
  const confirmed = storyboardImportFromUnknown({
    ...backendRecord,
    status: "confirmed",
    confirmation_result: {
      created_episode_ids: ["e1"],
      created_scene_ids: ["s1"],
      created_shot_ids: ["shot1", "shot2"],
      imported_shot_count: 2,
    },
  });
  assert.ok(confirmed);
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.confirmation_result?.imported_shot_count, 2);
  assert.deepEqual(confirmed.confirmation_result?.created_shot_ids, ["shot1", "shot2"]);
});

test("缺 id 或 preview 异常时不会让页面崩溃", () => {
  assert.equal(storyboardImportFromUnknown({ preview: { rows: [] } }), null);
  assert.equal(storyboardImportFromUnknown(null), null);
  const noPreview = storyboardImportFromUnknown({ id: "x" });
  assert.ok(noPreview);
  assert.deepEqual(noPreview.preview.rows, []);
  assert.deepEqual(noPreview.preview.issues, []);
  assert.equal(noPreview.preview.can_confirm, false);
});

/* K2N(GP-07):场景绑定试算——按名命中/候选/未命中/新集四种状态与合并行数。 */
const trialEpisodes: Pick<Episode, "id" | "episode_no">[] = [
  { id: "ep-1", episode_no: 1 },
  { id: "ep-2", episode_no: 2 },
];
const trialScenes: ReadonlyMap<string, Pick<Scene, "id" | "name">[]> = new Map([
  ["ep-1", [
    { id: "scene-1", name: "客厅" },
    { id: "scene-2", name: "北疆战场" },
    { id: "scene-3", name: "军营" },
  ]],
  ["ep-2", [{ id: "scene-9", name: "军营" }]],
]);

function trialRow(episodeNo: number | null, sceneName: string | null): StoryboardPreviewRow {
  return {
    ...(episodeNo === null ? {} : { episode_no: episodeNo }),
    ...(sceneName === null ? {} : { scene_name: sceneName }),
  };
}

test("按名精确命中=将绑定到已有场景(空白差异不造成假未命中)", () => {
  const trials = trialSceneBindings([trialRow(1, " 客厅 ")], trialEpisodes, trialScenes);
  assert.equal(trials.length, 1);
  assert.equal(trials[0]?.status, "matched");
  assert.deepEqual(trials[0]?.matched, { id: "scene-1", name: "客厅" });
});

test("相近名只进候选,绝不判为命中;候选按集隔离", () => {
  const trials = trialSceneBindings([trialRow(1, "军营外")], trialEpisodes, trialScenes);
  assert.equal(trials[0]?.status, "candidates");
  assert.deepEqual(trials[0]?.candidates, [{ id: "scene-3", name: "军营" }]);

  // 第 1 集的「夜雨巷口」不能因为第 2 集有相近名而出候选——候选只来自同集场景。
  const crossEpisode = trialSceneBindings([trialRow(1, "军营外"), trialRow(2, "校场")], trialEpisodes, trialScenes);
  assert.equal(crossEpisode[0]?.status, "candidates");
  assert.equal(crossEpisode[1]?.status, "unmatched");
  assert.deepEqual(crossEpisode[1]?.candidates, []);
});

test("无同名也无相近名=未命中;集不存在=新集", () => {
  const trials = trialSceneBindings([trialRow(1, "夜雨巷口"), trialRow(5, "客厅")], trialEpisodes, trialScenes);
  assert.equal(trials[0]?.status, "unmatched");
  assert.equal(trials[1]?.status, "new_episode");
});

test("同集同场景名的多行合并为一个核对项并累计镜数", () => {
  const trials = trialSceneBindings(
    [trialRow(1, "客厅"), trialRow(1, "客厅"), trialRow(1, " 客厅\n")],
    trialEpisodes,
    trialScenes,
  );
  assert.equal(trials.length, 1);
  assert.equal(trials[0]?.row_count, 3);
  assert.equal(trials[0]?.key, sceneBindingTrialKey(1, "客厅"));
});

test("缺集号或缺场景名的行不进核对清单", () => {
  const trials = trialSceneBindings([trialRow(null, "客厅"), trialRow(1, null), trialRow(1, "  ")], trialEpisodes, trialScenes);
  assert.equal(trials.length, 0);
});

test("候选最多列 5 个,超出截断", () => {
  const manyScenes: ReadonlyMap<string, Pick<Scene, "id" | "name">[]> = new Map([
    ["ep-1", Array.from({ length: 8 }, (_, index) => ({ id: `s-${index}`, name: `军营${index}区` }))],
  ]);
  const trials = trialSceneBindings([trialRow(1, "军营")], trialEpisodes, manyScenes);
  // 「军营」精确命中「军营x区」?不命中(名不同)——8 个相近名截到 5 个。
  assert.equal(trials[0]?.status, "candidates");
  assert.equal(trials[0]?.candidates.length, 5);
});
