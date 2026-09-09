type JsonSchema = Record<string, unknown>;

const uuid = { type: "string", format: "uuid" } as const;
const mediaKind = { type: "string", enum: ["image", "video", "audio"] } as const;

const sessionParams = {
  type: "object",
  additionalProperties: false,
  required: ["session_id"],
  properties: { session_id: uuid },
} as const;

const operationParams = {
  type: "object",
  additionalProperties: false,
  required: ["session_id", "operation_id"],
  properties: {
    session_id: uuid,
    operation_id: uuid,
  },
} as const;

const parameters = {
  type: "object",
  additionalProperties: true,
  propertyNames: {
    enum: [
      "size",
      "ratio",
      "duration_seconds",
      "resolution",
      "generate_audio",
      "sequential_image_generation",
      "original_duration_seconds",
      "format",
      "sample_rate",
      "speech_rate",
      "loudness_rate",
      "pitch_rate",
      "speaker_id",
    ],
  },
  properties: {
    size: { type: "string", description: "命名清晰度或具体宽x高，例如 1024x1024。" },
    ratio: { type: "string" },
    duration_seconds: { type: "integer", minimum: 1 },
    resolution: { type: "string" },
    generate_audio: { type: "boolean" },
    sequential_image_generation: { type: "string", enum: ["auto", "disabled"] },
    original_duration_seconds: { type: "integer", minimum: 1 },
    format: { type: "string", enum: ["mp3", "wav", "pcm"] },
    sample_rate: { type: "integer", minimum: 1 },
    speech_rate: { type: "number" },
    loudness_rate: { type: "number" },
    pitch_rate: { type: "number" },
    speaker_id: { type: "string" },
  },
} as const;

const turnBody = {
  type: "object",
  additionalProperties: true,
  propertyNames: { enum: ["message", "context"] },
  required: ["message", "context"],
  properties: {
    message: { type: "string", minLength: 1, maxLength: 8_000 },
    context: {
      type: "object",
      additionalProperties: true,
      propertyNames: {
        enum: [
          "project_id",
          "episode_id",
          "scene_id",
          "shot_id",
          "selected_asset",
          "reference_media_ids",
        ],
      },
      required: ["project_id"],
      properties: {
        project_id: uuid,
        episode_id: uuid,
        scene_id: uuid,
        shot_id: uuid,
        selected_asset: {
          type: "object",
          additionalProperties: true,
          propertyNames: {
            enum: ["asset_entity_id", "media_id", "media_kind"],
          },
          required: ["asset_entity_id", "media_id", "media_kind"],
          properties: {
            asset_entity_id: uuid,
            media_id: uuid,
            media_kind: mediaKind,
          },
        },
        reference_media_ids: {
          type: "array",
          maxItems: 20,
          uniqueItems: true,
          items: uuid,
          default: [],
        },
      },
    },
  },
} as const;

const requoteBody = {
  type: "object",
  additionalProperties: true,
  propertyNames: { enum: ["tier_id", "parameters"] },
  properties: {
    tier_id: { type: "string", minLength: 1, maxLength: 128 },
    parameters,
  },
} as const;

const publicGenerationParameters = {
  type: "object",
  additionalProperties: true,
  properties: parameters.properties,
} as const;

const scalar = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
} as const;

const target = {
  type: "object",
  additionalProperties: true,
  required: ["placement"],
  properties: {
    placement: {
      type: "string",
      enum: ["attach_to_shot", "project_asset", "replace_asset_variant"],
    },
    asset_entity_id: uuid,
    shot_id: uuid,
  },
} as const;

const parameterControl = {
  type: "object",
  additionalProperties: true,
  required: [
    "key",
    "label",
    "value",
    "default_value",
    "availability",
    "requires_requote",
  ],
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    value: scalar,
    default_value: scalar,
    availability: {
      type: "string",
      enum: [
        "adjustable",
        "fixed_by_tier",
        "frozen_context",
        "not_priced",
        "not_supported",
      ],
    },
    requires_requote: { type: "boolean" },
    options: { type: "array", items: scalar },
    range: {
      type: "object",
      additionalProperties: true,
      required: ["min", "max"],
      properties: {
        min: { type: "number" },
        max: { type: "number" },
        step: { type: "number" },
      },
    },
    note: { type: "string" },
  },
} as const;

