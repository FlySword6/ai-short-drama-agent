/*
 * S8 P1-9 导演台快捷键：store 层复制/粘贴单测 + StageCanvas 快捷键绑定源码断言。
 *
 * 快捷键合同（与帮助浮层一致）：G 平移 / R 旋转 / S 缩放、Ctrl/Cmd+C 复制、
 * Ctrl/Cmd+V 粘贴、Ctrl/Cmd+Z 撤销（命令栈）、Delete 删除、F 聚焦、Esc 取消选中。
 * 撤销走 commands/index.ts 的 undoDirectorCommand，不自建第二撤销栈。
 */
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { useDirectorStore } from "./store";

const store = () => useDirectorStore.getState();

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** 放一个素模（沿用 store.test.ts 的「男主」参数） */
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

/** 放一台机位（沿用 store.test.ts 的「总览」参数） */
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

/* ──────────────────────────── store 层：复制 / 粘贴 ──────────────────────────── */

test("copyObject/pasteObject：新 uid 唯一、x/z 各偏移 0.5m、选中新对象", () => {
  const sourceId = addTestMannequin();
  const sourcePosition = store().objects[sourceId]!.transform.position;

  assert.equal(store().copyObject(sourceId), true);
  assert.equal(store().clipboard?.id, sourceId, "剪贴板保留源对象快照（id 在粘贴时才换新）");

  const firstId = store().pasteObject();
  assert.ok(firstId);
  assert.notEqual(firstId, sourceId, "粘贴必须生成新 uid");
  const first = store().objects[firstId]!;
  assert.deepEqual(first.transform.position, [
    sourcePosition[0] + 0.5,
    sourcePosition[1],
    sourcePosition[2] + 0.5,
  ]);
  assert.equal(store().selectedId, firstId, "粘贴后选中新对象");
  assert.equal(store().order.at(-1), firstId, "新对象追加到清单末尾");

  // 连续粘贴：uid 不撞车，落点按上一次位置递进 0.5m，不叠罗汉
  const secondId = store().pasteObject();
  assert.ok(secondId);
  assert.notEqual(secondId, firstId);
  assert.notEqual(secondId, sourceId);
  assert.deepEqual(store().objects[secondId]!.transform.position, [
    first.transform.position[0] + 0.5,
    first.transform.position[1],
    first.transform.position[2] + 0.5,
  ]);
  assert.equal(store().selectedId, secondId);
});

test("copyObject 深拷贝解耦：源对象改动/删除不影响粘贴内容", () => {
  const sourceId = addTestMannequin();
  const copiedPosition = [...store().objects[sourceId]!.transform.position];
  assert.equal(store().copyObject(sourceId), true);

  // 复制后源对象被移动、改名、删除：粘贴仍用复制时刻的快照
  store().updateTransform(sourceId, { position: [9, 0, 9] });
  store().renameObject(sourceId, "被挪走的男主");
  store().removeObject(sourceId);
  assert.equal(store().objects[sourceId], undefined);

  const pastedId = store().pasteObject();
  assert.ok(pastedId);
  const pasted = store().objects[pastedId]!;
  assert.equal(pasted.name, "男主", "粘贴内容不受源对象改名影响");
  assert.deepEqual(pasted.transform.position, [
    copiedPosition[0]! + 0.5,
    copiedPosition[1],
    copiedPosition[2]! + 0.5,
  ]);
});

test("pasteObject 空剪贴板返回 null；copyObject 不存在对象返回 false", () => {
  assert.equal(store().clipboard, null);
  assert.equal(store().pasteObject(), null, "空剪贴板粘贴不创建对象");
  assert.equal(store().order.length, 0);
  assert.equal(store().copyObject("no-such-id"), false);
  assert.equal(store().clipboard, null, "复制失败不写入剪贴板");
});

test("粘贴机位：位置同样偏移 0.5m，无活动机位时粘贴机位自动接管", () => {
  const cameraId = addTestCamera();
  const sourcePosition = [...store().objects[cameraId]!.transform.position];
  assert.equal(store().copyObject(cameraId), true);
  store().removeObject(cameraId); // 删源机位（剪贴板深拷贝不受影响），活动机位回落 null
  assert.equal(store().activeCameraId, null);

  const pastedId = store().pasteObject();
  assert.ok(pastedId);
  assert.deepEqual(store().objects[pastedId]!.transform.position, [
    sourcePosition[0]! + 0.5,
    sourcePosition[1],
    sourcePosition[2]! + 0.5,
  ]);
  assert.equal(store().selectedId, pastedId);
  assert.equal(store().activeCameraId, pastedId, "粘贴出首个机位时自动成为活动机位");

  // 已有活动机位时再粘贴：活动机位不被抢占
  const againId = store().pasteObject();
  assert.ok(againId);
  assert.equal(store().activeCameraId, pastedId);
});

