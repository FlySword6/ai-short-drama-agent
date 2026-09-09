import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../../db/client.js";
import { errorBody } from "../../../shared/errors.js";
import { ProjectAccessService } from "../../project-access/service.js";
import type { ProjectAccessRecord, ProjectMembershipRole } from "../../project-access/types.js";
import { registerProjectStyleRoutes } from "./routes.js";
import type { ProjectStyle } from "./types.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const styleId = "44444444-4444-4444-8444-444444444444";
const fixture: ProjectStyle = {
  id: styleId,
  projectId,
  mediaKind: "image",
  name: "港风霓虹",
  content: "港风霓虹，暖色调，胶片颗粒，电影级质感",
  isDefault: false,
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
  await registerProjectStyleRoutes(app, () => ({} as Database), {
    createService: () => ({
      list: async (id: string, pid: string, mediaKind?: string) => {
        calls.push({ method: "list", id, pid, mediaKind });
        return [fixture];
      },
      create: async (id: string, pid: string, input: unknown) => {
        calls.push({ method: "create", id, pid, input });
        return { ...fixture, ...(input as object) };
      },
      update: async (id: string, pid: string, sid: string, input: unknown) => {
        calls.push({ method: "update", id, pid, sid, input });
        return { ...fixture, ...(input as object) };
      },
      softDelete: async (id: string, pid: string, sid: string) => {
        calls.push({ method: "softDelete", id, pid, sid });
        return undefined;
      },
      setDefault: async (id: string, pid: string, sid: string) => {
        calls.push({ method: "setDefault", id, pid, sid });
        return { ...fixture, isDefault: true };
      },
      unsetDefault: async (id: string, pid: string, sid: string) => {
        calls.push({ method: "unsetDefault", id, pid, sid });
        return { ...fixture, isDefault: false };
      },
    }) as never,
    createProjectAccessService: () => access,
  });
  return { app, calls };
}

test("风格库接口输出稳定 snake_case，并完整透传项目/媒介/创建人/风格 id", async () => {
  const { app, calls } = await createTestApp();
  try {
    const listed = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/project-styles?media_kind=image` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.count, 1);
    assert.deepEqual(listed.json().data.items[0], {
      id: styleId,
      project_id: projectId,
      media_kind: "image",
      name: "港风霓虹",
      content: "港风霓虹，暖色调，胶片颗粒，电影级质感",
      is_default: false,
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
      url: `/api/v1/projects/${projectId}/project-styles`,
      payload: { media_kind: "image", name: "新风格", content: "新风格内容" },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().data.name, "新风格");
    assert.deepEqual(calls, [{
      method: "create",
      id: actorId,
      pid: projectId,
      input: { mediaKind: "image", name: "新风格", content: "新风格内容" },
    }]);
    calls.length = 0;

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/project-styles/${styleId}`,
      payload: { media_kind: "video", name: "改名", content: "新内容" },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(calls, [{
      method: "update",
      id: actorId,
      pid: projectId,
      sid: styleId,
      input: { mediaKind: "video", name: "改名", content: "新内容" },
    }]);
    calls.length = 0;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/project-styles/${styleId}`,
    });
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(deleted.json().data, { style_id: styleId, deleted: true });
    assert.deepEqual(calls, [{ method: "softDelete", id: actorId, pid: projectId, sid: styleId }]);
    calls.length = 0;

    const setDefault = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/project-styles/${styleId}/default`,
    });
    assert.equal(setDefault.statusCode, 200);
    assert.equal(setDefault.json().data.is_default, true);
    assert.deepEqual(calls, [{ method: "setDefault", id: actorId, pid: projectId, sid: styleId }]);
    calls.length = 0;

    // D1（2026-08-17 修订）：取消默认 = 独立端点（默认可为空），幂等返回当前行。
    const unsetDefault = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}/project-styles/${styleId}/default`,
    });
    assert.equal(unsetDefault.statusCode, 200);
    assert.equal(unsetDefault.json().data.is_default, false);
    assert.deepEqual(calls, [{ method: "unsetDefault", id: actorId, pid: projectId, sid: styleId }]);
  } finally {
    await app.close();
  }
});

test("风格库写接口拒绝非 UUID、坏媒介、空/超长字段与未知键", async () => {
  const { app } = await createTestApp();
  try {
    const invalidProject = await app.inject({ method: "GET", url: "/api/v1/projects/not-a-uuid/project-styles" });
    assert.equal(invalidProject.statusCode, 400);

    const invalidStyle = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/project-styles/not-a-uuid`,
      payload: { media_kind: "image", name: "n", content: "c" },
    });
    assert.equal(invalidStyle.statusCode, 400);

    const badMedia = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/project-styles`,
      payload: { media_kind: "audio", name: "n", content: "c" },
    });
    assert.equal(badMedia.statusCode, 400);

    const emptyName = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/project-styles`,
      payload: { media_kind: "image", name: "", content: "c" },
    });
    assert.equal(emptyName.statusCode, 400);

    const overLimit = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/project-styles`,
      payload: { media_kind: "image", name: "n", content: "x".repeat(5001) },
    });
    assert.equal(overLimit.statusCode, 400);

    const unknownKey = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/project-styles`,
      payload: { media_kind: "image", name: "n", content: "c", extra: true },
    });
    assert.equal(unknownKey.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("风格库读取遵守项目可见性：成员可读，非成员 404，operator 可读", async () => {
  const cases = [
    { label: "viewer", actor: { id: "viewer-user", role: "member" as const }, membership: "viewer" as const, expectedStatus: 200 },
    { label: "nonmember", actor: { id: "nonmember-user", role: "member" as const }, membership: null, expectedStatus: 404 },
    { label: "operator", actor: { id: "operator-user", role: "operator" as const }, membership: null, expectedStatus: 200 },
  ];
  for (const item of cases) {
    const { app } = await createTestApp(item);
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/project-styles` });
      assert.equal(response.statusCode, item.expectedStatus, item.label);
    } finally {
      await app.close();
    }
  }
});

test("风格库写入允许项目 owner、editor 或 admin，viewer 与 operator 仍不能写", async () => {
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
        url: `/api/v1/projects/${projectId}/project-styles`,
        payload: { media_kind: "image", name: "n", content: "c" },
      });
      assert.equal(response.statusCode, item.expectedStatus, item.label);
    } finally {
      await app.close();
    }
  }
});
