import type { FastifyInstance } from "fastify";
import {
  createAssetUploadTaskService,
  createSeedanceAssetRegistrationService,
} from "../composition/seedanceAssetRegistration.js";
import type { Database } from "../db/client.js";
import { registerAssetRoutes } from "../modules/assets/routes.js";
import { registerAuthRoutes, type AuthRouteDependencies } from "../modules/auth/routes.js";
import { registerHealthRoutes } from "../modules/health/routes.js";
import { registerProductionRoutes } from "../modules/production/routes.js";
import { registerGenerationRoutes } from "../modules/generation/routes.js";
import { registerGenerationDefaultStrategyRoutes } from "../modules/generation/defaults/routes.js";
import { registerPromptTemplateRoutes } from "../modules/generation/prompt-templates/routes.js";
import { registerProjectStyleRoutes } from "../modules/generation/project-styles/routes.js";
import { registerStoryboardRoutes } from "../modules/storyboard/routes.js";
import { registerProjectAssetRoutes } from "../modules/project-assets/routes.js";
import { registerShotMediaRoutes } from "../modules/shot-media/routes.js";
import { registerDeliveryRoutes } from "../modules/delivery/routes.js";
import { registerTrashRoutes } from "../modules/trash/routes.js";
import { registerDashboardRoutes } from "../modules/dashboard/routes.js";
import { registerAssistantRoutes, type AssistantRouteDependencies } from "../modules/assistant/routes.js";
import { registerDirectorRoutes } from "../modules/director/routes.js";
import { registerReviewRoutes } from "../modules/reviews/routes.js";
import { registerReferenceTestRoutes } from "../modules/referenceTests/routes.js";
import { registerAdminGenerationRoutes } from "../modules/admin/generations/routes.js";
import { registerAdminUserRoutes } from "../modules/admin/users/index.js";
import { registerAdminModelRoutes } from "../modules/admin/models/routes.js";
import { registerEventRoutes } from "../modules/events/routes.js";
import { registerControlPackageRoutes } from "../modules/control-packages/routes.js";
import { registerConfigStatusRoutes } from "../modules/config-status/routes.js";
import { registerConsumptionRecordRoutes } from "../modules/consumption-records/routes.js";
import { registerCapabilityTierRoutes } from "../modules/capability-tiers/routes.js";
import { registerAiRoutes } from "../modules/ai/routes.js";
import { registerSeedanceAssetRegistrationRoutes } from "../modules/seedance-assets/routes.js";
import { registerOperationsRoutes } from "../modules/operations/routes.js";
import { registerTopicRadarRoutes } from "../modules/topic-radar/routes.js";
import { registerUserDirectoryRoutes } from "../modules/user-directory/routes.js";
import { registerVocabularyRoutes } from "../modules/vocabulary/routes.js";
import { registerScriptBreakdownRoutes } from "../modules/script-breakdown/routes.js";
import { registerLiteRoutes } from "../modules/lite/routes.js";
import { registerConfigEntriesRoutes } from "../modules/config-entries/routes.js";
import { registerCommandPaletteRoutes } from "../modules/command-palette/routes.js";
import { registerAudioRoutes } from "../modules/audio/routes.js";
import { DbVoiceCatalogProvider } from "../modules/audio/voiceCatalogProvider.js";
import { registerAssetUploadRoutes } from "../modules/asset-uploads/routes.js";
import type { AssetUploadKickPort } from "../modules/asset-uploads/worker.js";
import { registerAccountCreditRoutes } from "../modules/account-credits/routes.js";
import { registerObjectContextRoutes } from "../modules/object-context/routes.js";
import { registerCastingTaskRoutes } from "../modules/casting-tasks/routes.js";
import { registerTosPublicProxyRoutes } from "../modules/tos-public/routes.js";
import { registerScenePrepRoutes } from "../modules/prep/routes.js";
import { registerAssetMediaRepairRoutes } from "../modules/assets/mediaRepairRoutes.js";
import { registerGenerationOrchestrationRoutes } from "../modules/generation-orchestration/routes.js";
import type { AssetMediaRepairKickPort } from "../modules/assets/mediaRepairWorker.js";
import { registerVideoIngestRoutes } from "../modules/video-ingest/routes.js";
import type { VideoIngestKickPort } from "../modules/video-ingest/worker.js";
import { registerPlazaRoutes } from "../modules/plaza/routes.js";
import { registerAudioIngestRoutes } from "../modules/audio-ingest/routes.js";

export interface AppRouteOptions {
  getDatabase: () => Database;
  assistantRoutes?: AssistantRouteDependencies;
  authRoutes?: AuthRouteDependencies;
  /** Optional in-process upload queue worker; submissions kick it after enqueue. */
  assetUploadWorker?: AssetUploadKickPort;
  /** Optional in-process asset-media repair worker; repair submissions kick it after enqueue. */
  assetMediaRepairWorker?: AssetMediaRepairKickPort;
  /** Optional in-process video ingest worker; submissions kick it after enqueue. */
  videoIngestWorker?: VideoIngestKickPort;
}

