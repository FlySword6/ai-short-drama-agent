import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { registerVnextVideoVersionRoutes } from "../src/modules/vnext/video-versions/routes.js";

const source = await readFile(new URL("../src/modules/vnext/video-versions/routes.ts", import.meta.url), "utf8");

test("video version routes keep draft and attach mutations human-only", () => {
  const humanOnlyCount = (source.match(/agentAccess:\s*"human_only"/g) ?? []).length;
  assert.ok(humanOnlyCount >= 2, "draft creation and version attach must both be human-only");
  assert.equal(typeof registerVnextVideoVersionRoutes, "function");
});
