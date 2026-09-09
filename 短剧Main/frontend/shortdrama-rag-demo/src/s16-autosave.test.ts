/* ============================================================
   s16-autosave.test.ts — S16 条 1「已保存」频闪回归锁定

   根因：后端 nullableText 一律 trim 存储（production/routes.ts:16），
   前端原样比较 → 尾随换行造成"保存→回包已 trim→仍 dirty→再保存"
   死循环（实证：输入一个换行后 18s 内 12 次相同 PATCH，标签频闪）。
   修复：dirty 判定按 trim 语义 + 已保存 ~2.4s 淡出。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { autosaveDirty, normalizePromptText, SAVED_FADE_MS, serverPromptTrio } from "./workbench-autosave";

const workbench = readFileSync(new URL("./pages/workbench-page.tsx", import.meta.url), "utf8");

describe("autosaveDirty（trim 语义，与服务端 nullableText 契约对齐）", () => {
  it("尾随换行/空格差异不算 dirty——保存循环从根上断（条 1 核心回归）", () => {
    const server = { script: "任天野骑在照夜玉狮子上，银甲染血。", image: "", video: "" };
    // 服务端 trim 存储后的回包 vs 本地带尾随换行——不再判定 dirty
    assert.equal(autosaveDirty({ script: "任天野骑在照夜玉狮子上，银甲染血。\n", image: "", video: "" }, server), false);
    assert.equal(autosaveDirty({ script: "  任天野骑在照夜玉狮子上，银甲染血。 \n\n", image: "", video: "" }, server), false);
  });

  it("真实内容变更才算 dirty", () => {
    const server = { script: "甲", image: "", video: "" };
    assert.equal(autosaveDirty({ script: "甲乙", image: "", video: "" }, server), true);
    assert.equal(autosaveDirty({ script: "甲", image: "新提示词", video: "" }, server), true);
    assert.equal(autosaveDirty({ script: "甲", image: "", video: "  " }, server), false, "纯空白输入不算变更");
  });

  it("null/undefined 与空串等价（DB NULL 不触发误报）", () => {
    assert.equal(normalizePromptText(null), "");
    assert.equal(normalizePromptText(undefined), "");
    assert.equal(autosaveDirty({ script: "", image: "", video: "" }, { script: "", image: "", video: "" }), false);
    const shot = { script_text: null, image_prompt: undefined, video_prompt: " x " };
    assert.deepEqual(serverPromptTrio(shot), { script: "", image: "", video: " x " });
  });

  it("已保存淡出时长锁定（出现一次后自动消失）", () => {
    assert.ok(SAVED_FADE_MS >= 1200 && SAVED_FADE_MS <= 4000, "淡出窗口应在可感知且不烦扰的区间");
  });
});

describe("源码级：工作台自动保存接 trim 判定+淡出", () => {
  it("dirty 判定走 autosaveDirty，不再原样比较", () => {
    assert.ok(workbench.includes("autosaveDirty("), "自动保存未接 trim 判定");
    assert.ok(workbench.includes('from "../workbench-autosave"'), "未引 workbench-autosave 模块");
    assert.ok(!workbench.includes('scriptText === (shot.script_text || "") && imagePrompt ==='), "旧原样比较仍在");
  });

  it("「已保存」有淡出 effect（SAVED_FADE_MS 后回 idle）", () => {
    assert.ok(workbench.includes("SAVED_FADE_MS"), "缺淡出时长");
    assert.ok(workbench.includes('setPromptSaveState("idle"), SAVED_FADE_MS'), "缺 saved→idle 淡出定时器");
  });
});
