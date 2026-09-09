import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderMigrationSql } from "../src/db/migrate.js";

/**
 * 迁移 023(配置真源+版本计划播种)合同测试:
 * ① 表结构含治理字段(kind/status/时间/来源/负责人)+(kind, entry_key) 唯一约束;
 * ② 播种 ON CONFLICT DO NOTHING —— 只在首次写入,重放不覆盖库内运营改动;
 * ③ 播种内容=迁移时刻设置页写死内容的逐字拷贝(5 段 26 卡 + 2 条版本历史),
 *    状态五态/分类三值/teaser 规则/禁词红线在这里冻结,防后续手滑改种子。
 */
const migrationPath = path.resolve("migrations/022_config_entries_release_plan.sql");
const source = await readFile(migrationPath, "utf8");
const rendered = renderMigrationSql(source, "config_entries_contract_test");

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

test("表结构:治理字段固定(类型/状态/时间/来源/负责人),内容走 jsonb,键唯一", () => {
  assert.equal(rendered.includes("{{schema}}"), false);
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS "config_entries_contract_test"\.config_entries/);
  for (const column of ["kind", "entry_key", "status", "sort", "payload jsonb", "source", "created_by", "created_at", "updated_by", "updated_at"]) {
    assert.ok(rendered.includes(column), `config_entries 缺治理列 ${column}`);
  }
  assert.match(rendered, /config_entries_kind_key_unique UNIQUE \(kind, entry_key\)/);
  assert.match(rendered, /CHECK \(status IN \('draft', 'published', 'archived'\)\)/);
  assert.match(rendered, /CREATE INDEX IF NOT EXISTS config_entries_kind_status_sort/);
});

test("播种幂等不覆盖:ON CONFLICT (kind, entry_key) DO NOTHING,来源标记 seed-023", () => {
  assert.match(source, /ON CONFLICT \(kind, entry_key\) DO NOTHING/);
  assert.equal(seedRows.length, 7, "播种必须恰好 7 行(5 段预告 + 2 条历史)");
  const ids = new Set<string>();
  for (const row of seedRows) {
    assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      `${row.kind}/${row.entryKey} 必须显式给固定 UUID(主键无默认)`);
    assert.ok(!ids.has(row.id), `种子 id 重复 ${row.id}`);
    ids.add(row.id);
    assert.equal(row.source, "seed-023", `${row.kind}/${row.entryKey} 来源标记缺失`);
    assert.equal(row.status, "published", `${row.kind}/${row.entryKey} 必须已发布`);
  }
});

test("播种内容:五段 26 卡,段序/段状态/卡数与迁移时刻设置页一致", () => {
  assert.deepEqual(
    sectionRows.map((row) => [row.entryKey, row.sort, (row.payload.cards as unknown[]).length, row.payload.status]),
    [
      ["v0.1.2", 1, 4, "live"],
      ["v0.1.3", 2, 4, "filming"],
      ["v0.2", 3, 4, "scheduled"],
      ["v0.3", 4, 10, "concept"],
      ["vision", 5, 4, "vision"],
    ],
  );
  assert.equal(allCards.length, 26);
  const titles = (key: string) => sectionRows
    .find((row) => row.entryKey === key)!
    .payload.cards as Array<{ title: string }>;
  assert.deepEqual(titles("v0.1.2").map((card) => card.title), ["界面专业化", "导演台直通工作台", "资产库全量可用", "审核台"]);
  assert.deepEqual(titles("v0.1.3").map((card) => card.title), ["操作手感", "搜得懂人话", "模型对比试产", "管理控制台"]);
  assert.deepEqual(titles("v0.2").map((card) => card.title), ["Pi 协作", "Cmd+K 命令面板", "实拍混排", "选题雷达"]);
  assert.deepEqual(
    titles("v0.3").map((card) => card.title),
    ["参考调控", "角色一致性", "受控编辑", "画布工作台", "剧本工坊", "动作复刻", "图片局部编辑", "拆书定妆", "风格参考控制", "拍法技能库"],
  );
  assert.deepEqual(titles("vision").map((card) => card.title), ["IP 广场", "投放分发", "真人 IP 资产", "手机实拍运镜"]);
});

test("播种内容:每卡字段完整,状态/分类合法,远景卡未定档且无 teaser", () => {
  const statuses = new Set(["live", "filming", "scheduled", "concept", "vision"]);
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
    }
  }
  for (const card of allCards.filter((item) => item.status === "vision")) {
    assert.equal(card.release, "未定档");
    assert.ok(card.teaser === undefined, "远景卡不出轮播短句");
  }
});

test("播种内容:18 条 teaser(已上线/远景不进轮播),无空炮话术", () => {
  const teasable = allCards.filter((card) => typeof card.teaser === "string" && card.status !== "live" && card.status !== "vision");
  assert.equal(teasable.length, 18);
  const banned = /敬请期待|即将上线|coming\s*soon/i;
  const copy = allCards.flatMap((card) => [card.title, card.tagline, card.teaser ?? ""]);
  for (const text of copy) assert.ok(!banned.test(String(text)), `出现禁词:${String(text)}`);
  assert.ok(!banned.test(source), "迁移文件出现禁词");
});

test("播种内容:版本历史两条(新发布在前),条目带分类,日期合法", () => {
  assert.deepEqual(historyRows.map((row) => row.entryKey), ["v0.1.2", "v0.1.1"]);
  const v011 = historyRows.find((row) => row.entryKey === "v0.1.1")!;
  assert.equal(v011.payload.date, "2026-07-22");
  assert.equal(v011.payload.title, "首个可用版本");
  const v012 = historyRows.find((row) => row.entryKey === "v0.1.2")!;
  assert.deepEqual(v012.payload.items, [
    { label: "生成主链四合同冻结", category: "improvement" },
    { label: "TOS CORS 修复", category: "fix" },
  ]);
  for (const row of historyRows) {
    assert.match(row.payload.date as string, /^\d{4}-\d{2}-\d{2}$/);
    for (const item of row.payload.items as Array<Record<string, unknown>>) {
      assert.ok(typeof item.label === "string" && item.label.trim());
      assert.ok(["feature", "improvement", "fix"].includes(item.category as string));
    }
  }
});
