import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetReviewActions,
  assetVariants,
  generationAttempts,
  generationRequests,
  projectMembers,
  projectAssetRefs,
  projectReviewPolicies,
  users,
} from "../../db/schema.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { platformRoleOrMember } from "../auth/types.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccess, ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import { assertDecisionAllowed, type ReviewStore } from "./service.js";
import type {
  AssetReviewActionRecord,
  AssetReviewItem,
  AssetReviewStatus,
  ProjectReviewPolicy,
  PutProjectReviewPolicyInput,
  ReviewActor,
  ReviewMediaKind,
} from "./types.js";

type SqlResult<T> = { rows: T[] };
type PolicyRow = typeof projectReviewPolicies.$inferSelect;
type ActionRow = typeof assetReviewActions.$inferSelect;

interface ProjectAssetRow {
  id: string;
  status: string;
  mediaKind: ReviewMediaKind;
  visibility: string;
  ownerUserId: string | null;
}

/** The ownership facts a review decision needs, independent of any project. */
export interface ReviewTargetAsset {
  visibility: string;
  ownerUserId: string | null;
}

/** PostgreSQL is the only formal source for policy, state and action history. */
export class PostgresReviewRepository implements ReviewStore {
  constructor(private readonly db: Database) {}

  async listPolicies(actorInput: ReviewActor, projectId: string): Promise<ProjectReviewPolicy[]> {
    await this.requireProjectAction(this.db, actorInput, projectId, "read");
    const rows = await this.db.select().from(projectReviewPolicies)
      .where(eq(projectReviewPolicies.projectId, projectId))
      .orderBy(asc(projectReviewPolicies.mediaKind));
    const storedByKind = new Map(rows.map((row) => [row.mediaKind as ReviewMediaKind, toPolicy(row)]));
    return (["image", "video", "audio"] as const).map((mediaKind) => storedByKind.get(mediaKind)
      ?? defaultPolicy(projectId, mediaKind));
  }

  async getPolicy(
    actorInput: ReviewActor,
    projectId: string,
    mediaKind: ReviewMediaKind,
  ): Promise<ProjectReviewPolicy | undefined> {
    await this.requireProjectAction(this.db, actorInput, projectId, "read");
    const rows = await this.db.select().from(projectReviewPolicies).where(and(
      eq(projectReviewPolicies.projectId, projectId),
      eq(projectReviewPolicies.mediaKind, mediaKind),
    )).limit(1);
    return rows[0] ? toPolicy(rows[0]) : defaultPolicy(projectId, mediaKind);
  }

  async putPolicy(
    actorInput: ReviewActor,
    projectId: string,
    input: PutProjectReviewPolicyInput,
  ): Promise<ProjectReviewPolicy> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const actor = toActor(actorInput);
      await this.requireProjectAction(tx, actor, projectId, "manage_review_policy");
      const now = new Date();
      const existing = await tx.select().from(projectReviewPolicies).where(and(
        eq(projectReviewPolicies.projectId, projectId),
        eq(projectReviewPolicies.mediaKind, input.mediaKind),
      )).limit(1).for("update");
      const current = existing[0];
      if (!current && input.expectedVersion !== 0) {
        throw policyVersionConflict(null);
      }
      if (current && current.version !== input.expectedVersion) {
        throw policyVersionConflict(current.version);
      }

      const reviewerUserId = input.reviewerUserId === undefined
        ? current?.reviewerUserId ?? null
        : input.reviewerUserId;
      if (reviewerUserId) await assertProjectMember(tx, projectId, reviewerUserId);

      if (!current) {
        const created = await tx.insert(projectReviewPolicies).values({
          id: crypto.randomUUID(),
          projectId,
          mediaKind: input.mediaKind,
          defaultStrategy: input.defaultStrategy,
          reviewerUserId,
          updatedByUserId: actor.id,
          version: 1,
          createdAt: now,
          updatedAt: now,
        }).returning();
        const row = created[0];
        if (!row) throw new Error("审核默认策略未能写入");
        return toPolicy(row);
      }

