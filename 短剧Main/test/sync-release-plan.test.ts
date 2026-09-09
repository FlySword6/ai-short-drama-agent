import assert from "node:assert/strict";
import test from "node:test";
import type { ReleasePlanDocSection } from "../src/modules/config-entries/release-plan-doc.js";
import type { ReleaseCardPayload } from "../src/modules/config-entries/types.js";
import { buildPlan, type AdminEntry } from "../scripts/sync-release-plan.mts";

/**
 * S31 同步工具核心(buildPlan,纯函数)合同:
 * ① 文档有库里没有 → 追加(新卡 id=card_key、category 默认 feature、版本语按段);
 * ② 两边都有但状态/档期漂移 → 以文档为准,其余字段(title/tagline/reason/
 *    basis/teaser/acceptance/card_key)一个字不碰;
 * ③ 库里有文档没有 → 只报告不删,跨段同 key 给「可能挪了档期」提示;
 * ④ 库里缺 card_key 的卡按 id 兜底对齐并进未归属清单;
 * ⑤ 段 payload 结构认不出 → 整段拒绝,不留半截动作;
 * ⑥ 幂等:把待写 payload 当成库内现状再算一遍,必须无变化。
 */

function docSection(partial: Partial<ReleasePlanDocSection> & Pick<ReleasePlanDocSection, "entryKey" | "status">): ReleasePlanDocSection {
  return { title: partial.entryKey, cards: [], line: 1, ...partial };
}

function dbCard(partial: Partial<ReleaseCardPayload> & Pick<ReleaseCardPayload, "id" | "title">): ReleaseCardPayload {
  return {
    tagline: `${partial.title}的一句话`,
    status: "filming",
    category: "improvement",
    release: "v0.2.x",
    ...partial,
  };
}

function dbEntry(entryKey: string, cards: Array<Record<string, unknown>>, status = "filming"): AdminEntry {
  return {
    id: `uuid-${entryKey}`,
    kind: "release_section",
    entry_key: entryKey,
    status: "published",
    sort: 3,
    payload: { title: entryKey, status, note: "运营改过的段注", cards },
  };
}

test("文档有库里没有 → 追加新卡;已有卡逐字段不动(acceptance 原样保留)", () => {
  const sections = [docSection({
    entryKey: "v0.2.x", status: "filming",
    cards: [
      { cardKey: "env-governance", title: "环境治理", body: "工程向内容", reason: "起因", line: 2 },
      { cardKey: "command-palette", title: "⌘K 命令面板", body: "全局快捷指令入口", reason: "DC 点名", line: 3 },
    ],
  })];
  const entries = [dbEntry("v0.2.x", [
    { ...dbCard({ id: "env-governance", title: "环境规矩立起来" }), card_key: "env-governance", acceptance: "三环境各跑一次登录", reason: "人话起因" },
  ])];

  const { plan, writes } = buildPlan(sections, entries);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.additions.length, 1);
  assert.equal(plan.additions[0]!.card.cardKey, "command-palette");
  assert.deepEqual(plan.acceptanceExtras, [{ section: "v0.2.x", cardKey: "env-governance", title: "环境规矩立起来" }],
    "文档没写验收、库里有 → 只报告不自动清(S37)");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.action, "update");

  const payload = writes[0]!.payload;
  assert.equal(payload.note, "运营改过的段注", "段注是运营面,不碰");
  assert.equal(payload.cards.length, 2, "新卡追加在末尾");
  const [kept, added] = payload.cards;
  assert.equal(kept.title, "环境规矩立起来", "已有卡标题(人话)不被文档工程名覆盖");
  assert.equal(kept.reason, "人话起因", "已有卡 reason 不被文档覆盖");
  assert.equal(kept.acceptance, "三环境各跑一次登录", "acceptance 原样保留");
  assert.equal(kept.category, "improvement", "已有卡 category 不动");
  assert.deepEqual(added, {
    id: "command-palette",
    card_key: "command-palette",
    title: "⌘K 命令面板",
    tagline: "全局快捷指令入口",
    status: "filming",
    category: "feature",
    release: "v0.2.x",
    reason: "DC 点名",
  });
});

