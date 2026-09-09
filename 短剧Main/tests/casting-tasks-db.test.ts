import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  castingTasks,
  episodes,
  projectMembers,
  projects,
  referenceLaneVocabulary,
  scenes,
  shots,
  users,
} from "../src/db/schema.js";
import { registerCastingTaskRoutes } from "../src/modules/casting-tasks/routes.js";

const databaseUrl = process.env.CASTING_TASKS_TEST_DATABASE_URL;

interface FixtureUser {
  id: string;
  username: string;
  displayName: string;
  role?: "admin" | "operator" | "member";
}

interface Fixture {
  handle: DatabaseHandle;
  app: FastifyInstance;
  owner: FixtureUser;
  editor: FixtureUser;
  viewer: FixtureUser;
  outsider: FixtureUser;
  admin: FixtureUser;
  projectId: string;
  episodeId: string;
  sceneId: string;
  otherSceneId: string;
  shotId: string;
  otherShotId: string;
  looseShotId: string;
  inactiveLane: string;
  now: Date;
}

function as(user: FixtureUser): Record<string, string> {
  return { "x-casting-test-user": user.username };
}

test("casting tasks: 场级单与镜级单都能开、都能看", { skip: !databaseUrl }, async () =>
  withFixture(async (fixture) => {
    const sceneLevel = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.owner),
      payload: {
        scene_id: fixture.sceneId,
        lane: "scene",
        title: "场 3 缺一张夜景主视图",
        brief: "要全景空间基准,雨夜氛围",
      },
    });
    assert.equal(sceneLevel.statusCode, 201, sceneLevel.body);
    const sceneTask = sceneLevel.json().data;
    assert.equal(sceneTask.scene_id, fixture.sceneId);
    assert.equal(sceneTask.shot_id, null);
    assert.equal(sceneTask.status, "open");
    assert.equal(sceneTask.assignee_user_id, null);
    assert.equal(sceneTask.created_by_user_id, fixture.owner.id);
    assert.ok(sceneTask.created_at);
    assert.ok(sceneTask.updated_at);

    const shotLevel = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.editor),
      payload: {
        scene_id: fixture.sceneId,
        shot_id: fixture.shotId,
        lane: "character",
        title: "镜 5 缺女主转身参考",
        assignee_user_id: fixture.editor.id,
      },
    });
    assert.equal(shotLevel.statusCode, 201, shotLevel.body);
    const shotTask = shotLevel.json().data;
    assert.equal(shotTask.scene_id, fixture.sceneId);
    assert.equal(shotTask.shot_id, fixture.shotId);
    assert.equal(shotTask.assignee_user_id, fixture.editor.id);

    const fetched = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/casting-tasks/${shotTask.id}`,
      headers: as(fixture.viewer),
    });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.equal(fetched.json().data.id, shotTask.id);
    assert.equal(fetched.json().data.title, "镜 5 缺女主转身参考");
  }));

test("casting tasks: scene_id 可空——无场镜头与纯补图单都能开、都能查", { skip: !databaseUrl }, async () =>
  withFixture(async (fixture) => {
    // shots.scene_id 可空是既有数据事实,无场镜头照样要能开单。
    const looseShot = await createTask(fixture, fixture.owner, {
      shot_id: fixture.looseShotId,
      lane: "character",
      title: "无场镜头缺人物参考",
    });
    assert.equal(looseShot.scene_id, null);
    assert.equal(looseShot.shot_id, fixture.looseShotId);

    // 场镜都不填 = 纯补图单,挂在项目上。
    const projectLevel = await createTask(fixture, fixture.owner, {
      lane: "prop",
      title: "这个项目缺一版道具参考",
    });
    assert.equal(projectLevel.scene_id, null);
    assert.equal(projectLevel.shot_id, null);

    const byShot = await listTasks(fixture, fixture.viewer, `shot_id=${fixture.looseShotId}`);
    assert.deepEqual(byShot.map((task) => task.id), [looseShot.id]);
    assert.equal((await listTasks(fixture, fixture.viewer, "")).length, 2);
  }));

test("casting tasks: lane 不在参考栏词表或已停用时拒成 422", { skip: !databaseUrl }, async () =>
  withFixture(async (fixture) => {
    const unknown = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.owner),
      payload: { scene_id: fixture.sceneId, lane: "no-such-lane", title: "未知参考栏" },
    });
    assert.equal(unknown.statusCode, 422, unknown.body);

    const inactive = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.owner),
      payload: { scene_id: fixture.sceneId, lane: fixture.inactiveLane, title: "停用参考栏" },
    });
    assert.equal(inactive.statusCode, 422, inactive.body);
  }));

test("casting tasks: 非项目成员读单 403,非写权限成员开单 403", { skip: !databaseUrl }, async () =>
  withFixture(async (fixture) => {
    const created = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.owner),
      payload: { scene_id: fixture.sceneId, lane: "prop", title: "缺关键道具参考" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const taskId = created.json().data.id;

    const outsiderGet = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/casting-tasks/${taskId}`,
      headers: as(fixture.outsider),
    });
    assert.equal(outsiderGet.statusCode, 403, outsiderGet.body);

    const outsiderList = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.outsider),
    });
    assert.equal(outsiderList.statusCode, 403, outsiderList.body);

    const outsiderCreate = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.outsider),
      payload: { scene_id: fixture.sceneId, lane: "prop", title: "非成员开单" },
    });
    assert.equal(outsiderCreate.statusCode, 403, outsiderCreate.body);

    const viewerCreate = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.viewer),
      payload: { scene_id: fixture.sceneId, lane: "prop", title: "查看者开单" },
    });
    assert.equal(viewerCreate.statusCode, 403, viewerCreate.body);

    const viewerList = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.viewer),
    });
    assert.equal(viewerList.statusCode, 200, viewerList.body);
    assert.equal(viewerList.json().data.length, 1);

    const missing = await fixture.app.inject({
      method: "GET",
      url: `/api/v1/casting-tasks/${randomUUID()}`,
      headers: as(fixture.owner),
    });
    assert.equal(missing.statusCode, 404, missing.body);
  }));

