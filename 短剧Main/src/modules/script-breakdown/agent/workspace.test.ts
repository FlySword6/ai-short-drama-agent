import assert from "node:assert/strict";
import test from "node:test";
import { chunkScriptLines } from "../lines.js";
import { BreakdownWorkspace } from "./workspace.js";

/**
 * 填充工作台是「框架」那一半:agent 每调一次工具就往里填一格,工作台当场
 * 判这一格合不合法。合法就落进草稿,不合法就明确拒绝并说清该怎么改——
 * 拒绝只影响这一次调用,已经填好的不受影响。
 */

const SCRIPT = [
  "场景一 客栈门口",
  "林晚提着行李站在门口。",
  "掌柜迎上来:客官打尖还是住店?",
  "场景二 客房",
  "林晚推开窗,看见远处的山。",
].join("\n");

function workspace() {
  return new BreakdownWorkspace({
    scriptLines: chunkScriptLines(SCRIPT),
    approvedAssets: [],
    targetDurationSec: null,
  });
}

test("加一场:场号与覆盖行由工作台记账,描述是给人看的话", () => {
  const filler = workspace();

  const outcome = filler.addScene({
    name: "客栈门口",
    summary: "林晚抵达客栈",
    startLineIndex: 0,
    endLineIndex: 2,
  });

  assert.equal(outcome.status, "accepted");
  assert.match(outcome.description, /客栈门口/);
  assert.deepEqual(filler.draft.sceneDivisions, [{
    sceneIndex: 0,
    name: "客栈门口",
    summary: "林晚抵达客栈",
    startLineIndex: 0,
    endLineIndex: 2,
  }]);
  assert.equal(filler.progress.nextSceneStartLineIndex, 3);
});

test("场次接不上剧本时明确拒绝,并说清这一场该从哪行开始", () => {
  const filler = workspace();
  filler.addScene({ name: "客栈门口", summary: "林晚抵达客栈", startLineIndex: 0, endLineIndex: 2 });

  const outcome = filler.addScene({ name: "客房", summary: "林晚看山", startLineIndex: 4, endLineIndex: 4 });

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.status === "rejected" && /第 3 行/.test(outcome.reason), true, outcome.status === "rejected" ? outcome.reason : "");
  assert.equal(filler.draft.sceneDivisions?.length, 1, "被拒绝的这一次不该改动已经填好的内容");
});

test("阶段②落镜:applyStoryboardShots 整体替换草稿里的分镜,场次与资产不动", () => {
  const filler = workspace();
  filler.addScene({ name: "客栈门口", summary: "林晚抵达客栈", startLineIndex: 0, endLineIndex: 2 });
  filler.addCharacter({ name: "林晚", description: "女主角" });

  filler.applyStoryboardShots([{
    candidateId: "shot_001",
    shotNo: 1,
    sceneIndex: 0,
    lineIndices: [0, 1, 2],
    elements: { subject: "林晚", action: "提着行李走到客栈门口", visual: "黄昏,客栈灯笼亮起", cameraLanguage: "中景跟随" },
    storyboardDetail: null,
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt: "成文分镜提示词",
    durationSec: 4,
    characterNames: ["林晚"],
    sceneNames: ["客栈门口"],
    propNames: [],
    costumeNames: [],
  }]);

  const shots = filler.draft.shotCandidates ?? [];
  assert.equal(shots.length, 1);
  assert.equal(shots[0]?.candidateId, "shot_001");
  assert.equal(shots[0]?.videoPrompt, "成文分镜提示词");
  assert.equal(filler.draft.sceneDivisions?.length, 1, "场次不受落镜影响");
  assert.equal(filler.draft.assetCandidates?.characters.length, 1, "资产不受落镜影响");
});

test("同一个角色登记两次时拒绝", () => {
  const filler = workspace();
  filler.addCharacter({ name: "林晚", description: "女主角" });

  const outcome = filler.addCharacter({ name: "林晚", description: "重复登记" });

  assert.equal(outcome.status, "rejected");
  assert.equal(filler.draft.assetCandidates?.characters.length, 1);
});

test("被拒绝的一次不影响后面正确的一次", () => {
  const filler = workspace();
  filler.addScene({ name: "客栈门口", summary: "林晚抵达客栈", startLineIndex: 0, endLineIndex: 2 });
  filler.addScene({ name: "写错了", summary: "行号接不上", startLineIndex: 9, endLineIndex: 9 });

  const retry = filler.addScene({ name: "客房", summary: "林晚看山", startLineIndex: 3, endLineIndex: 4 });

  assert.equal(retry.status, "accepted");
  assert.equal(filler.draft.sceneDivisions?.length, 2);
  assert.equal(filler.draft.sceneDivisions?.[1]?.sceneIndex, 1, "场号按实际落库顺序算,不受被拒绝的那次影响");
});

test("剧本还没铺满就收尾时拒绝,并说清缺哪一段", () => {
  const filler = workspace();
  filler.setStoryOutline({ summary: "林晚投宿客栈" });
  filler.addScene({ name: "客栈门口", summary: "林晚抵达客栈", startLineIndex: 0, endLineIndex: 2 });
  filler.addCharacter({ name: "林晚", description: "女主角" });

  const outcome = filler.finish();

  assert.equal(outcome.status, "rejected");
  assert.match(outcome.status === "rejected" ? outcome.reason : "", /第 3 行/);
});

