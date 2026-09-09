import assert from "node:assert/strict";
import test from "node:test";
import {
  assetClearanceKeys,
  defaultAssetClearance,
  describeAssetClearanceIssues,
  inspectAssetClearance,
  parseAssetClearance,
} from "../src/db/schema.js";

// S40:clearance 管的是资产能否被检索/作生成参考/商用发布/训练模型。
// 这组测试锁定唯一的共享校验(src/db/schema.ts)的三条语义:
//   1. 缺省已知位 = 取 fail-safe 默认值,不报错;
//   2. 未知位一律拒绝(写入方与契约理解不一致必须显式失败);
//   3. 已知位必须是 JSON 布尔(字符串 "false"、数字、null、嵌套对象都拒绝)。

test("默认值与已知位集合互为镜像,且 fail-safe 默认不许改宽", () => {
  assert.deepEqual(Object.keys(defaultAssetClearance).sort(), [...assetClearanceKeys].sort());
  // 合规兜底:忘了设的时候必须是"没授权",这两位一旦被改宽就是合规事故。
  assert.equal(defaultAssetClearance.model_training, false);
  assert.equal(defaultAssetClearance.commercial_publish, false);
  assert.equal(defaultAssetClearance.search, true);
  assert.equal(defaultAssetClearance.gen_reference, true);
});

test("合法 clearance 原样通过,并按规范键序输出稳定形状", () => {
  const parsed = parseAssetClearance({
    model_training: true,
    search: false,
    gen_reference: true,
    commercial_publish: false,
  });
  assert.deepEqual(parsed, {
    search: false,
    gen_reference: true,
    commercial_publish: false,
    model_training: true,
  });
  assert.deepEqual(Object.keys(parsed), [...assetClearanceKeys]);
});

test("缺省已知位取 fail-safe 默认值而不是报错", () => {
  assert.deepEqual(parseAssetClearance({}), { ...defaultAssetClearance });
  assert.deepEqual(parseAssetClearance({ commercial_publish: true }), {
    ...defaultAssetClearance,
    commercial_publish: true,
  });
  assert.deepEqual(parseAssetClearance({ search: false }), {
    ...defaultAssetClearance,
    search: false,
  });
});

test("未知权利位一律拒绝", () => {
  assert.throws(
    () => parseAssetClearance({ search: true, derivatives: true }),
    /未知权利位 "derivatives"/,
  );
  assert.throws(() => parseAssetClearance({ searchable: true }), /未知权利位 "searchable"/);
});

test('非布尔值(字符串 "false"、数字、显式 null、嵌套对象)一律拒绝', () => {
  assert.throws(() => parseAssetClearance({ search: "false" }), /search 必须是布尔值/);
  assert.throws(() => parseAssetClearance({ search: 1 }), /search 必须是布尔值/);
  assert.throws(() => parseAssetClearance({ search: 0 }), /search 必须是布尔值/);
  assert.throws(() => parseAssetClearance({ search: null }), /search 必须是布尔值/);
  assert.throws(() => parseAssetClearance({ search: { enabled: true } }), /search 必须是布尔值/);
});

test("非对象整体(null、标量、数组)一律拒绝", () => {
  for (const value of [null, undefined, true, "clearance", 42, [{ search: true }]]) {
    assert.throws(() => parseAssetClearance(value), /必须是 jsonb 对象/);
  }
});

test("inspect 返回结构化问题供体检分组,describe 是同源文案", () => {
  const value = { search: "false", derivatives: true };
  const issues = inspectAssetClearance(value);
  assert.deepEqual(
    issues.map((issue) => ({ kind: issue.kind, key: issue.key })),
    [
      { kind: "unknown_bit", key: "derivatives" },
      { kind: "non_boolean_bit", key: "search" },
    ],
  );
  assert.deepEqual(describeAssetClearanceIssues(value), issues.map((issue) => issue.message));
  assert.deepEqual(inspectAssetClearance({ ...defaultAssetClearance }), []);
});

test("一行多个问题时全部报出,不吞", () => {
  const messages = describeAssetClearanceIssues({ search: "false", gen_reference: 1, extra: true });
  assert.equal(messages.length, 3);
  assert.ok(messages.some((message) => message.includes("未知权利位")));
  assert.ok(messages.some((message) => message.includes("search 必须是布尔值")));
  assert.ok(messages.some((message) => message.includes("gen_reference 必须是布尔值")));
});
