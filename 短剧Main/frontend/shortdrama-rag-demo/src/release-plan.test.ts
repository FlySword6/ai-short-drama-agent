/* ============================================================
   release-plan.test.ts — 版本计划机制(S23)纯逻辑与接口归一验收断言
   ① 呈现文案映射与卡片版本语(五态口径不变)
   ② Pi「功能预告」轮播:只承诺近期(已上线/远景不进)、格式、环形切换、可关
   ③ 服务端条目归一:蛇形/驼峰双吃、脏行丢弃、负载拼装可往返
   内容合同(5 段 26 卡等)在 test/config-entries-release-plan.test.ts 冻结,不在此重复。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIG_ENTRY_STATUS_LABEL,
  PI_TEASER_DISMISS_KEY,
  PI_TEASER_ROTATE_MS,
  RELEASE_CATEGORY_LABEL,
  RELEASE_PREVIEW_RULE,
  RELEASE_STATUS_LABEL,
  SETTINGS_INTRO,
  buildTeaserLines,
  cardShownOnPreview,
  configEntriesFromUnknown,
  configEntryFromUnknown,
  dismissPiTeaser,
  historyPayloadFromView,
  nextTeaserIndex,
  piTeaserDismissed,
  previewCardsOf,
  previewCategoryWarning,
  releaseHistoryFromEntry,
  releaseSectionFromEntry,
  releaseWindow,
  sectionPayloadFromView,
  type ConfigEntry,
  type ReleaseCard,
  type ReleaseSection,
} from "./release-plan";

function sectionFixture(): ReleaseSection {
  return {
    version: "v0.2",
    title: "v0.2",
    status: "scheduled",
    note: "接口冻结在前，执行链验证在后。",
    cards: [
      {
        id: "pi-collab",
        title: "Pi 协作",
        tagline: "拆剧本、备参考太费手？——对话说清楚，Pi 帮你备好；付费生成永远由你亲手点。",
        status: "scheduled",
        category: "feature",
        release: "v0.2",
        teaser: "对话拆剧本、提前备好参考、@素材直达提示词",
      },
    ],
  };
}

function entryFixture(overrides: Partial<ConfigEntry> = {}): ConfigEntry {
  return {
    id: "entry-1",
    kind: "release_section",
    entryKey: "v0.2",
    status: "published",
    sort: 3,
    payload: sectionPayloadFromView(sectionFixture()),
    source: "seed-023",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

/* ---------- ① 文案映射与版本语 ---------- */

test("状态五态与分类三值标签口径不变;条目治理状态有中文标签", () => {
  assert.deepEqual(RELEASE_STATUS_LABEL, { live: "已上线", filming: "开发中", scheduled: "已定档", concept: "规划中", vision: "远景" });
  assert.deepEqual(RELEASE_CATEGORY_LABEL, { feature: "新功能", improvement: "优化", fix: "修复" });
  assert.deepEqual(CONFIG_ENTRY_STATUS_LABEL, { draft: "草稿", published: "显示中", archived: "已归档" });
  assert.equal(SETTINGS_INTRO, "每个版本聚焦解决一类真实痛点，做好一个上线一个。");
});

test("版本语:已上线写版本号,开发中/已定档写预计上线,规划中写按证据排期,远景写看准再定档", () => {
  const base = sectionFixture().cards[0]!;
  const at = (status: ReleaseCard["status"], release = "v0.2"): ReleaseCard => ({ ...base, status, release, teaser: undefined });
  assert.equal(releaseWindow(at("live", "v0.1.2")), "已上线 · v0.1.2");
  assert.equal(releaseWindow(at("filming", "v0.1.3")), "开发中 · 预计 v0.1.3 上线");
  assert.equal(releaseWindow(at("scheduled")), "已定档 · 预计 v0.2 上线");
  assert.equal(releaseWindow(at("concept", "v0.3")), "规划中 · 按证据排期");
  assert.equal(releaseWindow(at("vision", "未定档")), "远景 · 看准再定档");
});

