import assert from "node:assert/strict";
import test from "node:test";
import { ConflictError } from "../../shared/errors.js";
import type { MediaReviewStrategies } from "../reviews/mediaPolicy.js";
import type { GatedDeliverableMedia } from "./manifest.js";
import type {
  DeliveryRecord,
  DeliveryRepository,
  EpisodeDeliverySource,
  NewDeliveryRecord,
} from "./repository.js";
import { DeliveryService } from "./service.js";

const automatic: MediaReviewStrategies = { image: "automatic", video: "automatic", audio: "automatic" };
const pending: MediaReviewStrategies = { image: "pending_review", video: "pending_review", audio: "pending_review" };

function media(overrides: Partial<GatedDeliverableMedia> = {}): GatedDeliverableMedia {
  return {
    projectId: "project-1",
    projectName: "测试短剧",
    episodeId: "episode-1",
    episodeNo: 1,
    shotId: "shot-1",
    shotCode: "G01",
    shotSortOrder: 1,
    mediaId: "video-1",
    mediaKind: "video",
    originKind: "generation",
    sourceAssetMediaId: null,
    storageUrl: "https://storage.example/video-1.mp4",
    storagePath: "projects/project-1/video-1.mp4",
    mimeType: "video/mp4",
    durationSeconds: 3,
    generationRequestId: "request-1",
    generationAttemptId: "attempt-1",
    provider: "ark",
    model: "seedance",
    parameters: {},
    estimatedCostFen: 100,
    reviewStatus: "accepted",
    ...overrides,
  };
}

class FakeDeliveryRepository implements DeliveryRepository {
  inserted: NewDeliveryRecord[] = [];

  constructor(readonly source: EpisodeDeliverySource) {}

  async loadEpisode(): Promise<EpisodeDeliverySource> {
    return this.source;
  }

  async getDownload() {
    return { mediaId: "m", storageUrl: "https://storage.example/m", storagePath: "m", mimeType: null };
  }

  async insertDeliveryRecord(_actor: unknown, input: NewDeliveryRecord): Promise<DeliveryRecord> {
    this.inserted.push(input);
    return {
      id: `record-${this.inserted.length}`,
      projectId: this.source.projectId,
      episodeId: input.episodeId,
      manifestHash: input.manifestHash,
      mediaResultIds: input.mediaResultIds,
      partial: input.partial,
      missingShotCodes: input.missingShotCodes,
      purpose: input.purpose,
      deliveredByUserId: "user-1",
      createdAt: new Date("2026-07-24T00:00:00.000Z"),
    };
  }

  async listDeliveryRecords() {
    return { items: [], total: 0, page: 1, pageSize: 20 };
  }
}

function sourceOf(
  strategies: MediaReviewStrategies,
  shots: EpisodeDeliverySource["shots"],
  items: GatedDeliverableMedia[],
): EpisodeDeliverySource {
  return {
    projectId: "project-1",
    projectName: "测试短剧",
    episodeId: "episode-1",
    episodeNo: 1,
    reviewStrategies: strategies,
    shots,
    media: items,
  };
}

test("pending_review 策略下未审产物不进交付,报错给出补齐指引", async () => {
  const repository = new FakeDeliveryRepository(sourceOf(
    pending,
    [{ id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: "video-1" }],
    [media({ reviewStatus: "needs_review" })],
  ));
  const service = new DeliveryService(repository);
  await assert.rejects(
    service.getManifest("user-1", "episode-1"),
    (error: unknown) => error instanceof ConflictError
      && error.code === "deliverable_not_ready"
      && error.message.includes("还没选定通过审核的视频")
      && JSON.stringify(error.details).includes("G01"),
  );
  // 审核通过后立即可交付
  repository.source.media[0]!.reviewStatus = "accepted";
  const manifest = await service.getManifest("user-1", "episode-1");
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.partial, false);
});

test("automatic 策略下 needs_review 产物行为与今天一致(放行),rejected 仍拦截", async () => {
  const service = new DeliveryService(new FakeDeliveryRepository(sourceOf(
    automatic,
    [{ id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: "video-1" }],
    [media({ reviewStatus: "needs_review" })],
  )));
  const manifest = await service.getManifest("user-1", "episode-1");
  assert.equal(manifest.items.length, 1);

  const blocked = new DeliveryService(new FakeDeliveryRepository(sourceOf(
    automatic,
    [{ id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: "video-1" }],
    [media({ reviewStatus: "rejected" })],
  )));
  await assert.rejects(
    blocked.getManifest("user-1", "episode-1"),
    (error: unknown) => error instanceof ConflictError
      && JSON.stringify(error.details).includes("video_not_accepted"),
  );
});

