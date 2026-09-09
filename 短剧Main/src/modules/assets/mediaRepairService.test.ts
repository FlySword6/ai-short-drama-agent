import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  AssetMediaRepairService,
  buildAssetMediaRenditionStoragePath,
} from "./mediaRepairService.js";
import { isLegalBundleMediaForAsset } from "./mediaRepairRepository.js";
import type {
  AssetMediaRepairActionInput,
  AssetMediaRepairActor,
  AssetMediaRepairRepositoryPort,
  AssetMediaRepairRenditionUpsert,
  AssetMediaStoragePort,
  AssetRepairBundle,
  AssetRepairMediaSnapshot,
  ClaimedAssetMediaRepairTask,
} from "./mediaRepairTypes.js";

const actor: AssetMediaRepairActor = {
  id: "11111111-1111-4111-8111-111111111111",
  role: "member",
};
const assetId = "22222222-2222-4222-8222-222222222222";
const mediaId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";

function bundle(): AssetRepairBundle {
  return {
    asset: {
      id: assetId,
      ownerUserId: actor.id,
      visibility: "personal",
      status: "approved",
      sourceProjectId: null,
      intro: null,
      metadata: {},
      deletedAt: null,
    },
    variants: [],
    media: [{
      id: mediaId,
      assetEntityId: assetId,
      assetVariantId: null,
      mediaKind: "image",
      title: "角色原图",
      description: null,
      storageBucket: "assets",
      storagePath: "asset/role.png",
      widthPx: null,
      heightPx: null,
      format: null,
      sha256: null,
      approved: true,
      metadata: {},
      deletedAt: null,
    }],
    renditions: [],
    activeRepairTaskId: taskId,
  };
}

test("原件下载只接受当前 asset 的已审核且归属一致媒体", () => {
  const input = bundle();
  const media = input.media[0]!;
  assert.equal(isLegalBundleMediaForAsset(input, media), true);

  media.approved = false;
  assert.equal(isLegalBundleMediaForAsset(input, media), false);
  media.approved = true;

  input.variants = [{
    id: "99999999-9999-4999-8999-999999999999",
    assetEntityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    deletedAt: null,
  }];
  media.assetVariantId = input.variants[0]!.id;
  assert.equal(isLegalBundleMediaForAsset(input, media), false);
});

function task(status: ClaimedAssetMediaRepairTask["status"] = "processing"): ClaimedAssetMediaRepairTask {
  const now = new Date("2026-08-04T00:00:00.000Z");
  return {
    id: taskId,
    assetId,
    requestedByUserId: actor.id,
    clientIdempotencyKey: "55555555-5555-4555-8555-555555555555",
    requestHash: "a".repeat(64),
    mode: "safe",
    trigger: "manual",
    mediaIds: null,
    status,
    diagnosis: {},
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
    claimToken: status === "processing" ? "66666666-6666-4666-8666-666666666666" : null,
    leaseExpiresAt: status === "processing" ? new Date("2026-08-04T00:05:00.000Z") : null,
  };
}

class FakeRepository implements AssetMediaRepairRepositoryPort {
  readonly state = bundle();
  readonly actions: AssetMediaRepairActionInput[] = [];
  completed: Parameters<AssetMediaRepairRepositoryPort["completeTask"]>[2] | undefined;
  createdInput: Parameters<AssetMediaRepairRepositoryPort["createOrReuseTask"]>[0] | undefined;
  claimed: ClaimedAssetMediaRepairTask | null = task();

