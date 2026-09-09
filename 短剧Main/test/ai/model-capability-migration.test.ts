import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../../src/db/migrate.js";

/**
 * 护栏:模型容量登记表必须是「查得到就能用」的表,不是一张空壳。
 *
 * 起因(2026-08-07 拍板):输出上限此前写死在六处代码里,最先卡死的是网关全局
 * 硬顶 2048——一场戏要出 20+ 个结构化镜头,必然被截断。产品要求「查并存表」:
 * 既能从供应商查到真实容量,也在本地存成表。这一层校验的是表本身的三个不变量:
 *   1. 数值列必须是数字型(整数 token 数)。供应商返回的是 "1024k" 这种带单位
 *      字符串,如果原样落库,每个读取点都得重新解析一遍,解析口径必然分叉。
 *   2. 同一模型名允许多个版本共存。调用 ID = 模型名-版本号,换版本就是换 ID,
 *      旧版本还在被历史请求引用,不能被新版本挤掉。
 *   3. 种子数据必须随迁移一起落。表建好当天就要能被网关查到,否则同步器没跑
 *      之前所有调用都走兜底,等于这张表没上线。
 */

const migrationPath = path.resolve("migrations/059_model_capabilities.sql");

test("模型容量迁移被 schema 限定,且 token 列都是整数型而不是带单位字符串", async () => {
  const source = await readFile(migrationPath, "utf8");
  const rendered = renderMigrationSql(source, "common_model_capability_test");

  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_model_capability_test"\.model_capabilities/);

  // token 与限流列一律 integer:供应商的 "1024k" 必须在写入前换算成数字。
  for (const column of [
    "context_window_tokens",
    "max_input_tokens",
    "max_output_tokens",
    "max_reasoning_tokens",
    "rate_limit_rpm",
    "rate_limit_tpm",
  ]) {
    assert.match(
      rendered,
      new RegExp(`${column}\\s+integer`),
      `${column} 必须是 integer——带单位字符串落库会让每个读取点各自解析`,
    );
  }

  for (const column of ["model_name", "model_version", "callable_model_id", "provider", "data_source", "synced_at"]) {
    assert.match(rendered, new RegExp(`\\b${column}\\b`), `缺列 ${column}`);
  }
});

test("同一模型名允许多版本共存,调用 ID 唯一", async () => {
  const rendered = renderMigrationSql(await readFile(migrationPath, "utf8"), "common_model_capability_test");

  // 唯一键落在 callable_model_id 上,而不是 model_name 上。
  assert.match(rendered, /model_capabilities_callable_model_id_key|UNIQUE\s*\(\s*callable_model_id\s*\)/);
  assert.match(rendered, /model_capabilities_name_version_key|UNIQUE\s*\(\s*model_name,\s*model_version\s*\)/);
  assert.doesNotMatch(
    rendered,
    /UNIQUE\s*\(\s*model_name\s*\)/,
    "model_name 单列唯一会让同一模型换版本时挤掉旧版本",
  );
});

test("data_source 区分供应商查得与手工填写,且输出上限必须为正", async () => {
  const rendered = renderMigrationSql(await readFile(migrationPath, "utf8"), "common_model_capability_test");

  assert.match(rendered, /model_capabilities_data_source_check/);
  assert.match(rendered, /'provider_api'/);
  assert.match(rendered, /'manual'/);
  assert.match(rendered, /model_capabilities_positive_tokens_check/);
});

test("种子数据随迁移落地:两个已实测模型建表即可用", async () => {
  const rendered = renderMigrationSql(await readFile(migrationPath, "utf8"), "common_model_capability_test");

  assert.match(rendered, /INSERT INTO "common_model_capability_test"\.model_capabilities/);

  // deepseek-v4-flash-ga-260731:1024k 上下文 / 384k 输出
  assert.match(rendered, /'deepseek-v4-flash-ga-260731'/);
  assert.match(rendered, /'deepseek-v4-flash-ga'/);
  assert.match(rendered, /'260731'/);
  assert.ok(rendered.includes("1048576"), "1024k 必须换算成 1048576 落库");
  assert.ok(rendered.includes("393216"), "384k 必须换算成 393216 落库");

  // doubao-seed-2-1-pro-260628:256k 上下文与输出同值
  assert.match(rendered, /'doubao-seed-2-1-pro-260628'/);
  assert.ok(rendered.includes("262144"), "256k 必须换算成 262144 落库");

  // 种子必须可重复执行:迁移在已应用的库上重跑不能撞唯一键。
  assert.match(rendered, /ON CONFLICT/);
});
