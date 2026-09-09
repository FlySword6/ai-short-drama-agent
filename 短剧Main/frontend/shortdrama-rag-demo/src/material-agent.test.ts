/* ============================================================
   material-agent.test.ts — 素材智能体页（板08）纯函数验收断言
   ① 检索 mode → 标注文案映射（structured_fallback/hybrid/undefined）
   ② 文件名 → 项目名提取
   ③ 入库批次结果聚合（N 成功 M 失败）
   ④ 后端状态卡推导（如实展示，不虚构）
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import {
  demoIngestCount,
  demoMaterialSearchResult,
  ingestBatchMessage,
  ingestFileKind,
  projectNameFromFileName,
  searchModeAnnotation,
  summarizeIngestBatch,
  vectorStatusFromError,
  vectorStatusFromSearch,
  vectorStatusView,
  type IngestFileOutcome,
} from "./pages/material-agent-page";

/* ---------- ① mode → 标注文案 ---------- */

test("structured_fallback → 「结构化命中」+ 降级提示与重试口径", () => {
  const annotation = searchModeAnnotation("structured_fallback");
  assert.equal(annotation.label, "结构化命中");
  assert.equal(annotation.degraded, true);
  assert.ok(annotation.hint.includes("回退"), "降级提示缺回退说明");
});

test("hybrid → 「语义命中」，非降级", () => {
  const annotation = searchModeAnnotation("hybrid");
  assert.equal(annotation.label, "语义命中");
  assert.equal(annotation.degraded, false);
  assert.equal(annotation.hint, "");
});

test("mode 缺省 → 默认标注「检索命中」，不虚构降级", () => {
  const annotation = searchModeAnnotation(undefined);
  assert.equal(annotation.label, "检索命中");
  assert.equal(annotation.degraded, false);
});

/* ---------- ② 文件名 → 项目名 ---------- */

test("去扩展名：Excel 与图片", () => {
  assert.equal(projectNameFromFileName("《杀穿女频》资产表.xlsx"), "《杀穿女频》资产表");
  assert.equal(projectNameFromFileName("巷口雨夜.jpg"), "巷口雨夜");
  assert.equal(projectNameFromFileName("角色表.xlsm"), "角色表");
});

test("去路径：斜杠与反斜杠都剥掉", () => {
  assert.equal(projectNameFromFileName("C:\\素材\\九千岁角色表.xlsx"), "九千岁角色表");
  assert.equal(projectNameFromFileName("assets/场景/府衙正堂.png"), "府衙正堂");
});

test("多点文件名只去最后扩展名；无扩展名原样；压缩空白", () => {
  assert.equal(projectNameFromFileName("资产表.v3.xlsx"), "资产表.v3");
  assert.equal(projectNameFromFileName("杀青物料"), "杀青物料");
  assert.equal(projectNameFromFileName("  雨夜   巷口 .webp"), "雨夜 巷口");
});

test("提取不出来时返回空串（调用方回退手动输入）", () => {
  assert.equal(projectNameFromFileName(".xlsx"), "");
  assert.equal(projectNameFromFileName(""), "");
});

/* ---------- ③ 入库批次聚合 ---------- */

function outcome(partial: Partial<IngestFileOutcome> & { fileName: string }): IngestFileOutcome {
  return { ok: true, count: 0, assetIds: [], error: "", ...partial };
}

test("批次聚合：3 成功 1 失败，条数与资产 id 只算成功文件", () => {
  const summary = summarizeIngestBatch([
    outcome({ fileName: "a.xlsx", count: 12, assetIds: ["a1", "a2"] }),
    outcome({ fileName: "b.png", count: 1, assetIds: ["b1"] }),
    outcome({ fileName: "c.xlsx", ok: false, error: "解析失败" }),
    outcome({ fileName: "d.jpg", count: 1, assetIds: ["d1"] }),
  ]);
  assert.equal(summary.filesTotal, 4);
  assert.equal(summary.filesSucceeded, 3);
  assert.equal(summary.filesFailed, 1);
  assert.equal(summary.assetsIngested, 14);
  assert.deepEqual(summary.assetIds, ["a1", "a2", "b1", "d1"]);
});

test("批次文案：全成时报写入资产数，不把音频说成解析", () => {
  const summary = summarizeIngestBatch([outcome({ fileName: "a.xlsx", count: 519, assetIds: ["x"] })]);
  assert.equal(ingestBatchMessage(summary), "已写入 519 条资产");
});

test("批次文案：有失败如实报 N 成功 M 失败", () => {
  const summary = summarizeIngestBatch([
    outcome({ fileName: "a.xlsx", count: 8, assetIds: ["x"] }),
    outcome({ fileName: "b.xlsx", ok: false, error: "网络错误" }),
  ]);
  const message = ingestBatchMessage(summary);
  assert.ok(message.includes("1 个文件成功"), message);
  assert.ok(message.includes("1 个失败"), message);
  assert.ok(message.includes("8 条资产"), message);
});

