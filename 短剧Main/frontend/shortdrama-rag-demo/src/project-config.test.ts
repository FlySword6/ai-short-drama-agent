/* ============================================================
   project-config.test.ts — 卡 #151 项目级生成配置验收断言
   ① 归一：项目行 generation_config 嵌套 wire → 配置（画幅共用、清晰度图片/视频分开、双风格、双模板）
   ② 选项推导：active 可点、冻结置灰带原因；后端加档前端零改动多出选项
   ③ 默认值：9:16 / 1K / 720p 在值域内才选中，不在则取第一个可点值
   ④ 界面接线：新建弹窗 chips、设置抽屉两页签、生成面板「这次出片」条、设置页假面板已删
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CapabilityTier } from "./capability-tiers";
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_IMAGE_RESOLUTION,
  DEFAULT_VIDEO_RESOLUTION,
  EMPTY_PROJECT_CONFIG,
  aspectRatioLabel,
  defaultTraceLabel,
  insertPlaceholder,
  listAspectRatioOptions,
  listConfigOptions,
  pickDefault,
  projectGenerationConfigFromUnknown,
  projectGenerationConfigToWire,
  projectTierPreference,
  styleConfigured,
  type ProjectGenerationConfig,
} from "./project-config";

function tier(partial: Partial<CapabilityTier> & { tier_id: string }): CapabilityTier {
  return {
    media_type: "image",
    display_name: null,
    provider_label: null,
    model_label: null,
    params: {},
    price: { unit: "per_image", points: 30 },
    status: "active",
    ...partial,
  };
}

/* ---------- ① 归一 ---------- */

test("归一：generation_config 嵌套 wire → camel 配置；画幅共用、清晰度图片/视频分开存，不互相映射", () => {
  const config = projectGenerationConfigFromUnknown({
    generation_config: {
      default_ratio: "9:16",
      default_image_resolution: "1K",
      default_video_resolution: "720p",
      image: {
        style_description: "港风黑帮",
        style_reference_media_ids: ["m1", "m2"],
        prompt_template: "画面:{片段内容}",
        prompt_template_source: "project",
      },
      video: {
        style_description: "手持轻晃",
        style_reference_media_ids: [],
        prompt_template: "这一镜:{片段内容}",
        prompt_template_source: "project",
      },
    },
  });
  assert.equal(config.aspectRatio, "9:16");
  assert.equal(config.imageResolution, "1K");
  assert.equal(config.videoResolution, "720p");
  assert.equal(config.styleImage.referenceMediaIds.length, 2);
  assert.equal(config.promptTemplateVideo.includes("这一镜"), true);

  /* 空行=空配置,不伪造默认 */
  const empty = projectGenerationConfigFromUnknown({});
  assert.equal(empty.aspectRatio, null);
  assert.equal(empty.styleImage.referenceMediaIds.length, 0);

  /* 平台默认模板不进项目表单：source=platform_default 视为没自配，否则回读→保存会把默认钉成项目快照 */
  const platform = projectGenerationConfigFromUnknown({
    generation_config: {
      image: { style_description: null, style_reference_media_ids: [], prompt_template: "平台默认模板原文", prompt_template_source: "platform_default" },
    },
  });
  assert.equal(platform.promptTemplateImage, "");

  /* wire 回写：generation_config 嵌套、字段名与后端 schema（production/routes.ts）一致 */
  const wire = projectGenerationConfigToWire(config);
  const gc = wire.generation_config as Record<string, unknown>;
  assert.equal(gc.default_ratio, "9:16");
  assert.equal(gc.default_image_resolution, "1K");
  assert.equal(gc.default_video_resolution, "720p");
  const image = gc.image as Record<string, unknown>;
  assert.deepEqual(image.style_reference_media_ids, ["m1", "m2"]);
  assert.equal(image.prompt_template, "画面:{片段内容}");
  assert.ok(!("resolution" in gc), "不许合成单一 resolution 字段");

  /* null（还没定）缺键不写 null（schema 不收）；空模板写 null（=走平台默认） */
  const partial = projectGenerationConfigToWire({ ...EMPTY_PROJECT_CONFIG, aspectRatio: "9:16" }).generation_config as Record<string, unknown>;
  assert.ok(!("default_image_resolution" in partial) && !("default_video_resolution" in partial), "null 必须缺键");
  assert.equal((partial.image as Record<string, unknown>).prompt_template, null);
});

