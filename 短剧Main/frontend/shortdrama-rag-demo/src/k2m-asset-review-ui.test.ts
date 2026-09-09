/* ============================================================
   k2m-asset-review-ui.test.ts — K2M GP-14 组件级验收（待审资产入口侧标识）

   剧本步 10 + 后端 422（control-packages assertReferenceAccessible：
   pending_review/rejected 挂控制包一律拒，全栏同口径，裁决「检索可见可看不可用」）：
   - 资产抽屉：候选带「待审核/已拒绝」徽标，挂入钮置灰+人话原因；已加入区徽标，移出不波及；
   - 参考栏条目：徽标+弱呈现+悬停人话（实时分桶取数，不落地副本）。
   组件级用 happy-dom 真渲染（同 k2-submit-truth 基建：React.createElement 不写 JSX）。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import type { Asset, ProjectAssetRef } from "./types";

/* happy-dom 先落地全局，再动态 import react/react-dom（同 s83 基建纪律）。 */
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
const { AssetPickDrawer } = await import("./components/asset-pick-drawer");
const { ReferenceList } = await import("./components/reference-lanes");
const { seedLanesFromRefs } = await import("./reference-lanes");

function mount(node: Parameters<ReturnType<typeof createRoot>["render"]>[0]): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container: container as HTMLElement,
    unmount: () => act(() => root.unmount()),
  };
}

function findRow(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll("[data-review-status], .flex.items-center.gap-2.rounded-md")]
    .find((el) => el.textContent?.includes(name));
  assert.ok(row, `缺资产行「${name}」`);
  return row as HTMLElement;
}

test("K2M/GP-14 组件级：抽屉候选——待审核徽标+置灰+人话原因；ready 放行（demo fixture 同源）", () => {
  const { container, unmount } = mount(createElement(AssetPickDrawer, {
    demoMode: true,
    notify: () => {},
    refs: [],
    onAdd: async () => true,
    onRemove: async () => {},
    onClose: () => {},
    mode: "browse",
  }));
  // 冷月光 status=pending → 徽标 + 置灰 + 原因
  const pending = findRow(container, "冷月光");
  assert.ok(pending.textContent!.includes("待审核"), "待审候选无徽标（入口侧零标识回来了）");
  assert.equal(pending.getAttribute("data-review-status"), "待审核");
  assert.ok(pending.textContent!.includes("先在资产审核中通过"), "置灰未给后端 422 同口径人话");
  const pendingBtn = [...pending.querySelectorAll("button")].find((el) => el.textContent?.includes("加入"));
  assert.ok(pendingBtn, "待审候选缺加入钮");
  assert.equal((pendingBtn as HTMLButtonElement).disabled, true, "待审候选加入钮未置灰（后端挂栏 422 会拒）");
  // 任天野 status=ready → 无徽标、放行
  const ready = findRow(container, "任天野");
  assert.ok(!ready.textContent!.includes("待审核"), "ready 资产被误标");
  assert.equal(ready.getAttribute("data-review-status"), null);
  const readyBtn = [...ready.querySelectorAll("button")].find((el) => el.textContent?.includes("加入"));
  assert.ok(readyBtn, "ready 候选缺加入钮");
  assert.equal((readyBtn as HTMLButtonElement).disabled, false, "ready 候选不应置灰");
  unmount();
});

test("K2M/GP-14 组件级：抽屉已加入区——待审资产带徽标，移出仍可用", () => {
  const joined: ProjectAssetRef = {
    id: "ref-lin",
    project_id: "demo-project-2",
    asset_id: "asset-lin",
    asset: { id: "asset-lin", asset_kind: "character", name: "林秋棠", status: "pending" } as Asset,
  };
  const { container, unmount } = mount(createElement(AssetPickDrawer, {
    demoMode: true,
    notify: () => {},
    refs: [joined],
    onAdd: async () => true,
    onRemove: async () => {},
    onClose: () => {},
    mode: "match",
  }));
  const joinedSection = [...container.querySelectorAll("section")].find((el) => el.getAttribute("aria-label") === "已加入项目的资产");
  assert.ok(joinedSection, "已加入区不在");
  assert.ok(joinedSection!.textContent!.includes("待审核"), "已加入的待审资产无徽标");
  const removeBtn = [...joinedSection!.querySelectorAll("button")].find((el) => el.textContent?.includes("移出"));
  assert.ok(removeBtn, "已加入区缺移出钮");
  assert.equal((removeBtn as HTMLButtonElement).disabled, false, "移出不应被闸门波及");
  unmount();
});

test("K2M/GP-14 组件级：栏内资产条目——待审核徽标+弱呈现+人话，ready 默认外观（实时分桶取数）", () => {
  const refs: ProjectAssetRef[] = [
    { id: "ref-ren", project_id: "demo-project-2", asset_id: "asset-ren", asset: { id: "asset-ren", asset_kind: "character", name: "任天野", status: "ready" } as Asset },
    { id: "ref-lin", project_id: "demo-project-2", asset_id: "asset-lin", asset: { id: "asset-lin", asset_kind: "character", name: "林秋棠", status: "pending" } as Asset },
  ];
  const state = seedLanesFromRefs(refs);
  const { container, unmount } = mount(createElement(ReferenceList, {
    state,
    demoMode: true,
    onLaneAction: () => {},
    onPickFromLibrary: () => {},
    onRemoveItem: () => {},
    onSaveCameraNote: () => {},
  }));
  const lane = container.querySelector('[data-lane="character"]');
  assert.ok(lane, "角色栏不在");
  const pendingChip = [...lane!.querySelectorAll("[data-review-status]")].find((el) => el.textContent?.includes("林秋棠"));
  assert.ok(pendingChip, "林秋棠条目无审核态标识（栏内零标识回来了）");
  assert.equal(pendingChip!.getAttribute("data-review-status"), "待审核");
  assert.ok(pendingChip!.textContent!.includes("待审核"), "待审核徽标缺失");
  assert.ok((pendingChip as HTMLElement).className.includes("opacity-60"), "待审条目未弱呈现");
  assert.ok((pendingChip as HTMLElement).getAttribute("title")!.includes("先在资产审核中通过"), "悬停人话缺失");
  const readyChip = [...lane!.querySelectorAll("li span")].find((el) => el.textContent?.includes("任天野") && !el.textContent?.includes("林秋棠"));
  assert.ok(readyChip, "任天野条目不在");
  assert.ok(!readyChip!.textContent!.includes("待审核"), "ready 条目被误标");
  unmount();
});

test("K2M/GP-14 纯逻辑：seedLanesFromRefs 带审核态（realtime 分桶不落地，审核通过自动回默认外观）", () => {
  const refs: ProjectAssetRef[] = [
    { id: "ref-light", project_id: "demo-project-2", asset_id: "asset-light", asset: { id: "asset-light", asset_kind: "lighting", role: "style_env", name: "冷月光", status: "pending" } as Asset },
  ];
  const state = seedLanesFromRefs(refs);
  const item = (state.lighting ?? []).find((entry) => entry.name === "冷月光");
  assert.ok(item, "冷月光未分进光影栏");
  assert.equal(item!.assetStatus, "pending", "分桶未带审核态");
});
