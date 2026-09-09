/**
 * 3D 导演台 · 快照序列化/反序列化测试（往返无损 + ephemeral 标记）
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { fromSceneSnapshot, toSceneSnapshot, currentUiStash, backendAspectOf } from "./snapshot";
import { useDirectorStore, createSeedSceneState } from "./store";
import type { SceneStateSlice } from "./store";
import { newId } from "../../uuid";

const jsonRound = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function seedSlice(): SceneStateSlice {
  const seed = createSeedSceneState();
  useDirectorStore.getState().replaceSceneState(seed);
  return seed;
}

beforeEach(() => {
  useDirectorStore.getState().resetToSeed();
});

test("后端 5 档画幅映射：auto/21:9 → 16:9", () => {
  assert.equal(backendAspectOf("9:16"), "9:16");
  assert.equal(backendAspectOf("auto"), "16:9");
  assert.equal(backendAspectOf("21:9"), "16:9");
  assert.equal(backendAspectOf("1:1"), "1:1");
});

test("空台 JSON 往返：序列化→解析→再序列化深度相等", () => {
  const slice = seedSlice();
  const snapshot1 = toSceneSnapshot(slice, { persist: true });
  const wire = jsonRound(snapshot1);
  const parsed = fromSceneSnapshot(wire);
  assert.deepEqual(parsed.skippedEphemeral, []);
  assert.deepEqual(parsed.skippedUnknown, []);
  const snapshot2 = toSceneSnapshot(parsed.slice, { persist: true });
  assert.deepEqual(snapshot2, snapshot1);
  // 语义点检：W5.5 空台（0 对象、无活动机位），画幅/环境/天空色保持默认
  assert.equal(parsed.slice.order.length, 0);
  assert.equal(parsed.slice.activeCameraId, null);
  assert.equal(parsed.slice.aspect, "9:16");
  assert.equal(parsed.slice.environment, "studio");
  assert.equal(parsed.slice.scene.skyColor, "#15181E");
});

test("pose/bodyType/joints/geometry/crowd 等松散字段往返保留", () => {
  const state = useDirectorStore.getState();
  const mannequinId = state.addObject({
    name: "男主",
    type: "mannequin",
    visible: true,
    transform: { position: [-1.05, 0, 0.95], rotation: [0, 140, 0], scale: [1, 1, 1] },
    color: "#4A82E1",
    bodyType: "male",
    pose: "站立",
    joints: {},
  });
  state.setPose(mannequinId, "fight");
  state.setBodyType(mannequinId, "muscular");
  state.setJoint(mannequinId, "head", [12, -8, 3]);
  const crowdId = state.addObject({
    name: "群演",
    type: "crowd",
    visible: true,
    transform: { position: [2, 0, 2], rotation: [0, 45, 0], scale: [1, 1, 1] },
    rows: 3,
    cols: 5,
    spacing: 1.4,
    color: "#6AC6C6",
  });

  const parsed = fromSceneSnapshot(jsonRound(toSceneSnapshot(useDirectorStore.getState(), { persist: true })));
  const mannequin = parsed.slice.objects[mannequinId];
  assert.ok(mannequin?.type === "mannequin");
  if (mannequin?.type === "mannequin") {
    assert.equal(mannequin.pose, "fight");
    assert.equal(mannequin.bodyType, "muscular");
    assert.deepEqual(mannequin.joints["head"], [12, -8, 3]);
  }
  const crowd = parsed.slice.objects[crowdId];
  assert.ok(crowd?.type === "crowd");
  if (crowd?.type === "crowd") {
    assert.equal(crowd.rows, 3);
    assert.equal(crowd.cols, 5);
    assert.equal(crowd.spacing, 1.4);
  }
});

test("persist：blob: 上传模型打 ephemeral:true 且 assetUrl 置空；加载跳过并报名单", () => {
  const state = useDirectorStore.getState();
  const modelId = state.addObject({
    name: "龙椅",
    type: "model",
    visible: true,
    transform: { position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
    assetUrl: "blob:http://localhost/abc-123",
    fileName: "throne.glb",
  });

  const persisted = toSceneSnapshot(useDirectorStore.getState(), { persist: true });
  const entry = persisted.objects.find((item) => item.id === modelId) as Record<string, unknown>;
  assert.equal(entry["ephemeral"], true);
  assert.equal(entry["assetUrl"], "");
  assert.equal(entry["fileName"], "throne.glb");

  const parsed = fromSceneSnapshot(jsonRound(persisted));
  assert.equal(parsed.slice.objects[modelId], undefined);
  assert.deepEqual(parsed.skippedEphemeral, ["龙椅"]);
  // order 中也不再有该对象
  assert.ok(!parsed.slice.order.includes(modelId));
});

test("session（命令执行器路径）不剔除 blob: 对象", () => {
  const state = useDirectorStore.getState();
  const modelId = state.addObject({
    name: "临时模型",
    type: "model",
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    assetUrl: "blob:http://localhost/xyz",
    fileName: "temp.glb",
  });
  const session = toSceneSnapshot(useDirectorStore.getState());
  const entry = session.objects.find((item) => item.id === modelId) as Record<string, unknown>;
  assert.equal(entry["assetUrl"], "blob:http://localhost/xyz");
  assert.equal(entry["ephemeral"], undefined);
  const parsed = fromSceneSnapshot(session);
  assert.deepEqual(parsed.skippedEphemeral, []);
  assert.ok(parsed.slice.objects[modelId]);
});

test("persist：全景 blob: 置空并打 panoramaEphemeral；session 保留", () => {
  const state = useDirectorStore.getState();
  state.setSceneSettings({ panoramaUrl: "blob:http://localhost/pano", panoramaRotation: 90, panoramaRadius: 50 });

  const persisted = toSceneSnapshot(useDirectorStore.getState(), { persist: true });
  assert.equal(persisted.ui?.scene.panoramaUrl, null);
  assert.equal(persisted.ui?.scene.panoramaEphemeral, true);
  assert.equal(persisted.ui?.scene.panoramaRotation, 90);

  const session = toSceneSnapshot(useDirectorStore.getState());
  assert.equal(session.ui?.scene.panoramaUrl, "blob:http://localhost/pano");

  // 加载端：全景回退为 null（旋转参数保留），UI 据此提示本地临时
  const parsed = fromSceneSnapshot(jsonRound(persisted));
  assert.equal(parsed.slice.scene.panoramaUrl, null);
  assert.equal(parsed.slice.scene.panoramaRotation, 90);
  assert.equal(parsed.ui.scene.panoramaEphemeral, true);
});

test("7 档画幅经 ui.aspect 无损往返；快照字段被外部改写时以快照为准", () => {
  const state = useDirectorStore.getState();
  state.setAspect("auto");
  let snapshot = toSceneSnapshot(useDirectorStore.getState(), { persist: true });
  assert.equal(snapshot.aspectRatio, "16:9");
  assert.equal(fromSceneSnapshot(jsonRound(snapshot)).slice.aspect, "auto");

  state.setAspect("21:9");
  snapshot = toSceneSnapshot(useDirectorStore.getState(), { persist: true });
  assert.equal(snapshot.aspectRatio, "16:9");
  assert.equal(fromSceneSnapshot(jsonRound(snapshot)).slice.aspect, "21:9");

  // 外部（命令/其他客户端）把 aspectRatio 改成 1:1：ui.aspect 与字段不一致 → 字段优先
  const tampered = jsonRound(snapshot);
  tampered.aspectRatio = "1:1";
  assert.equal(fromSceneSnapshot(tampered).slice.aspect, "1:1");
});

test("environment 映射：dusk + skyColor + groundVisible 往返", () => {
  const state = useDirectorStore.getState();
  state.setEnvironment("dusk");
  state.setSceneSettings({ skyColor: "#223344", groundVisible: false });
  const snapshot = toSceneSnapshot(useDirectorStore.getState(), { persist: true });
  assert.equal(snapshot.environment.preset, "dusk");
  assert.equal(snapshot.environment.backgroundColor, "#223344");
  assert.equal(snapshot.environment.groundVisible, false);

  const parsed = fromSceneSnapshot(jsonRound(snapshot));
  assert.equal(parsed.slice.environment, "dusk");
  assert.equal(parsed.slice.scene.skyColor, "#223344");
  assert.equal(parsed.slice.scene.groundVisible, false);
});

test("无 ui 的原生后端快照可装载（字段缺省回落）", () => {
  const nativeSnapshot = {
    schemaVersion: 1,
    objects: [
      {
        id: "obj-1",
        type: "mannequin",
        name: "甲",
        transform: { position: { x: 1, y: 0, z: 2 } },
        pose: { preset: "sit" },
      },
    ],
    cameras: [
      {
        id: "cam-1",
        type: "camera",
        name: "主机位",
        focalLength: 99,
        target: { x: 0, y: 1, z: 0 },
        transform: { position: { x: 2, y: 2, z: 2 } },
      },
    ],
    selectedObjectId: null,
    activeCameraId: "cam-1",
    aspectRatio: "16:9",
    environment: { preset: "dusk", backgroundColor: "#101010", ambientLight: 0.4, groundVisible: false },
  };
  const parsed = fromSceneSnapshot(nativeSnapshot);
  assert.equal(parsed.slice.aspect, "16:9");
  assert.equal(parsed.slice.environment, "dusk");
  assert.equal(parsed.slice.scene.skyColor, "#101010");
  assert.equal(parsed.slice.scene.groundVisible, false);
  assert.equal(parsed.slice.activeCameraId, "cam-1");
  // 焦距非法档回落 35
  const camera = parsed.slice.objects["cam-1"];
  assert.ok(camera?.type === "camera");
  if (camera?.type === "camera") assert.equal(camera.focalLength, 35);
  // mannequin 缺省字段回落：bodyType male / 默认色 / rotation [0,0,0]
  const mannequin = parsed.slice.objects["obj-1"];
  assert.ok(mannequin?.type === "mannequin");
  if (mannequin?.type === "mannequin") {
    assert.equal(mannequin.bodyType, "male");
    assert.equal(mannequin.pose, "sit");
    assert.deepEqual(mannequin.transform.rotation, [0, 0, 0]);
    assert.deepEqual(mannequin.transform.scale, [1, 1, 1]);
  }
  // order = objects 在前 cameras 在后
  assert.deepEqual(parsed.slice.order, ["obj-1", "cam-1"]);
});

test("未知类型对象跳过并记入 skippedUnknown；attachments 透传保留", () => {
  const state = useDirectorStore.getState();
  // 空台无对象：先放一个几何体承接 attachments（原用例写在种子对象上）
  state.addObject({
    name: "桌子",
    type: "geometry",
    visible: true,
    transform: { position: [0, 0, 0.05], rotation: [0, 0, 0], scale: [1, 1, 1] },
    shape: "box",
    color: "#9AA0A8",
    size: [1.4, 0.75, 0.8],
  });
  const snapshot = jsonRound(toSceneSnapshot(useDirectorStore.getState(), { persist: true })) as Record<string, unknown>;
  const objects = snapshot["objects"] as Array<Record<string, unknown>>;
  objects.push({
    id: "weird-1",
    type: "hologram",
    name: "全息投影",
    transform: { position: { x: 0, y: 0, z: 0 } },
  });
  objects[0]!["attachments"] = [{ assetEntityId: newId(), assetMediaId: null, name: "参考图" }];

  const parsed = fromSceneSnapshot(snapshot);
  assert.deepEqual(parsed.skippedUnknown, ["全息投影"]);
  assert.equal(parsed.slice.objects["weird-1"], undefined);

  // attachments 经 extras 暂存，保存时原样写回
  const repersisted = toSceneSnapshot(parsed.slice, { persist: true });
  const first = repersisted.objects.find((item) => item.id === parsed.slice.order[0]) as Record<string, unknown>;
  assert.ok(Array.isArray(first["attachments"]));
  assert.equal((first["attachments"] as Array<{ name?: string }>)[0]?.name, "参考图");
});

test("快照结构损坏抛错（schemaVersion 非法）", () => {
  assert.throws(() => fromSceneSnapshot({ schemaVersion: 2, objects: [] }));
});

test("currentUiStash 随装载更新（松散键暂存生命周期）", () => {
  const slice = seedSlice();
  const snapshot = toSceneSnapshot(slice, { persist: true });
  fromSceneSnapshot(jsonRound(snapshot));
  const stash = currentUiStash();
  assert.ok(stash);
  assert.deepEqual(stash!.order, slice.order);
});
