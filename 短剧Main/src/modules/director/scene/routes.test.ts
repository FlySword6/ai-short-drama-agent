import assert from "node:assert/strict";
import test from "node:test";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import { authHeaders, createDirectorTestApp, directorTestUser } from "../testUtils.js";
import type { DirectorProjectAccessPort } from "../projectAccess.js";
import type { DirectorSceneRecord, DirectorSceneVersionRecord } from "./repository.js";
import { DirectorSceneService } from "./service.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sceneId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sceneFixture: DirectorSceneRecord = {
  id: sceneId,
  projectId,
  status: "saved",
  currentVersion: 3,
  snapshot: { schemaVersion: 1, objects: [] },
  createdByUserId: directorTestUser.id,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

const versionFixture: DirectorSceneVersionRecord = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  sceneId,
  version: 3,
  kind: "current",
  sourceAction: "manual_save",
  createdByUserId: directorTestUser.id,
  createdAt: "2026-07-20T00:00:00.000Z",
};

function serviceWith(repository: Record<string, unknown>) {
  return new DirectorSceneService({} as never, {
    repository: repository as never,
    projectAccess: allowProjectAccess(),
  });
}

function allowProjectAccess(overrides: Partial<DirectorProjectAccessPort> = {}): DirectorProjectAccessPort {
  return {
    require: async (actor, requestedProjectId) => ({
      projectId: requestedProjectId,
      actorId: actor.id,
      platformRole: actor.role ?? "member",
      membershipRole: "owner",
      isPlatformObserver: false,
    }),
    ...overrides,
  };
}

test("service.get 无场景抛 404，save 默认来源动作为 manual_save", async () => {
  const calls: unknown[] = [];
  const service = serviceWith({
    getScene: async () => null,
  });
  await assert.rejects(service.get(directorTestUser.id, projectId), (error: unknown) => error instanceof NotFoundError);

  const saving = serviceWith({
    getScene: async () => null,
    saveVersion: async (input: Record<string, unknown>) => {
      calls.push(input);
      return { scene: sceneFixture, version: versionFixture };
    },
  });
  const result = await saving.save(directorTestUser.id, projectId, {
    sceneVersion: 2,
    snapshot: { schemaVersion: 1 },
  });
  assert.deepEqual(calls[0], {
    projectId,
    actorId: directorTestUser.id,
    expectedVersion: 2,
    snapshot: { schemaVersion: 1 },
    sourceAction: "manual_save",
  });
  assert.equal(result.scene.currentVersion, 3);
});

test("service.listVersions 场景不存在抛 404", async () => {
  const service = serviceWith({
    getScene: async () => null,
    listVersions: async () => [],
  });
  await assert.rejects(service.listVersions(directorTestUser.id, projectId), (error: unknown) => error instanceof NotFoundError);
});

test("场景读取走 read，保存走 create，权限服务拒绝时不访问场景仓库", async () => {
  const actions: string[] = [];
  let repositoryCalled = false;
  const access = allowProjectAccess({
    require: async (actor, requestedProjectId, action) => {
      actions.push(action);
      return {
        projectId: requestedProjectId,
        actorId: actor.id,
        platformRole: "member",
        membershipRole: "editor",
        isPlatformObserver: false,
      };
    },
  });
  const service = new DirectorSceneService({} as never, {
    projectAccess: access,
    repository: {
      getScene: async () => { repositoryCalled = true; return sceneFixture; },
      listVersions: async () => [],
      saveVersion: async () => { repositoryCalled = true; return { scene: sceneFixture, version: versionFixture }; },
    },
  });

  await service.get(directorTestUser, projectId);
  await service.save(directorTestUser, projectId, { sceneVersion: 3, snapshot: { schemaVersion: 1 } });
  assert.deepEqual(actions, ["read", "create"]);
  assert.equal(repositoryCalled, true);

  const denied = new DirectorSceneService({} as never, {
    projectAccess: allowProjectAccess({ require: async () => { throw new ForbiddenError(); } }),
    repository: {
      getScene: async () => { throw new Error("不应读取场景"); },
      listVersions: async () => [],
      saveVersion: async () => { throw new Error("不应保存场景"); },
    },
  });
  await assert.rejects(
    denied.get(directorTestUser, projectId),
    (error: unknown) => error instanceof ForbiddenError,
  );
});

test("编辑者可保存但删除已有对象时必须再通过 delete 权限", async () => {
  const actions: string[] = [];
  const current = {
    ...sceneFixture,
    snapshot: { schemaVersion: 1, objects: [{ id: "persisted-object" }], cameras: [] },
  };
  const service = new DirectorSceneService({} as never, {
    projectAccess: allowProjectAccess({
      require: async (actor, requestedProjectId, action) => {
        actions.push(action);
        if (action === "delete") throw new ForbiddenError();
        return {
          projectId: requestedProjectId,
          actorId: actor.id,
          platformRole: "member",
          membershipRole: "editor",
          isPlatformObserver: false,
        };
      },
    }),
    repository: {
      getScene: async () => current,
      listVersions: async () => [],
      saveVersion: async () => { throw new Error("不能在没有 delete 权限时保存删除结果"); },
    },
  });
  await assert.rejects(
    service.save(directorTestUser, projectId, {
      sceneVersion: 3,
      snapshot: { schemaVersion: 1, objects: [], cameras: [] },
    }),
    (error: unknown) => error instanceof ForbiddenError,
  );
  assert.deepEqual(actions, ["create", "delete"]);
});

