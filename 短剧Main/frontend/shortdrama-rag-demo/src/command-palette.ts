/* ============================================================
   command-palette.ts — ⌘K 命令面板(S30)纯逻辑

   红线(任务包 kimi-goal-s30-command-palette):
   - 指令清单与面板文案的真源在服务端 config_entries(迁移 026 播种),
     本文件只做归一、过滤、选中态机与落点拼装,不写死指令内容;
   - 指令 id(action 系 / nav 系)是注册机制锚点,行为在 command-registry.ts;
   - 搜索只出当前用户有权的内容:服务端接口已按成员关系过滤,前端不再
     自行判权,只做形状归一(蛇形/驼峰双吃,脏行丢弃);
   - demo 模式内容同样是数据(fixture 在 demo.ts),不是组件写死。

   纯逻辑、零 DOM,node:test 直接 import(command-palette.test.ts)。
   ============================================================ */

/* ---------- 指令分组与文案(对应 config payload 合同) ---------- */

import { assetKindLabel } from "./asset-kind-labels";

export interface CommandPaletteItem {
  /** 注册机制锚点(action 系 / nav 系指令 id),行为在 command-registry。 */
  command: string;
  label: string;
  hint?: string;
  keywords: string[];
  /** 仅项目内可用(面板在项目外不展示)。 */
  context?: "project";
  /** 仅 admin/operator 可见(服务端另有权限兜底)。 */
  requires?: "admin";
}

export interface CommandPaletteGroup {
  /** 条目业务键(entry_key),稳定标识。 */
  key: string;
  title: string;
  note?: string;
  items: CommandPaletteItem[];
  sort: number;
}

export type CommandPaletteSearchGroupKey = "projects" | "episodes" | "scenes" | "shots" | "assets";

export interface CommandPaletteCopy {
  placeholder: string;
  emptyResults: string;
  loadFailed: string;
  searchGroupLabels: Record<CommandPaletteSearchGroupKey, string>;
}

/** 代码兜底文案(lane-vocabulary 先例):接口读不到时面板不失语,回执如实声明。 */
export const DEFAULT_COMMAND_PALETTE_COPY: CommandPaletteCopy = {
  placeholder: "搜项目、剧集、分镜、资产,或直接下令…",
  emptyResults: "没找着。项目、剧集、场、分镜、资产都能搜,换个词再试试。",
  loadFailed: "搜索这会儿连不上,指令照常能用;搜东西请稍后再试。",
  searchGroupLabels: { projects: "项目", episodes: "剧集", scenes: "场", shots: "分镜", assets: "资产" },
};

/** 指令分组接口读不到时的面板横幅文案(机制文案,不是指令内容)。 */
export const COMMAND_PALETTE_GROUPS_FAILED_BANNER = "面板配置没读出来,指令清单稍后再试。";

/* ---------- 搜索结果五组(服务端 snake_case 契约的驼峰形) ---------- */

export interface CommandPaletteProjectHit { id: string; name: string; description: string | null }
export interface CommandPaletteEpisodeHit { id: string; projectId: string; episodeNo: number; name: string }
export interface CommandPaletteSceneHit { id: string; projectId: string; episodeId: string; sceneNo: number; name: string }
export interface CommandPaletteShotHit { id: string; projectId: string; episodeId: string; shotCode: string; title: string }
export interface CommandPaletteAssetHit { id: string; projectId: string; name: string; displayName: string; assetKind: string }

export interface CommandPaletteSearchResults {
  projects: CommandPaletteProjectHit[];
  episodes: CommandPaletteEpisodeHit[];
  scenes: CommandPaletteSceneHit[];
  shots: CommandPaletteShotHit[];
  assets: CommandPaletteAssetHit[];
}

export const EMPTY_SEARCH_RESULTS: CommandPaletteSearchResults = { projects: [], episodes: [], scenes: [], shots: [], assets: [] };

/* ---------- wire 归一(蛇形/驼峰双吃,脏行丢弃) ---------- */

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

interface ConfigEntryWire {
  kind: string;
  entryKey: string;
  status: string;
  sort: number;
  payload: unknown;
}

/** 窄归一:只收 command_palette_* 两种 kind 的 published 行,其余丢弃。 */
function paletteEntryFromUnknown(value: unknown): ConfigEntryWire | null {
  if (!isRecord(value)) return null;
  const kind = text(value.kind);
  if (kind !== "command_palette_group" && kind !== "command_palette_copy") return null;
  const entryKey = text(firstKey(value, "entry_key", "entryKey"));
  if (!entryKey) return null;
  const status = text(value.status) ?? "published";
  if (status !== "published") return null;
  return { kind, entryKey, status, sort: int(value.sort) ?? 0, payload: value.payload ?? {} };
}

