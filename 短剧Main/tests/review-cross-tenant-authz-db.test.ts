import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  assetEntities,
  assetReviewActions,
  projectAssetRefs,
  projects,
  sessions,
  users,
} from "../src/db/schema.js";
import { ProjectAssetRepository } from "../src/modules/project-assets/repository.js";
import { hashSessionToken } from "../src/modules/auth/service.js";

/**
 * Issue #24 / DC V-38「通用资产只有超管能审」的真实 HTTP + PostgreSQL 守卫。
 *
 * 被堵的完整链路(2026-07-28 对抗复核发现):
 *   1. POST /api/v1/projects 只要登录 —— 任何注册用户都能建项目并成为 owner;
 *   2. canReferenceAsset 允许引用任意 visibility=common 资产,不看审核状态;
 *   3. lockProjectAssets 把「项目里的资产」等同于 project_asset_refs 有一行;
 *   4. canDecideAsset 曾对 membershipRole=owner 无条件放行;
 *   5. 写的是 asset_entities.status —— 全平台单列,不是 per-project。
 *
 * 第 1、2 步是正常功能,不该动;守卫加在第 4 步:全平台生效的写入需要全平台
 * 级别的授权(仅平台 admin)。
 */
const databaseUrl = process.env.REVIEW_AUTHZ_TEST_DATABASE_URL;