test("casting tasks: 列表按 status / assignee_user_id / shot_id 过滤", { skip: !databaseUrl }, async () =>
  withFixture(async (fixture) => {
    const openShotTask = await createTask(fixture, fixture.owner, {
      scene_id: fixture.sceneId,
      shot_id: fixture.shotId,
      lane: "character",
      title: "镜级单 A",
      assignee_user_id: fixture.editor.id,
    });
    await createTask(fixture, fixture.owner, {
      scene_id: fixture.sceneId,
      shot_id: fixture.otherShotId,
      lane: "prop",
      title: "镜级单 B",
    });
    await createTask(fixture, fixture.owner, {
      scene_id: fixture.otherSceneId,
      lane: "scene",
      title: "场级单 C",
      assignee_user_id: fixture.viewer.id,
    });

    const all = await listTasks(fixture, fixture.viewer, "");
    assert.equal(all.length, 3);

    const byStatusOpen = await listTasks(fixture, fixture.viewer, "status=open");
    assert.equal(byStatusOpen.length, 3);
    const byStatusOther = await listTasks(fixture, fixture.viewer, "status=claimed");
    assert.equal(byStatusOther.length, 0, "本卡只产生 open,其他状态过滤必须为空");

    const byAssignee = await listTasks(fixture, fixture.viewer, `assignee_user_id=${fixture.editor.id}`);
    assert.deepEqual(byAssignee.map((task) => task.id), [openShotTask.id]);

    const byShot = await listTasks(fixture, fixture.viewer, `shot_id=${fixture.otherShotId}`);
    assert.equal(byShot.length, 1);
    assert.equal(byShot[0]?.title, "镜级单 B");

    const combined = await listTasks(
      fixture,
      fixture.viewer,
      `status=open&assignee_user_id=${fixture.editor.id}&shot_id=${fixture.shotId}`,
    );
    assert.deepEqual(combined.map((task) => task.id), [openShotTask.id]);
  }));

