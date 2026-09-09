/* ============================================================
   lite-workspace-page.test.ts — 一键生成本集「重跑入口 + 二次确认」（契约 v1.3.1 六.5）

   口径锁定（脚本页并入制作页后，v0.1.1 Lite 界面重做）:
   - 已确认（"已采用"锁定态）的集，动作条保留常驻「重新生成本集」入口，
     不需要先进「编辑剧本」解锁。
   - 点击弹二次确认对话框:明确告知现有分镜会被覆盖（软删重建）、
     素材只补缺失不覆盖不删除、不可撤销。
   - 「再想想」只关闭不提交;「确认重新生成」关闭并调用 autoGenerate()
     （同一重跑链路:新 submit → 新 run → 自动 confirm → 刷新分镜区）。

   不导入 .tsx（无 jsdom 会触发 React 组件评估挂起），
   纯函数复制同口径，结构断言用源码扫描。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./pages/lite/lite-workspace-page.tsx", import.meta.url), "utf8");

/* 确认态动作条 = 「重新生成本集」按钮块；二次确认对话框夹在两注释锚之间。 */
const RERUN_BUTTON_AT = source.indexOf("重新生成本集");
assert.ok(RERUN_BUTTON_AT >= 0, "缺「重新生成本集」入口");
const DIALOG_START = source.indexOf("重跑二次确认");
const DIALOG_END = source.indexOf("删集二次确认");
assert.ok(DIALOG_START >= 0 && DIALOG_END > DIALOG_START, "二次确认对话框缺失");
const dialog = source.slice(DIALOG_START, DIALOG_END);

// ---- 纯函数(复制自 lite-workspace-page.tsx 同口径) ----

/** 二次确认对话框的说明文案:复用 confirmedCounts 组装"本集已生成 N 场、M 个分镜"。 */
function rerunDialogDescription(scenes: number | null, shots: number | null): string {
  const counts =
    scenes !== null && shots !== null ? `本集已生成 ${scenes} 场、${shots} 个分镜。` : "本集已生成过分镜与素材。";
  return `${counts}重新生成将按当前剧本重新解析：现有分镜会被覆盖（软删重建），素材只补缺失、不覆盖不删除。此操作不可撤销。`;
}
function rerunLockedPromptWarning(count: number): string | null {
  return count > 0
    ? `本集有 ${count} 条你锁定的提示词，重新生成会一并清除，锁定不保护这一步。`
    : null;
}

// ---- 源码扫描断言 ----

test("T11.10 已确认集保留常驻「重新生成本集」入口(无需解锁)", () => {
  const bar = source.slice(RERUN_BUTTON_AT - 400, RERUN_BUTTON_AT + 120);
  assert.match(bar, /重新生成本集/);
  assert.match(bar, /onClick=\{\(\) => setRerunDialogOpen\(true\)\}/, "打开二次确认而不是直接重跑");
  assert.match(bar, /disabled=\{busy !== null \|\| shotsState\.loading \|\| shotsState\.data === null\}/, "分镜锁定计数未就绪时不得打开破坏性重跑弹窗");
  assert.doesNotMatch(bar, /autoGenerate/, "入口按钮不得直接调 autoGenerate");
  /* 相邻的「编辑剧本」走解锁开关，也不直接重跑。 */
  const editButtonAt = source.indexOf("编辑剧本");
  const editButton = source.slice(editButtonAt - 300, editButtonAt + 100);
  assert.match(editButton, /onClick=\{\(\) => setEditUnlocked\(true\)\}/);
  assert.doesNotMatch(editButton, /autoGenerate/);
});

test("T11.11a 二次确认对话框:文案明确覆盖分镜/只补素材/不可撤销", () => {
  assert.match(dialog, /<DialogTitle>重新生成本集？<\/DialogTitle>/);
  assert.match(dialog, /现有分镜会被覆盖（软删重建）/);
  assert.match(dialog, /素材只补缺失、不覆盖不删除/);
  assert.match(dialog, /此操作不可撤销/);
  assert.match(dialog, /confirmedCounts/, "说明复用已确认计数");
});

