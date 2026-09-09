import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runner = readFileSync("scripts/run-asset-media-repair-db-test.sh", "utf8");

test("052 本机 PostgreSQL runner 不继承共享云库 TLS 模式", () => {
  const invocationStart = runner.lastIndexOf('\nDATABASE_URL="postgresql://');
  assert.ok(invocationStart >= 0, "缺少本机 PostgreSQL 测试调用");
  const localInvocation = runner.slice(invocationStart + 1);
  assert.match(localInvocation, /POSTGRES_SSL_MODE="disable"/);
  assert.match(localInvocation, /ASSET_MEDIA_REPAIR_TEST_DATABASE_URL="postgresql:\/\/postgres:/);
});