  async loadVisibleBundle(): Promise<AssetRepairBundle> { return this.state; }
  async loadRepairBundle(): Promise<AssetRepairBundle> { return this.state; }
  async requireRepairPermission(): Promise<void> {}
  async requireVisibleMedia(): Promise<AssetRepairMediaSnapshot> { return this.state.media[0]!; }
  async createOrReuseTask(input: Parameters<AssetMediaRepairRepositoryPort["createOrReuseTask"]>[0]) {
    this.createdInput = input;
    return { task: task("queued"), created: false };
  }
  async getTaskForActor(): Promise<ClaimedAssetMediaRepairTask | null> { return task("queued"); }
  async claimNextQueued(): Promise<ClaimedAssetMediaRepairTask | null> {
    const value = this.claimed;
    this.claimed = null;
    return value;
  }
  async heartbeatClaim(): Promise<boolean> { return true; }
  async requeueInterrupted(): Promise<number> { return 0; }
  async enqueueSelfHealCandidates(): Promise<number> { return 0; }
  async updateMediaFactsAndAppendAction(
    targetTaskId: string,
    targetClaimToken: string,
    targetMediaId: string,
    patch: { widthPx: number; heightPx: number; format: string; sha256: string; metadata: Record<string, unknown> },
    action: Parameters<AssetMediaRepairRepositoryPort["updateMediaFactsAndAppendAction"]>[4],
  ): Promise<void> {
    assert.equal(targetMediaId, mediaId);
    Object.assign(this.state.media[0]!, patch);
    this.actions.push({ taskId: targetTaskId, claimToken: targetClaimToken, ...action });
  }
  async upsertRenditionsAndAppendAction(
    targetTaskId: string,
    targetClaimToken: string,
    inputs: readonly AssetMediaRepairRenditionUpsert[],
    action: Parameters<AssetMediaRepairRepositoryPort["upsertRenditionsAndAppendAction"]>[3],
  ): Promise<void> {
    for (const input of inputs) {
      const index = this.state.renditions.findIndex((item) =>
        item.assetMediaId === input.assetMediaId && item.renditionKind === input.renditionKind
      );
      const row = {
        id: index >= 0 ? this.state.renditions[index]!.id : `${input.renditionKind}-rendition`,
        ...input,
      };
      if (index >= 0) this.state.renditions[index] = row;
      else this.state.renditions.push(row);
    }
    this.actions.push({ taskId: targetTaskId, claimToken: targetClaimToken, ...action });
  }
  async appendAction(input: AssetMediaRepairActionInput): Promise<void> { this.actions.push(input); }
  async completeTask(
    _taskId: string,
    _claimToken: string,
    input: Parameters<AssetMediaRepairRepositoryPort["completeTask"]>[2],
  ): Promise<void> {
    this.completed = input;
    this.state.activeRepairTaskId = null;
  }
  async failTask(): Promise<void> { throw new Error("unexpected failTask"); }
}

test("通用资产普通成员的健康投影不暴露待审或双归属媒体，管理员仍能诊断", async () => {
  const repository = new FakeRepository();
  repository.state.asset.visibility = "common";
  repository.state.asset.ownerUserId = null;
  repository.state.media[0]!.approved = false;
  const conflictingMediaId = "77777777-7777-4777-8777-777777777777";
  const foreignAssetId = "88888888-8888-4888-8888-888888888888";
  const foreignVariantId = "99999999-9999-4999-8999-999999999999";
  repository.state.variants = [{
    id: foreignVariantId,
    assetEntityId: foreignAssetId,
    deletedAt: null,
  }];
  repository.state.media.push({
    ...repository.state.media[0]!,
    id: conflictingMediaId,
    assetEntityId: assetId,
    assetVariantId: foreignVariantId,
    approved: true,
  });
  const storage: AssetMediaStoragePort = {
    async uploadBytes() { throw new Error("not used"); },
    async headObject() { throw new Error("not used"); },
    async readObjectBytes() { throw new Error("not used"); },
    async createDownloadUrl() { throw new Error("not used"); },
  };
  const service = new AssetMediaRepairService(repository, storage);

  const publicHealth = await service.health(actor, assetId);
  assert.notEqual(publicHealth.status, "repairing");
  assert.equal(publicHealth.activeRepairTaskId, null);
  assert.equal(publicHealth.mediaCount, 0);
  assert.deepEqual(publicHealth.issues.map((item) => [item.code, item.mediaId]), [
    ["asset_media_missing", null],
  ]);

  const adminHealth = await service.health({ ...actor, role: "admin" }, assetId);
  assert.equal(adminHealth.status, "repairing");
  assert.equal(adminHealth.activeRepairTaskId, taskId);
  assert.equal(adminHealth.mediaCount, 2);
  assert.equal(adminHealth.issues.some((item) => item.mediaId === mediaId), true);
  assert.equal(adminHealth.issues.some((item) =>
    item.code === "media_entity_variant_mismatch" && item.mediaId === conflictingMediaId
  ), true);
});

