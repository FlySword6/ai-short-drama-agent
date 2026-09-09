import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  generationAttempts,
  generationRequests,
  mediaProvenanceParentEdges,
  mediaProvenanceSubjects,
  mediaResults,
  seedanceAssetRegistrationAttempts,
  seedanceAssetRegistrations,
  type SeedanceAssetRegistrationRow,
} from "../../db/schema.js";
import { BadRequestError, NotFoundError } from "../../shared/errors.js";
import { requireManageableAsset, lockAndRequireManageableAsset } from "../assets/manageableAsset.js";
import { platformRoleOrMember } from "../auth/types.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import {
  isVolcAssetGroupFailureCode,
  publicVolcAssetFailureCode,
  publicVolcAssetFailureMessage,
  type PublicVolcAssetFailureCode,
  type VolcAssetRegistryFailureCode,
  type VolcAssetStatus,
  type CreateableVolcAssetType,
} from "../assets/volcAssetRegistry.js";
import type {
  SeedanceAssetRegistrationActor,
  SeedanceAssetRegistrationStatus,
  SeedanceAssetRegistrationView,
} from "./types.js";
import { SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS } from "./policy.js";

export interface SeedanceRegistrationConfiguration {
  assetGroupId: string | null;
  projectName: string;
}

export interface RegistrationSource {
  assetMediaId: string;
  sourceMediaResultId: string | null;
  storageUrl: string;
  assetType: CreateableVolcAssetType;
  name: string;
}

export interface PreparedRegistration {
  registration: SeedanceAssetRegistrationRow;
  source: RegistrationSource;
  created: boolean;
}

export type RegistrationCreateClaim =
  | {
    kind: "create";
    registration: SeedanceAssetRegistrationRow;
    source: RegistrationSource;
  }
  | {
    kind: "refresh";
    registration: SeedanceAssetRegistrationRow;
  }
  | {
    kind: "reuse";
    registration: SeedanceAssetRegistrationRow;
  }
  | {
    kind: "settling";
    registration: SeedanceAssetRegistrationRow;
  };

export interface ProviderFailureAudit {
  errorCode: PublicVolcAssetFailureCode;
  errorMessage: string;
  requestId: string | null;
  httpStatus: number | null;
}

/**
 * PostgreSQL owns the local-to-remote mapping and every visible registration
 * action. The provider adapter only sees a transient public storage URL.
 */
export class SeedanceAssetRegistrationRepository {
  constructor(private readonly db: Database) {}

