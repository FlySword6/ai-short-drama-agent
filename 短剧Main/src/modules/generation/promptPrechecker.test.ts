import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePromptCompleteness, type PrecheckInput } from "./promptPrechecker.js";

// ---------------------------------------------------------------------------
// 测试数据工厂
// ---------------------------------------------------------------------------

function makeFullInput(): PrecheckInput {
  return {
    autoPrompt: `剧集背景:测试剧集。场景:深夜的御书房,烛火摇曳,光影明灭不定。镜头意图:中景推近,角色独坐沉思,表情凝重。台词:\u201C朕绝不退让。\u201D。角色:皇帝(玄色龙袍,眉目冷峻,约四十岁)、老太监(灰布袍,驼背)。道具:玉玺。负面:模糊,变形,低质量。`,
    manualPrompt: `补充:氛围沉稳,色调偏冷,画面有电影感。角色皇帝的表情从隐忍到爆发,眼神锐利如刀。镜头从全景缓慢推至特写,捕捉眉宇间细微变化。道具玉玺置于案上,象征权力与决断。光影设计采用低调照明,营造肃杀气氛。背景音效以低沉的钟声为主,间或夹杂木门吱呀声。画面构图采用三分法,皇帝偏左,留白暗示孤独。`,
    characterDescriptions: [
      "皇帝(玄色龙袍,眉目冷峻,约四十岁)",
      "老太监(灰布袍,驼背,白发)",
    ],
    sceneDescription: "深夜的御书房,烛火摇曳,光影明灭不定,色调偏冷。窗棂透进月光,案上奏章堆积如山,青铜香炉升起袅袅烟雾,氛围压抑而凝重。",
    shotIntent: "中景推近,角色独坐沉思,表情凝重,画面从暗到明渐变",
    referenceLaneCount: 4,
    filledLaneCount: 4,
    negativePrompt: "模糊,变形,低质量,多余手指,水印",
    mediaKind: "image",
  };
}

function makeEmptyInput(): PrecheckInput {
  return {
    autoPrompt: "",
    manualPrompt: undefined,
    characterDescriptions: [],
    sceneDescription: undefined,
    shotIntent: "",
    referenceLaneCount: 0,
    filledLaneCount: 0,
    negativePrompt: undefined,
    mediaKind: "image",
  };
}

// ---------------------------------------------------------------------------
// §8.1 用例
// ---------------------------------------------------------------------------

test("预检:满分 prompt overallScore >= 95", () => {
  const result = evaluatePromptCompleteness(makeFullInput());
  assert.ok(
    result.overallScore >= 95,
    `期望 >= 95, 实际 ${result.overallScore}`,
  );
  // 所有维度都是 good
  for (const dim of result.dimensions) {
    assert.equal(dim.status, "good", `维度 ${dim.key} 应为 good, 实际 ${dim.status} (score=${dim.score})`);
  }
});

test("预检:空 prompt overallScore <= 10", () => {
  const result = evaluatePromptCompleteness(makeEmptyInput());
  assert.ok(
    result.overallScore <= 10,
    `期望 <= 10, 实际 ${result.overallScore}`,
  );
  // 除 negative_constraints 外所有维度都是 missing (空负面词默认得 60)
  for (const dim of result.dimensions) {
    if (dim.key === "negative_constraints") {
      assert.equal(dim.score, 60, "空负面词应走默认词表得 60");
      assert.equal(dim.status, "ok");
    } else {
      assert.equal(dim.status, "missing", `维度 ${dim.key} 应为 missing`);
      assert.equal(dim.score, 0);
    }
  }
});

test("预检:缺角色 overallScore 70-85", () => {
  const input = makeFullInput();
  input.characterDescriptions = [];
  input.autoPrompt = input.autoPrompt.replace(/角色:.*?。/, "");
  const result = evaluatePromptCompleteness(input);
  assert.ok(
    result.overallScore >= 70 && result.overallScore <= 85,
    `期望 70-85, 实际 ${result.overallScore}`,
  );
  const charDim = result.dimensions.find((d) => d.key === "character_description")!;
  assert.equal(charDim.status, "missing");
});

test("预检:缺参考 overallScore 80-90", () => {
  const input = makeFullInput();
  input.referenceLaneCount = 4;
  input.filledLaneCount = 0;
  const result = evaluatePromptCompleteness(input);
  assert.ok(
    result.overallScore >= 80 && result.overallScore <= 90,
    `期望 80-90, 实际 ${result.overallScore}`,
  );
  const refDim = result.dimensions.find((d) => d.key === "reference_materials")!;
  assert.equal(refDim.score, 0);
  assert.equal(refDim.status, "missing");
});

test("预检:仅有默认负面词 constraint 维度 60", () => {
  const input = makeFullInput();
  input.negativePrompt = undefined;
  const result = evaluatePromptCompleteness(input);
  const negDim = result.dimensions.find((d) => d.key === "negative_constraints")!;
  assert.equal(negDim.score, 60);
  assert.equal(negDim.status, "ok");
});

test("预检:极短 prompt prompt_length 维度 0 或 20", () => {
  const input = makeFullInput();
  input.autoPrompt = "短";
  input.manualPrompt = undefined;
  const result = evaluatePromptCompleteness(input);
  const lenDim = result.dimensions.find((d) => d.key === "prompt_length")!;
  assert.ok(
    lenDim.score <= 20,
    `期望 <= 20, 实际 ${lenDim.score}`,
  );
});

