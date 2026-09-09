/* ============================================================
   segment-production-164.test.ts — #164 生产界面硬门源码级/纯函数验收
   G9  批量生图:段页有入口,抽屉=本段视图(标题/署名/参考集同源),三段链不绕过
   G10 选定稿:镜头图片面板(P-17a 语义)——选用=定稿、手选/默认分得开、
       定稿与入库双标独立、失败图永不可选、在途有动效
   G11 生视频:镜头视频产物页面内可播(storage_url 直显);定稿自动进参考如实告知
   G12 下载:走 api.downloadMedia(鉴权代理我们自己的存储),不碰厂商临时地址
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ShotMediaItem } from "./api";
import { shotMediaSelectionLabel, shotVideoPlaylist } from "./pages/segment-workbench-page";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const segmentPage = readSource("./pages/segment-workbench-page.tsx");
const batchDrawer = readSource("./pages/batch-generate-drawer.tsx");

function mediaItem(partial: Partial<ShotMediaItem> & { id: string }): ShotMediaItem {
  return {
    shot_id: "shot-1",
    media_kind: "video",
    persistence_status: "persisted",
    review_status: null,
    origin_label: null,
    storage_url: `https://tos.invalid/${partial.id}.mp4`,
    download_url: `/api/v1/media/${partial.id}/download`,
    mime_type: "video/mp4",
    width_px: null,
    height_px: null,
    duration_seconds: null,
    is_primary: false,
    selection_source: null,
    registered_asset_media_id: null,
    provider_result_key: null,
    created_at: null,
    ...partial,
  };
}

/* ---------- G11:可播清单纯函数 ---------- */

test("shotVideoPlaylist:只收有存储地址的视频条目", () => {
  const items = [
    mediaItem({ id: "v1" }),
    mediaItem({ id: "img1", media_kind: "image", storage_url: "https://tos.invalid/i.png" }),
    mediaItem({ id: "v2", storage_url: null }),
    mediaItem({ id: "v3", storage_url: "" }),
  ];
  assert.deepEqual(shotVideoPlaylist(items).map((item) => item.id), ["v1"]);
});

test("shotVideoPlaylist:定稿优先,其余最新在前", () => {
  const items = [
    mediaItem({ id: "old", created_at: "2026-08-01T00:00:00Z" }),
    mediaItem({ id: "new", created_at: "2026-08-05T00:00:00Z" }),
    mediaItem({ id: "primary-old", is_primary: true, selection_source: "manual", created_at: "2026-08-02T00:00:00Z" }),
  ];
  assert.deepEqual(shotVideoPlaylist(items).map((item) => item.id), ["primary-old", "new", "old"]);
});

test("shotMediaSelectionLabel:手选与系统默认分得开,历史版本不署名(§10.3,P-17a 措辞)", () => {
  assert.equal(shotMediaSelectionLabel(mediaItem({ id: "m", is_primary: true, selection_source: "manual" })), "定稿 · 手选");
  assert.equal(shotMediaSelectionLabel(mediaItem({ id: "d", is_primary: true, selection_source: "latest_default" })), "定稿 · 默认(最新)");
  assert.equal(shotMediaSelectionLabel(mediaItem({ id: "h" })), null);
});

/* ---------- G9:段页批量生图入口与抽屉接线 ---------- */

test("G9:段页头带有批量生图入口,挂载共享抽屉且钉死 image 模态", () => {
  assert.ok(segmentPage.includes(">批量生图</Button>"), "段页缺批量生图入口");
  assert.ok(segmentPage.includes('mediaKind="image"'), "段级抽屉未钉死 image 模态");
  assert.ok(segmentPage.includes("SEGMENT_IMAGE_BATCH_VIEW"), "段级批量未换本段视图");
});

test("G9:段级清单=本场镜头,参考集=控制包 submitted 层(与逐镜/整段同一取数源)", () => {
  assert.ok(segmentPage.includes("setBatchImageShots(shots)"), "头带入口清单不是本场镜头");
  assert.ok(segmentPage.includes("shots={batchImageShots}"), "抽屉清单未接调用方给的镜头集");
  assert.ok(segmentPage.includes("referenceMediaIds={batchImageReferenceIds}"), "参考集未接控制包");
  assert.ok(segmentPage.includes("partitionControlPack(lanesState"), "参考集取数源漂移");
});

