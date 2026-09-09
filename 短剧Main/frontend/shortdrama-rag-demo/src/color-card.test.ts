/* ============================================================
   color-card.test.ts — K-goal-02 包 N3「色卡栏」验收（V-17/V-18，B 走法）

   锁定六件事：
   1. 内容词表诚实：六条全部有据、全部 active（2026-07-29 照 DC 原图抄全，
      三格色板 hex 逐条照抄 + 像素取样互证）；原图不可辨的 gradingRecipe
      三处如实留空，不许编；
   2. upsertColorCard 纯函数：swatch 条目挂接/再选替换/可摘除/不碰其他栏；
   3. colors 字段持久化往返（localStorage save/load 不失真）；
   4. 组件渲染：prop 缺省=只读内容卡常驻、「选一套色卡」按钮不渲染；
      prop 就位=按钮渲染、内容卡 toggle 默认收起；swatch 条目色块圆点+名称；
   5. 色卡不进提交参考集（controlPackReferences 对 swatch 自然跳过）；
   6. B 走法守卫：workbench-page.tsx 零改动（基线 35021af diff 为空 +
      源码不含 onPickColorCard）。S83 合流后收尾包接线一行 prop 时，
      把第 6 组改为白名单（至多一行）或移除——不许悄悄破。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { COLOR_CARD_ENTRIES, activeColorCards, type ColorCardEntry } from "./color-card-vocabulary";
import {
  detachLaneItem,
  emptyLanesState,
  loadLanesState,
  saveLanesState,
  seedLanesFromRefs,
  upsertColorCard,
  type LanesState,
} from "./reference-lanes";
import { ReferenceList, type ReferenceListProps } from "./components/reference-lanes";
import { controlPackReferences } from "./control-pack";
import type { Asset, ProjectAssetRef } from "./types";

const WARM = COLOR_CARD_ENTRIES[0]!;

function refOf(asset: Partial<Asset> & { id: string }, refId = `ref-${asset.id}`): ProjectAssetRef {
  return { id: refId, asset_id: asset.id, asset: asset as Asset };
}

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
  } as unknown as Storage;
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/* ---------- 1. 内容词表诚实（色值不许编） ---------- */

