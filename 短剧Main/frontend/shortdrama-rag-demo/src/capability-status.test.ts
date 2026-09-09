/* ============================================================
   capability-status.test.ts — 「AI 能力状态」收敛（S46-A / 走查 P0-1）
   纯逻辑：三维合成 / 缺项清单 / 角色感知文案 / 503 统一口径;
   源码级：四处入口共用状态条、矛盾话术清场。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  capabilityErrorCopy,
  capabilityProblems,
  capabilityReady,
  capabilityStatusCopy,
  resolveCapabilityStatus,
  type CapabilityStatusFacts,
} from "./capability-status";

function facts(overrides: Partial<CapabilityStatusFacts>): CapabilityStatusFacts {
  return { kind: "image", slots: [], aiGatewayEnabled: null, tiers: null, ...overrides };
}

const configuredSlots = [
  { key: "image", configured: true, modelDisplayName: "Seedream 5 Pro" },
  { key: "video", configured: true, modelDisplayName: "Seedance 2.0" },
  { key: "llm", configured: true, modelDisplayName: null },
  { key: "vector", configured: true, modelDisplayName: null },
];

/* ---------- 三维合成 ---------- */

test("图片：模型已配 × 档位已配 = 全就绪,状态条不占位", () => {
  const status = resolveCapabilityStatus(facts({ kind: "image", slots: configuredSlots, tiers: [{ tier_id: "t1" }] }));
  assert.equal(status.model, "ok");
  assert.equal(status.tier, "ok");
  assert.equal(status.switch, "na");
  assert.equal(status.modelName, "Seedream 5 Pro");
  assert.equal(capabilityReady(status), true);
  assert.deepEqual(capabilityProblems(status), []);
});

test("视频：模型已配 × 档位空表 = 只缺档位（5173 走查的真实现场）", () => {
  const status = resolveCapabilityStatus(facts({ kind: "video", slots: configuredSlots, tiers: [] }));
  assert.equal(status.model, "ok");
  assert.equal(status.tier, "missing");
  assert.deepEqual(capabilityProblems(status), [{ dimension: "tier", state: "missing" }]);
  assert.equal(capabilityReady(status), false);
});

test("槽位缺失/未配置 = 模型未配置;config-status 整体读取失败 = 模型 unknown 不虚构", () => {
  const missing = resolveCapabilityStatus(facts({ kind: "image", slots: [{ key: "image", configured: false }], tiers: [{ tier_id: "t1" }] }));
  assert.equal(missing.model, "missing");
  const unknown = resolveCapabilityStatus(facts({ kind: "image", slots: null, tiers: null }));
  assert.equal(unknown.model, "unknown");
  assert.equal(unknown.tier, "unknown");
});

test("AI 辅助：模型 × 开关（无档位维）;网关关闭 = 开关 off", () => {
  const on = resolveCapabilityStatus(facts({ kind: "ai_assist", slots: configuredSlots, aiGatewayEnabled: true }));
  assert.equal(on.tier, "na");
  assert.equal(on.switch, "ok");
  assert.equal(capabilityReady(on), true);
  const off = resolveCapabilityStatus(facts({ kind: "ai_assist", slots: configuredSlots, aiGatewayEnabled: false }));
  assert.equal(off.switch, "off");
  assert.deepEqual(capabilityProblems(off), [{ dimension: "switch", state: "off" }]);
  const noModel = resolveCapabilityStatus(facts({ kind: "ai_assist", slots: [{ key: "llm", configured: false }], aiGatewayEnabled: true }));
  assert.equal(noModel.model, "missing");
});

/* ---------- 角色感知文案（消灭「请联系管理员」死循环） ---------- */

test("管理员：缺档位给「去配置」直达,写明缺哪一项", () => {
  const status = resolveCapabilityStatus(facts({ kind: "video", slots: configuredSlots, tiers: [] }));
  const copy = capabilityStatusCopy(status, "admin");
  assert.equal(copy.action, "configure");
  assert.ok(copy.detail.includes("生成档位未配置"), "缺项没写明");
  assert.ok(copy.detail.includes("全局设置"), "缺去配置落点");
  assert.ok(!copy.detail.includes("请联系管理员"), "对管理员说请联系管理员=死循环");
});

test("成员：缺档位写明缺项并找管理员;operator 同管理员口径", () => {
  const status = resolveCapabilityStatus(facts({ kind: "image", slots: configuredSlots, tiers: [] }));
  const member = capabilityStatusCopy(status, "member");
  assert.equal(member.action, "contact_admin");
  assert.ok(member.detail.includes("生成档位未配置"), "缺项没写明");
  assert.ok(member.detail.includes("找管理员"), "成员版没指路人");
  const operator = capabilityStatusCopy(status, "operator");
  assert.equal(operator.action, "configure");
});

