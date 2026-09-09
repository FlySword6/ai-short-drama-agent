/* ============================================================
   plaza/routes.ts — 创作广场（项目维度）BFF（2026-08-19）。

   广场是项目内的独立创作台：
   - 右栏生成记录只认 plaza_records（广场自己发起的生成单独成账，
     不混入项目生产链的在途/产物列表）；计费/队列真源仍是
     generation_requests，本表只做广场台账+回显快照；
   - 提交编排复用 generation 主链的 submitGenerationRequest
     （同一套档位/参考/计费契约），auto_confirm 并入提交；
   - 左栏上传（图片/音频）复用 lite 资产建档 + 资产媒体上传：
     上传件成为项目资产（可被引用作参考），不另造存储。
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import {
  generationAttempts,
  mediaResults,
  plazaRecords,
} from "../../db/schema.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { BadRequestError } from "../../shared/errors.js";
import { AssetMediaUploadService } from "../assets/mediaUpload.js";
import { createGenerationRepository } from "../generation/factory.js";
import {
  generationFailureDisplayReason,
  submitGenerationRequest,
  type GenerationSubmissionBody,
} from "../generation/routes.js";
import { createLiteAssetService } from "../lite/routes.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";

const projectParamsSchema = z.object({
  project_id: z.string().uuid(),
});

/** 广场提交体：纯文生或带 references（asset_media id），不强制 shot/资产归属。 */
const plazaGenerateSchema = z.object({
  media_kind: z.enum(["image", "video"]),
  tier_id: z.string().trim().min(1).max(128),
  prompt: z.string().trim().max(6000).optional().default(""),
  references: z.array(z.object({
    media_id: z.string().uuid(),
    usage_mode: z.string().trim().min(1).max(32),
  })).max(20).optional(),
  parameters: z.record(z.string(), z.unknown()).optional().default({}),
  quantity: z.number().int().min(1).max(4).optional().default(1),
  client_idempotency_key: z.string().trim().min(8).max(255),
}).strict();

export interface PlazaRouteDependencies {
  createMediaUploadService?: (db: Database) => AssetMediaUploadService;
  createLiteAssetService?: (db: Database) => ReturnType<typeof createLiteAssetService>;
}

