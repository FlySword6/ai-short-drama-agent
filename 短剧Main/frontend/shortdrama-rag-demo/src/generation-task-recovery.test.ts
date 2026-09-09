import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetGenerationRequest,
  recoverGenerationTask,
  rememberGenerationRequest,
} from "./generation-task-recovery";
import type { GenerationTask } from "./types";

const projectId = "22222222-2222-4222-8222-222222222222";
const shotId = "77777777-7777-4777-8777-777777777777";
const requestId = "88888888-8888-4888-8888-888888888888";

test("刷新后按项目、分镜和媒体类型从后端恢复任务", async () => {
  const storage = memoryStorage();
  rememberGenerationRequest(storage, projectId, shotId, "video", requestId);
  const loaded: string[] = [];
  const task = await recoverGenerationTask(storage, projectId, shotId, "video", async (id) => {
    loaded.push(id);
    return { generation_request_id: id, status: "running" } satisfies GenerationTask;
  });

  assert.deepEqual(loaded, [requestId]);
  assert.equal(task?.generation_request_id, requestId);
  assert.equal(task?.status, "running");

  forgetGenerationRequest(storage, projectId, shotId, "video");
  assert.equal(await recoverGenerationTask(storage, projectId, shotId, "video", async () => task!), null);
});

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
