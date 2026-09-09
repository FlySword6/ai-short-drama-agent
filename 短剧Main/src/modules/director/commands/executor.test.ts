import assert from "node:assert/strict";
import test from "node:test";
import { directorCommandSchema, type DirectorCommand } from "../commands.js";
import { applyCommand, CommandExecutionError, undo } from "./executor.js";
import type { SceneCamera, SceneObject, SceneSnapshot } from "./snapshot.js";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sceneId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const assetEntityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function mannequin(id: string, name = id): SceneObject {
  return {
    id,
    type: "mannequin",
    name,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    pose: { preset: "stand" },
    attachments: [],
  };
}

function camera(id: string, name = id): SceneCamera {
  return {
    id,
    type: "camera",
    name,
    focalLength: 50,
    target: { x: 0, y: 1, z: 0 },
    transform: { position: { x: 0, y: 1.5, z: -3 } },
  };
}

function baseSnapshot(overrides: Partial<SceneSnapshot> = {}): SceneSnapshot {
  return {
    schemaVersion: 1,
    objects: [mannequin("obj-a"), mannequin("obj-b")],
    cameras: [camera("cam-1")],
    selectedObjectId: null,
    activeCameraId: "cam-1",
    aspectRatio: "9:16",
    environment: { preset: "studio", backgroundColor: "#1E1E1E", ambientLight: 0.6, groundVisible: true },
    ...overrides,
  };
}

function command(input: Record<string, unknown>): DirectorCommand {
  return directorCommandSchema.parse({ projectId, sceneId, sceneVersion: 3, ...input });
}

function applyAndUndoRoundtrip(snapshot: SceneSnapshot, cmd: DirectorCommand) {
  const before = structuredClone(snapshot);
  const applied = applyCommand(snapshot, cmd);
  assert.deepEqual(snapshot, before, "applyCommand 不得修改输入快照");
  const restored = undo(applied.snapshot, applied.inverse);
  return { applied, restored };
}

test("add_object 追加对象，inverse 删除之，undo 还原", () => {
  const snapshot = baseSnapshot();
  const obj = mannequin("obj-c", "新角色");
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "add_object",
    payload: { object: obj },
  }));
  assert.equal(applied.snapshot.objects.length, 3);
  assert.equal(applied.snapshot.objects[2]?.id, "obj-c");
  assert.deepEqual(applied.inverse, { type: "delete_object", objectId: "obj-c" });
  assert.deepEqual(restored, snapshot);
});

test("add_object 重复 id（含机位 id）拒绝", () => {
  const snapshot = baseSnapshot();
  assert.throws(
    () => applyCommand(snapshot, command({ type: "add_object", payload: { object: mannequin("cam-1") } })),
    (error: unknown) => error instanceof CommandExecutionError && /已存在/.test(error.message),
  );
});

test("duplicate_object 复制对象并改名，undo 移除副本", () => {
  const snapshot = baseSnapshot();
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "duplicate_object",
    payload: { objectId: "obj-a" },
  }));
  assert.equal(applied.snapshot.objects.length, 3);
  const copy = applied.snapshot.objects[2];
  assert.equal(copy?.id, "obj-a-copy");
  assert.equal(copy?.name, "obj-a 副本");
  assert.notEqual(copy, applied.snapshot.objects[0], "副本必须是深拷贝");
  assert.deepEqual(applied.inverse, { type: "delete_object", objectId: "obj-a-copy" });
  assert.deepEqual(restored, snapshot);
});

test("duplicate_object 支持机位与显式新 id，冲突拒绝", () => {
  const snapshot = baseSnapshot();
  const applied = applyCommand(snapshot, command({
    type: "duplicate_object",
    payload: { objectId: "cam-1", newObjectId: "cam-2", name: "备用机位" },
  }));
  assert.equal(applied.snapshot.cameras.length, 2);
  assert.equal(applied.snapshot.cameras[1]?.type, "camera");
  assert.equal(applied.snapshot.cameras[1]?.name, "备用机位");
  assert.throws(
    () => applyCommand(snapshot, command({ type: "duplicate_object", payload: { objectId: "obj-a", newObjectId: "obj-b" } })),
    (error: unknown) => error instanceof CommandExecutionError && /已存在/.test(error.message),
  );
});

test("delete_object 删除对象并留完整 inverse，undo 还原", () => {
  const snapshot = baseSnapshot({ objects: [mannequin("obj-a")] });
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "delete_object",
    payload: { objectId: "obj-a" },
  }));
  assert.equal(applied.snapshot.objects.length, 0);
  assert.deepEqual(applied.inverse, {
    type: "add_object",
    collection: "objects",
    object: mannequin("obj-a"),
  });
  assert.deepEqual(restored, snapshot);
});

