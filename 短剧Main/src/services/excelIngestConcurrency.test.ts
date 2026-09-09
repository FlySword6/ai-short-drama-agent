import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../db/client.js";
import type { AssetEntityRow, AssetMediaRow, AssetVariantRow } from "../db/schema.js";
import type { AssetEntityData, AssetVariantData } from "../domain/assets/types.js";
import type { AssetEntityRepository } from "../repositories/assetEntityRepository.js";
import type { AssetMediaInput, AssetMediaRepository } from "../repositories/assetMediaRepository.js";
import type { AssetSourceProjectRepository } from "../repositories/assetSourceProjectRepository.js";
import type { AssetVariantRepository } from "../repositories/assetVariantRepository.js";
import { ExcelAssetIngestService } from "./assetIngestService.js";
import type { ExcelAssetExtractor } from "./excelExtractor.js";
import type { ExcelImageUploadService } from "./excelImageUploadService.js";
import type { ExcelAssetParser, ExcelAssetRow } from "./excelParser.js";
import type { VectorSyncService } from "./vectorSyncService.js";

const ownerUserId = "11111111-1111-4111-8111-111111111111";

test("Excel ingest runs extraction concurrently while saving rows in source order", async () => {
  const rows = [2, 3, 4, 5].map((rowNumber): ExcelAssetRow => ({
    sheetName: "roles",
    sourceFileName: "assets.xlsx",
    rowNumber,
    fields: { name: `asset-${rowNumber}` },
    images: [],
  }));
  const saveOrder: string[] = [];
  let activeExtractions = 0;
  let maxActiveExtractions = 0;

  const service = new ExcelAssetIngestService({} as Database, {
    projectRepository: {
      getOrCreate: async () => ({ id: "project-1", name: "test-project" }),
    } as unknown as AssetSourceProjectRepository,
    entityRepository: {
      save: async (asset: AssetEntityData) => {
        saveOrder.push(asset.name);
        return { ...asset, id: asset.id ?? `entity-${saveOrder.length}` } as unknown as AssetEntityRow;
      },
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
      getByUniqueKey: async () => undefined,
    } as unknown as AssetEntityRepository,
    variantRepository: {
      save: async () => {
        throw new Error("variant save should not run in this test");
      },
    } as unknown as AssetVariantRepository,
    mediaRepository: {
      create: async (input: AssetMediaInput) => input as unknown as AssetMediaRow,
    } as unknown as AssetMediaRepository,
    vectorSync: {
      syncEntity: async () => undefined,
      syncVariant: async () => undefined,
    } as unknown as VectorSyncService,
    excelParser: {
      parse: async () => rows,
    } as unknown as ExcelAssetParser,
    excelExtractor: {
      extractMany: async (batch: ExcelAssetRow[]) => {
        activeExtractions += 1;
        maxActiveExtractions = Math.max(maxActiveExtractions, activeExtractions);
        try {
          if (batch[0]?.rowNumber === 2) await delay(25);
          return batch.map((row) => ({
            sourceProjectId: "project-1",
            sourceProjectName: "test-project",
            assetKind: "character",
            name: `asset-${row.rowNumber}`,
            displayName: `asset-${row.rowNumber}`,
            styleTags: [],
            approved: true,
            reuseScope: "all_projects",
            status: "approved",
            metadata: {},
          }));
        } finally {
          activeExtractions -= 1;
        }
      },
    } as unknown as ExcelAssetExtractor,
  });

  const items = await service.ingest({
    ownerUserId,
    visibility: "personal",
    fileName: "assets.xlsx",
    content: Buffer.from("fake-xlsx"),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    batchSize: 1,
  });

  assert.ok(maxActiveExtractions > 1);
  assert.deepEqual(saveOrder, ["asset-2", "asset-3", "asset-4", "asset-5"]);
  assert.deepEqual(items.map((item) => item.name), saveOrder);
});

