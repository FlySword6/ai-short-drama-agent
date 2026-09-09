import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { settings } from "../src/config/env.js";
import { buildDatabasePoolConfig, createDatabase } from "../src/db/client.js";
import { configEntries } from "../src/db/schema.js";
import {
  expectedCardRelease,
  parseReleasePlanDoc,
  RELEASE_PLAN_DOC_PATH,
  type ReleasePlanDocSection,
} from "../src/modules/config-entries/release-plan-doc.js";
import {
  commandPaletteCopyPayloadSchema,
  commandPaletteGroupPayloadSchema,
  releaseSectionPayloadSchema,
  type ReleaseSectionPayload,
} from "../src/modules/config-entries/types.js";

/**
 * S31 真源一致性门禁(本包最重要的交付):version-plan.md ↔ config_entries。
 *
 * 2026-07-26 的教训:文档与库分叉了一整天才被人眼抓到——两边命名故意不同
 * (工程名 vs 人话),拿标题当主键让一切机械比对失效。本测试把分叉变成门禁:
 * 对齐只靠 card_key(文档锚点 <!-- card:... --> ↔ 库内卡片 card_key),
 * 任何一边多出、少掉、状态/档期/验收标准不一致,都点名到卡报红。
 *
 * 比对:段/卡归属、状态、档期、验收标准 acceptance(S37 起由文档管,
 * 改一个字都报红)。故意不比对的:卡片 title/tagline/reason/basis 文本
 * (命名不同是故意的,库里的用户向写法是对的那套)、段 title/note(运营面)。
 *
 * 只读库,一个字都不写。真库连接怎么找(S37 把这道门禁真正接进门禁的做法):
 *   1. 显式 RELEASE_PLAN_TRUTH_DATABASE_URL(或 =from-settings 用 DATABASE_URL)
 *      ——指定的必须指向本机库,否则当场抛错(大声失败,不许悄悄连云库);
 *   2. 未显式指定时回落到 .env 的本地库配置(env.ts 在 import 时已加载 .env),
 *      先探测可达性:通 → 门禁实跑;不通 / 指向非本机 → 如实 skip 并写明怎么起。
 * 没有「跑不了就当通过」:skip 原因永远写出来。POSTGRES_SCHEMA 必须指向
 * 目标库的 schema(默认 app)。
 */
const LOCAL_TRUTH_HOSTS = new Set(["127.0.0.1", "localhost", "db"]);

interface TruthTarget {
  url?: string;
  source?: string;
  skipReason?: string;
}

