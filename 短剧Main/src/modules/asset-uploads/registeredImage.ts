import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetTags,
  assetUploadTasks,
  mediaProvenanceSubjects,
  tagVocabulary,
} from "../../db/schema.js";
import { TosStorage, type StoredObject } from "../../integrations/tosStorage.js";
import { DoubaoVisionClient } from "../../integrations/visionClient.js";
import { BadRequestError } from "../../shared/errors.js";
import { safeFileName } from "../../shared/files.js";
import { buildAssetMediaStoragePath, inspectUploadedImage, type UploadedImageInfo } from "../assets/mediaUpload.js";
import type { AssetRegistrationForm } from "./registrationSchema.js";

export interface RegisteredImageInput {
  taskId: string;
  actorId: string;
  fileName: string;
  declaredContentType: string | null;
  content: Buffer;
  form: AssetRegistrationForm;
}

export interface RegisteredImageResult {
  assetId: string;
  mediaId: string;
  name: string;
}

export interface RegistrationVisionPort {
  describeImage(
    content: Buffer,
    contentType: string | null,
    context: { fileName: string; sourceProjectName: string; assetKindHint?: string | null },
    timing: Record<string, number>,
  ): Promise<Record<string, unknown>>;
}

export interface RegistrationStoragePort {
  uploadBytes(content: Buffer, storagePath: string, contentType: string): Promise<StoredObject>;
  deleteObject(storagePath: string): Promise<void>;
}

export interface RegisteredImagePersistenceInput {
  taskId: string;
  actorId: string;
  assetId: string;
  mediaId: string;
  fileName: string;
  declaredContentType: string | null;
  contentSha256: string;
  image: UploadedImageInfo;
  stored: StoredObject;
  form: AssetRegistrationForm;
  inferred: Record<string, unknown>;
}

export interface RegisteredImageRepositoryPort {
  persist(input: RegisteredImagePersistenceInput): Promise<RegisteredImageResult>;
}

export interface RegisteredImageDependencies {
  repository?: RegisteredImageRepositoryPort;
  storage?: RegistrationStoragePort;
  vision?: RegistrationVisionPort;
  inspectImage?: (content: Buffer) => Promise<UploadedImageInfo>;
  createId?: () => string;
}

/**
 * Registration-mode strategy for the existing asset upload task. It does not
 * own a second queue or a second API: the old worker selects this strategy only
 * when the accepted task carries a versioned registration_form snapshot.
 */
export class RegisteredImageAssetService {
  private readonly repository: RegisteredImageRepositoryPort;
  private readonly storage: RegistrationStoragePort;
  private readonly vision: RegistrationVisionPort;
  private readonly inspectImage: (content: Buffer) => Promise<UploadedImageInfo>;
  private readonly createId: () => string;

  constructor(db: Database, dependencies: RegisteredImageDependencies = {}) {
    this.repository = dependencies.repository ?? new DrizzleRegisteredImageRepository(db);
    this.storage = dependencies.storage ?? new TosStorage();
    this.vision = dependencies.vision ?? new DoubaoVisionClient();
    this.inspectImage = dependencies.inspectImage ?? inspectUploadedImage;
    this.createId = dependencies.createId ?? randomUUID;
  }

  async ingest(input: RegisteredImageInput): Promise<RegisteredImageResult> {
    if (!input.content.length) throw new BadRequestError("上传图片不能为空");
    const image = await this.inspectImage(input.content);
    const contentSha256 = createHash("sha256").update(input.content).digest("hex");
    const inferred = await this.vision.describeImage(input.content, input.declaredContentType, {
      fileName: input.fileName,
      sourceProjectName: "用户资产登记",
      assetKindHint: input.form.assetKind,
    }, {});
    const assetId = this.createId();
    const mediaId = this.createId();
    const storagePath = buildAssetMediaStoragePath(
      assetId,
      mediaId,
      contentSha256,
      image.extension,
    );
    const stored = await this.storage.uploadBytes(input.content, storagePath, image.contentType);
    try {
      return await this.repository.persist({
        taskId: input.taskId,
        actorId: input.actorId,
        assetId,
        mediaId,
        fileName: input.fileName,
        declaredContentType: input.declaredContentType,
        contentSha256,
        image,
        stored,
        form: input.form,
        inferred,
      });
    } catch (error) {
      await this.storage.deleteObject(stored.storagePath).catch(() => undefined);
      throw error;
    }
  }
}

export class DrizzleRegisteredImageRepository implements RegisteredImageRepositoryPort {
  constructor(private readonly db: Database) {}

  async persist(input: RegisteredImagePersistenceInput): Promise<RegisteredImageResult> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const now = new Date();
      const metadata = {
        asset_type: "image",
        asset_subtype: assetSubtype(input.form.assetKind),
        asset_factor: {
          dictionary_version: input.form.dictionaryVersion,
          factor_type: input.form.factorType,
          attributes: input.form.factorAttributes,
          input_origin: "user_declared",
        },
        rights_declaration: {
          source_kind: input.form.rightsDeclaration.sourceKind,
          contains_real_person: input.form.rightsDeclaration.containsRealPerson,
          reference_use_confirmed: true,
          declaration_origin: "user",
        },
        image_understanding: {
          input_origin: "model_inferred",
          extractor: "doubao_lite_image_upload_api",
          raw: input.inferred,
        },
        source_kind: "image_folder",
        source_file_stub: safeFileName(input.fileName),
        source_file_sha256: input.contentSha256,
        confidence_score: 0,
        review_state: "approved",
        public_storage_state: "quarantined",
        ingest: {
          source_kind: "image_folder",
          source_file_stub: safeFileName(input.fileName),
          source_file_sha256: input.contentSha256,
          confidence_score: 0,
          review_state: "approved",
          public_storage_state: "quarantined",
          extraction_method: "user_asset_registration_with_image_understanding",
          location: {},
        },
        provenance: {
          derived_from: [{ ref_type: "source", ref_id: safeFileName(input.fileName) }],
        },
        license_state: input.form.rightsDeclaration.sourceKind,
        aigc_label: {
          has_label: false,
          label_type: "",
          standard_ref: "pending_manual_review",
        },
        primary_image: {
          storage_bucket: input.stored.bucket,
          storage_path: input.stored.storagePath,
          storage_url: input.stored.storageUrl,
          sha256: input.contentSha256,
          width: input.image.width,
          height: input.image.height,
          format: input.image.format,
          is_primary: true,
          sort_order: 0,
        },
      };