test("T11.11b 对话框按钮:再想想只关闭,确认重新生成才走 autoGenerate", () => {
  assert.match(dialog, /setRerunDialogOpen\(false\)}>再想想<\/Button>/);
  assert.match(dialog, /setRerunDialogOpen\(false\);\s*\n\s*void autoGenerate\(\);/, "确认按钮先关对话框再触发重跑");
  assert.match(dialog, /确认重新生成\s*<\/Button>/);
});

test("T11.11c 对话框说明文案与纯函数口径一致", () => {
  const countsLine = dialog.slice(dialog.indexOf("DialogDescription"), dialog.indexOf("重新生成将按当前剧本"));
  assert.ok(countsLine.includes("本集已生成"), "计数分句存在");
  assert.ok(countsLine.includes("本集已生成过分镜与素材"), "无计数回落文案存在");
  const body = dialog.slice(dialog.indexOf("重新生成将按当前剧本"));
  assert.ok(body.includes("现有分镜会被覆盖（软删重建），素材只补缺失、不覆盖不删除。此操作不可撤销。"), "正文逐字一致");
  assert.equal(
    rerunDialogDescription(3, 12),
    "本集已生成 3 场、12 个分镜。重新生成将按当前剧本重新解析：现有分镜会被覆盖（软删重建），素材只补缺失、不覆盖不删除。此操作不可撤销。",
  );
  assert.equal(
    rerunDialogDescription(null, null),
    "本集已生成过分镜与素材。重新生成将按当前剧本重新解析：现有分镜会被覆盖（软删重建），素材只补缺失、不覆盖不删除。此操作不可撤销。",
  );
});
test("T11.11d 二次确认仅在存在锁定提示词时显示准确数量", () => {
  assert.equal(
    rerunLockedPromptWarning(2),
    "本集有 2 条你锁定的提示词，重新生成会一并清除，锁定不保护这一步。",
  );
  assert.equal(rerunLockedPromptWarning(0), null);
  assert.match(dialog, /lockedPromptCount > 0/);
  assert.match(dialog, /本集有 \{lockedPromptCount\} 条你锁定的提示词/);
});

/* ---- 整剧导入接线（2026-08-17 修复：空项目空态卡点「导入剧本」无反应） ---- */

test("T11.12 空项目空态卡的「导入剧本」能点到隐藏文件选择（2026-08-17 修复回归锁）", () => {
  /* 事故：隐藏 input 只挂主工作台分支；新建项目（0 集）走 !episodeId 空态卡分支，
     ref 为 null → 点击导入按钮无反应。修复：input 抽成共享 JSX，两个分支都挂载。 */
  const emptyBranchAt = source.indexOf("还没有可工作的剧集");
  assert.ok(emptyBranchAt >= 0, "缺空项目空态卡");
  const emptyBranch = source.slice(emptyBranchAt, emptyBranchAt + 1600);
  assert.match(emptyBranch, /bulkImportFileInput/, "空态卡分支必须挂载隐藏文件选择");
  assert.match(emptyBranch, /onClick=\{openBulkImportPicker\}/, "空态卡按钮直调打开文件选择");
  assert.equal(source.split("bulkImportFileInput").length - 1, 3, "共享隐藏 input 应定义 1 次 + 挂载 2 处");
  assert.equal(source.split("onClick={openBulkImportPicker}").length - 1, 2, "左栏剧集头与空态卡两处按钮都直调");
  /* 事件中转已随壳按钮退役（壳单条化后导入按钮全在本页），不再 window.dispatchEvent */
  assert.doesNotMatch(source, /window\.dispatchEvent/, "导入不再走事件中转");
});

/* ---- R2-12 集名按剧本真名展示（2026-08-17 用户反馈） ---- */

/** 纯函数复制自 lite-workspace-page.tsx 同口径（.tsx 不能直接 import）。 */
const EPISODE_HEADING_NAME_PATTERN = /^(?:第[ \t]*[零〇一二两三四五六七八九十百\d]+[ \t]*[集话]|EPISODE[ \t]*\d+)/iu;

