import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  assertCompatibleLocalEnvAllowed,
  parseCompatibleEnv,
  resolveCompatibleEnvPaths,
} from "./env.js";

test("工作树按共享根底值、本工作树覆盖顺序读取 .env", () => {
  const cwd = path.resolve("/workspace/.worktrees/sol2");
  assert.deepEqual(resolveCompatibleEnvPaths({ cwd, nodeEnv: "development" }), [
    path.resolve("/workspace/.env"),
    path.resolve("/workspace/.worktrees/sol2/.env"),
  ]);
});

test("显式 SHORTDRAMA_ENV_FILE 优先，production 不读取任何本地文件", () => {
  const cwd = path.resolve("/workspace/.worktrees/sol2");
  assert.deepEqual(resolveCompatibleEnvPaths({
    cwd,
    nodeEnv: "test",
    explicitFile: "../controlled.env",
  }), [path.resolve(cwd, "../controlled.env")]);
  assert.deepEqual(resolveCompatibleEnvPaths({
    cwd,
    nodeEnv: "production",
    explicitFile: "../controlled.env",
  }), []);
});

test("兼容解析保留现有井号语义，后读取文件可覆盖底值", () => {
  const shared = parseCompatibleEnv("A=shared\nB=value#not-comment\n");
  const local = parseCompatibleEnv("A=local\n");
  assert.deepEqual({ ...shared, ...local }, {
    A: "local",
    B: "value#not-comment",
  });
});

test("本地文件不能把未声明的进程切成 production 后继续注入密钥", () => {
  assert.throws(
    () => assertCompatibleLocalEnvAllowed(undefined, {
      NODE_ENV: "production",
      VOLCENGINE_SECRET_ACCESS_KEY: "must-not-load",
    }),
    /production 运行环境禁止从本地配置文件加载变量/,
  );
  assert.doesNotThrow(
    () => assertCompatibleLocalEnvAllowed("test", {
      NODE_ENV: "test",
      VOLCENGINE_SECRET_ACCESS_KEY: "test-only",
    }),
  );
});
