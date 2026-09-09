/* ============================================================
   asset-shared.tsx — W5.5 资产域共享纯逻辑（Dario #3/#4/#8）
   纯函数与常量集中在本文件、刻意不 import CSS：src/asset-center.test.ts
   直接覆盖（tsx --test 无法加载 .css，与 review-actions / promote-asset 先例一致）。
   UI 组件在 asset-widgets.tsx，视图层走 Tailwind utility（旧 asset-widgets.css 已随迁移删除）。

   覆盖范围：
   - 统一资产类型枚举（任务 4.3）：资产中心筛选 / 项目引入抽屉 / 项目资产页签唯一来源；
   - 审核四态说明文案（任务 3.2 悬浮说明 / 任务 8.2 图例 tooltip）；
   - 项目卡闭环统计可读格式化（任务 3.2）；
   - 性别 / 年龄段 / 名称 / Tag 客户端过滤（任务 8.4 / 4.4）；
   - Tag 建议下拉纯逻辑（bug6：收集去重 / 编辑段替换 / 建议过滤，UI 在 asset-widgets 的 TagFilterInput）；
   - 卡片副标题与版本摘要（任务 8.5：N 张图 · N 个变体 · N 待审核）；
   - 导入个人资产降级文案（任务 4.2：404/501/网络错 → 后端接口接入中（Sol 侧））；
   - 项目资产「更多」菜单定义（任务 8.3）。
   ============================================================ */

/* 显式 React import：门禁（node:test + tsx classic JSX）渲染断言与 Vite react-jsx 双兼容
   （AssetKindSelectOptions 在本文件做真渲染断言，与 ui.tsx 同一先例）。 */
import * as React from "react";
import { ApiClientError } from "../api";
import { isRecord } from "../generation-quotes";
import type { Asset, MediaVersion } from "../types";
import { assetKindLabel, assetName } from "../ui";
import { businessErrorMessage } from "../error-copy";
import type { AssetReviewBucket } from "./review-actions";

/* ---------- 统一资产类型枚举（任务 4.3） ----------
   资产中心筛选、项目引入抽屉（AssetPickerDrawer）、项目资产页签、新建资产弹窗
   必须从同一份常量取选项，禁止一处有「服装」另一处没有。 */

/**
 * S88 分类学大类（DC「动物不该与角色并列」整改）：三个维度少而稳——
 * - entity「创作实体」：戏里的东西（角色/场景/道具/服装）；动物是角色的子类（parent=character）；
 * - reference「参考素材」：拿来指导生成的素材（光线/摄影/视频/声音/配乐，reference 是兜底项）；
 * - artifact「产物形态」：生成链路产出的素材形态（关键帧/3D 素模）。
 * 大类是展示分组坐标，不是新枚举闸门：新增类型仍只登记词表主值+挂一个大类，
 * 子类走 parent 指向（可扩展），符合 creative-vocabulary-openness.md 的 R9。
 */
export type AssetKindCategory = "entity" | "reference" | "artifact";

export const ASSET_KIND_CATEGORY_LABELS: Readonly<Record<AssetKindCategory, string>> = {
  entity: "创作实体",
  reference: "参考素材",
  artifact: "产物形态",
};

export interface AssetKindOption {
  /** 筛选值（后端 asset_kind 主写入口径）。 */
  value: string;
  /** 展示文案：与 ui.tsx assetKindLabel 同一来源，label 改动自动跟随。 */
  label: string;
  /** S88：所属分类学大类（选择器 optgroup 分组的唯一来源）。 */
  category: AssetKindCategory;
  /**
   * S88：子类的父类型主值（目前仅 animal→character）。
   * 筛选父类型时上卷命中子类资产；子类自身仍是独立可选值，存量 animal 数据零迁移。
   */
  parent?: string;
  /**
   * 同一逻辑类型的历史/别名值：通用资产真实数据里 clothing（服装）、other（参考）
   * 等旧值仍在流通，筛选主值时必须一并命中，否则用户会以为资产丢了。
   */
  aliases: readonly string[];
}