      const updated = await tx.update(projectReviewPolicies).set({
        defaultStrategy: input.defaultStrategy,
        reviewerUserId,
        updatedByUserId: actor.id,
        version: sql`${projectReviewPolicies.version} + 1`,
        updatedAt: now,
      }).where(and(
        eq(projectReviewPolicies.id, current.id),
        eq(projectReviewPolicies.version, input.expectedVersion),
      )).returning();
      const row = updated[0];
      if (!row) throw policyVersionConflict(current.version);
      return toPolicy(row);
    });
  }

  async submitAssets(actorInput: ReviewActor, projectId: string, assetIds: string[]): Promise<AssetReviewItem[]> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const actor = toActor(actorInput);
      const projectAccess = await this.requireProjectAction(tx, actor, projectId, "manage_review_policy");
      const assets = await lockProjectAssets(tx, projectId, assetIds);
      const byId = new Map(assets.map((asset) => [asset.id, asset]));
      const assignees = new Map<ReviewMediaKind, string | null>();
      const now = new Date();
      const outcomes: AssetReviewItem[] = [];

      for (const assetId of assetIds) {
        const asset = byId.get(assetId);
        if (!asset) throw new NotFoundError("项目中不存在该资产");
        if (asset.visibility === "personal") throw personalAssetReviewNotApplicable();
        // Re-submitting is the same global write as deciding: it would let a
        // stranger pull an approved shared asset back into pending_review.
        if (!canChangeAssetReviewState(projectAccess, actor.id, asset)) {
          throw sharedAssetReviewForbidden();
        }
        const current = assertReviewStatus(asset.status, assetId);
        const assignedReviewerUserId = await reviewerForMediaKind(tx, projectId, asset.mediaKind, assignees);
        if (current === "pending_review") {
          outcomes.push({ assetId, status: current, changed: false, reason: "already_pending_review" });
          continue;
        }
        if (current === "approved") {
          outcomes.push({ assetId, status: current, changed: false, reason: "already_approved" });
          continue;
        }
        await assertNoSubmittingGenerationReferences(tx, [assetId]);

        // `approved` is a legacy compatibility field still read by older
        // catalogs. Keep it coherent with the review-domain status.
        const updated = await tx.update(assetEntities)
          .set({ status: "pending_review", approved: null, updatedAt: now })
          .where(and(eq(assetEntities.id, assetId), eq(assetEntities.status, current)))
          .returning({ id: assetEntities.id });
        if (!updated[0]) throw assetReviewStateConflict(assetId, current);
        const action = await insertAction(tx, {
          projectId,
          assetId,
          action: "submitted",
          fromStatus: current,
          toStatus: "pending_review",
          reviewerUserId: actor.id,
          assignedReviewerUserId,
          createdAt: now,
        });
        outcomes.push({
          assetId,
          status: "pending_review",
          changed: true,
          reason: "submitted",
          latestAction: action,
        });
      }
      return outcomes;
    });
  }

  async decideAsset(
    actorInput: ReviewActor,
    projectId: string,
    assetId: string,
    input: { action: "approved" | "rejected"; rejectionReason?: string },
  ): Promise<AssetReviewItem> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      const actor = toActor(actorInput);
      const projectAccess = await this.requireProjectAction(tx, actor, projectId, "read");
      const assets = await lockProjectAssets(tx, projectId, [assetId]);
      const asset = assets[0];
      if (!asset) throw new NotFoundError("项目中不存在该资产");
      if (asset.visibility === "personal") throw personalAssetReviewNotApplicable();
      const assignedReviewerUserId = await reviewerForMediaKind(tx, projectId, asset.mediaKind);
      // Checked ahead of the full matrix only to answer with the reason that
      // actually applies; canDecideAsset re-checks it and stays fail-closed
      // for every other caller.
      if (!canChangeAssetReviewState(projectAccess, actor.id, asset)) {
        throw sharedAssetReviewForbidden();
      }
      if (!canDecideAsset(projectAccess, actor.id, assignedReviewerUserId, asset)) {
        throw new ForbiddenError("你没有在该项目中执行审核决定的权限");
      }
      const current = assertReviewStatus(asset.status, assetId);
      const target = input.action;
      if (current === target) {
        return {
          assetId,
          status: current,
          changed: false,
          reason: target === "approved" ? "already_approved" : "already_rejected",
        };
      }
      assertDecisionAllowed(current, target);
      await assertNoSubmittingGenerationReferences(tx, [assetId]);
      const now = new Date();
      // Preserve the old boolean contract while the four-state review domain
      // becomes the canonical lifecycle: true=approved, false=rejected.
      const updated = await tx.update(assetEntities).set({
        status: target,
        approved: target === "approved",
        updatedAt: now,
      })
        .where(and(eq(assetEntities.id, assetId), eq(assetEntities.status, current)))
        .returning({ id: assetEntities.id });
      if (!updated[0]) throw assetReviewStateConflict(assetId, current);
      const action = await insertAction(tx, {
        projectId,
        assetId,
        action: target,
        fromStatus: current,
        toStatus: target,
        reviewerUserId: actor.id,
        assignedReviewerUserId,
        rejectionReason: input.rejectionReason,
        createdAt: now,
      });
      return {
        assetId,
        status: target,
        changed: true,
        reason: "submitted",
        latestAction: action,
      };
    });
  }

  async listActions(actorInput: ReviewActor, projectId: string, assetId: string): Promise<AssetReviewActionRecord[]> {
    await this.requireProjectAction(this.db, actorInput, projectId, "read");
    const referenced = await this.db.select({ id: projectAssetRefs.id }).from(projectAssetRefs).where(and(
      eq(projectAssetRefs.projectId, projectId),
      eq(projectAssetRefs.assetEntityId, assetId),
      isNull(projectAssetRefs.deletedAt),
    )).limit(1);
    if (!referenced[0]) throw new NotFoundError("项目中不存在该资产");
    const rows = await this.db.select({
      action: assetReviewActions,
      reviewerDisplayName: users.displayName,
    }).from(assetReviewActions).leftJoin(users, eq(users.id, assetReviewActions.reviewerUserId))
      .where(and(
        eq(assetReviewActions.projectId, projectId),
        eq(assetReviewActions.assetEntityId, assetId),
      ))
      .orderBy(desc(assetReviewActions.createdAt), desc(assetReviewActions.id));
    return rows.map((row) => toAction(row.action, row.reviewerDisplayName));
  }

  private async requireProjectAction(
    db: Database,
    actorInput: ReviewActor,
    projectId: string,
    action: ProjectAccessAction,
  ): Promise<ProjectAccess> {
    return ProjectAccessService.fromDatabase(new ProjectAccessRepository(db))
      .require(toActor(actorInput), projectId, action);
  }
}

