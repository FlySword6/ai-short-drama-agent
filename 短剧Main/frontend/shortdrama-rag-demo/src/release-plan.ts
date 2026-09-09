/* ============================================================
   release-plan.ts — 版本计划与预告(S23:内容入库,本文件只留机制)

   数据真源在服务端(设置页写死的静态数组已随 S23 迁出,首次播种=迁移时刻
   内容的逐字拷贝)。本文件保留:
   - 呈现类型与文案映射(状态五态/分类三值的中文标签);
   - 纯逻辑:卡片版本语、Pi「功能预告」轮播句拼装、关闭记忆;
   - 接口形状归一:服务端条目 → 页面视图(蛇形/驼峰双吃,脏行丢弃);
   - 管理后台读写用的负载拼装。

   红线:本文件不得再出现内容数组(段/卡/历史条目一律从接口读);
   接口读不到时调用方如实降级——设置页显示读不出来、轮播不出,
   一律不回退到写死的旧数据。

   S46 B-7(R46)预告页口径:看预告的是不懂技术的业务——
   预告主体只放「新功能」类卡片(优化/修复不上预告,版本历史不受限);
   每条=功能名+一句用户价值;轮播同样只承诺功能。
   ============================================================ */

/* ---------- 呈现类型与文案映射(机制,不是内容) ---------- */

export type ReleaseStatus = "live" | "filming" | "scheduled" | "concept" | "vision";

/** 条目分类:新功能 / 优化 / 修复(changelog 惯例;预告卡小标签与版本历史条目同源)。 */
export type ReleaseCategory = "feature" | "improvement" | "fix";

export const RELEASE_CATEGORY_LABEL: Record<ReleaseCategory, string> = {
  feature: "新功能",
  improvement: "优化",
  fix: "修复",
};

export interface ReleaseCard {
  id: string;
  title: string;
  /** 一句话价值(业务白话,讲清解决什么痛点)。 */
  tagline: string;
  status: ReleaseStatus;
  /** 条目分类:feature 新功能 / improvement 优化 / fix 修复。 */
  category: ReleaseCategory;
  /** 档期版本号:"v0.1.2" / "v0.2" / "v0.3" / "v0.3.x"(全页统一小写 v + 数字);远景卡未定档,写「未定档」。 */
  release: string;
  /** Pi 面板「功能预告」轮播短句;远景卡不出短句(轮播只承诺近期)。 */
  teaser?: string;
  /** 起因:用户可见的「为什么做」(S24 版本计划内容替换新增)。 */
  reason?: string;
  /** 依据:决策出处留痕,不上前台。 */
  basis?: string;
}

export interface ReleaseSection {
  version: string;
  title: string;
  status: ReleaseStatus;
  note: string;
  cards: ReleaseCard[];
}

export const RELEASE_STATUS_LABEL: Record<ReleaseStatus, string> = {
  live: "已上线",
  filming: "开发中",
  scheduled: "已定档",
  concept: "规划中",
  vision: "远景",
};

/** 顶部导语(附录二原文)。 */
export const SETTINGS_INTRO = "每个版本聚焦解决一类真实痛点，做好一个上线一个。";

/**
 * R46(2026-07-27)预告页内容口径:看预告的是不懂技术的业务——
 * 只放功能,不放 bug fix 和后端改动;每条=功能名+一句用户价值。
 * 机制层落地:预告主体(未上线段)只渲染「新功能」类卡片;版本历史(账本)不受限。
 */
export const RELEASE_PREVIEW_RULE = "预告页只放功能：不放 bug 修复，不放后端改动；每条 = 功能名 + 一句用户价值。";

/** 预告主体只放「新功能」类卡片;优化/修复不上预告(版本历史折叠区不受此限)。 */
export function cardShownOnPreview(card: Pick<ReleaseCard, "category">): boolean {
  return card.category === "feature";
}

/** 段内预告可见卡(保持原顺序,不丢数据,只决定显示)。 */
export function previewCardsOf(section: Pick<ReleaseSection, "cards">): ReleaseCard[] {
  return section.cards.filter(cardShownOnPreview);
}

/** 管理后台编辑提示:卡片分类不上预告时给一句预警;上预告返回 null。 */
export function previewCategoryWarning(category: ReleaseCategory): string | null {
  return cardShownOnPreview({ category }) ? null : "这张卡是「优化/修复」类，不会显示在预告页（预告只放功能；版本历史不受限）。";
}

