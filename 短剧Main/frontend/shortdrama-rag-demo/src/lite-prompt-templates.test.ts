/* ============================================================
   lite-prompt-templates.test.ts — 提示词模板库前端窄口 + 生效解析纯函数

   口径锁定（docs/design/prd-v2/lite-model-defaults.md §4.3）：
   - 模板表只存用户自建；系统默认模板是代码常量（后端 /generation/default-prompt-templates
     只读暴露），不是行数据。
   - 生效 = 引用关系 generation_default_strategies.parameters.prompt_template_id；
     生成期拼接与表无关：客户端解析模板表内容后作为 supplement_prompt 提交。
   - id 缺失/软删/跨项目统一回落系统默认（content=""）+ missingTemplateId 供页面提示。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { api } from "./api";
import type { JsonRecord, PromptTemplate } from "./types";
import {
  assembleAssetImagePrompt,
  effectivePromptTemplate,
  promptTemplateIdOf,
  PROMPT_TEMPLATE_CONTENT_MAX,
  PROMPT_TEMPLATE_NAME_MAX,
} from "./lite-prompt-templates";
import type { GenerationDefaultStrategy } from "./types";

const projectId = "11111111-1111-4111-8111-111111111111";
const templateId = "44444444-4444-4444-8444-444444444444";

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

function templateRow(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: templateId,
    project_id: projectId,
    media_kind: "image",
    name: "写实电影质感",
    content: "写实电影质感，自然光，浅景深",
    created_by_user_id: "33333333-3333-4333-8333-333333333333",
    deleted_by_user_id: null,
    deleted_at: null,
    created_at: "2026-08-13T00:00:00.000Z",
    updated_at: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

/* ---------- api 窄口 ---------- */

test("defaultPromptTemplates：GET 系统默认模板常量端点，容错非字符串", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { image: "平台默认图片模板", video: "平台默认视频模板" } });
    const result = await api.defaultPromptTemplates();
    assert.deepEqual(result, { image: "平台默认图片模板", video: "平台默认视频模板" });
    assert.equal(requests.items.length, 1);
    assert.equal(requests.items[0]!.url, "/api/v1/generation/default-prompt-templates");
  });
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { image: null, video: 42 } });
    const result = await api.defaultPromptTemplates();
    assert.deepEqual(result, { image: "", video: "" }, "非字符串按空回落，页面给「平台默认模板，随版本更新」");
  });
});

test("promptTemplates：不带媒介不拼 query，带媒介拼 media_kind，并归一列表", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: [templateRow()], count: 1 } });
    const listed = await api.promptTemplates(projectId, "image");
    assert.equal(requests.items[0]!.url, `/api/v1/projects/${projectId}/prompt-templates?media_kind=image`);
    assert.deepEqual(listed.items, [templateRow()]);
  });
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: [], count: 0 } });
    await api.promptTemplates(projectId);
    assert.equal(requests.items[0]!.url, `/api/v1/projects/${projectId}/prompt-templates`);
  });
});

test("createPromptTemplate / updatePromptTemplate / deletePromptTemplate 走对方法与 snake_case body", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: templateRow() });
    const created = await api.createPromptTemplate(projectId, { media_kind: "image", name: "写实电影质感", content: "写实电影质感，自然光，浅景深" });
    assert.equal(requests.items[0]!.init.method, "POST");
    assert.equal(requests.items[0]!.url, `/api/v1/projects/${projectId}/prompt-templates`);
    assert.deepEqual(JSON.parse(String(requests.items[0]!.init.body)), { media_kind: "image", name: "写实电影质感", content: "写实电影质感，自然光，浅景深" });
    assert.equal(created.id, templateId);
  });
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: templateRow({ name: "改名" }) });
    const updated = await api.updatePromptTemplate(projectId, templateId, { media_kind: "video", name: "改名", content: "新内容" });
    assert.equal(requests.items[0]!.init.method, "PUT");
    assert.equal(requests.items[0]!.url, `/api/v1/projects/${projectId}/prompt-templates/${templateId}`);
    assert.deepEqual(JSON.parse(String(requests.items[0]!.init.body)), { media_kind: "video", name: "改名", content: "新内容" });
    assert.equal(updated.name, "改名");
  });
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { template_id: templateId, deleted: true } });
    await api.deletePromptTemplate(projectId, templateId);
    assert.equal(requests.items[0]!.init.method, "DELETE");
    assert.equal(requests.items[0]!.url, `/api/v1/projects/${projectId}/prompt-templates/${templateId}`);
  });
});

/* ---------- 生效解析纯函数（§4.3：引用关系 → 内容；缺失/软删/跨项目回落系统默认） ---------- */

