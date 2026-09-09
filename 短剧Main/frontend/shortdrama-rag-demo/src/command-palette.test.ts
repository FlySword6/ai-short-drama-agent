/* ============================================================
   command-palette.test.ts — ⌘K 命令面板(S30)验收断言
   ① config 归一:groups/copy 蛇形驼峰双吃、脏行丢弃、sort 排序
   ② 指令过滤:context/requires 显隐 + 查询匹配 + 空组整组不出
   ③ 选中态机 moveActiveRow:环形、空列表、无选中起步
   ④ 搜索归一与行模型:五组落点 hitPath、行 id/标签兜底
   ⑤ demo 搜索:四组过滤、场恒空、每组上限 5
   ⑥ 指令注册表:五 id 注册、显隐、落点导航、未注册报 false
   ⑦ demo fixture ↔ 迁移 026 防漂移(含指令 id 与注册表互查)
   ⑧ 接线源码断言:组件键盘/aria/焦点、app.tsx ⌘K 绑定、三处深链
   ⑨ 文案红线:兜底/demo/种子文案无破折号、无「暂无数据」
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COMMAND_PALETTE_GROUPS_FAILED_BANNER,
  DEFAULT_COMMAND_PALETTE_COPY,
  DEMO_PALETTE_PER_GROUP_LIMIT,
  EMPTY_SEARCH_RESULTS,
  commandPaletteCopyFromUnknown,
  commandPaletteGroupsFromUnknown,
  commandPaletteHitPath,
  commandPaletteSearchFromUnknown,
  commandRows,
  commandVisible,
  filterPaletteGroups,
  moveActiveRow,
  searchDemoFixtures,
  searchResultRows,
  type CommandPaletteGroup,
  type CommandPaletteSearchResults,
} from "./command-palette";
import { COMMAND_IDS, commandAvailable, commandRegistered, runPaletteCommand, type CommandExecutionContext } from "./command-registry";
import { demoCommandPaletteCopy, demoCommandPaletteGroups } from "./demo";
import type { Capabilities } from "./operations";
import type { CapabilitiesState } from "./capabilities-state";
import { settingsSectionFromSearch, settingsSectionPath } from "./pages/settings-page";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/* ---------- ① config 归一 ---------- */

test("groups 归一:蛇形 wire 按 sort 排序,字段全收", () => {
  const groups = commandPaletteGroupsFromUnknown({
    entries: [
      {
        kind: "command_palette_group",
        entry_key: "b",
        status: "published",
        sort: 2,
        payload: { title: "后场", items: [{ command: "nav.settings", label: "打开设置" }] },
      },
      {
        kind: "command_palette_group",
        entry_key: "a",
        status: "published",
        sort: 1,
        payload: {
          title: "开拍",
          note: "从这儿起",
          items: [{ command: "action.create_shot", label: "新建分镜", hint: "加一条镜头", keywords: ["xjfj", 1, "镜头"], context: "project", requires: "admin" }],
        },
      },
    ],
  });
  assert.deepEqual(groups.map((group) => group.key), ["a", "b"]);
  const first = groups[0]!;
  assert.equal(first.title, "开拍");
  assert.equal(first.note, "从这儿起");
  assert.deepEqual(first.items[0], {
    command: "action.create_shot",
    label: "新建分镜",
    hint: "加一条镜头",
    keywords: ["xjfj", "镜头"],
    context: "project",
    requires: "admin",
  });
  const second = groups[1]!;
  assert.deepEqual(second.items[0]!.keywords, []);
  assert.equal(second.items[0]!.context, undefined);
  assert.equal(second.items[0]!.requires, undefined);
});