test("delete_object 删除机位、清理 selected/active 指针；不存在则报错", () => {
  const snapshot = baseSnapshot({ selectedObjectId: "cam-1" });
  const applied = applyCommand(snapshot, command({ type: "delete_object", payload: { objectId: "cam-1" } }));
  assert.equal(applied.snapshot.cameras.length, 0);
  assert.equal(applied.snapshot.activeCameraId, null);
  assert.equal(applied.snapshot.selectedObjectId, null);
  assert.equal(applied.inverse.type, "add_object");
  assert.equal(applied.inverse.type === "add_object" ? applied.inverse.collection : null, "cameras");
  assert.throws(
    () => applyCommand(snapshot, command({ type: "delete_object", payload: { objectId: "ghost" } })),
    (error: unknown) => error instanceof CommandExecutionError && /不存在/.test(error.message),
  );
});

test("select_object 设置/取消选择，undo 恢复旧选择", () => {
  const snapshot = baseSnapshot({ selectedObjectId: "obj-a" });
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "select_object",
    payload: { objectId: null },
  }));
  assert.equal(applied.snapshot.selectedObjectId, null);
  assert.deepEqual(applied.inverse, { type: "select_object", objectId: "obj-a" });
  assert.deepEqual(restored, snapshot);
  assert.throws(
    () => applyCommand(snapshot, command({ type: "select_object", payload: { objectId: "ghost" } })),
    (error: unknown) => error instanceof CommandExecutionError && /不存在/.test(error.message),
  );
});

test("set_transform 局部合并，inverse 存旧值，undo 精确还原", () => {
  const snapshot = baseSnapshot();
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "set_transform",
    payload: { objectId: "obj-a", transform: { position: { x: 1, y: 0, z: 2 } } },
  }));
  const moved = applied.snapshot.objects[0];
  assert.deepEqual(moved?.transform.position, { x: 1, y: 0, z: 2 });
  assert.deepEqual(moved?.transform.scale, { x: 1, y: 1, z: 1 }, "未给的分量保持不变");
  assert.equal(applied.inverse.type, "set_transform");
  assert.deepEqual(restored, snapshot);
});

test("set_transform 可用于机位（只有 position）", () => {
  const snapshot = baseSnapshot();
  const applied = applyCommand(snapshot, command({
    type: "set_transform",
    payload: { objectId: "cam-1", transform: { position: { x: 5, y: 2, z: -4 } } },
  }));
  assert.deepEqual(applied.snapshot.cameras[0]?.transform.position, { x: 5, y: 2, z: -4 });
  const restored = undo(applied.snapshot, applied.inverse);
  assert.deepEqual(restored.cameras[0]?.transform, { position: { x: 0, y: 1.5, z: -3 } });
});

test("set_pose 替换姿态，undo 还原；机位/无姿态对象报错", () => {
  const snapshot = baseSnapshot();
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "set_pose",
    payload: { objectId: "obj-a", pose: { preset: "sit" } },
  }));
  assert.deepEqual(applied.snapshot.objects[0]?.pose, { preset: "sit" });
  assert.deepEqual(applied.inverse, {
    type: "set_pose",
    objectId: "obj-a",
    pose: { preset: "stand" },
  });
  assert.deepEqual(restored, snapshot);
  assert.throws(
    () => applyCommand(snapshot, command({ type: "set_pose", payload: { objectId: "cam-1", pose: { preset: "sit" } } })),
    (error: unknown) => error instanceof CommandExecutionError && /不支持姿态调整/.test(error.message),
  );
  const noPose = baseSnapshot({ objects: [{ ...mannequin("obj-x"), pose: undefined }] });
  assert.throws(
    () => applyCommand(noPose, command({ type: "set_pose", payload: { objectId: "obj-x", pose: { preset: "sit" } } })),
    (error: unknown) => error instanceof CommandExecutionError && /不支持姿态/.test(error.message),
  );
});

test("add_camera 追加机位，undo 移除", () => {
  const snapshot = baseSnapshot();
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "add_camera",
    payload: { camera: camera("cam-2", "特写") },
  }));
  assert.equal(applied.snapshot.cameras.length, 2);
  assert.deepEqual(applied.inverse, { type: "delete_object", objectId: "cam-2" });
  assert.deepEqual(restored, snapshot);
  assert.throws(
    () => applyCommand(snapshot, command({ type: "add_camera", payload: { camera: camera("obj-a") } })),
    (error: unknown) => error instanceof CommandExecutionError && /已存在/.test(error.message),
  );
});