test("casting tasks: 改单只改 title / brief / assignee_user_id", { skip: !databaseUrl }, async () =>
  withFixture(async (fixture) => {
    const created = await createTask(fixture, fixture.owner, {
      scene_id: fixture.sceneId,
      lane: "lighting",
      title: "缺光影参考",
      assignee_user_id: fixture.editor.id,
    });

    const patched = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/casting-tasks/${created.id}`,
      headers: as(fixture.owner),
      payload: { title: "缺夜景光影参考", brief: "低调布光", assignee_user_id: fixture.viewer.id },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    const updated = patched.json().data;
    assert.equal(updated.title, "缺夜景光影参考");
    assert.equal(updated.brief, "低调布光");
    assert.equal(updated.assignee_user_id, fixture.viewer.id);
    assert.equal(updated.status, "open");
    assert.notEqual(updated.updated_at, created.updated_at);

    const unassigned = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/casting-tasks/${created.id}`,
      headers: as(fixture.editor),
      payload: { assignee_user_id: null },
    });
    assert.equal(unassigned.statusCode, 200, unassigned.body);
    assert.equal(unassigned.json().data.assignee_user_id, null, "传 null 必须改回待认领");

    const emptyPatch = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/casting-tasks/${created.id}`,
      headers: as(fixture.owner),
      payload: {},
    });
    assert.equal(emptyPatch.statusCode, 400, emptyPatch.body);

    // 改派给项目外的人是允许的：承接人是普通用户 ID，不是项目角色。
    const assignOutsider = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/casting-tasks/${created.id}`,
      headers: as(fixture.owner),
      payload: { assignee_user_id: fixture.outsider.id },
    });
    assert.equal(assignOutsider.statusCode, 200, assignOutsider.body);
    assert.equal(assignOutsider.json().data.assignee_user_id, fixture.outsider.id);

    const missingAssignee = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/casting-tasks/${created.id}`,
      headers: as(fixture.owner),
      payload: { assignee_user_id: randomUUID() },
    });
    assert.equal(missingAssignee.statusCode, 400, missingAssignee.body);

    const viewerPatch = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/casting-tasks/${created.id}`,
      headers: as(fixture.viewer),
      payload: { title: "查看者改单" },
    });
    assert.equal(viewerPatch.statusCode, 403, viewerPatch.body);

    const outsiderPatch = await fixture.app.inject({
      method: "PATCH",
      url: `/api/v1/casting-tasks/${created.id}`,
      headers: as(fixture.outsider),
      payload: { title: "非成员改单" },
    });
    assert.equal(outsiderPatch.statusCode, 403, outsiderPatch.body);
  }));

test("casting tasks: 场镜归属与承接人校验", { skip: !databaseUrl }, async () =>
  withFixture(async (fixture) => {
    const shotNotInScene = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.owner),
      payload: {
        scene_id: fixture.otherSceneId,
        shot_id: fixture.shotId,
        lane: "character",
        title: "镜头不属于该场",
      },
    });
    assert.equal(shotNotInScene.statusCode, 400, shotNotInScene.body);

    const sceneMissing = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.owner),
      payload: { scene_id: randomUUID(), lane: "character", title: "场不存在" },
    });
    assert.equal(sceneMissing.statusCode, 400, sceneMissing.body);

    // 承接人是普通用户 ID，不查项目成员身份:项目外的人照样能被派单。
    // 「谁是抽卡师」等于「谁被派了抽卡任务」，系统里不做第三处定义。
    const assigneeOutsider = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.owner),
      payload: {
        scene_id: fixture.sceneId,
        lane: "character",
        title: "派给项目外的抽卡师",
        assignee_user_id: fixture.outsider.id,
      },
    });
    assert.equal(assigneeOutsider.statusCode, 201, assigneeOutsider.body);
    assert.equal(assigneeOutsider.json().data.assignee_user_id, fixture.outsider.id);

    // 但用户得真存在——FK 的 23503 翻成一句人话，不是 500。
    const assigneeMissing = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.owner),
      payload: {
        scene_id: fixture.sceneId,
        lane: "character",
        title: "承接人不存在",
        assignee_user_id: randomUUID(),
      },
    });
    assert.equal(assigneeMissing.statusCode, 400, assigneeMissing.body);

    // 平台 admin 非项目成员也能开单（既有能力矩阵：admin 全局可写）。
    const adminCreate = await fixture.app.inject({
      method: "POST",
      url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
      headers: as(fixture.admin),
      payload: { scene_id: fixture.sceneId, lane: "audio", title: "缺环境音参考" },
    });
    assert.equal(adminCreate.statusCode, 201, adminCreate.body);
  }));

interface CreatedTask {
  id: string;
  title: string;
  updated_at: string;
  [key: string]: unknown;
}

