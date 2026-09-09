/**
 * 3D 导演台 · 模版实例化合入测试（POST apply 返回 → store）
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { mergeTemplateScene, parseTemplateApplyScene } from "./templates";
import type { TemplateApplyScene } from "./templates";
import { currentUiStash, toSceneSnapshot } from "./snapshot";
import { useDirectorStore } from "./store";
import { isCameraObject, isMannequinObject } from "./types";

function fakeTemplateScene(): TemplateApplyScene {
  return {
    templateId: "dialogue-ots-2p",
    templateName: "双人对话·过肩正反打",
    objects: [
      {
        id: "mannequin-A",
        role: "A",
        name: "男主",
        type: "mannequin",
        bodyType: "male",
        color: "#d14836",
        height: 1.75,
        pose: { preset: "stand" },
        transform: {
          position: { x: -0.7, y: 0, z: 0 },
          rotation: { x: 0, y: 90, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
      {
        id: "mannequin-B",
        role: "B",
        name: "女主",
        type: "mannequin",
        bodyType: "female",
        color: "#4A82E1",
        height: 1.64,
        pose: { preset: "sit" },
        transform: {
          position: { x: 0.7, y: 0, z: 0 },
          rotation: { x: 0, y: -90, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
        },
      },
    ],
    cameras: [
      {
        id: "camera-1",
        name: "过肩A",
        type: "camera",
        focalLength: 50,
        target: { x: 0.7, y: 1.44, z: 0 },
        transform: { position: { x: -1.5, y: 1.6, z: 0.5 } },
        rollDeg: 6,
        meta: { kind: "relational", relation: "OTS", side: "left", subjectRoles: ["A", "B"] },
      },
      {
        id: "camera-2",
        name: "过肩B",
        type: "camera",
        focalLength: 50,
        target: { x: -0.7, y: 1.54, z: 0 },
        transform: { position: { x: 1.5, y: 1.6, z: 0.5 } },
      },
    ],
  };
}

beforeEach(() => {
  useDirectorStore.getState().resetToSeed();
});

test("合入：素模站位/朝向/姿势/配色/身高缩放全部映射进 store", () => {
  const before = useDirectorStore.getState().order.length;
  const result = mergeTemplateScene(fakeTemplateScene());
  const state = useDirectorStore.getState();
  assert.equal(state.order.length, before + 4);
  assert.equal(result.addedObjectIds.length, 2);
  assert.equal(result.addedCameraIds.length, 2);
  assert.equal(result.sourceAction, "template:apply:dialogue-ots-2p");
  assert.equal(result.templateName, "双人对话·过肩正反打");

  const a = state.objects[result.addedObjectIds[0]!]!;
  assert.ok(isMannequinObject(a));
  assert.equal(a.name, "男主");
  assert.equal(a.bodyType, "male");
  assert.equal(a.color, "#D14836"); // 统一大写
  assert.equal(a.pose, "stand");
  assert.deepEqual(a.transform.position, [-0.7, 0, 0]);
  assert.deepEqual(a.transform.rotation, [0, 90, 0]);
  // 身高折算统一缩放：1.75 / BODIES.male.height(1.76) ≈ 0.994
  assert.ok(Math.abs(a.transform.scale[0] - 0.994) < 0.001);

  const b = state.objects[result.addedObjectIds[1]!]!;
  assert.ok(isMannequinObject(b));
  assert.equal(b.bodyType, "female");
  assert.equal(b.pose, "sit");
  // 1.64 / 1.64 = 1
  assert.ok(Math.abs(b.transform.scale[0] - 1) < 0.001);

  const camA = state.objects[result.addedCameraIds[0]!]!;
  assert.ok(isCameraObject(camA));
  assert.equal(camA.name, "过肩A");
  assert.equal(camA.focalLength, 50);
  assert.deepEqual(camA.target, [0.7, 1.44, 0]);
  assert.deepEqual(camA.transform.position, [-1.5, 1.6, 0.5]);
});

test("合入：rollDeg/meta/templateId 经 extras 暂存，保存快照透传留痕", () => {
  const result = mergeTemplateScene(fakeTemplateScene());
  const stash = currentUiStash();
  const camExtras = stash?.objectExtras?.[result.addedCameraIds[0]!];
  assert.ok(camExtras);
  assert.equal(camExtras["rollDeg"], 6);
  assert.equal(camExtras["templateId"], "dialogue-ots-2p");
  assert.ok(camExtras["meta"]);
  const roleExtras = stash?.objectExtras?.[result.addedObjectIds[0]!];
  assert.equal(roleExtras?.["role"], "A");

  // persist 快照里透传
  const snapshot = toSceneSnapshot(useDirectorStore.getState(), { persist: true });
  const camEntry = snapshot.cameras.find((item) => item.id === result.addedCameraIds[0]!) as Record<string, unknown>;
  assert.equal(camEntry["rollDeg"], 6);
  assert.equal(camEntry["templateId"], "dialogue-ots-2p");
});

test("重复应用同一模版：id 全部重新分配不撞车", () => {
  const first = mergeTemplateScene(fakeTemplateScene());
  const second = mergeTemplateScene(fakeTemplateScene());
  const ids = new Set([...first.addedObjectIds, ...first.addedCameraIds, ...second.addedObjectIds, ...second.addedCameraIds]);
  assert.equal(ids.size, 8);
});

test("parseTemplateApplyScene：结构非法抛错", () => {
  assert.throws(() => parseTemplateApplyScene(null));
  assert.throws(() => parseTemplateApplyScene({ templateId: "x" }));
  const parsed = parseTemplateApplyScene({ templateId: "t", templateName: "n", objects: [], cameras: [] });
  assert.equal(parsed.templateId, "t");
});

test("非法焦距回落 35；缺失字段回落默认", () => {
  const scene = fakeTemplateScene();
  scene.cameras[0]!.focalLength = 99;
  scene.objects[0]!.color = "not-a-color";
  const result = mergeTemplateScene(scene);
  const state = useDirectorStore.getState();
  const cam = state.objects[result.addedCameraIds[0]!]!;
  if (isCameraObject(cam)) assert.equal(cam.focalLength, 35);
  const mannequin = state.objects[result.addedObjectIds[0]!]!;
  if (isMannequinObject(mannequin)) assert.equal(mannequin.color, "#9AA0A8");
});
