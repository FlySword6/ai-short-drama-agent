/* ============================================================
   s46-kind-toggle.test.ts — S46 C-5 资产中心空类型折叠胶囊语义 源码级验收断言
   C-5：类型页签区零计数类型默认折叠，折叠开关文案原为「+13 类（暂无资产）」——
      加号是什么、13 类是什么均未说明。改为「展开其余 N 类（暂无资产）」，
      展开态配套「收起其余类型」；折叠行为与 aria-expanded 不动。
   K2（N1）：横条改单行三簇后，折叠/展开从整行 showAllKinds 改为按簇生效
      （expandedKindClusters + toggleKindCluster），文案与可逆语义不变。
   纯 readSource 源码断言，不 import 页面组件（tsx 按仓根 tsconfig 编译，无 react-jsx）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const globalPages = readSource("./pages/global-pages.tsx");

test("C-5a：折叠态文案说清「展开其余 N 类（暂无资产）」", () => {
  assert.ok(globalPages.includes('`展开其余 ${hiddenCount} 类（暂无资产）`'));
});

test("C-5b：旧「+N 类」加号形态下线", () => {
  assert.ok(!globalPages.includes('`+${hiddenCount} 类（暂无资产）`'));
});

test("C-5c：展开态配套「收起其余类型」，折叠开关语义与 aria-expanded 不动（K2 起按簇生效）", () => {
  assert.ok(globalPages.includes('"收起其余类型"'));
  assert.ok(globalPages.includes("aria-expanded={expanded}"));
  assert.ok(globalPages.includes("onClick={() => toggleKindCluster(cluster.category)}"));
  assert.ok(!globalPages.includes("showAllKinds"), "旧的整行展开态残留——K2 起按簇生效");
});
