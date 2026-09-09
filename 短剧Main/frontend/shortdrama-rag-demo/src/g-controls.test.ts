import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ASSET_ROLES,
  REFERENCE_ZONES,
  assetRoleMeta,
  mediaMatchesZone,
} from "./control-assets";

/* ---------- G1：role 六类注册表 ---------- */

test("G1：六类 role 唯一且覆盖控制包提案枚举", () => {
  assert.equal(ASSET_ROLES.length, 6);
  assert.deepEqual(
    ASSET_ROLES.map((role) => role.value),
    ["character_identity", "scene", "prop", "motion", "camera_storyboard", "style_env"],
  );
  // DC 指正：motion / camera_storyboard 以视频为主（全能参考不只图片）
  assert.equal(assetRoleMeta("motion")?.mediaHint, "视频为主");
  assert.equal(assetRoleMeta("camera_storyboard")?.mediaHint, "视频为主");
});

test("G1：assetRoleMeta 命中/未知/空值", () => {
  assert.equal(assetRoleMeta("scene")?.label, "场景");
  assert.equal(assetRoleMeta("character_identity")?.tone, "accent");
  assert.equal(assetRoleMeta("bogus"), null);
  assert.equal(assetRoleMeta(""), null);
  assert.equal(assetRoleMeta(null), null);
  assert.equal(assetRoleMeta(undefined), null);
});

/* ---------- G2：分区过滤（媒介 × usage_mode） ---------- */

test("G2：REFERENCE_ZONES 四区且媒介约束正确", () => {
  assert.deepEqual(REFERENCE_ZONES.map((zone) => zone.key), ["reference_image", "reference_video", "first_frame", "last_frame"]);
  assert.equal(REFERENCE_ZONES.find((zone) => zone.key === "reference_video")?.accepts, "video");
});

test("G2：mediaMatchesZone——视频区只收视频，图片区拒视频", () => {
  const image = { media_kind: "image", format: "jpg" };
  const video = { media_kind: "video", format: "mp4" };
  const zones = Object.fromEntries(REFERENCE_ZONES.map((zone) => [zone.key, zone]));
  assert.equal(mediaMatchesZone(video, zones.reference_video!), true);
  assert.equal(mediaMatchesZone(image, zones.reference_video!), false);
  assert.equal(mediaMatchesZone(video, zones.reference_image!), false);
  assert.equal(mediaMatchesZone(image, zones.reference_image!), true);
});

test("G2：mediaMatchesZone——首帧/尾帧看 usage_mode，缺省按 reference", () => {
  const zones = Object.fromEntries(REFERENCE_ZONES.map((zone) => [zone.key, zone]));
  const firstFrame = { media_kind: "image", format: "jpg", usage_mode: "first_frame" };
  const noUsage = { media_kind: "image", format: "jpg", usage_mode: null };
  assert.equal(mediaMatchesZone(firstFrame, zones.first_frame!), true);
  assert.equal(mediaMatchesZone(firstFrame, zones.reference_image!), false);
  assert.equal(mediaMatchesZone(noUsage, zones.reference_image!), true);
  assert.equal(mediaMatchesZone(noUsage, zones.last_frame!), false);
});

/* ---------- G1 源码级：上传弹窗强制选 role ---------- */

test("G1 源码级：上传弹窗六类单选 + 未选不可提交", () => {
  const modal = readFileSync(new URL("./components/asset-upload-modal.tsx", import.meta.url), "utf8");
  assert.ok(modal.includes("ASSET_ROLES"), "未消费六类注册表");
  assert.ok(modal.includes("aria-pressed={role === item.value}"), "单选语义缺失");
  assert.ok(modal.includes("!role"), "提交按钮未把 role 纳入禁用条件");
  assert.ok(modal.includes("请先选择资产职责"), "缺未选提示");
});

/* ---------- G2 源码级：生成面板=参考集主体（role 分组混排）+ 锚帧折叠高级 ---------- */

test("G2 源码级：合同 §5——参考集为主体（控制包分组混排），锚帧无一等席位", () => {
  /* 块 3 改锚(2026-08-03):合同主体=段落工作台(活件);旧镜级 workbench-page 已块 2 退役(死代码),不再作锚。 */
  const workbench = readFileSync(new URL("./pages/segment-workbench-page.tsx", import.meta.url), "utf8");
  // 主体：参考集分组（S9-17 起取数源=工作台参考控制包六组，取代旧六类 role 注册表+「其他资产」兜底），图片视频混排
  // 块 2:控制包纯逻辑挪出成 control-pack.ts,页面取数符号=partitionControlPack(controlPackReferences 的分层上位,S9-17 语义不变)
  assert.ok(workbench.includes("partitionControlPack("), "分组未走参考控制包（S9-17 取数源）");
  const truthSource = readFileSync(new URL("./components/control-pack-truth.tsx", import.meta.url), "utf8");
  assert.ok(truthSource.includes("groupControlPackReferences"), "缺控制包分组函数（S9-17,块 2 起居 control-pack-truth）");
  assert.ok(!workbench.includes("其他资产"), "「其他资产」兜底分组应已废除（S9-17）");
  /* K-goal-04 条 4：确认抽屉退场，参考集真相=主界面常驻（生成卡真相条+参考车道）；
     手动锚帧 UI 随抽屉退场——锚帧无一等席位的合同语义不变（视频默认仍按确认图作首帧）
     块 3 欠件①:真相条已接线段落工作台两处确认区(整段+逐镜)。 */
  assert.ok(workbench.includes("ControlPackSubmitTruth"), "缺生成卡参考集真相条");
  assert.ok(!workbench.includes("高级：锚帧"), "手动锚帧 UI 残留（随确认抽屉退场）");
  // 四分区旧范式退场
  // 注：「reference_video」字面量现为 S2 参考清单六组的合同组 id（参考视频组），合法出现；
  // 这里只断言旧四分区范式的真正残留（分区状态与旧用法）不再存在。
  assert.ok(!workbench.includes("zoneSelections"), "旧分区状态仍在");
});
