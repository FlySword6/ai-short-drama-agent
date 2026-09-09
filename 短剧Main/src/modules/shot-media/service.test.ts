import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import type { mediaResults } from "../../db/schema.js";
import { ShotMediaService } from "./service.js";
import type { ShotMediaRecord, ShotMediaRepository } from "./repository.js";

/* #164 G10:shot-media 列表下发「已入资产库」标记(registered_asset_media_id)——
   与定稿(is_primary/selection_source)两个独立标记同挂(§10.2),界面据此同时显示。 */

const actor = { id: "11111111-1111-4111-8111-111111111111", role: "member" as const };
const shotId = "22222222-2222-4222-8222-222222222222";

function mediaRow(overrides: Partial<typeof mediaResults.$inferSelect>): typeof mediaResults.$inferSelect {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    requestId: null,
    attemptId: null,
    shotId,
    originKind: "generation",
    sourceAssetMediaId: null,
    registeredByUserId: null,
    mediaKind: "image",
    resultIndex: 0,
    providerResultKey: null,
    providerUrl: null,
    providerUrlExpiresAt: null,
    persistenceStatus: "persisted",
    storageBucket: "bucket",
    storagePath: "path",
    storageUrl: "https://tos.example/image.png",
    sha256: null,
    mimeType: "image/png",
    widthPx: 720,
    heightPx: 1280,
    durationSeconds: null,
    reviewStatus: "accepted",
    createdAt: new Date("2026-08-06T14:22:00Z"),
    updatedAt: new Date("2026-08-06T14:22:00Z"),
    deletedAt: null,
    deletedByUserId: null,
    ...overrides,
  } as typeof mediaResults.$inferSelect;
}

function record(overrides: Partial<ShotMediaRecord>): ShotMediaRecord {
  return {
    media: mediaRow({}),
    attemptNo: 1,
    attemptStatus: "succeeded",
    attemptCreatedAt: new Date("2026-08-06T14:22:00Z"),
    provider: "seedream",
    model: "seedream-x",
    registeredAssetMediaId: null,
    ...overrides,
  };
}

function serviceWith(items: ShotMediaRecord[], effectiveImage: { id: string; source: "manual" | "latest_default" } | null) {
  const repository = {
    list: async () => ({ items, effectiveImage, effectiveVideo: null }),
  } as unknown as ShotMediaRepository;
  return new ShotMediaService({} as Database, repository);
}

test("G10:已登记产物带 registered_asset_media_id,未登记为 null", async () => {
  const registered = record({
    media: mediaRow({ id: "55555555-5555-4555-8555-555555555555" }),
    registeredAssetMediaId: "66666666-6666-4666-8666-666666666666",
  });
  const plain = record({ media: mediaRow({ id: "77777777-7777-4777-8777-777777777777" }) });
  const service = serviceWith([registered, plain], null);

  const items = await service.list(actor, shotId);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.registered_asset_media_id, "66666666-6666-4666-8666-666666666666");
  assert.equal(items[1]!.registered_asset_media_id, null);
});

test("G10:定稿与入库两个标记互不影响——同一张图可同时挂(§10.2)", async () => {
  const both = record({
    media: mediaRow({ id: "55555555-5555-4555-8555-555555555555" }),
    registeredAssetMediaId: "66666666-6666-4666-8666-666666666666",
  });
  const service = serviceWith([both], { id: "55555555-5555-4555-8555-555555555555", source: "manual" });

  const [item] = await service.list(actor, shotId);
  assert.equal(item!.is_primary, true);
  assert.equal(item!.selection_source, "manual");
  assert.equal(item!.registered_asset_media_id, "66666666-6666-4666-8666-666666666666");
});

