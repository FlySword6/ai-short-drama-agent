import assert from "node:assert/strict";
import test from "node:test";
import { referenceImageViolation } from "./referencePrecheck.js";

test("参考图预检:常规尺寸与边界宽高比放行", () => {
  assert.equal(referenceImageViolation({ widthPx: 1024, heightPx: 1024 }), null);
  assert.equal(referenceImageViolation({ widthPx: 300, heightPx: 750 }), null); // 0.4 下限
  assert.equal(referenceImageViolation({ widthPx: 6000, heightPx: 2400 }), null); // 2.5 上限
});

test("参考图预检:尺寸未知的历史资产放行不阻断", () => {
  assert.equal(referenceImageViolation({ widthPx: null, heightPx: null }), null);
  assert.equal(referenceImageViolation({ widthPx: 1024, heightPx: null }), null);
  assert.equal(referenceImageViolation({ widthPx: 0, heightPx: 0 }), null);
});

test("参考图预检:边长越界人话报错", () => {
  assert.match(referenceImageViolation({ widthPx: 299, heightPx: 500 })!, /边长不能小于 300px/);
  assert.match(referenceImageViolation({ widthPx: 500, heightPx: 200 })!, /边长不能小于 300px/);
  assert.match(referenceImageViolation({ widthPx: 6001, heightPx: 3000 })!, /边长不能超过 6000px/);
});

test("参考图预检:宽高比越界人话报错", () => {
  assert.match(referenceImageViolation({ widthPx: 1000, heightPx: 3000 })!, /宽高比需在 0.4~2.5 之间/); // 0.333
  assert.match(referenceImageViolation({ widthPx: 3000, heightPx: 1000 })!, /宽高比需在 0.4~2.5 之间/); // 3.0
});