test("groups 归一:非 published、非面板 kind、缺标题、空 items 一律丢弃", () => {
  const groups = commandPaletteGroupsFromUnknown({
    entries: [
      { kind: "command_palette_group", entry_key: "draft", status: "draft", sort: 1, payload: { title: "草稿", items: [{ command: "c", label: "l" }] } },
      { kind: "release_plan", entry_key: "other", status: "published", sort: 2, payload: { title: "别的", items: [{ command: "c", label: "l" }] } },
      { kind: "command_palette_group", entry_key: "empty", status: "published", sort: 3, payload: { title: "空组", items: [] } },
      { kind: "command_palette_group", entry_key: "notitle", status: "published", sort: 4, payload: { items: [{ command: "c", label: "l" }] } },
      { kind: "command_palette_group", entry_key: "baditem", status: "published", sort: 5, payload: { title: "坏行", items: [{ label: "没指令" }] } },
      "junk",
    ],
  });
  assert.deepEqual(groups, []);
});

test("copy 归一:蛇形驼峰双吃;缺任一字段返回 null", () => {
  const snake = commandPaletteCopyFromUnknown({
    entries: [{
      kind: "command_palette_copy",
      entry_key: "default",
      status: "published",
      sort: 1,
      payload: {
        placeholder: "搜",
        empty_results: "空",
        load_failed: "挂",
        search_group_labels: { projects: "项目", episodes: "剧集", scenes: "场", shots: "分镜", assets: "资产" },
      },
    }],
  });
  assert.deepEqual(snake, {
    placeholder: "搜",
    emptyResults: "空",
    loadFailed: "挂",
    searchGroupLabels: { projects: "项目", episodes: "剧集", scenes: "场", shots: "分镜", assets: "资产" },
  });
  const camel = commandPaletteCopyFromUnknown({
    entries: [{
      kind: "command_palette_copy",
      entryKey: "default",
      status: "published",
      sort: 1,
      payload: {
        placeholder: "搜",
        emptyResults: "空",
        loadFailed: "挂",
        searchGroupLabels: { projects: "项目", episodes: "剧集", scenes: "场", shots: "分镜", assets: "资产" },
      },
    }],
  });
  assert.deepEqual(camel, snake);
  const missingLabel = commandPaletteCopyFromUnknown({
    entries: [{
      kind: "command_palette_copy",
      entry_key: "default",
      status: "published",
      sort: 1,
      payload: { placeholder: "搜", empty_results: "空", load_failed: "挂", search_group_labels: { projects: "项目" } },
    }],
  });
  assert.equal(missingLabel, null);
  assert.equal(commandPaletteCopyFromUnknown({ entries: [] }), null);
  assert.equal(commandPaletteCopyFromUnknown(null), null);
});

/* ---------- ② 指令过滤 ---------- */

const FILTER_GROUPS: CommandPaletteGroup[] = [
  {
    key: "production",
    title: "开拍",
    sort: 1,
    items: [
      { command: "action.create_project", label: "新建项目", hint: "开一部新戏", keywords: ["xjxm", "立项"] },
      { command: "action.create_shot", label: "新建分镜", keywords: [], context: "project" },
    ],
  },
  {
    key: "back_office",
    title: "后场",
    sort: 2,
    items: [{ command: "nav.admin", label: "管理后台", keywords: ["houtai"], requires: "admin" }],
  },
];

test("commandVisible:project 上下文与 admin 门槛各自独立", () => {
  const projectItem = FILTER_GROUPS[0]!.items[1]!;
  const adminItem = FILTER_GROUPS[1]!.items[0]!;
  assert.equal(commandVisible(projectItem, { inProject: false, canAdmin: true }), false);
  assert.equal(commandVisible(projectItem, { inProject: true, canAdmin: false }), true);
  assert.equal(commandVisible(adminItem, { inProject: true, canAdmin: false }), false);
  assert.equal(commandVisible(adminItem, { inProject: false, canAdmin: true }), true);
});

