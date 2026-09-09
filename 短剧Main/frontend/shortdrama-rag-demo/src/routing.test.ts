import assert from "node:assert/strict";
import test from "node:test";
import { projectStoryboardPath, shotWorkbenchPath } from "./routing.js";

test("项目默认进入分镜生产页", () => {
  assert.equal(
    projectStoryboardPath("project 1"),
    "/projects/project%201/storyboards",
  );
});

test("分镜工作台路径编码项目、剧集和分镜 id", () => {
  assert.equal(
    shotWorkbenchPath("project 1", "episode/1", "shot 1"),
    "/projects/project%201/storyboards/episode%2F1/shots/shot%201",
  );
});