  async prepareForMediaResult(
    actorInput: SeedanceAssetRegistrationActor,
    mediaResultId: string,
    configuration: SeedanceRegistrationConfiguration,
  ): Promise<PreparedRegistration> {
    const actor = toProjectActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await db.execute(sql`SELECT id FROM ${mediaResults} WHERE id = ${mediaResultId} FOR UPDATE`);
      const result = await requirePersistedMediaResultProjectAction(db, actor, mediaResultId, "create");
      const existing = await findRegistrationBySourceResult(db, mediaResultId);
      if (existing) {
        return {
          registration: existing,
          source: await requireAssetMediaSource(db, existing.assetMediaId, mediaResultId),
          created: false,
        };
      }

      const now = new Date();
      const entityId = randomUUID();
      const assetMediaId = randomUUID();
      await db.insert(assetEntities).values({
        id: entityId,
        sourceProjectId: null,
        sourceProjectName: null,
        ownerUserId: actor.id,
        visibility: "personal",
        assetKind: "reference",
        role: null,
        usageMode: "reference",
        name: promotionName(result.id),
        displayName: null,
        intro: null,
        appearance: null,
        ageValue: null,
        gender: null,
        heightCm: null,
        hairDescription: null,
        outfitDescription: null,
        category: null,
        styleTags: [],
        approved: true,
        reuseScope: "all_projects",
        status: "approved",
        sourceFileUrl: null,
        metadata: { source: "media_result_promotion", source_media_result_id: result.id },
        createdAt: now,
        updatedAt: now,
        useCount: 0,
        deletedAt: null,
        deletedByUserId: null,
      });
      await db.insert(assetMedia).values({
        id: assetMediaId,
        assetEntityId: entityId,
        assetVariantId: null,
        mediaKind: normalizeLocalMediaKind(result.mediaKind),
        viewAngle: null,
        title: promotionName(result.id),
        description: null,
        storageBucket: result.storageBucket,
        storagePath: result.storagePath,
        storageUrl: result.storageUrl,
        widthPx: result.widthPx,
        heightPx: result.heightPx,
        format: formatFromMime(result.mimeType),
        sha256: result.sha256,
        isPrimary: true,
        approved: true,
        sortOrder: 0,
        metadata: { source: "media_result_promotion", source_media_result_id: result.id },
        createdAt: now,
        deletedAt: null,
        deletedByUserId: null,
      });
      await createPromotedAssetProvenance(db, assetMediaId, result.id, now);
      const registration = await insertRegistration(db, {
        assetMediaId,
        sourceMediaResultId: result.id,
        actorId: actor.id,
        configuration,
        now,
      });
      return {
        registration,
        source: toSource({
          assetMediaId,
          sourceMediaResultId: result.id,
          storageUrl: result.storageUrl,
          mediaKind: result.mediaKind,
          title: promotionName(result.id),
        }),
        created: true,
      };
    });
  }

  async prepareForAssetMedia(
    actorInput: SeedanceAssetRegistrationActor,
    assetId: string,
    mediaId: string,
    configuration: SeedanceRegistrationConfiguration,
  ): Promise<PreparedRegistration> {
    const actor = toProjectActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      await db.execute(sql`SELECT id FROM ${assetMedia} WHERE id = ${mediaId} FOR UPDATE`);
      await lockAndRequireManageableAsset(db, actor.id, assetId);
      const source = await requireOwnedAssetMedia(db, assetId, mediaId);
      const existing = await findRegistrationByAssetMedia(db, mediaId);
      if (existing) return { registration: existing, source, created: false };
      const providerLibraryAssetId = await findProviderLibraryAssetId(db, mediaId);
      if (providerLibraryAssetId) {
        const registration = await bindProviderLibraryAsset(db, {
          assetMediaId: mediaId,
          actorId: actor.id,
          configuration,
          remoteAssetId: providerLibraryAssetId,
          now: new Date(),
        });
        return { registration, source, created: true };
      }
      const registration = await insertRegistration(db, {
        assetMediaId: mediaId,
        sourceMediaResultId: null,
        actorId: actor.id,
        configuration,
        now: new Date(),
      });
      return { registration, source, created: true };
    });
  }

  async getForMediaResult(
    actorInput: SeedanceAssetRegistrationActor,
    mediaResultId: string,
  ): Promise<SeedanceAssetRegistrationView> {
    await requirePersistedMediaResultProjectAction(this.db, toProjectActor(actorInput), mediaResultId, "read");
    const registration = await findRegistrationBySourceResult(this.db, mediaResultId);
    if (!registration) throw new NotFoundError("该生成产物尚未登记为火山可信素材");
    return this.toView(registration);
  }

  async getForAssetMedia(
    actorInput: SeedanceAssetRegistrationActor,
    assetId: string,
    mediaId: string,
  ): Promise<SeedanceAssetRegistrationView> {
    await requireManageableAsset(this.db, toProjectActor(actorInput).id, assetId);
    await requireOwnedAssetMedia(this.db, assetId, mediaId);
    const registration = await findRegistrationByAssetMedia(this.db, mediaId);
    if (!registration) throw new NotFoundError("该资产媒体尚未登记为火山可信素材");
    return this.toView(registration);
  }

  async getForRegistration(
    actorInput: SeedanceAssetRegistrationActor,
    registrationId: string,
  ): Promise<SeedanceAssetRegistrationView> {
    const registration = await requireRegistration(this.db, registrationId);
    await requireRegistrationAction(this.db, toProjectActor(actorInput), registration, "read");
    return this.toView(registration);
  }

  async getPreparedSourceForRegistration(
    actorInput: SeedanceAssetRegistrationActor,
    registrationId: string,
  ): Promise<PreparedRegistration> {
    const actor = toProjectActor(actorInput);
    const registration = await requireRegistration(this.db, registrationId);
    await requireRegistrationAction(this.db, actor, registration, "create");
    return {
      registration,
      source: await requireAssetMediaSource(
        this.db,
        registration.assetMediaId,
        registration.sourceMediaResultId,
      ),
      created: false,
    };
  }

  async bindAssetGroup(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
    assetGroupId: string,
    projectName: string,
  ): Promise<PreparedRegistration["registration"]> {
    const actor = toProjectActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const registration = await requireRegistrationForUpdate(db, registrationId);
      await requireRegistrationAction(db, actor, registration, "create");
      if (registration.projectName !== projectName) {
        throw new BadRequestError("素材登记项目与素材组项目不一致");
      }
      if (registration.assetGroupId) {
        if (registration.assetGroupId !== assetGroupId) {
          throw new BadRequestError("素材登记已绑定其他火山素材组，禁止静默改绑");
        }
        return registration;
      }
      const now = new Date();
      const retriesGroupFailure = registration.status === "failed"
        && registration.latestErrorCode !== null
        && isVolcAssetGroupFailureCode(
          publicVolcAssetFailureCode(registration.latestErrorCode),
        );
      const updated = (await db.update(seedanceAssetRegistrations).set({
        assetGroupId,
        status: retriesGroupFailure ? "pending" : registration.status,
        lastActionByUserId: actor.id,
        lastActionAt: now,
        updatedAt: now,
        latestErrorCode: null,
        latestErrorMessage: null,
        retryCount: registration.retryCount + (retriesGroupFailure ? 1 : 0),
        lastRetryAt: retriesGroupFailure ? now : registration.lastRetryAt,
      }).where(eq(seedanceAssetRegistrations.id, registration.id)).returning())[0];
      if (!updated) throw new Error("Failed to bind Volc asset group");
      return updated;
    });
  }

  async recordGroupFailure(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
    failure: ProviderFailureAudit,
    status: "failed" | "unknown",
  ): Promise<SeedanceAssetRegistrationView> {
    return this.recordFailure(registrationId, actorInput, "group", failure, status);
  }

  /**
   * Atomically claims the one allowed CreateAsset call for this local media.
   * The remote request intentionally happens after this transaction commits:
   * a second click sees `submitting`, never a second pending registration.
   */
  async claimCreate(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
  ): Promise<RegistrationCreateClaim> {
    const actor = toProjectActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const registration = await requireRegistrationForUpdate(db, registrationId);
      await requireRegistrationAction(db, actor, registration, "create");
      if (registration.status === "active") {
        const unavailableReason = registrationUnavailableReason(registration, new Date());
        if (!unavailableReason) return { kind: "reuse", registration };
        return {
          kind: "settling",
          registration: await markRegistrationUnavailable(db, registration, actor.id, unavailableReason),
        };
      }
      if (registration.status === "processing" && registration.remoteAssetId) return { kind: "refresh", registration };
      if (registration.status === "unknown" || registration.status === "unavailable") {
        return { kind: "settling", registration };
      }
      if (registration.status === "submitting") {
        if (!isSubmissionStale(registration.lastActionAt)) return { kind: "settling", registration };
        const settled = await markSubmissionUnknown(
          db,
          registration,
          actor.id,
          "ASSET_REGISTRY_SUBMISSION_OUTCOME_UNKNOWN",
        );
        return { kind: "settling", registration: settled };
      }
      if (!registration.assetGroupId) {
        throw new BadRequestError("火山素材组尚未准备完成，未发送素材登记请求");
      }
      const source = await requireAssetMediaSource(
        db,
        registration.assetMediaId,
        registration.sourceMediaResultId,
      );

      // `failed` is an explicit provider result and may be retried only by a
      // new human POST. The previous remote ID is deliberately detached before
      // the next CreateAsset call; its historical value remains in attempts.
      const now = new Date();
      const claimed = (await db.update(seedanceAssetRegistrations).set({
        status: "submitting",
        remoteAssetId: null,
        remoteAssetName: null,
        lastActionByUserId: actor.id,
        lastActionAt: now,
        updatedAt: now,
        activatedAt: null,
        authorizationExpiresAt: null,
        lastVerifiedAt: null,
        latestRequestId: null,
        latestErrorCode: null,
        latestErrorMessage: null,
        retryCount: registration.retryCount + (registration.status === "failed" ? 1 : 0),
        lastRetryAt: registration.status === "failed" ? now : registration.lastRetryAt,
      }).where(eq(seedanceAssetRegistrations.id, registration.id)).returning())[0];
      if (!claimed) throw new Error("Failed to claim Ark asset registration");
      await appendAttempt(db, claimed, {
        actorId: actor.id,
        action: "create",
        outcome: "submitting",
        requestId: null,
        httpStatus: null,
        remoteAssetId: null,
      });
      return { kind: "create", registration: claimed, source };
    });
  }

  async viewForRegistration(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
  ): Promise<SeedanceAssetRegistrationView> {
    const registration = await requireRegistration(this.db, registrationId);
    await requireRegistrationAction(this.db, toProjectActor(actorInput), registration, "read");
    return this.toView(registration);
  }

  async recordCreateSubmitted(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
    result: { assetId: string; assetName: string; requestId: string | null; httpStatus: number },
  ): Promise<SeedanceAssetRegistrationView> {
    const actor = toProjectActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const registration = await requireRegistrationForUpdate(db, registrationId);
      await requireRegistrationAction(db, actor, registration, "create");
      const now = new Date();
      const updated = (await db.update(seedanceAssetRegistrations).set({
        remoteAssetId: result.assetId,
        remoteAssetName: result.assetName,
        status: "processing",
        lastActionByUserId: actor.id,
        lastActionAt: now,
        updatedAt: now,
        activatedAt: null,
        authorizationExpiresAt: null,
        lastVerifiedAt: null,
        latestRequestId: result.requestId,
        latestErrorCode: null,
        latestErrorMessage: null,
      }).where(eq(seedanceAssetRegistrations.id, registration.id)).returning())[0];
      if (!updated) throw new Error("Failed to save Ark asset registration");
      await syncRemoteAssetProjection(db, updated.assetMediaId, updated.remoteAssetId);
      await appendAttempt(db, updated, {
        actorId: actor.id,
        action: "create",
        outcome: "submitted",
        requestId: result.requestId,
        httpStatus: result.httpStatus,
        remoteAssetId: result.assetId,
      });
      return toView(updated);
    });
  }

  async recordAssetStatus(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
    result: {
      status: VolcAssetStatus;
      requestId: string | null;
      httpStatus: number;
      errorCode: VolcAssetRegistryFailureCode | null;
      errorMessage: string | null;
    },
  ): Promise<SeedanceAssetRegistrationView> {
    const actor = toProjectActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const registration = await requireRegistrationForUpdate(db, registrationId);
      await requireRegistrationAction(db, actor, registration, "create");
      if (!registration.remoteAssetId) throw new BadRequestError("素材登记尚未取得远端素材 ID");
      const now = new Date();
      const providerStatus = fromVolcStatus(result.status);
      const status = providerStatus === "active" && !authorizationNotExpired(registration, now)
        ? "unavailable"
        : providerStatus;
      const latestError = status === "failed" || status === "unknown" || status === "unavailable"
        ? sanitizeAuditFailure(
          result.errorCode ?? (status === "unavailable" ? "ASSET_REGISTRY_UNAVAILABLE" : null),
          result.errorMessage,
        )
        : null;
      const updated = (await db.update(seedanceAssetRegistrations).set({
        status,
        lastActionByUserId: actor.id,
        lastActionAt: now,
        updatedAt: now,
        activatedAt: status === "active" ? now : null,
        lastVerifiedAt: now,
        latestRequestId: result.requestId,
        latestErrorCode: latestError?.errorCode ?? null,
        latestErrorMessage: latestError?.errorMessage ?? null,
      }).where(eq(seedanceAssetRegistrations.id, registration.id)).returning())[0];
      if (!updated) throw new Error("Failed to update Ark asset status");
      // The registration row is the formal mapping. Refresh doubles as an
      // idempotent repair point for the legacy metadata projection.
      await syncRemoteAssetProjection(db, updated.assetMediaId, updated.remoteAssetId);
      await appendAttempt(db, updated, {
        actorId: actor.id,
        action: "list",
        outcome: status,
        requestId: result.requestId,
        httpStatus: result.httpStatus,
        remoteAssetId: registration.remoteAssetId,
        ...latestError,
      });
      return toView(updated);
    });
  }

  async recordCreateFailure(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
    failure: ProviderFailureAudit,
  ): Promise<SeedanceAssetRegistrationView> {
    return this.recordFailure(registrationId, actorInput, "create", failure, "failed");
  }

  async recordCreateUnknown(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
    failure: ProviderFailureAudit,
  ): Promise<SeedanceAssetRegistrationView> {
    return this.recordFailure(registrationId, actorInput, "create", failure, "unknown");
  }

  async recordRefreshFailure(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
    failure: ProviderFailureAudit,
  ): Promise<SeedanceAssetRegistrationView> {
    // A ListAssets transport/protocol failure cannot prove an already-active
    // remote asset remains usable. Preserve its ID for manual reconciliation,
    // but fail closed so it cannot be emitted as asset://.
    return this.recordFailure(registrationId, actorInput, "list", failure, "unknown");
  }

  async recordReuseActive(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
  ): Promise<SeedanceAssetRegistrationView> {
    const actor = toProjectActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const registration = await requireRegistrationForUpdate(db, registrationId);
      await requireRegistrationAction(db, actor, registration, "create");
      if (registration.status !== "active" || !registration.remoteAssetId) return this.toView(registration, db);
      const unavailableReason = registrationUnavailableReason(registration, new Date());
      if (unavailableReason) {
        const unavailable = await markRegistrationUnavailable(db, registration, actor.id, unavailableReason);
        return toView(unavailable);
      }
      const now = new Date();
      const updated = (await db.update(seedanceAssetRegistrations).set({
        lastActionByUserId: actor.id,
        lastActionAt: now,
        updatedAt: now,
        latestErrorCode: null,
        latestErrorMessage: null,
      }).where(eq(seedanceAssetRegistrations.id, registration.id)).returning())[0];
      if (!updated) throw new Error("Failed to save Ark asset reuse audit");
      await appendAttempt(db, updated, {
        actorId: actor.id,
        action: "reuse",
        outcome: "already_active",
        requestId: null,
        httpStatus: null,
        remoteAssetId: updated.remoteAssetId,
      });
      return toView(updated);
    });
  }

  async getPreparedSourceForMediaResult(
    actorInput: SeedanceAssetRegistrationActor,
    mediaResultId: string,
  ): Promise<PreparedRegistration> {
    const actor = toProjectActor(actorInput);
    await requirePersistedMediaResultProjectAction(this.db, actor, mediaResultId, "create");
    const row = await findRegistrationBySourceResult(this.db, mediaResultId);
    if (!row) throw new NotFoundError("该生成产物尚未登记为火山可信素材");
    return {
      registration: row,
      source: await requireAssetMediaSource(this.db, row.assetMediaId, row.sourceMediaResultId),
      created: false,
    };
  }

  async getPreparedSourceForAssetMedia(
    actorInput: SeedanceAssetRegistrationActor,
    assetId: string,
    mediaId: string,
  ): Promise<PreparedRegistration> {
    const actor = toProjectActor(actorInput);
    await lockAndRequireManageableAsset(this.db, actor.id, assetId);
    await requireOwnedAssetMedia(this.db, assetId, mediaId);
    const row = await findRegistrationByAssetMedia(this.db, mediaId);
    if (!row) throw new NotFoundError("该资产媒体尚未登记为火山可信素材");
    return {
      registration: row,
      source: await requireOwnedAssetMedia(this.db, assetId, mediaId),
      created: false,
    };
  }

  private async recordFailure(
    registrationId: string,
    actorInput: SeedanceAssetRegistrationActor,
    action: "group" | "create" | "list" | "refresh",
    failure: ProviderFailureAudit,
    nextStatus: "failed" | "unknown" | null,
  ): Promise<SeedanceAssetRegistrationView> {
    const actor = toProjectActor(actorInput);
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const registration = await requireRegistrationForUpdate(db, registrationId);
      await requireRegistrationAction(db, actor, registration, "create");
      const now = new Date();
      const latestError = sanitizeAuditFailure(failure.errorCode, failure.errorMessage);
      const retryingGroupFailure = action === "group"
        && registration.status === "failed"
        && registration.latestErrorCode !== null
        && isVolcAssetGroupFailureCode(
          publicVolcAssetFailureCode(registration.latestErrorCode),
        );
      const updated = (await db.update(seedanceAssetRegistrations).set({
        ...(nextStatus ? { status: nextStatus, activatedAt: null } : {}),
        lastActionByUserId: actor.id,
        lastActionAt: now,
        updatedAt: now,
        latestRequestId: failure.requestId,
        latestErrorCode: latestError.errorCode,
        latestErrorMessage: latestError.errorMessage,
        retryCount: registration.retryCount + (retryingGroupFailure ? 1 : 0),
        lastRetryAt: retryingGroupFailure ? now : registration.lastRetryAt,
      }).where(eq(seedanceAssetRegistrations.id, registration.id)).returning())[0];
      if (!updated) throw new Error("Failed to save Ark asset failure audit");
      await appendAttempt(db, updated, {
        actorId: actor.id,
        action,
        outcome: nextStatus === "unknown" ? "unknown" : "failed",
        requestId: failure.requestId,
        httpStatus: failure.httpStatus,
        remoteAssetId: updated.remoteAssetId,
        ...latestError,
      });
      return toView(updated);
    });
  }

  private async toView(registration: SeedanceAssetRegistrationRow, db: Database = this.db): Promise<SeedanceAssetRegistrationView> {
    void db;
    return toView(registration);
  }
}

