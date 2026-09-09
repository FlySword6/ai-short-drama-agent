import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../db/client.js";
import type { AssetEntityRow, AssetMediaRow } from "../db/schema.js";
import type { AssetEntityData } from "../domain/assets/types.js";
import type { AssetEntityRepository } from "../repositories/assetEntityRepository.js";
import type { AssetMediaInput, AssetMediaRepository } from "../repositories/assetMediaRepository.js";
import type { AssetSourceProjectRepository } from "../repositories/assetSourceProjectRepository.js";
import type { ArkChatClient } from "../integrations/arkClient.js";
import type { DoubaoVisionClient } from "../integrations/visionClient.js";
import type { TosStorage } from "../integrations/tosStorage.js";
import type { VectorSyncService } from "./vectorSyncService.js";
import { ImageAssetIngestService, JsonAssetIngestService } from "./assetIngestService.js";
import { ExcelAssetExtractor } from "./excelExtractor.js";
import type { ExcelAssetRow } from "./excelParser.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";

function buildImageIngestService(
  captured: { mediaInput?: AssetMediaInput; savedEntity?: AssetEntityData },
  visionAsset: Record<string, unknown> = {
    asset_kind: "other",
    name: "音频配置面板截图",
    style_tags: ["音频配置面板", "工具界面"],
  },
) {
  return new ImageAssetIngestService({} as Database, {
    projectRepository: {
      getOrCreate: async (input: { name: string }) => ({ id: "project-1", name: input.name }),
    } as unknown as AssetSourceProjectRepository,
    entityRepository: {
      save: async (asset: AssetEntityData) => {
        captured.savedEntity = asset;
        return asset as unknown as AssetEntityRow;
      },
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
    } as unknown as AssetEntityRepository,
    mediaRepository: {
      create: async (input: AssetMediaInput) => {
        captured.mediaInput = input;
        return input as unknown as AssetMediaRow;
      },
    } as unknown as AssetMediaRepository,
    vectorSync: { syncEntity: async () => undefined } as unknown as VectorSyncService,
    tos: {
      uploadBytes: async (_content: Buffer, storagePath: string) => ({
        bucket: "test-bucket",
        storagePath,
        storageUrl: `https://tos.example/${storagePath}`,
      }),
    } as unknown as TosStorage,
    vision: {
      // 复刻 DC 现场:AI 把一张 PNG 截图理解成 other,并打上内容标签
      describeImage: async () => visionAsset,
    } as unknown as DoubaoVisionClient,
  });
}

function imageUpload(visibility?: "personal" | "common") {
  return {
    ownerUserId,
    visibility,
    fileName: "panel.png",
    content: Buffer.from("fake-png-bytes"),
    contentType: "image/png",
    batchSize: 1,
  };
}

test("图片上传:media_kind 记文件事实 image,不被 AI 推断的 asset_kind 带偏", async () => {
  const captured: { mediaInput?: AssetMediaInput; savedEntity?: AssetEntityData } = {};
  const result = await buildImageIngestService(captured).ingest(imageUpload());

  // 文件就是图片:media_kind 必须是 "image",前端 primaryImageVersion 才找得到
  assert.equal(captured.mediaInput?.mediaKind, "image");
  // AI 对内容的理解仍作为推断保留在 asset_kind 上,不被改写
  assert.equal(captured.savedEntity?.assetKind, "other");
  assert.equal(result.assetKind, "other");
});

test("图片上传:兼容当前 asset_kind 词表,旧字段保留到 metadata", async () => {
  const captured: { mediaInput?: AssetMediaInput; savedEntity?: AssetEntityData } = {};
  const result = await buildImageIngestService(captured, {
    asset_kind: "lighting_ref",
    name: "冷蓝光影参考",
    display_name: "冷蓝色科幻光影参考",
    person_type: "其他",
    asset_type: 1,
    extraction_confidence: 0.79,
    missing_fields: ["age_value", "gender"],
  }).ingest(imageUpload());

  assert.equal(captured.savedEntity?.assetKind, "lighting");
  assert.equal(result.assetKind, "lighting");
  assert.equal(captured.savedEntity?.metadata?.legacy_person_type, "其他");
  assert.equal(captured.savedEntity?.metadata?.legacy_asset_type, 1);
  assert.equal(captured.savedEntity?.metadata?.extraction_confidence, 0.79);
  assert.deepEqual(captured.savedEntity?.metadata?.missing_fields, ["age_value", "gender"]);
});

