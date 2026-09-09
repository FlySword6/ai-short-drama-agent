/* ============================================================
   asset-center.test.ts — W5.5 资产域验收断言（Dario #3/#4/#8）+ W7 IA 四页签
   纯逻辑来自 components/asset-shared.tsx（不引 CSS，node:test 可直接 import）：
   - 统一资产类型枚举（任务 4.3，两处消费同一常量）；
   - 项目卡闭环统计完整词格式化 + 四态悬浮说明（任务 3.2）；
   - 审核四态说明文案（任务 8.2 图例/pill tooltip）；
   - 性别/年龄段/名称/Tag 客户端过滤（任务 8.4/4.4）；
   - Tag 建议下拉（bug6：collectAssetTags 去重 / applyTagSuggestion 替换编辑段 / tagSuggestionsFor 过滤上限）；
   - 卡片定位行与版本摘要（任务 8.5）；
   - 导入个人资产降级文案（任务 4.2：404/501/网络错 → Sol 侧接入中）；
   - 「更多」菜单定义与片场语缺口提示（任务 8.3）。
   源码级：两处消费统一枚举、组件不引 CSS、global 三页已迁 Tailwind（旧 p1-/aw- 类与手写 CSS 离场）、问 Pi 摘要条已撤。
   K2（N1）：横条单行三簇与 select 同源守卫、服务端 kind_counts 聚合守卫、
   词表外 kind → 未分类计数与树状分组行为、大类字面量全仓唯一扫描。
   ============================================================ */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiClientError } from "./api";
import {
  AGE_BAND_OPTIONS,
  ASSET_KIND_FETCH_VALUES,
  ASSET_KIND_GROUPS,
  ASSET_KIND_OPTIONS,
  ASSET_LIBRARY_PAGE_SIZE,
  AssetKindSelectOptions,
  DOWNLOAD_ALL_LIMIT_NOTE,
  GENDER_OPTIONS,
  IMPORT_PERSONAL_PENDING_MESSAGE,
  NO_IMAGE_MEDIA_MESSAGE,
  PROJECT_ASSET_MENU_ITEMS,
  REVIEW_BUCKET_EXPLAIN,
  REVIEW_LEGEND_BUCKETS,
  REVIEW_LEGEND_NOTE,
  SOUND_GENERATE_MESSAGE,
  SOUND_UPLOAD_MESSAGE,
  TAG_SUGGESTION_LIMIT,
  UNCATEGORIZED_KIND,
  ageBandMatches,
  applyTagSuggestion,
  assetDetailPreviewVersion,
  assetKindClusterViews,
  assetKindGroupValue,
  assetKindMatches,
  assetPositionLine,
  assetRawNameNote,
  assetTagMatches,
  assetTextMatches,
  collectAssetTags,
  countAssetsByKind,
  countRawAssetKinds,
  formatAssetCardSummary,
  formatLoopCountsLine,
  genderMatches,
  importPersonalFailureMessage,
  loopCountsTooltip,
  mergeAssetItems,
  normalizeGender,
  outOfRangePageTarget,
  pageCount,
  paginateItems,
  paginationWindow,
  primaryImageVersion,
  referencedToProjectMessage,
  summarizeAssetVersions,
  tagEditingFragment,
  tagSuggestionsFor,
  type AssetKindCategory,
} from "./components/asset-shared";
import { AssetKindTreeView, assetCenterPath, assetCenterTabFromSearch } from "./pages/global-pages";
import type { Asset, MediaVersion } from "./types";
import { assetKindLabel, assetKindRawTitle } from "./ui";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function asset(partial: Partial<Asset> & { id: string }): Asset {
  return partial;
}

function version(partial: Partial<MediaVersion> & { id: string }): MediaVersion {
  return { media_kind: "image", ...partial };
}

test("video asset thumbnail uses current media preview", () => {
  const source = readSource("./components/asset-widgets.tsx");
  assert.ok(source.includes("assetVideoPreviewMedia(asset)"), "asset thumbnail does not read video current_media");
  assert.ok(source.includes("api.assetMediaPreviewUrl"), "video preview should exchange protected API path for signed URL");
  assert.ok(source.includes("<video"), "video assets do not render a video preview element");
  assert.ok(source.includes('preload="metadata"'), "video preview should only preload metadata");
});

test("audio asset detail exchanges protected download path for playable preview URL", () => {
  const source = readSource("./components/asset-widgets.tsx");
  assert.ok(source.includes('kind="audio"'), "audio detail does not use the protected media preview flow");
  assert.ok(source.includes("isProtectedAssetMediaDownloadUrl"), "audio preview should detect protected download endpoints");
  assert.ok(source.includes("api.assetMediaPreviewUrl"), "audio preview should exchange protected API path for signed URL");
  assert.ok(source.includes("<audio"), "audio assets do not render an audio player");
});

/* ---------- 统一资产类型枚举（任务 4.3） ---------- */

test("ASSET_KIND_OPTIONS 覆盖通用资产真实存在的类型（含 animal/clothing/other/reference）", () => {
  const values = ASSET_KIND_OPTIONS.map((option) => option.value);
  for (const required of ["character", "scene", "prop", "costume", "lighting", "camera", "video", "audio", "sound", "music", "animal", "reference", "model_3d"]) {
    assert.ok(values.includes(required), `缺少类型 ${required}`);
  }
  // 历史别名并入主类型，筛选不丢资产
  const costume = ASSET_KIND_OPTIONS.find((option) => option.value === "costume");
  assert.ok(costume?.aliases.includes("clothing"), "服装缺少 clothing 别名");
  const reference = ASSET_KIND_OPTIONS.find((option) => option.value === "reference");
  assert.ok(reference?.aliases.includes("other"), "参考缺少 other 别名");
  // S88：动物是角色的子类（parent 指向 character），不再是并列大类
  const animal = ASSET_KIND_OPTIONS.find((option) => option.value === "animal");
  assert.equal(animal?.parent, "character", "动物未挂到角色下作子类");
  assert.equal(animal?.category, "entity", "动物不属于创作实体大类");
  // 值唯一、label 非空
  assert.equal(new Set(values).size, values.length);
  for (const option of ASSET_KIND_OPTIONS) assert.ok(option.label.trim(), `${option.value} 缺 label`);
});