test("场次铺满就收得了尾:分镜不在阶段①产出(P6 阶段②一次拆镜)", () => {
  const filler = workspace();
  filler.setStoryOutline({ summary: "林晚投宿客栈" });
  filler.addScene({ name: "客栈门口", summary: "林晚抵达客栈", startLineIndex: 0, endLineIndex: 2 });
  filler.addScene({ name: "客房", summary: "林晚看山", startLineIndex: 3, endLineIndex: 4 });
  filler.addCharacter({ name: "林晚", description: "女主角" });

  const outcome = filler.finish();

  assert.equal(outcome.status, "accepted");
  assert.match(outcome.description, /2 场/);
});

test("收尾提示词与 finish 描述不再向模型要镜头(P6)", () => {
  const filler = workspace();
  filler.setStoryOutline({ summary: "林晚投宿客栈" });
  filler.addScene({ name: "客栈门口", summary: "林晚抵达客栈", startLineIndex: 0, endLineIndex: 4 });
  const outcome = filler.finish();
  assert.equal(outcome.status, "accepted");
  assert.match(outcome.description, /1 场/, "收尾只报场次与资产,不提镜头");
});

/**
 * 续跑护栏(P6 后口径)。阶段② 成功后的草稿整体落库一次;续跑时草稿里的
 * 分镜原样恢复,服务层见草稿已有镜头就不再重拆——重拆的唯一入口是
 * applyStoryboardShots,它是整体替换不是追加,重放不会产生重复镜头。
 */
test("续跑:草稿恢复分镜;再次落镜是整体替换,不产生重复", () => {
  const restored = new BreakdownWorkspace(
    {
      scriptLines: chunkScriptLines(SCRIPT),
      approvedAssets: [],
      targetDurationSec: null,
    },
    {
      storySummary: "林晚投宿客栈",
      sceneDivisions: [
        { sceneIndex: 0, name: "客栈门口", summary: "抵达", startLineIndex: 0, endLineIndex: 2 },
        { sceneIndex: 1, name: "客房", summary: "看山", startLineIndex: 3, endLineIndex: 4 },
      ],
      shotCandidates: [{
        candidateId: "shot_001",
        shotNo: 1,
        sceneIndex: 0,
        lineIndices: [0, 1, 2],
        elements: { subject: "林晚", action: "抵达客栈", visual: null, cameraLanguage: null },
        storyboardDetail: null,
        directorPrompt: null,
        imagePrompt: null,
        videoPrompt: "v1",
        durationSec: 4,
        characterNames: [],
        sceneNames: [],
        propNames: [],
        costumeNames: [],
      }],
    },
  );

  assert.equal(restored.draft.shotCandidates?.length, 1, "草稿恢复带回了已有分镜");

  // 阶段② 重放:整体替换,仍是 1 个镜头,不是 2 个。
  restored.applyStoryboardShots([{
    candidateId: "shot_001",
    shotNo: 1,
    sceneIndex: 0,
    lineIndices: [0, 1, 2],
    elements: { subject: "林晚", action: "抵达客栈", visual: null, cameraLanguage: null },
    storyboardDetail: null,
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt: "v2",
    durationSec: 4,
    characterNames: [],
    sceneNames: [],
    propNames: [],
    costumeNames: [],
  }]);
  assert.equal(restored.draft.shotCandidates?.length, 1, "重放是替换不是追加");
  assert.equal(restored.draft.shotCandidates?.[0]?.videoPrompt, "v2");
});

/**
 * 角色候选预关联。判据没变,只是从 assetsOutputToDraft 搬到了这里:
 * 项目里恰好一条同名已通过角色才提示绑定,同名多条是歧义,不静默任选。
 */
test("角色候选预关联:只有项目内唯一同名已通过角色才提示绑定", () => {
  const unique = new BreakdownWorkspace({
    scriptLines: chunkScriptLines(SCRIPT),
    approvedAssets: [{ assetEntityId: "asset-1", name: "林晚", assetKind: "character" }],
    targetDurationSec: null,
  });
  unique.addCharacter({ name: "林晚", description: "女主角" });
  assert.deepEqual(unique.draft.assetCandidates?.characters[0]?.prelinkedAsset, {
    assetEntityId: "asset-1",
    name: "林晚",
    matchedBy: "exact_name",
  });

  const ambiguous = new BreakdownWorkspace({
    scriptLines: chunkScriptLines(SCRIPT),
    approvedAssets: [
      { assetEntityId: "asset-1", name: "林晚", assetKind: "character" },
      { assetEntityId: "asset-2", name: "林晚", assetKind: "character" },
    ],
    targetDurationSec: null,
  });
  ambiguous.addCharacter({ name: "林晚", description: "女主角" });
  assert.equal(
    ambiguous.draft.assetCandidates?.characters[0]?.prelinkedAsset,
    null,
    "同名多条不能静默任选一个",
  );

  // 同名的是场景不是角色:不算数,角色预关联只看角色
  const otherKind = new BreakdownWorkspace({
    scriptLines: chunkScriptLines(SCRIPT),
    approvedAssets: [{ assetEntityId: "asset-3", name: "林晚", assetKind: "scene" }],
    targetDurationSec: null,
  });
  otherKind.addCharacter({ name: "林晚" });
  assert.equal(otherKind.draft.assetCandidates?.characters[0]?.prelinkedAsset, null);
});
