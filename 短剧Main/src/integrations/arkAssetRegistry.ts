import { signArkV4Request } from "./volcSignatureV4.js";
import { AppError } from "../shared/errors.js";
import { isRecord } from "../shared/json.js";

const DEFAULT_ENDPOINT = "https://ark.cn-beijing.volcengineapi.com/";
const DEFAULT_REGION = "cn-beijing";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_SAFE_PROVIDER_MESSAGE_LENGTH = 512;
const MAX_ASSET_NAME_LENGTH = 64;
const MAX_ASSET_GROUP_NAME_LENGTH = 64;
const MAX_ASSET_GROUP_DESCRIPTION_LENGTH = 300;
const MAX_LIST_GROUP_IDS = 100;

export type ArkAssetType = "Image" | "Video" | "Audio";
/** CreateAsset submission is restricted to image and primary-variant audio. */
export type CreateArkAssetType = "Image" | "Audio";
/** Explicit non-usable provider states are retained instead of being treated
 * as Active. Unknown protocol values still throw and become local unknown. */
export type ArkAssetStatus = "Active" | "Processing" | "Failed" | "Removed" | "Revoked" | "Unavailable";
export type ArkListAssetStatus = Extract<ArkAssetStatus, "Active" | "Processing" | "Failed">;
export type ArkAssetRegistryFetch = typeof fetch;

/**
 * Runtime configuration for Ark's private-asset OpenAPI.
 *
 * The caller owns configuration loading. Keeping it explicit makes it
 * impossible for this adapter to accidentally read a differently-scoped
 * credential or emit it through logs.
 */
export interface ArkAssetRegistryClientOptions {
  accessKeyId: string;
  secretAccessKey: string;
  securityToken?: string;
  endpoint?: string;
  region?: string;
  timeoutMs?: number;
  fetchImpl?: ArkAssetRegistryFetch;
}

export interface CreateArkAssetInput {
  groupId: string;
  url: string;
  /**
   * DC repository contract: image and primary-variant audio are the only
   * CreateAsset types this client may submit (2026-08-19). Video stays out.
   */
  assetType: CreateArkAssetType;
  projectName: string;
  name: string;
}

export interface CreateArkAssetResult {
  assetId: string;
  requestId: string | null;
  httpStatus: number;
  errorCode: null;
  errorMessage: null;
}

export interface CreateArkAssetGroupInput {
  name: string;
  description: string;
  groupType: "AIGC";
  projectName: string;
}

export interface CreateArkAssetGroupResult {
  groupId: string;
  requestId: string | null;
  httpStatus: number;
}

export interface GetArkAssetInput {
  assetId: string;
  projectName?: string;
}

export interface GetArkAssetResult {
  status: ArkAssetStatus;
  requestId: string | null;
  httpStatus: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ListArkAssetsInput {
  groupIds: string[];
  groupType?: "AIGC" | "LivenessFace";
  statuses?: ArkListAssetStatus[];
  name?: string;
  pageNumber?: number;
  pageSize?: number;
  sortBy?: "CreateTime" | "UpdateTime" | "GroupId";
  sortOrder?: "Desc" | "Asc";
  projectName: string;
}

export interface ArkAssetListItem {
  assetId: string;
  name: string;
  groupId: string;
  assetType: ArkAssetType;
  status: ArkListAssetStatus;
  errorCode: string | null;
  errorMessage: string | null;
  projectName: string;
  createTime: string;
  updateTime: string;
  lastInferenceTime: string | null;
}

export interface ListArkAssetsResult {
  items: ArkAssetListItem[];
  totalCount: number;
  pageNumber: number;
  pageSize: number;
  requestId: string | null;
  httpStatus: number;
}

/**
 * A deliberately small, safe provider error surface. In particular, request
 * headers, source URLs, AK/SK and raw provider bodies are never retained here.
 */
export class ArkAssetRegistryError extends AppError {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly requestId: string | null,
    statusCode: number,
    retryable: boolean,
    readonly providerHttpStatus: number | null = null,
  ) {
    super(
      statusCode,
      "ark_asset_registry_failed",
      sanitizeProviderMessage(message, "Ark 素材注册请求失败"),
      retryable,
      { errorCode, requestId },
    );
    this.name = "ArkAssetRegistryError";
  }
}

