import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_TOOL_NAMES, createAssistantTools } from "./tools.js";
import type { AssistantToolServices } from "./types.js";
import type { VnextProjectService } from "../vnext/service.js";

function services(calls: Array<Record<string, unknown>>): AssistantToolServices {
  return {
    searchAssets: async (input) => { calls.push({ name: "search", ...input }); return { receipt: { kind: "asset_search" } }; },
    addProjectAsset: async (input) => { calls.push({ name: "add", ...input }); return { receipt: { kind: "project_asset_added" } }; },
    executeDirectorCommand: async (input) => { calls.push({ name: "director", ...input }); return { receipt: { kind: "director_command" } }; },
    prepareGenerationCard: async (input) => { calls.push({ name: "prepare", ...input }); return { receipt: { kind: "generation_preparation" } }; },
    getGenerationTask: async (input) => { calls.push({ name: "task", ...input }); return { receipt: { kind: "generation_task" } }; },
  };
}

test("只注册 I04 的五类允许工具", () => {
  const tools = createAssistantTools({ sessionId: "s1", userId: "u1", projectId: "p1", shotId: "sh1" }, services([]));
  assert.deepEqual(tools.map((tool) => tool.name), ASSISTANT_TOOL_NAMES);
  assert.equal(tools.some((tool) => tool.name === "generate_media"), false);
});

test("结构化 DirectorCommand 注入认证与项目上下文", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = createAssistantTools({ sessionId: "s1", userId: "u1", projectId: "p1" }, services(calls))
    .find((candidate) => candidate.name === "execute_director_command");
  assert.ok(tool);
  await tool.execute("call-1", { action: "set_camera", camera_id: "camera-1", position: [1, 2, 3], target: [0, 0, 0] });
  assert.deepEqual(calls[0], {
    name: "director", actorId: "u1", projectId: "p1",
    command: { action: "set_camera", cameraId: "camera-1", position: [1, 2, 3], target: [0, 0, 0] },
    signal: undefined,
  });
});

test("生成只准备卡并注入当前分镜，不提供付费提交参数", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const tool = createAssistantTools({ sessionId: "s1", userId: "u1", projectId: "p1", shotId: "sh1" }, services(calls))
    .find((candidate) => candidate.name === "prepare_generation_card");
  assert.ok(tool);
  await tool.execute("call-1", { media_kind: "video", prompt: "角色转身", reference_media_ids: ["media-1"], parameters: { duration_seconds: 4 } });
  assert.deepEqual(calls[0], {
    name: "prepare", actorId: "u1", projectId: "p1", shotId: "sh1", mediaKind: "video",
    prompt: "角色转身", referenceMediaIds: ["media-1"], parameters: { duration_seconds: 4 }, signal: undefined,
  });
});

test("没有项目或分镜时拒绝安全写操作和生成准备", async () => {
  const tools = createAssistantTools({ sessionId: "s1", userId: "u1" }, services([]));
  const director = tools.find((tool) => tool.name === "execute_director_command");
  const prepare = tools.find((tool) => tool.name === "prepare_generation_card");
  assert.ok(director);
  assert.ok(prepare);
  await assert.rejects(director.execute("call-1", { action: "capture_snapshot", name: "构图" }), /没有选择项目/);
  await assert.rejects(prepare.execute("call-2", { media_kind: "image", prompt: "角色肖像" }), /没有选择项目/);
});

test("vNext 上下文只在注入同一项目服务时注册真实画布工具", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const vnextProjectService = {
    getDocument: async (actor: { id: string }, projectId: string) => {
      calls.push({ name: "getDocument", actor, projectId });
      return {
        projectId,
        revision: 1,
        document: { schemaVersion: 1, nodes: [], edges: [] },
        updatedAt: new Date("2026-08-14T00:00:00.000Z"),
        lastWrite: null,
      };
    },
    replaceDocument: async (input: Record<string, unknown>) => {
      calls.push({ name: "replaceDocument", ...input });
      return {
        projectId: "11111111-1111-4111-8111-111111111111",
        revision: 2,
        document: { schemaVersion: 1, nodes: [], edges: [] },
        updatedAt: new Date("2026-08-14T00:00:00.000Z"),
        lastWrite: {
          kind: "agent",
          userId: "22222222-2222-4222-8222-222222222222",
          at: new Date("2026-08-14T00:00:00.000Z"),
        },
      };
    },
  } as unknown as VnextProjectService;
  const tools = createAssistantTools(
    {
      sessionId: "33333333-3333-4333-8333-333333333333",
      userId: "22222222-2222-4222-8222-222222222222",
      vnextProjectId: "11111111-1111-4111-8111-111111111111",
    },
    { ...services([]), vnextProjectService },
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [...ASSISTANT_TOOL_NAMES, "get_vnext_canvas", "write_vnext_canvas"],
  );
  const readTool = tools.find((candidate) => candidate.name === "get_vnext_canvas");
  const tool = tools.find((candidate) => candidate.name === "write_vnext_canvas");
  assert.ok(readTool);
  assert.ok(tool);
  const read = await readTool.execute("call-vnext-read", {});
  assert.equal((read.details as { revision: number }).revision, 1);
  await tool.execute("call-vnext", {
    expected_revision: 1,
    document: { schema_version: 1, nodes: [], edges: [] },
  });
  assert.deepEqual(calls[0], {
    name: "getDocument",
    actor: { id: "22222222-2222-4222-8222-222222222222" },
    projectId: "11111111-1111-4111-8111-111111111111",
  });
  assert.deepEqual(calls[1], {
    name: "replaceDocument",
    actor: { id: "22222222-2222-4222-8222-222222222222" },
    projectId: "11111111-1111-4111-8111-111111111111",
    expectedRevision: 1,
    document: { schemaVersion: 1, nodes: [], edges: [] },
    actorKind: "agent",
  });
  assert.throws(
    () => createAssistantTools(
      {
        sessionId: "33333333-3333-4333-8333-333333333333",
        userId: "22222222-2222-4222-8222-222222222222",
        vnextProjectId: "11111111-1111-4111-8111-111111111111",
      },
      services([]),
    ),
    /requires VnextProjectService/,
  );
});