function isLocalTruthHost(value: string): boolean {
  try {
    return LOCAL_TRUTH_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** 短超时探测:库可达才实跑门禁;不可达如实 skip,而不是报错或装过。 */
async function probeTruthDatabase(value: string): Promise<boolean> {
  const client = new Client({ ...buildDatabasePoolConfig(value), connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function resolveTruthTarget(): Promise<TruthTarget> {
  const requested = process.env.RELEASE_PLAN_TRUTH_DATABASE_URL;
  if (requested) {
    const url = requested === "from-settings" ? process.env.DATABASE_URL : requested;
    if (!url) {
      return { skipReason: "RELEASE_PLAN_TRUTH_DATABASE_URL=from-settings 但 DATABASE_URL 为空——如实 skip 不假装通过" };
    }
    assertLocalTestDatabase(url); // 显式指定非本机:大声失败,不是 skip
    return { url, source: "RELEASE_PLAN_TRUTH_DATABASE_URL" };
  }
  // 回落:.env 的本地库配置。dev 标准动作就是 npm run dev:up,库在 → 门禁自动
  // 实跑,不再靠人记得设环境变量(S31 的缺口:不设变量时这道门禁从不运行)。
  const fallback = settings.databaseUrl;
  if (!fallback) {
    return { skipReason: "未设 RELEASE_PLAN_TRUTH_DATABASE_URL,也没有本地 .env 库配置——真源一致性门禁如实 skip 不假装通过;npm run dev:up 起本地库后自动实跑" };
  }
  if (!isLocalTruthHost(fallback)) {
    return { skipReason: ".env 的库配置指向非本机地址,门禁拒绝连接云库,如实 skip;要对齐请跑本地 dev 库(npm run dev:up)" };
  }
  if (!(await probeTruthDatabase(fallback))) {
    return { skipReason: `检测到本地 .env 库配置但连不上(${new URL(fallback).host})——dev 库没起;npm run dev:up 后门禁自动实跑,此处如实 skip 不假装通过` };
  }
  return { url: fallback, source: ".env 本地 dev 库(自动探测)" };
}

const truth = await resolveTruthTarget();
if (truth.url) {
  console.log(`  ℹ 真源一致性门禁实跑:库连接来自 ${truth.source}(${new URL(truth.url).host})`);
}
const databaseUrl = truth.url;
const SKIP_REASON = truth.skipReason ?? "";

interface EntryRow {
  id: string;
  kind: string;
  entryKey: string;
  status: string;
  payload: unknown;
}

test("门禁:version-plan.md 与 config_entries.release_section 逐卡对齐", {
  skip: !databaseUrl ? SKIP_REASON : false,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  try {
    const doc = parseReleasePlanDoc(await readFile(path.resolve(RELEASE_PLAN_DOC_PATH), "utf8"));
    const problems: string[] = [...doc.issues.map((issue) => `文档结构: ${issue}`)];

    const rows = (await handle.db.select().from(configEntries).where(eq(configEntries.kind, "release_section"))) as unknown as EntryRow[];
    const infos: string[] = [];

    for (const section of doc.sections) {
      const entry = rows.find((row) => row.entryKey === section.entryKey);
      if (!entry) {
        problems.push(`段 ${section.entryKey} 整段缺失:文档有库里没有——跑 scripts/sync-release-plan.mts 或在管理界面补`);
        continue;
      }
      if (entry.status !== "published") {
        infos.push(`段 ${section.entryKey} 库内状态是 ${entry.status}(未发布,前台不可见)`);
      }
      const parsed = releaseSectionPayloadSchema.safeParse(entry.payload);
      if (!parsed.success) {
        problems.push(`段 ${section.entryKey} 库内 payload 不符合格式:${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
        continue;
      }
      compareSection(section, entry, parsed.data, rows, doc.sections, problems);
    }

    for (const row of rows) {
      // 已归档=本判据自己开的处方(「管理界面归档或补进文档」)已执行,不再算分叉;
      // 2026-08-01 v0.2.x 挪号搬家实证:归档后仍红=守卫处方与判定不自洽,修判定不改处方。
      if (row.status === "archived") continue;
      if (!doc.sections.some((section) => section.entryKey === row.entryKey)) {
        problems.push(`段 ${row.entryKey} 库里有文档没有——只报告不自动删,要人确认(管理界面归档或补进文档)`);
      }
    }

    for (const info of infos) console.log(`  ℹ ${info}`);
    assert.deepEqual(problems, [],
      `版本计划两份真源分叉(${problems.length} 处)——逐条修完本测试才绿;不许反过来改测试/文档/库内容迁就:\n${problems.join("\n")}`);
  } finally {
    await handle.pool.end();
  }
});

function compareSection(
  section: ReleasePlanDocSection,
  entry: EntryRow,
  payload: ReleaseSectionPayload,
  allRows: EntryRow[],
  allDocSections: ReleasePlanDocSection[],
  problems: string[],
): void {
  if (payload.status !== section.status) {
    problems.push(`段 ${section.entryKey} 状态不一致:库里 ${payload.status},文档 ${section.status}`);
  }
  const dbKeys = new Map<string, Record<string, unknown>>();
  for (const card of payload.cards) {
    const raw = card as Record<string, unknown>;
    const key = typeof raw.card_key === "string" && raw.card_key.trim() ? raw.card_key.trim() : undefined;
    if (!key) {
      problems.push(`段 ${section.entryKey} 卡 ${card.id}(${card.title})缺 card_key——未归属内容,先跑迁移 027 补齐`);
      continue;
    }
    if (dbKeys.has(key)) {
      problems.push(`段 ${section.entryKey} 的 card_key ${key} 在库内重复,对齐歧义`);
      continue;
    }
    dbKeys.set(key, raw);
  }

  const expectedRelease = expectedCardRelease(section);
  for (const docCard of section.cards) {
    const dbCard = dbKeys.get(docCard.cardKey);
    if (!dbCard) {
      const elsewhere = findCardInOtherSections(allRows, section.entryKey, docCard.cardKey);
      problems.push(`段 ${section.entryKey} 缺卡 ${docCard.cardKey}(${docCard.title}):文档有库里没有——跑 scripts/sync-release-plan.mts 或在管理界面补${elsewhere ? `;同一 key 在库内 ${elsewhere} 段,可能是挪了档期` : ""}`);
      continue;
    }
    if (dbCard.status !== section.status) {
      problems.push(`卡 ${section.entryKey}/${docCard.cardKey} 状态不一致:库里 ${String(dbCard.status)},文档段 ${section.status}`);
    }
    if (dbCard.release !== expectedRelease) {
      problems.push(`卡 ${section.entryKey}/${docCard.cardKey} 档期不一致:库里 ${String(dbCard.release)},按文档应为 ${expectedRelease}`);
    }
    // 验收标准(S37)由文档管:两边逐字一致才算对齐,改一个字都报红。
    const docAcceptance = docCard.acceptance;
    const dbAcceptance = typeof dbCard.acceptance === "string" ? dbCard.acceptance : undefined;
    if (docAcceptance !== dbAcceptance) {
      problems.push(`卡 ${section.entryKey}/${docCard.cardKey} 验收标准不一致${acceptanceDiffHint(dbAcceptance, docAcceptance)}\n  库里: ${show(dbAcceptance)}\n  文档: ${show(docAcceptance)}\n  acceptance 以文档为准:改文档后跑 scripts/sync-release-plan.mts 推进库;文档没有而库里有的,同步只报告不自动清,要人确认后手动处理`);
    }
  }

  for (const [key, card] of dbKeys) {
    if (!section.cards.some((docCard) => docCard.cardKey === key)) {
      const elsewhere = allDocSections.find((other) => other.entryKey !== section.entryKey && other.cards.some((docCard) => docCard.cardKey === key));
      problems.push(`段 ${section.entryKey} 多卡 ${key}(${String(card.title)}):库里有文档没有——只报告不自动删,要人确认(管理界面归档或补进文档)${elsewhere ? `;同一 key 在文档 ${elsewhere.entryKey} 段,可能是挪了档期` : ""}`);
    }
  }
}

function findCardInOtherSections(rows: EntryRow[], currentEntryKey: string, cardKey: string): string | undefined {
  for (const row of rows) {
    if (row.entryKey === currentEntryKey) continue;
    const parsed = releaseSectionPayloadSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const hit = parsed.data.cards.some((card) => (card as Record<string, unknown>).card_key === cardKey || card.id === cardKey);
    if (hit) return row.entryKey;
  }
  return undefined;
}

/** 验收不一致时定位差在哪:首个不同字符的位置与上下文(多行文本逐字比对)。 */
function acceptanceDiffHint(dbValue: string | undefined, docValue: string | undefined): string {
  if (dbValue === undefined || docValue === undefined) return "(一边写了另一边没写)";
  let at = 0;
  while (at < Math.min(dbValue.length, docValue.length) && dbValue[at] === docValue[at]) at += 1;
  const head = Math.max(0, at - 15);
  const slice = (value: string) => value.slice(head, at + 25).replaceAll("\n", "⏎");
  return `(首个差异在第 ${at + 1} 字:库里 …${slice(dbValue)}… / 文档 …${slice(docValue)}…)`;
}

/** 报错里展示验收全文;超长按字数截断,差异定位由 acceptanceDiffHint 给。 */
function show(value: string | undefined): string {
  if (value === undefined) return "(没写)";
  return value.length > 600 ? `${value.slice(0, 600)}…(共 ${value.length} 字)` : value;
}

test("归属:command_palette_group / command_palette_copy 必须存在且 payload 合法(S30 内容不留无人管)", {
  skip: !databaseUrl ? SKIP_REASON : false,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const handle = createDatabase(databaseUrl);
  try {
    const problems: string[] = [];

    const groups = (await handle.db.select().from(configEntries).where(eq(configEntries.kind, "command_palette_group"))) as unknown as EntryRow[];
    if (!groups.some((row) => row.status === "published")) {
      problems.push("command_palette_group 没有 published 行——⌘K 面板分组成了没人管的内容");
    }
    for (const row of groups) {
      const parsed = commandPaletteGroupPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        problems.push(`command_palette_group/${row.entryKey} payload 不合法:${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      }
    }

    const copies = (await handle.db.select().from(configEntries).where(eq(configEntries.kind, "command_palette_copy"))) as unknown as EntryRow[];
    if (!copies.some((row) => row.status === "published")) {
      problems.push("command_palette_copy 没有 published 行——⌘K 面板文案成了没人管的内容");
    }
    for (const row of copies) {
      const parsed = commandPaletteCopyPayloadSchema.safeParse(row.payload);
      if (!parsed.success) {
        problems.push(`command_palette_copy/${row.entryKey} payload 不合法:${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      }
    }

    assert.deepEqual(problems, [], `⌘K 配置归属检查失败(${problems.length} 处):\n${problems.join("\n")}`);
  } finally {
    await handle.pool.end();
  }
});

function assertLocalTestDatabase(value: string): void {
  if (!isLocalTruthHost(value)) {
    throw new Error("RELEASE_PLAN_TRUTH_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}
