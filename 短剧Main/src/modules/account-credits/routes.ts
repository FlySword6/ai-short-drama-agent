import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { settings } from "../../config/env.js";
import type { Database } from "../../db/client.js";
import { requireCurrentSessionId, requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { AppError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { isAdministrator } from "../auth/types.js";
import { AccountCreditRepository } from "./repository.js";
import { AccountCreditService } from "./service.js";
import { assertPositiveGenerationCredit } from "./generationAccess.js";
import type { AccountCreditActor } from "./types.js";

const idParams = z.object({ id: z.string().uuid() });
const tierParams = z.object({ tier_id: z.string().uuid() });
const codeParams = z.object({ code_id: z.string().uuid() });
const positivePoints = z.coerce.number().int().min(1).max(2_147_483_647);
const nonNegativePoints = z.coerce.number().int().min(0).max(2_147_483_647);
const tierCreateSchema = z.object({ code: z.string(), name: z.string(), grant_points: nonNegativePoints, daily_limit_points: nonNegativePoints }).strict();
const tierUpdateSchema = z.object({ name: z.string().optional(), grant_points: nonNegativePoints.optional(), daily_limit_points: nonNegativePoints.optional(), active: z.boolean().optional() }).strict();
const inviteCodeCreateSchema = z.object({ tier_id: z.string().uuid(), max_redemptions: positivePoints.optional(), expires_at: z.coerce.date().nullable().optional() }).strict();
const inviteCodeUpdateSchema = z.object({ max_redemptions: positivePoints.optional(), expires_at: z.coerce.date().nullable().optional(), active: z.boolean().optional() }).strict();
const policySchema = z.object({ daily_limit_points: nonNegativePoints }).strict();
const adjustSchema = z.object({ amount_points: z.coerce.number().int().min(-2_147_483_647).max(2_147_483_647).refine((value) => value !== 0), reason: z.string().trim().min(1).max(256) }).strict();

export type AccountCreditServicePort = Pick<AccountCreditService,
  "getSummary" | "listInvitationTiers" | "createInvitationTier" | "updateInvitationTier" | "deactivateInvitationTier"
  | "listInviteCodes" | "createInviteCode" | "updateInviteCode" | "deactivateInviteCode"
  | "getSelfRegistrationPolicy" | "updateSelfRegistrationPolicy" | "adjustBalance">;

export interface AccountCreditRouteDependencies {
  createService?: () => AccountCreditServicePort;
  generationPilotCreditGateEnabled?: boolean;
}

/** Integration owner registers this module before generation routes. */
export async function registerAccountCreditRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AccountCreditRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.() ?? new AccountCreditService(new AccountCreditRepository(getDatabase()));
  const generationPilotCreditGateEnabled = dependencies.generationPilotCreditGateEnabled
    ?? settings.generationPilotCreditGateEnabled;
  /**
   * A full estimate is the first paid-task preparation action. Rejecting a
   * zero-balance account here gives the frontend one clear, early message;
   * migration 034 remains the authoritative exact debit/daily-limit guard
   * when a confirmed quote is actually consumed in PostgreSQL.
   */
  app.addHook("preHandler", async (request) => {
    if (!generationPilotCreditGateEnabled || !isPaidGenerationPreparation(request)) return;
    const user = requireCurrentUser(request);
    let summary;
    try {
      summary = await service().getSummary(user.id);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new AppError(503, "account_credit_unavailable", "查看积分没成：积分账户暂时未就绪，请稍后重试。", true);
      }
      throw error;
    }
    assertPositiveGenerationCredit(summary);
  });
  app.get("/api/v1/account-credits/me", async (request) => success(await service().getSummary(requireCurrentUser(request).id)));
  app.get("/api/v1/admin/invite-tiers", async (request) => success({ items: await service().listInvitationTiers(adminActor(request)) }));
  app.post("/api/v1/admin/invite-tiers", async (request, reply) => { const input = parseRequest(tierCreateSchema, request.body); const item = await service().createInvitationTier(adminActor(request), { code: input.code, name: input.name, grantPoints: input.grant_points, dailyLimitPoints: input.daily_limit_points }); return reply.code(201).send(success({ item })); });
  app.patch("/api/v1/admin/invite-tiers/:tier_id", async (request) => { const params = parseRequest(tierParams, request.params); const input = parseRequest(tierUpdateSchema, request.body); return success({ item: await service().updateInvitationTier(adminActor(request), params.tier_id, { ...(input.name === undefined ? {} : { name: input.name }), ...(input.grant_points === undefined ? {} : { grantPoints: input.grant_points }), ...(input.daily_limit_points === undefined ? {} : { dailyLimitPoints: input.daily_limit_points }), ...(input.active === undefined ? {} : { active: input.active }) }) }); });
  app.delete("/api/v1/admin/invite-tiers/:tier_id", async (request) => { const params = parseRequest(tierParams, request.params); await service().deactivateInvitationTier(adminActor(request), params.tier_id); return success({ deactivated: true, id: params.tier_id }); });
  app.get("/api/v1/admin/invite-codes", async (request) => success({ items: await service().listInviteCodes(adminActor(request)) }));
  app.post("/api/v1/admin/invite-codes", async (request, reply) => { const input = parseRequest(inviteCodeCreateSchema, request.body); const result = await service().createInviteCode(adminActor(request), { tierId: input.tier_id, ...(input.max_redemptions === undefined ? {} : { maxRedemptions: input.max_redemptions }), ...(input.expires_at === undefined ? {} : { expiresAt: input.expires_at }) }); return reply.code(201).send(success(result)); });
  app.patch("/api/v1/admin/invite-codes/:code_id", async (request) => { const params = parseRequest(codeParams, request.params); const input = parseRequest(inviteCodeUpdateSchema, request.body); return success({ item: await service().updateInviteCode(adminActor(request), params.code_id, { ...(input.max_redemptions === undefined ? {} : { maxRedemptions: input.max_redemptions }), ...(input.expires_at === undefined ? {} : { expiresAt: input.expires_at }), ...(input.active === undefined ? {} : { active: input.active }) }) }); });
  app.delete("/api/v1/admin/invite-codes/:code_id", async (request) => { const params = parseRequest(codeParams, request.params); await service().deactivateInviteCode(adminActor(request), params.code_id); return success({ deactivated: true, id: params.code_id }); });
  app.get("/api/v1/admin/account-credit-policies/self-registration", async (request) => success({ policy: await service().getSelfRegistrationPolicy(adminActor(request)) }));
  app.patch("/api/v1/admin/account-credit-policies/self-registration", async (request) => { const input = parseRequest(policySchema, request.body); return success({ policy: await service().updateSelfRegistrationPolicy(adminActor(request), { dailyLimitPoints: input.daily_limit_points }) }); });
  app.post("/api/v1/admin/users/:id/account-credits/adjust", async (request) => { const params = parseRequest(idParams, request.params); const input = parseRequest(adjustSchema, request.body); return success({ adjustment: await service().adjustBalance(adminActor(request), params.id, { amountPoints: input.amount_points, reason: input.reason }) }); });
}

function adminActor(request: FastifyRequest): AccountCreditActor {
  const user = requireCurrentUser(request);
  if (!isAdministrator(user.role)) throw new ForbiddenError("管理积分没成：当前账号没有权限，请联系管理员处理。");
  return { userId: user.id, sessionId: requireCurrentSessionId(request) };
}

function isPaidGenerationPreparation(request: FastifyRequest): boolean {
  if (request.method !== "POST") return false;
  const path = request.url.split("?", 1)[0] ?? request.url;
  if (path !== "/api/v1/generations/estimate") return false;
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  // A simple pricing lookup has no account/user scope and remains browsable.
  return typeof value.project_id === "string" || value.action === "retry";
}
