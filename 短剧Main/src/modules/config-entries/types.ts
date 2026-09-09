import { z } from "zod";
import { providerCostBasisPayloadSchema } from "../generation/providerCost.js";

/**
 * Soft-config source of truth (migration 023): entries that must change
 * without a deploy.  The release plan (settings-page preview sections and
 * release history) is the first kind moved in.  Governance fields are fixed
 * columns (kind/status/timestamps/source/owner); content lives in the
 * snake_case-keyed payload, so categories and labels may stay multi-valued
 * without a schema change.
 */

export const CONFIG_ENTRY_STATUSES = ["draft", "published", "archived"] as const;

export type ConfigEntryStatus = (typeof CONFIG_ENTRY_STATUSES)[number];

export const CONFIG_ENTRY_KINDS = [
  "release_section",
  "release_history_entry",
  "command_palette_group",
  "command_palette_copy",
  "provider_cost_basis",
] as const;

export type ConfigEntryKind = (typeof CONFIG_ENTRY_KINDS)[number];

/** Supplier cost rates are commercially sensitive and remain admin-only. */
export const PUBLIC_CONFIG_ENTRY_KINDS = [
  "release_section",
  "release_history_entry",
  "command_palette_group",
  "command_palette_copy",
] as const satisfies readonly ConfigEntryKind[];

export const RELEASE_STATUSES = ["live", "filming", "scheduled", "concept", "vision"] as const;

/** card_key 的 slug 形状:小写字母数字,段间单连字符,首尾不许是连字符。 */
export const RELEASE_CARD_KEY_PATTERN_SOURCE = "[a-z0-9]+(?:-[a-z0-9]+)*";
export const RELEASE_CARD_KEY_PATTERN = new RegExp(`^${RELEASE_CARD_KEY_PATTERN_SOURCE}$`);

export const RELEASE_CATEGORIES = ["feature", "improvement", "fix"] as const;

const releaseStatusSchema = z.enum(RELEASE_STATUSES);
const releaseCategorySchema = z.enum(RELEASE_CATEGORIES);

export const releaseCardPayloadSchema = z.object({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(64),
  tagline: z.string().trim().min(1).max(500),
  status: releaseStatusSchema,
  category: releaseCategorySchema,
  release: z.string().trim().min(1).max(32),
  teaser: z.string().trim().min(1).max(200).optional(),
  /** 起因：用户可见的「为什么做」（S24 版本计划内容替换新增）。 */
  reason: z.string().trim().min(1).max(500).optional(),
  /** 依据：入库留痕的决策出处，不上前台。 */
  basis: z.string().trim().min(1).max(500).optional(),
  /**
   * 稳定对齐键（S31）：docs/design/version-plan.md 的 <!-- card:... --> 锚点
   * 与库内卡片靠它对齐，不靠标题文本（两边命名故意不同，标题对齐正是
   * 2026-07-26 分叉查不出来的根因）。可空——旧行由迁移 027 按 id 回填；
   * 为空时一致性测试报「未归属」，不在这里强制。
   */
  card_key: z.string().trim().min(1).max(64).regex(RELEASE_CARD_KEY_PATTERN, "card_key 需为小写 slug").optional(),
  /**
   * 验收标准（S31）：可空，由 Fable 后续逐张填。为空时前端不显示，
   * 不编占位文案。
   */
  acceptance: z.string().trim().min(1).max(2000).optional(),
}).strict();

export const releaseSectionPayloadSchema = z.object({
  title: z.string().trim().min(1).max(64),
  status: releaseStatusSchema,
  note: z.string().trim().max(200).default(""),
  cards: z.array(releaseCardPayloadSchema).max(50),
}).strict();

export const releaseHistoryItemPayloadSchema = z.object({
  label: z.string().trim().min(1).max(128),
  category: releaseCategorySchema,
}).strict();

export const releaseHistoryEntryPayloadSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期需为 YYYY-MM-DD"),
  title: z.string().trim().min(1).max(128),
  items: z.array(releaseHistoryItemPayloadSchema).max(100),
}).strict();

