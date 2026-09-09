import assert from "node:assert/strict";
import test from "node:test";
import type { ArkChatClient } from "../../integrations/arkClient.js";
import { StoryboardHeaderMapper } from "./headerMapper.js";

test("标准分镜表头在本地识别，不调用文字模型", async () => {
  let modelCalls = 0;
  const mapper = new StoryboardHeaderMapper({
    async completeJson() {
      modelCalls += 1;
      return {};
    },
  } as unknown as ArkChatClient);

  const result = await mapper.mapHeaders("第1集分镜", [
    "集数",
    "镜号",
    "场景",
    "画面描述",
    "运镜",
    "景别/视角",
    "对白",
    "音效",
  ]);

  assert.equal(modelCalls, 0);
  assert.equal(result.episode, "集数");
  assert.equal(result.shotNo, "镜号");
  assert.equal(result.scene, "场景");
  assert.equal(result.screenDescription, "画面描述");
  assert.equal(result.cameraMotion, "运镜");
  assert.equal(result.shotSizeAngle, "景别/视角");
  assert.equal(result.dialogue, "对白");
  assert.equal(result.soundEffect, "音效");
});

test("无法本地确认的表头仍交给文字模型识别", async () => {
  let modelCalls = 0;
  const mapper = new StoryboardHeaderMapper({
    async completeJson() {
      modelCalls += 1;
      return {
        episode: "章节",
        shot_no: "序号",
        screen_description: "内容",
      };
    },
  } as unknown as ArkChatClient);

  const result = await mapper.mapHeaders("工作表", ["章节", "序号", "内容"]);

  assert.equal(modelCalls, 1);
  assert.equal(result.episode, "章节");
  assert.equal(result.shotNo, "序号");
  assert.equal(result.screenDescription, "内容");
});
