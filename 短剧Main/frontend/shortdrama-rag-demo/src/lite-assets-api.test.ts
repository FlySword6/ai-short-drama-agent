import assert from "node:assert/strict";
import test from "node:test";
import { api, type LiteAssetListResult } from "./api";

const projectId = "11111111-1111-4111-8111-111111111111";
const assetEntityId = "55555555-5555-4555-8555-555555555555";

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

test("liteListAssets:不带 kind 时 URL 无 query", async () => {
  await withMockBrowser(async (requests) => {
    const mockResult: LiteAssetListResult = {
      items: [{
        asset_entity_id: assetEntityId,
        name: "林雪",
        intro: "目击者",
        asset_kind: "character",
        audio_kind: null,
        primary_media_url: null,
        has_media: false,
        has_primary: false,
        has_pending_generation: false,
        last_modified_at: "2026-08-12T00:00:00.000Z",
      }],
      tab_counts: [{ kind: "character", count: 1 }],
    };
    requests.respondWith({ ok: true, data: mockResult });
    const result = await api.liteListAssets(projectId);
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets`);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]!.name, "林雪");
    assert.equal(result.tab_counts.length, 1);
  });
});

test("liteListAssets:带 kind 时 URL 带 query", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: [], tab_counts: [] } });
    await api.liteListAssets(projectId, "costume");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets?kind=costume`);
  });
});

test("liteListAssets:坏行(asset_entity_id 缺失)被丢弃不凑数", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        items: [
          { asset_entity_id: assetEntityId, name: "好行" },
          { name: "坏行缺 id" },
          { asset_entity_id: "", name: "空 id" },
        ],
        tab_counts: [{ kind: "character", count: 1 }, { kind: "costume", count: 0 }],
      },
    });
    const result = await api.liteListAssets(projectId);
    assert.equal(result.items.length, 1, "缺 id 或空 id 的行整行丢弃");
    assert.equal(result.tab_counts.length, 2);
  });
});

test("liteGetAsset:URL 含 asset_entity_id", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        asset_entity_id: assetEntityId, name: "林雪", intro: null,
        asset_kind: "character", note: null,
        has_media: false, has_primary: false, has_pending_generation: false,
        last_modified_at: "2026-08-12T00:00:00.000Z", modified_by_user_id: null,
        gender: "female", age_value: null, appearance: null,
        hair_description: null, outfit_description: null, height_cm: null,
        metadata_lite: null,
      },
    });
    const result = await api.liteGetAsset(projectId, assetEntityId);
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}`);
    assert.equal(result.name, "林雪");
    assert.equal(result.gender, "female");
  });
});

test("liteCreateAsset:POST body 含 name + asset_kind + intro + note", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { asset_entity_id: assetEntityId, first_variant_id: "var-1" } });
    const result = await api.liteCreateAsset(projectId, {
      name: "黑色风衣",
      asset_kind: "costume",
      intro: "林雪的外套",
      note: "第一集",
    });
    assert.equal(result.asset_entity_id, assetEntityId);
    assert.equal(result.first_variant_id, "var-1");
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "POST");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      name: "黑色风衣",
      asset_kind: "costume",
      intro: "林雪的外套",
      note: "第一集",
    });
  });
});

test("liteCreateAsset:响应含 first_variant_id(服务端自动建的第一个变体)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { asset_entity_id: assetEntityId, first_variant_id: "first-var-uuid" } });
    const result = await api.liteCreateAsset(projectId, { name: "测试", asset_kind: "scene" });
    assert.equal(result.asset_entity_id, assetEntityId);
    assert.equal(result.first_variant_id, "first-var-uuid");
  });
});

test("liteCreateAsset:intro/note 省略时不进 body", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { asset_entity_id: assetEntityId } });
    await api.liteCreateAsset(projectId, { name: "测试", asset_kind: "character" });
    const body = JSON.parse(String(requests.items[0]?.init?.body));
    assert.equal(body.name, "测试");
    assert.equal(body.asset_kind, "character");
    assert.ok(!("intro" in body), "intro 省略不进 body");
    assert.ok(!("note" in body), "note 省略不进 body");
  });
});

test("liteUpdateAsset:PATCH body 只含传入字段", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { ok: true } });
    await api.liteUpdateAsset(projectId, assetEntityId, { name: "新名", intro: "新描述" });
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "PATCH");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}`);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { name: "新名", intro: "新描述" });
  });
});

test("liteUpdateAsset:note 为 null 时进 body(清空备注)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { ok: true } });
    await api.liteUpdateAsset(projectId, assetEntityId, { note: null });
    const body = JSON.parse(String(requests.items[0]?.init?.body));
    assert.deepEqual(body, { note: null });
  });
});

// ---- Phase 2:变体 / 版本图轨 / 主图翻转 / 关联分镜 ----

