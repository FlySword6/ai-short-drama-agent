/**
 * Production composition for vNext generation.
 *
 * This file wires real adapters (TOS, Seedance 2.5, DB) together.
 * It is the only place that reads settings for generation capability.
 * Tests inject fakes through VnextGenerationServiceOptions directly.
 */

import { settings } from "../../../config/env.js";
import { effectivePaidBudgetFen } from "../../generation/factory.js";
import { VnextGenerationWorker } from "./worker.js";
import { TosStorage } from "../../../integrations/tosStorage.js";
import { Seedance25Provider } from "../providers/seedance/seedance25Provider.js";
import { VnextGenerationRepository } from "./repository.js";
import { VnextGenerationService } from "./service.js";
import type { VnextGenerationStorage } from "./service.js";
import { VnextDatabaseReferenceResolver } from "./referenceResolver.js";
import type { Database } from "../../../db/client.js";

export function seedance25ProviderConfigured(): boolean {
  return Boolean(settings.arkApiKey?.trim()) && Boolean(settings.arkVideoModel25?.trim());
}

export function vnextGenerationExecutionEnabled(): boolean {
  return settings.allowPaidGeneration === true
    && effectivePaidBudgetFen(settings) > 0
    && seedance25ProviderConfigured()
    && Boolean(settings.vnextDatabaseUrl)
    && Boolean(settings.tosBucket)
    && Boolean(settings.tosEndpoint)
    && Boolean(settings.tosAccessKey)
    && Boolean(settings.tosSecretKey)
}

export function createSeedance25Provider(): Seedance25Provider {
  return new Seedance25Provider({
    apiKey: settings.arkApiKey ?? "",
    endpointModel: settings.arkVideoModel25 ?? "",
    baseUrl: settings.arkBaseUrl,
  });
}

function createProductionStorage(): VnextGenerationStorage {
  const tos = new TosStorage();
  return {
    async downloadBytes(url: string, signal?: AbortSignal) {
      // Use built-in fetch with abort support to download provider-issued URLs.
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`Failed to download media from provider: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "video/mp4";
      const extension = contentTypeToExtension(contentType);
      return { content: buffer, contentType, extension };
    },
    async uploadBytes(input) {
      const result = await tos.uploadBytes(input.content, input.storagePath, input.contentType);
      return { bucket: result.bucket, storagePath: result.storagePath, storageUrl: result.storageUrl };
    },
  };
}

export function createVnextGenerationService(
  db: Database,
  pendingIntentRepository: { findById(intentId: string, projectId: string): Promise<import("../generation-intents/types.js").PendingGenerationIntent | null> },
  projectAccess: import("./service.js").VnextProjectAccess,
): VnextGenerationService {
  return new VnextGenerationService({
    store: new VnextGenerationRepository(db),
    intents: {
      findById: async (intentId, projectId) => {
        const intent = await pendingIntentRepository.findById(intentId, projectId);
        if (!intent) return null;
        return {
          id: intent.id,
          projectId: intent.projectId,
          actorId: intent.actorId,
          controlPackageId: intent.controlPackageId,
          controlPackageVersion: intent.controlPackageVersion,
          references: intent.references,
          finalPrompt: intent.finalPrompt,
          model: intent.model,
          parameters: intent.parameters,
          noBgm: intent.noBgm,
          estimatedCostFen: intent.estimatedCostFen,
        };
      },
    },
    access: projectAccess,
    provider: createSeedance25Provider(),
    storage: createProductionStorage(),
    referenceResolver: new VnextDatabaseReferenceResolver(db),
  });
}

export function createVnextGenerationWorker(
  db: Database,
  pendingIntentRepository: { findById(intentId: string, projectId: string): Promise<import("../generation-intents/types.js").PendingGenerationIntent | null> },
  projectAccess: import("./service.js").VnextProjectAccess,
  logger: ConstructorParameters<typeof VnextGenerationWorker>[0],
): VnextGenerationWorker {
  const service = createVnextGenerationService(db, pendingIntentRepository, projectAccess);
  return new VnextGenerationWorker(logger, {
    store: new VnextGenerationRepository(db),
    service,
    executionEnabled: vnextGenerationExecutionEnabled,
  });
}

function contentTypeToExtension(contentType: string): string {
  const ct = contentType.split(";")[0]?.trim() ?? "";
  switch (ct) {
    case "video/mp4": return "mp4";
    case "video/webm": return "webm";
    case "video/quicktime": return "mov";
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
    default: return "mp4";
  }
}
