import assert from "node:assert/strict";
import test from "node:test";
import type { ArkChatClient, ChatMessage } from "./arkClient.js";
import { DoubaoVisionClient } from "./visionClient.js";

test("图片视觉抽取提示词:使用多模态资产字段合同和当前 asset_kind 词表", async () => {
  let prompt = "";
  const client = new DoubaoVisionClient({
    completeMessages: async (messages: ChatMessage[]) => {
      const content = messages[0]?.content;
      assert.ok(Array.isArray(content));
      const textPart = content.find((part) => part.type === "text");
      const text = typeof textPart?.text === "string" ? textPart.text : "";
      assert.ok(text);
      prompt = text;
      return JSON.stringify({
        asset_kind: "costume",
        name: "红衣造型",
        display_name: "红衣角色造型参考",
        intro: "用于角色造型参考。",
        appearance: "红色古风服饰造型。",
        age_value: null,
        gender: null,
        height_cm: null,
        hair_description: null,
        outfit_description: "红色古风服饰。",
        category: "造型参考",
        style_tags: ["古风", "红色", "造型参考"],
        person_type: null,
        asset_type: 1,
        extraction_confidence: 0.88,
        missing_fields: ["age_value", "gender", "height_cm", "hair_description"],
      });
    },
  } as unknown as ArkChatClient);

  const result = await client.describeImage(Buffer.from("fake-image"), "image/png", {
    fileName: "红衣造型.png",
    sourceProjectName: "测试项目",
  }, {});

  assert.equal(result.asset_kind, "costume");
  assert.match(prompt, /你是短剧多模态资产入库助手/);
  assert.match(prompt, /输出字段必须包含：asset_kind, name, display_name/);
  assert.match(prompt, /extraction_confidence/);
  assert.match(prompt, /missing_fields/);
  assert.match(prompt, /asset_kind 只能是 character \/ animal \/ scene \/ prop \/ costume \/ lighting \/ camera/);
  assert.match(prompt, /兼容旧字段/);
});