/* ---------- ② 轮播机制 ---------- */

test("轮播句:只承诺近期(开发中/已定档/规划中),已上线与远景不进,格式「状态 · 名称——短句」", () => {
  const card = (status: ReleaseCard["status"], teaser?: string): ReleaseCard => ({
    ...sectionFixture().cards[0]!,
    id: `card-${status}`,
    title: `卡（${status}）`,
    status,
    teaser,
  });
  const sections: ReleaseSection[] = [{ ...sectionFixture(), cards: [card("live", "已上线句"), card("filming", "开发中句"), card("scheduled", "已定档句"), card("concept", "规划中句"), card("vision", "远景句"), card("filming", undefined)] }];
  const lines = buildTeaserLines(sections);
  assert.deepEqual(lines, [
    "开发中 · 卡——开发中句",
    "已定档 · 卡——已定档句",
    "规划中 · 卡——规划中句",
  ]);
  assert.ok(lines.every((line) => /^(开发中|已定档|规划中) · .+——.+$/.test(line)));
});

test("轮播切换:5s 间隔,环形推进,空列表守 0", () => {
  assert.equal(PI_TEASER_ROTATE_MS, 5000);
  assert.equal(nextTeaserIndex(0, 8), 1);
  assert.equal(nextTeaserIndex(6, 8), 7);
  assert.equal(nextTeaserIndex(7, 8), 0);
  assert.equal(nextTeaserIndex(3, 0), 0);
});

test("轮播可关:关闭写入 sessionStorage,本次会话不再出现", () => {
  assert.equal(PI_TEASER_DISMISS_KEY, "shortdrama_v011_pi_teaser_dismissed");
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
  assert.equal(piTeaserDismissed(storage), false);
  dismissPiTeaser(storage);
  assert.equal(piTeaserDismissed(storage), true);
});

/* ---------- ③ 条目归一与往返 ---------- */

test("条目归一:蛇形/驼峰双吃,非法 kind 与缺字段脏行丢弃", () => {
  const entry = configEntryFromUnknown({
    id: "e1",
    kind: "release_section",
    entry_key: "v0.2",
    status: "draft",
    sort: 7,
    payload: { title: "v0.2" },
    source: "admin",
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T01:00:00.000Z",
  });
  assert.ok(entry);
  assert.equal(entry.entryKey, "v0.2");
  assert.equal(entry.status, "draft");
  assert.equal(entry.updatedAt, "2026-07-26T01:00:00.000Z");
  const camel = configEntryFromUnknown({ id: "e2", kind: "release_history_entry", entryKey: "v0.1.1", sort: 2, payload: {} });
  assert.ok(camel && camel.kind === "release_history_entry" && camel.status === "published");
  assert.equal(configEntryFromUnknown({ kind: "release_section", entry_key: "x" }), null);
  assert.equal(configEntryFromUnknown({ id: "e3", kind: "unknown_kind", entry_key: "x" }), null);
  assert.equal(configEntryFromUnknown("junk"), null);
  assert.deepEqual(configEntriesFromUnknown({ entries: ["junk", { id: "e4", kind: "release_section", entry_key: "v0.3" }] }).map((item) => item.id), ["e4"]);
  assert.deepEqual(configEntriesFromUnknown(null), []);
});

test("段归一:版本号取业务键;段状态非法整段丢弃,脏卡剔除,无 teaser 不补空串", () => {
  const section = releaseSectionFromEntry(entryFixture());
  assert.deepEqual(section, sectionFixture());
  assert.equal(releaseSectionFromEntry(entryFixture({ kind: "release_history_entry" })), null);
  assert.equal(releaseSectionFromEntry(entryFixture({ payload: { title: "v0.2", status: "doing", cards: [] } })), null);
  const withDirty = releaseSectionFromEntry(entryFixture({
    payload: {
      title: "v0.2",
      status: "scheduled",
      note: "注",
      cards: [
        { id: "ok", title: "好卡", tagline: "有价值", status: "scheduled", category: "feature", release: "v0.2" },
        { id: "bad", title: "缺字段" },
        { id: "bad2", title: "状态错", tagline: "x", status: "doing", category: "feature", release: "v0.2" },
      ],
    },
  }));
  assert.ok(withDirty);
  assert.deepEqual(withDirty.cards.map((card) => card.id), ["ok"]);
  assert.ok(!("teaser" in withDirty.cards[0]!));
});

