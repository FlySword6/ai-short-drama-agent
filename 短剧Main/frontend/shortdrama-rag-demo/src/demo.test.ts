import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  demoEpisodes,
  demoEpisodesForProject,
  demoProjectAssetsForProject,
  demoProjectById,
  demoProjects,
  demoShotMedia,
  demoShotMediaForShot,
  demoShots,
  demoStoryboardImportPreview,
  registerDemoSessionProject,
} from "./demo";
import { demoDeliveryGaps, demoMediaReviewQueuePage, demoReadyVideoIds, resetDemoReviewDelivery } from "./demo-review-delivery";
import { inferProductionProgress, type ProductionShotRecord } from "./production-progress";
import type { MediaVersion } from "./types";

/* K2O/GP-04：demo fallback 必须按 projectId 隔离——两个 projectId 各自 fallback 不串；
   读不出该项目的数据就如实空/自己的名，绝不拿 fixture 属主项目（demo-project-2《杀穿女频》）顶上。
   媒体 fixture 同口径：K2A 合流后 demoShotMedia 是 demo 媒体唯一真源，隔离 accessor 覆盖它、不绕开。 */

test("GP-04：fixture 属主项目有集/资产，且全部归属自己", () => {
  const episodes = demoEpisodesForProject("demo-project-2");
  assert.ok(episodes.length > 0, "demo-project-2 应有 fixture 集");
  assert.ok(episodes.every((episode) => episode.project_id === "demo-project-2"));

  const refs = demoProjectAssetsForProject("demo-project-2");
  assert.ok(refs.length > 0, "demo-project-2 应有 fixture 项目资产");
  assert.ok(refs.every((ref) => ref.project_id === "demo-project-2"));
});

test("GP-04：另一个 projectId 的 fallback 不串 fixture 属主项目的数据", () => {
  /* 另一个 fixture 项目（demo-project-1《老公诈死》）：没有自己的集/资产 fixture 就如实空 */
  assert.deepEqual(demoEpisodesForProject("demo-project-1"), []);
  assert.deepEqual(demoProjectAssetsForProject("demo-project-1"), []);
  /* 新项目式 id（demo-project-<时间戳>，未登记）：同样如实空 */
  assert.deepEqual(demoEpisodesForProject("demo-project-1753800000000"), []);
  assert.deepEqual(demoProjectAssetsForProject("demo-project-1753800000000"), []);
});

test("GP-04：demo 会话新建的项目登记后按 projectId 找回真名，不顶别的项目 fixture", () => {
  const created = { id: "demo-project-test-session", name: "《永恒之塔》", status: "进行中" };
  registerDemoSessionProject(created);
  assert.equal(demoProjectById(created.id)?.name, "《永恒之塔》");
  /* 会话项目没有集/资产 fixture，项目页如实空态 */
  assert.deepEqual(demoEpisodesForProject(created.id), []);
  assert.deepEqual(demoProjectAssetsForProject(created.id), []);
  /* fixture 项目的名字不受会话登记影响 */
  assert.equal(demoProjectById("demo-project-2")?.name, demoProjects.find((item) => item.id === "demo-project-2")?.name);
  /* 改名后同 id 覆盖（会话登记优先于 fixture） */
  registerDemoSessionProject({ ...created, name: "《永恒之塔·改》" });
  assert.equal(demoProjectById(created.id)?.name, "《永恒之塔·改》");
  /* demo 完全不认识的项目：如实 undefined，由调用方给空态 */
  assert.equal(demoProjectById("demo-project-not-exists"), undefined);
});

/* K2O/GP-04 媒体维度：K2A 的 demoShotMedia 是集成线上 demo 媒体唯一真源，隔离口径必须覆盖它——
   表以 shot.id 为键、不自带 project 字段，accessor 沿 shot→episode→project 归属链按调用方 projectId 门控。 */

test("GP-04：媒体 fixture 属主项目读得到真源表内容（accessor 不绕开 demoShotMedia）", () => {
  /* 属主项目读自己的 shot：拿到的就是真源表同一份内容（引用相等=没另写一份状态） */
  const media = demoShotMediaForShot("demo-project-2", "demo-shot-1");
  assert.ok(media.length > 0, "demo-project-2 的 demo-shot-1 应有图/视频产物");
  assert.equal(media, demoShotMedia["demo-shot-1"], "accessor 必须直读 K2A 真源表，不复制、不另写");
  /* 真源表每个键沿归属链都归 demo-project-2（fixture 只服务它声明归属的项目） */
  for (const shotId of Object.keys(demoShotMedia)) {
    const shot = demoShots.find((item) => item.id === shotId);
    assert.ok(shot, `真源表键 ${shotId} 应对应 fixture shot`);
    const episode = demoEpisodesForProject("demo-project-2").find((item) => item.id === shot.episode_id);
    assert.ok(episode, `真源表键 ${shotId} 的归属链应落在 demo-project-2`);
  }
});

