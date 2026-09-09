import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { pricingRules } from "../../../db/schema.js";
import { BadRequestError, ConflictError } from "../../../shared/errors.js";
import { generationPricingLockKey } from "../../generation/cost.js";
import {
  requiresV01LegacyVideoPriceFloor,
  V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND,
} from "../../generation/v01Contract.js";
import type { PricingRulePage, PricingRuleRecord, ReplacePricingRuleInput } from "./types.js";

export interface AdminModelRepository {
  listCurrentPricingRules(at: Date): Promise<PricingRuleRecord[]>;
  listPricingRules(page: number, pageSize: number): Promise<PricingRulePage>;
  replacePricingRule(actorId: string, input: ReplacePricingRuleInput): Promise<PricingRuleRecord>;
}

export class DrizzleAdminModelRepository implements AdminModelRepository {
  constructor(private readonly db: Database) {}

  async listCurrentPricingRules(at: Date): Promise<PricingRuleRecord[]> {
    return this.db.select().from(pricingRules).where(and(
      eq(pricingRules.active, true),
      lte(pricingRules.effectiveFrom, at),
      or(isNull(pricingRules.effectiveTo), gt(pricingRules.effectiveTo, at)),
    )).orderBy(
      asc(pricingRules.provider),
      asc(pricingRules.model),
      asc(pricingRules.mediaKind),
      asc(pricingRules.billingUnit),
      desc(pricingRules.effectiveFrom),
      desc(pricingRules.id),
    );
  }

  async listPricingRules(page: number, pageSize: number): Promise<PricingRulePage> {
    const offset = (page - 1) * pageSize;
    const [items, totals] = await Promise.all([
      this.db.select().from(pricingRules).orderBy(
        asc(pricingRules.provider),
        asc(pricingRules.model),
        asc(pricingRules.mediaKind),
        asc(pricingRules.billingUnit),
        desc(pricingRules.effectiveFrom),
        desc(pricingRules.id),
      ).limit(pageSize).offset(offset),
      this.db.select({ total: sql<number>`count(*)::integer` }).from(pricingRules),
    ]);
    return { items, total: totals[0]?.total ?? 0 };
  }

  async replacePricingRule(actorId: string, input: ReplacePricingRuleInput): Promise<PricingRuleRecord> {
    validatePricingRule(input);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${generationPricingLockKey})`);
      const key = JSON.stringify([input.provider, input.model, input.mediaKind, input.billingUnit]);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);

      const now = new Date();
      const effectiveFrom = now;
      const activeRows = await tx.select({
        id: pricingRules.id,
        effectiveFrom: pricingRules.effectiveFrom,
      })
        .from(pricingRules)
        .where(and(
          eq(pricingRules.provider, input.provider),
          eq(pricingRules.model, input.model),
          eq(pricingRules.mediaKind, input.mediaKind),
          eq(pricingRules.billingUnit, input.billingUnit),
          eq(pricingRules.active, true),
          sql`${pricingRules.metadata}->'capability_tier' IS NULL`,
        ));

      const activeRuleIds = activeRows.map((row) => row.id);
      const observedCurrentRule = input.expectedActiveRuleId === null
        ? activeRuleIds.length === 0
        : activeRuleIds.length === 1 && activeRuleIds[0] === input.expectedActiveRuleId;
      if (!observedCurrentRule) {
        throw new ConflictError(
          "保存单价没成：当前单价已变化，请刷新后再试。",
          "pricing_rule_version_conflict",
          {
            expected_active_rule_id: input.expectedActiveRuleId,
            current_active_rule_ids: activeRuleIds,
          },
        );
      }

      if (activeRows.some((row) => effectiveFrom.getTime() <= row.effectiveFrom.getTime())) {
        throw new ConflictError(
          "保存单价没成：生效时间需要晚于当前单价，请调整后再试。",
          "pricing_rule_effective_time_conflict",
        );
      }

      // Price-bearing columns are deliberately absent. Historical rows are
      // closed, never edited in place, so old quotes keep a trustworthy rule.
      await tx.update(pricingRules).set({
        active: false,
        effectiveTo: effectiveFrom,
        updatedAt: now,
      }).where(and(
        eq(pricingRules.provider, input.provider),
        eq(pricingRules.model, input.model),
        eq(pricingRules.mediaKind, input.mediaKind),
        eq(pricingRules.billingUnit, input.billingUnit),
        eq(pricingRules.active, true),
        sql`${pricingRules.metadata}->'capability_tier' IS NULL`,
      ));

      const source = input.source?.trim() || `manual:user:${actorId}`;
      const metadata = { ...(input.metadata ?? {}), updated_by_user_id: actorId };
      const [created] = await tx.insert(pricingRules).values({
        id: randomUUID(),
        provider: input.provider,
        model: input.model,
        mediaKind: input.mediaKind,
        billingUnit: input.billingUnit,
        unitPriceFen: input.unitPriceFen,
        currency: input.currency,
        source,
        active: true,
        effectiveFrom,
        effectiveTo: null,
        metadata,
        createdAt: now,
        updatedAt: now,
      }).returning();

      if (!created) throw new Error("单价保存失败");
      return created;
    });
  }
}

function validatePricingRule(input: ReplacePricingRuleInput): void {
  if (!Number.isSafeInteger(input.unitPriceFen) || input.unitPriceFen <= 0 || input.unitPriceFen > 2_147_483_647) {
    throw new BadRequestError("保存单价没成：单价必须是大于 0 的整数，请修改后再试。");
  }
  if (input.mediaKind === "audio") {
    throw new BadRequestError(
      "保存音频单价没成：音频计费尚未核对完成，请联系管理员处理。",
    );
  }
  if ((input.mediaKind === "image" && input.billingUnit !== "image")
    || (input.mediaKind === "video" && input.billingUnit !== "second")) {
    throw new BadRequestError("保存单价没成：图片按张填写，视频按秒填写，请修改后再试。");
  }
  if (input.currency !== "CNY") {
    throw new BadRequestError("保存单价没成：当前只支持人民币计价，请修改后再试。");
  }
  if (hasCapabilityTier(input.metadata)) {
    throw new BadRequestError("保存单价没成：能力档只能使用受控解冻脚本逐档维护。");
  }
  if (input.provider.trim().toLowerCase() === "ark"
    && input.mediaKind === "video"
    && requiresV01LegacyVideoPriceFloor(input.metadata)
    && input.unitPriceFen < V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND) {
    throw new BadRequestError(
      `保存视频单价没成：单价低于当前允许的最低值，请提高到每秒 ${V01_VIDEO_MIN_UNIT_PRICE_FEN_PER_SECOND} 分后再试。`,
    );
  }
}

function hasCapabilityTier(metadata: Record<string, unknown> | undefined): boolean {
  return Boolean(metadata?.capability_tier);
}
