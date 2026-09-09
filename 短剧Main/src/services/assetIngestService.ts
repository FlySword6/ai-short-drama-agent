import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type { Database } from "../db/client.js";
import type {
  AssetEntityData,
  AssetVariantData,
  ControlAssetRole,
  ControlAssetUsageMode,
  IngestedAssetResponse,
  JsonAssetInput,
  JsonObject,
  StoredImage,
} from "../domain/assets/types.js";
import type { AssetMediaRow, AssetSourceProjectRow } from "../db/schema.js";
import { TosStorage } from "../integrations/tosStorage.js";
import { DoubaoVisionClient } from "../integrations/visionClient.js";
import { AssetEntityRepository } from "../repositories/assetEntityRepository.js";
import { AssetMediaRepository } from "../repositories/assetMediaRepository.js";
import { AssetSourceProjectRepository } from "../repositories/assetSourceProjectRepository.js";
import { AssetVariantRepository } from "../repositories/assetVariantRepository.js";
import { BadRequestError } from "../shared/errors.js";
import { extensionOf, safePathPart } from "../shared/files.js";
import { TimingCollector } from "../shared/timing.js";
import { booleanValue, numberValue, optionalText, textValue } from "../shared/values.js";
import { mapConcurrent } from "../shared/concurrency.js";
import { ExcelAssetExtractor } from "./excelExtractor.js";
import { ExcelAssetParser, type ExcelAssetRow } from "./excelParser.js";
import { buildMediaInput } from "./assetMedia.js";
import { withAssetContractMetadata } from "./assetContract.js";
import { detectAssetVariant } from "./assetVariantDetector.js";
import { ExcelImageUploadService, chooseRowPrimaryIndex } from "./excelImageUploadService.js";
import { VectorSyncService } from "./vectorSyncService.js";

const EXCEL_INGEST_CONCURRENCY = 4;
const EXCEL_IMAGE_UPLOAD_CONCURRENCY = 8;
const EXCEL_VECTOR_SYNC_CONCURRENCY = 3;
const EXCEL_VISUAL_VECTOR_CONCURRENCY = 4;
const VISUAL_VECTOR_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_ALLOWED_KINDS = new Set([
  "character",
  "animal",
  "scene",
  "prop",
  "costume",
  "lighting",
  "camera",
  "video",
  "sound",
  "music",
  "voice",
  "reference",
  "keyword",
  "model_3d",
  "other",
]);
const IMAGE_LEGACY_KIND_MAP = new Map<string, string>([
  ["lighting_ref", "lighting"],
  ["cinematography_ref", "camera"],
  ["video_ref", "video"],
  ["sound_ref", "sound"],
  ["music_ref", "music"],
  ["clothing", "costume"],
]);

class ConcurrencyPool {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

interface ExcelRowIngestContext {
  row: ExcelAssetRow;
  entity: AssetEntityData;
  variant?: AssetVariantData;
  mediaEntityId: string;
  mediaAsset: AssetEntityData;
  images: StoredImage[];
  mediaRows: AssetMediaRow[];
}

export interface JsonIngestRequest {
  ownerUserId: string;
  visibility?: "personal" | "common";
  sourceProjectId?: string | null;
  sourceProjectName?: string | null;
  assets: JsonAssetInput[];
}

export interface UploadContext {
  ownerUserId: string;
  visibility?: "personal" | "common";
  fileName: string;
  content: Buffer;
  contentType: string | null;
  sourceProjectName?: string | null;
  batchSize: number;
  assetKindHint?: string | null;
  role?: ControlAssetRole | null;
  usageMode?: ControlAssetUsageMode | null;
}

export interface IngestServiceDependencies {
  entityRepository?: AssetEntityRepository;
  variantRepository?: AssetVariantRepository;
  mediaRepository?: AssetMediaRepository;
  projectRepository?: AssetSourceProjectRepository;
  vectorSync?: VectorSyncService;
  tos?: TosStorage;
  vision?: DoubaoVisionClient;
  excelParser?: ExcelAssetParser;
  excelExtractor?: ExcelAssetExtractor;
  excelImageUploader?: ExcelImageUploadService;
}

export class JsonAssetIngestService {
  private readonly entities: AssetEntityRepository;
  private readonly vectors: VectorSyncService;

