import { AppError, BadRequestError } from "../../shared/errors.js";
import type { VolcAssetGroupResolverPort } from "../assets/volcAssetGroups.js";
import {
  VolcAssetRegistryOperationError,
  type ListVolcAssetsResult,
  type VolcAssetRegistryFailureCode,
  type VolcAssetRegistryPort,
} from "../assets/volcAssetRegistry.js";
import {
  SeedanceAssetRegistrationRepository,
  type PreparedRegistration,
  type ProviderFailureAudit,
  type SeedanceRegistrationConfiguration,
} from "./repository.js";
import type {
  SeedanceAssetRegistrationActor,
  SeedanceAssetRegistrationPort,
  SeedanceAssetRegistrationView,
} from "./types.js";

export interface SeedanceAssetRegistrationServiceDependencies {
  repository?: SeedanceAssetRegistrationRepository;
  registry?: VolcAssetRegistryPort;
  assetGroups?: VolcAssetGroupResolverPort;
  configuration?: SeedanceAssetRegistrationRuntimeConfiguration;
}

export interface SeedanceAssetRegistrationRuntimeConfiguration extends SeedanceRegistrationConfiguration {
  enabled: boolean;
  providerReady: boolean;
  assetGroupName: string;
  assetGroupDescription: string;
}

/**
 * CreateAssetGroup / CreateAsset / ListAssets orchestration. Entry points are
 * explicit human actions (存进资产库 / 登记素材) or the single automatic trigger:
 * a media becoming the primary variant (fired as a background task after the
 * flip commits). Never fires as a side effect of quote, submission, or result.
 */
export class SeedanceAssetRegistrationService implements SeedanceAssetRegistrationPort {
  private readonly configuration: SeedanceAssetRegistrationRuntimeConfiguration;
  private readonly registry: VolcAssetRegistryPort;
  private readonly assetGroups: VolcAssetGroupResolverPort;

  constructor(
    private readonly repository: SeedanceAssetRegistrationRepository,
    dependencies: Omit<SeedanceAssetRegistrationServiceDependencies, "repository"> = {},
  ) {
    if (!dependencies.configuration || !dependencies.registry) {
      throw new Error("Seedance asset registration runtime dependencies must be composed explicitly");
    }
    this.configuration = dependencies.configuration;
    this.registry = dependencies.registry;
    this.assetGroups = dependencies.assetGroups ?? configuredGroupOnlyResolver();
  }

  async registerMediaResult(actor: SeedanceAssetRegistrationActor, mediaResultId: string): Promise<SeedanceAssetRegistrationView> {
    const configuration = this.requireReady();
    const prepared = await this.repository.prepareForMediaResult(actor, mediaResultId, configuration);
    return this.resolveGroupAndCreate(actor, prepared);
  }

  async registerAssetMedia(actor: SeedanceAssetRegistrationActor, assetId: string, mediaId: string): Promise<SeedanceAssetRegistrationView> {
    const configuration = this.requireReady();
    const prepared = await this.repository.prepareForAssetMedia(actor, assetId, mediaId, configuration);
    return this.resolveGroupAndCreate(actor, prepared);
  }

  async refreshMediaResult(actor: SeedanceAssetRegistrationActor, mediaResultId: string): Promise<SeedanceAssetRegistrationView> {
    this.requireReady();
    const prepared = await this.repository.getPreparedSourceForMediaResult(actor, mediaResultId);
    return this.refresh(actor, prepared);
  }

  async refreshAssetMedia(actor: SeedanceAssetRegistrationActor, assetId: string, mediaId: string): Promise<SeedanceAssetRegistrationView> {
    this.requireReady();
    const prepared = await this.repository.getPreparedSourceForAssetMedia(actor, assetId, mediaId);
    return this.refresh(actor, prepared);
  }

  async getMediaResult(actor: SeedanceAssetRegistrationActor, mediaResultId: string): Promise<SeedanceAssetRegistrationView> {
    return this.repository.getForMediaResult(actor, mediaResultId);
  }

  async getAssetMedia(actor: SeedanceAssetRegistrationActor, assetId: string, mediaId: string): Promise<SeedanceAssetRegistrationView> {
    return this.repository.getForAssetMedia(actor, assetId, mediaId);
  }

  async getRegistration(
    actor: SeedanceAssetRegistrationActor,
    registrationId: string,
  ): Promise<SeedanceAssetRegistrationView> {
    return this.repository.getForRegistration(actor, registrationId);
  }

