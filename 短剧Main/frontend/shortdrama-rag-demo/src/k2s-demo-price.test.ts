/* ============================================================
   k2s-demo-price.test.ts — K2S 返工轮守卫：demo 批量估价随档（「同镜同档同价」）

   打回点（旧 K2S）：守卫用出现次数正则钉 workbench-page.tsx 的 `fixture.price.points *`
   恰好 4 次——S83 火车把 demo 估价推导改成 demoEstimatePoints(demoTier)，旧守卫必红；
   产品口径同步从「同镜同价（批量恒取默认档）」改为「同镜同档同价（批量随当前选档）」。

   本文件守卫全部为行为级断言，不用出现次数正则钉代码文本：
   1. 批量行价 === demoEstimatePoints(档)——全量 demo 档逐档断言
      （硬编码行价/换函数推导，必在某些档上不等而红）；
   2. 换档行价跟随——同一批分镜,2K 档行价 60、1K 档行价 30（行为复现「切档」）；
   3. 批量总价 = 档价 × 可行镜数；复核阈值按真实档价触发（不虚高不低估）；
   4. 组件级（happy-dom 真渲染批量抽屉）：demo 档 = 工作台当前选中档
      （tier-selection 会话共享）——持久化 1K 档后行价/合计按 1K 算；
      「批量改回恒取默认档」的变异必红在这一组；
   5. tier-selection 读写/按媒体类型隔离/损坏容错（纯函数）。

   单镜侧的 demoEstimatePoints 调用由 S83 守卫（s83-workbench-params.test.ts）在看,
   本文件只钉批量侧与「两入口同函数同档」的相等关系,不重复钉单镜。

   基建同 s83-workbench-params.test.ts：happy-dom 真渲染；React.createElement 不写 JSX。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

import {
  DEMO_IMAGE_TIERS,
  FALLBACK_IMAGE_TIER,
  FALLBACK_VIDEO_TIER,
  demoEstimatePoints,
  type CapabilityTier,
} from "./capability-tiers";
import { recallSelectedTierId, rememberSelectedTierId, type TierSelectionStorage } from "./tier-selection";
import type { Shot } from "./types";

/* happy-dom 先落地全局，再动态 import react/react-dom 与被测组件（同 s83 基建）。 */
const happyWindow = new Window({ url: "http://localhost/" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
(globalThis as Record<string, unknown>).React = await import("react");
const { createRoot } = await import("react-dom/client");
const { BatchGenerateDrawer, buildBatchItems, demoBatchEstimate } = await import("./pages/batch-generate-drawer");

const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";

function shot(partial: Partial<Shot> & { id: string }): Shot {
  return { episode_id: episodeId, shot_no: "1", ...partial };
}

function itemsFor(tier: CapabilityTier, ids: string[]): ReturnType<typeof buildBatchItems> {
  return buildBatchItems({
    projectId,
    episodeId,
    mediaKind: tier.media_type,
    shots: ids.map((id) => shot({ id, script_text: `剧本 ${id}` })),
    referenceMediaIds: [],
    tier,
  });
}

function availableQuotes(result: ReturnType<typeof demoBatchEstimate>): number[] {
  return result.items
    .filter((item) => item.availability === "available")
    .map((item) => item.quote!.estimated_cost_fen);
}

/* ============================================================
   tier-selection：当前选中档的会话级共享（纯函数）
   ============================================================ */

function memoryStorage(initial: Record<string, string> = {}): TierSelectionStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

test("tier-selection：记住/读出按媒体类型往返,图片与视频互不串档", () => {
  const storage = memoryStorage();
  assert.equal(recallSelectedTierId(storage, "image"), null, "未选过应读出 null（调用方回落首 active 档）");
  rememberSelectedTierId(storage, "image", "img-seedream5pro-169-1k-1");
  rememberSelectedTierId(storage, "video", "vid-seedance20fast-916-720p-4s");
  assert.equal(recallSelectedTierId(storage, "image"), "img-seedream5pro-169-1k-1");
  assert.equal(recallSelectedTierId(storage, "video"), "vid-seedance20fast-916-720p-4s");
  rememberSelectedTierId(storage, "image", "img-seedream5pro-916-2k-1");
  assert.equal(recallSelectedTierId(storage, "image"), "img-seedream5pro-916-2k-1", "后写覆盖先写（当前选档以最新为准）");
  assert.equal(recallSelectedTierId(storage, "video"), "vid-seedance20fast-916-720p-4s", "图片改写不波及视频");
});

test("tier-selection：记录损坏/写失败不抛错,读出 null 回落首档", () => {
  const corrupted = memoryStorage({ shortdrama_v011_selected_tier: "{不是 json" });
  assert.equal(recallSelectedTierId(corrupted, "image"), null);
  const wrongShape = memoryStorage({ shortdrama_v011_selected_tier: JSON.stringify(["不是对象"]) });
  assert.equal(recallSelectedTierId(wrongShape, "image"), null);
  const throwing: TierSelectionStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("隐私模式写不进"); },
  };
  assert.doesNotThrow(() => rememberSelectedTierId(throwing, "image", "x"));
});

