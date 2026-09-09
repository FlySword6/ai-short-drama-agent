/**
 * 3D 导演台 · 装载/保存编排测试（mock fetch：404 种子 / 200 装载 / PUT 成功 / 409 冲突 / 500 错误）
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import type { FetchLike } from "./api";
import { loadDirectorScene, saveDirectorSceneState } from "./persistence";
import { toSceneSnapshot } from "./snapshot";
import { useDirectorStore } from "./store";
import { newId } from "../../uuid";

const PROJECT_ID = newId();

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** 收集请求的 mock fetch */
function mockFetch(handler: (url: string, init?: { method?: string; body?: unknown }) => ReturnType<typeof jsonResponse>) {
  const calls: Array<{ url: string; init?: { method?: string; body?: unknown } }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetchImpl };
}

beforeEach(() => {
  useDirectorStore.getState().resetToSeed();
});

test("加载：GET 404 → seed（无已存版本）", async () => {
  const { fetchImpl } = mockFetch(() => jsonResponse(404, { ok: false, error: { code: "not_found", message: "导演场景不存在" } }));
  const result = await loadDirectorScene(PROJECT_ID, fetchImpl);
  assert.equal(result.kind, "seed");
});

test("加载：GET 200 → 解析快照为 store 切片（含版本号与 ephemeral 名单）", async () => {
  const snapshot = toSceneSnapshot(useDirectorStore.getState(), { persist: true });
  // 塞一个 ephemeral 对象验证名单透出
  (snapshot.objects as Array<Record<string, unknown>>).push({
    id: "ghost-1",
    type: "model",
    name: "旧模型",
    ephemeral: true,
    assetUrl: "",
    fileName: "old.glb",
    transform: { position: { x: 0, y: 0, z: 0 } },
  });
  const { calls, fetchImpl } = mockFetch(() =>
    jsonResponse(200, {
      ok: true,
      data: {
        id: "scene-1",
        projectId: PROJECT_ID,
        status: "saved",
        currentVersion: 3,
        snapshot,
      },
    }),
  );
  const result = await loadDirectorScene(PROJECT_ID, fetchImpl);
  assert.equal(result.kind, "loaded");
  if (result.kind === "loaded") {
    assert.equal(result.sceneId, "scene-1");
    assert.equal(result.sceneVersion, 3);
    // 空台快照：0 对象（ephemeral 旧模型被跳过并报名单）
    assert.equal(result.slice.order.length, 0);
    assert.deepEqual(result.skippedEphemeral, ["旧模型"]);
  }
  assert.ok(calls[0]?.url.includes(`/api/v1/projects/${PROJECT_ID}/director/scene`));
});

test("加载：GET 500 → error", async () => {
  const { fetchImpl } = mockFetch(() => jsonResponse(500, { ok: false, error: { code: "internal", message: "服务端错误" } }));
  const result = await loadDirectorScene(PROJECT_ID, fetchImpl);
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.equal(result.message, "服务端错误");
});

test("保存：PUT 200 → saved，请求体带 sceneVersion/snapshot/sourceAction", async () => {
  const { calls, fetchImpl } = mockFetch(() =>
    jsonResponse(200, {
      ok: true,
      data: {
        id: "scene-1",
        projectId: PROJECT_ID,
        status: "saved",
        currentVersion: 4,
        snapshot: {},
        savedVersion: { id: "v-4", version: 4, sourceAction: "template:apply:t-1" },
      },
    }),
  );
  const result = await saveDirectorSceneState(
    PROJECT_ID,
    { sceneVersion: 3, sourceAction: "template:apply:t-1" },
    fetchImpl,
  );
  assert.equal(result.kind, "saved");
  if (result.kind === "saved") {
    assert.equal(result.sceneId, "scene-1");
    assert.equal(result.sceneVersion, 4);
  }
  const call = calls[0]!;
  assert.equal(call.init?.method, "PUT");
  const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
  assert.equal(body["sceneVersion"], 3);
  assert.equal(body["sourceAction"], "template:apply:t-1");
  assert.equal(body["status"], "saved");
  const snapshot = body["snapshot"] as Record<string, unknown>;
  assert.equal(snapshot["schemaVersion"], 1);
  assert.ok(Array.isArray(snapshot["objects"]));
  assert.ok(Array.isArray(snapshot["cameras"]));
});

test("保存：PUT 409 scene_version_conflict → conflict 分支（带服务端当前版本）", async () => {
  const { fetchImpl } = mockFetch(() =>
    jsonResponse(409, {
      ok: false,
      error: {
        code: "scene_version_conflict",
        message: "场景版本不匹配，请刷新后重试",
        details: { currentVersion: 7 },
      },
    }),
  );
  const result = await saveDirectorSceneState(PROJECT_ID, { sceneVersion: 3 }, fetchImpl);
  assert.equal(result.kind, "conflict");
  if (result.kind === "conflict") assert.equal(result.currentVersion, 7);
});

test("保存：PUT 409 无 details → conflict 分支 currentVersion=null", async () => {
  const { fetchImpl } = mockFetch(() =>
    jsonResponse(409, { ok: false, error: { code: "conflict", message: "版本冲突" } }),
  );
  const result = await saveDirectorSceneState(PROJECT_ID, { sceneVersion: 0 }, fetchImpl);
  assert.equal(result.kind, "conflict");
  if (result.kind === "conflict") assert.equal(result.currentVersion, null);
});

test("保存：PUT 500 → error 分支", async () => {
  const { fetchImpl } = mockFetch(() =>
    jsonResponse(500, { ok: false, error: { code: "internal", message: "写入失败" } }),
  );
  const result = await saveDirectorSceneState(PROJECT_ID, { sceneVersion: 0 }, fetchImpl);
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.equal(result.message, "写入失败");
});
