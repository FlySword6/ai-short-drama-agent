import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database, DatabaseHandle } from "../src/db/client.js";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import {
  assetEntities,
  pricingRules,
  projectAssetRefs,
  projectMembers,
  users,
} from "../src/db/schema.js";
import { createAuthenticationHook } from "../src/http/authenticate.js";
import { toHttpErrorResponse } from "../src/http/errorResponse.js";
import {
  assertPositiveGenerationCredit,
} from "../src/modules/account-credits/generationAccess.js";
import {
  readAccountCreditSummaryForUpdate,
} from "../src/modules/account-credits/repository.js";
import { registerAccountCreditRoutes } from "../src/modules/account-credits/routes.js";
import { registerAdminUserRoutes } from "../src/modules/admin/users/index.js";
import { AuthService, hashPassword } from "../src/modules/auth/service.js";
import { registerAuthRoutes, type AuthServicePort } from "../src/modules/auth/routes.js";
import { registerCapabilityTierRoutes } from "../src/modules/capability-tiers/routes.js";
import {
  PostgresGenerationRepository,
  type GenerationActorAccessGuard,
} from "../src/modules/generation/repository.js";
import {
  generationParameters,
  registerGenerationRoutes,
} from "../src/modules/generation/routes.js";
import {
  hashGenerationBatch,
  hashGenerationRequest,
  normalizeGenerationInput,
} from "../src/modules/generation/service.js";
import { registerOperationsRoutes } from "../src/modules/operations/routes.js";
import { registerReviewRoutes } from "../src/modules/reviews/routes.js";
import type {
  BatchGenerationSubmitInput,
  GenerationActor,
  NormalizedGenerationInput,
  SubmitGenerationInput,
} from "../src/modules/generation/types.js";
import { registerProductionRoutes } from "../src/modules/production/routes.js";
import {
  createSgoal04P2DevPromotionSeeds,
  metadataFor,
  PRICING_TIER_SEEDS,
} from "../scripts/seed-pricing-tiers.mts";

const databaseUrl = process.env.OPS_P0_HTTP_TEST_DATABASE_URL;
const schemaName = process.env.POSTGRES_SCHEMA;