/* ---------- ② 选项推导 ---------- */

test("选项由能力矩阵推导：active 可点、冻结置灰带原因、同值合并", () => {
  const tiers = [
    tier({ tier_id: "a", params: { aspect_ratio: "9:16", resolution: "1K" } }),
    tier({ tier_id: "b", params: { aspect_ratio: "16:9", resolution: "1K" } }),
    tier({ tier_id: "c", params: { aspect_ratio: "1:1", resolution: "2K" }, status: "experimental", availability: "pricing_unverified", availability_reason: "还没开通（卡在定价）" }),
  ];
  const imageRes = listConfigOptions(tiers, "image", "resolution");
  assert.deepEqual(imageRes.map((o) => [o.value, o.available]), [["1K", true], ["2K", false]]);
  assert.equal(imageRes.find((o) => o.value === "2K")?.frozenReason, "还没开通（卡在定价）");

  const ratios = listAspectRatioOptions(tiers);
  assert.deepEqual(ratios.map((o) => o.value), ["9:16", "16:9", "1:1"]);

  /* 后端加一个档,前端零改动多出选项 */
  const more = [...tiers, tier({ tier_id: "d", params: { aspect_ratio: "4:3", resolution: "1K" } })];
  assert.ok(listAspectRatioOptions(more).some((o) => o.value === "4:3"), "后端新档的画幅没有自动出现");
});

/* ---------- ③ 默认值 ---------- */

test("默认值：产品默认在值域内才选中；不在取第一个可点值；全灰返回 null", () => {
  const options = [
    { value: "16:9", available: true, frozenReason: null },
    { value: "9:16", available: true, frozenReason: null },
  ];
  assert.equal(pickDefault(options, DEFAULT_ASPECT_RATIO), "9:16");
  assert.equal(pickDefault([{ value: "16:9", available: true, frozenReason: null }], DEFAULT_ASPECT_RATIO), "16:9");
  assert.equal(pickDefault([{ value: "2K", available: false, frozenReason: "卡在定价" }], DEFAULT_IMAGE_RESOLUTION), null);
  assert.equal(DEFAULT_IMAGE_RESOLUTION, "1K");
  assert.equal(DEFAULT_VIDEO_RESOLUTION, "720p");
});

test("风格与痕迹：styleConfigured / defaultTraceLabel / insertPlaceholder / aspectRatioLabel", () => {
  assert.equal(styleConfigured({ description: "", referenceMediaIds: [] }), false);
  assert.equal(styleConfigured({ description: "港风", referenceMediaIds: [] }), true);
  assert.equal(styleConfigured({ description: "", referenceMediaIds: ["m1"] }), true);
  assert.equal(defaultTraceLabel("9:16", "9:16"), "9:16 · 项目默认");
  assert.equal(defaultTraceLabel("16:9", "9:16"), "16:9 · 这次改过，项目默认是 9:16");
  assert.equal(insertPlaceholder("画面:{片段内容}", "角色"), "画面:{片段内容} {角色}");
  assert.equal(aspectRatioLabel("9:16"), "竖屏 9:16");
  assert.equal(aspectRatioLabel("3:4"), "3:4");
});

