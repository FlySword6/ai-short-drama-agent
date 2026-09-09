import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { settings } from "../../../config/env.js";
import type { Database } from "../../../db/client.js";
import { requireCurrentUser } from "../../../http/authenticate.js";
import { parseRequest, success } from "../../../http/response.js";
import { BadRequestError } from "../../../shared/errors.js";
import { requireAdministrator } from "../../auth/admin.js";
import { createGenerationProviderRegistry } from "../../generation/factory.js";
import {
  requiresV01LegacyVideoPriceFloor,
  V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND,
} from "../../generation/v01Contract.js";
import { DrizzleAdminModelRepository } from "./repository.js";
import { AdminModelService, type AdminModelServicePort } from "./service.js";

const pricingRuleSchema = z.object({
  provider: z.string().trim().min(1).max(32),
  model: z.string().trim().min(1).max(128),
  media_kind: z.enum(["image", "video"]),
  billing_unit: z.enum(["image", "second"]),
  unit_price_fen: z.coerce.number().int().min(1).max(2_147_483_647),
  currency: z.literal("CNY").default("CNY"),
  expected_active_rule_id: z.string().uuid().nullable(),
  source: z.string().trim().min(1).max(512).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((input, context) => {
  if (!((input.media_kind === "image" && input.billing_unit === "image")
    || (input.media_kind === "video" && input.billing_unit === "second"))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "保存单价没成：图片按张填写，视频按秒填写，请修改后再试。",
      path: ["billing_unit"],
    });
  }
  if (!input.metadata?.capability_tier
    && input.provider.toLowerCase() === "ark"
    && input.media_kind === "video"
    && requiresV01LegacyVideoPriceFloor(input.metadata)
    && input.unit_price_fen < V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `保存视频单价没成：单价低于当前允许的最低值，请提高到每秒 ${V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND} 分后再试。`,
      path: ["unit_price_fen"],
    });
  }
});

const pricingRuleListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export interface RegisterAdminModelRoutesOptions {
  adminUsernames?: readonly string[];
  createService?: (database: Database) => AdminModelServicePort;
}

/**
 * Self-contained S2 admin surface. The integrator only needs to call this
 * function from the shared route registry; this module never edits env-backed
 * model availability or performs a provider call.
 */
export async function registerAdminModelRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  options: RegisterAdminModelRoutesOptions = {},
): Promise<void> {
  const adminUsernames = options.adminUsernames ?? settings.adminUsernames;
  const createService = options.createService ?? ((database: Database) => new AdminModelService(
    new DrizzleAdminModelRepository(database),
    createGenerationProviderRegistry(),
  ));
  const requireAdmin = (request: Parameters<typeof requireCurrentUser>[0]) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user, adminUsernames);
    return user;
  };

  app.get("/api/v1/admin/models", async (request) => {
    requireAdmin(request);
    const items = await createService(getDatabase()).listModels();
    return success({ items, count: items.length });
  });

  app.get("/api/v1/admin/pricing-rules", async (request) => {
    requireAdmin(request);
    const query = parseRequest(pricingRuleListQuerySchema, request.query);
    const result = await createService(getDatabase()).listPricingRules(query.page, query.page_size);
    return success({
      items: result.items,
      count: result.total,
      page: query.page,
      page_size: query.page_size,
      has_more: query.page * query.page_size < result.total,
    });
  });

  app.post("/api/v1/admin/pricing-rules", async (request, reply: FastifyReply) => {
    const actor = requireAdmin(request);
    const input = parseRequest(pricingRuleSchema, request.body);
    if (input.metadata?.capability_tier) {
      throw new BadRequestError("保存单价没成：能力档只能使用受控解冻脚本逐档维护。");
    }
    const item = await createService(getDatabase()).replacePricingRule(actor.id, {
      provider: input.provider,
      model: input.model,
      mediaKind: input.media_kind,
      billingUnit: input.billing_unit,
      unitPriceFen: input.unit_price_fen,
      currency: input.currency,
      expectedActiveRuleId: input.expected_active_rule_id,
      source: input.source,
      metadata: input.metadata,
    });
    return reply.code(201).send(success({ item }));
  });
}
