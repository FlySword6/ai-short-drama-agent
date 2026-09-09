/* ============================================================
   s15-lane-vocabulary.test.ts — S15-B 参考栏词表驱动验收（R9 创作词表不冻结）

   锁定四件事：
   1. 内置词表=八条三域（S14 七条零漂移 + K2 内置第八条「色卡」：
      分组/排序/投影/图标/动作特例全对照）；
   2. loadLaneVocabulary 是唯一取数口：fetcher 可注入、失败回落内置；
   3. mock 第九条「情绪板」进词表（一行数据新增，零改码）：
      分组/投影/图标回退/动作兜底/空清单/资产自动分桶全部自动生效；
   4. 源码断言：词条不再 hardcode 在 reference-lanes.ts，iconKey 走映射。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { ImageSquare, Palette, User } from "@phosphor-icons/react";
import {
  BUILTIN_LANE_VOCABULARY,
  assetKindWithAncestors,
  hasLane,
  injectLaneVocabularyForTest,
  laneDomains,
  laneEntries,
  laneEntry,
  laneIdForAssetKind,
  laneVocabularyFromApi,
  laneVocabularySnapshot,
  loadLaneVocabulary,
  resetLaneVocabularyForTest,
  type LaneVocabulary,
  type LaneVocabularyApiEntry,
  type LaneVocabularyEntry,
} from "./lane-vocabulary";
import { LANE_DOMAINS, emptyLanesState, laneDef, laneDefs, seedLanesFromRefs } from "./reference-lanes";
import { ASSET_KIND_OPTIONS } from "./components/asset-shared";
import { assetMatchesPick } from "./components/asset-pick-drawer";
import { laneActions, laneIcon } from "./components/reference-lanes";
import type { Asset, ProjectAssetRef } from "./types";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const referenceLanesLogic = readSource("./reference-lanes.ts");
const referenceLanesView = readSource("./components/reference-lanes.tsx");

afterEach(() => {
  resetLaneVocabularyForTest();
});

/* ---------- 1. 内置词表=八条三域（S14 七条 + K2 色卡） ---------- */

describe("内置词表快照（=S14 七条常量迁为数据 + K2 色卡）", () => {
  it("默认快照就是内置词表", () => {
    assert.equal(laneVocabularySnapshot(), BUILTIN_LANE_VOCABULARY);
  });

  it("八条词条按域排序：实体(角色/场景/道具)→风格(光影/色卡/运镜)→媒介(参考视频/音频)", () => {
    assert.deepEqual(
      laneEntries().map((entry) => entry.id),
      ["character", "scene", "prop", "lighting", "color_card", "camera_motion", "reference_video", "audio"],
    );
    assert.deepEqual(
      laneDomains().map((domain) => [domain.label, domain.entries.map((entry) => entry.id)]),
      [
        ["实体参考", ["character", "scene", "prop"]],
        ["风格参考", ["lighting", "color_card", "camera_motion"]],
        ["媒介参考", ["reference_video", "audio"]],
      ],
    );
  });

  it("每条词条带齐 registry+呈现字段（active/iconKey/workshop/建议）", () => {
    for (const entry of laneEntries()) {
      assert.ok(entry.active, entry.id);
      assert.ok(entry.iconKey.length > 0, entry.id);
      assert.ok(["image", "video", "director", "audio"].includes(entry.workshop), entry.id);
      assert.ok(entry.recommended.length > 0, entry.id);
      assert.ok(entry.emptyHint.length > 0, entry.id);
    }
    // 关键映射零漂移抽查（条 9 根因修复：lighting 归风格域，不混场景）
    assert.deepEqual(laneEntry("scene").roles, ["scene"]);
    assert.deepEqual(laneEntry("lighting").roles, ["style_env"]);
    assert.equal(laneEntry("character").priority, "P0");
  });

  it("reference-lanes 投影层与词表同源（laneDefs/laneDef/LANE_DOMAINS）", () => {
    assert.equal(laneDefs().length, 8);
    assert.equal(laneDef("lighting").label, "光影");
    assert.deepEqual(LANE_DOMAINS[1]!.lanes, ["lighting", "color_card", "camera_motion"]);
  });
});

