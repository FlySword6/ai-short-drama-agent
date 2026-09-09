/**
 * 3D 导演台 · 资产库 3D 资产纯逻辑（W5.5 · 资产面板数据层）
 *
 * 不碰 React / three / DOM，node:test 直接 import（见 assets-library.test.ts）。
 * - DIRECTOR_ASSET_KINDS：可入台的资产类目（后端 directorManifestImport 的分类映射：
 *   human→character；city-commercial/city-roads/city-suburban/interior/street→scene；
 *   door/food/furniture/lamp/plant/prop/vehicle/window→prop；clothing→clothing；
 *   reference→other）。
 * - assetGlbUrl / isDirector3dAsset：3D 过滤（GLB 媒体直链 + 类目白名单）。
 * - groupAssetsByKind / filterAssetsByQuery：分组与搜索（客户端，519 条量级足够）。
 * - BUILTIN_ASSETS：内置 fixture（manifest 实物各挑 1 件小体积 GLB，TOS 公开读直链）——
 *   资产接口 404/501（未接后端）时降级展示、demoMode 离线演示时充当示例数据。
 * - assetDisplayName：内置资产先查中文映射（asset-display-names.ts，P1-10），
 *   再回落 name / display_name / intro；原始英文名保留在 asset.name 供 title 回显。
 */
import type { Asset } from "../../types";

import { BUILTIN_ASSET_DISPLAY_NAMES } from "./asset-display-names";

/** 可入台资产类目（固定顺序即分组顺序） */
export const DIRECTOR_ASSET_KINDS = ["character", "scene", "prop", "clothing", "other"] as const;

export type DirectorAssetKind = (typeof DIRECTOR_ASSET_KINDS)[number];

/** 分组标签（组头展示：角色/场景/道具/服装/参考） */
export const ASSET_KIND_LABELS: Record<DirectorAssetKind, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  clothing: "服装",
  other: "参考",
};

const GLB_URL_PATTERN = /\.glb($|[?#])/i;

/**
 * 取资产的 GLB 直链：优先媒体字段（format=glb 或 media_kind=model_3d，selected 先于
 * current），兜底 .glb 结尾的 storage_url；都不是 3D 资产返回 null。
 */
export function assetGlbUrl(asset: Asset): string | null {
  for (const media of [asset.selected_media, asset.current_media]) {
    if (!media?.storage_url) continue;
    if (media.format?.toLowerCase() === "glb" || media.media_kind === "model_3d") {
      return media.storage_url;
    }
  }
  const direct = asset.storage_url;
  return direct && GLB_URL_PATTERN.test(direct) ? direct : null;
}

/** 3D 资产判定：类目在白名单内且有 GLB 直链 */
export function isDirector3dAsset(asset: Asset): boolean {
  if (!asset.asset_kind) return false;
  if (!(DIRECTOR_ASSET_KINDS as readonly string[]).includes(asset.asset_kind)) return false;
  return assetGlbUrl(asset) !== null;
}

/** W7-C：3D 资产拉取分这三类（prop/scene/character，后端各自均 <500 上限）。 */
export const DIRECTOR_FETCH_KINDS = ["prop", "scene", "character"] as const;

export interface DirectorAssetFetchResult {
  /** 合并去重 + 3D 过滤后的可见资产 */
  assets: Asset[];
  /** 各 kind 后端返回的原始条数（「三类计数合计=可见总数」验收锚点） */
  counts: Record<string, number>;
}

/**
 * 按类目分批拉取并合并（W7-C）。
 * 背景：资产列表 API 单次 500 上限截断，一次拉全部时排序靠前的云 2D 资产挤占名额
 * （导演台一度只见 432/519）；按 asset_kind 分三次拉取后合并即齐。
 * fetchKind 注入以便测试（生产传 api.assets）。
 */
export async function fetchDirector3dAssets(
  fetchKind: (kind: string) => Promise<{ items: Asset[]; count: number }>,
): Promise<DirectorAssetFetchResult> {
  const merged = new Map<string, Asset>();
  const counts: Record<string, number> = {};
  for (const kind of DIRECTOR_FETCH_KINDS) {
    const list = await fetchKind(kind);
    counts[kind] = list.count;
    for (const asset of list.items) merged.set(asset.id, asset);
  }
  return { assets: [...merged.values()].filter(isDirector3dAsset), counts };
}

/** 展示名：内置资产中文映射（P1-10）优先，回落 name → display_name → intro，兜底占位 */
export function assetDisplayName(asset: Asset): string {
  return (
    BUILTIN_ASSET_DISPLAY_NAMES[asset.id] ||
    asset.name?.trim() ||
    asset.display_name?.trim() ||
    asset.intro?.trim() ||
    "未命名资产"
  );
}

export interface AssetGroup {
  kind: DirectorAssetKind;
  label: string;
  items: Asset[];
}

/** 按类目分 5 组（固定顺序；空组保留，组头计数由 UI 展示；白名单外类目不进组） */
export function groupAssetsByKind(assets: Asset[]): AssetGroup[] {
  const buckets = new Map<DirectorAssetKind, Asset[]>(
    DIRECTOR_ASSET_KINDS.map((kind) => [kind, []]),
  );
  for (const asset of assets) {
    const kind = asset.asset_kind as DirectorAssetKind | undefined;
    if (kind) buckets.get(kind)?.push(asset);
  }
  return DIRECTOR_ASSET_KINDS.map((kind) => ({
    kind,
    label: ASSET_KIND_LABELS[kind],
    items: buckets.get(kind) ?? [],
  }));
}

/**
 * 名称过滤：大小写不敏感子串（与对象清单搜索同语义）；空串原样返回。
 * 中文显示名与原始英文名（asset.name）都可命中——内置资产中文化后
 * 仍可按原文件名检索（如「仰望」或「female」都能找到仰望的女性）。
 */
export function filterAssetsByQuery(assets: Asset[], query: string): Asset[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return assets;
  return assets.filter((asset) =>
    [assetDisplayName(asset), asset.name ?? ""].some((text) => text.toLowerCase().includes(keyword)),
  );
}

/** GLB 加载错误 → 人话（ModelGuard 捕获后展示，重试语义不变） */
export function humanModelLoadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/404|not found/i.test(message)) return "模型文件不存在或已下架";
  if (/failed to fetch|networkerror|cors|network/i.test(message)) return "网络异常，模型下载失败";
  if (/parse|invalid|unexpected|json/i.test(message)) return "模型文件损坏，无法解析";
  return "模型加载失败，请重试";
}