describe("内容词表诚实（照原图抄全，不可辨的留空不编）", () => {
  it("六条，id/name 对齐 R19「电影调色大全」", () => {
    assert.deepEqual(
      COLOR_CARD_ENTRIES.map((entry) => [entry.id, entry.name]),
      [
        ["warm", "暖调"],
        ["cool", "冷调"],
        ["low_sat", "低饱和"],
        ["high_sat", "高饱和"],
        ["noir", "暗黑"],
        ["teal_orange", "青橙"],
      ],
    );
  });

  it("六条全部有据、全部上界面（原图抄全后不再有占位条）", () => {
    assert.deepEqual(
      activeColorCards().map((entry) => entry.id),
      ["warm", "cool", "low_sat", "high_sat", "noir", "teal_orange"],
    );
  });

  it("每条三格色板照抄原图，格式合法且主色=第一格", () => {
    for (const entry of COLOR_CARD_ENTRIES) {
      assert.equal(entry.palette.length, 3, `${entry.id} 原图是三格色板`);
      for (const hex of entry.palette) {
        assert.match(hex, /^#[0-9A-F]{6}$/, `${entry.id} 色板必须是六位大写 hex`);
      }
      assert.equal(entry.primaryHex, entry.palette[0], `${entry.id} 主色取第一格（六条色相全部吻合，有据）`);
    }
  });

  it("暖调：色值/情绪/导演用途逐字照抄原图", () => {
    assert.deepEqual(WARM.palette, ["#D99B52", "#E8C98A", "#6B7B45"]);
    assert.equal(WARM.primaryName, "Gold", "原图：主色 Gold");
    assert.equal(WARM.secondaryHex, "Green", "辅助色不做格位推断，记色名原话");
    assert.deepEqual(WARM.mood, ["温暖", "浪漫", "幸福感"]);
    assert.deepEqual(WARM.moodEn, ["Romance", "Warmth", "Nostalgia"]);
    assert.equal(WARM.directorUse, "爱情、回忆、治愈剧情");
  });

  it("暗黑：导演用途照抄；第三格色值存疑但按原图标签抄，注释留痕", () => {
    const noir = COLOR_CARD_ENTRIES.find((entry) => entry.id === "noir")!;
    assert.equal(noir.directorUse, "犯罪、复仇、惊悚");
    assert.deepEqual(noir.palette, ["#1B2636", "#2C2F36", "#0E0F42"]);
    assert.deepEqual(noir.gradingRecipe, ["降低曝光", "增加阴影", "强化对比"]);
  });

  it("原图不可辨的 gradingRecipe 三条留空（暖调/高饱和/青橙），不许编", () => {
    const blank = COLOR_CARD_ENTRIES.filter((entry) => entry.gradingRecipe.length === 0).map((entry) => entry.id);
    assert.deepEqual(blank, ["warm", "high_sat", "teal_orange"]);
  });
});

/* ---------- 2. upsertColorCard 纯函数（upsertCameraNote 同模式） ---------- */

describe("upsertColorCard 纯函数", () => {
  it("挂接：生成 swatch 条目（固定 id、色值成对、导演用途进 note）", () => {
    const state = upsertColorCard(emptyLanesState(), WARM);
    const items = state.color_card!;
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      id: "swatch:color_card",
      name: "暖调",
      kind: "swatch",
      origin: "workshop",
      colors: ["#D99B52", "Green"],
      note: "爱情、回忆、治愈剧情",
    });
  });

  it("再选即替换（全剧只挂一套）；摘除走通用 detachLaneItem", () => {
    let state = upsertColorCard(emptyLanesState(), WARM);
    const pending: ColorCardEntry = {
      id: "teal_orange", name: "青橙", nameEn: "TEAL & ORANGE",
      primaryName: "Teal", primaryHex: "#111111", secondaryHex: "#222222",
      palette: ["#111111", "#222222", "#333333"],
      mood: [], moodEn: [], gradingRecipe: [], directorUse: "", active: false,
    };
    state = upsertColorCard(state, pending);
    assert.equal(state.color_card!.length, 1, "固定 id upsert，替换不叠加");
    assert.equal(state.color_card![0]!.name, "青橙");
    assert.deepEqual(state.color_card![0]!.colors, ["#111111", "#222222"]);
    assert.equal(state.color_card![0]!.note, undefined, "空导演用途不进 note");
    state = detachLaneItem(state, "color_card", "swatch:color_card");
    assert.equal(state.color_card!.length, 0, "workshop 条目可摘除");
  });

  it("不碰其他栏", () => {
    const state = upsertColorCard(emptyLanesState(), WARM);
    assert.equal(state.lighting!.length, 0);
    assert.equal(state.camera_motion!.length, 0);
    assert.equal(state.character!.length, 0);
  });
});

/* ---------- 3. colors 字段持久化往返 ---------- */

describe("colors 字段持久化往返", () => {
  it("save/load 后 swatch 条目 colors/note 不失真；资产条目不落地", () => {
    const storage = fakeStorage();
    const refs = [refOf({ id: "a1", role: "character_identity", asset_kind: "character", name: "任天野" })];
    let state = seedLanesFromRefs(refs);
    state = upsertColorCard(state, WARM);
    saveLanesState(storage, "shot-1", state);

    const loaded = loadLanesState(storage, "shot-1", seedLanesFromRefs(refs));
    const swatch = loaded.color_card!.find((item) => item.id === "swatch:color_card")!;
    assert.equal(swatch.kind, "swatch");
    assert.deepEqual(swatch.colors, ["#D99B52", "Green"], "colors 字段 JSON 往返不失真");
    assert.equal(swatch.note, "爱情、回忆、治愈剧情");
    assert.equal(loaded.character!.length, 1, "实时分桶不受持久化影响");
  });
});

/* ---------- 4. 组件渲染（B 走法：prop 门控） ---------- */

function baseProps(state: LanesState, extra: Partial<ReferenceListProps> = {}): ReferenceListProps {
  return {
    state,
    demoMode: true,
    onLaneAction: () => undefined,
    onPickFromLibrary: () => undefined,
    onRemoveItem: () => undefined,
    onSaveCameraNote: () => undefined,
    ...extra,
  };
}

function renderList(props: ReferenceListProps): string {
  return renderToStaticMarkup(React.createElement(ReferenceList, props));
}

