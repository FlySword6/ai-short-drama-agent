/* ============================================================
   promote-asset.test.ts — W5-1 生成图一键入资产库验收断言
   纯逻辑：提示词摘要截断、kind 默认值、入口显隐（图片可转/视频不可转/
   无 url 隐藏/demo 渲染）、名称预填、文件名兜底、ingest 载荷组装。
   源码级：组件不引 CSS（node:test 可 import；视图已迁 Tailwind utility，
   旧 promote-asset.css 已随迁移删除）、图标唯一来源 @phosphor-icons/react。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_PROMOTE_KIND,
  PROMOTE_MAX_FILE_BYTES,
  PROMOTE_PROMPT_SUMMARY_MAX,
  buildPromoteIngestItem,
  defaultPromoteName,
  isImageMedia,
  promoteDefaultKind,
  promoteEntryState,
  promoteFileName,
  resolvePromoteKind,
  summarizePrompt,
} from "./components/promote-asset-modal";
import { ASSET_KIND_OPTIONS } from "./components/asset-shared";
import type { MediaResult, MediaVersion } from "./types";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const promoteModalSource = readSource("./components/promote-asset-modal.tsx");
const workbenchPageSource = readSource("./pages/workbench-page.tsx");
const versionModalSource = readSource("./components/version-modal.tsx");

function imageVersion(partial: Partial<MediaVersion> = {}): MediaVersion {
  return { id: "m1", media_kind: "image", storage_url: "https://cdn.example.com/a.jpg", ...partial };
}

/* ---------- 提示词摘要截断 ---------- */

test("summarizePrompt：压平空白为单空格，短文本原样返回", () => {
  assert.equal(summarizePrompt("  少女回眸，\n  雪落城头。\t风起 "), "少女回眸， 雪落城头。 风起");
  assert.equal(summarizePrompt(""), "");
  assert.equal(summarizePrompt("   \n\t "), "");
});

test("summarizePrompt：超长截断到上限并加省略号", () => {
  const long = "字".repeat(PROMOTE_PROMPT_SUMMARY_MAX + 50);
  const summary = summarizePrompt(long);
  assert.ok(summary.endsWith("…"));
  assert.ok(summary.length <= PROMOTE_PROMPT_SUMMARY_MAX);
  assert.equal(summarizePrompt("a".repeat(PROMOTE_PROMPT_SUMMARY_MAX)), "a".repeat(PROMOTE_PROMPT_SUMMARY_MAX));
});

/* ---------- kind 默认值 ---------- */

/* ---------- kind 默认值（S16 条 4①：创作词表全集+入口上下文预填，推翻 S10 单值收敛） ---------- */

test("类型=创作词表完整可选集（与资产中心同源 ASSET_KIND_OPTIONS）；默认关键帧；未知值回落默认", () => {
  assert.equal(DEFAULT_PROMOTE_KIND, "keyword");
  // S88b：直接断唯一真源 ASSET_KIND_OPTIONS（PROMOTE_KIND_OPTIONS 别名导出已删）
  assert.ok(ASSET_KIND_OPTIONS.length >= 13, "应为创作词表全集（13 类）");
  assert.ok(ASSET_KIND_OPTIONS.some((option) => option.value === "prop"), "道具必须可选（DC 实测只剩关键帧）");
  assert.ok(ASSET_KIND_OPTIONS.some((option) => option.value === "keyword"), "关键帧仍可选");
  assert.equal(resolvePromoteKind("prop"), "prop");
  assert.equal(resolvePromoteKind("scene"), "scene");
  assert.equal(resolvePromoteKind("keyframe"), "keyword", "别名归一到主值");
  assert.equal(resolvePromoteKind("clothing"), "costume", "别名归一到主值");
  assert.equal(resolvePromoteKind("不存在的类型"), DEFAULT_PROMOTE_KIND, "词表外值回落默认");
});