test("运营底座 P0 真实 HTTP + PostgreSQL：注册、登录、额度、管理调账和最便宜报价止步", {
  timeout: 180_000,
}, async (context) => {
  if (!databaseUrl) {
    context.skip("OPS_P0_HTTP_TEST_DATABASE_URL 未设置；一次性 PostgreSQL runner 会执行本门禁");
    return;
  }
  assertLocalDatabase(databaseUrl);
  assert.ok(schemaName, "runner must provide POSTGRES_SCHEMA");
  assert.match(schemaName, /^ops_p0_http_[a-z0-9_]+$/);

  const handle = createDatabase(databaseUrl);
  const quoted = quoteIdentifier(schemaName);
  let app: FastifyInstance | undefined;
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    await applyAllMigrations(handle, schemaName);
    await seedCurrentDevelopmentPricing(handle.db);
    const admin = await seedDayZeroAdmin(handle.db);
    const captured = { verificationCode: null as string | null };
    app = await createOpsP0App(handle.db, captured);

    const email = `ops-p0-${randomUUID()}@example.test`;
    const password = "ops-p0-member-password";
    const verification = await injectSuccess<{
      email: string;
      expires_at: string;
      delivery: string;
    }>(app, {
      method: "POST",
      url: "/api/v1/auth/email-verification-codes",
      payload: { email },
      expectedStatus: 202,
    });
    assert.equal(verification.email, email);
    assert.equal(verification.delivery, "dev_log");
    assert.ok(captured.verificationCode);
    assert.match(captured.verificationCode, /^\d{6}$/);

    const missingInvite = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email,
        password,
        verification_code: captured.verificationCode,
      },
    });
    assert.equal(missingInvite.statusCode, 422, missingInvite.body);
    assert.equal(missingInvite.json().error.code, "invite_code_required");

    const wrongInvite = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email,
        password,
        verification_code: captured.verificationCode,
        invitation_code: "NOT-COLTECH",
      },
    });
    assert.equal(wrongInvite.statusCode, 422, wrongInvite.body);
    assert.equal(wrongInvite.json().error.code, "invite_code_invalid");
    assert.equal(await userCountByEmail(handle, quoted, email), 0);

    const registration = await injectSuccess<RegistrationResponse>(app, {
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        email,
        password,
        verification_code: captured.verificationCode,
        display_name: "运营底座 P0 同事",
        invitation_code: "coltech",
      },
      expectedStatus: 201,
    });
    assert.equal(registration.user.role, "member");
    assert.equal(registration.account_credit.balance_points, 50_000);
    assert.equal(registration.account_credit.daily_limit_points, 50_000);
    assert.equal(registration.account_credit.used_today_points, 0);
    assert.equal(registration.account_credit.remaining_today_points, 50_000);
    assert.deepEqual(registration.registration_grant, {
      source: "invitation",
      granted_points: 50_000,
    });

    const memberLogin = await injectSuccess<LoginResponse>(app, {
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    assert.equal(memberLogin.user.id, registration.user.id);
    assert.ok(memberLogin.token);

    const memberCredit = await injectSuccess<AccountCreditResponse>(app, {
      method: "GET",
      url: "/api/v1/account-credits/me",
      token: memberLogin.token,
    });
    assert.equal(memberCredit.balance_points, 50_000);
    assert.equal(memberCredit.daily_limit_points, 50_000);
    assert.equal(memberCredit.used_today_points, 0);
    assert.equal(memberCredit.remaining_today_points, 50_000);

    const adminLogin = await injectSuccess<LoginResponse>(app, {
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: admin.username, password: admin.password },
    });
    assert.equal(adminLogin.user.role, "admin");

    const listed = await injectSuccess<{ items: AdminListedUser[]; count: number }>(app, {
      method: "GET",
      url: "/api/v1/admin/users",
      token: adminLogin.token,
    });
    const listedMember = listed.items.find((item) => item.id === registration.user.id);
    assert.ok(listedMember);
    assert.equal(listedMember.email, email);
    assert.ok(listedMember.email_verified_at);
    assert.equal(listedMember.account_credit?.balance_points, 50_000);
    assert.equal(listedMember.account_credit?.daily_limit_points, 50_000);
    assert.equal(listedMember.account_credit?.remaining_today_points, 50_000);

    const increase = await injectSuccess<{ adjustment: AccountCreditAdjustment }>(app, {
      method: "POST",
      url: `/api/v1/admin/users/${registration.user.id}/account-credits/adjust`,
      token: adminLogin.token,
      payload: { amount_points: 100, reason: "运营底座 P0 加分回归" },
    });
    assert.equal(increase.adjustment.amount_points, 100);
    assert.equal(increase.adjustment.balance_points, 50_100);

    const decrease = await injectSuccess<{ adjustment: AccountCreditAdjustment }>(app, {
      method: "POST",
      url: `/api/v1/admin/users/${registration.user.id}/account-credits/adjust`,
      token: adminLogin.token,
      payload: { amount_points: -100, reason: "运营底座 P0 减分回归" },
    });
    assert.equal(decrease.adjustment.amount_points, -100);
    assert.equal(decrease.adjustment.balance_points, 50_000);

    const project = await injectSuccess<{ id: string }>(app, {
      method: "POST",
      url: "/api/v1/projects",
      token: memberLogin.token,
      payload: { name: `运营底座 P0 ${randomUUID()}`, description: "一次性本地验收项目" },
      expectedStatus: 201,
    });
    const episode = await injectSuccess<{ id: string }>(app, {
      method: "POST",
      url: `/api/v1/projects/${project.id}/episodes`,
      token: memberLogin.token,
      payload: { episode_no: 1, name: "第 1 集" },
      expectedStatus: 201,
    });
    const shot = await injectSuccess<{ id: string }>(app, {
      method: "POST",
      url: `/api/v1/episodes/${episode.id}/shots`,
      token: memberLogin.token,
      payload: {
        shot_no: "001",
        title: "最便宜报价验收",
        image_prompt: "一间明亮、整洁的现代办公室",
      },
      expectedStatus: 201,
    });

    const catalog = await injectSuccess<{ tiers: CapabilityTierResponse[] }>(app, {
      method: "GET",
      url: "/api/v1/generation/capability-tiers?media_type=image",
      token: memberLogin.token,
    });
    const activeImageTiers = catalog.tiers.filter((tier) => tier.status === "active");
    assert.ok(
      activeImageTiers.length > 0,
      "development pricing seed must expose at least one active image tier",
    );
    const cheapest = [...activeImageTiers].sort((left, right) => (
      left.price.points - right.price.points || left.tier_id.localeCompare(right.tier_id)
    ))[0]!;

    const quotePayload = {
      media_kind: "image",
      tier_id: cheapest.tier_id,
      project_id: project.id,
      episode_id: episode.id,
      shot_id: shot.id,
      prompt: "一间明亮、整洁的现代办公室，纪实摄影风格",
      parameters: requestParametersForImageTier(cheapest.params),
      quantity: 1,
      client_idempotency_key: `ops-p0-quote-${randomUUID()}`,
    };
    const quote = await withHeldAccountRowLock(
      handle,
      quoted,
      registration.user.id,
      () => injectSuccess<GenerationQuoteResponse>(app!, {
        method: "POST",
        url: "/api/v1/generations/estimate",
        token: memberLogin.token,
        payload: quotePayload,
      }),
    );
    assert.equal(quote.status, "pending_confirmation");
    assert.equal(quote.tier_id, cheapest.tier_id);
    assert.equal(quote.estimated_cost_fen, cheapest.price.points);
    assert.equal(quote.price_snapshot.unit_price_fen, cheapest.price.points);
    assert.equal(quote.generation_request_id, null);
    assert.equal(quote.generation_attempt_id, null);
    await handle.pool.query(
      `UPDATE ${quoted}.generation_quotes
       SET normalized_request = (normalized_request - 'projectId')
         || jsonb_build_object('project_id', $1::text)
       WHERE id = $2`,
      [project.id, quote.generation_quote_id],
    );

    const zeroBalance = await injectSuccess<{ adjustment: AccountCreditAdjustment }>(app, {
      method: "POST",
      url: `/api/v1/admin/users/${registration.user.id}/account-credits/adjust`,
      token: adminLogin.token,
      payload: { amount_points: -50_000, reason: "运营底座 P0 零余额闸回归" },
    });
    assert.equal(zeroBalance.adjustment.balance_points, 0);

    const estimateAtZero = await app.inject({
      method: "POST",
      url: "/api/v1/generations/estimate",
      headers: { authorization: `Bearer ${memberLogin.token}` },
      payload: {
        ...quotePayload,
        client_idempotency_key: `ops-p0-zero-${randomUUID()}`,
      },
    });
    assert.equal(estimateAtZero.statusCode, 422, estimateAtZero.body);
    assert.equal(estimateAtZero.json().error.code, "account_credit_insufficient");

    const confirmAtZero = await app.inject({
      method: "POST",
      url: `/api/v1/generation-quotes/${quote.generation_quote_id}/confirm`,
      headers: { authorization: `Bearer ${memberLogin.token}` },
    });
    assert.equal(confirmAtZero.statusCode, 422, confirmAtZero.body);
    assert.equal(confirmAtZero.json().error.code, "account_credit_insufficient");

    const restoredBalance = await injectSuccess<{ adjustment: AccountCreditAdjustment }>(app, {
      method: "POST",
      url: `/api/v1/admin/users/${registration.user.id}/account-credits/adjust`,
      token: adminLogin.token,
      payload: { amount_points: 50_000, reason: "运营底座 P0 恢复验收余额" },
    });
    assert.equal(restoredBalance.adjustment.balance_points, 50_000);
    const confirmedQuote = await injectSuccess<GenerationQuoteResponse>(app, {
      method: "POST",
      url: `/api/v1/generation-quotes/${quote.generation_quote_id}/confirm`,
      token: memberLogin.token,
    });
    assert.equal(confirmedQuote.status, "confirmed");
    assert.equal(confirmedQuote.generation_request_id, null);

    const evidence = await readEvidence(handle, quoted, registration.user.id, quote.generation_quote_id);
    assert.deepEqual(evidence, {
      quotes: 1,
      quote_status: "confirmed",
      requests: 0,
      attempts: 0,
      provider_costs: 0,
      generation_debits: 0,
      admin_adjustments: 4,
      admin_adjustment_audits: 4,
      invite_redemptions: 1,
      fixed_invite_uses: 1,
      balance_points: 50_000,
      used_today_points: 0,
    });

    await assertGenerationLockOrderHasNoDeadlocks({
      handle,
      quoted,
      projectId: project.id,
      episodeId: episode.id,
      shotId: shot.id,
      tier: cheapest,
    });
    assert.deepEqual(
      await readEvidence(handle, quoted, registration.user.id, quote.generation_quote_id),
      evidence,
      "并发锁序夹具不得污染业务验收账号的报价止步证据",
    );
  } finally {
    await app?.close().catch(() => undefined);
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

test("#16 项目成员五种生产角色经真实 HTTP + PostgreSQL 完成全生命周期", {
  timeout: 180_000,
  concurrency: false,
}, async (context) => {
  if (!databaseUrl) {
    context.skip("OPS_P0_HTTP_TEST_DATABASE_URL 未设置；一次性 PostgreSQL runner 会执行本门禁");
    return;
  }
  assertLocalDatabase(databaseUrl);
  assert.ok(schemaName, "runner must provide POSTGRES_SCHEMA");
  assert.match(schemaName, /^ops_p0_http_[a-z0-9_]+$/);

  const handle = createDatabase(databaseUrl);
  const quoted = quoteIdentifier(schemaName);
  let app: FastifyInstance | undefined;
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    await applyAllMigrations(handle, schemaName);

    const owner = await seedLoginUser(handle.db, "member-owner", "项目负责人");
    const collaborator = await seedLoginUser(handle.db, "member-collaborator", "项目协作者");
    const outsider = await seedLoginUser(handle.db, "member-outsider", "项目外成员");
    app = await createOpsP0App(handle.db, { verificationCode: null });

    const ownerLogin = await injectSuccess<LoginResponse>(app, {
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: owner.username, password: owner.password },
    });
    const collaboratorLogin = await injectSuccess<LoginResponse>(app, {
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: collaborator.username, password: collaborator.password },
    });
    const outsiderLogin = await injectSuccess<LoginResponse>(app, {
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: outsider.username, password: outsider.password },
    });

    const project = await injectSuccess<{ id: string }>(app, {
      method: "POST",
      url: "/api/v1/projects",
      token: ownerLogin.token,
      payload: { name: `#16 项目成员生命周期 ${randomUUID()}` },
      expectedStatus: 201,
    });

    const allRoles = [
      "reviewer",
      "coordinator",
      "screenwriter",
      "art",
      "director",
    ];
    const created = await injectSuccess<{ item: ProjectMemberApiRecord }>(app, {
      method: "POST",
      url: `/api/v1/projects/${project.id}/members`,
      token: ownerLogin.token,
      payload: {
        user_id: collaborator.id,
        role: "editor",
        production_roles: allRoles,
      },
      expectedStatus: 201,
    });
    assert.equal(created.item.user_id, collaborator.id);
    assert.equal(created.item.project_role, "editor");
    assert.deepEqual(created.item.production_roles, [
      "director",
      "art",
      "screenwriter",
      "coordinator",
      "reviewer",
    ]);

    const replayedWithoutRoles = await injectSuccess<{ item: ProjectMemberApiRecord }>(app, {
      method: "POST",
      url: `/api/v1/projects/${project.id}/members`,
      token: ownerLogin.token,
      payload: {
        user_id: collaborator.id,
        role: "editor",
      },
      expectedStatus: 201,
    });
    assert.deepEqual(
      replayedWithoutRoles.item.production_roles,
      ["director", "art", "screenwriter", "coordinator", "reviewer"],
      "旧调用端省略 production_roles 时不得清空已有职责",
    );

    const listed = await injectSuccess<{ items: ProjectMemberApiRecord[]; count: number }>(app, {
      method: "GET",
      url: `/api/v1/projects/${project.id}/members`,
      token: ownerLogin.token,
    });
    assert.equal(listed.count, 2);
    assert.deepEqual(
      listed.items.find((item) => item.user_id === collaborator.id)?.production_roles,
      ["director", "art", "screenwriter", "coordinator", "reviewer"],
    );

    const capabilities = await injectSuccess<{
      projects: Array<{
        project_id: string;
        role: string;
        production_roles: string[];
      }>;
    }>(app, {
      method: "GET",
      url: "/api/v1/me/capabilities",
      token: collaboratorLogin.token,
    });
    assert.deepEqual(
      capabilities.projects.find((item) => item.project_id === project.id),
      {
        project_id: project.id,
        role: "editor",
        production_roles: ["director", "art", "screenwriter", "coordinator", "reviewer"],
      },
    );

    const transferredOwner = await injectSuccess<{ item: ProjectMemberApiRecord }>(app, {
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
      token: ownerLogin.token,
      payload: { role: "owner" },
    });
    assert.equal(transferredOwner.item.project_role, "owner");
    assert.deepEqual(
      transferredOwner.item.production_roles,
      ["director", "art", "screenwriter", "coordinator", "reviewer"],
      "转移负责人不能清空正交的生产职责",
    );
    assert.deepEqual(
      (await handle.pool.query<{
        owner_user_id: string;
        owner_count: number;
      }>(
        `SELECT p.owner_user_id,
          (SELECT count(*)::int FROM ${quoted}.project_members pm
           WHERE pm.project_id = p.id AND pm.role = 'owner') AS owner_count
         FROM ${quoted}.projects p
         WHERE p.id = $1`,
        [project.id],
      )).rows[0],
      { owner_user_id: collaborator.id, owner_count: 1 },
      "负责人转移必须同步 projects.owner_user_id 且始终唯一",
    );

    const restoredOwner = await injectSuccess<{ item: ProjectMemberApiRecord }>(app, {
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/members/${owner.id}`,
      token: collaboratorLogin.token,
      payload: { role: "owner" },
    });
    assert.equal(restoredOwner.item.project_role, "owner");
    const restoredMembers = await injectSuccess<{
      items: ProjectMemberApiRecord[];
      count: number;
    }>(app, {
      method: "GET",
      url: `/api/v1/projects/${project.id}/members`,
      token: ownerLogin.token,
    });
    assert.deepEqual(
      restoredMembers.items.find((item) => item.user_id === collaborator.id)?.production_roles,
      ["director", "art", "screenwriter", "coordinator", "reviewer"],
      "负责人转回后协作者职责仍须保留",
    );

    const updated = await injectSuccess<{ item: ProjectMemberApiRecord }>(app, {
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
      token: ownerLogin.token,
      payload: {
        role: "viewer",
        production_roles: ["reviewer", "screenwriter"],
      },
    });
    assert.equal(updated.item.project_role, "viewer");
    assert.deepEqual(updated.item.production_roles, ["screenwriter", "reviewer"]);

    const cleared = await injectSuccess<{ item: ProjectMemberApiRecord }>(app, {
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
      token: ownerLogin.token,
      payload: { production_roles: [] },
    });
    assert.equal(cleared.item.project_role, "viewer");
    assert.deepEqual(cleared.item.production_roles, []);

    const reassigned = await injectSuccess<{ item: ProjectMemberApiRecord }>(app, {
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
      token: ownerLogin.token,
      payload: { production_roles: ["reviewer", "screenwriter"] },
    });
    assert.equal(reassigned.item.project_role, "viewer");
    assert.deepEqual(reassigned.item.production_roles, ["screenwriter", "reviewer"]);

    const concurrentRoleSets = [
      {
        input: ["art", "director"],
        expected: ["director", "art"],
      },
      {
        input: ["reviewer", "coordinator"],
        expected: ["coordinator", "reviewer"],
      },
    ] as const;
    const concurrentReplacements = await Promise.all(concurrentRoleSets.map((roles) =>
      injectSuccess<{ item: ProjectMemberApiRecord }>(app!, {
        method: "PATCH",
        url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
        token: ownerLogin.token,
        payload: { production_roles: roles.input },
      })));
    assert.deepEqual(
      concurrentReplacements.map((result) => result.item.production_roles),
      concurrentRoleSets.map((roles) => roles.expected),
      "并发整组替换都应在项目锁内完整落库，不能出现部分职责",
    );
    const afterConcurrentReplacement = await injectSuccess<{
      items: ProjectMemberApiRecord[];
      count: number;
    }>(app, {
      method: "GET",
      url: `/api/v1/projects/${project.id}/members`,
      token: ownerLogin.token,
    });
    const concurrentFinalRoles = afterConcurrentReplacement.items
      .find((item) => item.user_id === collaborator.id)
      ?.production_roles;
    assert.equal(
      concurrentRoleSets.some((roles) => (
        JSON.stringify(roles.expected) === JSON.stringify(concurrentFinalRoles)
      )),
      true,
      "并发后的最终职责必须等于某一次完整请求，不能合并成越权集合",
    );
    await injectSuccess<{ item: ProjectMemberApiRecord }>(app, {
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
      token: ownerLogin.token,
      payload: { production_roles: ["reviewer", "screenwriter"] },
    });

    const pendingCommonAssetId = randomUUID();
    const reviewFixtureNow = new Date();
    await handle.db.insert(assetEntities).values({
      id: pendingCommonAssetId,
      ownerUserId: null,
      visibility: "common",
      assetKind: "keyframe",
      name: "#16 审片职责越权反例",
      displayName: "#16 审片职责越权反例",
      styleTags: [],
      approved: null,
      reuseScope: "all_projects",
      status: "pending_review",
      metadata: {},
      createdAt: reviewFixtureNow,
      updatedAt: reviewFixtureNow,
      useCount: 0,
    });
    await handle.db.insert(projectAssetRefs).values({
      id: randomUUID(),
      projectId: project.id,
      assetEntityId: pendingCommonAssetId,
      versionSnapshot: {},
      createdByUserId: owner.id,
      createdAt: reviewFixtureNow,
    });
    const productionReviewerCannotModerateCommonAsset = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/reviews/assets/${pendingCommonAssetId}/decision`,
      headers: { authorization: `Bearer ${collaboratorLogin.token}` },
      payload: { action: "approve" },
    });
    assert.equal(
      productionReviewerCannotModerateCommonAsset.statusCode,
      403,
      productionReviewerCannotModerateCommonAsset.body,
    );
    assert.equal(
      productionReviewerCannotModerateCommonAsset.json().error.code,
      "forbidden",
    );
    assert.match(
      productionReviewerCannotModerateCommonAsset.json().error.message,
      /只有平台管理员/u,
    );
    const untouchedReview = await handle.pool.query<{
      status: string;
      action_count: number;
    }>(
      `SELECT e.status,
        (SELECT count(*)::int FROM ${quoted}.asset_review_actions a
         WHERE a.asset_entity_id = e.id) AS action_count
       FROM ${quoted}.asset_entities e
       WHERE e.id = $1`,
      [pendingCommonAssetId],
    );
    assert.deepEqual(
      untouchedReview.rows[0],
      { status: "pending_review", action_count: 0 },
      "生产职责 reviewer 不能获得 #24 平台通用资产审核权或伪造审核动作",
    );

    const reviewerCannotManageMembers = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/members`,
      headers: { authorization: `Bearer ${collaboratorLogin.token}` },
    });
    assert.equal(reviewerCannotManageMembers.statusCode, 403, reviewerCannotManageMembers.body);
    assert.equal(reviewerCannotManageMembers.json().error.code, "forbidden");
    assert.match(reviewerCannotManageMembers.json().error.message, /没有.*权限/u);

    const outsiderCannotDiscoverProject = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/members`,
      headers: { authorization: `Bearer ${outsiderLogin.token}` },
    });
    assert.equal(outsiderCannotDiscoverProject.statusCode, 404, outsiderCannotDiscoverProject.body);
    assert.equal(outsiderCannotDiscoverProject.json().error.code, "not_found");

    const duplicateRole = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
      headers: { authorization: `Bearer ${ownerLogin.token}` },
      payload: { production_roles: ["director", "director"] },
    });
    assert.equal(duplicateRole.statusCode, 400, duplicateRole.body);
    assert.equal(duplicateRole.json().error.code, "invalid_request");
    assert.match(duplicateRole.json().error.message, /检查|填写/u);

    const unknownRole = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
      headers: { authorization: `Bearer ${ownerLogin.token}` },
      payload: { production_roles: ["executive-producer"] },
    });
    assert.equal(unknownRole.statusCode, 400, unknownRole.body);
    assert.equal(unknownRole.json().error.code, "invalid_request");

    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.project_member_production_roles
          (project_id, user_id, role, assigned_by_user_id)
         VALUES ($1, $2, 'not-a-production-role', $3)`,
        [project.id, collaborator.id, owner.id],
      ),
      (error: unknown) => postgresCode(error) === "23514",
      "数据库 CHECK 必须拒绝五种枚举之外的职责",
    );
    await assert.rejects(
      handle.pool.query(
        `INSERT INTO ${quoted}.project_member_production_roles
          (project_id, user_id, role, assigned_by_user_id)
         VALUES ($1, $2, 'director', $3)`,
        [project.id, outsider.id, owner.id],
      ),
      (error: unknown) => postgresCode(error) === "23503",
      "非项目成员不能凭空拥有生产职责",
    );

    const lifecycleAudits = await handle.pool.query<{
      action: string;
      actor_session_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, actor_session_id, metadata
       FROM ${quoted}.admin_operation_actions
       WHERE target_type = 'project_member'
         AND target_id = $1
         AND metadata->>'user_id' = $2
       ORDER BY created_at ASC, id ASC`,
      [project.id, collaborator.id],
    );
    const auditCounts = lifecycleAudits.rows.reduce<Record<string, number>>((counts, row) => ({
      ...counts,
      [row.action]: (counts[row.action] ?? 0) + 1,
    }), {});
    assert.deepEqual(auditCounts, {
      project_member_added: 2,
      project_member_role_changed: 1,
      project_member_production_roles_changed: 7,
    });
    assert.ok(lifecycleAudits.rows.every((row) => row.actor_session_id));
    assert.equal(
      lifecycleAudits.rows.some((row) => (
        row.action === "project_member_production_roles_changed"
        && JSON.stringify(row.metadata.from_production_roles) === JSON.stringify([])
        && JSON.stringify(row.metadata.to_production_roles)
          === JSON.stringify(["director", "art", "screenwriter", "coordinator", "reviewer"])
      )),
      true,
      "首次分配职责也必须记录 [] → 五职责，不能只依赖成员新增快照",
    );
    assert.equal(
      lifecycleAudits.rows.some((row) => (
        row.action === "project_member_production_roles_changed"
        && JSON.stringify(row.metadata.to_production_roles) === JSON.stringify(["screenwriter", "reviewer"])
      )),
      true,
    );

    await injectSuccess<{ deleted: boolean; user_id: string }>(app, {
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/members/${collaborator.id}`,
      token: ownerLogin.token,
    });
    const deletedFacts = await handle.pool.query<{
      members: number;
      roles: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM ${quoted}.project_members
         WHERE project_id = $1 AND user_id = $2) AS members,
        (SELECT count(*)::int FROM ${quoted}.project_member_production_roles
         WHERE project_id = $1 AND user_id = $2) AS roles`,
      [project.id, collaborator.id],
    );
    assert.deepEqual(deletedFacts.rows[0], { members: 0, roles: 0 });

    const removedAudit = await handle.pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata
       FROM ${quoted}.admin_operation_actions
       WHERE action = 'project_member_removed'
         AND target_id = $1
         AND metadata->>'user_id' = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [project.id, collaborator.id],
    );
    assert.deepEqual(removedAudit.rows[0]?.metadata.production_roles, ["screenwriter", "reviewer"]);

    const ownerCannotDeleteSelf = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${project.id}/members/${owner.id}`,
      headers: { authorization: `Bearer ${ownerLogin.token}` },
    });
    assert.equal(ownerCannotDeleteSelf.statusCode, 409, ownerCannotDeleteSelf.body);
    assert.equal(ownerCannotDeleteSelf.json().error.code, "project_owner_required");

    const migration051 = await readFile(
      path.resolve("migrations/051_project_member_production_roles.sql"),
      "utf8",
    );
    await handle.pool.query(renderMigrationSql(migration051, schemaName));
  } finally {
    await app?.close().catch(() => undefined);
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

async function createOpsP0App(
  db: Database,
  captured: { verificationCode: string | null },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const normalized = toHttpErrorResponse(error);
    return reply.code(normalized.statusCode).send({ ok: false, error: normalized.body });
  });
  app.addHook("preHandler", createAuthenticationHook(() => db));

  const authService = new AuthService(db);
  const authPort: AuthServicePort = {
    requestEmailVerification: async (input) => {
      const issued = await authService.requestEmailVerification(input);
      captured.verificationCode = issued.devLogCode;
      return issued;
    },
    register: (input) => authService.register(input),
    login: (input, userAgent) => authService.login(input, userAgent),
    loginCli: (input, userAgent) => authService.loginCli(input, userAgent),
    issueAgentCredential: (actor, input, userAgent) => (
      authService.issueAgentCredential(actor, input, userAgent)
    ),
    listAgentCredentials: (actor) => authService.listAgentCredentials(actor),
    revokeAgentCredential: (actor, credentialId) => (
      authService.revokeAgentCredential(actor, credentialId)
    ),
    logout: (sessionId) => authService.logout(sessionId),
  };

  await registerAuthRoutes(app, () => db, { createService: () => authPort });
  await registerProductionRoutes(app, () => db);
  await registerAccountCreditRoutes(app, () => db, {
    generationPilotCreditGateEnabled: true,
  });
  await registerGenerationRoutes(app, () => db, {
    createRepository: (database) => lockOrderRepository(database, productionLikeAccountGuard),
  });
  await registerCapabilityTierRoutes(app, () => db);
  await registerAdminUserRoutes(app, () => db);
  await registerOperationsRoutes(app, () => db);
  await registerReviewRoutes(app, () => db);
  return app;
}

async function applyAllMigrations(handle: DatabaseHandle, targetSchema: string): Promise<void> {
  const files = (await readdir(path.resolve("migrations")))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  assert.ok(files.includes("049_ops_p0_internal_pilot.sql"));
  assert.ok(files.includes("050_reference_review_paid_submission_guard.sql"));
  assert.ok(files.includes("051_project_member_production_roles.sql"));
  for (const file of files) {
    const source = await readFile(path.resolve("migrations", file), "utf8");
    await handle.pool.query(renderMigrationSql(source, targetSchema));
  }
}

async function seedCurrentDevelopmentPricing(db: Database): Promise<void> {
  const promotions = new Map(
    createSgoal04P2DevPromotionSeeds().map((seed) => [seed.id, seed]),
  );
  const desired = PRICING_TIER_SEEDS.map((seed) => promotions.get(seed.id) ?? seed);
  const now = new Date();
  await db.insert(pricingRules).values(desired.map((seed) => ({
    id: seed.id,
    provider: seed.provider,
    model: seed.model,
    mediaKind: seed.mediaKind,
    billingUnit: seed.billingUnit,
    unitPriceFen: seed.unitPriceFen,
    currency: seed.currency,
    source: seed.source,
    active: seed.active,
    effectiveFrom: now,
    effectiveTo: null,
    metadata: metadataFor(seed),
    createdAt: now,
    updatedAt: now,
  })));
}

async function seedDayZeroAdmin(db: Database): Promise<{
  id: string;
  username: string;
  password: string;
}> {
  const id = randomUUID();
  const username = "ops-p0-admin";
  const password = "ops-p0-admin-password";
  const now = new Date();
  await db.insert(users).values({
    id,
    username,
    displayName: "运营底座 P0 管理员",
    passwordHash: await hashPassword(password),
    role: "admin",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  return { id, username, password };
}

async function seedLoginUser(
  db: Database,
  usernamePrefix: string,
  displayName: string,
): Promise<{ id: string; username: string; password: string }> {
  const id = randomUUID();
  const username = `${usernamePrefix}-${id.slice(0, 12)}`;
  const password = `${usernamePrefix}-password`;
  const now = new Date();
  await db.insert(users).values({
    id,
    username,
    displayName,
    passwordHash: await hashPassword(password),
    role: "member",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  return { id, username, password };
}

async function injectSuccess<T>(
  app: FastifyInstance,
  input: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    payload?: Record<string, unknown>;
    token?: string;
    expectedStatus?: number;
  },
): Promise<T> {
  const response = await app.inject({
    method: input.method,
    url: input.url,
    ...(input.payload ? { payload: input.payload } : {}),
    ...(input.token ? { headers: { authorization: `Bearer ${input.token}` } } : {}),
  });
  assert.equal(response.statusCode, input.expectedStatus ?? 200, response.body);
  const body = response.json() as { ok: boolean; data?: T };
  assert.equal(body.ok, true, response.body);
  assert.ok(body.data);
  return body.data;
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function requestParametersForImageTier(
  params: Record<string, string | number | boolean>,
): Record<string, unknown> {
  return {
    ...(typeof params.resolution === "string" ? { resolution: params.resolution } : {}),
    ...(typeof params.aspect_ratio === "string" ? { ratio: params.aspect_ratio } : {}),
    ...(typeof params.watermark === "boolean" ? { watermark: params.watermark } : {}),
    ...(typeof params.sequential_image_generation === "string"
      ? { sequential_image_generation: params.sequential_image_generation }
      : {}),
  };
}

async function userCountByEmail(
  handle: DatabaseHandle,
  quoted: string,
  email: string,
): Promise<number> {
  const result = await handle.pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${quoted}.users WHERE lower(email) = lower($1)`,
    [email],
  );
  return result.rows[0]?.count ?? 0;
}

