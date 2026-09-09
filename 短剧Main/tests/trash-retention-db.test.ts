import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDatabase } from "../src/db/client.js";
import { renderMigrationSql } from "../src/db/migrate.js";
import {
  assetEntities,
  episodes,
  episodeScriptVersions,
  projects,
  projectAssetRefs,
  scenes,
  scriptBreakdownRuns,
  scriptBreakdownRunStages,
  shots,
  trashPurgeAttempts,
  users,
} from "../src/db/schema.js";
import { DrizzleTrashRepository, type TrashExternalCleaner } from "../src/modules/trash/repository.js";
import { TrashRetentionWorker } from "../src/modules/trash/retention.js";
import { TrashService } from "../src/modules/trash/service.js";

const execFileAsync = promisify(execFile);
const POSTGRES_IMAGE = process.env.POSTGRES_IMAGE ?? "postgres:14-alpine";
const retentionDays = 180;
const now = new Date("2026-07-28T12:00:00.000Z");
const old = new Date(now.getTime() - 181 * 24 * 60 * 60 * 1000);
const recent = new Date(now.getTime() - 179 * 24 * 60 * 60 * 1000);

class Cleaner implements TrashExternalCleaner {
  fail = false;
  calls = 0;
  async deleteStoragePath(): Promise<void> { this.calls += 1; if (this.fail) throw new Error("external_delete_failed"); }
  async deleteVectorIds(): Promise<void> { this.calls += 1; if (this.fail) throw new Error("external_delete_failed"); }
}
const logger = { info() {}, warn() {}, error() {} };

