/* ============================================================
   lane-vocabulary.ts — 参考栏词表驱动层（S15-B，R9 创作词表不冻结）

   范式（docs/design/creative-vocabulary-openness.md + platform-ontology R9）：
   参考栏是创作词汇（每周都可能冒新参考物），**词表化为数据**——
   新参考栏=词表一行新增，零迁移零改码。本层是前端唯一取数口：
   - 线上：app 用 loadLaneVocabulary({ fetcher }) 显式接
     GET /api/v1/vocabulary/reference-lanes（S24-C 已接线），词表字段以服务端为准；
   - 兜底：接口失败回落内置八条（=020/023 播种七条 + K2 色卡一条，含
     id/display_name/domain/sort/pickKind/recommended/active + 前端呈现字段）；
   - icon 用 iconKey→组件映射（reference-lanes.tsx），未知 key 给默认图标，
     新词条不炸 UI；
   - 形状对齐 registry 字段：id/display_name/domain[实体 entity·风格 style·媒介 media]/
     sort/active，外加前端呈现域（workshop/recommended/emptyHint/roles/kinds/iconKey）。
   纯逻辑、零 DOM，node:test 直接 import（s15-lane-vocabulary.test.ts）。
   ============================================================ */

import type { LaneRecommendedElement, ReferenceLaneId, WorkshopId } from "./reference-lanes";
import { ASSET_KIND_OPTIONS } from "./components/asset-shared";

/* ---------- 词表形状（registry 字段 + 前端呈现域） ---------- */

export type LaneDomainId = "entity" | "style" | "media";

export interface LaneDomainDef {
  id: LaneDomainId;
  /** 域标题（实体参考/风格参考/媒介参考）。 */
  label: string;
  sort: number;
}

export interface LaneVocabularyEntry {
  id: string;
  /** 展示名（display_name）：角色/场景/道具/光影/运镜/参考视频/音频。 */
  displayName: string;
  domain: LaneDomainId;
  /** 域内排序。 */
  sort: number;
  /** 词表启停（inactive 不上界面不组包）。 */
  active: boolean;
  /** 图标 key（iconKey→组件映射在 reference-lanes.tsx；未知 key 走默认图标）。 */
  iconKey: string;
  /** 「从资产库选」槽位过滤的资产类型（S9-19；020 起入库,空=不限类型）。 */
  pickKind?: string | null;
  /** 功能页归属（入口动作按此给默认）。 */
  workshop: WorkshopId;
  /** spec §6 一致性优先级（P0 永不省略；界面不外显）。 */
  priority: "P0" | "P1" | "P2" | "P3";
  recommended: readonly LaneRecommendedElement[];
  emptyHint: string;
  /** 自动分桶：资产 role 命中即入本栏。 */
  roles: readonly string[];
  /** 自动分桶兜底：无 role 时按 asset_kind 入栏。 */
  kinds: readonly string[];
}

export interface LaneVocabulary {
  /** 词表版本（后端接口就位后由服务端给；内置="builtin-s15"）。 */
  version: string;
  domains: readonly LaneDomainDef[];
  entries: readonly LaneVocabularyEntry[];
}

/* ---------- 内置词表（=S14 七条常量迁为数据 + K2 色卡第八条） ---------- */

export const LANE_DOMAINS_BUILTIN: readonly LaneDomainDef[] = [
  { id: "entity", label: "实体参考", sort: 1 },
  { id: "style", label: "风格参考", sort: 2 },
  { id: "media", label: "媒介参考", sort: 3 },
];

