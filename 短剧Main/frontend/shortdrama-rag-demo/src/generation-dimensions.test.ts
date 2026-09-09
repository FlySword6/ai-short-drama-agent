/* generation-dimensions.test.ts — S66 参数维度引擎单测(纯函数,node:test 直跑)。
   覆盖:R59 维度拆分的值域推导/组合反查/置灰判据/摘要条/0 秒口径/模型展示标签。
   多模型接缝(FABLE-007):模型维度键=model_label(安全展示标签),不再接触真实型号 id。 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CapabilityTier } from "./capability-tiers";
import { MORE_TIERS_NOTE, SINGLE_TIER_NOTE, tierModelLabel } from "./capability-tiers";
import {
  dimensionPopoverFooter,
  dimensionValueLabel,
  listGenerationDimensions,
  resolveDimensionPick,
  tierDeclaredKeys,
  tierDimensionSummary,
  tierDimensionValue,
} from "./generation-dimensions";

function tier(overrides: Partial<CapabilityTier> & { tier_id: string }): CapabilityTier {
  return {
    model_label: "Seedream 5 Pro",
    display_name: "Seedream 5 Pro",
    provider_label: "火山方舟",
    media_type: "image",
    params: { aspect_ratio: "16:9", resolution: "2K", quantity: 1 },
    price: { unit: "per_image", points: 60 },
    status: "active",
    ...overrides,
  };
}

/** S58 全量档的缩微代表(形状一致:视频新档不含 duration_seconds)。 */
const IMAGE_TIERS: CapabilityTier[] = [
  tier({ tier_id: "img-169-2k", params: { aspect_ratio: "16:9", resolution: "2K", quantity: 1 } }),
  tier({ tier_id: "img-916-2k", params: { aspect_ratio: "9:16", resolution: "2K", quantity: 1 } }),
  tier({ tier_id: "img-11-2k", params: { aspect_ratio: "1:1", resolution: "2K", quantity: 1 } }),
  tier({ tier_id: "img-169-1k", params: { aspect_ratio: "16:9", resolution: "1K", quantity: 1 } }),
];

const VIDEO_TIERS: CapabilityTier[] = [
  tier({
    tier_id: "vid-fast-916-720p-4s",
    media_type: "video",
    model_label: "Seedance 2.0 Fast",
    display_name: "Seedance 2.0 Fast",
    params: { aspect_ratio: "9:16", resolution: "720p", duration_seconds: 4, quantity: 1 },
    price: { unit: "per_second", points: 80 },
  }),
  tier({
    tier_id: "vid-fast-169-720p",
    media_type: "video",
    model_label: "Seedance 2.0 Fast",
    display_name: "Seedance 2.0 Fast",
    params: { aspect_ratio: "16:9", resolution: "720p", quantity: 1 },
    price: { unit: "per_second", points: 80 },
  }),
  tier({
    tier_id: "vid-mini-169-480p",
    media_type: "video",
    model_label: "Seedance 2.0 Mini",
    display_name: "Seedance 2.0 Mini",
    params: { aspect_ratio: "16:9", resolution: "480p", quantity: 1 },
    price: { unit: "per_second", points: 25 },
  }),
];

test("维度取值:model_label 恒在,params 白名单键按声明读取,未声明=undefined", () => {
  const anchor = VIDEO_TIERS[0]!;
  assert.equal(tierDimensionValue(anchor, "model_label"), "Seedance 2.0 Fast");
  assert.equal(tierDimensionValue(anchor, "duration_seconds"), 4);
  assert.equal(tierDimensionValue(anchor, "generate_audio"), undefined);
  assert.deepEqual(tierDeclaredKeys(anchor, "video"), ["model_label", "aspect_ratio", "resolution", "duration_seconds", "quantity"]);
  // 新档无 duration_seconds:声明键如实少一项(0 秒不再虚构)
  assert.deepEqual(tierDeclaredKeys(VIDEO_TIERS[1]!, "video"), ["model_label", "aspect_ratio", "resolution", "quantity"]);
});

test("模型展示标签回落:model_label → display_name → tier_id,缺标签不并假值", () => {
  assert.equal(tierModelLabel(tier({ tier_id: "t-a" })), "Seedream 5 Pro");
  assert.equal(tierModelLabel(tier({ tier_id: "t-b", model_label: null })), "Seedream 5 Pro");
  assert.equal(tierModelLabel(tier({ tier_id: "t-c", model_label: null, display_name: null })), "t-c");
  assert.equal(tierModelLabel(tier({ tier_id: "t-d", model_label: "", display_name: "" })), "t-d");
});