function paletteEntriesFromUnknown(raw: unknown): ConfigEntryWire[] {
  const record = isRecord(raw) ? raw : {};
  const items = Array.isArray(record.entries) ? record.entries : [];
  return items.map((item) => paletteEntryFromUnknown(item)).filter((item): item is ConfigEntryWire => item !== null);
}

function paletteItemFromUnknown(value: unknown): CommandPaletteItem | null {
  if (!isRecord(value)) return null;
  const command = text(value.command);
  const label = text(value.label);
  if (!command || !label) return null;
  const rawKeywords = Array.isArray(value.keywords) ? value.keywords : [];
  const keywords = rawKeywords.map((word) => text(word)).filter((word): word is string => word !== null);
  const context = text(value.context);
  const requires = text(value.requires);
  const hint = text(value.hint);
  return {
    command,
    label,
    ...(hint ? { hint } : {}),
    keywords,
    ...(context === "project" ? { context: "project" as const } : {}),
    ...(requires === "admin" ? { requires: "admin" as const } : {}),
  };
}

/** GET /config-entries?kind=command_palette_group 响应 → 分组清单(按 sort 排)。 */
export function commandPaletteGroupsFromUnknown(raw: unknown): CommandPaletteGroup[] {
  return paletteEntriesFromUnknown(raw)
    .filter((entry) => entry.kind === "command_palette_group" && isRecord(entry.payload))
    .flatMap((entry) => {
      const payload = entry.payload as Record<string, unknown>;
      const title = text(payload.title);
      if (!title) return [];
      const rawItems = Array.isArray(payload.items) ? payload.items : [];
      const items = rawItems.map((item) => paletteItemFromUnknown(item)).filter((item): item is CommandPaletteItem => item !== null);
      if (items.length === 0) return [];
      const note = text(payload.note);
      return [{ key: entry.entryKey, title, ...(note ? { note } : {}), items, sort: entry.sort }];
    })
    .sort((a, b) => a.sort - b.sort);
}

const SEARCH_GROUP_KEYS: readonly CommandPaletteSearchGroupKey[] = ["projects", "episodes", "scenes", "shots", "assets"];

/** GET /config-entries?kind=command_palette_copy 响应 → 文案;读不到返回 null(调用方落兜底)。 */
export function commandPaletteCopyFromUnknown(raw: unknown): CommandPaletteCopy | null {
  const entry = paletteEntriesFromUnknown(raw).find((item) => item.kind === "command_palette_copy");
  if (!entry || !isRecord(entry.payload)) return null;
  const payload = entry.payload;
  const placeholder = text(payload.placeholder);
  const emptyResults = text(firstKey(payload, "empty_results", "emptyResults"));
  const loadFailed = text(firstKey(payload, "load_failed", "loadFailed"));
  const rawLabels = firstKey(payload, "search_group_labels", "searchGroupLabels");
  if (!placeholder || !emptyResults || !loadFailed || !isRecord(rawLabels)) return null;
  const labels = {} as Record<CommandPaletteSearchGroupKey, string>;
  for (const key of SEARCH_GROUP_KEYS) {
    const label = text(rawLabels[key]);
    if (!label) return null;
    labels[key] = label;
  }
  return { placeholder, emptyResults, loadFailed, searchGroupLabels: labels };
}

/* ---------- 指令过滤(上下文与权限由调用方算好传入) ---------- */

export interface CommandPaletteFilterContext {
  /** 当前是否在项目内(项目 id 在不在路径上)。 */
  inProject: boolean;
  /** 当前用户可否见管理台(canSeeAdminConsole 的结果)。 */
  canAdmin: boolean;
}

export function commandVisible(item: CommandPaletteItem, ctx: CommandPaletteFilterContext): boolean {
  if (item.context === "project" && !ctx.inProject) return false;
  if (item.requires === "admin" && !ctx.canAdmin) return false;
  return true;
}

function itemMatches(item: CommandPaletteItem, query: string): boolean {
  if (!query) return true;
  const haystacks = [item.label, item.hint ?? "", ...item.keywords];
  return haystacks.some((field) => field.toLowerCase().includes(query));
}

/** 按查询与上下文过滤分组;空查询=全部可见指令;空组整组不出。 */
export function filterPaletteGroups(
  groups: CommandPaletteGroup[],
  query: string,
  ctx: CommandPaletteFilterContext,
): CommandPaletteGroup[] {
  const needle = query.trim().toLowerCase();
  return groups.flatMap((group) => {
    const items = group.items.filter((item) => commandVisible(item, ctx) && itemMatches(item, needle));
    return items.length ? [{ ...group, items }] : [];
  });
}