  async refreshRegistration(
    actor: SeedanceAssetRegistrationActor,
    registrationId: string,
  ): Promise<SeedanceAssetRegistrationView> {
    this.requireReady();
    const prepared = await this.repository.getPreparedSourceForRegistration(actor, registrationId);
    return this.refresh(actor, prepared);
  }

  private async resolveGroupAndCreate(
    actor: SeedanceAssetRegistrationActor,
    prepared: PreparedRegistration,
  ): Promise<SeedanceAssetRegistrationView> {
    if (prepared.source.assetType !== "Image" && prepared.source.assetType !== "Audio") {
      throw new BadRequestError("当前 CreateAsset 仓库契约只支持图片与音频素材登记");
    }
    const resolution = await this.assetGroups.resolve(actorId(actor), {
      configuredGroupId: prepared.registration.assetGroupId
        ?? this.configuration.assetGroupId
        ?? undefined,
      name: this.configuration.assetGroupName,
      description: this.configuration.assetGroupDescription,
      projectName: prepared.registration.projectName,
    });
    if (resolution.kind === "settling") {
      return this.repository.viewForRegistration(prepared.registration.id, actor);
    }
    if (resolution.kind === "failure") {
      return this.repository.recordGroupFailure(
        prepared.registration.id,
        actor,
        resolution.failure,
        resolution.status,
      );
    }
    const registration = await this.repository.bindAssetGroup(
      prepared.registration.id,
      actor,
      resolution.groupId,
      prepared.registration.projectName,
    );
    return this.createOrRefresh(actor, { ...prepared, registration });
  }

  private async createOrRefresh(actor: SeedanceAssetRegistrationActor, prepared: PreparedRegistration): Promise<SeedanceAssetRegistrationView> {
    if (prepared.source.assetType !== "Image" && prepared.source.assetType !== "Audio") {
      throw new BadRequestError("当前 CreateAsset 仓库契约只支持图片与音频素材登记");
    }
    const claim = await this.repository.claimCreate(prepared.registration.id, actor);
    if (claim.kind === "reuse") {
      return this.repository.recordReuseActive(claim.registration.id, actor);
    }
    if (claim.kind === "refresh") {
      return this.refresh(actor, { ...prepared, registration: claim.registration });
    }
    if (claim.kind === "settling") {
      return this.repository.viewForRegistration(claim.registration.id, actor);
    }
    try {
      if (!claim.registration.assetGroupId) {
        throw new BadRequestError("火山素材组尚未准备完成，未发送素材登记请求");
      }
      const assetName = createAssetName(claim.source.name, claim.source.assetMediaId);
      const submitted = await this.registry.createAsset({
        groupId: claim.registration.assetGroupId,
        url: claim.source.storageUrl,
        assetType: claim.source.assetType,
        projectName: claim.registration.projectName,
        name: assetName,
      });
      return this.repository.recordCreateSubmitted(claim.registration.id, actor, {
        ...submitted,
        assetName,
      });
    } catch (error) {
      const failure = toFailureAudit(error);
      if (isAmbiguousCreateFailure(error)) {
        return this.repository.recordCreateUnknown(claim.registration.id, actor, failure);
      }
      return this.repository.recordCreateFailure(claim.registration.id, actor, failure);
    }
  }

  private async refresh(actor: SeedanceAssetRegistrationActor, prepared: PreparedRegistration): Promise<SeedanceAssetRegistrationView> {
    if (!prepared.registration.remoteAssetId) {
      throw new BadRequestError("素材登记尚未提交到火山，请先点击登记");
    }
    if (!prepared.registration.assetGroupId) {
      throw new BadRequestError("素材登记缺少火山素材组 ID，请联系管理员复核");
    }
    try {
      const result = await findAssetWithList(
        this.registry,
        prepared.registration.remoteAssetId,
        prepared.registration.assetGroupId,
        prepared.registration.projectName,
        prepared.registration.remoteAssetName,
      );
      return this.repository.recordAssetStatus(prepared.registration.id, actor, result);
    } catch (error) {
      return this.repository.recordRefreshFailure(prepared.registration.id, actor, toFailureAudit(error));
    }
  }

  private requireReady(): SeedanceAssetRegistrationRuntimeConfiguration {
    if (!this.configuration.enabled) {
      throw new AppError(
        503,
        "seedance_asset_registration_disabled",
        "火山素材注册尚未开启，未发送任何请求",
      );
    }
    if (!this.configuration.providerReady) {
      throw new AppError(
        503,
        "seedance_asset_registration_unavailable",
        "火山素材注册缺少安全配置，未发送任何请求",
      );
    }
    return this.configuration;
  }
}

