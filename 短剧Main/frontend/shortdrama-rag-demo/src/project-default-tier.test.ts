/* ============================================================
   project-default-tier.test.ts — #172：批量生图弹窗默认档跟项目设定走

   issue #172 实锤（2026-08-09 测试环境）：项目设了 9:16,批量生图弹窗默认选中的
   却是被标 is_default 的 21:9 档——旧链「上次记忆 → is_default → 首档」完全不读
   项目画幅/清晰度,生成入口又无换档控件,用户直接出横图白花钱。

   修复口径（本文件组件级断言,happy-dom 真渲染 + fetch mock 走真栈链路）：
   1. 项目设了画幅+清晰度 → 弹窗默认选中完全匹配档,估价请求 tier_id 全链一致;
   2. 项目清晰度查无匹配档 → 保画幅,选同画幅最便宜的可用档;
   3. 项目完全没设定 → 全局缺省链不变（is_default 档）。
   纯函数级断言在 capability-tiers.test.ts（resolveProjectDefaultTier / 链位）。

   基建同 k2s-demo-price.test.ts：happy-dom 先落地全局再动态 import,不写 JSX。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

/* happy-dom 先落地全局，再动态 import react/react-dom 与被测组件（同 k2s 基建）。 */
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
const { BatchGenerateDrawer } = await import("./pages/batch-generate-drawer");

const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";

function shot(id: string) {
  return { id, episode_id: episodeId, shot_no: id === "s1" ? "1" : "2", script_text: `剧本 ${id}` };
}

/* 档位行形状对齐 tierFromRaw 合同;测试站现状=is_default 标在 21:9 档上。 */
function tierRow(tierId: string, aspectRatio: string, resolution: string, points: number, isDefault = false) {
  return {
    tier_id: tierId,
    media_type: "image",
    display_name: "Seedream 5 Pro",
    provider_label: "火山方舟",
    model_label: "Seedream 5 Pro",
    ...(isDefault ? { is_default: true } : {}),
    availability: "available",
    params: { aspect_ratio: aspectRatio, resolution, quantity: 1 },
    price: { unit: "per_image", points },
    status: "active",
  };
}

const LIVE_TIERS = [
  tierRow("img-seedream5pro-219-1k-1", "21:9", "1K", 25, true),
  tierRow("img-seedream5pro-916-1k-1", "9:16", "1K", 30),
  tierRow("img-seedream5pro-916-2k-1", "9:16", "2K", 60),
];

interface CapturedCall {
  url: string;
  body?: Record<string, unknown>;
}

/** 真栈链路 mock：档位/项目详情/批量估价三个端点;估价请求体留证（tier_id 全链断言用）。 */
function installFetchMock(project: Record<string, unknown>): { calls: CapturedCall[]; restore: () => void } {
  const calls: CapturedCall[] = [];
  const originalFetch = globalThis.fetch;
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.startsWith("/api/v1/generation/capability-tiers")) {
      calls.push({ url });
      return json({ ok: true, data: { tiers: LIVE_TIERS } });
    }
    if (url.startsWith(`/api/v1/projects/${projectId}`)) {
      calls.push({ url });
      return json({ ok: true, data: project });
    }
    if (url.startsWith("/api/v1/generations/batch-estimate")) {
      const body = JSON.parse(String(init.body)) as { items: Array<Record<string, unknown>> };
      calls.push({ url, body });
      const items = body.items.map((item) => ({
        item_id: item.item_id,
        availability: "available",
        quote: {
          generation_quote_id: `q-${String(item.item_id)}`,
          source: "web",
          action: "submit",
          status: "pending_confirmation",
          estimated_cost_fen: 30,
          currency: "CNY",
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
          media_kind: "image",
        },
      }));
      return json({
        ok: true,
        data: {
          items,
          count: items.length,
          available_count: items.length,
          unavailable_count: 0,
          total_estimated_cost_fen: items.length * 30,
          currency: "CNY",
          requires_manual_review: false,
          creates_generation_tasks: false,
        },
      });
    }
    throw new Error(`未预期的请求：${url}`);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

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
      shots: [shot("s1"), shot("s2")],
      mediaKind: "image" as const,
      referenceMediaIds: [],
      demoMode: false,
      notify: () => {},
      onClose: () => {},
    }));
  });
  /* 真栈链=档接口 → 项目详情 → 批量估价,每环 promise 各一拍,多 flush 几轮等链结算 */
  for (let round = 0; round < 10; round += 1) {
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });
  }
  return {
    container,
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

function projectWithConfig(generationConfig: Record<string, unknown>): Record<string, unknown> {
  return { id: projectId, name: "天台对峙验收剧", generation_config: generationConfig };
}

function capturedEstimateTierIds(calls: CapturedCall[]): string[] {
  const estimate = calls.find((call) => call.url.startsWith("/api/v1/generations/batch-estimate"));
  assert.ok(estimate?.body, "应已发起批量估价请求");
  const items = (estimate.body as { items: Array<Record<string, unknown>> }).items;
  return items.map((item) => String(item.tier_id));
}

test("#172 组件级：项目设 9:16·1K → 弹窗默认选中 9:16·1K 档,估价 tier_id 全链一致（issue 现场回归）", async () => {
  const mock = installFetchMock(projectWithConfig({
    default_ratio: "9:16",
    default_image_resolution: "1K",
    default_video_resolution: "720p",
  }));
  const h = await mountBatchDrawer();
  try {
    assert.ok(h.container.textContent!.includes("9:16 · 1K"), "头部档位标签应随项目设定选中 9:16·1K 档");
    assert.ok(!h.container.textContent!.includes("21:9"), "不得再落到 is_default 的 21:9 档（issue #172 现象）");
    assert.deepEqual(
      [...new Set(capturedEstimateTierIds(mock.calls))],
      ["img-seedream5pro-916-1k-1"],
      "估价请求每行都必须带项目匹配档的 tier_id",
    );
    assert.ok(mock.calls.some((call) => call.url.startsWith(`/api/v1/projects/${projectId}`)), "弹窗必须真读项目生成配置");
  } finally {
    h.unmount();
    mock.restore();
  }
});

test("#172 组件级：项目清晰度查无匹配档 → 保画幅选同画幅最便宜可用档", async () => {
  const mock = installFetchMock(projectWithConfig({
    default_ratio: "9:16",
    default_image_resolution: "4K",
  }));
  const h = await mountBatchDrawer();
  try {
    assert.ok(h.container.textContent!.includes("9:16 · 1K"), "9:16 无 4K 档 → 同画幅 1K(30) 比 2K(60) 便宜");
    assert.deepEqual([...new Set(capturedEstimateTierIds(mock.calls))], ["img-seedream5pro-916-1k-1"]);
  } finally {
    h.unmount();
    mock.restore();
  }
});

test("#172 组件级：项目完全没设定 → 全局缺省链不变（is_default 的 21:9 档）", async () => {
  const mock = installFetchMock(projectWithConfig({}));
  const h = await mountBatchDrawer();
  try {
    assert.ok(h.container.textContent!.includes("21:9 · 1K"), "项目没设定时维持 is_default 全局默认档");
    assert.deepEqual([...new Set(capturedEstimateTierIds(mock.calls))], ["img-seedream5pro-219-1k-1"]);
  } finally {
    h.unmount();
    mock.restore();
  }
});
