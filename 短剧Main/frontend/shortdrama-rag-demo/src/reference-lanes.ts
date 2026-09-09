/* ============================================================
   reference-lanes.ts — 工作台「参考清单」逻辑层（纯逻辑，不引 CSS/DOM）

   S15-B（R9 创作词表不冻结）：参考栏定义不再 hardcode 在本文件——
   词条=词表数据（lane-vocabulary.ts，loadLaneVocabulary 唯一取数口；
   接口好后换实现一行，本文件零改）。本文件只剩视图层逻辑
   （分桶/挂接/持久化/完备度），新词条自动生效。
   历史口径：
   - 原六组参考（角色/场景/道具/运镜/参考视频/音频）= context 仓
     docs/specs/spec-set-package-reference-lanes-v1-2026-07-08.md 的 lane 结构
     （S14 起光影独立成组，三域=实体/风格/媒介）；
   - 四个功能页（图片/视频/音频/3D 导演台）是一级页签，与工作台双通路：
     从参考清单每组可一键跳转，功能页产出自动归入对应组；
   - 完备度提示是提示性质，不阻塞任何生成按钮（Dario 拍板：「就绪」是人工判断）。

   数据纪律（Fable 合同①②就位前的原型口径）：
   - 资产侧条目永远从项目资产实时分桶（role/kind → 六组），不落地副本；
   - 生成产出条目与运镜文字描述只存 localStorage（按粗剪素材 id 键控），
     合同 API 就位后整体换源，UI 不改动；
   - 不自造控制包实体：本文件只有视图层 lane 状态，字段对齐 spec §7 的
     lane / asset_id / source_scope 语义，便于届时平移。
   ============================================================ */

import type { Asset, ProjectAssetRef } from "./types";
import type { ColorCardEntry } from "./color-card-vocabulary";
import { laneEntries, laneEntry, laneDomains, laneIdForAssetKind, type LaneDomainId, type LaneVocabularyEntry } from "./lane-vocabulary";

/** 功能页四类：图片 / 视频 / 3D 导演台 / 音频。 */
export type WorkshopId = "image" | "video" | "director" | "audio";

/** 系统建议要素（预置）：required=false 的是增强项，缺了只在提示里列出。 */
export interface LaneRecommendedElement {
  key: string;
  label: string;
  required: boolean;
}

/**
 * 参考组视图形状（=词表词条的呈现投影；字段来自 lane-vocabulary 词条）。
 * 兼容旧 ReferenceLaneDef 消费方（laneCompleteness/LaneCard）。
 */
export interface ReferenceLaneDef {
  id: string;
  label: string;
  /** 图标 key（iconKey→组件映射在 reference-lanes.tsx；未知 key 走默认图标，新词条不炸 UI）。 */
  iconKey: string;
  priority: "P0" | "P1" | "P2" | "P3";
  workshop: WorkshopId;
  recommended: readonly LaneRecommendedElement[];
  emptyHint: string;
  roles: readonly string[];
  kinds: readonly string[];
}

/** 旧字面量联合（新词条会超出它——新代码一律用 string id）。 */
export type ReferenceLaneId = string;

/* ---------- S15-B：参考栏定义=词表数据（lane-vocabulary 快照投影） ---------- */

function entryToDef(entry: LaneVocabularyEntry): ReferenceLaneDef {
  return {
    id: entry.id,
    label: entry.displayName,
    iconKey: entry.iconKey,
    priority: entry.priority,
    workshop: entry.workshop,
    recommended: entry.recommended,
    emptyHint: entry.emptyHint,
    roles: entry.roles,
    kinds: entry.kinds,
  };
}

/** 词表全部 active 参考组（排序=词表 sort）。旧 REFERENCE_LANES 常量消费方改读这里。 */
export function laneDefs(): readonly ReferenceLaneDef[] {
  return laneEntries().map(entryToDef);
}

/**
 * 词表派生数组的兼容壳：get/has/ownKeys/descriptor 全转发到实时计算结果。
 * 只转发 get 会让 filter/map/forEach 等数组方法失真——它们内部用 HasProperty
 * 查索引，没有 has 陷阱时索引检查全落空数组（S9-17 分组测试抓到的实证）。
 */
function liveArray<T>(compute: () => readonly T[]): readonly T[] {
  return new Proxy([] as readonly T[], {
    get: (_target, prop) => (compute() as never)[prop],
    has: (_target, prop) => prop in (compute() as never),
    ownKeys: () => Reflect.ownKeys(compute()),
    getOwnPropertyDescriptor: (_target, prop) => Reflect.getOwnPropertyDescriptor(compute(), prop),
  });
}

/** 旧 REFERENCE_LANES 常量别名（逐步退役；新代码用 laneDefs()）。 */
export const REFERENCE_LANES: readonly ReferenceLaneDef[] = liveArray(laneDefs);