/* ---------- 1.5 K2 内置第八条「色卡」（V-17/V-18：分组/排序/投影/图标） ---------- */

describe("内置第八条「色卡」（K2：风格域色彩类补齐）", () => {
  it("分组与排序：色卡进「风格参考」域，光影(sort 1)之后、运镜(顺移 sort 3)之前", () => {
    const style = laneDomains().find((domain) => domain.id === "style")!;
    assert.deepEqual(
      style.entries.map((entry) => entry.id),
      ["lighting", "color_card", "camera_motion"],
    );
    assert.equal(laneEntry("lighting").sort, 1);
    assert.equal(laneEntry("color_card").sort, 2);
    assert.equal(laneEntry("camera_motion").sort, 3, "运镜 sort 顺移 3");
  });

  it("投影：laneDef 透出呈现字段（palette 图标/emptyHint/建议/分桶预留/pickKind null）", () => {
    const def = laneDef("color_card");
    assert.equal(def.label, "色卡");
    assert.equal(def.iconKey, "palette");
    assert.equal(def.workshop, "image");
    assert.deepEqual(def.recommended, [{ key: "palette", label: "定 1 套全剧色调基准", required: false }]);
    assert.equal(def.emptyHint, "还没有色卡。从六套导演调色里选一套，全剧影调就有了锚。");
    assert.deepEqual(def.roles, ["color_card"], "roles 预留，未来资产化自动分桶");
    assert.deepEqual(def.kinds, ["color_card"], "kinds 预留，未来资产化自动分桶");
    assert.equal(laneEntry("color_card").pickKind, null, "色卡是内容词表不是资产，不开资产类型筛选槽");
  });

  it("图标：palette 已是已知 key 映射 Palette 组件，不走回退", () => {
    assert.equal(laneIcon(laneDef("color_card")).type, Palette);
  });

  it("动作：特例=「选一套色卡」toggle（挂接 prop 门控在组件渲染层，不在此表）", () => {
    const actions = laneActions(laneDef("color_card"));
    assert.deepEqual(
      actions.map((action) => [action.key, action.label]),
      [["toggle_palette", "选一套色卡"]],
    );
  });

  it("空清单/资产分桶：color_card 自动有位，role 命中即入栏", () => {
    assert.deepEqual(emptyLanesState().color_card, []);
    const state = seedLanesFromRefs([
      { id: "ref-c1", asset_id: "c1", asset: { id: "c1", role: "color_card", asset_kind: "color_card", name: "全片色卡" } as Asset } as ProjectAssetRef,
    ]);
    assert.equal(state.color_card!.length, 1, "预留 roles/kinds 使命中即入栏，零改码");
    assert.equal(state.color_card![0]!.id, "asset:c1");
  });
});

/* ---------- 2. loadLaneVocabulary 取数口 ---------- */

describe("loadLaneVocabulary 取数口（S24-C：App 层注入接口 fetcher，默认内置兜底）", () => {
  it("默认 fetcher 返回内置词表", async () => {
    const vocab = await loadLaneVocabulary();
    assert.equal(vocab, BUILTIN_LANE_VOCABULARY);
    assert.equal(laneVocabularySnapshot(), BUILTIN_LANE_VOCABULARY);
  });

  it("fetcher 可注入：远程词表替换快照", async () => {
    const remote: LaneVocabulary = {
      ...BUILTIN_LANE_VOCABULARY,
      version: "remote-test",
      entries: BUILTIN_LANE_VOCABULARY.entries.filter((entry) => entry.id !== "audio"),
    };
    const vocab = await loadLaneVocabulary({ fetcher: async () => remote });
    assert.equal(vocab.version, "remote-test");
    assert.equal(hasLane("audio"), false, "远程词表下架的词条立即生效");
  });

  it("fetcher 失败回落内置，不炸 UI", async () => {
    const vocab = await loadLaneVocabulary({
      fetcher: async () => {
        throw new Error("network down");
      },
    });
    assert.equal(vocab, BUILTIN_LANE_VOCABULARY);
    assert.equal(laneEntries().length, 8);
  });
});

