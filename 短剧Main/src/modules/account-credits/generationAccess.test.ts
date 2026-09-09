import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "../../db/client.js";
import { AppError, NotFoundError } from "../../shared/errors.js";
import { assertGenerationPilotCreditAccess } from "./generationAccess.js";

const userId = "11111111-1111-4111-8111-111111111111";
const db = {} as Database;

test("试点生成额度闸关闭时不读账户，开启时要求正余额与当日剩余额度", async () => {
  let reads = 0;
  const readSummary = async () => {
    reads += 1;
    return summary({ balancePoints: 50_000, remainingTodayPoints: 50_000 });
  };
  await assertGenerationPilotCreditAccess(db, userId, { enabled: false, readSummary });
  assert.equal(reads, 0);
  await assertGenerationPilotCreditAccess(db, userId, { enabled: true, readSummary });
  assert.equal(reads, 1);
});

test("试点生成额度闸对缺账户、零余额和日额度耗尽给稳定中文错误", async (context) => {
  const cases = [
    {
      name: "missing",
      readSummary: async () => { throw new NotFoundError("missing"); },
      code: "account_credit_unavailable",
      statusCode: 503,
      message: "生成没排上：积分账户暂时未就绪，请稍后重试。",
    },
    {
      name: "balance",
      readSummary: async () => summary({ balancePoints: 0, remainingTodayPoints: 50_000 }),
      code: "account_credit_insufficient",
      statusCode: 422,
      message: "生成没排上：积分不够，请联系管理员调整后再试。",
    },
    {
      name: "daily",
      readSummary: async () => summary({ balancePoints: 50_000, remainingTodayPoints: 0 }),
      code: "account_credit_daily_limit_exceeded",
      statusCode: 422,
      message: "生成没排上：今天可用积分已用完，请明天再试或联系管理员调整。",
    },
  ] as const;
  for (const item of cases) {
    await context.test(item.name, async () => {
      await assert.rejects(
        assertGenerationPilotCreditAccess(db, userId, {
          enabled: true,
          readSummary: item.readSummary,
        }),
        (error: unknown) => error instanceof AppError
          && error.code === item.code
          && error.statusCode === item.statusCode
          && error.message === item.message,
      );
    });
  }
});

test("生产生成仓储把同一额度闸接到所有新报价和付费状态转换", async () => {
  const repositorySource = await readFile(
    path.resolve("src/modules/generation/repository.ts"),
    "utf8",
  );
  const guardedMethods = [
    "createSubmissionQuote",
    "createRetryQuote",
    "confirmQuote",
    "createSubmission",
    "createBatchAuthorization",
    "submitBatchAuthorization",
    "createRetry",
  ] as const;
  const methodSources = new Map<string, string>();
  for (const method of guardedMethods) {
    const start = repositorySource.indexOf(`  async ${method}(`);
    assert.notEqual(start, -1, `${method} must remain a repository method`);
    const nextStart = repositorySource.indexOf("\n  async ", start + 1);
    const end = nextStart > start ? nextStart : repositorySource.length;
    const methodSource = repositorySource.slice(start, end);
    methodSources.set(method, methodSource);
    assert.match(
      methodSource,
      /await this\.assertActorAccess\(/,
      `${method} must enforce the pilot account-credit gate`,
    );
  }

  for (const method of [
    "createSubmissionQuote",
    "createRetryQuote",
    "createSubmission",
    "submitBatchAuthorization",
    "createRetry",
  ]) {
    const source = methodSources.get(method)!;
    assert.ok(
      source.indexOf("await this.assertActorAccess(")
        < source.indexOf("pg_advisory_xact_lock(${generationPricingLockKey})"),
      `${method} must lock the account before the shared pricing advisory lock`,
    );
  }
  for (const method of [
    "confirmQuote",
    "createSubmission",
    "createBatchAuthorization",
    "submitBatchAuthorization",
    "createRetry",
  ]) {
    const source = methodSources.get(method)!;
    assert.ok(
      source.lastIndexOf("lockQuote(") < source.indexOf("await this.assertActorAccess("),
      `${method} must lock all affected quotes before the account row`,
    );
  }

  const factorySource = await readFile(
    path.resolve("src/modules/generation/factory.ts"),
    "utf8",
  );
  assert.match(factorySource, /assertGenerationPilotCreditAccess\(transaction, actorId/);
  assert.match(factorySource, /enabled: settings\.generationPilotCreditGateEnabled/);

  const accountRepositorySource = await readFile(
    path.resolve("src/modules/account-credits/repository.ts"),
    "utf8",
  );
  assert.match(accountRepositorySource, /readAccountCreditSummaryForUpdate/);
  assert.match(accountRepositorySource, /FOR UPDATE/);
});

function summary(overrides: {
  balancePoints: number;
  remainingTodayPoints: number;
}) {
  return {
    userId,
    balancePoints: overrides.balancePoints,
    dailyLimitPoints: 50_000,
    usedTodayPoints: 50_000 - overrides.remainingTodayPoints,
    remainingTodayPoints: overrides.remainingTodayPoints,
    dayDate: "2026-08-04",
    pointToFen: 1 as const,
  };
}