function laneDomainViews(): ReadonlyArray<{ id: LaneDomainId; label: string; lanes: readonly string[] }> {
  return laneDomains().map((domain) => ({ id: domain.id, label: domain.label, lanes: domain.entries.map((entry) => entry.id) }));
}

/** 三域分区（=词表 domains+entries 投影；界面域标题/收纳按此渲染）。 */
export const LANE_DOMAINS: ReadonlyArray<{ id: LaneDomainId; label: string; lanes: readonly string[] }> = liveArray(laneDomainViews);

export function laneDef(id: string): ReferenceLaneDef {
  return entryToDef(laneEntry(id));
}

/** 组内条目（视图层）。origin=asset 的条目来自项目资产实时分桶；origin=workshop 的是功能页生成后归入的产出。 */
export interface LaneItem {
  /** 稳定主键：`asset:<assetId>` / `workshop:<mediaId>` / `note:<lane>`（运镜文字描述）/ `swatch:color_card`（色卡）。 */
  id: string;
  name: string;
  kind: "image" | "video" | "audio" | "text" | "swatch";
  thumbUrl?: string;
  origin: "asset" | "workshop";
  /** 资产来源时的项目资产引用 id（去重/跳转用）。 */
  refId?: string;
  /** GP-14：资产来源时的实体审核态（wire 原值，两套词表都可能：pending/ready 或 pending_review/approved/rejected）。
      实时分桶时带上，不落地副本——审核通过后下次取数自动转默认外观。 */
  assetStatus?: string | null;
  note?: string;
  /** swatch 条目的色值列表（hex/色名，inline 呈现；内容数据不是主题色）。 */
  colors?: readonly string[];
}

export type LanesState = Record<string, LaneItem[]>;

/** 空清单（参考组=词表 active 词条，顺序=词表 sort；新词条自动有位）。 */
export function emptyLanesState(): LanesState {
  const state: LanesState = {};
  for (const lane of laneDefs()) state[lane.id] = [];
  return state;
}

function refEntity(ref: ProjectAssetRef): Asset {
  return ref.asset ?? ref.snapshot ?? ref.version_snapshot?.entity ?? { id: ref.asset_entity_id || ref.asset_id || ref.id };
}

function laneForAsset(asset: Asset): string | null {
  /* role 优先:roles 无族表,精确命中即入栏(唯一 roles 消费点)。 */
  const role = asset.role ?? "";
  if (role) {
    for (const lane of laneDefs()) {
      if (lane.roles.includes(role)) return lane.id;
    }
  }
  /* kind 兜底:走族表子类闭包(laneIdForAssetKind,栏位匹配唯一判定)——
     animal 沿 parent=character 落角色栏;落不了栏如实 null。 */
  const kind = (asset.asset_kind ?? "").toLowerCase();
  if (kind) return laneIdForAssetKind(kind);
  return null;
}

function itemKindForAsset(asset: Asset, lane: string): LaneItem["kind"] {
  if (lane === "audio") return "audio";
  if (lane === "reference_video") return "video";
  const kind = (asset.asset_kind ?? "").toLowerCase();
  if (["sound", "audio", "music"].includes(kind)) return "audio";
  return "image";
}

/** 资产 → 六组分桶（实时计算，不落地；role 优先、kind 兜底走族表子类闭包）。 */
export function seedLanesFromRefs(refs: readonly ProjectAssetRef[]): LanesState {
  const state = emptyLanesState();
  for (const ref of refs) {
    const asset = refEntity(ref);
    const lane = laneForAsset(asset);
    if (!lane) continue;
    const assetId = asset.id || ref.asset_entity_id || ref.asset_id || ref.id;
    (state[lane] ??= []).push({
      id: `asset:${assetId}`,
      name: asset.display_name || asset.name || "未命名资产",
      kind: itemKindForAsset(asset, lane),
      thumbUrl: asset.thumbnail_url || asset.storage_url || undefined,
      origin: "asset",
      refId: ref.id,
      assetStatus: asset.status ?? null,
      note: asset.role === "style_env" ? "风格环境" : undefined,
    });
  }
  return state;
}

/** 生成产出归入某组（按 id 去重，返回新 state）。 */
export function attachLaneItem(state: LanesState, lane: ReferenceLaneId, item: LaneItem): LanesState {
  const items = state[lane] ?? [];
  if (items.some((existing) => existing.id === item.id)) return state;
  return { ...state, [lane]: [...items, item] };
}

/** 移除条目（仅 workshop 产出可移除；资产条目请走项目资产管理）。 */
export function detachLaneItem(state: LanesState, lane: ReferenceLaneId, itemId: string): LanesState {
  const items = state[lane] ?? [];
  const target = items.find((item) => item.id === itemId);
  if (!target || target.origin !== "workshop") return state;
  return { ...state, [lane]: items.filter((item) => item.id !== itemId) };
}

