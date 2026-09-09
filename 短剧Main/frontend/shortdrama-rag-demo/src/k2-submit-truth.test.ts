/* ============================================================
   k2-submit-truth.test.ts — K2K「生成提交点的参考集真相」批验收
   （GP-11+GP-16+GP-17+GP-18+GP-13，同一提交点；基线 S83D-DONE）

   核心口径：界面所见 = 提交所发。静默丢弃是最接近数据丢失的一类，
   用户交了什么自己必须知道。

   GP-11+GP-16（同根因，静默蒸发）：controlPackReferences 对解不出 mediaId
     的栏条目静默丢弃且零提示——控制包 6 项在栏，提交侧却「参考集(0)」。
     修法=partitionControlPack 分层返回（随提交 submitted + 不随提交 excluded
     逐项+原因），界面两层如实呈现；提交 payload 不变。
   GP-17（S18 欠账）：提交点缺「多模态参考」模式字样与「参考图 N · 视频 M」
     分计清单——submissionModeLabel（与视频页签 videoMode 口径一致）
     + referenceMediaCounts。
   GP-18：锚帧与参考集互斥的前端表达——anchorRoleFor 判定保留（纯函数+测试）；
     K-goal-04 起手动锚帧 UI 随确认抽屉退场（视频默认仍按确认图作首帧，
     VIDEO_MODES「首尾帧」实装时互斥表达回主界面）。
   GP-13：attachItemToLane 在 updater 里设副作用标志位，React 19 下 updater
     只在渲染期执行，同步读恒 false——首次归入 toast 谎称「已在」、
     「已归入」成功文案与自动回栏 notify 永不触发。修法=lanesStateRef
     同步镜像 + setState 前算定归入结果。

   K-goal-04 条 4：确认抽屉退场，「随提交/不随提交」真相挪主界面——
     生成卡常驻真相条 ControlPackSubmitTruth + 参考车道条目弱显徽标。
   组件级用 happy-dom 真渲染 ControlPackSubmitTruth（同 s83 基建：
   根 npm test 只收集 .test.ts，用 React.createElement 不写 JSX）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";
import type { ProjectAssetRef } from "./types";

/* happy-dom 先落地全局，再动态 import react/react-dom（同 s83 基建纪律）。 */
const happyWindow = new Window({ url: "http://localhost/" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
(globalThis as Record<string, unknown>).React = await import("react");
const { createRoot } = await import("react-dom/client");
const { controlPackReferences, partitionControlPack, referenceMediaCounts } = await import("./control-pack");
const { ControlPackSubmitTruth, anchorRoleFor, submissionModeLabel } = await import("./components/control-pack-truth");
const { attachLaneItem, emptyLanesState, seedLanesFromRefs } = await import("./reference-lanes");

/* ============================================================
   夹具（形状对齐 s9-generation.test.ts；demo fixture 同源语义：
   项目资产无媒体版本 → 控制包在栏但提交侧一项都带不走）
   ============================================================ */

const IMAGE_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const VIDEO_MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const GLB_MEDIA_ID = "33333333-3333-4333-8333-333333333333";
const AUDIO_MEDIA_ID = "55555555-5555-4555-8555-555555555555";
const WORKSHOP_MEDIA_ID = "44444444-4444-4444-8444-444444444444";

const characterRef: ProjectAssetRef = {
  id: "ref-char",
  asset_media_id: IMAGE_MEDIA_ID,
  asset: {
    id: "asset-char",
    asset_kind: "character",
    name: "任天野",
    role: "character_identity",
    thumbnail_url: "https://example.com/char.png",
    current_media: { id: IMAGE_MEDIA_ID, media_kind: "image", format: "png" },
  },
};
const motionRef: ProjectAssetRef = {
  id: "ref-motion",
  asset_media_id: VIDEO_MEDIA_ID,
  asset: {
    id: "asset-motion",
    asset_kind: "prop",
    name: "奔跑动作参考",
    role: "motion",
    current_media: { id: VIDEO_MEDIA_ID, media_kind: "video", format: "mp4" },
  },
};
const glbRef: ProjectAssetRef = {
  id: "ref-glb",
  asset_media_id: GLB_MEDIA_ID,
  asset: {
    id: "asset-glb",
    asset_kind: "prop",
    name: "素模道具",
    role: "prop",
    current_media: { id: GLB_MEDIA_ID, media_kind: "model_3d", format: "glb" },
  },
};
const audioRef: ProjectAssetRef = {
  id: "ref-audio",
  asset_media_id: AUDIO_MEDIA_ID,
  asset: {
    id: "asset-audio",
    asset_kind: "sound",
    name: "低频脚步",
    current_media: { id: AUDIO_MEDIA_ID, media_kind: "audio", format: "mp3" },
  },
};
/** 无媒体快照（demo fixture 六项同款）：栏里在，提交侧带不走。 */
const mediaLessRef: ProjectAssetRef = {
  id: "ref-empty",
  asset: { id: "asset-empty", asset_kind: "scene", name: "无媒体场景", role: "scene" },
};

function fixtureLanes() {
  const refs = [characterRef, motionRef, glbRef, audioRef, mediaLessRef];
  let lanes = seedLanesFromRefs(refs);
  lanes = attachLaneItem(lanes, "character", {
    id: `workshop:${WORKSHOP_MEDIA_ID}`,
    name: "定妆图产出",
    kind: "image",
    origin: "workshop",
    thumbUrl: "https://example.com/out.png",
  });
  lanes = attachLaneItem(lanes, "camera_motion", { id: "note:camera_motion", name: "中景缓推", kind: "text", origin: "workshop" });
  lanes = attachLaneItem(lanes, "reference_video", { id: "workshop:demo-示例", name: "示例产出", kind: "video", origin: "workshop" });
  return { lanes, refs };
}

/* ============================================================
   GP-11+GP-16 纯函数：partitionControlPack 分层——不随提交逐项+原因
   ============================================================ */

test("K2K/GP-11+16：partitionControlPack 分层——随提交与不随提交各就各位，原因点名", () => {
  const { lanes, refs } = fixtureLanes();
  const partition = partitionControlPack(lanes, refs);
  assert.deepEqual(
    partition.submitted.map((option) => option.mediaId),
    [IMAGE_MEDIA_ID, WORKSHOP_MEDIA_ID, VIDEO_MEDIA_ID],
    "随提交层应=旧 controlPackReferences 产出（图片/归入产出/视频）",
  );
  const excludedByName = new Map(partition.excluded.map((item) => [item.name, item]));
  assert.equal(partition.excluded.length, 5, "不随提交层应逐项收齐（素模/音频/无媒体/文字/占位）");
  assert.ok(excludedByName.get("素模道具")?.reason.includes("3D 导演台"), "3D 素模原因不对");
  assert.ok(excludedByName.get("低频脚步")?.reason.includes("音频"), "音频原因不对");
  assert.ok(excludedByName.get("无媒体场景")?.reason.includes("媒体版本"), "无媒体资产原因不对");
  assert.ok(excludedByName.get("中景缓推")?.reason.includes("纯文字机位描述"), "机位文字原因不对");
  assert.ok(excludedByName.get("示例产出")?.reason.includes("占位"), "demo 占位原因不对");
  // 逐项带栏位（抽屉按栏位点名）
  assert.equal(excludedByName.get("无媒体场景")?.laneLabel, "场景");
  assert.equal(excludedByName.get("中景缓推")?.laneLabel, "运镜");
});

test("K2K/GP-11+16：资产引用失效（栏里有条目、项目资产列表查无）也进不随提交层", () => {
  let lanes = emptyLanesState();
  lanes = attachLaneItem(lanes, "character", { id: "asset:ghost", name: "失效资产", kind: "image", origin: "asset", refId: "ref-ghost" });
  const partition = partitionControlPack(lanes, []);
  assert.equal(partition.submitted.length, 0);
  assert.equal(partition.excluded.length, 1);
  assert.ok(partition.excluded[0]!.reason.includes("已失效"), "失效引用原因不对");
});

test("K2K/GP-11+16：demo 口径——控制包 6 项资产全无媒体版本时，随提交 0、不随提交 6（不再静默蒸发了无声）", () => {
  const refs: ProjectAssetRef[] = [
    { id: "ref-1", asset: { id: "a1", asset_kind: "character", role: "character_identity", name: "任天野" } },
    { id: "ref-2", asset: { id: "a2", asset_kind: "character", name: "林秋棠" } },
    { id: "ref-3", asset: { id: "a3", asset_kind: "scene", role: "scene", name: "巷口雨夜" } },
    { id: "ref-4", asset: { id: "a4", asset_kind: "prop", role: "prop", name: "银边短刀" } },
    { id: "ref-5", asset: { id: "a5", asset_kind: "scene", role: "scene", name: "府衙正堂" } },
    { id: "ref-6", asset: { id: "a6", asset_kind: "costume", name: "官服套装" } },
  ];
  const lanes = seedLanesFromRefs(refs);
  const partition = partitionControlPack(lanes, refs);
  assert.equal(partition.submitted.length, 0);
  assert.equal(partition.excluded.length, 6, "demo 六项必须逐项进不随提交层（修复前=静默全灭）");
  assert.ok(partition.excluded.every((item) => item.reason.includes("媒体版本")), "demo 六项原因应都是缺媒体版本");
});

test("K2K/GP-11+16：controlPackReferences 旧签名=partition.submitted（既有消费方行为不变）", () => {
  const { lanes, refs } = fixtureLanes();
  assert.deepEqual(controlPackReferences(lanes, refs), partitionControlPack(lanes, refs).submitted);
});

/* ============================================================
   GP-17 纯函数：模式人话 + 参考图 N · 视频 M 分计
   ============================================================ */

test("K2K/GP-17：referenceMediaCounts 按媒体类型分计", () => {
  const { lanes, refs } = fixtureLanes();
  const options = partitionControlPack(lanes, refs).submitted;
  assert.deepEqual(referenceMediaCounts(options), { images: 2, videos: 1 });
  assert.deepEqual(referenceMediaCounts([]), { images: 0, videos: 0 });
});

test("K2K/GP-17：submissionModeLabel 与 videoMode 口径一致（按图生成/多模态参考）", () => {
  assert.equal(submissionModeLabel(true), "按图生成（确认图作首帧）");
  assert.equal(submissionModeLabel(false), "多模态参考（全能参考）");
});

/* ============================================================
   GP-18 纯函数：anchorRoleFor 互斥判定
   ============================================================ */

test("K2K/GP-18：anchorRoleFor——锚帧占用返回角色，未占用 null，首尾不串", () => {
  assert.equal(anchorRoleFor("m1", "m1", null), "首帧");
  assert.equal(anchorRoleFor("m1", null, "m1"), "尾帧");
  assert.equal(anchorRoleFor("m1", "m2", "m3"), null);
  assert.equal(anchorRoleFor("m1", null, null), null);
});

/* ============================================================
   GP-13 纯函数：归入判定的语义基础——attachLaneItem 幂等返回原引用
   （修法=setState 前同步算定；连续两次归入，第二次必拿到第一次的 state）
   ============================================================ */

test("K2K/GP-13：attachLaneItem 幂等语义——真归入换新 state，已存在返回原引用（false 分支的判定基础）", () => {
  const state = emptyLanesState();
  const item = { id: "workshop:demo-prop", name: "示例产出 · 道具（原型占位）", kind: "image" as const, origin: "workshop" as const };
  const next = attachLaneItem(state, "prop", item);
  assert.notEqual(next, state, "首次归入应产生新 state（=attached true）");
  const again = attachLaneItem(next, "prop", item);
  assert.equal(again, next, "重复归入应返回原引用（=attached false，toast 说「已在」才合法）");
});

/* ============================================================
   组件级（happy-dom 真渲染 ControlPackSubmitTruth，K-goal-04 条 4 主界面真相条）
   ============================================================ */

type TruthOption = import("./control-pack").ControlPackReference;
type TruthExclusion = import("./control-pack").ControlPackExclusion;

const OPTION_CHAR: TruthOption = { mediaId: IMAGE_MEDIA_ID, name: "任天野定妆", url: "", isVideo: false, lane: "character", laneLabel: "角色" };
const OPTION_SCENE: TruthOption = { mediaId: "66666666-6666-4666-8666-666666666666", name: "巷口雨夜", url: "", isVideo: false, lane: "scene", laneLabel: "场景" };
const OPTION_VIDEO: TruthOption = { mediaId: VIDEO_MEDIA_ID, name: "奔跑动作参考", url: "", isVideo: true, lane: "reference_video", laneLabel: "参考视频" };
const EXCLUDED_LIGHT: TruthExclusion = { itemId: "asset:light", name: "冷月光", lane: "lighting", laneLabel: "光影", reason: "资产还没有可提交的媒体版本，不随本次提交" };
const EXCLUDED_NOTE: TruthExclusion = { itemId: "note:camera_motion", name: "中景缓推", lane: "camera_motion", laneLabel: "运镜", reason: "纯文字机位描述，不是媒体参考，不随本次生成提交" };

function mountTruth(props: Record<string, unknown> = {}): { bar: () => HTMLElement | null } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ControlPackSubmitTruth, {
      options: [OPTION_CHAR, OPTION_SCENE, OPTION_VIDEO],
      excluded: [EXCLUDED_LIGHT, EXCLUDED_NOTE],
      byImage: false,
      ...props,
    } as never));
  });
  return {
    bar: () => container.querySelector('[data-testid="control-pack-submit-truth"]') as HTMLElement | null,
  };
}

