import assert from "node:assert/strict";
import test from "node:test";
import { api } from "./api";
import {
  hasVisitedProject,
  loginEntryPathFor,
  markProjectVisited,
  projectDirectorPath,
  recallProjectLocation,
  rememberProjectLocation,
  safeRedirectTarget,
} from "./routing.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const refId = "55555555-5555-4555-8555-555555555555";

/* ---------- 登录跳转与回原位置（AUTH-02 / 非理想状态"未登录或会话过期"；V-47 落地页弹层形态） ---------- */

test("未登录跳转落地页登录卡时保存当前地址", () => {
  assert.equal(loginEntryPathFor("/projects/p1/assets?kind=scene"), "/landing?redirect=%2Fprojects%2Fp1%2Fassets%3Fkind%3Dscene");
  assert.equal(loginEntryPathFor("/"), "/landing?redirect=/projects");
  assert.equal(loginEntryPathFor("/login?redirect=x"), "/landing?redirect=/projects");
  assert.equal(loginEntryPathFor("/login?redirect=%2Fprojects%2Fp1"), "/landing?redirect=%2Fprojects%2Fp1");
});

test("登录成功只回站内相对地址，拒绝外部跳转", () => {
  assert.equal(safeRedirectTarget("?redirect=%2Fprojects%2Fp1%2Fdirector"), "/projects/p1/director");
  assert.equal(safeRedirectTarget("?redirect=https%3A%2F%2Fevil.example"), null);
  assert.equal(safeRedirectTarget("?redirect=%2F%2Fevil.example"), null);
  assert.equal(safeRedirectTarget(""), null);
});

/* ---------- director 路由插槽（DIR-01 的前端入口） ---------- */

test("3D 导演台路由带 projectId 且正确编码", () => {
  assert.equal(projectDirectorPath("project 1"), "/projects/project%201/director");
});

/* ---------- 项目位置记忆与三步引导（PRD 6.1/6.3） ---------- */

test("记录并恢复项目内上次工作位置；不同项目互不串位", () => {
  withMockLocalStorage(() => {
    rememberProjectLocation("p1", "/projects/p1/assets");
    rememberProjectLocation("p2", "/projects/p2/storyboards");
    assert.equal(recallProjectLocation("p1"), "/projects/p1/assets");
    assert.equal(recallProjectLocation("p2"), "/projects/p2/storyboards");
    assert.equal(recallProjectLocation("p3"), null);
  });
});

test("位置记忆拒绝写入不属于该项目的路径", () => {
  withMockLocalStorage(() => {
    rememberProjectLocation("p1", "/projects/p2/assets");
    assert.equal(recallProjectLocation("p1"), null);
  });
});

test("首次进入项目标记后不再是首次；标记可安全重复", () => {
  withMockLocalStorage(() => {
    assert.equal(hasVisitedProject("p1"), false);
    markProjectVisited("p1");
    markProjectVisited("p1");
    assert.equal(hasVisitedProject("p1"), true);
    assert.equal(hasVisitedProject("p2"), false);
  });
});

test("localStorage 损坏时按未访问处理，不抛错", () => {
  withMockLocalStorage((storage) => {
    storage.set("shortdrama_v011_project_visited", "not-json{{");
    assert.equal(hasVisitedProject("p1"), false);
    markProjectVisited("p1");
    assert.equal(hasVisitedProject("p1"), true);
  });
});

/* ---------- 语义检索 mode 透传（AST-02 / 检索降级旅程） ---------- */

test("语义检索透传 structured_fallback 降级模式与原因", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: [], count: 0, mode: "structured_fallback", degraded_reason: "milvus_unavailable" } });
    const result = await api.semanticSearch("雨夜巷口");
    assert.equal(result.mode, "structured_fallback");
    assert.equal(result.degraded_reason, "milvus_unavailable");
    assert.equal(requests.items[0]?.url, "/api/v1/asset-search/semantic");
  });
});

test("后端未提供 mode 字段时不虚构降级状态", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: [{ id: projectId }], count: 1 } });
    const result = await api.semanticSearch("女将军");
    assert.equal(result.mode, undefined);
    assert.equal(result.degraded_reason, undefined);
    assert.equal(result.count, 1);
  });
});

/* ---------- 移出项目（加入项目的撤销通道，AGT/AST-03 配套） ---------- */

test("移出项目调用 DELETE 项目资产引用接口", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: null });
    await api.removeProjectAsset(projectId, refId);
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/assets/${refId}`);
    assert.equal(requests.items[0]?.init.method, "DELETE");
  });
});

/* ---------- 测试工具 ---------- */

function withMockLocalStorage(run: (storage: Map<string, string>) => void): void {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  });
  try {
    run(storage);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

async function withMockBrowser(
  run: (requests: {
    items: CapturedRequest[];
    respondWith: (body: unknown, status?: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  const items: CapturedRequest[] = [];
  let responseBody: unknown = { ok: true, data: null };
  let responseStatus = 200;
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
    return new Response(JSON.stringify(responseBody), {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  api.setToken("test-token");
  try {
    await run({
      items,
      respondWith: (body, status = 200) => {
        responseBody = body;
        responseStatus = status;
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
