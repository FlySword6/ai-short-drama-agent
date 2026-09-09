import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * 迁移 023(版本计划内容替换 + lane 词表 recommended 扩列)合同测试:
 * ① recommended 列幂等扩列 + 七条带守卫播种(元素 {key,label,required});
 * ② 内容替换幂等——DELETE 命中 022 播种的七个固定 UUID,INSERT 八行
 *    新固定 UUID + ON CONFLICT (kind, entry_key) DO NOTHING;
 * ③ 新内容形状冻结:五段(v0.1.x/v0.2.0 live、v0.2.x filming、v0.3.0
 *    scheduled、v0.4+ vision)47 卡 + 三条版本历史;reason/basis 长度
 *    上限、vision 卡未定档无 teaser、全内容无 teaser(轮播自然静默)、
 *    禁词红线,防后续手滑改种子。
 */
const migrationPath = path.resolve("migrations/024_release_plan_content.sql");
const source = await readFile(migrationPath, "utf8");
const source022 = await readFile(path.resolve("migrations/022_config_entries_release_plan.sql"), "utf8");

interface SeedRow {
  id: string;
  kind: "release_section" | "release_history_entry";
  entryKey: string;
  status: string;
  sort: number;
  payload: Record<string, unknown>;
  source: string;
}

function parseSeedRows(sql: string): SeedRow[] {
  const rows: SeedRow[] = [];
  const pattern = /\('([0-9a-f-]{36})', '(release_section|release_history_entry)', '((?:[^']|'')+)', '(\w+)', (\d+), '((?:[^']|'')+)'::jsonb, '([^']+)'\)/g;
  for (const match of sql.matchAll(pattern)) {
    rows.push({
      id: match[1]!,
      kind: match[2] as SeedRow["kind"],
      entryKey: match[3]!.replaceAll("''", "'"),
      status: match[4]!,
      sort: Number(match[5]),
      payload: JSON.parse(match[6]!.replaceAll("''", "'")) as Record<string, unknown>,
      source: match[7]!,
    });
  }
  return rows;
}

const seedRows = parseSeedRows(source);
const sectionRows = seedRows.filter((row) => row.kind === "release_section");
const historyRows = seedRows.filter((row) => row.kind === "release_history_entry");
const allCards = sectionRows.flatMap((row) => (row.payload.cards ?? []) as Array<Record<string, unknown>>);

test("recommended 扩列幂等:ADD COLUMN IF NOT EXISTS,七条播种带空数组守卫", () => {
  assert.match(source, /ADD COLUMN IF NOT EXISTS recommended jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
  const updates = [...source.matchAll(/UPDATE \{\{schema\}\}\.reference_lane_vocabulary SET recommended = '((?:[^']|'')+)'::jsonb\s+WHERE id = '(\w+)' AND recommended = '\[\]'::jsonb;/g)];
  assert.deepEqual(
    updates.map((match) => match[2]),
    ["character", "scene", "prop", "lighting", "camera_motion", "reference_video", "audio"],
    "七条 lane 各一条带守卫播种",
  );
  for (const match of updates) {
    const items = JSON.parse(match[1]!.replaceAll("''", "'")) as Array<Record<string, unknown>>;
    assert.ok(items.length > 0, `${match[2]} recommended 不应为空`);
    for (const item of items) {
      assert.ok(typeof item.key === "string" && item.key.trim(), `${match[2]} 推荐项缺 key`);
      assert.ok(typeof item.label === "string" && item.label.trim(), `${match[2]} 推荐项缺 label`);
      assert.equal(typeof item.required, "boolean", `${match[2]} 推荐项 required 非布尔`);
    }
  }
});

test("内容替换幂等:DELETE 命中 022 七个播种 UUID,INSERT 八行固定 UUID + ON CONFLICT DO NOTHING", () => {
  const ids022 = parseSeedRows(source022).map((row) => row.id);
  assert.equal(ids022.length, 7, "022 播种行数前提(5 段 + 2 历史)变了,本测试要跟着改");
  const deleteMatch = source.match(/DELETE FROM \{\{schema\}\}\.config_entries WHERE id IN \(([^)]+)\)/);
  assert.ok(deleteMatch, "缺按固定 UUID 的 DELETE");
  const deletedIds = [...deleteMatch[1]!.matchAll(/'([0-9a-f-]{36})'/g)].map((match) => match[1]);
  assert.deepEqual([...deletedIds].sort(), [...ids022].sort(), "DELETE 清单必须恰好=022 播种的七行");
  assert.match(source, /ON CONFLICT \(kind, entry_key\) DO NOTHING/);

  assert.equal(seedRows.length, 8, "播种必须恰好 8 行(5 段预告 + 3 条历史)");
  const ids = new Set<string>();
  for (const row of seedRows) {
    assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      `${row.kind}/${row.entryKey} 必须显式给固定 UUID(主键无默认)`);
    assert.ok(!ids.has(row.id), `种子 id 重复 ${row.id}`);
    ids.add(row.id);
    assert.equal(row.source, "seed-024", `${row.kind}/${row.entryKey} 来源标记缺失`);
    assert.equal(row.status, "published", `${row.kind}/${row.entryKey} 必须已发布`);
  }
  assert.ok(!seedRows.some((row) => ids022.includes(row.id)), "新行 UUID 与 022 旧行撞车");
});