test("trash retention: PostgreSQL 14 migration and purge contract", { timeout: 180_000 }, async (context) => {
  const postgres = await startTemporaryPostgres();
  const handle = createDatabase(postgres.databaseUrl);
  context.after(async () => { await handle.pool.end(); await postgres.stop(); });
  await applyRetentionTestMigrations(handle.pool, "app");
  const db = handle.db;
  const owner = randomUUID();
  await db.insert(users).values(user(owner));

  await context.test("未到期对象不进入候选", async () => {
    const id = randomUUID();
    await db.insert(projects).values(project(id, owner, recent));
    const repo = new DrizzleTrashRepository(db);
    assert.equal((await repo.retentionCandidates(new Date(now.getTime() - retentionDays * 86_400_000))).some((x) => x.id === id), false);
  });

  await context.test("游标以 deleted_at,id,kind 全序跨页，不漏同 UUID 同时间的跨类型行", async () => {
    const id = randomUUID();
    await db.insert(projects).values(project(id, owner, old));
    await db.insert(assetEntities).values(asset(id, owner, old));
    const repo = new DrizzleTrashRepository(db);
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const first = await repo.retentionCandidates(cutoff, undefined, 1);
    const second = await repo.retentionCandidates(cutoff, first[0], 1);
    assert.equal(first.length, 1); assert.equal(second.length, 1);
    assert.equal(first[0]!.id, id); assert.equal(second[0]!.id, id);
    assert.notEqual(first[0]!.kind, second[0]!.kind);
  });

  await context.test("到期且无引用的对象删除并有 retention 审计", async () => {
    const id = randomUUID();
    await db.insert(projects).values(project(id, owner, old));
    const result = await worker(db).runOnce(now);
    assert.equal(result.skipped, false);
    assert.equal((await db.select().from(projects).where(eq(projects.id, id))).length, 0);
    await assertAttempt(db, id, "retention", "deleted");
  });

  await context.test("含 P-06 剧本版本和拆解运行的项目可永久删除", async () => {
    const projectId = randomUUID();
    const episodeId = randomUUID();
    const scriptVersionId = randomUUID();
    const breakdownRunId = randomUUID();
    const sceneId = randomUUID();
    const shotId = randomUUID();
    await db.insert(projects).values(project(projectId, owner, old));
    await db.insert(episodes).values({
      id: episodeId,
      projectId,
      episodeNo: 1,
      name: "P-06 回放集",
      sortOrder: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await db.insert(episodeScriptVersions).values({
      id: scriptVersionId,
      episodeId,
      versionNo: 1,
      title: "P-06 剧本",
      scriptText: "第一场：雨夜。",
      scriptSha256: "a".repeat(64),
      source: "manual",
      createdByUserId: owner,
      clientIdempotencyKey: `trash-script-${projectId}`,
      createdAt: now,
    });
    await db.insert(scriptBreakdownRuns).values({
      id: breakdownRunId,
      episodeId,
      scriptVersionId,
      createdByUserId: owner,
      clientIdempotencyKey: `trash-breakdown-${projectId}`,
      requestHash: "b".repeat(64),
      modelName: "test-model",
      promptVersion: "trash-r6",
      status: "draft",
      currentStage: "shots",
      targetDurationSec: 60,
      inputSha256: "c".repeat(64),
      draftJson: {},
      validationJson: { issues: [] },
      usageJson: { call_count: 1, total_input_tokens: 1, total_output_tokens: 1 },
      estimatedCostFen: null,
      actualCostFen: null,
      errorCode: null,
      errorMessage: null,
      confirmedByUserId: null,
      confirmedAt: null,
      discardedByUserId: null,
      discardedAt: null,
      supersededByRunId: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(scriptBreakdownRunStages).values({
      id: randomUUID(),
      runId: breakdownRunId,
      stageKey: "shots",
      stageOrder: 1,
      status: "succeeded",
      attemptCount: 1,
      outputJson: {},
      validationJson: { issues: [] },
      usageJson: { calls: [] },
      errorCode: null,
      errorMessage: null,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(scenes).values({
      id: sceneId,
      episodeId,
      sceneNo: 1,
      name: "雨夜",
      description: null,
      sortOrder: 1,
      sourceBreakdownRunId: breakdownRunId,
      sourceCandidateId: "scene-1",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await db.insert(shots).values({
      id: shotId,
      episodeId,
      sceneId,
      shotCode: "1-1",
      title: "雨中",
      scriptText: "人物走入雨幕。",
      breakdownElements: null,
      directorPrompt: null,
      imagePrompt: null,
      videoPrompt: null,
      durationSeconds: 3,
      sortOrder: 1,
      referenceAssetSnapshots: [],
      sourceBreakdownRunId: breakdownRunId,
      sourceCandidateId: "shot-1",
      selectedImageResultId: null,
      selectedVideoResultId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });

    await new TrashService(new DrizzleTrashRepository(db, new Cleaner()))
      .permanentlyDelete({ actorId: owner, kind: "project", id: projectId });

    assert.equal((await db.select().from(shots).where(eq(shots.id, shotId))).length, 0);
    assert.equal((await db.select().from(scenes).where(eq(scenes.id, sceneId))).length, 0);
    assert.equal((await db.select().from(scriptBreakdownRunStages).where(eq(scriptBreakdownRunStages.runId, breakdownRunId))).length, 0);
    assert.equal((await db.select().from(scriptBreakdownRuns).where(eq(scriptBreakdownRuns.id, breakdownRunId))).length, 0);
    assert.equal((await db.select().from(episodeScriptVersions).where(eq(episodeScriptVersions.id, scriptVersionId))).length, 0);
    assert.equal((await db.select().from(episodes).where(eq(episodes.id, episodeId))).length, 0);
    assert.equal((await db.select().from(projects).where(eq(projects.id, projectId))).length, 0);
    await assertAttempt(db, projectId, "manual", "deleted");
  });

  await context.test("到期有引用的个人资产保留并记录 blocked", async () => {
    const assetId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values(project(projectId, owner, null));
    await db.insert(assetEntities).values(asset(assetId, owner, old));
    await db.insert(projectAssetRefs).values({ id: randomUUID(), projectId, assetEntityId: assetId, assetVariantId: null, assetMediaId: null, versionSnapshot: {}, createdByUserId: owner, createdAt: now, deletedAt: null, deletedByUserId: null });
    await worker(db).runOnce(now);
    assert.equal((await db.select().from(assetEntities).where(eq(assetEntities.id, assetId))).length, 1);
    const [attempt] = await db.select().from(trashPurgeAttempts).where(and(eq(trashPurgeAttempts.targetId, assetId), eq(trashPurgeAttempts.status, "blocked")));
    assert.ok(attempt?.blockers.includes("资产存在项目引用记录"));
  });

  await context.test("两个 worker 竞争时仅一个执行", async () => {
    const id = randomUUID();
    await db.insert(projects).values(project(id, owner, old));
    const [a, b] = await Promise.all([worker(db).runOnce(now), worker(db).runOnce(now)]);
    assert.equal(Number(a.skipped) + Number(b.skipped), 1);
    assert.equal((await db.select().from(trashPurgeAttempts).where(eq(trashPurgeAttempts.targetId, id))).length, 1);
  });

  await context.test("实造前 50 blocker 后，第 51 项仍在下一页被删除", async () => {
    const blockerProject = "eeeeeeee-0000-4000-8000-000000000000";
    await db.insert(projects).values(project(blockerProject, owner, null));
    const ids = Array.from({ length: 50 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    await db.insert(assetEntities).values(ids.map((id) => asset(id, owner, old)));
    await db.insert(projectAssetRefs).values(ids.map((assetEntityId) => ({ id: randomUUID(), projectId: blockerProject, assetEntityId, assetVariantId: null, assetMediaId: null, versionSnapshot: {}, createdByUserId: owner, createdAt: now, deletedAt: null, deletedByUserId: null })));
    const survivor = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insert(projects).values(project(survivor, owner, old));
    await worker(db).runOnce(now);
    assert.equal((await db.select().from(projects).where(eq(projects.id, survivor))).length, 0);
    assert.equal((await db.select().from(assetEntities).where(eq(assetEntities.id, ids[0]!))).length, 1);
    // These 50 rows intentionally survive this case. Move them outside the
    // retention window so later subtests do not repeatedly reprocess this
    // case's fixtures and inherit its workload.
    await db.update(assetEntities).set({ deletedAt: recent }).where(inArray(assetEntities.id, ids));
  });

  await context.test("外部失败不 hard delete 且审计 failed", async () => {
    const id = randomUUID();
    await db.insert(assetEntities).values(asset(id, owner, old));
    const cleaner = new Cleaner(); cleaner.fail = true;
    await worker(db, cleaner).runOnce(now);
    assert.equal((await db.select().from(assetEntities).where(eq(assetEntities.id, id))).length, 1);
    await assertAttempt(db, id, "retention", "failed");
  });

  await context.test("手动永久删除使用同一审计", async () => {
    const id = randomUUID();
    await db.insert(assetEntities).values(asset(id, owner, old));
    await new TrashService(new DrizzleTrashRepository(db, new Cleaner())).permanentlyDelete({ actorId: owner, kind: "asset", id });
    await assertAttempt(db, id, "manual", "deleted");
  });

  await context.test("prepare 持有对象锁时 restore 等待，提交 purging 后恢复被拒", async () => {
    const id = randomUUID();
    await db.insert(assetEntities).values(asset(id, owner, old));
    const prepareClient = await handle.pool.connect();
    try {
      await prepareClient.query("begin");
      await prepareClient.query("select pg_advisory_xact_lock(hashtext($1))", [`trash:asset:${id}`]);
      await prepareClient.query("update app.asset_entities set status = 'purging' where id = $1", [id]);

      let restoreSettled = false;
      const restore = new TrashService(new DrizzleTrashRepository(db, new Cleaner()))
        .restore({ actorId: owner, kind: "asset", id })
        .finally(() => { restoreSettled = true; });

      // Prove the competing connection is waiting on our advisory lock before
      // releasing prepare. The old restore path waited on a row/transaction
      // lock instead, so a timing-only assertion could pass against the bug.
      await waitForAdvisoryWait(handle.pool);
      assert.equal(restoreSettled, false);

      await prepareClient.query("commit");
      await assert.rejects(restore, (error: unknown) => {
        assert.equal((error as { code?: string }).code, "asset_purge_in_progress");
        return true;
      });
    } finally {
      await prepareClient.query("rollback").catch(() => undefined);
      prepareClient.release();
    }
  });

  await context.test("prepare 抛错收敛为 failed，审计终态写失败会回滚 hard delete", async () => {
    const prepareId = randomUUID();
    await db.insert(assetEntities).values(asset(prepareId, owner, old));
    class ThrowingRepository extends DrizzleTrashRepository { override async preparePermanentDeletion() { throw new Error("prepare_fault"); } }
    await assert.rejects(new TrashService(new ThrowingRepository(db)).permanentlyDelete({ actorId: owner, kind: "asset", id: prepareId }), /prepare_fault/);
    await assertAttempt(db, prepareId, "manual", "failed");
    const rollbackId = randomUUID();
    await db.insert(assetEntities).values(asset(rollbackId, owner, old));
    await db.execute(sql`create or replace function app.reject_deleted_trash_attempt() returns trigger language plpgsql as $$ begin if new.status = 'deleted' then raise exception 'audit_deleted_fault'; end if; return new; end $$`);
    await db.execute(sql`create trigger reject_deleted_trash_attempt before update on app.trash_purge_attempts for each row execute function app.reject_deleted_trash_attempt()`);
    await assert.rejects(new TrashService(new DrizzleTrashRepository(db, new Cleaner())).permanentlyDelete({ actorId: owner, kind: "asset", id: rollbackId }), (error: unknown) => {
      assert.match(String((error as { cause?: { message?: string } }).cause?.message), /audit_deleted_fault/); return true;
    });
    assert.equal((await db.select().from(assetEntities).where(eq(assetEntities.id, rollbackId))).length, 1);
    await assertAttempt(db, rollbackId, "manual", "failed");
    await db.execute(sql`drop trigger reject_deleted_trash_attempt on app.trash_purge_attempts`);
  });
});

function worker(db: ReturnType<typeof createDatabase>["db"], cleaner = new Cleaner()) {
  return new TrashRetentionWorker(db, logger, retentionDays, (sessionDb) => new DrizzleTrashRepository(sessionDb, cleaner));
}
async function assertAttempt(db: ReturnType<typeof createDatabase>["db"], id: string, source: "manual" | "retention", status: "deleted" | "failed") {
  const [attempt] = await db.select().from(trashPurgeAttempts).where(and(eq(trashPurgeAttempts.targetId, id), eq(trashPurgeAttempts.source, source)));
  assert.equal(attempt?.status, status); assert.ok(attempt?.completedAt);
}
function user(id: string) { return { id, username: `ttl-${id.slice(0, 8)}`, displayName: "TTL", passwordHash: "test", active: true, createdAt: now, updatedAt: now }; }
function project(id: string, ownerUserId: string, deletedAt: Date | null) { return { id, ownerUserId, teamId: null, genre: null, name: `project-${id}`, description: null, status: "active", createdAt: now, updatedAt: now, deletedAt, deletedByUserId: deletedAt ? ownerUserId : null }; }
function asset(id: string, ownerUserId: string, deletedAt: Date) { return { id, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId, visibility: "personal", assetKind: "character", role: "character_identity", usageMode: "reference", name: `asset-${id}`, displayName: null, intro: null, appearance: null, ageValue: null, gender: null, heightCm: null, hairDescription: null, outfitDescription: null, category: null, styleTags: [], approved: true, reuseScope: "all_projects", status: "approved", sourceFileUrl: null, metadata: {}, clearance: { search: true, gen_reference: true, commercial_publish: false, model_training: false }, searchText: "", createdAt: now, updatedAt: now, useCount: 0, deletedAt, deletedByUserId: ownerUserId }; }

async function waitForAdvisoryWait(pool: ReturnType<typeof createDatabase>["pool"]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ waiting: number }>(`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database()
        and state = 'active'
        and wait_event = 'advisory'
    `);
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("restore did not enter PostgreSQL advisory-lock wait");
}

async function applyRetentionTestMigrations(pool: ReturnType<typeof createDatabase>["pool"], schema: string) {
  const client = await pool.connect();
  try {
    await client.query(`create schema ${schema}`);
    // 2026-08-02 Fable 集成修复:trash 迁移由 040 重编 044(号段撞车),白名单正则改全量——
    // 本测试断言的是「当前全量 schema 下的 purge 契约」,新迁移应自动纳入而非停在写死号段。
    const files = (await readdir("migrations")).filter((file) => /^\d{3}_.*\.sql$/.test(file)).sort();
    for (const file of files) await client.query(renderMigrationSql(await readFile(`migrations/${file}`, "utf8"), schema));
  } finally { client.release(); }
}
interface TemporaryPostgres { databaseUrl: string; stop(): Promise<void>; }
async function startTemporaryPostgres(): Promise<TemporaryPostgres> {
  const name = `trash-ttl-${process.pid}-${randomUUID().slice(0, 8)}`, password = "ttl-test", database = "trash_ttl";
  await docker(["run", "-d", "--rm", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-e", `POSTGRES_DB=${database}`, "--tmpfs", "/var/lib/postgresql/data:rw,size=512m", "-p", "127.0.0.1::5432", POSTGRES_IMAGE]);
  for (let n = 0; n < 60; n += 1) { if ((await dockerResult(["exec", name, "psql", "-U", "postgres", "-d", database, "-tAc", "select 1"])).stdout.trim() === "1") break; await new Promise((r) => setTimeout(r, 250)); }
  await docker(["exec", name, "psql", "-U", "postgres", "-d", database, "-c", "create extension if not exists pg_trgm"]);
  const port = /:(\d+)\s*$/.exec(await docker(["port", name, "5432/tcp"]))?.[1]; if (!port) throw new Error("postgres port unavailable");
  return { databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}`, stop: async () => { await dockerResult(["rm", "-f", name]); } };
}
async function docker(args: string[]): Promise<string> { return (await execFileAsync("docker", args, { encoding: "utf8" })).stdout; }
async function dockerResult(args: string[]) { try { return { stdout: await docker(args) }; } catch (error) { return { stdout: (error as { stdout?: string }).stdout ?? "" }; } }
