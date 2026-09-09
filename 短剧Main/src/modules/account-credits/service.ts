import { randomBytes } from "node:crypto";
import { BadRequestError, ConflictError, isPostgresUniqueViolation } from "../../shared/errors.js";
import type {
  AccountCreditActor,
  AccountCreditStore,
  AdjustAccountCreditInput,
  CreateInvitationTierInput,
  CreateInviteCodeInput,
  UpdateInvitationTierInput,
  UpdateInviteCodeInput,
  UpdateSelfRegistrationCreditPolicyInput,
} from "./types.js";

const TIER_CODE = /^[a-z][a-z0-9_]{1,31}$/;
const MAX_POINTS = 2_147_483_647;

export class AccountCreditService {
  constructor(private readonly store: AccountCreditStore) {}

  getSummary(userId: string) {
    return this.store.getSummary(userId);
  }

  listInvitationTiers(actor: AccountCreditActor) {
    return this.store.listInvitationTiers(actor);
  }

  async createInvitationTier(actor: AccountCreditActor, input: CreateInvitationTierInput) {
    const normalized = {
      code: normalizeTierCode(input.code),
      name: normalizeName(input.name, "邀请码档位名称"),
      grantPoints: nonNegativePoints(input.grantPoints, "赠送积分"),
      dailyLimitPoints: nonNegativePoints(input.dailyLimitPoints, "每日额度"),
    };
    try {
      return await this.store.createInvitationTier(actor, normalized);
    } catch (error) {
      if (isPostgresUniqueViolation(error)) throw new ConflictError("新建邀请码档位没成：这个档位代号已被使用，请换一个再试。", "invite_tier_exists");
      throw error;
    }
  }

  updateInvitationTier(actor: AccountCreditActor, tierId: string, input: UpdateInvitationTierInput) {
    if (input.name === undefined && input.grantPoints === undefined && input.dailyLimitPoints === undefined && input.active === undefined) {
      throw new BadRequestError("修改邀请码档位没成：没有填写可修改的内容，请补充后再试。");
    }
    return this.store.updateInvitationTier(actor, tierId, {
      ...(input.name === undefined ? {} : { name: normalizeName(input.name, "邀请码档位名称") }),
      ...(input.grantPoints === undefined ? {} : { grantPoints: nonNegativePoints(input.grantPoints, "赠送积分") }),
      ...(input.dailyLimitPoints === undefined ? {} : { dailyLimitPoints: nonNegativePoints(input.dailyLimitPoints, "每日额度") }),
      ...(input.active === undefined ? {} : { active: input.active }),
    });
  }

  deactivateInvitationTier(actor: AccountCreditActor, tierId: string) {
    return this.store.deactivateInvitationTier(actor, tierId);
  }

  listInviteCodes(actor: AccountCreditActor) {
    return this.store.listInviteCodes(actor);
  }

  createInviteCode(actor: AccountCreditActor, input: CreateInviteCodeInput) {
    return this.store.createInviteCode(actor, {
      tierId: input.tierId,
      ...(input.maxRedemptions === undefined ? {} : { maxRedemptions: positivePoints(input.maxRedemptions, "最大使用次数") }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
  }

  updateInviteCode(actor: AccountCreditActor, codeId: string, input: UpdateInviteCodeInput) {
    if (input.maxRedemptions === undefined && input.expiresAt === undefined && input.active === undefined) {
      throw new BadRequestError("修改邀请码没成：没有填写可修改的内容，请补充后再试。");
    }
    return this.store.updateInviteCode(actor, codeId, {
      ...(input.maxRedemptions === undefined ? {} : { maxRedemptions: positivePoints(input.maxRedemptions, "最大使用次数") }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.active === undefined ? {} : { active: input.active }),
    });
  }

  deactivateInviteCode(actor: AccountCreditActor, codeId: string) {
    return this.store.deactivateInviteCode(actor, codeId);
  }

  getSelfRegistrationPolicy(actor: AccountCreditActor) {
    return this.store.getSelfRegistrationPolicy(actor);
  }

  updateSelfRegistrationPolicy(actor: AccountCreditActor, input: UpdateSelfRegistrationCreditPolicyInput) {
    return this.store.updateSelfRegistrationPolicy(actor, {
      dailyLimitPoints: nonNegativePoints(input.dailyLimitPoints, "自注册每日额度"),
    });
  }

  adjustBalance(actor: AccountCreditActor, userId: string, input: AdjustAccountCreditInput) {
    if (!Number.isInteger(input.amountPoints) || input.amountPoints === 0 || Math.abs(input.amountPoints) > MAX_POINTS) {
      throw new BadRequestError("调整积分没成：增减数量必须是范围内的非零整数，请修改后再试。");
    }
    return this.store.adjustBalance(actor, userId, {
      amountPoints: input.amountPoints,
      reason: normalizeName(input.reason, "调账原因", 256),
    });
  }
}

/** Generated plaintext is returned exactly once by the admin route. */
export function generateInviteCode(): string {
  return `SD-${randomBytes(9).toString("base64url").toUpperCase()}`;
}

function normalizeTierCode(value: string): string {
  const code = value.trim().toLowerCase();
  if (!TIER_CODE.test(code)) throw new BadRequestError("保存邀请码档位没成：档位代号格式不对，请用 2 至 32 位小写字母、数字或下划线。");
  return code;
}

function normalizeName(value: string, label: string, maxLength = 128): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new BadRequestError(`保存没成：${label}不能为空且不能过长，请修改后再试。`);
  return normalized;
}

function positivePoints(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_POINTS) {
    throw new BadRequestError(`保存没成：${label}必须是 1 至 ${MAX_POINTS} 的整数，请修改后再试。`);
  }
  return value;
}

/** Zero is meaningful for an admin-controlled closed quota; it is not a charge. */
function nonNegativePoints(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_POINTS) {
    throw new BadRequestError(`保存没成：${label}必须是 0 至 ${MAX_POINTS} 的整数，请修改后再试。`);
  }
  return value;
}
