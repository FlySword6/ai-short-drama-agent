/* ============================================================
   s9-generation.test.ts — S9-17/18/19 生成链批验收断言
   （S11-4：/video 孤儿页已下线，原 video-workbench 两条源码断言随页退役）

   S9-17（P0，DC 语义铁律）：提交参考集取数源 = 工作台参考控制包
     （参考清单六组 lanesState，用户显式引用、按职责分组、图片视频混排）；
     已匹配资产只是候选池，不得直接进参考集。界面所见 = submit 所发 = 同一控制包源。
   S9-18（Fable 分析 DC 点名）：素材级唯一主按钮「生成视频」；生成依据真相在主界面——
     有确认图=按图生成（确认图作首帧），无图=按提示词直接生成。
     K-goal-04 条 4：确认抽屉退场，点击直接提交，本文件相关守卫已改挂新结构。
   S9-19：资产选择器分化——「从资产库选」=浏览选择器（类型过滤+搜索+分页），
     「匹配 + 选择资产」=匹配候选流（匹配理由+采纳）；匹配=本地子串过滤，
     理由文案如实、不暗示 AI 智能匹配；角色/场景/道具槽 kind 过滤；
     分页=前端切片（后端 /assets 无 limit/offset/page，缺口见 routes.ts assetListSchema）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  matchReason,
  pickPageCount,
  slicePage,
} from "./components/asset-pick-drawer";
import { controlPackReferences } from "./control-pack";
import { groupControlPackReferences } from "./components/control-pack-truth";
import { attachLaneItem, seedLanesFromRefs } from "./reference-lanes";
import { generationFailureCopy } from "./error-copy";
import type { Asset, ProjectAssetRef } from "./types";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const workbench = readSource("./pages/workbench-page.tsx");
const referenceTests = readSource("./pages/reference-tests-page.tsx");
const batchDrawer = readSource("./pages/batch-generate-drawer.tsx");
const capabilityTiers = readSource("./capability-tiers.ts");
const pickDrawer = readSource("./components/asset-pick-drawer.tsx");
const referenceLanes = readSource("./components/reference-lanes.tsx");
const popoverComponent = readSource("./components/gen-params-popover.tsx");

/* ============================================================
   S9-17：controlPackReferences 纯逻辑——取数源=控制包，过滤口径不松
   ============================================================ */

const IMAGE_MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const VIDEO_MEDIA_ID = "22222222-2222-4222-8222-222222222222";
const GLB_MEDIA_ID = "33333333-3333-4333-8333-333333333333";
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
/** 3D 素模（导演台专用）：进了道具组也不得进生成参考集（W5 联调合同口径沿用）。 */
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
/** 无媒体快照的老数据：没有 mediaId 可提交，不得进参考集。 */
const emptyRef: ProjectAssetRef = {
  id: "ref-empty",
  asset: { id: "asset-empty", asset_kind: "scene", name: "无媒体场景" },
};

function fixtureLanes() {
  const refs = [characterRef, motionRef, glbRef, emptyRef];
  let lanes = seedLanesFromRefs(refs);
  lanes = attachLaneItem(lanes, "character", {
    id: `workshop:${WORKSHOP_MEDIA_ID}`,
    name: "定妆图产出",
    kind: "image",
    origin: "workshop",
    thumbUrl: "https://example.com/out.png",
  });
  // 机位文字描述不是媒体引用
  lanes = attachLaneItem(lanes, "camera_motion", { id: "note:camera_motion", name: "中景缓推", kind: "text", origin: "workshop" });
  // demo/占位 id 不是真实媒体，不可提交
  lanes = attachLaneItem(lanes, "reference_video", { id: "workshop:demo-示例", name: "示例产出", kind: "video", origin: "workshop" });
  return { lanes, refs };
}

test("S9-17：控制包取数——六组顺序、图片视频混排、字段齐全", () => {
  const { lanes, refs } = fixtureLanes();
  const options = controlPackReferences(lanes, refs);
  assert.deepEqual(options.map((option) => option.mediaId), [IMAGE_MEDIA_ID, WORKSHOP_MEDIA_ID, VIDEO_MEDIA_ID]);
  assert.deepEqual(options.map((option) => option.laneLabel), ["角色", "角色", "参考视频"]);
  assert.equal(options[0]?.name, "任天野");
  assert.equal(options[0]?.url, "https://example.com/char.png");
  assert.equal(options[0]?.isVideo, false);
  assert.equal(options[1]?.name, "定妆图产出");
  assert.equal(options[1]?.isVideo, false);
  assert.equal(options[2]?.isVideo, true, "动作参考视频项应保留视频标记（默认不勾选、按需点名）");
});

