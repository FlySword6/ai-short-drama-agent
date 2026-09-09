/* lite-generation.test.ts — Lite 生成链路共享模块纯函数单测(node:test 直跑)。
   本文件只测纯函数(cheapestActiveTier 等),不渲染组件;
   直接 import lite-generation.ts(纯逻辑,无 DOM 副作用,tsx 可直跑)。

   cheapestActiveTier 计价口径(2026-08-18 音频参数改造定稿):
   按「单次生成总价」比——图片 档价×张数、视频/音频 档价×秒数(demoEstimatePoints)。
   若按裸 price.points 比,按秒计价的同单价档(如音频 3 积分/秒)全平手,
   时长档靠 tier_id 字典序决胜 → 10s("10s"<"3s")压过 3s,切音质/格式时把
   用户静默抬到 3 倍费用。总价口径下最短=最省,默认落 3s。 */
import assert from "node:assert/strict";
import test from "node:test";

import type { CapabilityTier } from "./capability-tiers";
import { cheapestActiveTier, clampPreviewDuration, formalVideoTiers, previewEstimatePoints, previewVideoTiers, readLitePreviewRequestIds, rememberLitePreviewRequest } from "./pages/lite/lite-generation";

/** 音频档缩微代表(与种子档同口径:时长键=original_duration_seconds,音质=32k/48k,格式=mp3/wav)。
    种子 16 档全部 unit_price_fen=3/秒 → 同模型同音质同格式下只有时长分档,正是
    旧 tie-break(裸 points+tier_id 字典序)会静默选 10s 的场景。 */
const AUDIO_TIERS: CapabilityTier[] = [
  audioTier("aud-seedaudio10-32k-mp3-3s", "Seed Audio 1.0", 32_000, "mp3", 3),
  audioTier("aud-seedaudio10-32k-mp3-10s", "Seed Audio 1.0", 32_000, "mp3", 10),
  audioTier("aud-seedaudio10-32k-wav-3s", "Seed Audio 1.0", 32_000, "wav", 3),
  audioTier("aud-seedaudio10-32k-wav-10s", "Seed Audio 1.0", 32_000, "wav", 10),
  audioTier("aud-seedaudio10-48k-mp3-3s", "Seed Audio 1.0", 48_000, "mp3", 3),
  audioTier("aud-seedaudio10-48k-mp3-10s", "Seed Audio 1.0", 48_000, "mp3", 10),
  audioTier("aud-seedaudio10-multilingual-32k-mp3-3s", "Seed Audio 1.0 多语言", 32_000, "mp3", 3),
  audioTier("aud-seedaudio10-multilingual-32k-mp3-10s", "Seed Audio 1.0 多语言", 32_000, "mp3", 10),
];

function audioTier(tier_id: string, model_label: string, sample_rate: number, format: string, original_duration_seconds: number): CapabilityTier {
  return {
    tier_id,
    model_label,
    display_name: model_label,
    provider_label: "火山方舟",
    media_type: "audio",
    params: { sample_rate, format, original_duration_seconds },
    price: { unit: "per_second", points: 3 },
    status: "active",
  };
}

test("cheapestActiveTier:音频按秒计价同单价下,时长档取最短(3s 总价 9 压过 10s 总价 30)", () => {
  // 同模型同音质同格式,只有时长分档:旧 tie-break 靠 tier_id 字典序选 "…-10s"("10s"<"3s")
  const bucket = AUDIO_TIERS.filter((t) => t.params.sample_rate === 32_000 && t.params.format === "mp3" && t.model_label === "Seed Audio 1.0");
  assert.equal(bucket.length, 2, "前置:该桶只有 3s/10s 两档");
  assert.equal(cheapestActiveTier(bucket)?.tier_id, "aud-seedaudio10-32k-mp3-3s", "切音质/格式落档不得静默抬到 10s(3 倍费用)");
  // 全量音质/格式/时长混桶:总价最低仍是 3s 档(9 积分)
  assert.equal(cheapestActiveTier(AUDIO_TIERS)?.tier_id, "aud-seedaudio10-32k-mp3-3s");
});

test("cheapestActiveTier:跨音质同 3s 时按 price.points 断价(48k 与 32k 同价则字典序),不按档名长度误判", () => {
  // 48k 与 32k 同为 3 积分/秒、同为 3s:总价相等 → 稳定字典序决胜(确定性,非崩溃)
  const threeSec = AUDIO_TIERS.filter((t) => t.params.original_duration_seconds === 3 && t.model_label === "Seed Audio 1.0");
  const best = cheapestActiveTier(threeSec);
  assert.ok(best !== undefined, "3s 桶应能落档");
  assert.ok(threeSec.some((t) => t.tier_id === best?.tier_id), "落档必须是桶内真实档(先有档再有界面)");
  assert.equal(best!.tier_id, "aud-seedaudio10-32k-mp3-3s", "同总价按 tier_id 字典序确定性取档");
});

