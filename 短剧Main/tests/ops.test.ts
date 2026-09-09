import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "../src/db/client.js";
import { DashboardService } from "../src/modules/dashboard/service.js";
import {
  COST_LEDGER_NOTICE,
  ESTIMATED_COST_NOTICE,
  type DashboardRepository,
} from "../src/modules/dashboard/repository.js";
import { DeliveryService } from "../src/modules/delivery/service.js";
import type {
  DeliveryRepository,
  EpisodeDeliverySource,
} from "../src/modules/delivery/repository.js";
import type { GatedDeliverableMedia } from "../src/modules/delivery/manifest.js";
import { ConflictError } from "../src/shared/errors.js";
import { registerDeliveryRoutes } from "../src/modules/delivery/routes.js";
import { registerTrashRoutes } from "../src/modules/trash/routes.js";

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
    storageUrl: "https://storage.example/video-1.mp4",
    storagePath: "projects/project-1/video-1.mp4",
    mimeType: "video/mp4",
    durationSeconds: 3,
    generationRequestId: "request-1",
    generationAttemptId: "attempt-1",
    provider: "ark",
    model: "seedance",
    parameters: {},
    estimatedCostFen: 123,
    originKind: "generation",
    sourceAssetMediaId: null,
    reviewStatus: "accepted",
    ...overrides,
  };
}

function deliveryRepository(source: EpisodeDeliverySource): DeliveryRepository {
  return {
    loadEpisode: async () => source,
    getDownload: async (_actorId, mediaId) => ({
      mediaId,
      storageUrl: `https://storage.example/${mediaId}`,
      storagePath: mediaId,
      mimeType: "video/mp4",
    }),
    insertDeliveryRecord: async (_actor, input) => ({
      id: "record-1",
      projectId: source.projectId,
      episodeId: input.episodeId,
      manifestHash: input.manifestHash,
      mediaResultIds: input.mediaResultIds,
      partial: input.partial,
      missingShotCodes: input.missingShotCodes,
      purpose: input.purpose,
      deliveredByUserId: "user-1",
      createdAt: new Date("2026-07-24T00:00:00.000Z"),
    }),
    listDeliveryRecords: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
  };
}

test("交付清单按分镜顺序生成连播内容", async () => {
  const first = media();
  const second = media({
    shotId: "shot-2",
    shotCode: "G02",
    shotSortOrder: 2,
    mediaId: "video-2",
    generationRequestId: "request-2",
    generationAttemptId: "attempt-2",
    estimatedCostFen: 200,
  });
  const service = new DeliveryService(deliveryRepository({
    projectId: "project-1",
    projectName: "测试短剧",
    episodeId: "episode-1",
    episodeNo: 1,
    reviewStrategies: { image: "automatic", video: "automatic" },
    shots: [
      { id: "shot-2", shotCode: "G02", sortOrder: 2, selectedImageResultId: null, selectedVideoResultId: "video-2" },
      { id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: "video-1" },
    ],
    media: [second, first],
  }));

  const result = await service.getPlayback("user-1", "episode-1");
  assert.deepEqual(result.playback.map((item) => item.shotCode), ["G01", "G02"]);
  assert.equal(result.estimatedCostFen, 323);
  assert.equal(result.estimatedCostNotice, ESTIMATED_COST_NOTICE);
});

test("分镜缺少成功的视频主版本时阻止交付", async () => {
  const service = new DeliveryService(deliveryRepository({
    projectId: "project-1",
    projectName: "测试短剧",
    episodeId: "episode-1",
    episodeNo: 1,
    reviewStrategies: { image: "automatic", video: "automatic" },
    shots: [{ id: "shot-1", shotCode: "G01", sortOrder: 1, selectedImageResultId: null, selectedVideoResultId: null }],
    media: [],
  }));

  await assert.rejects(
    service.getManifest("user-1", "episode-1"),
    (error: unknown) => error instanceof ConflictError
      && error.code === "deliverable_not_ready"
      && error.message === "这集暂时不能交付：有分镜还没选定通过审核的视频，补齐后再试。"
      && JSON.stringify(error.details).includes("G01"),
  );
});

test("看板同时返回真实数据计数和成本账本积分", async () => {
  const now = new Date("2026-07-14T12:00:00.000Z");
  const repository: DashboardRepository = {
    getDataCounts: async () => ({
      projects: 1,
      assets: 2,
      episodes: 1,
      shots: 3,
      images: 2,
      videos: 1,
      succeeded: 1,
      failed: 1,
    }),
    listCostRows: async () => [
      {
        projectId: "project-1",
        projectName: "测试短剧",
        userId: "user-1",
        userName: "制作同事",
        kind: "generation",
        chargedPoints: 100,
        isUnpriced: false,
        createdAt: now,
      },
      {
        projectId: "project-1",
        projectName: "测试短剧",
        userId: "user-1",
        userName: "制作同事",
        kind: "generation",
        chargedPoints: 250,
        isUnpriced: false,
        createdAt: now,
      },
    ],
    getProjectCosts: async () => ({
      projectId: "project-1",
      projectName: "测试短剧",
      notice: COST_LEDGER_NOTICE,
      estimatedCostFen: 350,
      actualCostFen: null,
      summary: {
        totals: {
          tasks: 0,
          imageEstimatedCostFen: null,
          videoEstimatedCostFen: null,
          otherEstimatedCostFen: null,
          totalEstimatedCostFen: 0,
          actualCostFen: null,
          chargedPoints: 0,
          unpricedCount: 0,
        },
        byUser: [],
        byDate: [],
        byEpisode: [],
        byModel: [],
        compatibilityGaps: [],
      },
      entries: [],
    }),
    listUnitPrices: async () => [],
    replaceUnitPrice: async () => { throw new Error("not used"); },
  };
  const result = await new DashboardService(repository).getSummary("user-1");
  assert.equal(result.data.shots, 3);
  assert.equal(result.costs.totalEstimatedCostFen, 350);
  assert.equal(result.costs.notice, COST_LEDGER_NOTICE);
  assert.equal(result.costs.failedTasks, null);
});

test("交付和回收站使用冻结的 API 路径", async () => {
  const app = Fastify({ logger: false });
  const database = {} as Database;
  await registerDeliveryRoutes(app, () => database);
  await registerTrashRoutes(app, () => database);
  try {
    assert.equal(app.hasRoute({ method: "GET", url: "/api/v1/episodes/:episode_id/deliverables" }), true);
    assert.equal(app.hasRoute({ method: "GET", url: "/api/v1/episodes/:episode_id/deliverables.csv" }), true);
    assert.equal(app.hasRoute({ method: "DELETE", url: "/api/v1/trash/:kind/:id" }), true);
    assert.equal(app.hasRoute({ method: "GET", url: "/api/v1/episodes/:episode_id/deliverable" }), false);
    assert.equal(app.hasRoute({ method: "DELETE", url: "/api/v1/trash/:kind/:id/permanent" }), false);
  } finally {
    await app.close();
  }
});