/**
 * Signed client for Ark's private-asset OpenAPI.
 *
 * It is intentionally an integration adapter only: it neither persists local
 * state nor retries. The service layer decides when a human-triggered
 * registration/poll action is appropriate and records its audit trail.
 */
export class ArkAssetRegistryClient {
  private readonly endpoint: string;
  private readonly region: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: ArkAssetRegistryFetch;

  constructor(private readonly options: ArkAssetRegistryClientOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.region = nonEmpty(options.region) ?? DEFAULT_REGION;
    this.timeoutMs = normalizeTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Creates one AIGC asset group. Idempotency is owned by the database service. */
  async createAssetGroup(input: CreateArkAssetGroupInput): Promise<CreateArkAssetGroupResult> {
    const response = await this.call("CreateAssetGroup", {
      Name: requireBoundedText(input.name, "Name", MAX_ASSET_GROUP_NAME_LENGTH),
      Description: requireBoundedText(
        input.description,
        "Description",
        MAX_ASSET_GROUP_DESCRIPTION_LENGTH,
      ),
      GroupType: requireAigcGroupType(input.groupType),
      ProjectName: requireNonEmpty(input.projectName, "ProjectName"),
    });
    const groupId = providerIdAt(response.payload);
    if (!groupId) {
      throw invalidProviderResponse(
        "MISSING_ASSET_GROUP_ID",
        "Ark CreateAssetGroup 响应未包含素材组 ID",
        response.requestId,
      );
    }
    return {
      groupId,
      requestId: response.requestId,
      httpStatus: response.httpStatus,
    };
  }

  /** Registers exactly one publicly accessible image or primary-variant audio. */
  async createAsset(input: CreateArkAssetInput): Promise<CreateArkAssetResult> {
    const body: Record<string, unknown> = {
      GroupId: requireNonEmpty(input.groupId, "GroupId"),
      URL: requirePublicHttpUrl(input.url),
      Name: requireBoundedText(input.name, "Name", MAX_ASSET_NAME_LENGTH),
      AssetType: requireCreateAssetType(input.assetType),
      ProjectName: requireNonEmpty(input.projectName, "ProjectName"),
    };

    const response = await this.call("CreateAsset", body);
    const assetId = providerIdAt(response.payload);
    if (!assetId) {
      throw invalidProviderResponse(
        "MISSING_ASSET_ID",
        "Ark CreateAsset 响应未包含素材 ID",
        response.requestId,
      );
    }
    return {
      assetId,
      requestId: response.requestId,
      httpStatus: response.httpStatus,
      errorCode: null,
      errorMessage: null,
    };
  }

  /** Lists one bounded page. Callers own exact-ID matching and pagination. */
  async listAssets(input: ListArkAssetsInput): Promise<ListArkAssetsResult> {
    const groupIds = requireGroupIds(input.groupIds);
    const filter: Record<string, unknown> = { GroupIds: groupIds };
    if (input.groupType !== undefined) filter.GroupType = requireListGroupType(input.groupType);
    if (input.statuses !== undefined) filter.Statuses = requireListStatuses(input.statuses);
    if (input.name !== undefined) {
      filter.Name = requireBoundedText(input.name, "Filter.Name", MAX_ASSET_NAME_LENGTH);
    }
    const pageNumber = boundedInteger(input.pageNumber ?? 1, "PageNumber", 1, Number.MAX_SAFE_INTEGER);
    const pageSize = boundedInteger(input.pageSize ?? 100, "PageSize", 1, 100);
    const sortBy = input.sortBy ?? "CreateTime";
    const sortOrder = input.sortOrder ?? "Desc";
    const response = await this.call("ListAssets", {
      Filter: filter,
      PageNumber: pageNumber,
      PageSize: pageSize,
      SortBy: requireSortBy(sortBy),
      SortOrder: requireSortOrder(sortOrder),
      ProjectName: requireNonEmpty(input.projectName, "ProjectName"),
    });
    const result = recordAtEither(response.payload, "Result", "result");
    const rawItems = arrayAtEither(result, "Items", "items");
    const totalCount = integerAtEither(result, "TotalCount", "totalCount");
    const returnedPageNumber = integerAtEither(result, "PageNumber", "pageNumber");
    const returnedPageSize = integerAtEither(result, "PageSize", "pageSize");
    if (
      !rawItems
      || totalCount === null
      || returnedPageNumber === null
      || returnedPageSize === null
      || totalCount < 0
      || returnedPageNumber < 1
      || returnedPageSize < 1
      || returnedPageSize > 100
    ) {
      throw invalidProviderResponse(
        "INVALID_ASSET_LIST",
        "Ark ListAssets 响应缺少可用的分页结果",
        response.requestId,
      );
    }
    return {
      items: rawItems.map((item) => parseListItem(item, response.requestId)),
      totalCount,
      pageNumber: returnedPageNumber,
      pageSize: returnedPageSize,
      requestId: response.requestId,
      httpStatus: response.httpStatus,
    };
  }

  /** Reads the asynchronous processing state of an already registered asset. */
  async getAsset(input: GetArkAssetInput): Promise<GetArkAssetResult> {
    const body: Record<string, string> = {
      Id: requireNonEmpty(input.assetId, "Id"),
    };
    const projectName = nonEmpty(input.projectName);
    if (projectName) body.ProjectName = projectName;

    const response = await this.call("GetAsset", body);
    const result = recordAtEither(response.payload, "Result", "result");
    const status = stringAtEither(result, "Status", "status");
    if (!isArkAssetStatus(status)) {
      throw invalidProviderResponse(
        "INVALID_ASSET_STATUS",
        "Ark GetAsset 响应未包含可用的素材状态",
        response.requestId,
      );
    }
    const resultError = recordAt(result, "Error");
    return {
      status,
      requestId: response.requestId,
      httpStatus: response.httpStatus,
      errorCode: safeProviderCode(stringAt(resultError, "Code")),
      errorMessage: safeProviderOptionalMessage(stringAt(resultError, "Message")),
    };
  }

  private async call(
    action: "CreateAssetGroup" | "CreateAsset" | "GetAsset" | "ListAssets",
    payload: Record<string, unknown>,
  ): Promise<{ payload: Record<string, unknown>; requestId: string | null; httpStatus: number }> {
    const accessKeyId = requireCredential(this.options.accessKeyId, "access key");
    const secretAccessKey = requireCredential(this.options.secretAccessKey, "secret access key");
    const body = JSON.stringify(payload);
    const securityToken = nonEmpty(this.options.securityToken);
    const signed = signArkV4Request({
      action,
      body,
      accessKeyId,
      secretAccessKey,
      ...(securityToken ? { securityToken } : {}),
      endpoint: this.endpoint,
      region: this.region,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(signed.url, {
        method: "POST",
        headers: signed.headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Do not include a fetch error: implementations often include a request
      // URL or transport diagnostics in that message.
      throw new ArkAssetRegistryError(
        "ARK_REQUEST_FAILED",
        "Ark 素材注册服务暂时不可用",
        null,
        502,
        true,
      );
    }

    let rawPayload: unknown;
    try {
      rawPayload = await response.json();
    } catch {
      throw new ArkAssetRegistryError(
        "INVALID_ARK_RESPONSE",
        "Ark 素材注册服务返回了无法识别的响应",
        null,
        502,
        response.status >= 500,
        response.status,
      );
    }
    if (!isRecord(rawPayload)) {
      throw new ArkAssetRegistryError(
        "INVALID_ARK_RESPONSE",
        "Ark 素材注册服务返回了无法识别的响应",
        null,
        502,
        response.status >= 500,
        response.status,
      );
    }

    const metadata = recordAtEither(rawPayload, "ResponseMetadata", "responseMetadata");
    const requestId = safeRequestId(stringAt(metadata, "RequestId"));
    const envelopeError = recordAt(metadata, "Error");
    if (envelopeError) {
      throw new ArkAssetRegistryError(
        safeProviderCode(stringAt(envelopeError, "Code")) ?? "ARK_ERROR",
        safeProviderOptionalMessage(stringAt(envelopeError, "Message"))
          ?? "Ark 素材注册请求失败",
        requestId,
        response.status >= 400 && response.status < 500 ? 400 : 502,
        response.status >= 500,
        response.status,
      );
    }
    if (!response.ok) {
      throw new ArkAssetRegistryError(
        `HTTP_${response.status}`,
        `Ark 素材注册请求失败（HTTP ${response.status}）`,
        requestId,
        response.status >= 400 && response.status < 500 ? 400 : 502,
        response.status >= 500,
        response.status,
      );
    }
    return { payload: rawPayload, requestId, httpStatus: response.status };
  }
}

function normalizeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("non-https endpoint");
    return url.toString();
  } catch {
    throw invalidInput("Ark 素材注册服务地址必须是 HTTPS URL");
  }
}

function normalizeTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw invalidInput("Ark 素材注册超时必须在 1 到 120000 毫秒之间");
  }
  return value;
}