async function withHeldAccountRowLock<T>(
  handle: DatabaseHandle,
  quoted: string,
  userId: string,
  action: () => Promise<T>,
): Promise<T> {
  const client = await handle.pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query(
      `SELECT user_id FROM ${quoted}.user_credit_accounts WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    let settled = false;
    const outcomePromise = action().then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    void outcomePromise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(
      settled,
      false,
      "generation state transition must wait for the account row authorization lock",
    );
    await client.query("COMMIT");
    transactionOpen = false;
    const outcome = await outcomePromise;
    if (outcome.kind === "rejected") throw outcome.error;
    return outcome.value;
  } finally {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function assertGenerationLockOrderHasNoDeadlocks(input: {
  handle: DatabaseHandle;
  quoted: string;
  projectId: string;
  episodeId: string;
  shotId: string;
  tier: CapabilityTierResponse;
}): Promise<void> {
  const concurrencyUserId = randomUUID();
  const now = new Date();
  await input.handle.db.insert(users).values({
    id: concurrencyUserId,
    username: `ops-p0-lock-${concurrencyUserId.slice(0, 12)}`,
    displayName: "运营底座锁序回归用户",
    passwordHash: "test-only-not-a-login",
    role: "member",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await input.handle.db.insert(projectMembers).values({
    projectId: input.projectId,
    userId: concurrencyUserId,
    role: "editor",
    addedByUserId: concurrencyUserId,
    createdAt: now,
  });
  const actor: GenerationActor = {
    userId: concurrencyUserId,
    authorizedProjectId: input.projectId,
  };
  await input.handle.pool.query(
    `UPDATE ${input.quoted}.user_credit_accounts
     SET balance_points = 1000000000, daily_limit_points = 1000000000, updated_at = now()
     WHERE user_id = $1`,
    [actor.userId],
  );

  const baseRepository = lockOrderRepository(
    input.handle.db,
    productionLikeAccountGuard,
  );
  const submissionInput = await directImageInput(
    baseRepository,
    input,
    "estimate-submit-source",
  );
  const submissionQuote = await createConfirmedDirectQuote(
    baseRepository,
    actor,
    submissionInput,
  );
  const submitResult = await runEstimateTransitionRace({
    handle: input.handle,
    actor,
    estimateInput: await directImageInput(
      baseRepository,
      input,
      "estimate-submit-parallel",
    ),
    label: "同账户 estimate/submit",
    transition: (repository) => repository.createSubmission({
      actorId: actor.userId,
      ...(actor.authorizedProjectId
        ? { authorizedProjectId: actor.authorizedProjectId }
        : {}),
      source: "web",
      quoteId: submissionQuote.id,
      requestHash: hashGenerationRequest(submissionInput),
      request: submissionInput,
      budgetLimitFen: 1_000_000_000,
    }),
  });
  assert.ok("view" in submitResult, "estimate/submit 必须创建或重放一个生成请求");

  await input.handle.pool.query(
    `UPDATE ${input.quoted}.generation_attempts
     SET status = 'failed', phase = 'complete', retryable = TRUE,
         error_code = 'ops_p0_lock_order_fixture',
         error_message = 'test fixture', finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [submitResult.view.attemptId],
  );
  const retryQuote = await baseRepository.createRetryQuote({
    actorId: actor.userId,
    ...(actor.authorizedProjectId
      ? { authorizedProjectId: actor.authorizedProjectId }
      : {}),
    source: "web",
    requestId: submitResult.view.requestId,
    ttlSeconds: 600,
  });
  await baseRepository.confirmQuote(
    actor.userId,
    retryQuote.id,
    actor.authorizedProjectId,
  );
  const retryResult = await runEstimateTransitionRace({
    handle: input.handle,
    actor,
    estimateInput: await directImageInput(
      baseRepository,
      input,
      "estimate-retry-parallel",
    ),
    label: "同账户 estimate/retry",
    transition: (repository) => repository.createRetry({
      actorId: actor.userId,
      ...(actor.authorizedProjectId
        ? { authorizedProjectId: actor.authorizedProjectId }
        : {}),
      source: "web",
      requestId: submitResult.view.requestId,
      quoteId: retryQuote.id,
      clientIdempotencyKey: `ops-p0-retry-${randomUUID()}`,
      budgetLimitFen: 1_000_000_000,
    }),
  });
  assert.ok("view" in retryResult, "estimate/retry 必须创建或重放一个重试尝试");

  const batchInput = await directImageInput(
    baseRepository,
    input,
    "batch-submit-source",
  );
  const batchQuote = await createDirectQuote(
    baseRepository,
    actor,
    batchInput,
  );
  const batch: BatchGenerationSubmitInput = {
    projectId: input.projectId,
    clientIdempotencyKey: `ops-p0-batch-${randomUUID()}`,
    expectedTotalEstimatedCostFen: batchQuote.estimatedCostFen,
    productionMode: "full",
    items: [{ itemId: "ops-p0-lock-order-item", quoteId: batchQuote.id }],
  };
  const authorization = await baseRepository.createBatchAuthorization({
    actorId: actor.userId,
    ...(actor.authorizedProjectId
      ? { authorizedProjectId: actor.authorizedProjectId }
      : {}),
    source: "web",
    batch,
    listHash: hashGenerationBatch(batch),
  });
  await input.handle.pool.query(
    `UPDATE ${input.quoted}.generation_quotes
     SET status = 'pending_confirmation', confirmed_at = NULL,
         confirmed_by_user_id = NULL, updated_at = now()
     WHERE id = $1`,
    [batchQuote.id],
  );
  await runBatchSubmitLockRace({
    handle: input.handle,
    actor,
    quoteId: batchQuote.id,
    authorizationId: authorization.authorizationId,
  });
}

