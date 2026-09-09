import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveReferenceMode,
  assertAudioSource,
  generationNativeCapability,
  normalizeV01Parameters,
  normalizeV01References,
  readReferenceSnapshots,
  referenceManifest,
  V01GenerationContractError,
  ARK_SEEDREAM_5_MODEL,
  ARK_SEEDREAM_5_PRO_MODEL,
  ARK_SEEDANCE_1_LITE_I2V_MODEL,
  ARK_SEEDANCE_2_FAST_MODEL,
  ARK_SEEDANCE_2_MODEL,
  ARK_SEEDANCE_2_MINI_MODEL,
  ARK_SEEDANCE_2_5_MODEL,
  ARK_SEEDANCE_2_5_ENDPOINT_MODEL,
  ARK_WAN_FLF2V_MODEL,
  ARK_WAN_I2V_MODEL,
  NANOBANANA_2_MODEL,
  NANOBANANA_LITE_MODEL,
  SUCHUANG_GPT_IMAGE_2_MODEL,
  V01_VIDEO_MODEL,
  HAPPYHORSE_R2V_MODEL,
} from "./v01Contract.js";

function imageReferences(count: number): Array<{ kind: "image"; url: string }> {
  return Array.from({ length: count }, (_, index) => ({
    kind: "image",
    url: `https://assets.test/reference-${index}.png`,
  }));
}

function videoReferences(count: number): Array<{ kind: "video"; url: string }> {
  return Array.from({ length: count }, (_, index) => ({
    kind: "video",
    url: `https://assets.test/reference-${index}.mp4`,
  }));
}

function audioReferences(count: number): Array<{ kind: "audio"; url: string }> {
  return Array.from({ length: count }, (_, index) => ({
    kind: "audio",
    url: `https://assets.test/reference-${index}.mp3`,
  }));
}

test("Seed Audio 固化时长、字幕和隐式水印默认值，并限制滑杆范围", () => {
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "audio",
    model: "deployment-configured-audio-model",
    quantity: 1,
    parameters: { originalDurationSeconds: 12, format: "mp3", speechRate: 10 },
  }), {
    originalDurationSeconds: 12,
    format: "mp3",
    speechRate: 10,
    enableSubtitle: true,
    aigcMetadataEnabled: true,
    aigcWatermarkEnabled: false,
  });
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "audio", model: "deployment-configured-audio-model", quantity: 1,
    parameters: { originalDurationSeconds: 121 },
  }), /1 到 120 秒/);
});

test("Seed Audio 支持纯文本、speaker、参考音频或单张参考图片四种互斥来源", () => {
  const references = normalizeV01References("audio", [{ kind: "audio", url: "https://assets.test/ref.mp3" }]);
  const imageReference = normalizeV01References("audio", [{ kind: "image", url: "https://assets.test/ref.png" }]);
  assert.doesNotThrow(() => assertAudioSource({}, []));
  assert.doesNotThrow(() => assertAudioSource({ speakerId: "voice-1" }, []));
  assert.doesNotThrow(() => assertAudioSource({}, references));
  assert.doesNotThrow(() => assertAudioSource({}, imageReference));
  assert.throws(() => assertAudioSource({ speakerId: "voice-1" }, references), /不能混用/);
});

test("Seed Audio 图片参考只允许一张，图片和音频不能混用", () => {
  assert.throws(
    () => normalizeV01References("audio", [
      { kind: "image", url: "https://assets.test/ref-1.png" },
      { kind: "image", url: "https://assets.test/ref-2.png" },
    ]),
    /最多支持 1 张图片参考/,
  );
  assert.throws(
    () => normalizeV01References("audio", [
      { kind: "image", url: "https://assets.test/ref.png" },
      { kind: "audio", url: "https://assets.test/ref.mp3" },
    ]),
    /图片参考和音频参考不能同时使用/,
  );
});

test("全能参考合同接受图片和视频，并保留它们的控制角色", () => {
  assert.deepEqual(normalizeV01References("video", [
    { kind: "image", url: "https://assets.test/character.png" },
    { kind: "video", url: "https://assets.test/motion.mp4" },
  ]), [
    { kind: "image", url: "https://assets.test/character.png", role: "reference_image" },
    { kind: "video", url: "https://assets.test/motion.mp4", role: "reference_video" },
  ]);
});

test("多模态参考放行音频，缺省角色一律显式落到 reference_*", () => {
  assert.deepEqual(normalizeV01References("video", [
    { kind: "image", url: "https://assets.test/character.png" },
    { kind: "audio", url: "https://assets.test/dialogue.mp3" },
  ]), [
    { kind: "image", url: "https://assets.test/character.png", role: "reference_image" },
    { kind: "audio", url: "https://assets.test/dialogue.mp3", role: "reference_audio" },
  ]);
});