test("维度表:值域只来自 active 档;全档单值维度=固定标签形态;未声明维度行不出现", () => {
  const retired = tier({ tier_id: "img-old", status: "retired", params: { aspect_ratio: "4:3", resolution: "4K", quantity: 2 } });
  const dimensions = listGenerationDimensions([...IMAGE_TIERS, retired], "image", IMAGE_TIERS[0]!);
  const byKey = Object.fromEntries(dimensions.map((dimension) => [dimension.key, dimension]));
  assert.deepEqual(byKey.aspect_ratio?.options.map((option) => option.value), ["16:9", "9:16", "1:1"], "retired 档的 4:3 不进值域");
  assert.deepEqual(byKey.resolution?.options.map((option) => option.value), ["2K", "1K"]);
  assert.equal(byKey.quantity?.single, true, "数量全档只有 1 → 固定标签,不做假 chips");
  assert.equal(byKey.generate_audio, undefined, "无档声明 generate_audio → 维度行不出现");
});

test("维度表选中态与置灰判据:当前档命中值选中;组合查无档的选项 feasible=false", () => {
  const dimensions = listGenerationDimensions(IMAGE_TIERS, "image", IMAGE_TIERS[3]!); // 当前 16:9·1K
  const ratio = dimensions.find((dimension) => dimension.key === "aspect_ratio")!;
  // 16:9 选中;9:16 可行(有 9:16·2K,共享维度 quantity 一致,resolution 不在两档共同键上?——1K 档与 2K 档共同声明键含 resolution,值不同 → 不可行)
  assert.deepEqual(
    ratio.options.map((option) => [option.value, option.feasible, option.selected]),
    [["16:9", true, true], ["9:16", false, false], ["1:1", false, false]],
    "当前 1K 档时,9:16/1:1 只有 2K 档 → 组合查无档,置灰",
  );
  const resolution = dimensions.find((dimension) => dimension.key === "resolution")!;
  assert.deepEqual(
    resolution.options.map((option) => [option.value, option.feasible, option.selected]),
    [["2K", true, false], ["1K", true, true]],
    "1K↔2K 在 16:9 下互换可行",
  );
});

test("维度反查:改比例命中同模型同清晰度档;查无组合返回 null;多候选取最贴近当前档者", () => {
  const current = IMAGE_TIERS[0]!; // 16:9·2K
  assert.equal(resolveDimensionPick(IMAGE_TIERS, current, "image", "aspect_ratio", "9:16")?.tier_id, "img-916-2k");
  assert.equal(resolveDimensionPick(IMAGE_TIERS, current, "image", "aspect_ratio", "4:3"), null, "查无组合 → null(界面置灰)");
  assert.equal(resolveDimensionPick(IMAGE_TIERS, current, "image", "resolution", "1K")?.tier_id, "img-169-1k");
  // 当前 16:9·1K 改比例 9:16:只有 9:16·2K,共享键 resolution 不一致 → null(置灰)
  assert.equal(resolveDimensionPick(IMAGE_TIERS, IMAGE_TIERS[3]!, "image", "aspect_ratio", "9:16"), null);
  // 锚点视频档改比例 16:9:fast 有 16:9·720p(无 duration,共同键上 duration 不参与)→ 命中
  assert.equal(resolveDimensionPick(VIDEO_TIERS, VIDEO_TIERS[0]!, "video", "aspect_ratio", "16:9")?.tier_id, "vid-fast-169-720p");
  // 锚点档改模型 mini:mini 只有 16:9·480p,共享键比例/清晰度不一致 → null
  assert.equal(resolveDimensionPick(VIDEO_TIERS, VIDEO_TIERS[0]!, "video", "model_label", "Seedance 2.0 Mini"), null);
  // 从 fast 16:9 改模型 mini:mini 有 16:9·480p,共享键比例一致(分辨率不在 mini 档?——mini 档声明 480p,共同键含 resolution 值不同)→ null
  assert.equal(resolveDimensionPick(VIDEO_TIERS, VIDEO_TIERS[1]!, "video", "model_label", "Seedance 2.0 Mini"), null);
});