test("S9-17：不可提交项一律不进参考集——3D 素模/无媒体资产/文字描述/占位 id", () => {
  const { lanes, refs } = fixtureLanes();
  const options = controlPackReferences(lanes, refs);
  assert.ok(!options.some((option) => option.mediaId === GLB_MEDIA_ID), "3D 素模混入参考集");
  assert.ok(!options.some((option) => option.name === "无媒体场景"), "无 mediaId 资产混入参考集");
  assert.ok(!options.some((option) => option.name === "中景缓推"), "机位文字描述混入参考集");
  assert.ok(!options.some((option) => option.name === "示例产出"), "demo 占位 id 混入参考集");
});

test("S9-17：同一媒体资产条目与归入产出重复时按 mediaId 去重", () => {
  const { lanes, refs } = fixtureLanes();
  const duplicated = attachLaneItem(lanes, "prop", {
    id: `workshop:${IMAGE_MEDIA_ID}`,
    name: "重复归入的同一媒体",
    kind: "image",
    origin: "workshop",
  });
  const options = controlPackReferences(duplicated, refs);
  assert.equal(options.filter((option) => option.mediaId === IMAGE_MEDIA_ID).length, 1);
});

test("S9-17：分组展示与默认选中同源——groupControlPackReferences 按六组顺序、空组不出现", () => {
  const { lanes, refs } = fixtureLanes();
  const options = controlPackReferences(lanes, refs);
  const groups = groupControlPackReferences(options);
  assert.deepEqual(groups.map((group) => group.label), ["角色", "参考视频"]);
  assert.equal(groups[0]?.options.length, 2);
  assert.equal(groups[1]?.options.length, 1);
  // 分组就是原数组的重排视图（同一对象引用，不搞第二份数据）
  assert.equal(groups[0]?.options[0], options[0]);
});

test("S9-17： lanes 里没有组员的资产（候选池）不进参考集", () => {
  // 未标职责且类型不落任何组的资产只进候选池，不进控制包
  const candidateOnlyRef: ProjectAssetRef = {
    id: "ref-candidate",
    asset_media_id: "55555555-5555-4555-8555-555555555555",
    asset: { id: "asset-candidate", asset_kind: "other", name: "未分桶候选" },
  };
  const lanes = seedLanesFromRefs([candidateOnlyRef]);
  assert.deepEqual(controlPackReferences(lanes, [candidateOnlyRef]), []);
});

/* ============================================================
   S9-17 源码级：提交取数源与提交链同一控制包源（端到端口径）
   ============================================================ */

test("S9-17 源码级：提交参考集取工作台控制包（lanesState），不再吃项目匹配资产", () => {
  // K2K：取数换 partitionControlPack 分层（submitted 层=controlPackReferences 产出，等值断言在 k2-submit-truth.test.ts）
  assert.ok(workbench.includes("partitionControlPack(lanesState"), "页面未从 lanesState 组装控制包参考");
  assert.ok(workbench.includes("options={controlPackOptions}"), "生成卡真相条 props 未接控制包选项");
  assert.ok(!workbench.includes("references={assetState.data"), "提交侧仍在直接吃项目匹配资产（候选池）");
});

test("S9-17 源码级：界面所见=submit 所发——参考集全量随提交同源控制包", () => {
  // K-goal-04 条 4：确认抽屉退场，startGeneration 直接提交，payload=控制包全量（按 mediaId 去重）
  const start = workbench.indexOf("async function startGeneration");
  assert.ok(start > 0, "startGeneration 不存在");
  const body = workbench.slice(start, start + 1200);
  assert.ok(body.includes("controlPackOptions.map((option) => option.mediaId)"), "提交引用未取控制包全量");
  assert.ok(!workbench.includes("referenceSelection"), "参考集多选态应随 S59 只读摘要退役");
});

/* ============================================================
   S9-18：生成按钮重构
   ============================================================ */

test("S9-18 源码级：素材级唯一主按钮「生成视频」，双按钮退场", () => {
  assert.ok(workbench.includes(">生成视频</Button>"), "缺唯一主按钮「生成视频」");
  assert.ok(!workbench.includes("生成本粗剪素材"), "旧主按钮「生成本粗剪素材」仍在");
  assert.ok(!workbench.includes(">文生视频<"), "「文生视频」入口按钮仍在");
  assert.ok(!workbench.includes("enterFastVideo"), "文生视频快速通道函数仍在");
});