test("参考集不能只包含音频", () => {
  assert.throws(
    () => normalizeV01References("video", [
      { kind: "audio", url: "https://assets.test/dialogue.mp3" },
    ]),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("不能只包含音频"),
  );
});

test("参考音频最多 3 段", () => {
  assert.throws(
    () => normalizeV01References("video", [
      { kind: "image", url: "https://assets.test/character.png" },
      { kind: "audio", url: "https://assets.test/a1.mp3" },
      { kind: "audio", url: "https://assets.test/a2.mp3" },
      { kind: "audio", url: "https://assets.test/a3.mp3" },
      { kind: "audio", url: "https://assets.test/a4.mp3" },
    ]),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("最多支持 3 段参考音频"),
  );
});

test("Seedance 2.5 两种模型标识均按官方 30/10/10 上限接收参考素材", () => {
  for (const model of [ARK_SEEDANCE_2_5_MODEL, ARK_SEEDANCE_2_5_ENDPOINT_MODEL]) {
    assert.equal(normalizeV01References("video", imageReferences(30), model).length, 30);
    assert.throws(
      () => normalizeV01References("video", imageReferences(31), model),
      /当前最多支持 30 张参考图/,
    );
    assert.equal(normalizeV01References("video", videoReferences(10), model).length, 10);
    assert.throws(
      () => normalizeV01References("video", videoReferences(11), model),
      /当前最多支持 10 段参考视频/,
    );
    assert.equal(
      normalizeV01References("video", [...imageReferences(1), ...audioReferences(10)], model).length,
      11,
    );
    assert.throws(
      () => normalizeV01References("video", [...imageReferences(1), ...audioReferences(11)], model),
      /当前最多支持 10 段参考音频/,
    );
    assert.deepEqual(generationNativeCapability("video", model)?.motion, {
      durationSeconds: { min: 4, max: 15, step: 1 },
      referenceImageLimit: 30,
      referenceVideoLimit: 10,
      referenceAudioLimit: 10,
      generateAudio: true,
    });
  }
});

test("Seedance 2.0 full/fast/mini 继续按官方 9/3/3 上限拒绝超量参考", () => {
  for (const model of [ARK_SEEDANCE_2_MODEL, ARK_SEEDANCE_2_FAST_MODEL, ARK_SEEDANCE_2_MINI_MODEL]) {
    assert.equal(normalizeV01References("video", imageReferences(9), model).length, 9);
    assert.throws(
      () => normalizeV01References("video", imageReferences(10), model),
      /当前最多支持 9 张参考图/,
    );
    assert.equal(normalizeV01References("video", videoReferences(3), model).length, 3);
    assert.throws(
      () => normalizeV01References("video", videoReferences(4), model),
      /当前最多支持 3 段参考视频/,
    );
    assert.equal(
      normalizeV01References("video", [...imageReferences(1), ...audioReferences(3)], model).length,
      4,
    );
    assert.throws(
      () => normalizeV01References("video", [...imageReferences(1), ...audioReferences(4)], model),
      /当前最多支持 3 段参考音频/,
    );
  }
});

test("来源待核的 i2v/flf2v/r2v 模型逐字保持 legacy 9/3/3 运行时行为", () => {
  for (const model of [
    ARK_SEEDANCE_1_LITE_I2V_MODEL,
    ARK_WAN_I2V_MODEL,
    ARK_WAN_FLF2V_MODEL,
    HAPPYHORSE_R2V_MODEL,
  ]) {
    assert.equal(normalizeV01References("video", imageReferences(1), model).length, 1);
    assert.throws(
      () => normalizeV01References("video", imageReferences(10), model),
      /当前最多支持 9 张参考图/,
    );
    assert.throws(
      () => normalizeV01References("video", videoReferences(4), model),
      /当前最多支持 3 段参考视频/,
    );
    assert.throws(
      () => normalizeV01References("video", [...imageReferences(1), ...audioReferences(4)], model),
      /当前最多支持 3 段参考音频/,
    );
    assert.equal(generationNativeCapability("video", model)?.motion?.referenceImageLimit, 9);
    assert.equal(generationNativeCapability("video", model)?.motion?.referenceVideoLimit, 3);
    assert.equal(generationNativeCapability("video", model)?.motion?.referenceAudioLimit, 3);
  }
});