test("filterPaletteGroups:空查询=全量可见;查询匹配 label/hint/keywords;空组整组不出", () => {
  const memberOutside = { inProject: false, canAdmin: false };
  const visible = filterPaletteGroups(FILTER_GROUPS, "", memberOutside);
  assert.deepEqual(visible.map((group) => group.key), ["production"]);
  assert.deepEqual(visible[0]!.items.map((item) => item.command), ["action.create_project"]);

  const adminInside = { inProject: true, canAdmin: true };
  const adminVisible = filterPaletteGroups(FILTER_GROUPS, "", adminInside);
  assert.deepEqual(adminVisible.map((group) => group.key), ["production", "back_office"]);
  assert.equal(adminVisible[0]!.items.length, 2);
  assert.equal(adminVisible[1]!.items.length, 1);

  const byKeyword = filterPaletteGroups(FILTER_GROUPS, "立项", memberOutside);
  assert.deepEqual(byKeyword.map((group) => group.key), ["production"]);
  assert.deepEqual(byKeyword[0]!.items.map((item) => item.command), ["action.create_project"]);

  const byHint = filterPaletteGroups(FILTER_GROUPS, "新戏", adminInside);
  assert.deepEqual(byHint[0]!.items.map((item) => item.command), ["action.create_project"]);

  assert.deepEqual(filterPaletteGroups(FILTER_GROUPS, "不存在的词", adminInside), []);
});

/* ---------- ③ 选中态机 ---------- */

test("moveActiveRow:空列表恒 -1;无选中 ↓ 到首行 ↑ 到末行;两端回卷", () => {
  assert.equal(moveActiveRow(0, 1, 0), -1);
  assert.equal(moveActiveRow(-1, -1, 0), -1);
  assert.equal(moveActiveRow(-1, 1, 3), 0);
  assert.equal(moveActiveRow(-1, -1, 3), 2);
  assert.equal(moveActiveRow(1, 1, 3), 2);
  assert.equal(moveActiveRow(2, 1, 3), 0);
  assert.equal(moveActiveRow(0, -1, 3), 2);
});

/* ---------- ④ 搜索归一与行模型 ---------- */

test("commandPaletteHitPath:五组落点与路由合同一致,id 做 URI 编码", () => {
  assert.equal(commandPaletteHitPath("projects", { id: "p1" }), "/projects/p1");
  assert.equal(commandPaletteHitPath("episodes", { id: "e1", projectId: "p1" }), "/projects/p1/storyboards?episode=e1");
  assert.equal(commandPaletteHitPath("scenes", { id: "s1", projectId: "p1", episodeId: "e1" }), "/projects/p1/storyboards?episode=e1");
  assert.equal(commandPaletteHitPath("shots", { id: "sh1", projectId: "p1", episodeId: "e1" }), "/projects/p1/storyboards/e1/shots/sh1");
  assert.equal(commandPaletteHitPath("assets", { id: "a1", projectId: "p1" }), "/projects/p1/assets/a1");
  assert.equal(commandPaletteHitPath("projects", { id: "p 1" }), "/projects/p%201");
});

test("commandPaletteSearchFromUnknown:蛇形 wire 归一,脏行丢弃,垃圾输入回空组", () => {
  const results = commandPaletteSearchFromUnknown({
    projects: [{ id: "p1", name: "《戏》", description: "desc" }, { name: "没 id" }],
    episodes: [{ id: "e1", project_id: "p1", episode_no: 3, name: "第三集" }, { id: "e2", project_id: "p1", episode_no: 1.5, name: "坏号" }],
    scenes: [{ id: "s1", project_id: "p1", episode_id: "e1", scene_no: 2, name: "夜戏" }],
    shots: [{ id: "sh1", project_id: "p1", episode_id: "e1", shot_code: "SC01-01", title: "推门" }],
    assets: [{ id: "a1", project_id: "p1", name: "hero.png", display_name: "女主定妆", asset_kind: "image" }],
  });
  assert.equal(results.projects.length, 1);
  assert.deepEqual(results.projects[0], { id: "p1", name: "《戏》", description: "desc" });
  assert.equal(results.episodes.length, 1);
  assert.deepEqual(results.episodes[0], { id: "e1", projectId: "p1", episodeNo: 3, name: "第三集" });
  assert.deepEqual(results.scenes[0], { id: "s1", projectId: "p1", episodeId: "e1", sceneNo: 2, name: "夜戏" });
  assert.deepEqual(results.shots[0], { id: "sh1", projectId: "p1", episodeId: "e1", shotCode: "SC01-01", title: "推门" });
  assert.deepEqual(results.assets[0], { id: "a1", projectId: "p1", name: "hero.png", displayName: "女主定妆", assetKind: "image" });
  const camel = commandPaletteSearchFromUnknown({ episodes: [{ id: "e1", projectId: "p1", episodeNo: 1, name: "一" }] });
  assert.equal(camel.episodes.length, 1);
  assert.deepEqual(commandPaletteSearchFromUnknown(null), EMPTY_SEARCH_RESULTS);
  assert.deepEqual(commandPaletteSearchFromUnknown("junk"), EMPTY_SEARCH_RESULTS);
});

