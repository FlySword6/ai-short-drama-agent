import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispersion, matchNames, nameVariants, normalizeName, setStability } from "./metrics.js";

describe("拆解评测 · 名字归一", () => {
  it("大小写、全半角、括号注释、场次标记行前缀都不影响比对", () => {
    assert.equal(normalizeName("ELARA"), "elara");
    assert.equal(normalizeName("GRANDMA（外婆）"), "grandma");
    assert.equal(normalizeName("INT. POLICE STATION – DAY"), "police station");
    assert.equal(normalizeName("EXT. WOODS - NIGHT"), "woods");
  });

  it("括号里的中文名单独留一份,中文输出也能对上英文金标", () => {
    assert.deepEqual(nameVariants("GRANDMA（外婆）"), ["grandma", "外婆"]);
  });
});

describe("拆解评测 · 准确率与召回率", () => {
  const gold = {
    items: [
      { id: "elara", name: "ELARA", aliases: ["Luna"] },
      { id: "caleb", name: "CALEB", aliases: [] },
    ],
    excluded: [{ name: "电话", kind: "prop" }],
    disputed: [{ id: "d-chair", item: "椅子", kind: "prop" }],
  };

  it("别名算命中,金标里没有的算误报", () => {
    const result = matchNames(["Luna", "CALEB", "沈公子"], gold);
    assert.deepEqual(result.matchedGoldIds.sort(), ["caleb", "elara"]);
    assert.deepEqual(result.falsePositives, ["沈公子"]);
    assert.equal(result.precision, 2 / 3);
    assert.equal(result.recall, 1);
  });

  it("两种读法都立得住的条目不进分母,既不算命中也不算误报", () => {
    const result = matchNames(["ELARA", "椅子"], gold);
    assert.deepEqual(result.disputedHits, ["椅子"]);
    assert.deepEqual(result.falsePositives, []);
    assert.equal(result.precision, 1);
    assert.equal(result.recall, 0.5);
  });

  it("金标明确判定「不该当资产」的条目,拆出来就是误报,并单独点名", () => {
    const result = matchNames(["ELARA", "CALEB", "电话"], gold);
    assert.deepEqual(result.excludedHits, ["电话"]);
    assert.deepEqual(result.falsePositives, ["电话"]);
    assert.equal(result.precision, 2 / 3);
  });

  it("金标名写成中文、模型输出剧本原文里的英文词时,靠证据引文认亲", () => {
    const bilingual = {
      items: [{
        id: "sheet",
        name: "盖尸白布",
        aliases: [],
        evidenceQuotes: ["Emily gently lifts the sheet over the corpse's face"],
      }],
      excluded: [],
      disputed: [],
    };
    const result = matchNames(["sheet"], bilingual);
    assert.deepEqual(result.matchedGoldIds, ["sheet"]);
    assert.equal(result.recall, 1);
  });

  it("证据引文认亲只认整词,不让两三个字母的碎片乱认", () => {
    const bilingual = {
      items: [{ id: "sheet", name: "盖尸白布", aliases: [], evidenceQuotes: ["lifts the sheet"] }],
      excluded: [],
      disputed: [],
    };
    assert.deepEqual(matchNames(["she"], bilingual).matchedGoldIds, []);
  });

  it("一个都没拆出来时准确率按 0 报,不报 NaN", () => {
    const result = matchNames([], gold);
    assert.equal(result.precision, 0);
    assert.equal(result.recall, 0);
  });
});

describe("拆解评测 · 稳定性", () => {
  it("离散程度用标准差与变异系数,单次运行不报变异系数", () => {
    assert.deepEqual(dispersion([4, 4, 4]), { mean: 4, stdev: 0, cv: 0, min: 4, max: 4 });
    const spread = dispersion([2, 4, 6]);
    assert.equal(spread.mean, 4);
    assert.equal(Math.round(spread.stdev! * 1000) / 1000, 1.633);
    assert.equal(Math.round(spread.cv! * 1000) / 1000, 0.408);
    assert.equal(dispersion([5]).cv, null);
    assert.equal(dispersion([]).mean, null);
  });

  it("几次运行拆出来的角色集合有多像,用两两 Jaccard 的平均值", () => {
    assert.equal(setStability([["a", "b"], ["a", "b"]]), 1);
    assert.equal(setStability([["a", "b"], ["a", "c"]]), 1 / 3);
    assert.equal(setStability([["a"]]), null);
  });
});
