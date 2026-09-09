import assert from "node:assert/strict";
import test from "node:test";
import { BreakdownWorkspace } from "../script-breakdown/agent/workspace.js";

test("ai-gateway-col-分镜身份由阶段②解析按连续镜号确定(P6)", () => {
  const workspace = new BreakdownWorkspace({
    scriptLines: [
      { lineIndex: 0, text: "林雪转身。" },
      { lineIndex: 1, text: "周行走近。" },
    ],
    approvedAssets: [],
    targetDurationSec: null,
  });
  workspace.addScene({ name: "旧仓库", summary: "林雪转身", startLineIndex: 0, endLineIndex: 0 });
  workspace.addScene({ name: "天台", summary: "周行走近", startLineIndex: 1, endLineIndex: 1 });
  workspace.addCharacter({ name: "林雪" });
  workspace.addCharacter({ name: "周行" });
  workspace.addLocation({ name: "旧仓库" });
  workspace.addLocation({ name: "天台" });

  // 阶段②产出的镜头按解析顺序带连续镜号落草稿,工作台整体接住。
  workspace.applyStoryboardShots([
    {
      candidateId: "shot_001", shotNo: 1, sceneIndex: 0, lineIndices: [0],
      elements: { subject: "林雪", action: "转身", visual: "仓库夜景", cameraLanguage: "中景" },
      storyboardDetail: null, directorPrompt: null, imagePrompt: null, videoPrompt: "p1",
      durationSec: 4, characterNames: ["林雪"], sceneNames: ["旧仓库"], propNames: [], costumeNames: [],
    },
    {
      candidateId: "shot_002", shotNo: 2, sceneIndex: 1, lineIndices: [1],
      elements: { subject: "周行", action: "走近", visual: "天台日景", cameraLanguage: "近景" },
      storyboardDetail: null, directorPrompt: null, imagePrompt: null, videoPrompt: "p2",
      durationSec: 5, characterNames: ["周行"], sceneNames: ["天台"], propNames: [], costumeNames: [],
    },
  ]);

  assert.deepEqual(
    workspace.draft.shotCandidates?.map((shot) => shot.candidateId),
    ["shot_001", "shot_002"],
  );
});
