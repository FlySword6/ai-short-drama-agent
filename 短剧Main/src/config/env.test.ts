import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCompleteWecomLoginConfiguration,
  resolveGenerationOrchestrationMode,
  resolveSingleActiveSession,
  strictBooleanEnvSchema,
} from "./env.js";

/** 一个只有注释的配置文件：让子进程在「没有本地配置」的条件下装载，与 CI 一致。 */
function emptyEnvFilePath(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "shortdrama-env-")), ".env");
  writeFileSync(file, "# 故意留空\n");
  return file;
}

/**
 * 子进程的环境全由测试自己造，不继承 process.env。
 *
 * 父进程 import 本模块时 env.ts 就把开发机 .env 里的键全注进了自己的 process.env，
 * 照抄给子进程，测的就成了「开发机这套配置 + 这个开关」而不是「这个开关」，
 * CI 上和本地跑的也不是同一件事。SHORTDRAMA_ENV_FILE 是其中已经咬过人的一个
 * （相对路径被子进程按自己的工作目录解析，找不到就崩，见 #243）；剩下那些键
 * 目前没让哪条断言红过，但让它们有资格参与判定本身就是多余的。
 * 这里只留跑 node 必需的 PATH。
 */
function isolatedEnv(
  emptyEnvFile: string,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    SHORTDRAMA_ENV_FILE: emptyEnvFile,
    ...overrides,
  };
}

test("共享 .env 的相对 SHORTDRAMA_ENV_FILE 不会随子进程继承", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "shortdrama-workspace-"));
  const parentCwd = path.join(workspace, ".worktrees", "parent");
  const childCwd = path.join(workspace, ".worktrees", "child");
  mkdirSync(parentCwd, { recursive: true });
  mkdirSync(childCwd, { recursive: true });
  writeFileSync(path.join(workspace, ".env"), "SHORTDRAMA_ENV_FILE=.env\n");

  const moduleUrl = new URL("./env.ts", import.meta.url).href;
  const tsxLoader = createRequire(import.meta.url).resolve("tsx");
  const childProgram = `await import(${JSON.stringify(moduleUrl)});`;
  const parentProgram = [
    `await import(${JSON.stringify(moduleUrl)});`,
    "const { spawnSync } = await import('node:child_process');",
    `const child = spawnSync(process.execPath, ["--import", ${JSON.stringify(createRequire(import.meta.url).resolve("tsx"))}, "--input-type=module", "--eval", ${JSON.stringify(childProgram)}], { cwd: ${JSON.stringify(childCwd)}, env: process.env, encoding: "utf8" });`,
    "if (child.status !== 0) { process.stderr.write(child.stderr); process.exit(child.status ?? 1); }",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--import", tsxLoader, "--input-type=module", "--eval", parentProgram],
    {
      cwd: parentCwd,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
    },
  );

  assert.equal(result.status, 0, result.stderr);
});

test("试点额度授权开关只接受明确布尔值，拼写错误必须让启动配置解析失败", () => {
  for (const value of ["true", "TRUE", "1", "yes", "Y", "on"]) {
    assert.equal(strictBooleanEnvSchema.parse(value), true, value);
  }
  for (const value of ["false", "FALSE", "0", "no", "N", "off"]) {
    assert.equal(strictBooleanEnvSchema.parse(value), false, value);
  }
  for (const value of ["treu", "", "enabled", "disabled", "2"]) {
    assert.throws(
      () => strictBooleanEnvSchema.parse(value),
      /true\/false/,
      value,
    );
  }
});

