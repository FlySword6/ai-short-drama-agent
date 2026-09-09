import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("默认策略迁移包含唯一策略、乐观版本和 JSON 约束", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.resolve(here, "../../../../migrations/005_generation_default_strategies.sql"), "utf8");
  assert.match(source, /generation_default_strategies_project_media_unique/);
  assert.match(source, /CHECK \(media_kind IN \('image', 'video'\)\)/);
  assert.match(source, /CHECK \(mode IN \('direct_reference', 'material_to_prompt'\)\)/);
  assert.match(source, /CHECK \(jsonb_typeof\(parameters\) = 'object'\)/);
  assert.match(source, /CHECK \(version > 0\)/);
  assert.match(source, /应用启动不应自动执行迁移/);
});

test("迁移 071 把默认策略 CHECK 放宽到 audio + text_to_speech(Lite 音频默认档)", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.resolve(here, "../../../../migrations/072_generation_default_audio.sql"), "utf8");
  assert.match(source, /'image', 'video', 'audio'/);
  assert.match(source, /'direct_reference', 'material_to_prompt', 'text_to_speech'/);
  assert.match(source, /generation_default_strategies/);
});
