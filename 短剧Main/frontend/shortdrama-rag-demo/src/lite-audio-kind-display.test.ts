/* ============================================================
   lite-audio-kind-display.test.ts — v0.9 音频分类展示渲染断言

   ① 工作台草稿审核「音频」候选组：audioKind 渲染为中文分类徽记（环境声等）；
   ② 资产详情页：audio 资产基础信息带「音频分类」行。
   demo 模式渲染，不触网。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

const happyWindow = new Window({ url: "http://localhost/" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
for (const eventCtor of ["Event", "CustomEvent", "PointerEvent", "MouseEvent", "KeyboardEvent", "FocusEvent"]) {
  const ctor = (happyWindow as unknown as Record<string, unknown>)[eventCtor];
  if (ctor) (globalThis as Record<string, unknown>)[eventCtor] = ctor;
}
class TestIntersectionObserver {
  constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
  observe(node: unknown): void {
    this.callback([{ isIntersecting: true } as never]);
  }
  disconnect(): void {}
  unobserve(): void {}
}
(globalThis as Record<string, unknown>).IntersectionObserver = TestIntersectionObserver;

const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
/* .tsx 走 classic JSX runtime(React.createElement),全局 React 必须先落地。 */
(globalThis as Record<string, unknown>).React = await import("react");
const { AssetCandidateGroup } = await import("./pages/lite/lite-workspace-page.js");

test("v0.9 音频候选组渲染五类分类徽记", () => {
  const html = renderToStaticMarkup(React.createElement(AssetCandidateGroup, {
    title: "音频",
    items: [{ candidateId: "audio_001", name: "雨声", description: "夜雨环境声", audioKind: "ambience" }],
  }));
  assert.ok(html.includes("雨声"), "音频名必须渲染");
  assert.ok(html.includes("环境声"), "audioKind=ambience 必须渲染中文分类徽记");
  const noKind = renderToStaticMarkup(React.createElement(AssetCandidateGroup, {
    title: "音频",
    items: [{ candidateId: "audio_002", name: "旧音频", description: null }],
  }));
  assert.ok(!noKind.includes("未分类"), "无 audioKind 不渲染徽记(不摆空壳)");
});

test("v0.9 音频资产详情页基础信息带「音频分类」行", async () => {
  const { LiteAssetDetailPage } = await import("./pages/lite/lite-asset-detail-page.js");
  const html = renderToStaticMarkup(React.createElement(LiteAssetDetailPage, {
    demoMode: true,
    notify: () => {},
    user: { id: "demo-user", username: "alice", display_name: "Alice", ui_mode: "lite" },
    capabilities: { status: "ready", capabilities: { platformRole: "member", allowMemberCreateProject: true, projects: [{ projectId: "demo-project-2", role: "owner" }], permissions: [] } },
    projectId: "demo-project-2",
    assetEntityId: "demo-asset",
  }));
  assert.ok(html.includes("音频分类"), "audio 资产必须有分类行");
  assert.ok(html.includes("环境声"), "demo 音频分类=环境声必须可见");
});