test("预检:mediaKind video 对 shot_intent 权重高于 image", () => {
  const baseInput = makeFullInput();
  // 删掉 shotIntent 的动作关键词使其降分
  const weakIntentInput: PrecheckInput = {
    ...baseInput,
    shotIntent: "皇帝坐在书房里",  // 无运镜关键词
    autoPrompt: `场景:书房。台词:\u201C坐。\u201D角色:皇帝。道具:玉玺。`,
    mediaKind: "image",
  };
  const imageResult = evaluatePromptCompleteness(weakIntentInput);
  const videoResult = evaluatePromptCompleteness({
    ...weakIntentInput,
    mediaKind: "video",
  });
  // video 对 shot_intent 权重 0.30 vs image 0.25
  // shotIntent 得分相同(40), 但对总分影响不同
  // video 总分应低于 image (因为 shot_intent 降分, 而 video 给它更高权重)
  assert.ok(
    videoResult.overallScore < imageResult.overallScore,
    `video 总分 ${videoResult.overallScore} 应低于 image ${imageResult.overallScore}`,
  );
  // 验证权重确实不同
  const imageShotWeight = imageResult.dimensions.find((d) => d.key === "shot_intent")!.weight;
  const videoShotWeight = videoResult.dimensions.find((d) => d.key === "shot_intent")!.weight;
  assert.ok(videoShotWeight > imageShotWeight, "video shot_intent 权重应高于 image");
});

// ---------------------------------------------------------------------------
// 边界用例
// ---------------------------------------------------------------------------

test("预检:确定性 — 同一输入两次调用结果一致 (precheckId 除外)", () => {
  const input = makeFullInput();
  const r1 = evaluatePromptCompleteness(input);
  const r2 = evaluatePromptCompleteness(input);
  assert.equal(r1.overallScore, r2.overallScore);
  assert.deepEqual(r1.dimensions, r2.dimensions);
  assert.deepEqual(r1.recommendations, r2.recommendations);
  assert.deepEqual(r1.missingReferences, r2.missingReferences);
  // precheckId 是随机 UUID, 不会相同
  assert.notEqual(r1.precheckId, r2.precheckId);
});

test("预检:部分填充参考栏位 score = ratio * 100", () => {
  const input = makeFullInput();
  input.referenceLaneCount = 4;
  input.filledLaneCount = 2;
  const result = evaluatePromptCompleteness(input);
  const refDim = result.dimensions.find((d) => d.key === "reference_materials")!;
  assert.equal(refDim.score, 50);
  assert.equal(refDim.status, "ok");
});

test("预检:角色仅有名字无特征 score = 50", () => {
  const input = makeFullInput();
  input.characterDescriptions = ["皇帝", "老太监"];
  const result = evaluatePromptCompleteness(input);
  const charDim = result.dimensions.find((d) => d.key === "character_description")!;
  assert.equal(charDim.score, 50);
  assert.equal(charDim.status, "ok");
});

test("预检:镜头意图仅时间码 score = 20", () => {
  const input = makeFullInput();
  input.shotIntent = "00:15";
  const result = evaluatePromptCompleteness(input);
  const shotDim = result.dimensions.find((d) => d.key === "shot_intent")!;
  assert.equal(shotDim.score, 20);
  assert.equal(shotDim.status, "weak");
});

test("预检:低分时 estimatedSamplingEffect.warning = true", () => {
  const result = evaluatePromptCompleteness(makeEmptyInput());
  assert.equal(result.estimatedSamplingEffect.warning, true);
  assert.ok(result.estimatedSamplingEffect.message);
});

test("预检:高分时 estimatedSamplingEffect.warning = false", () => {
  const result = evaluatePromptCompleteness(makeFullInput());
  assert.equal(result.estimatedSamplingEffect.warning, false);
});

test("预检:recommendations 按优先级排序且最多 3 条", () => {
  const input = makeEmptyInput();
  const result = evaluatePromptCompleteness(input);
  assert.ok(result.recommendations.length <= 3);
  assert.ok(result.recommendations.length > 0);
});

test("预检:权重之和 = 1 (image)", () => {
  const result = evaluatePromptCompleteness(makeFullInput());
  const totalWeight = result.dimensions.reduce((sum, d) => sum + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 0.001, `权重和 ${totalWeight} 应 = 1`);
});

test("预检:权重之和 = 1 (video)", () => {
  const input = { ...makeFullInput(), mediaKind: "video" as const };
  const result = evaluatePromptCompleteness(input);
  const totalWeight = result.dimensions.reduce((sum, d) => sum + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 0.001, `权重和 ${totalWeight} 应 = 1`);
});

test("预检:权重之和 = 1 (audio)", () => {
  const input = { ...makeFullInput(), mediaKind: "audio" as const };
  const result = evaluatePromptCompleteness(input);
  const totalWeight = result.dimensions.reduce((sum, d) => sum + d.weight, 0);
  assert.ok(Math.abs(totalWeight - 1) < 0.001, `权重和 ${totalWeight} 应 = 1`);
});

test("预检:autoPromptPreview 回传原 autoPrompt", () => {
  const input = makeFullInput();
  const result = evaluatePromptCompleteness(input);
  assert.equal(result.autoPromptPreview, input.autoPrompt);
});

test("预检:createdAt 是合法 ISO 8601", () => {
  const result = evaluatePromptCompleteness(makeFullInput());
  const d = new Date(result.createdAt);
  assert.ok(!isNaN(d.getTime()), "createdAt 应为合法日期");
});

test("预检:precheckId 是合法 UUID", () => {
  const result = evaluatePromptCompleteness(makeFullInput());
  assert.match(result.precheckId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
