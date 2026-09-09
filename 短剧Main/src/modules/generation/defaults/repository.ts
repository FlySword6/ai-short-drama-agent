import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import {
  generationDefaultStrategies,
  generationRequests,
  projects,
} from "../../../db/schema.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type {
  GenerationDefaultMediaKind,
  GenerationDefaultStrategy,
  PutGenerationDefaultStrategyInput,
} from "./types.js";

type StrategyRow = typeof generationDefaultStrategies.$inferSelect;

/** PostgreSQL is the only source of truth for test-domain defaults. */
export class GenerationDefaultStrategyRepository {
  constructor(private readonly db: Database) {}

  async listForActor(
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy[]> {
    await this.assertProjectOwnerUnlessRouteVerified(actorId, projectId, authorizedProjectId);
    const rows = await this.db.select().from(generationDefaultStrategies)
      .where(eq(generationDefaultStrategies.projectId, projectId))
      .orderBy(asc(generationDefaultStrategies.mediaKind));
    return rows.map(toStrategy);
  }

  async getForActor(
    actorId: string,
    projectId: string,
    mediaKind: GenerationDefaultMediaKind,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy | undefined> {
    await this.assertProjectOwnerUnlessRouteVerified(actorId, projectId, authorizedProjectId);
    const rows = await this.db.select().from(generationDefaultStrategies).where(and(
      eq(generationDefaultStrategies.projectId, projectId),
      eq(generationDefaultStrategies.mediaKind, mediaKind),
    )).limit(1);
    return rows[0] ? toStrategy(rows[0]) : undefined;
  }

  async putForActor(
    actorId: string,
    projectId: string,
    input: PutGenerationDefaultStrategyInput,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy> {
    return this.db.transaction(async (tx) => {
      await assertProjectOwnerUnlessRouteVerified(tx as Database, actorId, projectId, authorizedProjectId);
      if (input.sourceGenerationRequestId) {
        await assertSourceGenerationRequest(
          tx as Database,
          projectId,
          input.mediaKind,
          input.sourceGenerationRequestId,
        );
      }

      const currentRows = await tx.select({ version: generationDefaultStrategies.version })
        .from(generationDefaultStrategies)
        .where(and(
          eq(generationDefaultStrategies.projectId, projectId),
          eq(generationDefaultStrategies.mediaKind, input.mediaKind),
        ))
        .limit(1);
      const current = currentRows[0];
      if (!current && input.expectedVersion !== 0) {
        throw new ConflictError(
          "默认策略还未创建，请刷新页面后再保存",
          "generation_default_version_conflict",
        );
      }

      const now = new Date();
      const written = await tx.insert(generationDefaultStrategies).values({
        id: crypto.randomUUID(),
        projectId,
        mediaKind: input.mediaKind,
        mode: input.mode,
        modelKey: input.modelKey,
        parameters: input.parameters,
        sourceGenerationRequestId: input.sourceGenerationRequestId ?? null,
        updatedByUserId: actorId,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [generationDefaultStrategies.projectId, generationDefaultStrategies.mediaKind],
        set: {
          mode: input.mode,
          modelKey: input.modelKey,
          parameters: input.parameters,
          sourceGenerationRequestId: input.sourceGenerationRequestId ?? null,
          updatedByUserId: actorId,
          version: sql`${generationDefaultStrategies.version} + 1`,
          updatedAt: now,
        },
        where: eq(generationDefaultStrategies.version, input.expectedVersion),
      }).returning();
      if (written[0]) return toStrategy(written[0]);

      throw new ConflictError(
        "默认策略已被其他人更新，请刷新后重试",
        "generation_default_version_conflict",
      );
    });
  }

  private async assertProjectOwnerUnlessRouteVerified(
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): Promise<void> {
    await assertProjectOwnerUnlessRouteVerified(this.db, actorId, projectId, authorizedProjectId);
  }
}

/**
 * The HTTP route obtains this scope only after ProjectAccessService decides
 * the caller's platform and project role. Legacy direct callers deliberately
 * retain the original owner-only rule until they adopt that route contract.
 */
async function assertProjectOwnerUnlessRouteVerified(
  db: Database,
  actorId: string,
  projectId: string,
  authorizedProjectId?: string,
): Promise<void> {
  if (authorizedProjectId !== undefined) {
    if (authorizedProjectId !== projectId) throw new NotFoundError("项目不存在");
    return;
  }
  await assertProjectOwner(db, actorId, projectId);
}

async function assertProjectOwner(db: Database, actorId: string, projectId: string): Promise<void> {
  const rows = await db.select({ ownerUserId: projects.ownerUserId }).from(projects).where(and(
    eq(projects.id, projectId),
    isNull(projects.deletedAt),
  )).limit(1);
  const project = rows[0];
  if (!project) throw new NotFoundError("项目不存在");
  if (project.ownerUserId !== actorId) throw new ForbiddenError();
}

async function assertSourceGenerationRequest(
  db: Database,
  projectId: string,
  mediaKind: GenerationDefaultMediaKind,
  requestId: string,
): Promise<void> {
  const rows = await db.select({
    projectId: generationRequests.projectId,
    mediaKind: generationRequests.mediaKind,
  }).from(generationRequests).where(eq(generationRequests.id, requestId)).limit(1);
  const source = rows[0];
  if (!source) throw new NotFoundError("来源生成任务不存在");
  if (source.projectId !== projectId || source.mediaKind !== mediaKind) {
    throw new ConflictError(
      "来源生成任务不属于当前项目或媒体类型",
      "generation_default_source_mismatch",
    );
  }
}

function toStrategy(row: StrategyRow): GenerationDefaultStrategy {
  return {
    id: row.id,
    projectId: row.projectId,
    mediaKind: row.mediaKind as GenerationDefaultMediaKind,
    mode: row.mode as GenerationDefaultStrategy["mode"],
    modelKey: row.modelKey,
    parameters: row.parameters,
    sourceGenerationRequestId: row.sourceGenerationRequestId,
    updatedByUserId: row.updatedByUserId,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
