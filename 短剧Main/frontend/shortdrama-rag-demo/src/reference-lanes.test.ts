/* reference-lanes 单测：分桶 / 完备度 / 挂回去重 / 持久化合并（纯逻辑，不引 CSS/DOM）。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LANE_DOMAINS,
  REFERENCE_LANES,
  attachLaneItem,
  detachLaneItem,
  emptyLanesState,
  laneCompleteness,
  laneDef,
  loadLanesState,
  saveLanesState,
  seedLanesFromRefs,
  upsertCameraNote,
} from "./reference-lanes";
import type { Asset, ProjectAssetRef } from "./types";

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

describe("REFERENCE_LANES 定义", () => {
  it("八组三域（条 8：实体/风格/媒介分区；K2 色卡进风格域，枚举对齐合同①+DC 三域拍板）", () => {
    assert.deepEqual(
      REFERENCE_LANES.map((lane) => lane.id),
      ["character", "scene", "prop", "lighting", "color_card", "camera_motion", "reference_video", "audio"],
    );
    assert.equal(new Set(REFERENCE_LANES.map((lane) => lane.id)).size, 8);
    // 三域分区（条 8）：实体=角色/场景/道具，风格=光影/色卡/运镜，媒介=参考视频/音频
    assert.deepEqual(LANE_DOMAINS.map((d) => d.label), ["实体参考", "风格参考", "媒介参考"]);
    assert.deepEqual(LANE_DOMAINS[1]!.lanes, ["lighting", "color_card", "camera_motion"]);
  });

  it("每组都有功能页归属与建议要素（角色 P0 永不省略）", () => {
    for (const lane of REFERENCE_LANES) {
      assert.ok(lane.workshop.length > 0, lane.id);
      assert.ok(lane.recommended.length > 0, lane.id);
    }
    assert.equal(laneDef("character").priority, "P0");
    assert.equal(laneDef("reference_video").priority, "P3");
  });
});

describe("seedLanesFromRefs 资产分桶", () => {
  it("role 优先、kind 兜底；无匹配不入栏", () => {
    const state = seedLanesFromRefs([
      refOf({ id: "a1", role: "character_identity", asset_kind: "character", name: "任天野" }),
      refOf({ id: "a2", role: "style_env", asset_kind: "lighting", name: "冷月光" }),
      refOf({ id: "a3", asset_kind: "sound", name: "低频脚步" }),
      refOf({ id: "a4", asset_kind: "keyframe", name: "无名网格" }),
    ]);
    assert.equal(state.character!.length, 1);
    assert.equal(state.character![0]!.id, "asset:a1");
    // 条 8/9：lighting/style_env 不再混进场景组——归「光影」组（场景道具混淆的结构性修复）
    assert.equal(state.scene!.length, 0);
    assert.equal(state.lighting!.length, 1);
    assert.equal(state.lighting![0]!.note, "风格环境");
    assert.equal(state.audio!.length, 1);
    assert.equal(state.audio![0]!.kind, "audio");
    assert.equal(state.prop!.length, 0);
  });

  it("参考视频组条目标记为 video 类型", () => {
    const state = seedLanesFromRefs([refOf({ id: "v1", role: "motion", asset_kind: "reference", name: "骑马动作" })]);
    assert.equal(state.reference_video![0]!.kind, "video");
  });
});

describe("laneCompleteness 完备度", () => {
  it("空组：列出必备缺口（提示性质）", () => {
    const result = laneCompleteness(laneDef("character"), []);
    assert.deepEqual(result.missingRequired, ["每个出场角色锁定 1 张身份定妆图"]);
    assert.deepEqual(result.missingOptional, ["多角色同框再补 1 张同框比例参考"]);
  });

  it("有条目即视为到位（原型口径）", () => {
    const result = laneCompleteness(laneDef("character"), [
      { id: "asset:a1", name: "任天野", kind: "image", origin: "asset" },
    ]);
    assert.equal(result.missingRequired.length, 0);
    assert.equal(result.missingOptional.length, 0);
  });

});

describe("归入与持久化", () => {
  it("attach 按 id 去重；detach 只移除 workshop 条目", () => {
    let state = emptyLanesState();
    const item = { id: "workshop:m1", name: "产出 1", kind: "image" as const, origin: "workshop" as const };
    state = attachLaneItem(state, "character", item);
    state = attachLaneItem(state, "character", item);
    assert.equal(state.character!.length, 1);
    state = attachLaneItem(state, "character", { id: "asset:a1", name: "资产", kind: "image", origin: "asset" });
    state = detachLaneItem(state, "character", "asset:a1");
    assert.equal(state.character!.length, 2, "资产条目不可从参考栏移除");
    state = detachLaneItem(state, "character", "workshop:m1");
    assert.equal(state.character!.length, 1);
  });

  it("运镜文字描述 upsert / 清空", () => {
    let state = emptyLanesState();
    state = upsertCameraNote(state, "  中景平视缓推，手持感  ");
    assert.equal(state.camera_motion![0]!.name, "中景平视缓推，手持感");
    state = upsertCameraNote(state, "");
    assert.equal(state.camera_motion!.length, 0);
  });

  it("localStorage 只存 workshop 条目，加载时与实时分桶合并去重", () => {
    const storage = fakeStorage();
    let state = seedLanesFromRefs([refOf({ id: "a1", role: "prop", asset_kind: "prop", name: "短刀" })]);
    state = attachLaneItem(state, "prop", { id: "workshop:m9", name: "三视图", kind: "image", origin: "workshop" });
    saveLanesState(storage, "shot-1", state);

    const reseeded = seedLanesFromRefs([refOf({ id: "a1", role: "prop", asset_kind: "prop", name: "短刀" })]);
    const loaded = loadLanesState(storage, "shot-1", reseeded);
    assert.equal(loaded.prop!.length, 2);
    assert.equal(loaded.prop![0]!.origin, "asset");
    assert.equal(loaded.prop![1]!.id, "workshop:m9");

    const raw = storage.getItem("shortdrama_lanes_v2:shot-1")!;
    assert.ok(!raw.includes("asset:a1"), "资产条目不落地副本");
  });

  it("脏 JSON / 空存储都回退到实时分桶", () => {
    const storage = fakeStorage();
    storage.setItem("shortdrama_lanes_v2:shot-2", "{oops");
    const seeded = emptyLanesState();
    assert.deepEqual(loadLanesState(storage, "shot-2", seeded), seeded);
    assert.deepEqual(loadLanesState(storage, "shot-3", seeded), seeded);
  });
});
