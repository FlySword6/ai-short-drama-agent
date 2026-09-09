import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const migrationPath = path.resolve("migrations/042_command_palette_nav_queue.sql");

test("迁移 042：nav.queue 标签、分组与幂等守卫对齐 Kimi 壳层", async () => {
  const source = await readFile(migrationPath, "utf8");

  assert.match(source, /"command":"nav\.queue"/);
  assert.match(source, /"label":"生产队列"/);
  assert.match(source, /导航到 `\/queue`/);
  assert.match(source, /entry\.entry_key = 'back_office'/);
  assert.match(source, /jsonb_array_elements\(entry\.payload -> 'items'\)/);
  assert.match(source, /item\.value ->> 'command' = 'nav\.queue'/);
  assert.doesNotMatch(source, /"requires":"admin"/, "生产队列是全局入口，不应被播成管理员专属");
  assert.doesNotMatch(source, /\bSET\s+(?:source|sort|status)\b/i, "042 不应覆盖既有分组治理字段");
});
