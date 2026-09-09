/* ============================================================
   error-copy.test.ts — R96 错误文案映射兜底验收（K-goal-04 条 5）

   判据：生成链用户可见错误=业务语言。映射表命中已知后端错误串；
   未知英文给通用业务话术+console 留 detail；含中文透传。
   源码守卫：生成链各显示点必须走 businessErrorMessage，裸英文不许上屏。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BACKEND_ERROR_COPY, businessErrorMessage } from "./error-copy";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/* ---------- 映射表：已知后端错误串 → 业务语言 ---------- */

test("R96：Ark 提交结果未知（DC 点名实例）→ 业务话术", () => {
  assert.equal(
    businessErrorMessage(new Error("Ark submission outcome is unknown")),
    "提交结果暂时未知，请稍后到任务列表看状态",
  );
  // openspeech TTS 同款（后端另一条 provider 原话）
  assert.equal(
    businessErrorMessage("openspeech TTS submission outcome is unknown"),
    "提交结果暂时未知，请稍后到任务列表看状态",
  );
  // 带 Error 前缀/堆栈的多行原文也只取首行再映射
  assert.equal(
    businessErrorMessage(new Error("Error: Ark submission outcome is unknown\n    at submit (ark.ts:1:1)")),
    "提交结果暂时未知，请稍后到任务列表看状态",
  );
});

test("R96：落库耗尽/报价过期/报价被消费/余额/审核/超时/限流/断网各有业务话术", () => {
  const cases: [string, string][] = [
    ["Persistence recovery retry limit (3) exhausted: disk full", "生成结果保存失败，请稍后到任务列表看状态"],
    ["GENERATION_QUOTE_EXPIRED", "这次报价已过期，请重新生成"],
    ["GENERATION_QUOTE_CONFLICT", "这次报价已被使用，请重新生成"],
    ["insufficient balance", "积分不够，请联系管理员调账后再试"],
    ["内容审核未通过", "内容未通过审核，请调整提示词或参考后重试"],
    ["request timeout", "服务响应超时，请稍后重试"],
    ["rate limit exceeded", "请求太频繁，请稍等片刻再试"],
    ["fetch failed", "网络连接异常，请检查网络后重试"],
  ];
  for (const [raw, copy] of cases) {
    assert.equal(businessErrorMessage(raw), copy, `「${raw}」未命中映射表`);
  }
});

test("R96：映射表文案自身过 R96——无厂商名/HTTP 码/英文残留", () => {
  for (const [pattern, copy] of BACKEND_ERROR_COPY) {
    assert.ok(!/Ark|openspeech|HTTP|error|unknown/i.test(copy), `映射文案含技术词：${copy}（${pattern}）`);
    assert.ok(/[一-鿿]/.test(copy), `映射文案必须是中文业务话术：${copy}`);
  }
});

/* ---------- 兜底：未知错误不给用户看原文 ---------- */

test("R96：未知英文错误 → 通用业务话术 + console 留 detail（不上屏）", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const shown = businessErrorMessage(new Error("seedream 4.5 backend exploded with code 53001"), "提交失败，请稍后重试");
    assert.equal(shown, "提交失败，请稍后重试", "未知英文错误不该上屏");
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, "未知错误原文应进 console 留排障 detail");
  assert.ok(warnings[0]!.includes("seedream 4.5 backend exploded"), "console detail 丢了原文");
});

test("R96：含中文视为后端已人话化——透传（超 120 截断）；空错误给 fallback", () => {
  assert.equal(businessErrorMessage(new Error("生成档位未加载，请稍后重试")), "生成档位未加载，请稍后重试");
  const long = `前半段${"很长的中文说明".repeat(30)}`;
  assert.ok(businessErrorMessage(long).length <= 120, "超长中文未截断");
  assert.equal(businessErrorMessage(null, "操作失败，请重试"), "操作失败，请重试");
  assert.equal(businessErrorMessage(new Error("")), "操作失败，请重试");
});

/* ---------- 源码守卫：生成链各错误显示点必须走 businessErrorMessage ---------- */

test("R96 源码级：工作台生成链错误显示全部走 businessErrorMessage（裸英文上屏必红）", () => {
  const workbench = readSource("./pages/workbench-page.tsx");
  assert.ok(workbench.includes('from "../error-copy"'), "workbench 未接 error-copy");
  // 任务失败卡：display_reason 经映射兜底上屏（多模型接缝:不再读 failure_reason 原文）
  assert.ok(workbench.includes("businessErrorMessage(displayReason"), "任务失败卡 display_reason 未走映射兜底");
  assert.ok(!workbench.includes('{displayReason ||'), "任务失败卡仍在原样显示 display_reason");
  // 提交/重试/恢复链：错误文案经映射兜底
  assert.ok(workbench.includes("businessErrorMessage(reason"), "生成链 catch 未走映射兜底");
});

