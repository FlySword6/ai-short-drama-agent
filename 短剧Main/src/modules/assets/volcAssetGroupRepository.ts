import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { volcAssetGroups, type VolcAssetGroupRow } from "../../db/schema.js";
import { AppError } from "../../shared/errors.js";
import {
  isVolcAssetGroupFailureCode,
  publicVolcAssetFailureCode,
  type CreateVolcAssetGroupResult,
  type VolcAssetGroupFailureCode,
} from "./volcAssetRegistry.js";

const GROUP_CREATE_STALE_MS = 10 * 60 * 1000;

export interface VolcAssetGroupConfiguration {
  configuredGroupId?: string;
  name: string;
  description: string;
  projectName: string;
}

export interface VolcAssetGroupFailure {
  errorCode: VolcAssetGroupFailureCode;
  errorMessage: string;
  requestId: string | null;
  httpStatus: number | null;
}

export type VolcAssetGroupResolution =
  | { kind: "resolved"; groupId: string; requestId: string | null }
  | { kind: "settling" }
  | { kind: "failure"; status: "failed" | "unknown"; failure: VolcAssetGroupFailure };

export type VolcAssetGroupCreateClaim =
  | { kind: "create"; row: VolcAssetGroupRow }
  | { kind: "result"; result: VolcAssetGroupResolution };

export interface VolcAssetGroupRepositoryPort {
  importConfigured(
    actorUserId: string,
    configuration: VolcAssetGroupConfiguration,
    configuredGroupId: string,
  ): Promise<VolcAssetGroupResolution>;
  claimCreate(
    actorUserId: string,
    configuration: VolcAssetGroupConfiguration,
  ): Promise<VolcAssetGroupCreateClaim>;
  recordCreated(
    groupRowId: string,
    actorUserId: string,
    result: CreateVolcAssetGroupResult,
  ): Promise<VolcAssetGroupResolution>;
  recordFailure(
    groupRowId: string,
    actorUserId: string,
    status: "failed" | "unknown",
    failure: VolcAssetGroupFailure,
  ): Promise<void>;
}

/**
 * PostgreSQL owns CreateAssetGroup idempotency and the local-to-remote group
 * mapping. This repository never calls the provider.
 */
export class VolcAssetGroupRepository implements VolcAssetGroupRepositoryPort {
  constructor(private readonly db: Database) {}

  async importConfigured(
    actorUserId: string,
    configuration: VolcAssetGroupConfiguration,
    configuredGroupId: string,
  ): Promise<VolcAssetGroupResolution> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const now = new Date();
      await db.insert(volcAssetGroups).values({
        id: randomUUID(),
        name: configuration.name,
        description: configuration.description,
        groupType: "AIGC",
        projectName: configuration.projectName,
        volcAssetGroupId: configuredGroupId,
        status: "active",
        source: "configured",
        createdByUserId: actorUserId,
        lastActionByUserId: actorUserId,
        latestRequestId: null,
        latestErrorCode: null,
        latestErrorMessage: null,
        retryCount: 0,
        lastAttemptAt: now,
        lastRetryAt: null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();

      const row = await findGroupForUpdate(db, configuration);
      if (!row) {
        const remoteRow = await findGroupByRemoteIdForUpdate(db, configuredGroupId);
        if (remoteRow) throwConfiguredGroupConflict();
        throw new Error("Volc asset group mapping disappeared");
      }
      const remoteRow = await findGroupByRemoteIdForUpdate(db, configuredGroupId);
      if (remoteRow && remoteRow.id !== row.id) throwConfiguredGroupConflict();

      if (row.status === "creating") return { kind: "settling" };
      if (row.status === "unknown") return failureResolution(row);
      if (row.status === "active") {
        if (row.volcAssetGroupId !== configuredGroupId) throwConfiguredGroupConflict();
        return { kind: "resolved", groupId: configuredGroupId, requestId: row.latestRequestId };
      }

      const isRetry = row.status === "failed";
      const updated = (await db.update(volcAssetGroups).set({
        volcAssetGroupId: configuredGroupId,
        status: "active",
        source: "configured",
        lastActionByUserId: actorUserId,
        latestRequestId: null,
        latestErrorCode: null,
        latestErrorMessage: null,
        retryCount: row.retryCount + (isRetry ? 1 : 0),
        lastAttemptAt: now,
        lastRetryAt: isRetry ? now : row.lastRetryAt,
        updatedAt: now,
      }).where(eq(volcAssetGroups.id, row.id)).returning())[0];
      if (!updated?.volcAssetGroupId) throw new Error("Failed to import configured Volc asset group");
      return { kind: "resolved", groupId: updated.volcAssetGroupId, requestId: null };
    });
  }

  async claimCreate(
    actorUserId: string,
    configuration: VolcAssetGroupConfiguration,
  ): Promise<VolcAssetGroupCreateClaim> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const now = new Date();
      await db.insert(volcAssetGroups).values({
        id: randomUUID(),
        name: configuration.name,
        description: configuration.description,
        groupType: "AIGC",
        projectName: configuration.projectName,
        volcAssetGroupId: null,
        status: "pending",
        source: "created",
        createdByUserId: actorUserId,
        lastActionByUserId: actorUserId,
        latestRequestId: null,
        latestErrorCode: null,
        latestErrorMessage: null,
        retryCount: 0,
        lastAttemptAt: null,
        lastRetryAt: null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing();

      const row = await requireGroupForUpdate(db, configuration);
      if (row.status === "active" && row.volcAssetGroupId) {
        return {
          kind: "result",
          result: { kind: "resolved", groupId: row.volcAssetGroupId, requestId: row.latestRequestId },
        };
      }
      if (row.status === "unknown") {
        return { kind: "result", result: failureResolution(row) };
      }
      if (row.status === "creating") {
        if (row.lastAttemptAt && Date.now() - row.lastAttemptAt.getTime() < GROUP_CREATE_STALE_MS) {
          return { kind: "result", result: { kind: "settling" } };
        }
        const failure: VolcAssetGroupFailure = {
          errorCode: "ASSET_GROUP_OUTCOME_UNKNOWN",
          errorMessage: "火山素材组创建结果不明确，系统不会自动重复创建，请先人工复核",
          requestId: row.latestRequestId,
          httpStatus: null,
        };
        await db.update(volcAssetGroups).set({
          status: "unknown",
          latestErrorCode: failure.errorCode,
          latestErrorMessage: failure.errorMessage,
          lastActionByUserId: actorUserId,
          updatedAt: now,
        }).where(eq(volcAssetGroups.id, row.id));
        return { kind: "result", result: { kind: "failure", status: "unknown", failure } };
      }

      const isRetry = row.status === "failed";
      const claimed = (await db.update(volcAssetGroups).set({
        status: "creating",
        source: "created",
        lastActionByUserId: actorUserId,
        latestRequestId: null,
        latestErrorCode: null,
        latestErrorMessage: null,
        retryCount: row.retryCount + (isRetry ? 1 : 0),
        lastAttemptAt: now,
        lastRetryAt: isRetry ? now : row.lastRetryAt,
        updatedAt: now,
      }).where(eq(volcAssetGroups.id, row.id)).returning())[0];
      if (!claimed) throw new Error("Failed to claim Volc asset group creation");
      return { kind: "create", row: claimed };
    });
  }

  async recordCreated(
    groupRowId: string,
    actorUserId: string,
    result: CreateVolcAssetGroupResult,
  ): Promise<VolcAssetGroupResolution> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const row = await requireGroupByIdForUpdate(db, groupRowId);
      if (row.status !== "creating") {
        throw new AppError(
          409,
          "volc_asset_group_state_conflict",
          "素材组状态已变化，请先读取当前状态后再操作",
        );
      }
      const now = new Date();
      const updated = (await db.update(volcAssetGroups).set({
        volcAssetGroupId: result.groupId,
        status: "active",
        lastActionByUserId: actorUserId,
        latestRequestId: result.requestId,
        latestErrorCode: null,
        latestErrorMessage: null,
        lastAttemptAt: now,
        updatedAt: now,
      }).where(eq(volcAssetGroups.id, row.id)).returning())[0];
      if (!updated?.volcAssetGroupId) throw new Error("Failed to save Volc asset group");
      return {
        kind: "resolved",
        groupId: updated.volcAssetGroupId,
        requestId: updated.latestRequestId,
      };
    });
  }

  async recordFailure(
    groupRowId: string,
    actorUserId: string,
    status: "failed" | "unknown",
    failure: VolcAssetGroupFailure,
  ): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const row = await requireGroupByIdForUpdate(db, groupRowId);
      if (row.status !== "creating") return;
      const now = new Date();
      await db.update(volcAssetGroups).set({
        status,
        lastActionByUserId: actorUserId,
        latestRequestId: failure.requestId,
        latestErrorCode: failure.errorCode,
        latestErrorMessage: failure.errorMessage,
        lastAttemptAt: now,
        updatedAt: now,
      }).where(eq(volcAssetGroups.id, row.id));
    });
  }
}