test("新内容:五段 47 卡,段序/段状态/卡数按 version-plan 重排", () => {
  assert.deepEqual(
    sectionRows.map((row) => [row.entryKey, row.sort, (row.payload.cards as unknown[]).length, row.payload.status]),
    [
      ["v0.1.x", 1, 8, "live"],
      ["v0.2.0", 2, 9, "live"],
      ["v0.2.x", 3, 11, "filming"],
      ["v0.3.0", 4, 13, "scheduled"],
      ["v0.4+", 5, 6, "vision"],
    ],
  );
  assert.equal(allCards.length, 47);
  assert.equal(sectionRows.find((row) => row.entryKey === "v0.4+")!.payload.title, "v0.4 及以后");
});

test("新内容:每卡字段完整,状态/分类合法且与段一致,vision 卡未定档无 teaser", () => {
  const statuses = new Set(["live", "filming", "scheduled", "vision"]);
  const categories = new Set(["feature", "improvement", "fix"]);
  for (const row of sectionRows) {
    for (const card of row.payload.cards as Array<Record<string, unknown>>) {
      for (const field of ["id", "title", "tagline", "status", "category", "release"]) {
        assert.ok(typeof card[field] === "string" && (card[field] as string).trim(), `卡片缺字段 ${field}`);
      }
      assert.ok(statuses.has(card.status as string), `未知状态 ${String(card.status)}`);
      assert.ok(categories.has(card.category as string), `未知分类 ${String(card.category)}`);
      assert.equal(card.status, row.payload.status, `${String(card.title)} 状态与所在段不一致`);
      assert.ok(!("unlock" in card), "仍有解锁条件字段");
      /* S24:新内容不出轮播短句——Pi 轮播自然静默,不编造 teaser */
      assert.ok(card.teaser === undefined, `${String(card.title)} 不应带 teaser`);
      /* reason(前台可见)/basis(留痕不上前台)可空,写了就 ≤500(config-entries 合同上限) */
      for (const optional of ["reason", "basis"] as const) {
        if (card[optional] !== undefined) {
          assert.equal(typeof card[optional], "string", `${String(card.title)} ${optional} 非字符串`);
          assert.ok((card[optional] as string).length <= 500, `${String(card.title)} ${optional} 超 500 字`);
        }
      }
    }
  }
  for (const card of allCards.filter((item) => item.status === "vision")) {
    assert.equal(card.release, "未定档");
  }
  /* v0.2.x 段每卡都给「为什么做」一句交代 */
  const filming = sectionRows.find((row) => row.entryKey === "v0.2.x")!;
  for (const card of filming.payload.cards as Array<Record<string, unknown>>) {
    assert.ok(typeof card.reason === "string" && card.reason.trim(), `v0.2.x 卡片 ${String(card.title)} 缺 reason`);
  }
});

test("新内容:版本历史三条(新发布在前),条目带分类,日期合法", () => {
  assert.deepEqual(historyRows.map((row) => row.entryKey), ["v0.2.0", "v0.1.2", "v0.1.1"]);
  assert.deepEqual(historyRows.map((row) => row.sort), [1, 2, 3]);
  assert.equal(historyRows[0]!.payload.date, "2026-07-26");
  assert.equal((historyRows[0]!.payload.items as unknown[]).length, 9, "v0.2.0 历史条目=同段九卡");
  for (const row of historyRows) {
    assert.match(row.payload.date as string, /^\d{4}-\d{2}-\d{2}$/);
    for (const item of row.payload.items as Array<Record<string, unknown>>) {
      assert.ok(typeof item.label === "string" && item.label.trim());
      assert.ok(["feature", "improvement", "fix"].includes(item.category as string));
    }
  }
});

test("新内容:无空炮话术与版本语清场词", () => {
  const banned = /敬请期待|即将上线|coming\s*soon/i;
  const copy = allCards.flatMap((card) => [card.title, card.tagline, card.reason ?? "", card.basis ?? ""]);
  for (const text of copy) assert.ok(!banned.test(String(text)), `出现禁词:${String(text)}`);
  assert.ok(!banned.test(source), "迁移文件出现禁词");
});