test("K2K 组件级/GP-11+16+17：真相条常驻——随提交计数+模式人话+媒体分计，不随提交逐项带原因", () => {
  const h = mountTruth();
  const bar = h.bar();
  assert.ok(bar, "生成卡真相条不在（K-goal-04 条 4：真相挪主界面）");
  // 随提交层：计数 + GP-17 模式人话 + 参考图 N · 视频 M
  const modeLine = bar!.querySelector('[data-testid="submission-mode-line"]');
  assert.ok(modeLine, "提交模式行缺失");
  assert.ok(modeLine!.textContent!.includes("随本次提交：3 项"), "随提交计数缺失");
  assert.ok(modeLine!.textContent!.includes("多模态参考（全能参考）"), "无确认图时应=多模态参考");
  assert.ok(modeLine!.textContent!.includes("参考图 2 · 视频 1"), "媒体分计清单不对");
  // GP-11+16：不随提交层逐项+原因（弱显+title 带完整原因）
  const excluded = bar!.querySelector('[data-testid="control-pack-excluded"]');
  assert.ok(excluded, "不随提交分层缺失（静默丢弃回来了）");
  assert.ok(excluded!.textContent!.includes("不随本次提交（2 项"), "不随提交计数缺失");
  assert.ok(excluded!.textContent!.includes("冷月光"), "不随提交项「冷月光」不在");
  assert.ok(excluded!.textContent!.includes("媒体版本"), "冷月光原因不在");
  assert.ok(excluded!.textContent!.includes("中景缓推"), "不随提交项「中景缓推」不在");
  assert.ok(excluded!.textContent!.includes("纯文字机位描述"), "机位文字原因不在");
  const lightItem = excluded!.querySelector('[data-excluded-item="asset:light"]');
  assert.ok(lightItem?.getAttribute("title")?.includes("媒体版本"), "弱显项 title 未带完整原因");
});

