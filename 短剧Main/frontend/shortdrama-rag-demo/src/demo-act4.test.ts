/* ============================================================
   demo-act4.test.ts — K2U 幕四彩排自洽守卫(D-14/D-17/D-18/D-19,v2 重落)

   自洽不变量(变异验证的靶子,改坏任何一条都必须红):
   1. 5+1 结构:1-5 镜有「已过审的已选中持久化视频主版本」,#6 没有(缺口镜);
   2. 同源:连播清单、交付预览 JSON、交付预览 CSV 都从 demoShotMedia(K2A 真源表)
      派生,闸门与 demo-review-delivery 会话仓同一口径(accepted)——
      会话里拒绝主版本,连播/清单同步少一镜、缺口记 video_not_accepted;
   3. 合同:JSON = deliverables?partial=true wire 形状(含 partial/gaps),
      CSV 列与后端 manifestToCsv 同款 15 列;缺口原因只用后端枚举;
   4. 占位视频真实存在于 public/(视频库/预览全集/整集连播才能真播);
   5. id 纪律:派生数据的媒体 id 只吃 demo-image-N/demo-video-N 族,
      旧 K2P 的 demo-shot-media-N 族不复活;
   6. D-17 会话仓:裁决/提审真翻转并留痕,拒绝无理由拦下,终态不重复流转;
   7. 接线:三处回放与三处导出的 demo 分支都消费本包数据源,
      「离线演示不写库/不落盘」标注在位。
   ============================================================ */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  applyDemoAssetDecision,
  applyDemoAssetSubmissions,
  demoAssetReviewTrail,
  resetDemoAssetReviewSession,
} from "./components/review-actions";
import { demoEpisodes, demoShotMedia, demoShots } from "./demo";
import {
  buildDemoDeliveryPreview,
  demoDeliveryGapText,
  demoEpisodePlayback,
} from "./demo-delivery";
import { applyDemoReviewDecisions, demoReadyVideoIds, resetDemoReviewDelivery } from "./demo-review-delivery";
import type { DeliverableItem } from "./types";

const EPISODE_ID = "demo-episode-1";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/** fixture + 会话仓口径里「可交付」的镜集合(视频主版本过审)——一切派生数据的真源口径。 */
function deliverableShotIds(): string[] {
  const ready = new Set(demoReadyVideoIds(EPISODE_ID));
  return demoShots
    .filter((shot) => {
      const media = demoShotMedia[shot.id] ?? [];
      return media.some((item) => item.media_kind === "video" && item.is_primary && item.persistence_status === "persisted" && item.id === shot.selected_video_result_id && ready.has(item.id) && Boolean(item.storage_url));
    })
    .map((shot) => shot.id);
}

/* ---------- D-14:三处回放的数据源(连播清单) ---------- */

test("K2U D-14：第 1 集连播 = 5 镜可播,与真源可交付镜集合一致;#6 不在其中", () => {
  resetDemoReviewDelivery();
  const playback = demoEpisodePlayback(EPISODE_ID);
  assert.deepEqual(playback.playback.map((item) => item.shot_id), deliverableShotIds(), "连播镜集合与真源可交付镜集合不一致");
  assert.equal(playback.playback.length, 5, "连播应为 5 镜(1-5),#6 缺口不进连播");
  assert.deepEqual(playback.playback.map((item) => item.shot_code), ["1", "2", "3", "4", "5"], "连播顺序应按镜号 1→5");
  assert.ok(!playback.playback.some((item) => item.shot_id === "demo-shot-6"), "缺口镜 #6 不应进连播");
  for (const clip of playback.playback) {
    assert.match(clip.storage_url, /^\/demo-media\/ep1-shot-\d\.mp4$/, "连播地址必须是本地占位视频");
    assert.equal(clip.duration_seconds, 4, "占位小样时长应如实标注 4 秒");
    assert.equal(clip.mime_type, "video/mp4");
  }
  /* 清单 items = 5 主图 + 5 粗剪,与 playback 同集同源。 */
  assert.equal(playback.items.length, 10, "交付清单应为 10 项(5 图 + 5 视频)");
  assert.equal(playback.items.filter((item) => item.media_kind === "image").length, 5);
  assert.equal(playback.episode.no, 1);
});