test("S9-18 源码级（K-goal-04 条 4 改版）：生成依据真相在主界面——有确认图=按图生成作首帧，无图=按提示词", () => {
  // 确认抽屉「生成依据」栏随抽屉退场；真相=视频页签确认图首帧呈现 + 提交口径一致上送
  assert.ok(workbench.includes("按图生视频的首帧"), "视频页签缺确认图首帧呈现");
  const start = workbench.indexOf("async function startGeneration");
  assert.ok(start > 0, "startGeneration 不存在");
  const body = workbench.slice(start, start + 1200);
  assert.ok(body.includes('kind === "video" && imageMedia ? [imageMedia.id]'), "视频有确认图未上送首帧（payload 口径变了）");
  assert.ok(!workbench.includes("textOnly"), "抽屉 textOnly 配置残留");
  assert.ok(workbench.includes("还没有确认图") || workbench.includes("先在图片页签确认一张图"), "无确认图引导语丢失");
});

/* ============================================================
   S59（K-goal-04 条 4 改版）：确认抽屉整体退场后的结构守卫——
   价格前置=主界面 ⚡ 实时估价常显；正式报价/超阈值复核仍在提交链；
   模板卡唯一入口=「风格」chip；型号名=维度 popover 触发器。
   ============================================================ */

test("S59 源码级：价格前置=主界面 ⚡ 实时估价常显（预计 N），提交链正式报价+超阈值复核保留", () => {
  // 主界面实时估价（simpleEstimate，不创建报价行）常显在发送键旁
  assert.ok(workbench.includes("api.simpleEstimate"), "页面实时估价未走 simpleEstimate");
  assert.ok(workbench.includes("`预计 ${formatCost("), "主界面缺「预计 N」估价明示");
  // 提交链正式报价不变；服务端标记超复核阈值时仍另弹一次费用确认（GenerationQuoteModal 保留）
  assert.ok(workbench.includes("api.quoteGeneration(input)"), "提交链缺正式报价");
  assert.ok(workbench.includes("requires_manual_review"), "超阈值复核接线丢失");
  assert.ok(workbench.includes("GenerationQuoteModal"), "超阈值费用确认卡丢失");
});

test("S59 源码级：确认抽屉只做确认的呈现面整体退场，模板卡唯一入口=「风格」chip", () => {
  assert.ok(workbench.includes("IMAGE_PRESET_GROUPS"), "模板卡组应仍在（工作台提示词区上方）");
  // V-35(S83)：模板区唯一入口 = 生成卡「风格」chip(toggle),「套个模板」折叠头退场——两个开关管同一块区域被判重复
  assert.ok(!workbench.includes("套个模板"), "模板区仍带第二个折叠入口（V-35 去重失败）");
  assert.ok(workbench.includes("setShowImageTemplates((value) => !value)"), "风格 chip 未接成模板区开关");
  // K-goal-04 条 4：抽屉/旧入口不再存在（变异守卫在 k2-submit-truth.test.ts）
  assert.ok(!workbench.includes("确认抽屉「模板」"), "抽屉模板面板残留");
});

test("S59 源码级：模板画幅 ≠ 当前档画幅时工作台明示变形（G06/G07 回归吸收，不静默）", () => {
  assert.ok(workbench.includes("presetRatioNote(findImagePreset(imagePresetId)"), "模板区未按「选中模板+当前档画幅」计算明示");
  assert.ok(workbench.includes("imagePresetRatioNote"), "变形警示未接入模板区渲染");
  // 档画幅取自当前选中档 aspect_ratio（与提交链同源），类型收窄后才比较
  assert.ok(workbench.includes('params.aspect_ratio === "string"'), "档画幅取值未做类型收窄");
  // 条 5「给出实际型号名」：型号名=维度 popover 触发器（K-goal-04 起参数/确认两个抽屉都退场）
  assert.ok(!workbench.includes('>服务端配置</span></span>'), "参数行仍写死「服务端配置」");
  assert.ok(popoverComponent.includes("tierModelLabel(selectedTier)"), "维度 popover 触发器未取当前档模型展示标签");
});

/* ============================================================
   S9-19：资产选择器分化 / 槽位过滤 / 分页
   ============================================================ */

