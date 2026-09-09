import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { ExternalServiceError, ForbiddenError } from "../../../shared/errors.js";
import { authHeaders, createDirectorTestApp, directorTestUser } from "../testUtils.js";
import type { DirectorCaptureUploadInput } from "./service.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const episodeId = "12121212-1212-4212-8212-121212121212";
const shotId = "34343434-3434-4343-8343-343434343434";

function multipartPayload(boundary: string, parts: Array<{
  name: string;
  filename?: string;
  contentType?: string;
  content: Buffer | string;
}>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`;
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}`));
    chunks.push(typeof part.content === "string" ? Buffer.from(part.content) : part.content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function appWithCaptureService(service: Record<string, unknown>) {
  return createDirectorTestApp({
    captures: { createCaptureService: () => service as never },
  });
}

test("captures 未登录 401", async () => {
  const app = await appWithCaptureService({});
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/captures`,
      headers: { "content-type": "multipart/form-data; boundary=x" },
      payload: "",
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "unauthorized");
  } finally {
    await app.close();
  }
});

test("他人项目在读取 multipart 前返回 403", async () => {
  let uploadCalled = false;
  const app = await appWithCaptureService({
    assertProjectCreateAccess: async (actor: { id: string }, pid: string) => {
      assert.equal(actor.id, directorTestUser.id);
      assert.equal(pid, projectId);
      throw new ForbiddenError();
    },
    upload: async () => { uploadCalled = true; },
  });
  try {
    const boundary = "director-capture-forbidden";
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/captures`,
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [
        { name: "file", filename: "x.png", contentType: "image/png", content: Buffer.alloc(11 * 1024 * 1024, 97) },
      ]),
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "forbidden");
    assert.equal(uploadCalled, false);
  } finally {
    await app.close();
  }
});

test("201：multipart 文件与可选字段正确传入 service", async () => {
  const content = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#123456" } }).png().toBuffer();
  let captured: DirectorCaptureUploadInput | undefined;
  const app = await appWithCaptureService({
    assertProjectCreateAccess: async () => undefined,
    upload: async (input: DirectorCaptureUploadInput) => {
      captured = input;
      return {
        assetEntityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        assetMediaId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        status: "approved",
        approved: true,
        storageUrl: "https://storage.example/x.png",
      };
    },
  });
  try {
    const boundary = "director-capture-ok";
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/captures`,
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [
        { name: "file", filename: "主机位.png", contentType: "image/png", content },
        { name: "episode_id", content: episodeId },
        { name: "shot_id", content: shotId },
        { name: "title", content: "主机位截图" },
      ]),
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.status, "approved");
    assert.equal(body.data.approved, true);
    assert.equal(typeof captured?.actor === "string" ? captured.actor : captured?.actor.id, directorTestUser.id);
    assert.equal(captured?.projectId, projectId);
    assert.deepEqual(captured?.content, content);
    assert.deepEqual(captured?.placement, { episodeId, shotId });
    assert.equal(captured?.title, "主机位截图");
    assert.equal(captured?.declaredContentType, "image/png");
  } finally {
    await app.close();
  }
});

test("director-captures 错误信封快照：截图上传不暴露存储服务原文", async () => {
  const app = await appWithCaptureService({
    assertProjectCreateAccess: async () => undefined,
    upload: async () => {
      throw new ExternalServiceError("TOS", "request failed with status 503");
    },
  });
  try {
    const boundary = "director-capture-copy-snapshot";
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/captures`,
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [
        { name: "file", filename: "主机位.png", contentType: "image/png", content: Buffer.from("fake-image") },
      ]),
    });
    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      ok: false,
      error: {
        code: "external_service_error",
        message: "素材没能保存：存储服务暂时没响应，请稍后重试。",
        retryable: true,
        details: null,
      },
    });
  } finally {
    await app.close();
  }
});

test("缺少文件 400，字段不是 uuid 400", async () => {
  const app = await appWithCaptureService({
    assertProjectCreateAccess: async () => undefined,
    upload: async () => { throw new Error("不应执行"); },
  });
  try {
    const boundary = "director-capture-missing";
    const noFile = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/captures`,
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [{ name: "title", content: "只有字段" }]),
    });
    assert.equal(noFile.statusCode, 400);
    assert.equal(noFile.json().error.code, "invalid_request");

    const badField = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/captures`,
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [
        { name: "file", filename: "x.png", contentType: "image/png", content: Buffer.from("x") },
        { name: "episode_id", content: "not-a-uuid" },
      ]),
    });
    assert.equal(badField.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("超过 10 兆的文件返回 413，不进入 service", async () => {
  let uploadCalled = false;
  const app = await appWithCaptureService({
    assertProjectCreateAccess: async () => undefined,
    upload: async () => { uploadCalled = true; },
  });
  try {
    const boundary = "director-capture-too-large";
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/captures`,
      headers: { ...authHeaders, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartPayload(boundary, [
        { name: "file", filename: "big.png", contentType: "image/png", content: Buffer.alloc(10 * 1024 * 1024 + 1, 97) },
      ]),
    });
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, "payload_too_large");
    assert.match(response.json().error.message, /10 兆/);
    assert.equal(uploadCalled, false);
  } finally {
    await app.close();
  }
});
