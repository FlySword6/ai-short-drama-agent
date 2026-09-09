import { settings } from "../config/env.js";
import type { Database } from "../db/client.js";
import { createArkAssetRegistryAdapter } from "../integrations/arkAssetRegistryAdapter.js";
import { VolcAssetGroupRepository, type VolcAssetGroupRepositoryPort } from "../modules/assets/volcAssetGroupRepository.js";
import { VolcAssetGroupResolver } from "../modules/assets/volcAssetGroups.js";
import { AssetUploadTaskService } from "../modules/asset-uploads/service.js";
import { SeedanceAssetRegistrationRepository } from "../modules/seedance-assets/repository.js";
import {
  SeedanceAssetRegistrationService,
  type SeedanceAssetRegistrationRuntimeConfiguration,
  type SeedanceAssetRegistrationServiceDependencies,
} from "../modules/seedance-assets/service.js";
import type { VolcAssetRegistryPort } from "../modules/assets/volcAssetRegistry.js";
import { VolcSnapshotRegistrationAdapter, type VolcSnapshotRegistrationConfiguration } from "../modules/vnext/assets/registrationAdapter.js";
import type { SnapshotARegistrationPort, SnapshotRegistrationReadback } from "../modules/vnext/imports/service.js";
/**
 * Composition root for the provider-specific Ark implementation.
 * Domain modules depend only on the registry port and stable failure contract.
 */
export function createSeedanceAssetRegistrationService(
  db: Database,
  dependencies: SeedanceAssetRegistrationServiceDependencies = {},
): SeedanceAssetRegistrationService {
  const repository = dependencies.repository ?? new SeedanceAssetRegistrationRepository(db);
  const configuration = dependencies.configuration ?? registrationConfiguration();
  const registry = dependencies.registry ?? createArkAssetRegistryAdapter({
    accessKeyId: settings.volcengineAccessKeyId ?? "",
    secretAccessKey: settings.volcengineSecretAccessKey ?? "",
    securityToken: settings.volcengineSecurityToken,
    endpoint: settings.seedanceAssetRegistrationEndpoint,
    region: settings.seedanceAssetRegistrationRegion,
  });
  const assetGroups = dependencies.assetGroups
    ?? new VolcAssetGroupResolver(new VolcAssetGroupRepository(db), registry);
  return new SeedanceAssetRegistrationService(repository, {
    configuration,
    registry,
    assetGroups,
  });
}

export function createAssetUploadTaskService(db: Database): AssetUploadTaskService {
  return new AssetUploadTaskService(db, undefined, {
    seedance: createSeedanceAssetRegistrationService(db),
  });
}

export interface SnapshotARegistrationDependencies {
  db?: Database;
  assetGroups?: VolcAssetGroupRepositoryPort;
  registry?: VolcAssetRegistryPort;
  configuration?: VolcSnapshotRegistrationConfiguration;
  enabled?: boolean;
  providerReady?: boolean;
  actorUserId?: string;
}

/**
 * Production composition for Snapshot A registration. The existing Ark
 * registry backend is reused only when the shared registration switch is
 * enabled and credentials are present; otherwise the import service records
 * 「未开启、未发送任何请求」 instead of composing a dead adapter.
 */