async function runEstimateTransitionRace<T>(input: {
  handle: DatabaseHandle;
  actor: GenerationActor;
  estimateInput: NormalizedGenerationInput;
  label: string;
  transition: (repository: PostgresGenerationRepository) => Promise<T>;
}): Promise<T> {
  const estimateHasAccount = deferred<void>();
  const transitionReachedAccount = deferred<void>();
  const estimateRepository = lockOrderRepository(input.handle.db, async (db, actorId) => {
    const summary = await readAccountCreditSummaryForUpdate(db, actorId);
    assertPositiveGenerationCredit(summary);
    estimateHasAccount.resolve(undefined);
    await transitionReachedAccount.promise;
  });
  const transitionRepository = lockOrderRepository(input.handle.db, async (db, actorId) => {
    transitionReachedAccount.resolve(undefined);
    const summary = await readAccountCreditSummaryForUpdate(db, actorId);
    assertPositiveGenerationCredit(summary);
  });

  const estimatePromise = createDirectQuote(
    estimateRepository,
    input.actor,
    input.estimateInput,
  );
  await withTimeout(
    estimateHasAccount.promise,
    5_000,
    `${input.label}：estimate 未拿到账户行锁`,
  );
  const transitionPromise = input.transition(transitionRepository);
  void transitionPromise.catch((error: unknown) => {
    transitionReachedAccount.reject(error);
  });
  const settled = await withTimeout(
    Promise.allSettled([estimatePromise, transitionPromise]),
    15_000,
    `${input.label}：并发事务未结束`,
  );
  assertSettledWithoutPgDeadlock(input.label, settled);
  const transition = settled[1];
  assert.equal(
    transition.status,
    "fulfilled",
    `${input.label} transition failed: ${settledFailure(transition)}`,
  );
  return transition.value;
}