export async function registerPlazaRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: PlazaRouteDependencies = {},
): Promise<void> {
  const access = () => ProjectAccessService.fromDatabase(new ProjectAccessRepository(getDatabase()));
  const mediaUpload = () => dependencies.createMediaUploadService?.(getDatabase())
    ?? new AssetMediaUploadService(getDatabase());
  const liteAssets = () => dependencies.createLiteAssetService?.(getDatabase())
    ?? createLiteAssetService(getDatabase(), {});

  /** 广场记录列表：plaza_records 左联最新 attempt 与首条持久化产物。 */
  app.get("/api/v1/projects/:project_id/plaza/records", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    await access().require(actor, projectId, "read");
    const db = getDatabase();
    const rows = await db.select().from(plazaRecords)
      .where(eq(plazaRecords.projectId, projectId))
      .orderBy(desc(plazaRecords.createdAt), desc(plazaRecords.id))
      .limit(100);
    if (rows.length === 0) return success({ items: [], count: 0 });
    const requestIds = [...new Set(rows.map((row) => row.generationRequestId))];
    const [attempts, medias] = await Promise.all([
      db.select().from(generationAttempts).where(inArray(generationAttempts.requestId, requestIds)),
      db.select().from(mediaResults).where(and(
        inArray(mediaResults.requestId, requestIds),
        eq(mediaResults.persistenceStatus, "persisted"),
        isNull(mediaResults.deletedAt),
      )),
    ]);
    const attemptByRequest = new Map<string, typeof generationAttempts.$inferSelect>();
    for (const attempt of attempts) {
      const current = attemptByRequest.get(attempt.requestId);
      if (!current || attempt.attemptNo > current.attemptNo) attemptByRequest.set(attempt.requestId, attempt);
    }
    const mediaByRequest = new Map<string, typeof mediaResults.$inferSelect>();
    for (const media of [...medias].sort((a, b) => a.resultIndex - b.resultIndex)) {
      if (!mediaByRequest.has(media.requestId ?? "")) mediaByRequest.set(media.requestId ?? "", media);
    }
    const items = rows.map((row) => {
      const attempt = attemptByRequest.get(row.generationRequestId);
      const media = mediaByRequest.get(row.generationRequestId);
      return {
        id: row.id,
        generation_request_id: row.generationRequestId,
        media_kind: row.mediaKind,
        prompt: row.prompt,
        tier_id: row.tierId,
        parameters: row.parameters,
        reference_manifest: row.referenceManifest,
        status: attempt?.status ?? "pending",
        phase: attempt?.phase ?? null,
        display_reason: generationFailureDisplayReason(attempt?.errorMessage ?? null, row.mediaKind),
        estimated_cost_fen: attempt?.estimatedCostFen ?? null,
        media_results: media ? [{
          id: media.id,
          media_kind: media.mediaKind,
          storage_url: media.storageUrl,
        }] : [],
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      };
    });
    return success({ items, count: items.length });
  });

  /** 广场生成：主链编排（quote→auto-confirm→create）后落广场台账。 */
  app.post("/api/v1/projects/:project_id/plaza/generate", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    const body = parseRequest(plazaGenerateSchema, request.body);
    const submission: GenerationSubmissionBody = {
      media_kind: body.media_kind,
      tier_id: body.tier_id,
      project_id: projectId,
      prompt: body.prompt,
      use_project_style: true,
      ...(body.references?.length ? { references: body.references } : {}),
      parameters: body.parameters,
      quantity: body.quantity,
      client_idempotency_key: body.client_idempotency_key,
      auto_confirm: true,
    };
    const { view, tierId } = await submitGenerationRequest(
      createGenerationRepository(getDatabase()),
      access(),
      actor,
      "web",
      submission,
      { submit: true },
    );
    const requestId = view!.requestId;
    const now = new Date();
    const [record] = await getDatabase().insert(plazaRecords).values({
      projectId,
      userId: actor.id,
      generationRequestId: requestId,
      mediaKind: body.media_kind,
      prompt: body.prompt,
      tierId,
      parameters: body.parameters,
      referenceManifest: (body.references ?? []).map((reference) => ({
        media_id: reference.media_id,
        kind: "image",
        role: reference.usage_mode,
      })),
      createdAt: now,
      updatedAt: now,
    }).returning();
    return success({
      generation_request_id: requestId,
      plaza_record_id: record!.id,
    });
  });

  /** 广场上传（图片/音频）：建项目资产 + 挂主媒体，上传件即可被引用。 */
  app.post("/api/v1/projects/:project_id/plaza/uploads", async (request) => {
    const actor = requireCurrentUser(request);
    const { project_id: projectId } = parseRequest(projectParamsSchema, request.params);
    await access().require(actor, projectId, "create");
    const file = await request.file();
    if (!file) throw new BadRequestError("请选择一个图片/音频文件");
    const contentType = (file.mimetype ?? "").toLowerCase();
    const mediaKind: "image" | "audio" | null = contentType.startsWith("audio/")
      ? "audio"
      : contentType.startsWith("image/")
        ? "image"
        : null;
    if (!mediaKind) throw new BadRequestError("广场只支持上传图片或音频作参考");
    const content = await file.toBuffer();
    if (!content.length) throw new BadRequestError("文件是空的");
    const baseName = (file.filename || (mediaKind === "audio" ? "上传音频" : "上传图片")).replace(/\.[^.]+$/, "").trim() || (mediaKind === "audio" ? "上传音频" : "上传图片");
    const created = await liteAssets().createAssetManually(actor, projectId, {
      name: baseName.slice(0, 80),
      assetKind: mediaKind === "audio" ? "audio" : "reference",
      intro: "广场上传参考",
      note: null,
    });
    const uploaded = await mediaUpload().upload({
      actorId: actor.id,
      assetId: created.assetEntityId,
      fileName: file.filename || (mediaKind === "audio" ? "upload.mp3" : "upload.png"),
      declaredContentType: file.mimetype,
      content,
      isPrimary: true,
      assetVariantId: created.firstVariantId,
      mediaKind,
    });
    return success({
      asset_entity_id: created.assetEntityId,
      asset_variant_id: created.firstVariantId,
      media_kind: mediaKind,
      uploaded,
    });
  });
}