function episodeDisplayLabel(episode: { episode_no: number; name?: string | null }): { primary: string; secondary: string | null; title: string } {
  const name = episode.name?.trim() ?? "";
  const chinese = /[\u4e00-\u9fff]/u.test(name);
  const marker = !name || chinese ? `第 ${episode.episode_no} 集` : `EPISODE ${episode.episode_no}`;
  if (!name) return { primary: marker, secondary: null, title: marker };
  if (EPISODE_HEADING_NAME_PATTERN.test(name)) return { primary: name, secondary: null, title: name };
  return { primary: marker, secondary: name, title: `${marker} · ${name}` };
}

test("T11.13a 集名即集号标题（EPISODE N / 第N集）时单行展示，不再叠固定「第 N 集」", () => {
  assert.deepEqual(episodeDisplayLabel({ episode_no: 1, name: "EPISODE 1" }), { primary: "EPISODE 1", secondary: null, title: "EPISODE 1" });
  assert.deepEqual(episodeDisplayLabel({ episode_no: 3, name: "EPISODE 3: Night" }), { primary: "EPISODE 3: Night", secondary: null, title: "EPISODE 3: Night" });
  assert.deepEqual(episodeDisplayLabel({ episode_no: 2, name: "第2集" }), { primary: "第2集", secondary: null, title: "第2集" });
  assert.deepEqual(episodeDisplayLabel({ episode_no: 1, name: "第一集：重逢" }), { primary: "第一集：重逢", secondary: null, title: "第一集：重逢" });
});

test("T11.13b 普通集名：标题按集名语言取（中文名→第 N 集，英文名→EPISODE N），集名次行", () => {
  assert.deepEqual(episodeDisplayLabel({ episode_no: 2, name: "祠堂夜话" }), { primary: "第 2 集", secondary: "祠堂夜话", title: "第 2 集 · 祠堂夜话" });
  assert.deepEqual(episodeDisplayLabel({ episode_no: 3, name: "The Long Night" }), { primary: "EPISODE 3", secondary: "The Long Night", title: "EPISODE 3 · The Long Night" });
  assert.deepEqual(episodeDisplayLabel({ episode_no: 1, name: "" }), { primary: "第 1 集", secondary: null, title: "第 1 集" });
});

test("T11.13c 左栏不再渲染固定「第 {episode_no} 集」首行（R2-12 回归锁）", () => {
  assert.doesNotMatch(source, /第 \{episode\.episode_no\} 集\n/, "左栏集项首行不得再是固定「第 N 集」");
  assert.match(source, /episodeDisplayLabel\(episode\)/, "左栏集项文案必须走 episodeDisplayLabel");
});

/* ---- R2-13 集拖动排序 + R2-14 导入按钮下沉到剧集头（2026-08-17 用户反馈） ---- */

