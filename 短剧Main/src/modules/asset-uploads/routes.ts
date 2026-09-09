import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { BadRequestError, publicStoredMessage } from "../../shared/errors.js";
import { AssetRegistrationSchemaService } from "./registrationSchema.js";
import { AssetUploadTaskService } from "./service.js";
import type {
  AssetUploadNotificationView,
  AssetUploadRegistrationResultView,
  AssetUploadTaskView,
} from "./types.js";
import type { AssetUploadKickPort } from "./worker.js";

const notificationParams = z.object({ notification_id: z.string().uuid() });
const taskParams = z.object({ task_id: z.string().uuid() });
const registrationSchemaQuery = z.object({
  asset_kind: z.string().trim().min(1).max(32).optional(),
  factor_type: z.string().trim().min(1).max(64).optional(),
});
const notificationListQuery = z.object({
  // This is an unread-reminder drain, not a history endpoint. Same bounded,
  // stable page rule as the generation notification contract.
  limit: z.coerce.number().int().min(1).max(20).default(20),
});

export interface AssetUploadRouteDependencies {
  createService?: (
    db: Database,
  ) => Pick<AssetUploadTaskService, "submitImage" | "listActive" | "get" | "listNotifications" | "acknowledge">;
  createSchemaService?: (
    db: Database,
  ) => Pick<AssetRegistrationSchemaService, "getSchema">;
  /** Production wires the in-process worker; route tests can pass a fake or nothing. */
  worker?: AssetUploadKickPort;
}

export async function registerAssetUploadRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AssetUploadRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase())
    ?? new AssetUploadTaskService(getDatabase());
  const schemaService = () => dependencies.createSchemaService?.(getDatabase())
    ?? new AssetRegistrationSchemaService(getDatabase());

  app.get("/api/v1/assets/registration-schema", async (request) => {
    requireCurrentUser(request);
    const query = parseRequest(registrationSchemaQuery, request.query);
    const schema = await schemaService().getSchema(query.asset_kind, query.factor_type);
    return success(registrationSchemaData(schema));
  });

  app.post("/api/v1/asset-upload-tasks", {
    config: { agentAccess: "candidate" },
  }, async (request, reply) => {
    const actorId = requireCurrentUser(request).id;
    const upload = await readImageMultipart(request);
    const task = await service().submitImage(actorId, upload);
    dependencies.worker?.kick();
    return reply.code(202).send(success(assetUploadTaskData(task)));
  });

  app.get("/api/v1/asset-upload-tasks", async (request) => {
    const actorId = requireCurrentUser(request).id;
    const items = await service().listActive(actorId);
    return success({ items: items.map(assetUploadTaskData), count: items.length });
  });

  app.get("/api/v1/asset-upload-tasks/:task_id", async (request) => {
    const actorId = requireCurrentUser(request).id;
    const params = parseRequest(taskParams, request.params);
    return success(assetUploadTaskData(await service().get(actorId, params.task_id)));
  });

  app.get("/api/v1/asset-upload-notifications", async (request) => {
    const actor = requireCurrentUser(request);
    const query = parseRequest(notificationListQuery, request.query);
    const items = await service().listNotifications(actor.id, query.limit);
    return success({ items: items.map(assetUploadNotificationData), count: items.length });
  });

  app.post("/api/v1/asset-upload-notifications/:notification_id/acknowledge", async (request) => {
    const actor = requireCurrentUser(request);
    const params = parseRequest(notificationParams, request.params);
    await service().acknowledge(actor.id, params.notification_id);
    return success({ notification_id: params.notification_id, acknowledged: true });
  });
}

async function readImageMultipart(request: FastifyRequest) {
  const file = await request.file();
  if (!file) throw new BadRequestError("缺少上传文件");
  const content = await file.toBuffer();
  const fields = file.fields as Record<string, { value?: unknown }>;
  const clientIdempotencyKey = fieldText(fields.client_idempotency_key);
  const registrationText = fieldText(fields.registration);
  let registration: unknown;
  if (registrationText) {
    try {
      registration = JSON.parse(registrationText);
    } catch {
      throw new BadRequestError("登记表单不是有效 JSON");
    }
  }
  return {
    fileName: file.filename,
    declaredContentType: file.mimetype,
    content,
    assetKindHint: fieldText(fields.asset_kind_hint),
    sourceProjectName: fieldText(fields.source_project_name),
    clientIdempotencyKey: clientIdempotencyKey
      ? parseRequest(z.string().uuid(), clientIdempotencyKey)
      : undefined,
    registration,
  };
}

