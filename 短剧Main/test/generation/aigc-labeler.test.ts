import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  AIGC_CONTENT_PRODUCER,
  AigcLabelingError,
  AigcMetadataLabeler,
  labelAigcMedia,
  readAigcImplicitLabel,
} from "../../src/modules/generation/aigcLabeler.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
// 最小 MPEG-1 Layer III frame header。标签器只承诺验证并保留音频帧，使用
// 内联 fixture 可以避免为单元测试在 CI 安装整套 ffmpeg 编码器。
const MINIMAL_MP3_FRAME = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
const MINIMAL_MP3_WITH_ID3 = Buffer.concat([
  Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  MINIMAL_MP3_FRAME,
]);

async function fixture(extension: "mp4" | "mp3"): Promise<{ bytes: Buffer; dispose: () => Promise<void> }> {
  if (extension === "mp3") {
    return { bytes: MINIMAL_MP3_WITH_ID3, dispose: async () => {} };
  }
  return {
    bytes: await readFile(path.join(repoRoot, "frontend/shortdrama-rag-demo/public/demo-media/ep1-shot-1.mp4")),
    dispose: async () => {},
  };
}

const expectedKeys = [
  "Label", "ContentProducer", "ProduceID", "ReservedCode1", "ContentPropagator", "PropagateID", "ReservedCode2",
];

test("writes and independently reads the seven-field TC260 label in JPEG and PNG", async () => {
  for (const [extension, contentType] of [["jpg", "image/jpeg"], ["png", "image/png"]] as const) {
    const source = await sharp({ create: { width: 16, height: 16, channels: 3, background: "black" } }).toFormat(extension === "jpg" ? "jpeg" : "png").toBuffer();
    const result = await labelAigcMedia({ content: source, mediaKind: "image", extension, contentType, produceId: `attempt-1:${extension}` });
    const read = await readAigcImplicitLabel(result.content, "image", extension);
    assert.deepEqual(Object.keys(read), expectedKeys);
    assert.equal(read.ContentProducer, AIGC_CONTENT_PRODUCER);
    assert.equal(read.ContentPropagator, AIGC_CONTENT_PRODUCER);
    assert.equal(read.ProduceID, `attempt-1:${extension}`);
    assert.equal(read.PropagateID, `attempt-1:${extension}`);
  }
});

test("writes MP4 XMP and repeat writes update the one label instead of appending", async () => {
  const input = await fixture("mp4");
  try {
    const first = await labelAigcMedia({ content: input.bytes, mediaKind: "video", extension: "mp4", contentType: "video/mp4", produceId: "attempt-1:0" });
    const second = await labelAigcMedia({ content: first.content, mediaKind: "video", extension: "mp4", contentType: "video/mp4", produceId: "attempt-1:1" });
    const read = await readAigcImplicitLabel(second.content, "video", "mp4");
    assert.equal(read.ProduceID, "attempt-1:1");
    assert.equal(read.PropagateID, "attempt-1:1");
  } finally {
    await input.dispose();
  }
});

test("writes MP3 ID3 TXXX AIGC plus XMP PRIV and keeps exactly one on update", async () => {
  const input = await fixture("mp3");
  const verificationDirectory = await mkdtemp(path.join(tmpdir(), "aigc-mp3-exiftool-"));
  try {
    const first = await labelAigcMedia({ content: input.bytes, mediaKind: "audio", extension: "mp3", contentType: "audio/mpeg", produceId: "attempt-2:0" });
    const second = await labelAigcMedia({ content: first.content, mediaKind: "audio", extension: "mp3", contentType: "audio/mpeg", produceId: "attempt-2:1" });
    const read = readAigcImplicitLabel(second.content, "audio", "mp3");
    assert.equal(read.ProduceID, "attempt-2:1");
    assert.equal(read.PropagateID, "attempt-2:1");
    assert.equal((second.content.toString("utf8").match(/AIGC/g) ?? []).length >= 2, true);
    const tagSize = ((second.content[6]! & 0x7f) << 21)
      | ((second.content[7]! & 0x7f) << 14)
      | ((second.content[8]! & 0x7f) << 7)
      | (second.content[9]! & 0x7f);
    assert.deepEqual(
      second.content.subarray(10 + tagSize - 10, 10 + tagSize),
      Buffer.alloc(10),
    );
    const outputFile = path.join(verificationDirectory, "labeled.mp3");
    await writeFile(outputFile, second.content);
    const metadata = execFileSync("exiftool", ["-a", "-G1", "-s", outputFile], { encoding: "utf8" });
    assert.doesNotMatch(metadata, /Missing ID3 terminating frame/);
  } finally {
    await input.dispose();
    await rm(verificationDirectory, { recursive: true, force: true });
  }
});