/* ---------- 面板行模型与选中态机 ---------- */

export type CommandPaletteRow =
  | { kind: "command"; id: string; groupTitle: string; item: CommandPaletteItem }
  | { kind: "hit"; id: string; group: CommandPaletteSearchGroupKey; label: string; detail: string; path: string };

/** 搜索命中落点:项目根(恢复上次位置)、集级生产页、镜级工作台、资产详情。 */
export function commandPaletteHitPath(group: CommandPaletteSearchGroupKey, hit: { id: string; projectId?: string; episodeId?: string }): string {
  switch (group) {
    case "projects":
      return `/projects/${encodeURIComponent(hit.id)}`;
    case "episodes":
      return `/projects/${encodeURIComponent(hit.projectId ?? "")}/storyboards?episode=${encodeURIComponent(hit.id)}`;
    case "scenes":
      return `/projects/${encodeURIComponent(hit.projectId ?? "")}/storyboards?episode=${encodeURIComponent(hit.episodeId ?? "")}`;
    case "shots":
      return `/projects/${encodeURIComponent(hit.projectId ?? "")}/storyboards/${encodeURIComponent(hit.episodeId ?? "")}/shots/${encodeURIComponent(hit.id)}`;
    case "assets":
      return `/projects/${encodeURIComponent(hit.projectId ?? "")}/assets/${encodeURIComponent(hit.id)}`;
  }
}

/** 搜索结果 → 面板行(每组已按服务端上限截好,这里只扁化)。 */
export function searchResultRows(results: CommandPaletteSearchResults): CommandPaletteRow[] {
  const rows: CommandPaletteRow[] = [];
  for (const hit of results.projects) {
    rows.push({ kind: "hit", id: `hit-projects-${hit.id}`, group: "projects", label: hit.name, detail: hit.description ?? "", path: commandPaletteHitPath("projects", hit) });
  }
  for (const hit of results.episodes) {
    rows.push({ kind: "hit", id: `hit-episodes-${hit.id}`, group: "episodes", label: hit.name, detail: `第 ${hit.episodeNo} 集`, path: commandPaletteHitPath("episodes", hit) });
  }
  for (const hit of results.scenes) {
    rows.push({ kind: "hit", id: `hit-scenes-${hit.id}`, group: "scenes", label: hit.name, detail: `第 ${hit.sceneNo} 场`, path: commandPaletteHitPath("scenes", hit) });
  }
  for (const hit of results.shots) {
    rows.push({ kind: "hit", id: `hit-shots-${hit.id}`, group: "shots", label: hit.title || hit.shotCode, detail: hit.shotCode, path: commandPaletteHitPath("shots", hit) });
  }
  for (const hit of results.assets) {
    /* 业务语言化（#18）：资产类型枚举不裸显,走中文标签 */
    rows.push({ kind: "hit", id: `hit-assets-${hit.id}-${hit.projectId}`, group: "assets", label: hit.displayName || hit.name, detail: assetKindLabel(hit.assetKind), path: commandPaletteHitPath("assets", hit) });
  }
  return rows;
}

/** 过滤后的指令 → 面板行。 */
export function commandRows(groups: CommandPaletteGroup[]): CommandPaletteRow[] {
  return groups.flatMap((group) =>
    group.items.map((item) => ({ kind: "command" as const, id: `cmd-${group.key}-${item.command}`, groupTitle: group.title, item })));
}

/** 环形选中:total 为 0 回 -1;当前无选中时 ↓ 到首行、↑ 到末行。 */
export function moveActiveRow(current: number, delta: 1 | -1, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}

/* ---------- 搜索结果 wire 归一 ---------- */

function hitArray<T>(raw: unknown, map: (item: Record<string, unknown>) => T | null): T[] {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((item) => (isRecord(item) ? map(item) : null)).filter((item): item is T => item !== null);
}

