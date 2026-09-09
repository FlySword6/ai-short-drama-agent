import assert from "node:assert/strict";
import test from "node:test";
import { ApiClientError, api, assetFromUnknown, assetListPath, mediaVersionFromUnknown } from "./api";
import { assetImageValidationError, formatFileSize, selectReferenceMediaVersion } from "./asset-media";

const projectId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const mediaId = "44444444-4444-4444-8444-444444444444";

test("项目资产列表路径包含 project_id 和筛选条件", () => {
  assert.equal(
    assetListPath({ scope: "project", projectId, query: "女将军", assetKind: "character", status: "approved" }),
    `/assets?scope=project&project_id=${projectId}&query=%E5%A5%B3%E5%B0%86%E5%86%9B&asset_kind=character&status=approved`,
  );
  assert.equal(assetListPath({ scope: "personal" }), "/assets?scope=personal");
  assert.equal(
    assetListPath({ scope: "common", assetKind: "scene", tag: "雨夜", page: 2, pageSize: 24 }),
    "/assets?scope=common&asset_kind=scene&tag=%E9%9B%A8%E5%A4%9C&page=2&page_size=24",
  );
});

test("资产列表分页信封保留总数、下一页和全库类型计数", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        items: [{ id: assetId, scope: "common", asset_kind: "character" }],
        count: 961,
        filtered_count: 77,
        page: 1,
        page_size: 24,
        has_more: true,
        kind_counts: { character: 77, prop: 301 },
      },
    });
    const result = await api.assets({ scope: "common", page: 1, pageSize: 24 });
    assert.equal(result.items.length, 1);
    assert.equal(result.count, 961);
    assert.equal(result.filteredCount, 77);
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 24);
    assert.equal(result.hasMore, true);
    assert.deepEqual(result.kindCounts, { character: 77, prop: 301 });
    assert.equal(requests.items[0]?.url, "/api/v1/assets?scope=common&page=1&page_size=24");
  });
});

test("图片选择校验拒绝空文件、超大文件和 SVG", () => {
  assert.equal(assetImageValidationError({ name: "role.png", type: "image/png", size: 1024 }), "");
  assert.equal(assetImageValidationError({ name: "role.svg", type: "image/svg+xml", size: 1024 }), "请选择 JPG、PNG、WebP、GIF、AVIF、TIFF 或 BMP 图片");
  assert.equal(assetImageValidationError({ name: "empty.png", type: "image/png", size: 0 }), "图片文件不能为空");
  // S11-5：上限与后端 ASSET_MEDIA_MAX_FILE_BYTES 统一为 10MB（原 100MB 会被后端实际拒收）
  assert.equal(assetImageValidationError({ name: "huge.png", type: "image/png", size: 11 * 1024 * 1024 }), "图片不能超过 10 MB");
  assert.equal(formatFileSize(1536), "1.5 KB");
});

test("API 使用项目 scope 读取资产", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: [{ id: assetId, scope: "project" }], count: 1 } });
    const result = await api.assets({ scope: "project", projectId });

    assert.equal(result.count, 1);
    assert.equal(result.items[0]?.scope, "project");
    assert.equal(requests.items[0]?.url, `/api/v1/assets?scope=project&project_id=${projectId}`);
    assert.equal(requests.items[0]?.init.method, undefined);
    assert.equal(new Headers(requests.items[0]?.init.headers).get("authorization"), "Bearer test-token");
  });
});

test("API 以 multipart 上传单张图片和版本信息", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { id: mediaId, title: "红衣正面", is_primary: true } }, 201);
    const file = new File([new Uint8Array([1, 2, 3])], "role.png", { type: "image/png" });
    const result = await api.uploadAssetMedia(assetId, file, {
      title: "  红衣正面  ",
      description: "  定稿图  ",
      isPrimary: true,
    });

    assert.equal(result.id, mediaId);
    const request = requests.items[0];
    assert.equal(request?.url, `/api/v1/assets/${assetId}/media`);
    assert.equal(request?.init.method, "POST");
    assert.ok(request?.init.body instanceof FormData);
    const form = request.init.body;
    const sentFile = form.get("file");
    assert.ok(sentFile instanceof File);
    assert.equal(sentFile.name, "role.png");
    assert.equal(form.get("title"), "红衣正面");
    assert.equal(form.get("description"), "定稿图");
    assert.equal(form.get("is_primary"), "true");
    assert.equal(new Headers(request.init.headers).has("content-type"), false);
  });
});

