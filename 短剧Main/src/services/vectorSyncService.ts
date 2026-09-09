import { createHash } from "node:crypto";
import { settings } from "../config/env.js";
import type { AssetEntityData, AssetVariantData } from "../domain/assets/types.js";
import { buildAssetVectorId } from "../domain/assets/vectorKeys.js";
import type { EmbeddingClient } from "../integrations/embeddingClient.js";
import { DoubaoEmbeddingClient } from "../integrations/embeddingClient.js";
import { MilvusVectorStore } from "../integrations/milvusVectorStore.js";
import { optionalText, textValue } from "../shared/values.js";

const EMPTY_TEXT_VALUES = new Set(["", "-", "--", "/", "暂无", "暂无信息", "未填", "未知", "不详", "空", "none", "null", "n/a"]);

export interface VectorSyncDependencies {
  embedding?: EmbeddingClient;
  store?: MilvusVectorStore;
}

export interface AssetMediaVisualData {
  id: string;
  assetEntityId: string;
  mediaKind: string;
  sha256: string | null;
  storageUrl: string | null;
}

export class VectorSyncService {
  private readonly embedding: EmbeddingClient;
  private readonly store: MilvusVectorStore;

  constructor(dependencies: VectorSyncDependencies = {}) {
    this.embedding = dependencies.embedding ?? new DoubaoEmbeddingClient();
    this.store = dependencies.store ?? new MilvusVectorStore();
  }

  async syncEntity(entity: AssetEntityData): Promise<void> {
    await this.syncEntityWithText(entity, buildEntityVectorText(entity));
  }

  async syncEntityWithText(entity: AssetEntityData, rawText: string): Promise<void> {
    const text = textValue(rawText).trim();
    if (!text || !entity.id) return;
    const vector = await this.embedding.embedText(text);
    await this.store.upsert(buildAssetVectorId("asset_entities", entity.id, "full"), vector, text, {
      source_table: "asset_entities",
      source_id: entity.id,
      facet: "full",
      asset_kind: entity.assetKind,
      source_project_id: entity.sourceProjectId ?? null,
      source_project_name: entity.sourceProjectName ?? null,
      name: entity.name,
      display_name: entity.displayName ?? null,
      gender: normalizeGender(entity.gender),
      approval_state: approvalState(entity.approved),
      status: entity.status ?? "",
      text_hash: hashVectorText(text),
      embedding_model: settings.doubaoEmbeddingModel ?? "",
    });
  }

  async syncVariant(variant: AssetVariantData, parent: AssetEntityData): Promise<void> {
    const text = buildVariantVectorText(variant, parent);
    if (!text || !variant.id) return;
    const vector = await this.embedding.embedText(text);
    await this.store.upsert(buildAssetVectorId("asset_variants", variant.id, "full"), vector, text, {
      source_table: "asset_variants",
      source_id: variant.id,
      facet: "full",
      asset_kind: parent.assetKind,
      source_project_id: parent.sourceProjectId ?? null,
      source_project_name: parent.sourceProjectName ?? null,
      name: variant.name,
      parent_entity_id: parent.id ?? "",
      parent_entity_name: parent.name,
      gender: normalizeGender(parent.gender),
      approval_state: approvalState(variant.approved ?? parent.approved),
      status: variant.status ?? parent.status ?? "",
      text_hash: hashVectorText(text),
      embedding_model: settings.doubaoEmbeddingModel ?? "",
    });
  }

  async syncMediaVisual(
    media: AssetMediaVisualData,
    parent: AssetEntityData,
    imageContent: Buffer,
    imageContentType: string | null,
  ): Promise<void> {
    if (!media.id) return;
    const vector = await this.embedding.embedImage(imageContent, imageContentType);
    const caption = buildEntityVectorText(parent);
    await this.store.upsert(
      buildAssetVectorId("asset_media", media.id, "visual"),
      vector,
      caption,
      {
        source_table: "asset_media",
        source_id: media.id,
        facet: "visual",
        entity_id: media.assetEntityId,
        sha256: media.sha256 ?? "",
        media_kind: media.mediaKind,
        storage_url: media.storageUrl ?? "",
        asset_kind: parent.assetKind,
        source_project_id: parent.sourceProjectId ?? null,
        source_project_name: parent.sourceProjectName ?? null,
        name: parent.name,
        display_name: parent.displayName ?? null,
        gender: normalizeGender(parent.gender),
        approval_state: approvalState(parent.approved),
        status: parent.status ?? "",
        text_hash: hashVectorText(caption),
        embedding_model: settings.doubaoEmbeddingModel ?? "",
      },
    );
  }
}

export function buildEntityVectorText(entity: AssetEntityData): string {
  const lines: string[] = [];
  const name = cleanVectorText(entity.name);
  const displayName = cleanVectorText(entity.displayName);
  if (name && displayName && name !== displayName) lines.push(`${name}（${displayName}）`);
  else if (name || displayName) lines.push(name || displayName);

  for (const [label, value] of [
    ["", entity.intro],
    ["外观", entity.appearance],
    ["发型长相", entity.hairDescription],
    ["服装", entity.outfitDescription],
  ] as const) {
    const cleaned = cleanVectorText(value);
    if (cleaned) lines.push(label ? `${label}：${cleaned}` : cleaned);
  }
  if (entity.styleTags?.length) {
    const tags = entity.styleTags.map(cleanVectorText).filter(Boolean).join("、");
    if (tags) lines.push(`风格：${tags}`);
  }
  const attrs = [
    entity.gender && !isEmptyish(entity.gender) ? `性别${entity.gender}` : "",
    entity.ageValue !== null && entity.ageValue !== undefined ? `年龄${entity.ageValue}岁` : "",
    entity.heightCm !== null && entity.heightCm !== undefined ? `身高${entity.heightCm}cm` : "",
  ].filter(Boolean);
  if (attrs.length) lines.push(attrs.join(" "));
  return lines.join("\n");
}

export function buildVariantVectorText(variant: AssetVariantData, parent: AssetEntityData): string {
  const lines = [
    cleanVectorText(variant.name),
    cleanVectorText(variant.description),
    optionalText(variant.visualPrompt) ? `视觉：${cleanVectorText(variant.visualPrompt)}` : "",
    optionalText(variant.usageContext) ? `使用场景：${cleanVectorText(variant.usageContext)}` : "",
    parent.name ? `这是${parent.name}的变体造型。` : "",
    cleanVectorText(parent.intro),
  ];
  return lines.filter(Boolean).join("\n");
}

function isEmptyish(value: unknown): boolean {
  return EMPTY_TEXT_VALUES.has(textValue(value).toLowerCase());
}

function cleanVectorText(value: unknown): string {
  const text = textValue(value).replace(/[；;。]+/g, " ").trim();
  return isEmptyish(text) ? "" : text;
}

function normalizeGender(value: unknown): string {
  const text = textValue(value);
  if (!text || isEmptyish(text)) return "";
  if (["男", "男性", "male", "m"].includes(text.toLowerCase())) return "男";
  if (["女", "女性", "female", "f"].includes(text.toLowerCase())) return "女";
  return text.slice(0, 16);
}

function approvalState(value: boolean | null | undefined): "approved" | "rejected" | "unknown" {
  return value === true ? "approved" : value === false ? "rejected" : "unknown";
}

function hashVectorText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
