/* prompt-mentions 单测：@ 查询探测 / 过滤 / 插入 / 提及解析（纯逻辑）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendMentionAtCaret,
  detectMentionQuery,
  extractMentions,
  filterMentionCandidates,
  insertMention,
  type MentionCandidate,
} from "./prompt-mentions";

const CANDIDATES: MentionCandidate[] = [
  { key: "ref-1", name: "任天野", subtitle: "角色身份" },
  { key: "ref-2", name: "巷口雨夜", subtitle: "场景" },
  { key: "ref-3", name: "银边短刀" },
];

describe("detectMentionQuery", () => {
  it("行首/空白/句读后的 @ 触发查询态", () => {
    assert.deepEqual(detectMentionQuery("@任", 2), { start: 0, end: 2, query: "任" });
    assert.deepEqual(detectMentionQuery("雨夜。@", 4), { start: 3, end: 4, query: "" });
    assert.deepEqual(detectMentionQuery("参考 @巷口", 6), { start: 3, end: 6, query: "巷口" });
  });

  it("邮箱等粘连文本不触发；空白/超长后失效", () => {
    assert.equal(detectMentionQuery("test@col.com", 8), null);
    assert.equal(detectMentionQuery("@任 天", 4), null);
    assert.equal(detectMentionQuery(`@${"很长".repeat(13)}`, 27), null);
  });
});

describe("filterMentionCandidates", () => {
  it("空查询返回前 N 个；前缀优先于包含", () => {
    assert.deepEqual(filterMentionCandidates(CANDIDATES, "").map((c) => c.key), ["ref-1", "ref-2", "ref-3"]);
    const hits = filterMentionCandidates(CANDIDATES, "巷");
    assert.equal(hits[0]!.key, "ref-2");
  });

  it("大小写不敏感 + limit 生效", () => {
    const many: MentionCandidate[] = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, name: `Asset${i}` }));
    assert.equal(filterMentionCandidates(many, "asset", 8).length, 8);
  });
});

describe("insertMention / appendMentionAtCaret", () => {
  it("替换查询段并落在插入文本之后", () => {
    const active = detectMentionQuery("雨夜。@巷", 5)!;
    const result = insertMention("雨夜。@巷", active, "巷口雨夜");
    assert.equal(result.text, "雨夜。@巷口雨夜 ");
    assert.equal(result.caret, result.text.length);
  });

  it("chips 写入：光标在词中时先补前导空格", () => {
    const result = appendMentionAtCaret("打斗", 2, "任天野");
    assert.equal(result.text, "打斗 @任天野 ");
    const atStart = appendMentionAtCaret("", 0, "任天野");
    assert.equal(atStart.text, "@任天野 ");
  });
});

describe("extractMentions", () => {
  it("按首次出现排序、按 key 去重、忽略 <2 字名称", () => {
    const text = "@巷口雨夜 里 @任天野 拔刀，再次提到 @巷口雨夜";
    const found = extractMentions(text, [...CANDIDATES, { key: "ref-9", name: "刀" }]);
    assert.deepEqual(found.map((item) => item.candidate.key), ["ref-2", "ref-1"]);
    assert.ok(found[0]!.index < found[1]!.index);
  });

  it("没有 @ 前缀的裸名称不算提及", () => {
    assert.equal(extractMentions("任天野走进巷口雨夜", CANDIDATES).length, 0);
  });
});