test("T11.14a 左栏集项可拖动：draggable + dnd 事件 + 落盘 sort_order（R2-13）", () => {
  assert.match(source, /draggable=\{dragArmed && !renaming\}/, "集项可拖且受拖拽开关约束（改名时禁拖）");
  assert.match(source, /onDragStart=/, "缺拖起事件");
  assert.match(source, /onDrop=\{\(event\) => \{\s*event\.preventDefault\(\);\s*void handleEpisodeDrop\(episode\.id\);\s*\}\}/, "缺落点事件");
  assert.match(source, /void handleEpisodeDrop\(/, "落点必须走统一提交");
  assert.match(source, /api\.updateEpisode\(episode\.id, \{ sort_order: index \+ 1 \}\)/, "拖动结果必须 PATCH sort_order 落盘");
  assert.match(source, /episodesState\.retry\(\);\s*\n\s*notify\(humanErrorMessage\(reason, "保存集顺序失败"\)/, "落盘失败要重拉回滚并报错");
});

test("T11.14b 集列表按 sort_order 排（缺省回落集号），不再硬按集号", () => {
  assert.match(source, /\(a\.sort_order \?\? a\.episode_no \?\? 0\) - \(b\.sort_order \?\? b\.episode_no \?\? 0\)/, "显示顺序 = sort_order 优先");
});

test("T11.14c 「导入剧本」在左栏剧集头，不再独占页顶一整行（R2-14）", () => {
  /* 页顶动作位行（flex shrink-0 items-center justify-end + 导入按钮）已退役 */
  assert.doesNotMatch(source, /justify-end">\s*\n\s*<Button[\s\S]{0,200}导入剧本/, "页顶独占一行的导入按钮已退役");
  const asideAt = source.indexOf("<aside");
  assert.ok(asideAt >= 0);
  const asideHead = source.slice(asideAt, asideAt + 1600);
  assert.match(asideHead, /导入剧本/, "导入按钮应在左栏剧集头");
  assert.match(asideHead, /onClick=\{openBulkImportPicker\}/, "剧集头按钮直调文件选择");
  assert.match(asideHead, /disabled=\{bulkImporting\}/, "导入中禁用");
});

/* ---- R2-15 二轮反馈（2026-08-17）：拖拽开关 / 生成按钮位置 / 原文折叠 / 小屏高度 / 资产条分组 ---- */

test("T11.15a 拖拽需先点「拖拽」开启：纯文字按钮无图标，开启后可拖且有提示（2026-08-17 用户反馈）", () => {
  assert.match(source, /const \[dragArmed, setDragArmed\] = useState\(false\)/, "拖拽开关默认关");
  assert.match(source, /setDragArmed\(!dragArmed\)/, "左栏头有开关按钮");
  assert.match(source, /\{dragArmed \? "完成" : "拖拽"\}/, "按钮纯文字：拖拽/完成，无图标");
  assert.doesNotMatch(source, /ArrowsDownUp/, "排序/拖拽按钮不带图标");
  assert.match(source, /按住某一集，拖到目标位置松开即可调整顺序/, "开启后给操作提示");
  assert.match(source, /setDragArmed\(false\);\s*\n\s*\}, \[episodeId\]\)/, "切集重置拖拽开关");
});

test("T11.15b 一键生成本集在剧本原文卡标题行（原文旁），paste/failed 不再占独立动作条", () => {
  const pasteCard = source.slice(source.indexOf("/* paste */"), source.indexOf("/** 右栏 ③"));
  assert.match(pasteCard, /一键生成本集（1 次任务）/, "粘贴卡标题行带生成按钮");
  assert.match(pasteCard, /collapseRow\(pasteNotice \? "重新粘贴剧本" : "粘贴剧本原文"\)/, "粘贴卡标题行整行可折叠");
  const bar = source.slice(source.indexOf("function renderActionBar"), source.indexOf("/** 右栏 ②"));
  assert.doesNotMatch(bar, /一键生成本集/, "动作条不再渲染粘贴态生成按钮");
  assert.match(bar, /\/\* paste \/ failed：一键生成在内容卡标题行/, "paste/failed 动作条退役有注释说明");
});

test("T11.15c 原文默认展开、整行可折叠且 caret 在行首、输入框小字限高（2026-08-17 用户反馈）", () => {
  assert.match(source, /const \[scriptDetailsOpen, setScriptDetailsOpen\] = useState\(true\)/, "原文默认展开");
  assert.match(source, /<CaretDown className=\{cn\("size-4 shrink-0 transition-transform", scriptDetailsOpen \? "rotate-180" : ""\)\} aria-hidden="true" \/>\s*\n\s*<span className="truncate text-base font-semibold text-ink-1">\{title\}<\/span>/, "caret icon 在行首、标题随后，整行是开关");
  const textareaCount = (source.match(/max-h-40/g) ?? []).length;
  assert.ok(textareaCount >= 3, `剧本原文输入框应限高 max-h-40（实际 ${textareaCount} 处）`);
  const smallFontCount = (source.match(/max-h-40 text-xs|text-xs" \/>/g) ?? []).length;
  assert.ok(smallFontCount >= 3, `剧本原文应小字 text-xs（实际 ${smallFontCount} 处）`);
});

test("T11.15d 资产引用条按类型分组横排（角色：A、B；场景：C），多时横滚不撑高", () => {
  const bar = source.slice(source.indexOf("function renderAssetRefBar"), source.indexOf("/** 右栏 ④"));
  assert.match(bar, /ASSET_KIND_LABELS/, "按 asset_kind 分组");
  assert.match(bar, /group\.names\.join\("、"\)/, "组内名称顿号横排");
  assert.match(bar, /overflow-x-auto/, "资产多时横排滚动");
  assert.doesNotMatch(bar, /flex-wrap/, "不再换行纵向撑高");
});