/** 已发布版本交付清单(页顶「版本历史」折叠块数据源,新发布在前)。 */
export interface ReleaseHistoryItem {
  label: string;
  /** 条目分类:feature 新功能 / improvement 优化 / fix 修复。 */
  category: ReleaseCategory;
}

export interface ReleaseHistoryEntry {
  version: string;
  /** 发布日期(YYYY-MM-DD)。 */
  date: string;
  /** 一句话定位。 */
  title: string;
  /** 交付项清单(不含已上线预告卡——卡片在折叠区内直接展示,此处只记非卡交付项,防重复)。 */
  items: ReleaseHistoryItem[];
}

/** 卡片底部版本语:已上线写版本号,开发中/已定档写预计版本,规划中写按证据排期,远景写看准再定档。 */
export function releaseWindow(card: ReleaseCard): string {
  const label = RELEASE_STATUS_LABEL[card.status];
  if (card.status === "live") return `${label} · ${card.release}`;
  if (card.status === "concept") return `${label} · 按证据排期`;
  if (card.status === "vision") return `${label} · 看准再定档`;
  return `${label} · 预计 ${card.release} 上线`;
}

/* ---------- Pi 面板「功能预告」单行轮播(机制) ---------- */

/** 关闭后本次会话不再出现(记忆在 sessionStorage)。 */
export const PI_TEASER_DISMISS_KEY = "shortdrama_v011_pi_teaser_dismissed";

/** 自动切换间隔 5s;点行手动切换。 */
export const PI_TEASER_ROTATE_MS = 5000;

function teaserTitle(title: string): string {
  return title.replace(/（[^）]*）/g, "");
}

/** 轮播只承诺近期:开发中/已定档/规划中;已上线不再预告,远景=探索向不进轮播(防过度承诺)。 */
const TEASER_STATUSES: ReadonlySet<ReleaseStatus> = new Set(["filming", "scheduled", "concept"]);

/** 轮播文案取版本预告短句:「已定档 · Pi 协作——对话拆剧本、提前备好参考、@素材直达提示词」。
    R46:轮播同样只承诺功能(feature 类),优化/修复不进轮播。 */
export function buildTeaserLines(sections: ReleaseSection[]): string[] {
  return sections.flatMap((section) => section.cards).flatMap((card) =>
    card.teaser && cardShownOnPreview(card) && TEASER_STATUSES.has(card.status)
      ? [`${RELEASE_STATUS_LABEL[card.status]} · ${teaserTitle(card.title)}——${card.teaser}`]
      : []);
}

/** 下一条轮播索引(环形);total 为 0 时守 0,防空数组越界。 */
export function nextTeaserIndex(current: number, total: number): number {
  if (total <= 0) return 0;
  return (current + 1) % total;
}

export function piTeaserDismissed(storage: Pick<Storage, "getItem">): boolean {
  return storage.getItem(PI_TEASER_DISMISS_KEY) === "1";
}

export function dismissPiTeaser(storage: Pick<Storage, "setItem">): void {
  storage.setItem(PI_TEASER_DISMISS_KEY, "1");
}

/* ---------- 服务端条目形状与归一(蛇形/驼峰双吃,脏行丢弃) ---------- */

/** 条目治理状态:草稿不显示,显示中才上前台,归档留底。 */
export type ConfigEntryStatus = "draft" | "published" | "archived";

export const CONFIG_ENTRY_STATUS_LABEL: Record<ConfigEntryStatus, string> = {
  draft: "草稿",
  published: "显示中",
  archived: "已归档",
};

export type ConfigEntryKind = "release_section" | "release_history_entry";

export const CONFIG_ENTRY_KIND_LABEL: Record<ConfigEntryKind, string> = {
  release_section: "预告版本段",
  release_history_entry: "版本历史",
};