/* ---------- 3. mock 第九条「情绪板」：一行数据新增，零改码 ----------
   （K2 前此节 mock 的是「色卡」；色卡已进内置第八条，注入机制验证改用新 id。） */

const MOODBOARD: LaneVocabularyEntry = {
  id: "moodboard",
  displayName: "情绪板",
  domain: "style",
  sort: 4,
  active: true,
  iconKey: "no-such-icon", // 未知 key：ICON_BY_KEY 无此映射，必须回退默认图标
  workshop: "image",
  priority: "P2",
  recommended: [{ key: "board", label: "定 1 张全场情绪板", required: false }],
  emptyHint: "还没有情绪板。可以先留空，后续再补。",
  roles: ["moodboard"],
  kinds: ["moodboard"],
};

function vocabularyWithMoodboard(): LaneVocabulary {
  return { ...BUILTIN_LANE_VOCABULARY, version: "builtin+moodboard", entries: [...BUILTIN_LANE_VOCABULARY.entries, MOODBOARD] };
}

describe("新词条「情绪板」注入（词表一行新增，组件零改）", () => {
  it("分组自动生效：情绪板进「风格参考」域尾部，实体/媒介域不变", () => {
    injectLaneVocabularyForTest(vocabularyWithMoodboard());
    const style = laneDomains().find((domain) => domain.id === "style")!;
    assert.deepEqual(
      style.entries.map((entry) => entry.id),
      ["lighting", "color_card", "camera_motion", "moodboard"],
    );
    // reference-lanes 的 LANE_DOMAINS 兼容别名同步反映新词条
    assert.deepEqual(LANE_DOMAINS[1]!.lanes, ["lighting", "color_card", "camera_motion", "moodboard"]);
    assert.deepEqual(LANE_DOMAINS[0]!.lanes, ["character", "scene", "prop"]);
    assert.equal(laneDefs().length, 9);
    assert.equal(laneDef("moodboard").label, "情绪板");
  });

  it("未知 iconKey 回退默认图标（新词条不炸 UI）；已知 key 仍映射", () => {
    injectLaneVocabularyForTest(vocabularyWithMoodboard());
    assert.equal(laneIcon(laneDef("moodboard")).type, ImageSquare, "未知 iconKey 必须回退 ImageSquare");
    assert.equal(laneIcon(laneDef("character")).type, User, "已知 iconKey 映射不变");
  });

  it("无特例动作的新词条按 workshop 兜底给默认功能页入口", () => {
    injectLaneVocabularyForTest(vocabularyWithMoodboard());
    const actions = laneActions(laneDef("moodboard"));
    assert.deepEqual(
      actions.map((action) => [action.key, action.label]),
      [["generate", "去图片页"]],
      "workshop=image 的新词条兜底动作=去图片页",
    );
    // 特例组不受注入影响
    assert.equal(laneActions(laneDef("camera_motion"))[0]!.label, "写机位描述");
  });

  it("空清单/资产分桶自动有位：role 命中新词条即入栏", () => {
    injectLaneVocabularyForTest(vocabularyWithMoodboard());
    const empty = emptyLanesState();
    assert.deepEqual(empty.moodboard, [], "空清单自动含新词条位");
    const state = seedLanesFromRefs([
      { id: "ref-m1", asset_id: "m1", asset: { id: "m1", role: "moodboard", asset_kind: "moodboard", name: "开场情绪" } as Asset } as ProjectAssetRef,
    ]);
    assert.equal(state.moodboard!.length, 1, "新词条自动分桶，零改码");
    assert.equal(state.moodboard![0]!.id, "asset:m1");
  });

  it("active=false 的词条不上界面（词表启停也是数据）", () => {
    injectLaneVocabularyForTest({
      ...vocabularyWithMoodboard(),
      entries: vocabularyWithMoodboard().entries.map((entry) => (entry.id === "moodboard" ? { ...entry, active: false } : entry)),
    });
    assert.equal(hasLane("moodboard"), false);
    assert.equal(laneDefs().length, 8);
    assert.equal("moodboard" in emptyLanesState(), false);
    assert.throws(() => laneEntry("moodboard"), /未知参考栏/);
  });
});

