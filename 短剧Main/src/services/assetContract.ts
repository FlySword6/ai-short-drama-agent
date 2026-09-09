import type { AssetEntityData, JsonObject, JsonValue } from "../domain/assets/types.js";

export type IngestSourceKind = "excel_workbook" | "spreadsheet" | "image_folder" | "unknown";

export interface AssetContractInput {
  sourceKind: IngestSourceKind;
  sourceFileStub?: string | null;
  sourceFileSha256?: string | null;
  sourceSheetName?: string | null;
  sourceRowNo?: number | null;
  sourceCellRef?: string | null;
  confidenceScore?: number | null;
  reviewState?: string | null;
  publicStorageState?: string | null;
  extractionMethod?: string | null;
}

export function withAssetContractMetadata(asset: AssetEntityData, input: AssetContractInput): AssetEntityData {
  return {
    ...asset,
    metadata: normalizeAssetContractMetadata(asset, input),
  };
}

export function normalizeAssetContractMetadata(asset: AssetEntityData, input: AssetContractInput): JsonObject {
  const metadata = { ...(asset.metadata ?? {}) };
  const assetType = stringValue(metadata.asset_type) ?? assetTypeFor(asset);
  const assetSubtype = stringValue(metadata.asset_subtype) ?? assetSubtypeFor(asset);
  const reviewState = input.reviewState ?? stringValue(metadata.review_state) ?? asset.status ?? "pending_review";
  const sourceFileStub = input.sourceFileStub ?? stringValue(metadata.source_file_stub) ?? stringValue(metadata.source_file_name);
  const sourceFileSha256 = input.sourceFileSha256 ?? stringValue(metadata.source_file_sha256) ?? stringValue(metadata.image_sha256);
  const sourceKind = input.sourceKind;
  const ingestLocation = buildIngestLocation(input);

  metadata.asset_type = assetType;
  metadata.asset_subtype = assetSubtype;
  metadata.provenance = toJsonObject(metadata.provenance, {
    derived_from: sourceFileStub ? [{ ref_type: "source", ref_id: sourceFileStub }] : [],
  });
  metadata.license_state = stringValue(metadata.license_state) ?? "unknown";
  metadata.aigc_label = toJsonObject(metadata.aigc_label, {
    has_label: false,
    label_type: "",
    standard_ref: "pending_manual_review",
  });
  metadata.ingest = toJsonObject(metadata.ingest, {
    source_kind: sourceKind,
    source_file_stub: sourceFileStub ?? "",
    source_file_sha256: sourceFileSha256 ?? "",
    location: ingestLocation,
    confidence_score: clampConfidence(input.confidenceScore),
    review_state: reviewState,
    public_storage_state: input.publicStorageState ?? "quarantined",
    extraction_method: input.extractionMethod ?? stringValue(metadata.extractor) ?? "unknown",
  });

  metadata.source_kind = sourceKind;
  metadata.source_file_stub = sourceFileStub ?? "";
  metadata.source_file_sha256 = sourceFileSha256 ?? "";
  metadata.confidence_score = clampConfidence(input.confidenceScore);
  metadata.review_state = reviewState;
  metadata.public_storage_state = input.publicStorageState ?? "quarantined";

  return metadata;
}

function assetTypeFor(asset: AssetEntityData): string {
  if (asset.assetKind === "voice") return "audio";
  return asset.sourceFileUrl ? "image" : "reference";
}

function assetSubtypeFor(asset: AssetEntityData): string {
  const mapping: Record<string, string> = {
    character: "portrait",
    scene: "scene_concept",
    prop: "prop",
    clothing: "costume",
    voice: "voice_sample",
  };
  return mapping[asset.assetKind] ?? "reference_image";
}

function buildIngestLocation(input: AssetContractInput): JsonObject {
  const location: JsonObject = {};
  if (input.sourceSheetName) location.source_sheet_name = input.sourceSheetName;
  if (typeof input.sourceRowNo === "number") location.source_row_no = input.sourceRowNo;
  if (input.sourceCellRef) location.source_cell_ref = input.sourceCellRef;
  return location;
}

function clampConfidence(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toJsonObject(value: JsonValue | undefined, fallback: JsonObject): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...fallback, ...value } as JsonObject : fallback;
}