test("R96 源码级：参考栏任务卡/参考测试页/批量抽屉同走映射兜底", () => {
  const tracker = readSource("./lane-generation-tracker.ts");
  assert.ok(tracker.includes("businessErrorMessage"), "参考栏任务卡失败文案未走映射兜底");
  const referenceTests = readSource("./pages/reference-tests-page.tsx");
  assert.ok(referenceTests.includes("businessErrorMessage"), "参考测试页失败通知未走映射兜底");
  const batch = readSource("./pages/batch-generate-drawer.tsx");
  assert.ok(batch.includes("businessErrorMessage"), "批量生成抽屉错误显示未走映射兜底");
});

/* ---------- #18 非生成域业务语言化：扫描核查（不靠人肉记忆） ---------- */

/**
 * 已清扫文件清单（试点开门·前端质量包 v0.2.3）：项目/资产/队列/设置/消耗
 * 五页 + 壳层 + 资产组件群。裸透传三元式（X instanceof Error ? X.message : …）
 * 在这些文件里零容忍；例外逐条登记理由（与 s17-dev-copy-guard 白名单同机制）。
 */
const PLAIN_COPY_SWEPT_FILES = [
  "./pages/global-pages.tsx",
  "./pages/project-pages.tsx",
  "./pages/operations-pages.tsx",
  "./pages/settings-page.tsx",
  "./pages/admin-page.tsx",
  "./pages/admin-credits-panel.tsx",
  "./pages/admin-release-plan-panel.tsx",
  "./pages/queue-page.tsx",
  "./components/consumption-records.tsx",
  "./components/asset-widgets.tsx",
  "./components/asset-shared.tsx",
  "./components/asset-upload-modal.tsx",
  "./components/asset-pick-drawer.tsx",
  "./components/promote-asset-modal.tsx",
  "./components/create-episode-button.tsx",
  "./components/review-panels.tsx",
  "./components/project-settings.tsx",
  "./app.tsx",
] as const;

/** 裸透传例外登记（file + 行特征 + 理由）——收敛方向是清零，新增必须带裁决。
    2026-08-04：唯一例外（登录失败透传）已随 #67 UIUX 修复包码表化（loginErrorMessage），白名单清零。 */
const PLAIN_COPY_ALLOW: ReadonlyArray<{ file: string; needle: string; reason: string }> = [];

test("#18 源码级：非生成域已清扫文件零裸透传（err.message 三元式扫描）", () => {
  const naked = /(?:reason|caught|error|err) instanceof Error \? (?:reason|caught|error|err)\.message/;
  const offenders: string[] = [];
  for (const file of PLAIN_COPY_SWEPT_FILES) {
    const lines = readSource(file).split("\n");
    lines.forEach((line, index) => {
      if (!naked.test(line)) return;
      const allowed = PLAIN_COPY_ALLOW.some((entry) => entry.file === file && line.includes(entry.needle));
      if (!allowed) offenders.push(`${file}:${index + 1} ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `非生成域出现裸 err.message 透传(改走 businessErrorMessage):\n${offenders.join("\n")}`);
});

test("#18 源码级：型号/服务商/工具名/资产类型上屏走中文标签层", () => {
  const settings = readSource("./pages/settings-page.tsx");
  assert.ok(settings.includes("providerLabel(") && settings.includes("modelDisplayLabel("), "AI 日志服务商/型号未走标签层");
  assert.ok(settings.includes("toolNameLabel("), "AI 日志工具名未走标签层");
  assert.ok(!settings.includes(">Provider<"), "英文表头 Provider 仍在");
  const consumption = readSource("./components/consumption-records.tsx");
  assert.ok(consumption.includes("modelDisplayLabel("), "消耗明细型号列未走标签层");
  const operations = readSource("./pages/operations-pages.tsx");
  assert.ok(operations.includes("modelDisplayLabel("), "运营页型号显示未走标签层");
  const palette = readSource("./command-palette.ts");
  assert.ok(palette.includes("assetKindLabel("), "命令面板资产类型未走中文标签");
  const appShell = readSource("./app.tsx");
  assert.ok(appShell.includes("toolNameLabel("), "助手面板工具名未走标签层");
});