  constructor(db: Database, dependencies: IngestServiceDependencies = {}) {
    this.entities = dependencies.entityRepository ?? new AssetEntityRepository(db);
    this.vectors = dependencies.vectorSync ?? new VectorSyncService();
  }

  async ingest(request: JsonIngestRequest): Promise<IngestedAssetResponse[]> {
    if (!request.assets.length) throw new BadRequestError("assets cannot be empty");
    const result: IngestedAssetResponse[] = [];
    for (const input of request.assets) {
      // 审核是「进通用库」的闸门,不是「上传」的闸门:个人资产上传完即可用
      const isPersonal = (request.visibility ?? "personal") !== "common";
      const status = isPersonal ? "approved" : input.status;
      const asset: AssetEntityData = withAssetContractMetadata({
        sourceProjectId: request.sourceProjectId ?? null,
        sourceProjectName: request.sourceProjectName ?? null,
        ownerUserId: request.ownerUserId,
        visibility: request.visibility ?? "personal",
        assetKind: input.assetKind,
        ...(input.role !== undefined ? { role: input.role } : {}),
        ...(input.usageMode !== undefined ? { usageMode: input.usageMode } : {}),
        name: input.name,
        displayName: input.displayName ?? input.name,
        intro: input.intro ?? null,
        appearance: input.appearance ?? null,
        ageValue: input.ageValue ?? null,
        gender: input.gender ?? null,
        heightCm: input.heightCm ?? null,
        hairDescription: input.hairDescription ?? null,
        outfitDescription: input.outfitDescription ?? null,
        category: input.category ?? null,
        styleTags: input.styleTags,
        approved: isPersonal ? true : (input.approved ?? null),
        reuseScope: input.reuseScope,
        status,
        sourceFileUrl: input.sourceFileUrl ?? null,
        metadata: input.metadata,
      }, {
        sourceKind: "unknown",
        sourceFileStub: request.sourceProjectName ?? "json_asset_ingest",
        confidenceScore: 1,
        reviewState: status,
        publicStorageState: "quarantined",
        extractionMethod: "json_asset_ingest",
      });
      const saved = await this.entities.save(asset);
      const normalized = this.entities.toData(saved);
      await this.vectors.syncEntity(normalized);
      result.push(serializeEntity(normalized));
    }
    return result;
  }
}

export class ExcelAssetIngestService {
  private readonly projects: AssetSourceProjectRepository;
  private readonly entities: AssetEntityRepository;
  private readonly variants: AssetVariantRepository;
  private readonly media: AssetMediaRepository;
  private readonly vectors: VectorSyncService;
  private readonly tos: TosStorage;
  private readonly parser: ExcelAssetParser;
  private readonly extractor: ExcelAssetExtractor;
  private readonly imageUploader: ExcelImageUploadService;

  constructor(db: Database, dependencies: IngestServiceDependencies = {}) {
    this.projects = dependencies.projectRepository ?? new AssetSourceProjectRepository(db);
    this.entities = dependencies.entityRepository ?? new AssetEntityRepository(db);
    this.variants = dependencies.variantRepository ?? new AssetVariantRepository(db);
    this.media = dependencies.mediaRepository ?? new AssetMediaRepository(db);
    this.vectors = dependencies.vectorSync ?? new VectorSyncService();
    this.tos = dependencies.tos ?? new TosStorage();
    this.parser = dependencies.excelParser ?? new ExcelAssetParser();
    this.extractor = dependencies.excelExtractor ?? new ExcelAssetExtractor();
    this.imageUploader = dependencies.excelImageUploader ?? new ExcelImageUploadService(this.tos);
  }