async function lockProjectAssets(db: Database, projectId: string, assetIds: string[]): Promise<ProjectAssetRow[]> {
  if (assetIds.length === 0) return [];
  const rows: ProjectAssetRow[] = [];
  // Acquire the same entity locks as generation in exact ID order. A sorted
  // result alone is insufficient because PostgreSQL may row-lock before sort.
  for (const assetId of [...new Set(assetIds)].sort()) {
    const result = await db.execute(sql`
      SELECT
        e.id,
        e.status,
        e.visibility,
        e.owner_user_id AS "ownerUserId",
        COALESCE((
          SELECT CASE
            WHEN m.media_kind = 'video' THEN 'video'
            WHEN m.media_kind = 'audio' THEN 'audio'
            ELSE 'image'
          END
          FROM ${projectAssetRefs} selected_ref
          LEFT JOIN ${assetMedia} m
            ON m.id = selected_ref.asset_media_id
            AND m.deleted_at IS NULL
          WHERE selected_ref.project_id = ${projectId}
            AND selected_ref.asset_entity_id = e.id
            AND selected_ref.deleted_at IS NULL
          ORDER BY selected_ref.created_at DESC, selected_ref.id DESC
          LIMIT 1
        ), 'image') AS "mediaKind"
      FROM ${assetEntities} e
      INNER JOIN ${projectAssetRefs} r ON r.asset_entity_id = e.id
      WHERE r.project_id = ${projectId}
        AND r.deleted_at IS NULL
        AND e.deleted_at IS NULL
        AND e.id = ${assetId}
      ORDER BY e.id ASC
      LIMIT 1
      FOR UPDATE OF e
    `) as unknown as SqlResult<ProjectAssetRow>;
    if (result.rows[0]) rows.push(result.rows[0]);
  }
  return rows;
}

/**
 * The worker has already performed its final review check when an attempt is
 * running/submitting. Refuse the normal review API write before PostgreSQL's
 * trigger backstop so users receive a stable business conflict immediately.
 */
