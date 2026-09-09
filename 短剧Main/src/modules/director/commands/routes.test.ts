import assert from "node:assert/strict";
import test from "node:test";
import { ForbiddenError } from "../../../shared/errors.js";
import { authHeaders, createDirectorTestApp, directorTestUser } from "../testUtils.js";
import type { DirectorProjectAccessPort } from "../projectAccess.js";
import type { DirectorSceneRecord } from "../scene/repository.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sceneId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const snapshotFixture = {
  schemaVersion: 1,
  objects: [{
    id: "obj-a",
    type: "mannequin",
    name: "甲",
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    pose: { preset: "stand" },
    attachments: [],
  }],
  cameras: [{
    id: "cam-1",
    type: "camera",
    name: "主机位",
    focalLength: 50,
    target: { x: 0, y: 1, z: 0 },
    transform: { position: { x: 0, y: 1.5, z: -3 } },
  }],
  selectedObjectId: null,
  activeCameraId: "cam-1",
  aspectRatio: "9:16",
  environment: { preset: "studio", backgroundColor: "#1E1E1E", ambientLight: 0.6, groundVisible: true },
};

function sceneRecord(overrides: Partial<DirectorSceneRecord> = {}): DirectorSceneRecord {
  return {
    id: sceneId,
    projectId,
    status: "saved",
    currentVersion: 3,
    snapshot: structuredClone(snapshotFixture),
    createdByUserId: directorTestUser.id,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

function sceneStore(overrides: Record<string, unknown> = {}) {
  return {
    getScene: async () => sceneRecord(),
    ...overrides,
  };
}

function allowProjectAccess(overrides: Partial<DirectorProjectAccessPort> = {}): DirectorProjectAccessPort {
  return {
    require: async (actor, requestedProjectId) => ({
      projectId: requestedProjectId,
      actorId: actor.id,
      platformRole: actor.role ?? "member",
      membershipRole: "editor",
      isPlatformObserver: false,
    }),
    ...overrides,
  };
}

function appWithStore(store: Record<string, unknown>, projectAccess = allowProjectAccess()) {
  return createDirectorTestApp({ commands: { sceneStore: store as never, projectAccess } });
}

function cmd(input: Record<string, unknown>) {
  return { projectId, sceneId, sceneVersion: 3, ...input };
}

test("validate 未登录 401、他人项目 403", async () => {
  const app = await appWithStore(sceneStore());
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      payload: { sceneId, sceneVersion: 3, commands: [cmd({ type: "undo" })] },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }

  const stranger = await appWithStore(sceneStore(), allowProjectAccess({
    require: async () => { throw new ForbiddenError(); },
  }));
  try {
    const response = await stranger.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: { sceneId, sceneVersion: 3, commands: [cmd({ type: "undo" })] },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "forbidden");
  } finally {
    await stranger.close();
  }
});