export async function registerRoutes(app: FastifyInstance, options: AppRouteOptions): Promise<void> {
  await registerTosPublicProxyRoutes(app);
  await registerHealthRoutes(app, options.getDatabase);
  await registerAuthRoutes(app, options.getDatabase, options.authRoutes);
  await registerOperationsRoutes(app, options.getDatabase);
  await registerUserDirectoryRoutes(app, options.getDatabase);
  await registerProductionRoutes(app, options.getDatabase);
  await registerObjectContextRoutes(app, options.getDatabase);
  await registerCastingTaskRoutes(app, options.getDatabase);
  const seedanceAssetRegistration = () => createSeedanceAssetRegistrationService(
    options.getDatabase(),
  );
  await registerAssetRoutes(app, options.getDatabase, {
    volcRegistrationRoutes: {
      createService: seedanceAssetRegistration,
    },
    // 2026-08-19 触发模型:is_primary=true 上传(完整版+Lite 共享钩子)自动登记。
    createAssetRegistrationService: seedanceAssetRegistration,
  });
  await registerAssetMediaRepairRoutes(app, options.getDatabase, {
    ...(options.assetMediaRepairWorker ? { worker: options.assetMediaRepairWorker } : {}),
  });
  await registerSeedanceAssetRegistrationRoutes(app, options.getDatabase, {
    createService: seedanceAssetRegistration,
  });
  // S57 guards full paid-task estimates before generation routes persist a
  // quote. The migration's quote-consumption trigger remains the final atomic
  // debit authority, so this is a fast human-readable early rejection only.
  await registerAccountCreditRoutes(app, options.getDatabase);
  await registerGenerationRoutes(app, options.getDatabase);
  await registerVideoIngestRoutes(app, options.getDatabase, {
    ...(options.videoIngestWorker ? { worker: options.videoIngestWorker } : {}),
  });
  await registerAudioIngestRoutes(app, options.getDatabase);
  await registerAudioRoutes(app, {
    getDatabase: options.getDatabase,
    // S44: 音色词表是唯一事实来源;provider 构造不碰数据库,首次读取才取连接。
    voiceCatalogProvider: new DbVoiceCatalogProvider(options.getDatabase),
  });
  await registerGenerationDefaultStrategyRoutes(app, options.getDatabase);
  await registerPromptTemplateRoutes(app, options.getDatabase);
  await registerProjectStyleRoutes(app, options.getDatabase);
  await registerStoryboardRoutes(app, options.getDatabase);
  await registerProjectAssetRoutes(app, options.getDatabase);
  await registerScenePrepRoutes(app, options.getDatabase);
  await registerShotMediaRoutes(app, options.getDatabase);
  await registerDeliveryRoutes(app, options.getDatabase);
  await registerTrashRoutes(app, options.getDatabase);
  await registerDashboardRoutes(app, options.getDatabase);
  await registerAdminGenerationRoutes(app, options.getDatabase);
  await registerAdminUserRoutes(app, options.getDatabase);
  await registerAdminModelRoutes(app, options.getDatabase);
  await registerEventRoutes(app, options.getDatabase);
  await registerAssistantRoutes(app, options.getDatabase, options.assistantRoutes);
  await registerGenerationOrchestrationRoutes(app, options.getDatabase);
  await registerDirectorRoutes(app, options.getDatabase);
  await registerReviewRoutes(app, options.getDatabase);
  await registerReferenceTestRoutes(app, options.getDatabase);
  await registerControlPackageRoutes(app, options.getDatabase);
  await registerConfigStatusRoutes(app);
  await registerConsumptionRecordRoutes(app, options.getDatabase);
  await registerCapabilityTierRoutes(app, options.getDatabase);
  await registerAiRoutes(app, options.getDatabase);
  await registerTopicRadarRoutes(app, options.getDatabase);
  await registerVocabularyRoutes(app, options.getDatabase);
  await registerScriptBreakdownRoutes(app, options.getDatabase);
  await registerLiteRoutes(app, options.getDatabase, {
    // 2026-08-19 触发模型:Lite 设主图/主音频后自动登记火山素材。
    createRegistrationService: seedanceAssetRegistration,
  });
  await registerPlazaRoutes(app, options.getDatabase);
  await registerConfigEntriesRoutes(app, options.getDatabase);
  await registerCommandPaletteRoutes(app, options.getDatabase);
  await registerAssetUploadRoutes(app, options.getDatabase, {
    createService: createAssetUploadTaskService,
    ...(options.assetUploadWorker ? { worker: options.assetUploadWorker } : {}),
  });
}
