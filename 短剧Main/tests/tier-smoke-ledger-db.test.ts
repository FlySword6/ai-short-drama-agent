import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import {
  reserveTestEnvTierSmokeInPool,
} from "../scripts/fable007-provider-smoke.mjs";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

const databaseUrl = process.env.TIER_SMOKE_LEDGER_TEST_DATABASE_URL;
const schema = process.env.POSTGRES_SCHEMA ?? "";

test("test-env 付费冒烟在 provider POST 前由 PostgreSQL 永久防重", async () => {
  assert.ok(databaseUrl, "runner must provide a disposable PostgreSQL URL");
  assert.match(schema, /^tier_smoke_ledger_[a-z0-9_]+$/u);
  const pool = new Pool({ connectionString: databaseUrl });
  const quotedSchema = quoteIdentifier(schema);
  let providerSubmissions = 0;
  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await pool.query(`CREATE SCHEMA ${quotedSchema}`);
    const migration = await readFile(
      path.resolve("migrations/058_test_env_tier_smoke_ledger.sql"),
      "utf8",
    );
    await pool.query(renderMigrationSql(migration, schema));

    const guardedSubmit = async (): Promise<void> => {
      await reserveTestEnvTierSmokeInPool(
        pool,
        schema,
        "img-seedream5pro-916-1k-1",
        30,
      );
      providerSubmissions += 1;
    };
    const outcomes = await Promise.allSettled([guardedSubmit(), guardedSubmit()]);
    assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
    const rejection = outcomes.find((result) => result.status === "rejected");
    assert.ok(rejection?.status === "rejected");
    assert.match(String(rejection.reason), /ALREADY_RESERVED_OR_COMPLETED/);
    assert.equal(providerSubmissions, 1, "the rejected contender must stop before provider POST");

    const rows = await pool.query<{
      batch_id: string;
      tier_id: string;
      reserved_fen: number;
      status: string;
    }>(
      `SELECT batch_id, tier_id, reserved_fen, status
       FROM ${quotedSchema}.tier_smoke_reservations`,
    );
    assert.deepEqual(rows.rows, [{
      batch_id: "ark-test-env-portrait-image-v1",
      tier_id: "img-seedream5pro-916-1k-1",
      reserved_fen: 30,
      status: "reserved",
    }]);

    await assert.rejects(
      pool.query(
        `INSERT INTO ${quotedSchema}.tier_smoke_reservations (
           reservation_id, batch_id, tier_id, target, reserved_fen, status, reserved_at
         ) VALUES (
           gen_random_uuid(), 'wrong-batch', 'wrong-tier', 'test-env', 31, 'reserved', now()
         )`,
      ),
      /tier_smoke_reservations_approved_batch_check|tier_smoke_reservations_reserved_fen_check/,
    );
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`).catch(() => undefined);
    await pool.end();
  }
});
