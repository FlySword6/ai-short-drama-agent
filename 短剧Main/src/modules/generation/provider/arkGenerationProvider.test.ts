import assert from "node:assert/strict";
import test from "node:test";
import {
  ARK_SEEDANCE_2_FAST_MODEL,
  ARK_SEEDANCE_2_MINI_MODEL,
  ARK_SEEDANCE_2_MODEL,
  ARK_SEEDREAM_5_PRO_MODEL,
} from "../v01Contract.js";
import { ArkGenerationProvider } from "./arkGenerationProvider.js";

test("Seedream 请求将画幅落实为 WxH size，不把未识别 ratio 字段发给供应商", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new ArkGenerationProvider({
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        data: [{ url: "https://provider.example.test/image.png" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  await provider.submit({
    mediaKind: "image",
    model: ARK_SEEDREAM_5_PRO_MODEL,
    prompt: "雨夜街道",
    quantity: 1,
    parameters: { resolution: "2K", ratio: "9:16" },
    references: [],
  });

  assert.equal(body?.size, "1152x2048");
  assert.equal("ratio" in (body ?? {}), false);
});

for (const item of [
  { model: ARK_SEEDANCE_2_MODEL, resolution: "1080p", ratio: "16:9", durationSeconds: 15 },
  { model: ARK_SEEDANCE_2_FAST_MODEL, resolution: "720p", ratio: "9:16", durationSeconds: 8 },
  { model: ARK_SEEDANCE_2_MINI_MODEL, resolution: "480p", ratio: "1:1", durationSeconds: 4 },
] as const) {
  test(`视频模型参数进入真实请求体：${item.model}`, async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new ArkGenerationProvider({
      apiKey: "test-key",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: "task-1", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const result = await provider.submit({
      mediaKind: "video",
      model: item.model,
      prompt: "人物从雨夜街道走向镜头",
      quantity: 1,
      parameters: {
        resolution: item.resolution,
        ratio: item.ratio,
        durationSeconds: item.durationSeconds,
        generateAudio: true,
      },
      references: [],
    });

    assert.equal(result.outcome, "accepted");
    assert.equal(body?.model, item.model);
    assert.equal(body?.resolution, item.resolution);
    assert.equal(body?.ratio, item.ratio);
    assert.equal(body?.duration, item.durationSeconds);
    assert.equal(body?.generate_audio, true);
  });
}

function videoTextPart(body: Record<string, unknown> | undefined): string {
  const content = Array.isArray(body?.content) ? body.content : [];
  const first = content.find((part) => (part as Record<string, unknown>)?.type === "text");
  return String((first as Record<string, unknown> | undefined)?.text ?? "");
}

async function submitSeedanceVideo(
  references: { kind: "image" | "video" | "audio"; url: string; role?: string }[],
  prompt = "陈默站在天台边缘，镜头缓缓推近",
): Promise<Record<string, unknown> | undefined> {
  let body: Record<string, unknown> | undefined;
  const provider = new ArkGenerationProvider({
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "task-1", status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  await provider.submit({
    mediaKind: "video",
    model: ARK_SEEDANCE_2_FAST_MODEL,
    prompt,
    quantity: 1,
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
    references,
  });
  return body;
}

test("参考素材必须在提示词里被「图片1」指代，否则 Seedance 判 InvalidParameter", async () => {
  const body = await submitSeedanceVideo([
    { kind: "image", url: "asset://asset-20260807122129-68pnb", role: "reference_image" },
  ]);

  const text = videoTextPart(body);
  assert.ok(
    text.includes("图片1"),
    `提示词必须指代「图片1」，实际发出的是：${text}`,
  );
  assert.ok(
    !text.includes("asset-20260807122129-68pnb"),
    "Asset ID 不得出现在提示词里（火山文档明确禁止）",
  );
  assert.ok(text.includes("陈默站在天台边缘"), "原提示词内容必须保留");
});

test("全能参考直链以 reference_image 进入供应商请求，绝不被当作首帧", async () => {
  const body = await submitSeedanceVideo([
    { kind: "image", url: "https://tos.example.test/finals/shot.png", role: "reference_image" },
  ]);
  const content = Array.isArray(body?.content) ? body.content as Array<Record<string, unknown>> : [];
  const images = content.filter((part) => part.type === "image_url");
  assert.equal(images.length, 1);
  assert.equal(images[0]?.role, "reference_image");
  assert.equal(images.some((part) => part.role === "first_frame"), false);
  assert.deepEqual(images[0]?.image_url, { url: "https://tos.example.test/finals/shot.png" });
  assert.match(videoTextPart(body), /图片1/u);
});

test("多个同类素材按请求体顺序编号，不同模态各自从 1 起编", async () => {
  const body = await submitSeedanceVideo([
    { kind: "image", url: "asset://asset-a", role: "reference_image" },
    { kind: "image", url: "asset://asset-b", role: "reference_image" },
    { kind: "audio", url: "https://tos.example.test/voice.mp3", role: "reference_audio" },
  ]);

  const text = videoTextPart(body);
  assert.ok(text.includes("图片1"), `缺图片1：${text}`);
  assert.ok(text.includes("图片2"), `缺图片2：${text}`);
  assert.ok(text.includes("音频1"), `音频应从 1 起编：${text}`);
  assert.ok(!text.includes("图片3"), `只有两张图，不该出现图片3：${text}`);
});

test("首尾帧不是参考素材，不参与图片编号", async () => {
  const body = await submitSeedanceVideo([
    { kind: "image", url: "https://tos.example.test/first.jpg", role: "first_frame" },
  ], "从这一帧开始向前推进");

  assert.equal(videoTextPart(body), "从这一帧开始向前推进");
});

test("没有参考素材时不注入任何指代，提示词原样发出", async () => {
  const body = await submitSeedanceVideo([], "纯文生视频提示词");

  assert.equal(videoTextPart(body), "纯文生视频提示词");
});
