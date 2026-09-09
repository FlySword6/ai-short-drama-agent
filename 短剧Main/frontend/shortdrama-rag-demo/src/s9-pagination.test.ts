/* ============================================================
   s9-pagination.test.ts — S9-19 全平台列表分页排查与修复（G 线）
   覆盖口径（后端分页支持逐项核对过仓根 src/modules/*​/routes.ts，只读）：
   - 资产库 / 项目列表 / 回收站：后端列表接口无分页参数 → 前端切片兜底，
     三处共用 ListPager（页码窗口 + 原生 button，键盘可操作）；
   - 消耗明细：后端已支持 page/page_size + 筛选（modules/consumption-records/routes.ts，
     page_size zod max(100)）；H 线 P0-3 已接通服务端真分页（筛选透传 + ListPager +
     CSV 分页循环拉全量），page_size:500 拉全量的 400 路径与客户端切片兜底均已退役；
   - 参考测试：后端 page/page_size 已接真分页（usePagedList 首页 + hasNext 加载更多）；
   - 素材智能体：语义检索 limit 封顶 24（search 无 offset/cursor，报 Sol），
     入库队列为本地临时队列 —— 量小不需分页；
   - 生成历史：工作台域内横向版本轨道（overflow-x-auto），单镜头版本量级小 —— 量小不需。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { pageCount, paginateItems, paginationWindow } from "./components/asset-shared";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const globalPages = readSource("./pages/global-pages.tsx");
const operationsPages = readSource("./pages/operations-pages.tsx");
const consumptionPanel = readSource("./components/consumption-records.tsx");
const consumptionLogic = readSource("./consumption-records.ts");
const materialAgent = readSource("./pages/material-agent-page.tsx");
const referenceTests = readSource("./pages/reference-tests-page.tsx");
const workbench = readSource("./pages/workbench-page.tsx");

/* ---------- 通用分页器 ListPager：单页隐藏、页码窗口、键盘可操作 ---------- */

test("ListPager：三处列表共用的通用分页器，单页整体隐藏", () => {
  assert.ok(globalPages.includes("export function ListPager"), "ListPager 未导出共用");
  assert.ok(globalPages.includes("if (totalPages <= 1) return null;"), "单页时应整体隐藏分页器");
  assert.ok(globalPages.includes("paginationWindow(page, totalPages)"), "页码窗口未走 paginationWindow");
});

test("ListPager：原生 button + aria-current + nav 可访问名，键盘 Tab/Enter 可操作", () => {
  assert.ok(globalPages.includes("aria-label={ariaLabel}"), "nav 缺可访问名");
  assert.ok(globalPages.includes('aria-current={item === page ? "page" : undefined}'), "当前页缺 aria-current");
  assert.ok(globalPages.includes("aria-label={`第 ${item} 页`}"), "页码钮缺可访问名");
  assert.ok(globalPages.includes("上一页"), "缺上一页");
  assert.ok(globalPages.includes("下一页"), "缺下一页");
  // 页码用原生 button（天然键盘聚焦/回车触发），不是 div 点击区
  assert.match(globalPages, /<button\s+type="button"\s+aria-current/, "页码应为原生 button");
});

/* ---------- 项目列表：后端 /projects 无分页参数 → 前端切片兜底 ---------- */

test("项目列表：分页随看板化退役(列内滚动取代翻页),不得回潮", () => {
  // 2026-08-02 Fable 改锚:R2 看板化(批次一卡 3)后项目列表无分页——列内滚动取代翻页,
  // S9 的语义(不整页堆砌)由看板列承载;守「分页常量/ListPager 不回潮+列归组在场」。
  assert.ok(!globalPages.includes("PROJECTS_PAGE_SIZE"), "项目分页常量已退役,不得回潮");
  assert.ok(!globalPages.includes('ariaLabel="项目分页"'), "项目 ListPager 已退役,不得回潮");
  assert.ok(globalPages.includes("projectBoardColumn"), "缺看板列归组载体");
});

/* ---------- 资产库：既有前端分页迁移到共用 ListPager（行为不变） ---------- */

test("资产库：切片分页保留，分页器换共用 ListPager 且可访问名不漂移", () => {
  assert.ok(globalPages.includes("paginateItems(filtered, safePage)"), "资产库切片被改动");
  assert.ok(globalPages.includes('itemNoun="个资产" ariaLabel="资产分页"'), "资产库分页可访问名漂移");
  assert.ok(globalPages.includes("fetchScopeAssets"), "资产库全量分拉合并兜底被摘除");
});

/* ---------- 回收站：后端 /trash 无分页参数 → 前端切片兜底 ---------- */

test("回收站：每页 12 切片 + 复用 global-pages 的 ListPager + 类型切换回第一页", () => {
  assert.ok(operationsPages.includes("const TRASH_PAGE_SIZE = 12;"), "缺 TRASH_PAGE_SIZE");
  assert.ok(operationsPages.includes("paginateItems(items, safePage, TRASH_PAGE_SIZE)"), "回收站未切片");
  assert.ok(operationsPages.includes('itemNoun="项" ariaLabel="回收站分页" pageSize={TRASH_PAGE_SIZE}'), "回收站未接 ListPager");
  assert.ok(operationsPages.includes('import { ListPager, type PageRuntimeProps } from "./global-pages";'), "回收站未复用共用分页器");
  assert.ok(operationsPages.includes("useEffect(() => { setPage(1); }, [kind]);"), "类型切换未回第一页");
});

