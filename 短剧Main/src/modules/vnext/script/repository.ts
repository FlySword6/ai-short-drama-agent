import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import type { FormalShotPlanFacts, ShotPlanDraft } from "../shot-plan/types.js";
import type {
  ScriptParseError,
  ScriptParseRun,
  ScriptParseStage,
  ScriptSourceKind,
} from "./types.js";

type RunRow = {
  id: string;
  project_id: string;
  source_id: string;
  status: ScriptParseRun["status"];
  progress: number;
  current_stage: ScriptParseStage;
  draft: ShotPlanDraft | null;
  error_code: ScriptParseError["code"] | null;
  error_message: string | null;
  error_retryable: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  confirmed_at: Date | string | null;
};

type ConfirmationRow = {
  id: string;
  confirmed_at: Date | string;
};
type CharacterFactRow = Record<string, unknown> & FormalShotPlanFacts["characters"][number];
type SceneFactRow = Record<string, unknown> & FormalShotPlanFacts["scenes"][number];
type ShotFactRow = Record<string, unknown> & FormalShotPlanFacts["shots"][number];

export class VnextScriptRepository {
  constructor(private readonly db: Database) {}

  async createRun(input: {
    projectId: string;
    actorId: string;
    sourceKind: ScriptSourceKind;
    fileName: string | null;
    scriptContent: string;
    contentSha256: string;
    clientIdempotencyKey: string;
  }): Promise<{ run: ScriptParseRun; created: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${JSON.stringify([input.projectId, input.clientIdempotencyKey])}, 0)
        )`);
      const existing = await tx.execute<RunRow>(sql`
        SELECT ${runColumns} FROM vnext.script_parse_runs
        WHERE project_id = ${input.projectId}::uuid
          AND client_idempotency_key = ${input.clientIdempotencyKey}`);
      if (existing.rows[0]) return { run: toRun(existing.rows[0]), created: false };
      const sourceId = randomUUID();
      const runId = randomUUID();
      await tx.execute(sql`
        INSERT INTO vnext.script_sources (
          id, project_id, source_kind, file_name, script_content, content_sha256, created_by_user_id
        ) VALUES (
          ${sourceId}::uuid, ${input.projectId}::uuid, ${input.sourceKind}, ${input.fileName},
          ${input.scriptContent}, ${input.contentSha256}, ${input.actorId}::uuid
        )`);
      const inserted = await tx.execute<RunRow>(sql`
        INSERT INTO vnext.script_parse_runs (
          id, project_id, source_id, client_idempotency_key, status, progress,
          current_stage, created_by_user_id
        ) VALUES (
          ${runId}::uuid, ${input.projectId}::uuid, ${sourceId}::uuid,
          ${input.clientIdempotencyKey}, 'queued', 0, 'queued', ${input.actorId}::uuid
        )
        RETURNING ${runColumns}`);
      return { run: toRun(inserted.rows[0]!), created: true };
    });
  }

  async latestRun(projectId: string): Promise<ScriptParseRun | null> {
    const result = await this.db.execute<RunRow>(sql`
      SELECT ${runColumns} FROM vnext.script_parse_runs
      WHERE project_id = ${projectId}::uuid
      ORDER BY created_at DESC, id DESC LIMIT 1`);
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  async findRun(runId: string): Promise<ScriptParseRun | null> {
    const result = await this.db.execute<RunRow>(sql`
      SELECT ${runColumns} FROM vnext.script_parse_runs WHERE id = ${runId}::uuid`);
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  async sourceForAnalysis(runId: string): Promise<{
    scriptContent: string;
    actorId: string;
  } | null> {
    const result = await this.db.execute<{
      script_content: string;
      created_by_user_id: string;
    }>(sql`
      SELECT s.script_content, r.created_by_user_id
      FROM vnext.script_parse_runs r
      JOIN vnext.script_sources s ON s.id = r.source_id
      WHERE r.id = ${runId}::uuid`);
    const row = result.rows[0];
    return row ? {
      scriptContent: row.script_content,
      actorId: row.created_by_user_id,
    } : null;
  }

  async beginRun(runId: string): Promise<boolean> {
    const result = await this.db.execute(sql`
      UPDATE vnext.script_parse_runs
      SET status = 'running', progress = 10, current_stage = 'reading',
          draft = NULL, error_code = NULL, error_message = NULL,
          error_retryable = false, updated_at = now()
      WHERE id = ${runId}::uuid AND status IN ('queued', 'failed', 'partial_failure')`);
    return (result.rowCount ?? 0) === 1;
  }

  async updateProgress(runId: string, progress: number, stage: ScriptParseStage): Promise<void> {
    await this.db.execute(sql`
      UPDATE vnext.script_parse_runs
      SET progress = ${progress}, current_stage = ${stage}, updated_at = now()
      WHERE id = ${runId}::uuid AND status = 'running'`);
  }

  async completeRun(runId: string, draft: ShotPlanDraft): Promise<void> {
    await this.db.execute(sql`
      UPDATE vnext.script_parse_runs
      SET status = 'draft', progress = 100, current_stage = 'ready',
          draft = ${JSON.stringify(draft)}::jsonb, error_code = NULL,
          error_message = NULL, error_retryable = false, updated_at = now()
      WHERE id = ${runId}::uuid AND status = 'running'`);
  }

  async failRun(input: {
    runId: string;
    status: "failed" | "partial_failure";
    error: ScriptParseError;
    draft?: ShotPlanDraft;
  }): Promise<void> {
    await this.db.execute(sql`
      UPDATE vnext.script_parse_runs
      SET status = ${input.status}, progress = ${input.status === "partial_failure" ? 85 : 100},
          current_stage = 'failed', draft = ${input.draft ? JSON.stringify(input.draft) : null}::jsonb,
          error_code = ${input.error.code}, error_message = ${input.error.message},
          error_retryable = ${input.error.retryable}, updated_at = now()
      WHERE id = ${input.runId}::uuid AND status = 'running'`);
  }

  async resetForRetry(runId: string): Promise<{
    run: ScriptParseRun;
    transitioned: boolean;
  } | null> {
    return this.db.transaction(async (tx) => {
      const result = await tx.execute<RunRow>(sql`
        UPDATE vnext.script_parse_runs
        SET status = 'queued', progress = 0, current_stage = 'queued', draft = NULL,
            error_code = NULL, error_message = NULL, error_retryable = false, updated_at = now()
        WHERE id = ${runId}::uuid
          AND status IN ('failed', 'partial_failure')
          AND error_retryable = true
        RETURNING ${runColumns}`);
      if (result.rows[0]) {
        return { run: toRun(result.rows[0]), transitioned: true };
      }
      const current = await tx.execute<RunRow>(sql`
        SELECT ${runColumns} FROM vnext.script_parse_runs WHERE id = ${runId}::uuid`);
      return current.rows[0]
        ? { run: toRun(current.rows[0]), transitioned: false }
        : null;
    });
  }

  async recoverInterrupted(runId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE vnext.script_parse_runs
      SET status = 'queued', progress = 0, current_stage = 'queued',
          draft = NULL, error_code = NULL, error_message = NULL,
          error_retryable = false, updated_at = now()
      WHERE id = ${runId}::uuid AND status = 'running'`);
  }

  async confirm(input: {
    runId: string;
    actorId: string;
    clientIdempotencyKey: string;
  }): Promise<FormalShotPlanFacts | null> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute<RunRow>(sql`
        SELECT ${runColumns} FROM vnext.script_parse_runs
        WHERE id = ${input.runId}::uuid FOR UPDATE`);
      const run = locked.rows[0];
      if (!run) return null;
      const existing = await tx.execute<ConfirmationRow>(sql`
        SELECT id, confirmed_at FROM vnext.script_confirmations
        WHERE run_id = ${input.runId}::uuid`);
      if (existing.rows[0]) {
        return readFormalFacts(tx, existing.rows[0]);
      }
      if (run.status !== "draft" || !run.draft) return null;
      const confirmation = { id: randomUUID(), confirmed_at: new Date() };
      await tx.execute(sql`
        INSERT INTO vnext.script_confirmations (
          id, project_id, run_id, client_idempotency_key, confirmed_by_user_id, confirmed_at
        ) VALUES (
          ${confirmation.id}::uuid, ${run.project_id}::uuid, ${input.runId}::uuid,
          ${input.clientIdempotencyKey}, ${input.actorId}::uuid, ${confirmation.confirmed_at}
        )`);
      for (const character of run.draft.characters) {
        const id = randomUUID();
        await tx.execute(sql`
          INSERT INTO vnext.shot_plan_characters (
            id, project_id, confirmation_id, draft_key, name, description
          ) VALUES (
            ${id}::uuid, ${run.project_id}::uuid, ${confirmation.id}::uuid,
            ${character.key}, ${character.name}, ${character.description}
          )`);
      }
      const sceneIds = new Map<string, string>();
      for (const scene of run.draft.scenes) {
        const id = randomUUID();
        sceneIds.set(scene.key, id);
        await tx.execute(sql`
          INSERT INTO vnext.shot_plan_scenes (
            id, project_id, confirmation_id, draft_key, title, summary, position
          ) VALUES (
            ${id}::uuid, ${run.project_id}::uuid, ${confirmation.id}::uuid,
            ${scene.key}, ${scene.title}, ${scene.summary}, ${scene.position}
          )`);
      }
      for (const shot of run.draft.shots) {
        await tx.execute(sql`
          INSERT INTO vnext.shot_plan_shots (
            id, project_id, confirmation_id, scene_id, draft_key, position,
            shot_size, camera_movement, action, rhythm, dialogue, sound
          ) VALUES (
            ${randomUUID()}::uuid, ${run.project_id}::uuid, ${confirmation.id}::uuid,
            ${sceneIds.get(shot.sceneKey)!}::uuid, ${shot.key}, ${shot.position},
            ${shot.shotSize}, ${shot.cameraMovement}, ${shot.action},
            ${shot.rhythm}, ${shot.dialogue}, ${shot.sound}
          )`);
      }
      await tx.execute(sql`
        UPDATE vnext.script_parse_runs
        SET status = 'confirmed', current_stage = 'confirmed',
            confirmed_by_user_id = ${input.actorId}::uuid,
            confirmed_at = ${confirmation.confirmed_at}, updated_at = now()
        WHERE id = ${input.runId}::uuid`);
      return readFormalFacts(tx, confirmation);
    });
  }

  async latestFormalFacts(projectId: string): Promise<FormalShotPlanFacts | null> {
    const result = await this.db.execute<ConfirmationRow>(sql`
      SELECT id, confirmed_at FROM vnext.script_confirmations
      WHERE project_id = ${projectId}::uuid
      ORDER BY confirmed_at DESC, id DESC LIMIT 1`);
    return result.rows[0] ? readFormalFacts(this.db, result.rows[0]) : null;
  }
}