test("cheapestActiveTier:图片 per_image 单价与总价相等,同价跨比例 tie-break 语义不变", () => {
  const imageTiers: CapabilityTier[] = [
    imageTier("img-seedream5pro-169-1k-1", "16:9", "1K", 30),
    imageTier("img-seedream5pro-916-1k-1", "9:16", "1K", 30),
    imageTier("img-seedream5pro-169-2k-1", "16:9", "2K", 60),
  ];
  assert.equal(cheapestActiveTier(imageTiers)?.tier_id, "img-seedream5pro-169-1k-1", "图片单价=总价,1K(30)压过 2K(60)");
  assert.equal(cheapestActiveTier(imageTiers.filter((t) => t.params.resolution === "1K"))?.tier_id, "img-seedream5pro-169-1k-1", "同 1K 同价按 tier_id 字典序(169<916)");
});

test("cheapestActiveTier:视频单桶(同模型同比例同清晰度只有一档)落档不变,总价口径不误伤", () => {
  const videoTiers: CapabilityTier[] = [
    videoTier("vid-seedance20fast-169-720p", "16:9", "720p", 8, 80),
    videoTier("vid-seedance20fast-169-480p", "16:9", "480p", 5, 40),
  ];
  assert.equal(cheapestActiveTier(videoTiers)?.tier_id, "vid-seedance20fast-169-480p", "总价 480p(40×5=200)压过 720p(80×8=640),与裸 points 同向");
  assert.equal(cheapestActiveTier([videoTiers[0]!])?.tier_id, "vid-seedance20fast-169-720p", "单桶直落,不因计价口径变化翻车");
});

function imageTier(tier_id: string, aspect_ratio: string, resolution: string, points: number): CapabilityTier {
  return {
    tier_id,
    model_label: "Seedream 5 Pro",
    display_name: "Seedream 5 Pro",
    provider_label: "火山方舟",
    media_type: "image",
    params: { aspect_ratio, resolution, quantity: 1 },
    price: { unit: "per_image", points },
    status: "active",
  };
}

function videoTier(tier_id: string, aspect_ratio: string, resolution: string, duration_seconds: number, points: number): CapabilityTier {
  return {
    tier_id,
    model_label: "Seedance 2.0 Fast",
    display_name: "Seedance 2.0 Fast",
    provider_label: "火山方舟",
    media_type: "video",
    params: { aspect_ratio, resolution, duration_seconds, quantity: 1 },
    price: { unit: "per_second", points },
    status: "active",
  };
}

/* ---------- 预览视频身份台账（2026-08-19） ---------- */

/** 最小 Storage 桩：sessionStorage/localStorage 同接口。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => { map.delete(key); },
    setItem: (key, value) => { map.set(key, value); },
  };
}

test("预览台账:初始为空,remember 后按 shotId 隔离且幂等去重", () => {
  const storage = memoryStorage();
  assert.deepEqual([...readLitePreviewRequestIds(storage, "shot-a")], [], "初始无预览请求");
  rememberLitePreviewRequest(storage, "shot-a", "req-1");
  rememberLitePreviewRequest(storage, "shot-a", "req-2");
  rememberLitePreviewRequest(storage, "shot-a", "req-1");
  assert.deepEqual([...readLitePreviewRequestIds(storage, "shot-a")], ["req-1", "req-2"], "同请求重复记只留一份,保序");
  assert.deepEqual([...readLitePreviewRequestIds(storage, "shot-b")], [], "不同镜互不污染");
});

test("预览台账:脏数据(非数组/非字符串项)静默跳过,不抛错", () => {
  const storage = memoryStorage();
  storage.setItem("lite:preview-video-request:shot-c", "not-json{");
  assert.deepEqual([...readLitePreviewRequestIds(storage, "shot-c")], [], "损坏 JSON 回落空集");
  storage.setItem("lite:preview-video-request:shot-c", JSON.stringify(["ok", 42, null, "ok2"]));
  assert.deepEqual([...readLitePreviewRequestIds(storage, "shot-c")], ["ok", "ok2"], "非字符串项过滤,字符串保序");
});

/* ---------- 生视频档池切分（2026-08-19 裁定：正式=seedance / 预览=快乐马） ---------- */

/** 快乐马预览档（DB 真值：provider_label=快乐马，params.preview=true）。 */
function happyHorsePreviewTier(overrides: Partial<CapabilityTier> = {}): CapabilityTier {
  return {
    tier_id: "happyhorse-preview-480p-5s",
    model_label: "happyhorse-1.1-r2v",
    display_name: "快乐马 · 预览",
    provider_label: "快乐马",
    media_type: "video",
    params: { preview: true, quantity: 1, watermark: false, resolution: "480p", aspect_ratio: "9:16", duration_seconds: 5 },
    price: { unit: "per_second", points: 8 },
    status: "active",
    ...overrides,
  };
}

