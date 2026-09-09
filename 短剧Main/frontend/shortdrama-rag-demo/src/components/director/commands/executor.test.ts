/**
 * 3D 导演台 · 命令执行器测试（14 种 DirectorCommand 正反 + 撤销）
 *
 * 与后端同构：同一 zod 合同校验、同一 applyCommand/undo 纯函数，
 * 这里验证「校验 → store 映射 → inverse 撤销栈」的端到端行为。
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  executeDirectorCommand,
  undoDirectorCommand,
  directorUndoDepth,
  clearDirectorCommandHistory,
} from "./index";
import { toSceneSnapshot } from "../snapshot";
import { useDirectorStore } from "../store";
import { isCameraObject, isMannequinObject } from "../types";
import { newId } from "../../../uuid";

const PROJECT_ID = newId();
const SCENE_ID = newId();

/** 构造完整命令（commandBase + type + payload） */
function cmd(type: string, payload?: Record<string, unknown>): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    sceneId: SCENE_ID,
    sceneVersion: 0,
    type,
    ...(payload ? { payload } : {}),
  };
}

const xyz = (x: number, y: number, z: number) => ({ x, y, z });

const store = () => useDirectorStore.getState();

beforeEach(() => {
  useDirectorStore.getState().resetToSeed();
  clearDirectorCommandHistory();
  // W5.5 空台后命令用例需要既有对象：按原种子场景关键成员自建
  // （order[0]=男主 素模 pose 站立 / order[1]=总览 机位 35mm target [0,0.85,0.1]，后者自动成为活动机位）
  const state = useDirectorStore.getState();
  state.addObject({
    name: "男主",
    type: "mannequin",
    visible: true,
    transform: { position: [-1.05, 0, 0.95], rotation: [0, 140, 0], scale: [1, 1, 1] },
    color: "#4A82E1",
    bodyType: "male",
    pose: "站立",
    joints: {},
  });
  state.addObject({
    name: "总览",
    type: "camera",
    visible: true,
    transform: { position: [3.4, 2.7, 4.6], rotation: [0, 0, 0], scale: [1, 1, 1] },
    focalLength: 35,
    target: [0, 0.85, 0.1],
  });
});

test("add_object：入场景并入撤销栈，undo 移除", () => {
  const inverse = executeDirectorCommand(
    cmd("add_object", {
      object: {
        id: "box-1",
        type: "geometry",
        name: "盒子",
        shape: "box",
        color: "#9AA0A8",
        size: [1, 1, 1],
        transform: { position: xyz(1, 0, 1) },
      },
    }),
  );
  assert.equal(inverse.type, "delete_object");
  assert.ok(store().objects["box-1"]);
  assert.equal(directorUndoDepth(), 1);

  assert.equal(undoDirectorCommand(), true);
  assert.equal(store().objects["box-1"], undefined);
  assert.equal(directorUndoDepth(), 0);
});

test("add_object 重复 id 抛 CommandExecutionError", () => {
  const existing = store().order[0]!;
  assert.throws(
    () =>
      executeDirectorCommand(
        cmd("add_object", {
          object: { id: existing, type: "geometry", name: "撞车", shape: "box", size: [1, 1, 1], transform: { position: xyz(0, 0, 0) } },
        }),
      ),
    /已存在/,
  );
});

test("duplicate_object：复制 男主 → 默认名「 副本」，undo 删除副本", () => {
  const sourceId = store().order[0]!;
  executeDirectorCommand(cmd("duplicate_object", { objectId: sourceId, newObjectId: "dup-1" }));
  const copy = store().objects["dup-1"];
  assert.ok(copy);
  assert.equal(copy!.name, `${store().objects[sourceId]!.name} 副本`);
  undoDirectorCommand();
  assert.equal(store().objects["dup-1"], undefined);
});