/**
 * A generated result belongs to the project of its generation request, not to
 * whichever user happened to create, persist, or previously register it.
 * Keeping this lookup at the repository boundary makes GET and all writing
 * paths use the same project-member matrix.
 */
async function requirePersistedMediaResultProjectAction(
  db: Database,
  actor: ProjectAccessActor,
  mediaResultId: string,
  action: "read" | "create",
) {
  const row = (await db.select({
    result: mediaResults,
    projectId: generationRequests.projectId,
    attemptStatus: generationAttempts.status,
  }).from(mediaResults)
    .leftJoin(generationRequests, eq(mediaResults.requestId, generationRequests.id))
    .leftJoin(generationAttempts, eq(mediaResults.attemptId, generationAttempts.id))
    .where(and(eq(mediaResults.id, mediaResultId), isNull(mediaResults.deletedAt)))
    .limit(1))[0];
  if (!row?.projectId) throw new NotFoundError("生成产物不存在或你没有访问权限");
  await ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)).require(actor, row.projectId, action);
  if (
    row.result.persistenceStatus !== "persisted"
    || !row.result.storageUrl
    || row.attemptStatus !== "succeeded"
  ) {
    throw new BadRequestError("只有已落 TOS 的生成产物可以登记为火山可信素材");
  }
  return row.result;
}