test("#24 通用资产只有超管能审，成功裁决保留完整动作事实(V-38)", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const now = new Date("2026-07-28T08:00:00.000Z");

  const attackerId = randomUUID();
  const victimId = randomUUID();
  const adminId = randomUUID();
  const attackerToken = `review-attacker-${randomUUID()}`;
  const victimToken = `review-victim-${randomUUID()}`;
  const adminToken = `review-admin-${randomUUID()}`;
  const attackerProjectId = randomUUID();
  const victimProjectId = randomUUID();
  const adminProjectId = randomUUID();
  // victim 的通用库素材:待审的和已过审的各一份。
  const pendingCommonAssetId = randomUUID();
  const approvedCommonAssetId = randomUUID();
  // victim 自己的通用素材,用于验证资产所有者也不能自审。
  const victimOwnPendingAssetId = randomUUID();
  // attacker 自己的个人素材,用于验证个人域完全绕过审核状态机。
  const attackerPersonalAssetId = randomUUID();

  const userIds = [attackerId, victimId, adminId];
  const projectIds = [attackerProjectId, victimProjectId, adminProjectId];
  const assetIds = [
    pendingCommonAssetId,
    approvedCommonAssetId,
    victimOwnPendingAssetId,
    attackerPersonalAssetId,
  ];
  let app: Awaited<ReturnType<typeof createApp>> | undefined;

  try {
    await handle.db.insert(users).values([
      userValues(attackerId, "review-authz-attacker", "Review Authz Attacker", "member", now),
      userValues(victimId, "review-authz-victim", "Review Authz Victim", "member", now),
      userValues(adminId, "review-authz-admin", "Review Authz Admin", "admin", now),
    ]);
    await handle.db.insert(sessions).values([
      sessionValues(attackerId, attackerToken, "review-authz-attacker", now),
      sessionValues(victimId, victimToken, "review-authz-victim", now),
      sessionValues(adminId, adminToken, "review-authz-admin", now),
    ]);
    await handle.db.insert(projects).values([
      projectValues(attackerProjectId, attackerId, "Attacker Project", now),
      projectValues(victimProjectId, victimId, "Victim Project", now),
      projectValues(adminProjectId, adminId, "Admin Project", now),
    ]);
    await handle.db.insert(assetEntities).values([
      assetValues(pendingCommonAssetId, victimId, "common", "pending_review", "平台通用待审素材", now),
      assetValues(approvedCommonAssetId, victimId, "common", "approved", "平台通用已过审素材", now),
      assetValues(victimOwnPendingAssetId, victimId, "common", "pending_review", "所有者待审素材", now),
      assetValues(attackerPersonalAssetId, attackerId, "personal", "rejected", "自己的个人素材", now),
    ]);

    const projectAssets = new ProjectAssetRepository(handle.db);

    // 现行入口只允许引入已过审通用资产；待审引用按历史事实直写，
    // 用于证明旧项目关系不能绕过新的平台审核权。
    await projectAssets.add(attackerId, attackerProjectId, { assetEntityId: approvedCommonAssetId }, attackerProjectId);
    await insertHistoricalProjectRef(handle, attackerProjectId, pendingCommonAssetId, attackerId, now);
    // 历史个人脏行在 041 应用前可能已被项目引用；直接造这条历史事实，
    // 避免用现行引用服务为 rejected 个人资产制造一条新关系。
    await insertHistoricalProjectRef(handle, attackerProjectId, attackerPersonalAssetId, attackerId, now);
    app = await createApp({ databaseHandle: handle, logger: false, startGenerationWorker: false });

    // 真实 HTTP 链路必须断在这里：Bearer 会话 -> Fastify -> service ->
    // repository -> PostgreSQL，不能只用 repository 直调替代 API 验收。
    const attackerApproved = await postDecision(
      app,
      attackerToken,
      attackerProjectId,
      pendingCommonAssetId,
      { action: "approve" },
    );
    assertForbiddenCommonAssetReview(attackerApproved, "自建项目的 owner 批准他人通用库素材必须被拒绝");
    assert.equal(
      await assetStatus(handle, pendingCommonAssetId),
      "pending_review",
      "被拒后全平台审核状态不能有任何改动",
    );
    assert.equal(
      await reviewActionCount(handle, pendingCommonAssetId),
      0,
      "被拒的审核决定不能留下审核动作记录",
    );

    // 拒绝方向同样是全平台写入,一并堵死。
    const attackerRejected = await postDecision(
      app,
      attackerToken,
      attackerProjectId,
      pendingCommonAssetId,
      { action: "reject", rejection_reason: "越权拒绝" },
    );
    assertForbiddenCommonAssetReview(attackerRejected, "越权拒绝他人通用库素材同样必须被拒绝");
    assert.equal(await assetStatus(handle, pendingCommonAssetId), "pending_review");

    // 反向的可用性攻击:把别人已过审的通用素材打回待审,会卡住全平台的付费生成。
    const attackerSubmitted = await postSubmit(
      app,
      attackerToken,
      attackerProjectId,
      [approvedCommonAssetId],
    );
    assertForbiddenCommonAssetReview(attackerSubmitted, "越权把他人通用库素材打回待审必须被拒绝");
    assert.equal(
      await assetStatus(handle, approvedCommonAssetId),
      "approved",
      "被拒的提审不能改动全平台审核状态",
    );

    // R128:个人域免审。即使历史脏行带 rejected,也不能通过审核 API 改状态或留动作。
    const personalSubmitted = await postSubmit(
      app,
      attackerToken,
      attackerProjectId,
      [attackerPersonalAssetId],
    );
    assert.equal(personalSubmitted.statusCode, 409, personalSubmitted.body);
    assert.equal(personalSubmitted.json().error.code, "personal_asset_review_not_applicable");
    const personalDecided = await postDecision(
      app,
      attackerToken,
      attackerProjectId,
      attackerPersonalAssetId,
      { action: "approve" },
    );
    assert.equal(personalDecided.statusCode, 409, personalDecided.body);
    assert.equal(personalDecided.json().error.code, "personal_asset_review_not_applicable");
    assert.equal(await assetStatus(handle, attackerPersonalAssetId), "rejected");
    assert.equal(await reviewActionCount(handle, attackerPersonalAssetId), 0);

    // 资产所有者也不是平台审核角色，不能自审自己的通用素材。
    await insertHistoricalProjectRef(handle, victimProjectId, victimOwnPendingAssetId, victimId, now);
    const ownerSelfReview = await postDecision(
      app,
      victimToken,
      victimProjectId,
      victimOwnPendingAssetId,
      { action: "approve" },
    );
    assertForbiddenCommonAssetReview(ownerSelfReview, "通用资产所有者也不能代替超管审核");
    assert.equal(await assetStatus(handle, victimOwnPendingAssetId), "pending_review");
    assert.equal(await reviewActionCount(handle, victimOwnPendingAssetId), 0);

    // 正向:平台 admin 可以审。放在最后,顺带证明前面被拒的素材本身是可审的,
    // 拒绝来自权限判定而不是状态机卡住。
    await insertHistoricalProjectRef(handle, adminProjectId, pendingCommonAssetId, adminId, now);
    const adminDecided = await postDecision(
      app,
      adminToken,
      adminProjectId,
      pendingCommonAssetId,
      { action: "approve" },
    );
    assert.equal(adminDecided.statusCode, 200, adminDecided.body);
    assert.equal(adminDecided.json().data.status, "approved");
    assert.equal(await assetStatus(handle, pendingCommonAssetId), "approved");

    const auditRows = await handle.db.select().from(assetReviewActions)
      .where(eq(assetReviewActions.assetEntityId, pendingCommonAssetId));
    assert.equal(auditRows.length, 1, "一次成功裁决必须只落一条审核动作事实");
    assert.equal(auditRows[0]?.projectId, adminProjectId);
    assert.equal(auditRows[0]?.assetEntityId, pendingCommonAssetId);
    assert.equal(auditRows[0]?.action, "approved");
    assert.equal(auditRows[0]?.fromStatus, "pending_review");
    assert.equal(auditRows[0]?.toStatus, "approved");
    assert.equal(auditRows[0]?.reviewerUserId, adminId);
    assert.equal(auditRows[0]?.assignedReviewerUserId, null);
    assert.equal(auditRows[0]?.rejectionReason, null);

    const auditResponse = await getActions(app, adminToken, adminProjectId, pendingCommonAssetId);
    assert.equal(auditResponse.statusCode, 200, auditResponse.body);
    assert.equal(auditResponse.json().data.count, 1);
    assert.deepEqual(
      {
        project_id: auditResponse.json().data.items[0].project_id,
        asset_id: auditResponse.json().data.items[0].asset_id,
        action: auditResponse.json().data.items[0].action,
        from_status: auditResponse.json().data.items[0].from_status,
        to_status: auditResponse.json().data.items[0].to_status,
        reviewer_user_id: auditResponse.json().data.items[0].reviewer_user_id,
        reviewer_display_name: auditResponse.json().data.items[0].reviewer_display_name,
      },
      {
        project_id: adminProjectId,
        asset_id: pendingCommonAssetId,
        action: "approved",
        from_status: "pending_review",
        to_status: "approved",
        reviewer_user_id: adminId,
        reviewer_display_name: "Review Authz Admin",
      },
      "审核记录 API 必须把执行人和前后状态作为可解释证据返回",
    );
  } finally {
    await app?.close();
    await handle.db.delete(assetReviewActions)
      .where(inArray(assetReviewActions.assetEntityId, assetIds)).catch(() => undefined);
    await handle.db.delete(projectAssetRefs)
      .where(inArray(projectAssetRefs.projectId, projectIds)).catch(() => undefined);
    await handle.db.delete(assetEntities)
      .where(inArray(assetEntities.id, assetIds)).catch(() => undefined);
    await handle.db.delete(projects).where(inArray(projects.id, projectIds)).catch(() => undefined);
    await handle.db.delete(sessions).where(inArray(sessions.userId, userIds)).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, userIds)).catch(() => undefined);
    await handle.pool.end();
  }
});

