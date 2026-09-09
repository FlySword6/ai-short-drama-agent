import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECTOR_COMMAND_TYPES,
  directorCommandSchema,
  validateCommandsBodySchema,
} from "./commands.js";

const base = {
  projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sceneId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  sceneVersion: 0,
};

const objectFixture = {
  id: "obj-1",
  type: "mannequin",
  name: "甲",
  transform: {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  },
};

const cameraFixture = {
  id: "cam-1",
  type: "camera",
  name: "主机位",
  focalLength: 50,
  target: { x: 0, y: 1, z: 0 },
  transform: { position: { x: 0, y: 1.5, z: -3 } },
};

const validSamples: Record<string, unknown> = {
  add_object: { type: "add_object", payload: { object: objectFixture } },
  duplicate_object: { type: "duplicate_object", payload: { objectId: "obj-1" } },
  delete_object: { type: "delete_object", payload: { objectId: "obj-1" } },
  select_object: { type: "select_object", payload: { objectId: null } },
  set_transform: { type: "set_transform", payload: { objectId: "obj-1", transform: { position: { x: 1, y: 0, z: 0 } } } },
  set_pose: { type: "set_pose", payload: { objectId: "obj-1", pose: { preset: "walk" } } },
  add_camera: { type: "add_camera", payload: { camera: cameraFixture } },
  set_camera: { type: "set_camera", payload: { cameraId: "cam-1", patch: { focalLength: 35 } } },
  set_aspect_ratio: { type: "set_aspect_ratio", payload: { aspectRatio: "16:9" } },
  set_environment: { type: "set_environment", payload: { patch: { ambientLight: 0.3 } } },
  attach_asset: {
    type: "attach_asset",
    payload: { objectId: "obj-1", asset: { assetEntityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
  },
  save_scene: { type: "save_scene" },
  capture_view: { type: "capture_view", payload: { cameraId: "cam-1" } },
  undo: { type: "undo" },
};

test("合同覆盖且仅覆盖 14 种命令", () => {
  assert.equal(DIRECTOR_COMMAND_TYPES.length, 14);
  assert.deepEqual(Object.keys(validSamples).sort(), [...DIRECTOR_COMMAND_TYPES].sort());
});

test("14 种命令的合法样例全部通过 zod 校验", () => {
  for (const [type, sample] of Object.entries(validSamples)) {
    const parsed = directorCommandSchema.safeParse({ ...base, ...(sample as Record<string, unknown>) });
    assert.equal(parsed.success, true, `${type} 应通过: ${parsed.success ? "" : parsed.error.message}`);
    if (parsed.success) assert.equal(parsed.data.type, type);
  }
});

test("缺 projectId/sceneId/sceneVersion 或类型未知即拒绝", () => {
  for (const missing of ["projectId", "sceneId", "sceneVersion"] as const) {
    const input = { ...base, type: "delete_object", payload: { objectId: "x" } };
    delete (input as Record<string, unknown>)[missing];
    assert.equal(directorCommandSchema.safeParse(input).success, false, `缺 ${missing} 应失败`);
  }
  assert.equal(directorCommandSchema.safeParse({ ...base, type: "teleport", payload: {} }).success, false);
  assert.equal(directorCommandSchema.safeParse({ ...base, sceneVersion: -1, type: "undo" }).success, false);
});

test("payload 类型化校验：空补丁、非法画幅、非法 uuid 均拒绝", () => {
  assert.equal(directorCommandSchema.safeParse({
    ...base, type: "set_transform", payload: { objectId: "o", transform: {} },
  }).success, false);
  assert.equal(directorCommandSchema.safeParse({
    ...base, type: "set_camera", payload: { cameraId: "c", patch: {} },
  }).success, false);
  assert.equal(directorCommandSchema.safeParse({
    ...base, type: "set_environment", payload: { patch: {} },
  }).success, false);
  assert.equal(directorCommandSchema.safeParse({
    ...base, type: "set_aspect_ratio", payload: { aspectRatio: "21:9" },
  }).success, false);
  assert.equal(directorCommandSchema.safeParse({
    ...base, type: "attach_asset", payload: { objectId: "o", asset: { assetEntityId: "not-a-uuid" } },
  }).success, false);
});

test("validate 请求体：命令数 1-100，逐条过命令合同", () => {
  const good = {
    sceneId: base.sceneId,
    sceneVersion: 3,
    commands: [{ ...base, type: "undo" }],
  };
  assert.equal(validateCommandsBodySchema.safeParse(good).success, true);
  assert.equal(validateCommandsBodySchema.safeParse({ ...good, commands: [] }).success, false);
  assert.equal(validateCommandsBodySchema.safeParse({
    ...good,
    commands: Array.from({ length: 101 }, () => ({ ...base, type: "undo" })),
  }).success, false);
  assert.equal(validateCommandsBodySchema.safeParse({
    ...good,
    commands: [{ ...base, type: "delete_object" }],
  }).success, false, "payload 缺失应失败");
});