const mediaId = "44444444-4444-4444-8444-444444444444";
const shotId = "88888888-8888-4888-8888-888888888888";

test("liteListAssetVariants:URL 含 variants 路径,解析多变体 + 主标记", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        items: [
          { variant_id: "v1", variant_kind: "costume_a", display_name: "正装", is_primary: true },
          { variant_id: "v2", variant_kind: "costume_b", display_name: "便装", is_primary: false },
        ],
      },
    });
    const result = await api.liteListAssetVariants(projectId, assetEntityId);
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/variants`);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.variant_id, "v1");
    assert.equal(result[0]!.is_primary, true);
    assert.equal(result[1]!.is_primary, false);
  });
});

test("liteListAssetVariants:坏行被丢弃(items 非数组返回空)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: "not-an-array" } });
    const result = await api.liteListAssetVariants(projectId, assetEntityId);
    assert.equal(result.length, 0);
  });
});

test("liteListVersionTrack:合并上传 + 生成图,source 标记正确(T8.2)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        items: [
          { asset_media_id: mediaId, media_result_id: null, storage_url: "https://x/u.png", is_primary: true, source: "upload", width_px: 1024, height_px: 576, created_at: "2026-08-12T01:00:00.000Z" },
          { asset_media_id: null, media_result_id: "mr-1", storage_url: "https://x/g.png", is_primary: false, source: "ai", width_px: null, height_px: null, created_at: "2026-08-12T02:00:00.000Z" },
        ],
      },
    });
    const result = await api.liteListVersionTrack(projectId, assetEntityId);
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/version-track`);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.source, "upload");
    assert.equal(result[0]!.width_px, 1024);
    assert.equal(result[1]!.source, "ai");
    assert.equal(result[1]!.width_px, null);
  });
});

test("liteListVersionTrack:未知 source 归一为 ai(防御)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: { items: [{ asset_media_id: null, media_result_id: "mr-1", source: "weird" }] },
    });
    const result = await api.liteListVersionTrack(projectId, assetEntityId);
    assert.equal(result[0]!.source, "ai");
  });
});

test("liteSetPrimaryMedia:PATCH body 含 asset_media_id", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { ok: true } });
    await api.liteSetPrimaryMedia(projectId, assetEntityId, mediaId);
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "PATCH");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/primary-media`);
    assert.deepEqual(JSON.parse(String(init?.body)), { asset_media_id: mediaId });
  });
});

test("liteSetPrimaryMedia:生成图走 media_result_id,body 只发 media_result_id(不夹带 asset_media_id)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { ok: true } });
    await api.liteSetPrimaryMedia(projectId, assetEntityId, undefined, "mr-9");
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "PATCH");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/primary-media`);
    assert.deepEqual(JSON.parse(String(init?.body)), { media_result_id: "mr-9" });
  });
});

test("liteSetPrimaryMedia:409 时抛业务错误(主图已被他人更改)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith(
      { ok: false, error: { code: "lite_primary_media_changed", message: "主图已被他人更改，请刷新后重试", retryable: true } },
      409,
    );
    await assert.rejects(
      () => api.liteSetPrimaryMedia(projectId, assetEntityId, mediaId),
      (err: Error & { status?: number }) => {
        assert.equal(err.status, 409);
        return true;
      },
    );
  });
});

test("liteListAssetUsages:flat 形状解析(usage_id/status/evidence) + variantId 过滤 query", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        items: [
          {
            usage_id: "u-1", variant_id: "v1", shot_id: shotId, episode_id: "ep-1",
            episode_no: 3, shot_no: 2, scene_name: "仓库", shot_label: "S03-002 仓库对峙",
            status: "bound", matched_by: "manual",
            evidence: { scene_names: ["仓库"], line_indices: [12, 13], source_text_snippets: ["林雪走进仓库…"] },
          },
          {
            usage_id: "u-2", variant_id: null, shot_id: null, episode_id: null,
            episode_no: 99, shot_no: 5, scene_name: "客厅", shot_label: "",
            status: "pending", matched_by: "exact_name", evidence: {},
          },
        ],
      },
    });
    const result = await api.liteListAssetUsages(projectId, assetEntityId, "v1");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/usages?variant_id=v1`);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.usage_id, "u-1");
    assert.equal(result[0]!.variant_id, "v1");
    assert.equal(result[0]!.status, "bound");
    assert.equal(result[0]!.matched_by, "manual");
    assert.deepEqual(result[0]!.evidence, { scene_names: ["仓库"], line_indices: [12, 13], source_text_snippets: ["林雪走进仓库…"] });
    // pending 行:shot_id 为 null,evidence 非对象空数组兜底
    assert.equal(result[1]!.status, "pending");
    assert.equal(result[1]!.shot_id, null);
    assert.deepEqual(result[1]!.evidence, { scene_names: [], line_indices: [], source_text_snippets: [] });
  });
});

test("liteListAssetUsages:缺 usage_id 坏行丢弃,未知 status/matched_by 归一", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        items: [
          { usage_id: "u-1", shot_id: shotId, status: "weird_status", matched_by: "unknown" },
          { shot_id: "other", episode_id: "ep-2", matched_by: "manual" },
          { usage_id: "" },
        ],
      },
    });
    const result = await api.liteListAssetUsages(projectId, assetEntityId);
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/usages`);
    assert.equal(result.length, 1, "缺/空 usage_id 的行整行丢弃");
    assert.equal(result[0]!.usage_id, "u-1");
    assert.equal(result[0]!.status, "bound");
    assert.equal(result[0]!.matched_by, "manual");
  });
});