/**
 * 资产类型枚举（W5.5-4 全站统一；S88 起按大类分组排序）。
 * 同源纪律：枚举值以后端为准，前端不独立发明——
 * 主值见后端 src/domain/assets/types.ts（AssetEntityData.assetKind 流通值），
 * 3D 素模分类见 src/modules/assets/directorManifestImport.ts 的
 * DIRECTOR_ASSET_PATH_CLASSIFICATIONS（character/scene/prop/clothing/other）。
 * 新增类型先后端落值，再在这里加映射（挂一个大类即可，子类另指 parent）。
 */
const ASSET_KIND_DEFS: ReadonlyArray<{ value: string; category: AssetKindCategory; parent?: string; aliases?: readonly string[] }> = [
  { value: "character", category: "entity" },
  { value: "animal", category: "entity", parent: "character" },
  { value: "scene", category: "entity" },
  { value: "prop", category: "entity" },
  { value: "costume", category: "entity", aliases: ["clothing"] },
  { value: "lighting", category: "reference" },
  { value: "camera", category: "reference" },
  { value: "video", category: "reference" },
  { value: "audio", category: "reference" },
  { value: "sound", category: "reference" },
  { value: "music", category: "reference" },
  { value: "reference", category: "reference", aliases: ["other"] },
  { value: "keyword", category: "artifact", aliases: ["keyframe"] },
  { value: "model_3d", category: "artifact" },
];

export const ASSET_KIND_OPTIONS: ReadonlyArray<AssetKindOption> = ASSET_KIND_DEFS.map((def) => ({
  value: def.value,
  label: assetKindLabel(def.value),
  category: def.category,
  parent: def.parent,
  aliases: def.aliases ?? [],
}));

export interface AssetKindGroup {
  category: AssetKindCategory;
  label: string;
  options: ReadonlyArray<AssetKindOption>;
}

/** S88：选择器分组（创作实体 → 参考素材 → 产物形态），从 OPTIONS 派生，禁各页面自排。 */
export const ASSET_KIND_GROUPS: ReadonlyArray<AssetKindGroup> = (
  ["entity", "reference", "artifact"] as const
).map((category) => ({
  category,
  label: ASSET_KIND_CATEGORY_LABELS[category],
  options: ASSET_KIND_OPTIONS.filter((option) => option.category === category),
}));

/**
 * S88b：「未分类」筛选/陈列的哨兵值（不是后端枚举，只是前端筛选坐标）——
 * 词表外值（如 dev 库实测的 scene_reference）与空白 kind 归到这里陈列，
 * 不再被分组视图吞掉；标签走 ui.tsx assetKindLabel 的同名兜底。
 */
export const UNCATEGORIZED_KIND = "__uncategorized__";
export const UNCATEGORIZED_KIND_LABEL = "未分类";

/**
 * K2（N1）：类型计数聚合——每个主值按 assetKindMatches 计（别名/子类上卷命中），
 * 词表外/空白 kind（assetKindGroupValue=null）计入 UNCATEGORIZED_KIND。
 * 横条 pill、树状分组头部、大类簇视图共用这一份口径，不许各页面自算。
 */
export function countAssetsByKind(items: ReadonlyArray<Pick<Asset, "asset_kind">>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const asset of items) {
    for (const option of ASSET_KIND_OPTIONS) {
      if (assetKindMatches(asset.asset_kind, option.value)) counts.set(option.value, (counts.get(option.value) ?? 0) + 1);
    }
    if (assetKindGroupValue(asset.asset_kind) === null) {
      counts.set(UNCATEGORIZED_KIND, (counts.get(UNCATEGORIZED_KIND) ?? 0) + 1);
    }
  }
  return counts;
}