test("assetKindMatches：主值精确命中，别名并入，空串全通过，S88 子类上卷", () => {
  assert.equal(assetKindMatches("costume", "costume"), true);
  assert.equal(assetKindMatches("clothing", "costume"), true);
  assert.equal(assetKindMatches("other", "reference"), true);
  assert.equal(assetKindMatches("keyframe", "keyword"), true);
  assert.equal(assetKindMatches("animal", "animal"), true);
  assert.equal(assetKindMatches("animal", "costume"), false);
  // S88：动物是角色的子类——选「角色」要命中老虎（上卷）；选「动物」只命中动物（不反向）
  assert.equal(assetKindMatches("animal", "character"), true);
  assert.equal(assetKindMatches("character", "animal"), false);
  assert.equal(assetKindMatches("animal", "scene"), false);
  assert.equal(assetKindMatches("audio", "audio"), true);
  assert.equal(assetKindMatches("scene", ""), true);
  assert.equal(assetKindMatches(null, ""), true);
  assert.equal(assetKindMatches(undefined, "character"), false);
  // S88b：大小写归一（后端写入只 trim 不强制小写，「Animal」不该漏筛）
  assert.equal(assetKindMatches("Animal", "animal"), true);
  assert.equal(assetKindMatches("Animal", "character"), true);
  assert.equal(assetKindMatches(" CLOTHING ", "costume"), true);
});

test("S88b：「未分类」筛选——词表外值与空白 kind 归 UNCATEGORIZED，已识别值不进", () => {
  assert.equal(assetKindMatches("scene_reference", UNCATEGORIZED_KIND), true);
  assert.equal(assetKindMatches("voice", UNCATEGORIZED_KIND), true);
  assert.equal(assetKindMatches("", UNCATEGORIZED_KIND), true);
  assert.equal(assetKindMatches(null, UNCATEGORIZED_KIND), true);
  assert.equal(assetKindMatches("creature", UNCATEGORIZED_KIND), true);
  assert.equal(assetKindMatches("animal", UNCATEGORIZED_KIND), false);
  assert.equal(assetKindMatches("clothing", UNCATEGORIZED_KIND), false);
  assert.equal(assetKindMatches("Animal", UNCATEGORIZED_KIND), false);
});

/* ---------- S88 分类学：三分大类 + 动物归角色子类（DC 判决） ---------- */

test("ASSET_KIND_GROUPS：三分大类成员与 parent 正确，分组是 OPTIONS 的划分", () => {
  // S88b：组级显示顺序是展示细节，不锁死——类别集合相等 + 无重复即可
  assert.equal(ASSET_KIND_GROUPS.length, 3);
  assert.deepEqual(
    new Set(ASSET_KIND_GROUPS.map((group) => group.category)),
    new Set(["entity", "reference", "artifact"]),
  );
  assert.deepEqual(
    new Set(ASSET_KIND_GROUPS.map((group) => group.label)),
    new Set(["创作实体", "参考素材", "产物形态"]),
  );
  // 组成员资格仍按类精确断言
  const entity = ASSET_KIND_GROUPS.find((group) => group.category === "entity");
  const reference = ASSET_KIND_GROUPS.find((group) => group.category === "reference");
  const artifact = ASSET_KIND_GROUPS.find((group) => group.category === "artifact");
  assert.ok(entity && reference && artifact);
  assert.deepEqual(entity?.options.map((option) => option.value), ["character", "animal", "scene", "prop", "costume"]);
  assert.deepEqual(reference?.options.map((option) => option.value), ["lighting", "camera", "video", "audio", "sound", "music", "reference"]);
  assert.deepEqual(artifact?.options.map((option) => option.value), ["keyword", "model_3d"]);
  // 并集 = 全集且不重不漏（新增类型漏挂大类会在这里现形）
  assert.deepEqual(
    ASSET_KIND_GROUPS.flatMap((group) => group.options.map((option) => option.value)),
    ASSET_KIND_OPTIONS.map((option) => option.value),
  );
});

test("assetKindGroupValue：唯一归属——别名归主值、animal 归自己、未映射值诚实落空", () => {
  assert.equal(assetKindGroupValue("animal"), "animal");
  assert.equal(assetKindGroupValue("character"), "character");
  assert.equal(assetKindGroupValue("clothing"), "costume");
  assert.equal(assetKindGroupValue("keyframe"), "keyword");
  assert.equal(assetKindGroupValue("other"), "reference");
  assert.equal(assetKindGroupValue("audio"), "audio");
  // voice 不是音频入库新口径；后端新增音频资产写 audio，不把旧脏值硬塞进任何组。
  assert.equal(assetKindGroupValue("voice"), null);
  assert.equal(assetKindGroupValue(""), null);
  assert.equal(assetKindGroupValue(null), null);
  // S88b：大小写归一（「Animal」归 animal 组，不落未分类）
  assert.equal(assetKindGroupValue("Animal"), "animal");
  assert.equal(assetKindGroupValue(" Costume"), "costume");
  assert.equal(assetKindGroupValue("scene_reference"), null);
});

test("assetKindLabel：动物展示「角色·动物」（DC 判决），旧值标签不变", () => {
  assert.equal(assetKindLabel("animal"), "角色·动物");
  assert.equal(assetKindLabel("character"), "角色");
  assert.equal(assetKindLabel("clothing"), "服装");
  assert.equal(assetKindLabel("other"), "参考");
  assert.equal(assetKindLabel("model_3d"), "3D 素模");
  assert.equal(assetKindLabel("audio"), "音频");
  // S88b：诚实兜底——未识别值与空白串展示「未分类」不裸显原值；null/undefined 仍是「资产」；
  // 大小写归一（「Animal」也拿到中文标签）
  assert.equal(assetKindLabel("creature"), "未分类");
  assert.equal(assetKindLabel("scene_reference"), "未分类");
  assert.equal(assetKindLabel(""), "未分类");
  assert.equal(assetKindLabel("  "), "未分类");
  assert.equal(assetKindLabel(null), "资产");
  assert.equal(assetKindLabel(undefined), "资产");
  assert.equal(assetKindLabel("Animal"), "角色·动物");
});

test("assetKindRawTitle：未识别值给原值悬浮说明，已识别/空白/缺省各自口径", () => {
  assert.equal(assetKindRawTitle("creature"), "creature");
  assert.equal(assetKindRawTitle(" scene_reference "), "scene_reference");
  assert.equal(assetKindRawTitle(""), "（空白）");
  assert.equal(assetKindRawTitle("  "), "（空白）");
  assert.equal(assetKindRawTitle("animal"), undefined);
  assert.equal(assetKindRawTitle("audio"), undefined);
  assert.equal(assetKindRawTitle("Animal"), undefined);
  assert.equal(assetKindRawTitle(null), undefined);
  assert.equal(assetKindRawTitle(undefined), undefined);
});

