import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../../db/client.js";
import { errorBody } from "../../shared/errors.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessRecord, ProjectMembershipRole } from "../project-access/types.js";
import { registerProjectAssetRoutes } from "./routes.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const referenceId = "33333333-3333-4333-8333-333333333333";

test("项目资产读取遵循成员可读、非成员隐藏、operator 可读的统一口径", async () => {
  const cases = [
    { label: "viewer", actor: { id: "viewer", role: "member" as const }, membership: "viewer" as const, expected: 200 },
    { label: "nonmember", actor: { id: "nonmember", role: "member" as const }, membership: null, expected: 404 },
    { label: "operator", actor: { id: "operator", role: "operator" as const }, membership: null, expected: 200 },
  ];

  for (const item of cases) {
    const { app, calls } = await createTestApp(item);
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}/assets` });
      assert.equal(response.statusCode, item.expected, item.label);
      assert.equal(calls.length, item.expected === 200 ? 1 : 0, item.label);
      if (item.expected === 200) {
        assert.deepEqual(calls[0], { action: "list", actorId: item.actor.id, authorizedProjectId: projectId });
      }
    } finally {
      await app.close();
    }
  }
});

test("项目资产引用与移除只允许 owner/editor/admin，且把精确项目授权传给服务层", async () => {
  const cases = [
    { label: "owner", actor: { id: "owner", role: "member" as const }, membership: "owner" as const, expected: 201 },
    { label: "editor", actor: { id: "editor", role: "member" as const }, membership: "editor" as const, expected: 201 },
    { label: "admin", actor: { id: "admin", role: "admin" as const }, membership: null, expected: 201 },
    { label: "viewer", actor: { id: "viewer", role: "member" as const }, membership: "viewer" as const, expected: 403 },
    { label: "operator", actor: { id: "operator", role: "operator" as const }, membership: null, expected: 403 },
    { label: "nonmember", actor: { id: "nonmember", role: "member" as const }, membership: null, expected: 404 },
  ];

  for (const item of cases) {
    const { app, calls } = await createTestApp(item);
    try {
      const add = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/assets`,
        payload: { asset_entity_id: assetId },
      });
      assert.equal(add.statusCode, item.expected, `${item.label} add`);

      const remove = await app.inject({
        method: "DELETE",
        url: `/api/v1/projects/${projectId}/assets/${referenceId}`,
      });
      assert.equal(remove.statusCode, item.expected === 201 ? 200 : item.expected, `${item.label} remove`);

      if (item.expected === 201) {
        assert.deepEqual(calls, [
          {
            action: "add",
            actorId: item.actor.id,
            authorizedProjectId: projectId,
            assetEntityId: assetId,
          },
          {
            action: "remove",
            actorId: item.actor.id,
            authorizedProjectId: projectId,
            referenceId,
          },
        ]);
      } else {
        assert.equal(calls.length, 0, item.label);
      }
    } finally {
      await app.close();
    }
  }
});

async function createTestApp(options: {
  actor: { id: string; role: "admin" | "operator" | "member" };
  membership: ProjectMembershipRole | null;
}) {
  const calls: Array<Record<string, unknown>> = [];
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  app.addHook("preHandler", async (request) => {
    request.authUser = {
      id: options.actor.id,
      username: options.actor.id,
      displayName: options.actor.id,
      role: options.actor.role,
    };
  });
  const access = new ProjectAccessService({
    findAccessRecord: async (_actorId, requestedProjectId): Promise<ProjectAccessRecord | null> => (
      requestedProjectId === projectId
        ? { projectId, ownerUserId: "owner", membershipRole: options.membership }
        : null
    ),
  });
  await registerProjectAssetRoutes(app, () => ({} as Database), {
    createProjectAccessService: () => access,
    createService: () => ({
      list: async (actorId: string, _projectId: string, authorizedProjectId?: string) => {
        calls.push({ action: "list", actorId, authorizedProjectId });
        return [];
      },
      addReference: async (
        actorId: string,
        _projectId: string,
        input: { assetEntityId: string },
        authorizedProjectId?: string,
      ) => {
        calls.push({ action: "add", actorId, authorizedProjectId, assetEntityId: input.assetEntityId });
        return { id: referenceId };
      },
      removeReference: async (
        actorId: string,
        _projectId: string,
        incomingReferenceId: string,
        authorizedProjectId?: string,
      ) => {
        calls.push({ action: "remove", actorId, authorizedProjectId, referenceId: incomingReferenceId });
      },
    }) as never,
  });
  return { app, calls };
}