test("音频参考不接受其它角色，也不接受火山注册引用", () => {
  assert.throws(
    () => normalizeV01References("video", [
      { kind: "image", url: "https://assets.test/character.png" },
      { kind: "audio", url: "https://assets.test/dialogue.mp3", role: "first_frame" },
    ]),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("用途不适用于当前视频生成方式"),
  );
  assert.throws(
    () => normalizeV01References("video", [
      { kind: "image", url: "https://assets.test/character.png" },
      { kind: "audio", url: "asset://Asset-registered" },
    ], V01_VIDEO_MODEL),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("暂不支持用于音频参考"),
  );
});

test("锚帧组与多模态参考组混用被服务端拒绝", () => {
  assert.throws(
    () => normalizeV01References("video", [
      { kind: "image", url: "https://assets.test/prop.png", role: "reference_image" },
      { kind: "image", url: "https://assets.test/first.png", role: "first_frame" },
    ]),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("不能混用"),
  );
  assert.throws(
    () => normalizeV01References("video", [
      { kind: "video", url: "https://assets.test/motion.mp4" },
      { kind: "image", url: "https://assets.test/first.png", role: "first_frame" },
      { kind: "image", url: "https://assets.test/last.png", role: "last_frame" },
    ]),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("不能混用"),
  );
});

test("锚帧组单独成立：首帧必备，尾帧可选但不能单独出现", () => {
  assert.deepEqual(normalizeV01References("video", [
    { kind: "image", url: "https://assets.test/first.png", role: "first_frame" },
    { kind: "image", url: "https://assets.test/last.png", role: "last_frame" },
  ]), [
    { kind: "image", url: "https://assets.test/first.png", role: "first_frame" },
    { kind: "image", url: "https://assets.test/last.png", role: "last_frame" },
  ]);
  assert.throws(
    () => normalizeV01References("video", [
      { kind: "image", url: "https://assets.test/last.png", role: "last_frame" },
    ]),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("尾帧需要与首帧一起使用"),
  );
});

test("图片生成的参考图不接受首帧尾帧角色", () => {
  assert.throws(
    () => normalizeV01References("image", [
      { kind: "image", url: "https://assets.test/first.png", role: "first_frame" },
    ]),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("首帧和尾帧只用于视频生成"),
  );
});

test("火山已注册素材只允许作为当前 Seedance 的普通视频参考", () => {
  assert.deepEqual(normalizeV01References("video", [
    { kind: "image", url: "asset://Asset-registered" },
  ], V01_VIDEO_MODEL), [
    { kind: "image", url: "asset://Asset-registered", role: "reference_image" },
  ]);

  assert.throws(
    () => normalizeV01References("video", [
      { kind: "image", url: "asset://Asset-registered", role: "first_frame" },
    ], V01_VIDEO_MODEL),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("首帧或尾帧"),
  );
  assert.throws(
    () => normalizeV01References("image", [
      { kind: "image", url: "asset://Asset-registered" },
    ], "seedream-5-0-pro"),
    (error: unknown) => error instanceof V01GenerationContractError
      && error.message.includes("只能用于视频生成"),
  );
});

test("Seedance 2.0 请求体不得携带 seed/camera_fixed/frames/draft 等不支持参数", () => {
  for (const parameters of [
    { seed: 42 },
    { camera_fixed: true },
    { frames: 121 },
    { draft: true },
  ]) {
    assert.throws(
      () => normalizeV01Parameters({
        mediaKind: "video",
        model: V01_VIDEO_MODEL,
        parameters,
        quantity: 1,
      }),
      (error: unknown) => error instanceof V01GenerationContractError
        && error.message.includes("当前生成档位不支持这些设置"),
    );
  }
});

test("Seedream 将独立的清晰度与画幅实际编译为方舟可识别的 WxH size", () => {
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "image", model: ARK_SEEDREAM_5_PRO_MODEL, quantity: 1,
    parameters: { resolution: "2K", ratio: "16:9" },
  }), {
    size: "2048x1152", ratio: "16:9", watermark: false, sequentialImageGeneration: "disabled",
  });
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "image", model: ARK_SEEDREAM_5_PRO_MODEL, quantity: 1,
    parameters: { resolution: "2K", ratio: "9:16" },
  }), {
    size: "1152x2048", ratio: "9:16", watermark: false, sequentialImageGeneration: "disabled",
  });
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "image", model: ARK_SEEDREAM_5_PRO_MODEL, quantity: 1,
    parameters: { resolution: "2K", ratio: "1:1" },
  }), {
    size: "1536x1536", ratio: "1:1", watermark: false, sequentialImageGeneration: "disabled",
  });
});