/** 运镜组文字描述：有 note 条目视为已满足；写在 items 里（kind=text, id=note:camera_motion）。 */
export function upsertCameraNote(state: LanesState, text: string): LanesState {
  const trimmed = text.trim();
  const without = (state.camera_motion ?? []).filter((item) => item.id !== "note:camera_motion");
  if (!trimmed) return { ...state, camera_motion: without };
  return {
    ...state,
    camera_motion: [{ id: "note:camera_motion", name: trimmed, kind: "text", origin: "workshop" }, ...without],
  };
}

/**
 * 色卡组挂接（K2，与 upsertCameraNote 同模式）：一套全剧只挂一条——固定 id
 * upsert，再选即替换；摘除走通用 detachLaneItem（origin=workshop）。
 * 色卡不进提交参考集：swatch 是非媒体条目，controlPackReferences 解不出
 * mediaId 自然跳过（v1 色卡=挂在那里的全剧影调锚，不注入生成）。
 */
export function upsertColorCard(state: LanesState, entry: ColorCardEntry): LanesState {
  const without = (state.color_card ?? []).filter((item) => item.id !== "swatch:color_card");
  return {
    ...state,
    color_card: [
      {
        id: "swatch:color_card",
        name: entry.name,
        kind: "swatch",
        origin: "workshop",
        colors: [entry.primaryHex, entry.secondaryHex],
        note: entry.directorUse || undefined,
      },
      ...without,
    ],
  };
}

export interface LaneCompleteness {
  /** 已满足的推荐要素 key。 */
  satisfied: readonly string[];
  /** 缺失的必备要素 label。 */
  missingRequired: readonly string[];
  /** 缺失的增强要素 label。 */
  missingOptional: readonly string[];
}

/** 完备度判定：有任一条目即视为该组到位（原型口径；精细判据等合同①）。 */
export function laneCompleteness(def: ReferenceLaneDef, items: readonly LaneItem[]): LaneCompleteness {
  const has = items.length > 0;
  const satisfied = has ? def.recommended.map((element) => element.key) : [];
  const missingRequired = has ? [] : def.recommended.filter((element) => element.required).map((element) => element.label);
  const missingOptional = has ? [] : def.recommended.filter((element) => !element.required).map((element) => element.label);
  return { satisfied, missingRequired, missingOptional };
}


/* ---------- 原型持久化：只存生成归入的条目，资产条目永远实时分桶 ---------- */

/* v2：lane 枚举对齐合同①（character/scene/prop/camera_motion/reference_video/audio），
   v1 旧键直接废弃（原型期数据可丢）。 */
const STORAGE_PREFIX = "shortdrama_lanes_v2:";

interface StoredLanesPayload {
  workshopItems: Partial<Record<ReferenceLaneId, LaneItem[]>>;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** 合并实时分桶与本机归入记录（生成条目按 id 去重追加）。 */
export function mergeLanesState(seeded: LanesState, stored: StoredLanesPayload | null): LanesState {
  if (!stored) return seeded;
  const merged = { ...seeded };
  for (const lane of REFERENCE_LANES) {
    const seededItems = seeded[lane.id] ?? [];
    const extras = (stored.workshopItems[lane.id] ?? []).filter(
      (item) => item && item.origin === "workshop" && !seededItems.some((existing) => existing.id === item.id),
    );
    merged[lane.id] = [...seededItems, ...extras];
  }
  return merged;
}

export function loadLanesState(storage: StorageLike, shotId: string, seeded: LanesState): LanesState {
  try {
    const raw = storage.getItem(`${STORAGE_PREFIX}${shotId}`);
    if (!raw) return seeded;
    const parsed = JSON.parse(raw) as StoredLanesPayload;
    if (!parsed || typeof parsed !== "object" || typeof parsed.workshopItems !== "object" || !parsed.workshopItems) return seeded;
    return mergeLanesState(seeded, parsed);
  } catch {
    return seeded;
  }
}

/** 只持久化生成归入的条目（资产条目实时分桶，落地副本会过期）。 */
export function saveLanesState(storage: StorageLike, shotId: string, state: LanesState): void {
  const workshopItems: StoredLanesPayload["workshopItems"] = {};
  for (const lane of REFERENCE_LANES) {
    const items = (state[lane.id] ?? []).filter((item) => item.origin === "workshop");
    if (items.length > 0) workshopItems[lane.id] = items;
  }
  try {
    storage.setItem(`${STORAGE_PREFIX}${shotId}`, JSON.stringify({ workshopItems }));
  } catch {
    /* 存储满/私密模式下静默降级：本条粗剪素材的挂回仅本次会话可见 */
  }
}
