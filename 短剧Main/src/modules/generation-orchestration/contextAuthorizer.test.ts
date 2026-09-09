import assert from "node:assert/strict";
import test from "node:test";
import { linkedShotSceneIsConsistent } from "./contextAuthorizer.js";

test("镜头与场景必须属于同一集，不能用同项目跨集异常关系绕过", () => {
  assert.equal(linkedShotSceneIsConsistent({
    shotEpisodeId: "10000000-0000-4000-8000-000000000001",
    shotSceneId: "10000000-0000-4000-8000-000000000002",
    linkedSceneId: "10000000-0000-4000-8000-000000000002",
    linkedSceneEpisodeId: "10000000-0000-4000-8000-000000000001",
    linkedSceneDeletedAt: null,
  }), true);
  assert.equal(linkedShotSceneIsConsistent({
    shotEpisodeId: "10000000-0000-4000-8000-000000000001",
    shotSceneId: "10000000-0000-4000-8000-000000000002",
    linkedSceneId: "10000000-0000-4000-8000-000000000002",
    linkedSceneEpisodeId: "10000000-0000-4000-8000-000000000003",
    linkedSceneDeletedAt: null,
  }), false);
});

test("无场景镜头允许 scene_id 为空；已删或错绑场景必须拒绝", () => {
  assert.equal(linkedShotSceneIsConsistent({
    shotEpisodeId: "10000000-0000-4000-8000-000000000001",
    shotSceneId: null,
    linkedSceneId: null,
    linkedSceneEpisodeId: null,
    linkedSceneDeletedAt: null,
  }), true);
  assert.equal(linkedShotSceneIsConsistent({
    shotEpisodeId: "10000000-0000-4000-8000-000000000001",
    shotSceneId: "10000000-0000-4000-8000-000000000002",
    linkedSceneId: "10000000-0000-4000-8000-000000000002",
    linkedSceneEpisodeId: "10000000-0000-4000-8000-000000000001",
    linkedSceneDeletedAt: new Date("2026-08-05T00:00:00.000Z"),
  }), false);
});