/* ============================================================
   demo 批量估价随档（纯函数行为级）
   ============================================================ */

test("K2S 行为级：批量行价 === demoEstimatePoints(档)——全量 demo 档逐档相等（同镜同档同价）", () => {
  for (const tier of [...DEMO_IMAGE_TIERS, FALLBACK_VIDEO_TIER]) {
    const result = demoBatchEstimate(itemsFor(tier, ["s1", "s2"]), tier);
    const expected = demoEstimatePoints(tier);
    assert.deepEqual(
      availableQuotes(result),
      [expected, expected],
      `${tier.tier_id}：批量行价必须等于单镜同源函数 demoEstimatePoints 同档输出（硬编码/换函数必在此红）`,
    );
    assert.equal(result.total_estimated_cost_fen, expected * 2, `${tier.tier_id}：批量总价=档价×镜数`);
  }
});

test("K2S 行为级：换档后批量行价跟随——同一批分镜 2K 档 60、1K 档 30", () => {
  const tier1k = DEMO_IMAGE_TIERS.find((tier) => tier.tier_id === "img-seedream5pro-169-1k-1");
  assert.ok(tier1k, "demo 档表缺 16:9·1K 真登记档");
  const at2k = demoBatchEstimate(itemsFor(FALLBACK_IMAGE_TIER, ["s1", "s2", "s3"]), FALLBACK_IMAGE_TIER);
  const at1k = demoBatchEstimate(itemsFor(tier1k, ["s1", "s2", "s3"]), tier1k);
  assert.deepEqual(availableQuotes(at2k), [60, 60, 60]);
  assert.deepEqual(availableQuotes(at1k), [30, 30, 30]);
  assert.equal(at2k.total_estimated_cost_fen, 180);
  assert.equal(at1k.total_estimated_cost_fen, 90);
});

test("K2S 行为级：复核阈值按真实档价触发,不虚高不低估（视频 320/镜）", () => {
  const one = demoBatchEstimate(itemsFor(FALLBACK_VIDEO_TIER, ["s1"]), FALLBACK_VIDEO_TIER);
  assert.equal(one.total_estimated_cost_fen, 320, "视频口径=档价 80 积分/秒 × 4 秒");
  assert.equal(one.requires_manual_review, false, "单镜 320 低于阈值,不得虚高触发复核");
  const two = demoBatchEstimate(itemsFor(FALLBACK_VIDEO_TIER, ["s1", "s2"]), FALLBACK_VIDEO_TIER);
  assert.equal(two.total_estimated_cost_fen, 640);
  assert.equal(two.requires_manual_review, true, "两镜 640 超阈值,如实触发复核提示");
});