/**
 * Asset-media routes have no project parameter, so they retain the asset
 * object boundary. Registration rows created from a media result, however,
 * always re-enter the project member matrix above. This closes the gap where
 * a successful initial check could otherwise be followed by a stale write.
 */
async function requireRegistrationAction(
  db: Database,
  actor: ProjectAccessActor,
  registration: SeedanceAssetRegistrationRow,
  action: "read" | "create",
): Promise<void> {
  if (registration.sourceMediaResultId) {
    await requirePersistedMediaResultProjectAction(db, actor, registration.sourceMediaResultId, action);
    return;
  }
  await requireAssetMediaAction(db, actor, registration.assetMediaId, action);
}

async function requireAssetMediaAction(
  db: Database,
  actor: ProjectAccessActor,
  mediaId: string,
  action: "read" | "create",
): Promise<void> {
  const row = (await db.select({
    assetEntityId: assetMedia.assetEntityId,
    variantEntityId: assetVariants.assetEntityId,
  }).from(assetMedia)
    .leftJoin(assetVariants, eq(assetMedia.assetVariantId, assetVariants.id))
    .where(and(eq(assetMedia.id, mediaId), isNull(assetMedia.deletedAt)))
    .limit(1))[0];
  const assetId = row?.assetEntityId ?? row?.variantEntityId;
  if (!assetId) throw new NotFoundError("资产媒体不存在");
  if (action === "create") {
    await lockAndRequireManageableAsset(db, actor.id, assetId);
    return;
  }
  await requireManageableAsset(db, actor.id, assetId);
}

