import assert from "node:assert/strict";
import test from "node:test";
import type { StoryboardExcelRow } from "../../services/storyboard/types.js";
import { buildStoryboardPreview } from "./preview.js";

function row(input: Partial<StoryboardExcelRow> = {}): StoryboardExcelRow {
  return {
    sheetName: "第1集分镜",
    rowNumber: 2,
    episode: "第1集",
    shotNo: "TJ1-2",
    screenDescription: "角色走进夜色中的街道",
    cameraMotion: "缓慢推进",
    shotSizeAngle: "中景",
    dialogue: null,
    scene: "旧城街道",
    soundEffect: "风声",
    referenceImageNote: null,
    storyboardImageNote: null,
    rawFields: {},
    ...input,
  };
}

test("保留字符串镜号并生成可确认预览", () => {
  const preview = buildStoryboardPreview([row()]);
  assert.equal(preview.canConfirm, true);
  assert.equal(preview.rows[0]?.shotCode, "TJ1-2");
  assert.equal(preview.episodeCount, 1);
  assert.equal(preview.sceneCount, 1);
});

test("重复镜号阻止确认", () => {
  const preview = buildStoryboardPreview([row(), row({ rowNumber: 3 })]);
  assert.equal(preview.canConfirm, false);
  assert.equal(preview.rows.length, 1);
  assert.equal(preview.issues[0]?.code, "duplicate_shot_code");
});

test("缺少画面描述只警告，不阻止确认", () => {
  const preview = buildStoryboardPreview([row({ screenDescription: null })]);
  assert.equal(preview.canConfirm, true);
  assert.equal(preview.issues[0]?.level, "warning");
});

test("空表阻止确认", () => {
  const preview = buildStoryboardPreview([]);
  assert.equal(preview.canConfirm, false);
  assert.equal(preview.issues[0]?.code, "empty_storyboard");
});