export function createSnapshotARegistration(
  dependencies: SnapshotARegistrationDependencies = {},
): SnapshotARegistrationPort | undefined {
  const enabled = dependencies.enabled ?? settings.seedanceAssetRegistrationEnabled;
  const providerReady = dependencies.providerReady ?? Boolean(
    settings.volcengineAccessKeyId && settings.volcengineSecretAccessKey,
  );
  if (!enabled || !providerReady) return undefined;
  const registry = dependencies.registry ?? createArkAssetRegistryAdapter({
    accessKeyId: settings.volcengineAccessKeyId ?? "",
    secretAccessKey: settings.volcengineSecretAccessKey ?? "",
    securityToken: settings.volcengineSecurityToken,
    endpoint: settings.seedanceAssetRegistrationEndpoint,
    region: settings.seedanceAssetRegistrationRegion,
  });
  const configuration = dependencies.configuration ?? {
    assetGroupId: settings.seedanceAssetGroupId ?? null,
    projectName: settings.seedanceAssetProjectName,
  };
  if (configuration.assetGroupId) return new VolcSnapshotRegistrationAdapter(registry, configuration);
  const db = dependencies.db;
  const assetGroupRepository = dependencies.assetGroups ?? (db ? new VolcAssetGroupRepository(db) : undefined);
  if (!assetGroupRepository) return new VolcSnapshotRegistrationAdapter(registry, configuration);
  const assetGroups = new VolcAssetGroupResolver(assetGroupRepository, registry);
  let resolvedGroupId: string | undefined;
  let resolvingGroupId: Promise<string> | undefined;
  async function resolveGroupId(): Promise<string> {
    if (resolvedGroupId) return resolvedGroupId;
    resolvingGroupId ??= (async () => {
      const resolution = await assetGroups.resolve(dependencies.actorUserId ?? "snapshot-a", {
        configuredGroupId: configuration.assetGroupId ?? undefined,
        name: settings.seedanceAssetGroupName,
        description: settings.seedanceAssetGroupDescription,
        projectName: configuration.projectName,
      });
      if (resolution.kind !== "resolved") {
        const failure = resolution.kind === "failure" ? resolution.failure : { errorCode: "ASSET_GROUP_OUTCOME_UNKNOWN", errorMessage: "火山素材组创建结果不明确，未发送登记请求", requestId: null, httpStatus: null };
        throw new GroupResolutionFailure(failure);
      }
      resolvedGroupId = resolution.groupId;
      return resolvedGroupId;
    })();
    try {
      return await resolvingGroupId;
    } catch (error) {
      resolvingGroupId = undefined;
      throw error;
    }
  }
  return {
    async register(input) {
      try {
        const groupId = await resolveGroupId();
        return new VolcSnapshotRegistrationAdapter(registry, { ...configuration, assetGroupId: groupId }).register(input);
      } catch (error) {
        return groupFailureReadback(error, null, "CreateAsset");
      }
    },
    async readback(input) {
      try {
        const groupId = await resolveGroupId();
        return new VolcSnapshotRegistrationAdapter(registry, { ...configuration, assetGroupId: groupId }).readback(input);
      } catch (error) {
        return groupFailureReadback(error, input.registrationId, "ListAssets");
      }
    },
    async readbackByName(input) {
      try {
        const groupId = await resolveGroupId();
        return new VolcSnapshotRegistrationAdapter(registry, { ...configuration, assetGroupId: groupId }).readbackByName(input);
      } catch (error) {
        return groupFailureReadback(error, null, "ListAssetsByName");
      }
    },
  };
}
class GroupResolutionFailure extends Error {
  constructor(readonly failure: { errorCode: string; errorMessage: string; requestId: string | null; httpStatus: number | null }) {
    super(`${failure.errorCode}: ${failure.errorMessage}`);
  }
}
function groupFailureReadback(error: unknown, registrationId: string | null, action: "CreateAsset" | "ListAssets" | "ListAssetsByName"): SnapshotRegistrationReadback {
  const failure = error instanceof GroupResolutionFailure ? error.failure : undefined;
  const message = failure?.errorMessage ?? (error instanceof Error ? error.message : "火山素材组解析失败");
  const errorCode = failure?.errorCode ?? (message.split(": ")[0] || "ASSET_GROUP_OUTCOME_UNKNOWN");
  return {
    registrationId,
    status: "unknown",
    failureCode: errorCode,
    failureReason: failure?.errorMessage ?? (message.includes(": ") ? message.slice(message.indexOf(": ") + 2) : message),
    readback: { action, matched: false, ...(failure?.requestId ? { requestId: failure.requestId } : {}), ...(failure?.httpStatus ? { httpStatus: failure.httpStatus } : {}) },
  };
}

function registrationConfiguration(): SeedanceAssetRegistrationRuntimeConfiguration {
  return {
    enabled: settings.seedanceAssetRegistrationEnabled,
    providerReady: Boolean(
      settings.volcengineAccessKeyId
      && settings.volcengineSecretAccessKey,
    ),
    assetGroupId: settings.seedanceAssetGroupId ?? null,
    projectName: settings.seedanceAssetProjectName,
    assetGroupName: settings.seedanceAssetGroupName,
    assetGroupDescription: settings.seedanceAssetGroupDescription,
  };
}