function toProjectActor(input: SeedanceAssetRegistrationActor): ProjectAccessActor {
  if (typeof input === "string") return { id: input, role: "member" };
  return { id: input.id, role: platformRoleOrMember(input.role) };
}

async function requireOwnedAssetMedia(db: Database, assetId: string, mediaId: string): Promise<RegistrationSource> {
  const row = (await db.select({
    media: assetMedia,
    variantEntityId: assetVariants.assetEntityId,
  }).from(assetMedia)
    .leftJoin(assetVariants, eq(assetMedia.assetVariantId, assetVariants.id))
    .where(and(eq(assetMedia.id, mediaId), isNull(assetMedia.deletedAt)))
    .limit(1))[0];
  const entityId = row?.media.assetEntityId ?? row?.variantEntityId;
  if (!row || entityId !== assetId) throw new NotFoundError("资产媒体不存在");
  if (!row.media.storageBucket || !row.media.storagePath || !row.media.storageUrl) {
    throw new BadRequestError("只有已入库到 TOS 的资产媒体可以登记为火山可信素材");
  }
  return toSource({
    assetMediaId: row.media.id,
    sourceMediaResultId: null,
    storageUrl: row.media.storageUrl,
    mediaKind: row.media.mediaKind,
    title: row.media.title,
  });
}

/**
 * Promotion is an asset-library projection of a generated result, not a new
 * provenance claim.  Copy the already server-owned channel/attempt and record
 * an immutable direct asset -> result edge in the same transaction.
 */