test("GP-04：陌生/非属主 projectId 读媒体 fixture 得空，不串 demo-project-2 的产物", () => {
  /* 陌生 id：读任何 fixture shot 的媒体都必须空 */
  assert.deepEqual(demoShotMediaForShot("demo-project-999999", "demo-shot-1"), []);
  /* 另一个 fixture 项目（demo-project-1《老公诈死》）：同样不串 */
  assert.deepEqual(demoShotMediaForShot("demo-project-1", "demo-shot-1"), []);
  /* 会话新建项目：登记了名字也没有媒体 fixture，如实空 */
  assert.deepEqual(demoShotMediaForShot("demo-project-test-session", "demo-shot-1"), []);
  /* 属主项目读陌生 shot：同样如实空 */
  assert.deepEqual(demoShotMediaForShot("demo-project-2", "demo-shot-not-exists"), []);
});

/* K2O/GP-08：demo 导入预览的诚实形态——标记示例数据、带上真实文件名、
   文案明说不是解析结果；can_confirm 恒 false（离线不允许确认）。 */

test("GP-08：demo 导入预览标注示例数据，不冒充解析结果", () => {
  const record = demoStoryboardImportPreview("demo-project-test-session", "我的剧本.xlsx");
  assert.equal(record.demo_sample, true, "必须带示例数据标记，预览区据此显著标注");
  assert.equal(record.file_name, "我的剧本.xlsx", "文件名取自用户真实选择的文件");
  assert.equal(record.preview.can_confirm, false);
  assert.equal(record.preview.rows.length, 3);
  const messages = record.preview.issues.map((issue) => issue.message).join("\n");
  assert.match(messages, /不做真实解析/);
  assert.match(messages, /示例数据/);
  assert.match(messages, /不是「我的剧本\.xlsx」的内容/);
});

/* ============================================================
   K2-P GP-27 幕四彩排 fixture 自洽守卫(基于 K2-A 真源表重做)

   彩排情节:demo-project-2 第 1 集「5 镜已过审可交付 + 1 镜缺口」——
   素材 1-5 图/视频主版本俱齐、已选主版本、review_status=accepted;
   素材 6 只有主图(缺口镜,视频未生成)。
   四处必须说同一件事:生产进度条(stepper)、集头(视频计数)、素材卡(主版本媒体)、
   交付口径(demoReadyVideoIds/demoDeliveryGaps 的「N/M 镜可交付」)。
   本文件就是不变量:把 #6 也写上主视频、或把任一主版本 review_status 改坏,
   这里必须红。
   ============================================================ */

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function mediaOf(shotId: string): MediaVersion[] {
  return demoShotMedia[shotId] ?? [];
}

function primaryOfKind(shotId: string, kind: "image" | "video"): MediaVersion | undefined {
  return mediaOf(shotId).find((item) => item.media_kind === kind && item.is_primary === true);
}

const DELIVERABLE_SHOT_IDS = ["demo-shot-1", "demo-shot-2", "demo-shot-3", "demo-shot-4", "demo-shot-5"];

test("K2P GP-27:1-5 镜图/视频主版本俱齐且 review_status=accepted,#6 只有主图(缺口镜)", () => {
  assert.equal(demoShots.length, 6, "彩排集应为 6 镜");
  for (const shot of demoShots) {
    const image = primaryOfKind(shot.id, "image");
    assert.ok(image, `${shot.id} 缺主图`);
    assert.equal(image?.persistence_status, "persisted", `${shot.id} 主图未持久化`);
    assert.equal(image?.review_status, "accepted", `${shot.id} 主图未过审`);
    assert.equal(shot.selected_image_result_id, image?.id, `${shot.id} 选中主图与媒体不一致`);
    if (shot.id === "demo-shot-6") {
      assert.equal(primaryOfKind(shot.id, "video"), undefined, "缺口镜 #6 不应有视频主版本");
      assert.equal(mediaOf(shot.id).filter((item) => item.media_kind === "video").length, 0, "缺口镜 #6 不应挂任何视频条目");
      assert.ok(!shot.selected_video_result_id, "缺口镜 #6 不应选视频主版本");
    } else {
      const video = primaryOfKind(shot.id, "video");
      assert.ok(video, `${shot.id} 缺视频主版本`);
      assert.equal(video?.persistence_status, "persisted", `${shot.id} 视频未持久化`);
      /* 与旧 K2P 的关键差别:K2-A 的审核队列由 review_status 驱动,光有媒体没有
         accepted 会全落待审,「5 镜可交付」就不成立。 */
      assert.equal(video?.review_status, "accepted", `${shot.id} 视频主版本未过审`);
      assert.equal(shot.selected_video_result_id, video?.id, `${shot.id} 选中视频与媒体不一致`);
    }
  }
});

test("K2P GP-27:进度条与 fixture 同源——当前卡点是 #6 缺视频,不再说 #1 没图", () => {
  /* 与 production-stepper.tsx 的 demoRecords() 同一构造(唯一源=demoShotMedia)。 */
  const records: ProductionShotRecord[] = demoShots.map((shot) => ({ episode: demoEpisodes[0]!, shot, media: mediaOf(shot.id) }));
  const progress = inferProductionProgress(records);
  assert.equal(progress.current, "video");
  assert.equal(progress.shotId, "demo-shot-6");
  assert.ok(progress.description.includes("#6"), "卡点描述应指到缺口镜 #6");
  assert.ok(progress.description.includes("还没有可用视频"), "卡点应如实说缺视频");
});