test("安全修复读取原图真值，补齐元数据并核验两档展示变体", async () => {
  const source = await sharp({
    create: { width: 640, height: 360, channels: 3, background: "#986f52" },
  }).png().toBuffer();
  const thumbnail = await sharp(source).resize(320, 180, { fit: "cover" }).webp().toBuffer();
  const detail = await sharp(source).resize(1280, 720, { fit: "inside" }).webp().toBuffer();
  const reads: string[] = [];
  const uploads: Array<{ storagePath: string; contentType: string }> = [];
  const storage: AssetMediaStoragePort = {
    async uploadBytes(_content, storagePath, contentType) {
      uploads.push({ storagePath, contentType });
      return {
        bucket: "assets",
        storagePath,
        storageUrl: `https://private-storage.invalid/${storagePath}`,
      };
    },
    async headObject(path, bucket) {
      assert.equal(path, "asset/role.png");
      assert.equal(bucket, "assets");
      return { contentLength: source.length, contentType: "image/png", etag: "safe-etag", lastModified: null };
    },
    async readObjectBytes(path, options) {
      reads.push(options.process ?? "source");
      if (path.startsWith("asset-renditions/v1/")) {
        return path === uploads[0]?.storagePath ? thumbnail : detail;
      }
      if (!options.process) return source;
      return options.process.includes("w_320") ? thumbnail : detail;
    },
    createDownloadUrl() {
      return { url: "https://signed.example.test/object", expiresAt: new Date("2026-08-04T00:05:00.000Z") };
    },
  };
  const repository = new FakeRepository();
  const service = new AssetMediaRepairService(repository, storage);

  assert.equal(await service.processNextQueued(), true);
  assert.equal(repository.completed?.status, "succeeded");
  assert.equal(repository.state.media[0]!.widthPx, 640);
  assert.equal(repository.state.media[0]!.heightPx, 360);
  assert.equal(repository.state.renditions.length, 2);
  assert.equal(repository.state.renditions.every((item) => item.status === "healthy"), true);
  assert.equal(repository.state.renditions.every((item) => item.strategy === "stored_object"), true);
  assert.deepEqual(
    uploads,
    ["thumbnail", "detail"].map((kind) => ({
      storagePath: buildAssetMediaRenditionStoragePath(
        mediaId,
        repository.state.media[0]!.sha256!,
        kind as "thumbnail" | "detail",
        repository.state.renditions.find((item) => item.renditionKind === kind)!.sha256!,
      ),
      contentType: "image/webp",
    })),
  );
  assert.equal(uploads.every((item) =>
    item.storagePath.startsWith("asset-renditions/v1/")
    && !item.storagePath.includes("asset/role.png")
  ), true);
  assert.equal(repository.actions.filter((item) => item.action === "refresh_metadata").length, 1);
  assert.equal(repository.actions.filter((item) => item.action === "create_rendition").length, 2);
  assert.deepEqual(reads, [
    "source",
    "image/resize,m_fill,w_320,h_180/format,webp",
    "source",
    "image/resize,m_lfit,w_1280,h_720/format,webp",
    "source",
  ]);
});

test("rendition 对象 key 绑定输出 SHA，过期 worker 的不同字节不能覆盖新 worker", () => {
  const oldPath = buildAssetMediaRenditionStoragePath(
    mediaId,
    "a".repeat(64),
    "detail",
    "b".repeat(64),
  );
  const currentPath = buildAssetMediaRenditionStoragePath(
    mediaId,
    "a".repeat(64),
    "detail",
    "c".repeat(64),
  );
  assert.notEqual(oldPath, currentPath);
  assert.match(oldPath, /^asset-renditions\/v1\/[0-9a-f]{2}\/[0-9a-f]{64}[.]webp$/u);
  assert.match(currentPath, /^asset-renditions\/v1\/[0-9a-f]{2}\/[0-9a-f]{64}[.]webp$/u);
});