test("K2S 行为级：缺提示词行不可行且不按档计价,合计只算可行行", () => {
  const items = buildBatchItems({
    projectId,
    episodeId,
    mediaKind: "image",
    shots: [shot({ id: "s1", script_text: "有文本" }), shot({ id: "s2", shot_no: "9" })],
    referenceMediaIds: [],
    tier: FALLBACK_IMAGE_TIER,
  });
  const result = demoBatchEstimate(items, FALLBACK_IMAGE_TIER);
  assert.equal(result.available_count, 1);
  assert.equal(result.unavailable_count, 1);
  assert.equal(result.total_estimated_cost_fen, 60, "不可行行不进合计,合计=档价×可行镜数");
});

/* ============================================================
   组件级：批量抽屉 demo 档 = 工作台当前选中档（会话共享）
   ============================================================ */

interface DrawerHarness {
  container: HTMLElement;
  unmount: () => void;
}

async function mountBatchDrawer(): Promise<DrawerHarness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(BatchGenerateDrawer, {
      projectId,
      episodeId,
      episodeNo: 1,
      shots: [shot({ id: "s1", script_text: "剧本 s1" }), shot({ id: "s2", shot_no: "2", script_text: "剧本 s2" })],
      mediaKind: "image" as const,
      referenceMediaIds: [],
      demoMode: true,
      notify: () => {},
      onClose: () => {},
    }));
  });
  // 档拉取(fixture Promise)与估价(Promise.resolve)各一拍,多flush几轮等链结算
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
  }
  return {
    container,
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

function rowPricesOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('ul li span[class*="font-mono"]')].map((el) => el.textContent ?? "");
}

test("K2S 组件级：未选过档时批量抽屉按缺省首档(2K)取价——行价 60、合计 120", async () => {
  happyWindow.sessionStorage.clear();
  const h = await mountBatchDrawer();
  try {
    assert.ok(h.container.textContent!.includes("2K"), "头部档位标签应含缺省 2K 档");
    assert.deepEqual(rowPricesOf(h.container), ["60 积分", "60 积分"], "缺省档行价=2K 档价 60 积分");
    assert.ok(h.container.textContent!.includes("确认并生成 2 项，合计 120 积分"), "合计=档价×镜数");
  } finally {
    h.unmount();
  }
});

test("K2S 组件级：工作台当前选中 1K 档 → 批量抽屉同档取价——行价 30、合计 60（变异「恒取默认档」必红）", async () => {
  happyWindow.sessionStorage.clear();
  rememberSelectedTierId(happyWindow.sessionStorage, "image", "img-seedream5pro-169-1k-1");
  const h = await mountBatchDrawer();
  try {
    assert.ok(h.container.textContent!.includes("1K"), "头部档位标签应跟随当前选中 1K 档");
    assert.deepEqual(rowPricesOf(h.container), ["30 积分", "30 积分"], "批量行价必须跟当前选档=1K 档价 30 积分(恒取默认档的变异在这里红)");
    assert.ok(h.container.textContent!.includes("确认并生成 2 项，合计 60 积分"), "合计随档=30×2");
    assert.ok(!h.container.textContent!.includes("合计 120 积分"), "不得残留默认档合计");
  } finally {
    h.unmount();
    happyWindow.sessionStorage.clear();
  }
});

/* ============================================================
   源码级存在性断言（非出现次数）——只钉「接线存在」,行为由上面断言钉死
   旧 K2S 打回点=出现次数正则钉 fixture.price.points×4;此处单布尔 includes,
   调用点增删/重排不误伤,实现换写法（不改行为）也不误伤。
   ============================================================ */

const drawerSource = readFileSync(new URL("./pages/batch-generate-drawer.tsx", import.meta.url), "utf8");
const workbenchSource = readFileSync(new URL("./pages/workbench-page.tsx", import.meta.url), "utf8");

test("K2S 源码级(存在性)：批量 demo 取价接 demoEstimatePoints,选中档会话共享读写两侧都在", () => {
  assert.ok(drawerSource.includes("demoEstimatePoints"), "批量抽屉 demo 估价未接单镜同源函数 demoEstimatePoints");
  assert.ok(drawerSource.includes("recallSelectedTierId"), "批量抽屉未读工作台当前选中档(会话共享)");
  assert.ok(workbenchSource.includes("rememberSelectedTierId"), "工作台未把当前选中档写入会话共享");
});