test("searchResultRows/commandRows:行 id 稳定,标签按兜底顺序取", () => {
  const results: CommandPaletteSearchResults = {
    projects: [{ id: "p1", name: "《戏》", description: null }],
    episodes: [{ id: "e1", projectId: "p1", episodeNo: 3, name: "第三集" }],
    scenes: [{ id: "s1", projectId: "p1", episodeId: "e1", sceneNo: 2, name: "夜戏" }],
    shots: [{ id: "sh1", projectId: "p1", episodeId: "e1", shotCode: "SC01-01", title: "" }],
    assets: [{ id: "a1", projectId: "p1", name: "hero.png", displayName: "", assetKind: "image" }],
  };
  const rows = searchResultRows(results);
  assert.deepEqual(rows.map((row) => row.id), ["hit-projects-p1", "hit-episodes-e1", "hit-scenes-s1", "hit-shots-sh1", "hit-assets-a1-p1"]);
  const shotRow = rows[3]!;
  assert.equal(shotRow.kind === "hit" ? shotRow.label : "", "SC01-01");
  const assetRow = rows[4]!;
  assert.equal(assetRow.kind === "hit" ? assetRow.label : "", "hero.png");
  assert.equal(assetRow.kind === "hit" ? assetRow.path : "", "/projects/p1/assets/a1");

  const commands = commandRows([FILTER_GROUPS[0]!]);
  assert.deepEqual(commands.map((row) => row.id), ["cmd-production-action.create_project", "cmd-production-action.create_shot"]);
  assert.equal(commands[0]!.kind === "command" ? commands[0]!.groupTitle : "", "开拍");
});

/* ---------- ⑤ demo 搜索 ---------- */

test("searchDemoFixtures:四组过滤、场恒空、空查询回空、每组上限 5", () => {
  const fixtures = {
    projects: Array.from({ length: 7 }, (_, index) => ({ id: `p${index}`, name: `夜奔 ${index}`, description: null })),
    episodes: [
      { id: "e1", project_id: "p0", episode_no: 1, name: "夜奔第一集" },
      { id: "e2", project_id: "p0", episode_no: 2, name: "日戏" },
    ],
    shots: [
      { id: "sh1", episode_id: "e1", shot_no: "SC01-01", title: "推门夜奔" },
      { id: "sh2", episode_id: "e9", shot_no: "SC09-09", title: "夜奔孤儿" },
    ],
    projectAssets: [
      { project_id: "p0", asset: { id: "a1", name: "hero.png", display_name: "夜奔女主", asset_kind: "image" } },
      { project_id: "p1", asset: { id: "a1", name: "hero.png", display_name: "夜奔女主", asset_kind: "image" } },
      { project_id: "p2" },
    ],
  };
  const results = searchDemoFixtures("夜奔", fixtures);
  assert.equal(results.projects.length, DEMO_PALETTE_PER_GROUP_LIMIT);
  assert.deepEqual(results.episodes.map((hit) => hit.id), ["e1"]);
  assert.deepEqual(results.scenes, []);
  assert.deepEqual(results.shots.map((hit) => hit.id), ["sh1", "sh2"]);
  assert.equal(results.shots[1]!.projectId, "");
  assert.deepEqual(results.assets.map((hit) => `${hit.id}@${hit.projectId}`), ["a1@p0", "a1@p1"]);

  const byShotNo = searchDemoFixtures("sc01", fixtures);
  assert.deepEqual(byShotNo.shots.map((hit) => hit.id), ["sh1"]);

  assert.deepEqual(searchDemoFixtures("  ", fixtures), EMPTY_SEARCH_RESULTS);
});