test("API 以 multipart 上传本地视频并提交解析", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        asset_id: assetId,
        media_id: mediaId,
        task_id: "video-task-1",
        status: "queued",
        storage_bucket: "shortdrama-dev",
        storage_path: "asset-videos/demo.mp4",
        storage_url: null,
      },
    }, 202);
    const file = new File([new Uint8Array([1, 2, 3])], "demo.mp4", { type: "video/mp4" });
    const result = await api.uploadVideoAsset(file, {
      name: "雨夜追逐参考",
      description: "镜头运动参考",
      sourceProjectName: "参考视频素材库",
    });

    assert.equal(result.assetId, assetId);
    assert.equal(result.mediaId, mediaId);
    assert.equal(result.taskId, "video-task-1");
    assert.equal(result.status, "queued");
    const request = requests.items[0];
    assert.equal(request?.url, "/api/v1/asset-ingest/videos/upload");
    assert.equal(request?.init.method, "POST");
    assert.ok(request?.init.body instanceof FormData);
    const form = request.init.body;
    const sentFile = form.get("file");
    assert.ok(sentFile instanceof File);
    assert.equal(sentFile.name, "demo.mp4");
    assert.equal(form.get("name"), "雨夜追逐参考");
    assert.equal(form.get("description"), "镜头运动参考");
    assert.equal(form.get("source_project_name"), "参考视频素材库");
    assert.equal(new Headers(request.init.headers).has("content-type"), false);
  });
});

test("API 以 multipart 上传本地音频并创建音色素材", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        asset_id: assetId,
        media_id: mediaId,
        storage_bucket: "shortdrama-dev",
        storage_path: "asset-audio/voice.wav",
        storage_url: null,
      },
    }, 201);
    const file = new File([new Uint8Array([1, 2, 3])], "voice.wav", { type: "audio/wav" });
    const result = await api.uploadAudioAsset(file, {
      name: "  男主旁白参考  ",
      description: "  冷静克制的男主旁白  ",
      category: "音色",
      sourceProjectName: "  音色素材库  ",
      voiceTraits: [" 低沉 ", "", "克制"],
      speakingStyle: " 旁白 ",
    });

    assert.equal(result.assetId, assetId);
    assert.equal(result.mediaId, mediaId);
    assert.equal(result.storageBucket, "shortdrama-dev");
    assert.equal(result.storagePath, "asset-audio/voice.wav");
    assert.equal(Object.prototype.hasOwnProperty.call(result, "taskId"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(result, "status"), false);
    const request = requests.items[0];
    assert.equal(request?.url, "/api/v1/asset-ingest/audio/upload");
    assert.equal(request?.init.method, "POST");
    assert.ok(request?.init.body instanceof FormData);
    const form = request.init.body;
    const sentFile = form.get("file");
    assert.ok(sentFile instanceof File);
    assert.equal(sentFile.name, "voice.wav");
    assert.equal(form.get("name"), "男主旁白参考");
    assert.equal(form.get("description"), "冷静克制的男主旁白");
    assert.equal(form.get("category"), "音色");
    assert.equal(form.get("source_project_name"), "音色素材库");
    assert.equal(form.get("voice_traits"), "低沉,克制");
    assert.equal(form.get("speaking_style"), "旁白");
    assert.equal(form.has("music_traits"), false);
    assert.equal(form.has("tempo"), false);
    assert.equal(form.has("usage_scene"), false);
    assert.equal(new Headers(request.init.headers).has("content-type"), false);
  });
});

test("API 以 multipart 上传本地音频并创建背景音乐素材", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        asset_id: assetId,
        media_id: mediaId,
        storage_bucket: "shortdrama-dev",
        storage_path: "asset-audio/bgm.ogg",
        storage_url: "https://example.invalid/bgm.ogg",
      },
    }, 201);
    const file = new File([new Uint8Array([1, 2, 3])], "bgm.ogg", { type: "audio/ogg" });
    const result = await api.uploadAudioAsset(file, {
      name: "都市悬疑低频铺底",
      category: "背景音乐",
      musicTraits: ["悬疑", "压抑"],
      tempo: "慢",
      usageScene: "反转",
    });

    assert.equal(result.assetId, assetId);
    assert.equal(result.mediaId, mediaId);
    assert.equal(result.storageUrl, "https://example.invalid/bgm.ogg");
    const request = requests.items[0];
    assert.equal(request?.url, "/api/v1/asset-ingest/audio/upload");
    assert.ok(request?.init.body instanceof FormData);
    const form = request.init.body;
    assert.equal(form.get("category"), "背景音乐");
    assert.equal(form.get("music_traits"), "悬疑,压抑");
    assert.equal(form.get("tempo"), "慢");
    assert.equal(form.get("usage_scene"), "反转");
    assert.equal(form.has("voice_traits"), false);
    assert.equal(form.has("speaking_style"), false);
    assert.equal(new Headers(request.init.headers).has("content-type"), false);
  });
});