test("状态/档期漂移以文档为准,其余字段不碰;段状态漂移一起报", () => {
  const sections = [docSection({
    entryKey: "v0.2.x", status: "scheduled",
    cards: [{ cardKey: "tag-system", title: "标签体系", body: "内容", line: 2 }],
  })];
  const entries = [dbEntry("v0.2.x", [
    { ...dbCard({ id: "tag-system", title: "标签体系" }), card_key: "tag-system", teaser: "运营写的轮播句" },
  ])];

  const { plan, writes } = buildPlan(sections, entries);
  assert.equal(writes.length, 1);
  const driftFields = plan.drift.map((item) => `${item.cardKey}.${item.field}:${item.from}->${item.to}`).sort();
  // release 本来就是 v0.2.x(段键),不算漂移;只有 status 与段状态两条。
  assert.deepEqual(driftFields, [
    "(段).section_status:filming->scheduled",
    "tag-system.status:filming->scheduled",
  ]);
  const card = writes[0]!.payload.cards[0]!;
  assert.equal(card.status, "scheduled");
  assert.equal(card.teaser, "运营写的轮播句", "teaser 不碰");
  assert.equal(writes[0]!.payload.status, "scheduled");
});

test("远景段新卡版本语写「未定档」,非远景写段键", () => {
  const sections = [docSection({
    entryKey: "v0.4+", status: "vision", title: "v0.4 及以后",
    cards: [{ cardKey: "ip-plaza", title: "IP 广场", body: "未定档", line: 2 }],
  })];
  const { writes } = buildPlan(sections, []);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.action, "create");
  assert.equal(writes[0]!.payload.cards[0]!.release, "未定档");
  assert.equal(writes[0]!.payload.title, "v0.4 及以后");
  assert.equal(writes[0]!.sort, 1);
});

test("库里有文档没有 → 只报告不删;同 key 在文档另一段 → 给挪档期提示", () => {
  const sections = [
    docSection({ entryKey: "v0.2.0", status: "live", cards: [] }),
    docSection({
      entryKey: "v0.2.x", status: "filming",
      cards: [{ cardKey: "voice-workshop-1", title: "声音工坊一期", body: "配音链路", reason: "合同已就绪", line: 3 }],
    }),
  ];
  const entries = [
    dbEntry("v0.2.0", [{ ...dbCard({ id: "voice-workshop-1", title: "声音工坊一期", status: "live", release: "v0.2.0" }), card_key: "voice-workshop-1" }], "live"),
    dbEntry("v0.2.x", []),
  ];

  const { plan, writes } = buildPlan(sections, entries);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.extras.length, 1);
  assert.equal(plan.extras[0]!.section, "v0.2.0");
  assert.equal(plan.extras[0]!.cardKey, "voice-workshop-1");
  assert.match(plan.extras[0]!.hint ?? "", /v0\.2\.x/, "跨段同 key 必须提示");
  const v020 = writes.find((write) => write.entryKey === "v0.2.0");
  assert.equal(v020, undefined, "只报告的段不写库");
  const v02xPayload = writes.find((write) => write.entryKey === "v0.2.x")!.payload;
  assert.equal(v02xPayload.cards[0]!.id, "voice-workshop-1", "文档侧的卡照样追加");
});

test("库里缺 card_key 的卡按 id 兜底对齐,进未归属清单提醒跑迁移 027", () => {
  const sections = [docSection({
    entryKey: "v0.2.x", status: "filming",
    cards: [{ cardKey: "env-governance", title: "环境治理", body: "内容", line: 2 }],
  })];
  const entries = [dbEntry("v0.2.x", [dbCard({ id: "env-governance", title: "环境规矩立起来" })])];

  const { plan, writes } = buildPlan(sections, entries);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.additions.length, 0, "按 id 兜底对上,不当成新卡");
  assert.deepEqual(plan.homeless, [{ section: "v0.2.x", id: "env-governance", title: "环境规矩立起来" }]);
  assert.equal(writes.length, 0, "没有漂移就不写");
});

