import assert from "node:assert/strict";
import test from "node:test";
import { validateRunDraft } from "./validators.js";

/**
 * 阶段级的三个 validate*Output 随阶段机一起退场:模型现在只能按工具入参
 * schema 调用,那些形状不再可能出现。运行级校验留下来,而且更要紧了——
 * 续跑接进来的草稿不会再过一遍工作台,这里是最后一道闸。
 */
import type { SceneDivision, ShotCandidate } from "./types.js";

const scene = (overrides: Partial<SceneDivision> = {}): SceneDivision => ({
  sceneIndex: 0,
  name: null,
  summary: "s",
  startLineIndex: 0,
  endLineIndex: 3,
  ...overrides,
});

test("运行级校验:全局镜号、重复覆盖、未匹配资产、时长偏离", () => {
  const shot = (overrides: Partial<ShotCandidate>): ShotCandidate => ({
    candidateId: "shot_001",
    shotNo: 1,
    sceneIndex: 0,
    lineIndices: [0],
    elements: { subject: "甲", action: null, visual: "室内", cameraLanguage: "中景" },
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt: null,
    durationSec: 5,
    characterNames: [],
    sceneNames: [],
    propNames: [],
    costumeNames: [],
    ...overrides,
  });
  const draft = {
    sceneDivisions: [scene()],
    assetCandidates: {
      characters: [{
        candidateId: "c1",
        name: "林雪",
        description: null,
        gender: null,
        ageValue: null,
        ageStage: null,
        appearance: null,
        personalityTags: [],
        prelinkedAsset: null,
      }],
      scenes: [],
      props: [],
      costumes: [],
      audios: [],
    },
    shotCandidates: [
      shot({}),
      shot({ candidateId: "shot_002", shotNo: 2, lineIndices: [0, 1], characterNames: ["林雪", "幽灵"] }),
      shot({ candidateId: "shot_003", shotNo: 3, lineIndices: [2, 3] }),
    ],
  };
  const result = validateRunDraft({
    draft,
    lineCount: 4,
    approvedAssets: [{ assetEntityId: "a1", name: "幽灵", assetKind: "prop" }],
    targetDurationSec: 100,
  });
  assert.deepEqual(result.hardIssues, []);
  assert.equal(result.validation.status, "pass_with_warnings");
  // 行 0 被 shot_001 与 shot_002 重复引用 → 标记重复覆盖,不静默吞掉
  assert.ok(result.validation.duplicateCoverage.some((item) => item.lineIndex === 0));
  // "幽灵" 是 prop 白名单但按 character 引用 → 仍是未匹配
  assert.deepEqual(result.validation.unmatchedAssets.map((item) => `${item.kind}:${item.name}`), ["character:幽灵"]);
  // 总时长 15 秒 vs 目标 100 秒 → 偏离警告
  assert.ok(result.validation.issues.some((issue) => issue.code === "duration_deviation"));
  assert.equal(result.validation.totalDurationSec, 15);

  const hardFailed = validateRunDraft({
    draft: { ...draft, shotCandidates: [shot({}), shot({ candidateId: "shot_002", shotNo: 7, lineIndices: [1] })] },
    lineCount: 4,
    approvedAssets: [],
    targetDurationSec: null,
  });
  assert.ok(hardFailed.hardIssues.some((issue) => issue.code === "shot_no_not_continuous"));
});

test("运行级校验:场没有分镜进警告;行未被任何分镜覆盖进警告", () => {
  const result = validateRunDraft({
    draft: {
      sceneDivisions: [scene(), scene({ sceneIndex: 1, startLineIndex: 4, endLineIndex: 5 })],
      assetCandidates: { characters: [], scenes: [], props: [], costumes: [], audios: [] },
      shotCandidates: [{
        candidateId: "shot_001",
        shotNo: 1,
        sceneIndex: 0,
        lineIndices: [0, 1],
        elements: { subject: "甲", action: null, visual: "室内", cameraLanguage: "中景" },
        directorPrompt: null,
        imagePrompt: null,
        videoPrompt: null,
        durationSec: 5,
        characterNames: [],
        sceneNames: [],
        propNames: [],
        costumeNames: [],
      }],
    },
    lineCount: 6,
    approvedAssets: [],
    targetDurationSec: null,
  });
  assert.deepEqual(result.hardIssues, []);
  assert.ok(result.validation.issues.some((issue) => issue.code === "scene_without_shots"));
  assert.ok(result.validation.issues.some((issue) => issue.code === "lines_without_shots"));
});