test("项目引用选择服务端主图片，并把 asset_media_id 写入请求", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        items: [
          { id: mediaId, mediaKind: "image", storageUrl: "https://media.example.com/role.png", isPrimary: true },
        ],
        count: 1,
      },
    });
    const versions = await api.assetVersions(assetId);
    const selected = selectReferenceMediaVersion(versions.items);

    assert.equal(selected?.id, mediaId);
    assert.equal(selected?.is_primary, true);
    assert.equal(selected?.storage_url, "https://media.example.com/role.png");

    requests.respondWith({ ok: true, data: { id: "55555555-5555-4555-8555-555555555555", asset_media_id: mediaId } }, 201);
    await api.addProjectAsset(projectId, assetId, selected!.id);

    const request = requests.items[1];
    assert.equal(request?.url, `/api/v1/projects/${projectId}/assets`);
    assert.deepEqual(JSON.parse(String(request?.init.body)), {
      asset_entity_id: assetId,
      asset_media_id: mediaId,
    });
  });
});

test("没有持久化地址的图片不能被静默加入项目", () => {
  assert.equal(selectReferenceMediaVersion([{ id: mediaId, media_kind: "image", is_primary: true }]), null);
});

/* ---------- H 线：assetFromUnknown 键名归一补洞（S9-7 死字段审计 P0-2 / P1-1） ---------- */

test("assetFromUnknown：后端 catalog 的 role 字段映射到 Asset.role（RoleBadge/参考集分组数据源）", () => {
  const asset = assetFromUnknown({
    id: "a1",
    role: "character_identity",
    name: "任天野",
    image_status: "repairable",
  });
  assert.equal(asset.role, "character_identity");
  assert.equal(asset.image_status, "repairable");
  // 后端未迁移 role 的旧数据保持 undefined，不虚构职责
  assert.equal(assetFromUnknown({ id: "a2" }).role, undefined);
});

test("assetFromUnknown：current_media 兜底读 metadata.primary_image（wire 为 snake，旧 camel 读法恒空）", () => {
  const asset = assetFromUnknown({
    id: "a1",
    metadata: { primary_image: { id: mediaId, media_kind: "image", storage_url: "https://media.example.com/role.png", is_primary: true } },
  });
  assert.equal(asset.current_media?.id, mediaId);
  assert.equal(asset.current_media?.storage_url, "https://media.example.com/role.png");
  // 缩略图/主图兜底链同时生效
  assert.equal(asset.thumbnail_url, "https://media.example.com/role.png");
  // 顶层 current_media（snake）优先于 metadata 兜底
  const direct = assetFromUnknown({
    id: "a2",
    current_media: { id: "m-direct", storage_url: "https://media.example.com/direct.png" },
    metadata: { primary_image: { id: "m-meta", storage_url: "https://media.example.com/meta.png" } },
  });
  assert.equal(direct.current_media?.id, "m-direct");
  // 两者都缺 → undefined，不伪造媒体
  assert.equal(assetFromUnknown({ id: "a3" }).current_media, undefined);
});

test("assetFromUnknown：视频 current_media 使用同源下载地址作为可播放地址", () => {
  const asset = assetFromUnknown({
    id: "video-asset",
    asset_kind: "video",
    current_media: {
      id: mediaId,
      media_kind: "video",
      download_url: `/api/v1/assets/video-asset/media/${mediaId}/download`,
    },
  });
  assert.equal(asset.current_media?.media_kind, "video");
  assert.equal(asset.current_media?.storage_url, `/api/v1/assets/video-asset/media/${mediaId}/download`);
  assert.equal(asset.storage_url, `/api/v1/assets/video-asset/media/${mediaId}/download`);
});

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

/* ---------- S10：裁决 9/12 归一 + tier_id 全链 + 简单估价 + AI 审计日志 ---------- */