const parameterGroup = {
  type: "object",
  additionalProperties: true,
  required: ["key", "label", "controls"],
  properties: {
    key: { type: "string", enum: ["visual", "motion", "audio", "cost"] },
    label: { type: "string" },
    controls: { type: "array", items: parameterControl },
  },
} as const;

const operationQuote = {
  type: "object",
  additionalProperties: true,
  required: [
    "mode",
    "generation_quote_id",
    "estimated_cost_fen",
    "currency",
    "billing_unit",
    "billable_units",
    "expires_at",
    "notice",
  ],
  properties: {
    mode: { type: "string", enum: ["mock", "real"] },
    generation_quote_id: { anyOf: [uuid, { type: "null" }] },
    estimated_cost_fen: {
      type: "integer",
      minimum: 0,
      description: "人民币分（CNY fen），不是积分。",
    },
    currency: { type: "string", const: "CNY" },
    billing_unit: { type: "string" },
    billable_units: { type: "integer", minimum: 1 },
    expires_at: {
      anyOf: [
        { type: "string", format: "date-time" },
        { type: "null" },
      ],
    },
    notice: { type: "string" },
  },
} as const;

const postAction = {
  type: "object",
  additionalProperties: true,
  required: ["method", "endpoint", "label"],
  properties: {
    method: { type: "string", const: "POST" },
    endpoint: { type: "string" },
    label: { type: "string" },
  },
} as const;

const turnData = {
  type: "object",
  additionalProperties: true,
  required: ["turn_id", "status", "assistant_message"],
  properties: {
    turn_id: uuid,
    status: {
      type: "string",
      enum: ["clarification_required", "confirmation_required"],
    },
    assistant_message: { type: "string", description: "可直接展示的中文说明。" },
    clarification: {
      type: "object",
      additionalProperties: true,
      required: ["code", "question"],
      properties: {
        code: {
          type: "string",
          description: "稳定澄清码，例如 media_kind_required、tier_not_priced、trusted_script_required。",
        },
        question: { type: "string" },
        choices: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["value", "label"],
            properties: {
              value: { type: "string" },
              label: { type: "string" },
            },
          },
        },
      },
    },
    operation_card: {
      type: "object",
      additionalProperties: true,
      required: [
        "operation_id",
        "operation_type",
        "input_mode",
        "media_kind",
        "prompt",
        "context",
        "target",
        "references",
        "tier",
        "defaults",
        "parameter_groups",
        "quote",
        "requote",
        "confirmation",
      ],
      properties: {
        operation_id: uuid,
        operation_type: { type: "string", enum: ["generate", "edit"] },
        input_mode: {
          type: "string",
          enum: [
            "text_to_image",
            "image_to_image",
            "text_to_video",
            "image_to_video",
            "video_to_video",
            "text_to_audio",
          ],
        },
        media_kind: mediaKind,
        prompt: { type: "string" },
        context: {
          type: "object",
          additionalProperties: true,
          required: ["project_id"],
          properties: {
            project_id: uuid,
            episode_id: uuid,
            scene_id: uuid,
            shot_id: uuid,
          },
        },
        target,
        references: {
          type: "object",
          additionalProperties: true,
          required: ["media_ids"],
          properties: {
            selected_media_id: uuid,
            media_ids: { type: "array", items: uuid, maxItems: 20 },
          },
        },
        tier: {
          type: "object",
          additionalProperties: true,
          required: ["tier_id", "display_name", "provider_label", "model_label"],
          properties: {
            tier_id: { type: "string" },
            display_name: { type: "string" },
            provider_label: { type: "string" },
            model_label: { type: "string" },
          },
        },
        defaults: publicGenerationParameters,
        parameter_groups: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: parameterGroup,
        },
        quote: operationQuote,
        requote: postAction,
        confirmation: {
          ...postAction,
          required: ["required", "method", "endpoint", "label"],
          properties: {
            ...postAction.properties,
            required: { type: "boolean", const: true },
          },
        },
      },
    },
  },
} as const;