/* ──────────────────────────── 内置资产 fixture ────────────────────────────
 * 取自 assets/director/manifest.json 实物（各挑 1 件小体积 GLB，覆盖角色/场景/道具三组）；
 * 仅用于「资产库未连接」降级与 demoMode 示例，不参与生产列表。
 */

const TOS_PUBLIC_BASE = "https://drama-asset.tos-cn-beijing.volces.com";

function builtinAsset(
  id: string,
  assetKind: DirectorAssetKind,
  name: string,
  tosKey: string,
): Asset {
  const storageUrl = `${TOS_PUBLIC_BASE}/${tosKey}`;
  return {
    id: `builtin:${id}`,
    asset_kind: assetKind,
    name,
    storage_url: storageUrl,
    current_media: {
      id: `builtin:${id}:media`,
      media_kind: "model_3d",
      format: "glb",
      storage_url: storageUrl,
    },
  };
}

export const BUILTIN_ASSETS: Asset[] = [
  builtinAsset(
    "quaternius/human/Female_LookingUp",
    "character",
    "Female Looking Up",
    "director-assets/v1/quaternius/human/Female_LookingUp.glb",
  ),
  builtinAsset(
    "kenney/city-commercial/building-a",
    "scene",
    "Building A",
    "director-assets/v1/kenney/city-commercial/building-a.glb",
  ),
  builtinAsset(
    "kenney/furniture/bathroomCabinet",
    "prop",
    "Bathroom Cabinet",
    "director-assets/v1/kenney/furniture/bathroomCabinet.glb",
  ),
  builtinAsset(
    "kenney/vehicle/ambulance",
    "prop",
    "Ambulance",
    "director-assets/v1/kenney/vehicle/ambulance.glb",
  ),
  builtinAsset(
    "quaternius/food/Apple",
    "prop",
    "Apple",
    "director-assets/v1/quaternius/food/Apple.glb",
  ),
];

/**
 * demoMode 检测（与 app.tsx 同一 sessionStorage 键；UI 侧调用，node 环境恒 false）。
 * 放在本模块是为让 AssetsPanel 不反向依赖 app.tsx。
 */
export function isDirectorDemoMode(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.sessionStorage.getItem("shortdrama_v01_demo") === "1"
    );
  } catch {
    return false;
  }
}