/* ---------- ⑥ 指令注册表 ---------- */

const ADMIN_CAPS: Capabilities = { platformRole: "admin", allowMemberCreateProject: true, projects: [], permissions: [] };
const MEMBER_CAPS: Capabilities = { platformRole: "member", allowMemberCreateProject: false, projects: [], permissions: [] };

function ctxWith(caps: Capabilities, projectId: string | null): { ctx: CommandExecutionContext; paths: string[] } {
  return ctxWithState({ status: "ready", capabilities: caps }, projectId);
}

function ctxWithState(capabilities: CapabilitiesState, projectId: string | null): { ctx: CommandExecutionContext; paths: string[] } {
  const paths: string[] = [];
  return { ctx: { projectId, capabilities, navigate: (path) => paths.push(path) }, paths };
}

test("注册表:六个 id 与迁移播种一一对应,未知 id 不注册", () => {
  // 2026-08-02 Fable:nav.queue 第六项(批次一放行单①,播种迁移 042)。
  assert.deepEqual([...COMMAND_IDS], ["action.create_project", "action.create_shot", "nav.settings", "nav.releases", "nav.admin", "nav.queue"]);
  assert.ok(commandRegistered("nav.admin"));
  assert.equal(commandRegistered("action.generate_video"), false);
});

test("commandAvailable:未注册、缺项目上下文、缺 admin 各挡一道", () => {
  const shotItem = { command: "action.create_shot", label: "新建分镜", keywords: [], context: "project" as const };
  const adminItem = { command: "nav.admin", label: "管理后台", keywords: [], requires: "admin" as const };
  const bogus = { command: "action.generate_video", label: "提交生成", keywords: [] };
  assert.equal(commandAvailable(shotItem, ctxWith(MEMBER_CAPS, null).ctx), false);
  assert.equal(commandAvailable(shotItem, ctxWith(MEMBER_CAPS, "p1").ctx), true);
  assert.equal(commandAvailable(adminItem, ctxWith(MEMBER_CAPS, "p1").ctx), false);
  assert.equal(commandAvailable(adminItem, ctxWith(ADMIN_CAPS, null).ctx), true);
  assert.equal(commandAvailable(bogus, ctxWith(ADMIN_CAPS, "p1").ctx), false);
  /* 权限没读到时 admin 指令同样不上架——但那是「没读到」,面板底部的失败位负责说清,
     不许把它当成「你不是管理员」的证据。 */
  assert.equal(commandAvailable(adminItem, ctxWithState({ status: "loading" }, null).ctx), false);
  assert.equal(commandAvailable(adminItem, ctxWithState({ status: "unavailable", reload: () => {} }, null).ctx), false);
});

test("runPaletteCommand:五条指令落点正确,未注册/缺上下文返回 false 且不导航", () => {
  const create = ctxWith(MEMBER_CAPS, null);
  assert.equal(runPaletteCommand("action.create_project", create.ctx), true);
  assert.deepEqual(create.paths, ["/projects?create=1"]);

  const shot = ctxWith(MEMBER_CAPS, "p 1");
  assert.equal(runPaletteCommand("action.create_shot", shot.ctx), true);
  assert.deepEqual(shot.paths, ["/projects/p%201/storyboards?addShot=1"]);

  const noProject = ctxWith(MEMBER_CAPS, null);
  assert.equal(runPaletteCommand("action.create_shot", noProject.ctx), false);
  assert.deepEqual(noProject.paths, []);

  const nav = ctxWith(ADMIN_CAPS, null);
  assert.equal(runPaletteCommand("nav.settings", nav.ctx), true);
  assert.equal(runPaletteCommand("nav.releases", nav.ctx), true);
  assert.equal(runPaletteCommand("nav.admin", nav.ctx), true);
  assert.deepEqual(nav.paths, ["/settings", "/settings?section=releases", "/admin"]);

  const unknown = ctxWith(ADMIN_CAPS, "p1");
  assert.equal(runPaletteCommand("action.generate_video", unknown.ctx), false);
  assert.deepEqual(unknown.paths, []);
});

