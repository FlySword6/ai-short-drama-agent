import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getTableColumns } from "drizzle-orm";
import { renderMigrationSql } from "../../db/migrate.js";
import { videoIngestTasks } from "../../db/schema.js";

test("066 video ingest migration creates queue table and retry guards", async () => {
  const source = await readFile(path.resolve("migrations/066_video_ingest_tasks.sql"), "utf8");
  const rendered = renderMigrationSql(source, "common_test");
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "common_test"\.video_ingest_tasks/);
  assert.match(rendered, /status IN \('queued', 'processing', 'succeeded', 'failed'\)/);
  assert.match(rendered, /video_ingest_tasks_active_media_unique/);
  assert.match(rendered, /video_ingest_tasks_success_dedupe_unique/);
});

test("066 ledger matches the migration and Drizzle exposes the expected queue fields", async () => {
  const [source, ledgerSource] = await Promise.all([
    readFile(path.resolve("migrations/066_video_ingest_tasks.sql"), "utf8"),
    readFile(path.resolve("migrations/ledger.json"), "utf8"),
  ]);
  const ledger = JSON.parse(ledgerSource) as { checksums: Record<string, string> };

  assert.equal(
    ledger.checksums["066_video_ingest_tasks.sql"],
    createHash("sha256").update(source.replace(/\r\n?/g, "\n")).digest("hex"),
  );
  assert.deepEqual(Object.keys(getTableColumns(videoIngestTasks)).sort(), [
    "actorUserId", "assetEntityId", "assetMediaId", "attemptCount", "completedAt", "createdAt",
    "errorCode", "errorMessage", "id", "normalizedResult", "operatorId", "operatorTaskId",
    "operatorVersion", "queryHash", "rawResult", "sourceVideoBucket", "sourceVideoPath", "startedAt",
    "status", "taskTemplate", "updatedAt",
  ]);
});
