/* ============================================================
   display-labels.test.ts — 业务语言化（#18）技术标识中文标签验收

   判据：服务商/型号/工具名三类标识上屏=中文标签；未知值中性兜底，
   原值只进 title 悬浮说明，不裸显。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import {
  modelDisplayLabel,
  modelRawTitle,
  providerLabel,
  providerRawTitle,
  toolNameLabel,
  toolNameRawTitle,
} from "./display-labels";

test("#18：服务商标识 → 中文服务名；未知 → 平台服务 + title 原值", () => {
  assert.equal(providerLabel("ark"), "火山方舟");
  assert.equal(providerLabel("openspeech"), "语音合成服务");
  assert.equal(providerLabel("Ark"), "火山方舟", "大小写归一");
  assert.equal(providerLabel(null), "—");
  assert.equal(providerLabel(""), "—");
  assert.equal(providerLabel("some-new-vendor"), "平台服务", "未知服务商不裸显");
  assert.equal(providerRawTitle("some-new-vendor"), "some-new-vendor", "未知值进 title");
  assert.equal(providerRawTitle("ark"), undefined, "已识别不加 title");
  assert.equal(providerRawTitle(null), undefined);
});

test("#18：型号 → 能力中文名；未知 → 平台模型 + title 原值", () => {
  assert.equal(modelDisplayLabel("doubao-seed-1.6"), "对话模型");
  assert.equal(modelDisplayLabel("Seedream 4.5"), "图片生成模型");
  assert.equal(modelDisplayLabel("seedance-2.0-pro"), "视频生成模型");
  assert.equal(modelDisplayLabel("doubao-seedance-1.0"), "视频生成模型", "seedance 先于 doubao 命中");
  assert.equal(modelDisplayLabel("openspeech-tts-v1"), "语音合成模型");
  assert.equal(modelDisplayLabel(null), "—");
  assert.equal(modelDisplayLabel("vendor-x-9000"), "平台模型", "未知型号不裸显");
  assert.equal(modelRawTitle("vendor-x-9000"), "vendor-x-9000");
  assert.equal(modelRawTitle("doubao-seed-1.6"), undefined, "已识别型号不加 title");
});

test("#18：工具名 → 中文动作；未知 snake_case → 工具调用 + title 原值", () => {
  assert.equal(toolNameLabel("search_assets"), "检索资产");
  assert.equal(toolNameLabel("add_project_asset"), "加入项目资产");
  assert.equal(toolNameLabel("generate_media"), "准备生成");
  assert.equal(toolNameLabel("get_generation_task"), "查询任务");
  assert.equal(toolNameLabel("draft_episode_outline"), "起草分集大纲");
  assert.equal(toolNameLabel("brand_new_tool"), "工具调用", "新工具不裸显 snake_case");
  assert.equal(toolNameLabel(null), "工具调用");
  assert.equal(toolNameRawTitle("brand_new_tool"), "brand_new_tool");
  assert.equal(toolNameRawTitle("search_assets"), undefined);
});

test("#18：标签自身过判据——无 snake_case/厂商型号原串残留", () => {
  const labels = [
    providerLabel("ark"),
    modelDisplayLabel("doubao-seed-1.6"),
    modelDisplayLabel("Seedream 4.5"),
    toolNameLabel("search_assets"),
    providerLabel("mystery"),
    modelDisplayLabel("mystery"),
    toolNameLabel("mystery_tool"),
  ];
  for (const label of labels) {
    assert.ok(!/ark|doubao|seedream|seedance|openspeech|_/i.test(label), `标签含技术词：${label}`);
    assert.ok(/[一-鿿—]/.test(label), `标签必须是中文业务词：${label}`);
  }
});