function strategy(parameters: JsonRecord): GenerationDefaultStrategy {
  return {
    id: "gd-1",
    project_id: projectId,
    media_kind: "image",
    mode: "material_to_prompt",
    model_key: "img-tier-1",
    parameters,
    source_generation_request_id: null,
    updated_by_user_id: "33333333-3333-4333-8333-333333333333",
    version: 1,
    created_at: "2026-08-13T00:00:00.000Z",
    updated_at: "2026-08-13T00:00:00.000Z",
  };
}

const LIBRARY: PromptTemplate[] = [
  templateRow(),
  templateRow({ id: "77777777-7777-4777-8777-777777777777", media_kind: "video", name: "镜头稳定", content: "镜头稳定推进" }),
];

test("promptTemplateIdOf：只认非空字符串的 prompt_template_id，其余一律 null", () => {
  assert.equal(promptTemplateIdOf(strategy({ prompt_template_id: templateId })), templateId);
  assert.equal(promptTemplateIdOf(strategy({ prompt_template_id: "" })), null);
  assert.equal(promptTemplateIdOf(strategy({ prompt_template_id: null })), null);
  assert.equal(promptTemplateIdOf(strategy({})), null);
  assert.equal(promptTemplateIdOf(null), null);
});

test("effectivePromptTemplate：命中同项目同媒介模板 → 内容来自模板；无引用 → 系统默认空", () => {
  const hit = effectivePromptTemplate(strategy({ prompt_template_id: templateId }), LIBRARY, "image");
  assert.equal(hit.source, "template");
  assert.equal(hit.content, "写实电影质感，自然光，浅景深");
  assert.equal(hit.missingTemplateId, undefined);

  const system = effectivePromptTemplate(strategy({}), LIBRARY, "image");
  assert.equal(system.source, "system_default");
  assert.equal(system.content, "");
  assert.equal(system.missingTemplateId, undefined);
});

test("effectivePromptTemplate：跨媒介引用不生效（同名不同媒介不串）", () => {
  const cross = effectivePromptTemplate(strategy({ prompt_template_id: templateId }), LIBRARY, "video");
  assert.equal(cross.source, "system_default");
  assert.equal(cross.content, "");
  assert.equal(cross.missingTemplateId, templateId, "引用了视频模板的 id，但库里该 id 是图片 → 回落并提示");
});

test("effectivePromptTemplate：引用 id 已软删/跨项目 → 回落系统默认并带 missingTemplateId", () => {
  const gone = effectivePromptTemplate(strategy({ prompt_template_id: "99999999-9999-4999-8999-999999999999" }), LIBRARY, "image");
  assert.equal(gone.source, "system_default");
  assert.equal(gone.content, "");
  assert.equal(gone.missingTemplateId, "99999999-9999-4999-8999-999999999999");
});

test("前端模板上限与后端 zod + 数据库 CHECK 一致（5000 / 80）", () => {
  assert.equal(PROMPT_TEMPLATE_CONTENT_MAX, 5000);
  assert.equal(PROMPT_TEMPLATE_NAME_MAX, 80);
});

/* ---------- v1.4(七.3)资产生图提示词拼接合同:assembleAssetImagePrompt ---------- */

test("T12.8 assembleAssetImagePrompt：风格模板 + 名称/描述/备注两段拼接", () => {
  const out = assembleAssetImagePrompt({
    template: "写实电影质感，保持角色一致性",
    name: "任天野",
    intro: "中年刑警，体格健硕",
    notes: "常穿便装",
  });
  assert.equal(
    out,
    "写实电影质感，保持角色一致性\n任天野，中年刑警，体格健硕，常穿便装",
  );
});

test("T12.8 assembleAssetImagePrompt：备注进入资产段（v1.4 缺口①修复）", () => {
  const out = assembleAssetImagePrompt({ template: "", name: "玉玺", intro: null, notes: "传国之物" });
  assert.ok(out.includes("传国之物"), "备注必须参与拼接");
  assert.ok(out.endsWith("玉玺，传国之物"), "名称与备注中文逗号连接");
});

test("T12.8 assembleAssetImagePrompt：模板为空（系统默认空内容）时空段跳过", () => {
  const out = assembleAssetImagePrompt({ template: "", name: "主题曲", intro: "主旋律" });
  assert.equal(out, "主题曲，主旋律", "风格段为空时整段跳过");
});

test("T12.9 两弹窗同一拼接合同：均调用 assembleAssetImagePrompt（单一真源）", () => {
  const addImageSource = readFileSync(new URL("./pages/lite/lite-asset-add-image-dialog.tsx", import.meta.url), "utf8");
  const createSource = readFileSync(new URL("./pages/lite/lite-asset-create-dialog.tsx", import.meta.url), "utf8");
  assert.ok(addImageSource.includes("assembleAssetImagePrompt("), "弹窗 B 应调用同一拼接函数");
  assert.ok(createSource.includes("assembleAssetImagePrompt("), "弹窗 A 应调用同一拼接函数");
});