test("Excel ingest creates source project with stable excel_api code", async () => {
  const rows: ExcelAssetRow[] = [{
    sheetName: "roles",
    sourceFileName: "assets.xlsx",
    rowNumber: 2,
    fields: { name: "asset-2" },
    images: [],
  }];
  let capturedCode: string | null | undefined;

  const service = new ExcelAssetIngestService({} as Database, {
    projectRepository: {
      getOrCreate: async (input: { name: string; code?: string | null }) => {
        capturedCode = input.code;
        return { id: "project-1", name: input.name, code: input.code ?? null };
      },
    } as unknown as AssetSourceProjectRepository,
    entityRepository: {
      save: async (asset: AssetEntityData) => ({ ...asset, id: asset.id ?? "entity-1" }) as unknown as AssetEntityRow,
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
      getByUniqueKey: async () => undefined,
    } as unknown as AssetEntityRepository,
    variantRepository: {
      save: async () => {
        throw new Error("variant save should not run in this test");
      },
    } as unknown as AssetVariantRepository,
    mediaRepository: {
      create: async (input: AssetMediaInput) => input as unknown as AssetMediaRow,
    } as unknown as AssetMediaRepository,
    vectorSync: {
      syncEntity: async () => undefined,
      syncVariant: async () => undefined,
    } as unknown as VectorSyncService,
    excelParser: {
      parse: async () => rows,
    } as unknown as ExcelAssetParser,
    excelExtractor: {
      extractMany: async () => [{
        sourceProjectId: "project-1",
        sourceProjectName: "测试时间",
        assetKind: "character",
        name: "asset-2",
        styleTags: [],
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        metadata: {},
      }],
    } as unknown as ExcelAssetExtractor,
  });

  await service.ingest({
    ownerUserId,
    visibility: "personal",
    sourceProjectName: "测试时间",
    fileName: "assets.xlsx",
    content: Buffer.from("fake-xlsx"),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    batchSize: 1,
  });

  assert.equal(capturedCode, "excel_api_44ca3630dfc0");
});

test("Excel ingest queues vector sync in background without blocking the response", async () => {
  const rows: ExcelAssetRow[] = [{
    sheetName: "roles",
    sourceFileName: "assets.xlsx",
    rowNumber: 2,
    fields: { name: "asset-2" },
    images: [],
  }];
  let vectorStarted = false;
  let releaseVector!: () => void;
  let notifyVectorStarted!: () => void;
  const vectorStartedSignal = new Promise<void>((resolve) => {
    notifyVectorStarted = resolve;
  });
  const vectorBlocker = new Promise<void>((resolve) => {
    releaseVector = resolve;
  });

  const service = new ExcelAssetIngestService({} as Database, {
    projectRepository: {
      getOrCreate: async () => ({ id: "project-1", name: "test-project" }),
    } as unknown as AssetSourceProjectRepository,
    entityRepository: {
      save: async (asset: AssetEntityData) => ({ ...asset, id: asset.id ?? "entity-1" }) as unknown as AssetEntityRow,
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
      getByUniqueKey: async () => undefined,
    } as unknown as AssetEntityRepository,
    variantRepository: {
      save: async () => {
        throw new Error("variant save should not run in this test");
      },
    } as unknown as AssetVariantRepository,
    mediaRepository: {
      create: async (input: AssetMediaInput) => input as unknown as AssetMediaRow,
    } as unknown as AssetMediaRepository,
    vectorSync: {
      syncEntity: async () => {
        vectorStarted = true;
        notifyVectorStarted();
        await vectorBlocker;
      },
      syncVariant: async () => undefined,
    } as unknown as VectorSyncService,
    excelParser: {
      parse: async () => rows,
    } as unknown as ExcelAssetParser,
    excelExtractor: {
      extractMany: async (batch: ExcelAssetRow[]) => batch.map((row) => ({
        sourceProjectId: "project-1",
        sourceProjectName: "test-project",
        assetKind: "character",
        name: `asset-${row.rowNumber}`,
        displayName: `asset-${row.rowNumber}`,
        styleTags: [],
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        metadata: {},
      })),
    } as unknown as ExcelAssetExtractor,
  });

  const items = await service.ingest({
    ownerUserId,
    visibility: "personal",
    fileName: "assets.xlsx",
    content: Buffer.from("fake-xlsx"),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    batchSize: 1,
  });

  assert.equal(vectorStarted, false);
  assert.equal(items[0]?.metadata.vector_sync_status, "queued_background_task");

  await vectorStartedSignal;
  assert.equal(vectorStarted, true);
  releaseVector();
  await delay(0);
});