/* ---------- 消耗明细：服务端真分页（H 线 P0-3 已接通，客户端切片兜底退役） ---------- */

test("消耗明细：筛选与分页全量透传服务端，复用 ListPager，CSV 分页循环拉全量", () => {
  // 客户端切片兜底与 page_size:500 拉全量（被后端 zod max(100) 拒为 400 的真栈 bug）均已摘除
  assert.ok(!consumptionPanel.includes("paginateConsumptionRecords("), "客户端切片兜底仍在");
  assert.ok(!consumptionLogic.includes("page_size: 500"), "page_size:500 拉全量的 400 路径仍在");
  // 筛选参数与页码透传合同端点（from/to/task_type/model/page/page_size）
  for (const needle of ["from: query.from || undefined", "to: query.to || undefined", "task_type: query.taskType || undefined", "model: query.model || undefined", "page: query.page", "page_size: pageSize"]) {
    assert.ok(consumptionLogic.includes(needle), `缺服务端透传参数：${needle}`);
  }
  // CSV 导出按筛选分页循环拉全量，每页条数钉在后端上限 100（超了直接 400）
  assert.ok(consumptionLogic.includes("CONSUMPTION_EXPORT_PAGE_SIZE = 100"), "导出每页条数未钉在后端上限 100");
  assert.ok(consumptionLogic.includes("listAllConsumptionRecords"), "缺导出全量分页循环");
  // 组件复用共用 ListPager（与资产库/项目列表/回收站同器，单页整体隐藏）
  assert.ok(consumptionPanel.includes("<ListPager"), "消耗明细未复用 ListPager");
  assert.ok(consumptionPanel.includes('itemNoun="笔"'), "分页器量词漂移");
  assert.ok(consumptionPanel.includes('ariaLabel="消耗明细分页"'), "分页器可访问名漂移");
  assert.ok(consumptionPanel.includes("CONSUMPTION_PAGE_SIZE"), "缺每页条数常量");
});

/* ---------- 参考测试：后端 page/page_size 已接真分页（首页 + hasNext 加载更多） ---------- */

test("参考测试：测试列表与批次结果都按页码参数拉取 + 加载更多", () => {
  assert.ok(referenceTests.includes("api.referenceTests(projectId, page, REFERENCE_TESTS_PAGE_SIZE)"), "测试列表未带页码参数");
  assert.ok(referenceTests.includes("api.projectReferenceTestResults(projectId, page, REFERENCE_TEST_RESULTS_PAGE_SIZE)"), "项目级结果未带页码参数");
  assert.ok(referenceTests.includes("api.referenceTestResults(projectId, selectedTestId, page, REFERENCE_TEST_RESULTS_PAGE_SIZE)"), "单测试结果未带页码参数");
  assert.ok(referenceTests.includes("加载更多测试"), "测试列表缺加载更多");
  assert.ok(referenceTests.includes("加载更多批次"), "结果列表缺加载更多");
  // usePagedList：hasNext 驱动加载更多，失败有独立错误行
  assert.ok(referenceTests.includes("function usePagedList<T>("), "缺分页读取 hook");
  assert.ok(referenceTests.includes("setHasNext(page.hasNext)"), "未消费 has_next");
  assert.ok(referenceTests.includes("loadMoreError"), "加载更多缺错误态");
});

/* ---------- 量小不需：素材检索 limit 封顶 / 入库本地队列 / 生成历史横向轨道 ---------- */

test("素材智能体：检索切混合检索（S13，接口自带分页；网格渲染不变），入库为本地临时队列", () => {
  assert.ok(materialAgent.includes("api.assetSearch(trimmed"), "检索未切混合检索（S13）");
  assert.ok(materialAgent.includes("searchResult.items.map("), "检索结果网格被改动");
});

test("生成历史：工作台域内横向版本轨道（overflow-x-auto 横滑），量小不需分页", () => {
  assert.ok(workbench.includes('aria-label="生成历史版本轨道"'), "生成历史版本轨道缺失");
  assert.match(workbench, /overflow-x-auto[^}]*aria-label="生成历史版本轨道"|aria-label="生成历史版本轨道"[^}]*overflow-x-auto/, "版本轨道应可横滑");
});

/* ---------- 逻辑级：分页原语支持自定义每页条数（项目/回收站复用口径） ---------- */

test("pageCount/paginateItems/paginationWindow：自定义 pageSize 口径正确", () => {
  assert.equal(pageCount(12, 12), 1);
  assert.equal(pageCount(13, 12), 2);
  assert.equal(pageCount(0, 12), 1);
  const items = Array.from({ length: 30 }, (_, index) => index + 1);
  assert.deepEqual(paginateItems(items, 1, 12).length, 12);
  assert.deepEqual(paginateItems(items, 3, 12), [25, 26, 27, 28, 29, 30]);
  assert.deepEqual(paginationWindow(2, 3), [1, 2, 3]);
});
