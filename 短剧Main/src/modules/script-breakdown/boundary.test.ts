import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * 草稿区边界合同(本包验收核心之一,静态层):
 * - 编排/纯函数层(service/types/schemas/validators/mapper/lines 与整个
 *   agent 目录)不得 import 数据库 schema——它们连正式表的名字都不该知道;
 * - 全模块只有 repository.ts 允许触碰 scenes/shots 与正式资产表,且写入
 *   只能由 confirmRun 的人工确认事务触发;
 * - 动态层证据见 service.test.ts(执行后 confirmCalls 为 0)与
 *   tests/script-breakdown-db.test.ts(执行后正式表行数为 0)。
 */
const moduleDir = path.resolve("src/modules/script-breakdown");

/**
 * 清单从文件系统列出来,不再手写。手写的清单会在删文件时变成 ENOENT,
 * 更糟的是新增文件默认不在守卫范围内——agent 目录整个进来就是这么补的。
 */
function pureFiles(): string[] {
  const top = readdirSync(moduleDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "repository.ts")
    .map((name) => path.join(moduleDir, name));
  const agent = readdirSync(path.join(moduleDir, "agent"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => path.join(moduleDir, "agent", name));
  return [...top, ...agent];
}

test("编排与纯函数层不 import 数据库 schema", () => {
  const files = pureFiles();
  assert.ok(files.some((file) => file.endsWith("service.ts")), "清单没列到 service.ts,守卫是空的");
  assert.ok(files.some((file) => file.includes(`agent${path.sep}runner.ts`)), "agent 目录必须在守卫范围内");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      !source.includes("db/schema.js"),
      `${path.relative(moduleDir, file)} 不得 import 数据库 schema(草稿区边界:正式表只许出现在 repository 确认事务)`,
    );
  }
});

test("全模块只有 repository.ts 能提 scenes/shots 表", () => {
  const files = readdirSync(moduleDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  for (const file of files) {
    const source = readFileSync(path.join(moduleDir, file), "utf8");
    if (file === "repository.ts") continue;
    const touchesFormalTables = /\b(scenes|shots)\b/.test(source) && source.includes("schema.js");
    assert.ok(!touchesFormalTables, `${file} 不得引用正式 scenes/shots 表`);
  }
});

test("repository 对正式表的写只在确认事务内", () => {
  const source = readFileSync(path.join(moduleDir, "repository.ts"), "utf8");
  const confirmStart = source.indexOf("async confirmRun(");
  const confirmEnd = source.indexOf("async discardRun(");
  assert.ok(confirmStart > 0 && confirmEnd > confirmStart, "confirmRun 必须存在");
  const confirmBody = source.slice(confirmStart, confirmEnd);
  const outsideConfirm = source.slice(0, confirmStart) + source.slice(confirmEnd);
  assert.match(confirmBody, /tx\.insert\(scenes\)/, "确认事务必须写正式场");
  assert.match(confirmBody, /tx\.insert\(shots\)/, "确认事务必须写正式分镜");
  assert.match(confirmBody, /materializeAssetCandidates\(/, "确认事务必须把资产候选转为正式项目资产");
  assert.ok(!/\.insert\(scenes\)|\.insert\(shots\)|\.update\(scenes\)|\.update\(shots\)/.test(outsideConfirm),
    "confirmRun 之外不得有任何正式 scenes/shots 写路径");
  // 除确认事务调用的资产物化 helper 外，执行/落草稿路径只能写三张草稿区表。
  const allowedTables = [
    "episodeScriptVersions",
    "scriptBreakdownRuns",
    "scriptBreakdownRunStages",
    "assetEntities",
    "projectAssetRefs",
  ];
  const inserts = [...outsideConfirm.matchAll(/\.insert\((\w+)\)/g)].map((match) => match[1]);
  for (const table of inserts) {
    assert.ok(allowedTables.includes(table!), `草稿区路径出现意外写入表:${table}`);
  }
});