const pickAsset: Asset = { id: "asset-1", asset_kind: "character", name: "任天野", intro: "钦差官服" };

test("S9-19：匹配理由诚实口径——关键词命中名称/简介如实写，不暗示 AI 匹配", () => {
  assert.equal(matchReason(pickAsset, "", "任天"), "名称包含「任天」");
  assert.equal(matchReason(pickAsset, "", "官服"), "简介包含「官服」");
  assert.equal(matchReason(pickAsset, "character", ""), "类型筛选：角色");
  assert.equal(matchReason(pickAsset, "", ""), "资产中心候选（未按相关度排序）");
});

test("S9-19：前端切片分页（后端 /assets 无分页参数）", () => {
  const items = Array.from({ length: 25 }, (_, index) => index + 1);
  assert.equal(slicePage(items, 0, 12).length, 12);
  assert.deepEqual(slicePage(items, 2, 12), [25]);
  assert.deepEqual(slicePage(items, -1, 12), slicePage(items, 0, 12), "负页码按第一页切");
  assert.equal(pickPageCount(25, 12), 3);
  assert.equal(pickPageCount(12, 12), 1);
  assert.equal(pickPageCount(0, 12), 1);
});

test("S9-19 源码级：抽屉分化两模式——match=匹配候选流（理由+采纳），browse=浏览选择器", () => {
  assert.ok(pickDrawer.includes('mode?: "match" | "browse"'), "抽屉缺 mode 分化参数");
  assert.ok(pickDrawer.includes("matchReason"), "匹配候选流缺匹配理由");
  assert.ok(pickDrawer.includes("采纳"), "匹配候选流缺「采纳」按钮");
  // S13-3：召回已切混合检索真接口——「未接 AI 智能匹配」诚实标注退役，换真实召回说明
  assert.ok(pickDrawer.includes("候选由平台检索按关键词召回"), "匹配召回说明未更新为真实口径");
  assert.ok(!pickDrawer.includes("未接 AI 智能匹配"), "本地过滤旧标注应随混检退役");
  assert.ok(pickDrawer.includes("从资产库选"), "browse 模式标题「从资产库选」缺失");
});

test("S9-19 源码级：槽位 kind 过滤——角色/场景/道具槽只列对应类型资产", () => {
  assert.ok(pickDrawer.includes("lockedKind"), "抽屉缺 kind 锁定过滤");
  assert.ok(pickDrawer.includes("只列"), "槽位锁定时缺「只列X」明示");
  // S24-C：槽位→资产类型映射随词表走（pickKind 词表列），不再是写死的 LANE_PICK_KIND
  assert.ok(workbench.includes("laneEntry(lane).pickKind"), "工作台槽位类型未走词表 pickKind");
  assert.ok(readSource("./lane-vocabulary.ts").includes('pickKind: "character"'), "角色槽未锁定只列角色");
  assert.ok(readSource("./lane-vocabulary.ts").includes('pickKind: "scene"'), "场景槽未锁定只列场景");
  assert.ok(readSource("./lane-vocabulary.ts").includes('pickKind: "prop"'), "道具槽未锁定只列道具");
  assert.ok(referenceLanes.includes("onPickFromLibrary(lane.id)"), "参考清单「从资产库选」入口未把槽位传出");
});

test("S9-19 源码级：候选列表分页控件与两处入口 mode 接线", () => {
  assert.ok(pickDrawer.includes("slicePage"), "缺切片分页");
  assert.ok(pickDrawer.includes("PICK_PAGE_SIZE"), "缺分页大小常量");
  assert.ok(pickDrawer.includes("上一页") && pickDrawer.includes("下一页"), "缺翻页控件");
  assert.ok(workbench.includes('mode: "match"'), "工作台「匹配 + 选择资产」未接 match 模式");
  assert.ok(workbench.includes('mode: "browse"'), "工作台「从资产库选」未接 browse 模式");
});

/* ============================================================
   S10：档位接真接口（合同 v0.3.0）+ 裁决 4/2/四-1 源码级断言
   ============================================================ */

test("S10 源码级：裁决 4——capability-tiers 不再静默回落本地档,空数组=「档位未配置」报 Sol", () => {
  assert.ok(!capabilityTiers.includes("reason.status === 404 || reason.status === 501"), "404/501 静默回落仍在");
  assert.ok(capabilityTiers.includes("TIER_UNCONFIGURED_MESSAGE"), "缺「档位未配置」错误口径");
  assert.ok(capabilityTiers.includes("档位未配置"), "空数组未按「档位未配置」报错");
  assert.ok(capabilityTiers.includes("demo 模式走本地 fixture") || capabilityTiers.includes("demo 模式仍走"), "demo fixture 路径丢失");
});