test("试点额度授权开关拼错时应用配置装载直接失败，显式 false 保持关闭", () => {
  const moduleUrl = new URL("./env.ts", import.meta.url).href;
  const emptyEnvFile = emptyEnvFilePath();
  const loadSettings = (value: string) => spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const env = await import(${JSON.stringify(moduleUrl)});`
        + "if (env.settings.generationPilotCreditGateEnabled !== false) process.exit(17);",
    ],
    {
      encoding: "utf8",
      env: isolatedEnv(emptyEnvFile, {
        GENERATION_PILOT_CREDIT_GATE_ENABLED: value,
      }),
    },
  );

  const invalid = loadSettings("treu");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /GENERATION_PILOT_CREDIT_GATE_ENABLED/);

  const disabled = loadSettings("false");
  assert.equal(disabled.status, 0, disabled.stderr);
});

test("自然语言生成编排在生产默认关闭，开发测试默认 mock，显式配置优先", () => {
  assert.equal(resolveGenerationOrchestrationMode(undefined, "production"), "disabled");
  assert.equal(resolveGenerationOrchestrationMode(undefined, "development"), "mock");
  assert.equal(resolveGenerationOrchestrationMode(undefined, "test"), "mock");
  assert.equal(resolveGenerationOrchestrationMode("real", "production"), "real");
  assert.equal(resolveGenerationOrchestrationMode("disabled", "development"), "disabled");
});

test("同一账号只留一处登录：生产默认开，开发与测试默认关，不要求运维显式配置", () => {
  assert.equal(resolveSingleActiveSession(undefined, "production"), true);
  assert.equal(resolveSingleActiveSession(undefined, "development"), false);
  assert.equal(resolveSingleActiveSession(undefined, "test"), false);
});

test("企业微信登录默认关闭，关闭时不要求任何供应商配置", () => {
  assert.doesNotThrow(() => assertCompleteWecomLoginConfiguration({ enabled: false }));
});

test("企业微信登录开启时缺少任一配置都在启动期失败", () => {
  assert.throws(
    () => assertCompleteWecomLoginConfiguration({ enabled: true, corpId: "ww-corp" }),
    /WECOM_AGENT_ID, WECOM_CORP_SECRET, WECOM_CALLBACK_URL/,
  );
  assert.doesNotThrow(() => assertCompleteWecomLoginConfiguration({
    enabled: true,
    corpId: "ww-corp",
    agentId: "1000002",
    corpSecret: "test-only-secret",
    callbackUrl: "https://example.test/api/v1/auth/wecom/callback",
  }));
});

test("企业微信登录开关、HTTPS 回调和 state TTL 由配置 schema fail-closed", () => {
  const moduleUrl = new URL("./env.ts", import.meta.url).href;
  const emptyEnvFile = emptyEnvFilePath();
  const load = (overrides: Record<string, string>) => spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const { settings } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify({ enabled: settings.wecomLoginEnabled, ttl: settings.wecomStateTtlSeconds }));`,
    ],
    { encoding: "utf8", env: isolatedEnv(emptyEnvFile, { NODE_ENV: "test", ...overrides }) },
  );

  const defaults = load({});
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), { enabled: false, ttl: 300 });

  const invalidSwitch = load({ WECOM_LOGIN_ENABLED: "enabled" });
  assert.notEqual(invalidSwitch.status, 0);
  assert.match(invalidSwitch.stderr, /WECOM_LOGIN_ENABLED/);

  const incomplete = load({ WECOM_LOGIN_ENABLED: "true" });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /WECOM_CORP_ID/);

  const insecureCallback = load({
    WECOM_LOGIN_ENABLED: "true",
    WECOM_CORP_ID: "ww-corp",
    WECOM_AGENT_ID: "1000002",
    WECOM_CORP_SECRET: "test-only-secret",
    WECOM_CALLBACK_URL: "http://example.test/callback",
  });
  assert.notEqual(insecureCallback.status, 0);
  assert.match(insecureCallback.stderr, /WECOM_CALLBACK_URL/);

  const enabled = load({
    WECOM_LOGIN_ENABLED: "true",
    WECOM_CORP_ID: "ww-corp",
    WECOM_AGENT_ID: "1000002",
    WECOM_CORP_SECRET: "test-only-secret",
    WECOM_CALLBACK_URL: "https://example.test/api/v1/auth/wecom/callback",
    WECOM_STATE_TTL_SECONDS: "180",
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.deepEqual(JSON.parse(enabled.stdout), { enabled: true, ttl: 180 });

  const overContractMaximum = load({ WECOM_STATE_TTL_SECONDS: "301" });
  assert.notEqual(overContractMaximum.status, 0);
  assert.match(overContractMaximum.stderr, /WECOM_STATE_TTL_SECONDS/);
});

test("同一账号只留一处登录：显式开关双向覆盖默认", () => {
  // 测试环境临时打开，验证「后登的把先登的挤下线」这条行为本身。
  assert.equal(resolveSingleActiveSession(true, "test"), true);
  assert.equal(resolveSingleActiveSession(true, "development"), true);
  // 生产临时关掉排障。
  assert.equal(resolveSingleActiveSession(false, "production"), false);
});

test("同一账号只留一处登录：NODE_ENV 决定应用装载出来的默认值", () => {
  const moduleUrl = new URL("./env.ts", import.meta.url).href;
  // 本测试问的是「不配这个键时默认值是什么」，开发机工作区根上的 .env 不能替它回答。
  const emptyEnvFile = emptyEnvFilePath();
  const loadSettings = (environment: string, configured?: string) => spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `const env = await import(${JSON.stringify(moduleUrl)});`
        + "process.stdout.write(String(env.settings.authSingleActiveSession));",
    ],
    {
      encoding: "utf8",
      env: isolatedEnv(emptyEnvFile, {
        NODE_ENV: environment,
        AUTH_SINGLE_ACTIVE_SESSION: configured,
      }),
    },
  );

  for (const [environment, expected] of [
    ["production", "true"],
    ["development", "false"],
    ["test", "false"],
  ] as const) {
    const result = loadSettings(environment);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, `${environment} 的默认值不对`);
  }

  const productionOff = loadSettings("production", "false");
  assert.equal(productionOff.status, 0, productionOff.stderr);
  assert.equal(productionOff.stdout, "false");

  const testOn = loadSettings("test", "true");
  assert.equal(testOn.status, 0, testOn.stderr);
  assert.equal(testOn.stdout, "true");
});
