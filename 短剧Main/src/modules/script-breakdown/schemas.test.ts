import assert from "node:assert/strict";
import test from "node:test";
import { draftFromUnknown } from "./schemas.js";

/**
 * 模型不再自由吐 JSON,阶段输出合同随之退场。这里只剩草稿回读——
 * 它是数据库里那份 draft_json 的形状闸,lite 模块也在读同一个函数。
 */

test("草稿回读:合法草稿往返,垃圾输入直接拒绝", () => {
  const draft = {
    storySummary: "s",
    sceneDivisions: [{ sceneIndex: 0, name: null, summary: "s", startLineIndex: 0, endLineIndex: 1 }],
    shotCandidates: [{
      candidateId: "shot_001",
      shotNo: 1,
      sceneIndex: 0,
      lineIndices: [0, 1],
      elements: null,
      storyboardDetail: null,
      directorPrompt: "d",
      imagePrompt: "i",
      videoPrompt: "v",
      durationSec: 5,
      characterNames: [],
      sceneNames: [],
      propNames: [],
      costumeNames: [],
      audioNames: [],
    }],
  };
  assert.deepEqual(draftFromUnknown(draft), draft);
  assert.deepEqual(draftFromUnknown({}), {});
  assert.deepEqual(draftFromUnknown(null), {});
  assert.throws(() => draftFromUnknown({ sceneDivisions: "not-an-array" }), /draft_json 形状非法/);
});