/** 服务端分页响应的原始 kind→count 聚合成与卡片计数相同的主值/别名口径。 */
export function countRawAssetKinds(rawCounts: Readonly<Record<string, number>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [kind, rawCount] of Object.entries(rawCounts)) {
    const value = Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 0;
    if (value === 0) continue;
    for (const option of ASSET_KIND_OPTIONS) {
      if (assetKindMatches(kind, option.value)) {
        counts.set(option.value, (counts.get(option.value) ?? 0) + value);
      }
    }
    if (assetKindGroupValue(kind) === null) {
      counts.set(UNCATEGORIZED_KIND, (counts.get(UNCATEGORIZED_KIND) ?? 0) + value);
    }
  }
  return counts;
}

/** K2（N1）横条三簇视图：一簇 = 大类小标签 + 类内 pill（零计数折叠后）。 */
export interface AssetKindClusterView {
  category: AssetKindCategory;
  label: string;
  /** 首层可见的类内 pill：零计数折叠后剩余；选中中的类型始终可见（不被折叠吞掉）。 */
  visibleOptions: ReadonlyArray<AssetKindOption>;
  /** 本簇被折叠的零计数类型数（「展开其余 N 类」的 N），按簇独立。 */
  hiddenCount: number;
}

/**
 * K2（N1）：资产中心横条从 13 枚平铺改为单行三簇——与 select 消费同一份
 * ASSET_KIND_GROUPS（横条不许再从 ASSET_KIND_OPTIONS 平铺自排）。
 * 零计数折叠与「展开其余 N 类」收纳按簇生效：expanded 里有的簇整簇展开，
 * 其余簇只摆有计数或选中中的 pill。计数口径不变（countAssetsByKind 的全量计数），
 * 三簇只是把同一批计数分组展示。
 */
export function assetKindClusterViews(
  counts: ReadonlyMap<string, number>,
  selected: string,
  expanded: ReadonlySet<AssetKindCategory>,
): AssetKindClusterView[] {
  return ASSET_KIND_GROUPS.map((group) => {
    const visibleOptions = expanded.has(group.category)
      ? group.options
      : group.options.filter((option) => (counts.get(option.value) ?? 0) > 0 || option.value === selected);
    return {
      category: group.category,
      label: group.label,
      visibleOptions,
      hiddenCount: group.options.length - visibleOptions.length,
    };
  });
}

/**
 * 类型筛选匹配：空串 = 全部；UNCATEGORIZED_KIND = 词表外/空白值；主值精确命中或别名命中
 * （clothing→服装、other→参考、keyframe→关键帧）；
 * S88 子类上卷：选「角色」同时命中 animal（动物是角色的子类），选「动物」只命中动物。
 * S88b：大小写归一——后端写入只做 trim、不强制小写（routes.ts asset_kind 口径），
 * 「Animal」这类值筛选时不应漏命中。
 */
export function assetKindMatches(assetKind: string | null | undefined, optionValue: string): boolean {
  if (!optionValue) return true;
  if (optionValue === UNCATEGORIZED_KIND) return assetKindGroupValue(assetKind) === null;
  const kind = (assetKind ?? "").trim().toLowerCase();
  if (kind === optionValue) return true;
  const option = ASSET_KIND_OPTIONS.find((item) => item.value === optionValue);
  if (option?.aliases.includes(kind)) return true;
  const owner = ASSET_KIND_OPTIONS.find((item) => item.value === kind || item.aliases.includes(kind));
  return Boolean(owner?.parent && owner.parent === optionValue);
}

/**
 * 类型的唯一归属主值（S88 树状/分组陈列口径）：别名归主值（clothing→costume），
 * 子类归自己（animal→animal，展示「角色·动物」），未知值 null。
 * 与 assetKindMatches 的上卷不同——陈列时一件资产只出现在一个组里，不重复占位。
 * S88b：大小写归一（同 assetKindMatches 的理由）。
 */
export function assetKindGroupValue(assetKind: string | null | undefined): string | null {
  const kind = (assetKind ?? "").trim().toLowerCase();
  if (!kind) return null;
  const hit = ASSET_KIND_OPTIONS.find((item) => item.value === kind || item.aliases.includes(kind));
  return hit?.value ?? null;
}

