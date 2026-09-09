import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import { ConflictError } from "../../../shared/errors.js";
import type { StoryboardBoard, StoryboardCell, StoryboardCellVersion } from "./types.js";

interface BoardRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  confirmation_id: string;
  version: number;
  source_kind: "shot_plan" | "redraw";
  base_board_id: string | null;
  redrawn_cell_id: string | null;
  redrawn_cell_version_id: string | null;
  created_at: Date | string;
}

interface CellRow extends Record<string, unknown> {
  cell_id: string;
  shot_id: string;
  position: number;
  version_id: string;
  version: number;
  prompt: string;
  source: Record<string, unknown>;
  media_url: string;
  media_sha256: string;
  provider: string;
  model: string;
  billing_receipt_id: string;
  created_at: Date | string;
}

interface ShotRow extends Record<string, unknown> {
  id: string;
  board_position: number;
  shot_size: string;
  camera_movement: string;
  action: string;
  rhythm: string;
  dialogue: string;
  sound: string;
}

interface ImageReceipt {
  mediaUrl: string;
  mediaSha256: string;
  provider: string;
  model: string;
  billingReceiptId: string;
}

const boardColumns = sql.raw("id, project_id, confirmation_id, version, source_kind, base_board_id, redrawn_cell_id, redrawn_cell_version_id, created_at");

export class StoryboardRepository {
  constructor(private readonly db: Database) {}

  async latest(projectId: string, confirmationId?: string): Promise<StoryboardBoard | null> {
    const board = confirmationId
      ? await this.db.execute<BoardRow>(sql`SELECT ${boardColumns} FROM vnext.storyboard_boards WHERE project_id = ${projectId}::uuid AND confirmation_id = ${confirmationId}::uuid ORDER BY version DESC LIMIT 1`)
      : await this.db.execute<BoardRow>(sql`SELECT ${boardColumns} FROM vnext.storyboard_boards WHERE project_id = ${projectId}::uuid ORDER BY version DESC LIMIT 1`);
    return board.rows[0] ? this.readBoard(this.db, board.rows[0]) : null;
  }

