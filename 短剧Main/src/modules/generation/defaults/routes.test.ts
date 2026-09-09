import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../../db/client.js";
import { errorBody } from "../../../shared/errors.js";
import { ProjectAccessService } from "../../project-access/service.js";
import type { ProjectAccessRecord, ProjectMembershipRole } from "../../project-access/types.js";
import { registerGenerationDefaultStrategyRoutes } from "./routes.js";
import type { GenerationDefaultStrategy } from "./types.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const actorId = "33333333-3333-4333-8333-333333333333";
const fixture: GenerationDefaultStrategy = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId,
  mediaKind: "video",
  mode: "material_to_prompt",
  modelKey: "seedance-2-0",
  parameters: { duration_seconds: 4 },
  sourceGenerationRequestId: null,
  updatedByUserId: actorId,
  version: 2,
  createdAt: new Date("2026-07-20T00:00:00.000Z"),
  updatedAt: new Date("2026-07-20T00:01:00.000Z"),
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
  await registerGenerationDefaultStrategyRoutes(app, () => ({} as Database), {
    createService: () => ({
      list: async () => [fixture],
      get: async () => fixture,
      put: async (userId: string, incomingProjectId: string, input: unknown) => {
        calls.push({ userId, projectId: incomingProjectId, input });
        return fixture;
      },
    }) as never,
    createProjectAccessService: () => access,
  });
  return { app, calls };
}

test("默认策略接口输出稳定 snake_case，并向服务传递项目、类型和版本", async () => {
  const { app, calls } = await createTestApp();
  try {
    const listed = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/generation-defaults` });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().data.count, 1);
    assert.equal(listed.json().data.items[0].model_key, "seedance-2-0");

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/generation-defaults/video`,
      payload: {
        mode: "material_to_prompt",
        model_key: "seedance-2-0",
        parameters: { duration_seconds: 4 },
        expected_version: 1,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(calls, [{
      userId: actorId,
      projectId,
      input: {
        mediaKind: "video",
        mode: "material_to_prompt",
        modelKey: "seedance-2-0",
        parameters: { duration_seconds: 4 },
        sourceGenerationRequestId: undefined,
        expectedVersion: 1,
      },
    }]);
  } finally {
    await app.close();
  }
});

test("默认策略接口拒绝缺少 expected_version、未知模式和非 UUID 项目", async () => {
  const { app } = await createTestApp();
  try {
    const missingVersion = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/generation-defaults/image`,
      payload: { mode: "direct_reference", model_key: "gpt-image-2" },
    });
    assert.equal(missingVersion.statusCode, 400);

    const unknownMode = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/generation-defaults/image`,
      payload: { mode: "auto", model_key: "gpt-image-2", expected_version: 0 },
    });
    assert.equal(unknownMode.statusCode, 400);

    const invalidProject = await app.inject({ method: "GET", url: "/api/v1/projects/not-a-uuid/generation-defaults" });
    assert.equal(invalidProject.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("默认策略接口接受 audio 媒体类型 + text_to_speech 模式(Lite 音频默认档/默认音色)", async () => {
  const { app, calls } = await createTestApp();
  try {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/generation-defaults/audio`,
      payload: {
        mode: "text_to_speech",
        model_key: "seed-audio-1.0",
        parameters: { speaker_id: "voice-cn-1", prompt_template_id: null },
        expected_version: 0,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal((calls[0] as { input: { mediaKind: string } }).input.mediaKind, "audio");
    assert.equal((calls[0] as { input: { mode: string } }).input.mode, "text_to_speech");
    assert.equal(
      (calls[0] as { input: { parameters: { speaker_id: string } } }).input.parameters.speaker_id,
      "voice-cn-1",
    );
    assert.equal((calls[0] as { input: { parameters: { prompt_template_id: unknown } } }).input.parameters.prompt_template_id, null);
  } finally {
    await app.close();
  }
});

test("默认策略读取遵守项目可见性：成员可读，非成员 404，operator 可读", async () => {
  const cases = [
    {
      label: "viewer",
      actor: { id: "viewer-user", role: "member" as const },
      membership: "viewer" as const,
      expectedStatus: 200,
    },
    {
      label: "nonmember",
      actor: { id: "nonmember-user", role: "member" as const },
      membership: null,
      expectedStatus: 404,
    },
    {
      label: "operator",
      actor: { id: "operator-user", role: "operator" as const },
      membership: null,
      expectedStatus: 200,
    },
  ];
  for (const item of cases) {
    const { app } = await createTestApp(item);
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/generation-defaults` });
      assert.equal(response.statusCode, item.expectedStatus, item.label);
    } finally {
      await app.close();
    }
  }
});

test("默认策略写入允许项目 owner、editor 或 admin，viewer 与 operator 仍不能写", async () => {
  const cases = [
    {
      label: "owner",
      actor: { id: actorId, role: "member" as const },
      membership: "owner" as const,
      expectedStatus: 200,
    },
    {
      label: "admin",
      actor: { id: "admin-user", role: "admin" as const },
      membership: null,
      expectedStatus: 200,
    },
    {
      label: "editor",
      actor: { id: "editor-user", role: "member" as const },
      membership: "editor" as const,
      expectedStatus: 200,
    },
    {
      label: "viewer",
      actor: { id: "viewer-user", role: "member" as const },
      membership: "viewer" as const,
      expectedStatus: 403,
    },
    {
      label: "operator",
      actor: { id: "operator-user", role: "operator" as const },
      membership: null,
      expectedStatus: 403,
    },
  ];
  for (const item of cases) {
    const { app } = await createTestApp(item);
    try {
      const response = await app.inject({
        method: "PUT",
        url: `/api/v1/projects/${projectId}/generation-defaults/video`,
        payload: {
          mode: "material_to_prompt",
          model_key: "seedance-2-0",
          parameters: {},
          expected_version: 0,
        },
      });
      assert.equal(response.statusCode, item.expectedStatus, item.label);
    } finally {
      await app.close();
    }
  }
});
