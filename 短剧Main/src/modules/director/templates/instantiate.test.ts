import assert from "node:assert/strict";
import test from "node:test";
import { distanceForShotSize, instantiateTemplate } from "./instantiate.js";
import { createTemplateRegistry } from "./registry.js";
import type { DirectorTemplate } from "./types.js";
import { TemplateApplyError } from "./validate.js";

const registry = createTemplateRegistry();

function template(id: string): DirectorTemplate {
  const found = registry.get(id);
  assert.ok(found, `模版 ${id} 未加载`);
  return structuredClone(found);
}

function cameraByName(scene: ReturnType<typeof instantiateTemplate>, name: string) {
  const camera = scene.cameras.find((candidate) => candidate.name === name);
  assert.ok(camera, `场景缺少机位 ${name}`);
  return camera;
}

function horizontalDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function close(actual: number, expected: number, tolerance = 1e-3): void {
  assert.ok(Math.abs(actual - expected) < tolerance, `期望 ${expected}，实际 ${actual}`);
}

test("景别距离公式：50mm MCU 在 9:16 下对 1.7m 主体反推约 2.78m", () => {
  // vfov = 2·atan(18/50)，2·tan(vfov/2) = 36/50 = 0.72；距离 = 1.7 / (0.72 × 0.85)
  assert.ok(Math.abs(distanceForShotSize("MCU", 50, 1.7) - 2.77778) < 1e-4);
  assert.ok(Math.abs(distanceForShotSize("CU", 85, 1.65) - 3.89583) < 1e-4);
  // 同一景别下距离随焦距线性增长
  assert.ok(distanceForShotSize("MS", 85, 1.7) > distanceForShotSize("MS", 35, 1.7));
});

test("dialogue-reverse-2p 默认落位：世界坐标、朝向与正反打几何", () => {
  const scene = instantiateTemplate(template("dialogue-reverse-2p"));
  assert.equal(scene.objects.length, 2);
  const [a, b] = scene.objects;
  assert.ok(a && b);
  assert.deepEqual(a.transform.position, { x: -0.55, y: 0, z: 0 });
  assert.deepEqual(b.transform.position, { x: 0.55, y: 0, z: 0 });
  // faceTo：A 朝 +x（90°），B 朝 -x（270°）
  assert.equal(a.transform.rotation.y, 90);
  assert.equal(b.transform.rotation.y, 270);
  assert.equal(a.pose.preset, "stand");
  assert.equal(a.type, "mannequin");
  assert.equal(a.joints, null);

  // single 机位：距离公式 + side 侧偏
  const aClose = cameraByName(scene, "A 近景");
  assert.equal(aClose.focalLength, 50);
  assert.ok(Math.abs(horizontalDistance(aClose.transform.position, a.transform.position) - 2.77778) < 1e-3);
  assert.equal(aClose.transform.position.y, 1.5);
  close(aClose.target.y, 0.88 * 1.7, 1e-4);
  // 轴线 A→B 沿 +x，left 侧为 z < 0
  assert.ok(aClose.transform.position.z < 0, "A 近景应在轴线 left 侧");

  // REV：关于动作轴的轴向镜像（x 翻转、z 保留），仍在同侧
  const bClose = cameraByName(scene, "B 近景");
  assert.ok(Math.abs(bClose.transform.position.x + aClose.transform.position.x) < 1e-4);
  assert.ok(Math.abs(bClose.transform.position.z - aClose.transform.position.z) < 1e-4);
  assert.equal(bClose.focalLength, 50);
  assert.ok(Math.abs(horizontalDistance(bClose.transform.position, b.transform.position) - 2.77778) < 1e-3);

  // OTS：近肩后退 0.75 + 侧移 0.45，机高 0.92×near.height，注视 0.88×far.height
  const otsAB = cameraByName(scene, "OTS-A拍B");
  assert.deepEqual(otsAB.transform.position, { x: -1.3, y: 1.564, z: -0.45 });
  close(otsAB.target.y, 0.88 * 1.65, 1e-4);
  const otsBA = cameraByName(scene, "OTS-B拍A");
  assert.deepEqual(otsBA.transform.position, { x: 1.3, y: 1.518, z: -0.45 });
  // 双边 OTS 必须在轴线同一侧
  assert.ok(otsAB.transform.position.z < 0 && otsBA.transform.position.z < 0);

  assert.deepEqual(scene.axis, {
    fromRole: "A",
    toRole: "B",
    from: { x: -0.55, z: 0 },
    to: { x: 0.55, z: 0 },
  });
});