/* ---------- 4. 源码断言：词条不再 hardcode，iconKey 走映射 ---------- */

describe("源码层：hardcode 已摘除（R9）", () => {
  it("reference-lanes.ts 不再定义词条本体，唯一取数口=lane-vocabulary", () => {
    assert.ok(referenceLanesLogic.includes('from "./lane-vocabulary"'), "逻辑层未接词表");
    assert.ok(!referenceLanesLogic.includes("身份定妆图"), "词条建议文案仍 hardcode 在逻辑层");
    assert.ok(!referenceLanesLogic.includes("还没有角色参考"), "词条空态文案仍 hardcode 在逻辑层");
    assert.ok(!referenceLanesLogic.includes('id: "character"'), "词条 id 仍 hardcode 在逻辑层");
  });

  it("组件层 iconKey 走映射表+未知 key 回退；动作特例与兜底分离", () => {
    assert.ok(referenceLanesView.includes("ICON_BY_KEY"), "缺 iconKey→组件映射表");
    assert.ok(referenceLanesView.includes("?? <ImageSquare"), "缺未知 key 默认图标回退");
    assert.ok(referenceLanesView.includes("LANE_ACTIONS_SPECIAL"), "动作特例表缺失");
    assert.ok(referenceLanesView.includes("lane.workshop"), "新词条 workshop 兜底缺失");
    assert.ok(!referenceLanesView.includes("character: <User"), "图标仍按词条 id hardcode");
  });
});

/* ---------- 5. S24-C：接口词表 merger + App 层接线 ---------- */

describe("laneVocabularyFromApi（服务端字段为准，呈现覆盖层按 id 查内置）", () => {
  const API_ROWS: LaneVocabularyApiEntry[] = [
    { id: "character", displayName: "角色", domain: "entity", pickKind: "character", sort: 1, active: true, recommended: [{ key: "id-photo", label: "定妆照 1 张", required: true }] },
    { id: "color_card", displayName: "色卡", domain: "style", pickKind: null, sort: 9, active: true, recommended: [{ key: "palette", label: "全片色卡 1 张", required: false }] },
    { id: "moodboard", displayName: "情绪板", domain: "style", pickKind: null, sort: 10, active: true, recommended: [] },
    { id: "dirty_row", displayName: "脏行", domain: "atlantis", pickKind: null, sort: 99, active: true, recommended: [] },
  ];

  it("已知 id：词表字段以服务端为准，覆盖层（iconKey/roles/kinds 等）按 id 查内置", () => {
    const vocab = laneVocabularyFromApi(API_ROWS);
    assert.equal(vocab.version, "api");
    const character = vocab.entries.find((entry) => entry.id === "character")!;
    assert.equal(character.displayName, "角色");
    assert.equal(character.pickKind, "character");
    assert.deepEqual(character.recommended, [{ key: "id-photo", label: "定妆照 1 张", required: true }], "recommended 词表列透出");
    assert.equal(character.iconKey, BUILTIN_LANE_VOCABULARY.entries[0]!.iconKey, "覆盖层 iconKey 来自内置");
    assert.deepEqual(character.roles, BUILTIN_LANE_VOCABULARY.entries[0]!.roles, "覆盖层 roles 来自内置");
    assert.equal(character.priority, "P0", "覆盖层 priority 来自内置");
  });

  it("K2：color_card 已是内置已知 id——服务端播种后覆盖层自动升级为 palette 呈现", () => {
    const vocab = laneVocabularyFromApi(API_ROWS);
    const colorCard = vocab.entries.find((entry) => entry.id === "color_card")!;
    assert.equal(colorCard.sort, 9, "排序以服务端为准");
    assert.deepEqual(colorCard.recommended, [{ key: "palette", label: "全片色卡 1 张", required: false }], "recommended 以服务端为准");
    assert.equal(colorCard.iconKey, "palette", "覆盖层 iconKey 来自内置第八条");
    assert.equal(colorCard.workshop, "image");
    assert.equal(colorCard.emptyHint, "还没有色卡。从六套导演调色里选一套，全剧影调就有了锚。", "覆盖层 emptyHint 来自内置");
    assert.deepEqual(colorCard.roles, ["color_card"]);
    assert.deepEqual(colorCard.kinds, ["color_card"]);
  });

  it("未知 id：安全默认不炸 UI（iconKey 空串回退默认图标、workshop image、priority P3）", () => {
    const vocab = laneVocabularyFromApi(API_ROWS);
    const moodboard = vocab.entries.find((entry) => entry.id === "moodboard")!;
    assert.equal(moodboard.iconKey, "");
    assert.equal(moodboard.workshop, "image");
    assert.equal(moodboard.priority, "P3");
    assert.deepEqual(moodboard.roles, []);
    assert.ok(moodboard.emptyHint.includes("情绪板"), "未知 id 空态给通用句");
    assert.equal(moodboard.pickKind, null);
  });

  it("域非法的脏行丢弃", () => {
    const vocab = laneVocabularyFromApi(API_ROWS);
    assert.equal(vocab.entries.some((entry) => entry.id === "dirty_row"), false);
    assert.equal(vocab.entries.length, 3);
  });
});