test("图片批量入库:同一批并发图片复用同一个来源项目", async () => {
  let projectGetOrCreateCount = 0;
  const service = new ImageAssetIngestService({} as Database, {
    projectRepository: {
      getOrCreate: async (input: { name: string }) => {
        projectGetOrCreateCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { id: "project-1", name: input.name };
      },
    } as unknown as AssetSourceProjectRepository,
    entityRepository: {
      save: async (asset: AssetEntityData) => ({ ...asset, id: asset.id ?? crypto.randomUUID() }) as unknown as AssetEntityRow,
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
    } as unknown as AssetEntityRepository,
    mediaRepository: {
      create: async (input: AssetMediaInput) => input as unknown as AssetMediaRow,
    } as unknown as AssetMediaRepository,
    vectorSync: { syncEntity: async () => undefined } as unknown as VectorSyncService,
    tos: {
      uploadBytes: async (_content: Buffer, storagePath: string) => ({
        bucket: "test-bucket",
        storagePath,
        storageUrl: `https://tos.example/${storagePath}`,
      }),
    } as unknown as TosStorage,
    vision: {
      describeImage: async () => ({
        asset_kind: "scene",
        name: "太空环带场景",
        display_name: "太空环带场景参考",
      }),
    } as unknown as DoubaoVisionClient,
  });

  await Promise.all(["a.png", "b.png", "c.png"].map((fileName) => service.ingest({
    ...imageUpload(),
    fileName,
    sourceProjectName: "文件夹测试456",
  })));

  assert.equal(projectGetOrCreateCount, 1);
});

test("图片上传:个人资产不过审核闸,上传完即可用(approved)", async () => {
  const captured: { mediaInput?: AssetMediaInput; savedEntity?: AssetEntityData } = {};
  const result = await buildImageIngestService(captured).ingest(imageUpload("personal"));

  assert.equal(captured.savedEntity?.status, "approved");
  assert.equal(captured.savedEntity?.approved, true);
  assert.equal(result.status, "approved");
  assert.equal(captured.savedEntity?.metadata?.review_state, "approved");
});

test("图片上传:进通用库仍过审核闸(pending_review),闸门语义不变", async () => {
  const captured: { mediaInput?: AssetMediaInput; savedEntity?: AssetEntityData } = {};
  const result = await buildImageIngestService(captured).ingest(imageUpload("common"));

  assert.equal(captured.savedEntity?.status, "pending_review");
  assert.equal(result.status, "pending_review");
});

test("JSON 入库:个人资产强制 approved,无视调用方传入的 pending_review", async () => {
  let saved: AssetEntityData | undefined;
  const service = new JsonAssetIngestService({} as Database, {
    entityRepository: {
      save: async (asset: AssetEntityData) => {
        saved = asset;
        return asset as unknown as AssetEntityRow;
      },
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
    } as unknown as AssetEntityRepository,
    vectorSync: { syncEntity: async () => undefined } as unknown as VectorSyncService,
  });

  const items = await service.ingest({
    ownerUserId,
    visibility: "personal",
    assets: [{
      assetKind: "other",
      name: "动作参考",
      styleTags: [],
      reuseScope: "needs_review",
      status: "pending_review",
      metadata: {},
    }],
  });

  assert.equal(saved?.status, "approved");
  assert.equal(saved?.approved, true);
  assert.equal(saved?.metadata?.review_state, "approved");
  assert.equal(items[0]?.status, "approved");
});

test("JSON 入库:通用可见性保留调用方状态,审核闸不动", async () => {
  let saved: AssetEntityData | undefined;
  const service = new JsonAssetIngestService({} as Database, {
    entityRepository: {
      save: async (asset: AssetEntityData) => {
        saved = asset;
        return asset as unknown as AssetEntityRow;
      },
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
    } as unknown as AssetEntityRepository,
    vectorSync: { syncEntity: async () => undefined } as unknown as VectorSyncService,
  });

  await service.ingest({
    ownerUserId,
    visibility: "common",
    assets: [{
      assetKind: "character",
      name: "通用角色",
      styleTags: [],
      reuseScope: "all_projects",
      status: "pending_review",
      metadata: {},
    }],
  });

  assert.equal(saved?.status, "pending_review");
  assert.equal(saved?.approved, null);
});

function excelRow(): ExcelAssetRow {
  return {
    sheetName: "角色表",
    sourceFileName: "《测试剧》资产表.xlsx",
    rowNumber: 2,
    fields: { 姓名: "李承瑶" },
    images: [],
  };
}

