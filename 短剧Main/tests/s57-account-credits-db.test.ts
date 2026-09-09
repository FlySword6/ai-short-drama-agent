import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import {
  AccountCreditRepository,
  hashInviteCode,
} from "../src/modules/account-credits/repository.js";
import { AuthRepository } from "../src/modules/auth/repository.js";

/**
 * This rehearsal is opt-in and never permits a cloud endpoint. Run it with a
 * local Compose PostgreSQL and a dedicated schema, for example:
 *
 * POSTGRES_SCHEMA=s57_account_credits_rehearsal \
 * S57_ACCOUNT_CREDITS_TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/shortdrama \
 * node --import tsx --test tests/s57-account-credits-db.test.ts
 */
const databaseUrl = process.env.S57_ACCOUNT_CREDITS_TEST_DATABASE_URL;
const schemaName = settings.postgresSchema;
const quotedSchema = quoteIdentifier(schemaName);

test("S57 真 PG：邀请码并发核销、账户扣减与成本账本三处同源", {
  skip: !databaseUrl
    ? "未设 S57_ACCOUNT_CREDITS_TEST_DATABASE_URL——需显式指定本机 Compose PostgreSQL，跳过不等于通过"
    : false,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalDatabase(databaseUrl);
  assert.match(schemaName, /^s57_account_credits_[a-z0-9_]+$/, "S57 真 PG 演练只能使用专用临时 schema，拒绝触碰 common/default");
  const handle = createDatabase(databaseUrl);
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quotedSchema}`);
    await applyAllMigrations(handle.pool);
    const fixedInvite = await handle.pool.query<{
      code_prefix: string;
      tier_key: string;
      grant_points: number;
      daily_limit_points: number;
      max_uses: number;
      status: string;
      issued_by_user_id: string | null;
    }>(
      `SELECT code_prefix, tier_key, grant_points, daily_limit_points, max_uses, status, issued_by_user_id
       FROM ${quotedSchema}.invite_codes
       WHERE code_hash = $1`,
      [hashInviteCode("COLTECH")],
    );
    assert.deepEqual(fixedInvite.rows[0], {
      code_prefix: "COLTE••••",
      tier_key: "invited",
      grant_points: 50_000,
      daily_limit_points: 50_000,
      max_uses: 2_147_483_647,
      status: "active",
      issued_by_user_id: null,
    }, "迁移必须幂等播种固定内部邀请码及既有受邀额度口径");

    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quotedSchema}.invite_codes
          (id, code_hash, code_prefix, tier_id, tier_key, grant_points,
           daily_limit_points, max_uses, used_count, status, created_at, updated_at)
         VALUES ($1, $2, 'OTHER••••', $3, 'invited', 50000, 50000, 1, 0, 'active', now(), now())`,
        [
          randomUUID(),
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "3d0222ba-7c6f-4ffc-901f-510c3e4aa002",
        ],
      ),
      (error: unknown) => {
        const pgError = error as { code?: string; constraint?: string };
        return pgError.code === "23514"
          && pgError.constraint === "invite_codes_issuer_provenance_check";
      },
      "只有固定平台邀请码可以没有签发人",
    );

    const safetyExpiry = new Date("2027-01-02T03:04:05.000Z");
    await handle.pool.query(
      `UPDATE ${quotedSchema}.invite_codes
       SET status = 'revoked', max_uses = 17, used_count = 9, expires_at = $2
       WHERE code_hash = $1`,
      [hashInviteCode("COLTECH"), safetyExpiry],
    );
    const migration049 = await readFile(path.resolve("migrations/049_ops_p0_internal_pilot.sql"), "utf8");
    await handle.pool.query(renderMigrationSql(migration049, schemaName));
    const preservedSafety = await handle.pool.query<{
      status: string;
      max_uses: number;
      used_count: number;
      expires_at: Date;
    }>(
      `SELECT status, max_uses, used_count, expires_at
       FROM ${quotedSchema}.invite_codes WHERE code_hash = $1`,
      [hashInviteCode("COLTECH")],
    );
    assert.deepEqual(preservedSafety.rows[0], {
      status: "revoked",
      max_uses: 17,
      used_count: 9,
      expires_at: safetyExpiry,
    }, "迁移重跑不得撤销管理员对固定码的停用、次数、过期时间或既有使用计数");

    const now = new Date();
    const issuerId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.users (id, username, display_name, password_hash, active, created_at, updated_at)
       VALUES ($1, 's57-issuer', 'S57 Issuer', 'test-only', TRUE, $2, $2)`,
      [issuerId, now],
    );
    const tierId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.invite_tiers
        (id, tier_key, display_name, grant_points, daily_limit_points, active, created_by_user_id, updated_by_user_id, created_at, updated_at)
       VALUES ($1, 's57_test', 'S57 Test', 50000, 50000, TRUE, $2, $2, $3, $3)`,
      [tierId, issuerId, now],
    );
    const inviteCodeId = randomUUID();
    const inviteCode = "SD-S57-ONE";
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.invite_codes
        (id, code_hash, code_prefix, tier_id, tier_key, grant_points, daily_limit_points,
         max_uses, used_count, status, issued_by_user_id, created_at, updated_at)
       VALUES ($1, $2, 'SD-S5••••', $3, 's57_test', 50000, 50000, 1, 0, 'active', $4, $5, $5)`,
      [inviteCodeId, hashInviteCode(inviteCode), tierId, issuerId, now],
    );

    const auth = new AuthRepository(handle.db);
    const emails = ["s57-first@example.test", "s57-second@example.test"];
    for (const email of emails) {
      await auth.issueEmailVerificationCode({
        email,
        codeHash: "111111",
        expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
        maxAttempts: 5,
      });
    }
    const results = await Promise.all(emails.map((email, index) => auth.registerVerifiedEmail({
      email,
      username: `s57-user-${index}`,
      displayName: `S57 User ${index}`,
      passwordHash: "test-only",
      verificationCode: "111111",
      invitationCodeHash: hashInviteCode(inviteCode),
      verifyCode: async (code, encoded) => code === encoded,
    })));
    const registered = results.filter((result): result is Extract<typeof result, { kind: "registered" }> => result.kind === "registered");
    const rejected = results.filter((result): result is Extract<typeof result, { kind: "rejected" }> => result.kind === "rejected");
    assert.equal(registered.length, 1, "max_uses=1 的同一码并发核销只允许一个账户成功");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.failure.code, "invite_code_invalid");

    const winnerRegistration = registered[0]!;
    const winner = winnerRegistration.user;
    assert.deepEqual(winnerRegistration.registrationGrant, {
      source: "invitation",
      grantedPoints: 50_000,
    });
    assert.deepEqual(
      winnerRegistration.accountCredit,
      await new AccountCreditRepository(handle.db).getSummary(winner.id),
      "注册响应的账户块必须与账户积分真源同形同值",
    );
    assert.deepEqual({
      balancePoints: winnerRegistration.accountCredit.balancePoints,
      dailyLimitPoints: winnerRegistration.accountCredit.dailyLimitPoints,
      usedTodayPoints: winnerRegistration.accountCredit.usedTodayPoints,
      remainingTodayPoints: winnerRegistration.accountCredit.remainingTodayPoints,
      pointToFen: winnerRegistration.accountCredit.pointToFen,
    }, {
      balancePoints: 50_000,
      dailyLimitPoints: 50_000,
      usedTodayPoints: 0,
      remainingTodayPoints: 50_000,
      pointToFen: 1,
    });
    const redemption = await handle.pool.query<{ used_count: number; balance_points: number; daily_limit_points: number; ledger_count: number }>(
      `SELECT code.used_count, account.balance_points, account.daily_limit_points,
              (SELECT COUNT(*)::int FROM ${quotedSchema}.user_credit_ledger_entries ledger WHERE ledger.user_id = account.user_id AND ledger.entry_kind = 'invite_grant') AS ledger_count
       FROM ${quotedSchema}.invite_codes code
       JOIN ${quotedSchema}.user_credit_accounts account ON account.user_id = $1
       WHERE code.id = $2`,
      [winner.id, inviteCodeId],
    );
    assert.deepEqual(redemption.rows[0], { used_count: 1, balance_points: 50000, daily_limit_points: 50000, ledger_count: 1 });

    const noInviteEmail = "s57-no-invite@example.test";
    await auth.issueEmailVerificationCode({
      email: noInviteEmail,
      codeHash: "222222",
      expiresAt: new Date(now.getTime() + 10 * 60 * 1_000),
      maxAttempts: 5,
    });
    const noInvite = await auth.registerVerifiedEmail({
      email: noInviteEmail,
      username: "s57-no-invite",
      displayName: "S57 No Invite",
      passwordHash: "test-only",
      verificationCode: "222222",
      verifyCode: async (code, encoded) => code === encoded,
    });
    assert.deepEqual(noInvite, {
      kind: "rejected",
      failure: {
        code: "invite_code_required",
        message: "公司内部试点注册必须填写邀请码",
      },
    });
    const noInviteUser = await handle.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${quotedSchema}.users WHERE email = $1`,
      [noInviteEmail],
    );
    assert.equal(noInviteUser.rows[0]?.count, 0, "无码拒绝不得留下半注册用户");

    const projectId = randomUUID();
    const episodeId = randomUUID();
    const shotId = randomUUID();
    const requestId = randomUUID();
    const pricingRuleId = randomUUID();
    const attemptId = randomUUID();
    const quoteId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.projects (id, owner_user_id, name, status, created_at, updated_at)
       VALUES ($1, $2, 'S57 Credit Project', 'active', $3, $3)`,
      [projectId, winner.id, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.episodes (id, project_id, episode_no, sort_order, status, created_at, updated_at)
       VALUES ($1, $2, 1, 0, 'active', $3, $3)`,
      [episodeId, projectId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.shots (id, episode_id, shot_code, reference_asset_snapshots, created_at, updated_at)
       VALUES ($1, $2, 'S57-01', '[]'::jsonb, $3, $3)`,
      [shotId, episodeId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.generation_requests
        (id, user_id, project_id, episode_id, shot_id, media_kind, prompt, reference_media_ids,
         reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'video', 'S57 test', '[]'::jsonb, '[]'::jsonb,
               '{}'::jsonb, 1, 's57-credit-test', repeat('a', 64), $6, $6)`,
      [requestId, winner.id, projectId, episodeId, shotId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.pricing_rules
        (id, provider, model, media_kind, billing_unit, unit_price_fen, currency, source, active, effective_from, metadata, created_at, updated_at)
       VALUES ($1, 'test', 's57-model', 'video', 'second', 120, 'CNY', 's57-test', TRUE, $2, '{}'::jsonb, $2, $2)`,
      [pricingRuleId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.generation_attempts
        (id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
         retryable, estimated_cost_fen, actual_cost_status, pricing_rule_id, price_snapshot, created_at, updated_at)
       VALUES ($1, $2, 1, 'test', 's57-model', '{}'::jsonb, 1, 'pending', 'created',
               FALSE, 120, 'estimated', $3, '{}'::jsonb, $4, $4)`,
      [attemptId, requestId, pricingRuleId, now],
    );
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.generation_quotes
        (id, user_id, source, action, request_hash, normalized_request, pricing_rule_id,
         price_snapshot, estimated_cost_fen, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, 'web', 'submit', repeat('b', 64), '{}'::jsonb, $3,
               '{}'::jsonb, 120, 'pending_confirmation', $4::timestamptz + interval '1 hour', $4, $4)`,
      [quoteId, winner.id, pricingRuleId, now],
    );
    await handle.pool.query(
      `UPDATE ${quotedSchema}.generation_quotes
       SET status = 'consumed', confirmed_at = $2, confirmed_by_user_id = $5, consumed_at = $2,
           generation_request_id = $3, generation_attempt_id = $4, updated_at = $2
       WHERE id = $1`,
      [quoteId, now, requestId, attemptId, winner.id],
    );
    const truth = await handle.pool.query<{
      balance_points: number;
      usage_points: number;
      ledger_delta: number;
      request_points: number;
      cost_points: number;
    }>(
      `SELECT account.balance_points,
              usage.charged_points AS usage_points,
              ledger.points_delta AS ledger_delta,
              request.charged_points AS request_points,
              cost.charged_points AS cost_points
       FROM ${quotedSchema}.user_credit_accounts account
       JOIN ${quotedSchema}.user_credit_daily_usage usage ON usage.user_id = account.user_id
       JOIN ${quotedSchema}.user_credit_ledger_entries ledger ON ledger.source_id = $1
       JOIN ${quotedSchema}.generation_requests request ON request.id = $2
       JOIN ${quotedSchema}.cost_entries cost ON cost.source_id = request.id AND cost.kind = 'generation'
       WHERE account.user_id = $3`,
      [quoteId, requestId, winner.id],
    );
    assert.deepEqual(truth.rows[0], {
      balance_points: 49880,
      usage_points: 120,
      ledger_delta: -120,
      request_points: 120,
      cost_points: 120,
    }, "账户扣减、generation_requests.charged_points、cost_entries 必须同源于同一 estimated_cost_fen");

    const duplicateQuoteId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.generation_quotes
        (id, user_id, source, action, request_hash, normalized_request, pricing_rule_id,
         price_snapshot, estimated_cost_fen, status, expires_at, confirmed_at, confirmed_by_user_id, created_at, updated_at)
       VALUES ($1, $2, 'web', 'submit', repeat('c', 64), '{}'::jsonb, $3,
               '{}'::jsonb, 120, 'confirmed', $4::timestamptz + interval '1 hour', $4, $2, $4, $4)`,
      [duplicateQuoteId, winner.id, pricingRuleId, now],
    );
    await assert.rejects(
      handle.pool.query(
        `UPDATE ${quotedSchema}.generation_quotes
         SET status = 'consumed', consumed_at = $2, generation_request_id = $3,
             generation_attempt_id = $4, updated_at = $2
         WHERE id = $1`,
        [duplicateQuoteId, now, requestId, attemptId],
      ),
      (error: unknown) => postgresError(error, "P0001", "account_credit_duplicate_generation_attempt"),
      "同一幂等生成尝试的第二张报价必须被数据库拒绝，不能产生第二笔扣费",
    );
    const noDuplicateDebit = await handle.pool.query<{ count: number; balance_points: number; charged_points: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM ${quotedSchema}.user_credit_ledger_entries
          WHERE source_type = 'generation_quote' AND generation_request_id = $1) AS count,
         (SELECT balance_points FROM ${quotedSchema}.user_credit_accounts WHERE user_id = $2) AS balance_points,
         (SELECT charged_points FROM ${quotedSchema}.generation_requests WHERE id = $1) AS charged_points`,
      [requestId, winner.id],
    );
    assert.deepEqual(noDuplicateDebit.rows[0], { count: 1, balance_points: 49880, charged_points: 120 });

    // This is the race the row lock in 034 protects: two browser requests can
    // reach confirmed quotes for one attempt before either quote is consumed.
    // One must win and debit; the other must observe the committed sibling
    // after waiting for the attempt lock and be rejected without a second debit.
    const concurrentAttemptId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${quotedSchema}.generation_attempts
        (id, request_id, attempt_no, provider, model, parameters, quantity, status, phase,
         retryable, estimated_cost_fen, actual_cost_status, pricing_rule_id, price_snapshot, created_at, updated_at)
       VALUES ($1, $2, 2, 'test', 's57-model', '{}'::jsonb, 1, 'pending', 'created',
               FALSE, 30, 'estimated', $3, '{}'::jsonb, $4, $4)`,
      [concurrentAttemptId, requestId, pricingRuleId, now],
    );
    const concurrentQuoteIds = [randomUUID(), randomUUID()];
    for (const [index, concurrentQuoteId] of concurrentQuoteIds.entries()) {
      await handle.pool.query(
        `INSERT INTO ${quotedSchema}.generation_quotes
          (id, user_id, source, action, request_hash, normalized_request, pricing_rule_id,
           price_snapshot, estimated_cost_fen, status, expires_at, confirmed_at, confirmed_by_user_id, created_at, updated_at)
         VALUES ($1, $2, 'web', 'submit', repeat($3, 64), '{}'::jsonb, $4,
                 '{}'::jsonb, 30, 'confirmed', $5::timestamptz + interval '1 hour', $5, $2, $5, $5)`,
        [concurrentQuoteId, winner.id, index === 0 ? "d" : "e", pricingRuleId, now],
      );
    }
    const concurrentConsumption = await Promise.allSettled(concurrentQuoteIds.map((concurrentQuoteId) => handle.pool.query(
      `UPDATE ${quotedSchema}.generation_quotes
       SET status = 'consumed', consumed_at = $2, generation_request_id = $3,
           generation_attempt_id = $4, updated_at = $2
       WHERE id = $1`,
      [concurrentQuoteId, now, requestId, concurrentAttemptId],
    )));
    const fulfilled = concurrentConsumption.filter((outcome) => outcome.status === "fulfilled");
    const rejectedConcurrent = concurrentConsumption.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1, "同一生成尝试的并发报价只能消费一张");
    assert.equal(rejectedConcurrent.length, 1);
    assert.ok(postgresError(rejectedConcurrent[0]?.reason, "P0001", "account_credit_duplicate_generation_attempt"));
    const concurrentDebit = await handle.pool.query<{ count: number; balance_points: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM ${quotedSchema}.user_credit_ledger_entries
          WHERE source_type = 'generation_quote' AND source_id = ANY($1::uuid[])) AS count,
         (SELECT balance_points FROM ${quotedSchema}.user_credit_accounts WHERE user_id = $2) AS balance_points`,
      [concurrentQuoteIds, winner.id],
    );
    assert.deepEqual(concurrentDebit.rows[0], { count: 1, balance_points: 49850 });
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

async function applyAllMigrations(pool: ReturnType<typeof createDatabase>["pool"]): Promise<void> {
  const files = (await readdir(path.resolve("migrations")))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  assert.ok(files.some((name) => name === "034_s57_account_registration.sql"));
  for (const file of files) {
    const source = await readFile(path.resolve("migrations", file), "utf8");
    await pool.query(renderMigrationSql(source, schemaName));
  }
}

function assertLocalDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (![
    "127.0.0.1",
    "localhost",
    "db",
  ].includes(host)) {
    throw new Error("S57_ACCOUNT_CREDITS_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL，拒绝连接云 RDS");
  }
}

function postgresError(error: unknown, code: string, message: string): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === code
    && error instanceof Error
    && error.message === message;
}
