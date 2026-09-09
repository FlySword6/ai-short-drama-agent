import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProductionTargetAllowed,
  E2E_PRODUCTION_OPT_IN_ENV,
  resolveCliE2eTarget,
  resolveEffectiveCliE2eTarget,
} from "./production-target-guard.js";

const productionHosts = new Set(["shortdrama.col.com"]);

test("生产目标默认 fail-closed", () => {
  assert.throws(
    () => assertProductionTargetAllowed(
      new URL("https://shortdrama.col.com"),
      productionHosts,
      {},
    ),
    /拒绝生产域名/u,
  );
});

test("只有显式值 1 可以打开生产目标", () => {
  assert.doesNotThrow(() => assertProductionTargetAllowed(
    new URL("https://shortdrama.col.com"),
    productionHosts,
    { [E2E_PRODUCTION_OPT_IN_ENV]: "1" },
  ));
  for (const value of ["", "0", "true", "yes"]) {
    assert.throws(() => assertProductionTargetAllowed(
      new URL("https://shortdrama.col.com"),
      productionHosts,
      { [E2E_PRODUCTION_OPT_IN_ENV]: value },
    ));
  }
});

test("非生产目标行为不变", () => {
  assert.doesNotThrow(() => assertProductionTargetAllowed(
    new URL("https://shortdrama-main-test.col.com"),
    productionHosts,
    {},
  ));
});

test("生产 opt-in 下 CLI 目标必须显式且受同一生产闸约束", () => {
  assert.throws(
    () => resolveEffectiveCliE2eTarget(
      productionHosts,
      { [E2E_PRODUCTION_OPT_IN_ENV]: "1" },
    ),
    /必须显式设置 SHORTDRAMA_API_BASE 或 CLI_E2E_BASE_URL/u,
  );
  assert.throws(
    () => resolveEffectiveCliE2eTarget(
      productionHosts,
      { SHORTDRAMA_API_BASE: "https://shortdrama.col.com" },
    ),
    /拒绝生产域名/u,
  );
  assert.equal(
    resolveEffectiveCliE2eTarget(
      productionHosts,
      {
        SHORTDRAMA_API_BASE: "https://shortdrama.col.com/path",
        CLI_E2E_BASE_URL: "https://shortdrama-main-test.col.com",
        [E2E_PRODUCTION_OPT_IN_ENV]: "1",
      },
    ),
    "https://shortdrama.col.com",
    "SHORTDRAMA_API_BASE 是 CLI 实际优先目标，不能被备用变量盖掉",
  );
  assert.equal(
    resolveCliE2eTarget(
      "https://shortdrama.col.com/path",
      productionHosts,
      { [E2E_PRODUCTION_OPT_IN_ENV]: "1" },
    ),
    "https://shortdrama.col.com",
  );
});

test("CLI env 文件里的实际目标也必须先过生产闸", () => {
  const envFile = [
    "SHORTDRAMA_API_BASE=https://shortdrama.col.com",
    "CLI_E2E_BASE_URL=https://shortdrama-main-test.col.com",
  ].join("\n");
  assert.throws(
    () => resolveEffectiveCliE2eTarget(
      productionHosts,
      {},
      envFile,
    ),
    /拒绝生产域名/u,
  );
  assert.equal(
    resolveEffectiveCliE2eTarget(
      productionHosts,
      {
        CLI_E2E_BASE_URL: "https://shortdrama-main-test.col.com",
        [E2E_PRODUCTION_OPT_IN_ENV]: "1",
      },
      envFile,
    ),
    "https://shortdrama.col.com",
    "env 文件 SHORTDRAMA_API_BASE 的实际优先级不能被进程内备用 CLI URL 掩盖",
  );
});
