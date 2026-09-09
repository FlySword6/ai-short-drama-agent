/**
 * S57 account-credit contracts. One point is permanently equal to one fen;
 * this module never calculates a provider price or a conversion rate.
 */
export const CREDIT_POINT_TO_FEN = 1 as const;

export interface AccountCreditActor {
  userId: string;
  sessionId?: string;
}

export interface AccountCreditSummary {
  userId: string;
  balancePoints: number;
  dailyLimitPoints: number;
  usedTodayPoints: number;
  remainingTodayPoints: number;
  dayDate: string;
  pointToFen: typeof CREDIT_POINT_TO_FEN;
}

export interface InvitationTier {
  id: string;
  code: string;
  name: string;
  grantPoints: number;
  dailyLimitPoints: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface InviteCodeRecord {
  id: string;
  prefix: string;
  tierId: string;
  tierCode: string;
  grantPoints: number;
  dailyLimitPoints: number;
  maxRedemptions: number;
  usedRedemptions: number;
  expiresAt: Date | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SelfRegistrationCreditPolicy {
  policyKey: "self_registration";
  dailyLimitPoints: number;
  updatedAt: Date;
}

export interface AccountCreditAdjustment {
  userId: string;
  balancePoints: number;
  amountPoints: number;
  reason: string;
  createdAt: Date;
}

export interface AccountCreditStore {
  getSummary(userId: string): Promise<AccountCreditSummary>;
  listInvitationTiers(actor: AccountCreditActor): Promise<InvitationTier[]>;
  createInvitationTier(actor: AccountCreditActor, input: CreateInvitationTierInput): Promise<InvitationTier>;
  updateInvitationTier(actor: AccountCreditActor, tierId: string, input: UpdateInvitationTierInput): Promise<InvitationTier>;
  deactivateInvitationTier(actor: AccountCreditActor, tierId: string): Promise<void>;
  listInviteCodes(actor: AccountCreditActor): Promise<InviteCodeRecord[]>;
  createInviteCode(actor: AccountCreditActor, input: CreateInviteCodeInput): Promise<{ inviteCode: InviteCodeRecord; plaintextCode: string }>;
  updateInviteCode(actor: AccountCreditActor, codeId: string, input: UpdateInviteCodeInput): Promise<InviteCodeRecord>;
  deactivateInviteCode(actor: AccountCreditActor, codeId: string): Promise<void>;
  getSelfRegistrationPolicy(actor: AccountCreditActor): Promise<SelfRegistrationCreditPolicy>;
  updateSelfRegistrationPolicy(
    actor: AccountCreditActor,
    input: UpdateSelfRegistrationCreditPolicyInput,
  ): Promise<SelfRegistrationCreditPolicy>;
  adjustBalance(actor: AccountCreditActor, userId: string, input: AdjustAccountCreditInput): Promise<AccountCreditAdjustment>;
}

export interface CreateInvitationTierInput {
  code: string;
  name: string;
  grantPoints: number;
  dailyLimitPoints: number;
}

export interface UpdateInvitationTierInput {
  name?: string;
  grantPoints?: number;
  dailyLimitPoints?: number;
  active?: boolean;
}

export interface CreateInviteCodeInput {
  tierId: string;
  maxRedemptions?: number;
  expiresAt?: Date | null;
}

export interface UpdateInviteCodeInput {
  maxRedemptions?: number;
  expiresAt?: Date | null;
  active?: boolean;
}

export interface UpdateSelfRegistrationCreditPolicyInput {
  dailyLimitPoints: number;
}

export interface AdjustAccountCreditInput {
  amountPoints: number;
  reason: string;
}