/**
 * S88：全站资产类型选择器的分组选项（原生 <select> 的 <optgroup> 三分组）。
 * 放在本 CSS-free 文件而非 asset-widgets：promote-asset-modal 等消费者与 node:test
 * 渲染断言都要求整条 import 链不引 CSS；所有选择器统一消费本组件，禁各写一份。
 */
export function AssetKindSelectOptions(): React.JSX.Element {
  return (
    <>
      {ASSET_KIND_GROUPS.map((group) => (
        <optgroup key={group.category} label={group.label}>
          {group.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </optgroup>
      ))}
    </>
  );
}

/**
 * S46 C-1：资产「名称」（name，AI 抽取的简短名）与「展示名」（display_name，卡片所見）
 * 是两个字段；生成弹窗标题用展示名与卡片对齐后，名称不同才把名称标注出来，
 * 相同或名称为空返回空串（不标注，避免重复信息）。
 */
export function assetRawNameNote(asset: Pick<Asset, "name" | "display_name" | "parent_entity_name" | "source_id">): string {
  const raw = (asset.name ?? "").trim();
  return raw && raw !== assetName(asset) ? raw : "";
}

/* ---------- 审核四态说明（任务 3.2 悬浮说明 / 任务 8.2 图例行 tooltip） ---------- */

/** 四态含义人话版：图例与统计行的 title/aria-label 统一从这里取，避免两处文案漂移。 */
export const REVIEW_BUCKET_EXPLAIN: Readonly<Record<AssetReviewBucket, string>> = {
  auto: "自动：新资产默认自动通过，无需人审；制片可事后抽查提审",
  pending: "待审：已送进待审队列，等待审核人裁决；悬停卡片可看审核人",
  approved: "通过：已通过终审，可继续进戏",
  rejected: "拒绝：已被审核人打回并留档；悬停卡片可看拒绝理由，修改后可重新提审",
};

/** 图例行顺序（板02/06 稿：自动审核 → 待审核 → 已通过 → 已拒绝）。 */
export const REVIEW_LEGEND_BUCKETS: readonly AssetReviewBucket[] = ["auto", "pending", "approved", "rejected"];

/** 06 稿图例行尾注。 */
export const REVIEW_LEGEND_NOTE = "待审核悬停看审核人；已拒绝悬停看拒绝理由";

/* ---------- 项目卡闭环统计（任务 3.2：单字黑话 → 完整词 + 悬浮说明） ---------- */

/** 与 pages/batch-generate-drawer 的 LoopCounts 结构对齐（那边是页面模块，这里不反向依赖）。 */
export interface LoopBucketCounts {
  auto: number;
  pending: number;
  approved: number;
  rejected: number;
}

/** 卡片统计行：「自动 0 · 待审 0 · 通过 0 · 拒绝 0」（完整词，不再用 自/待/过/拒 单字）。 */
export function formatLoopCountsLine(counts: LoopBucketCounts): string {
  return `自动 ${counts.auto} · 待审 ${counts.pending} · 通过 ${counts.approved} · 拒绝 ${counts.rejected}`;
}

/** 统计行悬浮说明（DC 拍板：每组都要解释四态含义）。 */
export function loopCountsTooltip(kindLabel: string): string {
  return `${kindLabel}生成闭环四态——自动：新产物默认自动通过，无需人审；待审：已提审，等审核人确认；通过：审核人确认可用；拒绝：被打回，需重做后重新提审`;
}

/* ---------- 性别 / 年龄段过滤（任务 8.4：客户端过滤 Asset.gender / age_value） ---------- */

export const GENDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "male", label: "男" },
  { value: "female", label: "女" },
];

/** 性别归一：后端历史数据中英文混存（male/男、female/女），筛选前统一映射。 */
export function normalizeGender(gender: string | null | undefined): string {
  const value = (gender ?? "").trim().toLowerCase();
  if (["male", "m", "男", "man"].includes(value)) return "male";
  if (["female", "f", "女", "woman"].includes(value)) return "female";
  return value;
}

/** 性别筛选：空串 = 全部；资产未填性别时不命中任何已选性别（诚实过滤，不猜）。 */
export function genderMatches(gender: string | null | undefined, filter: string): boolean {
  if (!filter) return true;
  return normalizeGender(gender) === filter;
}

