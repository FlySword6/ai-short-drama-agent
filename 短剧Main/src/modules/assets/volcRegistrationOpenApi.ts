const uuid = { type: "string", format: "uuid" } as const;
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const nullableDateTime = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
} as const;

const registration = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "asset_media_id",
    "volc_asset_group_id",
    "volc_asset_id",
    "status",
    "request_id",
    "retry_count",
    "last_retry_at",
    "last_verified_at",
    "failure",
  ],
  properties: {
    id: uuid,
    asset_media_id: uuid,
    volc_asset_group_id: nullableString,
    volc_asset_id: nullableString,
    status: {
      type: "string",
      enum: ["pending", "submitting", "processing", "active", "failed", "unknown", "unavailable"],
    },
    request_id: nullableString,
    retry_count: { type: "integer", minimum: 0 },
    last_retry_at: nullableDateTime,
    last_verified_at: nullableDateTime,
    failure: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string", description: "可直接展示的稳定中文失败说明。" },
          },
        },
        { type: "null" },
      ],
    },
  },
} as const;

const success = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "data"],
  properties: {
    ok: { type: "boolean", const: true },
    data: {
      type: "object",
      additionalProperties: false,
      required: ["registration"],
      properties: { registration },
    },
  },
} as const;

const errors = {
  400: { type: "object" },
  401: { type: "object" },
  403: { type: "object" },
  404: { type: "object" },
  409: { type: "object" },
  503: { type: "object" },
} as const;

export const volcRegistrationCreateOpenApi = {
  tags: ["assets"],
  summary: "将一个已入 TOS 的本地资产媒体登记到火山素材库",
  body: {
    type: "object",
    additionalProperties: false,
    required: ["asset_id", "asset_media_id"],
    properties: {
      asset_id: uuid,
      asset_media_id: uuid,
    },
  },
  response: { 200: success, ...errors },
} as const;

export const volcRegistrationGetOpenApi = {
  tags: ["assets"],
  summary: "读取本地与火山素材库的登记映射和状态",
  params: {
    type: "object",
    additionalProperties: false,
    required: ["registration_id"],
    properties: { registration_id: uuid },
  },
  response: { 200: success, ...errors },
} as const;

export const volcRegistrationRefreshOpenApi = {
  ...volcRegistrationGetOpenApi,
  summary: "通过 ListAssets 显式回读并刷新火山素材状态",
} as const;
