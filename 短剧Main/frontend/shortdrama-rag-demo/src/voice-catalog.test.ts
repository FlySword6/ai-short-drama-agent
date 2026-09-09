import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesVoice,
  voiceCatalogFromUnknown,
  voiceCategories,
  type VoiceCatalogVoice,
} from "./voice-catalog";

test("音色库响应解析:snake_case 映射、可选字段缺省、reason 透传", () => {
  const parsed = voiceCatalogFromUnknown({
    voices: [
      {
        id: "zh_female_vv_uranus_bigtts",
        display_name: "Vivi 2.0",
        language: "中文",
        category: "通用场景",
        gender: "女",
      },
      { id: "zh_male_sunwukong_uranus_bigtts", display_name: "猴哥 2.0", audition_url: "https://tos.example/x.mp3" },
    ],
  });
  assert.equal(parsed.voices.length, 2);
  assert.deepEqual(parsed.voices[0], {
    id: "zh_female_vv_uranus_bigtts", displayName: "Vivi 2.0", language: "中文", category: "通用场景", gender: "女",
  });
  assert.equal(parsed.voices[1]!.auditionUrl, "https://tos.example/x.mp3");
  assert.equal(parsed.reason, undefined);

  const empty = voiceCatalogFromUnknown({ voices: [], reason: "音色词表为空：种子未播或全部停用，未发送任何外部请求" });
  assert.deepEqual(empty.voices, []);
  assert.match(empty.reason ?? "", /词表为空/);
});

test("音色库响应解析:畸形响应 fail-closed,不静默兜底", () => {
  assert.throws(() => voiceCatalogFromUnknown({}), /格式不正确/);
  assert.throws(() => voiceCatalogFromUnknown({ voices: [{ display_name: "没 id" }] }), /格式不正确/);
});

test("音色筛选:分类精确匹配,关键词覆盖 id/名称/语种/性别", () => {
  const voices: VoiceCatalogVoice[] = [
    { id: "zh_female_cancan_uranus_bigtts", displayName: "知性灿灿 2.0", category: "角色扮演", gender: "女", language: "中文" },
    { id: "en_male_tim_uranus_bigtts", displayName: "Tim", category: "多语种", gender: "男", language: "美式英语" },
  ];
  assert.deepEqual(voiceCategories(voices), ["角色扮演", "多语种"]);
  assert.equal(matchesVoice(voices[0]!, "灿灿", ""), true);
  assert.equal(matchesVoice(voices[0]!, "", "角色扮演"), true);
  assert.equal(matchesVoice(voices[0]!, "", "多语种"), false);
  assert.equal(matchesVoice(voices[1]!, "英语", ""), true);
  assert.equal(matchesVoice(voices[1]!, "灿灿", ""), false);
});