test("合法命令序列 200：干跑通过并返回版本信息", async () => {
  const accessActions: string[] = [];
  const app = await appWithStore(sceneStore(), allowProjectAccess({
    require: async (actor, requestedProjectId, action) => {
      accessActions.push(action);
      return {
        projectId: requestedProjectId,
        actorId: actor.id,
        platformRole: "member",
        membershipRole: "editor",
        isPlatformObserver: false,
      };
    },
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: {
        sceneId,
        sceneVersion: 3,
        commands: [
          cmd({
            type: "add_object",
            payload: {
              object: {
                id: "obj-b",
                type: "mannequin",
                name: "乙",
                transform: { position: { x: 1, y: 0, z: 0 } },
              },
            },
          }),
          cmd({ type: "set_transform", payload: { objectId: "obj-b", transform: { position: { x: 2, y: 0, z: 0 } } } }),
          cmd({ type: "set_pose", payload: { objectId: "obj-a", pose: { preset: "sit" } } }),
          cmd({ type: "save_scene" }),
        ],
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.data, { valid: true, commandCount: 4, sceneId, sceneVersion: 3 });
    assert.deepEqual(accessActions, ["create"]);
  } finally {
    await app.close();
  }
});

test("delete_object 是破坏性命令，编辑者必须通过 delete 权限", async () => {
  const actions: string[] = [];
  const app = await appWithStore(sceneStore(), allowProjectAccess({
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
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: {
        sceneId,
        sceneVersion: 3,
        commands: [cmd({ type: "delete_object", payload: { objectId: "obj-a" } })],
      },
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(actions, ["delete"]);
  } finally {
    await app.close();
  }
});

test("结构不合法 400：空命令数组、payload 缺失、命令与 URL/请求体不一致", async () => {
  const app = await appWithStore(sceneStore());
  try {
    const empty = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: { sceneId, sceneVersion: 3, commands: [] },
    });
    assert.equal(empty.statusCode, 400);

    const badPayload = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: { sceneId, sceneVersion: 3, commands: [cmd({ type: "delete_object" })] },
    });
    assert.equal(badPayload.statusCode, 400);

    const wrongProject = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: {
        sceneId,
        sceneVersion: 3,
        commands: [cmd({ type: "undo", projectId: "99999999-9999-4999-8999-999999999999" })],
      },
    });
    assert.equal(wrongProject.statusCode, 400);
    assert.match(wrongProject.json().error.message, /不属于当前项目/);
    assert.doesNotMatch(wrongProject.json().error.message, /projectId|URL/);

    const wrongVersion = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: {
        sceneId,
        sceneVersion: 3,
        commands: [cmd({ type: "undo", sceneVersion: 2 })],
      },
    });
    assert.equal(wrongVersion.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("场景不存在 404；sceneId 与当前场景不符 400", async () => {
  const missing = await appWithStore(sceneStore({ getScene: async () => null }));
  try {
    const response = await missing.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: { sceneId, sceneVersion: 0, commands: [cmd({ type: "undo", sceneVersion: 0 })] },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    await missing.close();
  }

  const app = await appWithStore(sceneStore());
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: {
        sceneId: "99999999-9999-4999-8999-999999999999",
        sceneVersion: 3,
        commands: [{ ...cmd({ type: "undo" }), sceneId: "99999999-9999-4999-8999-999999999999" }],
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error.message, /不是当前项目的导演场景/);
    assert.doesNotMatch(response.json().error.message, /sceneId/);
  } finally {
    await app.close();
  }
});

test("版本不符 409 scene_version_conflict 给人话并保留当前版本", async () => {
  const app = await appWithStore(sceneStore());
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: {
        sceneId,
        sceneVersion: 1,
        commands: [{ ...cmd({ type: "undo" }), sceneVersion: 1 }],
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "scene_version_conflict");
    assert.match(response.json().error.message, /场景已更新/);
    assert.deepEqual(response.json().error.details, { currentVersion: 3 });
  } finally {
    await app.close();
  }
});

test("对象引用不存在 422 command_validation_failed，展示文案与机器定位分离", async () => {
  const app = await appWithStore(sceneStore());
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: {
        sceneId,
        sceneVersion: 3,
        commands: [
          cmd({ type: "set_transform", payload: { objectId: "obj-a", transform: { position: { x: 1, y: 0, z: 0 } } } }),
          cmd({ type: "delete_object", payload: { objectId: "ghost" } }),
          cmd({ type: "set_pose", payload: { objectId: "cam-1", pose: { preset: "sit" } } }),
        ],
      },
    });
    assert.equal(response.statusCode, 422);
    const body = response.json();
    assert.equal(body.error.code, "command_validation_failed");
    assert.match(body.error.message, /导演操作没能完成/);
    assert.equal(body.error.details.length, 2);
    assert.deepEqual(body.error.details[0], { index: 1, type: "delete_object", message: "所选对象不存在" });
    assert.equal(body.error.details[1].index, 2);
    assert.match(body.error.details[1].message, /不支持姿态调整/);
  } finally {
    await app.close();
  }
});

test("存储快照损坏时不静默吞错：409 scene_snapshot_corrupt", async () => {
  const app = await appWithStore(sceneStore({
    getScene: async () => sceneRecord({ snapshot: { schemaVersion: 2, broken: true } }),
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/director/commands/validate`,
      headers: authHeaders,
      payload: { sceneId, sceneVersion: 3, commands: [cmd({ type: "undo" })] },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "scene_snapshot_corrupt");
  } finally {
    await app.close();
  }
});
