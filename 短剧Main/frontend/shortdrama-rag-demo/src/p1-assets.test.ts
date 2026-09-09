import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VARIANT_NAME,
  assetImagePrompt,
  assetMetadataWithImagePrompt,
  assetReferenceLines,
  assetReviewLabel,
  assetReviewStatus,
  assetTypeLine,
  assetUploadReviewNote,
  assetUploadValidationError,
  formatEpisodeNos,
  groupAssetVersions,
  introduceAction,
  normalizeStyleTags,
  projectAssetAddReducer,
  projectAssetReferenceLine,
  projectAssetRemoveReducer,
  referenceBindingsFromMetadata,
  viewLabelForVersion,
} from "./components/asset-upload-modal";
import type { Asset, MediaVersion } from "./types";

const projectId = "22222222-2222-4222-8222-222222222222";

function version(partial: Partial<MediaVersion> & { id: string }): MediaVersion {
  return { media_kind: "image", ...partial };
}

function asset(partial: Partial<Asset> & { id: string }): Asset {
  return { asset_kind: "character", ...partial };
}

/* ---------- 审核四态映射（板12 头部 pill / 板13 卡片 pill） ---------- */

test("assetReviewStatus：后端口径与 demo 口径都归并到四态，未知值并入待审核", () => {
  assert.equal(assetReviewStatus("approved"), "approved");
  assert.equal(assetReviewStatus("ready"), "approved");
  assert.equal(assetReviewStatus("pending_review"), "pending");
  assert.equal(assetReviewStatus("pending"), "pending");
  assert.equal(assetReviewStatus("auto_approved"), "auto");
  assert.equal(assetReviewStatus("rejected"), "rejected");
  assert.equal(assetReviewStatus("something-else"), "pending");
  assert.equal(assetReviewStatus(null), "pending");
  assert.equal(assetReviewLabel("approved"), "已通过");
  assert.equal(assetReviewLabel("pending"), "待审核");
  assert.equal(assetReviewLabel("auto"), "自动通过");
  assert.equal(assetReviewLabel("rejected"), "已拒绝");
});

test("assetTypeLine：类型 + metadata.category / 首个风格标签", () => {
  assert.equal(assetTypeLine(asset({ id: "a1", asset_kind: "character", metadata: { category: "男主参考" }, style_tags: ["古装"] })), "角色 · 男主参考");
  assert.equal(assetTypeLine(asset({ id: "a2", asset_kind: "character", style_tags: ["男主参考", "古装"] })), "角色 · 男主参考");
  assert.equal(assetTypeLine(asset({ id: "a3", asset_kind: "scene" })), "场景");
});

/* ---------- 变体切换（板12：chips 分组、命名、主图、视图标签） ---------- */