export const BUILTIN_LANE_VOCABULARY: LaneVocabulary = {
  version: "builtin-s15",
  domains: LANE_DOMAINS_BUILTIN,
  entries: [
    {
      id: "character", displayName: "角色", domain: "entity", sort: 1, active: true, iconKey: "user",
      workshop: "image", priority: "P0", pickKind: "character",
      recommended: [
        { key: "identity", label: "每个出场角色锁定 1 张身份定妆图", required: true },
        { key: "ensemble", label: "多角色同框再补 1 张同框比例参考", required: false },
      ],
      emptyHint: "还没有角色参考。去图片页生成定妆图，或从资产库选。",
      /* K2R/GP-15：角色栏只收 character——costume 在 S88 族表(asset-shared
         ASSET_KIND_DEFS)是 entity 顶级类型、非 character 子类(对比 animal
         parent=character),归栏随族表同套口径移道具栏;栏位映射只在本词表
         维护,禁组件层硬编码。
         K2T：kinds 仍只写 character——animal 不另列字符串,靠族表子类闭包
         (animal.parent=character)经 laneIdForAssetKind 自动落本栏。 */
      roles: ["character_identity"], kinds: ["character"],
    },
    {
      id: "scene", displayName: "场景", domain: "entity", sort: 2, active: true, iconKey: "mountains",
      workshop: "director", priority: "P1", pickKind: "scene",
      recommended: [
        { key: "master", label: "场景主视图 1 张（全景空间基准）", required: true },
        { key: "variants", label: "日/夜或气氛差异大时各 1 张", required: false },
      ],
      emptyHint: "还没有场景参考。可以在 3D 导演台搭一个，或从资产库选。",
      /* 条 9 根因修复：场景组只收 scene——lighting/style_env 归「光影」组，
         道具混入场景是资产 asset_kind 标错的存量数据问题（已报 Fable 出清单），不在此兜底。 */
      roles: ["scene"], kinds: ["scene"],
    },
    {
      id: "prop", displayName: "道具", domain: "entity", sort: 3, active: true, iconKey: "package",
      workshop: "image", priority: "P2", pickKind: "prop",
      recommended: [
        { key: "hero", label: "会特写/交互的关键道具 1 张参考图", required: false },
      ],
      emptyHint: "还没有道具参考。本场无关键道具可留空。",
      /* K2R/GP-15：服装(costume)随道具栏——S88 族表里 costume 与 prop 同为
         entity 顶级类型(戏里的物件),不再落角色栏。 */
      roles: ["prop"], kinds: ["prop", "costume"],
    },
    {
      id: "lighting", displayName: "光影", domain: "style", sort: 1, active: true, iconKey: "sun",
      workshop: "image", priority: "P2", pickKind: "lighting",
      recommended: [
        { key: "tone", label: "定 1 张全场影调基准（色卡/光影参考）", required: false },
      ],
      emptyHint: "还没有光影参考。去图片页生成一张影调基准，或从资产库选。",
      roles: ["style_env"], kinds: ["lighting"],
    },
    {
      /* K2 色卡栏（V-17/V-18）：风格域光影之后、运镜之前（运镜 sort 顺移 3）。
         pickKind=null——色卡是内容词表不是资产（color-card-vocabulary.ts）；
         roles/kinds 预留 color_card，未来资产化时自动分桶免改码。 */
      id: "color_card", displayName: "色卡", domain: "style", sort: 2, active: true, iconKey: "palette",
      workshop: "image", priority: "P2", pickKind: null,
      recommended: [
        { key: "palette", label: "定 1 套全剧色调基准", required: false },
      ],
      emptyHint: "还没有色卡。从六套导演调色里选一套，全剧影调就有了锚。",
      roles: ["color_card"], kinds: ["color_card"],
    },
    {
      id: "camera_motion", displayName: "运镜", domain: "style", sort: 3, active: true, iconKey: "video-camera",
      workshop: "director", priority: "P2", pickKind: "camera",
      recommended: [
        { key: "description", label: "在 3D 导演台录一段运镜小样，或写一句机位描述", required: true },
      ],
      emptyHint: "还没有运镜参考。可以在 3D 导演台录一段运镜小样，或写一句机位描述。",
      roles: ["camera_storyboard"], kinds: ["camera"],
    },
    {
      id: "reference_video", displayName: "参考视频", domain: "media", sort: 1, active: true, iconKey: "film-strip",
      workshop: "video", priority: "P3", pickKind: null,
      recommended: [
        { key: "draft", label: "上传真人参考视频，或用文生视频快抽一段动作小样", required: false },
      ],
      emptyHint: "还没有参考视频。可以上传真人参考视频，或用文生视频快抽一段动作小样。",
      roles: ["motion"], kinds: [],
    },
    {
      id: "audio", displayName: "音频", domain: "media", sort: 2, active: true, iconKey: "music-note",
      workshop: "audio", priority: "P3", pickKind: null,
      recommended: [
        { key: "voice", label: "音色/环境音参考", required: false },
      ],
      emptyHint: "还没有音频参考。可后续补。",
      roles: [], kinds: ["sound", "audio", "music"],
    },
  ],
};