test("摘要条:libTV 口径;未声明时长不显示「0 秒」(R59 显示 bug 同口径)", () => {
  assert.equal(tierDimensionSummary(VIDEO_TIERS[0]!), "9:16 · 720p · 4 秒 · 1 个");
  assert.equal(tierDimensionSummary(VIDEO_TIERS[1]!), "16:9 · 720p · 1 个", "无 duration_seconds 的档不得出现 0 秒");
  assert.equal(tierDimensionSummary(IMAGE_TIERS[0]!), "16:9 · 2K · 1 张");
  assert.equal(tierDimensionSummary(tier({
    tier_id: "vid-audio",
    media_type: "video",
    params: { aspect_ratio: "9:16", resolution: "720p", duration_seconds: 5, quantity: 1, generate_audio: true },
  })), "9:16 · 720p · 5 秒 · 1 个 · 🔊");
});

test("S73:数量单位随媒介——视频维度选项显示「个」不是「张」(listGenerationDimensions 漏传 mediaType 回归)", () => {
  assert.equal(dimensionValueLabel("quantity", 1, "video"), "1 个");
  const dimensions = listGenerationDimensions(VIDEO_TIERS, "video", VIDEO_TIERS[0]!);
  const quantity = dimensions.find((dimension) => dimension.key === "quantity")!;
  assert.deepEqual(quantity.options.map((option) => option.label), ["1 个"], "视频数量维度行不得再用图片单位「张」");
  const imageDimensions = listGenerationDimensions(IMAGE_TIERS, "image", IMAGE_TIERS[0]!);
  const imageQuantity = imageDimensions.find((dimension) => dimension.key === "quantity")!;
  assert.deepEqual(imageQuantity.options.map((option) => option.label), ["1 张"], "图片数量仍是「张」");
});

test("维度值标签:不虚构,模型=展示标签原样(多模型接缝:不从真实 id 派生)", () => {
  assert.equal(dimensionValueLabel("duration_seconds", 4), "4 秒");
  assert.equal(dimensionValueLabel("quantity", 2, "image"), "2 张");
  assert.equal(dimensionValueLabel("generate_audio", true), "开");
  assert.equal(dimensionValueLabel("model_label", "Seedance 2.0 Fast"), "Seedance 2.0 Fast");
});

/* ---------- S83b(验收 R1):popover footer 判定——单值维度也要出路说明 ---------- */

test("S83b footer 判定:有置灰项=出路说明;全单值=如实现状;部分单值=即将开放;全多值全可点=不显示", () => {
  // 全单值(demo 视频页签/真栈单档就是这个状态):S83 只看守置灰项,把 footer 删成了死胡同
  const singleOnly = listGenerationDimensions([VIDEO_TIERS[0]!], "video", VIDEO_TIERS[0]!);
  assert.ok(singleOnly.every((dimension) => dimension.single), "前置:单档下维度必须全 single");
  assert.equal(dimensionPopoverFooter(singleOnly, singleOnly), SINGLE_TIER_NOTE, "全单值必须如实交代「当前只开放这一档」");

  // 有置灰项:footer=置灰项的出路说明(S83 原语义保留)
  const withInfeasible = listGenerationDimensions(IMAGE_TIERS, "image", IMAGE_TIERS[3]!); // 当前 16:9·1K,9:16/1:1 置灰
  assert.ok(withInfeasible.some((dimension) => dimension.options.some((option) => !option.feasible)), "前置:确有置灰项");
  assert.equal(dimensionPopoverFooter(withInfeasible, withInfeasible), MORE_TIERS_NOTE);

  // 部分单值(有 chips 也有固定标签)且无置灰:仍要交代「即将开放」
  const mixed: CapabilityTier[] = [
    tier({ tier_id: "img-169-2k", params: { aspect_ratio: "16:9", resolution: "2K", quantity: 1 } }),
    tier({ tier_id: "img-916-2k", params: { aspect_ratio: "9:16", resolution: "2K", quantity: 1 } }),
  ];
  const mixedDims = listGenerationDimensions(mixed, "image", mixed[0]!);
  assert.ok(mixedDims.some((dimension) => dimension.single), "前置:清晰度/数量是单值");
  assert.ok(mixedDims.every((dimension) => dimension.options.every((option) => option.feasible)), "前置:无置灰项");
  assert.equal(dimensionPopoverFooter(mixedDims, mixedDims), MORE_TIERS_NOTE);

  // 全多值且全可点(理想叉乘):不显示——恒显「即将开放」是假话(S83 原判定保留)
  const fullCross: CapabilityTier[] = [
    tier({ tier_id: "img-169-2k", params: { aspect_ratio: "16:9", resolution: "2K" } }),
    tier({ tier_id: "img-169-1k", params: { aspect_ratio: "16:9", resolution: "1K" } }),
    tier({ tier_id: "img-916-2k", params: { aspect_ratio: "9:16", resolution: "2K" } }),
    tier({ tier_id: "img-916-1k", params: { aspect_ratio: "9:16", resolution: "1K" } }),
  ];
  const crossDimsAll = listGenerationDimensions(fullCross, "image", fullCross[0]!);
  const crossDims = crossDimsAll
    .filter((dimension) => dimension.key !== "model_label"); // 参数 popover 口径(模型行进模型 popover)
  assert.ok(crossDims.every((dimension) => !dimension.single), "前置:参数维度全多值");
  assert.equal(dimensionPopoverFooter(crossDims, crossDimsAll), undefined, "全可点时不得恒显「即将开放」");
});