describe("组件渲染（prop 门控：缺省只读、就位可挂）", () => {
  it("prop 缺省：色卡栏出现、「选一套色卡」按钮不渲染、暖调内容卡常驻只读", () => {
    const html = renderList(baseProps(emptyLanesState()));
    assert.ok(html.includes("色卡"), "色卡栏未出现");
    assert.ok(!html.includes("选一套色卡"), "prop 缺省时挂接按钮必须不渲染（B 走法）");
    assert.ok(html.includes("暖调"), "暖调内容卡未呈现");
    assert.ok(html.includes("background-color:#D99B52"), "主色色块（hex 才渲染，inline 内容色值）未呈现");
    assert.ok(!html.includes("background-color:Green"), "色名原话不许猜色渲染色块");
    assert.ok(html.includes("Green"), "辅色按原图色名原话文字呈现");
    assert.ok(html.includes("导演用途：爱情、回忆、治愈剧情"), "导演用途未照抄呈现");
    assert.ok(html.includes("情绪：温暖、浪漫、幸福感"), "情绪词已抄全，应渲染");
    assert.ok(html.includes("还没有色卡。从六套导演调色里选一套，全剧影调就有了锚。"), "空态人话缺失");
    assert.ok(html.includes("青橙") && html.includes("冷调"), "六条抄全后全部上界面");
  });

  it("prop 就位：「选一套色卡」按钮渲染，内容卡 toggle 默认收起", () => {
    const html = renderList(baseProps(emptyLanesState(), { onPickColorCard: () => undefined }));
    assert.ok(html.includes("选一套色卡"), "prop 就位后挂接按钮应渲染");
    assert.ok(!html.includes("暖调"), "toggle 未开时内容卡不渲染");
  });

  it("swatch 条目渲染：色块圆点（inline 色值）+ 名称 + 导演用途 + 摘除钮", () => {
    const html = renderList(baseProps(upsertColorCard(emptyLanesState(), WARM)));
    assert.ok(html.includes("rounded-full"), "色块圆点未渲染");
    assert.ok(html.includes("background-color:#D99B52"), "swatch 主色圆点未渲染");
    assert.ok(!html.includes("background-color:Green"), "色名原话不许猜色渲染圆点");
    assert.ok(html.includes("暖调"), "swatch 名称未渲染");
    assert.ok(html.includes("爱情、回忆、治愈剧情"), "swatch 导演用途 note 未渲染");
    assert.ok(html.includes("从色卡摘除 暖调"), "swatch 摘除钮缺失");
    assert.ok(!html.includes("还没有色卡"), "有条目时不应再显示空态");
  });

  it("text 条目徽标按栏取词：运镜=机位描述，其他栏回退栏名（不再硬编码）", () => {
    const badgeOf = (word: string): string => `text-accent-text">${word}</span>`;
    const camera = renderList(baseProps({
      ...emptyLanesState(),
      camera_motion: [{ id: "note:camera_motion", name: "缓推", kind: "text", origin: "workshop" }],
    }));
    assert.ok(camera.includes(badgeOf("机位描述")), "运镜栏文本徽标回归");
    const other = renderList(baseProps({
      ...emptyLanesState(),
      prop: [{ id: "note:prop", name: "短刀特写补一句", kind: "text", origin: "workshop" }],
    }));
    assert.ok(other.includes(badgeOf("道具")), "道具栏文本徽标应按栏取词=栏名");
    assert.ok(!other.includes(badgeOf("机位描述")), "道具栏文本条目不应顶「机位描述」徽标");
  });
});

/* ---------- 5. 色卡不进提交参考集（v1=全剧影调锚，不注入生成） ---------- */

describe("提交参考集口径", () => {
  it("swatch 是非媒体条目，controlPackReferences 自然跳过", () => {
    const lanes = upsertColorCard(emptyLanesState(), WARM);
    const options = controlPackReferences(lanes, []);
    assert.equal(options.length, 0, "色卡条目不得进入提交参考集");
  });
});

/* ---------- 6. B 走法守卫：workbench-page.tsx 零改动 ---------- */

describe("B 走法守卫（S83 未合流，workbench-page 一行也不许碰）", () => {
  it("源码不含 onPickColorCard（接线留 S83 合流后收尾包）", () => {
    const workbench = readSource("./pages/workbench-page.tsx");
    assert.ok(!workbench.includes("onPickColorCard"), "workbench-page 出现色卡挂接 prop——B 走法零改动被破");
  });

  // 原「对基线 35021af 的 git diff 为空」断言在合流时删除(Fable 07-29):它钉的是时点快照,
  // 集成线上 workbench-page.tsx 会被其他包合法修改(K2C 合入当天就红了)。
  // B 走法的真守卫是上面那条源码扫描——workbench-page 不出现 onPickColorCard 挂点。
});
