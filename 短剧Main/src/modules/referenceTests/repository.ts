import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  assetEntities,
  assetMedia,
  generationAttempts,
  generationRequests,
  mediaResults,
  projectAssetRefs,
  projects,
  referenceTestResults,
  referenceTests,
} from "../../db/schema.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  isPostgresUniqueViolation,
} from "../../shared/errors.js";
import type {
  AttachReferenceTestResultInput,
  Page,
  ProjectReferenceTestResult,
  ReferenceTest,
  ReferenceTestInput,
  ReferenceTestMediaKind,
  ReferenceTestResult,
} from "./types.js";

type ReferenceTestRow = typeof referenceTests.$inferSelect;
type ReferenceTestResultRow = typeof referenceTestResults.$inferSelect;

/** PostgreSQL/Drizzle is the formal source of truth for the reference-test domain. */
export class DrizzleReferenceTestRepository {
  constructor(private readonly db: Database) {}

  async assertProjectOwner(actorId: string, projectId: string): Promise<void> {
    await assertProjectOwner(this.db, actorId, projectId);
  }

  async create(actorId: string, projectId: string, input: ReferenceTestInput): Promise<ReferenceTest> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await assertProjectOwner(tx, actorId, projectId);
      await assertReferenceMediaAccess(tx, actorId, projectId, input.referenceMediaIds);
      const now = new Date();
      const written = await tx.insert(referenceTests).values({
        id: crypto.randomUUID(),
        projectId,
        name: input.name,
        mediaKind: input.mediaKind,
        mode: input.mode,
        modelKey: input.modelKey,
        prompt: input.prompt,
        parameters: input.parameters,
        referenceMediaIds: input.referenceMediaIds,
        createdByUserId: actorId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }).returning();
      const row = written[0];
      if (!row) throw new Error("参考测试创建后读取失败");
      return toReferenceTest(row);
    });
  }

  async get(actorId: string, projectId: string, referenceTestId: string): Promise<ReferenceTest> {
    await this.assertProjectOwner(actorId, projectId);
    return getReferenceTest(this.db, projectId, referenceTestId);
  }

  async list(
    actorId: string,
    projectId: string,
    page: number,
    pageSize: number,
    mediaKind?: ReferenceTestMediaKind,
  ): Promise<Page<ReferenceTest>> {
    await this.assertProjectOwner(actorId, projectId);
    const where = [eq(referenceTests.projectId, projectId), isNull(referenceTests.deletedAt)];
    if (mediaKind) where.push(eq(referenceTests.mediaKind, mediaKind));
    const rows = await this.db.select().from(referenceTests)
      .where(and(...where))
      .orderBy(desc(referenceTests.updatedAt), desc(referenceTests.id))
      .limit(pageSize + 1)
      .offset((page - 1) * pageSize);
    return pageOf(rows.map(toReferenceTest), page, pageSize);
  }

  async update(
    actorId: string,
    projectId: string,
    referenceTestId: string,
    input: ReferenceTestInput,
    expectedVersion: number,
  ): Promise<ReferenceTest> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await assertProjectOwner(tx, actorId, projectId);
      await getReferenceTest(tx, projectId, referenceTestId);
      await assertReferenceMediaAccess(tx, actorId, projectId, input.referenceMediaIds);
      const written = await tx.update(referenceTests).set({
        name: input.name,
        mediaKind: input.mediaKind,
        mode: input.mode,
        modelKey: input.modelKey,
        prompt: input.prompt,
        parameters: input.parameters,
        referenceMediaIds: input.referenceMediaIds,
        version: sql`${referenceTests.version} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(referenceTests.id, referenceTestId),
        eq(referenceTests.projectId, projectId),
        isNull(referenceTests.deletedAt),
        eq(referenceTests.version, expectedVersion),
      )).returning();
      return toReferenceTest(written[0] ?? await throwReferenceTestVersionConflict(tx, projectId, referenceTestId));
    });
  }

  async remove(actorId: string, projectId: string, referenceTestId: string, expectedVersion: number): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await assertProjectOwner(tx, actorId, projectId);
      const written = await tx.update(referenceTests).set({
        deletedAt: new Date(),
        deletedByUserId: actorId,
        updatedAt: new Date(),
      }).where(and(
        eq(referenceTests.id, referenceTestId),
        eq(referenceTests.projectId, projectId),
        isNull(referenceTests.deletedAt),
        eq(referenceTests.version, expectedVersion),
      )).returning({ id: referenceTests.id });
      if (!written[0]) await throwReferenceTestVersionConflict(tx, projectId, referenceTestId);
    });
  }

  async attachResult(
    actorId: string,
    projectId: string,
    referenceTestId: string,
    input: AttachReferenceTestResultInput,
  ): Promise<ReferenceTestResult> {
    return this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Database;
      await assertProjectOwner(tx, actorId, projectId);
      const referenceTest = await getReferenceTest(tx, projectId, referenceTestId);
      await assertSourceResultLink(tx, projectId, referenceTest.mediaKind, input);
      try {
        const written = await tx.insert(referenceTestResults).values({
          id: crypto.randomUUID(),
          referenceTestId,
          generationRequestId: input.generationRequestId,
          mediaResultId: input.mediaResultId,
          mediaKind: referenceTest.mediaKind,
          mode: referenceTest.mode,
          modelKey: referenceTest.modelKey,
          parameters: referenceTest.parameters,
          createdByUserId: actorId,
          createdAt: new Date(),
        }).returning();
        const row = written[0];
        if (!row) throw new Error("参考测试结果创建后读取失败");
        return toReferenceTestResult(row);
      } catch (error) {
        if (isPostgresUniqueViolation(error)) {
          throw new ConflictError("该生成结果已加入本参考测试", "reference_test_result_already_attached");
        }
        throw error;
      }
    });
  }

  async listResults(
    actorId: string,
    projectId: string,
    referenceTestId: string,
    page: number,
    pageSize: number,
  ): Promise<Page<ProjectReferenceTestResult>> {
    await this.assertProjectOwner(actorId, projectId);
    await getReferenceTest(this.db, projectId, referenceTestId);
    const rows = await this.db.select({
      result: referenceTestResults,
      referenceTestName: referenceTests.name,
      mediaResultId: mediaResults.id,
      storageUrl: mediaResults.storageUrl,
      persistenceStatus: mediaResults.persistenceStatus,
      mimeType: mediaResults.mimeType,
      widthPx: mediaResults.widthPx,
      heightPx: mediaResults.heightPx,
      durationSeconds: mediaResults.durationSeconds,
    }).from(referenceTestResults)
      .innerJoin(referenceTests, eq(referenceTests.id, referenceTestResults.referenceTestId))
      .leftJoin(mediaResults, and(eq(mediaResults.id, referenceTestResults.mediaResultId), isNull(mediaResults.deletedAt)))
      .where(eq(referenceTestResults.referenceTestId, referenceTestId))
      .orderBy(desc(referenceTestResults.createdAt), desc(referenceTestResults.id))
      .limit(pageSize + 1)
      .offset((page - 1) * pageSize);
    return pageOf(rows.map(toProjectReferenceTestResult), page, pageSize);
  }

  async listProjectResults(
    actorId: string,
    projectId: string,
    page: number,
    pageSize: number,
    mediaKind?: ReferenceTestMediaKind,
  ): Promise<Page<ProjectReferenceTestResult>> {
    await this.assertProjectOwner(actorId, projectId);
    const where = [eq(referenceTests.projectId, projectId), isNull(referenceTests.deletedAt)];
    if (mediaKind) where.push(eq(referenceTestResults.mediaKind, mediaKind));
    const rows = await this.db.select({
      result: referenceTestResults,
      referenceTestName: referenceTests.name,
      mediaResultId: mediaResults.id,
      storageUrl: mediaResults.storageUrl,
      persistenceStatus: mediaResults.persistenceStatus,
      mimeType: mediaResults.mimeType,
      widthPx: mediaResults.widthPx,
      heightPx: mediaResults.heightPx,
      durationSeconds: mediaResults.durationSeconds,
    }).from(referenceTestResults)
      .innerJoin(referenceTests, eq(referenceTests.id, referenceTestResults.referenceTestId))
      .leftJoin(mediaResults, and(eq(mediaResults.id, referenceTestResults.mediaResultId), isNull(mediaResults.deletedAt)))
      .where(and(...where))
      .orderBy(desc(referenceTestResults.createdAt), desc(referenceTestResults.id))
      .limit(pageSize + 1)
      .offset((page - 1) * pageSize);
    return pageOf(rows.map(toProjectReferenceTestResult), page, pageSize);
  }

  async getResultForDefault(
    actorId: string,
    projectId: string,
    referenceTestId: string,
    resultId: string,
  ): Promise<ReferenceTestResult> {
    await this.assertProjectOwner(actorId, projectId);
    const row = (await this.db.select({ result: referenceTestResults })
      .from(referenceTestResults)
      .innerJoin(referenceTests, eq(referenceTests.id, referenceTestResults.referenceTestId))
      .where(and(
        eq(referenceTestResults.id, resultId),
        eq(referenceTestResults.referenceTestId, referenceTestId),
        eq(referenceTests.projectId, projectId),
        isNull(referenceTests.deletedAt),
      )).limit(1))[0];
    if (!row) throw new NotFoundError("参考测试结果不存在");
    return toReferenceTestResult(row.result);
  }
}

async function assertProjectOwner(db: Database, actorId: string, projectId: string): Promise<void> {
  const project = (await db.select({ ownerUserId: projects.ownerUserId }).from(projects).where(and(
    eq(projects.id, projectId),
    isNull(projects.deletedAt),
  )).limit(1))[0];
  if (!project) throw new NotFoundError("项目不存在");
  if (project.ownerUserId !== actorId) throw new ForbiddenError();
}

async function getReferenceTest(db: Database, projectId: string, referenceTestId: string): Promise<ReferenceTest> {
  const row = (await db.select().from(referenceTests).where(and(
    eq(referenceTests.id, referenceTestId),
    eq(referenceTests.projectId, projectId),
    isNull(referenceTests.deletedAt),
  )).limit(1))[0];
  if (!row) throw new NotFoundError("参考测试不存在");
  return toReferenceTest(row);
}

async function assertReferenceMediaAccess(
  db: Database,
  actorId: string,
  projectId: string,
  mediaIds: string[],
): Promise<void> {
  if (mediaIds.length === 0) return;
  const rows = await db.select({ id: assetMedia.id }).from(assetMedia)
    .leftJoin(assetEntities, and(eq(assetEntities.id, assetMedia.assetEntityId), isNull(assetEntities.deletedAt)))
    .leftJoin(projectAssetRefs, and(
      eq(projectAssetRefs.assetMediaId, assetMedia.id),
      eq(projectAssetRefs.projectId, projectId),
      isNull(projectAssetRefs.deletedAt),
    ))
    .where(and(
      inArray(assetMedia.id, mediaIds),
      isNull(assetMedia.deletedAt),
      or(
        isNotNull(projectAssetRefs.id),
        eq(assetEntities.visibility, "common"),
        eq(assetEntities.ownerUserId, actorId),
      ),
    ));
  const accessible = new Set(rows.map((row) => row.id));
  const missing = mediaIds.filter((id) => !accessible.has(id));
  if (missing.length > 0) {
    throw new ConflictError("部分参考素材不存在、已删除或无权使用，请重新选择", "reference_test_media_access_denied");
  }
}

async function assertSourceResultLink(
  db: Database,
  projectId: string,
  mediaKind: ReferenceTestMediaKind,
  input: AttachReferenceTestResultInput,
): Promise<void> {
  const source = (await db.select({ id: mediaResults.id }).from(mediaResults)
    .innerJoin(generationRequests, eq(generationRequests.id, mediaResults.requestId))
    .innerJoin(generationAttempts, eq(generationAttempts.id, mediaResults.attemptId))
    .where(and(
      eq(mediaResults.id, input.mediaResultId),
      eq(mediaResults.requestId, input.generationRequestId),
      eq(generationRequests.projectId, projectId),
      eq(mediaResults.mediaKind, mediaKind),
      isNull(mediaResults.deletedAt),
      eq(mediaResults.persistenceStatus, "persisted"),
      eq(generationAttempts.status, "succeeded"),
    )).limit(1))[0];
  if (!source) {
    throw new ConflictError(
      "来源结果必须属于当前项目、关联指定任务、类型一致且已持久化",
      "reference_test_source_result_mismatch",
    );
  }
}

async function throwReferenceTestVersionConflict(
  db: Database,
  projectId: string,
  referenceTestId: string,
): Promise<never> {
  const current = (await db.select({ id: referenceTests.id }).from(referenceTests).where(and(
    eq(referenceTests.id, referenceTestId),
    eq(referenceTests.projectId, projectId),
    isNull(referenceTests.deletedAt),
  )).limit(1))[0];
  if (!current) throw new NotFoundError("参考测试不存在");
  throw new ConflictError(
    "参考测试已被其他人更新，请刷新后重试",
    "reference_test_version_conflict",
  );
}

function toReferenceTest(row: ReferenceTestRow): ReferenceTest {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    mediaKind: row.mediaKind as ReferenceTestMediaKind,
    mode: row.mode as ReferenceTest["mode"],
    modelKey: row.modelKey,
    prompt: row.prompt,
    parameters: row.parameters,
    referenceMediaIds: row.referenceMediaIds,
    createdByUserId: row.createdByUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toReferenceTestResult(row: ReferenceTestResultRow): ReferenceTestResult {
  return {
    id: row.id,
    referenceTestId: row.referenceTestId,
    generationRequestId: row.generationRequestId,
    mediaResultId: row.mediaResultId,
    mediaKind: row.mediaKind as ReferenceTestMediaKind,
    mode: row.mode as ReferenceTestResult["mode"],
    modelKey: row.modelKey,
    parameters: row.parameters,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toProjectReferenceTestResult(row: {
  result: ReferenceTestResultRow;
  referenceTestName: string;
  mediaResultId: string | null;
  storageUrl: string | null;
  persistenceStatus: string | null;
  mimeType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
}): ProjectReferenceTestResult {
  return {
    ...toReferenceTestResult(row.result),
    referenceTestName: row.referenceTestName,
    mediaResult: row.mediaResultId ? {
      storageUrl: row.storageUrl,
      persistenceStatus: row.persistenceStatus,
      mimeType: row.mimeType,
      widthPx: row.widthPx,
      heightPx: row.heightPx,
      durationSeconds: row.durationSeconds,
    } : null,
  };
}

function pageOf<T>(items: T[], page: number, pageSize: number): Page<T> {
  return { items: items.slice(0, pageSize), page, pageSize, hasNext: items.length > pageSize };
}
