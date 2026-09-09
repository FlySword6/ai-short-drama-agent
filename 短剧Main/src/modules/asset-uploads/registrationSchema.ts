import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { assetKindVocabulary } from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";

export const ASSET_REGISTRATION_SCHEMA_VERSION = "asset-registration-v1";
export const ASSET_FACTOR_DICTIONARY_VERSION = "asset-factor-v0.2";

const acceptedImageAssetKinds = new Set([
  "character",
  "scene",
  "prop",
  "costume",
  "lighting",
  "camera",
  "keyword",
  "animal",
  "reference",
]);

const factorsByAssetKind: Record<string, string[]> = {
  character: ["character_core", "identity_profile", "face_identity"],
  costume: ["costume"],
  scene: ["scene"],
  prop: ["prop"],
  lighting: ["lighting"],
  camera: ["camera"],
  keyword: ["reference"],
  reference: ["reference"],
  animal: ["animal"],
};

const factorNames: Record<string, string> = {
  character_core: "角色",
  identity_profile: "身份档案",
  face_identity: "面部身份",
  costume: "服装",
  scene: "场景",
  prop: "道具",
  lighting: "光线",
  camera: "摄影机",
  reference: "参考素材",
  animal: "动物角色",
};

export interface RegistrationFieldDefinition {
  id: string;
  displayName: string;
  valueType: "text" | "long_text" | "single_select" | "text_list";
  required: boolean;
  maxLength?: number;
  options?: string[];
  inputSource: "user";
}

const commonFields: RegistrationFieldDefinition[] = [
  { id: "name", displayName: "资产名称", valueType: "text", required: true, maxLength: 128, inputSource: "user" },
  { id: "description", displayName: "资产说明", valueType: "long_text", required: false, maxLength: 2000, inputSource: "user" },
];

const factorFields: Record<string, RegistrationFieldDefinition[]> = {
  character_core: [
    { id: "age_stage", displayName: "年龄阶段", valueType: "single_select", required: false, options: ["child", "teen", "adult", "older", "unknown"], inputSource: "user" },
    { id: "stable_feature_notes", displayName: "稳定辨识特征", valueType: "long_text", required: false, maxLength: 2000, inputSource: "user" },
  ],
  identity_profile: [
    { id: "age_stage", displayName: "年龄阶段", valueType: "single_select", required: false, options: ["child", "teen", "adult", "older", "unknown"], inputSource: "user" },
    { id: "stable_feature_notes", displayName: "稳定辨识特征", valueType: "long_text", required: false, maxLength: 2000, inputSource: "user" },
  ],
  face_identity: [
    { id: "view_type", displayName: "视角", valueType: "single_select", required: false, options: ["front", "three_quarter", "side", "other"], inputSource: "user" },
    { id: "stable_feature_notes", displayName: "稳定辨识特征", valueType: "long_text", required: false, maxLength: 2000, inputSource: "user" },
  ],
  costume: [
    { id: "category", displayName: "服装类别", valueType: "text", required: false, maxLength: 128, inputSource: "user" },
    { id: "layer", displayName: "穿着层级", valueType: "text", required: false, maxLength: 128, inputSource: "user" },
    { id: "dominant_colors", displayName: "主色", valueType: "text_list", required: false, inputSource: "user" },
    { id: "material", displayName: "材质", valueType: "text", required: false, maxLength: 128, inputSource: "user" },
    { id: "pattern", displayName: "纹样", valueType: "text", required: false, maxLength: 128, inputSource: "user" },
    { id: "silhouette", displayName: "轮廓", valueType: "text", required: false, maxLength: 128, inputSource: "user" },
  ],
  scene: [],
  prop: [],
  lighting: [],
  camera: [],
  reference: [],
  animal: [],
};

export const systemManagedRegistrationFields = [
  "version",
  "derivation_mode",
  "confidence_score",
  "review_state",
  "rights_status",
  "source_fragment_id",
  "status",
  "evidence_level",
  "reasoning_mode",
] as const;

const rightsDeclarationSchema = z.object({
  source_kind: z.enum(["self_created", "licensed", "public_domain", "unknown"]),
  contains_real_person: z.boolean(),
  reference_use_confirmed: z.boolean(),
}).strict();

