import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { registerVnextGenerationRoutes } from "../src/modules/vnext/generation/routes.js";

const source = await readFile(new URL("../src/modules/vnext/generation/routes.ts", import.meta.url), "utf8");

test("generation routes keep paid confirmation human-only", () => {
  assert.match(source, /generation-tasks[\s\S]*agentAccess:\s*"human_only"/);
  assert.equal(typeof registerVnextGenerationRoutes, "function");
});
