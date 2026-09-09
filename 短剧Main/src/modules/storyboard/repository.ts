import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { episodes, scenes, shots, storyboardImports } from "../../db/schema.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessAction, ProjectAccessActor } from "../project-access/types.js";
import type {
  StoryboardImportRecord,
  StoryboardImportRepository,
  StoryboardPreview,
  StoryboardPreviewIssue,
  StoryboardPreviewShot,
} from "./types.js";

export class DrizzleStoryboardImportRepository implements StoryboardImportRepository {
  constructor(
    private readonly db: Database,
    private readonly sourceSha256 = "",
    private readonly access = ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
  ) {}

  async createPreview(input: {
    projectId: string;
    uploadedBy: string;
    fileName: string;
    preview: StoryboardPreview;
  }): Promise<StoryboardImportRecord> {
    const now = new Date();
    const rows = await this.db.insert(storyboardImports).values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      createdByUserId: input.uploadedBy,
      sourceFileName: input.fileName,
      sourceSha256: this.sourceSha256,
      sourceStoragePath: null,
      status: "previewed",
      previewRows: input.preview.rows as unknown as Array<Record<string, unknown>>,
      warnings: input.preview.issues.filter((issue) => issue.level === "warning") as unknown as Array<Record<string, unknown>>,
      errors: input.preview.issues.filter((issue) => issue.level === "error") as unknown as Array<Record<string, unknown>>,
      confirmationResult: null,
      confirmedAt: null,
      confirmedByUserId: null,
      createdAt: now,
      updatedAt: now,
    }).returning();
    const created = rows[0];
    if (!created) throw new Error("Failed to create storyboard import");
    return toRecord(created);
  }

  async getById(id: string): Promise<StoryboardImportRecord | undefined> {
    const rows = await this.db.select().from(storyboardImports).where(eq(storyboardImports.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async confirm(input: {
    importId: string;
    projectId: string;
    actor: ProjectAccessActor;
    rows: StoryboardPreviewShot[];
  }): Promise<StoryboardImportRecord> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM ${storyboardImports} WHERE id = ${input.importId} FOR UPDATE`);
      const importRows = await tx.select().from(storyboardImports)
        .where(eq(storyboardImports.id, input.importId)).limit(1);
      const importRow = importRows[0];
      if (!importRow || importRow.projectId !== input.projectId) throw new NotFoundError("分镜导入记录不存在");
      if (importRow.status === "confirmed") return;
      if (importRow.createdByUserId !== input.actor.id) throw new ForbiddenError("无权确认这份分镜导入");
      if (importRow.errors.length > 0) throw new ConflictError("预览仍有错误，不能确认导入", "storyboard_has_errors");

      // A route check alone is insufficient because a membership can change
      // between preview and confirmation. Re-check inside the import write
      // transaction, where project membership is the sole authority.
      await ProjectAccessService.fromDatabase(new ProjectAccessRepository(tx as unknown as Database))
        .require(input.actor, input.projectId, "create");

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.projectId}))`);
      const createdEpisodeIds: string[] = [];
      const createdSceneIds: string[] = [];
      const createdShotIds: string[] = [];
      const episodeMap = new Map<number, string>();
      const sceneMap = new Map<string, string>();

      for (const row of [...input.rows].sort((left, right) => left.sortOrder - right.sortOrder)) {
        let episodeId = episodeMap.get(row.episodeNo);
        if (!episodeId) {
          const existingEpisodes = await tx.select().from(episodes).where(and(
            eq(episodes.projectId, input.projectId),
            eq(episodes.episodeNo, row.episodeNo),
            isNull(episodes.deletedAt),
          )).limit(1);
          const existing = existingEpisodes[0];
          if (existing) {
            episodeId = existing.id;
          } else {
            episodeId = crypto.randomUUID();
            const now = new Date();
            await tx.insert(episodes).values({
              id: episodeId,
              projectId: input.projectId,
              episodeNo: row.episodeNo,
              name: `第 ${row.episodeNo} 集`,
              sortOrder: row.episodeNo,
              status: "active",
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
              deletedByUserId: null,
            });
            createdEpisodeIds.push(episodeId);
          }
          episodeMap.set(row.episodeNo, episodeId);
        }

        const sceneKey = `${episodeId}:${row.sceneName}`;
        let sceneId = sceneMap.get(sceneKey);
        if (!sceneId) {
          const existingScenes = await tx.select().from(scenes).where(and(
            eq(scenes.episodeId, episodeId),
            eq(scenes.name, row.sceneName),
            isNull(scenes.deletedAt),
          )).limit(1);
          const existing = existingScenes[0];
          if (existing) {
            sceneId = existing.id;
          } else {
            const maximum = await tx.select({ value: max(scenes.sceneNo) }).from(scenes)
              .where(and(eq(scenes.episodeId, episodeId), isNull(scenes.deletedAt)));
            const sceneNo = (maximum[0]?.value ?? 0) + 1;
            sceneId = crypto.randomUUID();
            const now = new Date();
            await tx.insert(scenes).values({
              id: sceneId,
              episodeId,
              sceneNo,
              name: row.sceneName,
              description: null,
              sortOrder: sceneNo,
              createdAt: now,
              updatedAt: now,
              deletedAt: null,
              deletedByUserId: null,
            });
            createdSceneIds.push(sceneId);
          }
          sceneMap.set(sceneKey, sceneId);
        }

        const duplicate = await tx.select({ id: shots.id }).from(shots).where(and(
          eq(shots.episodeId, episodeId),
          eq(shots.shotCode, row.shotCode),
          isNull(shots.deletedAt),
        )).limit(1);
        if (duplicate[0]) {
          throw new ConflictError(`第 ${row.episodeNo} 集镜号 ${row.shotCode} 已存在`, "duplicate_shot_code");
        }

        const shotId = crypto.randomUUID();
        const now = new Date();
        const promptParts = [
          row.screenDescription,
          row.cameraMovement ? `镜头运动：${row.cameraMovement}` : null,
          row.shotSizeAngle ? `景别视角：${row.shotSizeAngle}` : null,
        ].filter((value): value is string => Boolean(value));
        await tx.insert(shots).values({
          id: shotId,
          episodeId,
          sceneId,
          shotCode: row.shotCode,
          title: row.screenDescription?.slice(0, 255) ?? `镜头 ${row.shotCode}`,
          scriptText: row.dialogue,
          directorPrompt: promptParts.join("\n") || null,
          imagePrompt: row.screenDescription,
          videoPrompt: promptParts.join("\n") || null,
          durationSeconds: null,
          sortOrder: row.sortOrder,
          referenceAssetSnapshots: [],
          selectedImageResultId: null,
          selectedVideoResultId: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          deletedByUserId: null,
        });
        createdShotIds.push(shotId);
      }

      const confirmedAt = new Date();
      await tx.update(storyboardImports).set({
        status: "confirmed",
        confirmedAt,
        confirmedByUserId: input.actor.id,
        confirmationResult: {
          created_episode_ids: createdEpisodeIds,
          created_scene_ids: createdSceneIds,
          created_shot_ids: createdShotIds,
          imported_shot_count: input.rows.length,
        },
        updatedAt: confirmedAt,
      }).where(eq(storyboardImports.id, input.importId));
    });

    const confirmed = await this.getById(input.importId);
    if (!confirmed) throw new Error("Confirmed storyboard import disappeared");
    return confirmed;
  }

  async requireProjectAccess(
    projectId: string,
    actor: ProjectAccessActor,
    action: ProjectAccessAction,
  ): Promise<void> {
    await this.access.require(actor, projectId, action);
  }
}

function toRecord(row: typeof storyboardImports.$inferSelect): StoryboardImportRecord {
  const previewRows = row.previewRows as unknown as StoryboardPreviewShot[];
  const warnings = row.warnings as unknown as StoryboardPreviewIssue[];
  const errors = row.errors as unknown as StoryboardPreviewIssue[];
  return {
    id: row.id,
    projectId: row.projectId,
    uploadedBy: row.createdByUserId,
    fileName: row.sourceFileName,
    status: row.status as StoryboardImportRecord["status"],
    preview: {
      rows: previewRows,
      issues: [...errors, ...warnings],
      episodeCount: new Set(previewRows.map((item) => item.episodeNo)).size,
      sceneCount: new Set(previewRows.map((item) => `${item.episodeNo}:${item.sceneName}`)).size,
      shotCount: previewRows.length,
      canConfirm: previewRows.length > 0 && errors.length === 0,
    },
    confirmationResult: row.confirmationResult,
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
  };
}