test("set_camera 补丁修改与 roll 清除，inverse 存完整旧机位", () => {
  const snapshot = baseSnapshot({
    cameras: [{ ...camera("cam-1"), rollDeg: 6 }],
  });
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "set_camera",
    payload: {
      cameraId: "cam-1",
      patch: { focalLength: 85, target: { x: 1, y: 1.2, z: 0 }, rollDeg: null },
    },
  }));
  const updated = applied.snapshot.cameras[0];
  assert.equal(updated?.focalLength, 85);
  assert.deepEqual(updated?.target, { x: 1, y: 1.2, z: 0 });
  assert.equal(updated && "rollDeg" in updated, false, "rollDeg: null 表示清除");
  assert.deepEqual(applied.inverse, {
    type: "set_camera",
    cameraId: "cam-1",
    camera: { ...camera("cam-1"), rollDeg: 6 },
  });
  assert.deepEqual(restored, snapshot);
  assert.throws(
    () => applyCommand(snapshot, command({ type: "set_camera", payload: { cameraId: "obj-a", patch: { focalLength: 35 } } })),
    (error: unknown) => error instanceof CommandExecutionError && /不是镜头/.test(error.message),
  );
});

test("set_aspect_ratio 切换画幅，undo 还原", () => {
  const snapshot = baseSnapshot();
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "set_aspect_ratio",
    payload: { aspectRatio: "16:9" },
  }));
  assert.equal(applied.snapshot.aspectRatio, "16:9");
  assert.deepEqual(applied.inverse, { type: "set_aspect_ratio", aspectRatio: "9:16" });
  assert.deepEqual(restored, snapshot);
});

test("set_environment 局部合并，inverse 存完整旧环境", () => {
  const snapshot = baseSnapshot();
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "set_environment",
    payload: { patch: { preset: "night-street", ambientLight: 0.2 } },
  }));
  assert.equal(applied.snapshot.environment.preset, "night-street");
  assert.equal(applied.snapshot.environment.ambientLight, 0.2);
  assert.equal(applied.snapshot.environment.groundVisible, true, "未给的字段保持不变");
  assert.deepEqual(applied.inverse, {
    type: "set_environment",
    environment: { preset: "studio", backgroundColor: "#1E1E1E", ambientLight: 0.6, groundVisible: true },
  });
  assert.deepEqual(restored, snapshot);
});

test("attach_asset 挂载资产，重复拒绝，undo 摘除", () => {
  const snapshot = baseSnapshot();
  const asset = { assetEntityId, assetMediaId: null, name: "参考图" };
  const { applied, restored } = applyAndUndoRoundtrip(snapshot, command({
    type: "attach_asset",
    payload: { objectId: "obj-a", asset },
  }));
  assert.equal(applied.snapshot.objects[0]?.attachments.length, 1);
  assert.deepEqual(applied.inverse, { type: "detach_asset", objectId: "obj-a", assetEntityId });
  assert.deepEqual(restored, snapshot);
  assert.throws(
    () => applyCommand(applied.snapshot, command({ type: "attach_asset", payload: { objectId: "obj-a", asset } })),
    (error: unknown) => error instanceof CommandExecutionError && /已经挂在所选对象上/.test(error.message),
  );
  assert.throws(
    () => applyCommand(snapshot, command({ type: "attach_asset", payload: { objectId: "cam-1", asset } })),
    (error: unknown) => error instanceof CommandExecutionError && /不能挂载素材/.test(error.message),
  );
});

test("save_scene / capture_view / undo 是恒等动作命令，inverse 为 noop", () => {
  const snapshot = baseSnapshot();
  for (const cmd of [
    command({ type: "save_scene" }),
    command({ type: "capture_view", payload: { cameraId: "cam-1", label: "主机位" } }),
    command({ type: "undo" }),
  ]) {
    const applied = applyCommand(snapshot, cmd);
    assert.deepEqual(applied.snapshot, snapshot, `${cmd.type} 不得改变快照`);
    assert.equal(applied.inverse.type, "noop");
    assert.deepEqual(undo(applied.snapshot, applied.inverse), snapshot);
  }
});

test("连续命令可链式执行并逐条撤销", () => {
  const snapshot = baseSnapshot();
  const step1 = applyCommand(snapshot, command({ type: "add_object", payload: { object: mannequin("obj-c") } }));
  const step2 = applyCommand(step1.snapshot, command({
    type: "set_transform",
    payload: { objectId: "obj-c", transform: { position: { x: 2, y: 0, z: 2 } } },
  }));
  const step3 = applyCommand(step2.snapshot, command({
    type: "set_pose",
    payload: { objectId: "obj-c", pose: { preset: "bow" } },
  }));
  assert.equal(step3.snapshot.objects.length, 3);
  assert.deepEqual(step3.snapshot.objects[2]?.transform.position, { x: 2, y: 0, z: 2 });
  assert.deepEqual(step3.snapshot.objects[2]?.pose, { preset: "bow" });

  const back2 = undo(step3.snapshot, step3.inverse);
  assert.deepEqual(back2, step2.snapshot);
  const back1 = undo(back2, step2.inverse);
  assert.deepEqual(back1, step1.snapshot);
  const back0 = undo(back1, step1.inverse);
  assert.deepEqual(back0, snapshot);
});