test("K2U D-14：占位视频文件真实存在于 public/(三处回放真播的前提)", () => {
  resetDemoReviewDelivery();
  for (const clip of demoEpisodePlayback(EPISODE_ID).playback) {
    assert.ok(existsSync(new URL(`../public${clip.storage_url}`, import.meta.url)), `占位视频 ${clip.storage_url} 不存在`);
  }
});

test("K2U D-14：克隆集(第 2/3 集)连播如实为空,不串彩排数据", () => {
  resetDemoReviewDelivery();
  for (const episode of demoEpisodes.slice(1)) {
    const playback = demoEpisodePlayback(episode.id);
    assert.equal(playback.playback.length, 0, `${episode.id} 不应有连播内容`);
    assert.equal(playback.items.length, 0, `${episode.id} 不应有交付项`);
  }
});

test("K2U v2 同源：会话仓拒绝主版本→连播与清单同步少一镜,缺口记 video_not_accepted;重置复原", () => {
  resetDemoReviewDelivery();
  const outcomes = applyDemoReviewDecisions([{ media_result_id: "demo-video-3", action: "reject", rejection_reason: "马蹄穿帮" }]);
  assert.equal(outcomes[0]!.changed, true, "拒绝主版本应真翻转");
  const playback = demoEpisodePlayback(EPISODE_ID);
  assert.deepEqual(playback.playback.map((item) => item.shot_code), ["1", "2", "4", "5"], "拒绝 #3 主版本后连播应少一镜");
  assert.equal(playback.items.length, 8, "清单同步变 8 项(4 图 + 4 视频)");
  const preview = buildDemoDeliveryPreview(EPISODE_ID)!;
  assert.deepEqual(
    preview.gaps.map((gap) => [gap.shotCode, gap.reason]),
    [["3", "video_not_accepted"], ["6", "missing_video_primary"]],
    "缺口应同时列出未过审 #3 与缺视频 #6(只用后端枚举)",
  );
  assert.equal(demoDeliveryGapText(preview.gaps[0]!), "#3 视频主版本未过审");
  const wire = JSON.parse(preview.jsonText) as { partial: boolean; gaps: Array<{ shot_id: string; reason: string }> };
  assert.equal(wire.partial, true);
  assert.deepEqual(wire.gaps.map((gap) => gap.shot_id), ["demo-shot-3", "demo-shot-6"], "JSON wire 的 gaps 同步且为 snake_case");
  resetDemoReviewDelivery();
  assert.equal(demoEpisodePlayback(EPISODE_ID).playback.length, 5, "重置后连播回 5 镜(刷新复原口径)");
});

/* ---------- D-18/D-19:交付清单内容(JSON/CSV 同源、合同形状) ---------- */

test("K2U D-19：交付预览 = 10 项 + 缺口 #6(missing_video_primary),JSON 为 partial wire 形状", () => {
  resetDemoReviewDelivery();
  const preview = buildDemoDeliveryPreview(EPISODE_ID);
  assert.ok(preview, "第 1 集应有交付预览");
  assert.equal(preview.itemCount, 10);
  assert.equal(preview.imageCount, 5);
  assert.equal(preview.videoCount, 5);
  assert.deepEqual(preview.gaps, [{ shotId: "demo-shot-6", shotCode: "6", reason: "missing_video_primary" }], "缺口应逐镜列出且只用后端枚举");
  assert.equal(demoDeliveryGapText(preview.gaps[0]!), "#6 还没有视频主版本");

  const wire = JSON.parse(preview.jsonText) as Record<string, unknown>;
  assert.equal(wire.version, "v0.1");
  assert.equal(wire.partial, true, "有缺口镜时 JSON 应如实标注 partial");
  assert.equal((wire.gaps as unknown[]).length, 1);
  assert.equal((wire.items as unknown[]).length, 10);
  assert.equal(wire.estimated_cost_fen, preview.estimatedCostFen);
  assert.equal((wire.episode as { no: number }).no, 1);
  assert.match(String(wire.estimated_cost_notice), /离线示例/, "清单说明应如实标注离线示例");
});

test("K2U D-19：JSON 与 CSV 同源——媒体集合一致,CSV 为表头 + 10 行", () => {
  resetDemoReviewDelivery();
  const preview = buildDemoDeliveryPreview(EPISODE_ID)!;
  const lines = preview.csvText.split("\n");
  assert.equal(lines.length, 11, "CSV 应为表头 + 10 行产物");
  const jsonIds = new Set((JSON.parse(preview.jsonText).items as DeliverableItem[]).map((item) => item.media_id));
  const csvIds = lines.slice(1).map((line) => line.split(",")[5]);
  assert.deepEqual(new Set(csvIds), jsonIds, "CSV 与 JSON 的媒体集合必须一致");
});

