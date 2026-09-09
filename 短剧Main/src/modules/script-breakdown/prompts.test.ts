import assert from "node:assert/strict";
import test from "node:test";
import { buildAssetsPrompt, buildShotsPrompt, PROMPT_VERSION } from "./prompts.js";

test("v2 角色候选提示词锁定补全字段与不猜测规则", () => {
  assert.equal(PROMPT_VERSION, "script-breakdown.v4");
  const { prompt } = buildAssetsPrompt({
    scriptLines: [{ lineIndex: 0, text: "林雪走进旧仓库。" }],
    sceneDivisions: [{
      sceneIndex: 0,
      name: "旧仓库",
      summary: "林雪进入仓库",
      startLineIndex: 0,
      endLineIndex: 0,
    }],
  });
  for (const field of ["gender", "age_value", "age_stage", "appearance", "personality_tags"]) {
    assert.match(prompt, new RegExp(field));
  }
  assert.match(prompt, /不得从姓名、职业或称谓猜测/);
});

test("v2 分镜提示词只要求四栏要素,不再要求三段成文提示词", () => {
  const { prompt } = buildShotsPrompt({
    scene: {
      sceneIndex: 0,
      name: "旧仓库",
      summary: "林雪独白",
      startLineIndex: 0,
      endLineIndex: 0,
    },
    sceneLines: [{ lineIndex: 0, text: "林雪独白。" }],
    storySummary: "林雪独白",
    approvedAssets: [],
    candidateNames: { characters: ["林雪"], scenes: ["旧仓库"], props: [], costumes: [] },
    nextShotNo: 1,
    targetDurationSec: null,
  });
  for (const field of ["subject", "action", "visual", "camera_language"]) {
    assert.match(prompt, new RegExp(field));
  }
  assert.doesNotMatch(prompt, /director_prompt|image_prompt|video_prompt/);
  assert.match(prompt, /不写成文提示词/);
});