/**
 * ⌘K 命令面板(S30):面板里展示什么、文案是什么、排序怎么排由配置驱动
 * (DC 点名不许写死内容);command 只是注册机制里的指令 id,行为留在代码。
 * 一条 group 就是一个分组(如「开拍」「后场」),sort 决定分组顺序。
 */
export const commandPaletteItemPayloadSchema = z.object({
  command: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  hint: z.string().trim().max(128).optional(),
  keywords: z.array(z.string().trim().min(1).max(32)).max(8).optional(),
  /** project=只在项目内出现;缺省=全局出现。 */
  context: z.enum(["project"]).optional(),
  /** admin=仅平台管理员可见可执行(服务端仍兜底拦截)。 */
  requires: z.enum(["admin"]).optional(),
}).strict();

export const commandPaletteGroupPayloadSchema = z.object({
  title: z.string().trim().min(1).max(64),
  note: z.string().trim().max(200).optional(),
  items: z.array(commandPaletteItemPayloadSchema).min(1).max(20),
}).strict();

export const commandPaletteSearchGroupLabelsSchema = z.object({
  projects: z.string().trim().min(1).max(32),
  episodes: z.string().trim().min(1).max(32),
  scenes: z.string().trim().min(1).max(32),
  shots: z.string().trim().min(1).max(32),
  assets: z.string().trim().min(1).max(32),
}).strict();

export const commandPaletteCopyPayloadSchema = z.object({
  placeholder: z.string().trim().min(1).max(128),
  empty_results: z.string().trim().min(1).max(200),
  load_failed: z.string().trim().min(1).max(200),
  search_group_labels: commandPaletteSearchGroupLabelsSchema,
}).strict();

export const CONFIG_ENTRY_PAYLOAD_SCHEMAS = {
  release_section: releaseSectionPayloadSchema,
  release_history_entry: releaseHistoryEntryPayloadSchema,
  command_palette_group: commandPaletteGroupPayloadSchema,
  command_palette_copy: commandPaletteCopyPayloadSchema,
  provider_cost_basis: providerCostBasisPayloadSchema,
} as const;

export type ReleaseCardPayload = z.infer<typeof releaseCardPayloadSchema>;
export type ReleaseSectionPayload = z.infer<typeof releaseSectionPayloadSchema>;
export type ReleaseHistoryEntryPayload = z.infer<typeof releaseHistoryEntryPayloadSchema>;
export type CommandPaletteItemPayload = z.infer<typeof commandPaletteItemPayloadSchema>;
export type CommandPaletteGroupPayload = z.infer<typeof commandPaletteGroupPayloadSchema>;
export type CommandPaletteCopyPayload = z.infer<typeof commandPaletteCopyPayloadSchema>;

export interface ConfigEntry {
  id: string;
  kind: ConfigEntryKind;
  entryKey: string;
  status: ConfigEntryStatus;
  sort: number;
  payload: unknown;
  source: string;
  createdBy: string | null;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface CreateConfigEntryInput {
  kind: ConfigEntryKind;
  entryKey: string;
  status?: ConfigEntryStatus;
  sort?: number;
  payload: unknown;
  createdBy?: string | null;
}

export interface UpdateConfigEntryInput {
  entryKey?: string;
  status?: ConfigEntryStatus;
  sort?: number;
  payload?: unknown;
  updatedBy?: string | null;
}

export interface ConfigEntriesRepository {
  /** Published entries only — the login-readable surface. */
  listPublishedByKind(kind: ConfigEntryKind): Promise<ConfigEntry[]>;
  /** All statuses — the admin surface. */
  listByKind(kind: ConfigEntryKind): Promise<ConfigEntry[]>;
  create(input: CreateConfigEntryInput): Promise<ConfigEntry>;
  update(id: string, kind: ConfigEntryKind, input: UpdateConfigEntryInput): Promise<ConfigEntry | null>;
  remove(id: string): Promise<boolean>;
}