      await db.insert(assetEntities).values({
        id: input.assetId,
        copiedFromAssetEntityId: null,
        sourceProjectId: null,
        sourceProjectName: null,
        ownerUserId: input.actorId,
        visibility: "personal",
        assetKind: input.form.assetKind,
        role: roleForAssetKind(input.form.assetKind),
        usageMode: "reference",
        name: input.form.name,
        displayName: input.form.name,
        intro: input.form.description,
        appearance: null,
        ageValue: null,
        gender: null,
        heightCm: null,
        hairDescription: null,
        outfitDescription: null,
        category: typeof input.form.factorAttributes.category === "string"
          ? input.form.factorAttributes.category
          : null,
        styleTags: input.form.tags,
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        sourceFileUrl: input.stored.storageUrl,
        metadata,
        createdAt: now,
        updatedAt: now,
        useCount: 0,
        deletedAt: null,
        deletedByUserId: null,
      });

      await db.insert(assetMedia).values({
        id: input.mediaId,
        assetEntityId: input.assetId,
        assetVariantId: null,
        mediaKind: "image",
        viewAngle: viewAngle(input.form.factorAttributes.view_type),
        title: input.form.name,
        description: input.form.description,
        storageBucket: input.stored.bucket,
        storagePath: input.stored.storagePath,
        storageUrl: input.stored.storageUrl,
        widthPx: input.image.width,
        heightPx: input.image.height,
        format: input.image.format,
        sha256: input.contentSha256,
        isPrimary: true,
        approved: true,
        sortOrder: 0,
        metadata: {
          source: "asset_registration_upload",
          original_file_name: safeFileName(input.fileName),
          declared_content_type: input.declaredContentType,
          detected_content_type: input.image.contentType,
        },
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      });

      await db.insert(mediaProvenanceSubjects).values({
        assetMediaId: input.mediaId,
        mediaResultId: null,
        sourceChannel: "external_upload",
        sourceGenerationAttemptId: null,
        providerAssetId: null,
        observedAt: now,
      });

      for (const tag of input.form.tags) {
        const canonicalId = await ensureCanonicalTag(db, tag, input.actorId, now);
        await db.insert(assetTags).values({
          assetEntityId: input.assetId,
          tagId: canonicalId,
          createdBy: input.actorId,
          createdAt: now,
        }).onConflictDoNothing();
      }

      // The local asset and the task's resume pointer commit together. A
      // process crash after COMMIT therefore resumes from these IDs instead of
      // creating a second personal asset.
      const resumed = await db.update(assetUploadTasks).set({
        resultAssetEntityId: input.assetId,
        resultAssetMediaId: input.mediaId,
        resultAssetName: input.form.name,
      }).where(eq(assetUploadTasks.id, input.taskId)).returning({ id: assetUploadTasks.id });
      if (!resumed[0]) throw new Error("上传任务不存在，个人资产事务已取消");

      return { assetId: input.assetId, mediaId: input.mediaId, name: input.form.name };
    });
  }
}

async function ensureCanonicalTag(
  db: Database,
  tagId: string,
  actorId: string,
  now: Date,
): Promise<string> {
  await db.insert(tagVocabulary).values({
    id: tagId,
    canonicalId: tagId,
    domain: "general",
    displayName: tagId,
    sort: 0,
    active: true,
    createdBy: actorId,
    createdAt: now,
  }).onConflictDoNothing();
  const [entry] = await db.select().from(tagVocabulary).where(eq(tagVocabulary.id, tagId)).limit(1);
  if (!entry?.active) throw new BadRequestError("标签已停用，请刷新表单后重试");
  const [canonical] = entry.canonicalId === entry.id
    ? [entry]
    : await db.select().from(tagVocabulary).where(eq(tagVocabulary.id, entry.canonicalId)).limit(1);
  if (!canonical?.active || canonical.id !== canonical.canonicalId) {
    throw new BadRequestError("标签词表配置异常，请刷新表单后重试");
  }
  return canonical.id;
}

function roleForAssetKind(assetKind: string): string | null {
  if (assetKind === "character" || assetKind === "animal") return "character_identity";
  if (assetKind === "scene" || assetKind === "lighting") return "scene";
  if (assetKind === "prop" || assetKind === "costume") return "prop";
  if (assetKind === "camera") return "camera_storyboard";
  return "style_env";
}

function viewAngle(value: string | string[] | undefined): string {
  if (typeof value !== "string") return "unknown";
  const map: Record<string, string> = {
    front: "front",
    three_quarter: "three-quarter",
    side: "side",
    other: "unknown",
  };
  return map[value] ?? "unknown";
}

function assetSubtype(assetKind: string): string {
  const map: Record<string, string> = {
    character: "portrait",
    animal: "character_reference",
    scene: "scene_concept",
    prop: "prop",
    costume: "costume",
    lighting: "lighting_reference",
    camera: "camera_reference",
  };
  return map[assetKind] ?? "reference_image";
}