test("空批次守 0，不除零不越界", () => {
  const summary = summarizeIngestBatch([]);
  assert.deepEqual(summary, { filesTotal: 0, filesSucceeded: 0, filesFailed: 0, filesSubmittedForParsing: 0, assetsIngested: 0, assetIds: [] });
  assert.equal(ingestBatchMessage(summary), "已写入 0 条资产");
});

test("视频入库只提示解析任务已提交，不冒充后台解析已完成", () => {
  const summary = summarizeIngestBatch([
    outcome({ fileName: "动作参考.mp4", kind: "video", submittedForParsing: true, count: 0, assetIds: ["video-asset-1"] }),
  ]);
  assert.equal(summary.assetsIngested, 0);
  assert.equal(summary.filesSubmittedForParsing, 1);
  assert.equal(ingestBatchMessage(summary), "已提交 1 个视频解析任务");
});

test("音频入库按资产创建计数，不进入解析任务统计", () => {
  const summary = summarizeIngestBatch([
    outcome({ fileName: "男主旁白.opus", kind: "audio", count: 1, assetIds: ["audio-asset-1"] }),
  ]);
  assert.equal(summary.assetsIngested, 1);
  assert.equal(summary.filesSubmittedForParsing, 0);
  assert.equal(ingestBatchMessage(summary), "已写入 1 条资产");
});

test("入库文件类型判定：Excel / 图片 / 视频 / 音频 / 不支持", () => {
  assert.equal(ingestFileKind("资产表.xlsx"), "excel");
  assert.equal(ingestFileKind("资产表.XLSM"), "excel");
  assert.equal(ingestFileKind("定妆照.JPG"), "image");
  assert.equal(ingestFileKind("场景.webp"), "image");
  assert.equal(ingestFileKind("雨夜追逐.MP4"), "video");
  assert.equal(ingestFileKind("镜头参考.webm"), "video");
  assert.equal(ingestFileKind("人声参考.opus"), "audio");
  assert.equal(ingestFileKind("无扩展名", "audio/opus"), "audio");
  assert.equal(ingestFileKind("旁白.m4a", "audio/mp4"), "unsupported");
  assert.equal(ingestFileKind("备注.txt"), "unsupported");
  assert.equal(ingestFileKind("无扩展名"), "unsupported");
});

/* ---------- ④ 后端状态卡推导 ---------- */

test("hybrid → 向量服务已配置", () => {
  const status = vectorStatusFromSearch({ items: [], count: 0, mode: "hybrid" });
  assert.equal(status.state, "configured");
  assert.equal(vectorStatusView(status).title, "向量服务已配置");
});

test("structured_fallback → 降级中，透传 degraded_reason", () => {
  const status = vectorStatusFromSearch({ items: [], count: 0, mode: "structured_fallback", degraded_reason: "Milvus 连接超时" });
  assert.deepEqual(status, { state: "degraded", reason: "Milvus 连接超时" });
  assert.equal(vectorStatusView(status).detail, "Milvus 连接超时");
  // 无 reason 时有兜底文案
  const fallback = vectorStatusFromSearch({ items: [], count: 0, mode: "structured_fallback" });
  assert.ok(vectorStatusView(fallback).detail.includes("回退"));
});

test("mode 缺省 → 保持未探测，不虚构配置状态", () => {
  const status = vectorStatusFromSearch({ items: [], count: 0 });
  assert.equal(status.state, "untested");
  assert.equal(vectorStatusView(status).title, "未探测");
});

test("检索报错 → 探测失败，人话上卡", () => {
  const status = vectorStatusFromError("无法连接服务，请确认后端已启动");
  assert.deepEqual(status, { state: "unreachable", message: "无法连接服务，请确认后端已启动" });
  assert.equal(vectorStatusView(status).title, "探测失败");
});

/* ---------- demo fixture ---------- */

test("离线演示检索：本地 fixture 命中，mode 缺省（页面标注示例数据）", () => {
  const result = demoMaterialSearchResult("巷口");
  assert.ok(result.count >= 1, "fixture 应命中「巷口雨夜」");
  assert.equal(result.mode, undefined);
  const empty = demoMaterialSearchResult("不存在的素材 xyz");
  assert.equal(empty.count, 0);
});

test("离线演示入库模拟计数：Excel 批量、图片/视频/音频单条", () => {
  assert.equal(demoIngestCount("资产表.xlsx"), 6);
  assert.equal(demoIngestCount("定妆照.png"), 1);
  assert.equal(demoIngestCount("动作参考.mp4"), 1);
  assert.equal(demoIngestCount("人声参考.opus"), 1);
});