  async ingest(context: UploadContext): Promise<IngestedAssetResponse[]> {
    const timing = new TimingCollector();
    const projectName = context.sourceProjectName || extractProjectFromName(context.fileName);
    const projectStarted = performance.now();
    const project = await this.projects.getOrCreate({
      name: projectName,
      code: `excel_api_${createHash("md5").update(projectName).digest("hex").slice(0, 12)}`,
      description: context.fileName,
      projectType: "excel_upload",
      metadata: { ingest_api: "asset-ingest/upload", source_file_name: context.fileName },
    });
    timing.mark("excel_source_project_get_or_create", projectStarted);

    const parseStarted = performance.now();
    const rows = await this.parser.parse(context.content, context.fileName);
    timing.mark("excel_parse_workbook", parseStarted);
    const batches: ExcelAssetRow[][] = [];
    for (let offset = 0; offset < rows.length; offset += context.batchSize) {
      batches.push(rows.slice(offset, offset + context.batchSize));
    }
    const imageCount = rows.reduce((count, row) => count + row.images.length, 0);
    timing.set("excel_row_count", rows.length);
    timing.set("excel_batch_count", batches.length);
    timing.set("excel_batch_size", context.batchSize);
    timing.set("excel_embedded_image_count", imageCount);
    timing.set("excel_llm_concurrency", EXCEL_INGEST_CONCURRENCY);
    timing.set("excel_image_upload_concurrency", EXCEL_IMAGE_UPLOAD_CONCURRENCY);

    const extractStarted = performance.now();
    let extractedBatches: AssetEntityData[][];
    try {
      extractedBatches = await mapConcurrent(batches, EXCEL_INGEST_CONCURRENCY, async (batch) =>
        this.extractor.extractMany(batch, project.id, project.name ?? projectName, context.visibility ?? "personal"),
      );
    } catch (error) {
      timing.mark("excel_llm_extract_parallel_failed", extractStarted);
      timing.total("excel_service_failed_total");
      console.warn("[excel-ingest] failed during LLM extraction", timing.snapshot());
      throw error;
    }
    timing.mark("excel_llm_extract_parallel", extractStarted);

    const uploadPool = new ConcurrencyPool(EXCEL_IMAGE_UPLOAD_CONCURRENCY);
    const rowContexts: ExcelRowIngestContext[] = [];
    const rowUploadPromises: Array<Promise<void>> = [];

    const saveStarted = performance.now();
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex] ?? [];
      const assets = extractedBatches[batchIndex] ?? [];
      for (let index = 0; index < assets.length; index += 1) {
        const row = batch[index];
        const asset = assets[index];
        if (!row || !asset) continue;
        asset.ownerUserId = context.ownerUserId;
        asset.visibility = context.visibility ?? "personal";
        if (context.role !== undefined) asset.role = context.role;
        if (context.usageMode !== undefined) asset.usageMode = context.usageMode;
        const saved = await this.entities.save(asset);
        const entity = this.entities.toData(saved);
        const variant = await this.maybeSaveVariant(entity);
        const rowContext: ExcelRowIngestContext = {
          row,
          entity,
          variant,
          mediaEntityId: variant?.assetEntityId ?? entity.id ?? "",
          mediaAsset: variant ? { ...entity, assetKind: "character" } : entity,
          images: [],
          mediaRows: [],
        };
        rowContexts.push(rowContext);

        const primaryIndex = chooseRowPrimaryIndex(row.images);
        for (let imageIndex = 0; imageIndex < row.images.length; imageIndex += 1) {
          const image = row.images[imageIndex];
          rowUploadPromises.push(
            uploadPool
              .run(() => this.imageUploader.uploadSingle(row, entity, image, imageIndex, primaryIndex))
              .then((stored) => {
                if (stored) rowContext.images.push(stored);
              })
              .catch((error: unknown) => {
                console.warn(`[excel-ingest] image upload failed row=${row.rowNumber} image=${imageIndex}: ${error instanceof Error ? error.message : String(error)}`);
              }),
          );
        }
      }
    }
    timing.mark("excel_pg_save_entities_and_queue_images", saveStarted);

    const uploadStarted = performance.now();
    await Promise.all(rowUploadPromises);
    timing.mark("excel_tos_upload_images_parallel", uploadStarted);

    const mediaStarted = performance.now();
    const result: IngestedAssetResponse[] = [];
    for (const rowContext of rowContexts) {
      rowContext.images.sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
      let entity = rowContext.entity;
      rowContext.mediaRows = await this.writeRowMedia(entity, rowContext.mediaEntityId, rowContext.mediaAsset, rowContext.variant, rowContext.images);
      if (rowContext.variant) {
        rowContext.variant = await this.updateVariantFromEntity(rowContext.variant, entity);
        entity.metadata = {
          ...(entity.metadata ?? {}),
          variant_id: rowContext.variant.id ?? null,
          parent_entity_id: rowContext.variant.assetEntityId,
          variant_name: rowContext.variant.name,
        };
      }
      if (entity.sourceFileUrl || entity.metadata?.primary_image || rowContext.variant) {
        entity = withAssetContractMetadata(entity, {
          sourceKind: "excel_workbook",
          sourceFileStub: context.fileName,
          sourceSheetName: rowContext.row.sheetName,
          sourceRowNo: rowContext.row.rowNumber,
          sourceCellRef: `row:${rowContext.row.rowNumber}`,
          confidenceScore: 0,
          reviewState: entity.status,
          publicStorageState: "quarantined",
          extractionMethod: "llm_excel_asset_extractor",
        });
        entity = this.entities.toData(await this.entities.save(entity));
      }
      rowContext.entity = entity;
    }
    timing.mark("excel_pg_write_media_and_metadata", mediaStarted);

