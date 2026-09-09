import {
  ArkAssetRegistryClient,
  ArkAssetRegistryError,
  type ArkAssetRegistryClientOptions,
  type CreateArkAssetGroupInput,
  type CreateArkAssetGroupResult,
  type CreateArkAssetInput,
  type CreateArkAssetResult,
  type ListArkAssetsInput,
  type ListArkAssetsResult,
} from "./arkAssetRegistry.js";
import {
  VolcAssetRegistryOperationError,
  volcAssetRegistryFailureMessage,
  type ListVolcAssetsResult,
  type VolcAssetListItem,
  type VolcAssetRegistryFailure,
  type VolcAssetRegistryFailureCode,
  type VolcAssetRegistryPort,
} from "../modules/assets/volcAssetRegistry.js";

type ArkAssetRegistryAction = "CreateAssetGroup" | "CreateAsset" | "ListAssets";

interface ArkAssetRegistryClientPort {
  createAssetGroup(input: CreateArkAssetGroupInput): Promise<CreateArkAssetGroupResult>;
  createAsset(input: CreateArkAssetInput): Promise<CreateArkAssetResult>;
  listAssets(input: ListArkAssetsInput): Promise<ListArkAssetsResult>;
}

/**
 * Converts Ark-specific result/error semantics into the module-owned registry
 * contract. Business services never inspect Ark error classes or error codes.
 */
export class ArkAssetRegistryAdapter implements VolcAssetRegistryPort {
  constructor(private readonly client: ArkAssetRegistryClientPort) {}

  async createAssetGroup(
    input: Parameters<VolcAssetRegistryPort["createAssetGroup"]>[0],
  ): ReturnType<VolcAssetRegistryPort["createAssetGroup"]> {
    return this.call("CreateAssetGroup", () => this.client.createAssetGroup(input));
  }

  async createAsset(
    input: Parameters<VolcAssetRegistryPort["createAsset"]>[0],
  ): ReturnType<VolcAssetRegistryPort["createAsset"]> {
    return this.call("CreateAsset", () => this.client.createAsset(input));
  }

  async listAssets(
    input: Parameters<VolcAssetRegistryPort["listAssets"]>[0],
  ): ReturnType<VolcAssetRegistryPort["listAssets"]> {
    const result = await this.call("ListAssets", () => this.client.listAssets(input));
    return normalizeListResult(result);
  }

  private async call<T>(action: ArkAssetRegistryAction, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw normalizeArkFailure(action, error);
    }
  }
}

export function createArkAssetRegistryAdapter(
  options: ArkAssetRegistryClientOptions,
): VolcAssetRegistryPort {
  return new ArkAssetRegistryAdapter(new ArkAssetRegistryClient(options));
}

function normalizeArkFailure(
  action: ArkAssetRegistryAction,
  error: unknown,
): VolcAssetRegistryOperationError {
  if (!(error instanceof ArkAssetRegistryError)) {
    return new VolcAssetRegistryOperationError(
      {
        errorCode: "ASSET_REGISTRY_UNAVAILABLE",
        errorMessage: "火山素材注册服务暂时不可用",
        requestId: null,
        httpStatus: null,
      },
      action !== "ListAssets",
    );
  }

  const errorCode = normalizeProviderFailureCode(
    error.errorCode,
    error.providerHttpStatus,
  );
  const failure: VolcAssetRegistryFailure = {
    errorCode,
    errorMessage: volcAssetRegistryFailureMessage(errorCode),
    requestId: error.requestId,
    httpStatus: error.providerHttpStatus,
  };
  return new VolcAssetRegistryOperationError(
    failure,
    action !== "ListAssets" && isUnknownWriteOutcome(action, error),
  );
}

function isUnknownWriteOutcome(
  action: Exclude<ArkAssetRegistryAction, "ListAssets">,
  error: ArkAssetRegistryError,
): boolean {
  const missingIdCode = action === "CreateAssetGroup"
    ? "MISSING_ASSET_GROUP_ID"
    : "MISSING_ASSET_ID";
  return error.errorCode === "ARK_REQUEST_FAILED"
    || error.errorCode === "INVALID_ARK_RESPONSE"
    || error.errorCode === missingIdCode
    || (error.providerHttpStatus ?? 0) >= 500;
}

function normalizeListResult(result: ListArkAssetsResult): ListVolcAssetsResult {
  return {
    ...result,
    items: result.items.map((item): VolcAssetListItem => {
      if (item.status !== "Failed") {
        return {
          ...item,
          errorCode: null,
          errorMessage: null,
        };
      }
      const errorCode = normalizeListItemFailureCode(item.errorCode);
      return {
        ...item,
        errorCode,
        errorMessage: volcAssetRegistryFailureMessage(errorCode),
      };
    }),
  };
}

function normalizeProviderFailureCode(
  rawCode: string,
  httpStatus: number | null,
): VolcAssetRegistryFailureCode {
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (
    code === "INVALID_ASSET_REGISTRY_INPUT"
    || code.includes("INVALID_PARAMETER")
    || code.includes("INVALIDPARAMETER")
    || code.includes("INVALID_REQUEST")
    || code.includes("INVALIDREQUEST")
  ) {
    return "ASSET_REGISTRY_INVALID_REQUEST";
  }
  if (
    httpStatus === 401
    || httpStatus === 403
    || code.includes("ACCESSDENIED")
    || code.includes("ACCESS_DENIED")
    || code.includes("UNAUTHORIZED")
    || code.includes("FORBIDDEN")
  ) {
    return "ASSET_REGISTRY_ACCESS_DENIED";
  }
  if (
    httpStatus === 429
    || code.includes("THROTTL")
    || code.includes("RATE_LIMIT")
    || code.includes("TOO_MANY_REQUEST")
    || code.includes("TOOMANYREQUEST")
  ) {
    return "ASSET_REGISTRY_RATE_LIMITED";
  }
  if (
    httpStatus === 404
    || code.includes("NOT_FOUND")
    || code.includes("NOTFOUND")
  ) {
    return "ASSET_REGISTRY_NOT_FOUND";
  }
  if (
    code === "INVALID_ARK_RESPONSE"
    || code.startsWith("MISSING_ASSET_")
    || code.startsWith("INVALID_ASSET_LIST")
  ) {
    return "ASSET_REGISTRY_INVALID_RESPONSE";
  }
  if (
    code === "ARK_REQUEST_FAILED"
    || code === "MISSING_ASSET_CREDENTIALS"
    || (httpStatus ?? 0) >= 500
  ) {
    return "ASSET_REGISTRY_UNAVAILABLE";
  }
  return "ASSET_REGISTRY_REJECTED";
}

function normalizeListItemFailureCode(
  rawCode: string | null,
): VolcAssetRegistryFailureCode {
  if (!rawCode) return "ASSET_REGISTRY_PROCESSING_FAILED";
  const normalized = normalizeProviderFailureCode(rawCode, null);
  return normalized === "ASSET_REGISTRY_REJECTED"
    ? "ASSET_REGISTRY_PROCESSING_FAILED"
    : normalized;
}
