/* ============================================================
   k2m-prompt-sections.test.ts — K2M GP-12 验收（提示词两段式）

   剧本步 6：提示词=自动段（系统预填，只读）+补充段（手输，可编辑）；
   提交=两段拼接（注入语义同旧单框未编辑态）。
   K-goal-04 条 4：生成确认抽屉退场，两段式唯一呈现面=工作台生成卡提示词区；
   守卫随之从抽屉组件级改为页面源码级+纯函数级：
   - 自动段不在任何可编辑控件里——两段合并回一块全可编辑 textarea，本批必红；
   - startGeneration 提交全文=imagePrompt/videoPrompt（splice 同口径拼接）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { splicePromptSections } from "./prompt-sections";

const workbench = readFileSync(new URL("./pages/workbench-page.tsx", import.meta.url), "utf8");

/** 生成卡提示词区源码切片（「提示词」标题 → 生成卡底条）。 */
function promptAreaSource(): string {
  const start = workbench.indexOf("提示词</h2>");
  const end = workbench.indexOf("生成卡底条", start);
  assert.ok(start > 0 && end > start, "生成卡提示词区边界没找到");
  return workbench.slice(start, end);
}

test("K2M/GP-12：生成卡两段式——自动段只读呈现、补充段是唯一可编辑提示词控件（合并回一块此测必红）", () => {
  const area = promptAreaSource();
  assert.ok(area.includes('data-testid="prompt-auto-section"'), "自动段区块缺失（两段式退回一块了）");
  assert.ok(area.includes("自动段 · 系统预填（只读）"), "自动段未标明只读");
  assert.ok(area.includes("补充段 · 手输（可编辑）"), "补充段标识缺失");
  // 自动段渲染为只读 <p>，自动段区块到补充段之间不得出现任何 textarea/可编辑控件
  const autoStart = area.indexOf('data-testid="prompt-auto-section"');
  const supplementStart = area.indexOf("补充段 · 手输（可编辑）");
  assert.ok(supplementStart > autoStart, "补充段必须在自动段之后");
  const between = area.slice(autoStart, supplementStart);
  assert.ok(!/<textarea|MentionTextarea|contentEditable/i.test(between), "自动段区块里出现可编辑控件（只读保护失守）");
  // 补充段只挂一个 MentionTextarea（两段合并回一块全可编辑框=这里会出现第二个框装自动段）
  const mentionCount = (area.match(/<MentionTextarea/g) ?? []).length;
  assert.equal(mentionCount, 1, "提示词区应只剩补充段一个可编辑框");
});

test("K2M/GP-12：无自动段（用户全手输）→ 不渲染自动段区块（条件渲染守卫）", () => {
  const autoStart = workbench.indexOf('data-testid="prompt-auto-section"');
  const conditionStart = workbench.lastIndexOf("{(activeKind", autoStart);
  assert.ok(conditionStart > 0 && autoStart - conditionStart < 400, "自动段区块缺条件渲染（空自动段也会占位）");
  assert.ok(workbench.slice(conditionStart, autoStart).includes(".trim()"), "自动段条件未按 trim 判空");
});

test("K2M/GP-12：提交=自动段+补充段拼接——startGeneration 用 splice 口径全文，不各段单发", () => {
  // 页面全文口径：imagePrompt/videoPrompt=splicePromptSections(自动段, 补充段)
  assert.ok(workbench.includes("splicePromptSections(imageAutoPrompt, imageSupplement)"), "图片全文未按 splice 口径拼接");
  assert.ok(workbench.includes("splicePromptSections(videoAutoPrompt, videoSupplement)"), "视频全文未按 splice 口径拼接");
  const start = workbench.indexOf("async function startGeneration");
  assert.ok(start > 0, "startGeneration 不存在");
  const body = workbench.slice(start, start + 900);
  assert.ok(body.includes("imagePrompt.trim()"), "startGeneration 未读 splice 后全文（图片）");
  assert.ok(body.includes("videoPrompt.trim()"), "startGeneration 未读 splice 后全文（视频）");
  // 空全文时先预填自动段再提交（口径同旧抽屉入口）
  assert.ok(body.includes("buildImagePrompt(shot, refs)") && body.includes("buildVideoPrompt(shot, refs)"), "空全文预填自动段口径丢失");
  // 纯函数级：拼接语义锚定（autosave/提交共用）
  const AUTO_TEXT = "任天野骑在照夜玉狮子上，银甲染血。\n使用资产：任天野、巷口雨夜\n画风：电影级写实，真实光影，人物与服装保持一致。";
  assert.equal(splicePromptSections(AUTO_TEXT, "补充：要雨夜逆光"), `${AUTO_TEXT}\n补充：要雨夜逆光`, "提交全文不是两段拼接");
  assert.equal(splicePromptSections("", "测试提示词"), "测试提示词", "无自动段时补充段即全文");
});