function requirePublicHttpUrl(value: string): string {
  const normalized = requireNonEmpty(value, "URL");
  try {
    const parsed = new URL(normalized);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || isLocalOrPrivateHostname(parsed.hostname)
    ) throw new Error("not public https");
    return parsed.toString();
  } catch {
    throw invalidInput("URL 必须是火山服务可访问的公共 HTTPS 地址");
  }
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost"
    || normalized === "::1"
    || normalized.endsWith(".local")
    || normalized.endsWith(".localhost")
  ) return true;
  const octets = normalized.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd")
      || normalized.startsWith("fe8") || normalized.startsWith("fe9")
      || normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  const [first, second] = octets as [number, number, number, number];
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function requireCreateAssetType(value: CreateArkAssetType): CreateArkAssetType {
  if (value === "Image" || value === "Audio") return value;
  throw invalidInput("当前 CreateAsset 仓库契约只支持 AssetType=Image 或 Audio");
}

function requireAigcGroupType(value: "AIGC"): "AIGC" {
  if (value === "AIGC") return value;
  throw invalidInput("当前素材组只支持 GroupType=AIGC");
}

function requireListGroupType(value: "AIGC" | "LivenessFace"): "AIGC" | "LivenessFace" {
  if (value === "AIGC" || value === "LivenessFace") return value;
  throw invalidInput("ListAssets GroupType 不受支持");
}