test("groupAssetVersions：实体级媒体归入「默认造型」并排最前", () => {
  const groups = groupAssetVersions([
    version({ id: "v1", is_primary: false }),
    version({ id: "v2", is_primary: true }),
    version({ id: "v3", asset_variant_id: "var-a", metadata: { variant_name: "铠甲染血" }, is_primary: true }),
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.id, "");
  assert.equal(groups[0]?.name, DEFAULT_VARIANT_NAME);
  assert.equal(groups[0]?.versions.length, 2);
  assert.equal(groups[0]?.primary?.id, "v2");
  assert.equal(groups[1]?.name, "铠甲染血");
  assert.equal(groups[1]?.primary?.id, "v3");
});

test("groupAssetVersions：无 variant_name 时回退「变体 N」，不虚构命名", () => {
  const groups = groupAssetVersions([
    version({ id: "v1", asset_variant_id: "var-x" }),
    version({ id: "v2", asset_variant_id: "var-y", metadata: { variantName: "官服" } }),
  ]);
  assert.equal(groups[0]?.name, "变体 1");
  assert.equal(groups[1]?.name, "官服");
});

test("groupAssetVersions：组内主图取 is_primary 优先，否则第一条；空列表返回空", () => {
  assert.deepEqual(groupAssetVersions([]), []);
  const groups = groupAssetVersions([version({ id: "v1" }), version({ id: "v2" })]);
  assert.equal(groups[0]?.primary?.id, "v1");
});

test("viewLabelForVersion：metadata.view_angle > title > 视图 N", () => {
  assert.equal(viewLabelForVersion(version({ id: "v1", metadata: { view_angle: "三视图 · 正" }, title: "被忽略" }), 0), "三视图 · 正");
  assert.equal(viewLabelForVersion(version({ id: "v2", title: "特写" }), 3), "特写");
  assert.equal(viewLabelForVersion(version({ id: "v3" }), 4), "视图 5");
});

/* ---------- 上传校验（板12：.jpg/.png/.webp · 单张 ≤ 10MB，S11-5 与后端真口径统一） ---------- */

test("assetUploadValidationError：接受 jpg/png/webp 且 ≤ 10MB", () => {
  assert.equal(assetUploadValidationError({ name: "a.jpg", size: 1024, type: "image/jpeg" }), "");
  assert.equal(assetUploadValidationError({ name: "b.png", size: 10 * 1024 * 1024, type: "image/png" }), "");
  assert.equal(assetUploadValidationError({ name: "c.webp", size: 5, type: "" }), "");
});

test("assetUploadValidationError：拒绝超尺寸、空文件与不支持格式", () => {
  assert.match(assetUploadValidationError({ name: "a.jpg", size: 10 * 1024 * 1024 + 1, type: "image/jpeg" }), /10 MB/);
  assert.equal(assetUploadValidationError({ name: "a.jpg", size: 0, type: "image/jpeg" }), "图片文件不能为空");
  assert.match(assetUploadValidationError({ name: "a.gif", size: 10, type: "image/gif" }), /JPG、PNG 或 WebP/);
  assert.match(assetUploadValidationError({ name: "a.tiff", size: 10, type: "image/tiff" }), /JPG、PNG 或 WebP/);
});

test("assetUploadReviewNote：上传即自动通过（S17-A3 假待审档已摘，一句用户语言说明）", () => {
  assert.match(assetUploadReviewNote(), /上传后即自动通过/);
  assert.ok(!assetUploadReviewNote().includes("缺口"), "不得再出现开发词");
});

/* ---------- 引入-移出状态机（板13：引入 = project_reference，移出 = DELETE reference） ---------- */

test("projectAssetAddReducer：引入追加并标记 project 作用域与引用编号", () => {
  const next = projectAssetAddReducer(null, asset({ id: "a1" }), { projectId, referenceId: "ref-1", mediaId: "media-1" });
  assert.equal(next.items.length, 1);
  assert.equal(next.count, 1);
  assert.equal(next.items[0]?.scope, "project");
  assert.equal(next.items[0]?.project_id, projectId);
  assert.equal(next.items[0]?.project_reference_id, "ref-1");
  assert.equal(next.items[0]?.selected_media_id, "media-1");
});

test("projectAssetAddReducer：幂等——已引入的资产不重复添加", () => {
  const first = projectAssetAddReducer(null, asset({ id: "a1" }), { projectId, referenceId: "ref-1" });
  const second = projectAssetAddReducer(first, asset({ id: "a1" }), { projectId, referenceId: "ref-2" });
  assert.equal(second.items.length, 1);
  assert.equal(second.count, 1);
  assert.equal(second.items[0]?.project_reference_id, "ref-1");
});

test("projectAssetRemoveReducer：移出过滤且计数减一；不存在的项保持原样", () => {
  const added = projectAssetAddReducer(
    projectAssetAddReducer(null, asset({ id: "a1" }), { projectId }),
    asset({ id: "a2" }),
    { projectId },
  );
  const removed = projectAssetRemoveReducer(added, "a1");
  assert.equal(removed?.items.length, 1);
  assert.equal(removed?.items[0]?.id, "a2");
  assert.equal(removed?.count, 1);
  const untouched = projectAssetRemoveReducer(removed, "a9");
  assert.equal(untouched?.items.length, 1);
  assert.equal(untouched?.count, 1);
  assert.equal(projectAssetRemoveReducer(null, "a1"), null);
});

test("introduceAction：引入 / 已引入 / 处理中三态", () => {
  assert.deepEqual(introduceAction("a1", new Set(), ""), { introduced: false, busy: false, label: "引入", disabled: false });
  assert.deepEqual(introduceAction("a1", new Set(["a1"]), ""), { introduced: true, busy: false, label: "已引入", disabled: true });
  const busy = introduceAction("a1", new Set(), "a1");
  assert.equal(busy.busy, true);
  assert.equal(busy.label, "处理中");
  assert.equal(introduceAction("a2", new Set(), "a1").disabled, true);
});

/* ---------- 引用信息推导（板12 引用情况卡 / 板13 卡片引用行） ---------- */

test("referenceBindingsFromMetadata：按约定读 metadata.reference_bindings，容忍缺失与脏数据", () => {
  const bindings = referenceBindingsFromMetadata(asset({
    id: "a1",
    metadata: {
      reference_bindings: [
        { project_id: "p1", project_name: "《杀穿女频》", episode_nos: [1, 2], shot_count: 6 },
        { project_name: "《回到1998》", episode_nos: [], shot_count: null },
        { episode_nos: [3] },
        "junk",
      ],
    },
  }));
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings[0], { projectId: "p1", projectName: "《杀穿女频》", episodeNos: [1, 2], shotCount: 6 });
  assert.deepEqual(bindings[1], { projectId: undefined, projectName: "《回到1998》", episodeNos: [], shotCount: null });
  assert.deepEqual(referenceBindingsFromMetadata(asset({ id: "a2" })), []);
  assert.deepEqual(referenceBindingsFromMetadata(null), []);
});