test("formalVideoTiers:只收 active 非预览火山方舟视频档,快乐马(DB 与 DEMO 标签)全排除", () => {
  const pool: CapabilityTier[] = [
    videoTier("vid-seedance20fast-916-720p-4s", "9:16", "720p", 4, 80),
    videoTier("vid-seedance20fast-169-480p", "16:9", "480p", 5, 40),
    happyHorsePreviewTier(),
    /* DEMO 兜底快乐马档：provider_label=阿里云百炼（非火山方舟），同样被正式池排除。 */
    { ...videoTier("vid-demo-happyhorse-480p-5s", "9:16", "480p", 5, 8), provider_label: "阿里云百炼" },
    /* 非 video 不混入。 */
    imageTier("img-seedream5pro-169-1k-1", "16:9", "1K", 30),
  ];
  const formal = formalVideoTiers(pool);
  assert.deepEqual(formal.map((t) => t.tier_id), ["vid-seedance20fast-916-720p-4s", "vid-seedance20fast-169-480p"], "正式池 = 火山方舟非预览视频档");
  assert.ok(formal.every((t) => !t.params.preview && t.provider_label === "火山方舟"), "正式池不得含任何预览档/非 seedance");
});

test("formalVideoTiers:非 active 状态档(experimental/retired)不进正式池", () => {
  const experimental = videoTier("vid-seedance20fast-916-720p-4s-exp", "9:16", "720p", 4, 80);
  experimental.status = "experimental";
  const retired = videoTier("vid-seedance20fast-916-720p-4s-old", "9:16", "720p", 4, 80);
  retired.status = "retired";
  assert.deepEqual(formalVideoTiers([experimental, retired]), [], "只收 active");
});

test("previewVideoTiers:只收 active 快乐马预览档(video+preview=true),seedance 不混入", () => {
  const pool: CapabilityTier[] = [
    videoTier("vid-seedance20fast-916-720p-4s", "9:16", "720p", 4, 80),
    happyHorsePreviewTier(),
    { ...happyHorsePreviewTier(), tier_id: "happyhorse-preview-720p-5s", params: { preview: true, resolution: "720p" } },
    /* 预览档 retired 不进预览池。 */
    { ...happyHorsePreviewTier(), tier_id: "happyhorse-preview-old", status: "retired" },
  ];
  assert.deepEqual(previewVideoTiers(pool).map((t) => t.tier_id), ["happyhorse-preview-480p-5s", "happyhorse-preview-720p-5s"], "预览池 = active 视频预览档");
});

test("formal/preview 两池互斥且不共享档(同一 input 池分切结果不重叠)", () => {
  const seedance = videoTier("vid-seedance20fast-916-720p-4s", "9:16", "720p", 4, 80);
  const preview = happyHorsePreviewTier();
  const input = [seedance, preview];
  const formal = formalVideoTiers(input);
  const previews = previewVideoTiers(input);
  assert.equal(formal.length, 1);
  assert.equal(previews.length, 1);
  assert.notEqual(formal[0]!.tier_id, previews[0]!.tier_id, "正式生成与预览不在同一档");
});

/* ---------- 快乐马预览参数化助手（2026-08-19 裁定：比例/清晰度/时长在能力内可调） ---------- */

test("clampPreviewDuration:分镜时长收敛到快乐马 3–15 秒并取整", () => {
  assert.equal(clampPreviewDuration(4), 4, "4 秒在能力内原样保留(演示镜 4s)");
  assert.equal(clampPreviewDuration(3), 3, "下边界 3 秒保留");
  assert.equal(clampPreviewDuration(15), 15, "上边界 15 秒保留");
  assert.equal(clampPreviewDuration(2), 3, "2 秒被收敛到 3 秒下限");
  assert.equal(clampPreviewDuration(16), 15, "16 秒被收敛到 15 秒上限");
  assert.equal(clampPreviewDuration(12.4), 12, "12.4 四舍五入为 12");
  assert.equal(clampPreviewDuration(12.6), 13, "12.6 四舍五入为 13");
  assert.equal(clampPreviewDuration(NaN), 5, "非数字回落缺省 5 秒");
  assert.equal(clampPreviewDuration(null), 5, "null 回落缺省 5 秒");
  assert.equal(clampPreviewDuration(undefined), 5, "undefined 回落缺省 5 秒");
  assert.equal(clampPreviewDuration(undefined, 7), 7, "显式 fallback 优先");
});

test("previewEstimatePoints:per_second 预览档按实际覆盖时长计价,非 per_second 回落 demoEstimatePoints", () => {
  const preview = happyHorsePreviewTier(); // 8 积分/秒,登记 5s
  assert.equal(previewEstimatePoints(preview, 4), 32, "4 秒 × 8 点 = 32(不按档登记 5s 计 40)");
  assert.equal(previewEstimatePoints(preview, 8), 64, "8 秒 × 8 点 = 64(覆盖时长进计价)");
  // 非 per_second 档(图片)无时长维度,回落 demoEstimatePoints(档价×张数)。
  const image = imageTier("img-seedream5pro-169-1k-1", "16:9", "1K", 30);
  assert.equal(previewEstimatePoints(image, 4), 30, "per_image 档忽略时长参数");
});