test("partial=true 先交付已就绪镜头并明确列出缺口", async () => {
  const shots = [
    { id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: "video-1" },
    { id: "shot-2", shotCode: "G02", sortOrder: 2, selectedImageResultId: null, selectedVideoResultId: "video-2" },
    { id: "shot-3", shotCode: "G03", sortOrder: 3, selectedImageResultId: null, selectedVideoResultId: null },
  ];
  const repository = new FakeDeliveryRepository(sourceOf(pending, shots, [
    media(),
    media({ mediaId: "video-2", shotId: "shot-2", shotCode: "G02", shotSortOrder: 2, reviewStatus: "needs_review" }),
  ]));
  const service = new DeliveryService(repository);

  const manifest = await service.getManifest("user-1", "episode-1", { partial: true });
  assert.equal(manifest.partial, true);
  assert.deepEqual(manifest.items.map((item) => item.shotCode), ["G01"]);
  assert.deepEqual(
    manifest.gaps.map((gap) => [gap.shotCode, gap.reason]),
    [["G02", "video_not_accepted"], ["G03", "missing_video_primary"]],
  );

  const playback = await service.getPlayback("user-1", "episode-1", { partial: true });
  assert.deepEqual(playback.playback.map((item) => item.shotCode), ["G01"]);

  await assert.rejects(
    service.getManifest("user-1", "episode-1"),
    (error: unknown) => error instanceof ConflictError && error.code === "deliverable_not_ready",
  );
});

test("部分交付但全集未就绪时 playback 给出补齐指引", async () => {
  const service = new DeliveryService(new FakeDeliveryRepository(sourceOf(
    pending,
    [{ id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: "video-1" }],
    [media({ reviewStatus: "needs_review" })],
  )));
  await assert.rejects(
    service.getPlayback("user-1", "episode-1", { partial: true }),
    (error: unknown) => error instanceof ConflictError
      && error.code === "deliverable_not_ready"
      && error.message.includes("没有可交付的素材")
      && JSON.stringify(error.details).includes("G01"),
  );
});

test("交付记录:同一集两次交付两行,清单 hash 一致;partial 记录缺口镜号", async () => {
  const repository = new FakeDeliveryRepository(sourceOf(
    automatic,
    [{ id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: "video-1" }],
    [media({ reviewStatus: "needs_review" })],
  ));
  const service = new DeliveryService(repository);
  const first = await service.createDeliveryRecord("user-1", "episode-1", { purpose: "送审样片" });
  const second = await service.createDeliveryRecord("user-1", "episode-1", {});
  assert.equal(repository.inserted.length, 2);
  assert.equal(first.manifestHash, second.manifestHash);
  assert.equal(first.manifestHash.length, 64);
  assert.deepEqual(first.mediaResultIds, ["video-1"]);
  assert.equal(first.partial, false);
  assert.equal(first.purpose, "送审样片");

  const partialRepository = new FakeDeliveryRepository(sourceOf(
    pending,
    [
      { id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: "video-1" },
      { id: "shot-2", shotCode: "G02", sortOrder: 2, selectedImageResultId: null, selectedVideoResultId: "video-2" },
    ],
    [media(), media({ mediaId: "video-2", shotId: "shot-2", shotCode: "G02", shotSortOrder: 2, reviewStatus: "needs_review" })],
  ));
  const partialService = new DeliveryService(partialRepository);
  const partialRecord = await partialService.createDeliveryRecord("user-1", "episode-1", { partial: true });
  assert.equal(partialRecord.partial, true);
  assert.deepEqual(partialRecord.missingShotCodes, ["G02"]);
  assert.deepEqual(partialRecord.mediaResultIds, ["video-1"]);

  // 默认(非 partial)门禁拦截时不落任何记录
  await assert.rejects(partialService.createDeliveryRecord("user-1", "episode-1", {}));
  assert.equal(partialRepository.inserted.length, 1);
});