test("G9:抽屉支持段级署名 episodeLabel,缺省仍回落「第 N 集」", () => {
  assert.ok(batchDrawer.includes("episodeLabel"), "抽屉缺 episodeLabel 接缝");
  assert.ok(batchDrawer.includes("`第 ${episodeNo} 集`"), "集级署名兜底被改丢");
  assert.ok(segmentPage.includes("episodeLabel={`段落·${sceneName}`}"), "段页未传段级署名");
});

test("G9:批量提交成功后接上本页任务轮询(genTick)与全局进度广播", () => {
  assert.ok(segmentPage.includes('window.dispatchEvent(new Event("production-progress-changed"))'), "缺进度广播");
  assert.ok(segmentPage.includes("setGenTick((tick) => tick + 1)"), "提交后未接轮询");
});

test("G9:batchEstimate 客户端把 wire 的 item_id 归一为 itemId(真栈抓出的隐形断链)", () => {
  const apiSource = readSource("./api.ts");
  assert.ok(apiSource.includes("item.item_id"), "api.batchEstimate 缺 item_id → itemId 归一");
  assert.ok(apiSource.includes("itemId: (typeof item.itemId"), "归一逻辑被改动");
});

/* ---------- G11/G12:镜头视频产物播放与下载 ---------- */

test("G11:视频在页面内播放,播放器 src 用 storage_url(我们自己 TOS 的直显地址)", () => {
  assert.ok(segmentPage.includes("<video"), "缺视频播放器");
  assert.ok(segmentPage.includes("src={playing.storage_url ?? undefined}"), "播放器未用 storage_url");
});

test("G11:拿定稿生视频——逐镜确认区如实告知定稿图自动进参考", () => {
  assert.ok(segmentPage.includes('data-testid="final-image-auto-reference"'), "缺定稿进参考提示");
  assert.ok(segmentPage.includes("shot.selected_image_result_id"), "提示未以定稿指针为条件");
});

test("G12:下载走 api.downloadMedia(/media/:id/download 鉴权代理),不直连厂商地址", () => {
  assert.ok(segmentPage.includes("api.downloadMedia(item.id)"), "下载未走鉴权代理接口");
  assert.ok(!segmentPage.includes("download_url ?? item.storage_url"), "下载绕开了鉴权代理");
});

test("G11/G12:产物面板随在途任务落终态自动重拉(mediaTick),不用刷新页面", () => {
  assert.ok(segmentPage.includes("setMediaTick((tick) => tick + 1)"), "缺落终态边沿重拉");
  assert.ok(segmentPage.includes("refreshKey={mediaTick}"), "面板未接重拉信号");
});

/* ---------- G10:选定稿(镜头图片面板,P-17a 语义) ---------- */

import {
  shotImageFinalBadge,
  shotImageFinalStatusLine,
  shotImageGeometryLabel,
  shotImageVersions,
  splitShotImageTasks,
} from "./pages/shot-image-results";
import type { GenerationTask } from "./types";

const imagePanel = readSource("./pages/shot-image-results.tsx");

function imageItem(partial: Partial<ShotMediaItem> & { id: string }): ShotMediaItem {
  return mediaItem({ media_kind: "image", storage_url: `https://tos.invalid/${partial.id}.png`, mime_type: "image/png", ...partial });
}

test("G10:图片版本只收图片条目,按生成时间正序(卡号 01 起编)", () => {
  const items = [
    imageItem({ id: "b", created_at: "2026-08-06T02:00:00Z" }),
    mediaItem({ id: "v", created_at: "2026-08-06T01:00:00Z" }),
    imageItem({ id: "a", created_at: "2026-08-06T01:00:00Z" }),
  ];
  assert.deepEqual(shotImageVersions(items).map((item) => item.id), ["a", "b"]);
});

test("G10:定稿徽章分型——手选/默认(最新)/历史版本(§10.3)", () => {
  assert.equal(shotImageFinalBadge(imageItem({ id: "m", is_primary: true, selection_source: "manual" })), "manual");
  assert.equal(shotImageFinalBadge(imageItem({ id: "d", is_primary: true, selection_source: "latest_default" })), "default");
  assert.equal(shotImageFinalBadge(imageItem({ id: "h" })), null);
});

test("G10:定稿状态条——无定稿说规则,手选/默认署名与 P-17a 同词", () => {
  assert.match(shotImageFinalStatusLine([]), /还没有定稿/);
  const manual = imageItem({ id: "m", is_primary: true, selection_source: "manual", created_at: "2026-08-06T01:00:00Z" });
  assert.match(shotImageFinalStatusLine([manual]), /本镜定稿:01\(手选\)/);
  const dflt = imageItem({ id: "d", is_primary: true, selection_source: "latest_default", created_at: "2026-08-06T01:00:00Z" });
  assert.match(shotImageFinalStatusLine([dflt]), /本镜定稿:01\(默认 · 最新\)/);
});

