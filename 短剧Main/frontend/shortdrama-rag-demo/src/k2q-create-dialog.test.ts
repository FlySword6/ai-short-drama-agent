/* ============================================================
   k2q-create-dialog.test.ts — K2Q 包验收断言（测试+代码成对提交）

   GP-09：建项目弹窗 1440×900（基准视口）下内容溢出，「指定审核人」被裁切——
          弹窗按实例放宽高度上限（calc(100dvh-2rem)），全字段完整可见；
          既有弹窗模式不动（DialogBody 滚动 + 底栏常驻兜底更小视口）。
   GP-10：「谁可以看这部剧」成员 chip 上屏口径=显示名（陈默），用户名只作
          唯一标识落账（viewerNames 存规范 username，提交解析口径不变）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEMO_DIRECTORY } from "./operations";
import { resolveDirectoryUser, viewerChipLabel } from "./components/user-search-input";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const globalPages = readSource("./pages/global-pages.tsx");
const dialogPrimitive = readSource("./components/ui/dialog.tsx");

/** 截取新建项目弹窗源码块（从 showCreate 的 Dialog 起到首个 </Dialog> 闭合止），断言只盯这个弹窗。 */
function createDialogBlock(): string {
  const start = globalPages.indexOf("<Dialog open={showCreate}");
  assert.notEqual(start, -1, "找不到新建项目弹窗");
  const end = globalPages.indexOf("</Dialog>", start);
  assert.notEqual(end, -1, "新建项目弹窗没有闭合");
  return globalPages.slice(start, end);
}

/* ---------- GP-09：弹窗高度收敛 ---------- */

test("GP-09：新建弹窗按实例放宽高度上限——calc(100dvh-2rem)，基准视口 900px 全字段完整可见", () => {
  const block = createDialogBlock();
  assert.ok(
    block.includes('className="max-h-[calc(100dvh-2rem)]"'),
    "新建弹窗未放宽高度上限（仍是默认 85dvh，900px 视口下指定审核人被裁）",
  );
});

test("GP-09：既有弹窗模式兜底不动——DialogBody 滚动 + 底栏常驻 + 全局 85dvh 默认不改", () => {
  const block = createDialogBlock();
  assert.ok(block.includes("<DialogBody>"), "新建弹窗缺 DialogBody（内容区）");
  assert.ok(block.includes("<DialogFooter>"), "新建弹窗缺 DialogFooter（取消/创建项目常驻底栏）");
  /* 组件层默认约束不变：本包只动新建弹窗一个实例，其他弹窗不受影响 */
  assert.ok(dialogPrimitive.includes("max-h-[85dvh]"), "Dialog 全局默认高度上限被改动");
  assert.ok(dialogPrimitive.includes("overflow-y-auto"), "DialogBody 滚动兜底被改动");
});

test("GP-09：八段字段仍都在弹窗里（放宽上限不是删字段）", () => {
  const block = createDialogBlock();
  for (const label of ["项目名称", "项目说明", "负责人", "题材", "谁可以看这部剧", "图片默认审核", "视频默认审核", "指定审核人"]) {
    assert.ok(block.includes(label), `新建弹窗缺字段「${label}」`);
  }
});

/* ---------- GP-10：成员 chip 上屏=显示名 ---------- */

test("GP-10：viewerChipLabel——username 落账、显示名上屏（chenmo→陈默）", () => {
  assert.equal(viewerChipLabel(DEMO_DIRECTORY, "chenmo"), "陈默");
  assert.equal(viewerChipLabel(DEMO_DIRECTORY, "zhoulan"), "周岚");
  assert.equal(viewerChipLabel(DEMO_DIRECTORY, "alice"), "Alice");
  /* 大小写不敏感（与解析口径一致） */
  assert.equal(viewerChipLabel(DEMO_DIRECTORY, "ChenMo"), "陈默");
});

test("GP-10：viewerChipLabel——目录查不到时如实回落原串（不编造、不空白）", () => {
  assert.equal(viewerChipLabel(DEMO_DIRECTORY, "ghost-user"), "ghost-user");
  assert.equal(viewerChipLabel([], "chenmo"), "chenmo");
});

test("GP-10：归一前提——显示名手打也能解析出规范 username（resolveDirectoryUser 双口径）", () => {
  assert.equal(resolveDirectoryUser(DEMO_DIRECTORY, "陈默")?.username, "chenmo");
  assert.equal(resolveDirectoryUser(DEMO_DIRECTORY, "chenmo")?.username, "chenmo");
  assert.equal(resolveDirectoryUser(DEMO_DIRECTORY, "不存在的人"), null);
});

test("GP-10 源码级：chip 渲染走 viewerChipLabel，username 只作 key/提交键不上屏", () => {
  const block = createDialogBlock();
  assert.ok(block.includes("viewerChipLabel(directory, item)"), "成员 chip 未按显示名上屏");
  assert.ok(block.includes("aria-label={`移除 ${label}`}"), "移除按钮可读名未同步显示名");
  /* 落账归一：Enter 添加按 target.username 存，不再存手打原串 */
  assert.ok(block.includes("current.includes(target.username)"), "仅查看成员未按规范 username 归一去重");
  assert.ok(block.includes("[...current, target.username]"), "仅查看成员未落规范 username");
});
