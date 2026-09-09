import assert from "node:assert/strict";
import test from "node:test";
import { parseAssetQuarantine } from "../../scripts/legacy-merge-etl/lib/quarantine.mjs";

// 人工指定资产隔离清单(manual_quarantined)的解析与拒执路径。

test("asset-quarantine: 合法清单解析为 Map", () => {
  const map = parseAssetQuarantine({
    assets: {
      "782a3ba5-4abf-4701-93f1-e021b7e02809": { reason: "图片归属错配: 主图实为楚家茶室", decidedBy: "kimi-s52" },
    },
  });
  assert.equal(map.size, 1);
  assert.deepEqual(map.get("782a3ba5-4abf-4701-93f1-e021b7e02809"), {
    reason: "图片归属错配: 主图实为楚家茶室",
    decidedBy: "kimi-s52",
  });
});

test("asset-quarantine: 空清单/缺 assets 键 → 空 Map(不报错)", () => {
  assert.equal(parseAssetQuarantine({}).size, 0);
  assert.equal(parseAssetQuarantine({ assets: {} }).size, 0);
  assert.equal(parseAssetQuarantine({ assets: null }).size, 0);
});

test("asset-quarantine: 非对象根/assets 非映射 → 抛错", () => {
  assert.throws(() => parseAssetQuarantine("nope"), /必须是对象/);
  assert.throws(() => parseAssetQuarantine({ assets: [] }), /必须是对象映射/);
});

test("asset-quarantine: 缺 reason/decidedBy 或空串 → 抛错(不许无理由隔离)", () => {
  assert.throws(() => parseAssetQuarantine({ assets: { abc: { decidedBy: "x" } } }), /assets\["abc"\] 非法/);
  assert.throws(() => parseAssetQuarantine({ assets: { abc: { reason: "  ", decidedBy: "x" } } }), /assets\["abc"\] 非法/);
  assert.throws(() => parseAssetQuarantine({ assets: { abc: { reason: "r" } } }), /assets\["abc"\] 非法/);
  assert.throws(() => parseAssetQuarantine({ assets: { abc: { reason: "r", decidedBy: "" } } }), /assets\["abc"\] 非法/);
});

test("asset-quarantine: 空 sourcePk → 抛错", () => {
  assert.throws(() => parseAssetQuarantine({ assets: { "  ": { reason: "r", decidedBy: "x" } } }), /空 sourcePk/);
});