describe("S24-C 源码级接线：App 注入接口 fetcher，workbench 的 pick 类型走词表 pickKind", () => {
  const app = readSource("./app.tsx");
  const workbench = readSource("./pages/workbench-page.tsx");

  it("App 层登录后经 api.vocabularyReferenceLanes + laneVocabularyFromApi 加载词表", () => {
    assert.ok(app.includes("laneVocabularyFromApi"), "App 未接 merger");
    assert.ok(app.includes("api.vocabularyReferenceLanes()"), "App 未拉接口词表");
    assert.ok(app.includes("loadLaneVocabulary({"), "App 未注入 fetcher");
  });

  it("workbench 不再写死 LANE_PICK_KIND，pick 类型取词条 pickKind", () => {
    assert.ok(!workbench.includes("LANE_PICK_KIND =") && !workbench.includes("LANE_PICK_KIND:"), "LANE_PICK_KIND 写死表定义残留");
    assert.ok(workbench.includes("laneEntry(lane).pickKind"), "pick 类型未走词表 pickKind");
    assert.ok(BUILTIN_LANE_VOCABULARY.entries.every((entry) => "pickKind" in entry), "内置词条缺 pickKind 兜底");
  });
});

/* ---------- 6. K2R/GP-15：costume 归栏与 S88 族表同套口径 ---------- */

describe("K2R/GP-15：costume 归道具栏，栏位映射与 S88 族表同套口径", () => {
  it("族断言：costume 在 S88 族表归 entity 族、非 character 子类", () => {
    const costume = ASSET_KIND_OPTIONS.find((option) => option.value === "costume")!;
    assert.equal(costume.category, "entity", "costume 必须是创作实体族");
    assert.equal(costume.parent, undefined, "costume 不是 character 子类（对比 animal parent=character）");
    assert.ok(costume.aliases.includes("clothing"), "clothing 别名归一不能丢");
  });

  it("栏位断言：costume 落道具栏，且全词表只落一栏", () => {
    assert.ok(laneEntry("prop").kinds.includes("costume"), "道具栏 kinds 缺 costume");
    assert.deepEqual(laneEntry("character").kinds, ["character"], "角色栏不得再收 costume");
    const owners = laneEntries().filter((entry) => entry.kinds.includes("costume"));
    assert.deepEqual(owners.map((entry) => entry.id), ["prop"], "costume 必须且只能落道具栏");
  });

  it("分桶行为：无 role 的 costume 资产入道具栏，角色栏为零", () => {
    const state = seedLanesFromRefs([
      { id: "ref-costume", asset_id: "a-costume", asset: { id: "a-costume", asset_kind: "costume", name: "官服套装" } as Asset } as ProjectAssetRef,
    ]);
    assert.equal(state.prop!.length, 1, "costume 资产应入道具栏");
    assert.equal(state.prop![0]!.name, "官服套装");
    assert.equal(state.character!.length, 0, "角色栏不应再出现 costume");
  });

  it("栏位默认类型不漂移：角色栏=character、道具栏=prop（promoteDefaultKind 取 kinds[0]）", () => {
    assert.equal(laneDef("character").kinds[0], "character");
    assert.equal(laneDef("prop").kinds[0], "prop");
  });

  it("同源守卫：实体域栏位 kinds 必须都在 S88 族表 entity 族登记（栏表不发明族表外类型）", () => {
    const entityKinds = new Set(
      ASSET_KIND_OPTIONS.filter((option) => option.category === "entity")
        .flatMap((option) => [option.value, ...option.aliases]),
    );
    for (const entry of laneEntries().filter((item) => item.domain === "entity")) {
      for (const kind of entry.kinds) {
        assert.ok(entityKinds.has(kind), `${entry.id} 栏 kind "${kind}" 未在 S88 族表 entity 族登记`);
      }
    }
    /* 守卫圈定实体域的理由：audio 栏 "audio" 是族表未收的历史流通值
       （S74 已挂的词表收口待办），不属于本包断点域，不在此一刀切。 */
  });

  it("源码守卫：costume 的栏位映射只许 lane-vocabulary.ts 一处，组件层禁硬编码", () => {
    const srcDir = new URL(".", import.meta.url);
    const offenders = readdirSync(srcDir, { recursive: true })
      .map((entry) => String(entry))
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts") && name !== "lane-vocabulary.ts")
      .filter((name) => /kinds\s*:\s*\[[^\]]*"costume"/.test(readFileSync(new URL(name, srcDir), "utf8")));
    assert.deepEqual(offenders, [], `costume 栏位映射硬编码出逃：${offenders.join(", ")}`);
  });
});