/* ---------- 接口词表接线（S24-C：GET /api/v1/vocabulary/reference-lanes 已就位） ---------- */

/** 服务端词条形状（api.ts 已把 snake_case 归一成驼峰）。 */
export interface LaneVocabularyApiEntry {
  id: string;
  displayName: string;
  domain: string;
  pickKind: string | null;
  sort: number;
  active: boolean;
  recommended: LaneRecommendedElement[];
}

const LANE_DOMAIN_IDS: ReadonlySet<string> = new Set(["entity", "style", "media"]);

/**
 * 服务端词表 → 前端词表：词表字段（id/展示名/域/排序/启停/pick_kind/推荐项）
 * 以服务端为准；呈现覆盖层（iconKey/workshop/priority/emptyHint/roles/kinds）
 * 按 id 从内置词条查表（裁决：覆盖层留代码），未知 id 给安全默认，不炸 UI；
 * 域非法的脏行丢弃。
 */
export function laneVocabularyFromApi(entries: readonly LaneVocabularyApiEntry[]): LaneVocabulary {
  const overlay = new Map(BUILTIN_LANE_VOCABULARY.entries.map((entry) => [entry.id, entry]));
  const merged = entries.flatMap((entry): LaneVocabularyEntry[] => {
    if (!LANE_DOMAIN_IDS.has(entry.domain)) return [];
    const base = overlay.get(entry.id);
    return [{
      id: entry.id,
      displayName: entry.displayName,
      domain: entry.domain as LaneDomainId,
      sort: entry.sort,
      active: entry.active,
      pickKind: entry.pickKind,
      iconKey: base?.iconKey ?? "",
      workshop: base?.workshop ?? "image",
      priority: base?.priority ?? "P3",
      recommended: entry.recommended,
      emptyHint: base?.emptyHint ?? `还没有${entry.displayName}参考。可以先留空，后续再补。`,
      roles: base?.roles ?? [],
      kinds: base?.kinds ?? [],
    }];
  });
  return { version: "api", domains: LANE_DOMAINS_BUILTIN, entries: merged };
}

/* ---------- 取数口（默认内置兜底；app 显式传接口 fetcher） ---------- */

/**
 * 默认取数实现：返回内置词表（接口失败时的兜底，displayName/domain/sort/
 * recommended 与 020/023 播种同源）。线上路径由 app 显式传接口 fetcher
 * （api.vocabularyReferenceLanes + laneVocabularyFromApi），组件零改。
 */
async function defaultFetcher(): Promise<LaneVocabulary> {
  return BUILTIN_LANE_VOCABULARY;
}

let snapshot: LaneVocabulary = BUILTIN_LANE_VOCABULARY;

/** 当前词表快照（同步读；未加载过远程时=内置）。 */
export function laneVocabularySnapshot(): LaneVocabulary {
  return snapshot;
}

/**
 * 加载词表并更新快照。fetcher 可注入（测试 mock 远程词表）；
 * 失败回落内置，不炸 UI。返回最终生效的词表。
 */
export async function loadLaneVocabulary(input: { fetcher?: () => Promise<LaneVocabulary> } = {}): Promise<LaneVocabulary> {
  const fetcher = input.fetcher ?? defaultFetcher;
  try {
    snapshot = await fetcher();
  } catch {
    snapshot = BUILTIN_LANE_VOCABULARY;
  }
  return snapshot;
}

