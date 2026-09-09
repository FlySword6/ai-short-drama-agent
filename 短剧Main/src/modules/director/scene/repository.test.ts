import assert from "node:assert/strict";
import test from "node:test";
import { settings } from "../../../config/env.js";
import { ConflictError, NotFoundError } from "../../../shared/errors.js";
import {
  PgDirectorSceneRepository,
  type DirectorDbClient,
  type DirectorDbExecutor,
  type DirectorDbQueryResult,
} from "./repository.js";

/**
 * repository 单测：假 pg client 按脚本断言 SQL 序列并返回预置行，
 * 验证乐观锁、版本单调 +1 与留痕的 SQL 流程；项目访问由服务层的
 * ProjectAccessService 统一判定，不在 repository 复制 owner 查询。
 */

// schema 名从配置来，不写死。写死过一次 "common"：本机 .env 恰好是 common 时
// 门禁全绿，改回规范值 app 就红——等于在校验开发者的 .env 而不是代码行为。
// 模板里的 {} 会被换成当前 schema。
const sql = (pattern: string) => new RegExp(pattern.replaceAll("{}", settings.postgresSchema));

const actorId = "11111111-1111-4111-8111-111111111111";
const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sceneId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const versionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

interface FakeQuery {
  match: RegExp;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
}

function fakeExecutor(script: FakeQuery[]) {
  const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
  const run = (text: string, values?: unknown[]): DirectorDbQueryResult => {
    calls.push({ text, values });
    const expected = script.shift();
    assert.ok(expected, `未预期的 SQL: ${text}`);
    assert.match(text.replace(/\s+/g, " "), expected.match);
    return { rows: expected.rows ?? [], rowCount: expected.rowCount ?? expected.rows?.length ?? 0 };
  };
  const client: DirectorDbClient = { query: async (text, values) => run(text, values) };
  const executor: DirectorDbExecutor = {
    query: client.query,
    transaction: async (fn) => fn(client),
  };
  return {
    executor,
    calls,
    assertConsumed: () => assert.equal(script.length, 0, `还有 ${script.length} 条预期 SQL 未执行`),
  };
}

function sceneRow(overrides: Record<string, unknown> = {}) {
  return {
    id: sceneId,
    project_id: projectId,
    status: "saved",
    current_version: 1,
    snapshot: { schemaVersion: 1, objects: [] },
    created_by_user_id: actorId,
    created_at: new Date("2026-07-20T00:00:00.000Z"),
    updated_at: new Date("2026-07-20T00:00:00.000Z"),
    ...overrides,
  };
}

function versionRow(version: number, isCurrent = true) {
  return {
    id: versionId,
    scene_id: sceneId,
    version,
    is_current: isCurrent,
    source_action: "manual_save",
    created_by_user_id: actorId,
    created_at: new Date("2026-07-20T00:00:00.000Z"),
  };
}

const snapshot = { schemaVersion: 1, objects: [{ id: "obj-a" }] };

test("saveVersion 创建路径：sceneVersion=0 创建场景并写入版本 1（留痕创建者与来源动作）", async () => {
  const { executor, calls, assertConsumed } = fakeExecutor([
    { match: sql("SELECT id, status, current_version FROM {}\\.director_scenes .* FOR UPDATE"), rows: [] },
    { match: sql("INSERT INTO {}\\.director_scenes"), rows: [{ id: sceneId }], rowCount: 1 },
    { match: sql("INSERT INTO {}\\.director_scene_versions"), rows: [versionRow(1)], rowCount: 1 },
    { match: sql("LEFT JOIN {}\\.director_scene_versions"), rows: [sceneRow({ current_version: 1 })] },
  ]);
  const repository = new PgDirectorSceneRepository(executor);
  const result = await repository.saveVersion({
    projectId, actorId, expectedVersion: 0, snapshot, sourceAction: "template_apply",
  });
  assert.equal(result.scene.id, sceneId);
  assert.equal(result.scene.currentVersion, 1);
  assert.equal(result.version.version, 1);
  assert.equal(result.version.kind, "current");

  const insertVersion = calls[2];
  assert.equal(insertVersion?.values?.[1], 1, "首版本号为 1");
  assert.equal(insertVersion?.values?.[2], JSON.stringify(snapshot));
  assert.equal(insertVersion?.values?.[3], "template_apply");
  assert.equal(insertVersion?.values?.[4], actorId);
  assertConsumed();
});