test("K2K 组件级/GP-17：byImage=按图生成（确认图作首帧），false=多模态参考（与提交口径一致）", () => {
  const byImage = mountTruth({ byImage: true });
  assert.ok(byImage.bar()!.querySelector('[data-testid="submission-mode-line"]')!.textContent!.includes("按图生成（确认图作首帧）"), "byImage 时应=按图生成");
  const omni = mountTruth({ byImage: false });
  assert.ok(omni.bar()!.querySelector('[data-testid="submission-mode-line"]')!.textContent!.includes("多模态参考（全能参考）"), "非 byImage 时应=多模态参考");
});

test("K2K 组件级/GP-11+16：随提交 0 但控制包有条目时如实说「随本次提交：0 项」，不随提交逐项仍在", () => {
  const h = mountTruth({ options: [], excluded: [EXCLUDED_LIGHT, EXCLUDED_NOTE] });
  const bar = h.bar();
  assert.ok(bar, "有 excluded 时真相条仍应渲染");
  assert.ok(bar!.textContent!.includes("随本次提交：0 项"), "随提交 0 项未如实呈现");
  assert.ok(bar!.querySelector('[data-testid="control-pack-excluded"]'), "不随提交分层缺失");
  // 两层全空=没有真相可述，不渲染不占位
  const empty = mountTruth({ options: [], excluded: [] });
  assert.equal(empty.bar(), null, "两层全空不应渲染真相条");
});

