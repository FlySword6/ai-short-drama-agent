/* ============================================================
   prompt-sections.test.ts — GP-12 两段式提示词纯函数验收

   分界口径：自动段=系统预填整段（build*Prompt 同源产出），补充段=用户手输；
   拼接=自动段+换行+补充段（任一侧空即另一侧原文），与旧单框未编辑态注入语义一致；
   已存文本分界靠前缀比对，对不上如实整段作自动段+空白补充段。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { splicePromptSections, splitSavedPromptSections } from "./prompt-sections";

test("GP-12/splice：只有自动段 → 自动段原文（预填未动，同旧单框未编辑口径）", () => {
  const auto = "剧本文本\n使用资产：任天野\n画风：电影级写实";
  assert.equal(splicePromptSections(auto, ""), auto);
  assert.equal(splicePromptSections(auto, "   "), auto);
});

test("GP-12/splice：只有补充段 → 补充段原文（用户全手输，同旧单框手输口径）", () => {
  assert.equal(splicePromptSections("", "手输画面描述"), "手输画面描述");
  assert.equal(splicePromptSections("  ", "手输画面描述"), "手输画面描述");
});

test("GP-12/splice：两段都有 → 自动段去尾随空白 + 一个换行 + 补充段原文", () => {
  assert.equal(splicePromptSections("自动段内容\n", "补充一句"), "自动段内容\n补充一句");
  assert.equal(splicePromptSections("自动段内容", "补充一句"), "自动段内容\n补充一句");
});

test("GP-12/split：空已存 → 两段皆空（干净起点）", () => {
  assert.deepEqual(splitSavedPromptSections("", "候选"), { auto: "", supplement: "" });
  assert.deepEqual(splitSavedPromptSections("   ", "候选"), { auto: "", supplement: "" });
});

test("GP-12/split：已存==系统候选 → 整段自动段、补充段空（预填未动过）", () => {
  const candidate = "剧本文本\n使用资产：任天野\n画风：电影级写实";
  assert.deepEqual(splitSavedPromptSections(candidate, candidate), { auto: candidate, supplement: "" });
});

test("GP-12/split：已存=候选+换行+追加 → 候选为自动段、追加为补充段（旧单框追加过）", () => {
  const candidate = "剧本文本\n使用资产：任天野\n画风：电影级写实";
  assert.deepEqual(
    splitSavedPromptSections(`${candidate}\n追加：要雨天`, candidate),
    { auto: candidate, supplement: "追加：要雨天" },
  );
  assert.deepEqual(
    splitSavedPromptSections(`${candidate}\n\n追加：要雨天`, candidate),
    { auto: candidate, supplement: "追加：要雨天" },
  );
});

test("GP-12/split：对不上候选（改过半截/候选为空/前缀后非换行）→ 如实整段自动段+空白补充段", () => {
  const candidate = "剧本文本\n使用资产：任天野\n画风：电影级写实";
  // 旧单框里把系统文本改了一半——无法回溯哪段是用户的，不猜切点
  assert.deepEqual(
    splitSavedPromptSections("改写过的文本\n画风：电影级写实", candidate),
    { auto: "改写过的文本\n画风：电影级写实", supplement: "" },
  );
  // 候选为空（参考未载齐时也算对不上的一种）
  assert.deepEqual(
    splitSavedPromptSections("任何已存文本", ""),
    { auto: "任何已存文本", supplement: "" },
  );
  // 前缀命中但紧接的不是换行（候选恰好是更长文本的词头）——不算追加
  assert.deepEqual(
    splitSavedPromptSections(`${candidate}化的补充`, candidate),
    { auto: `${candidate}化的补充`, supplement: "" },
  );
});

test("GP-12/拼接-拆分互逆：预填+追加的已存文本拆完再拼 = 原文（自动保存不丢字）", () => {
  const candidate = "剧本文本\n使用资产：任天野\n画风：电影级写实";
  const saved = `${candidate}\n追加：要雨天`;
  const sections = splitSavedPromptSections(saved, candidate);
  assert.equal(splicePromptSections(sections.auto, sections.supplement), saved);
});