/* ---------- ④ 界面接线（源码断言） ---------- */

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("新建项目弹窗：画幅/清晰度 chips 接能力矩阵,提交后补写默认值进 followUps", () => {
  const source = readSource("./pages/global-pages.tsx");
  assert.ok(source.includes("ConfigOptionChips"), "新建弹窗未接 chips");
  assert.ok(source.includes("includeFrozen: true"), "未拉冻结档（置灰原因无数据源）");
  assert.ok(source.includes("updateProjectGenerationConfig"), "创建后未补写项目生成默认值");
  assert.ok(source.includes('followUps.push("画幅/清晰度默认值")'), "补写失败未进 followUps 如实提示");
});

test("项目设置抽屉：画面与风格 + 提示词模板两个页签,参考图从资产里选", () => {
  const source = readSource("./components/project-settings.tsx");
  assert.ok(source.includes("画面与风格") && source.includes("提示词模板"), "缺新页签");
  assert.ok(source.includes("ReferenceImagePicker"), "未接参考图选择器");
  assert.ok(source.includes("从资产里选"), "参考图缺「从资产里选」入口");
  assert.ok(!source.includes("另传一套") === false, "缺「不另传一套」说明");
  assert.ok(source.includes("PROMPT_TEMPLATE_PLACEHOLDERS"), "模板页签缺占位符");
  assert.ok(source.includes("defaultPromptTemplates"), "缺平台默认模板读取");
});

test("生成面板：这次出片条 + 这次不带开关;提交只在取消时带 skip 键", () => {
  /* 现行生成动线=段落工作台（镜级工作台已归档,深链全 redirect 过来）,条接在整段与逐镜两处确认区。 */
  const source = readSource("./pages/segment-workbench-page.tsx");
  assert.ok(source.includes("project-style-bar") || source.includes("ProjectStyleBar"), "缺这次出片条");
  assert.ok(source.includes("skip_project_defaults"), "提交缺跳过键");
  assert.ok(source.includes("skipProjectStyle ? { skip_project_defaults: true } : {}"), "skip 键必须只在用户取消时带");
  const barSource = readSource("./components/project-style-bar.tsx");
  assert.ok(barSource.includes("带了项目风格") && barSource.includes("这次不带"), "缺风格带/不带切换");
  assert.ok(barSource.includes("只影响这一次"), "缺「只影响这一次」说明");
});

test("设置页：三个本机保存假面板已退役（settings-page.test.ts 另有零残留断言）", () => {
  const source = readSource("./pages/settings-page.tsx");
  assert.ok(!source.includes("GlobalStylePanel") && !source.includes("PromptTemplatesPanel"), "假面板仍有残留");
});

/* ---------- 界面文案红线 ---------- */

test("界面文案无厂商名/英文报错/HTTP 码（说人话）", () => {
  const config = projectGenerationConfigFromUnknown({});
  void config;
  for (const [file, banned] of [
    ["./components/config-option-chips.tsx", ["Seedream", "Seedance", "HTTP", "provider"]],
    ["./components/reference-image-picker.tsx", ["Seedream", "Seedance", "HTTP"]],
    ["./components/project-settings.tsx", ["Seedance", "HTTP"]],
  ] as const) {
    const source = readSource(file);
    for (const word of banned) assert.ok(!source.includes(word), `${file} 出现「${word}」`);
  }
});

/* ---------- #172：项目设定 → 生成面板默认档偏好 ---------- */

test("#172：选档偏好映射——画幅共用;清晰度图片/视频各取各的刻度,不互相映射", () => {
  const config: ProjectGenerationConfig = {
    ...EMPTY_PROJECT_CONFIG,
    aspectRatio: "9:16",
    imageResolution: "1K",
    videoResolution: "720p",
  };
  assert.deepEqual(projectTierPreference(config, "image"), { aspectRatio: "9:16", resolution: "1K" });
  assert.deepEqual(projectTierPreference(config, "video"), { aspectRatio: "9:16", resolution: "720p" });
  assert.deepEqual(projectTierPreference(EMPTY_PROJECT_CONFIG, "image"), { aspectRatio: null, resolution: null }, "项目没设定=空偏好,选档续走全局缺省链");
});
