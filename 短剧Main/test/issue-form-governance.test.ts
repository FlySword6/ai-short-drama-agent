import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../.github/workflows/issue-form-governance.yml", import.meta.url), "utf8");
const syncStart = source.lastIndexOf("const currentLabels");
const syncEnd = source.indexOf("if (missing.length > 0)", syncStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart, "找不到标签同步代码块");
const sync = source.slice(syncStart, syncEnd);

test("表单重校验只增删 needs-triage，保留 team/type/priority 与其它流程标签", () => {
  assert.match(sync, /managed\s*=\s*\(name\)\s*=>\s*name\s*===\s*"needs-triage"/);
  assert.match(sync, /desired\s*=\s*missing\.length\s*===\s*0\s*\?\s*\[\]\s*:\s*\["needs-triage"\]/);
  assert.doesNotMatch(sync, /startsWith\("priority:"\)|startsWith\("type:"\)|startsWith\("team:"\)/);
  assert.doesNotMatch(sync, /desired = missing\.length === 0 \? selected/);
});

test("team/type/priority 表单映射仍用于判定字段是否合法，不再拥有标签删除权", () => {
  assert.match(source, /mappings\.priority\[values\.priority\]/);
  assert.match(source, /mappings\.type\[values\.type\]/);
  assert.match(source, /mappings\.team\[values\.team\]/);
  assert.match(source, /if \(!selected\[0\]\) missing\.push\("优先级"\)/);
  assert.match(source, /if \(!selected\[1\]\) missing\.push\("类型"\)/);
  assert.match(source, /if \(!selected\[2\]\) missing\.push\("归属组"\)/);
});