async function createPromotedAssetProvenance(
  db: Database,
  assetMediaId: string,
  mediaResultId: string,
  observedAt: Date,
): Promise<void> {
  let resultSubject = (await db.select({
    id: mediaProvenanceSubjects.id,
    sourceChannel: mediaProvenanceSubjects.sourceChannel,
    sourceGenerationAttemptId: mediaProvenanceSubjects.sourceGenerationAttemptId,
  }).from(mediaProvenanceSubjects)
    .where(eq(mediaProvenanceSubjects.mediaResultId, mediaResultId))
    .limit(1))[0] ?? null;
  if (!resultSubject) {
    await db.insert(mediaProvenanceSubjects).values({
      assetMediaId: null,
      mediaResultId,
      sourceChannel: "unknown",
      sourceGenerationAttemptId: null,
      providerAssetId: null,
      observedAt,
    }).onConflictDoNothing();
    resultSubject = (await db.select({
      id: mediaProvenanceSubjects.id,
      sourceChannel: mediaProvenanceSubjects.sourceChannel,
      sourceGenerationAttemptId: mediaProvenanceSubjects.sourceGenerationAttemptId,
    }).from(mediaProvenanceSubjects)
      .where(eq(mediaProvenanceSubjects.mediaResultId, mediaResultId))
      .limit(1))[0] ?? null;
  }
  if (!resultSubject) throw new Error("Promoted result provenance subject is missing");
  const assetSubject = (await db.insert(mediaProvenanceSubjects).values({
    assetMediaId,
    mediaResultId: null,
    sourceChannel: resultSubject.sourceChannel,
    sourceGenerationAttemptId: resultSubject.sourceGenerationAttemptId,
    providerAssetId: null,
    observedAt,
  }).returning({ id: mediaProvenanceSubjects.id }))[0];
  if (!assetSubject) throw new Error("Promoted asset provenance subject is missing");
  await db.insert(mediaProvenanceParentEdges).values({
    childSubjectId: assetSubject.id,
    parentSubjectId: resultSubject.id,
    createdAt: observedAt,
  });
}

async function requireAssetMediaSource(
  db: Database,
  assetMediaId: string,
  sourceMediaResultId: string | null,
): Promise<RegistrationSource> {
  const media = (await db.select().from(assetMedia).where(and(
    eq(assetMedia.id, assetMediaId),
    isNull(assetMedia.deletedAt),
  )).limit(1))[0];
  if (!media) throw new NotFoundError("已登记的本地资产媒体不存在");
  if (!media.storageBucket || !media.storagePath || !media.storageUrl) {
    throw new BadRequestError("已登记资产缺少可验证的 TOS 对象，不能刷新火山状态");
  }
  return toSource({
    assetMediaId: media.id,
    sourceMediaResultId,
    storageUrl: media.storageUrl,
    mediaKind: media.mediaKind,
    title: media.title,
  });
}

async function findRegistrationBySourceResult(db: Database, mediaResultId: string) {
  return (await db.select().from(seedanceAssetRegistrations).where(
    eq(seedanceAssetRegistrations.sourceMediaResultId, mediaResultId),
  ).limit(1))[0] ?? null;
}

async function findRegistrationByAssetMedia(db: Database, assetMediaId: string) {
  return (await db.select().from(seedanceAssetRegistrations).where(
    eq(seedanceAssetRegistrations.assetMediaId, assetMediaId),
  ).limit(1))[0] ?? null;
}

async function requireRegistration(db: Database, registrationId: string): Promise<SeedanceAssetRegistrationRow> {
  const registration = (await db.select().from(seedanceAssetRegistrations)
    .where(eq(seedanceAssetRegistrations.id, registrationId)).limit(1))[0];
  if (!registration) throw new NotFoundError("素材登记记录不存在");
  return registration;
}

async function requireRegistrationForUpdate(db: Database, registrationId: string): Promise<SeedanceAssetRegistrationRow> {
  // Keep the typed Drizzle row mapping here. A raw `SELECT *` returns
  // snake_case keys from PostgreSQL, which silently breaks state decisions
  // such as `lastActionAt` under a real database connection.
  const registration = (await db.select()
    .from(seedanceAssetRegistrations)
    .where(eq(seedanceAssetRegistrations.id, registrationId))
    .limit(1)
    .for("update"))[0];
  if (!registration) throw new NotFoundError("素材登记记录不存在");
  return registration;
}

async function markSubmissionUnknown(
  db: Database,
  registration: SeedanceAssetRegistrationRow,
  actorId: string,
  errorCode: VolcAssetRegistryFailureCode,
): Promise<SeedanceAssetRegistrationRow> {
  const now = new Date();
  const updated = (await db.update(seedanceAssetRegistrations).set({
    status: "unknown",
    lastActionByUserId: actorId,
    lastActionAt: now,
    updatedAt: now,
    activatedAt: null,
    latestRequestId: null,
    latestErrorCode: errorCode,
    latestErrorMessage: "火山素材登记结果不明确，系统不会自动重复登记",
  }).where(eq(seedanceAssetRegistrations.id, registration.id)).returning())[0];
  if (!updated) throw new Error("Failed to settle unknown Ark asset submission");
  await appendAttempt(db, updated, {
    actorId,
    action: "create",
    outcome: "unknown",
    requestId: null,
    httpStatus: null,
    remoteAssetId: null,
    errorCode,
    errorMessage: "火山素材登记结果不明确，系统不会自动重复登记",
  });
  return updated;
}

async function insertRegistration(
  db: Database,
  input: {
    assetMediaId: string;
    sourceMediaResultId: string | null;
    actorId: string;
    configuration: SeedanceRegistrationConfiguration;
    now: Date;
  },
): Promise<SeedanceAssetRegistrationRow> {
  const row = (await db.insert(seedanceAssetRegistrations).values({
    id: randomUUID(),
    assetMediaId: input.assetMediaId,
    sourceMediaResultId: input.sourceMediaResultId,
    assetGroupId: input.configuration.assetGroupId,
    projectName: input.configuration.projectName,
    remoteAssetId: null,
    remoteAssetName: null,
    status: "pending",
    createdByUserId: input.actorId,
    lastActionByUserId: input.actorId,
    createdAt: input.now,
    updatedAt: input.now,
    lastActionAt: input.now,
    activatedAt: null,
    authorizationExpiresAt: null,
    lastVerifiedAt: null,
    latestRequestId: null,
    latestErrorCode: null,
    latestErrorMessage: null,
    retryCount: 0,
    lastRetryAt: null,
  }).returning())[0];
  if (!row) throw new Error("Failed to create Ark asset registration");
  return row;
}