test("delete_object：删除后可撤销恢复", () => {
  const targetId = store().order[0]!;
  const before = structuredClone(store().objects[targetId]!);
  executeDirectorCommand(cmd("delete_object", { objectId: targetId }));
  assert.equal(store().objects[targetId], undefined);
  undoDirectorCommand();
  assert.deepEqual(store().objects[targetId], before);
});

test("select_object：选中与撤销恢复前一个选中态", () => {
  const targetId = store().order[1]!;
  executeDirectorCommand(cmd("select_object", { objectId: targetId }));
  assert.equal(store().selectedId, targetId);
  undoDirectorCommand();
  assert.equal(store().selectedId, null);
});

test("set_transform：位置补丁应用，undo 精确还原", () => {
  const targetId = store().order[0]!;
  const before = structuredClone(store().objects[targetId]!.transform);
  executeDirectorCommand(cmd("set_transform", { objectId: targetId, transform: { position: xyz(5, 0, 5) } }));
  assert.deepEqual(store().objects[targetId]!.transform.position, [5, 0, 5]);
  undoDirectorCommand();
  assert.deepEqual(store().objects[targetId]!.transform, before);
});

test("set_pose：素模姿势切换与撤销；对机位执行抛错", () => {
  const mannequinId = store().order[0]!;
  executeDirectorCommand(cmd("set_pose", { objectId: mannequinId, pose: { preset: "sit" } }));
  const mannequin = store().objects[mannequinId]!;
  assert.ok(isMannequinObject(mannequin));
  assert.equal(mannequin.pose, "sit");
  undoDirectorCommand();
  assert.equal((store().objects[mannequinId] as typeof mannequin).pose, "站立");

  const cameraId = store().activeCameraId!;
  assert.throws(
    () => executeDirectorCommand(cmd("set_pose", { objectId: cameraId, pose: { preset: "sit" } })),
    /没有姿态/,
  );
});

test("add_camera：新机位入场景，undo 移除", () => {
  executeDirectorCommand(
    cmd("add_camera", {
      camera: {
        id: "cam-new",
        name: "轨道",
        focalLength: 24,
        target: xyz(0, 1, 0),
        transform: { position: xyz(4, 2, 4) },
      },
    }),
  );
  const camera = store().objects["cam-new"]!;
  assert.ok(isCameraObject(camera));
  if (isCameraObject(camera)) assert.equal(camera.focalLength, 24);
  undoDirectorCommand();
  assert.equal(store().objects["cam-new"], undefined);
});

test("set_camera：焦距/目标点补丁，undo 还原原机位", () => {
  const cameraId = store().activeCameraId!;
  executeDirectorCommand(cmd("set_camera", { cameraId, patch: { focalLength: 85, target: xyz(1, 2, 3) } }));
  const camera = store().objects[cameraId]!;
  assert.ok(isCameraObject(camera));
  if (isCameraObject(camera)) {
    assert.equal(camera.focalLength, 85);
    assert.deepEqual(camera.target, [1, 2, 3]);
  }
  undoDirectorCommand();
  const restored = store().objects[cameraId]!;
  if (isCameraObject(restored)) {
    assert.equal(restored.focalLength, 35);
    assert.deepEqual(restored.target, [0, 0.85, 0.1]);
  }
});

test("set_aspect_ratio：切换与撤销（含 store 画幅映射）", () => {
  executeDirectorCommand(cmd("set_aspect_ratio", { aspectRatio: "1:1" }));
  assert.equal(store().aspect, "1:1");
  undoDirectorCommand();
  assert.equal(store().aspect, "9:16");
});

test("set_environment：预设/背景色补丁，undo 还原", () => {
  executeDirectorCommand(
    cmd("set_environment", { patch: { preset: "dusk", backgroundColor: "#112233" } }),
  );
  assert.equal(store().environment, "dusk");
  assert.equal(store().scene.skyColor, "#112233");
  undoDirectorCommand();
  assert.equal(store().environment, "studio");
  assert.equal(store().scene.skyColor, "#15181E");
});