test("段 payload 结构认不出 → 整段拒绝,不留半截动作", () => {
  const sections = [docSection({
    entryKey: "v0.2.x", status: "filming",
    cards: [{ cardKey: "command-palette", title: "⌘K", body: "内容", line: 2 }],
  })];
  const entries = [dbEntry("v0.2.x", [{ "坏掉的": true }])];

  const { plan, writes } = buildPlan(sections, entries);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0]!, /v0\.2\.x/);
  assert.equal(writes.length, 0);
  assert.equal(plan.additions.length, 0, "拒绝的段不留半截新增");
});

test("幂等:把待写 payload 当库内现状再算,必须无变化(报告项仍在)", () => {
  const sections = [docSection({
    entryKey: "v0.2.x", status: "filming",
    cards: [
      { cardKey: "env-governance", title: "环境治理", body: "内容", reason: "起因", line: 2 },
      { cardKey: "command-palette", title: "⌘K 命令面板", body: "入口", line: 3 },
    ],
  })];
  const entries = [dbEntry("v0.2.x", [
    { ...dbCard({ id: "env-governance", title: "环境规矩立起来", status: "live", release: "v0.2.0" }), card_key: "env-governance" },
    { ...dbCard({ id: "legacy-extra", title: "文档没有的旧卡" }), card_key: "legacy-extra" },
  ])];

  const first = buildPlan(sections, entries);
  assert.equal(first.writes.length, 1);
  assert.equal(first.plan.drift.length > 0, true, "前提:有漂移要修");
  const applied = [dbEntry("v0.2.x", first.writes[0]!.payload.cards as unknown as Array<Record<string, unknown>>)];
  const second = buildPlan(sections, applied);
  assert.deepEqual(second.plan.errors, []);
  assert.equal(second.writes.length, 0, "连跑两次,第二次必须无变化");
  assert.equal(second.plan.additions.length, 0);
  assert.equal(second.plan.drift.length, 0);
  assert.equal(second.plan.extras.length, 1, "报告项(旧卡)仍在,等人确认");
  assert.equal(second.plan.extras[0]!.cardKey, "legacy-extra");
});

test("库里有文档没有的段 → 只报告;文档段键顺序决定新建段 sort", () => {
  const sections = [
    docSection({ entryKey: "v0.1.x", status: "live", cards: [{ cardKey: "audit", title: "审计", body: "内容", line: 2 }] }),
    docSection({ entryKey: "v9.9", status: "concept", title: "新档期", cards: [{ cardKey: "new-card", title: "新卡", body: "内容", line: 3 }] }),
  ];
  const entries = [dbEntry("v0.5", [{ ...dbCard({ id: "x", title: "旧段残卡" }), card_key: "x" }], "vision")];

  const { plan, writes } = buildPlan(sections, entries);
  assert.deepEqual(plan.extraSections, [{ entryKey: "v0.5", status: "published" }]);
  const creates = writes.filter((write) => write.action === "create");
  assert.deepEqual(creates.map((write) => [write.entryKey, write.sort]), [["v0.1.x", 1], ["v9.9", 2]],
    "库里没有的段都走新建,sort = 文档里的段序");
});

