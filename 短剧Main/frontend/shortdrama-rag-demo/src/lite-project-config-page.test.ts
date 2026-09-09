/* ============================================================
   lite-project-config-page.test.ts — Lite 项目生成配置页音频 tab 源码断言
   (2026-08-18 音频改造:配置页保存音频默认档;音色栏同日删——参数不含 speaker_id)

   断言口径:与既有前端测试同款 node:test + readFileSync 源码断言,
   不导入 .tsx(jsdom 环境缺位),只验证可观察契约在源码里成立。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./pages/lite/lite-project-config-page.tsx", import.meta.url), "utf8");

/* ---------- 音频媒体类型进入配置域 ---------- */

test("音频: LiteConfigKind 含 audio(移除 Lite 不涉及 audio 注释)", () => {
  assert.ok(source.includes('type LiteConfigKind = "image" | "video" | "audio"'), "LiteConfigKind 应含 audio");
  assert.ok(!source.includes("Lite 不涉及 audio"), "不应再有「Lite 不涉及 audio」注释");
});

test("音频: FORM_DIMENSION_KEYS.audio 暴露模型/音质/格式/时长四级级联(2026-08-18 用户裁定)", () => {
  assert.ok(source.includes('audio: ["model_label", "sample_rate", "format", "duration_seconds"]'), "音频档应暴露模型/音质/格式/时长四个维度");
  assert.ok(source.includes("original_duration_seconds"), "应注明音频时长来自档冻参数 original_duration_seconds");
  assert.ok(source.includes("sample_rate: { audio: \"音质\" }"), "音质维度字段标签应为「音质」");
  assert.ok(source.includes("format: { audio: \"格式\" }"), "格式维度字段标签应为「格式」");
});

test("音频: 媒体 tab 含音频配置(图片/视频/音频三枚),?kind=audio 持久化", () => {
  assert.ok(source.includes('value="audio"'), "媒体 tab 应有 audio 值");
  assert.ok(source.includes("音频配置"), "媒体 tab 应有「音频配置」标签");
  assert.ok(source.includes('kind === "audio" ? "audio" : "image"'), "readKindFromUrl 应解析 audio");
});

/* ---------- 音频默认档 + 默认音色保存 ---------- */

test("音频: 保存 payload 走 putGenerationDefault(audio),mode=text_to_speech", () => {
  assert.ok(source.includes('api.putGenerationDefault(projectId, kind, {'), "保存应调 putGenerationDefault");
  assert.ok(source.includes('setMode(data.strategy?.mode ?? (kind === "audio" ? "text_to_speech" : "material_to_prompt"))'), "音频未配置时应回落 text_to_speech 模式");
  assert.ok(source.includes("text_to_speech"), "音频默认策略 mode 应为 text_to_speech");
});

test("音频: buildParameters 音频分支不再保存 speaker_id(音色栏已删)+ 无模板引用", () => {
  assert.ok(source.includes('if (kind === "audio")'), "buildParameters 应有音频分支");
  assert.ok(!source.includes("speaker_id:"), "音频参数不应再保存 speaker_id 属性(音色栏已删)");
  assert.ok(source.includes("prompt_template_id: null"), "音频无提示词模板引用应显式 null");
  // 音频分支必须在图片/视频分支之前短路返回(音频参数不混入 size/ratio/resolution)
  const audioAt = source.indexOf('if (kind === "audio")');
  const imageAt = source.indexOf('if (kind === "image")');
  assert.ok(audioAt !== -1 && imageAt !== -1 && audioAt < imageAt, "音频分支应排在图片分支前短路返回");
});

test("音频: 音色栏已删——无未选音色禁存 + 保存按钮文案/通知音频口径", () => {
  assert.ok(!source.includes('kind === "audio" && !selectedVoice'), "不应再有音频未选音色校验");
  assert.ok(!source.includes("请选择音色后保存"), "不应再有未选音色禁存原因");
  assert.ok(source.includes('kind === "audio" ? "音频" : "视频"'), "保存按钮文案应为「保存音频配置」");
  assert.ok(source.includes("音频生成配置已保存"), "保存成功通知应为音频口径");
});

/* ---------- 音色选择器 UI 已删(2026-08-18 用户裁定:暂时不需要音色) ---------- */

test("音频: 默认音色选择器与试听已删(不引 voice-catalog/aria-label/试听)", () => {
  assert.ok(!source.includes("fetchVoiceCatalog"), "音频卡不应再调音色目录接口");
  assert.ok(!source.includes('aria-label="音频配置默认音色"'), "不应再有默认音色下拉");
  assert.ok(!source.includes("toggleVoicePreview"), "不应再有试听切换函数");
  assert.ok(!source.includes("playingVoiceId"), "不应再有试听中音色状态");
  assert.ok(!source.includes("auditionUrl"), "不应再引用音色试听素材");
  assert.ok(!source.includes('data?.strategy?.parameters?.speaker_id'), "不应再按已存默认策略的 speaker_id 预填音色");
});

/* ---------- 音频卡不渲染模板/风格(无此概念) ---------- */

test("音频: 模板配置子 tab 与风格配置面板不渲染", () => {
  assert.ok(source.includes('kind !== "audio" ? <TabsTrigger value="template"'), "音频卡不渲染模板配置子 tab");
  assert.ok(source.includes('kind !== "audio" ? (\n            <div className="flex min-h-0 flex-1 flex-col gap-2">'), "音频卡不渲染风格配置面板");
  assert.ok(source.includes("音频无提示词模板/风格概念"), "应有注释说明音频无模板/风格概念");
});

/* ---------- 音频卡数据加载:无模板库/风格库 ---------- */

test("音频: loadKindConfig 音频分支只读档+默认策略,不加载模板/风格", () => {
  assert.ok(source.includes('if (kind === "audio")'), "loadKindConfig 应有音频分支");
  assert.ok(source.includes("library: [], styles: [], systemDefault: \"\""), "音频卡不应有模板库/风格库/系统默认模板");
  assert.ok(source.includes("api.generationDefault(projectId, \"audio\")"), "音频默认策略应按 media_kind=audio 读取");
});

/* ---------- 视频出厂默认(2026-08-19:新建项目即有初始化配置,默认 seedance 2.0/720p/9:16) ---------- */

test("视频: 未配置按出厂默认展示——过滤快乐马预览档,取最便宜非预览 active 档", () => {
  assert.ok(source.includes('const pool = kind === "video" ? active.filter((tier) => !isPreviewTier(tier)) : active'), "视频未配置应排除预览档(快乐马锁定档不入配置表单)");
  assert.ok(source.includes("cheapestActiveTier(pool) ?? pool[0]!"), "应取最便宜非预览 active 档(dev=seedance 2.0/720p/9:16)");
  assert.ok(source.includes("import { cheapestActiveTier } from \"./lite-generation\""), "应复用既有最便宜档助手,不另写排序");
  assert.ok(source.includes("isPreviewTier,"), "应引用共享预览档识别函数");
});