/**
 * A provider-library subject has a server-owned Ark ID. It enters the local
 * formal mapping as an auditable binding, never through CreateAsset, but the
 * ID alone is not evidence that Ark currently accepts it. A later GetAsset
 * observation is required before this mapping can become active.
 * provider_asset_id is server-owned and immutable, so this does not accept a
 * browser-provided Asset ID or overwrite a prior mapping.
 */
async function bindProviderLibraryAsset(
  db: Database,
  input: {
    assetMediaId: string;
    actorId: string;
    configuration: SeedanceRegistrationConfiguration;
    remoteAssetId: string;
    now: Date;
  },
): Promise<SeedanceAssetRegistrationRow> {
  const registration = (await db.insert(seedanceAssetRegistrations).values({
    id: randomUUID(),
    assetMediaId: input.assetMediaId,
    sourceMediaResultId: null,
    assetGroupId: input.configuration.assetGroupId,
    projectName: input.configuration.projectName,
    remoteAssetId: input.remoteAssetId,
    remoteAssetName: null,
    status: "unknown",
    createdByUserId: input.actorId,
    lastActionByUserId: input.actorId,
    createdAt: input.now,
    updatedAt: input.now,
    lastActionAt: input.now,
    activatedAt: null,
    authorizationExpiresAt: null,
    lastVerifiedAt: null,
    latestRequestId: null,
    latestErrorCode: "ASSET_REGISTRY_BINDING_UNVERIFIED",
    latestErrorMessage: "方舟既有素材绑定尚未完成远端核验",
    retryCount: 0,
    lastRetryAt: null,
  }).returning())[0];
  if (!registration) throw new Error("Failed to bind existing Ark provider asset");
  await syncRemoteAssetProjection(db, registration.assetMediaId, registration.remoteAssetId);
  await appendAttempt(db, registration, {
    actorId: input.actorId,
    action: "bind",
    outcome: "unknown",
    requestId: null,
    httpStatus: null,
    remoteAssetId: input.remoteAssetId,
    errorCode: "ASSET_REGISTRY_BINDING_UNVERIFIED",
    errorMessage: "方舟既有素材绑定尚未完成远端核验",
  });
  return registration;
}

async function findProviderLibraryAssetId(db: Database, assetMediaId: string): Promise<string | null> {
  const subject = (await db.select({
    sourceChannel: mediaProvenanceSubjects.sourceChannel,
    providerAssetId: mediaProvenanceSubjects.providerAssetId,
  }).from(mediaProvenanceSubjects)
    .where(eq(mediaProvenanceSubjects.assetMediaId, assetMediaId))
    .limit(1))[0] ?? null;
  if (!subject || subject.sourceChannel !== "provider_library") return null;
  if (!subject.providerAssetId) {
    throw new BadRequestError("方舟预置素材缺少可复核的既有 Asset ID，禁止重复 CreateAsset");
  }
  return subject.providerAssetId;
}