/* ---------- S83d:「只有一档」判定只吃全量维度,子集单值≠只有一档 ---------- */

test("S83d footer 判定:模型子集全单值但全量有多值维度时,任何子集都不得说「只有一档」", () => {
  // demo 图片的真实形态:模型子集只有 model_label 一条(同标签档表→恒单值),
  // 参数子集比例/清晰度多值——S83b 拿子集 every(single) 判,模型浮层在五档齐开时
  // 对用户说「当前只开放这一档」(子集单值≠只有一档的当场假话),本轮修。
  const all = listGenerationDimensions(IMAGE_TIERS, "image", IMAGE_TIERS[0]!);
  const modelSubset = all.filter((dimension) => dimension.key === "model_label");
  const paramSubset = all.filter((dimension) => dimension.key !== "model_label");
  assert.ok(modelSubset.length === 1 && modelSubset.every((dimension) => dimension.single), "前置:模型子集只有一条且单值");
  assert.ok(all.some((dimension) => !dimension.single), "前置:全量有多值维度(档表不止一档)");
  assert.equal(
    dimensionPopoverFooter(modelSubset, all), MORE_TIERS_NOTE,
    "模型行是固定标签,全量非单档时出路说明=「更多档位即将开放」,不得出 SINGLE_TIER_NOTE",
  );
  assert.notEqual(
    dimensionPopoverFooter(paramSubset, all), SINGLE_TIER_NOTE,
    "参数子集同样不得出 SINGLE_TIER_NOTE",
  );
});

test("S83d footer 判定:全量单档时,模型/参数两个子集都如实说「当前只开放这一档」", () => {
  const all = listGenerationDimensions([VIDEO_TIERS[0]!], "video", VIDEO_TIERS[0]!);
  assert.ok(all.every((dimension) => dimension.single), "前置:单档下全量维度全 single");
  assert.equal(
    dimensionPopoverFooter(all.filter((dimension) => dimension.key === "model_label"), all),
    SINGLE_TIER_NOTE, "全量单档,模型浮层如实说",
  );
  assert.equal(
    dimensionPopoverFooter(all.filter((dimension) => dimension.key !== "model_label"), all),
    SINGLE_TIER_NOTE, "全量单档,参数浮层如实说",
  );
});

/* ---------- 音频参数维度(2026-08-18 用户裁定:音质/格式/时长,全落真实原子档) ---------- */

/** 音频档缩微代表(与种子档同口径:时长键=original_duration_seconds,音质=32k/48k,格式=mp3/wav)。 */
const AUDIO_TIERS: CapabilityTier[] = [
  tier({
    tier_id: "aud-a-32k-mp3-3s",
    media_type: "audio",
    model_label: "Seed Audio 1.0",
    display_name: "Seed Audio 1.0",
    params: { sample_rate: 32_000, format: "mp3", original_duration_seconds: 3 },
    price: { unit: "per_second", points: 3 },
  }),
  tier({
    tier_id: "aud-a-48k-mp3-3s",
    media_type: "audio",
    model_label: "Seed Audio 1.0",
    display_name: "Seed Audio 1.0",
    params: { sample_rate: 48_000, format: "mp3", original_duration_seconds: 3 },
    price: { unit: "per_second", points: 3 },
  }),
  tier({
    tier_id: "aud-a-48k-wav-10s",
    media_type: "audio",
    model_label: "Seed Audio 1.0",
    display_name: "Seed Audio 1.0",
    params: { sample_rate: 48_000, format: "wav", original_duration_seconds: 10 },
    price: { unit: "per_second", points: 3 },
  }),
  tier({
    tier_id: "aud-b-32k-mp3-3s",
    media_type: "audio",
    model_label: "Seed Audio 1.0 多语言",
    display_name: "Seed Audio 1.0 多语言",
    params: { sample_rate: 32_000, format: "mp3", original_duration_seconds: 3 },
    price: { unit: "per_second", points: 3 },
  }),
];