test("纯读取失败：给「重试」而非缺配置话术（不虚构配置状态）", () => {
  const status = resolveCapabilityStatus(facts({ kind: "image", slots: null, tiers: null }));
  const copy = capabilityStatusCopy(status, "admin");
  assert.equal(copy.action, "retry");
  assert.ok(copy.title.includes("读取失败"));
});

test("就绪：无动作无详情（状态条不渲染的口径）", () => {
  const status = resolveCapabilityStatus(facts({ kind: "image", slots: configuredSlots, tiers: [{ tier_id: "t1" }] }));
  const copy = capabilityStatusCopy(status, "member");
  assert.equal(copy.action, null);
  assert.equal(copy.detail, "");
});

/* ---------- 503 统一口径（toast 兜底） ---------- */

test("AI 网关 503：disabled/not_configured 角色感知;非 503/未知码走原文", () => {
  assert.equal(
    capabilityErrorCopy({ status: 503, code: "ai_gateway_disabled" }, "admin"),
    "AI 辅助未开启：到「全局设置」开启后再试",
  );
  assert.equal(
    capabilityErrorCopy({ status: 503, code: "ai_gateway_disabled" }, "member"),
    "AI 辅助未开启，找管理员开启后再试",
  );
  assert.ok(capabilityErrorCopy({ status: 503, code: "ai_gateway_not_configured" }, "admin")!.includes("模型未配置"));
  assert.equal(capabilityErrorCopy({ status: 500, code: "ai_gateway_disabled" }, "admin"), null);
  assert.equal(capabilityErrorCopy({ status: 503, code: "other" }, "admin"), null);
  assert.equal(capabilityErrorCopy(null, "admin"), null);
});

/* ---------- 源码级：四处共用同一状态条,矛盾红字清场 ---------- */

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("S46-A 源码级：工作台/实验室/剧本拆解页共用 CapabilityStatusBar", () => {
  const workbench = readSource("./pages/workbench-page.tsx");
  const referenceTests = readSource("./pages/reference-tests-page.tsx");
  const scriptBreakdown = readSource("./pages/script-breakdown-page.tsx");
  assert.ok(workbench.includes("CapabilityStatusBar"), "工作台未接能力状态条");
  assert.ok(referenceTests.includes("CapabilityStatusBar"), "实验室未接能力状态条");
  assert.ok(scriptBreakdown.includes('kind="ai_assist"'), "剧本拆解页未接 AI 辅助状态条");
  assert.ok(scriptBreakdown.includes("capabilityErrorCopy"), "剧本拆解 503 未走统一口径");
});

test("S46-A 源码级：状态条角色感知动作（去配置/重新读取）与三维亮灯在位", () => {
  const bar = readSource("./components/capability-status.tsx");
  assert.ok(bar.includes("去配置"), "管理员缺去配置直达");
  assert.ok(bar.includes("重新读取"), "缺重试入口");
  assert.ok(bar.includes('role="alert"'), "缺 alert 语义");
  assert.ok(bar.includes('navigate("/settings")'), "去配置落点不是全局设置");
  const api = readSource("./api.ts");
  assert.ok(api.includes("/admin/config-status"), "api 缺 config-status 读取");
});

test("S46-A 源码级：「请联系管理员」死循环话术清场（能力域）", () => {
  for (const path of [
    "./capability-tiers.ts",
    "./capability-status.ts",
    "./pages/workbench-page.tsx",
    "./pages/reference-tests-page.tsx",
    "./pages/script-breakdown-page.tsx",
  ] as const) {
    const source = readSource(path);
    assert.ok(!source.includes("请联系管理员配置后再生成"), `${path} 死循环话术残留`);
    assert.ok(!source.includes("AI 辅助当前未启用，请联系管理员"), `${path} 死循环话术残留`);
  }
  const projectPages = readSource("./pages/project-pages.tsx");
  assert.ok(!projectPages.includes("AI 助手当前未开启，请联系管理员"), "项目页 503 死循环话术残留");
});

test("S46-A 源码级：设置页模型槽位同屏补「档位/开关」维（矛盾在同页说清）", () => {
  const settings = readSource("./pages/settings-page.tsx");
  assert.ok(settings.includes("api.configStatus"), "设置页未读 AI 网关开关");
  assert.ok(settings.includes("listCapabilityTiers"), "设置页未读档位状态");
  assert.ok(settings.includes("档位 未配置"), "设置页缺档位缺配状态行");
});
