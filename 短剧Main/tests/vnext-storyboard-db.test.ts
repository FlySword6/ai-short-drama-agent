import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import { runVnextMigrations } from "../src/db/migrate.js";
import { StoryboardRepository } from "../src/modules/vnext/storyboard/repository.js";

const databaseUrl = process.env.VNEXT_STORYBOARD_TEST_DATABASE_URL;

test("storyboard PostgreSQL preserves paid successes, immutable cells, board lineage, replay, and failed redraw rollback", { skip: !databaseUrl }, async () => {
  const handle = createDatabase(databaseUrl!);
  const projectId = randomUUID(); const confirmationId = randomUUID(); const actorId = randomUUID();
  try {
    await runVnextMigrations(handle.pool);
    await handle.db.execute(sql`INSERT INTO vnext.projects (id, name, owner_user_id) VALUES (${projectId}::uuid, 'storyboard db test', ${actorId}::uuid)`);
    const runId = randomUUID();
    await handle.db.execute(sql`INSERT INTO vnext.script_sources (id, project_id, source_kind, script_content, content_sha256, created_by_user_id) VALUES (${randomUUID()}::uuid, ${projectId}::uuid, 'paste', 'fixture', ${"0".repeat(64)}, ${actorId}::uuid)`);
    const source = await handle.db.execute<{ id: string }>(sql`SELECT id FROM vnext.script_sources WHERE project_id = ${projectId}::uuid LIMIT 1`);
    await handle.db.execute(sql`INSERT INTO vnext.script_parse_runs (id, project_id, source_id, client_idempotency_key, status, progress, current_stage, draft, created_by_user_id) VALUES (${runId}::uuid, ${projectId}::uuid, ${source.rows[0]!.id}::uuid, 'run', 'confirmed', 100, 'confirmed', '{}'::jsonb, ${actorId}::uuid)`);
    await handle.db.execute(sql`INSERT INTO vnext.script_confirmations (id, project_id, run_id, client_idempotency_key, confirmed_by_user_id) VALUES (${confirmationId}::uuid, ${projectId}::uuid, ${runId}::uuid, 'confirm', ${actorId}::uuid)`);
    const sceneId = randomUUID();
    await handle.db.execute(sql`INSERT INTO vnext.shot_plan_scenes (id, project_id, confirmation_id, draft_key, title, summary, position) VALUES (${sceneId}::uuid, ${projectId}::uuid, ${confirmationId}::uuid, 'scene', 'scene', 'summary', 0)`);
    for (const position of [0, 1]) await handle.db.execute(sql`INSERT INTO vnext.shot_plan_shots (id, project_id, confirmation_id, scene_id, draft_key, position, shot_size, camera_movement, action, rhythm, dialogue, sound) VALUES (${randomUUID()}::uuid, ${projectId}::uuid, ${confirmationId}::uuid, ${sceneId}::uuid, ${`shot-${position}`}, ${position}, 'wide', 'static', 'action', 'slow', 'dialogue', 'sound')`);
    const secondSceneId = randomUUID();
    await handle.db.execute(sql`INSERT INTO vnext.shot_plan_scenes (id, project_id, confirmation_id, draft_key, title, summary, position) VALUES (${secondSceneId}::uuid, ${projectId}::uuid, ${confirmationId}::uuid, 'scene-2', 'scene two', 'summary two', 1)`);
    await handle.db.execute(sql`INSERT INTO vnext.shot_plan_shots (id, project_id, confirmation_id, scene_id, draft_key, position, shot_size, camera_movement, action, rhythm, dialogue, sound) VALUES (${randomUUID()}::uuid, ${projectId}::uuid, ${confirmationId}::uuid, ${secondSceneId}::uuid, 'shot-next-scene', 0, 'wide', 'static', 'action', 'slow', 'dialogue', 'sound')`);
    const repository = new StoryboardRepository(handle.db);
    let calls = 0;
    await assert.rejects(repository.createInitial({ projectId, confirmationId, actorId, key: 'initial', generate: async (cellId, prompt) => {
      calls += 1;
      if (calls === 2) throw new Error('second image failed');
      return { mediaUrl: `https://cdn.example/${cellId}`, mediaSha256: '1'.repeat(64), provider: 'test', model: prompt, billingReceiptId: 'receipt-1' };
    } }), /second image failed/);
    assert.equal(await repository.latest(projectId), null);
    const preserved = await handle.db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM vnext.storyboard_cell_versions WHERE project_id = ${projectId}::uuid`);
    assert.equal(preserved.rows[0]?.count, '1');
    let resumedCalls = 0;
    const first = await repository.createInitial({ projectId, confirmationId, actorId, key: 'initial', generate: async (cellId, prompt) => {
      resumedCalls += 1;
      return { mediaUrl: `https://cdn.example/${cellId}`, mediaSha256: '2'.repeat(64), provider: 'test', model: prompt, billingReceiptId: 'receipt-2' };
    } });
    assert.equal(resumedCalls, 2);
    assert.equal(first.created, true); assert.equal(first.board.cells.length, 3);
    assert.deepEqual(first.board.cells.map((cell) => cell.position), [0, 1, 2]);
    const replay = await repository.createInitial({ projectId, confirmationId, actorId, key: 'initial', generate: async () => { throw new Error('provider must not be called for replay'); } });
    assert.equal(replay.created, false); assert.equal(replay.board.id, first.board.id);
    const otherRunId = randomUUID();
    const otherConfirmationId = randomUUID();
    await handle.db.execute(sql`INSERT INTO vnext.script_parse_runs (id, project_id, source_id, client_idempotency_key, status, progress, current_stage, draft, created_by_user_id) VALUES (${otherRunId}::uuid, ${projectId}::uuid, ${source.rows[0]!.id}::uuid, 'other-run', 'confirmed', 100, 'confirmed', '{}'::jsonb, ${actorId}::uuid)`);
    await handle.db.execute(sql`INSERT INTO vnext.script_confirmations (id, project_id, run_id, client_idempotency_key, confirmed_by_user_id) VALUES (${otherConfirmationId}::uuid, ${projectId}::uuid, ${otherRunId}::uuid, 'other-confirm', ${actorId}::uuid)`);
    assert.equal(await repository.latest(projectId, otherConfirmationId), null);
    const untouched = first.board.cells[1]!;
    const redrawn = await repository.redraw({ projectId, confirmationId, cellId: first.board.cells[0]!.id, actorId, key: 'redraw', prompt: 'new prompt', generate: async () => ({ mediaUrl: 'https://cdn.example/new', mediaSha256: 'f'.repeat(64), provider: 'test', model: 'new', billingReceiptId: 'receipt-redraw' }) });
    assert.equal(redrawn.board.version, 2); assert.equal(redrawn.board.baseBoardId, first.board.id);
    assert.equal(redrawn.board.cells[1]!.id, untouched.id); assert.equal(redrawn.board.cells[1]!.version.id, untouched.version.id); assert.equal(redrawn.board.cells[1]!.version.mediaSha256, untouched.version.mediaSha256);
    await assert.rejects(repository.redraw({ projectId, confirmationId, cellId: first.board.cells[0]!.id, actorId, key: 'fails', prompt: 'fail', generate: async () => { throw new Error('provider down'); } }), /provider down/);
    const latest = await repository.latest(projectId); assert.equal(latest?.version, 2);
    await assert.rejects(handle.db.execute(sql`UPDATE vnext.storyboard_cell_versions SET prompt = 'mutated' WHERE id = ${redrawn.board.cells[0]!.version.id}::uuid`), /append-only|Failed query/);
  } finally { await handle.pool.end(); }
});
