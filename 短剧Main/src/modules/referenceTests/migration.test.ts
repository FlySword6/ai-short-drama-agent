import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("参考测试迁移保存配置、结果来源关联和稳定列表索引", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.resolve(here, "../../../migrations/008_reference_tests.sql"), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.reference_tests/);
  assert.match(source, /reference_tests_media_kind_check CHECK \(media_kind IN \('image', 'video'\)\)/);
  assert.match(source, /reference_tests_mode_check CHECK \(mode IN \('direct_reference', 'material_to_prompt'\)\)/);
  assert.match(source, /reference_tests_version_check CHECK \(version > 0\)/);
  assert.match(source, /reference_test_results.*generation_request_id/s);
  assert.match(source, /reference_test_results.*media_result_id/s);
  assert.match(source, /reference_test_results_test_created_idx/);
  assert.match(source, /不创建生成任务，也不调用模型供应商/);
});