/* ---------- 7. K2T：栏位匹配按族表子类闭包（animal 闭包落角色栏） ---------- */

describe("K2T：栏位匹配按族表子类闭包判定（kind 自身或任一祖先在栏 kinds 内）", () => {
  it("闭包链：animal→[animal,character]；无父 kind 只自身；大小写归一；空串空链", () => {
    assert.deepEqual(assetKindWithAncestors("animal"), ["animal", "character"], "animal 沿 parent 链上卷到 character");
    assert.deepEqual(assetKindWithAncestors("character"), ["character"], "顶级类型无祖先");
    assert.deepEqual(assetKindWithAncestors("Animal"), ["animal", "character"], "大小写归一（同 S88b assetKindMatches 口径）");
    assert.deepEqual(assetKindWithAncestors("scene_reference"), ["scene_reference"], "族表外 kind 链止步于自身（断链防御）");
    assert.deepEqual(assetKindWithAncestors(""), [], "空 kind 空链");
  });

  it("栏位判定：animal 闭包落角色栏；costume 落道具栏；词表外/断链如实 null", () => {
    assert.equal(laneIdForAssetKind("animal"), "character", "animal 自身不在角色栏 kinds,靠祖先 character 闭包落栏");
    assert.equal(laneIdForAssetKind("character"), "character");
    assert.equal(laneIdForAssetKind("costume"), "prop", "K2R 结论不退回");
    assert.equal(laneIdForAssetKind("scene"), "scene");
    assert.equal(laneIdForAssetKind("sound"), "audio");
    assert.equal(laneIdForAssetKind("audio"), "audio", "族表未收的历史流通值靠自身命中,行为不变");
    assert.equal(laneIdForAssetKind("scene_reference"), null, "词表外 kind 落不了栏如实 null");
    assert.equal(laneIdForAssetKind(""), null);
  });

  it("分桶行为：无 role 的老虎（animal）闭包落角色栏,官服（costume）仍在道具栏", () => {
    const state = seedLanesFromRefs([
      { id: "ref-tiger", asset_id: "a-tiger", asset: { id: "a-tiger", asset_kind: "animal", name: "山林猛虎" } as Asset } as ProjectAssetRef,
      { id: "ref-costume", asset_id: "a-costume", asset: { id: "a-costume", asset_kind: "costume", name: "官服套装" } as Asset } as ProjectAssetRef,
    ]);
    assert.deepEqual(state.character!.map((item) => item.name), ["山林猛虎"], "无 role 的 animal 资产必须闭包落角色栏");
    assert.deepEqual(state.prop!.map((item) => item.name), ["官服套装"], "costume 仍在道具栏");
  });

  it("角色栏 kinds 仍只写 character（K2R 不退回）,animal 不写进任何栏 kinds", () => {
    assert.deepEqual(laneEntry("character").kinds, ["character"], "角色栏 kinds 不得为 animal 补字符串");
    const owners = laneEntries().filter((entry) => entry.kinds.includes("animal"));
    assert.deepEqual(owners.map((entry) => entry.id), [], "animal 靠闭包落栏,不得另列进任何栏 kinds");
  });

  it("「从资产库选」抽屉（assetMatchesPick）同走族表：角色槽列动物,场景槽不收,父类选择器不反收", () => {
    const tiger = { id: "a-tiger", asset_kind: "animal", name: "山林猛虎" } as Asset;
    const ren = { id: "a-ren", asset_kind: "character", name: "任天野" } as Asset;
    assert.equal(assetMatchesPick(tiger, "character", ""), true, "角色槽（pickKind=character）必须列出 animal——子类上卷");
    assert.equal(assetMatchesPick(ren, "character", ""), true);
    assert.equal(assetMatchesPick(tiger, "scene", ""), false, "动物不进场景槽");
    assert.equal(assetMatchesPick(tiger, "animal", ""), true, "动物槽只列动物");
    assert.equal(assetMatchesPick(ren, "animal", ""), false, "选子类不反收父类（单向上卷,与 assetKindMatches 同口径）");
  });

  it("族表守卫：每个叶子 kind 闭包解析到恰好一个栏（解析不到/落两栏即红；设计上无栏的须登记理由）", () => {
    // 叶子=族表里没有子类的 kind（目前唯一非叶子=character,子类 animal）
    const parents = new Set(ASSET_KIND_OPTIONS.map((option) => option.parent).filter((parent) => parent !== undefined));
    const leaves = ASSET_KIND_OPTIONS.filter((option) => !parents.has(option.value));
    /* 设计上不进任何栏的叶子 kind 逐个登记——新 kind 进族表必须二选一:
       闭包解析到一个栏,或在此登记无栏理由;落两个栏无豁免,直接红。 */
    const NO_LANE_LEAVES: Readonly<Record<string, string>> = {
      video: "参考视频栏走 role=motion/功能页归入,kinds 刻意为空",
      reference: "族表兜底参考值,无对应参考栏",
      keyword: "产物形态（关键帧）,不进参考栏",
      model_3d: "产物形态（3D 素模）,不进参考栏",
    };
    for (const leaf of leaves) {
      const chain = assetKindWithAncestors(leaf.value);
      const owners = laneEntries().filter((entry) => chain.some((kind) => entry.kinds.includes(kind)));
      if (leaf.value in NO_LANE_LEAVES) {
        assert.deepEqual(owners.map((entry) => entry.id), [], `${leaf.value} 登记为无栏（${NO_LANE_LEAVES[leaf.value]}）却解析到栏`);
      } else {
        assert.equal(owners.length, 1, `叶子 kind "${leaf.value}" 闭包解析到 ${owners.length} 个栏（${owners.map((entry) => entry.id).join(",") || "无"}）,必须恰好一个`);
      }
    }
  });

  it("源码守卫：kinds 栏位匹配唯一判定=lane-vocabulary.ts,roles 唯一消费点=reference-lanes.ts", () => {
    const srcDir = new URL(".", import.meta.url);
    const sources = readdirSync(srcDir, { recursive: true })
      .map((entry) => String(entry))
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"));
    const kindsOffenders = sources
      .filter((name) => name !== "lane-vocabulary.ts")
      .filter((name) => /\.kinds\.includes\(/.test(readFileSync(new URL(name, srcDir), "utf8")));
    assert.deepEqual(kindsOffenders, [], `kinds 精确匹配第二处消费点:${kindsOffenders.join(", ")}`);
    const rolesOffenders = sources
      .filter((name) => name !== "reference-lanes.ts")
      .filter((name) => /\.roles\.includes\(/.test(readFileSync(new URL(name, srcDir), "utf8")));
    assert.deepEqual(rolesOffenders, [], `roles 精确匹配第二处消费点:${rolesOffenders.join(", ")}`);
  });
});