export interface AgeBandOption {
  value: string;
  label: string;
  /** 含下界。 */
  min: number;
  /** 含上界。 */
  max: number;
}

export const AGE_BAND_OPTIONS: readonly AgeBandOption[] = [
  { value: "child", label: "儿童", min: 0, max: 12 },
  { value: "teen", label: "少年", min: 13, max: 17 },
  { value: "youth", label: "青年", min: 18, max: 35 },
  { value: "middle", label: "中年", min: 36, max: 55 },
  { value: "senior", label: "老年", min: 56, max: 200 },
];

/** 年龄段筛选：空串 = 全部；资产未填年龄时不命中任何已选段（与性别同原则）。 */
export function ageBandMatches(ageValue: number | null | undefined, bandValue: string): boolean {
  if (!bandValue) return true;
  if (typeof ageValue !== "number" || !Number.isFinite(ageValue)) return false;
  const band = AGE_BAND_OPTIONS.find((item) => item.value === bandValue);
  if (!band) return false;
  return ageValue >= band.min && ageValue <= band.max;
}

/* ---------- 名称/描述/Tag 过滤（任务 8.4 / 4.4） ---------- */

/** 名称/描述搜索：命中 name、display_name、intro、description 任一（大小写不敏感）。 */
export function assetTextMatches(asset: Asset, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [asset.name, asset.display_name, asset.intro, asset.description]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Tag 过滤：style_tags 任一包含输入片段即命中（支持逗号分隔多 tag 同时命中）。 */
export function assetTagMatches(asset: Asset, tagQuery: string): boolean {
  const needles = tagQuery.split(/[,，]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (needles.length === 0) return true;
  const tags = (asset.style_tags ?? []).map((tag) => tag.toLowerCase());
  return needles.every((needle) => tags.some((tag) => tag.includes(needle)));
}

/* ---------- Tag 建议（bug6：「输入/选择 Tag」的「选择」补齐——过滤本就正常，缺的是建议下拉） ---------- */

/** 建议条数上限：下拉一屏至多 8 条，再多就是噪音。 */
export const TAG_SUGGESTION_LIMIT = 8;

/**
 * 全量 tag 收集：所有资产 style_tags 去重（大小写不敏感，保留首见写法），按中文排序。
 * 建议源必须是未过滤的全量资产——拿筛过的列表算建议，会越筛越少直到下拉空了。
 */
export function collectAssetTags(assets: readonly Asset[]): string[] {
  const seen = new Map<string, string>();
  for (const asset of assets) {
    for (const raw of asset.style_tags ?? []) {
      const tag = raw.trim();
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

/** 当前编辑段 = 最后一个中/英文逗号后的片段（与 assetTagMatches 的多 tag 口径一致）。 */
export function tagEditingFragment(query: string): string {
  const segments = query.split(/[,，]/);
  return (segments[segments.length - 1] ?? "").trim();
}

/** 选中建议 = 替换当前编辑段，前面已确认的段原样保留（已确认段不会出现在建议里，天然不会重复）。 */
export function applyTagSuggestion(query: string, suggestion: string): string {
  const segments = query.split(/[,，]/).map((segment) => segment.trim());
  segments[segments.length - 1] = suggestion;
  return segments.filter(Boolean).join(",");
}

/**
 * 建议过滤：编辑段大小写不敏感包含匹配；编辑段之前已确认的完整 tag 不再建议；
 * 空编辑段（刚聚焦/刚敲逗号）给全量前 limit 条。
 */
export function tagSuggestionsFor(tags: readonly string[], query: string, limit: number = TAG_SUGGESTION_LIMIT): string[] {
  const segments = query.split(/[,，]/);
  const committed = new Set(
    segments.slice(0, -1).map((segment) => segment.trim().toLowerCase()).filter(Boolean),
  );
  const fragment = (segments[segments.length - 1] ?? "").trim().toLowerCase();
  const matched = tags.filter((tag) => {
    const lower = tag.toLowerCase();
    if (committed.has(lower)) return false;
    return fragment === "" || lower.includes(fragment);
  });
  return matched.slice(0, Math.max(0, limit));
}

/* ---------- 卡片副标题（任务 8.5：男主 / 26岁 / 江湖侠客 式定位行） ---------- */

/**
 * 定位行 = 角色定位（metadata.category 或首个风格标签）+ 年龄 + 其余标签（至多两个）。
 * 全缺时返回空串，调用方回退到类型 label，不虚构定位。
 */
export function assetPositionLine(asset: Asset): string {
  const meta = asset.metadata;
  const category = isRecord(meta) && typeof meta.category === "string" ? meta.category.trim() : "";
  const tags = (asset.style_tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const role = category || tags[0] || "";
  const parts: string[] = [];
  if (role) parts.push(role);
  if (typeof asset.age_value === "number" && Number.isFinite(asset.age_value)) parts.push(`${asset.age_value}岁`);
  for (const tag of tags.filter((item) => item !== role).slice(0, 2)) parts.push(tag);
  return parts.join(" / ");
}

/* ---------- 版本摘要（任务 8.5：N 张图 · N 个变体 · N 待审核） ---------- */

export interface AssetVersionSummary {
  /** 图片媒体版本数（media_kind 缺省按图片计，与列表页缩略口径一致）。 */
  images: number;
  /** 变体组数：按 asset_variant_id 分组，实体级（默认造型）算一组。 */
  variants: number;
  /** 待审核版本数：draft / pending / pending_review / needs_review。 */
  pending: number;
}

const PENDING_VERSION_STATUSES = new Set(["draft", "pending", "pending_review", "needs_review"]);

export function summarizeAssetVersions(versions: readonly MediaVersion[]): AssetVersionSummary {
  const variantIds = new Set<string>();
  let images = 0;
  let pending = 0;
  for (const version of versions) {
    if (!version.media_kind || version.media_kind === "image") images += 1;
    variantIds.add(version.asset_variant_id ?? "");
    if (PENDING_VERSION_STATUSES.has((version.status ?? "").trim().toLowerCase())) pending += 1;
  }
  return { images, variants: versions.length === 0 ? 0 : variantIds.size, pending };
}

/** 卡片底部摘要行：「6 张图 · 3 个变体 · 1 待审核」。 */
export function formatAssetCardSummary(summary: AssetVersionSummary): string {
  return `${summary.images} 张图 · ${summary.variants} 个变体 · ${summary.pending} 待审核`;
}

/* ---------- 导入个人资产（任务 4.2：接口未接通时的人话降级） ---------- */

/**
 * Sol 侧后端接口（POST /assets/:id/import-personal）仍在开发；
 * 404/501/网络错（status 0 = 服务不可达，联调期等价于未接通）统一降级为这句人话，
 * 禁止假装成功。
 */
export const IMPORT_PERSONAL_PENDING_MESSAGE = "导入个人资产暂不可用，请稍后再试";

/** 导入失败文案：接口未接通 → 降级人话；其余错误透传服务端原文（真失败要看得见）。 */
export function importPersonalFailureMessage(error: unknown): string {
  if (error instanceof ApiClientError && (error.status === 404 || error.status === 501 || error.status === 0)) {
    return IMPORT_PERSONAL_PENDING_MESSAGE;
  }
  return businessErrorMessage(error, "导入失败，请重试");
}

/* ---------- S17-B：新建人设/资产的类型→职责映射与韧性入库 ---------- */

/** 类型→职责（role）映射：新建人设/角色类资产建档时一并写入职责，参考栏自动分桶才有准头。 */
export const KIND_TO_ROLE: Readonly<Record<string, string>> = {
  character: "character_identity",
  scene: "scene",
  prop: "prop",
  lighting: "style_env",
  camera: "camera_storyboard",
};

export function roleForAssetKind(kind: string): string | undefined {
  return KIND_TO_ROLE[(kind ?? "").trim()];
}

/**
 * 韧性入库（DC「新建人设有问题」根因的客户端侧处置）：
 * 后端入库是「先提交、后补搜索索引」——索引失败（embedding 未配置）时接口报 500
 * 但资产已经建成（S17 实证：500 后库里查得到）。直接报错=假失败+用户重试建重。
 * 处置：报错前按名称回查个人库，查到=已建（索引稍后自动补，如实告知）；
 * 查不到才是真知败。后端索引改 fail-open/异步已报 Fable（本方不动后端）。
 * 返回 assetId（入库响应或回查命中）与 indexed（索引是否同步成功）。
 */
export async function ingestAssetVerified(
  item: { asset_kind: string; name: string; display_name?: string | null; intro?: string | null; style_tags?: string[]; role?: string | null },
  input: {
    ingest: (items: readonly typeof item[]) => Promise<{ items: Array<{ id?: string }> }>;
    lookup: () => Promise<Asset[]>;
  },
): Promise<{ assetId: string | null; indexed: boolean }> {
  try {
    const result = await input.ingest([item]);
    return { assetId: result.items[0]?.id ?? null, indexed: true };
  } catch (reason) {
    const candidates = await input.lookup().catch(() => [] as Asset[]);
    const hit = candidates.find((asset) => (asset.name || asset.display_name || "") === item.name);
    if (hit) return { assetId: hit.id, indexed: false };
    throw reason;
  }
}

/** 引用到项目成功 toast：项目名没带书名号时补上（demo 项目名自带《》）。 */
export function referencedToProjectMessage(projectName: string): string {
  const trimmed = projectName.trim();
  const titled = trimmed.startsWith("《") ? trimmed : `《${trimmed}》`;
  return `已引用到${titled}`;
}

/**
 * 资产没有图片媒体版本时禁止提交引用（任务 4.2）。
 * 3D 素模（glb）与声效资产没有图片版本：后端 addProjectAsset 要求图片媒体
 * （无媒体时报 asset_media_required），前端提前明示，不把请求打出去再失败。
 */
export const NO_IMAGE_MEDIA_MESSAGE = "该资产暂无可引用图片版本";

/** 可引用的图片版本：is_primary 优先，其次列表首个图片版本；无图片版本返回 null。 */
export function primaryImageVersion(versions: readonly MediaVersion[]): MediaVersion | null {
  const images = versions.filter((version) => !version.media_kind || version.media_kind === "image");
  return images.find((version) => version.is_primary) ?? images[0] ?? null;
}

/**
 * 资产中心详情的临时预览只认当前返回的媒体版本。
 * 弹窗关闭或切换资产后 selectedId 会清空；若列表变化导致 id 不存在，也回到资产主图，
 * 不把过期 URL 留在主预览区。
 */
export function assetDetailPreviewVersion(
  versions: readonly MediaVersion[],
  selectedId: string,
): MediaVersion | null {
  if (!selectedId) return null;
  return versions.find((version) => version.id === selectedId) ?? null;
}

/* ---------- 声效类能力缺口（菜单项一律禁用置灰，plain 文案，不做可点假象） ---------- */

export const SOUND_GENERATE_MESSAGE = "声效生成预计 v0.1.2 上线";
export const SOUND_UPLOAD_MESSAGE = "声效上传预计 v0.1.2 上线";

/* ---------- 项目资产「更多」菜单（任务 8.3，对照 06 稿） ---------- */

export type ProjectAssetMenuAction = "create" | "sound-generate" | "sound-upload" | "refresh" | "download-all";

export interface ProjectAssetMenuItem {
  id: string;
  label: string;
  action: ProjectAssetMenuAction;
  /** action=create 时预填的 asset_kind（接现有新建资产弹窗）。 */
  kind?: string;
}

export const PROJECT_ASSET_MENU_ITEMS: readonly ProjectAssetMenuItem[] = [
  { id: "create-character", label: "创建角色", action: "create", kind: "character" },
  { id: "create-scene", label: "创建场景", action: "create", kind: "scene" },
  { id: "create-prop", label: "创建道具", action: "create", kind: "prop" },
  { id: "create-costume", label: "创建服装", action: "create", kind: "costume" },
  { id: "create-lighting", label: "创建光线参考", action: "create", kind: "lighting" },
  { id: "create-camera", label: "创建摄影参考", action: "create", kind: "camera" },
  { id: "create-video", label: "创建视频参考", action: "create", kind: "video" },
  { id: "sound-generate", label: "生成声效参考", action: "sound-generate" },
  { id: "sound-upload", label: "上传声效参考", action: "sound-upload" },
  { id: "refresh", label: "刷新", action: "refresh" },
  { id: "download-all", label: "一键下载图片", action: "download-all" },
];

/** 一键下载的提示：浏览器对连续多文件下载有限制（需用户允许），先打预防针。 */
export const DOWNLOAD_ALL_LIMIT_NOTE = "浏览器可能拦截连续多文件下载，如被拦截请在地址栏允许后重试";

/* ---------- 资产库全量拉取与分页（W8：通用库 779 件超后端单拉 500 上限） ---------- */

/**
 * 全量拉取的类型清单：主值 + 别名（clothing/keyframe/other 等历史值独立成行，
 * 后端按 asset_kind 精确匹配，只拉主值会漏别名行）。
 * 后端 /assets 单次上限 500，默认视图一拉必截断（真实通用库 779 件）；
 * 按类型分拉合并是该上限下的诚实全量口径（每类真实量级 <500），与导演台
 * fetchDirector3dAssets 三拉合并同一修法。根治要后端 limit/offset/total（Sol 侧），
 * 在此之前本清单与 ASSET_KIND_OPTIONS 同源，新增类型只改 ASSET_KIND_DEFS。
 */
export const ASSET_KIND_FETCH_VALUES: readonly string[] = [...new Set(
  ASSET_KIND_OPTIONS.flatMap((option) => [option.value, ...option.aliases]),
)];

/**
 * 旧 fixture / 离线数据的防御性合并：按 id 去重并保留首次出现顺序。
 * 产品排序属于服务端 browse-v1 合同，本地辅助函数不得复制或冻结排序语义。
 */
export function mergeAssetItems(lists: ReadonlyArray<readonly Asset[]>): Asset[] {
  const byId = new Map<string, Asset>();
  for (const items of lists) {
    for (const asset of items) {
      if (!byId.has(asset.id)) byId.set(asset.id, asset);
    }
  }
  return [...byId.values()];
}

/** 资产库分页页大小：网格约 4-5 列，24 约 5 行一屏，首屏不压滚动。 */
export const ASSET_LIBRARY_PAGE_SIZE = 24;

/** 总页数：空列表也算 1 页（分页器在 ≤1 页时整体隐藏，这里只保数学口径）。 */
export function pageCount(totalItems: number, pageSize: number = ASSET_LIBRARY_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(totalItems / pageSize));
}

/**
 * Return the last valid page only when a server-side filter made the requested
 * URL page impossible. Callers use the target to replace the URL and refetch;
 * merely clamping the rendered pager would leave the current response empty.
 */
export function outOfRangePageTarget(
  requestedPage: number,
  filteredTotal: number,
  pageSize: number = ASSET_LIBRARY_PAGE_SIZE,
): number | null {
  const lastPage = pageCount(filteredTotal, pageSize);
  return requestedPage > lastPage ? lastPage : null;
}

/** 当前页切片；page 越界由调用方先夹取（列表缩水上限 pageCount）。 */
export function paginateItems<T>(items: readonly T[], page: number, pageSize: number = ASSET_LIBRARY_PAGE_SIZE): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize);
}

/**
 * 页码窗口：总页数 ≤7 全展示；否则首尾锚定 + 当前页左右各一格，缺口用 "…" 占位。
 * 渲染侧把 "…" 画成禁用占位，不可点。
 */
export function paginationWindow(current: number, total: number): ReadonlyArray<number | "…"> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const anchors = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = [...anchors].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
  const windowed: Array<number | "…"> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous && page - previous > 1) windowed.push("…");
    windowed.push(page);
    previous = page;
  }
  return windowed;
}