test("音频:时长维度读 original_duration_seconds(duration_seconds 回落),音质/格式按声明读取", () => {
  const anchor = AUDIO_TIERS[0]!;
  assert.equal(tierDimensionValue(anchor, "duration_seconds"), 3, "音频档声明 original_duration_seconds,统一读时长维度");
  assert.equal(tierDimensionValue(anchor, "sample_rate"), 32_000);
  assert.equal(tierDimensionValue(anchor, "format"), "mp3");
  assert.equal(tierDimensionValue(anchor, "generate_audio"), undefined, "音频无 generate_audio 声明");
  assert.deepEqual(tierDeclaredKeys(anchor, "audio"), ["model_label", "sample_rate", "format", "duration_seconds"]);
});

test("音频:维度值标签——音质 kHz、格式大写、时长秒", () => {
  assert.equal(dimensionValueLabel("sample_rate", 48_000), "48kHz");
  assert.equal(dimensionValueLabel("sample_rate", 32_000), "32kHz");
  assert.equal(dimensionValueLabel("format", "mp3"), "MP3");
  assert.equal(dimensionValueLabel("format", "wav"), "WAV");
  assert.equal(dimensionValueLabel("duration_seconds", 10), "10 秒");
});

test("音频:摘要条拼音质/格式/时长", () => {
  assert.equal(tierDimensionSummary(AUDIO_TIERS[0]!), "3 秒 · 32kHz · MP3");
  assert.equal(tierDimensionSummary(AUDIO_TIERS[2]!), "10 秒 · 48kHz · WAV");
});

test("音频:listGenerationDimensions 维度行=模型/音质/格式/时长,值域只来自 active 档", () => {
  const current = AUDIO_TIERS[0]!; // 32k·mp3·3s
  const dimensions = listGenerationDimensions(AUDIO_TIERS, "audio", current);
  const byKey = Object.fromEntries(dimensions.map((dimension) => [dimension.key, dimension]));
  assert.deepEqual(Object.keys(byKey), ["model_label", "sample_rate", "format", "duration_seconds"], "音频维度行顺序=模型/音质/格式/时长");
  assert.deepEqual(byKey.sample_rate?.options.map((option) => [option.value, option.label]), [[32_000, "32kHz"], [48_000, "48kHz"]], "音质值域=32k/48k(升序)");
  assert.deepEqual(byKey.format?.options.map((option) => option.label), ["MP3", "WAV"], "格式值域=MP3/WAV(数据真源大写)");
  assert.deepEqual(byKey.duration_seconds?.options.map((option) => option.value), [3, 10], "时长值域=3s/10s");
  // 当前 32k·mp3·3s 改音质 48k:存在 48k·mp3·3s(共享格式/时长一致)→ 可行
  const sampleRate48 = byKey.sample_rate!.options.find((option) => option.value === 48_000)!;
  assert.equal(sampleRate48.feasible, true, "32k·mp3·3s → 48k:有 48k·mp3·3s 档,应可行");
  // 当前 32k·mp3·3s 改格式 wav:只有 48k·wav·10s,共享音质/时长不一致 → 置灰
  const formatWav = byKey.format!.options.find((option) => option.value === "wav")!;
  assert.equal(formatWav.feasible, false, "32k·mp3·3s → wav:无 32k·wav 档,应置灰");
});

test("音频:维度反查改音质命中同模型同格式同时长档,查无组合返回 null", () => {
  const current = AUDIO_TIERS[0]!; // 32k·mp3·3s
  assert.equal(resolveDimensionPick(AUDIO_TIERS, current, "audio", "sample_rate", 48_000)?.tier_id, "aud-a-48k-mp3-3s");
  assert.equal(resolveDimensionPick(AUDIO_TIERS, current, "audio", "format", "wav"), null, "32k 无 wav 档 → null(界面置灰)");
  assert.equal(resolveDimensionPick(AUDIO_TIERS, current, "audio", "model_label", "Seed Audio 1.0 多语言")?.tier_id, "aud-b-32k-mp3-3s", "跨模型改选命中另一模型的 32k·mp3·3s");
});
