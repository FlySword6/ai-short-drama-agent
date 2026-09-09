import assert from "node:assert/strict";
import test from "node:test";
import { parseToolCallArguments, TOOL_CALL_ARGUMENTS_EXCERPT_MAX_CHARS } from "./toolCallArguments.js";

/**
 * 工具入参的解析结果只有两种:读得出,或读不出并留下一段能定位的片段。
 * 片段是给排查的人看的,不进用户可见文案,所以只要求「短、单行、不带密钥」。
 */

test("合法 JSON 对象读得出", () => {
  assert.deepEqual(parseToolCallArguments("{\"name\":\"林晚\"}"), {
    readable: true,
    arguments: { name: "林晚" },
  });
});

test("供应商直接给对象时照收,空串按空入参处理", () => {
  assert.deepEqual(parseToolCallArguments({ name: "林晚" }), {
    readable: true,
    arguments: { name: "林晚" },
  });
  assert.deepEqual(parseToolCallArguments("   "), { readable: true, arguments: {} });
});

test("裸词没加引号时读不出,并留下原样片段", () => {
  // 这是 doubao-seed-2-1-pro 实测挂掉的形状:female 是裸词。
  const result = parseToolCallArguments("{\"name\": \"Grandma\", \"gender\": female}");

  assert.equal(result.readable, false);
  assert.ok(result.readable === false);
  assert.match(result.excerpt, /gender/);
  assert.match(result.excerpt, /female/);
});

test("不是对象的 JSON 也算读不出", () => {
  assert.equal(parseToolCallArguments("[1,2,3]").readable, false);
  assert.equal(parseToolCallArguments("null").readable, false);
  assert.equal(parseToolCallArguments(42).readable, false);
});

test("片段截断到定长并压成单行,不把整篇剧本抄进日志", () => {
  const long = `{"summary":"${"剧".repeat(500)}`;

  const result = parseToolCallArguments(long);

  assert.ok(result.readable === false);
  assert.ok(
    result.excerpt.length <= TOOL_CALL_ARGUMENTS_EXCERPT_MAX_CHARS + 1,
    `片段长度 ${result.excerpt.length} 超出上限`,
  );
  assert.ok(result.excerpt.endsWith("…"), "截断要有明确标记");
});

test("片段压成单行,换行不会把一条日志撑成一屏", () => {
  const result = parseToolCallArguments("{\n  \"summary\": \"第一场\",\n  \"gender\": female\n}");

  assert.ok(result.readable === false);
  assert.doesNotMatch(result.excerpt, /[\n\r]/);
});

test("片段里像密钥的赋值一律打码", () => {
  const result = parseToolCallArguments(
    "{\"note\":\"api_key=sk-live-abcdefghijklmn\", \"Authorization\": \"Bearer zzzz\", \"token\":\"t-1234\",",
  );

  assert.ok(result.readable === false);
  assert.doesNotMatch(result.excerpt, /sk-live-abcdefghijklmn/);
  assert.doesNotMatch(result.excerpt, /Bearer zzzz/);
  assert.doesNotMatch(result.excerpt, /t-1234/);
  assert.match(result.excerpt, /\[REDACTED\]/);
});