test("resetToSeed 清空剪贴板", () => {
  const id = addTestMannequin();
  store().copyObject(id);
  assert.ok(store().clipboard);
  store().resetToSeed();
  assert.equal(store().clipboard, null);
  assert.equal(store().pasteObject(), null);
});

/* ──────────────────────────── 源码断言：StageCanvas 快捷键绑定 ──────────────────────────── */

test("G/R/S 切 gizmo 模式，V 键释放不再绑定平移", () => {
  const source = readSource("./StageCanvas.tsx");
  assert.ok(source.includes('case "g":'), "缺 G 键绑定");
  assert.ok(source.includes('state.setGizmoMode("translate")'), "G 必须写 translate");
  assert.ok(source.includes('case "r":'), "缺 R 键绑定");
  assert.ok(source.includes('state.setGizmoMode("rotate")'), "R 必须写 rotate");
  assert.ok(source.includes('case "s":'), "缺 S 键绑定");
  assert.ok(source.includes('state.setGizmoMode("scale")'), "S 必须写 scale");
  // V 键释放：case "v" 附近不允许再出现 setGizmoMode（Ctrl+V 粘贴分支不含 gizmo 写入）
  assert.ok(
    !/case "v"[\s\S]{0,120}setGizmoMode/.test(source),
    'case "v" 不应再绑定 gizmo 模式（V 已释放给 Ctrl/Cmd+V 粘贴）',
  );
});

test("Ctrl/Cmd+C/V/Z 走内部剪贴板与命令栈，且只在真正处理时拦截", () => {
  const source = readSource("./StageCanvas.tsx");
  // 组合键入口与撤销栈来源
  assert.ok(source.includes("event.metaKey || event.ctrlKey"), "缺 Ctrl/Cmd 组合键分支");
  assert.ok(source.includes('from "./commands"'), "撤销必须 import 自 commands/index.ts");
  assert.ok(source.includes("undoDirectorCommand()"), "Ctrl+Z 必须调 undoDirectorCommand()");
  assert.ok(source.includes("state.copyObject("), "Ctrl+C 必须走 store.copyObject");
  assert.ok(source.includes("state.pasteObject("), "Ctrl+V 必须走 store.pasteObject");
  // 拦截门控：无选中不劫持 copy、剪贴板空不劫持 paste、撤销栈空不劫持 undo
  assert.ok(source.includes("if (!state.selectedId) return;"), "缺「无选中不劫持复制」门控");
  assert.ok(source.includes("if (!state.clipboard) return;"), "缺「剪贴板空不劫持粘贴」门控");
  assert.ok(source.includes("if (directorUndoDepth() === 0) return;"), "缺「撤销栈空不劫持」门控");
});

test("F 聚焦绑定：仅导演视角、target 移到对象位置、dolly 约 4m", () => {
  const source = readSource("./StageCanvas.tsx");
  assert.ok(source.includes('case "f":'), "缺 F 键绑定");
  assert.ok(source.includes("FOCUS_DISTANCE_M = 4"), "聚焦距离必须为约 4m");
  assert.ok(
    source.includes("dollyCameraToObject(controls, object.transform.position)"),
    "F 必须把相机 dolly 到对象位置",
  );
  assert.ok(source.includes('state.viewMode !== "director"'), "F 聚焦必须限定导演视角");
  assert.ok(source.includes("controls.target.set("), "聚焦必须移动 OrbitControls target");
});

test("既有行为保留：Delete/Backspace 删除、Esc 取消选中、表单输入守卫", () => {
  const source = readSource("./StageCanvas.tsx");
  assert.ok(source.includes('case "delete":'), "缺 Delete 绑定");
  assert.ok(source.includes('case "backspace":'), "缺 Backspace 绑定");
  assert.ok(source.includes("state.removeObject(state.selectedId)"), "Delete 必须删除选中对象");
  assert.ok(source.includes('case "escape":'), "缺 Esc 绑定");
  assert.ok(source.includes("state.select(null)"), "Esc 必须取消选中");
  assert.ok(source.includes("isEditableTarget(event.target)"), "表单输入守卫必须保留");
});