async function runBatchSubmitLockRace(input: {
  handle: DatabaseHandle;
  actor: GenerationActor;
  quoteId: string;
  authorizationId: string;
}): Promise<void> {
  const confirmationHasQuote = deferred<void>();
  const batchReachedAccount = deferred<void>();
  const confirmationRepository = lockOrderRepository(
    input.handle.db,
    async (db, actorId) => {
      confirmationHasQuote.resolve(undefined);
      await Promise.race([
        batchReachedAccount.promise,
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      const summary = await readAccountCreditSummaryForUpdate(db, actorId);
      assertPositiveGenerationCredit(summary);
    },
  );
  const batchRepository = lockOrderRepository(input.handle.db, async (db, actorId) => {
    const summary = await readAccountCreditSummaryForUpdate(db, actorId);
    assertPositiveGenerationCredit(summary);
    batchReachedAccount.resolve(undefined);
  });

  const confirmationPromise = confirmationRepository.confirmQuote(
    input.actor.userId,
    input.quoteId,
    input.actor.authorizedProjectId,
  );
  await withTimeout(
    confirmationHasQuote.promise,
    5_000,
    "batch/submit：单项确认未拿到报价行锁",
  );
  const batchPromise = batchRepository.submitBatchAuthorization({
    actorId: input.actor.userId,
    ...(input.actor.authorizedProjectId
      ? { authorizedProjectId: input.actor.authorizedProjectId }
      : {}),
    source: "web",
    authorizationId: input.authorizationId,
    budgetLimitFen: 1_000_000_000,
  });
  void batchPromise.catch((error: unknown) => {
    batchReachedAccount.reject(error);
  });
  const settled = await withTimeout(
    Promise.allSettled([confirmationPromise, batchPromise]),
    15_000,
    "同账户 batch/submit：并发事务未结束",
  );
  assertSettledWithoutPgDeadlock("同账户 batch/submit", settled);
  for (const result of settled) {
    assert.equal(
      result.status,
      "fulfilled",
      `同账户 batch/submit failed: ${settledFailure(result)}`,
    );
  }
}

function lockOrderRepository(
  db: Database,
  accessGuard: GenerationActorAccessGuard,
): PostgresGenerationRepository {
  return new PostgresGenerationRepository(
    db,
    5_000,
    true,
    () => {},
    2,
    accessGuard,
  );
}

const productionLikeAccountGuard: GenerationActorAccessGuard = async (db, actorId) => {
  const summary = await readAccountCreditSummaryForUpdate(db, actorId);
  assertPositiveGenerationCredit(summary);
};

async function directImageInput(
  repository: PostgresGenerationRepository,
  input: {
    projectId: string;
    episodeId: string;
    shotId: string;
    tier: CapabilityTierResponse;
  },
  key: string,
): Promise<NormalizedGenerationInput> {
  const tier = await repository.resolveActiveTier({
    tierId: input.tier.tier_id,
    mediaKind: "image",
    parameters: generationParameters(requestParametersForImageTier(input.tier.params)),
    quantity: 1,
  });
  const request: SubmitGenerationInput = {
    projectId: input.projectId,
    episodeId: input.episodeId,
    shotId: input.shotId,
    mediaKind: "image",
    tierId: tier.tierId,
    model: tier.rule.model,
    prompt: `运营底座锁序回归 ${key}`,
    parameters: tier.parameters,
    referenceMediaIds: [],
    referenceAssetSnapshots: [],
    quantity: tier.quantity,
    productionMode: "full",
    clientIdempotencyKey: `ops-p0-${key}-${randomUUID()}`,
  };
  return normalizeGenerationInput(request);
}

function createDirectQuote(
  repository: PostgresGenerationRepository,
  actor: GenerationActor,
  request: NormalizedGenerationInput,
) {
  return repository.createSubmissionQuote({
    actorId: actor.userId,
    ...(actor.authorizedProjectId
      ? { authorizedProjectId: actor.authorizedProjectId }
      : {}),
    source: "web",
    requestHash: hashGenerationRequest(request),
    request,
    ttlSeconds: 600,
  });
}

async function createConfirmedDirectQuote(
  repository: PostgresGenerationRepository,
  actor: GenerationActor,
  request: NormalizedGenerationInput,
) {
  const quote = await createDirectQuote(repository, actor, request);
  await repository.confirmQuote(actor.userId, quote.id, actor.authorizedProjectId);
  return quote;
}

function assertSettledWithoutPgDeadlock(
  label: string,
  settled: PromiseSettledResult<unknown>[],
): void {
  for (const result of settled) {
    if (result.status === "rejected") {
      assert.equal(
        hasErrorCode(result.reason, "40P01"),
        false,
        `${label} hit PostgreSQL deadlock_detected: ${errorText(result.reason)}`,
      );
    }
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function settledFailure(result: PromiseSettledResult<unknown>): string {
  return result.status === "rejected" ? errorText(result.reason) : "none";
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readEvidence(
  handle: DatabaseHandle,
  quoted: string,
  userId: string,
  quoteId: string,
) {
  const result = await handle.pool.query<{
    quotes: number;
    quote_status: string;
    requests: number;
    attempts: number;
    provider_costs: number;
    generation_debits: number;
    admin_adjustments: number;
    admin_adjustment_audits: number;
    invite_redemptions: number;
    fixed_invite_uses: number;
    balance_points: number;
    used_today_points: number;
  }>(`
    SELECT
      (SELECT COUNT(*)::int FROM ${quoted}.generation_quotes WHERE user_id = $1) AS quotes,
      (SELECT status FROM ${quoted}.generation_quotes WHERE id = $2) AS quote_status,
      (SELECT COUNT(*)::int FROM ${quoted}.generation_requests WHERE user_id = $1) AS requests,
      (SELECT COUNT(*)::int FROM ${quoted}.generation_attempts ga
        JOIN ${quoted}.generation_requests gr ON gr.id = ga.request_id
        WHERE gr.user_id = $1) AS attempts,
      (SELECT COUNT(*)::int FROM ${quoted}.provider_costs WHERE actor_user_id = $1) AS provider_costs,
      (SELECT COUNT(*)::int FROM ${quoted}.user_credit_ledger_entries
        WHERE user_id = $1 AND entry_kind = 'generation_debit') AS generation_debits,
      (SELECT COUNT(*)::int FROM ${quoted}.user_credit_ledger_entries
        WHERE user_id = $1 AND entry_kind = 'admin_adjustment') AS admin_adjustments,
      (SELECT COUNT(*)::int FROM ${quoted}.admin_operation_actions
        WHERE target_id = $1 AND action = 'account_credit_adjusted') AS admin_adjustment_audits,
      (SELECT COUNT(*)::int FROM ${quoted}.invite_code_redemptions
        WHERE user_id = $1) AS invite_redemptions,
      (SELECT used_count FROM ${quoted}.invite_codes
        WHERE code_hash = '9b062e193fc35fbf9267d3f5ec74324edb9f7dd07f333e7b0eb8c5b8f771638a') AS fixed_invite_uses,
      (SELECT balance_points FROM ${quoted}.user_credit_accounts WHERE user_id = $1) AS balance_points,
      (SELECT COALESCE(SUM(charged_points), 0)::int FROM ${quoted}.user_credit_daily_usage
        WHERE user_id = $1) AS used_today_points
  `, [userId, quoteId]);
  return result.rows[0];
}

function assertLocalDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("OPS_P0_HTTP_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL");
  }
}

interface RegistrationResponse {
  user: {
    id: string;
    username: string;
    display_name: string;
    role: string;
  };
  account_credit: AccountCreditResponse;
  registration_grant: {
    source: string;
    granted_points: number;
  };
}

interface LoginResponse {
  token: string;
  expires_at: string;
  user: {
    id: string;
    username: string;
    display_name: string;
    role: string;
  };
}

interface ProjectMemberApiRecord {
  project_id: string;
  user_id: string;
  username: string;
  display_name: string;
  platform_role: "admin" | "operator" | "member";
  project_role: "owner" | "editor" | "viewer";
  production_roles: Array<"director" | "art" | "screenwriter" | "coordinator" | "reviewer">;
  added_by_user_id: string | null;
  created_at: string;
}

interface AccountCreditResponse {
  user_id: string;
  balance_points: number;
  daily_limit_points: number;
  used_today_points: number;
  remaining_today_points: number;
  day_date: string;
  point_to_fen: number;
}

interface AdminListedUser {
  id: string;
  email: string | null;
  email_verified_at: string | null;
  account_credit: AccountCreditResponse | null;
}

interface AccountCreditAdjustment {
  user_id: string;
  balance_points: number;
  amount_points: number;
  reason: string;
  created_at: string;
}

interface CapabilityTierResponse {
  tier_id: string;
  model_id: string;
  media_type: "image";
  params: Record<string, string | number | boolean>;
  price: {
    unit: "per_image";
    points: number;
  };
  status: "active";
}

interface GenerationQuoteResponse {
  generation_quote_id: string;
  status: string;
  tier_id: string;
  estimated_cost_fen: number;
  price_snapshot: {
    unit_price_fen: number;
  };
  generation_request_id: string | null;
  generation_attempt_id: string | null;
}