test("creates a v2.3 tag for a valid MP3 without ID3 and updates its UTF-16 TXXX", async () => {
  const input = await fixture("mp3");
  try {
    const tagSize = ((input.bytes[6]! & 0x7f) << 21) | ((input.bytes[7]! & 0x7f) << 14) | ((input.bytes[8]! & 0x7f) << 7) | (input.bytes[9]! & 0x7f);
    const noId3 = input.bytes.subarray(10 + tagSize);
    const first = await labelAigcMedia({ content: noId3, mediaKind: "audio", extension: "mp3", contentType: "audio/mpeg", produceId: "attempt-3:0" });
    assert.equal(first.content[3], 3);
    const second = await labelAigcMedia({ content: first.content, mediaKind: "audio", extension: "mp3", contentType: "audio/mpeg", produceId: "attempt-3:1" });
    const read = readAigcImplicitLabel(second.content, "audio", "mp3");
    assert.equal(read.ProduceID, "attempt-3:1");
  } finally {
    await input.dispose();
  }
});

test("fails closed for malformed MP3 instead of emitting unverified metadata", async () => {
  await assert.rejects(
    () => labelAigcMedia({ content: Buffer.from("ID3\x04\x00\x80\x00\x00\x00\x00broken"), mediaKind: "audio", extension: "mp3", contentType: "audio/mpeg", produceId: "attempt-bad:0" }),
    (error: unknown) => error instanceof AigcLabelingError && error.code === "AIGC_METADATA_ID3_UNSUPPORTED",
  );
});

test("fails closed when bytes have no ID3 tag and no MPEG audio frame", async () => {
  await assert.rejects(
    () => labelAigcMedia({ content: Buffer.from("plain arbitrary bytes"), mediaKind: "audio", extension: "mp3", contentType: "audio/mpeg", produceId: "attempt-bad:1" }),
    (error: unknown) => error instanceof AigcLabelingError && error.code === "AIGC_METADATA_MP3_INVALID",
  );
});

test("fails closed for corrupt image and video bytes", async () => {
  for (const [mediaKind, extension, contentType] of [
    ["image", "jpg", "image/jpeg"],
    ["video", "mp4", "video/mp4"],
  ] as const) {
    await assert.rejects(
      () => labelAigcMedia({ content: Buffer.from("not a media file"), mediaKind, extension, contentType, produceId: `bad-${extension}:0` }),
      (error: unknown) => error instanceof AigcLabelingError && error.code === "AIGC_METADATA_EXIFTOOL_FAILED",
    );
  }
});

test("production adapter carries platform-applied evidence and caller-owned content id", async () => {
  const source = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).jpeg().toBuffer();
  const result = await new AigcMetadataLabeler().apply({
    content: source,
    contentType: "image/jpeg",
    extension: "jpg",
    mediaKind: "image",
    contentId: "attempt-adapter:0",
  });
  assert.deepEqual(result.complianceMetadata, {
    aigcMetadataEnabled: true,
    aigcMetadataEvidence: "platform_applied",
    contentId: "attempt-adapter:0",
    contentProducer: AIGC_CONTENT_PRODUCER,
    schemaVersion: "GB45438-2025-Appendix-E",
  });
});
