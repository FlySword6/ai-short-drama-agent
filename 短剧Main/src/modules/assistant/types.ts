import type { VnextProjectService } from "../vnext/service.js";

export interface AssistantContext {
  sessionId: string;
  userId: string;
  projectId?: string | null;
  vnextProjectId?: string | null;
  shotId?: string | null;
}

/** Only reversible, explicitly supported director actions may cross this port. */
export type DirectorCommand =
  | { action: "select_asset"; assetEntityId: string }
  | { action: "set_camera"; cameraId: string; position: [number, number, number]; target: [number, number, number] }
  | { action: "capture_snapshot"; name: string };

export interface DirectorCommandPort {
  execute(input: {
    actorId: string;
    projectId: string;
    command: DirectorCommand;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>>;
}

export interface AssistantToolServices {
  /** 只在 vNext 会话中注入；工具与 UI 共用这一服务和 GraphDocument revision。 */
  vnextProjectService?: VnextProjectService;
  searchAssets(input: {
    actorId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
  addProjectAsset(input: {
    actorId: string;
    projectId: string;
    assetEntityId: string;
    assetVariantId?: string;
    assetMediaId?: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
  executeDirectorCommand(input: {
    actorId: string;
    projectId: string;
    command: DirectorCommand;
    signal?: AbortSignal;
  }): Promise<unknown>;
  prepareGenerationCard(input: {
    actorId: string;
    projectId: string;
    shotId: string;
    mediaKind: "image" | "video";
    prompt: string;
    referenceMediaIds: string[];
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<unknown>;
  getGenerationTask(input: {
    actorId: string;
    requestId: string;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface AssistantRuntimeConfig {
  /** Set only by server deployment configuration, never by the client. */
  aiGatewayEnabled: boolean;
  remoteApiUrl?: string;
  remoteApiToken?: string;
  remoteModelId?: string;
  contextWindow?: number;
  maxTokens?: number;
}