  async createInitial(input: {
    projectId: string;
    confirmationId: string;
    actorId: string;
    key: string;
    generate: (cellId: string, prompt: string, source: Record<string, unknown>) => Promise<ImageReceipt>;
  }): Promise<{ board: StoryboardBoard; created: boolean }> {
    const keyed = await this.boardByKey(this.db, input.projectId, input.key);
    if (keyed) return this.initialReplay(this.db, keyed, input.confirmationId);

    const existing = await this.initialBoard(this.db, input.projectId, input.confirmationId);
    if (existing) return { board: await this.readBoard(this.db, existing), created: false };

    const shots = await this.db.execute<ShotRow>(sql`
      SELECT s.id, ROW_NUMBER() OVER (ORDER BY sc.position, s.position, s.id) - 1 AS board_position,
             s.shot_size, s.camera_movement, s.action, s.rhythm, s.dialogue, s.sound
      FROM vnext.shot_plan_shots s
      JOIN vnext.shot_plan_scenes sc ON sc.id = s.scene_id
      WHERE s.project_id = ${input.projectId}::uuid AND s.confirmation_id = ${input.confirmationId}::uuid
      ORDER BY sc.position, s.position, s.id`);
    if (!shots.rows.length) throw new Error("Confirmed shot plan has no shots");

    // Each paid success commits independently. If a later cell fails, retry reuses
    // the committed version and dispatches only the missing cell.
    const composition: Array<{ cell_id: string; cell_version_id: string }> = [];
    for (const shot of shots.rows) {
      const item = await this.ensureInitialCellVersion(input, shot);
      composition.push({ cell_id: item.cellId, cell_version_id: item.versionId });
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 0))`);
      const keyedReplay = await this.boardByKey(tx, input.projectId, input.key);
      if (keyedReplay) return this.initialReplay(tx, keyedReplay, input.confirmationId);
      const replay = await this.initialBoard(tx, input.projectId, input.confirmationId);
      if (replay) return { board: await this.readBoard(tx, replay), created: false };

      const latest = await tx.execute<{ version: number }>(sql`SELECT COALESCE(MAX(version), 0)::integer AS version FROM vnext.storyboard_boards WHERE project_id = ${input.projectId}::uuid`);
      const boardId = randomUUID();
      const inserted = await tx.execute<BoardRow>(sql`
        INSERT INTO vnext.storyboard_boards (
          id, project_id, confirmation_id, version, source_kind, composition,
          created_by_user_id, client_idempotency_key
        ) VALUES (
          ${boardId}::uuid, ${input.projectId}::uuid, ${input.confirmationId}::uuid,
          ${(latest.rows[0]?.version ?? 0) + 1}, 'shot_plan', ${JSON.stringify(composition)}::jsonb,
          ${input.actorId}::uuid, ${input.key}
        ) RETURNING ${boardColumns}`);
      return { board: await this.readBoard(tx, inserted.rows[0]!), created: true };
    });
  }

  async redraw(input: {
    projectId: string;
    confirmationId: string;
    cellId: string;
    actorId: string;
    key: string;
    prompt: string;
    generate: (source: Record<string, unknown>) => Promise<ImageReceipt>;
  }): Promise<{ board: StoryboardBoard; created: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.projectId}, 0))`);
      const replay = await this.boardByKey(tx, input.projectId, input.key);
      if (replay) {
        if (replay.confirmation_id !== input.confirmationId || replay.source_kind !== "redraw" || replay.redrawn_cell_id !== input.cellId) {
          throw idempotencyConflict();
        }
        return { board: await this.readBoard(tx, replay), created: false };
      }
      const previousResult = await tx.execute<BoardRow>(sql`
        SELECT ${boardColumns} FROM vnext.storyboard_boards
        WHERE project_id = ${input.projectId}::uuid AND confirmation_id = ${input.confirmationId}::uuid
        ORDER BY version DESC LIMIT 1`);
      const previous = previousResult.rows[0];
      if (!previous) throw new Error("Storyboard board does not exist");
      const cells = await this.cellsForBoard(tx, previous.id);
      const target = cells.find((cell) => cell.id === input.cellId);
      if (!target) throw new Error("Storyboard cell is not part of the current board");

      const image = await input.generate(target.version.source);
      const versionId = randomUUID();
      const nextVersion = target.version.version + 1;
      await tx.execute(sql`
        INSERT INTO vnext.storyboard_cell_versions (
          id, cell_id, project_id, version, prompt, source, media_url, media_sha256,
          provider, model, billing_receipt_id, created_by_user_id, client_idempotency_key
        ) VALUES (
          ${versionId}::uuid, ${target.id}::uuid, ${input.projectId}::uuid, ${nextVersion},
          ${input.prompt}, ${JSON.stringify(target.version.source)}::jsonb, ${image.mediaUrl},
          ${image.mediaSha256}, ${image.provider}, ${image.model}, ${image.billingReceiptId},
          ${input.actorId}::uuid, ${input.key}
        )`);

      const composition = cells.map((cell) => ({
        cell_id: cell.id,
        cell_version_id: cell.id === input.cellId ? versionId : cell.version.id,
      }));
      const boardId = randomUUID();
      const inserted = await tx.execute<BoardRow>(sql`
        INSERT INTO vnext.storyboard_boards (
          id, project_id, confirmation_id, version, source_kind, base_board_id,
          redrawn_cell_id, redrawn_cell_version_id, composition, created_by_user_id,
          client_idempotency_key
        ) VALUES (
          ${boardId}::uuid, ${input.projectId}::uuid, ${previous.confirmation_id}::uuid,
          ${previous.version + 1}, 'redraw', ${previous.id}::uuid, ${input.cellId}::uuid,
          ${versionId}::uuid, ${JSON.stringify(composition)}::jsonb, ${input.actorId}::uuid,
          ${input.key}
        ) RETURNING ${boardColumns}`);
      return { board: await this.readBoard(tx, inserted.rows[0]!), created: true };
    });
  }

  private async ensureInitialCellVersion(input: {
    projectId: string;
    confirmationId: string;
    actorId: string;
    key: string;
    generate: (cellId: string, prompt: string, source: Record<string, unknown>) => Promise<ImageReceipt>;
  }, shot: ShotRow): Promise<{ cellId: string; versionId: string }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.confirmationId}:${shot.id}`}, 0))`);
      const found = await tx.execute<{ id: string }>(sql`SELECT id FROM vnext.storyboard_cells WHERE confirmation_id = ${input.confirmationId}::uuid AND shot_id = ${shot.id}::uuid`);
      const cellId = found.rows[0]?.id ?? randomUUID();
      if (!found.rows[0]) {
        await tx.execute(sql`
          INSERT INTO vnext.storyboard_cells (
            id, project_id, confirmation_id, shot_id, position, created_by_user_id,
            client_idempotency_key
          ) VALUES (
            ${cellId}::uuid, ${input.projectId}::uuid, ${input.confirmationId}::uuid,
            ${shot.id}::uuid, ${shot.board_position}, ${input.actorId}::uuid, ${`cell:${shot.id}`}
          )`);
      }
      const existing = await tx.execute<{ id: string }>(sql`SELECT id FROM vnext.storyboard_cell_versions WHERE cell_id = ${cellId}::uuid AND version = 1`);
      if (existing.rows[0]) return { cellId, versionId: existing.rows[0].id };

      const source = shotSource(shot);
      const prompt = promptForShot(shot);
      const image = await input.generate(cellId, prompt, source);
      const versionId = randomUUID();
      await tx.execute(sql`
        INSERT INTO vnext.storyboard_cell_versions (
          id, cell_id, project_id, version, prompt, source, media_url, media_sha256,
          provider, model, billing_receipt_id, created_by_user_id, client_idempotency_key
        ) VALUES (
          ${versionId}::uuid, ${cellId}::uuid, ${input.projectId}::uuid, 1, ${prompt},
          ${JSON.stringify(source)}::jsonb, ${image.mediaUrl}, ${image.mediaSha256},
          ${image.provider}, ${image.model}, ${image.billingReceiptId}, ${input.actorId}::uuid,
          ${`initial:${input.confirmationId}`}
        )`);
      return { cellId, versionId };
    });
  }

  private async boardByKey(executor: Pick<Database, "execute">, projectId: string, key: string): Promise<BoardRow | null> {
    const result = await executor.execute<BoardRow>(sql`SELECT ${boardColumns} FROM vnext.storyboard_boards WHERE project_id = ${projectId}::uuid AND client_idempotency_key = ${key}`);
    return result.rows[0] ?? null;
  }

  private async initialBoard(executor: Pick<Database, "execute">, projectId: string, confirmationId: string): Promise<BoardRow | null> {
    const result = await executor.execute<BoardRow>(sql`SELECT ${boardColumns} FROM vnext.storyboard_boards WHERE project_id = ${projectId}::uuid AND confirmation_id = ${confirmationId}::uuid AND source_kind = 'shot_plan' ORDER BY version DESC LIMIT 1`);
    return result.rows[0] ?? null;
  }

  private async initialReplay(executor: Pick<Database, "execute">, board: BoardRow, confirmationId: string): Promise<{ board: StoryboardBoard; created: false }> {
    if (board.confirmation_id !== confirmationId || board.source_kind !== "shot_plan") throw idempotencyConflict();
    return { board: await this.readBoard(executor, board), created: false };
  }

  private async readBoard(executor: Pick<Database, "execute">, row: BoardRow): Promise<StoryboardBoard> {
    return {
      id: row.id,
      projectId: row.project_id,
      confirmationId: row.confirmation_id,
      version: row.version,
      sourceKind: row.source_kind,
      baseBoardId: row.base_board_id,
      redrawnCellId: row.redrawn_cell_id,
      redrawnCellVersionId: row.redrawn_cell_version_id,
      cells: await this.cellsForBoard(executor, row.id),
      createdAt: date(row.created_at),
    };
  }

  private async cellsForBoard(executor: Pick<Database, "execute">, boardId: string): Promise<StoryboardCell[]> {
    const rows = await executor.execute<CellRow>(sql`
      SELECT c.id AS cell_id, c.shot_id, c.position, v.id AS version_id, v.version,
             v.prompt, v.source, v.media_url, v.media_sha256, v.provider, v.model,
             v.billing_receipt_id, v.created_at
      FROM vnext.storyboard_boards b
      CROSS JOIN LATERAL jsonb_array_elements(b.composition) WITH ORDINALITY AS item(value, ordinality)
      JOIN vnext.storyboard_cells c ON c.id = (item.value->>'cell_id')::uuid
      JOIN vnext.storyboard_cell_versions v ON v.id = (item.value->>'cell_version_id')::uuid
      WHERE b.id = ${boardId}::uuid
      ORDER BY item.ordinality`);
    return rows.rows.map((row) => ({
      id: row.cell_id,
      shotId: row.shot_id,
      position: row.position,
      version: toVersion(row),
    }));
  }
}

function toVersion(row: CellRow): StoryboardCellVersion {
  return {
    id: row.version_id,
    cellId: row.cell_id,
    version: row.version,
    prompt: row.prompt,
    source: row.source,
    mediaUrl: row.media_url,
    mediaSha256: row.media_sha256,
    provider: row.provider,
    model: row.model,
    billingReceiptId: row.billing_receipt_id,
    createdAt: date(row.created_at),
  };
}

function idempotencyConflict(): ConflictError {
  return new ConflictError("幂等键已用于另一项故事板操作", "storyboard_idempotency_conflict");
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function shotSource(shot: ShotRow): Record<string, unknown> {
  return {
    shot_id: shot.id,
    position: shot.board_position,
    camera_movement: shot.camera_movement,
    action: shot.action,
    rhythm: shot.rhythm,
    dialogue: shot.dialogue,
    sound: shot.sound,
  };
}

function promptForShot(shot: ShotRow): string {
  return `${shot.shot_size}; ${shot.camera_movement}; ${shot.action}; ${shot.rhythm}; dialogue: ${shot.dialogue}; sound: ${shot.sound}`;
}