test("G10:画幅尺寸如实呈现,无原始像素不编", () => {
  assert.equal(shotImageGeometryLabel(imageItem({ id: "p", width_px: 720, height_px: 1280 })), "竖屏 · 720×1280");
  assert.equal(shotImageGeometryLabel(imageItem({ id: "l", width_px: 1280, height_px: 720 })), "横屏 · 1280×720");
  assert.equal(shotImageGeometryLabel(imageItem({ id: "n" })), "图片");
});

test("G10:在途/失败任务按本镜+图片型过滤(成功产物不在此列)", () => {
  const base = { generation_request_id: "r", status: "pending" as const, shot_id: "shot-1" };
  const tasks: GenerationTask[] = [
    { ...base, generation_request_id: "inflight", media_kind: "image" },
    { ...base, generation_request_id: "failed", status: "failed", media_kind: "image" },
    { ...base, generation_request_id: "video", media_kind: "video" },
    { ...base, generation_request_id: "other-shot", shot_id: "shot-2", media_kind: "image" },
    { ...base, generation_request_id: "done", status: "succeeded", media_kind: "image" },
  ];
  const split = splitShotImageTasks(tasks, "shot-1");
  assert.deepEqual(split.inflight.map((task) => task.generation_request_id), ["inflight"]);
  assert.deepEqual(split.failed.map((task) => task.generation_request_id), ["failed"]);
});

test("G10:选用=setShotPrimary 写定稿指针;失败图没有选用入口(永不可选)", () => {
  assert.ok(imagePanel.includes("api.setShotPrimary(shot.id, item.id)"), "选用未接 setShotPrimary");
  assert.ok(imagePanel.includes("出完才能选"), "在途卡缺不可选说明");
  assert.ok(!imagePanel.includes("selectFinal(task"), "失败/在途卡不得给选用");
});

test("G10:定稿两来源徽章=实心手选/描边默认,P-17a 同词", () => {
  assert.ok(imagePanel.includes("定稿 · 手选"), "缺手选徽章");
  assert.ok(imagePanel.includes("定稿 · 默认(最新)"), "缺默认徽章");
  assert.ok(imagePanel.includes('data-testid="badge-final-manual"'), "手选徽章缺锚点");
  assert.ok(imagePanel.includes('data-testid="badge-final-default"'), "默认徽章缺锚点");
});

test("G10:定稿与入库是两个独立动作——入库走 registerMediaResultAsset,徽章各自独立", () => {
  assert.ok(imagePanel.includes("api.registerMediaResultAsset(item.id)"), "入库未接登记接口");
  assert.ok(imagePanel.includes('data-testid="badge-registered"'), "缺已入资产库徽章");
  assert.ok(imagePanel.includes("registered_asset_media_id"), "入库标记未读 wire 字段");
});

test("G10:失败卡说人话给下一步——换个说法重试(落 image_prompt 再开抽屉)+看看提示词", () => {
  assert.ok(imagePanel.includes("换个说法重试"), "缺换个说法重试");
  assert.ok(imagePanel.includes("看看提示词"), "缺看看提示词");
  assert.ok(imagePanel.includes('api.updateShot(shot.id, { image_prompt: retryDraft.text })'), "新说法未落 image_prompt");
  assert.ok(imagePanel.includes("task.display_reason"), "失败原因未用脱敏 display_reason");
});

test("G10:等待态有动效(thinking-orbs working),不是静态文字", () => {
  assert.ok(imagePanel.includes('from "thinking-orbs"'), "未接 thinking-orbs");
  assert.ok(imagePanel.includes('state="working"'), "在途卡缺 working 动效");
});

test("G10:段页接线——选中镜默认图片签,面板接任务流/改判回调/单镜抽屉", () => {
  assert.ok(segmentPage.includes("<ShotImageResults"), "段页未挂图片面板");
  assert.ok(segmentPage.includes("tasks={sceneVersions}"), "面板未接任务流(在途/失败卡断链)");
  assert.ok(segmentPage.includes("onOpenBatch={(target) => setBatchImageShots([target])}"), "再出一批未开单镜抽屉");
  assert.ok(segmentPage.includes('data-testid={`shot-panel-tab-${key}`}'), "缺图片/视频页签");
});

test("G10:shot-media wire 解析带 registered_asset_media_id(已入资产库标记)", () => {
  const apiSource = readSource("./api.ts");
  assert.ok(apiSource.includes('firstValue(value, "registered_asset_media_id", "registeredAssetMediaId")'), "解析器缺入库字段");
});