async function assertNoSubmittingGenerationReferences(db: Database, assetIds: string[]): Promise<void> {
  const uniqueAssetIds = [...new Set(assetIds)].sort();
  if (uniqueAssetIds.length === 0) return;
  const active = await db.select({ assetId: assetEntities.id })
    .from(assetMedia)
    .leftJoin(assetVariants, eq(assetMedia.assetVariantId, assetVariants.id))
    .innerJoin(assetEntities, or(
      eq(assetMedia.assetEntityId, assetEntities.id),
      eq(assetVariants.assetEntityId, assetEntities.id),
    ))
    .innerJoin(
      generationRequests,
      sql`${generationRequests.referenceMediaIds} ? ${assetMedia.id}::text`,
    )
    .innerJoin(generationAttempts, eq(generationAttempts.requestId, generationRequests.id))
    .where(and(
      inArray(assetEntities.id, uniqueAssetIds),
      isNull(assetMedia.deletedAt),
      eq(generationAttempts.status, "running"),
      eq(generationAttempts.phase, "submitting"),
    ))
    .orderBy(asc(assetEntities.id))
    .limit(1);
  const blocked = active[0];
  if (!blocked) return;
  throw new ConflictError(
    "该资产正用于一笔已进入供应商提交中的生成任务，请待提交结果明确后再修改审核状态",
    "asset_review_change_in_progress",
    { assetId: blocked.assetId },
  );
}

async function insertAction(
  db: Database,
  input: {
    projectId: string;
    assetId: string;
    action: "submitted" | "approved" | "rejected";
    fromStatus: AssetReviewStatus;
    toStatus: AssetReviewStatus;
    reviewerUserId: string;
    assignedReviewerUserId: string | null;
    rejectionReason?: string;
    createdAt: Date;
  },
): Promise<AssetReviewActionRecord> {
  const created = await db.insert(assetReviewActions).values({
    id: crypto.randomUUID(),
    projectId: input.projectId,
    assetEntityId: input.assetId,
    action: input.action,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reviewerUserId: input.reviewerUserId,
    assignedReviewerUserId: input.assignedReviewerUserId,
    rejectionReason: input.rejectionReason ?? null,
    createdAt: input.createdAt,
  }).returning();
  const row = created[0];
  if (!row) throw new Error("审核动作未能写入");
  const reviewer = await db.select({ displayName: users.displayName }).from(users)
    .where(eq(users.id, input.reviewerUserId)).limit(1);
  return toAction(row, reviewer[0]?.displayName ?? null);
}

/**
 * The assignment is a snapshot, not a second policy source. Assets imported
 * before media metadata existed retain the legacy image-policy behavior.
 * Exported so the media-product review path resolves the exact same assignee.
 */
export async function reviewerForMediaKind(
  db: Database,
  projectId: string,
  mediaKind: ReviewMediaKind,
  cache?: Map<ReviewMediaKind, string | null>,
): Promise<string | null> {
  const cached = cache?.get(mediaKind);
  if (cached !== undefined) return cached;
  const rows = await db.select({
    reviewerUserId: projectReviewPolicies.reviewerUserId,
    memberUserId: projectMembers.userId,
  }).from(projectReviewPolicies)
    .leftJoin(projectMembers, and(
      eq(projectMembers.projectId, projectReviewPolicies.projectId),
      eq(projectMembers.userId, projectReviewPolicies.reviewerUserId),
    ))
    .where(and(
      eq(projectReviewPolicies.projectId, projectId),
      eq(projectReviewPolicies.mediaKind, mediaKind),
    ))
    .limit(1);
  const reviewerUserId = rows[0]?.reviewerUserId && rows[0]?.memberUserId === rows[0].reviewerUserId
    ? rows[0].reviewerUserId
    : null;
  cache?.set(mediaKind, reviewerUserId);
  return reviewerUserId;
}

async function assertProjectMember(db: Database, projectId: string, userId: string): Promise<void> {
  const rows = await db.select({ userId: projectMembers.userId }).from(projectMembers).where(and(
    eq(projectMembers.projectId, projectId),
    eq(projectMembers.userId, userId),
  )).limit(1);
  if (!rows[0]) throw new BadRequestError("指定审核人必须是当前项目成员");
}