test("AssetKindSelectOptions 真渲染：三个 optgroup，动物在「创作实体」组紧随角色，选项值齐全", () => {
  const html = renderToStaticMarkup(React.createElement("select", null, React.createElement(AssetKindSelectOptions)));
  // S88b：组级渲染顺序不锁死——类别集合相等即可；组内顺序（动物紧随角色）仍精确断言
  const groupLabels = [...html.matchAll(/<optgroup[^>]*label="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(groupLabels.length, 3);
  assert.deepEqual(new Set(groupLabels), new Set(["创作实体", "参考素材", "产物形态"]));
  const entityMatch = html.match(/<optgroup[^>]*label="创作实体"[\s\S]*?<\/optgroup>/);
  assert.ok(entityMatch, "缺少「创作实体」optgroup");
  const entityBlock = entityMatch[0];
  assert.ok(entityBlock.includes('value="animal"'), "动物不在创作实体组");
  assert.ok(entityBlock.includes("角色·动物"), "动物选项未展示归类路径");
  assert.ok(entityBlock.indexOf('value="character"') < entityBlock.indexOf('value="animal"'), "动物应紧随角色之后");
  const values = [...html.matchAll(/<option[^>]*value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ASSET_KIND_OPTIONS.map((option) => option.value));
});

test("S88b：全站类型选择器禁硬编码平铺——src 全目录扫描（不再是白名单抽查）", () => {
  // R2 整改：旧版只抽查 3 个白名单文件，asset-pick-drawer / material-agent-page
  // 两处硬编码平铺漏网。改为递归扫描 src 下全部 .tsx（测试文件除外）：
  // (a) 任何文件出现硬编码类型 option 直接红；(b) 硬编码类型元组表直接红；
  // (c) 已知选择器消费点必须真消费 AssetKindSelectOptions（防整段删选择器骗过扫描）。
  const srcRoot = fileURLToPath(new URL(".", import.meta.url));
  const collectTsx = (dir: string): Array<string> =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return collectTsx(full);
      return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [full] : [];
    });
  const tsxFiles = collectTsx(srcRoot);
  assert.ok(tsxFiles.length > 20, `目录扫描覆盖异常（仅 ${tsxFiles.length} 个 .tsx）`);
  const FLAT_KIND_OPTION = /<option\s+value="(?:character|scene|prop|costume|lighting|animal)"[\s>]/;
  const KIND_TUPLE_TABLE = /\[\s*"character",\s*"角色"\s*\]/;
  for (const file of tsxFiles) {
    const rel = file.slice(srcRoot.length);
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, FLAT_KIND_OPTION, `${rel} 存在硬编码平铺类型 option，应消费 AssetKindSelectOptions`);
    assert.doesNotMatch(source, KIND_TUPLE_TABLE, `${rel} 存在硬编码类型元组表，应消费 AssetKindSelectOptions`);
  }
  const KNOWN_SELECT_CONSUMERS = [
    "./pages/global-pages.tsx",
    "./pages/project-pages.tsx",
    "./components/promote-asset-modal.tsx",
    "./components/asset-pick-drawer.tsx",
    "./pages/material-agent-page.tsx",
  ];
  for (const path of KNOWN_SELECT_CONSUMERS) {
    assert.ok(readSource(path).includes("AssetKindSelectOptions"), `${path} 未消费统一分组选择器`);
  }
});

test("S46 C-1：生成弹窗两名字段标注——名称与展示名不同才标注，相同/为空不标注", () => {
  // walkthrough P2-5①实拍的矛盾对：卡片展示名 vs 弹窗标题里的 name
  assert.equal(assetRawNameNote({ name: "中年男性球迷", display_name: "穿巴西队球衣的中年男子" }), "中年男性球迷");
  assert.equal(assetRawNameNote({ name: "任天野", display_name: "任天野" }), "");
  assert.equal(assetRawNameNote({ name: "任天野", display_name: "任天野·定妆" }), "任天野");
  assert.equal(assetRawNameNote({ name: "  ", display_name: "北疆战场" }), "");
  assert.equal(assetRawNameNote({ name: null, display_name: "北疆战场" }), "");
});

test("任务 4.3：资产中心与引入抽屉消费同一份 ASSET_KIND_OPTIONS", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  const projectPages = readSource("./pages/project-pages.tsx");
  for (const [name, source] of [["global-pages.tsx", globalPages], ["project-pages.tsx", projectPages]] as const) {
    assert.ok(source.includes("ASSET_KIND_OPTIONS"), `${name} 未消费统一类型枚举`);
    assert.ok(source.includes("assetKindMatches"), `${name} 未走统一类型匹配`);
  }
  // 不允许回退到硬编码类型 option（旧写法一处有一处没有）
  assert.doesNotMatch(projectPages, /<option value="costume">服装<\/option>/);
  assert.doesNotMatch(globalPages, /<option value="costume">服装<\/option>/);
});

/* ---------- 项目卡闭环统计（任务 3.2） ---------- */

test("formatLoopCountsLine：完整词四态，不再用单字黑话", () => {
  assert.equal(formatLoopCountsLine({ auto: 12, pending: 4, approved: 40, rejected: 3 }), "自动 12 · 待审 4 · 通过 40 · 拒绝 3");
  assert.equal(formatLoopCountsLine({ auto: 0, pending: 0, approved: 0, rejected: 0 }), "自动 0 · 待审 0 · 通过 0 · 拒绝 0");
});

test("loopCountsTooltip：每组都解释四态含义（自动=新产物默认自动通过无需人审）", () => {
  const tooltip = loopCountsTooltip("图片");
  assert.match(tooltip, /^图片/);
  assert.match(tooltip, /自动：新产物默认自动通过，无需人审/);
  assert.match(tooltip, /待审：/);
  assert.match(tooltip, /通过：/);
  assert.match(tooltip, /拒绝：/);
});