function appWithSceneService(service: Record<string, unknown>) {
  return createDirectorTestApp({
    scene: { createSceneService: () => service as never },
  });
}

test("scene 接口未登录一律 401", async () => {
  const app = await appWithSceneService({});
  try {
    for (const request of [
      { method: "GET", url: `/api/v1/projects/${projectId}/director/scene` },
      { method: "PUT", url: `/api/v1/projects/${projectId}/director/scene`, payload: {} },
      { method: "GET", url: `/api/v1/projects/${projectId}/director/scene/versions` },
    ] as const) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    }
  } finally {
    await app.close();
  }
});

test("GET scene 200 返回当前版本快照；404/403 语义正确", async () => {
  const app = await appWithSceneService({
    get: async (actor: { id: string }, pid: string) => {
      assert.equal(actor.id, directorTestUser.id);
      assert.equal(pid, projectId);
      return sceneFixture;
    },
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/director/scene`,
      headers: authHeaders,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.id, sceneId);
    assert.equal(body.data.currentVersion, 3);
    assert.deepEqual(body.data.snapshot, { schemaVersion: 1, objects: [] });
  } finally {
    await app.close();
  }

  const notFound = await appWithSceneService({
    get: async () => { throw new NotFoundError("导演场景不存在"); },
  });
  try {
    const response = await notFound.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/director/scene`,
      headers: authHeaders,
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "not_found");
  } finally {
    await notFound.close();
  }

  const forbidden = await appWithSceneService({
    get: async () => { throw new ForbiddenError(); },
  });
  try {
    const response = await forbidden.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/director/scene`,
      headers: authHeaders,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "forbidden");
  } finally {
    await forbidden.close();
  }
});

test("PUT scene 保存新版本；版本冲突 409；快照不合法 400", async () => {
  const savedInputs: unknown[] = [];
  const app = await appWithSceneService({
    save: async (_actor: { id: string }, _pid: string, input: unknown) => {
      savedInputs.push(input);
      return { scene: sceneFixture, version: versionFixture };
    },
  });
  try {
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/director/scene`,
      headers: authHeaders,
      payload: {
        sceneVersion: 2,
        snapshot: { schemaVersion: 1, objects: [], cameras: [] },
        sourceAction: "template_apply",
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.savedVersion.version, 3);
    assert.equal(body.data.savedVersion.kind, "current");
    assert.deepEqual(savedInputs[0], {
      sceneVersion: 2,
      snapshot: { schemaVersion: 1, objects: [], cameras: [], selectedObjectId: null, activeCameraId: null, aspectRatio: "9:16", environment: { preset: "studio", backgroundColor: "#1E1E1E", ambientLight: 0.6, groundVisible: true } },
      sourceAction: "template_apply",
    });

    const badSnapshot = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/director/scene`,
      headers: authHeaders,
      payload: { sceneVersion: 2, snapshot: { schemaVersion: 2 } },
    });
    assert.equal(badSnapshot.statusCode, 400);
    assert.equal(badSnapshot.json().error.code, "invalid_request");

    const missingVersion = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/director/scene`,
      headers: authHeaders,
      payload: { snapshot: { schemaVersion: 1 } },
    });
    assert.equal(missingVersion.statusCode, 400);
  } finally {
    await app.close();
  }

  const conflicted = await appWithSceneService({
    save: async () => {
      throw new ConflictError("保存场景没成：场景已被更新，请刷新后再试。", "scene_version_conflict");
    },
  });
  try {
    const response = await conflicted.inject({
      method: "PUT",
      url: `/api/v1/projects/${projectId}/director/scene`,
      headers: authHeaders,
      payload: { sceneVersion: 2, snapshot: { schemaVersion: 1 } },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "scene_version_conflict");
    assert.equal(response.json().error.details, null);
  } finally {
    await conflicted.close();
  }
});

test("GET versions 返回版本列表（current 在前）", async () => {
  const app = await appWithSceneService({
    listVersions: async () => ({
      scene: sceneFixture,
      versions: [
        versionFixture,
        { ...versionFixture, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", version: 2, kind: "historical" },
      ],
    }),
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/director/scene/versions`,
      headers: authHeaders,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.data.currentVersion, 3);
    assert.equal(body.data.versions.length, 2);
    assert.deepEqual(body.data.versions.map((item: { kind: string }) => item.kind), ["current", "historical"]);
    assert.equal(body.data.versions[0].sourceAction, "manual_save");
  } finally {
    await app.close();
  }
});