test("projectAssetReferenceLine：「第 1、2 集 · 6 镜引用」/「绑定于集」/暂未引用（裁决 1：use_count 兜底已摘）", () => {
  const referenced = asset({
    id: "a1",
    metadata: { reference_bindings: [{ project_name: "《杀穿女频》", episode_nos: [1, 2], shot_count: 6 }] },
  });
  assert.equal(projectAssetReferenceLine(referenced), "第 1、2 集 · 6 镜引用");
  const boundOnly = asset({
    id: "a2",
    metadata: { reference_bindings: [{ project_name: "《杀穿女频》", episode_nos: [1], shot_count: null }] },
  });
  assert.equal(projectAssetReferenceLine(boundOnly), "第 1 集 · 绑定于集");
  // 裁决 1：use_count 数据死（无自增链路）,「累计被引用 N 次」兜底整段摘除——无绑定即「暂未引用」
  assert.equal(projectAssetReferenceLine(asset({ id: "a3", use_count: 3 })), "暂未引用");
  assert.equal(projectAssetReferenceLine(asset({ id: "a4" })), "暂未引用");
});

test("projectAssetReferenceLine：按 projectId 过滤绑定，无 projectId 的绑定视为通用", () => {
  const item = asset({
    id: "a1",
    metadata: {
      reference_bindings: [
        { project_id: "other-project", project_name: "《别的剧》", episode_nos: [9], shot_count: 2 },
        { project_id: projectId, project_name: "《杀穿女频》", episode_nos: [1], shot_count: 4 },
      ],
    },
  });
  assert.equal(projectAssetReferenceLine(item, projectId), "第 1 集 · 4 镜引用");
});

test("assetReferenceLines：板12 引用情况卡逐项目一行，未引用项目标 idle", () => {
  const lines = assetReferenceLines(asset({
    id: "a1",
    metadata: {
      reference_bindings: [
        { project_name: "《杀穿女频》", episode_nos: [1, 2], shot_count: 6 },
        { project_name: "《回到1998》", episode_nos: [] },
      ],
    },
  }));
  assert.deepEqual(lines, [
    { text: "《杀穿女频》第 1、2 集 · 6 个分镜引用", active: true },
    { text: "《回到1998》未引用", active: false },
  ]);
  const empty = assetReferenceLines(asset({ id: "a2" }));
  assert.deepEqual(empty, [{ text: "暂未读到引用记录", active: false }]);
  // 裁决 1：use_count 兜底摘除——只有计数没有绑定时按「暂未读到引用记录」处理
  const counted = assetReferenceLines(asset({ id: "a3", use_count: 2 }));
  assert.deepEqual(counted, [{ text: "暂未读到引用记录", active: false }]);
});

test("formatEpisodeNos：顿号连接", () => {
  assert.equal(formatEpisodeNos([1]), "1");
  assert.equal(formatEpisodeNos([1, 2]), "1、2");
  assert.equal(formatEpisodeNos([]), "");
});

/* ---------- 描述 / image_prompt 读写约定（板12 三卡保存） ---------- */

test("assetImagePrompt：metadata.image_prompt 优先，回退 visual_prompt", () => {
  assert.equal(assetImagePrompt(asset({ id: "a1", metadata: { image_prompt: "银甲玄氅" }, visual_prompt: "旧" })), "银甲玄氅");
  assert.equal(assetImagePrompt(asset({ id: "a2", visual_prompt: "旧" })), "旧");
  assert.equal(assetImagePrompt(asset({ id: "a3" })), "");
  assert.equal(assetImagePrompt(null), "");
});

test("assetMetadataWithImagePrompt：写入 image_prompt 且剥除 GET 合并进来的 primaryImage", () => {
  const next = assetMetadataWithImagePrompt({ primaryImage: { id: "m1" }, reference_bindings: [], keep: "yes" }, "  新提示词  ");
  assert.equal(next.image_prompt, "新提示词");
  assert.equal(next.keep, "yes");
  assert.ok(!("primaryImage" in next));
  assert.deepEqual(next.reference_bindings, []);
  const cleared = assetMetadataWithImagePrompt({ image_prompt: "旧" }, "   ");
  assert.ok(!("image_prompt" in cleared));
});

test("normalizeStyleTags：去空白、去重、上限 50", () => {
  assert.deepEqual(normalizeStyleTags([" 男主参考 ", "古装", "男主参考", "", "青年"]), ["男主参考", "古装", "青年"]);
  assert.equal(normalizeStyleTags(Array.from({ length: 60 }, (_, index) => `tag-${index}`)).length, 50);
});