test("origin + headingDeg=90 把整个站位绕原点旋转 90°", () => {
  const scene = instantiateTemplate(template("dialogue-reverse-2p"), {
    origin: { x: 10, z: 5, headingDeg: 90 },
  });
  const [a, b] = scene.objects;
  assert.ok(a && b);
  // 旋转矩阵：x' = x·cos + z·sin，z' = -x·sin + z·cos；(±0.55, 0) → (0, ∓(-0.55)) 即 (0, ±0.55)
  assert.deepEqual(a.transform.position, { x: 10, y: 0, z: 5.55 });
  assert.deepEqual(b.transform.position, { x: 10, y: 0, z: 4.45 });
  assert.equal(a.transform.rotation.y, 180);
  assert.equal(b.transform.rotation.y, 0);
  // 机位同样整体旋转，且仍在轴线同侧（校验通过即未抛错）
  const otsAB = cameraByName(scene, "OTS-A拍B");
  assert.deepEqual(otsAB.transform.position, { x: 9.55, y: 1.564, z: 6.3 });
  assert.deepEqual(scene.axis?.from, { x: 10, z: 5.55 });
});

test("pushin-2p：distanceM 直接决定拍摄距离，REV 镜像出反打推近线", () => {
  const scene = instantiateTemplate(template("pushin-2p"));
  const [a] = scene.objects;
  assert.ok(a);
  const start = cameraByName(scene, "推近起点");
  const end = cameraByName(scene, "推近终点");
  assert.ok(Math.abs(horizontalDistance(start.transform.position, a.transform.position) - 3.0) < 1e-3);
  assert.ok(Math.abs(horizontalDistance(end.transform.position, a.transform.position) - 1.2) < 1e-3);

  const bStart = cameraByName(scene, "B 推近起点");
  assert.ok(Math.abs(bStart.transform.position.x + start.transform.position.x) < 1e-4);
  assert.ok(Math.abs(bStart.transform.position.z - start.transform.position.z) < 1e-4);

  assert.equal(scene.moves?.length, 2);
  assert.equal(scene.moves?.[0]?.type, "dolly-in");
  assert.equal(scene.moves?.[0]?.fromCamera, "推近起点");
  assert.equal(scene.moves?.[0]?.toCamera, "推近终点");
});

test("roleAssignments 覆盖 name/height 并传导到机位数学", () => {
  const scene = instantiateTemplate(template("dialogue-reverse-2p"), {
    roleAssignments: { A: { name: "天尊", height: 2.0 }, B: { name: "随从" } },
  });
  const [a, b] = scene.objects;
  assert.ok(a && b);
  assert.equal(a.name, "天尊");
  assert.equal(a.height, 2.0);
  assert.equal(b.name, "随从");
  // 身高 2.0 → MCU 距离 = 2.0 / 0.612
  const aClose = cameraByName(scene, "A 近景");
  assert.ok(Math.abs(horizontalDistance(aClose.transform.position, a.transform.position) - 2.0 / 0.612) < 1e-3);
  // OTS 机高 0.92 × near.height
  const otsAB = cameraByName(scene, "OTS-A拍B");
  assert.equal(otsAB.transform.position.y, 1.84);
  assert.equal(scene.applied.roles["A"]?.name, "天尊");
});