    const vectorStarted = performance.now();
    for (const rowContext of rowContexts) {
      const item = serializeEntity(rowContext.entity);
      item.metadata.vector_sync_status = "queued_background_task";
      result.push(item);
    }
    this.queueExcelVectorSync(rowContexts);
    timing.mark("excel_vector_sync_async_enqueue", vectorStarted);
    timing.set("excel_vector_sync_mode", "async_background");
    timing.set("excel_vector_sync_concurrency", EXCEL_VECTOR_SYNC_CONCURRENCY);
    timing.total("excel_service_total");
    const timingSnapshot = timing.snapshot();
    for (const item of result) {
      const current = item.metadata.ingest_timing_ms;
      const currentObject = typeof current === "object" && current !== null && !Array.isArray(current) ? current : {};
      item.metadata.ingest_timing_ms = { ...currentObject, ...timingSnapshot };
    }
    console.info("[excel-ingest] timing", timingSnapshot);
    return result;
  }

  private queueExcelVectorSync(rowContexts: ExcelRowIngestContext[]): void {
    const tasks = rowContexts.map((rowContext) => ({
      entity: rowContext.entity,
      variant: rowContext.variant,
      mediaRows: rowContext.mediaRows,
    }));
    if (!tasks.length) return;
    setImmediate(() => {
      void (async () => {
        let synced = 0;
        let failed = 0;
        const started = performance.now();
        await mapConcurrent(tasks, EXCEL_VECTOR_SYNC_CONCURRENCY, async ({ entity, variant, mediaRows }) => {
          try {
            await this.vectors.syncEntity(entity);
            if (variant) await this.vectors.syncVariant(variant, entity);
            const visualMedia = mediaRows.filter((m) => m.storagePath && m.mediaKind === "image");
            if (visualMedia.length) {
              await mapConcurrent(visualMedia, EXCEL_VISUAL_VECTOR_CONCURRENCY, async (mediaRow) => {
                try {
                  const buffer = await this.tos.readObjectBytes(mediaRow.storagePath!, { maxBytes: VISUAL_VECTOR_IMAGE_MAX_BYTES });
                  await this.vectors.syncMediaVisual(
                    {
                      id: mediaRow.id,
                      assetEntityId: mediaRow.assetEntityId ?? "",
                      mediaKind: mediaRow.mediaKind,
                      sha256: mediaRow.sha256,
                      storageUrl: mediaRow.storageUrl,
                    },
                    entity,
                    buffer,
                    null,
                  );
                } catch (error) {
                  console.error("[excel-visual-vector-sync] media item failed", {
                    media_id: mediaRow.id,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              });
            }
            synced += 1;
          } catch (error) {
            failed += 1;
            console.error("[excel-vector-sync] background item failed", {
              asset_id: entity.id ?? null,
              asset_name: entity.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
        console.info("[excel-vector-sync] background task completed", {
          total: tasks.length,
          synced,
          failed,
          duration_ms: Math.round((performance.now() - started) * 100) / 100,
        });
      })().catch((error: unknown) => {
        console.error("[excel-vector-sync] background task failed", error);
      });
    });
  }

  private async writeRowMedia(
    entity: AssetEntityData,
    mediaEntityId: string,
    mediaAsset: AssetEntityData,
    variant: AssetVariantData | undefined,
    images: StoredImage[],
  ): Promise<AssetMediaRow[]> {
    const createdMedia: AssetMediaRow[] = [];
    const metadata = entity.metadata ?? {};
    const primaryImages: JsonObject[] = [];
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      if (!image) continue;
      const storedImage = image;
      if (storedImage.isPrimary) {
        primaryImages.push({
          storage_bucket: storedImage.storageBucket ?? null,
          storage_path: storedImage.storagePath ?? null,
          storage_url: storedImage.storageUrl ?? null,
          width: storedImage.width ?? null,
          height: storedImage.height ?? null,
          format: storedImage.format ?? null,
          sha256: storedImage.sha256 ?? null,
          is_primary: true,
          sort_order: index,
        });
        entity.sourceFileUrl = storedImage.storageUrl;
      }
      const mediaRow = await this.media.create(buildMediaInput(mediaEntityId, mediaAsset, storedImage, variant?.id));
      createdMedia.push(mediaRow);
    }
    if (primaryImages.length) {
      metadata.primary_image = primaryImages[0] ?? null;
      entity.metadata = metadata;
    }
    return createdMedia;
  }

  private async maybeSaveVariant(entity: AssetEntityData) {
    const detected = detectAssetVariant(entity.assetKind, entity.name);
    if (!detected) return undefined;
    const parent = await this.entities.getByUniqueKey({
      sourceProjectId: entity.sourceProjectId,
      ownerUserId: entity.ownerUserId,
      assetKind: "character",
      name: detected.parentName,
    });
    if (!parent) return undefined;
    const personal = parent.visibility === "personal";
    const variant = await this.variants.save({
      assetEntityId: parent.id,
      variantKind: detected.variantKind,
      name: detected.variantName,
      description: entity.appearance,
      usageContext: entity.category,
      visualPrompt: entity.outfitDescription,
      sourceFileUrl: entity.sourceFileUrl ?? null,
      sourceText: entity.name,
      approved: personal ? true : null,
      status: personal ? "approved" : "pending_review",
      metadata: { source_entity_id: entity.id ?? null },
    });
    return this.variants.toData(variant);
  }

  private async updateVariantFromEntity(variant: AssetVariantData, entity: AssetEntityData): Promise<AssetVariantData> {
    // 只回填上传产物(sourceFileUrl/metadata),不传播 entity 的 approved/status:
    // 变体的审核态在创建时由「个人免审、公共待审」口径决定(76dce613),
    // 不允许被 Excel 行里自带的审核字段覆盖。
    const saved = await this.variants.save({
      ...variant,
      sourceFileUrl: entity.sourceFileUrl ?? variant.sourceFileUrl ?? null,
      metadata: {
        ...(variant.metadata ?? {}),
        source_entity_id: entity.id ?? variant.metadata?.source_entity_id ?? null,
      },
    });
    return this.variants.toData(saved);
  }
}

export class ImageAssetIngestService {
  private readonly projects: AssetSourceProjectRepository;
  private readonly entities: AssetEntityRepository;
  private readonly media: AssetMediaRepository;
  private readonly vectors: VectorSyncService;
  private readonly tos: TosStorage;
  private readonly vision: DoubaoVisionClient;
  private readonly projectPromises = new Map<string, Promise<AssetSourceProjectRow>>();

  constructor(db: Database, dependencies: IngestServiceDependencies = {}) {
    this.projects = dependencies.projectRepository ?? new AssetSourceProjectRepository(db);
    this.entities = dependencies.entityRepository ?? new AssetEntityRepository(db);
    this.media = dependencies.mediaRepository ?? new AssetMediaRepository(db);
    this.vectors = dependencies.vectorSync ?? new VectorSyncService();
    this.tos = dependencies.tos ?? new TosStorage();
    this.vision = dependencies.vision ?? new DoubaoVisionClient();
  }

  async ingest(context: UploadContext, syncVector = false): Promise<IngestedAssetResponse> {
    const extension = extensionOf(context.fileName);
    if (!context.content.length) throw new BadRequestError("Uploaded image is empty");
    const projectName = context.sourceProjectName || path.basename(context.fileName, extension);
    const project = await this.getOrCreateImageProject(projectName, context.fileName);
    const timing = new TimingCollector();
    const sha256 = createHash("sha256").update(context.content).digest("hex");
    const visionTiming: Record<string, number> = {};
    const raw = await this.vision.describeImage(context.content, context.contentType, {
      fileName: context.fileName,
      sourceProjectName: project.name ?? projectName,
      assetKindHint: context.assetKindHint,
    }, visionTiming);
    for (const [key, value] of Object.entries(visionTiming)) timing.set(key, value);
    const asset = normalizeVisionAsset(raw, context, sha256);
    asset.sourceProjectId = project.id;
    asset.sourceProjectName = project.name ?? projectName;
    asset.ownerUserId = context.ownerUserId;
    asset.visibility = context.visibility ?? "personal";
    if (context.role !== undefined) asset.role = context.role;
    if (context.usageMode !== undefined) asset.usageMode = context.usageMode;
    const storagePath = [
      "prod", "asset", safePathPart(project.name ?? projectName), safePathPart(asset.assetKind),
      safePathPart(asset.name), `${sha256.slice(0, 12)}_${safePathPart(path.parse(context.fileName).name)}${extension}`,
    ].join("/");
    const tosStarted = performance.now();
    const stored = await this.tos.uploadBytes(context.content, storagePath, context.contentType ?? "application/octet-stream");
    timing.mark("tos_upload", tosStarted);
    const info = await imageInfo(context.content);
    asset.sourceFileUrl = stored.storageUrl;
    asset.metadata = {
      ...(asset.metadata ?? {}),
      primary_image: {
        storage_bucket: stored.bucket,
        storage_path: stored.storagePath,
        storage_url: stored.storageUrl,
        sha256,
        width: info.width ?? null,
        height: info.height ?? null,
        format: info.format ?? extension.slice(1),
        is_primary: true,
        sort_order: 0,
      },
      source_file_name: context.fileName,
      content_type: context.contentType ?? "application/octet-stream",
      ingest_timing_ms: timing.snapshot(),
    };
    const contractAsset = withAssetContractMetadata(asset, {
      sourceKind: "image_folder",
      sourceFileStub: context.fileName,
      sourceFileSha256: sha256,
      confidenceScore: 0,
      reviewState: asset.status,
      publicStorageState: "quarantined",
      extractionMethod: "doubao_lite_image_upload_api",
    });
    const databaseStarted = performance.now();
    const saved = await this.entities.save(contractAsset);
    const entity = this.entities.toData(saved);
    const mediaRow = await this.media.create({
      assetEntityId: entity.id ?? "",
      // 文件的实际类型是事实:该链路只接受图片上传(路由层 isImage 校验),
      // media_kind 必须记为 "image";AI 对内容的理解(asset_kind)是推断,不能覆盖事实。
      mediaKind: "image",
      viewAngle: "unknown",
      title: entity.displayName ?? entity.name,
      description: entity.appearance ?? entity.intro,
      storageBucket: stored.bucket,
      storagePath: stored.storagePath,
      storageUrl: stored.storageUrl,
      widthPx: info.width ?? null,
      heightPx: info.height ?? null,
      format: info.format ?? extension.slice(1),
      sha256,
      isPrimary: true,
      approved: entity.approved,
      sortOrder: 100,
      metadata: { source_project_name: entity.sourceProjectName ?? null, source_file_name: context.fileName },
    });
    timing.mark("pg_write", databaseStarted);
    if (syncVector) {
      await this.vectors.syncEntity(entity);
      await this.vectors.syncMediaVisual(
        {
          id: mediaRow.id,
          assetEntityId: mediaRow.assetEntityId ?? "",
          mediaKind: mediaRow.mediaKind,
          sha256: mediaRow.sha256,
          storageUrl: mediaRow.storageUrl,
        },
        entity,
        context.content,
        context.contentType,
      );
    }
    timing.total("service_total_before_commit");
    entity.metadata = { ...(entity.metadata ?? {}), ingest_timing_ms: timing.snapshot() };
    const finalEntity = this.entities.toData(await this.entities.save(entity));
    return serializeEntity(finalEntity);
  }

  private async getOrCreateImageProject(projectName: string, fileName: string): Promise<AssetSourceProjectRow> {
    const key = projectName.trim();
    const existing = this.projectPromises.get(key);
    if (existing) return existing;
    const promise = this.projects.getOrCreate({
      name: projectName,
      code: `image_api_${createHash("md5").update(projectName).digest("hex").slice(0, 12)}`,
      description: fileName,
      projectType: "image_upload",
      metadata: { ingest_api: "asset-ingest/upload", source_file_name: fileName },
    });
    this.projectPromises.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      this.projectPromises.delete(key);
      throw error;
    }
  }
}

function normalizeVisionAsset(raw: Record<string, unknown>, context: UploadContext, sha256: string): AssetEntityData {
  const kindValue = optionalText(raw.asset_kind);
  const mappedKind = kindValue ? IMAGE_LEGACY_KIND_MAP.get(kindValue) ?? kindValue : null;
  const hintKind = context.assetKindHint ? IMAGE_LEGACY_KIND_MAP.get(context.assetKindHint) ?? context.assetKindHint : null;
  const kind = mappedKind && IMAGE_ALLOWED_KINDS.has(mappedKind)
    ? mappedKind
    : hintKind && IMAGE_ALLOWED_KINDS.has(hintKind)
      ? hintKind
      : "other";
  const name = optionalText(raw.name) ?? optionalText(raw.display_name) ?? path.parse(context.fileName).name;
  // 审核是「进通用库」的闸门,不是「上传」的闸门:个人资产上传完即可用
  const isPersonal = (context.visibility ?? "personal") !== "common";
  const legacyPersonType = optionalText(raw.person_type);
  const legacyAssetType = numberValue(raw.asset_type);
  const extractionConfidence = confidenceValue(raw.extraction_confidence);
  const missingFields = stringArray(raw.missing_fields);
  return {
    assetKind: kind,
    name,
    displayName: optionalText(raw.display_name) ?? name,
    intro: optionalText(raw.intro),
    appearance: optionalText(raw.appearance),
    ageValue: numberValue(raw.age_value),
    gender: optionalText(raw.gender),
    heightCm: numberValue(raw.height_cm),
    hairDescription: optionalText(raw.hair_description),
    outfitDescription: optionalText(raw.outfit_description),
    category: optionalText(raw.category),
    styleTags: Array.isArray(raw.style_tags) ? raw.style_tags.map(textValue).filter(Boolean) : [],
    approved: isPersonal ? true : booleanValue(raw.approved),
    reuseScope: "all_projects",
    status: isPersonal ? "approved" : "pending_review",
    sourceFileUrl: null,
    metadata: {
      extractor: "doubao_lite_image_upload_api",
      image_sha256: sha256,
      raw_vision_asset: JSON.parse(JSON.stringify(raw)) as JsonObject,
      ...(legacyPersonType ? { legacy_person_type: legacyPersonType } : {}),
      ...(legacyAssetType !== null ? { legacy_asset_type: legacyAssetType } : {}),
      ...(extractionConfidence !== null ? { extraction_confidence: extractionConfidence } : {}),
      ...(missingFields.length ? { missing_fields: missingFields } : {}),
    },
  };
}

function serializeEntity(entity: AssetEntityData): IngestedAssetResponse {
  return {
    id: entity.id ?? "",
    assetKind: entity.assetKind,
    role: entity.role ?? null,
    usageMode: entity.usageMode ?? null,
    name: entity.name,
    displayName: entity.displayName ?? null,
    sourceFileUrl: entity.sourceFileUrl ?? null,
    metadata: entity.metadata ?? {},
    source_project_id: entity.sourceProjectId ?? null,
    source_project_name: entity.sourceProjectName ?? null,
    asset_kind: entity.assetKind,
    display_name: entity.displayName ?? null,
    intro: entity.intro ?? null,
    appearance: entity.appearance ?? null,
    age_value: entity.ageValue ?? null,
    gender: entity.gender ?? null,
    height_cm: entity.heightCm ?? null,
    hair_description: entity.hairDescription ?? null,
    outfit_description: entity.outfitDescription ?? null,
    category: entity.category ?? null,
    style_tags: entity.styleTags ?? [],
    approved: entity.approved ?? null,
    reuse_scope: entity.reuseScope ?? null,
    status: entity.status ?? null,
    source_file_url: entity.sourceFileUrl ?? null,
  };
}

function confidenceValue(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.max(0, Math.min(1, parsed));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(textValue).filter(Boolean)
    : [];
}

function extractProjectFromName(fileName: string): string {
  const stem = path.basename(fileName, path.extname(fileName));
  const match = stem.match(/《(.+?)》/);
  return match?.[1]?.trim() || stem;
}

async function imageInfo(content: Buffer): Promise<{ width: number | null; height: number | null; format: string | null }> {
  try {
    const info = await sharp(content).metadata();
    return { width: info.width ?? null, height: info.height ?? null, format: info.format ?? null };
  } catch {
    return { width: null, height: null, format: null };
  }
}
