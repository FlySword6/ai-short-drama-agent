import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { renderMigrationSql } from "../src/db/migrate.js";
import { voiceVocabulary } from "../src/db/schema.js";
import { DbVoiceCatalogProvider } from "../src/modules/audio/voiceCatalogProvider.js";
import { eq } from "drizzle-orm";

/**
 * 真 PostgreSQL 验证 S44 音色词表(迁移 033)与 DbVoiceCatalogProvider:
 *   验收① 回放 033 后 listVoices 读出 586 条规范词,按 sort 排序,别名不入列;
 *   验收② resolveVoiceType 别名一跳解析成规范词 voice_type,未登记/停用返回 undefined;
 *   验收③ audition_url 写回后出现在目录里(预渲染脚本的读侧口径)。
 * 连接串只允许本机或本地 Compose,拒绝云 RDS。未设环境变量时整个文件 skip。
 */
const requestedDatabaseUrl = process.env.VOICE_CATALOG_TEST_DATABASE_URL;
const databaseUrl = requestedDatabaseUrl === "from-settings"
  ? process.env.DATABASE_URL
  : requestedDatabaseUrl;

const ALIAS_ID = "御姐音-s44-test";
const ALIAS_TARGET = "zh_female_cancan_uranus_bigtts";

test("voice catalog: 词表读出、别名一跳解析、audition_url 口径", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  try {
    await applyMigrations(handle);
    const provider = new DbVoiceCatalogProvider(() => handle.db);

    // 验收①:586 条规范词,按 sort 升序;第一条是文档 2.0 表首行。
    const voices = await provider.listVoices();
    assert.equal(voices.length, 586, "目录必须恰好 586 条规范词");
    assert.equal(voices[0]!.id, "zh_female_vv_uranus_bigtts");
    assert.equal(voices[0]!.displayName, "Vivi 2.0");
    assert.equal(new Set(voices.map((voice) => voice.id)).size, 586, "voice_type 不得重复");
    assert.ok(voices.every((voice) => voice.auditionUrl === undefined), "未预渲染前不得出现 audition_url");

    // 别名先行登记(规范词已播种,一跳目标合法)。
    await handle.db.insert(voiceVocabulary).values({
      id: ALIAS_ID,
      canonicalId: ALIAS_TARGET,
      displayName: "御姐音(S44 测试别名)",
      createdAt: new Date(),
    }).onConflictDoNothing();

    // 别名不进目录列表。
    const withAlias = await provider.listVoices();
    assert.equal(withAlias.length, 586, "别名不得出现在目录列表");
    assert.ok(!withAlias.some((voice) => voice.id === ALIAS_ID));

    // 验收②:一跳解析——别名→规范词 voice_type;规范词→自身;未登记→undefined。
    assert.equal(await provider.resolveVoiceType(ALIAS_ID), ALIAS_TARGET);
    assert.equal(await provider.resolveVoiceType(ALIAS_TARGET), ALIAS_TARGET);
    assert.equal(await provider.resolveVoiceType("不存在的音色"), undefined);
    assert.equal(await provider.resolveVoiceType(""), undefined);
    // 停用别名不得解析。
    await handle.db.update(voiceVocabulary).set({ active: false }).where(eq(voiceVocabulary.id, ALIAS_ID));
    assert.equal(await provider.resolveVoiceType(ALIAS_ID), undefined);
    await handle.db.update(voiceVocabulary).set({ active: true }).where(eq(voiceVocabulary.id, ALIAS_ID));

    // 验收③:audition_url 写回后出现在目录里(预渲染脚本写侧⇄目录读侧同一口径)。
    const auditionUrl = "https://tos.example.invalid/voice-auditions/zh_female_cancan_uranus_bigtts.mp3";
    await handle.db.update(voiceVocabulary).set({ auditionUrl }).where(eq(voiceVocabulary.id, ALIAS_TARGET));
    const updated = (await provider.listVoices()).find((voice) => voice.id === ALIAS_TARGET);
    assert.equal(updated?.auditionUrl, auditionUrl);
    await handle.db.update(voiceVocabulary).set({ auditionUrl: null }).where(eq(voiceVocabulary.id, ALIAS_TARGET));
  } finally {
    await handle.db.delete(voiceVocabulary).where(eq(voiceVocabulary.id, ALIAS_ID)).catch(() => undefined);
    await handle.pool.end();
  }
});

async function applyMigrations(handle: DatabaseHandle): Promise<void> {
  const source = await readFile(path.resolve("migrations", "033_voice_vocabulary.sql"), "utf8");
  await handle.pool.query(renderMigrationSql(source, settings.postgresSchema));
}

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("VOICE_CATALOG_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