test("提交会排序去重媒体 ID，重放保持同一任务；下载只返回短时签名", async () => {
  const repository = new FakeRepository();
  const storage: AssetMediaStoragePort = {
    async uploadBytes() { throw new Error("not used"); },
    async headObject() { throw new Error("not used"); },
    async readObjectBytes() { throw new Error("not used"); },
    async createDownloadUrl(path, options) {
      assert.equal(path, "asset/role.png");
      assert.equal(options?.bucket, "assets");
      assert.equal(options?.expiresSeconds, 300);
      return { url: "https://signed.example.test/object", expiresAt: new Date("2026-08-04T00:05:00.000Z") };
    },
  };
  const service = new AssetMediaRepairService(repository, storage);
  const submitted = await service.submit({
    actor,
    assetId,
    clientIdempotencyKey: "55555555-5555-4555-8555-555555555555",
    mediaIds: [mediaId, mediaId],
    mode: "safe",
  });
  assert.equal(submitted.idempotentReplay, true);
  assert.deepEqual(repository.createdInput?.mediaIds, [mediaId]);
  assert.match(repository.createdInput?.requestHash ?? "", /^[0-9a-f]{64}$/);

  const download = await service.createDownloadUrl(actor, assetId, mediaId);
  assert.equal(download.url, "https://signed.example.test/object");
  assert.equal(download.mediaId, mediaId);
});

test("处理服务返回原格式、错尺寸或超界详情时不得登记 healthy rendition", async () => {
  const source = await sharp({
    create: { width: 640, height: 360, channels: 3, background: "#72563f" },
  }).png().toBuffer();
  const wrongThumbnail = await sharp(source).resize(319, 180).webp().toBuffer();
  const oversizedDetail = await sharp(source).resize(1281, 720, { fit: "fill" }).webp().toBuffer();
  let uploadCount = 0;
  const storage: AssetMediaStoragePort = {
    async uploadBytes() {
      uploadCount += 1;
      throw new Error("invalid rendition must not upload");
    },
    async headObject() {
      return { contentLength: source.length, contentType: "image/png", etag: null, lastModified: null };
    },
    async readObjectBytes(_path, options) {
      if (!options.process) return source;
      return options.process.includes("w_320") ? wrongThumbnail : oversizedDetail;
    },
    async createDownloadUrl() {
      throw new Error("not used");
    },
  };
  const repository = new FakeRepository();

  assert.equal(await new AssetMediaRepairService(repository, storage).processNextQueued(), true);
  assert.equal(uploadCount, 0);
  assert.equal(repository.state.renditions.length, 2);
  assert.equal(repository.state.renditions.every((item) => item.status === "failed"), true);
  assert.equal(repository.completed?.status, "partial", "metadata refresh may succeed while both variants fail");
});

test("上传成功但最终对象回读损坏或错对象时不得登记 healthy rendition", async () => {
  const source = await sharp({
    create: { width: 640, height: 360, channels: 3, background: "#3f5d72" },
  }).png().toBuffer();
  const thumbnail = await sharp(source).resize(320, 180, { fit: "cover" }).webp().toBuffer();
  const detail = await sharp(source).resize(1280, 720, { fit: "inside" }).webp().toBuffer();
  const wrongDetail = await sharp({
    create: { width: 1280, height: 720, channels: 3, background: "#72563f" },
  }).webp().toBuffer();
  const uploaded: string[] = [];
  const storage: AssetMediaStoragePort = {
    async uploadBytes(_content, storagePath) {
      uploaded.push(storagePath);
      return { bucket: "rendition-assets", storagePath, storageUrl: `https://private-storage.invalid/${storagePath}` };
    },
    async headObject() {
      return { contentLength: source.length, contentType: "image/png", etag: null, lastModified: null };
    },
    async readObjectBytes(path, options) {
      if (path === "asset/role.png" && !options.process) return source;
      if (path === "asset/role.png") {
        return options.process?.includes("w_320") ? thumbnail : detail;
      }
      assert.equal(options.bucket, "rendition-assets", "readback must target the final upload bucket");
      assert.equal(options.process, undefined, "readback must not reapply the source rendition process");
      return path === uploaded[0] ? Buffer.from("corrupted final object") : wrongDetail;
    },
    async createDownloadUrl() { throw new Error("not used"); },
  };
  const repository = new FakeRepository();

  assert.equal(await new AssetMediaRepairService(repository, storage).processNextQueued(), true);
  assert.equal(uploaded.length, 2, "both upload calls report success");
  assert.equal(repository.state.renditions.length, 2);
  assert.equal(repository.state.renditions.every((item) => item.status === "failed"), true);
  assert.equal(repository.state.renditions.some((item) => item.status === "healthy"), false);
  assert.equal(repository.completed?.status, "partial", "source metadata refresh can succeed independently");
  assert.ok(thumbnail.length > 0 && detail.length > 0, "the rendered candidates are valid before final-object readback");
});