/* ============================================================
   源码级守卫——块 2 改锚说明(2026-08-03):
   镜级工作台已随块 2 归档退役,原「页面接线」三守卫(GP-13 时序/分层取数+真相条接线/
   确认抽屉退场)的合同主体消失。合同迁移=段落工作台接真相条与直接提交闸门(重构靶单
   块 3 首项),接线时守卫随迁改锚 segment-workbench-page。车道徽标锚 reference-lanes
   (活件),保留如下。
   ============================================================ */

test("K2K 源码级：参考车道接 excludedReasons 与「不随提交」徽标(GP-16 车道侧)", () => {
  const lanesSource = readFileSync(new URL("./components/reference-lanes.tsx", import.meta.url), "utf8");
  assert.ok(lanesSource.includes("excludedReasons"), "参考车道未接 excludedReasons");
  assert.ok(lanesSource.includes("不随提交"), "车道条目缺「不随提交」徽标");
});

/* ---------- 块 3 接线复活(2026-08-03,靶单欠件①②):守卫随迁改锚 segment-workbench-page ---------- */

test("K2K 源码级:真相条接线段落工作台两处确认区(块 3 欠件①),取数与提交同源", () => {
  const seg = readFileSync(new URL("./pages/segment-workbench-page.tsx", import.meta.url), "utf8");
  assert.ok(seg.includes('from "../components/control-pack-truth"'), "段落工作台未引入真相条组件");
  assert.equal(seg.match(/<ControlPackSubmitTruth/g)?.length ?? 0, 2, "整段+逐镜两处确认区都应接真相条");
  assert.ok(seg.includes("options={packPartition.submitted}"), "真相条 options 未与 partitionControlPack 同源(GP-17)");
  assert.ok(seg.includes("excluded={packPartition.excluded}"), "真相条 excluded 未接(GP-11/16 不随提交层)");
});

test("K2K/GP-13 源码级:段落工作台归入链路无时序病(块 3 欠件②等价审计钉死)", () => {
  const seg = readFileSync(new URL("./pages/segment-workbench-page.tsx", import.meta.url), "utf8");
  /* 旧页病型:setLanesState(updater) 后同步读 updater 副作用标志(let attached),React 19 下恒 false。
     段落工作台健康形态=demo 分支函数式 attachLaneItem、真栈分支 await api 成败直判,两处都不读同步标志。 */
  assert.ok(seg.includes("attachLaneItem(current, lane,"), "demo 归入应走函数式 attachLaneItem(先算后设)");
  assert.ok(!seg.includes("let attached"), "GP-13 病型回潮:setState 后同步读 attached 标志");
});
