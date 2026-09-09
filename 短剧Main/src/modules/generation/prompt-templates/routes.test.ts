import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../../db/client.js";
import { errorBody } from "../../../shared/errors.js";
import { ProjectAccessService } from "../../project-access/service.js";
import type { ProjectAccessRecord, ProjectMembershipRole } from "../../project-access/types.js";
import { registerPromptTemplateRoutes } from "./routes.js";
import type { PromptTemplate } from "./types.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const templateId = "44444444-4444-4444-8444-444444444444";
const fixture: PromptTemplate = {
  id: templateId,
  projectId,
  mediaKind: "image",
  name: "写实电影质感",
  content: "写实电影质感，自然光，浅景深",
  createdByUserId: actorId,
  deletedByUserId: null,
  deletedAt: null,
  createdAt: new Date("2026-08-13T00:00:00.000Z"),
  updatedAt: new Date("2026-08-13T00:00:00.000Z"),
};

async function createTestApp(options: {
  actor?: { id: string; role: "admin" | "operator" | "member" };
  membership?: ProjectMembershipRole | null;
} = {}) {
  const actor = options.actor ?? { id: actorId, role: "member" as const };
  const membership = options.membership === undefined ? "owner" : options.membership;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = { id: actor.id, username: "tester", displayName: "测试用户", role: actor.role };
  });
  const calls: unknown[] = [];
  const access = new ProjectAccessService({
    findAccessRecord: async (_actorId, requestedProjectId): Promise<ProjectAccessRecord | null> => (
      requestedProjectId === projectId
        ? { projectId, ownerUserId: actorId, membershipRole: membership }
        : null
    ),
  });
  await registerPromptTemplateRoutes(app, () => ({} as Database), {
    createService: () => ({
      list: async (id: string, pid: string, mediaKind?: string) => {
        calls.push({ method: "list", id, pid, mediaKind });
        return [fixture];
      },
      create: async (id: string, pid: string, input: unknown) => {
        calls.push({ method: "create", id, pid, input });
        return { ...fixture, ...(input as object) };
      },
      update: async (id: string, pid: string, tid: string, input: unknown) => {
        calls.push({ method: "update", id, pid, tid, input });
        return { ...fixture, ...(input as object) };
      },
      softDelete: async (id: string, pid: string, tid: string) => {
        calls.push({ method: "softDelete", id, pid, tid });
        return undefined;
      },
    }) as never,
    createProjectAccessService: () => access,
  });
  return { app, calls };
}

test("模板库接口输出稳定 snake_case，并把项目/媒介筛选/创建人传给服务", async () => {
  const { app, calls } = await createTestApp();
  try {
    const listed = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/prompt-templates?media_kind=image` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.count, 1);
    assert.deepEqual(listed.json().data.items[0], {
      id: templateId,
      project_id: projectId,
      media_kind: "image",
      name: "写实电影质感",
      content: "写实电影质感，自然光，浅景深",
      created_by_user_id: actorId,
      deleted_by_user_id: null,
      deleted_at: null,
      created_at: "2026-08-13T00:00:00.000Z",
      updated_at: "2026-08-13T00:00:00.000Z",
    });
    assert.deepEqual(calls, [{ method: "list", id: actorId, pid: projectId, mediaKind: "image" }]);
    calls.length = 0;

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/prompt-templates`,
      payload: { media_kind: "image", name: "新模板", content: "新模板内容" },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().data.name, "新模板");
    assert.deepEqual(calls, [{
      method: "create",
      id: actorId,
      pid: projectId,
      input: { mediaKind: "image", name: "新模板", content: "新模板内容" },
    }]);
    calls.length = 0;

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/prompt-templates/${templateId}`,
      payload: { media_kind: "video", name: "改名", content: "新内容" },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(calls, [{
      method: "update",
      id: actorId,
      pid: projectId,
      tid: templateId,
      input: { mediaKind: "video", name: "改名", content: "新内容" },
    }]);
    calls.length = 0;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/prompt-templates/${templateId}`,
    });
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(deleted.json().data, { template_id: templateId, deleted: true });
    assert.deepEqual(calls, [{ method: "softDelete", id: actorId, pid: projectId, tid: templateId }]);
  } finally {
    await app.close();
  }
});

test("模板库写接口拒绝非 UUID、坏媒介、空/超长字段与未知键", async () => {
  const { app } = await createTestApp();
  try {
    const invalidProject = await app.inject({ method: "GET", url: "/api/v1/projects/not-a-uuid/prompt-templates" });
    assert.equal(invalidProject.statusCode, 400);

    const invalidTemplate = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/prompt-templates/not-a-uuid`,
      payload: { media_kind: "image", name: "n", content: "c" },
    });
    assert.equal(invalidTemplate.statusCode, 400);

    const badMedia = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/prompt-templates`,
      payload: { media_kind: "audio", name: "n", content: "c" },
    });
    assert.equal(badMedia.statusCode, 400);

    const emptyName = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/prompt-templates`,
      payload: { media_kind: "image", name: "", content: "c" },
    });
    assert.equal(emptyName.statusCode, 400);

    const overLimit = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/prompt-templates`,
      payload: { media_kind: "image", name: "n", content: "x".repeat(5001) },
    });
    assert.equal(overLimit.statusCode, 400);

    const unknownKey = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/prompt-templates`,
      payload: { media_kind: "image", name: "n", content: "c", extra: true },
    });
    assert.equal(unknownKey.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("模板库读取遵守项目可见性：成员可读，非成员 404，operator 可读", async () => {
  const cases = [
    { label: "viewer", actor: { id: "viewer-user", role: "member" as const }, membership: "viewer" as const, expectedStatus: 200 },
    { label: "nonmember", actor: { id: "nonmember-user", role: "member" as const }, membership: null, expectedStatus: 404 },
    { label: "operator", actor: { id: "operator-user", role: "operator" as const }, membership: null, expectedStatus: 200 },
  ];
  for (const item of cases) {
    const { app } = await createTestApp(item);
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/prompt-templates` });
      assert.equal(response.statusCode, item.expectedStatus, item.label);
    } finally {
      await app.close();
    }
  }
});

test("模板库写入允许项目 owner、editor 或 admin，viewer 与 operator 仍不能写", async () => {
  const cases = [
    { label: "owner", actor: { id: actorId, role: "member" as const }, membership: "owner" as const, expectedStatus: 200 },
    { label: "admin", actor: { id: "admin-user", role: "admin" as const }, membership: null, expectedStatus: 200 },
    { label: "editor", actor: { id: "editor-user", role: "member" as const }, membership: "editor" as const, expectedStatus: 200 },
    { label: "viewer", actor: { id: "viewer-user", role: "member" as const }, membership: "viewer" as const, expectedStatus: 403 },
    { label: "operator", actor: { id: "operator-user", role: "operator" as const }, membership: null, expectedStatus: 403 },
  ];
  for (const item of cases) {
    const { app } = await createTestApp(item);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/prompt-templates`,
        payload: { media_kind: "image", name: "n", content: "c" },
      });
      assert.equal(response.statusCode, item.expectedStatus, item.label);
    } finally {
      await app.close();
    }
  }
});