async function appendAttempt(
  db: Database,
  registration: SeedanceAssetRegistrationRow,
  input: {
    actorId: string;
    action: "group" | "create" | "list" | "refresh" | "reuse" | "bind";
    outcome: "submitting" | "submitted" | "processing" | "active" | "failed" | "unknown" | "unavailable" | "already_active";
    requestId: string | null;
    httpStatus: number | null;
    remoteAssetId: string | null;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<void> {
  // Every state writer locks this registration row before calling us, which
  // serializes MAX()+1 inside one registration without a global sequence.
  const result = await db.select({ next: sql<number>`coalesce(max(${seedanceAssetRegistrationAttempts.attemptNo}), 0) + 1` })
    .from(seedanceAssetRegistrationAttempts)
    .where(eq(seedanceAssetRegistrationAttempts.registrationId, registration.id));
  const attemptNo = Number(result[0]?.next ?? 1);
  await db.insert(seedanceAssetRegistrationAttempts).values({
    id: randomUUID(),
    registrationId: registration.id,
    attemptNo,
    actorUserId: input.actorId,
    action: input.action,
    outcome: input.outcome,
    providerRequestId: input.requestId,
    providerHttpStatus: input.httpStatus,
    remoteAssetId: input.remoteAssetId,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    createdAt: new Date(),
  });
}

function toSource(input: {
  assetMediaId: string;
  sourceMediaResultId: string | null;
  storageUrl: string | null;
  mediaKind: string;
  title: string | null;
}): RegistrationSource {
  if (!input.storageUrl) throw new BadRequestError("资产没有可供火山读取的公开地址");
  return {
    assetMediaId: input.assetMediaId,
    sourceMediaResultId: input.sourceMediaResultId,
    storageUrl: input.storageUrl,
    assetType: volcAssetType(input.mediaKind),
    name: truncateName(input.title ?? `素材-${input.assetMediaId.slice(0, 8)}`),
  };
}

function volcAssetType(mediaKind: string): CreateableVolcAssetType {
  if (mediaKind === "image") return "Image";
  if (mediaKind === "audio") return "Audio";
  throw new BadRequestError("当前 CreateAsset 仓库合同只支持图片与音频素材");
}

function normalizeLocalMediaKind(mediaKind: string): "image" | "video" | "audio" {
  if (mediaKind === "image" || mediaKind === "video" || mediaKind === "audio") return mediaKind;
  throw new BadRequestError("该生成产物类型暂不支持登记到火山素材库");
}

function formatFromMime(mimeType: string | null): string | null {
  if (!mimeType) return null;
  const subtype = mimeType.split("/")[1]?.toLowerCase();
  return subtype && subtype.length <= 32 ? subtype : null;
}

function promotionName(mediaResultId: string): string {
  return `生成参考-${mediaResultId.slice(0, 8)}`;
}

function truncateName(value: string): string {
  return [...value.trim()].slice(0, 64).join("") || "短剧参考素材";
}

function fromVolcStatus(value: VolcAssetStatus): "processing" | "active" | "failed" | "unknown" | "unavailable" {
  if (value === "Active") return "active";
  if (value === "Processing") return "processing";
  if (value === "Unavailable" || value === "Removed" || value === "Revoked") return "unavailable";
  return "failed";
}

function registrationUnavailableReason(
  registration: Pick<SeedanceAssetRegistrationRow, "authorizationExpiresAt" | "lastVerifiedAt">,
  now: Date,
): { errorCode: string; errorMessage: string } | null {
  if (!authorizationNotExpired(registration, now)) {
    return {
      errorCode: "ASSET_REGISTRY_AUTHORIZATION_EXPIRED",
      errorMessage: "火山素材授权已到期，必须人工刷新核验",
    };
  }
  if (
    registration.lastVerifiedAt === null
    || now.getTime() - registration.lastVerifiedAt.getTime() >= SEEDANCE_ASSET_VERIFICATION_MAX_AGE_MS
  ) {
    return {
      errorCode: "ASSET_REGISTRY_VERIFICATION_STALE",
      errorMessage: "火山素材远端核验已过期，必须人工刷新核验",
    };
  }
  return null;
}

function authorizationNotExpired(
  registration: Pick<SeedanceAssetRegistrationRow, "authorizationExpiresAt">,
  now: Date,
): boolean {
  return registration.authorizationExpiresAt === null
    || registration.authorizationExpiresAt.getTime() > now.getTime();
}

async function markRegistrationUnavailable(
  db: Database,
  registration: SeedanceAssetRegistrationRow,
  actorId: string,
  reason: { errorCode: string; errorMessage: string },
): Promise<SeedanceAssetRegistrationRow> {
  const now = new Date();
  const updated = (await db.update(seedanceAssetRegistrations).set({
    status: "unavailable",
    lastActionByUserId: actorId,
    lastActionAt: now,
    updatedAt: now,
    activatedAt: null,
    latestErrorCode: reason.errorCode,
    latestErrorMessage: reason.errorMessage,
  }).where(eq(seedanceAssetRegistrations.id, registration.id)).returning())[0];
  if (!updated) throw new Error("Failed to mark stale Ark registration unavailable");
  await appendAttempt(db, updated, {
    actorId,
    action: "reuse",
    outcome: "unavailable",
    requestId: null,
    httpStatus: null,
    remoteAssetId: updated.remoteAssetId,
    errorCode: reason.errorCode,
    errorMessage: reason.errorMessage,
  });
  return updated;
}

function isSubmissionStale(lastActionAt: Date): boolean {
  return Date.now() - lastActionAt.getTime() >= 10 * 60 * 1000;
}

function sanitizeAuditFailure(
  errorCode: PublicVolcAssetFailureCode | null,
  _errorMessage: string | null,
): { errorCode: PublicVolcAssetFailureCode; errorMessage: string } {
  const safeCode = errorCode
    ? publicVolcAssetFailureCode(errorCode)
    : "ASSET_REGISTRY_FAILED";
  // Provider messages are intentionally not persisted: they may include an
  // expiring source URL or credentials despite an upstream contract. The
  // stable provider code + request ID + HTTP status are sufficient evidence.
  return { errorCode: safeCode, errorMessage: "火山素材登记未完成，请查看受控服务日志" };
}

/**
 * `remote_asset_id` is formal truth; this JSON field is an old consumer
 * projection. Keep it in the same transaction as every persisted/observed
 * remote ID, making retries deterministic and safe to replay.
 */
async function syncRemoteAssetProjection(db: Database, assetMediaId: string, remoteAssetId: string | null): Promise<void> {
  if (!remoteAssetId) return;
  await db.update(assetMedia).set({
    metadata: sql<Record<string, unknown>>`jsonb_set(
      coalesce(${assetMedia.metadata}, '{}'::jsonb),
      '{seedance_asset_id}',
      to_jsonb(${remoteAssetId}::text),
      true
    )`,
  }).where(eq(assetMedia.id, assetMediaId));
}

function toView(
  registration: SeedanceAssetRegistrationRow,
): SeedanceAssetRegistrationView {
  const latestErrorCode = registration.latestErrorCode
    ? publicVolcAssetFailureCode(registration.latestErrorCode)
    : null;
  return {
    id: registration.id,
    assetMediaId: registration.assetMediaId,
    sourceMediaResultId: registration.sourceMediaResultId,
    assetGroupId: registration.assetGroupId,
    remoteAssetId: registration.remoteAssetId,
    status: registration.status as SeedanceAssetRegistrationStatus,
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
    activatedAt: registration.activatedAt,
    authorizationExpiresAt: registration.authorizationExpiresAt,
    lastVerifiedAt: registration.lastVerifiedAt,
    latestRequestId: registration.latestRequestId,
    latestErrorCode,
    latestErrorMessage: latestErrorCode
      ? publicVolcAssetFailureMessage(latestErrorCode)
      : null,
    retryCount: registration.retryCount,
    lastRetryAt: registration.lastRetryAt,
  };
}