test("历史归一:日期/标题缺失整条丢弃,脏条目剔除", () => {
  const history = releaseHistoryFromEntry(entryFixture({
    kind: "release_history_entry",
    entryKey: "v0.1.1",
    payload: {
      date: "2026-07-22",
      title: "首个可用版本",
      items: [
        { label: "登录", category: "feature" },
        { label: "缺分类" },
        { label: "坏分类", category: "other" },
      ],
    },
  }));
  assert.deepEqual(history, {
    version: "v0.1.1",
    date: "2026-07-22",
    title: "首个可用版本",
    items: [{ label: "登录", category: "feature" }],
  });
  assert.equal(releaseHistoryFromEntry(entryFixture({ kind: "release_history_entry", payload: { title: "缺日期" } })), null);
});

test("负载拼装可往返:视图 → 服务端负载 → 归一回同一视图", () => {
  const section = sectionFixture();
  const roundTrip = releaseSectionFromEntry(entryFixture({ payload: sectionPayloadFromView(section) }));
  assert.deepEqual(roundTrip, section);
  const history = { version: "v0.1.1", date: "2026-07-22", title: "首个可用版本", items: [{ label: "登录", category: "feature" as const }] };
  const historyRoundTrip = releaseHistoryFromEntry(entryFixture({ kind: "release_history_entry", entryKey: "v0.1.1", payload: historyPayloadFromView(history) }));
  assert.deepEqual(historyRoundTrip, history);
});

/* ---------- ④ R46 预告页口径(S46 B-7):只放功能 ---------- */

test("R46:预告主体只放「新功能」类卡——优化/修复不上预告,顺序不动", () => {
  const base = sectionFixture().cards[0]!;
  const improvement: ReleaseCard = { ...base, id: "imp", category: "improvement" };
  const fix: ReleaseCard = { ...base, id: "fix", category: "fix" };
  const feature2: ReleaseCard = { ...base, id: "feat-2" };
  assert.equal(cardShownOnPreview(improvement), false);
  assert.equal(cardShownOnPreview(fix), false);
  assert.equal(cardShownOnPreview(feature2), true);
  assert.deepEqual(
    previewCardsOf({ cards: [improvement, base, fix, feature2] }).map((card) => card.id),
    [base.id, feature2.id],
  );
});

test("R46:轮播同样只承诺功能——优化/修复卡即使有短句也不进轮播", () => {
  const base = sectionFixture().cards[0]!;
  const improvement: ReleaseCard = { ...base, id: "imp", title: "优化卡", category: "improvement", teaser: "优化句" };
  const sections: ReleaseSection[] = [{ ...sectionFixture(), cards: [improvement, base] }];
  const lines = buildTeaserLines(sections);
  assert.equal(lines.length, 1);
  assert.ok(!lines.some((line) => line.includes("优化句")), "优化类卡进了轮播");
});

test("R46:口径成文——编辑面预警只打非功能类,功能类不预警", () => {
  assert.ok(RELEASE_PREVIEW_RULE.includes("只放功能"), "口径未成文");
  assert.ok(RELEASE_PREVIEW_RULE.includes("bug 修复"), "口径未点名 bug fix");
  assert.equal(previewCategoryWarning("feature"), null);
  assert.ok(previewCategoryWarning("improvement")?.includes("不会显示在预告页"));
  assert.ok(previewCategoryWarning("fix")?.includes("不会显示在预告页"));
});
