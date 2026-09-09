/* ============================================================
   s13-hybrid-search.test.ts — S13 全站搜索切混合检索单框验收（测试+代码成对提交）

   1. 资产中心搜索切 POST /asset-search（去引擎描述）；
   2. 资产选择器浏览模式同切（槽位 kind 前端过滤保留）；
   3. 匹配候选流召回同切（旧「本地过滤」标注退役）；
   4. 分页接真（page/page_size+has_more，前端切片退役）；
   5. 空结果如实+出路，不做假推荐。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { api, assetFromUnknown } from "./api";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const globalPages = readSource("./pages/global-pages.tsx");
const pickDrawer = readSource("./components/asset-pick-drawer.tsx");
const projectPages = readSource("./pages/project-pages.tsx");
const materialAgent = readSource("./pages/material-agent-page.tsx");

/* ---------- 轻量 fetch mock ---------- */
interface CapturedRequest { url: string; init: RequestInit }
async function withMockFetch(
  responses: Array<{ body: unknown; status?: number }>,
  run: (requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  const items: CapturedRequest[] = [];
  let call = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    items.push({ url: String(input), init });
    const next = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await run(items);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

const searchEnvelope = {
  ok: true,
  data: {
    items: [{ id: "a1", name: "验收角色甲", asset_kind: "character", scope: "personal", status: "approved", use_count: 0, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z" }],
    page: 2,
    page_size: 12,
    has_more: true,
    diagnostics: { engine: "rrf" },
  },
};

/* ---------- 1/4. assetSearch 请求形状与归一 ---------- */

test("S13-1/4 运行时：assetSearch 打 /asset-search 带 scope/query/page/page_size，has_more 归一", async () => {
  await withMockFetch([{ body: searchEnvelope }], async (requests) => {
    api.setToken("test-token");
    const result = await api.assetSearch("验收角色甲", { scope: "personal", page: 2, pageSize: 12 });
    const call = requests.find((item) => item.url.includes("/asset-search"));
    assert.ok(call, "未发检索请求");
    assert.ok(call.url.endsWith("/asset-search"), `打错端点：${call.url}`);
    assert.ok(!call.url.includes("/semantic"), "走了旧 semantic 端点");
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      query: "验收角色甲",
      scope: "personal",
      page: 2,
      page_size: 12,
    });
    assert.equal(result.hasMore, true);
    assert.equal(result.page, 2);
    assert.equal(result.items[0]?.name, "验收角色甲");
    assert.equal(result.items[0]?.scope, "personal");
    assert.equal(result.items[0]?.status, "approved");
  });
});

test("S13-1/4 运行时：带 project_id 透传；diagnostics 不上界面（不透传 mode/engine 字段）", async () => {
  await withMockFetch([{ body: searchEnvelope }], async () => {
    api.setToken("test-token");
    const result = await api.assetSearch("客厅", { projectId: "11111111-1111-1111-1111-111111111111" });
    assert.ok(!("mode" in result), "结果不得携带模式概念");
    assert.ok(!("diagnostics" in result), "结果不得透传 diagnostics");
  });
  await withMockFetch([{ body: searchEnvelope }], async (requests) => {
    api.setToken("test-token");
    await api.assetSearch("客厅", { projectId: "11111111-1111-1111-1111-111111111111" });
    const call = requests.find((item) => item.url.includes("/asset-search"));
    assert.equal(JSON.parse(String(call!.init.body)).project_id, "11111111-1111-1111-1111-111111111111");
  });
});

/* ---------- 1. 资产中心搜索 ---------- */

test("S13-1 源码级：资产中心切混检单框，引擎描述不上界面", () => {
  assert.ok(globalPages.includes("api.assetSearch(appliedQuery"), "资产中心未切混合检索");
  assert.ok(globalPages.includes("api.assetSearch(appliedQuery, { scope,"), "资产中心搜索未把个人/通用范围交给服务端");
  assert.ok(!globalPages.includes("api.semanticSearch(appliedQuery"), "资产中心仍走旧 semantic");
  assert.ok(!globalPages.includes("语义与结构化混合检索结果"), "引擎描述仍上界面");
  assert.ok(!globalPages.includes("语义检索暂不可用"), "旧降级条仍在");
  assert.ok(globalPages.includes("搜角色、场景、道具…支持自然语言"), "占位文案未换成自然语言口径");
});

/* ---------- 2/3. 选择器与匹配候选流 ---------- */

test("S13-2/3 源码级：选择器浏览与匹配候选同切混检，槽位 kind 过滤保留", () => {
  assert.ok(pickDrawer.includes("api.assetSearch(trimmedQuery"), "选择器未切混合检索");
  assert.ok(pickDrawer.includes("api.assetSearch(trimmedQuery, { scope,"), "选择器搜索未沿用当前个人/通用范围");
  assert.ok(pickDrawer.includes("assetMatchesPick(asset, effectiveKind, \"\")"), "槽位 kind 前端过滤未保留");
  assert.ok(pickDrawer.includes("候选由平台检索按关键词召回"), "匹配召回说明未换真实口径");
  assert.ok(!pickDrawer.includes("未接 AI 智能匹配"), "旧诚实标注应退役");
  assert.ok(pickDrawer.includes("按「${trimmedQuery}」召回"), "候选行缺真实召回理由");
});

test("S13-3 源码级：引入抽屉/素材智能体检索同切（全站单框，无遗漏）", () => {
  assert.ok(projectPages.includes("api.assetSearch(nlQuery"), "引入抽屉未切混合检索");
  assert.ok(projectPages.includes("api.assetSearch(nlQuery, { scope,"), "引入抽屉搜索未沿用当前个人/通用范围");
  assert.ok(!projectPages.includes("api.semanticSearch(nlQuery"), "引入抽屉仍走旧 semantic");
  assert.ok(materialAgent.includes("api.assetSearch(trimmed"), "素材智能体检索未切混合检索");
  // 「链路探测」按钮探旧 semantic 链路健康是其职责，允许保留（注释已明示两处不混）
  assert.ok(materialAgent.includes("链路探测"), "探测按钮被误删");
});

/* ---------- 4. 分页接真 ---------- */

test("S13-4 源码级：分页接真 hasMore，搜索态不再本地切片", () => {
  assert.ok(pickDrawer.includes("searchState.data?.hasMore"), "选择器未用 hasMore 真分页");
  assert.ok(globalPages.includes("data?.hasMore"), "资产中心未用 hasMore 真分页");
  assert.ok(globalPages.includes("searchPage"), "资产中心缺搜索页码状态");
  assert.ok(pickDrawer.includes("searchPage"), "选择器缺搜索页码状态");
});

/* ---------- 5. 空结果出路 ---------- */

test("S13-5 源码级：空结果如实+给出路，不做假推荐", () => {
  assert.ok(pickDrawer.includes("没搜到「{trimmedQuery}」"), "选择器缺如实空态");
  assert.ok(pickDrawer.includes("去资产中心看全部"), "选择器缺出路链接");
  assert.ok(globalPages.includes("没搜到「${appliedQuery}」"), "资产中心缺如实空态");
  assert.ok(globalPages.includes("看全部资产"), "资产中心缺出路动作");
});

test("S13 真栈回归:存量资产旧格式 primary_image(缺 id)不炸整页——兜底放弃而非抛错", () => {
  const legacy = assetFromUnknown({
    source_id: "0f0f0f0f-0000-0000-0000-000000000001",
    asset_kind: "scene",
    name: "存量场景",
    metadata: { primary_image: { url: "https://example.com/a.png", thumbnail_url: "https://example.com/t.png" } },
  });
  assert.equal(legacy.id, "0f0f0f0f-0000-0000-0000-000000000001");
  assert.equal(legacy.current_media, undefined);
  const modern = assetFromUnknown({
    id: "0f0f0f0f-0000-0000-0000-000000000002",
    asset_kind: "scene",
    name: "新格式场景",
    metadata: { primary_image: { id: "1e1e1e1e-0000-0000-0000-000000000003", url: "https://example.com/b.png" } },
  });
  assert.equal(modern.current_media?.id, "1e1e1e1e-0000-0000-0000-000000000003");
});