test("G10:素材库选用回挂的条目不回填登记标记(本身就来自素材库,不算「存进资产库」)", async () => {
  const fromAsset = record({
    media: mediaRow({ originKind: "asset_media", sourceAssetMediaId: "88888888-8888-4888-8888-888888888888" }),
    attemptNo: null,
    attemptStatus: null,
    attemptCreatedAt: null,
    provider: null,
    model: null,
    registeredAssetMediaId: null,
  });
  const service = serviceWith([fromAsset], null);

  const [item] = await service.list(actor, shotId);
  assert.equal(item!.origin_label, "从素材库选用");
  assert.equal(item!.registered_asset_media_id, null);
});

/* Lite 批次二 S3:wire 输出 provider_result_key——视频任务尾帧行='last-frame-<i>',
   候选图='image-<i>',延长链前端据此把尾帧图和候选图分得开。 */
test("S3:provider_result_key 透传——尾帧行/候选图可区分,素材库选用=null", async () => {
  const lastFrame = record({
    media: mediaRow({
      id: "55555555-5555-4555-8555-555555555555",
      mediaKind: "image",
      providerResultKey: "last-frame-0",
    }),
  });
  const candidate = record({
    media: mediaRow({
      id: "77777777-7777-4777-8777-777777777777",
      providerResultKey: "image-0",
    }),
  });
  const fromAsset = record({
    media: mediaRow({ originKind: "asset_media", sourceAssetMediaId: "88888888-8888-4888-8888-888888888888" }),
    attemptNo: null,
    attemptStatus: null,
    attemptCreatedAt: null,
    provider: null,
    model: null,
    registeredAssetMediaId: null,
  });
  const service = serviceWith([lastFrame, candidate, fromAsset], null);

  const items = await service.list(actor, shotId);
  assert.equal(items[0]!.provider_result_key, "last-frame-0");
  assert.equal(items[1]!.provider_result_key, "image-0");
  assert.equal(items[2]!.provider_result_key, null);
});

/* v1.4(迁移 065):版本号 = 同分镜 video 按 created_at 升序序号,图片无版本号;
   版本标签/回溯请求 id 分别透出 metadata.shot_version.label 与 requestId。 */
function videoRecord(id: string, createdAt: string, extra: Partial<typeof mediaResults.$inferSelect> = {}): ShotMediaRecord {
  return record({
    media: mediaRow({ id, mediaKind: "video", createdAt: new Date(createdAt), ...extra }),
  });
}

test("v1.4:版本号按 video 的 created_at 升序编号,图片与素材库选用无版本号", async () => {
  const v1 = videoRecord("55555555-5555-4555-8555-555555555555", "2026-08-06T10:00:00Z");
  const v2 = videoRecord("66666666-6666-4666-8666-666666666666", "2026-08-06T11:00:00Z");
  const v3 = videoRecord("77777777-7777-4777-8777-777777777777", "2026-08-06T09:00:00Z");
  const image = record({ media: mediaRow({ id: "88888888-8888-4888-8888-888888888888", mediaKind: "image" }) });
  const fromAsset = record({
    media: mediaRow({
      id: "99999999-9999-4999-8999-999999999999",
      mediaKind: "video",
      originKind: "asset_media",
      createdAt: new Date("2026-08-06T12:00:00Z"),
    }),
    attemptNo: null,
    attemptStatus: null,
    attemptCreatedAt: null,
    provider: null,
    model: null,
  });
  // 列表顺序与版本号无关:repository 按 mediaKind/createdAt desc 返回,版本号仍按 createdAt asc。
  const service = serviceWith([v1, v2, v3, image, fromAsset], null);

  const items = await service.list(actor, shotId);
  const versionByMediaId = new Map(items.map((item) => [item.id, item.version_no]));
  assert.equal(versionByMediaId.get("77777777-7777-4777-8777-777777777777"), 1);
  assert.equal(versionByMediaId.get("55555555-5555-4555-8555-555555555555"), 2);
  assert.equal(versionByMediaId.get("66666666-6666-4666-8666-666666666666"), 3);
  assert.equal(versionByMediaId.get("88888888-8888-4888-8888-888888888888"), null);
  // 素材库选用条目也是 video,参与版本编号;但无回溯请求。
  assert.equal(versionByMediaId.get("99999999-9999-4999-8999-999999999999"), 4);
});