test("saveVersion 正常保存：版本单调 +1 并命中条件更新", async () => {
  const { executor, calls, assertConsumed } = fakeExecutor([
    { match: /FOR UPDATE/, rows: [{ id: sceneId, status: "saved", current_version: 2 }] },
    { match: sql("UPDATE {}\\.director_scenes"), rowCount: 1 },
    { match: sql("INSERT INTO {}\\.director_scene_versions"), rows: [versionRow(3)], rowCount: 1 },
    { match: /LEFT JOIN/, rows: [sceneRow({ current_version: 3 })] },
  ]);
  const repository = new PgDirectorSceneRepository(executor);
  const result = await repository.saveVersion({
    projectId, actorId, expectedVersion: 2, snapshot, sourceAction: "manual_save", status: "saved",
  });
  const update = calls[1];
  assert.deepEqual(update?.values, [sceneId, 3, "saved", 2], "条件更新携带新旧版本号");
  const insertVersion = calls[2];
  assert.equal(insertVersion?.values?.[1], 3);
  assert.equal(result.version.version, 3);
  assertConsumed();
});

test("saveVersion 版本不符返回 409 scene_version_conflict 且不写版本", async () => {
  const { executor, assertConsumed } = fakeExecutor([
    { match: /FOR UPDATE/, rows: [{ id: sceneId, status: "saved", current_version: 5 }] },
  ]);
  const repository = new PgDirectorSceneRepository(executor);
  await assert.rejects(
    repository.saveVersion({ projectId, actorId, expectedVersion: 2, snapshot, sourceAction: "manual_save" }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.code, "scene_version_conflict");
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, "保存场景没成：场景已被更新，请刷新后再试。");
      assert.deepEqual(error.details, { currentVersion: 5 });
      return true;
    },
  );
  assertConsumed();
});

test("saveVersion 并发写导致条件更新落空同样返回 409", async () => {
  const { executor } = fakeExecutor([
    { match: /FOR UPDATE/, rows: [{ id: sceneId, status: "saved", current_version: 2 }] },
    { match: sql("UPDATE {}\\.director_scenes"), rowCount: 0 },
  ]);
  const repository = new PgDirectorSceneRepository(executor);
  await assert.rejects(
    repository.saveVersion({ projectId, actorId, expectedVersion: 2, snapshot, sourceAction: "manual_save" }),
    (error: unknown) => error instanceof ConflictError && error.code === "scene_version_conflict",
  );
});

test("saveVersion 场景不存在但 sceneVersion>0 返回 404", async () => {
  const { executor } = fakeExecutor([
    { match: /FOR UPDATE/, rows: [] },
  ]);
  const repository = new PgDirectorSceneRepository(executor);
  await assert.rejects(
    repository.saveVersion({ projectId, actorId, expectedVersion: 4, snapshot, sourceAction: "manual_save" }),
    (error: unknown) => error instanceof NotFoundError,
  );
});

test("getScene 返回当前版本快照，无场景返回 null", async () => {
  const found = new PgDirectorSceneRepository(fakeExecutor([
    { match: /LEFT JOIN/, rows: [sceneRow({ current_version: 7 })] },
  ]).executor);
  const scene = await found.getScene(projectId);
  assert.equal(scene?.currentVersion, 7);
  assert.deepEqual(scene?.snapshot, { schemaVersion: 1, objects: [] });

  const missing = new PgDirectorSceneRepository(fakeExecutor([
    { match: /LEFT JOIN/, rows: [] },
  ]).executor);
  assert.equal(await missing.getScene(projectId), null);
});

test("listVersions 派生 current/historical 并按版本倒序", async () => {
  const repository = new PgDirectorSceneRepository(fakeExecutor([
    {
      match: sql("FROM {}\\.director_scene_versions v\\s+JOIN {}\\.director_scenes"),
      rows: [versionRow(3, true), versionRow(2, false), versionRow(1, false)],
    },
  ]).executor);
  const versions = await repository.listVersions(sceneId);
  assert.deepEqual(versions.map((item) => item.version), [3, 2, 1]);
  assert.deepEqual(versions.map((item) => item.kind), ["current", "historical", "historical"]);
});