test("入口上下文预填：道具组产物默认 prop、光影组默认 lighting、无上下文回落 keyframe", () => {
  assert.equal(promoteDefaultKind(["prop"]), "prop");
  assert.equal(promoteDefaultKind(["lighting"]), "lighting");
  assert.equal(promoteDefaultKind(["character", "costume"]), "character");
  assert.equal(promoteDefaultKind(["camera"]), "camera");
  assert.equal(promoteDefaultKind([]), DEFAULT_PROMOTE_KIND);
  assert.equal(promoteDefaultKind(null), DEFAULT_PROMOTE_KIND);
  assert.equal(promoteDefaultKind(["词表外kind"]), DEFAULT_PROMOTE_KIND);
});

/* ---------- 入口显隐判定 ---------- */

test("入口显隐：图片 + storage_url → ready；无 url / 无 media → 隐藏", () => {
  assert.equal(promoteEntryState(imageVersion(), false), "ready");
  assert.equal(promoteEntryState(imageVersion({ storage_url: null }), false), "hidden");
  assert.equal(promoteEntryState(imageVersion({ storage_url: "  " }), false), "hidden");
  assert.equal(promoteEntryState(null, false), "hidden");
  assert.equal(promoteEntryState(undefined, false), "hidden");
});

test("入口显隐：视频产物不出按钮（后端 media 上传只收图片）", () => {
  assert.equal(promoteEntryState(imageVersion({ media_kind: "video" }), false), "hidden");
  assert.equal(promoteEntryState(imageVersion({ media_kind: "video" }), true), "hidden");
});

test("入口显隐：demoMode 下图片无真实 url 仍渲染（点击仅提示不写库）", () => {
  assert.equal(promoteEntryState(imageVersion({ storage_url: null }), true), "demo");
  assert.equal(promoteEntryState(imageVersion(), true), "demo");
});

test("isImageMedia：media_kind 优先；缺 kind 时按 format 图片扩展名判定", () => {
  assert.equal(isImageMedia({ media_kind: "image" }), true);
  assert.equal(isImageMedia({ media_kind: "video", format: "jpg" }), false);
  assert.equal(isImageMedia({ format: "png" }), true);
  assert.equal(isImageMedia({ format: ".JPG" }), true);
  assert.equal(isImageMedia({ format: "mp4" }), false);
  assert.equal(isImageMedia({ format: "glb" }), false);
  assert.equal(isImageMedia({}), false);
});

test("入口判定结构兼容 MediaResult（无 format 字段）", () => {
  const result: MediaResult = { id: "r1", media_kind: "image", storage_url: "https://cdn.example.com/b.jpg" };
  assert.equal(promoteEntryState(result, false), "ready");
});

/* ---------- 名称预填 / 文件名 ---------- */

test("defaultPromoteName：素材标题优先，缺省回落「素材 #N」", () => {
  assert.equal(defaultPromoteName({ title: "雪夜独行", shot_no: "3" }), "雪夜独行");
  assert.equal(defaultPromoteName({ title: "  ", shot_no: "3" }), "素材 #3");
  assert.equal(defaultPromoteName({ title: null, shot_no: "12" }), "素材 #12");
  assert.equal(defaultPromoteName(null), "素材图");
});

test("promoteFileName：空名兜底 reference.jpg，正常名去首尾空白", () => {
  assert.equal(promoteFileName("雪夜独行"), "雪夜独行.jpg");
  assert.equal(promoteFileName("  "), "reference.jpg");
  assert.equal(promoteFileName(""), "reference.jpg");
});

/* ---------- ingest 载荷组装 ---------- */