async function createTask(
  fixture: Fixture,
  user: FixtureUser,
  payload: Record<string, unknown>,
): Promise<CreatedTask> {
  const response = await fixture.app.inject({
    method: "POST",
    url: `/api/v1/projects/${fixture.projectId}/casting-tasks`,
    headers: as(user),
    payload,
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().data as CreatedTask;
}

async function listTasks(
  fixture: Fixture,
  user: FixtureUser,
  query: string,
): Promise<CreatedTask[]> {
  const response = await fixture.app.inject({
    method: "GET",
    url: `/api/v1/projects/${fixture.projectId}/casting-tasks${query ? `?${query}` : ""}`,
    headers: as(user),
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().data as CreatedTask[];
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const now = new Date("2026-08-12T08:00:00.000Z");
  const owner: FixtureUser = { id: randomUUID(), username: `casting-owner-${randomUUID().slice(0, 8)}`, displayName: "抽卡负责人" };
  const editor: FixtureUser = { id: randomUUID(), username: `casting-editor-${randomUUID().slice(0, 8)}`, displayName: "抽卡编辑" };
  const viewer: FixtureUser = { id: randomUUID(), username: `casting-viewer-${randomUUID().slice(0, 8)}`, displayName: "抽卡查看" };
  const outsider: FixtureUser = { id: randomUUID(), username: `casting-outsider-${randomUUID().slice(0, 8)}`, displayName: "项目外人" };
  const admin: FixtureUser = { id: randomUUID(), username: `casting-admin-${randomUUID().slice(0, 8)}`, displayName: "平台管理员", role: "admin" };
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const sceneId = randomUUID();
  const otherSceneId = randomUUID();
  const shotId = randomUUID();
  const otherShotId = randomUUID();
  const looseShotId = randomUUID();
  const inactiveLane = `off-${randomUUID().slice(0, 8)}`;
  const allUsers = [owner, editor, viewer, outsider, admin];

  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (request) => {
    const username = request.headers["x-casting-test-user"];
    const user = allUsers.find((candidate) => candidate.username === username);
    if (user) {
      request.authUser = {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        ...(user.role ? { role: user.role } : {}),
      };
    }
  });
  await registerCastingTaskRoutes(app, () => handle.db);

  try {
    await handle.db.insert(users).values(allUsers.map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      passwordHash: "test-only-hash",
      active: true,
      role: user.role ?? "member",
      createdAt: now,
      updatedAt: now,
    })));
    await handle.db.insert(projects).values({
      id: projectId,
      ownerUserId: owner.id,
      name: "抽卡任务项目",
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(episodes).values({
      id: episodeId,
      projectId,
      episodeNo: 1,
      name: "第一集",
      sortOrder: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(scenes).values([
      sceneValues(sceneId, episodeId, 1, now),
      sceneValues(otherSceneId, episodeId, 2, now),
    ]);
    await handle.db.insert(shots).values([
      shotValues(shotId, episodeId, sceneId, "CT-01", now),
      shotValues(otherShotId, episodeId, sceneId, "CT-02", now),
      // shots.scene_id 可空:无场镜头也要能开单。
      shotValues(looseShotId, episodeId, null, "CT-03", now),
    ]);
    await handle.db.insert(projectMembers).values([
      { projectId, userId: editor.id, role: "editor", addedByUserId: owner.id, createdAt: now },
      { projectId, userId: viewer.id, role: "viewer", addedByUserId: owner.id, createdAt: now },
    ]);
    await handle.db.insert(referenceLaneVocabulary).values({
      id: inactiveLane,
      displayName: "停用参考栏",
      domain: "style",
      pickKind: null,
      sort: 99,
      active: false,
      createdBy: null,
      createdAt: now,
    });

    await run({
      handle, app, owner, editor, viewer, outsider, admin,
      projectId, episodeId, sceneId, otherSceneId, shotId, otherShotId, looseShotId, inactiveLane, now,
    });
  } finally {
    await handle.db.delete(castingTasks).where(eq(castingTasks.projectId, projectId)).catch(() => undefined);
    await handle.db.delete(referenceLaneVocabulary).where(eq(referenceLaneVocabulary.id, inactiveLane)).catch(() => undefined);
    await handle.db.delete(projectMembers).where(eq(projectMembers.projectId, projectId)).catch(() => undefined);
    await handle.db.delete(shots).where(inArray(shots.id, [shotId, otherShotId, looseShotId])).catch(() => undefined);
    await handle.db.delete(scenes).where(inArray(scenes.id, [sceneId, otherSceneId])).catch(() => undefined);
    await handle.db.delete(episodes).where(eq(episodes.id, episodeId)).catch(() => undefined);
    await handle.db.delete(projects).where(eq(projects.id, projectId)).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, allUsers.map((user) => user.id))).catch(() => undefined);
    await app.close();
    await handle.pool.end();
  }
}

function sceneValues(id: string, episodeId: string, sceneNo: number, now: Date) {
  return {
    id,
    episodeId,
    sceneNo,
    name: `第 ${sceneNo} 场`,
    description: null,
    sortOrder: sceneNo,
    sourceBreakdownRunId: null,
    sourceCandidateId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function shotValues(id: string, episodeId: string, sceneId: string | null, code: string, now: Date) {
  return {
    id,
    episodeId,
    sceneId,
    shotCode: code,
    title: "抽卡测试镜头",
    scriptText: null,
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt: null,
    durationSeconds: null,
    sortOrder: 0,
    referenceAssetSnapshots: [],
    selectedImageResultId: null,
    selectedVideoResultId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}