test("Excel ingest writes variant approval state and primary image url", async () => {
  const rows: ExcelAssetRow[] = [
    {
      sheetName: "roles",
      sourceFileName: "assets.xlsx",
      rowNumber: 2,
      fields: { name: "叶萧遥" },
      images: [],
    },
    {
      sheetName: "roles",
      sourceFileName: "assets.xlsx",
      rowNumber: 3,
      fields: { name: "叶萧遥天尊版" },
      images: [{
        buffer: Buffer.from("fake-image"),
        fileName: "roles-3.png",
        contentType: "image/png",
        extension: ".png",
        sheetName: "roles",
        row: 3,
        col: 5,
        columnHeader: "人设图定稿",
        imageIndex: 0,
      }],
    },
  ];
  const savedEntities = new Map<string, AssetEntityData>();
  const variantSaves: Array<{ approved?: boolean | null; status?: string; sourceFileUrl?: string | null }> = [];

  const service = new ExcelAssetIngestService({} as Database, {
    projectRepository: {
      getOrCreate: async () => ({ id: "project-1", name: "test-project" }),
    } as unknown as AssetSourceProjectRepository,
    entityRepository: {
      save: async (asset: AssetEntityData) => {
        const row = { ...asset, id: asset.id ?? `entity-${savedEntities.size + 1}` };
        savedEntities.set(row.name, row);
        return row as unknown as AssetEntityRow;
      },
      toData: (row: AssetEntityRow) => row as unknown as AssetEntityData,
      getByUniqueKey: async (input: { name: string }) => savedEntities.get(input.name) as unknown as AssetEntityRow | undefined,
    } as unknown as AssetEntityRepository,
    variantRepository: {
      save: async (variant: AssetVariantData) => {
        variantSaves.push({
          approved: variant.approved,
          status: variant.status,
          sourceFileUrl: variant.sourceFileUrl,
        });
        return { ...variant, id: variant.id ?? "variant-1" } as unknown as AssetVariantRow;
      },
      toData: (row: AssetVariantRow) => row as unknown as AssetVariantData,
    } as unknown as AssetVariantRepository,
    mediaRepository: {
      create: async (input: AssetMediaInput) => input as unknown as AssetMediaRow,
    } as unknown as AssetMediaRepository,
    vectorSync: {
      syncEntity: async () => undefined,
      syncVariant: async () => undefined,
    } as unknown as VectorSyncService,
    excelParser: {
      parse: async () => rows,
    } as unknown as ExcelAssetParser,
    excelExtractor: {
      extractMany: async (batch: ExcelAssetRow[]) => batch.map((row) => ({
        sourceProjectId: "project-1",
        sourceProjectName: "test-project",
        assetKind: "character",
        name: row.fields.name ?? "",
        displayName: row.fields.name ?? "",
        appearance: row.rowNumber === 3 ? "黑色中分刘海高" : "主角本体",
        outfitDescription: row.rowNumber === 3 ? "蓝白色古风服饰" : null,
        category: "人物角色",
        styleTags: [],
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        metadata: {},
      })),
    } as unknown as ExcelAssetExtractor,
    excelImageUploader: {
      uploadSingle: async () => ({
        fileName: "roles-3.png",
        contentType: "image/png",
        extension: ".png",
        sheetName: "roles",
        row: 3,
        col: 5,
        columnHeader: "人设图定稿",
        imageIndex: 0,
        storageBucket: "test-bucket",
        storagePath: "asset/roles-3.png",
        storageUrl: "https://tos.example/asset/roles-3.png",
        width: 800,
        height: 1200,
        format: "png",
        sha256: "abc",
        isPrimary: true,
        sortOrder: 0,
      }),
    } as unknown as ExcelImageUploadService,
  });

  await service.ingest({
    ownerUserId,
    visibility: "personal",
    fileName: "assets.xlsx",
    content: Buffer.from("fake-xlsx"),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    batchSize: 1,
  });

  assert.equal(variantSaves[0]?.approved, true);
  assert.equal(variantSaves[0]?.status, "approved");
  assert.equal(variantSaves[0]?.sourceFileUrl, null);
  assert.equal(variantSaves[1]?.approved, true);
  assert.equal(variantSaves[1]?.status, "approved");
  assert.equal(variantSaves[1]?.sourceFileUrl, "https://tos.example/asset/roles-3.png");
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