function requireListStatuses(value: ArkListAssetStatus[]): ArkListAssetStatus[] {
  const statuses = [...new Set(value)];
  if (statuses.length === 0 || statuses.some((status) => !isListArkAssetStatus(status))) {
    throw invalidInput("ListAssets Statuses 必须包含 Active、Processing 或 Failed");
  }
  return statuses;
}

function requireGroupIds(value: string[]): string[] {
  const groupIds = [...new Set(value.map((item) => requireNonEmpty(item, "Filter.GroupIds")))];
  if (groupIds.length === 0 || groupIds.length > MAX_LIST_GROUP_IDS) {
    throw invalidInput(`Filter.GroupIds 数量必须在 1 到 ${MAX_LIST_GROUP_IDS} 之间`);
  }
  return groupIds;
}

function requireSortBy(value: string): "CreateTime" | "UpdateTime" | "GroupId" {
  if (value === "CreateTime" || value === "UpdateTime" || value === "GroupId") return value;
  throw invalidInput("ListAssets SortBy 不受支持");
}

function requireSortOrder(value: string): "Desc" | "Asc" {
  if (value === "Desc" || value === "Asc") return value;
  throw invalidInput("ListAssets SortOrder 不受支持");
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = nonEmpty(value);
  if (!normalized) throw invalidInput(`${label} 不能为空`);
  return normalized;
}

function requireBoundedText(value: string, label: string, maximumLength: number): string {
  const normalized = requireNonEmpty(value, label);
  if ([...normalized].length > maximumLength) {
    throw invalidInput(`${label} 长度不能超过 ${maximumLength} 个字符`);
  }
  return normalized;
}

function requireCredential(value: string, label: string): string {
  const credential = nonEmpty(value);
  if (!credential) {
    throw new ArkAssetRegistryError(
      "MISSING_ASSET_CREDENTIALS",
      `Ark 素材注册 ${label} 未配置`,
      null,
      503,
      false,
    );
  }
  return credential;
}

function invalidInput(message: string): ArkAssetRegistryError {
  return new ArkAssetRegistryError("INVALID_ASSET_REGISTRY_INPUT", message, null, 400, false);
}

function invalidProviderResponse(
  errorCode: string,
  message: string,
  requestId: string | null,
): ArkAssetRegistryError {
  return new ArkAssetRegistryError(errorCode, message, requestId, 502, false);
}

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return isRecord(candidate) ? candidate : null;
}

/**
 * The DC repository contract explicitly permits only these four casing
 * combinations. Do not widen this parser with fuzzy key matching: a missing
 * Asset ID must stop the local state machine rather than look successful.
 */
