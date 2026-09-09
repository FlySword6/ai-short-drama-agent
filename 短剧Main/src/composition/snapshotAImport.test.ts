import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { TosStorage, type TosClientLike } from "../integrations/tosStorage.js";
import { AppError, BadRequestError } from "../shared/errors.js";
import { createSnapshotATosVerification } from "./snapshotAImport.js";

const publicBaseUrl = "https://snapshot-assets.tos-cn-beijing.volces.com";
const objectBytes = Buffer.from("snapshot-a controlled bytes");
const objectSha256 = createHash("sha256").update(objectBytes).digest("hex");

function storageWithObject(expectedPath: string): { storage: TosStorage; calls: string[] } {
  const calls: string[] = [];
  const client: TosClientLike = {
    async headObject(input) {
      calls.push(String((input as { key?: unknown }).key));
      return { data: { contentLength: objectBytes.length, contentType: "image/png", etag: "etag" } };
    },
    async getObjectV2(input) {
      calls.push(String((input as { key?: unknown }).key));
      assert.equal((input as { key?: unknown }).key, expectedPath);
      return { data: { content: objectBytes } };
    },
  };
  return {
    storage: new TosStorage({
      client,
      config: { bucket: "assets", endpoint: "tos.example.com", accessKey: "test", secretKey: "test", region: "cn-beijing" },
    }),
    calls,
  };
}

test("TOS 校验只接受受信 TOS 空间内的对象并产出权威哈希", async () => {
  const { storage, calls } = storageWithObject("snapshot-a/rain-street.png");
  const verification = createSnapshotATosVerification({ storage, publicBaseUrl });
  const verified = await verification.verify({
    mediaUrl: `${publicBaseUrl}/snapshot-a/rain-street.png`,
    mediaSha256: objectSha256.toUpperCase(),
  });
  assert.equal(verified.mediaUrl, `${publicBaseUrl}/snapshot-a/rain-street.png`);
  assert.equal(verified.mediaSha256, objectSha256, "登记哈希必须采用 TOS 对象实测 SHA-256");
  assert.deepEqual(calls, ["snapshot-a/rain-street.png", "snapshot-a/rain-street.png"]);
});

test("TOS 校验拒绝非 TOS 来源、错误对象与未配置空间", async () => {
  const { storage } = storageWithObject("snapshot-a/rain-street.png");
  const verification = createSnapshotATosVerification({ storage, publicBaseUrl });

  await assert.rejects(
    () => verification.verify({ mediaUrl: "https://vendor.example.com/a.png", mediaSha256: objectSha256 }),
    (error: unknown) => error instanceof BadRequestError,
    "非受信 TOS 空间的供应商 URL 必须拒绝",
  );
  await assert.rejects(
    () => verification.verify({ mediaUrl: "http://snapshot-assets.tos-cn-beijing.volces.com/a.png", mediaSha256: objectSha256 }),
    (error: unknown) => error instanceof BadRequestError,
    "非 HTTPS 地址必须拒绝",
  );
  await assert.rejects(
    () => verification.verify({ mediaUrl: `${publicBaseUrl}/snapshot-a/rain-street.png`, mediaSha256: "b".repeat(64) }),
    /哈希/,
    "哈希不匹配必须失败关闭",
  );
  await assert.rejects(
    () => createSnapshotATosVerification({ storage, publicBaseUrl: "" }).verify({
      mediaUrl: `${publicBaseUrl}/snapshot-a/rain-street.png`,
      mediaSha256: objectSha256,
    }),
    (error: unknown) => error instanceof AppError && (error as AppError).statusCode === 503,
    "TOS 空间未配置必须失败关闭且不落任何事实",
  );
});
