import assert from "node:assert/strict";
import test from "node:test";
import { createTemplateRegistry, defaultTemplatesDirectory } from "./registry.js";
import { directorTemplateSchema, TEMPLATE_CATEGORIES } from "./types.js";

const registry = createTemplateRegistry();

test("registry 加载 assets/director/templates 下全部 11 个模版", () => {
  assert.equal(registry.size(), 11);
  assert.equal(
    defaultTemplatesDirectory().replaceAll("\\", "/").endsWith("assets/director/templates"),
    true,
  );
});

test("每个模版都过 zod schema、2-6 个机位、字段完整", () => {
  const summaries = registry.list();
  assert.equal(summaries.length, 11);
  const ids = new Set<string>();
  for (const summary of summaries) {
    ids.add(summary.id);
    assert.ok(summary.name.length > 0, `${summary.id} 缺少 name`);
    assert.ok(TEMPLATE_CATEGORIES.includes(summary.category), `${summary.id} category 非法`);
    assert.ok(summary.tags.length > 0, `${summary.id} 缺少 tags`);
    assert.ok(summary.cameraCount >= 2 && summary.cameraCount <= 6, `${summary.id} 机位数 ${summary.cameraCount} 不在 2-6`);
    assert.match(summary.dataSource, /^tianzun-master-table:T\d+$/);

    const template = registry.get(summary.id);
    assert.ok(template, `${summary.id} get 失败`);
    assert.equal(template.characterCount, template.characters.length, `${summary.id} characterCount 与角色数不一致`);
    assert.equal(template.cameras.length, summary.cameraCount);
    // registry 已 parse 过一次，这里再独立校验一次 schema 本身与文件内容一致
    assert.equal(directorTemplateSchema.safeParse(template).success, true, `${summary.id} 二次 schema 校验失败`);
  }
  assert.equal(ids.size, 11, "模版 id 重复");
});

test("schema 拒绝非法模版", () => {
  const base = registry.get("dialogue-reverse-2p");
  assert.ok(base);
  const missingName = { ...structuredClone(base), name: "" };
  assert.equal(directorTemplateSchema.safeParse(missingName).success, false);

  const badFocal = structuredClone(base);
  badFocal.cameras[0] = { ...badFocal.cameras[0]!, focalLength: 42 } as never;
  assert.equal(directorTemplateSchema.safeParse(badFocal).success, false);

  const badCategory = { ...structuredClone(base), category: "romance" };
  assert.equal(directorTemplateSchema.safeParse(badCategory).success, false);
});