const receiptData = {
  type: "object",
  additionalProperties: true,
  required: [
    "operation_id",
    "status",
    "execution_mode",
    "generation_request_id",
    "attempt_id",
    "target",
    "artifact",
    "ledger",
    "timeline",
    "message",
  ],
  properties: {
    operation_id: uuid,
    status: { type: "string", enum: ["queued", "succeeded"] },
    execution_mode: { type: "string", enum: ["mock", "real"] },
    generation_request_id: {
      anyOf: [uuid, { type: "null" }],
    },
    attempt_id: { type: "string" },
    target,
    artifact: {
      type: "object",
      additionalProperties: true,
      required: ["media_kind", "storage_state", "storage_url"],
      properties: {
        media_kind: mediaKind,
        storage_state: {
          type: "string",
          enum: ["simulated", "persisted", "pending"],
        },
        storage_url: {
          anyOf: [{ type: "string", format: "uri" }, { type: "null" }],
        },
      },
    },
    ledger: {
      type: "object",
      additionalProperties: true,
      required: [
        "estimated_cost_fen",
        "charged_cost_fen",
        "points_spent",
        "currency",
      ],
      properties: {
        estimated_cost_fen: {
          type: "integer",
          minimum: 0,
          description: "人民币分（CNY fen），不是积分。",
        },
        charged_cost_fen: {
          anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
        },
        points_spent: {
          anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
        },
        currency: { type: "string", const: "CNY" },
      },
    },
    timeline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["state", "offset_ms"],
        properties: {
          state: { type: "string", enum: ["accepted", "running", "succeeded"] },
          offset_ms: { type: "integer", minimum: 0 },
        },
      },
    },
    message: { type: "string", description: "可直接展示的中文说明。" },
  },
} as const;

const errorEnvelope = {
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
        code: {
          type: "string",
          example: "assistant_context_mismatch",
          description: [
            "稳定机器错误码。编排路由至少可能返回：bad_request、forbidden、not_found、",
            "assistant_context_mismatch、selected_asset_mismatch、",
            "generation_operation_already_confirmed、real_orchestration_disabled、",
            "generation_orchestration_disabled。",
          ].join(""),
        },
        message: { type: "string", description: "脱敏且可直接展示的中文说明。" },
        retryable: { type: "boolean" },
        details: {},
      },
    },
  },
} as const;

const commonErrors = {
  400: errorEnvelope,
  401: errorEnvelope,
  403: errorEnvelope,
  404: errorEnvelope,
  409: errorEnvelope,
  422: errorEnvelope,
  503: errorEnvelope,
} as const;

function successEnvelope(data: JsonSchema): JsonSchema {
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

export const generationTurnOpenApiSchema = {
  tags: ["generation-orchestration"],
  summary: "把自然语言整理为澄清问题或一张冻结生成操作卡",
  params: sessionParams,
  body: turnBody,
  response: {
    200: successEnvelope(turnData),
    201: successEnvelope(turnData),
    ...commonErrors,
  },
} as const;

export const generationRequoteOpenApiSchema = {
  tags: ["generation-orchestration"],
  summary: "按白名单参数创建新的冻结报价卡，原卡保持不变",
  params: operationParams,
  body: requoteBody,
  response: {
    200: successEnvelope(turnData),
    201: successEnvelope(turnData),
    ...commonErrors,
  },
} as const;

export const generationConfirmOpenApiSchema = {
  tags: ["generation-orchestration"],
  summary: "由人确认一次冻结操作；同一操作重复确认保持幂等",
  params: operationParams,
  response: {
    200: successEnvelope(receiptData),
    202: successEnvelope(receiptData),
    402: errorEnvelope,
    ...commonErrors,
  },
} as const;