test("attach_asset：资产挂载经快照透传，undo 卸载", () => {
  const targetId = store().order[0]!;
  const assetEntityId = newId();
  executeDirectorCommand(
    cmd("attach_asset", { objectId: targetId, asset: { assetEntityId, assetMediaId: null, name: "参考图" } }),
  );
  // attachments 不进 store 领域模型，但快照序列化必须透传（保存不丢）
  const snapshot = toSceneSnapshot(store(), {});
  const entry = snapshot.objects.find((item) => item.id === targetId) as Record<string, unknown>;
  const attachments = entry["attachments"] as Array<Record<string, unknown>>;
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0]!["assetEntityId"], assetEntityId);

  undoDirectorCommand();
  const after = toSceneSnapshot(store(), {});
  const restored = after.objects.find((item) => item.id === targetId) as Record<string, unknown>;
  // 卸载后 attachments 为缺省空数组（空数组不进 extras，序列化不再显式发射）
  assert.equal(((restored["attachments"] as Array<unknown> | undefined) ?? []).length, 0);
});

test("save_scene / capture_view：动作类命令快照恒等，inverse 为 noop 不压栈", () => {
  const before = toSceneSnapshot(store(), {});
  const inverseSave = executeDirectorCommand(cmd("save_scene"));
  const inverseCapture = executeDirectorCommand(cmd("capture_view", { cameraId: store().activeCameraId! }));
  assert.equal(inverseSave.type, "noop");
  assert.equal(inverseCapture.type, "noop");
  assert.deepEqual(toSceneSnapshot(store(), {}), before);
  assert.equal(directorUndoDepth(), 0);
});

test("undo 命令：直接弹本地撤销栈（不压栈）", () => {
  executeDirectorCommand(
    cmd("add_object", {
      object: { id: "tmp-1", type: "geometry", name: "临时", shape: "box", size: [1, 1, 1], transform: { position: xyz(0, 0, 0) } },
    }),
  );
  assert.ok(store().objects["tmp-1"]);
  const inverse = executeDirectorCommand(cmd("undo"));
  assert.equal(inverse.type, "noop");
  assert.equal(store().objects["tmp-1"], undefined);
  assert.equal(directorUndoDepth(), 0);
});

test("undoDirectorCommand：空栈返回 false", () => {
  assert.equal(undoDirectorCommand(), false);
});

test("结构非法命令抛 zod 错误（类型未知 / 缺 commandBase / uuid 非法）", () => {
  assert.throws(() => executeDirectorCommand({ type: "bogus" }));
  assert.throws(() => executeDirectorCommand(cmd("select_object", {})));
  assert.throws(() =>
    executeDirectorCommand({
      projectId: "not-a-uuid",
      sceneId: SCENE_ID,
      sceneVersion: 0,
      type: "select_object",
      payload: { objectId: null },
    }),
  );
});

test("连续命令 + 连续撤销：栈序精确回放", () => {
  const targetId = store().order[0]!;
  executeDirectorCommand(cmd("set_transform", { objectId: targetId, transform: { position: xyz(1, 0, 1) } }));
  executeDirectorCommand(cmd("set_transform", { objectId: targetId, transform: { position: xyz(2, 0, 2) } }));
  executeDirectorCommand(cmd("set_pose", { objectId: targetId, pose: { preset: "bow" } }));
  assert.equal(directorUndoDepth(), 3);

  undoDirectorCommand(); // 撤销 pose
  assert.equal((store().objects[targetId] as { pose?: string }).pose, "站立");
  undoDirectorCommand(); // 撤销第二次 transform
  assert.deepEqual(store().objects[targetId]!.transform.position, [1, 0, 1]);
  undoDirectorCommand(); // 撤销第一次 transform
  assert.deepEqual(store().objects[targetId]!.transform.position, [-1.05, 0, 0.95]);
  assert.equal(directorUndoDepth(), 0);
});