/** GET /command-palette/search 响应归一:脏组容错为空组,组内脏行丢弃。 */
export function commandPaletteSearchFromUnknown(raw: unknown): CommandPaletteSearchResults {
  const record = isRecord(raw) ? raw : {};
  return {
    projects: hitArray(record.projects, (item) => {
      const id = text(item.id);
      const name = text(item.name);
      return id && name ? { id, name, description: text(item.description) } : null;
    }),
    episodes: hitArray(record.episodes, (item) => {
      const id = text(item.id);
      const projectId = text(firstKey(item, "project_id", "projectId"));
      const episodeNo = int(firstKey(item, "episode_no", "episodeNo"));
      const name = text(item.name);
      return id && projectId && episodeNo !== null && name ? { id, projectId, episodeNo, name } : null;
    }),
    scenes: hitArray(record.scenes, (item) => {
      const id = text(item.id);
      const projectId = text(firstKey(item, "project_id", "projectId"));
      const episodeId = text(firstKey(item, "episode_id", "episodeId"));
      const sceneNo = int(firstKey(item, "scene_no", "sceneNo"));
      const name = text(item.name);
      return id && projectId && episodeId && sceneNo !== null && name ? { id, projectId, episodeId, sceneNo, name } : null;
    }),
    shots: hitArray(record.shots, (item) => {
      const id = text(item.id);
      const projectId = text(firstKey(item, "project_id", "projectId"));
      const episodeId = text(firstKey(item, "episode_id", "episodeId"));
      const shotCode = text(firstKey(item, "shot_code", "shotCode"));
      const title = text(item.title);
      return id && projectId && episodeId && shotCode && title ? { id, projectId, episodeId, shotCode, title } : null;
    }),
    assets: hitArray(record.assets, (item) => {
      const id = text(item.id);
      const projectId = text(firstKey(item, "project_id", "projectId"));
      const name = text(item.name);
      const displayName = text(firstKey(item, "display_name", "displayName"));
      const assetKind = text(firstKey(item, "asset_kind", "assetKind"));
      return id && projectId && name && displayName && assetKind ? { id, projectId, name, displayName, assetKind } : null;
    }),
  };
}

/* ---------- demo 模式搜索(fixture 由调用方从 demo.ts 传入,本文件不反向依赖) ---------- */

export interface DemoPaletteFixtures {
  projects: Array<{ id: string; name: string; description?: string | null }>;
  episodes: Array<{ id: string; project_id: string; episode_no: number; name?: string | null }>;
  shots: Array<{ id: string; episode_id: string; shot_no?: string | null; title?: string | null }>;
  projectAssets: Array<{ project_id?: string; asset?: { id: string; name?: string | null; display_name?: string | null; asset_kind?: string | null } }>;
}

/** demo 每组上限,与服务端 COMMAND_PALETTE_PER_GROUP_LIMIT 对齐。 */
export const DEMO_PALETTE_PER_GROUP_LIMIT = 5;

/** 离线演示搜索:项目/剧集/分镜/项目资产 fixtures 过滤;场无 fixture 恒空(回执声明)。 */
export function searchDemoFixtures(query: string, fixtures: DemoPaletteFixtures): CommandPaletteSearchResults {
  const needle = query.trim().toLowerCase();
  if (!needle) return EMPTY_SEARCH_RESULTS;
  const episodeProject = new Map(fixtures.episodes.map((episode) => [episode.id, episode.project_id]));
  return {
    projects: fixtures.projects
      .filter((project) => project.name.toLowerCase().includes(needle))
      .slice(0, DEMO_PALETTE_PER_GROUP_LIMIT)
      .map((project) => ({ id: project.id, name: project.name, description: project.description ?? null })),
    episodes: fixtures.episodes
      .filter((episode) => (episode.name ?? "").toLowerCase().includes(needle))
      .slice(0, DEMO_PALETTE_PER_GROUP_LIMIT)
      .map((episode) => ({ id: episode.id, projectId: episode.project_id, episodeNo: episode.episode_no, name: episode.name ?? "" })),
    scenes: [],
    shots: fixtures.shots
      .filter((shot) => (shot.title ?? "").toLowerCase().includes(needle) || (shot.shot_no ?? "").toLowerCase().includes(needle))
      .slice(0, DEMO_PALETTE_PER_GROUP_LIMIT)
      .map((shot) => ({
        id: shot.id,
        projectId: episodeProject.get(shot.episode_id) ?? "",
        episodeId: shot.episode_id,
        shotCode: shot.shot_no ?? "",
        title: shot.title ?? "",
      })),
    assets: fixtures.projectAssets
      .flatMap((ref) => (ref.asset ? [{ projectId: ref.project_id ?? "", asset: ref.asset }] : []))
      .filter((ref) => (ref.asset.display_name ?? ref.asset.name ?? "").toLowerCase().includes(needle))
      .slice(0, DEMO_PALETTE_PER_GROUP_LIMIT)
      .map((ref) => ({
        id: ref.asset.id,
        projectId: ref.projectId,
        name: ref.asset.name ?? "",
        displayName: ref.asset.display_name ?? ref.asset.name ?? "",
        assetKind: ref.asset.asset_kind ?? "",
      })),
  };
}