function excelExtractorReturning(payload: unknown) {
  const llm = { completeText: async () => JSON.stringify(payload) } as unknown as ArkChatClient;
  return new ExcelAssetExtractor(llm);
}

function excelExtractorCapturingPrompt(captured: { prompt?: string }, payload: unknown) {
  const llm = {
    completeText: async (prompt: string) => {
      captured.prompt = prompt;
      return JSON.stringify(payload);
    },
  } as unknown as ArkChatClient;
  return new ExcelAssetExtractor(llm);
}

test("Excel 抽取:个人资产不过审核闸,状态与 review_state 同为 approved", async () => {
  const extractor = excelExtractorReturning([
    { row_key: "角色表:2", asset_kind: "character", name: "李承瑶" },
  ]);
  const [asset] = await extractor.extractMany([excelRow()], null, "《测试剧》", "personal");

  assert.equal(asset?.status, "approved");
  assert.equal(asset?.approved, true);
  assert.equal(asset?.metadata?.review_state, "approved");
});

test("Excel 抽取:进通用库仍过审核闸(pending_review)", async () => {
  const extractor = excelExtractorReturning([
    { row_key: "角色表:2", asset_kind: "character", name: "李承瑶" },
  ]);
  const [asset] = await extractor.extractMany([excelRow()], null, "《测试剧》", "common");

  assert.equal(asset?.status, "pending_review");
  assert.equal(asset?.metadata?.review_state, "pending_review");
});

test("Excel 抽取:提示词兼容旧项目字段,并把图片锚点传给模型", async () => {
  const row: ExcelAssetRow = {
    ...excelRow(),
    fields: { 姓名: "叶萧遥天尊版", 描述: "白衣剑修,仙侠主角,冷峻" },
    images: [{
      buffer: Buffer.from("fake-image"),
      fileName: "角色表-0.png",
      contentType: "image/png",
      extension: ".png",
      sheetName: "角色表",
      row: 2,
      col: 5,
      columnHeader: "人设图/三视图",
      imageIndex: 0,
    }],
  };
  const captured: { prompt?: string } = {};
  const extractor = excelExtractorCapturingPrompt(captured, [
    {
      row_key: "角色表:2",
      asset_kind: "character",
      name: "叶萧遥天尊版",
      display_name: "叶萧遥天尊版",
      intro: "仙侠主角人设",
      appearance: "白衣剑修",
      age_value: null,
      gender: "男",
      height_cm: null,
      hair_description: null,
      outfit_description: "白衣",
      category: "人物角色",
      style_tags: ["仙侠", "剑修"],
      person_type: "亚洲人种",
      asset_type: 1,
    },
  ]);

  await extractor.extractMany([row], null, "《测试剧》", "personal");

  assert.match(captured.prompt ?? "", /app\.asset_entities/);
  assert.match(captured.prompt ?? "", /asset_kind 只能是 character \/ animal \/ scene \/ prop \/ costume/);
  assert.match(captured.prompt ?? "", /输出字段必须包含：row_key, asset_kind, name, display_name, intro, appearance/);
  assert.match(captured.prompt ?? "", /person_type/);
  assert.match(captured.prompt ?? "", /asset_type/);
  assert.match(captured.prompt ?? "", /image_hints/);
  assert.match(captured.prompt ?? "", /人设图\/三视图/);
});

test("Excel 抽取:旧项目 asset_kind 别名映射到当前资产类型,旧字段保留到 metadata", async () => {
  const rows: ExcelAssetRow[] = [
    excelRow(),
    { ...excelRow(), rowNumber: 3, fields: { 名称: "冷光参考" } },
  ];
  const extractor = excelExtractorReturning([
    {
      row_key: "角色表:2",
      asset_kind: "clothing",
      name: "玄色战损服",
      person_type: "亚洲人种",
      asset_type: 2,
    },
    {
      row_key: "角色表:3",
      asset_kind: "lighting_ref",
      name: "冷光参考",
    },
  ]);

  const assets = await extractor.extractMany(rows, null, "《测试剧》", "personal");

  assert.equal(assets[0]?.assetKind, "costume");
  assert.equal(assets[0]?.metadata?.legacy_person_type, "亚洲人种");
  assert.equal(assets[0]?.metadata?.legacy_asset_type, 2);
  assert.equal(assets[1]?.assetKind, "lighting");
});