test("liteAddShotUsages:POST body 为 { items } 包裹的条目数组,解析 added/pending", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { ok: true, added: 2, pending: 1 } });
    const result = await api.liteAddShotUsages(projectId, assetEntityId, [
      { shot_id: shotId, variant_id: "v1" },
      { episode_no: 2, shot_no: 5, scene_name: "厨房", variant_id: "v1" },
    ]);
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "POST");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/usages`);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      items: [
        { shot_id: shotId, variant_id: "v1" },
        { episode_no: 2, shot_no: 5, scene_name: "厨房", variant_id: "v1" },
      ],
    });
    assert.equal(result.added, 2);
    assert.equal(result.pending, 1);
  });
});

test("liteRemoveShotUsage:DELETE URL 含 usage_id 路径段,无 body", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { ok: true } });
    await api.liteRemoveShotUsage(projectId, assetEntityId, "usage-1");
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "DELETE");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/usages/usage-1`);
    assert.equal(init?.body, undefined);
  });
});

test("liteDeleteAssetVariant:DELETE URL 含 variants 路径段", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { ok: true } });
    await api.liteDeleteAssetVariant(projectId, assetEntityId, "var-1");
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "DELETE");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/variants/var-1`);
    assert.equal(init?.body, undefined);
  });
});

test("liteDeleteAssetMedia:DELETE URL 含 media 路径段(双 ID 空间均可)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { ok: true } });
    await api.liteDeleteAssetMedia(projectId, assetEntityId, mediaId);
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "DELETE");
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/lite/assets/${assetEntityId}/media/${mediaId}`);
    assert.equal(init?.body, undefined);
  });
});

test("createAssetVariant:POST 到 assets 模块,body 含 name + description", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { id: "var-1", name: "战斗形态" } });
    const result = await api.createAssetVariant(assetEntityId, { name: "战斗形态", description: "红色战甲" });
    const init = requests.items[0]?.init;
    assert.equal(init?.method, "POST");
    assert.equal(requests.items[0]?.url, `/api/v1/assets/${assetEntityId}/variants`);
    assert.deepEqual(JSON.parse(String(init?.body)), { name: "战斗形态", description: "红色战甲" });
    assert.equal(result.id, "var-1");
    assert.equal(result.name, "战斗形态");
  });
});

test("createAssetVariant:description 省略时不进 body", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { id: "var-2", name: "便装" } });
    await api.createAssetVariant(assetEntityId, { name: "便装" });
    assert.deepEqual(JSON.parse(String(requests.items[0]?.init?.body)), { name: "便装" });
  });
});

test("uploadAssetMedia:assetVariantId 传入时 FormData 含 asset_variant_id", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { id: mediaId, asset_id: assetEntityId, media_kind: "image", is_primary: false, width: 1, height: 1, storage_url: "x", format: "png", created_at: "2026-01-01T00:00:00Z" } });
    await api.uploadAssetMedia(assetEntityId, new File(["x"], "f.png"), {
      isPrimary: false,
      assetVariantId: "var-uuid-1",
    });
    const body = requests.items[0]?.init?.body;
    assert.ok(body instanceof FormData, "body 应为 FormData");
    assert.equal((body as FormData).get("asset_variant_id"), "var-uuid-1");
  });
});

test("liteListVersionTrack:variant_id 被正确解析(上传图有,生成图无)", async () => {
  await withMockBrowser(async () => {
    const { api } = await import("./api");
    api.setToken("test-token");
    const variantId = "77777777-7777-4777-8777-777777777777";
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      data: {
        items: [
          { asset_media_id: "m1", source: "upload", variant_id: variantId },
          { asset_media_id: null, media_result_id: "mr1", source: "ai", variant_id: null },
        ],
      },
    }), { headers: { "content-type": "application/json" } });
    const result = await api.liteListVersionTrack(projectId, assetEntityId);
    assert.equal(result[0]!.variant_id, variantId);
    assert.equal(result[1]!.variant_id, null);
  });
});