const registrationInputSchema = z.object({
  schema_version: z.string(),
  dictionary_version: z.string(),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2000).nullable().optional(),
  asset_kind: z.string().trim().min(1).max(32),
  factor_type: z.string().trim().min(1).max(64),
  tags: z.array(z.string().trim().min(1).max(64)).max(30).default([]),
  factor_attributes: z.record(z.string(), z.unknown()).default({}),
  rights_declaration: rightsDeclarationSchema,
}).strict();

export interface AssetRegistrationForm {
  schemaVersion: string;
  dictionaryVersion: string;
  name: string;
  description: string | null;
  assetKind: string;
  factorType: string;
  tags: string[];
  factorAttributes: Record<string, string | string[]>;
  rightsDeclaration: {
    sourceKind: "self_created" | "licensed" | "public_domain" | "unknown";
    containsRealPerson: boolean;
    referenceUseConfirmed: true;
  };
}

export interface AssetKindVocabularyPort {
  listActive(): Promise<Array<{ id: string; canonicalId: string; displayName: string; sort: number }>>;
}

class DrizzleAssetKindVocabularyRepository implements AssetKindVocabularyPort {
  constructor(private readonly db: Database) {}

  listActive() {
    return this.db.select({
      id: assetKindVocabulary.id,
      canonicalId: assetKindVocabulary.canonicalId,
      displayName: assetKindVocabulary.displayName,
      sort: assetKindVocabulary.sort,
    }).from(assetKindVocabulary).where(eq(assetKindVocabulary.active, true))
      .orderBy(assetKindVocabulary.sort, assetKindVocabulary.id);
  }
}

export class AssetRegistrationSchemaService {
  private readonly vocabulary: AssetKindVocabularyPort;

  constructor(db: Database, vocabulary?: AssetKindVocabularyPort) {
    this.vocabulary = vocabulary ?? new DrizzleAssetKindVocabularyRepository(db);
  }

  async getSchema(assetKind?: string | null, factorType?: string | null) {
    const vocabulary = await this.vocabulary.listActive();
    const canonicalRows = vocabulary.filter((row) => row.id === row.canonicalId && acceptedImageAssetKinds.has(row.id));
    const resolvedAssetKind = assetKind
      ? this.resolveAssetKind(assetKind, vocabulary)
      : null;
    const selectedFactor = factorType?.trim() || null;
    if (selectedFactor) this.assertFactorType(resolvedAssetKind, selectedFactor);

    return {
      schemaVersion: ASSET_REGISTRATION_SCHEMA_VERSION,
      dictionaryVersion: ASSET_FACTOR_DICTIONARY_VERSION,
      acceptedMediaKinds: ["image"] as const,
      assetKinds: canonicalRows.map((row) => ({
        id: row.id,
        displayName: row.displayName,
        factorTypes: (factorsByAssetKind[row.id] ?? []).map((id) => ({
          id,
          displayName: factorNames[id] ?? id,
        })),
      })),
      fields: [
        ...commonFields,
        ...(selectedFactor ? (factorFields[selectedFactor] ?? []) : []),
      ],
      systemManagedFields: [...systemManagedRegistrationFields],
      defaults: {
        visibility: "personal",
        status: "approved",
        clearance: {
          search: true,
          genReference: true,
          commercialPublish: false,
          modelTraining: false,
        },
      },
    };
  }

  async validate(input: unknown): Promise<AssetRegistrationForm> {
    const parsed = registrationInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new AppError(400, "registration_schema_mismatch", "登记字段已更新，请刷新页面后重新提交");
    }
    if (
      parsed.data.schema_version !== ASSET_REGISTRATION_SCHEMA_VERSION
      || parsed.data.dictionary_version !== ASSET_FACTOR_DICTIONARY_VERSION
    ) {
      throw new AppError(400, "registration_schema_mismatch", "登记字段已更新，请刷新页面后重新提交");
    }
    if (!parsed.data.rights_declaration.reference_use_confirmed) {
      throw new AppError(400, "rights_confirmation_required", "请先确认你有权上传并将该图片用于创作参考");
    }