/* ---------- ⑦ demo fixture ↔ 迁移 026 防漂移 ---------- */

interface SeedRow {
  kind: string;
  entryKey: string;
  sort: number;
  payload: Record<string, unknown>;
}

function seedRows(sql: string): SeedRow[] {
  const pattern = /\('[0-9a-f-]+',\s*'(command_palette_group|command_palette_copy)',\s*'([^']+)',\s*'published',\s*(\d+),\s*'(\{[^']*\})'::jsonb/g;
  const rows: SeedRow[] = [];
  for (const match of sql.matchAll(pattern)) {
    rows.push({ kind: match[1]!, entryKey: match[2]!, sort: Number(match[3]), payload: JSON.parse(match[4]!) as Record<string, unknown> });
  }
  return rows;
}

test("迁移 026 三行种子与 demo fixture 逐字段一致", () => {
  const rows = seedRows(source("../../../migrations/026_command_palette.sql"));
  assert.equal(rows.length, 3, "迁移 026 应恰好三行种子");
  for (const group of demoCommandPaletteGroups) {
    const row = rows.find((item) => item.kind === "command_palette_group" && item.entryKey === group.key);
    assert.ok(row, `迁移 026 缺分组 ${group.key}`);
    assert.equal(row.sort, group.sort, `${group.key} 排序漂移`);
    assert.deepEqual(row.payload, { title: group.title, note: group.note, items: group.items }, `${group.key} 内容漂移`);
  }
  const copyRow = rows.find((item) => item.kind === "command_palette_copy");
  assert.ok(copyRow, "迁移 026 缺文案行");
  assert.deepEqual(copyRow.payload, {
    placeholder: demoCommandPaletteCopy.placeholder,
    empty_results: demoCommandPaletteCopy.emptyResults,
    load_failed: demoCommandPaletteCopy.loadFailed,
    search_group_labels: demoCommandPaletteCopy.searchGroupLabels,
  }, "面板文案漂移");
});

test("迁移播种的指令 id 与注册表互查:双向一一对应", () => {
  // 2026-08-02 Fable:播种=026(INSERT 行)+042(UPDATE 拼接)联集;
  // 042 类增量播种不是行插入,seedRows 读不到,改为对 SQL 源抽 "command" 令牌——两种播种风格都覆盖。
  const seedSql =
    source("../../../migrations/026_command_palette.sql") +
    source("../../../migrations/042_command_palette_nav_queue.sql");
  const seeded = [...new Set([...seedSql.matchAll(/"command"\s*:\s*"([a-z_.]+)"/g)].map((m) => m[1]!))];
  assert.deepEqual(seeded.slice().sort(), [...COMMAND_IDS].sort());
  for (const command of seeded) {
    assert.ok(commandRegistered(command), `种子指令未注册:${command}`);
  }
});

/* ---------- ⑧ 接线源码断言 ---------- */

test("组件:键盘主交互、aria 组合框、焦点出/回归位、防抖与竞态防旧盖新", () => {
  const component = source("./components/command-palette.tsx");
  for (const needle of [
    'event.key === "ArrowDown"',
    'event.key === "ArrowUp"',
    'event.key === "Enter"',
    'event.key === "Escape"',
    'role="combobox"',
    "aria-activedescendant",
    'role="listbox"',
    'role="option"',
    "onOpenAutoFocus",
    "onCloseAutoFocus",
    "restoreFocusRef",
    "SEARCH_DEBOUNCE_MS = 150",
    "searchSeq",
    "COMMAND_PALETTE_GROUPS_FAILED_BANNER",
    "DEFAULT_COMMAND_PALETTE_COPY",
  ]) {
    assert.ok(component.includes(needle), `command-palette.tsx 缺:${needle}`);
  }
});

test("app.tsx:⌘K/Ctrl+K 全局绑定、头部按钮、demo fixture 接线(S46 B-6 起判定收口 shortcut-hint)", () => {
  const app = source("./app.tsx");
  for (const needle of [
    "isPaletteToggleEvent",
    "searchDemoFixtures",
    "demoCommandPaletteGroups",
    "demoCommandPaletteCopy",
    "onOpenPalette",
  ]) {
    assert.ok(app.includes(needle), `app.tsx 缺:${needle}`);
  }
  const shortcutHint = source("./shortcut-hint.ts");
  assert.ok(shortcutHint.includes("event.metaKey || event.ctrlKey"), "快捷键判定未收口 shortcut-hint.ts");
  assert.ok(shortcutHint.includes('event.key.toLowerCase() === "k"'), "⌘K 判定丢失");
  assert.ok(app.includes("<CommandPalette"), "app.tsx 未渲染 <CommandPalette");
});

test("深链三处:?create=1 开新建弹窗、?section= 设置页签、?addShot=1 添加分镜", () => {
  const globalPages = source("./pages/global-pages.tsx");
  assert.ok(globalPages.includes('.get("create")'), "项目列表缺 create 深链");
  assert.ok(globalPages.includes("setShowCreate(true)"), "create 深链未开既有弹窗");

  const settings = source("./pages/settings-page.tsx");
  assert.ok(settings.includes("settingsSectionFromSearch"), "设置页缺 section 解析");
  assert.ok(settings.includes('URLSearchParams(search).get("section")'), "设置页缺 ?section= 读取");

  const projectPages = source("./pages/project-pages.tsx");
  assert.ok(projectPages.includes('.get("addShot")'), "分镜页缺 addShot 深链");
  assert.ok(projectPages.includes("addShotDeepLinkHandled"), "addShot 深链缺防重跑锁");
});

test("api.ts:面板配置与搜索两方法走本仓 API 与前端归一", () => {
  const api = source("./api.ts");
  for (const needle of ["commandPaletteConfig", "commandPaletteSearch", "/command-palette/search", "commandPaletteGroupsFromUnknown", "commandPaletteCopyFromUnknown", "commandPaletteSearchFromUnknown"]) {
    assert.ok(api.includes(needle), `api.ts 缺:${needle}`);
  }
});

test("设置页深链解析:?section= 校验合法 key,缺省/未知回 defaults", () => {
  assert.equal(settingsSectionFromSearch("?section=releases"), "releases");
  assert.equal(settingsSectionFromSearch("?section=api"), "api");
  assert.equal(settingsSectionFromSearch("?section=bogus"), "defaults");
  assert.equal(settingsSectionFromSearch(""), "defaults");
  assert.equal(settingsSectionPath("defaults"), "/settings");
  assert.equal(settingsSectionPath("releases"), "/settings?section=releases");
});

/* ---------- ⑨ 文案红线 ---------- */

test("面板文案(兜底/demo/种子/横幅)无破折号、无「暂无数据」", () => {
  const corpus = [
    JSON.stringify(DEFAULT_COMMAND_PALETTE_COPY),
    JSON.stringify(demoCommandPaletteGroups),
    JSON.stringify(demoCommandPaletteCopy),
    COMMAND_PALETTE_GROUPS_FAILED_BANNER,
    source("../../../migrations/026_command_palette.sql"),
  ].join("\n");
  assert.ok(!corpus.includes("——"), "面板文案踩破折号红线");
  assert.ok(!corpus.includes("暂无数据"), "面板文案踩「暂无数据」红线");
});
