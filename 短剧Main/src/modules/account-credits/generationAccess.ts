import type { Database } from "../../db/client.js";
import { AppError, NotFoundError } from "../../shared/errors.js";
import { readAccountCreditSummaryForUpdate } from "./repository.js";
import type { AccountCreditSummary } from "./types.js";

export type AccountCreditSummaryReader = (
  db: Database,
  userId: string,
) => Promise<AccountCreditSummary>;

export interface GenerationPilotAccessOptions {
  enabled: boolean;
  readSummary?: AccountCreditSummaryReader;
}

/**
 * The pilot gate is authorization, not charging. PostgreSQL migration 034
 * remains the only exact debit authority when a confirmed quote is consumed.
 */
export async function assertGenerationPilotCreditAccess(
  db: Database,
  userId: string,
  options: GenerationPilotAccessOptions,
): Promise<void> {
  if (!options.enabled) return;
  let summary: AccountCreditSummary;
  try {
    summary = await (options.readSummary ?? readAccountCreditSummaryForUpdate)(db, userId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new AppError(
        503,
        "account_credit_unavailable",
        "生成没排上：积分账户暂时未就绪，请稍后重试。",
        true,
      );
    }
    throw error;
  }
  assertPositiveGenerationCredit(summary);
}

export function assertPositiveGenerationCredit(summary: AccountCreditSummary): void {
  if (summary.balancePoints <= 0) {
    throw new AppError(
      422,
      "account_credit_insufficient",
      "生成没排上：积分不够，请联系管理员调整后再试。",
      false,
      { balance_points: summary.balancePoints },
    );
  }
  if (summary.remainingTodayPoints <= 0) {
    throw new AppError(
      422,
      "account_credit_daily_limit_exceeded",
      "生成没排上：今天可用积分已用完，请明天再试或联系管理员调整。",
      false,
      {
        daily_limit_points: summary.dailyLimitPoints,
        used_today_points: summary.usedTodayPoints,
      },
    );
  }
}