test("S10 源码级：档价标签——固定标签带档价（合同 §4「16:9 · 2K · 1 张 · 60 积分/张」口径）", () => {
  assert.ok(capabilityTiers.includes("tierPriceLabel"), "缺档价标签函数");
  assert.ok(capabilityTiers.includes("积分/"), "档价未带「积分/张|秒」单位");
});

test("S10 源码级：workbench 估价/提交全链带 tier_id,档错误态收敛到能力状态条（S46-A）", () => {
  assert.ok(workbench.includes("tier_id: submitTier.tier_id"), "runGenerationFlow 未带 tier_id");
  assert.ok(workbench.includes("tier_id: selectedTier.tier_id"), "实时估价未带 tier_id");
  assert.ok(workbench.includes("tierError"), "缺档位错误态");
  // S46-A：档错误态收敛到「AI 能力状态」条（模型×档位×开关,角色感知）,重试经 onRetry 回拉档位
  assert.ok(workbench.includes("CapabilityStatusBar"), "档错误态未收敛到能力状态条");
  assert.ok(workbench.includes("setTierRevision"), "档位重试未接线");
  // 确认卡显示档位与价格（合同 §4）
  assert.ok(workbench.includes("tierText"), "确认卡缺档位行");
  assert.ok(workbench.includes("tierLabelText"), "确认卡未传档位标签");
});

test("S10 源码级：reference-tests 生成接档+简单估价预览;四-1 入口锁 mediaKind", () => {
  assert.ok(referenceTests.includes("buildTestGenerationInput(test, projectId, newId(), submitTier)"), "生成未接选中档");
  assert.ok(referenceTests.includes("api.simpleEstimate"), "未用简单估价做无项目上下文估价预览");
  assert.ok(referenceTests.includes("类型随入口锁定，不可改选"), "四-1：生成目标未锁定为说明行");
  assert.ok(!referenceTests.includes('role="group" aria-label="生成目标"'), "生成目标可切换 radiogroup 仍在");
  assert.ok(referenceTests.includes("tierText"), "确认卡缺档位行");
});

test("S10 源码级：batch 抽屉整档估价/提交;裁决 2「已完成」分桶已摘", () => {
  assert.ok(batchDrawer.includes("tier: tierState"), "批量清单未接接口档");
  assert.ok(batchDrawer.includes("tier_id"), "批量清单缺 tier_id");
  assert.ok(batchDrawer.includes("tierLabel(tierState)"), "抽屉确认卡缺档位与档价");
  assert.ok(!batchDrawer.includes('["completed", "已完成"]'), "裁决 2：「已完成」分桶仍在");
});

test("sgoal06 源码级:V-29 备好再拍软引导——就位不足确认区亮缺口,不硬闸(PRD 生产章二)", () => {
  const seg = readSource("./pages/segment-workbench-page.tsx");
  assert.ok(seg.includes('data-testid="prep-shortfall-note"'), "确认区缺 V-29 缺口提示锚点");
  assert.ok(seg.includes("还缺"), "缺「还缺 N 类参考」缺口文案");
  assert.ok(seg.includes("通过率会低"), "缺杠杆话术「通过率会低」");
  /* 软引导不硬闸:开拍禁用条件不得含 readyLaneCount(就位不足仍可开拍)。 */
  const segDisabled = seg.slice(seg.indexOf("const segDisabled"), seg.indexOf("const segDisabled") + 400);
  assert.ok(!segDisabled.includes("readyLaneCount"), "就位数进了开拍禁用条件=软引导变硬闸");
});


/* ============================================================
   GENDOMAIN（FABLE-KIMI-GOAL-GENDOMAIN-20260803）四目标守卫钉
   ============================================================ */

