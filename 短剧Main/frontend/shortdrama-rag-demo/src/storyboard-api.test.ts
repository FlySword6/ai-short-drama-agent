import assert from "node:assert/strict";
import test from "node:test";
import { api } from "./api";

const projectId = "22222222-2222-4222-8222-222222222222";
const importId = "66666666-6666-4666-8666-666666666666";

test("分镜预览把嵌套响应映射为可渲染数据，并用真实 id 确认", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        id: importId,
        status: "previewed",
        preview: {
          rows: [{
            source_sheet: "第1集",
            source_row: 2,
            episode_no: 1,
            scene_name: "夜雨巷口",
            shot_no: "S01",
            screen_description: "任天野在雨中勒马。",
            dialogue: "停下。",
          }],
          issues: [{ level: "warning", code: "missing_sound", message: "缺少音效", source_row: 2 }],
          can_confirm: true,
        },
      },
    }, 201);

    const file = new File([new Uint8Array([1, 2, 3])], "storyboard.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const preview = await api.previewStoryboard(projectId, file);

    assert.equal(preview.id, importId);
    assert.equal(preview.preview.rows.length, 1);
    assert.deepEqual(preview.preview.rows[0], {
      source_sheet: "第1集",
      source_row: 2,
      episode_no: 1,
      scene_name: "夜雨巷口",
      shot_no: "S01",
      screen_description: "任天野在雨中勒马。",
      dialogue: "停下。",
    });
    assert.deepEqual(preview.preview.issues, [{ level: "warning", code: "missing_sound", message: "缺少音效", source_row: 2 }]);
    assert.equal(preview.preview.can_confirm, true);

    requests.respondWith({ ok: true, data: { id: importId, preview: { rows: [], issues: [], can_confirm: true } } });
    await api.confirmStoryboard(preview.id);
    assert.equal(requests.items[1]?.url, `/api/v1/storyboard-imports/${importId}/confirm`);
  });
});

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