test("K2P GP-27:集头口径=5/6——5 镜已选视频主版本,#6 未选", () => {
  const episode1Shots = demoShots.filter((shot) => shot.episode_id === "demo-episode-1");
  const videoDone = episode1Shots.filter((shot) => shot.selected_video_result_id).length;
  assert.equal(videoDone, 5, "集头「本集视频已生成 5/6」的分子");
  assert.equal(episode1Shots.length, 6, "集头分母");
});

test("K2P GP-27:交付口径=5/6——5 镜视频主版本已过审,未交齐只有 #6(缺视频主版本)", () => {
  resetDemoReviewDelivery();
  assert.deepEqual([...demoReadyVideoIds("demo-episode-1")].sort(), ["demo-video-1", "demo-video-2", "demo-video-3", "demo-video-4", "demo-video-5"]);
  const gaps = demoDeliveryGaps("demo-episode-1");
  assert.deepEqual(gaps.map((gap) => gap.shotCode), ["6"], "「5 / 6 镜可交付」的缺口应只有 #6");
  assert.equal(gaps[0]!.reason, "missing_video_primary", "#6 的缺口原因应是缺视频主版本");
});

test("K2P GP-27:审核队列三页签分布合理——待审 2(候选)/已通过 11/已拒绝 1(候选),待审不挡交付", () => {
  resetDemoReviewDelivery();
  const pending = demoMediaReviewQueuePage({ status: "needs_review", episodeId: "demo-episode-1", page: 1, pageSize: 50 });
  assert.equal(pending.total, 2, "队列要有待审项,批量通过/单镜拒绝才演得动");
  assert.ok(pending.items.every((item) => !item.isPrimary), "待审项必须是非主版本候选,否则「5 镜可交付」不成立");
  const accepted = demoMediaReviewQueuePage({ status: "accepted", episodeId: "demo-episode-1", page: 1, pageSize: 50 });
  assert.equal(accepted.total, 11, "6 主图 + 5 视频主版本全部过审");
  const rejected = demoMediaReviewQueuePage({ status: "rejected", episodeId: "demo-episode-1", page: 1, pageSize: 50 });
  assert.equal(rejected.total, 1, "已拒绝页签留 1 条候选演拒绝留痕");
  assert.ok(!rejected.items[0]!.isPrimary, "已拒绝项不应占主版本位");
});

test("K2P GP-27 源码级:镜头媒体唯一真源=demo.ts 的 demoShotMedia,消费方不再各写一份", () => {
  const stepper = readSource("./production-stepper.tsx");
  assert.ok(stepper.includes("media: demoShotMedia[shot.id]"), "进度条 demoRecords 未消费 demoShotMedia");
  assert.ok(!stepper.includes("shot, media: [] }"), "进度条仍固定空媒体(旧矛盾根)");

  const projectPages = readSource("./pages/project-pages.tsx");
  assert.ok(!projectPages.includes("const DEMO_SHOT_MEDIA"), "project-pages 仍私存一份镜头媒体");
  /* K2O 合流后素材卡改走 projectId 门控 accessor(demoShotMediaForShot)——accessor 直读真源表,
     与直读 demoShotMedia[shot.id] 同效;两种调用形状都算消费真源表。 */
  assert.ok(
    projectPages.includes("demoShotMediaForShot(") || projectPages.includes("demoShotMedia[shot.id]"),
    "素材卡未消费 demoShotMedia 真源表(直读或经 projectId 门控 accessor)",
  );

  const demoStore = readSource("./demo-review-delivery.ts");
  assert.ok(demoStore.includes("demoShotMedia"), "审核队列彩排仓未从 demoShotMedia 派生");
});

test("K2P GP-27:id 纪律——只用 K2-A 的 demo-image-N/demo-video-N 族,不复活旧 K2P 的 demo-shot-media-N 族", () => {
  /* 打回根因:两包同名 demoShotMedia 互撞。K2-A 表是唯一真源,本包注入的候选版本
     也挂在 demo-video-Nb 族下;旧 K2P 的 demo-shot-media-N-image/video id 族作废。 */
  const demoSource = readSource("./demo.ts");
  assert.ok(!demoSource.includes("demo-shot-media-"), "旧 K2P 的 id 族在 demo.ts 复活");
  for (const shotId of DELIVERABLE_SHOT_IDS) {
    const no = shotId.replace("demo-shot-", "");
    assert.ok(primaryOfKind(shotId, "image")?.id === `demo-image-${no}`, `${shotId} 主图 id 不在 demo-image-N 族`);
    assert.ok(primaryOfKind(shotId, "video")?.id === `demo-video-${no}`, `${shotId} 视频主版本 id 不在 demo-video-N 族`);
  }
});