function toFailureAudit(error: unknown): ProviderFailureAudit {
  if (error instanceof VolcAssetRegistryOperationError) return error.failure;
  return {
    errorCode: "ASSET_REGISTRY_UNAVAILABLE",
    errorMessage: "火山素材注册服务暂时不可用",
    requestId: null,
    httpStatus: null,
  };
}

function isAmbiguousCreateFailure(error: unknown): boolean {
  if (!(error instanceof VolcAssetRegistryOperationError)) return true;
  return error.outcomeUnknown;
}

const MAX_ASSET_NAME_LENGTH = 64;
const MAX_LIST_PAGES = 10;
const LIST_PAGE_SIZE = 100;

/**
 * RegistrationSource.name is local display text, not provider input. Normalize
 * it before deriving the provider Name so a title cannot
 * inject control characters or an accidental URL into the provider request.
 */
export function createAssetName(sourceName: string, assetMediaId: string): string {
  const normalized = sourceName
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "参考素材")
    .replace(/\s+/g, " ")
    .trim();
  const stableSuffix = ` [${assetMediaId.slice(0, 8)}]`;
  const prefix = truncateText(
    normalized || "短剧图片参考素材",
    MAX_ASSET_NAME_LENGTH - [...stableSuffix].length,
  );
  return `${prefix}${stableSuffix}`;
}

function truncateText(value: string, maximumLength: number): string {
  return [...value].slice(0, maximumLength).join("");
}

async function findAssetWithList(
  registry: VolcAssetRegistryPort,
  assetId: string,
  groupId: string,
  projectName: string,
  assetName: string | null,
): Promise<{
  status: "Active" | "Processing" | "Failed";
  requestId: string | null;
  httpStatus: number;
  errorCode: VolcAssetRegistryFailureCode | null;
  errorMessage: string | null;
}> {
  let pageNumber = 1;
  let lastResult: ListVolcAssetsResult | null = null;
  while (pageNumber <= MAX_LIST_PAGES) {
    const result = await registry.listAssets({
      groupIds: [groupId],
      groupType: "AIGC",
      statuses: ["Active", "Processing", "Failed"],
      ...(assetName ? { name: assetName } : {}),
      pageNumber,
      pageSize: LIST_PAGE_SIZE,
      sortBy: "CreateTime",
      sortOrder: "Desc",
      projectName,
    });
    lastResult = result;
    const matched = result.items.find((item) => item.assetId === assetId);
    if (matched) {
      if (matched.groupId !== groupId || matched.projectName !== projectName) {
        throw new VolcAssetRegistryOperationError(
          {
            errorCode: "ASSET_REGISTRY_IDENTITY_MISMATCH",
            errorMessage: "火山素材回读身份与本地映射不一致",
            requestId: result.requestId,
            httpStatus: result.httpStatus,
          },
          false,
        );
      }
      return {
        status: matched.status,
        requestId: result.requestId,
        httpStatus: result.httpStatus,
        errorCode: matched.errorCode,
        errorMessage: matched.errorMessage,
      };
    }
    if (pageNumber * result.pageSize >= result.totalCount) break;
    pageNumber += 1;
  }
  if (lastResult && pageNumber >= MAX_LIST_PAGES && pageNumber * lastResult.pageSize < lastResult.totalCount) {
    throw new VolcAssetRegistryOperationError(
      {
        errorCode: "ASSET_REGISTRY_QUERY_LIMIT_REACHED",
        errorMessage: "火山素材列表超过受控查询上限，请缩小范围后人工复核",
        requestId: lastResult.requestId,
        httpStatus: lastResult.httpStatus,
      },
      false,
    );
  }
  return {
    status: "Processing",
    requestId: lastResult?.requestId ?? null,
    httpStatus: lastResult?.httpStatus ?? 200,
    errorCode: null,
    errorMessage: null,
  };
}

function actorId(actor: SeedanceAssetRegistrationActor): string {
  return typeof actor === "string" ? actor : actor.id;
}

function configuredGroupOnlyResolver(): VolcAssetGroupResolverPort {
  return {
    async resolve(_actorUserId, configuration) {
      if (!configuration.configuredGroupId) {
        throw new Error("VolcAssetGroupResolver must be injected when no configured group ID exists");
      }
      return { kind: "resolved", groupId: configuration.configuredGroupId, requestId: null };
    },
  };
}
