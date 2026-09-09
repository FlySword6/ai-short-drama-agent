import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSET_UPLOAD_FILE_ACCEPT,
  audioTraitListFromInput,
  assetLibraryPendingCount,
  isAudioUploadFile,
  isExcelUploadFile,
  uploadDisplayFileName,
  uploadNotificationText,
  uploadTaskCardModel,
  uploadTaskEstimatedDurationText,
  uploadTaskIsActive,
  uploadTaskQueuePositionText,
  uploadTaskStatusLabel,
} from "./asset-upload-tracker";
import type { AssetUploadNotification, AssetUploadTask } from "./types";

function task(partial: Partial<AssetUploadTask>): AssetUploadTask {
  return { id: "t-1", status: "queued", original_file_name: "角色.png", ...partial };
}

test("Excel 资产表走同步批量解析,图片走异步队列", () => {
  assert.equal(isExcelUploadFile("资产表.xlsx"), true);
  assert.equal(isExcelUploadFile("资产表.XLSM"), true);
  assert.equal(isExcelUploadFile("角色.png"), false);
  assert.equal(isExcelUploadFile("无扩展名"), false);
});

test("音频入库只接受后端合同允许的格式", () => {
  assert.equal(isAudioUploadFile("人声参考.mp3"), true);
  assert.equal(isAudioUploadFile("环境音.WAV"), true);
  assert.equal(isAudioUploadFile("钟声.ogg"), true);
  assert.equal(isAudioUploadFile("月影.opus"), true);
  assert.equal(isAudioUploadFile("无扩展名", "audio/mpeg"), true);
  assert.equal(isAudioUploadFile("无扩展名", "audio/opus"), true);
  assert.equal(isAudioUploadFile("旁白.m4a", "audio/mpeg"), false);
  assert.equal(isAudioUploadFile("旁白.m4a", "audio/mp4"), false);
  assert.equal(isAudioUploadFile("音乐.flac", "audio/flac"), false);
});

test("音频标签输入按中英文分隔符清洗为空值列表", () => {
  assert.deepEqual(audioTraitListFromInput("低沉，克制, 疲惫、温柔\n沙哑"), ["低沉", "克制", "疲惫", "温柔", "沙哑"]);
  assert.deepEqual(audioTraitListFromInput("  ,，、\n  "), []);
});

test("资产中心文件选择器放宽显示系统音频但仍列出 opus 合同格式", () => {
  assert.match(ASSET_UPLOAD_FILE_ACCEPT, /(?:^|,)\.opus(?:,|$)/);
  assert.match(ASSET_UPLOAD_FILE_ACCEPT, /(?:^|,)audio\/\*(?:,|$)/);
  assert.match(ASSET_UPLOAD_FILE_ACCEPT, /(?:^|,)audio\/opus(?:,|$)/);
});

test("排位只对 queued 给值,processing/终态不编数字", () => {
  assert.equal(uploadTaskQueuePositionText(task({ status: "queued", queue_position: 3 })), "排队第 3 位");
  assert.equal(uploadTaskQueuePositionText(task({ status: "queued", queue_position: null })), null);
  assert.equal(uploadTaskQueuePositionText(task({ status: "queued", queue_position: 0 })), null);
  assert.equal(uploadTaskQueuePositionText(task({ status: "processing", queue_position: 3 })), null);
  assert.equal(uploadTaskQueuePositionText(task({ status: "succeeded" })), null);
});

test("ETA 用历史样本中位数,样本不足不显示耗时行(S46 B-3:不摆「暂无估计」状态自述)", () => {
  assert.equal(uploadTaskEstimatedDurationText(task({ status: "queued", estimated_duration_seconds: 45 })), "预计总耗时约 45 秒");
  assert.equal(uploadTaskEstimatedDurationText(task({ status: "processing", estimated_duration_seconds: 125 })), "预计总耗时约 2 分 5 秒");
  assert.equal(uploadTaskEstimatedDurationText(task({ status: "queued", estimated_duration_seconds: null })), null);
  assert.equal(uploadTaskEstimatedDurationText(task({ status: "succeeded", estimated_duration_seconds: 45 })), null);
});