function providerIdAt(payload: Record<string, unknown>): string | null {
  for (const resultKey of ["Result", "result"] as const) {
    const result = recordAt(payload, resultKey);
    for (const idKey of ["Id", "id"] as const) {
      const assetId = stringAt(result, idKey);
      if (assetId) return assetId;
    }
  }
  return null;
}

function recordAtEither(value: unknown, primary: string, compatible: string): Record<string, unknown> | null {
  return recordAt(value, primary) ?? recordAt(value, compatible);
}

function stringAt(value: Record<string, unknown> | null, key: string): string | null {
  if (!value) return null;
  const candidate = value[key];
  return nonEmpty(typeof candidate === "string" ? candidate : undefined);
}

function stringAtEither(value: Record<string, unknown> | null, primary: string, compatible: string): string | null {
  return stringAt(value, primary) ?? stringAt(value, compatible);
}

function arrayAtEither(
  value: Record<string, unknown> | null,
  primary: string,
  compatible: string,
): unknown[] | null {
  if (!value) return null;
  const candidate = value[primary] ?? value[compatible];
  return Array.isArray(candidate) ? candidate : null;
}

function integerAtEither(
  value: Record<string, unknown> | null,
  primary: string,
  compatible: string,
): number | null {
  if (!value) return null;
  const candidate = value[primary] ?? value[compatible];
  return typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : null;
}

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isArkAssetStatus(value: string | null): value is ArkAssetStatus {
  return value === "Active" || value === "Processing" || value === "Failed"
    || value === "Removed" || value === "Revoked" || value === "Unavailable";
}

function isListArkAssetStatus(value: string | null): value is ArkListAssetStatus {
  return value === "Active" || value === "Processing" || value === "Failed";
}

function isArkAssetType(value: string | null): value is ArkAssetType {
  return value === "Image" || value === "Video" || value === "Audio";
}

function parseListItem(value: unknown, requestId: string | null): ArkAssetListItem {
  if (!isRecord(value)) {
    throw invalidProviderResponse("INVALID_ASSET_LIST_ITEM", "Ark ListAssets 返回了无效素材项", requestId);
  }
  const assetId = stringAtEither(value, "Id", "id");
  const name = stringAtEither(value, "Name", "name");
  const groupId = stringAtEither(value, "GroupId", "groupId");
  const assetType = stringAtEither(value, "AssetType", "assetType");
  const status = stringAtEither(value, "Status", "status");
  const projectName = stringAtEither(value, "ProjectName", "projectName");
  const createTime = stringAtEither(value, "CreateTime", "createTime");
  const updateTime = stringAtEither(value, "UpdateTime", "updateTime");
  if (
    !assetId
    || !name
    || !groupId
    || !isArkAssetType(assetType)
    || !isListArkAssetStatus(status)
    || !projectName
    || !createTime
    || !updateTime
  ) {
    throw invalidProviderResponse(
      "INVALID_ASSET_LIST_ITEM",
      "Ark ListAssets 素材项缺少可用身份或状态",
      requestId,
    );
  }
  const itemError = recordAtEither(value, "Error", "error");
  return {
    assetId,
    name,
    groupId,
    assetType,
    status,
    errorCode: safeProviderCode(stringAtEither(itemError, "Code", "code")),
    errorMessage: safeProviderOptionalMessage(stringAtEither(itemError, "Message", "message")),
    projectName,
    createTime,
    updateTime,
    lastInferenceTime: stringAtEither(value, "LastInferenceTime", "lastInferenceTime"),
  };
}

function safeRequestId(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 128) || null;
}

function safeProviderCode(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || null;
}

function safeProviderOptionalMessage(value: string | null): string | null {
  return value ? sanitizeProviderMessage(value, "Ark 素材注册请求失败") : null;
}

function sanitizeProviderMessage(value: string, fallback: string): string {
  const normalized = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[已隐藏地址]")
    .replace(
      /\b(authorization|x-api-key|x-security-token|access[_ -]?key(?:[_ -]?id)?|secret[_ -]?access[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi,
      (_match, label: string) => `${label}=[已隐藏]`,
    )
    .replace(/\b(authorization|x-api-key|x-security-token|access[_ -]?key(?:[_ -]?id)?|secret[_ -]?access[_ -]?key|credential|token)\b/gi, "[已隐藏字段]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SAFE_PROVIDER_MESSAGE_LENGTH);
  return normalized || fallback;
}