async function assetStatus(handle: DatabaseHandle, assetId: string): Promise<string | undefined> {
  const rows = await handle.db.select({ status: assetEntities.status })
    .from(assetEntities).where(eq(assetEntities.id, assetId)).limit(1);
  return rows[0]?.status;
}

async function reviewActionCount(handle: DatabaseHandle, assetId: string): Promise<number> {
  const rows = await handle.db.select({ id: assetReviewActions.id })
    .from(assetReviewActions).where(eq(assetReviewActions.assetEntityId, assetId));
  return rows.length;
}

async function insertHistoricalProjectRef(
  handle: DatabaseHandle,
  projectId: string,
  assetEntityId: string,
  createdByUserId: string,
  createdAt: Date,
): Promise<void> {
  await handle.db.insert(projectAssetRefs).values({
    id: randomUUID(),
    projectId,
    assetEntityId,
    assetVariantId: null,
    assetMediaId: null,
    versionSnapshot: {},
    createdByUserId,
    createdAt,
    deletedAt: null,
    deletedByUserId: null,
  });
}

function userValues(id: string, username: string, displayName: string, role: string, now: Date) {
  return {
    id,
    username: `${username}-${id.slice(0, 8)}`,
    displayName,
    passwordHash: "test-only-hash",
    active: true,
    role: role as "member" | "admin",
    createdAt: now,
    updatedAt: now,
  };
}

function sessionValues(userId: string, token: string, userAgent: string, now: Date) {
  return {
    id: randomUUID(),
    userId,
    tokenHash: hashSessionToken(token),
    credentialSource: "web" as const,
    agentType: null,
    userAgent,
    credentialLabel: null,
    issuedBySessionId: null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    revokedAt: null,
    createdAt: now,
  };
}

function projectValues(id: string, ownerUserId: string, name: string, now: Date) {
  return {
    id, ownerUserId, name, description: null, status: "active",
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function assetValues(
  id: string,
  ownerUserId: string | null,
  visibility: "common" | "personal",
  status: string,
  name: string,
  now: Date,
) {
  return {
    id, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId, visibility,
    assetKind: "keyframe", name, displayName: name, intro: null, appearance: null, ageValue: null, gender: null,
    heightCm: null, hairDescription: null, outfitDescription: null, category: null, styleTags: [],
    approved: status === "approved", reuseScope: "all_projects", status, sourceFileUrl: null, metadata: {},
    createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
  };
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("REVIEW_AUTHZ_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}

function postDecision(
  app: Awaited<ReturnType<typeof createApp>>,
  token: string,
  projectId: string,
  assetId: string,
  payload: { action: "approve" | "reject"; rejection_reason?: string },
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/reviews/assets/${assetId}/decision`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

function postSubmit(
  app: Awaited<ReturnType<typeof createApp>>,
  token: string,
  projectId: string,
  assetIds: string[],
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/projects/${projectId}/reviews/submit`,
    headers: { authorization: `Bearer ${token}` },
    payload: { asset_ids: assetIds },
  });
}

function getActions(
  app: Awaited<ReturnType<typeof createApp>>,
  token: string,
  projectId: string,
  assetId: string,
) {
  return app.inject({
    method: "GET",
    url: `/api/v1/projects/${projectId}/reviews/assets/${assetId}/actions`,
    headers: { authorization: `Bearer ${token}` },
  });
}

function assertForbiddenCommonAssetReview(
  response: Awaited<ReturnType<typeof postDecision>>,
  message: string,
): void {
  assert.equal(response.statusCode, 403, `${message}: ${response.body}`);
  assert.equal(response.json().error.code, "forbidden");
  assert.equal(
    response.json().error.message,
    "通用库资产的审核状态全平台生效，只有平台管理员可以变更",
  );
}