test("K2U D-19：CSV 列与后端 manifestToCsv 同款 15 列(防漂移)", () => {
  const backend = readSource("../../../src/modules/delivery/manifest.ts");
  const headerMatch = backend.match(/const header = \[([\s\S]*?)\];/);
  assert.ok(headerMatch, "后端 manifestToCsv 表头定义未找到");
  const backendColumns = [...headerMatch[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  resetDemoReviewDelivery();
  const preview = buildDemoDeliveryPreview(EPISODE_ID)!;
  assert.deepEqual(preview.csvText.split("\n")[0]!.split(","), backendColumns, "demo CSV 列与后端 deliverables.csv 不一致");
});

test("K2U D-19：克隆集没有可交付主版本,预览如实为 null(对应真栈 409 人话态)", () => {
  resetDemoReviewDelivery();
  for (const episode of demoEpisodes.slice(1)) {
    assert.equal(buildDemoDeliveryPreview(episode.id), null, `${episode.id} 不应生成交付预览`);
  }
});

test("K2U v2 id 纪律：派生数据的媒体 id 只吃 demo-image-N/demo-video-N 族", () => {
  resetDemoReviewDelivery();
  const playback = demoEpisodePlayback(EPISODE_ID);
  for (const item of playback.items) {
    assert.match(item.media_id, /^demo-(image|video)-\d+$/, `${item.media_id} 不在 K2A id 族`);
    assert.ok(!item.media_id.includes("demo-shot-media-"), "旧 K2P id 族复活");
  }
  const preview = buildDemoDeliveryPreview(EPISODE_ID)!;
  for (const line of preview.csvText.split("\n").slice(1)) {
    assert.match(line.split(",")[5]!, /^demo-(image|video)-\d+$/, "CSV 媒体 id 不在 K2A id 族");
  }
});

/* ---------- D-17:资产裁决会话仓(真翻转+留痕+拦截) ---------- */

test("K2U D-17：会话裁决真翻转并留痕——通过/拒绝入轨迹,拒绝无理由按 422 同文案拦下", () => {
  resetDemoAssetReviewSession();
  assert.throws(
    () => applyDemoAssetDecision({ assetId: "asset-lin", action: "reject", fromStatus: "pending_review", reason: "  ", reviewerName: "Alice" }),
    /拒绝必须写明理由/,
    "空理由拒绝必须被拦(与后端 422 同文案)",
  );
  const approved = applyDemoAssetDecision({ assetId: "asset-lin", action: "approve", fromStatus: "pending_review", reviewerName: "Alice" });
  assert.equal(approved.toStatus, "approved");
  assert.equal(approved.action, "approved");
  const rejected = applyDemoAssetDecision({ assetId: "common-palace", action: "reject", fromStatus: "pending_review", reason: "屋脊形制与朝代不符", reviewerName: "Alice" });
  assert.equal(rejected.toStatus, "rejected");
  assert.equal(rejected.rejectionReason, "屋脊形制与朝代不符");

  const trail = demoAssetReviewTrail("common-palace");
  assert.ok(trail.some((record) => record.id === rejected.id && record.rejectionReason === "屋脊形制与朝代不符"), "会话拒绝应进审核轨迹留痕");
  assert.ok(demoAssetReviewTrail("asset-lin").some((record) => record.id === approved.id), "会话通过应进审核轨迹留痕");
  resetDemoAssetReviewSession();
  assert.ok(!demoAssetReviewTrail("common-palace").some((record) => record.id === rejected.id), "重置后会话留痕应清空(刷新复原口径)");
});

test("K2U D-17：会话批量提审逐项出结果——自动态进待审,待审/终态不重复流转", () => {
  resetDemoAssetReviewSession();
  const items = applyDemoAssetSubmissions([
    { id: "asset-harbor", status: "automatic_review" },
    { id: "asset-lin", status: "pending_review" },
    { id: "asset-ren", status: "approved" },
    { id: "asset-knife", status: "rejected" },
  ], "Alice");
  assert.deepEqual(
    items.map((item) => [item.assetId, item.changed, item.reason]),
    [
      ["asset-harbor", true, "submitted"],
      ["asset-lin", false, "already_pending_review"],
      ["asset-ren", false, "already_approved"],
      ["asset-knife", false, "already_rejected"],
    ],
    "提审逐项结果与真栈口径不一致",
  );
  assert.equal(items[0]!.status, "pending_review", "新进待审的状态应真翻转为 pending_review");
  assert.ok(demoAssetReviewTrail("asset-harbor").some((record) => record.action === "submitted" && record.reviewerDisplayName === "Alice"), "提审应留 submitted 痕迹");
  assert.equal(demoAssetReviewTrail("asset-lin").filter((record) => record.reviewerDisplayName === "Alice").length, 0, "未流转的不应留痕");
  resetDemoAssetReviewSession();
});

/* ---------- 接线守卫:demo 分支消费本包数据源,真栈动作原样保留 ---------- */

test("K2U 源码级：三处回放 demo 分支消费 demo-delivery/demoShotMedia,不再是空态", () => {
  const operations = readSource("./pages/operations-pages.tsx");
  assert.ok(operations.includes("demoEpisodePlayback(episodeId)"), "连播弹窗 demo fallback 未消费 demo-delivery");
  assert.ok(!operations.includes("EMPTY_PLAYBACK"), "连播弹窗仍用旧空 fixture");

  const workbench = readSource("./pages/workbench-page.tsx");
  assert.ok(workbench.includes("{ items: demoShotMedia[shotId] ?? [], count: (demoShotMedia[shotId] ?? []).length }"), "工作台视频库 demo fallback 未与 demoShotMedia 同源");

  /* 块 2:顶栏集时间线随镜级工作台退役,第三处回放(app.tsx)合同随之关闭。 */
});

test("K2U 源码级：三处导出 demo 分支同一预览弹窗,真栈下载动作原样保留", () => {
  const operations = readSource("./pages/operations-pages.tsx");
  const projectPages = readSource("./pages/project-pages.tsx");
  /* 块 2:app.tsx 页头交付快捷键随镜级工作台退役,导出预览弹窗合同收敛为两处。 */
  for (const [name, source] of [["operations-pages", operations], ["project-pages", projectPages]] as const) {
    assert.ok(source.includes("DemoExportPreviewDialog"), `${name} 未接导出预览弹窗`);
  }
  /* 真栈分支零改动:三处仍走既有下载接口。 */
  assert.ok(operations.includes("await api.downloadEpisodeJson(episodeId)"), "连播页脚真栈 JSON 下载被改动");
  assert.ok(operations.includes("await api.downloadEpisodeCsv(episodeId)"), "连播页脚真栈 CSV 下载被改动");
  assert.ok(projectPages.includes("await api.downloadEpisodeCsv(selectedEpisode.id)"), "生产页真栈 CSV 下载被改动");
  assert.ok(projectPages.includes("await api.downloadEpisodeJson(selectedEpisode.id)"), "生产页真栈 JSON 下载被改动");
  /* 旧「只弹 toast」的 demo 拦截已退役。 */
  assert.ok(!operations.includes("离线演示不会导出示例交付清单"), "连播页脚 demo 仍只弹 toast");
  assert.ok(!projectPages.includes("离线演示不会下载真实文件\", \"info\");\n      return;\n    }\n    try {\n      if (mode === \"all\")"), "生产页导出 demo 仍只弹 toast");
});

test("K2U 源码级：D-17 两页裁决/提审 demo 分支接入会话仓,诚实标注在位", () => {
  const projectPages = readSource("./pages/project-pages.tsx");
  assert.ok(projectPages.includes("applyDemoAssetDecision"), "裁决 demo 分支未接会话仓");
  assert.ok(projectPages.includes("applyDemoAssetSubmissions"), "批量提审 demo 分支未接会话仓");
  assert.ok(projectPages.includes("通用资产审核只在本次会话翻转并留痕，不提交后端"), "本剧资产页离线标注未更新");
  const panels = readSource("./components/review-panels.tsx");
  assert.ok(panels.includes("demoAssetReviewTrail(assetId)"), "轨迹面板未消费会话留痕");
  const preview = readSource("./components/demo-export-preview.tsx");
  assert.ok(preview.includes("不落盘"), "导出预览缺「离线演示不落盘」标注");
  assert.ok(preview.includes("离线演示"), "导出预览缺离线标注");
});
