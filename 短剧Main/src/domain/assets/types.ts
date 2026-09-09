export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type AssetKind =
  | "character"
  | "scene"
  | "prop"
  | "clothing"
  | "voice"
  | "other";

export type ControlAssetRole =
  | "character_identity"
  | "scene"
  | "prop"
  | "motion"
  | "camera_storyboard"
  | "style_env";

export type ControlAssetUsageMode = "reference" | "first_frame" | "last_frame";

export interface AssetEntityData {
  id?: string;
  sourceProjectId?: string | null;
  sourceProjectName?: string | null;
  ownerUserId?: string | null;
  visibility?: "personal" | "common";
  assetKind: AssetKind | string;
  role?: ControlAssetRole | null;
  usageMode?: ControlAssetUsageMode | null;
  name: string;
  displayName?: string | null;
  intro?: string | null;
  appearance?: string | null;
  ageValue?: number | null;
  gender?: string | null;
  heightCm?: number | null;
  hairDescription?: string | null;
  outfitDescription?: string | null;
  category?: string | null;
  styleTags?: string[];
  approved?: boolean | null;
  reuseScope?: string;
  status?: string;
  sourceFileUrl?: string | null;
  metadata?: JsonObject;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  useCount?: number;
  deletedAt?: Date | null;
  deletedByUserId?: string | null;
}

export interface AssetVariantData {
  id?: string;
  assetEntityId: string;
  variantKind: string;
  name: string;
  description?: string | null;
  usageContext?: string | null;
  visualPrompt?: string | null;
  approved?: boolean | null;
  status?: string;
  isPrimary?: boolean;
  sortOrder?: number;
  sourceFileUrl?: string | null;
  sourceText?: string | null;
  metadata?: JsonObject;
}

export interface UploadedImage {
  buffer: Buffer;
  fileName: string;
  contentType: string | null;
  extension: string;
  sheetName?: string;
  row?: number;
  col?: number;
  columnHeader?: string;
  imageIndex?: number;
  isPrimary?: boolean;
  sortOrder?: number;
}

export interface StoredImage extends Omit<UploadedImage, "buffer"> {
  storageBucket?: string | null;
  storagePath?: string | null;
  storageUrl?: string | null;
  width?: number | null;
  height?: number | null;
  format?: string | null;
  sha256?: string | null;
}

export interface AssetSearchItem {
  score: number | null;
  lexicalHit?: boolean;
  semanticHit?: boolean;
  sourceTable: string;
  sourceId: string;
  scope?: "personal" | "common" | string;
  status?: string | null;
  assetKind?: string | null;
  name?: string | null;
  displayName?: string | null;
  parentEntityId?: string | null;
  parentEntityName?: string | null;
  intro?: string | null;
  appearance?: string | null;
  description?: string | null;
  usageContext?: string | null;
  visualPrompt?: string | null;
  sourceFileUrl?: string | null;
  metadata: JsonObject;
  vectorText?: string | null;
}

export interface TimingMetadata {
  ingestTimingMs?: JsonObject;
  vectorSyncStatus?: string;
}

export interface IngestedAssetResponse {
  [key: string]: JsonValue | undefined;
  id: string;
  assetKind: string;
  name: string;
  displayName?: string | null;
  sourceFileUrl?: string | null;
  metadata: JsonObject;
  role?: ControlAssetRole | null;
  usageMode?: ControlAssetUsageMode | null;
}

export interface JsonAssetInput {
  assetKind: string;
  role?: ControlAssetRole | null;
  usageMode?: ControlAssetUsageMode | null;
  name: string;
  displayName?: string | null;
  intro?: string | null;
  appearance?: string | null;
  ageValue?: number | null;
  gender?: string | null;
  heightCm?: number | null;
  hairDescription?: string | null;
  outfitDescription?: string | null;
  category?: string | null;
  styleTags: string[];
  approved?: boolean | null;
  reuseScope: string;
  status: string;
  sourceFileUrl?: string | null;
  metadata: JsonObject;
}