    const vocabulary = await this.vocabulary.listActive();
    const assetKind = this.resolveAssetKind(parsed.data.asset_kind, vocabulary);
    this.assertFactorType(assetKind, parsed.data.factor_type);
    const attributes = validateFactorAttributes(parsed.data.factor_type, parsed.data.factor_attributes);

    return {
      schemaVersion: parsed.data.schema_version,
      dictionaryVersion: parsed.data.dictionary_version,
      name: parsed.data.name,
      description: parsed.data.description || null,
      assetKind,
      factorType: parsed.data.factor_type,
      tags: [...new Set(parsed.data.tags)],
      factorAttributes: attributes,
      rightsDeclaration: {
        sourceKind: parsed.data.rights_declaration.source_kind,
        containsRealPerson: parsed.data.rights_declaration.contains_real_person,
        referenceUseConfirmed: true,
      },
    };
  }

  private resolveAssetKind(
    requested: string,
    rows: Array<{ id: string; canonicalId: string }>,
  ): string {
    const row = rows.find((candidate) => candidate.id === requested.trim());
    if (!row || !acceptedImageAssetKinds.has(row.canonicalId)) {
      throw new AppError(400, "unsupported_asset_media", "当前只支持登记图片资产");
    }
    return row.canonicalId;
  }

  private assertFactorType(assetKind: string | null, factorType: string): void {
    if (!assetKind || !(factorsByAssetKind[assetKind] ?? []).includes(factorType)) {
      throw new AppError(400, "registration_schema_mismatch", "登记字段已更新，请刷新页面后重新提交");
    }
  }
}

function validateFactorAttributes(
  factorType: string,
  input: Record<string, unknown>,
): Record<string, string | string[]> {
  const fields = factorFields[factorType] ?? [];
  const allowed = new Map(fields.map((field) => [field.id, field]));
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = allowed.get(key);
    if (!field) {
      throw new AppError(400, "unknown_factor_field", "这项资产信息当前不支持，请刷新表单后重试");
    }
    if (field.valueType === "text_list") {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
        throw new AppError(400, "registration_schema_mismatch", "登记字段已更新，请刷新页面后重新提交");
      }
      result[key] = value.map((entry) => entry.trim()).slice(0, 20);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new AppError(400, "registration_schema_mismatch", "登记字段已更新，请刷新页面后重新提交");
    }
    if (field.options && !field.options.includes(value)) {
      throw new AppError(400, "registration_schema_mismatch", "登记字段已更新，请刷新页面后重新提交");
    }
    if (field.maxLength && [...value].length > field.maxLength) {
      throw new AppError(400, "registration_schema_mismatch", "登记字段已更新，请刷新页面后重新提交");
    }
    result[key] = value.trim();
  }
  return result;
}

export function registrationFormSnapshot(form: AssetRegistrationForm): Record<string, unknown> {
  return {
    schema_version: form.schemaVersion,
    dictionary_version: form.dictionaryVersion,
    name: form.name,
    description: form.description,
    asset_kind: form.assetKind,
    factor_type: form.factorType,
    tags: form.tags,
    factor_attributes: form.factorAttributes,
    rights_declaration: {
      source_kind: form.rightsDeclaration.sourceKind,
      contains_real_person: form.rightsDeclaration.containsRealPerson,
      reference_use_confirmed: true,
    },
  };
}

export function parseRegistrationFormSnapshot(input: Record<string, unknown> | null): AssetRegistrationForm | null {
  if (!input) return null;
  const parsed = registrationInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.rights_declaration.reference_use_confirmed !== true) return null;
  return {
    schemaVersion: parsed.data.schema_version,
    dictionaryVersion: parsed.data.dictionary_version,
    name: parsed.data.name,
    description: parsed.data.description || null,
    assetKind: parsed.data.asset_kind,
    factorType: parsed.data.factor_type,
    tags: parsed.data.tags,
    factorAttributes: parsed.data.factor_attributes as Record<string, string | string[]>,
    rightsDeclaration: {
      sourceKind: parsed.data.rights_declaration.source_kind,
      containsRealPerson: parsed.data.rights_declaration.contains_real_person,
      referenceUseConfirmed: true,
    },
  };
}