test("裁决 9：mediaVersionFromUnknown 补读 usage_mode（wire snake,缺省不虚构）", () => {
  const version = mediaVersionFromUnknown({ id: mediaId, usage_mode: "first_frame", media_kind: "image" });
  assert.equal(version.usage_mode, "first_frame");
  assert.equal(mediaVersionFromUnknown({ id: mediaId }).usage_mode, undefined);
  // camel 旧读法兼容（归一与其他键同法）
  assert.equal(mediaVersionFromUnknown({ id: mediaId, usageMode: "last_frame" }).usage_mode, "last_frame");
});

test("分镜媒体未暴露对象存储地址时，使用同源下载地址播放", () => {
  const version = mediaVersionFromUnknown({
    id: mediaId,
    media_kind: "video",
    download_url: `/api/v1/media/${mediaId}/download`,
  });
  assert.equal(version.storage_url, `/api/v1/media/${mediaId}/download`);
  assert.equal(version.download_url, `/api/v1/media/${mediaId}/download`);
});

test("video preview exchanges Bearer auth for a short-lived signed URL", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        media_id: mediaId,
        url: "https://signed.example.test/video.mp4",
        expires_at: "2026-08-17T00:05:00.000Z",
      },
    });
    const url = await api.assetMediaPreviewUrl(assetId, mediaId);
    assert.equal(url, "https://signed.example.test/video.mp4");
    assert.equal(requests.items[0]?.url, `/api/v1/assets/${assetId}/media/${mediaId}/preview-url`);
    assert.equal(requests.items[0]?.init.method, "POST");
    assert.equal(new Headers(requests.items[0]?.init.headers).get("authorization"), "Bearer test-token");
  });
});

test("客户端保留场景乐观锁版本，其余错误详情不进入展示层", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: false,
      error: {
        code: "scene_version_conflict",
        message: "保存场景没成：场景已被更新，请刷新后再试。",
        retryable: false,
        details: { currentVersion: 5 },
      },
    }, 409);
    await assert.rejects(
      api.asset(assetId),
      (error: unknown) => error instanceof ApiClientError
        && error.code === "scene_version_conflict"
        && (error.details as { currentVersion?: unknown })?.currentVersion === 5,
    );

    requests.respondWith({
      ok: false,
      error: {
        code: "review_state_conflict",
        message: "审核没成：状态已经变化，请刷新后重试。",
        retryable: false,
        details: { currentStatus: "pending" },
      },
    }, 409);
    await assert.rejects(
      api.asset(assetId),
      (error: unknown) => error instanceof ApiClientError && error.details === null,
    );
  });
});

test("裁决 12：ingestJsonAssets 键名归一——wire snake_case → 前端 camel IngestedAsset", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        count: 1,
        items: [{ id: assetId, asset_kind: "character", name: "任天野", display_name: "任天野·定妆", source_file_url: "https://example.com/src.png", role: null, usage_mode: null, metadata: {} }],
      },
    });
    const result = await api.ingestJsonAssets([{ asset_kind: "character", name: "任天野" }], { source_project_id: projectId });

    assert.equal(result.count, 1);
    assert.deepEqual(result.items[0], {
      id: assetId,
      assetKind: "character",
      name: "任天野",
      displayName: "任天野·定妆",
      sourceFileUrl: "https://example.com/src.png",
    });
    assert.equal(requests.items[0]?.url, "/api/v1/asset-ingest/json/assets");
    assert.equal(JSON.parse(String(requests.items[0]?.init.body)).source_project_id, projectId);
  });
});

test("tier_id 全链：估价与创建请求体都带 tier_id（合同 §3,不一致 422）", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        generation_quote_id: "q1",
        status: "pending_confirmation",
        estimated_cost_fen: 60,
        currency: "CNY",
        expires_at: "2099-01-01T00:00:00.000Z",
        tier_id: "img-seedream5pro-169-2k-1",
      },
    });
    const input = {
      media_kind: "image" as const,
      tier_id: "img-seedream5pro-169-2k-1",
      project_id: projectId,
      shot_id: "77777777-7777-4777-8777-777777777777",
      prompt: "估价",
      reference_media_ids: [],
      parameters: { ratio: "16:9", size: "2K" },
      quantity: 1,
      client_idempotency_key: "idem-key-0001",
    };
    await api.quoteGeneration(input);
    const estimateBody = JSON.parse(String(requests.items[0]?.init.body));
    assert.equal(estimateBody.tier_id, "img-seedream5pro-169-2k-1");
    assert.equal(estimateBody.action, "submit");

    requests.respondWith({ ok: true, data: { generation_request_id: "r1", status: "pending" } }, 202);
    await api.createGeneration(input, "q1");
    const createBody = JSON.parse(String(requests.items[1]?.init.body));
    assert.equal(createBody.tier_id, "img-seedream5pro-169-2k-1");
    assert.equal(createBody.generation_quote_id, "q1");
  });
});