function fieldText(value: { value?: unknown } | undefined): string | null {
  return typeof value?.value === "string" && value.value.trim() ? value.value.trim() : null;
}

export function assetUploadTaskData(view: AssetUploadTaskView): Record<string, unknown> {
  const displayReason = view.error
    ? publicStoredMessage(
        view.error.message,
        "图片入库没成：请重新上传图片；多次失败可换一张。",
      )
    : null;
  return {
    id: view.id,
    status: view.status,
    original_file_name: view.originalFileName,
    asset_kind_hint: view.assetKindHint,
    asset_kind: view.assetKind,
    factor_type: view.factorType,
    queue_position: view.queuePosition,
    estimated_duration_seconds: view.estimatedDurationSeconds,
    estimated_duration_sample_count: view.estimatedDurationSampleCount,
    created_at: view.createdAt,
    started_at: view.startedAt,
    finished_at: view.finishedAt,
    result: view.result
      ? {
          asset: view.result.asset
            ? {
                id: view.result.asset.id,
                media_id: view.result.asset.mediaId,
                scope: view.result.asset.scope,
                status: view.result.asset.status,
              }
            : null,
          seedance_registration: view.result.seedanceRegistration
            ? assetUploadRegistrationData(view.result.seedanceRegistration)
            : null,
        }
      : null,
    error: view.error,
    display_reason: displayReason,
  };
}

export function assetUploadNotificationData(view: AssetUploadNotificationView): Record<string, unknown> {
  const displayReason = view.errorMessage
    ? publicStoredMessage(
        view.errorMessage,
        "图片入库没成：请重新上传图片；多次失败可换一张。",
      )
    : null;
  return {
    id: view.id,
    status: view.status,
    original_file_name: view.originalFileName,
    result_asset_entity_id: view.resultAssetEntityId,
    result_asset_media_id: view.resultAssetMediaId,
    result_asset_name: view.resultAssetName,
    seedance_registration: view.seedanceRegistration
      ? assetUploadRegistrationData(view.seedanceRegistration)
      : null,
    error_code: view.errorCode,
    error_message: view.errorMessage,
    display_reason: displayReason,
    created_at: view.createdAt,
    finished_at: view.finishedAt,
  };
}

function assetUploadRegistrationData(
  view: AssetUploadRegistrationResultView,
): Record<string, unknown> {
  const displayReason = view.errorMessage
    ? publicStoredMessage(
        view.errorMessage,
        "素材登记没成：可稍后重试。",
      )
    : null;
  return {
    id: view.id,
    status: view.status,
    remote_asset_id: view.remoteAssetId,
    last_verified_at: view.lastVerifiedAt,
    fresh_until: view.freshUntil,
    can_use_as_seedance_reference: view.canUseAsSeedanceReference,
    next_action: view.nextAction,
    error_code: view.errorCode,
    error_message: view.errorMessage,
    display_reason: displayReason,
  };
}

function registrationSchemaData(
  schema: Awaited<ReturnType<AssetRegistrationSchemaService["getSchema"]>>,
): Record<string, unknown> {
  return {
    schema_version: schema.schemaVersion,
    dictionary_version: schema.dictionaryVersion,
    accepted_media_kinds: schema.acceptedMediaKinds,
    asset_kinds: schema.assetKinds.map((kind) => ({
      id: kind.id,
      display_name: kind.displayName,
      factor_types: kind.factorTypes.map((factor) => ({
        id: factor.id,
        display_name: factor.displayName,
      })),
    })),
    fields: schema.fields.map((field) => ({
      id: field.id,
      display_name: field.displayName,
      value_type: field.valueType,
      required: field.required,
      ...(field.maxLength ? { max_length: field.maxLength } : {}),
      ...(field.options ? { options: field.options } : {}),
      input_source: field.inputSource,
    })),
    system_managed_fields: schema.systemManagedFields,
    defaults: {
      visibility: schema.defaults.visibility,
      status: schema.defaults.status,
      clearance: {
        search: schema.defaults.clearance.search,
        gen_reference: schema.defaults.clearance.genReference,
        commercial_publish: schema.defaults.clearance.commercialPublish,
        model_training: schema.defaults.clearance.modelTraining,
      },
    },
  };
}
