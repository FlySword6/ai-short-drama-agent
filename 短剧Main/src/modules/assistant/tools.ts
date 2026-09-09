import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createVnextCanvasReadTool, createVnextCanvasTool } from "../vnext/agentTool.js";
import type { AssistantContext, AssistantToolServices } from "./types.js";

export const ASSISTANT_TOOL_NAMES = [
  "search_assets",
  "add_project_asset",
  "get_generation_task",
  "execute_director_command",
  "prepare_generation_card",
] as const;

const searchAssetsParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "自然语言检索内容" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 })),
});

const addProjectAssetParameters = Type.Object({
  asset_entity_id: Type.String({ minLength: 1 }),
  asset_variant_id: Type.Optional(Type.String({ minLength: 1 })),
  asset_media_id: Type.Optional(Type.String({ minLength: 1 })),
});

const directorCommandParameters = Type.Object({
  action: Type.Union([Type.Literal("select_asset"), Type.Literal("set_camera"), Type.Literal("capture_snapshot")]),
  asset_entity_id: Type.Optional(Type.String({ minLength: 1 })),
  camera_id: Type.Optional(Type.String({ minLength: 1 })),
  position: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
  target: Type.Optional(Type.Tuple([Type.Number(), Type.Number(), Type.Number()])),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false });

const prepareGenerationCardParameters = Type.Object({
  media_kind: Type.Union([Type.Literal("image"), Type.Literal("video")]),
  prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
  reference_media_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 8 })),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

const getGenerationTaskParameters = Type.Object({
  request_id: Type.String({ minLength: 1 }),
});

export function createAssistantTools(
  context: AssistantContext,
  services: AssistantToolServices,
): AgentTool[] {
  const searchAssets: AgentTool<typeof searchAssetsParameters, unknown> = {
    name: "search_assets",
    label: "检索资产",
    description: "检索当前用户有权查看的个人资产和通用资产。",
    parameters: searchAssetsParameters,
    execute: async (_toolCallId, params, signal) => {
      const result = await services.searchAssets({
        actorId: context.userId,
        query: params.query,
        limit: params.limit ?? 8,
        signal,
      });
      return toolResult(result);
    },
  };

  const addProjectAsset: AgentTool<typeof addProjectAssetParameters, unknown> = {
    name: "add_project_asset",
    label: "加入项目资产",
    description: "把当前用户可引用的资产加入当前项目。",
    parameters: addProjectAssetParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const projectId = requiredContext(context.projectId, "当前没有选择项目");
      const result = await services.addProjectAsset({
        actorId: context.userId,
        projectId,
        assetEntityId: params.asset_entity_id,
        assetVariantId: params.asset_variant_id,
        assetMediaId: params.asset_media_id,
        signal,
      });
      return toolResult(result);
    },
  };

  const executeDirectorCommand: AgentTool<typeof directorCommandParameters, unknown> = {
    name: "execute_director_command",
    label: "执行导演台安全动作",
    description: "向当前项目的导演台提交一个受限、结构化的安全动作。",
    parameters: directorCommandParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const projectId = requiredContext(context.projectId, "当前没有选择项目");
      const command = params.action === "select_asset"
        ? { action: params.action, assetEntityId: params.asset_entity_id! } as const
        : params.action === "set_camera"
          ? { action: params.action, cameraId: params.camera_id!, position: params.position!, target: params.target! } as const
          : { action: params.action, name: params.name! } as const;
      const result = await services.executeDirectorCommand({
        actorId: context.userId,
        projectId,
        command,
        signal,
      });
      return toolResult(result);
    },
  };

  const prepareGenerationCard: AgentTool<typeof prepareGenerationCardParameters, unknown> = {
    name: "prepare_generation_card",
    label: "准备生成卡",
    description: "准备当前项目的图片或视频生成卡，不会创建任务、报价或任何付费调用。需要已选择具体镜头（shot_id）才能准备。",
    parameters: prepareGenerationCardParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const projectId = requiredContext(context.projectId, "当前没有选择项目");
      if (!context.shotId) {
        return toolResult({
          error: "no_shot_selected",
          message: "当前没有选择具体镜头。请先在场级工作台选择一个镜头，再准备生成卡。",
        });
      }
      const result = await services.prepareGenerationCard({
        actorId: context.userId,
        projectId,
        shotId: context.shotId,
        mediaKind: params.media_kind,
        prompt: params.prompt,
        referenceMediaIds: params.reference_media_ids ?? [],
        parameters: params.parameters ?? {},
        signal,
      });
      return toolResult(result);
    },
  };

  const getGenerationTask: AgentTool<typeof getGenerationTaskParameters, unknown> = {
    name: "get_generation_task",
    label: "查询生成任务",
    description: "查询当前用户有权查看的生成请求、尝试和媒体结果。",
    parameters: getGenerationTaskParameters,
    execute: async (_toolCallId, params, signal) => {
      const result = await services.getGenerationTask({
        actorId: context.userId,
        requestId: params.request_id,
        signal,
      });
      return toolResult(result);
    },
  };

  const tools: AgentTool[] = [
    searchAssets,
    addProjectAsset,
    getGenerationTask,
    executeDirectorCommand,
    prepareGenerationCard,
  ];
  if (context.vnextProjectId) {
    if (!services.vnextProjectService) {
      throw new Error("vNext Assistant context requires VnextProjectService");
    }
    tools.push(createVnextCanvasReadTool(context, services.vnextProjectService));
    tools.push(createVnextCanvasTool(context, services.vnextProjectService));
  }
  return tools;
}

export function assistantIdempotencyKey(sessionId: string, toolCallId: string): string {
  return `assistant:${createHash("sha256").update(`${sessionId}:${toolCallId}`).digest("hex")}`;
}

export function assistantConfirmationIdempotencyKey(generationQuoteId: string): string {
  return `confirmation:${generationQuoteId}`;
}

function requiredContext(value: string | null | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function toolResult(result: unknown) {
  const safeResult = JSON.parse(JSON.stringify(result ?? null)) as unknown;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(safeResult) }],
    details: safeResult,
  };
}
