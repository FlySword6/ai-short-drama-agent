import {
  PLATFORM_ROLES,
  PROJECT_PRODUCTION_ROLES,
  PROJECT_ROLES,
} from "./types.js";

type JsonSchema = Record<string, unknown>;

const uuidSchema = {
  type: "string",
  format: "uuid",
} as const;

const nullableUuidSchema = {
  anyOf: [uuidSchema, { type: "null" }],
} as const;

const projectRoleSchema = {
  type: "string",
  enum: [...PROJECT_ROLES],
} as const;

const productionRolesSchema = {
  type: "array",
  uniqueItems: true,
  maxItems: PROJECT_PRODUCTION_ROLES.length,
  items: {
    type: "string",
    enum: [...PROJECT_PRODUCTION_ROLES],
  },
  description: "项目生产职责；可多选，不授予项目访问、成员管理、付费生成或平台通用资产审核权限。",
} as const;

const projectParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["project_id"],
  properties: {
    project_id: uuidSchema,
  },
} as const;

const projectMemberParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["project_id", "user_id"],
  properties: {
    project_id: uuidSchema,
    user_id: uuidSchema,
  },
} as const;

const projectMemberSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "project_id",
    "user_id",
    "username",
    "display_name",
    "platform_role",
    "project_role",
    "production_roles",
    "added_by_user_id",
    "created_at",
  ],
  properties: {
    project_id: uuidSchema,
    user_id: uuidSchema,
    username: { type: "string" },
    display_name: { type: "string" },
    platform_role: {
      type: "string",
      enum: [...PLATFORM_ROLES],
    },
    project_role: projectRoleSchema,
    production_roles: productionRolesSchema,
    added_by_user_id: nullableUuidSchema,
    created_at: {
      type: "string",
      format: "date-time",
    },
  },
} as const;

const errorEnvelopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "error"],
  properties: {
    ok: { type: "boolean", const: false },
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "retryable", "details"],
      properties: {
        code: { type: "string" },
        message: { type: "string", description: "可直接展示的中文错误说明。" },
        retryable: { type: "boolean" },
        details: {},
      },
    },
  },
} as const;

const memberErrors = {
  400: errorEnvelopeSchema,
  401: errorEnvelopeSchema,
  403: errorEnvelopeSchema,
  404: errorEnvelopeSchema,
  409: errorEnvelopeSchema,
} as const;

function successEnvelopeSchema(data: JsonSchema): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ok", "data"],
    properties: {
      ok: { type: "boolean", const: true },
      data,
    },
  };
}

export const capabilitiesOpenApiSchema = {
  tags: ["operations"],
  summary: "读取当前账号的平台权限、项目访问角色与生产职责",
  response: {
    200: successEnvelopeSchema({
      type: "object",
      additionalProperties: false,
      required: ["platform_role", "allow_member_create_project", "projects", "permissions"],
      properties: {
        platform_role: {
          type: "string",
          enum: [...PLATFORM_ROLES],
        },
        allow_member_create_project: { type: "boolean" },
        projects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["project_id", "role", "production_roles"],
            properties: {
              project_id: uuidSchema,
              role: projectRoleSchema,
              production_roles: productionRolesSchema,
            },
          },
        },
        permissions: {
          type: "array",
          items: { type: "string" },
        },
      },
    }),
    401: errorEnvelopeSchema,
  },
} as const;

export const projectMemberListOpenApiSchema = {
  tags: ["operations"],
  summary: "列出项目成员及其访问角色和生产职责",
  params: projectParamsSchema,
  response: {
    200: successEnvelopeSchema({
      type: "object",
      additionalProperties: false,
      required: ["items", "count"],
      properties: {
        items: {
          type: "array",
          items: projectMemberSchema,
        },
        count: {
          type: "integer",
          minimum: 0,
        },
      },
    }),
    ...memberErrors,
  },
} as const;

export const projectMemberCreateOpenApiSchema = {
  tags: ["operations"],
  summary: "新增或更新项目成员",
  params: projectParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    required: ["user_id", "role"],
    properties: {
      user_id: uuidSchema,
      role: projectRoleSchema,
      production_roles: productionRolesSchema,
    },
  },
  response: {
    201: successEnvelopeSchema({
      type: "object",
      additionalProperties: false,
      required: ["item"],
      properties: {
        item: projectMemberSchema,
      },
    }),
    ...memberErrors,
  },
} as const;

export const projectMemberUpdateOpenApiSchema = {
  tags: ["operations"],
  summary: "修改项目成员的访问角色或生产职责",
  params: projectMemberParamsSchema,
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      role: projectRoleSchema,
      production_roles: productionRolesSchema,
    },
  },
  response: {
    200: successEnvelopeSchema({
      type: "object",
      additionalProperties: false,
      required: ["item"],
      properties: {
        item: projectMemberSchema,
      },
    }),
    ...memberErrors,
  },
} as const;

export const projectMemberDeleteOpenApiSchema = {
  tags: ["operations"],
  summary: "移除项目成员",
  params: projectMemberParamsSchema,
  response: {
    200: successEnvelopeSchema({
      type: "object",
      additionalProperties: false,
      required: ["deleted", "user_id"],
      properties: {
        deleted: { type: "boolean", const: true },
        user_id: uuidSchema,
      },
    }),
    ...memberErrors,
  },
} as const;