test("S3:shot-media wire 解析带 provider_result_key(尾帧行 last-frame-<i> 与候选图分得开)", () => {
  const apiSource = readSource("./api.ts");
  assert.ok(apiSource.includes('firstValue(value, "provider_result_key", "providerResultKey")'), "解析器缺供应商结果键");
});

/* ---------- 工作台 L1/L2(P-04b 顶层结构,§9.6 拍板本期口径) ---------- */

test("L1:分镜切换条——同集段落按 sort_order 直切 sceneWorkbenchPath,>1 段才渲染", () => {
  assert.ok(segmentPage.includes('data-testid="scene-switcher"'), "缺分镜切换条");
  assert.ok(segmentPage.includes("siblingScenes.length > 1"), "单段也渲染=占位噪音");
  assert.ok(segmentPage.includes("navigate(sceneWorkbenchPath(projectId, episodeId, item.id))"), "切换未走段页路由");
  assert.ok(segmentPage.includes("(a.sort_order ?? 0) - (b.sort_order ?? 0)"), "切换条未按 sort_order 排序");
});

test("L1:重新生成=重算派生物不扣积分——只重拉剧本/资产,不触碰生成与估价端点", () => {
  assert.ok(segmentPage.includes('data-testid="regenerate-derivatives"'), "缺重新生成按钮");
  assert.ok(segmentPage.includes("重算提示词与匹配，不扣积分"), "缺不扣积分口径");
  const fn = segmentPage.slice(segmentPage.indexOf("function regenerateDerivatives"), segmentPage.indexOf("function regenerateDerivatives") + 400);
  assert.ok(fn.includes("refsState.retry()") && fn.includes("shotState.retry()"), "重算未接剧本/资产重拉");
  for (const forbidden of ["createGeneration", "quoteGeneration", "batchEstimate", "batchConfirm"]) {
    assert.ok(!fn.includes(forbidden), `重新生成不得触碰付费端点 ${forbidden}`);
  }
});

test("L2:三页签骨架——工作台高亮;参考图/生成视频留灰并写明为什么灰(本期不做)", () => {
  assert.ok(segmentPage.includes('data-testid="workbench-tabs"'), "缺三页签骨架");
  assert.ok(segmentPage.includes('data-testid="tab-reference-images-disabled"'), "参考图签未留灰");
  assert.ok(segmentPage.includes('data-testid="tab-video-disabled"'), "生成视频签未留灰");
  assert.ok(segmentPage.includes("本期不做 · 图像处理与宫格分镜，待模型接线"), "参考图签缺灰因");
  assert.ok(segmentPage.includes("本期不做 · 视频提示词与模型选择，待拍板"), "生成视频签缺灰因");
});

test("开拍不设闸(V-29 对齐 P-04b):缺类点名+「仍可开拍」,琥珀警示不硬闸", () => {
  assert.ok(segmentPage.includes("通过率会低。仍可开拍。"), "整段确认区缺「仍可开拍」话术");
  assert.ok(segmentPage.includes("missingLaneLabels"), "缺类未点名");
  assert.ok(segmentPage.includes('text-warning" data-testid="prep-shortfall-note"'), "缺参考话术未用警示色");
});

test("术语:参考控制包未满=「备料中」+还差 N 件,不出现「已锁定」", () => {
  assert.ok(segmentPage.includes('data-testid="pack-prepping-tag"'), "缺备料中标记");
  assert.ok(segmentPage.includes("还差 ${missingLanes.length} 件"), "缺还差计数");
  assert.ok(!segmentPage.includes("已锁定"), "段落工作台不得出现「已锁定」");
});

test("术语:定稿措辞与 P-17a 同源——手选/默认(最新),旧词「人工选用/最新默认」退场", () => {
  assert.ok(segmentPage.includes("定稿 · 手选"), "缺手选措辞");
  assert.ok(segmentPage.includes("定稿 · 默认(最新)"), "缺默认措辞");
  assert.ok(!segmentPage.includes("人工选用"), "旧词「人工选用」未退");
  assert.ok(!segmentPage.includes("最新默认"), "旧词「最新默认」未退");
});

test("等待态动效:在途版本 pill 带 working orb;重新生成忙态带 composing orb", () => {
  assert.ok(segmentPage.includes('<ThinkingOrb state="working" size={20}'), "版本 pill 缺动效");
  assert.ok(segmentPage.includes('<ThinkingOrb state="composing" size={20}'), "重新生成缺 composing 动效");
});