test("任务 3.1/3.2 源码级：问 Pi 摘要条已撤；产物审核四态统计随死字段摘除（架构 P3 拍板）", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  assert.ok(!globalPages.includes('className="p1-pi"'), "内联问 Pi 摘要条仍在");
  assert.ok(!globalPages.includes("askPi"), "问 Pi 交互函数仍在");
  // media_results.review_status 死字段拍板先摘：项目卡不再渲染四态统计行
  assert.ok(!globalPages.includes("loopCountsTooltip"), "四态统计行未随死字段摘除");
  assert.ok(!globalPages.includes("LoopCounts"), "闭环四态类型仍被引用");
  // Tailwind 迁移后：global-pages 不再引用 p1-/aw- 旧类，也不再 import 手写 CSS
  assert.ok(!/["\s`]p1-/.test(globalPages), "global-pages.tsx 仍引用 p1- 旧类");
  assert.ok(!/["\s`]aw-/.test(globalPages), "global-pages.tsx 仍引用 aw- 旧类");
  assert.ok(!globalPages.includes(".css"), "global-pages.tsx 仍 import 手写 CSS");
});

/* ---------- 审核四态说明（任务 8.2 图例/pill tooltip） ---------- */

test("REVIEW_BUCKET_EXPLAIN：四态齐全且人话", () => {
  assert.deepEqual([...REVIEW_LEGEND_BUCKETS], ["auto", "pending", "approved", "rejected"]);
  assert.match(REVIEW_BUCKET_EXPLAIN.auto, /自动.*无需人审/);
  assert.match(REVIEW_BUCKET_EXPLAIN.pending, /等待审核人/);
  assert.match(REVIEW_BUCKET_EXPLAIN.approved, /通过终审|已通过终审/);
  assert.match(REVIEW_BUCKET_EXPLAIN.rejected, /打回/);
  assert.equal(REVIEW_LEGEND_NOTE, "待审核悬停看审核人；已拒绝悬停看拒绝理由");
});

/* ---------- 性别 / 年龄段过滤（任务 8.4） ---------- */

test("normalizeGender：中英文历史数据归一", () => {
  assert.equal(normalizeGender("male"), "male");
  assert.equal(normalizeGender("男"), "male");
  assert.equal(normalizeGender(" Female "), "female");
  assert.equal(normalizeGender("女"), "female");
  assert.equal(normalizeGender(""), "");
  assert.equal(normalizeGender(null), "");
});

test("genderMatches：空串全过；未填性别不命中已选性别（诚实过滤）", () => {
  assert.equal(genderMatches("男", "male"), true);
  assert.equal(genderMatches("female", "female"), true);
  assert.equal(genderMatches(null, ""), true);
  assert.equal(genderMatches(undefined, "male"), false);
  assert.equal(genderMatches("男", "female"), false);
  assert.ok(GENDER_OPTIONS.length >= 2);
});

test("ageBandMatches：分段边界正确，未填年龄不命中", () => {
  assert.equal(ageBandMatches(10, "child"), true);
  assert.equal(ageBandMatches(13, "teen"), true);
  assert.equal(ageBandMatches(26, "youth"), true);
  assert.equal(ageBandMatches(18, "youth"), true);
  assert.equal(ageBandMatches(35, "youth"), true);
  assert.equal(ageBandMatches(36, "middle"), true);
  assert.equal(ageBandMatches(60, "senior"), true);
  assert.equal(ageBandMatches(26, "child"), false);
  assert.equal(ageBandMatches(null, "youth"), false);
  assert.equal(ageBandMatches(undefined, ""), true);
  assert.equal(ageBandMatches(26, "no-such-band"), false);
  // 分段不重叠且全覆盖 0..200
  for (const band of AGE_BAND_OPTIONS) assert.ok(band.min <= band.max, `${band.value} 区间非法`);
});

test("assetTextMatches / assetTagMatches：名称描述命中、Tag 片段与多 tag 同时命中", () => {
  const target = asset({ id: "a1", name: "任天野", display_name: "任天野", intro: "钦差官服，主角视觉锚点", style_tags: ["青年", "人族"] });
  assert.equal(assetTextMatches(target, "钦差"), true);
  assert.equal(assetTextMatches(target, "天野"), true);
  assert.equal(assetTextMatches(target, "不存在"), false);
  assert.equal(assetTextMatches(target, "  "), true);
  assert.equal(assetTagMatches(target, "青年"), true);
  assert.equal(assetTagMatches(target, "青"), true);
  assert.equal(assetTagMatches(target, "青年,人族"), true);
  assert.equal(assetTagMatches(target, "青年，古装"), false);
  assert.equal(assetTagMatches(target, ""), true);
});

/* ---------- Tag 建议下拉（bug6：「输入/选择 Tag」的「选择」补齐） ---------- */

test("collectAssetTags：去重（大小写不敏感保留首见写法）、去空白、中文排序", () => {
  const tags = collectAssetTags([
    asset({ id: "a1", style_tags: ["青年", "人族", " 古装 ", ""] }),
    asset({ id: "a2", style_tags: ["青年", "夜戏"] }),
    asset({ id: "a3", style_tags: ["人族"] }),
    asset({ id: "a4" }),
  ]);
  assert.equal(new Set(tags.map((tag) => tag.toLowerCase())).size, tags.length, "去重后不应有大小写重复");
  for (const required of ["青年", "人族", "古装", "夜戏"]) assert.ok(tags.includes(required), `缺 ${required}`);
  assert.ok(!tags.includes(""), "空 tag 应被剔除");
  assert.deepEqual([...tags].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")), tags, "应按中文排序");
  assert.deepEqual(collectAssetTags([]), []);
});

test("tagEditingFragment：当前编辑段 = 最后一个中/英文逗号后的片段", () => {
  assert.equal(tagEditingFragment("青年，青"), "青");
  assert.equal(tagEditingFragment("青年,青"), "青");
  assert.equal(tagEditingFragment("青"), "青");
  assert.equal(tagEditingFragment("青年,"), "");
  assert.equal(tagEditingFragment(""), "");
  assert.equal(tagEditingFragment("青年， 青 "), "青");
});

test("applyTagSuggestion：替换编辑段，已确认段原样保留", () => {
  assert.equal(applyTagSuggestion("青", "青年"), "青年");
  assert.equal(applyTagSuggestion("古装，青", "青年"), "古装,青年");
  assert.equal(applyTagSuggestion("古装, 夜，青", "青年"), "古装,夜,青年");
  assert.equal(applyTagSuggestion("", "青年"), "青年");
  assert.equal(applyTagSuggestion("古装，", "青年"), "古装,青年");
});

test("tagSuggestionsFor：片段大小写不敏感、排除已确认 tag、上限 8", () => {
  const tags = ["青年", "青少年", "人族", "古装", "夜戏", "外景", "冷色", "特写", "镜头", "运动"];
  // 空编辑段给全量前 8 条
  assert.equal(TAG_SUGGESTION_LIMIT, 8);
  assert.equal(tagSuggestionsFor(tags, "").length, 8);
  // 片段匹配（中英文逗号口径一致）
  assert.deepEqual(tagSuggestionsFor(tags, "青"), ["青年", "青少年"]);
  assert.deepEqual(tagSuggestionsFor(tags, "青年，青"), ["青少年"], "已确认的「青年」不再建议");
  assert.deepEqual(tagSuggestionsFor(tags, "古装,青"), ["青年", "青少年"]);
  // 大小写不敏感
  assert.deepEqual(tagSuggestionsFor(["Qing"], "qing"), ["Qing"]);
  // 无命中回空
  assert.deepEqual(tagSuggestionsFor(tags, "不存在"), []);
  // 自定义上限
  assert.equal(tagSuggestionsFor(tags, "", 3).length, 3);
});

test("bug6 源码级：两处 Tag 筛选都挂 TagFilterInput，建议源取未过滤全量", () => {
  const projectPages = readSource("./pages/project-pages.tsx");
  const globalPages = readSource("./pages/global-pages.tsx");
  for (const [name, source] of [["project-pages.tsx", projectPages], ["global-pages.tsx", globalPages]] as const) {
    assert.ok(source.includes("<TagFilterInput"), `${name} 未挂 TagFilterInput`);
    assert.ok(source.includes('placeholder="输入/选择 Tag"'), `${name} placeholder 漂移`);
    assert.ok(source.includes('ariaLabel="Tag 筛选"'), `${name} aria-label 漂移`);
    assert.ok(source.includes("collectAssetTags"), `${name} 未消费全量 tag 收集`);
    assert.ok(source.includes("tagSuggestionsFor"), `${name} 未消费建议过滤`);
  }
  // 建议源纪律：项目页取未过滤 assets，资产中心取 data?.items 全量（不是筛过的 filtered/visibleAssets）
  assert.ok(projectPages.includes("collectAssetTags(assets)"), "项目页建议源应取未过滤 assets");
  assert.ok(globalPages.includes("collectAssetTags(data?.items ?? [])"), "资产中心建议源应取 data?.items 全量");
});

test("bug6 源码级：TagFilterInput 是完整 combobox（展开态/listbox/option/键盘与外部关闭）", () => {
  const source = readSource("./components/asset-widgets.tsx");
  assert.ok(source.includes('role="combobox"'), "缺 combobox 角色");
  assert.ok(source.includes("aria-expanded"), "缺展开态");
  assert.ok(source.includes('role="listbox"'), "缺 listbox");
  assert.ok(source.includes('role="option"'), "缺 option");
  assert.ok(source.includes("applyTagSuggestion"), "选中未走编辑段替换");
  for (const key of ['"ArrowDown"', '"ArrowUp"', '"Enter"', '"Escape"', '"pointerdown"']) {
    assert.ok(source.includes(key), `缺 ${key} 处理`);
  }
});

/* ---------- 卡片定位行与版本摘要（任务 8.5） ---------- */

test("assetPositionLine：定位 / 年龄 / 标签 组合，全缺返回空串", () => {
  assert.equal(
    assetPositionLine(asset({ id: "a1", metadata: { category: "男主" }, age_value: 26, style_tags: ["男主", "江湖侠客"] })),
    "男主 / 26岁 / 江湖侠客",
  );
  assert.equal(assetPositionLine(asset({ id: "a2", style_tags: ["夜戏", "外景"] })), "夜戏 / 外景");
  assert.equal(assetPositionLine(asset({ id: "a3" })), "");
  // category 与首个标签重复时不重复出现
  assert.equal(assetPositionLine(asset({ id: "a4", age_value: 41, style_tags: ["配角", "镖局"] })), "配角 / 41岁 / 镖局");
});

test("summarizeAssetVersions：张图/变体/待审核三计数", () => {
  const versions = [
    version({ id: "v1", is_primary: true, status: "ready" }),
    version({ id: "v2", status: "ready" }),
    version({ id: "v3", asset_variant_id: "var-1", status: "draft" }),
    version({ id: "v4", asset_variant_id: "var-1", status: "pending_review" }),
    version({ id: "v5", asset_variant_id: "var-2", status: "ready" }),
    version({ id: "v6", media_kind: "video", status: "ready" }),
  ];
  assert.deepEqual(summarizeAssetVersions(versions), { images: 5, variants: 3, pending: 2 });
  assert.deepEqual(summarizeAssetVersions([]), { images: 0, variants: 0, pending: 0 });
});

test("formatAssetCardSummary：「6 张图 · 3 个变体 · 1 待审核」", () => {
  assert.equal(formatAssetCardSummary({ images: 6, variants: 3, pending: 1 }), "6 张图 · 3 个变体 · 1 待审核");
  assert.equal(formatAssetCardSummary({ images: 0, variants: 0, pending: 0 }), "0 张图 · 0 个变体 · 0 待审核");
});

/* ---------- 导入个人资产降级（任务 4.2） ---------- */

test("importPersonalFailureMessage：404/501/网络错 → 人话降级（S17 用户语言），不假装成功", () => {
  for (const status of [404, 501, 0]) {
    assert.equal(importPersonalFailureMessage(new ApiClientError("unused", { status })), IMPORT_PERSONAL_PENDING_MESSAGE);
  }
  assert.match(IMPORT_PERSONAL_PENDING_MESSAGE, /暂不可用/);
  assert.ok(!IMPORT_PERSONAL_PENDING_MESSAGE.includes("Sol"), "不得含开发词");
  // 真失败透传服务端中文原文（400 等业务错误要看得见）；英文技术串不再裸显（业务语言化 #18）
  assert.equal(importPersonalFailureMessage(new ApiClientError("资产已在个人库", { status: 400 })), "资产已在个人库");
  assert.equal(importPersonalFailureMessage(new Error("boom")), "导入失败，请重试");
  assert.equal(importPersonalFailureMessage("str"), "导入失败，请重试");
});

test("referencedToProjectMessage：项目名补书名号，已有《》不重复", () => {
  assert.equal(referencedToProjectMessage("杀穿女频"), "已引用到《杀穿女频》");
  assert.equal(referencedToProjectMessage("《杀穿女频》"), "已引用到《杀穿女频》");
});

test("primaryImageVersion：主图优先，无图片版本返回 null（3D/声效场景）", () => {
  const versions = [version({ id: "v1" }), version({ id: "v2", is_primary: true })];
  assert.equal(primaryImageVersion(versions)?.id, "v2");
  assert.equal(primaryImageVersion([version({ id: "v3", media_kind: "video" })]), null);
  assert.equal(primaryImageVersion([]), null);
  assert.match(NO_IMAGE_MEDIA_MESSAGE, /暂无可引用图片版本/);
});

test("资产详情缩略图：点击版本后主预览跟随，不存在的版本回到资产主图", () => {
  const versions = [
    version({ id: "v1", storage_url: "https://example.com/one.png" }),
    version({ id: "v2", storage_url: "https://example.com/two.png" }),
  ];
  assert.equal(assetDetailPreviewVersion(versions, "v2")?.storage_url, "https://example.com/two.png");
  assert.equal(assetDetailPreviewVersion(versions, ""), null);
  assert.equal(assetDetailPreviewVersion(versions, "removed"), null);

  const source = readSource("./components/asset-widgets.tsx");
  assert.ok(source.includes("setPreviewVersionId(version.id)"), "缩略图点击未更新主预览选择");
  assert.ok(source.includes("aria-pressed={previewVersionId === version.id}"), "缩略图缺选中态");
  assert.ok(source.includes("<AssetDetailPreview version={previewVersion} asset={asset} />"), "主图仍未消费所选媒体版本");
  assert.ok(source.includes('role="list" aria-label="媒体版本列表"'), "媒体版本列表缺分组语义");

  const pageSource = readSource("./pages/global-pages.tsx");
  assert.ok(pageSource.includes("key={detailAsset.id}"), "切换资产时详情弹窗未按资产重建，可能残留上一资产媒体");
});

/* ---------- 「更多」菜单（任务 8.3） ---------- */

test("PROJECT_ASSET_MENU_ITEMS：06 稿 11 项齐全有序，创建类带 kind 预填", () => {
  const labels = PROJECT_ASSET_MENU_ITEMS.map((item) => item.label);
  assert.deepEqual(labels, [
    "创建角色", "创建场景", "创建道具", "创建服装", "创建光线参考", "创建摄影参考", "创建视频参考",
    "生成声效参考", "上传声效参考", "刷新", "一键下载图片",
  ]);
  const createKinds = PROJECT_ASSET_MENU_ITEMS.filter((item) => item.action === "create").map((item) => item.kind);
  assert.deepEqual(createKinds, ["character", "scene", "prop", "costume", "lighting", "camera", "video"]);
  assert.equal(new Set(PROJECT_ASSET_MENU_ITEMS.map((item) => item.id)).size, PROJECT_ASSET_MENU_ITEMS.length);
});

test("声效缺口提示：白话版本语，禁「敬请期待」", () => {
  for (const message of [SOUND_GENERATE_MESSAGE, SOUND_UPLOAD_MESSAGE]) {
    assert.match(message, /预计 v0\.1\.2 上线/);
    assert.ok(!message.includes("敬请期待"), "不允许「敬请期待」");
    assert.ok(!message.includes("拍摄中"), "不允许片场档期语");
  }
  assert.match(DOWNLOAD_ALL_LIMIT_NOTE, /浏览器/);
});

/* ---------- 源码级：组件不引 CSS、样式走 tokens、图标唯一来源 ---------- */

test("asset-widgets.tsx：组件不直接引 CSS，图标只用 @phosphor-icons/react", () => {
  const source = readSource("./components/asset-widgets.tsx");
  assert.doesNotMatch(source, /^import\s+"[^"]*\.css";?$/m);
  assert.doesNotMatch(source, /from\s+"[^"]*\.css"/);
  const iconImports = source.match(/from "[^"]*icon[^"]*"/gi) ?? [];
  assert.deepEqual([...new Set(iconImports)], ['from "@phosphor-icons/react"']);
});

test("迁移完成：projects-home.css / asset-widgets.css / asset-domain.css 已删除", () => {
  // global 与 project 资产页均已迁 Tailwind utility，三份旧手写样式必须离场（防回潮）
  for (const path of ["./pages/projects-home.css", "./components/asset-widgets.css", "./pages/asset-domain.css"]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} 应已随 Tailwind 迁移删除`);
  }
});

test("任务 8.2/8.3 源码级：项目资产页有图例行、更多菜单、页签计数", () => {
  const source = readSource("./pages/project-pages.tsx");
  assert.ok(source.includes("<ReviewLegendHelp />"), "审核状态说明未收进「?」帮助浮层");
  assert.ok(source.includes("PROJECT_ASSET_MENU_ITEMS"), "缺更多菜单");
  assert.ok(source.includes("kindCounts"), "缺类型页签计数");
  assert.ok(source.includes("p2-position-line"), "缺卡片定位行");
  assert.ok(source.includes("formatAssetCardSummary"), "缺卡片版本摘要");
  assert.ok(source.includes('navigate("/trash?kind=asset")'), "回收站入口缺失");
});

/* ---------- W7 IA：资产中心三页签（素材入库 + 实验室并入；语义检索撤并） ---------- */

test("assetCenterTabFromSearch：?tab= 解析三页签，缺省/未知/旧 search 深链回资产库", () => {
  assert.equal(assetCenterTabFromSearch(""), "library");
  assert.equal(assetCenterTabFromSearch("?scope=personal"), "library");
  assert.equal(assetCenterTabFromSearch("?tab=ingest"), "ingest");
  // 「语义检索」独立页签已撤（与资产库查询栏重复）：旧深链 ?tab=search 落回资产库
  assert.equal(assetCenterTabFromSearch("?tab=search"), "library");
  assert.equal(assetCenterTabFromSearch("?tab=reference-tests"), "reference-tests");
  // 旧路由 301 深链别名：/projects/:id/reference-tests → /assets?tab=tests&project=:id
  assert.equal(assetCenterTabFromSearch("?tab=tests&project=p1"), "reference-tests");
  assert.equal(assetCenterTabFromSearch("?tab=material-agent"), "library");
  assert.equal(assetCenterTabFromSearch("?tab="), "library");
});

test("assetCenterPath：深链保留 scope 与 project，默认页签省略 tab 参数", () => {
  assert.equal(assetCenterPath("library", "personal"), "/assets?scope=personal");
  assert.equal(assetCenterPath("library", "common"), "/assets?scope=common");
  assert.equal(assetCenterPath("ingest", "personal"), "/assets?scope=personal&tab=ingest");
  assert.equal(assetCenterPath("reference-tests", "common"), "/assets?scope=common&tab=reference-tests");
  assert.equal(assetCenterPath("reference-tests", "personal", "demo-project-2"), "/assets?scope=personal&tab=reference-tests&project=demo-project-2");
  assert.equal(assetCenterPath("ingest", "personal", ""), "/assets?scope=personal&tab=ingest");
});

test("W7 IA 源码级：三页签懒挂载+常驻互斥，语义检索撤并、诊断卡迁实验室", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  const materialAgent = readSource("./pages/material-agent-page.tsx");
  const referenceTests = readSource("./pages/reference-tests-page.tsx");
  const twCss = readSource("./tw.css");
  // 三页签（S4 改名）：检索 / 入库 / 实验室；语义检索独立页签已撤（查询能力在检索页查询栏）
  assert.ok(globalPages.includes('"检索"'), "缺检索页签");
  assert.ok(globalPages.includes('"入库"'), "缺入库页签");
  assert.ok(globalPages.includes('"实验室"'), "缺实验室页签");
  assert.ok(!globalPages.includes('"资产入库"'), "旧页签名「资产入库」仍在");
  assert.ok(globalPages.includes("MaterialIngestPanel"), "缺素材入库面板");
  assert.ok(globalPages.includes("ReferenceTestsPage"), "缺实验室内嵌");
  assert.ok(!globalPages.includes("MaterialSearchPanel"), "语义检索面板仍在资产中心（与资产库查询栏重复）");
  assert.ok(globalPages.includes("uploadVideoAsset"), "资产库上传弹窗未接视频上传 API");
  assert.ok(materialAgent.includes("uploadVideoAsset"), "素材入库面板未接视频上传 API");
  assert.ok(materialAgent.includes("ASSET_UPLOAD_FILE_ACCEPT"), "素材入库文件选择未消费统一上传格式");
  // 页签常驻内存但非激活必须视觉隐藏（forceMount + tw.css inactive 规则兜底）
  assert.ok(globalPages.includes("forceMount"), "页签未保持挂载");
  assert.ok(globalPages.includes("TabsContent"), "未用 TabsContent 承载页签");
  assert.ok(twCss.includes('[role="tabpanel"][data-state="inactive"]'), "tw.css 缺页签非激活隐藏规则");
  // 后端状态卡组件化并带自探测变体；实验室页底挂自探测卡
  assert.ok(materialAgent.includes("BackendStatusCard"), "后端状态卡未组件化");
  assert.ok(materialAgent.includes("VectorStatusProbe"), "缺自探测状态卡");
  assert.ok(materialAgent.includes("PiIntroCard"), "Pi 说明卡未组件化");
  assert.ok(referenceTests.includes("VectorStatusProbe"), "实验室页底未挂状态自探测卡");
});

/* ---------- W8：资产库全量拉取（500 上限绕行）与分页 ---------- */

test("ASSET_KIND_FETCH_VALUES：主值+别名全覆盖且无重复（分拉合并的全量口径）", () => {
  const expected = ASSET_KIND_OPTIONS.flatMap((option) => [option.value, ...option.aliases]);
  assert.deepEqual([...ASSET_KIND_FETCH_VALUES], [...new Set(expected)]);
  // 别名历史值独立成行，只拉主值会漏：clothing/keyframe/other 必须在清单里
  assert.ok(ASSET_KIND_FETCH_VALUES.includes("clothing"));
  assert.ok(ASSET_KIND_FETCH_VALUES.includes("other"));
  assert.equal(ASSET_KIND_FETCH_VALUES.length, new Set(ASSET_KIND_FETCH_VALUES).size);
});

test("mergeAssetItems：按 id 去重并保留首次出现顺序，不定义产品排序", () => {
  const older = asset({ id: "a", name: "旧", updated_at: "2026-07-01T00:00:00Z" });
  const newer = asset({ id: "b", name: "B", updated_at: "2026-07-20T00:00:00Z" });
  const sameTime = asset({ id: "c", name: "A", updated_at: "2026-07-20T00:00:00Z" });
  const dup = asset({ id: "b", name: "B（重复拉取）", updated_at: "2026-07-20T00:00:00Z" });
  const merged = mergeAssetItems([[older, newer], [dup, sameTime]]);
  assert.deepEqual(merged.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(merged.find((item) => item.id === "b")?.name, "B", "重复 id 保留先见版本");
});

test("pageCount / paginateItems：页数与切片，空列表一页", () => {
  assert.equal(ASSET_LIBRARY_PAGE_SIZE, 24);
  assert.equal(pageCount(0), 1);
  assert.equal(pageCount(24), 1);
  assert.equal(pageCount(25), 2);
  assert.equal(pageCount(779), 33);
  const items = Array.from({ length: 50 }, (_, index) => index + 1);
  assert.deepEqual(paginateItems(items, 1).length, 24);
  assert.deepEqual(paginateItems(items, 3), [49, 50]);
  assert.deepEqual(paginateItems(items, 2)[0], 25);
});

test("筛选后 URL 页码越界：按 filteredTotal 返回末页并触发重新请求", () => {
  assert.equal(outOfRangePageTarget(9, 240), null, "基础总数足够时第 9 页有效");
  assert.equal(outOfRangePageTarget(9, 2), 1, "筛选只剩 2 项时必须回第 1 页");
  assert.equal(outOfRangePageTarget(2, 25), null);
  assert.equal(outOfRangePageTarget(3, 25), 2);

  const globalPages = readSource("./pages/global-pages.tsx");
  assert.match(globalPages, /setBrowse\(\{ page: browsePageRedirect \}\)/);
  assert.match(globalPages, /loading \|\| correctingBrowsePage/);
});

test("paginationWindow：≤7 页全展示，否则首尾锚定+当前页邻格", () => {
  assert.deepEqual(paginationWindow(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(paginationWindow(1, 33), [1, 2, "…", 33]);
  assert.deepEqual(paginationWindow(33, 33), [1, "…", 32, 33]);
  assert.deepEqual(paginationWindow(17, 33), [1, "…", 16, 17, 18, "…", 33]);
  assert.deepEqual(paginationWindow(2, 33), [1, 2, 3, "…", 33]);
});

test("资产中心源码级：浏览只发一条 24 件分页请求，上传类型提示与筛选解耦", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  assert.ok(globalPages.includes("fetchScopeAssets"), "缺资产分页读取");
  assert.ok(globalPages.includes("pageSize: ASSET_LIBRARY_PAGE_SIZE"), "资产浏览未显式限制为一页 24 件");
  assert.ok(!globalPages.includes("ASSET_KIND_FETCH_VALUES.map((kind) => api.assets"), "仍在按类型扇出多路请求");
  assert.ok(globalPages.includes("countRawAssetKinds(data.kindCounts)"), "类型计数未消费服务端全库聚合");
  assert.ok(globalPages.includes("ListPager"), "分页器未接入");
  assert.ok(globalPages.includes('ariaLabel="资产分页"'), "分页器缺可访问名");
  assert.ok(globalPages.includes("uploadKindHint"), "上传类型提示未与列表筛选解耦");
  // 筛选表单里的类型下拉已撤（类型筛选由带计数的 pill 行承担，不再两层重复控件）
  assert.ok(!globalPages.includes('aria-label="全部类型"'), "类型下拉与 pill 行重复堆叠");
});

/* ---------- K2（N1）：横条单行三簇 + 未分类取数修复 ---------- */

test("K2-N1：横条三簇与 select 同源——横条消费 assetKindClusterViews（ASSET_KIND_GROUPS 投影）", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  assert.ok(globalPages.includes("assetKindClusterViews("), "横条未消费三簇视图函数（回到平铺即违例）");
  assert.ok(!globalPages.includes("showAllKinds"), "旧的整行平铺展开态残留");
  // 行为级同源：三簇 = ASSET_KIND_GROUPS 的投影（类别/标签/成员与 select 的 optgroup 同一份源）
  const views = assetKindClusterViews(new Map<string, number>(), "", new Set());
  assert.deepEqual(views.map((view) => view.category), ASSET_KIND_GROUPS.map((group) => group.category));
  assert.deepEqual(views.map((view) => view.label), ASSET_KIND_GROUPS.map((group) => group.label));
  for (const view of views) {
    const group = ASSET_KIND_GROUPS.find((item) => item.category === view.category);
    // 空计数下整簇折叠：可见为零、折叠数 = 组内全量（成员确实来自同一份源）
    assert.equal(view.hiddenCount, group?.options.length);
  }
});

test("K2-N1：assetKindClusterViews 零计数折叠按簇生效——选中项不被吞、展开簇整簇可见", () => {
  const counts = new Map<string, number>([["character", 2], ["camera", 1], ["keyword", 3]]);
  const collapsed = assetKindClusterViews(counts, "", new Set());
  const entity = collapsed.find((view) => view.category === "entity");
  const reference = collapsed.find((view) => view.category === "reference");
  const artifact = collapsed.find((view) => view.category === "artifact");
  assert.deepEqual(entity?.visibleOptions.map((option) => option.value), ["character"]);
  assert.equal(entity?.hiddenCount, 4);
  assert.deepEqual(reference?.visibleOptions.map((option) => option.value), ["camera"]);
  assert.equal(reference?.hiddenCount, 6);
  assert.deepEqual(artifact?.visibleOptions.map((option) => option.value), ["keyword"]);
  assert.equal(artifact?.hiddenCount, 1);
  // 选中中的零计数类型始终可见（不被折叠吞掉，与旧平铺同规则）
  const selected = assetKindClusterViews(counts, "scene", new Set());
  assert.deepEqual(selected.find((view) => view.category === "entity")?.visibleOptions.map((option) => option.value), ["character", "scene"]);
  // 展开按簇生效：只展开 artifact 簇，其余簇维持折叠
  const expanded = assetKindClusterViews(counts, "", new Set<AssetKindCategory>(["artifact"]));
  assert.equal(expanded.find((view) => view.category === "artifact")?.visibleOptions.length, 2);
  assert.equal(expanded.find((view) => view.category === "artifact")?.hiddenCount, 0);
  assert.equal(expanded.find((view) => view.category === "entity")?.hiddenCount, 4);
});

test("资产分页：fetchScopeAssets 只调用一次 API，不再等待十余个空类型请求", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  const start = globalPages.indexOf("async function fetchScopeAssets");
  assert.ok(start > 0, "fetchScopeAssets 不在");
  const fnBody = globalPages.slice(start, globalPages.indexOf("\n}", start));
  assert.equal((fnBody.match(/api\.assets\(/g) ?? []).length, 1, "浏览入口不是单请求");
  assert.ok(fnBody.includes("pageSize: ASSET_LIBRARY_PAGE_SIZE"), "单请求没有 24 件页大小");
});

test("服务端 kind_counts 聚合保留别名上卷和未分类计数", () => {
  const counts = countRawAssetKinds({
    character: 2,
    animal: 1,
    scene_reference: 3,
    "": 1,
  });
  assert.equal(counts.get("character"), 3);
  assert.equal(counts.get("animal"), 1);
  assert.equal(counts.get(UNCATEGORIZED_KIND), 4);
});

test("K2-N1：mock 合并行为——词表外 kind 进 items 后未分类计数 >0、树状尾部出现未分类组", () => {
  // mock 形状与 fetchScopeAssets 一致：16 路分拉只回词表内资产；无 kind 全量路额外带回
  // 词表外 scene_reference（dev 库实测脏值）与空白 kind，mergeAssetItems 按 id 去重后收编
  const known = asset({ id: "a1", asset_kind: "character", name: "任天野", updated_at: "2026-07-20T00:00:00Z" });
  const offVocab = asset({ id: "x1", asset_kind: "scene_reference", name: "街景参考", updated_at: "2026-07-27T00:00:00Z" });
  const blank = asset({ id: "x2", asset_kind: "", name: "空白类型资产", updated_at: "2026-07-26T00:00:00Z" });
  const merged = mergeAssetItems([[known], [known, offVocab, blank]]);
  assert.deepEqual(merged.map((item) => item.id), ["a1", "x1", "x2"], "按 id 去重并保留首次出现顺序");
  // 未分类计数从恒 0 变真值（与页头 kindCounts 同一份聚合函数）
  const counts = countAssetsByKind(merged);
  assert.equal(counts.get(UNCATEGORIZED_KIND), 2);
  assert.equal(counts.get("character"), 1);
  // 树状尾部出现未分类组（行为级渲染断言，不靠源码字符串）
  const html = renderToStaticMarkup(React.createElement(AssetKindTreeView, { assets: merged, onOpen: () => undefined }));
  const uncategorizedAt = html.indexOf('aria-label="未分类分组"');
  assert.ok(uncategorizedAt > 0, "树状尾部缺未分类组");
  assert.ok(uncategorizedAt > html.indexOf('aria-label="角色分组"'), "未分类组不在尾部");
  assert.ok(html.slice(uncategorizedAt).includes("2 个资产"), "未分类组计数不是 2");
  assert.ok(html.includes("街景参考") && html.includes("空白类型资产"), "词表外/空白资产未进树状陈列");
});

test("K2-N1：大类字面量全仓唯一——分类学标签只许在 asset-shared.tsx（轴唯一真源）", () => {
  // S88/K2 纪律：大类常量只许存在于 asset-shared.tsx；新增类型 = 加一行 DEFS 挂一个大类。
  // 「参考素材」在日常文案里另有语义（usage_mode/指引文案），无法按字面量扫；但克隆轴必须
  // 同时出现「创作实体/产物形态」——扫这两个无歧义字面量 + 常量消费点即等效守住。
  const srcRoot = fileURLToPath(new URL(".", import.meta.url));
  const collectSources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return collectSources(full);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
    });
  const offenders: string[] = [];
  for (const file of collectSources(srcRoot)) {
    const rel = file.slice(srcRoot.length);
    if (rel === "/components/asset-shared.tsx") continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("创作实体") || source.includes("产物形态")) offenders.push(rel);
    if (source.includes("ASSET_KIND_CATEGORY_LABELS")) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `大类字面量/常量扩散到 asset-shared.tsx 之外：${offenders.join("、")}`);
});

/* ---------- K2P GP-05：demo 手工建资产本地回显（步 3 替代路径在 demo 可验收） ----------
   集成线 33ae312 已合入 A1-05 实现（createBlankAsset demo 分支本地加卡，id 前缀 demo-asset-、
   toast「未写入服务」），本断言对着已合入实现写，不再另造一份。 */

test("K2P GP-05 源码级：demo 建档案本地加卡 + 诚实标注，不再零回显直退", () => {
  const globalPages = readSource("./pages/global-pages.tsx");
  // demo 分支本地加卡：新资产入列首、计数 +1（与建项目 demo 本地加卡同口径）
  assert.ok(globalPages.includes("demo-asset-"), "demo 分支未生成本地资产 id");
  assert.ok(globalPages.includes('notify("离线示例资产只保存在当前页面，未写入服务", "info")'), "缺「只保存在当前页面」诚实标注");
  assert.ok(!globalPages.includes('notify("离线演示不会写入资产库", "info")'), "旧的零回显直退仍在");
  // 本地卡带类型与职责：类型 pill 计数/树状分组由列表数据现算，入列即进对应分组
  assert.ok(globalPages.includes("asset_kind: newAssetKind"), "本地卡未带所选类型");
  assert.ok(globalPages.includes("role: roleForAssetKind(newAssetKind) ?? null"), "本地卡未按类型补职责");
  // demo 分支不能落到尾部那次列表刷新：demo 下刷新会把列表重置回 fixture，本地卡会被抹掉
  const demoBranch = globalPages.slice(globalPages.indexOf("demo-asset-"), globalPages.indexOf("setCreatingAsset(true)"));
  assert.ok(!demoBranch.includes("retry()"), "demo 分支触发了尾部刷新，本地卡会被 fixture 重置抹掉");
});
