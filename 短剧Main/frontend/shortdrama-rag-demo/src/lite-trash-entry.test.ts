import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

const happyWindow = new Window({ url: "http://localhost/lite" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).Event = happyWindow.Event;
(globalThis as Record<string, unknown>).MouseEvent = happyWindow.MouseEvent;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
(globalThis as Record<string, unknown>).React = React;
const { act, createElement } = React;
const { createRoot } = await import("react-dom/client");
const { LiteProjectsPage } = await import("./pages/lite/lite-projects-page");

const user = { id: "lite-user", username: "lite", display_name: "Lite User", ui_mode: "lite" as const };
const capabilities = {
  status: "ready" as const,
  capabilities: {
    platformRole: "member" as const,
    allowMemberCreateProject: true,
    projects: [],
    permissions: [] as string[],
  },
};
test("Lite 项目列表提供可达现有回收站的入口", async () => {
  happyWindow.history.replaceState({}, "", "/lite");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(LiteProjectsPage, {
        demoMode: true,
        notify: () => undefined,
        user,
        capabilities,
        onLogout: () => undefined,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "回收站");
    assert.ok(button, "Lite 项目列表缺回收站入口");
    act(() => button.click());
    assert.equal(happyWindow.location.pathname, "/lite", "回收站应留在 Lite 壳内，不换 Full 路由");
    assert.equal(container.querySelector("h1")?.textContent, "回收站");
    assert.ok(container.textContent?.includes("还原"), "必须复用真实项目/资产还原页面");
    const projectsFilter = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "被删项目");
    assert.ok(projectsFilter, "Lite 回收站缺项目过滤入口");
    act(() => projectsFilter.click());
    assert.equal(happyWindow.location.pathname, "/lite", "过滤回收站类型不应离开 Lite 壳");
    assert.equal(projectsFilter.getAttribute("aria-pressed"), "true");
    const back = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "返回项目");
    assert.ok(back, "Lite 回收站缺返回项目入口");
    act(() => back.click());
    assert.equal(container.querySelector("h1")?.textContent, "我的项目");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
