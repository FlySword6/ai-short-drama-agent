import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetPendingLiteRun,
  readPendingLiteRun,
  rememberPendingLiteRun,
  toLiteTelemetryPayload,
} from "./pages/lite/lite-telemetry";


test("Lite 事件固定带 project_id 与 episode_id，只保留效率归因字段", () => {
  const payload = toLiteTelemetryPayload({
    event: "lite_script_confirmed",
    projectId: "project-1",
    episodeId: "episode-1",
    runId: "run-1",
    mode: "auto",
    outcome: "confirmed",
    sceneCount: 3,
    shotCount: 12,
    completedAt: "2026-08-22T10:00:00.000Z",
  });
  assert.deepEqual(payload, {
    event: "lite_script_confirmed",
    props: {
      project_id: "project-1",
      episode_id: "episode-1",
      run_id: "run-1",
      mode: "auto",
      outcome: "confirmed",
      scene_count: 3,
      shot_count: 12,
      completed_at: "2026-08-22T10:00:00.000Z",
    },
  });
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["raw_text", "title", "prompt", "name", "username"]) {
    assert.equal(serialized.includes(forbidden), false, `埋点不得带 ${forbidden}`);
  }
});

test("剧本提交保留 created/existing 结果，统计时可按 run 去重", () => {
  assert.deepEqual(toLiteTelemetryPayload({
    event: "lite_script_submitted",
    projectId: "project-1",
    episodeId: "episode-1",
    runId: "run-1",
    rework: true,
    outcome: "existing",
  }), {
    event: "lite_script_submitted",
    props: {
      project_id: "project-1",
      episode_id: "episode-1",
      run_id: "run-1",
      rework: true,
      outcome: "existing",
    },
  });
});

test("生成提交与满意版本选用可按集、镜、请求串起尝试次数", () => {
  assert.deepEqual(toLiteTelemetryPayload({
    event: "lite_generation_submitted",
    projectId: "project-1",
    episodeId: "episode-1",
    shotId: "shot-1",
    requestId: "request-1",
    mediaKind: "video",
    preview: false,
  }), {
    event: "lite_generation_submitted",
    props: {
      project_id: "project-1",
      episode_id: "episode-1",
      shot_id: "shot-1",
      request_id: "request-1",
      media_kind: "video",
      preview: false,
    },
  });
  assert.deepEqual(toLiteTelemetryPayload({
    event: "lite_media_selected",
    projectId: "project-1",
    episodeId: "episode-1",
    shotId: "shot-1",
    mediaId: "media-1",
    mediaKind: "image",
    approvedInAction: true,
  }), {
    event: "lite_media_selected",
    props: {
      project_id: "project-1",
      episode_id: "episode-1",
      shot_id: "shot-1",
      media_id: "media-1",
      media_kind: "image",
      approved_in_action: true,
    },
  });
});


test("刷新页面后仍能恢复待确认 run，避免丢失阶段终点", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } as Storage;

  rememberPendingLiteRun(storage, "project-1", "episode-1", { runId: "run-1" });
  assert.deepEqual(readPendingLiteRun(storage, "project-1", "episode-1"), { runId: "run-1" });
  forgetPendingLiteRun(storage, "project-1", "episode-1");
  assert.equal(readPendingLiteRun(storage, "project-1", "episode-1"), null);
});