const runColumns = sql.raw(`
  id, project_id, source_id, status, progress, current_stage, draft,
  error_code, error_message, error_retryable, created_at, updated_at, confirmed_at
`);

function toRun(row: RunRow): ScriptParseRun {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    status: row.status,
    progress: row.progress,
    currentStage: row.current_stage,
    draft: row.draft,
    error: row.error_code && row.error_message
      ? { code: row.error_code, message: row.error_message, retryable: row.error_retryable }
      : null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    confirmedAt: row.confirmed_at ? toDate(row.confirmed_at) : null,
  };
}

async function readFormalFacts(
  executor: Pick<Database, "execute">,
  confirmation: ConfirmationRow,
): Promise<FormalShotPlanFacts> {
  const characters = await executor.execute<CharacterFactRow>(sql`
    SELECT id, draft_key AS key, name, description
    FROM vnext.shot_plan_characters
    WHERE confirmation_id = ${confirmation.id}::uuid ORDER BY created_at, id`);
  const scenes = await executor.execute<SceneFactRow>(sql`
    SELECT id, draft_key AS key, title, summary, position
    FROM vnext.shot_plan_scenes
    WHERE confirmation_id = ${confirmation.id}::uuid ORDER BY position, id`);
  const shots = await executor.execute<ShotFactRow>(sql`
    SELECT id, scene_id AS "sceneId", draft_key AS key, position,
           shot_size AS "shotSize", camera_movement AS "cameraMovement",
           action, rhythm, dialogue, sound
    FROM vnext.shot_plan_shots
    WHERE confirmation_id = ${confirmation.id}::uuid ORDER BY scene_id, position, id`);
  return {
    confirmationId: confirmation.id,
    confirmedAt: toDate(confirmation.confirmed_at),
    characters: characters.rows,
    scenes: scenes.rows,
    shots: shots.rows,
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