test("v1.4:version_label 与 generation_request_id 透出——打标签的/有请求的各自非空", async () => {
  const labeled = videoRecord("55555555-5555-4555-8555-555555555555", "2026-08-06T10:00:00Z", {
    metadata: { shot_version: { label: "定稿版" } },
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  const plain = videoRecord("66666666-6666-4666-8666-666666666666", "2026-08-06T11:00:00Z", {
    requestId: null,
  });
  const service = serviceWith([labeled, plain], null);

  const items = await service.list(actor, shotId);
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get("55555555-5555-4555-8555-555555555555")!.version_label, "定稿版");
  assert.equal(byId.get("55555555-5555-4555-8555-555555555555")!.generation_request_id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(byId.get("66666666-6666-4666-8666-666666666666")!.version_label, null);
  assert.equal(byId.get("66666666-6666-4666-8666-666666666666")!.generation_request_id, null);
});

/* happyhorse 预览集成 §2.2:版本视图透传 metadata.preview——预览档视频带 preview=true,
   历史行无键一律按正式(false),不回填。 */
test("预览档:metadata.preview=true 透出 preview=true,无键=false", async () => {
  const previewVersion = videoRecord("55555555-5555-4555-8555-555555555555", "2026-08-06T10:00:00Z", {
    metadata: { preview: true },
  });
  const formalVersion = videoRecord("66666666-6666-4666-8666-666666666666", "2026-08-06T11:00:00Z");
  const service = serviceWith([previewVersion, formalVersion], null);

  const items = await service.list(actor, shotId);
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.equal(byId.get("55555555-5555-4555-8555-555555555555")!.preview, true);
  assert.equal(byId.get("66666666-6666-4666-8666-666666666666")!.preview, false);
});

test("v1.4:setVersionLabel 委托仓储并回显请求的标签与备注", async () => {
  let received: { shotId: string; mediaId: string; label: string | null; note: string | null } | undefined;
  const repository = {
    setVersionLabel: async (_actor: unknown, actualShotId: string, mediaId: string, label: string | null, note: string | null) => {
      received = { shotId: actualShotId, mediaId, label, note };
      return { shotId: actualShotId, mediaKind: "video" as const, mediaResultId: mediaId };
    },
  } as unknown as ShotMediaRepository;
  const service = new ShotMediaService({} as Database, repository);

  const result = await service.setVersionLabel(actor, shotId, "55555555-5555-4555-8555-555555555555", "雨夜版", "人物偏暗");
  assert.deepEqual(received, { shotId, mediaId: "55555555-5555-4555-8555-555555555555", label: "雨夜版", note: "人物偏暗" });
  assert.deepEqual(result, {
    shot_id: shotId,
    media_kind: "video",
    media_result_id: "55555555-5555-4555-8555-555555555555",
    version_label: "雨夜版",
    version_note: "人物偏暗",
  });
});

test("Lite 界面重做:deleteMedia 委托仓储并回显被删版本 id", async () => {
  let received: { shotId: string; mediaId: string } | undefined;
  const repository = {
    deleteMedia: async (_actor: unknown, actualShotId: string, mediaId: string) => {
      received = { shotId: actualShotId, mediaId };
      return { shotId: actualShotId, mediaKind: "video" as const, mediaResultId: mediaId };
    },
  } as unknown as ShotMediaRepository;
  const service = new ShotMediaService({} as Database, repository);

  const result = await service.deleteMedia(actor, shotId, "55555555-5555-4555-8555-555555555555");
  assert.deepEqual(received, { shotId, mediaId: "55555555-5555-4555-8555-555555555555" });
  assert.deepEqual(result, {
    shot_id: shotId,
    media_kind: "video",
    media_result_id: "55555555-5555-4555-8555-555555555555",
  });
});