test("G7:最低成本 1K 竖屏档编译后的高严格大于宽", () => {
  const parameters = normalizeV01Parameters({
    mediaKind: "image",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    quantity: 1,
    parameters: { resolution: "1K", ratio: "9:16" },
  });
  assert.equal(parameters.size, "768x1366");
  const [width, height] = String(parameters.size).split("x").map(Number);
  assert.ok(height! > width!, `竖屏尺寸必须高于宽，实际 ${parameters.size}`);
});

test("图片清晰度非法或与分辨率冲突时明确拒绝，不能静默回退默认 2K", () => {
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "image",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    parameters: { size: "5K" },
    quantity: 1,
  }), /图片清晰度仅支持/);
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "image",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    parameters: { size: "1K", resolution: "2K" },
    quantity: 1,
  }), /不能同时填写不同的值/);
});

test("Seedream 各正式模型只接受官方声明的清晰度与连续组图能力", () => {
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "image", model: ARK_SEEDREAM_5_PRO_MODEL, quantity: 1,
    parameters: { resolution: "3K" },
  }), /不支持 3K/);
  // `disabled` is a product-level no-op. The Pro adapter omits the vendor
  // field entirely, so retaining this legacy value does not send an
  // unsupported field to Ark.
  assert.doesNotThrow(() => normalizeV01Parameters({
    mediaKind: "image", model: ARK_SEEDREAM_5_PRO_MODEL, quantity: 1,
    parameters: { sequentialImageGeneration: "disabled" },
  }));
  assert.doesNotThrow(() => normalizeV01Parameters({
    mediaKind: "image", model: ARK_SEEDREAM_5_MODEL, quantity: 1,
    parameters: { resolution: "3K", ratio: "1:1", sequentialImageGeneration: "disabled" },
  }));
});

test("Seedance 2.0 系列按模型开放分辨率、画幅和时长", () => {
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_FAST_MODEL, quantity: 1,
    parameters: { resolution: "720p", ratio: "16:9", durationSeconds: 8, generateAudio: false },
  }), {
    resolution: "720p", ratio: "16:9", durationSeconds: 8, watermark: false,
    generateAudio: false,
  });
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_MODEL, quantity: 1,
    parameters: { resolution: "4k", ratio: "21:9", durationSeconds: 15 },
  }), {
    resolution: "4k", ratio: "21:9", durationSeconds: 15, watermark: false,
    generateAudio: true,
  });
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_MODEL, quantity: 1,
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: -1 },
  }), /智能时长的计费规则尚未开放/);
  assert.doesNotThrow(() => normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_MINI_MODEL, quantity: 1,
    parameters: { resolution: "480p", ratio: "adaptive", durationSeconds: 15 },
  }));
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_FAST_MODEL, quantity: 1,
    parameters: { resolution: "1080p" },
  }), /不支持 1080p/);
});

test("HappyHorse 预览档按快乐马能力表归一化:3 档清晰度/9 种画幅/3–15 秒(2026-08-19 参数化裁定)", () => {
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "1080p", ratio: "16:9", durationSeconds: 5 },
  }), {
    resolution: "1080p", ratio: "16:9", durationSeconds: 5, watermark: false,
    generateAudio: true,
  });
  assert.doesNotThrow(() => normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "480p", ratio: "9:21", durationSeconds: 3 },
  }), "480p + 9:21 + 3 秒:快乐马能力下边界");
  assert.doesNotThrow(() => normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "720p", ratio: "4:5", durationSeconds: 15 },
  }), "720p + 4:5 + 15 秒:快乐马独占画幅 + 上边界");
  assert.doesNotThrow(() => normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "720p", ratio: "5:4", durationSeconds: 8 },
  }), "5:4 也是快乐马画幅白名单成员");
  // 快乐马无 adaptive 画幅、无 2K/4K 清晰度、时长限 3–15;非快乐马模型沿用旧边界。
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "2K", ratio: "16:9", durationSeconds: 5 },
  }), /当前视频模型不支持 2K，可选：480p、720p、1080p/);
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "4k", ratio: "16:9", durationSeconds: 5 },
  }), /当前视频模型不支持 4k/);
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "720p", ratio: "adaptive", durationSeconds: 5 },
  }), /当前视频模型画幅仅支持 16:9、9:16、3:4、4:3、4:5、5:4、1:1、9:21、21:9/);
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "720p", ratio: "16:9", durationSeconds: 2 },
  }), /视频时长仅支持 3 到 15 秒/);
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: HAPPYHORSE_R2V_MODEL, quantity: 1,
    parameters: { resolution: "720p", ratio: "16:9", durationSeconds: 16 },
  }), /视频时长仅支持 3 到 15 秒/);
});

