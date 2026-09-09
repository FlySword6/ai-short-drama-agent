/* ============================================================
   production-stepper.test.ts — S46 C-3 流程条署名源码级验收断言
   walkthrough P2-5③：③④⑤ 匿名圆圈不知道后续步骤是什么——
   每步都署名，仍保持单行紧凑；窄屏才回落为只显示当前步名。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const stepper = readSource("./production-stepper.tsx");
const stepperCss = readSource("./production-stepper.css");

test("S46 C-3：每步都渲染步骤名，不再只有当前步署名", () => {
  assert.ok(stepper.includes('className="step-name"'), "缺步骤名节点");
  // 非当前步也出文字（当前步加粗，其余平字），不再收进 title 悬停。
  assert.ok(stepper.includes("{state === \"current\" ? <strong>{step.label}</strong> : step.label}"), "非当前步未署名");
  assert.ok(!stepper.includes("title={step.label}"), "步骤名仍藏在悬停里");
});

test("S46 C-3：圆点样式独立命名,不与步骤名节点串样式", () => {
  assert.ok(stepper.includes('className="step-dot"'), "圆点缺 step-dot 类");
  assert.ok(stepperCss.includes(".production-stepper .step-dot {"), "CSS 未按 step-dot 命名");
  assert.ok(!stepperCss.includes(".production-stepper li > span {"), "旧 li > span 选择器会误伤步骤名节点");
});

test("S46 C-3：窄屏（<1180px）回落为只显示当前步名，保持单行紧凑", () => {
  assert.ok(stepperCss.includes(".production-stepper li:not(.current) .step-name { display: none; }"), "缺窄屏回落规则");
});