test("验收(S37):文档有库里没有 → 以文档为准写入;两边都有但不同 → 覆盖;一致 → 不动", () => {
  const sections = [docSection({
    entryKey: "v0.2.x", status: "filming",
    cards: [
      { cardKey: "env-governance", title: "环境治理", body: "内容", acceptance: "交付物:示例假判据甲\n门禁:npm test 绿", line: 2 },
      { cardKey: "tag-system", title: "标签体系", body: "内容", acceptance: "交付物:示例假判据乙(新版)", line: 3 },
      { cardKey: "cost-metric", title: "成本口径", body: "内容", acceptance: "交付物:示例假判据丙", line: 4 },
    ],
  })];
  const entries = [dbEntry("v0.2.x", [
    { ...dbCard({ id: "env-governance", title: "环境规矩立起来" }), card_key: "env-governance" },
    { ...dbCard({ id: "tag-system", title: "标签体系" }), card_key: "tag-system", acceptance: "交付物:示例假判据乙(旧版)" },
    { ...dbCard({ id: "cost-metric", title: "成本口径" }), card_key: "cost-metric", acceptance: "交付物:示例假判据丙" },
  ])];

  const { plan, writes } = buildPlan(sections, entries);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.acceptanceExtras, []);
  assert.equal(writes.length, 1, "两张卡验收要修,合并成一笔段更新");
  const driftFields = plan.drift.map((item) => `${item.cardKey}.${item.field}`).sort();
  assert.deepEqual(driftFields, ["env-governance.acceptance", "tag-system.acceptance"], "一致的卡不报漂移");
  const cards = new Map(writes[0]!.payload.cards.map((card) => [card.card_key, card]));
  assert.equal(cards.get("env-governance")!.acceptance, "交付物:示例假判据甲\n门禁:npm test 绿", "多行验收原文写入");
  assert.equal(cards.get("tag-system")!.acceptance, "交付物:示例假判据乙(新版)", "冲突以文档为准覆盖");
  assert.equal(cards.get("cost-metric")!.acceptance, "交付物:示例假判据丙", "一致的原样保留");
  assert.equal(cards.get("env-governance")!.title, "环境规矩立起来", "标题等其他字段照旧不碰");
});

test("验收(S37):文档没有而库里有 → 只报告不自动清,光这一条不产生写动作", () => {
  const sections = [docSection({
    entryKey: "v0.2.x", status: "filming",
    cards: [{ cardKey: "env-governance", title: "环境治理", body: "内容", line: 2 }],
  })];
  const entries = [dbEntry("v0.2.x", [
    { ...dbCard({ id: "env-governance", title: "环境规矩立起来" }), card_key: "env-governance", acceptance: "交付物:库里已有的判据" },
  ])];

  const { plan, writes } = buildPlan(sections, entries);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.drift, []);
  assert.equal(writes.length, 0, "acceptanceExtras 是报告项,不触发写库");
  assert.deepEqual(plan.acceptanceExtras, [{ section: "v0.2.x", cardKey: "env-governance", title: "环境规矩立起来" }]);
});

test("验收(S37):新卡带验收一起追加;写入后重算无变化(幂等),报告项仍在", () => {
  const sections = [docSection({
    entryKey: "v0.2.x", status: "filming",
    cards: [{ cardKey: "intent-clarification", title: "意图澄清 grill", body: "内容", acceptance: "交付物:示例假判据", line: 2 }],
  })];
  const entries = [dbEntry("v0.2.x", [
    { ...dbCard({ id: "legacy-extra", title: "文档没有的旧卡" }), card_key: "legacy-extra", acceptance: "交付物:旧卡库里验收" },
  ])];

  const first = buildPlan(sections, entries);
  assert.deepEqual(first.plan.errors, []);
  assert.equal(first.writes.length, 1);
  const added = first.writes[0]!.payload.cards.find((card) => card.card_key === "intent-clarification")!;
  assert.equal(added.acceptance, "交付物:示例假判据", "新卡验收随卡入库");
  assert.equal(added.category, "feature");

  const applied = [dbEntry("v0.2.x", first.writes[0]!.payload.cards as unknown as Array<Record<string, unknown>>)];
  const second = buildPlan(sections, applied);
  assert.equal(second.writes.length, 0, "连跑两次,第二次必须无变化(报告项不触发写)");
  assert.equal(second.plan.extras.length, 1, "旧卡报告项仍在");
  assert.deepEqual(second.plan.acceptanceExtras, [], "旧卡仍在库里且验收原样保留——文档没提它,不算验收漂移");
});
