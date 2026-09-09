import {
  VolcAssetRegistryOperationError,
  type ListVolcAssetsResult,
  type VolcAssetListItem,
  type VolcAssetRegistryPort,
} from "../../assets/volcAssetRegistry.js";
import type { SnapshotARegistrationPort, SnapshotRegistrationReadback } from "../imports/service.js";

export interface VolcSnapshotRegistrationConfiguration {
  assetGroupId: string | null;
  projectName: string;
}

/**
 * Adapts the existing Volc private-asset registration backend to Snapshot A
 * through its public `VolcAssetRegistryPort` only. Snapshot A facts never
 * enter Lite/main-schema asset tables, and this adapter performs no paid
 * generation: only CreateAsset registration and ListAssets readback.
 */
export class VolcSnapshotRegistrationAdapter implements SnapshotARegistrationPort {
  constructor(
    private readonly registry: VolcAssetRegistryPort,
    private readonly configuration: VolcSnapshotRegistrationConfiguration,
  ) {}

  async register(input: { assetId: string; mediaUrl: string; mediaSha256: string; name: string }): Promise<SnapshotRegistrationReadback> {
    try {
      const groupId = requireGroupId(this.configuration, "登记");
      const result = await this.registry.createAsset({
        groupId,
        url: input.mediaUrl,
        assetType: "Image",
        projectName: this.configuration.projectName,
        name: snapshotAssetName(input.name, input.assetId),
      });
      return {
        registrationId: result.assetId,
        status: "processing",
        readback: { action: "CreateAsset", assetId: result.assetId, requestId: result.requestId, httpStatus: result.httpStatus },
      };
    } catch (error) {
      return failureReadback(error);
    }
  }

  async readback(input: { registrationId: string; name: string }): Promise<SnapshotRegistrationReadback> {
    try {
      const groupId = requireGroupId(this.configuration, "回读");
      let pageNumber = 1;
      let result: ListVolcAssetsResult | null = null;
      while (pageNumber <= MAX_LIST_PAGES) {
        result = await this.registry.listAssets({
          groupIds: [groupId], groupType: "AIGC", statuses: ["Active", "Processing", "Failed"],
          pageNumber, pageSize: LIST_PAGE_SIZE, sortBy: "CreateTime", sortOrder: "Desc", projectName: this.configuration.projectName,
        });
        const matched = result.items.find((item) => item.assetId === input.registrationId);
        if (matched) return readbackForMatched(input.registrationId, matched, result);
        if (pageNumber * result.pageSize >= result.totalCount) break;
        pageNumber += 1;
      }
      if (result && pageNumber >= MAX_LIST_PAGES && pageNumber * result.pageSize < result.totalCount) {
        throw new VolcAssetRegistryOperationError({ errorCode: "ASSET_REGISTRY_QUERY_LIMIT_REACHED", errorMessage: "火山素材列表超过受控查询上限，请人工复核", requestId: result.requestId, httpStatus: result.httpStatus }, false);
      }
      return { registrationId: input.registrationId, status: "unknown", failureCode: "ASSET_REGISTRY_NOT_FOUND", failureReason: "火山素材库中未找到目标素材，登记结果仍不明确", readback: { action: "ListAssets", requestId: result?.requestId ?? null, httpStatus: result?.httpStatus ?? null, matched: false } };
    } catch (error) {
      return failureReadback(error, input.registrationId);
    }
  }

  async readbackByName(input: { assetId: string; name: string }): Promise<SnapshotRegistrationReadback> {
    try {
      const groupId = requireGroupId(this.configuration, "按名回读");
      const expectedName = snapshotAssetName(input.name, input.assetId);
      let pageNumber = 1;
      let result: ListVolcAssetsResult | null = null;
      while (pageNumber <= MAX_LIST_PAGES) {
        result = await this.registry.listAssets({
          groupIds: [groupId], groupType: "AIGC", statuses: ["Active", "Processing", "Failed"],
          name: expectedName,
          pageNumber, pageSize: LIST_PAGE_SIZE, sortBy: "CreateTime", sortOrder: "Desc", projectName: this.configuration.projectName,
        });
        const matched = result.items.find((item) => item.name === expectedName);
        if (matched) return readbackForMatched(matched.assetId, matched, result);
        if (pageNumber * result.pageSize >= result.totalCount) break;
        pageNumber += 1;
      }
      if (result && pageNumber >= MAX_LIST_PAGES && pageNumber * result.pageSize < result.totalCount) {
        throw new VolcAssetRegistryOperationError({ errorCode: "ASSET_REGISTRY_QUERY_LIMIT_REACHED", errorMessage: "火山素材列表超过受控查询上限，请人工复核", requestId: result.requestId, httpStatus: result.httpStatus }, false);
      }
      return { registrationId: null, status: "unknown", failureCode: "ASSET_REGISTRY_NOT_FOUND", failureReason: "火山素材库中未找到同名素材，登记结果仍不明确", readback: { action: "ListAssetsByName", requestId: result?.requestId ?? null, httpStatus: result?.httpStatus ?? null, matched: false } };
    } catch (error) {
      return failureReadback(error, null);
    }
  }
}

const MAX_ASSET_NAME_LENGTH = 64;
const MAX_LIST_PAGES = 10;
const LIST_PAGE_SIZE = 100;

function readbackForMatched(registrationId: string, matched: VolcAssetListItem, result: ListVolcAssetsResult): SnapshotRegistrationReadback {
  const readback = { action: "ListAssets", assetId: matched.assetId, status: matched.status, requestId: result.requestId, httpStatus: result.httpStatus };
  if (matched.status === "Active") return { registrationId, status: "active", readback };
  if (matched.status === "Processing") return { registrationId, status: "processing", readback };
  return { registrationId, status: "failed", failureCode: matched.errorCode ?? "ASSET_REGISTRY_PROCESSING_FAILED", failureReason: matched.errorMessage ?? "火山素材登记失败，供应商未返回失败原因", readback };
}

/** Keeps provider names deterministic and safe; the vNext asset id suffix is stable. */
export function snapshotAssetName(sourceName: string, assetId: string): string {
  const normalized = sourceName
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "参考素材")
    .replace(/\s+/g, " ")
    .trim();
  const suffix = ` [${assetId.slice(0, 8)}]`;
  const prefix = [...normalized || "快照参考素材"].slice(0, MAX_ASSET_NAME_LENGTH - [...suffix].length).join("");
  return `${prefix}${suffix}`;
}

function requireGroupId(configuration: VolcSnapshotRegistrationConfiguration, action: string): string {
  if (!configuration.assetGroupId) {
    throw new VolcAssetRegistryOperationError({
      errorCode: "ASSET_REGISTRY_INVALID_REQUEST",
      errorMessage: `火山素材组未配置，未发送任何${action}请求`,
      requestId: null,
      httpStatus: null,
    }, false);
  }
  return configuration.assetGroupId;
}

function failureReadback(error: unknown, registrationId: string | null = null): SnapshotRegistrationReadback {
  if (error instanceof VolcAssetRegistryOperationError) {
    return {
      registrationId,
      status: registrationId || error.outcomeUnknown ? "unknown" : "failed",
      failureCode: error.failure.errorCode,
      failureReason: error.failure.errorMessage,
      readback: { requestId: error.failure.requestId, httpStatus: error.failure.httpStatus },
    };
  }
  return {
    registrationId,
    status: "unknown",
    failureCode: "ASSET_REGISTRY_UNAVAILABLE",
    failureReason: "火山素材注册服务暂时不可用，登记结果不明确",
    readback: null,
  };
}