async function findGroupForUpdate(
  db: Database,
  configuration: VolcAssetGroupConfiguration,
): Promise<VolcAssetGroupRow | null> {
  return (await db.select().from(volcAssetGroups).where(and(
    eq(volcAssetGroups.projectName, configuration.projectName),
    eq(volcAssetGroups.groupType, "AIGC"),
    eq(volcAssetGroups.name, configuration.name),
  )).limit(1).for("update"))[0] ?? null;
}

async function requireGroupForUpdate(
  db: Database,
  configuration: VolcAssetGroupConfiguration,
): Promise<VolcAssetGroupRow> {
  const row = await findGroupForUpdate(db, configuration);
  if (!row) throw new Error("Volc asset group mapping disappeared");
  return row;
}

async function findGroupByRemoteIdForUpdate(
  db: Database,
  remoteGroupId: string,
): Promise<VolcAssetGroupRow | null> {
  return (await db.select().from(volcAssetGroups)
    .where(eq(volcAssetGroups.volcAssetGroupId, remoteGroupId))
    .limit(1)
    .for("update"))[0] ?? null;
}

async function requireGroupByIdForUpdate(db: Database, id: string): Promise<VolcAssetGroupRow> {
  const row = (await db.select().from(volcAssetGroups)
    .where(eq(volcAssetGroups.id, id)).limit(1).for("update"))[0];
  if (!row) throw new Error("Volc asset group mapping disappeared");
  return row;
}

function failureResolution(row: VolcAssetGroupRow): VolcAssetGroupResolution {
  const status = row.status === "failed" ? "failed" : "unknown";
  const projectedCode = row.latestErrorCode
    ? publicVolcAssetFailureCode(row.latestErrorCode)
    : "ASSET_GROUP_FAILED";
  return {
    kind: "failure",
    status,
    failure: {
      errorCode: isVolcAssetGroupFailureCode(projectedCode)
        ? projectedCode
        : "ASSET_GROUP_FAILED",
      errorMessage: row.latestErrorMessage
        ?? "火山素材组尚未创建完成，请联系管理员复核",
      requestId: row.latestRequestId,
      httpStatus: null,
    },
  };
}

function throwConfiguredGroupConflict(): never {
  throw new AppError(
    409,
    "volc_asset_group_configuration_conflict",
    "当前素材组配置与已保存的火山素材组不一致，请先由管理员核对",
  );
}