test("Seedance 2.5 专用接入点 ep 按 2.5 能力表归一化：720p/9:16/4s", () => {
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_5_ENDPOINT_MODEL, quantity: 1,
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
  }), {
    resolution: "720p", ratio: "9:16", durationSeconds: 4, watermark: false,
    generateAudio: true,
  });
  // 与 2.5 裸模型同一张能力表：1080p 可选，480p 不在档内。
  assert.doesNotThrow(() => normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_5_ENDPOINT_MODEL, quantity: 1,
    parameters: { resolution: "1080p", durationSeconds: 15 },
  }));
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_5_ENDPOINT_MODEL, quantity: 1,
    parameters: { resolution: "480p" },
  }), /不支持 480p/);
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "video", model: ARK_SEEDANCE_2_5_ENDPOINT_MODEL, quantity: 1,
    parameters: { returnLastFrame: true },
  }), /不支持这些设置/);
});

test("临时图片网关逐模型保留独立参数矩阵", () => {
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "image",
    model: SUCHUANG_GPT_IMAGE_2_MODEL,
    quantity: 1,
    parameters: { ratio: "9:21" },
  }), { size: "9:21" });
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "image",
    model: NANOBANANA_LITE_MODEL,
    quantity: 1,
    parameters: { size: "1K", ratio: "5:4" },
  }), { size: "1K", aspectRatio: "5:4" });
  assert.deepEqual(normalizeV01Parameters({
    mediaKind: "image",
    model: NANOBANANA_2_MODEL,
    quantity: 1,
    parameters: { size: "4K", ratio: "1:8" },
  }), { size: "4K", aspectRatio: "1:8" });
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "image",
    model: NANOBANANA_LITE_MODEL,
    quantity: 1,
    parameters: { size: "1K", ratio: "1:8" },
  }), /不受当前图片模型支持/);
  assert.throws(() => normalizeV01Parameters({
    mediaKind: "image",
    model: NANOBANANA_LITE_MODEL,
    quantity: 1,
    parameters: { size: "2K", ratio: "1:1" },
  }), /不受当前图片模型支持/);
});

test("generate_audio 显式传值：缺省显式落 true，显式 false 原样保留", () => {
  const defaulted = normalizeV01Parameters({
    mediaKind: "video",
    model: V01_VIDEO_MODEL,
    parameters: {},
    quantity: 1,
  });
  assert.equal(defaulted.generateAudio, true);
  const disabled = normalizeV01Parameters({
    mediaKind: "video",
    model: V01_VIDEO_MODEL,
    parameters: { generateAudio: false },
    quantity: 1,
  });
  assert.equal(disabled.generateAudio, false);
});

test("A5 模式派生:空参考集=text_only,参考组=multimodal_reference,锚帧组=anchor_frames", () => {
  assert.equal(deriveReferenceMode([]), "text_only");
  assert.equal(deriveReferenceMode([
    { kind: "image", url: "https://assets.test/a.png", role: "reference_image" },
    { kind: "audio", url: "https://assets.test/b.mp3", role: "reference_audio" },
  ]), "multimodal_reference");
  assert.equal(deriveReferenceMode([
    { kind: "image", url: "https://assets.test/f.png", role: "first_frame" },
  ]), "anchor_frames");
  assert.equal(deriveReferenceMode([
    { kind: "image", url: "https://assets.test/f.png", role: "first_frame" },
    { kind: "image", url: "https://assets.test/l.png", role: "last_frame" },
  ]), "anchor_frames");
});

test("A5 快照读取:历史脏数据防御性解析,非法项丢弃不炸读路径", () => {
  assert.deepEqual(readReferenceSnapshots(undefined), []);
  assert.deepEqual(readReferenceSnapshots("not-an-array"), []);
  assert.deepEqual(readReferenceSnapshots([
    { kind: "image", url: "https://assets.test/a.png", role: "reference_image", mediaId: "m-1" },
    { kind: "image" },
    null,
    { kind: "hologram", url: "https://assets.test/x" },
  ]), [
    { kind: "image", url: "https://assets.test/a.png", role: "reference_image", mediaId: "m-1" },
  ]);
});

test("A5 参考清单:缺 mediaId/role 的历史快照以 null 兜底", () => {
  assert.deepEqual(referenceManifest([
    { kind: "image", url: "https://assets.test/a.png", role: "reference_image", mediaId: "m-1" },
    { kind: "video", url: "https://assets.test/b.mp4" },
  ]), [
    { mediaId: "m-1", kind: "image", role: "reference_image" },
    { mediaId: null, kind: "video", role: null },
  ]);
});
