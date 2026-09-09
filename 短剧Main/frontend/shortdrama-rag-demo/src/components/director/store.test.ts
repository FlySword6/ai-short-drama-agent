/**
 * 3D 导演台 · store reducer 测试（tsx --test，无 DOM 依赖）
 *
 * W5.5 空台后：seed 不再预置对象，需要既有对象的用例经 addTestMannequin /
 * addTestCamera 自建（参数沿用原种子场景的「男主」「总览」）。
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { createSeedSceneState, useDirectorStore } from "./store";
import { isCameraObject, isMannequinObject } from "./types";

const store = () => useDirectorStore.getState();

/** 放一个素模（沿用原种子「男主」参数：姿势/朝向/配色） */
function addTestMannequin(name = "男主"): string {
  return store().addObject({
    name,
    type: "mannequin",
    visible: true,
    transform: { position: [-1.05, 0, 0.95], rotation: [0, 140, 0], scale: [1, 1, 1] },
    color: "#4A82E1",
    bodyType: "male",
    pose: "站立",
    joints: {},
  });
}

/** 放一台机位（沿用原种子「总览」参数：35mm / target [0,0.85,0.1]） */
function addTestCamera(name = "总览"): string {
  return store().addObject({
    name,
    type: "camera",
    visible: true,
    transform: { position: [3.4, 2.7, 4.6], rotation: [0, 0, 0], scale: [1, 1, 1] },
    focalLength: 35,
    target: [0, 0.85, 0.1],
  });
}

beforeEach(() => {
  useDirectorStore.getState().resetToSeed();
});

test("默认空台：无对象无机位，环境/画幅/视角/叠加层保持默认", () => {
  const state = store();
  assert.equal(state.order.length, 0);
  assert.deepEqual(state.objects, {});
  assert.equal(state.selectedId, null);
  assert.equal(state.activeCameraId, null);
  assert.equal(state.viewMode, "director");
  assert.equal(state.aspect, "9:16");
  assert.equal(state.environment, "studio");
  assert.equal(state.scene.skyColor, "#15181E");
  assert.equal(state.scene.groundVisible, true);
  assert.deepEqual(state.overlays, { thirds: true, center: false, safeArea: false, nameTags: true });
});

test("clearSceneObjects：移除全部对象（含机位），保留环境/画幅/场景设置；空台幂等", () => {
  addTestMannequin();
  const cameraId = addTestCamera();
  store().select(cameraId);
  store().setViewMode("camera");
  store().setEnvironment("dusk");
  store().setAspect("16:9");
  store().setSceneSettings({ gridSnap: true });

  store().clearSceneObjects();
  assert.equal(store().order.length, 0);
  assert.deepEqual(store().objects, {});
  assert.equal(store().selectedId, null);
  assert.equal(store().activeCameraId, null);
  // 机位清空后退回导演视角；环境/画幅/场景设置保留
  assert.equal(store().viewMode, "director");
  assert.equal(store().environment, "dusk");
  assert.equal(store().aspect, "16:9");
  assert.equal(store().scene.gridSnap, true);

  // 空台再调用无副作用
  store().clearSceneObjects();
  assert.equal(store().order.length, 0);
  assert.equal(store().environment, "dusk");
});

