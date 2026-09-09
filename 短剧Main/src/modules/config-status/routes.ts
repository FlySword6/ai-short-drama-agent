import type { FastifyInstance } from "fastify";
import { settings, type Settings } from "../../config/env.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { success } from "../../http/response.js";
import { isAdministrator } from "../auth/types.js";

export type ConfigurationSlotKey = "image" | "video" | "llm" | "vector";

export interface ConfigurationSlotView {
  key: ConfigurationSlotKey;
  configured: boolean;
  modelDisplayName: string | null;
}

export interface RegisterConfigStatusRoutesOptions {
  /**
   * Injected by tests. This deliberately contains only derived configuration
   * inputs; route responses never expose a key, token, URL, or environment
   * variable name.
   */
  configuration?: Pick<
    Settings,
    | "arkApiKey"
    | "arkImageModel"
    | "arkVideoModel"
    | "arkLlmModel"
    | "doubaoLlmModel"
    | "aiGatewayEnabled"
    | "piRemoteApiUrl"
    | "piRemoteApiToken"
    | "piRemoteModel"
    | "doubaoEmbeddingModel"
    | "milvusUri"
    | "milvusUser"
    | "milvusPassword"
  >;
  adminUsernames?: readonly string[];
}

/**
 * A read-only, low-detail settings signal for the product settings screen.
 * Every authenticated user sees only whether each slot is usable. Deployment
 * administrators additionally see the selected model display name, but never
 * a credential, connection address, token, or environment variable name.
 */
export async function registerConfigStatusRoutes(
  app: FastifyInstance,
  options: RegisterConfigStatusRoutesOptions = {},
): Promise<void> {
  const configuration = options.configuration ?? settings;
  // Kept as a registration option only while older callers/tests migrate.
  // Runtime access is always decided from the database-backed session role.
  void (options.adminUsernames ?? settings.adminUsernames);

  app.get("/api/v1/admin/config-status", async (request) => {
    const user = requireCurrentUser(request);
    const includeModelDisplayName = isAdministrator(user.role);
    const slots = configurationSlots(configuration).map((slot) => (
      includeModelDisplayName
        ? slot
        : { key: slot.key, configured: slot.configured }
    ));
    // AI 网关开关（S46-A 能力状态条「开关」维）：布尔状态非凭据,登录即可读。
    return success({ slots, ai_gateway: { enabled: configuration.aiGatewayEnabled } });
  });
}

export function configurationSlots(
  configuration: NonNullable<RegisterConfigStatusRoutesOptions["configuration"]>,
): ConfigurationSlotView[] {
  const imageConfigured = Boolean(configuration.arkApiKey && configuration.arkImageModel);
  const videoConfigured = Boolean(configuration.arkApiKey && configuration.arkVideoModel);

  // Pi is the preferred LLM runtime when fully configured. Ark remains the
  // supported fallback for deployments that have not enabled the Pi remote.
  const piLlmConfigured = Boolean(
    configuration.piRemoteApiUrl
    && configuration.piRemoteApiToken
    && configuration.piRemoteModel,
  );
  // Must mirror the runtime fallback (arkClient / assistant / ai service all read
  // `arkLlmModel ?? doubaoLlmModel`), otherwise a deployment that only sets
  // DOUBAO_LLM_MODEL is reported as unconfigured while its AI calls work fine.
  const arkLlmModel = configuration.arkLlmModel ?? configuration.doubaoLlmModel;
  const arkLlmConfigured = Boolean(configuration.arkApiKey && arkLlmModel);
  const llmConfigured = piLlmConfigured || arkLlmConfigured;
  const llmDisplayName = piLlmConfigured
    ? configuration.piRemoteModel?.trim() || null
    : arkLlmModel?.trim() || null;

  const vectorConfigured = Boolean(
    configuration.arkApiKey
    && configuration.doubaoEmbeddingModel
    && configuration.milvusUri
    && configuration.milvusUser
    && configuration.milvusPassword,
  );

  return [
    slot("image", imageConfigured, configuration.arkImageModel),
    slot("video", videoConfigured, configuration.arkVideoModel),
    { key: "llm", configured: llmConfigured, modelDisplayName: llmConfigured ? llmDisplayName : null },
    slot("vector", vectorConfigured, configuration.doubaoEmbeddingModel),
  ];
}

function slot(
  key: Exclude<ConfigurationSlotKey, "llm">,
  configured: boolean,
  modelDisplayName: string | undefined,
): ConfigurationSlotView {
  return {
    key,
    configured,
    modelDisplayName: configured ? modelDisplayName?.trim() || null : null,
  };
}
