import {
  VolcAssetRegistryOperationError,
  type CreateVolcAssetGroupResult,
  type VolcAssetGroupFailureCode,
  type VolcAssetRegistryFailureCode,
} from "./volcAssetRegistry.js";
import type {
  VolcAssetGroupConfiguration,
  VolcAssetGroupFailure,
  VolcAssetGroupRepositoryPort,
  VolcAssetGroupResolution,
} from "./volcAssetGroupRepository.js";

export type {
  VolcAssetGroupConfiguration,
  VolcAssetGroupFailure,
  VolcAssetGroupResolution,
} from "./volcAssetGroupRepository.js";

export interface VolcAssetGroupRegistryPort {
  createAssetGroup(input: {
    name: string;
    description: string;
    groupType: "AIGC";
    projectName: string;
  }): Promise<CreateVolcAssetGroupResult>;
}

export interface VolcAssetGroupResolverPort {
  resolve(
    actorUserId: string,
    configuration: VolcAssetGroupConfiguration,
  ): Promise<VolcAssetGroupResolution>;
}

/**
 * Orchestrates the CreateAssetGroup provider call. PostgreSQL idempotency and
 * group mapping state stay behind the repository port.
 */
export class VolcAssetGroupResolver implements VolcAssetGroupResolverPort {
  constructor(
    private readonly repository: VolcAssetGroupRepositoryPort,
    private readonly registry: VolcAssetGroupRegistryPort,
  ) {}

  async resolve(
    actorUserId: string,
    configuration: VolcAssetGroupConfiguration,
  ): Promise<VolcAssetGroupResolution> {
    const configuredGroupId = configuration.configuredGroupId?.trim();
    if (configuredGroupId) {
      return this.repository.importConfigured(actorUserId, configuration, configuredGroupId);
    }

    const claim = await this.repository.claimCreate(actorUserId, configuration);
    if (claim.kind !== "create") return claim.result;

    try {
      const result = await this.registry.createAssetGroup({
        name: configuration.name,
        description: configuration.description,
        groupType: "AIGC",
        projectName: configuration.projectName,
      });
      return await this.repository.recordCreated(claim.row.id, actorUserId, result);
    } catch (error) {
      const failure = groupFailure(error);
      const status = isAmbiguousGroupFailure(error) ? "unknown" : "failed";
      await this.repository.recordFailure(claim.row.id, actorUserId, status, failure);
      return { kind: "failure", status, failure };
    }
  }
}

function groupFailure(error: unknown): VolcAssetGroupFailure {
  if (error instanceof VolcAssetRegistryOperationError) {
    const ambiguous = isAmbiguousGroupFailure(error);
    return {
      errorCode: ambiguous
        ? "ASSET_GROUP_OUTCOME_UNKNOWN"
        : groupFailureCode(error.failure.errorCode),
      errorMessage: ambiguous
        ? "火山素材组创建结果不明确，系统不会自动重复创建，请先人工复核"
        : "火山素材组创建失败，请核对素材库权限和配置后再次明确提交",
      requestId: error.failure.requestId,
      httpStatus: error.failure.httpStatus,
    };
  }
  return {
    errorCode: "ASSET_GROUP_UNAVAILABLE",
    errorMessage: "火山素材组创建结果不明确，系统不会自动重复创建，请先人工复核",
    requestId: null,
    httpStatus: null,
  };
}

function isAmbiguousGroupFailure(error: unknown): boolean {
  if (!(error instanceof VolcAssetRegistryOperationError)) return true;
  return error.outcomeUnknown;
}

function groupFailureCode(
  code: VolcAssetRegistryFailureCode,
): VolcAssetGroupFailureCode {
  switch (code) {
    case "ASSET_REGISTRY_INVALID_REQUEST":
      return "ASSET_GROUP_INVALID_REQUEST";
    case "ASSET_REGISTRY_ACCESS_DENIED":
      return "ASSET_GROUP_ACCESS_DENIED";
    case "ASSET_REGISTRY_RATE_LIMITED":
      return "ASSET_GROUP_RATE_LIMITED";
    case "ASSET_REGISTRY_UNAVAILABLE":
      return "ASSET_GROUP_UNAVAILABLE";
    case "ASSET_REGISTRY_INVALID_RESPONSE":
      return "ASSET_GROUP_INVALID_RESPONSE";
    case "ASSET_REGISTRY_REJECTED":
    case "ASSET_REGISTRY_NOT_FOUND":
      return "ASSET_GROUP_REJECTED";
    default:
      return "ASSET_GROUP_FAILED";
  }
}