test("状态徽章用大众认知措辞,活跃口径=排队中或入库中", () => {
  assert.equal(uploadTaskStatusLabel(task({ status: "queued" })), "排队中");
  assert.equal(uploadTaskStatusLabel(task({ status: "processing" })), "入库中");
  assert.equal(uploadTaskStatusLabel(task({ status: "succeeded" })), "已入库");
  assert.equal(uploadTaskStatusLabel(task({ status: "failed" })), "失败");
  assert.equal(uploadTaskStatusLabel(null), "已提交");
  assert.equal(uploadTaskIsActive("queued"), true);
  assert.equal(uploadTaskIsActive("processing"), true);
  assert.equal(uploadTaskIsActive("succeeded"), false);
  assert.equal(uploadTaskIsActive("failed"), false);
});

test("卡片模型透传文件名与文案,不额外造数", () => {
  const card = uploadTaskCardModel(task({ status: "queued", queue_position: 2, estimated_duration_seconds: null }));
  assert.deepEqual(card, {
    id: "t-1",
    fileName: "角色.png",
    statusLabel: "排队中",
    queuePositionText: "排队第 2 位",
    estimatedDurationText: null,
  });
});

test("S46 B-3: 机器串文件名不裸露原文,显示「未命名图片+扩展名」;人类可读原名不动", () => {
  assert.equal(uploadDisplayFileName("3fa85f64-5717-4562-b3fc-2c963f66afa6.png"), "未命名图片.png");
  assert.equal(uploadDisplayFileName("9F3A85F6-5717-4562-B3FC-2C963F66AFA6.PNG"), "未命名图片.PNG");
  assert.equal(uploadDisplayFileName("e3b0c44298fc1c149afbf4c8996fb92427ae41e4.jpg"), "未命名图片.jpg");
  assert.equal(uploadDisplayFileName("1721900000000000.webp"), "未命名图片.webp");
  assert.equal(uploadDisplayFileName("角色.png"), "角色.png");
  assert.equal(uploadDisplayFileName("雨夜巷战参考-终稿.jpg"), "雨夜巷战参考-终稿.jpg");
  const card = uploadTaskCardModel(task({ original_file_name: "3fa85f64-5717-4562-b3fc-2c963f66afa6.png" }));
  assert.equal(card.fileName, "未命名图片.png");
});

test("S46 C-2: 头部待入库并入在途上传,toast 入库中时计数不再为 0", () => {
  assert.equal(assetLibraryPendingCount(0, 1), 1);
  assert.equal(assetLibraryPendingCount(2, 0), 2);
  assert.equal(assetLibraryPendingCount(3, 2), 5);
  // 异常负数不吞掉列表计数。
  assert.equal(assetLibraryPendingCount(1, -2), 1);
});

test("终态提醒：成功报资产名，失败只显示公开文案", () => {
  const succeeded: AssetUploadNotification = {
    id: "n-1", status: "succeeded", original_file_name: "角色.png",
    result_asset_name: "林晚", created_at: "2026-07-27T00:00:00Z",
  };
  assert.deepEqual(uploadNotificationText(succeeded), { title: "图片已入库", body: "「林晚」已加入个人资产库。" });

  const failed: AssetUploadNotification = {
    id: "n-2", status: "failed", original_file_name: "角色.png",
    error_message: "TOS request failed with status 503",
    display_reason: "图片入库没成：请重新上传该图片。", created_at: "2026-07-27T00:00:00Z",
  };
  assert.deepEqual(uploadNotificationText(failed), { title: "图片入库失败", body: "图片入库没成：请重新上传该图片。" });

  const failedNoReason: AssetUploadNotification = {
    id: "n-3", status: "failed", original_file_name: "角色.png", created_at: "2026-07-27T00:00:00Z",
  };
  assert.deepEqual(uploadNotificationText(failedNoReason), { title: "图片入库失败", body: "图片入库没成：请重新上传该图片。" });
});
