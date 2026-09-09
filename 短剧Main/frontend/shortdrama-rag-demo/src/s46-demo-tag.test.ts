/* ============================================================
   s46-demo-tag.test.ts — S46 C-7 演示项目 tag 标注 源码级验收断言
   C-7：项目卡「本地演示项目（可删）」——括号自注释是开发视角。双管修复：
      ① 种子数据改名「本地演示项目」（scripts/dev-seed.mts），描述去 CLI 黑话；
      ② ProjectCard 对名字含「演示」的项目在状态徽章旁打「演示」tag，
         「可删」语义不再寄生在项目名里。
   纯 readSource 源码断言，不 import 页面组件（tsx 按仓根 tsconfig 编译，无 react-jsx）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const globalPages = readSource("./pages/global-pages.tsx");
const devSeed = readSource("../../../scripts/dev-seed.mts");

test("C-7a：ProjectCard 对名字含「演示」的项目打「演示」tag", () => {
  assert.ok(globalPages.includes('project.name.includes("演示")'), "缺演示判定");
  assert.ok(globalPages.includes('<Badge tone="neutral">演示</Badge>'), "缺「演示」tag");
});

test("C-7b：「演示」tag 与状态徽章同行，不挤压标题区", () => {
  assert.ok(globalPages.includes('<div className="absolute left-3 top-3 flex gap-1">'));
  assert.ok(globalPages.includes('<StatusBadge status={project.status || "进行中"} />'));
});

test("C-7c：种子项目改名「本地演示项目」，「可删」自注释下线", () => {
  assert.ok(devSeed.includes('name: "本地演示项目"'), "种子名未改");
  assert.ok(!devSeed.includes("可删"), "「可删」自注释仍在种子里");
});

test("C-7d：种子描述去 CLI 黑话（npm run dev:reset 不上卡面）", () => {
  assert.ok(!devSeed.includes("数据随时可用 npm run dev:reset 清空"), "描述仍带 CLI 黑话");
});