test("addObject 生成 id 并追加 order；首个机位自动成为活动机位", () => {
  const state = store();
  const id = state.addObject({
    name: "测试几何",
    type: "geometry",
    visible: true,
    transform: { position: [1, 0, 1], rotation: [0, 0, 0], scale: [1, 1, 1] },
    shape: "box",
    color: "#9AA0A8",
    size: [1, 1, 1],
  });
  assert.ok(id);
  assert.equal(store().order.at(-1), id);
  assert.equal(store().objects[id]?.type, "geometry");

  // 空台无机位：新增机位自动成为活动机位
  assert.equal(store().activeCameraId, null);
  const cameraId = store().addObject({
    name: "新机位",
    type: "camera",
    visible: true,
    transform: { position: [2, 2, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
    focalLength: 35,
    target: [0, 1, 0],
  });
  assert.equal(store().activeCameraId, cameraId);
});

test("removeObject 清理选中；删除活动机位回落到清单第一个机位", () => {
  const firstCamera = addTestCamera("总览");
  addTestCamera("过肩");
  store().select(firstCamera);
  store().removeObject(firstCamera);
  assert.equal(store().selectedId, null);
  assert.notEqual(store().activeCameraId, firstCamera);
  assert.ok(store().activeCameraId);

  // 删光机位：机位视角自动退回导演视角
  store().setViewMode("camera");
  for (const objectId of [...store().order]) {
    if (store().objects[objectId]?.type === "camera") store().removeObject(objectId);
  }
  assert.equal(store().activeCameraId, null);
  assert.equal(store().viewMode, "director");
});

test("duplicateObject 名称加「 副本」且非机位偏移 0.5m", () => {
  const sourceId = addTestMannequin();
  const source = store().objects[sourceId]!;
  const copyId = store().duplicateObject(sourceId);
  assert.ok(copyId);
  const copy = store().objects[copyId]!;
  assert.equal(copy.name, `${source.name} 副本`);
  assert.equal(copy.transform.position[0], source.transform.position[0] + 0.5);
  assert.equal(copy.transform.position[2], source.transform.position[2] + 0.5);
  // 机位复制不偏移
  const cameraId = addTestCamera();
  const cameraCopy = store().duplicateObject(cameraId);
  assert.ok(cameraCopy);
  assert.deepEqual(
    store().objects[cameraCopy]!.transform.position,
    store().objects[cameraId]!.transform.position,
  );
  // 不存在返回 null
  assert.equal(store().duplicateObject("no-such-id"), null);
});

test("renameObject trim、空名忽略；setVisible 切换", () => {
  const id = addTestMannequin();
  store().renameObject(id, "  新名字  ");
  assert.equal(store().objects[id]!.name, "新名字");
  store().renameObject(id, "   ");
  assert.equal(store().objects[id]!.name, "新名字");
  store().setVisible(id, false);
  assert.equal(store().objects[id]!.visible, false);
});

test("updateTransform 浅合并；setPose/setBodyType/setJoint 仅素模生效", () => {
  const mannequinId = addTestMannequin();
  const geometryId = store().addObject({
    name: "桌子",
    type: "geometry",
    visible: true,
    transform: { position: [0, 0, 0.05], rotation: [0, 0, 0], scale: [1, 1, 1] },
    shape: "box",
    color: "#9AA0A8",
    size: [1.4, 0.75, 0.8],
  });

  store().updateTransform(mannequinId, { position: [9, 0, 9] });
  assert.deepEqual(store().objects[mannequinId]!.transform.position, [9, 0, 9]);
  assert.deepEqual(store().objects[mannequinId]!.transform.scale, [1, 1, 1]);

  store().setPose(mannequinId, "sit");
  const mannequin = store().objects[mannequinId]!;
  assert.ok(isMannequinObject(mannequin));
  assert.equal(mannequin.pose, "sit");
  // 几何体 setPose 无效
  store().setPose(geometryId, "run");
  assert.equal(store().objects[geometryId]!.type, "geometry");

  store().setBodyType(mannequinId, "chibi");
  assert.equal((store().objects[mannequinId] as typeof mannequin).bodyType, "chibi");

  store().setJoint(mannequinId, "head", [10, 0, 0]);
  assert.deepEqual((store().objects[mannequinId] as typeof mannequin).joints["head"], [10, 0, 0]);
});

test("setColor 对机位/模型忽略；updateGeometry/setCrowdParams 约束", () => {
  const cameraId = addTestCamera();
  store().setColor(cameraId, "#FF0000");
  assert.equal(store().objects[cameraId]!.type, "camera");
  assert.ok(isCameraObject(store().objects[cameraId]!));

  const geometryId = store().addObject({
    name: "几何",
    type: "geometry",
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    shape: "box",
    color: "#9AA0A8",
    size: [1, 1, 1],
  });
  store().updateGeometry(geometryId, { size: [2, 3, 4] });
  assert.deepEqual((store().objects[geometryId] as { size: number[] }).size, [2, 3, 4]);

  const crowdId = store().addObject({
    name: "群众",
    type: "crowd",
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    rows: 2,
    cols: 2,
    spacing: 1,
    color: "#6AC6C6",
  });
  store().setCrowdParams(crowdId, { rows: 0.4, cols: 99, spacing: 0.01 });
  const crowd = store().objects[crowdId]!;
  assert.equal(crowd.type, "crowd");
  if (crowd.type === "crowd") {
    assert.equal(crowd.rows, 1);
    assert.equal(crowd.cols, 99);
    assert.equal(crowd.spacing, 0.2);
  }
});

test("addCamera 缺省参数与命名；updateCamera 改焦距/目标点", () => {
  const id = store().addCamera();
  const camera = store().objects[id]!;
  assert.ok(isCameraObject(camera));
  assert.equal(camera.focalLength, 35);
  assert.deepEqual(camera.target, [0, 1, 0]);
  assert.match(camera.name, /^机位 \d+$/);

  store().updateCamera(id, { focalLength: 85, target: [1, 1, 1] });
  const updated = store().objects[id]!;
  if (isCameraObject(updated)) {
    assert.equal(updated.focalLength, 85);
    assert.deepEqual(updated.target, [1, 1, 1]);
  }
});

test("setViewMode：无机位时切机位视角停留导演视角", () => {
  store().setViewMode("camera");
  assert.equal(store().viewMode, "director");
});

test("replaceSceneState：整体装载并做防御回落", () => {
  const seed = createSeedSceneState();
  // 放一台机位，activeCameraId 指向不存在对象 → 回落到该机位
  seed.objects["cam-x"] = {
    id: "cam-x",
    name: "主机位",
    type: "camera",
    visible: true,
    transform: { position: [3, 2.2, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    focalLength: 35,
    target: [0, 1, 0],
  };
  seed.order.push("cam-x");
  // 脏数据：activeCameraId 指向不存在对象、selectedId 悬空、机位视角
  const slice = {
    ...seed,
    activeCameraId: "ghost",
    selectedId: "ghost",
    viewMode: "camera" as const,
  };
  store().replaceSceneState(slice);
  assert.equal(store().activeCameraId, "cam-x");
  assert.equal(store().selectedId, null);
  // 无机位时强制退回导演视角
  store().replaceSceneState({ ...createSeedSceneState(), viewMode: "camera" });
  assert.equal(store().viewMode, "director");
  assert.equal(store().activeCameraId, null);
});

test("replaceSceneState 推进 uid 序号，装载 ds-N id 后新增不撞车", () => {
  const seed = createSeedSceneState();
  seed.objects["ds-41"] = {
    id: "ds-41",
    name: "旧几何",
    type: "geometry",
    visible: true,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    shape: "box",
    color: "#9AA0A8",
    size: [1, 1, 1],
  };
  seed.order.push("ds-41");
  store().replaceSceneState(seed);
  const newId = store().addCamera();
  const seq = Number(newId.slice(3));
  assert.ok(seq > 41, `新 id ${newId} 应晚于装载的最大 ds-41`);
});

test("resetToSeed 恢复默认（含 gizmoMode）", () => {
  addTestMannequin();
  addTestCamera();
  store().setGizmoMode("scale");
  store().setAspect("16:9");
  store().resetToSeed();
  assert.equal(store().gizmoMode, "translate");
  assert.equal(store().aspect, "9:16");
  assert.equal(store().order.length, 0);
  assert.equal(store().activeCameraId, null);
});