export interface ConfigEntry {
  id: string;
  kind: ConfigEntryKind;
  entryKey: string;
  status: ConfigEntryStatus;
  sort: number;
  payload: unknown;
  source: string;
  createdAt: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function firstKey(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

const ENTRY_STATUSES: ReadonlySet<string> = new Set(["draft", "published", "archived"]);
const RELEASE_STATUSES: ReadonlySet<string> = new Set(["live", "filming", "scheduled", "concept", "vision"]);
const RELEASE_CATEGORIES: ReadonlySet<string> = new Set(["feature", "improvement", "fix"]);

/** wire → 条目规范形;缺 id/kind/业务键的脏行丢弃(返回 null)。 */
export function configEntryFromUnknown(value: unknown): ConfigEntry | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const kind = text(value.kind);
  const entryKey = text(firstKey(value, "entry_key", "entryKey"));
  if (!id || !entryKey) return null;
  if (kind !== "release_section" && kind !== "release_history_entry") return null;
  const status = text(value.status);
  return {
    id,
    kind,
    entryKey,
    status: status && ENTRY_STATUSES.has(status) ? status as ConfigEntryStatus : "published",
    sort: int(value.sort) ?? 0,
    payload: value.payload ?? {},
    source: text(value.source) ?? "",
    createdAt: text(firstKey(value, "created_at", "createdAt")) ?? "",
    updatedAt: text(firstKey(value, "updated_at", "updatedAt")) ?? "",
  };
}

/** 列表响应归一:非数组容错为空列表。 */
export function configEntriesFromUnknown(value: unknown): ConfigEntry[] {
  const record = isRecord(value) ? value : {};
  const raw = Array.isArray(record.entries) ? record.entries : [];
  return raw.map((item) => configEntryFromUnknown(item)).filter((item): item is ConfigEntry => item !== null);
}

function releaseCardFromUnknown(value: unknown): ReleaseCard | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const title = text(value.title);
  const tagline = text(value.tagline);
  const status = text(value.status);
  const category = text(value.category);
  const release = text(value.release);
  if (!id || !title || !tagline || !release) return null;
  if (!status || !RELEASE_STATUSES.has(status)) return null;
  if (!category || !RELEASE_CATEGORIES.has(category)) return null;
  const teaser = text(value.teaser);
  const reason = text(value.reason);
  const basis = text(value.basis);
  return {
    id,
    title,
    tagline,
    status: status as ReleaseStatus,
    category: category as ReleaseCategory,
    release,
    ...(teaser ? { teaser } : {}),
    ...(reason ? { reason } : {}),
    ...(basis ? { basis } : {}),
  };
}

/** 预告版本段:版本号取条目业务键;段标题/状态非法则整段丢弃,脏卡单独剔除。 */
export function releaseSectionFromEntry(entry: ConfigEntry): ReleaseSection | null {
  if (entry.kind !== "release_section" || !isRecord(entry.payload)) return null;
  const payload = entry.payload;
  const title = text(payload.title);
  const status = text(payload.status);
  if (!title || !status || !RELEASE_STATUSES.has(status)) return null;
  const rawCards = Array.isArray(payload.cards) ? payload.cards : [];
  return {
    version: entry.entryKey,
    title,
    status: status as ReleaseStatus,
    note: text(payload.note) ?? "",
    cards: rawCards.map((card) => releaseCardFromUnknown(card)).filter((card): card is ReleaseCard => card !== null),
  };
}

/** 版本历史:日期/标题非法则整条丢弃,脏条目单独剔除。 */
export function releaseHistoryFromEntry(entry: ConfigEntry): ReleaseHistoryEntry | null {
  if (entry.kind !== "release_history_entry" || !isRecord(entry.payload)) return null;
  const payload = entry.payload;
  const date = text(payload.date);
  const title = text(payload.title);
  if (!date || !title) return null;
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  const items = rawItems.flatMap((item): ReleaseHistoryItem[] => {
    if (!isRecord(item)) return [];
    const label = text(item.label);
    const category = text(item.category);
    if (!label || !category || !RELEASE_CATEGORIES.has(category)) return [];
    return [{ label, category: category as ReleaseCategory }];
  });
  return { version: entry.entryKey, date, title, items };
}

/* ---------- 管理后台写回用的负载拼装(视图 → 服务端形状) ---------- */

/** 段视图 → 服务端负载:版本号留在条目业务键,负载只装标题/状态/段注/卡片。 */
export function sectionPayloadFromView(section: ReleaseSection): Record<string, unknown> {
  return {
    title: section.title,
    status: section.status,
    note: section.note,
    cards: section.cards.map((card) => ({
      id: card.id,
      title: card.title,
      tagline: card.tagline,
      status: card.status,
      category: card.category,
      release: card.release,
      ...(card.teaser ? { teaser: card.teaser } : {}),
      ...(card.reason ? { reason: card.reason } : {}),
      ...(card.basis ? { basis: card.basis } : {}),
    })),
  };
}

/** 历史视图 → 服务端负载:版本号留在条目业务键。 */
export function historyPayloadFromView(entry: ReleaseHistoryEntry): Record<string, unknown> {
  return {
    date: entry.date,
    title: entry.title,
    items: entry.items.map((item) => ({ label: item.label, category: item.category })),
  };
}