test("简单估价（simpleEstimate）：body 只带 media_kind/tier_id/parameters/quantity,不带项目上下文", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        tier_id: "vid-seedance20fast-916-720p-4s",
        pricing_rule_id: "rule-1",
        provider: "ark",
        model: "doubao-seedance-2-0-fast-260128",
        media_kind: "video",
        billing_unit: "second",
        unit_price_fen: 80,
        billable_units: 4,
        estimated_cost_fen: 320,
        currency: "CNY",
        notice: "预估消耗，非云平台实际账单",
        generation_quote_id: null,
      },
    });
    const estimate = await api.simpleEstimate({
      media_kind: "video",
      tier_id: "vid-seedance20fast-916-720p-4s",
      parameters: { ratio: "9:16", resolution: "720p", duration_seconds: 4 },
      quantity: 1,
    });

    assert.equal(estimate.estimated_cost_fen, 320);
    assert.equal(estimate.billing_unit, "second");
    assert.equal(estimate.generation_quote_id, null, "简单估价不创建报价,不可确认");
    const body = JSON.parse(String(requests.items[0]?.init.body));
    assert.deepEqual(Object.keys(body).sort(), ["media_kind", "parameters", "quantity", "tier_id"]);
    assert.equal("project_id" in body, false);
    assert.equal("action" in body, false, "不得误入 full/retry 估价分支");
  });
});

test("aiAuditLogs：路径带分页参数,snake wire 归一 camel,has_more 透传", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({
      ok: true,
      data: {
        items: [{
          id: "msg-1",
          session_id: "s-1",
          user_id: "u-1",
          user_name: "张三",
          project_id: projectId,
          shot_id: null,
          role: "assistant",
          content: "已生成",
          tool_name: "generate_media",
          status: "completed",
          provider: "ark",
          model: "doubao-seed-1.6",
          usage: { input_tokens: 10, output_tokens: 20 },
          provider_cost_usd_micros: 123,
          points_spent: 60,
          duration_ms: 890,
          created_at: "2026-07-22T13:57:12.000Z",
        }],
        page: 2,
        page_size: 20,
        total: 42,
        has_more: true,
      },
    });
    const page = await api.aiAuditLogs(projectId, { page: 2, page_size: 20 });

    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/ai-audit-logs?page=2&page_size=20`);
    assert.equal(page.page, 2);
    assert.equal(page.pageSize, 20);
    assert.equal(page.total, 42);
    assert.equal(page.hasMore, true);
    const entry = page.items[0]!;
    assert.equal(entry.id, "msg-1");
    assert.equal(entry.sessionId, "s-1");
    assert.equal(entry.userName, "张三");
    assert.equal(entry.toolName, "generate_media");
    assert.equal(entry.pointsSpent, 60);
    assert.equal(entry.durationMs, 890);
    assert.equal(entry.createdAt, "2026-07-22T13:57:12.000Z");
  });
});

test("aiAuditLogs：has_more 缺失按 page*page_size<total 推导,不虚构「还有更多」", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: [{ id: "m1" }, { id: "m2" }], total: 2 } });
    const page = await api.aiAuditLogs(projectId);
    assert.equal(requests.items[0]?.url, `/api/v1/projects/${projectId}/ai-audit-logs`);
    assert.equal(page.page, 1);
    assert.equal(page.total, 2);
    assert.equal(page.hasMore, false);
  });
});

test("S76：上传/生成提醒列表 URL 只带一个 ?,limit 真正进 query(双问号会把 limit 解析成键名 ?limit 被后端丢弃)", async () => {
  await withMockBrowser(async (requests) => {
    requests.respondWith({ ok: true, data: { items: [], count: 0 } });
    await api.assetUploadNotifications();
    await api.generationAttemptNotifications(5);

    assert.equal(requests.items[0]?.url, "/api/v1/asset-upload-notifications?limit=20");
    assert.equal(requests.items[1]?.url, "/api/v1/generation-attempt-notifications?limit=5");
    for (const { url } of requests.items) assert.equal(url.includes("??"), false, `URL 出现双问号: ${url}`);
  });
});

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
