import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { projectDirectorStoryboardPrompts } from "../db/schema.js";
import type { JsonObject } from "../domain/assets/types.js";

export interface StoryboardPromptData {
  projectId: string;
  projectName?: string | null;
  episodeNo?: number | null;
  shotNo?: number | null;
  sceneName?: string | null;
  directorPromptText?: string | null;
  shotDescription?: string | null;
  cameraMovement?: string | null;
  lighting?: string | null;
  soundInstruction?: string | null;
  soundEffect?: string | null;
  userId?: string | null;
  userName?: string | null;
  resultMediaId?: string | null;
  status?: string;
  metadata?: JsonObject;
  referenceFileUrl?: string | null;
  storyboardFileUrl?: string | null;
}

export class StoryboardPromptRepository {
  constructor(private readonly db: Database) {}

  async getByProjectEpisodeShot(input: {
    projectId: string;
    episodeNo?: number | null;
    shotNo?: number | null;
  }) {
    const episodeCondition = input.episodeNo === null || input.episodeNo === undefined
      ? isNull(projectDirectorStoryboardPrompts.episodeNo)
      : eq(projectDirectorStoryboardPrompts.episodeNo, input.episodeNo);
    const shotCondition = input.shotNo === null || input.shotNo === undefined
      ? isNull(projectDirectorStoryboardPrompts.shotNo)
      : eq(projectDirectorStoryboardPrompts.shotNo, input.shotNo);
    const rows = await this.db
      .select()
      .from(projectDirectorStoryboardPrompts)
      .where(and(
        eq(projectDirectorStoryboardPrompts.projectId, input.projectId),
        episodeCondition,
        shotCondition,
      ))
      .limit(1);
    return rows[0];
  }

  async save(input: StoryboardPromptData) {
    const existing = await this.getByProjectEpisodeShot(input);
    const now = new Date();
    const values = {
      projectId: input.projectId,
      projectName: input.projectName ?? null,
      episodeNo: input.episodeNo ?? null,
      shotNo: input.shotNo ?? null,
      sceneName: input.sceneName ?? null,
      directorPromptText: input.directorPromptText ?? null,
      shotDescription: input.shotDescription ?? null,
      cameraMovement: input.cameraMovement ?? null,
      lighting: input.lighting ?? null,
      soundInstruction: input.soundInstruction ?? null,
      soundEffect: input.soundEffect ?? null,
      userId: input.userId ?? null,
      userName: input.userName ?? null,
      resultMediaId: input.resultMediaId ?? null,
      status: input.status ?? "active",
      metadata: input.metadata ?? {},
      referenceFileUrl: input.referenceFileUrl ?? null,
      storyboardFileUrl: input.storyboardFileUrl ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) {
      const rows = await this.db.update(projectDirectorStoryboardPrompts)
        .set(values)
        .where(eq(projectDirectorStoryboardPrompts.id, existing.id))
        .returning();
      return rows[0];
    }
    const rows = await this.db.insert(projectDirectorStoryboardPrompts)
      .values({ id: crypto.randomUUID(), ...values })
      .returning();
    return rows[0];
  }
}