test("buildPromoteIngestItem：字段映射 + metadata 只写有值的键", () => {
  const full = buildPromoteIngestItem({
    kind: "keyframe",
    name: "雪夜独行",
    intro: "少女回眸",
    sourceUrl: "https://cdn.example.com/a.jpg",
    generationRequestId: "req-1",
    shotId: "shot-1",
  });
  assert.deepEqual(full, {
    asset_kind: "keyframe",
    name: "雪夜独行",
    intro: "少女回眸",
    source_file_url: "https://cdn.example.com/a.jpg",
    metadata: { origin: "generation_result", generation_request_id: "req-1", shot_id: "shot-1" },
  });

  const minimal = buildPromoteIngestItem({ kind: "keyframe", name: "n", intro: "", sourceUrl: "u" });
  assert.deepEqual(minimal.metadata, { origin: "generation_result" });
  assert.equal(minimal.intro, null);
});

/* ---------- 上限常量 ---------- */

test("PROMOTE_MAX_FILE_BYTES：对齐后端 10MB 上限", () => {
  assert.equal(PROMOTE_MAX_FILE_BYTES, 10 * 1024 * 1024);
});

/* ---------- 源码级：组件约定、三处接入 ---------- */

test("promote-asset-modal：组件不引 CSS（node:test 可 import），图标唯一来源 phosphor", () => {
  assert.doesNotMatch(promoteModalSource, /^import\s+"[^"]*\.css";?$/m);
  assert.doesNotMatch(promoteModalSource, /from\s+"[^"]*\.css"/);
  const iconImports = promoteModalSource.match(/from "[^"]*icon[^"]*"/gi) ?? [];
  assert.deepEqual([...new Set(iconImports)], ['from "@phosphor-icons/react"']);
});

test("三处接入共用同一弹窗组件", () => {
  for (const [name, source] of [
    ["pages/workbench-page.tsx", workbenchPageSource],
  ] as const) {
    assert.ok(source.includes('from "../components/promote-asset-modal"'), `${name} 未引入弹窗`);
    assert.ok(source.includes("<PromoteToAssetModal"), `${name} 未挂载弹窗`);
    assert.ok(source.includes("离线演示不会写入资产库"), `${name} 缺 demo 提示`);
    assert.ok(source.includes("已入资产库，下次生成可 @ 引用"), `${name} 缺成功 toast`);
  }
  assert.ok(versionModalSource.includes("promoteEntryState"), "版本弹窗未复用入口显隐判定");
  assert.ok(versionModalSource.includes("onPromoteImage"), "版本弹窗缺图片候选回调");
});

/* ============================================================
   S16 条 4（DC 实测）：类型选项错 + 状态串台 回归锁定
   ============================================================ */

test("条 4① 源码级：类型选项=词表全集（ASSET_KIND_OPTIONS），默认档随入口上下文", () => {
  assert.ok(promoteModalSource.includes("ASSET_KIND_OPTIONS"), "类型选项未接词表全集");
  assert.ok(promoteModalSource.includes("defaultKind"), "弹窗未收入口默认类型");
  assert.ok(promoteModalSource.includes("已按来源组"), "缺来源组预填提示");
  assert.ok(workbenchPageSource.includes("promoteDefaultKind(laneDef(attachTarget).kinds)"), "页面未按参考组解析默认类型");
});

test("条 4② 源码级：弹窗按 media id 重挂载；简介只取本产物提示词，不吃实时框残留", () => {
  assert.ok(workbenchPageSource.includes("key={imageMedia.id}"), "弹窗未按 media id 重挂载（切入口不重置=串台根因）");
  assert.ok(workbenchPageSource.includes("lastSubmittedPromptRef"), "缺提交时 prompt 快照");
  assert.ok(workbenchPageSource.includes("promptSummary={promotePromptSummary}"), "简介未接本产物提示词");
  assert.ok(!workbenchPageSource.includes("promptSummary={imagePrompt || shot.image_prompt"), "旧口径（实时框/分镜字段）残留=别栏串台源");
  assert.ok(workbenchPageSource.includes("capture.requestId === imageTask?.generation_request_id"), "未校验产物来自本会话任务");
});
