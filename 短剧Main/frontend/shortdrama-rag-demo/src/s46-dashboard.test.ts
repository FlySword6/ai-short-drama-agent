/* ============================================================
   s46-dashboard.test.ts — S46 C-4 看板结果卡副文案对称 源码级验收断言
   C-4：运营看板「图片结果」卡挂全局成功数、「视频结果」卡挂全局失败数，
      两卡并排读起来像"视频专统计失败"。DashboardDataCounts 无 per-kind
      成败拆分（后端数据合同变更，超出 C 组前端毛刺范围），定稿方案为
      两卡共用同一句全局口径「任务成功 N 次 · 失败 M 次」，图片卡不再
      独占成功口径、视频卡不再独占失败口径。
   纯 readSource 源码断言，不 import 页面组件（tsx 按仓根 tsconfig 编译，无 react-jsx）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const operationsPages = readSource("./pages/operations-pages.tsx");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SYMMETRIC_NOTE = '任务成功 ${data.succeeded} 次 · 失败 ${data.failed} 次';

test("C-4a：图片/视频结果卡共用同一句全局成败口径（恰好 2 处）", () => {
  assert.equal(countOccurrences(operationsPages, SYMMETRIC_NOTE), 2);
});

test("C-4b：图片卡不再独占成功口径、视频卡不再独占失败口径", () => {
  assert.equal(countOccurrences(operationsPages, '${data.succeeded} 次任务成功'), 0);
  assert.equal(countOccurrences(operationsPages, '${data.failed} 次任务失败'), 0);
});

test("C-4c：结果卡计数值仍为 per-kind 的 images/videos，不动数据合同", () => {
  assert.ok(operationsPages.includes('label="图片结果" value={data.images}'));
  assert.ok(operationsPages.includes('label="视频结果" value={data.videos}'));
});