/**
 * Personal assets bypass review entirely. `asset_entities.status` is a single
 * platform-global column, so a review decision on a `common` asset lands in
 * every project at once. A project role cannot carry that weight: anyone can
 * create a project, become its owner and reference any common asset into it,
 * which would let them publish unreviewed platform material platform-wide.
 * Shared assets therefore answer only to platform admins, whatever the
 * project matrix or entity owner says. Asset ownership is not a platform
 * moderation role.
 */
export function canChangeAssetReviewState(
  access: ProjectAccess,
  _actorId: string,
  asset: ReviewTargetAsset,
): boolean {
  return asset.visibility === "common" && access.platformRole === "admin";
}

/**
 * The project-scoped matrix, for review targets that live in exactly one
 * project (media results). A named reviewer is only effective while they
 * remain a project member.
 */
export function canDecideProjectReview(
  access: ProjectAccess,
  actorId: string,
  assignedReviewerUserId: string | null,
): boolean {
  if (access.platformRole === "admin") return true;
  if (access.platformRole === "operator") return false;
  if (access.membershipRole === "owner") return true;
  return access.membershipRole !== null && assignedReviewerUserId === actorId;
}

/** Assets add the platform-scoped guard on top of the project matrix. */
export function canDecideAsset(
  access: ProjectAccess,
  actorId: string,
  assignedReviewerUserId: string | null,
  asset: ReviewTargetAsset,
): boolean {
  if (!canChangeAssetReviewState(access, actorId, asset)) return false;
  return canDecideProjectReview(access, actorId, assignedReviewerUserId);
}

function toActor(input: ReviewActor): ProjectAccessActor {
  if (typeof input === "string") return { id: input, role: "member" };
  return { id: input.id, role: platformRoleOrMember(input.role) };
}

function assertReviewStatus(status: string, _assetId: string): AssetReviewStatus {
  if (status === "automatic_review" || status === "pending_review" || status === "approved" || status === "rejected") {
    return status;
  }
  throw new ConflictError(
    "资产不在可审核状态，不能进行审核操作",
    "asset_review_invalid_state",
  );
}

function sharedAssetReviewForbidden(): ForbiddenError {
  return new ForbiddenError("通用库资产的审核状态全平台生效，只有平台管理员可以变更");
}

function personalAssetReviewNotApplicable(): ConflictError {
  return new ConflictError(
    "个人资产无需审核，不能进入审核流程",
    "personal_asset_review_not_applicable",
  );
}

function policyVersionConflict(_currentVersion: number | null): ConflictError {
  return new ConflictError(
    "审核默认策略已被其他人更新，请刷新后重试",
    "project_review_policy_version_conflict",
  );
}

function assetReviewStateConflict(_assetId: string, _expectedStatus: AssetReviewStatus): ConflictError {
  return new ConflictError(
    "资产审核状态已被其他操作更新，请刷新后重试",
    "asset_review_state_conflict",
  );
}

function toPolicy(row: PolicyRow): ProjectReviewPolicy {
  return {
    id: row.id,
    projectId: row.projectId,
    mediaKind: row.mediaKind as ReviewMediaKind,
    defaultStrategy: row.defaultStrategy as ProjectReviewPolicy["defaultStrategy"],
    reviewerUserId: row.reviewerUserId,
    updatedByUserId: row.updatedByUserId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Pending review is the fail-closed default until a project owner opts in to automation. */
function defaultPolicy(projectId: string, mediaKind: ReviewMediaKind): ProjectReviewPolicy {
  return {
    id: null,
    projectId,
    mediaKind,
    defaultStrategy: "pending_review",
    reviewerUserId: null,
    updatedByUserId: null,
    version: 0,
    createdAt: null,
    updatedAt: null,
  };
}

function toAction(row: ActionRow, reviewerDisplayName: string | null): AssetReviewActionRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    assetId: row.assetEntityId,
    action: row.action as AssetReviewActionRecord["action"],
    fromStatus: row.fromStatus as AssetReviewStatus,
    toStatus: row.toStatus as AssetReviewStatus,
    reviewerUserId: row.reviewerUserId,
    reviewerDisplayName,
    assignedReviewerUserId: row.assignedReviewerUserId,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
  };
}