test("GENDOMAIN-1 连续生成:段页不跳 queue+在途轮询回填+本场排除清单", () => {
  const seg = readSource("./pages/segment-workbench-page.tsx");
  assert.ok(!seg.includes('navigate("/queue")'), "提交后仍跳 /queue（V-50 后半：留原地续作）");
  assert.ok(seg.includes("wasInflightRef"), "缺在途落终态边沿回填（wasInflightRef）");
  assert.ok(seg.includes("setInterval"), "缺在途轮询定时器");
  assert.ok(seg.includes("EXCLUDED_LANES_PREFIX"), "缺本场排除清单存储键");
  assert.ok(seg.includes("filterExcludedFromLanes"), "排除清单未在 seed 链过滤");
  assert.ok(seg.includes("detachLaneItem(current, lane, item.id)"), "workshop 条目摘除未走 detachLaneItem");
  assert.ok(seg.includes('data-testid="excluded-asset-restore"'), "缺排除资产恢复区");
});

test("GENDOMAIN-2 提示词 AI 触点:段页逐镜编辑+起草/互译/模型目录;api 形状锁定", () => {
  const seg = readSource("./pages/segment-workbench-page.tsx");
  assert.ok(seg.includes("shot-prompt-editor-"), "缺逐镜提示词行内编辑锚点");
  assert.ok(seg.includes('video_prompt: editingText'), "保存未写 video_prompt");
  assert.ok(seg.includes("api.draftPrompt"), "缺 AI 起草触点");
  assert.ok(seg.includes("api.translatePrompt"), "缺中英互译触点");
  assert.ok(seg.includes("api.listPromptModels"), "缺模型目录触点");
  const apiSource = readSource("./api.ts");
  assert.ok(apiSource.includes('"/ai/prompt-models"'), "api 缺 prompt-models 封装");
  assert.ok(apiSource.includes('"/ai/prompt-translate"'), "api 缺 prompt-translate 封装");
  assert.ok(apiSource.includes("prompt_text"), "draft/translate 未取 prompt_text 合成文本");
});

test("GENDOMAIN-3 补漏:X3 缩略图/X7 参考位/N5 拆抽屉各自钉死", () => {
  const seg = readSource("./pages/segment-workbench-page.tsx");
  assert.ok(seg.includes('data-testid="pack-entry-chips"'), "X3：包级编译稿缺参考条目缩略图 chips");
  const widgets = readSource("./components/asset-widgets.tsx");
  assert.ok(widgets.includes('data-testid="asset-image-ref-slot"'), "X7：生成图片弹窗缺参考位");
  assert.ok(widgets.includes("reference_media_ids: referenceMediaIds"), "X7：参考位未接提交 payload");
  assert.ok(widgets.includes("primaryImageVersion"), "X7：参考位未取主图版本");
  assert.ok(batchDrawer.includes("BatchImageGenerateDrawer"), "N5：缺独立图片抽屉导出");
  assert.ok(batchDrawer.includes("BatchVideoGenerateDrawer"), "N5：缺独立视频抽屉导出");
  assert.ok(batchDrawer.includes("BATCH_KIND_VIEWS"), "N5：缺各模态真实界面视图");
  const projectPages = readSource("./pages/project-pages.tsx");
  assert.ok(projectPages.includes("<BatchImageGenerateDrawer"), "N5：生产调用未走图片抽屉");
  assert.ok(projectPages.includes("<BatchVideoGenerateDrawer"), "N5：生产调用未走视频抽屉");
  assert.ok(!projectPages.includes("<BatchGenerateDrawer"), "N5：生产调用仍走共壳抽屉");
});

test("GENDOMAIN-4 余额感知:确认区带数说真话+error-copy 场景映射", () => {
  const seg = readSource("./pages/segment-workbench-page.tsx");
  assert.ok(seg.includes('data-testid="credit-awareness-line"'), "缺余额常态行");
  assert.ok(seg.includes('data-testid="credit-shortfall-line"'), "缺余额不足真话行");
  assert.ok(seg.includes("generationFailureCopy"), "提交失败未走余额感知文案");
  assert.ok(seg.includes("accountCreditsMe"), "余额未接 account-credits/me");
  const insufficient = Object.assign(new Error("insufficient credits"), { code: "account_credit_insufficient" });
  const copy = generationFailureCopy(insufficient, { costPoints: 320, balancePoints: 100 });
  assert.ok(copy.includes("320") && copy.includes("100") && copy.includes("220"), "余额不足文案未带数（这单/余额/还差）");
  assert.ok(!copy.includes("请检查标出的填写内容"), "仍是指错方向的兜底话术");
  const unknown = generationFailureCopy(insufficient, { costPoints: null, balancePoints: null });
  assert.ok(unknown.includes("积分不够"), "无数时未落「积分不够」口径");
});
