import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import {
  createAiProductionAssistService,
  toAiPromptDraftActor,
  type AiProductionAssistService,
} from "./service.js";
import {
  AI_ASSET_MATCH_MAX_DESCRIPTION_CHARS,
  AI_PROMPT_MODEL_KEY_PATTERN,
  AI_PROMPT_DRAFT_MAX_CREATIVE_CONTEXT_CHARS,
  AI_PROMPT_DRAFT_MAX_DESCRIPTION_CHARS,
  AI_PROMPT_DRAFT_MAX_NAME_CHARS,
  AI_PROMPT_DRAFT_MAX_SELECTED_ASSETS,
  AI_PROMPT_DRAFT_MAX_SUPPLEMENT_CHARS,
  AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS,
} from "./types.js";

const uuid = z.string().uuid();
const promptModelKey = z.string().trim().min(1).max(128).regex(AI_PROMPT_MODEL_KEY_PATTERN);
const selectedAssetSchema = z.object({
  asset_id: uuid,
}).strict();

const contextSchema = z.object({
  project_id: uuid.optional(),
  related_object_type: z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_:-]*$/).optional(),
  related_object_id: z.string().trim().min(1).max(128).optional(),
}).strict().superRefine((value, context) => {
  if ((value.related_object_type === undefined) !== (value.related_object_id === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "准备 AI 辅助没成：关联内容没有填完整，请补充后再试。" });
  }
});

const promptDraftSchema = z.object({
  media_kind: z.enum(["image", "video", "audio"]),
  description: z.string().trim().min(1).max(AI_PROMPT_DRAFT_MAX_DESCRIPTION_CHARS),
  name: z.string().trim().max(AI_PROMPT_DRAFT_MAX_NAME_CHARS).optional(),
  selected_assets: z.array(selectedAssetSchema).max(AI_PROMPT_DRAFT_MAX_SELECTED_ASSETS).default([]),
  supplement: z.string().max(AI_PROMPT_DRAFT_MAX_SUPPLEMENT_CHARS).optional(),
  creative_context: z.object({
    visual_style: z.string().trim().max(AI_PROMPT_DRAFT_MAX_CREATIVE_CONTEXT_CHARS).optional(),
    camera_direction: z.string().trim().max(AI_PROMPT_DRAFT_MAX_CREATIVE_CONTEXT_CHARS).optional(),
    reference_notes: z.array(z.string().trim().min(1).max(1_000)).max(12).optional(),
  }).strict().optional(),
  model_key: promptModelKey.optional(),
  context: contextSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.context?.related_object_type && !value.context.project_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["context", "project_id"], message: "准备 AI 辅助没成：关联内容需要选择所属项目，请补充后再试。" });
  }
});

const assetMatchSchema = z.object({
  description: z.string().trim().min(1).max(AI_ASSET_MATCH_MAX_DESCRIPTION_CHARS),
}).strict();

const promptTranslateSchema = z.object({
  prompt: z.object({
    auto: z.string().trim().min(1).max(AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS),
    supplement: z.string().max(AI_PROMPT_TRANSLATE_MAX_SECTION_CHARS).default(""),
  }).strict(),
  target_language: z.enum(["zh", "en"]),
  model_key: promptModelKey.optional(),
  context: contextSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.context?.related_object_type && !value.context.project_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["context", "project_id"], message: "准备 AI 辅助没成：关联内容需要选择所属项目，请补充后再试。" });
  }
});

export interface AiRouteDependencies {
  createService?: (db: Database) => Pick<
    AiProductionAssistService,
    "createPromptDraft" | "translatePrompt" | "listPromptModels" | "matchAssets"
  >;
}

export async function registerAiRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AiRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase()) ?? createAiProductionAssistService(getDatabase());

  app.get("/api/v1/ai/prompt-models", async (request) => {
    requireCurrentUser(request);
    return success(service().listPromptModels());
  });

  app.post("/api/v1/ai/prompt-draft", async (request) => {
    const input = parseRequest(promptDraftSchema, request.body);
    const context = input.context;
    const result = await service().createPromptDraft(toAiPromptDraftActor(requireCurrentUser(request)), {
      mediaKind: input.media_kind,
      description: input.description,
      selectedAssets: input.selected_assets.map((asset) => ({
        assetId: asset.asset_id,
        // Display data is always hydrated from PostgreSQL in the service.
        name: "",
      })),
      ...(input.name !== undefined && input.name !== "" ? { name: input.name } : {}),
      ...(input.supplement !== undefined ? { supplement: input.supplement } : {}),
      ...(input.creative_context ? { creativeContext: {
        visualStyle: input.creative_context.visual_style,
        cameraDirection: input.creative_context.camera_direction,
        referenceNotes: input.creative_context.reference_notes,
      } } : {}),
      ...(input.model_key ? { modelKey: input.model_key } : {}),
      projectId: context?.project_id,
      relatedObject: context?.related_object_type && context.related_object_id
        ? { type: context.related_object_type, id: context.related_object_id }
        : undefined,
    });
    return success(result);
  });

  app.post("/api/v1/ai/prompt-translate", async (request) => {
    const input = parseRequest(promptTranslateSchema, request.body);
    const context = input.context;
    return success(await service().translatePrompt(toAiPromptDraftActor(requireCurrentUser(request)), {
      prompt: input.prompt,
      targetLanguage: input.target_language,
      ...(input.model_key ? { modelKey: input.model_key } : {}),
      projectId: context?.project_id,
      relatedObject: context?.related_object_type && context.related_object_id
        ? { type: context.related_object_type, id: context.related_object_id }
        : undefined,
    }));
  });

  app.post("/api/v1/ai/asset-match", async (request) => {
    const input = parseRequest(assetMatchSchema, request.body);
    return success(await service().matchAssets(requireCurrentUser(request).id, input.description));
  });
}
