import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("serving entrypoint never runs database migrations", async () => {
  const source = await readFile(path.resolve("src/server.ts"), "utf8");
  assert.doesNotMatch(source, /from "\.\/db\/migrate\.js"/);
  assert.doesNotMatch(source, /runMigrations\s*\(/);
  assert.match(source, /createApp\(/);
});
