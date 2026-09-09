import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.AUDIO_PRICING_SEED_TEST_DATABASE_URL;
const schema = process.env.POSTGRES_SCHEMA;
const source = "seed:r154:seed-audio-pricing";

test("audio 售价档在完整迁移库首次播种并可幂等重放", { timeout: 180_000 }, async () => {
  assert.ok(databaseUrl, "audio pricing seed runner must provide a disposable PostgreSQL URL");
  assert.match(databaseUrl, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\//);
  assert.ok(schema);
  assert.match(schema, /^audio_pricing_seed_[a-z0-9_]+$/);

  const handle = createDatabase(databaseUrl);
  const quoted = quoteIdentifier(schema);
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    await applyMigrations(handle, schema);

    const first = await runSeedCli(databaseUrl, schema);
    assert.match(first.stdout, /\[APPLY\].*目标行 126 个档位/);
    assert.match(first.stdout, /已插入 56 个档位/);
    const afterFirst = await readAudioRows(handle, quoted);
    assert.deepEqual(afterFirst.map(publicFields), [
      {
        id: "00000000-5580-4000-8000-000000000031",
        provider: "openspeech",
        model: "seed-audio-1.0",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-32k-mp3-3s",
        duration_seconds: 3,
      },
      {
        id: "00000000-5580-4000-8000-000000000032",
        provider: "openspeech",
        model: "seed-audio-1.0",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-32k-mp3-10s",
        duration_seconds: 10,
      },
      {
        id: "00000000-5580-4000-8000-000000000033",
        provider: "openspeech",
        model: "seed-audio-1.0",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-32k-wav-3s",
        duration_seconds: 3,
      },
      {
        id: "00000000-5580-4000-8000-000000000034",
        provider: "openspeech",
        model: "seed-audio-1.0",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-32k-wav-10s",
        duration_seconds: 10,
      },
      {
        id: "00000000-5580-4000-8000-000000000029",
        provider: "openspeech",
        model: "seed-audio-1.0",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-3s",
        duration_seconds: 3,
      },
      {
        id: "00000000-5580-4000-8000-000000000035",
        provider: "openspeech",
        model: "seed-audio-1.0",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-48k-mp3-10s",
        duration_seconds: 10,
      },
      {
        id: "00000000-5580-4000-8000-000000000036",
        provider: "openspeech",
        model: "seed-audio-1.0",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-48k-wav-3s",
        duration_seconds: 3,
      },
      {
        id: "00000000-5580-4000-8000-000000000037",
        provider: "openspeech",
        model: "seed-audio-1.0",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-48k-wav-10s",
        duration_seconds: 10,
      },
      {
        id: "00000000-5580-4000-8000-000000000038",
        provider: "openspeech",
        model: "seed-audio-1.0-multilingual",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-multilingual-32k-mp3-3s",
        duration_seconds: 3,
      },
      {
        id: "00000000-5580-4000-8000-000000000039",
        provider: "openspeech",
        model: "seed-audio-1.0-multilingual",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-multilingual-32k-mp3-10s",
        duration_seconds: 10,
      },
      {
        id: "00000000-5580-4000-8000-000000000040",
        provider: "openspeech",
        model: "seed-audio-1.0-multilingual",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-multilingual-32k-wav-3s",
        duration_seconds: 3,
      },
      {
        id: "00000000-5580-4000-8000-000000000041",
        provider: "openspeech",
        model: "seed-audio-1.0-multilingual",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-multilingual-32k-wav-10s",
        duration_seconds: 10,
      },
      {
        id: "00000000-5580-4000-8000-000000000030",
        provider: "openspeech",
        model: "seed-audio-1.0-multilingual",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-multilingual-3s",
        duration_seconds: 3,
      },
      {
        id: "00000000-5580-4000-8000-000000000042",
        provider: "openspeech",
        model: "seed-audio-1.0-multilingual",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-multilingual-48k-mp3-10s",
        duration_seconds: 10,
      },
      {
        id: "00000000-5580-4000-8000-000000000043",
        provider: "openspeech",
        model: "seed-audio-1.0-multilingual",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-multilingual-48k-wav-3s",
        duration_seconds: 3,
      },
      {
        id: "00000000-5580-4000-8000-000000000044",
        provider: "openspeech",
        model: "seed-audio-1.0-multilingual",
        media_kind: "audio",
        billing_unit: "second",
        unit_price_fen: 3,
        active: true,
        tier_id: "aud-seedaudio10-multilingual-48k-wav-10s",
        duration_seconds: 10,
      },
    ]);

    const second = await runSeedCli(databaseUrl, schema);
    assert.match(second.stdout, /无需写入:所有档位均已存在且一致/);
    assert.deepEqual(await readAudioRows(handle, quoted), afterFirst, "重放不得新增、改价或刷新时间戳");
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

test("057 拒绝缺字段或多字段的既有图片档，不把残缺行留在可报价目录", { timeout: 180_000 }, async () => {
  assert.ok(databaseUrl, "audio pricing seed runner must provide a disposable PostgreSQL URL");
  assert.ok(schema);

  for (const [suffix, capabilityTier] of [
    ["missing", {
      tier_id: "img-suchuang-gptimage2-auto-1",
      params: { aspect_ratio: "auto", quantity: 1 },
      display_name: "auto，按 1 张计价；这不是模型能力上限",
    }],
    ["extra", {
      tier_id: "img-suchuang-gptimage2-auto-1",
      params: { aspect_ratio: "auto", quantity: 1, undocumented: true },
      status: "active",
      display_name: "auto，按 1 张计价；这不是模型能力上限",
      provider_label: "公司图片网关",
      model_label: "GPT Image 2",
      capabilities: ["text_to_image", "image_reference", "platform_aigc_metadata"],
      official_price_source: "https://api.wuyinkeji.com/doc/53",
    }],
  ] as const) {
    const driftSchema = `${schema}_${suffix}`;
    const handle = createDatabase(databaseUrl);
    const quoted = quoteIdentifier(driftSchema);
    try {
      await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
      await handle.pool.query(`CREATE SCHEMA ${quoted}`);
      await applyMigrations(handle, driftSchema, "055_suchuang_image_provider_cost_basis.sql");
      await handle.pool.query(`
        INSERT INTO ${quoted}.pricing_rules (
          id, provider, model, media_kind, billing_unit, unit_price_fen,
          currency, source, active, effective_from, metadata, created_at, updated_at
        ) VALUES (
          '00000000-5591-4000-8000-000000000001',
          'suchuang',
          'gpt-image-2-suchuang',
          'image',
          'image',
          10,
          'CNY',
          'seed:issue-157:suchuang-image-gateway',
          true,
          '2026-08-07T00:00:00+08:00',
          $1::jsonb,
          now(),
          now()
        )
      `, [{
        capability_tier: capabilityTier,
        value_sources: {},
        price_source_kind: "内部定价",
      }]);

      const originalMigration = await readFile(
        path.resolve("migrations/056_suchuang_image_pricing_tiers.sql"),
        "utf8",
      );
      await handle.pool.query(renderMigrationSql(originalMigration, driftSchema));
      const beforeRejectedMigration = await handle.pool.query(`
        SELECT id::text, metadata, updated_at
        FROM ${quoted}.pricing_rules
        WHERE source = 'seed:issue-157:suchuang-image-gateway'
        ORDER BY id
      `);

      const migration = await readFile(
        path.resolve("migrations/057_suchuang_image_pricing_tier_guard.sql"),
        "utf8",
      );
      await assert.rejects(
        () => handle.pool.query(renderMigrationSql(migration, driftSchema)),
        /#157 .*pricing tier .*drift detected/,
      );
      const afterRejectedMigration = await handle.pool.query(`
        SELECT id::text, metadata, updated_at
        FROM ${quoted}.pricing_rules
        WHERE source = 'seed:issue-157:suchuang-image-gateway'
        ORDER BY id
      `);
      assert.deepEqual(
        afterRejectedMigration.rows,
        beforeRejectedMigration.rows,
        "057 失败必须整条事务回滚，不能留下半更新 metadata 或时间戳",
      );
    } finally {
      await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
      await handle.pool.end();
    }
  }
});

async function applyMigrations(
  handle: DatabaseHandle,
  targetSchema: string,
  through?: string,
): Promise<void> {
  const files = (await readdir(path.resolve("migrations")))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort()
    .filter((file) => through === undefined || file <= through);
  assert.ok(files.includes("020_vocabulary_and_media_kind_audio.sql"));
  for (const file of files) {
    const migration = await readFile(path.resolve("migrations", file), "utf8");
    await handle.pool.query(renderMigrationSql(migration, targetSchema));
  }
}

async function runSeedCli(targetDatabaseUrl: string, targetSchema: string) {
  return execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "scripts/seed-pricing-tiers.mts",
    "--apply",
    "--database-url",
    targetDatabaseUrl,
    "--schema",
    targetSchema,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: targetDatabaseUrl,
      POSTGRES_SCHEMA: targetSchema,
    },
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

interface AudioPricingRow {
  id: string;
  provider: string;
  model: string;
  media_kind: string;
  billing_unit: string;
  unit_price_fen: number;
  active: boolean;
  metadata: {
    capability_tier?: {
      tier_id?: string;
      params?: { original_duration_seconds?: number };
    };
  };
  created_at: Date;
  updated_at: Date;
}

async function readAudioRows(handle: DatabaseHandle, quoted: string): Promise<AudioPricingRow[]> {
  const result = await handle.pool.query<AudioPricingRow>(`
    SELECT id::text, provider, model, media_kind, billing_unit, unit_price_fen,
           active, metadata, created_at, updated_at
    FROM ${quoted}.pricing_rules
    WHERE source = $1
    ORDER BY model,
      (metadata->'capability_tier'->'params'->>'sample_rate')::int,
      metadata->'capability_tier'->'params'->>'format',
      (metadata->'capability_tier'->'params'->>'original_duration_seconds')::int
  `, [source]);
  return result.rows;
}

function publicFields(row: AudioPricingRow) {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    media_kind: row.media_kind,
    billing_unit: row.billing_unit,
    unit_price_fen: row.unit_price_fen,
    active: row.active,
    tier_id: row.metadata.capability_tier?.tier_id,
    duration_seconds: row.metadata.capability_tier?.params?.original_duration_seconds,
  };
}