/* ---------- 读侧助手（组件唯一入口，不直读常量） ---------- */

function activeEntries(): readonly LaneVocabularyEntry[] {
  return snapshot.entries.filter((entry) => entry.active);
}

/** 按 id 取词条；未知 id 抛错（与旧 laneDef 同语义，调用方先校验）。 */
export function laneEntry(id: string): LaneVocabularyEntry {
  const entry = activeEntries().find((item) => item.id === id);
  if (!entry) throw new Error(`未知参考栏：${id}`);
  return entry;
}

export function hasLane(id: string): boolean {
  return activeEntries().some((item) => item.id === id);
}

/** 词表全部 active 词条（按 domain.sort→sort 排好）。 */
export function laneEntries(): readonly LaneVocabularyEntry[] {
  const domainOrder = new Map(snapshot.domains.map((domain) => [domain.id, domain.sort]));
  return [...activeEntries()].sort((a, b) =>
    (domainOrder.get(a.domain) ?? 99) - (domainOrder.get(b.domain) ?? 99) || a.sort - b.sort);
}

/** 三域分区（域标题+域内词条，域无词条时也给空域以便呈现「空」）。 */
export function laneDomains(): ReadonlyArray<{ id: LaneDomainId; label: string; entries: readonly LaneVocabularyEntry[] }> {
  const sorted = [...snapshot.domains].sort((a, b) => a.sort - b.sort);
  return sorted.map((domain) => ({
    id: domain.id,
    label: domain.label,
    entries: laneEntries().filter((entry) => entry.domain === domain.id),
  }));
}

/* ---------- 栏位匹配：族表子类闭包判定（K2T） ---------- */

/* kind→父类型索引（S88 族表 ASSET_KIND_OPTIONS 的 parent 链,唯一来源;
   族表只读不写——新增子类在 asset-shared 登 parent,本层自动跟随）。 */
const ASSET_KIND_PARENT: ReadonlyMap<string, string> = new Map(
  ASSET_KIND_OPTIONS.flatMap((option) => (option.parent ? [[option.value, option.parent] as const] : [])),
);

/**
 * kind 自身 + 沿族表 parent 链的全部祖先（子类闭包,近亲在前）。
 * 防御:parent 链成环或指向族表外值时止步,已走到的链如实返回;
 * 大小写归一(同 S88b assetKindMatches 口径——后端 asset_kind 只 trim 不强制小写)。
 */
export function assetKindWithAncestors(assetKind: string): readonly string[] {
  const chain: string[] = [];
  let current = assetKind.trim().toLowerCase();
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = ASSET_KIND_PARENT.get(current) ?? "";
  }
  return chain;
}

/**
 * kind 落哪个栏:它自己或它的任一祖先在该栏 kinds 内(按词表 sort 取首个命中栏)。
 * 栏位匹配唯一判定——组件/视图层不许再写第二处 kinds 精确匹配;
 * 落不了栏(词表外 kind、断链)如实返回 null。
 */
export function laneIdForAssetKind(assetKind: string): string | null {
  const chain = assetKindWithAncestors(assetKind);
  if (chain.length === 0) return null;
  for (const lane of laneEntries()) {
    if (chain.some((kind) => lane.kinds.includes(kind))) return lane.id;
  }
  return null;
}

/* ---------- 演示/测试注入 ---------- */

/** 测试辅助：直接覆盖快照（mock 新词条进词表后验证渲染/组包）。 */
export function injectLaneVocabularyForTest(next: LaneVocabulary): void {
  snapshot = next;
}

export function resetLaneVocabularyForTest(): void {
  snapshot = BUILTIN_LANE_VOCABULARY;
}

/** 兼容类型（旧 ReferenceLaneId 字面量在新词条面前会窄化——新代码一律用 string）。 */
export type { ReferenceLaneId };