test("validate 拦截间距违规", () => {
  const broken = template("dialogue-reverse-2p");
  broken.constraints = { ...broken.constraints, spacing: [{ between: ["A", "B"], min: 0.9, max: 1.0 }] };
  assert.throws(
    () => instantiateTemplate(broken),
    (error: unknown) => {
      assert.ok(error instanceof TemplateApplyError);
      assert.equal(error.statusCode, 422);
      assert.match(error.message, /间距/);
      return true;
    },
  );
});

test("validate 拦截越轴（机位不在轴线同侧）", () => {
  const broken = template("dialogue-reverse-2p");
  const otsBA = broken.cameras.find((camera) => camera.name === "OTS-B拍A");
  assert.ok(otsBA && otsBA.kind === "relational" && otsBA.relation === "OTS");
  otsBA.side = "right";
  assert.throws(
    () => instantiateTemplate(broken),
    (error: unknown) => {
      assert.ok(error instanceof TemplateApplyError);
      assert.match(error.message, /越轴|不一致/);
      return true;
    },
  );
});

test("validate 拦截角色未被机位覆盖", () => {
  const broken = template("dialogue-reverse-2p");
  broken.cameras = broken.cameras.filter((camera) => camera.name === "A 近景");
  assert.throws(
    () => instantiateTemplate(broken),
    (error: unknown) => {
      assert.ok(error instanceof TemplateApplyError);
      assert.match(error.message, /没有被任何机位覆盖/);
      return true;
    },
  );
});

test("validate 拦截不合理的拍摄距离", () => {
  const broken = template("pushin-2p");
  const start = broken.cameras.find((camera) => camera.name === "推近起点");
  assert.ok(start && start.kind === "relational" && start.relation === "single");
  start.distanceM = 0.1;
  assert.throws(
    () => instantiateTemplate(broken),
    (error: unknown) => {
      assert.ok(error instanceof TemplateApplyError);
      assert.match(error.message, /超出合理范围/);
      return true;
    },
  );
});

test("未知角色的 roleAssignments 直接 422", () => {
  assert.throws(
    () => instantiateTemplate(template("dialogue-reverse-2p"), { roleAssignments: { Z: { name: "路人" } } }),
    (error: unknown) => {
      assert.ok(error instanceof TemplateApplyError);
      assert.match(error.message, /选定的角色不在这个场景模板里/);
      return true;
    },
  );
});

test("action-fastcut-2p：荷兰角成对且 REV 取反，keepSide 全 left", () => {
  const scene = instantiateTemplate(template("action-fastcut-2p"));
  const handA = cameraByName(scene, "手持近景A");
  const handB = cameraByName(scene, "手持近景B");
  assert.equal(handA.rollDeg, 6);
  assert.equal(handB.rollDeg, -6);
  for (const camera of scene.cameras) {
    assert.ok(camera.transform.position.z < 0, `${camera.name} 应在轴线 left 侧`);
  }
});

test("confront-triangle-3p：三角间距约束满足且三人都被覆盖", () => {
  const scene = instantiateTemplate(template("confront-triangle-3p"));
  assert.equal(scene.objects.length, 3);
  const covered = new Set(scene.cameras.flatMap((camera) => camera.meta.subjectRoles));
  for (const object of scene.objects) {
    assert.ok(covered.has(object.role), `${object.role} 未被覆盖`);
  }
  const master = cameraByName(scene, "三角 master");
  assert.equal(master.focalLength, 35);
  // master 注视 B/C 中点：xz = ((-0.9+0.9)/2, -0.7)，y = 平均身高 × 0.6
  assert.ok(Math.abs(master.target.x - 0) < 1e-4);
  assert.ok(Math.abs(master.target.z + 0.7) < 1e-4);
  assert.ok(Math.abs(master.target.y - ((1.75 + 1.68) / 2) * 0.6) < 1e-4);
});
