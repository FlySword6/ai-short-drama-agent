import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { settings } from "../config/env.js";
import type { CredentialSource } from "../modules/auth/types.js";
import type { ShotStoryboardDetail } from "../modules/script-breakdown/types.js";

export const common = pgSchema(settings.postgresSchema);
const utcTimestamp = (name: string) => timestamp(name, { mode: "date", withTimezone: true });

export const platformRoles = ["admin", "operator", "member"] as const;
export type PlatformRole = (typeof platformRoles)[number];

export const projectMemberRoles = ["owner", "editor", "viewer"] as const;
export type ProjectMemberRole = (typeof projectMemberRoles)[number];

export const projectProductionRoles = [
  "director",
  "art",
  "screenwriter",
  "coordinator",
  "reviewer",
] as const;
export type ProjectProductionRole = (typeof projectProductionRoles)[number];

/** Lite 界面模式开关（红线 R2：users 表是唯一事实源，禁 localStorage/URL 参数/构建期开关替代）。 */
export const uiModes = ["lite", "full"] as const;
export type UiMode = (typeof uiModes)[number];

/**
 * This is an asset fact, not an enforcement switch.  Publishing and generation
 * enforcement deliberately arrive with their own later contracts.
 */
export interface AssetClearance {
  search: boolean;
  gen_reference: boolean;
  commercial_publish: boolean;
  model_training: boolean;
}

export const defaultAssetClearance: AssetClearance = {
  search: true,
  gen_reference: true,
  commercial_publish: false,
  model_training: false,
};

/**
 * Known clearance bits, in canonical write order. The set is allowed to grow
 * (see docs/design/creative-vocabulary-openness.md): adding a bit means
 * extending this list, `defaultAssetClearance`, and the migration 030 CHECK
 * constraint together — this list is the single source the other two mirror.
 */
export const assetClearanceKeys = ["search", "gen_reference", "commercial_publish", "model_training"] as const;
export type AssetClearanceKey = (typeof assetClearanceKeys)[number];

export interface AssetClearanceIssue {
  kind: "not_object" | "unknown_bit" | "non_boolean_bit";
  /** The offending bit for per-key issues; absent when the whole value is misshapen. */
  key?: string;
  message: string;
}

function isClearanceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one and only clearance shape check. Every write path
 * (`parseAssetClearance`) and the read-only fleet audit
 * (scripts/check-asset-clearance.mts) derive from this inspection, so they can
 * never drift apart. A missing known bit is NOT an issue — it falls back to
 * the fail-safe default; an unknown bit or a non-boolean value always is.
 */
export function inspectAssetClearance(value: unknown): AssetClearanceIssue[] {
  if (!isClearanceRecord(value)) {
    return [{ kind: "not_object", message: "clearance 必须是 jsonb 对象（不接受数组、标量或 null）" }];
  }
  const known = new Set<string>(assetClearanceKeys);
  const issues: AssetClearanceIssue[] = [];
  for (const key of Object.keys(value).sort()) {
    if (!known.has(key)) {
      issues.push({
        kind: "unknown_bit",
        key,
        message: `未知权利位 ${JSON.stringify(key)}（已知位：${assetClearanceKeys.join(", ")}）`,
      });
    } else if (typeof value[key] !== "boolean") {
      issues.push({
        kind: "non_boolean_bit",
        key,
        message: `权利位 ${key} 必须是布尔值，实际为 ${JSON.stringify(value[key])}`,
      });
    }
  }
  return issues;
}

/** Human-readable issue strings, derived from `inspectAssetClearance`. */
export function describeAssetClearanceIssues(value: unknown): string[] {
  return inspectAssetClearance(value).map((issue) => issue.message);
}

/**
 * Validates an unknown clearance value for writing. Missing known bits take
 * the fail-safe defaults instead of failing; unknown bits or non-boolean
 * values throw. Output keys are emitted in canonical order so written rows
 * have a stable shape.
 */
export function parseAssetClearance(value: unknown): AssetClearance {
  const issues = describeAssetClearanceIssues(value);
  if (issues.length > 0) {
    throw new Error(`asset clearance 不合法: ${issues.join("; ")}`);
  }
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    assetClearanceKeys.map((key) => [key, input[key] ?? defaultAssetClearance[key]]),
  ) as unknown as AssetClearance;
}

export const users = common.table("users", {
  id: uuid("id").primaryKey(),
  username: varchar("username", { length: 64 }).notNull(),
  // Email is nullable for Day-0 and legacy username-only accounts. New
  // self-registration uses it as the verified login identifier.
  email: varchar("email", { length: 320 }),
  emailVerifiedAt: utcTimestamp("email_verified_at"),
  displayName: varchar("display_name", { length: 128 }).notNull(),
  passwordHash: text("password_hash"),
  active: boolean("active").notNull(),
  role: varchar("role", { length: 16 }).$type<PlatformRole>().notNull().default("member"),
  // 默认 'full'：迁移上线时完整版用户不受打扰；业务账号由管理员显式置 'lite'。
  uiMode: varchar("ui_mode", { length: 8 }).$type<UiMode>().notNull().default("full"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("users_email_unique")
    .on(sql`lower(${table.email})`)
    .where(sql`${table.email} is not null`),
  check("users_ui_mode_check", sql`${table.uiMode} in ('lite', 'full')`),
]);

export const sessions = common.table("sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  credentialSource: varchar("credential_source", { length: 16 }).$type<CredentialSource>().notNull(),
  agentType: varchar("agent_type", { length: 64 }),
  userAgent: varchar("user_agent", { length: 512 }),
  credentialLabel: varchar("credential_label", { length: 128 }),
  // SQL migration 047 owns this self-reference to avoid a circular runtime binding.
  issuedBySessionId: uuid("issued_by_session_id"),
  expiresAt: utcTimestamp("expires_at").notNull(),
  revokedAt: utcTimestamp("revoked_at"),
  createdAt: utcTimestamp("created_at").notNull(),
});

export const wecomUserIdentities = common.table("wecom_user_identities", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  corpId: varchar("corp_id", { length: 64 }).notNull(),
  wecomUserId: varchar("wecom_user_id", { length: 64 }).notNull(),
  lastAuthenticatedAt: utcTimestamp("last_authenticated_at").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("wecom_user_identities_external_unique").on(table.corpId, table.wecomUserId),
  uniqueIndex("wecom_user_identities_user_unique").on(table.userId),
]);

export const wecomAuthTransactions = common.table("wecom_auth_transactions", {
  id: uuid("id").primaryKey(),
  stateHash: varchar("state_hash", { length: 64 }).notNull(),
  browserNonceHash: varchar("browser_nonce_hash", { length: 64 }).notNull(),
  returnPath: varchar("return_path", { length: 2048 }).notNull(),
  expiresAt: utcTimestamp("expires_at").notNull(),
  callbackConsumedAt: utcTimestamp("callback_consumed_at"),
  resultHash: varchar("result_hash", { length: 64 }),
  resultExpiresAt: utcTimestamp("result_expires_at"),
  resultConsumedAt: utcTimestamp("result_consumed_at"),
  resolvedUserId: uuid("resolved_user_id").references(() => users.id, { onDelete: "restrict" }),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("wecom_auth_transactions_state_hash_unique").on(table.stateHash),
  uniqueIndex("wecom_auth_transactions_result_hash_unique")
    .on(table.resultHash)
    .where(sql`${table.resultHash} is not null`),
  index("wecom_auth_transactions_expiry_idx").on(table.expiresAt, table.createdAt),
]);

/**
 * Teams are cost-attribution units.  They are not an additional permission
 * model: project membership remains the only project-level access truth.
 */
export const teams = common.table("teams", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  // The SQL migration owns the self-reference to avoid a circular Drizzle
  // runtime binding.  It is an optional single parent, never an auth edge.
  parentTeamId: uuid("parent_team_id"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

export const teamMembers = common.table("team_members", {
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.teamId, table.userId], name: "team_members_pkey" }),
]);

/** User groups are administration/reporting tags only; they never authorize. */
export const userGroups = common.table("user_groups", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 128 }).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

export const userGroupMembers = common.table("user_group_members", {
  userGroupId: uuid("user_group_id").notNull().references(() => userGroups.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.userGroupId, table.userId], name: "user_group_members_pkey" }),
]);

/**
 * Cross-entity operations use a separate audit table from the legacy
 * user-only `admin_user_actions` table.  This avoids weakening its historical
 * target-user constraints while keeping every future management action typed.
 */
export const adminOperationActions = common.table("admin_operation_actions", {
  id: uuid("id").primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  actorSessionId: uuid("actor_session_id").references(() => sessions.id, { onDelete: "set null" }),
  action: varchar("action", { length: 64 }).notNull(),
  targetType: varchar("target_type", { length: 32 }).notNull(),
  targetId: uuid("target_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
});

export const projects = common.table("projects", {
  id: uuid("id").primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  teamId: uuid("team_id").references(() => teams.id),
  genre: varchar("genre", { length: 32 }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull(),
  defaultRatio: varchar("default_ratio", { length: 5 }).notNull().default("9:16"),
  defaultImageResolution: varchar("default_image_resolution", { length: 64 }).notNull().default("1K"),
  defaultVideoResolution: varchar("default_video_resolution", { length: 64 }).notNull().default("720p"),
  imageStyleDescription: text("image_style_description"),
  videoStyleDescription: text("video_style_description"),
  imageStyleReferenceMediaIds: jsonb("image_style_reference_media_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  videoStyleReferenceMediaIds: jsonb("video_style_reference_media_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  imagePromptTemplate: text("image_prompt_template"),
  videoPromptTemplate: text("video_prompt_template"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
  /** Lite 容器集指针（A 方案）：非空即 Lite 项目的判定依据，与集名解耦。由 Lite BFF 建集时写回。
      指向 episodes.id 的外键由迁移 SQL 持有（同 teams 自引用先例），Drizzle 侧不绑——
      projects↔episodes 互引用会让下游查询的类型推断退化（实测 storyboard/repository.ts 报错）。 */
  liteEpisodeId: uuid("lite_episode_id"),
});

/**
 * Project membership is the project visibility and authorization source.  The
 * legacy owner column stays as a compatibility index and is synchronized by
 * the membership service/016 migration trigger.
 */
export const projectMembers = common.table("project_members", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 16 }).$type<ProjectMemberRole>().notNull(),
  addedByUserId: uuid("added_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.userId], name: "project_members_pkey" }),
  uniqueIndex("project_members_one_owner_per_project")
    .on(table.projectId)
    .where(sql`${table.role} = 'owner'`),
]);

/**
 * A member's production responsibilities are multi-select and deliberately
 * separate from the owner/editor/viewer authorization role above.
 */
export const projectMemberProductionRoles = common.table("project_member_production_roles", {
  projectId: uuid("project_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: varchar("role", { length: 32 }).$type<ProjectProductionRole>().notNull(),
  assignedByUserId: uuid("assigned_by_user_id").notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  primaryKey({
    columns: [table.projectId, table.userId, table.role],
    name: "project_member_production_roles_pkey",
  }),
  foreignKey({
    name: "project_member_production_roles_membership_fk",
    columns: [table.projectId, table.userId],
    foreignColumns: [projectMembers.projectId, projectMembers.userId],
  }).onDelete("cascade"),
  check(
    "project_member_production_roles_role_check",
    sql`${table.role} IN ('director', 'art', 'screenwriter', 'coordinator', 'reviewer')`,
  ),
  index("project_member_production_roles_project_role_idx")
    .on(table.projectId, table.role, table.userId),
  index("project_member_production_roles_user_project_idx")
    .on(table.userId, table.projectId),
]);

export const episodes = common.table("episodes", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  episodeNo: integer("episode_no").notNull(),
  name: varchar("name", { length: 255 }),
  /** v1.4:集级可编辑概要(065),与剧本正文分离——改概要不触发拆解;空则前端回退最新剧本正文开头。 */
  synopsis: text("synopsis"),
  sortOrder: integer("sort_order").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

export const scenes = common.table("scenes", {
  id: uuid("id").primaryKey(),
  episodeId: uuid("episode_id").notNull().references(() => episodes.id),
  sceneNo: integer("scene_no").notNull(),
  name: varchar("name", { length: 255 }),
  description: text("description"),
  sortOrder: integer("sort_order").notNull(),
  sourceBreakdownRunId: uuid("source_breakdown_run_id").references(() => scriptBreakdownRuns.id),
  sourceCandidateId: varchar("source_candidate_id", { length: 64 }),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

/**
 * P6 skill 单次结构化拆镜输出全量（迁移 067）。分镜（shots 一行）= 一个
 * Segment（独立剧情单元）；Segment 内若干 Shot 四模块（数量由剧情内容自然
 * 决定，至少 1 个，不固定）作为该分镜的内部结构化内容落本字段，成文提示词
 * （video_prompt）涵盖全部 Shot。
 * 可空：skill 删除降级路径（通用拆镜）写 NULL（§2.6 F）。
 * 形状真源在 script-breakdown 模块（boundary 合同禁止该模块反向 import 本文件）。
 */
export type { ShotStoryboardDetail };
/**
 * v1.4 长尾字段的固定命名空间(065)。与资产方案的 `metadata.lite` 同口径:
 * 固定命名空间 + 服务端 Zod 校验,不与既有 jsonb 冲突。氛围/结构化对白/
 * 提示词锁定存 `metadata.lite.shot`,其余命名空间保留给未来能力。
 */
export interface ShotLiteMetadata {
  atmosphere?: string | null;
  /** 2026-08-18 Lite 详情「对白」输入框（v1.7 反馈：与场景/时长同组的自由文本，
      独立于结构化 dialogue.lines 与剧本原文 script_text）。 */
  dialogue_note?: string | null;
  dialogue?: {
    lines?: Array<{
      speaker: string;
      text: string;
      asset_entity_id?: string | null;
    }>;
  } | null;
  prompt_locked?: boolean | null;
}

export interface ShotMetadata {
  lite?: {
    shot?: ShotLiteMetadata | null;
    /**
     * v1.7(八.10.4)分镜侧删除的自动引用抑制名单:(asset_entity_id, variant_id) 对
     * 被用户在分镜页删除后追加于此,materialize backfill A/B 两层重跑都不复活;
     * 资产侧重新手动关联该对时移除(用户显式恢复意愿优先)。既有 jsonb 列,零迁移。
     */
    removedAutoRefs?: Array<{ asset_entity_id: string; variant_id: string }>;
  } | null;
}

export const shots = common.table("shots", {
  id: uuid("id").primaryKey(),
  episodeId: uuid("episode_id").notNull().references(() => episodes.id),
  sceneId: uuid("scene_id").references(() => scenes.id),
  shotCode: varchar("shot_code", { length: 64 }).notNull(),
  title: varchar("title", { length: 255 }),
  scriptText: text("script_text"),
  breakdownElements: jsonb("breakdown_elements").$type<{
    subject: string | null;
    action: string | null;
    visual: string | null;
    camera_language: string | null;
  }>(),
  directorPrompt: text("director_prompt"),
  imagePrompt: text("image_prompt"),
  videoPrompt: text("video_prompt"),
  /** P6（067）：skill 单次结构化拆镜全量；降级路径写 NULL，见 {@link ShotStoryboardDetail}。 */
  storyboardDetail: jsonb("storyboard_detail").$type<ShotStoryboardDetail | null>(),
  durationSeconds: integer("duration_seconds"),
  sortOrder: integer("sort_order").notNull(),
  referenceAssetSnapshots: jsonb("reference_asset_snapshots").$type<Array<Record<string, unknown>>>().notNull(),
  sourceBreakdownRunId: uuid("source_breakdown_run_id").references(() => scriptBreakdownRuns.id),
  sourceCandidateId: varchar("source_candidate_id", { length: 64 }),
  selectedImageResultId: uuid("selected_image_result_id"),
  selectedVideoResultId: uuid("selected_video_result_id"),
  /** v1.4 长尾字段(065):氛围/结构化对白/提示词锁定,见 {@link ShotMetadata}。 */
  metadata: jsonb("metadata").$type<ShotMetadata>().default({}).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

/**
 * v1.4 分镜-资产引用(065,附录 B.7):把 `shots.reference_asset_snapshots` 那份
 * 只读 JSON 快照升级为可编辑、可查询的引用真值;快照保留为剧本确认时的审计溯源。
 * usage_mode 沿用 asset_entities.usage_mode 口径(reference/first_frame/last_frame);
 * enabled=false = 临时禁用(参与生成勾掉,引用保留但提示词编译跳过)。
 */
export const shotAssetRefs = common.table("shot_asset_refs", {
  id: uuid("id").primaryKey(),
  shotId: uuid("shot_id").notNull().references(() => shots.id),
  assetEntityId: uuid("asset_entity_id").notNull().references(() => assetEntities.id),
  assetVariantId: uuid("asset_variant_id").references(() => assetVariants.id),
  assetMediaId: uuid("asset_media_id").references(() => assetMedia.id),
  usageMode: varchar("usage_mode", { length: 16 }),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
}, (table) => [
  index("shot_asset_refs_shot_idx").on(table.shotId),
  index("shot_asset_refs_asset_entity_idx").on(table.assetEntityId),
  uniqueIndex("shot_asset_refs_shot_entity_unique")
    .on(table.shotId, table.assetEntityId)
    .where(sql`${table.deletedAt} is null`),
]);

/**
 * Casting tasks (migration 061, main#292「表与读」): one missing-reference work
 * order per scene or shot — which lane asset is needed, what it should look
 * like, and who it is assigned to. Scene-level rows fill scene_id only;
 * shot-level rows fill both. assignee_user_id NULL means unclaimed; it is a
 * plain user reference, not a new role. Claim/submit/review transitions land
 * with the follow-up card; this table only ever carries status 'open' from
 * this card's API.
 */
export const castingTasks = common.table("casting_tasks", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  sceneId: uuid("scene_id").references(() => scenes.id),
  shotId: uuid("shot_id").references(() => shots.id),
  lane: varchar("lane", { length: 24 }).notNull().references(() => referenceLaneVocabulary.id),
  targetAssetEntityId: uuid("target_asset_entity_id").references(() => assetEntities.id),
  targetAssetVariantId: uuid("target_asset_variant_id").references(() => assetVariants.id),
  title: text("title").notNull(),
  brief: text("brief"),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  assigneeUserId: uuid("assignee_user_id").references(() => users.id),
  status: varchar("status", { length: 16 }).notNull().default("open"),
  referenceTestId: uuid("reference_test_id").references(() => referenceTests.id),
  deliveredAssetMediaId: uuid("delivered_asset_media_id").references(() => assetMedia.id),
  rejectionReason: text("rejection_reason"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  index("casting_tasks_project_status_idx").on(table.projectId, table.status),
  index("casting_tasks_assignee_idx").on(table.assigneeUserId),
  index("casting_tasks_shot_idx").on(table.shotId),
]);

export const storyboardImports = common.table("storyboard_imports", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  sourceFileName: varchar("source_file_name", { length: 512 }).notNull(),
  sourceSha256: varchar("source_sha256", { length: 64 }).notNull(),
  sourceStoragePath: varchar("source_storage_path", { length: 1024 }),
  status: varchar("status", { length: 20 }).notNull(),
  previewRows: jsonb("preview_rows").$type<Array<Record<string, unknown>>>().notNull(),
  warnings: jsonb("warnings").$type<Array<Record<string, unknown>>>().notNull(),
  errors: jsonb("errors").$type<Array<Record<string, unknown>>>().notNull(),
  confirmationResult: jsonb("confirmation_result").$type<Record<string, unknown>>(),
  confirmedAt: utcTimestamp("confirmed_at"),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

export const assetSourceProjects = common.table("asset_source_projects", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 128 }),
  code: varchar("code", { length: 64 }),
  description: varchar("description", { length: 512 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }),
  projectType: varchar("project_type", { length: 64 }),
});

/**
 * Script breakdown draft area (migration 021). AI output only ever lands in
 * these tables; formal scenes/shots are written exclusively by the human
 * confirmation transaction and keep their source run/candidate reference.
 */
export const episodeScriptVersions = common.table("episode_script_versions", {
  id: uuid("id").primaryKey(),
  episodeId: uuid("episode_id").notNull().references(() => episodes.id),
  versionNo: integer("version_no").notNull(),
  title: varchar("title", { length: 255 }),
  scriptText: text("script_text").notNull(),
  scriptSha256: varchar("script_sha256", { length: 64 }).notNull(),
  source: varchar("source", { length: 16 }).notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  clientIdempotencyKey: varchar("client_idempotency_key", { length: 255 }).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
});

export const scriptBreakdownRuns = common.table("script_breakdown_runs", {
  id: uuid("id").primaryKey(),
  episodeId: uuid("episode_id").notNull().references(() => episodes.id),
  scriptVersionId: uuid("script_version_id").notNull().references(() => episodeScriptVersions.id),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  clientIdempotencyKey: varchar("client_idempotency_key", { length: 255 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  modelName: varchar("model_name", { length: 128 }),
  promptVersion: varchar("prompt_version", { length: 64 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  executionToken: uuid("execution_token"),
  currentStage: varchar("current_stage", { length: 64 }),
  targetDurationSec: integer("target_duration_sec"),
  inputSha256: varchar("input_sha256", { length: 64 }).notNull(),
  draftJson: jsonb("draft_json").$type<Record<string, unknown>>().notNull(),
  validationJson: jsonb("validation_json").$type<Record<string, unknown>>().notNull(),
  usageJson: jsonb("usage_json").$type<Record<string, unknown>>().notNull(),
  estimatedCostFen: integer("estimated_cost_fen"),
  actualCostFen: integer("actual_cost_fen"),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: varchar("error_message", { length: 512 }),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
  confirmedAt: utcTimestamp("confirmed_at"),
  discardedByUserId: uuid("discarded_by_user_id").references(() => users.id),
  discardedAt: utcTimestamp("discarded_at"),
  supersededByRunId: uuid("superseded_by_run_id"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

export const scriptBreakdownRunStages = common.table("script_breakdown_run_stages", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull().references(() => scriptBreakdownRuns.id, { onDelete: "cascade" }),
  stageKey: varchar("stage_key", { length: 64 }).notNull(),
  stageOrder: integer("stage_order").notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  attemptCount: integer("attempt_count").notNull(),
  outputJson: jsonb("output_json").$type<Record<string, unknown>>(),
  validationJson: jsonb("validation_json").$type<Record<string, unknown>>().notNull(),
  usageJson: jsonb("usage_json").$type<Record<string, unknown>>().notNull(),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: varchar("error_message", { length: 512 }),
  startedAt: utcTimestamp("started_at"),
  completedAt: utcTimestamp("completed_at"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

export const assetEntities = common.table("asset_entities", {
  id: uuid("id").primaryKey(),
  copiedFromAssetEntityId: uuid("copied_from_asset_entity_id"),
  sourceProjectId: uuid("source_project_id"),
  sourceProjectName: varchar("source_project_name", { length: 128 }),
  ownerUserId: uuid("owner_user_id").references(() => users.id),
  visibility: varchar("visibility", { length: 16 }).notNull(),
  assetKind: varchar("asset_kind", { length: 20 }).notNull(),
  role: varchar("role", { length: 32 }),
  usageMode: varchar("usage_mode", { length: 16 }),
  name: varchar("name", { length: 128 }).notNull(),
  displayName: varchar("display_name", { length: 128 }),
  intro: text("intro"),
  appearance: text("appearance"),
  ageValue: integer("age_value"),
  gender: varchar("gender", { length: 16 }),
  heightCm: integer("height_cm"),
  hairDescription: varchar("hair_description", { length: 512 }),
  outfitDescription: text("outfit_description"),
  category: varchar("category", { length: 64 }),
  styleTags: jsonb("style_tags").$type<string[]>().notNull(),
  approved: boolean("approved"),
  reuseScope: varchar("reuse_scope", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  sourceFileUrl: varchar("source_file_url", { length: 1024 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  clearance: jsonb("clearance").$type<AssetClearance>().notNull().default(
    sql`'{"search": true, "gen_reference": true, "commercial_publish": false, "model_training": false}'::jsonb`,
  ),
  /** Maintained by migration 017; only approved human-facing retrieval fields. */
  searchText: text("search_text").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date" }).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).notNull(),
  useCount: integer("use_count").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

export const assetVariants = common.table("asset_variants", {
  id: uuid("id").primaryKey(),
  assetEntityId: uuid("asset_entity_id").notNull(),
  variantKind: varchar("variant_kind", { length: 32 }).notNull(),
  name: varchar("name", { length: 128 }).notNull(),
  description: text("description"),
  usageContext: varchar("usage_context", { length: 255 }),
  visualPrompt: text("visual_prompt"),
  approved: boolean("approved"),
  status: varchar("status", { length: 20 }).notNull(),
  isPrimary: boolean("is_primary").notNull(),
  sortOrder: integer("sort_order").notNull(),
  sourceFileUrl: varchar("source_file_url", { length: 1024 }),
  sourceText: text("source_text"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  /** Maintained by migration 017; only approved human-facing retrieval fields. */
  searchText: text("search_text").notNull().default(""),
  createdAt: timestamp("created_at", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

export const assetMedia = common.table("asset_media", {
  id: uuid("id").primaryKey(),
  assetEntityId: uuid("asset_entity_id"),
  assetVariantId: uuid("asset_variant_id"),
  mediaKind: varchar("media_kind", { length: 32 }).notNull(),
  viewAngle: varchar("view_angle", { length: 20 }),
  title: varchar("title", { length: 128 }),
  description: text("description"),
  storageBucket: varchar("storage_bucket", { length: 128 }),
  storagePath: varchar("storage_path", { length: 512 }),
  storageUrl: varchar("storage_url", { length: 1024 }),
  widthPx: integer("width_px"),
  heightPx: integer("height_px"),
  format: varchar("format", { length: 32 }),
  sha256: varchar("sha256", { length: 64 }),
  isPrimary: boolean("is_primary").notNull(),
  approved: boolean("approved"),
  sortOrder: integer("sort_order").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { mode: "date" }),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

export const videoIngestTasks = common.table("video_ingest_tasks", {
  id: uuid("id").primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assetEntityId: uuid("asset_entity_id").notNull().references(() => assetEntities.id, { onDelete: "restrict" }),
  assetMediaId: uuid("asset_media_id").notNull().references(() => assetMedia.id, { onDelete: "restrict" }),
  sourceVideoBucket: varchar("source_video_bucket", { length: 128 }).notNull(),
  sourceVideoPath: varchar("source_video_path", { length: 512 }).notNull(),
  operatorId: varchar("operator_id", { length: 64 }).notNull(),
  operatorVersion: varchar("operator_version", { length: 32 }).notNull(),
  operatorTaskId: varchar("operator_task_id", { length: 128 }),
  taskTemplate: varchar("task_template", { length: 64 }).notNull(),
  queryHash: varchar("query_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  rawResult: jsonb("raw_result").$type<Record<string, unknown>>(),
  normalizedResult: jsonb("normalized_result").$type<Record<string, unknown>>(),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: text("error_message"),
  startedAt: utcTimestamp("started_at"),
  completedAt: utcTimestamp("completed_at"),
  createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("video_ingest_tasks_queued_created_idx")
    .on(table.createdAt, table.id)
    .where(sql`${table.status} = 'queued'`),
  index("video_ingest_tasks_actor_created_idx")
    .on(table.actorUserId, table.createdAt.desc(), table.id.desc()),
  index("video_ingest_tasks_asset_media_idx")
    .on(table.assetMediaId, table.createdAt.desc(), table.id.desc()),
  uniqueIndex("video_ingest_tasks_active_media_unique")
    .on(table.assetMediaId)
    .where(sql`${table.status} in ('queued', 'processing')`),
  uniqueIndex("video_ingest_tasks_success_dedupe_unique")
    .on(table.assetMediaId, table.operatorId, table.operatorVersion, table.taskTemplate, table.queryHash)
    .where(sql`${table.status} = 'succeeded'`),
]);

/** Fixed, safe-to-display renditions derived from a source asset media row. */
export const assetMediaRenditions = common.table("asset_media_renditions", {
  id: uuid("id").primaryKey(),
  assetMediaId: uuid("asset_media_id").notNull().references(() => assetMedia.id, { onDelete: "restrict" }),
  renditionKind: varchar("rendition_kind", { length: 16 }).notNull(),
  strategy: varchar("strategy", { length: 16 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  processSpec: varchar("process_spec", { length: 1024 }),
  storageBucket: varchar("storage_bucket", { length: 128 }),
  storagePath: varchar("storage_path", { length: 512 }),
  storageUrl: varchar("storage_url", { length: 1024 }),
  sourceSha256: varchar("source_sha256", { length: 64 }),
  widthPx: integer("width_px"),
  heightPx: integer("height_px"),
  format: varchar("format", { length: 32 }),
  sha256: varchar("sha256", { length: 64 }),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: text("error_message"),
  checkedAt: utcTimestamp("checked_at"),
  createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("asset_media_renditions_media_kind_unique").on(table.assetMediaId, table.renditionKind),
  index("asset_media_renditions_status_checked_idx").on(table.status, table.checkedAt, table.id),
  check("asset_media_renditions_kind_check", sql`${table.renditionKind} in ('thumbnail', 'detail')`),
  check("asset_media_renditions_strategy_check", sql`${table.strategy} in ('tos_process', 'stored_object')`),
  check("asset_media_renditions_status_check", sql`${table.status} in ('pending', 'healthy', 'stale', 'failed')`),
  check("asset_media_renditions_healthy_facts_check", sql`${table.status} <> 'healthy' or (${table.strategy} = 'stored_object' and ${table.processSpec} is null and ${table.storageBucket} is not null and ${table.storagePath} ~ '^asset-renditions/v1/[0-9a-f]{2}/[0-9a-f]{64}[.]webp$' and ${table.storageUrl} is null and ${table.sourceSha256} is not null and ${table.checkedAt} is not null and ${table.widthPx} is not null and ${table.heightPx} is not null and lower(${table.format}) = 'webp' and ${table.sha256} is not null)`),
]);

/** Durable, request-idempotent safe media repair work. */
export const assetMediaRepairTasks = common.table("asset_media_repair_tasks", {
  id: uuid("id").primaryKey(),
  assetEntityId: uuid("asset_entity_id").notNull().references(() => assetEntities.id, { onDelete: "restrict" }),
  requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  clientIdempotencyKey: varchar("client_idempotency_key", { length: 255 }),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  mode: varchar("mode", { length: 16 }).notNull().default("safe"),
  trigger: varchar("trigger", { length: 16 }).notNull(),
  mediaIds: jsonb("media_ids").$type<string[]>().notNull().default([]),
  status: varchar("status", { length: 16 }).notNull().default("queued"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: utcTimestamp("lease_expires_at"),
  diagnosis: jsonb("diagnosis").$type<Record<string, unknown>>().notNull().default({}),
  result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: text("error_message"),
  createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  startedAt: utcTimestamp("started_at"),
  finishedAt: utcTimestamp("finished_at"),
  updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("asset_media_repair_tasks_actor_idempotency_unique")
    .on(table.requestedByUserId, table.clientIdempotencyKey)
    .where(sql`${table.requestedByUserId} is not null and ${table.clientIdempotencyKey} is not null`),
  index("asset_media_repair_tasks_asset_created_idx").on(table.assetEntityId, table.createdAt.desc(), table.id.desc()),
  index("asset_media_repair_tasks_queued_created_idx").on(table.createdAt, table.id).where(sql`${table.status} = 'queued'`),
  index("asset_media_repair_tasks_expired_lease_idx").on(table.leaseExpiresAt, table.id).where(sql`${table.status} = 'processing'`),
  uniqueIndex("asset_media_repair_tasks_active_asset_unique")
    .on(table.assetEntityId)
    .where(sql`${table.status} in ('queued', 'processing')`),
  check("asset_media_repair_tasks_mode_check", sql`${table.mode} = 'safe'`),
  check("asset_media_repair_tasks_trigger_check", sql`${table.trigger} in ('manual', 'self_heal', 'batch')`),
  check("asset_media_repair_tasks_manual_requester_check", sql`${table.trigger} <> 'manual' or ${table.requestedByUserId} is not null`),
  check("asset_media_repair_tasks_status_check", sql`${table.status} in ('queued', 'processing', 'succeeded', 'partial', 'failed')`),
  check("asset_media_repair_tasks_processing_lease_check", sql`(${table.status} = 'processing' and ${table.claimToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} <> 'processing' and ${table.claimToken} is null and ${table.leaseExpiresAt} is null)`),
]);

/** Last hard blocker per asset, keyed to the source state that caused it. */
export const assetMediaRepairBlockers = common.table("asset_media_repair_blockers", {
  assetEntityId: uuid("asset_entity_id").primaryKey().references(() => assetEntities.id, { onDelete: "restrict" }),
  stateFingerprint: varchar("state_fingerprint", { length: 32 }).notNull(),
  errorCode: varchar("error_code", { length: 64 }).notNull(),
  errorMessage: text("error_message"),
  blockedAt: utcTimestamp("blocked_at").notNull().defaultNow(),
  retryAfter: utcTimestamp("retry_after").notNull().default(sql`now() + interval '24 hours'`),
  updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("asset_media_repair_blockers_retry_idx").on(table.retryAfter, table.assetEntityId),
  check("asset_media_repair_blockers_fingerprint_check", sql`${table.stateFingerprint} ~ '^[0-9a-f]{32}$'`),
]);

/** Immutable per-media repair audit facts; updates and deletes are blocked in SQL. */
export const assetMediaRepairActions = common.table("asset_media_repair_actions", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").notNull().references(() => assetMediaRepairTasks.id, { onDelete: "restrict" }),
  assetMediaId: uuid("asset_media_id").notNull().references(() => assetMedia.id, { onDelete: "restrict" }),
  action: varchar("action", { length: 32 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  before: jsonb("before").$type<Record<string, unknown>>().notNull().default({}),
  after: jsonb("after").$type<Record<string, unknown>>().notNull().default({}),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: text("error_message"),
  createdAt: utcTimestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("asset_media_repair_actions_task_created_idx").on(table.taskId, table.createdAt, table.id),
  index("asset_media_repair_actions_media_created_idx").on(table.assetMediaId, table.createdAt, table.id),
  check("asset_media_repair_actions_action_check", sql`${table.action} in ('diagnose', 'create_rendition', 'refresh_rendition', 'refresh_metadata', 'register_object', 'mark_blocked')`),
  check("asset_media_repair_actions_status_check", sql`${table.status} in ('succeeded', 'skipped', 'blocked', 'failed')`),
]);

export const projectAssetRefs = common.table("project_asset_refs", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  assetEntityId: uuid("asset_entity_id").notNull().references(() => assetEntities.id),
  assetVariantId: uuid("asset_variant_id").references(() => assetVariants.id),
  assetMediaId: uuid("asset_media_id").references(() => assetMedia.id),
  versionSnapshot: jsonb("version_snapshot").$type<Record<string, unknown>>().notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

/** R161 scene-level prep truth. Committing without shots stops at project refs. */
export const scenePrepItems = common.table("scene_prep_items", {
  id: uuid("id").primaryKey(),
  sceneId: uuid("scene_id").notNull().references(() => scenes.id, { onDelete: "cascade" }),
  lane: varchar("lane", { length: 24 }).notNull(),
  assetEntityId: uuid("asset_entity_id").notNull().references(() => assetEntities.id),
  assetVariantId: uuid("asset_variant_id").references(() => assetVariants.id),
  assetMediaId: uuid("asset_media_id").references(() => assetMedia.id),
  status: varchar("status", { length: 16 }).notNull(),
  projectAssetRefId: uuid("project_asset_ref_id").references(() => projectAssetRefs.id),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  committedByUserId: uuid("committed_by_user_id").references(() => users.id),
  clientIdempotencyKey: varchar("client_idempotency_key", { length: 255 }).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  committedAt: utcTimestamp("committed_at"),
}, (table) => [
  uniqueIndex("scene_prep_items_scene_lane_asset_unique")
    .on(table.sceneId, table.lane, table.assetEntityId),
  uniqueIndex("scene_prep_items_actor_key_unique")
    .on(table.createdByUserId, table.clientIdempotencyKey),
  index("scene_prep_items_scene_status_created_idx")
    .on(table.sceneId, table.status, table.createdAt, table.id),
]);

/** Request-level idempotency receipt for an atomic prep commit. */
export const scenePrepCommits = common.table("scene_prep_commits", {
  id: uuid("id").primaryKey(),
  sceneId: uuid("scene_id").notNull().references(() => scenes.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  clientIdempotencyKey: varchar("client_idempotency_key", { length: 255 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  targetMode: varchar("target_mode", { length: 16 }).notNull(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("scene_prep_commits_actor_key_unique")
    .on(table.userId, table.clientIdempotencyKey),
  index("scene_prep_commits_scene_created_idx")
    .on(table.sceneId, table.createdAt.desc(), table.id.desc()),
]);

export const projectReviewPolicies = common.table("project_review_policies", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  defaultStrategy: varchar("default_strategy", { length: 24 }).notNull(),
  updatedByUserId: uuid("updated_by_user_id").notNull().references(() => users.id),
  reviewerUserId: uuid("reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
  version: integer("version").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("project_review_policies_project_media_unique").on(table.projectId, table.mediaKind),
]);

export const assetReviewActions = common.table("asset_review_actions", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  assetEntityId: uuid("asset_entity_id").notNull().references(() => assetEntities.id),
  action: varchar("action", { length: 24 }).notNull(),
  fromStatus: varchar("from_status", { length: 24 }).notNull(),
  toStatus: varchar("to_status", { length: 24 }).notNull(),
  reviewerUserId: uuid("reviewer_user_id").notNull().references(() => users.id),
  assignedReviewerUserId: uuid("assigned_reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
  rejectionReason: text("rejection_reason"),
  createdAt: utcTimestamp("created_at").notNull(),
});

export const generationRequests = common.table("generation_requests", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  episodeId: uuid("episode_id").references(() => episodes.id),
  sceneId: uuid("scene_id").references(() => scenes.id),
  shotId: uuid("shot_id").references(() => shots.id),
  targetAssetEntityId: uuid("target_asset_entity_id").references(() => assetEntities.id),
  /** v1.9 十.10：从哪个变体发起的生成，产物就归属哪个变体（缺省回落第一变体）。 */
  targetAssetVariantId: uuid("target_asset_variant_id").references(() => assetVariants.id),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  prompt: text("prompt").notNull(),
  referenceMediaIds: jsonb("reference_media_ids").$type<string[]>().notNull(),
  referenceAssetSnapshots: jsonb("reference_asset_snapshots").$type<Array<Record<string, unknown>>>().notNull(),
  parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
  quantity: integer("quantity").notNull(),
  clientIdempotencyKey: varchar("client_idempotency_key", { length: 255 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  chargedPoints: integer("charged_points").notNull().default(0),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

/** 创作广场（项目维度）独立生成记录：只记广场发起的生成，右栏列表/回显唯一真源；
    计费/队列真源是 generation_requests，本表为广场台账+回显快照（迁移 073）。 */
export const plazaRecords = common.table("plaza_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id),
  generationRequestId: uuid("generation_request_id").notNull().references(() => generationRequests.id, { onDelete: "cascade" }),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  prompt: text("prompt").notNull().default(""),
  tierId: varchar("tier_id", { length: 128 }),
  parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
  referenceManifest: jsonb("reference_manifest").$type<Array<Record<string, unknown>>>().notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  index("plaza_records_project_created_idx").on(table.projectId, table.createdAt),
]);

/**
 * 每个项目、每种媒体只有一条当前默认策略。
 *
 * 它保存的是人在测试域确认过的“模式 + 模型 + 参数”，不是供应商密钥、
 * 原始响应或自动生成指令。实际付费生成仍必须走单任务人工提交链路。
 */
export const generationDefaultStrategies = common.table("generation_default_strategies", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  mode: varchar("mode", { length: 32 }).notNull(),
  modelKey: varchar("model_key", { length: 128 }).notNull(),
  parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
  sourceGenerationRequestId: uuid("source_generation_request_id")
    .references(() => generationRequests.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").notNull().references(() => users.id),
  version: integer("version").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("generation_default_strategies_project_media_unique").on(table.projectId, table.mediaKind),
]);

/**
 * Lite 项目级提示词模板库（docs/design/prd-v2/lite-model-defaults.md §4.3）。
 * 只存用户自建模板；系统默认模板见 prompt_default_templates（迁移 064，v1.0 起）。
 * 生效 = 引用关系（generation_default_strategies.parameters->>'prompt_template_id'），
 * 不是本表的行属性。软删（R1 禁硬删）：仅置 deleted_at + deleted_by_user_id。
 */
export const promptTemplates = common.table("prompt_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  content: text("content").notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
  deletedAt: utcTimestamp("deleted_at"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("prompt_templates_project_kind_name_active_key")
    .on(table.projectId, table.mediaKind, table.name)
    .where(sql`${table.deletedAt} is null`),
  index("prompt_templates_project_kind_idx").on(table.projectId, table.mediaKind, table.createdAt),
]);

/**
 * Lite 项目级风格库（docs/design/prd-v2/lite-config-tabs-and-style.md §4.4）。
 * 风格 = 一段 ≤5000 字的画面基调描述，可多条；每项目每媒介至多 1 个默认
 * （project_styles_one_default_key 部分唯一索引兜底并发）。
 * 生成期：默认风格内容镜像写 projects.image_style_description / video_style_description，
 * 服务端 resolveProjectGenerationConfig 读取同一列 → 生成链路零改动（§4.6）。
 * 默认风格不锁定（D1 2026-08-17 修订）：随时可编辑/换设/取消/删除，全程可逆，默认可为空；
 * 编辑/换设/取消/删除默认行均同事务同步镜像列（project-styles/repository.ts）。
 * 软删（R1 禁硬删）：仅置 deleted_at + deleted_by_user_id。
 */
export const projectStyles = common.table("project_styles", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  content: text("content").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
  deletedAt: utcTimestamp("deleted_at"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("project_styles_project_kind_name_active_key")
    .on(table.projectId, table.mediaKind, table.name)
    .where(sql`${table.deletedAt} is null`),
  uniqueIndex("project_styles_one_default_key")
    .on(table.projectId, table.mediaKind)
    .where(sql`${table.deletedAt} is null and ${table.isDefault}`),
  index("project_styles_project_kind_idx").on(table.projectId, table.mediaKind, table.createdAt),
]);

/**
 * 平台默认提示词模板（docs/design/prd-v2/lite-model-defaults.md v1.0）。
 * 资产生图 image_prompt 默认模板 + 视频 video_prompt 默认模板，作为**默认配置**落库，
 * 由迁移 064 播种——任何本地环境 `npm run db:migrate` 后即存在，不依赖代码常量。
 * 读侧：GET /generation/default-prompt-templates 读本表，缺行时回落代码常量
 * （DEFAULT_IMAGE_PROMPT_TEMPLATE / DEFAULT_VIDEO_PROMPT_TEMPLATE）。
 */
export const promptDefaultTemplates = common.table("prompt_default_templates", {
  mediaKind: varchar("media_kind", { length: 16 }).primaryKey(),
  content: text("content").notNull(),
  version: varchar("version", { length: 32 }).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

export const pricingRules = common.table("pricing_rules", {
  id: uuid("id").primaryKey(),
  provider: varchar("provider", { length: 32 }).notNull(),
  model: varchar("model", { length: 128 }).notNull(),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  billingUnit: varchar("billing_unit", { length: 32 }).notNull(),
  unitPriceFen: integer("unit_price_fen").notNull(),
  currency: varchar("currency", { length: 8 }).notNull(),
  source: varchar("source", { length: 512 }).notNull(),
  active: boolean("active").notNull(),
  effectiveFrom: utcTimestamp("effective_from").notNull(),
  effectiveTo: utcTimestamp("effective_to"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

/** S57 email-registration proof. The raw verification code never reaches PostgreSQL. */
export const emailVerificationCodes = common.table("email_verification_codes", {
  id: uuid("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  purpose: varchar("purpose", { length: 32 }).notNull(),
  codeHash: text("code_hash").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  expiresAt: utcTimestamp("expires_at").notNull(),
  consumedAt: utcTimestamp("consumed_at"),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  index("email_verification_codes_lookup_idx")
    .on(table.email, table.purpose, table.createdAt.desc(), table.id.desc())
    .where(sql`${table.consumedAt} is null`),
]);

/** One row keeps the no-invite daily allowance adjustable without a deploy. */
export const accountCreditPolicies = common.table("account_credit_policies", {
  policyKey: varchar("policy_key", { length: 64 }).primaryKey(),
  dailyLimitPoints: integer("daily_limit_points").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

/** Admin-editable templates for codes issued after an edit. */
export const inviteTiers = common.table("invite_tiers", {
  id: uuid("id").primaryKey(),
  tierKey: varchar("tier_key", { length: 64 }).notNull(),
  displayName: varchar("display_name", { length: 128 }).notNull(),
  grantPoints: integer("grant_points").notNull(),
  dailyLimitPoints: integer("daily_limit_points").notNull(),
  active: boolean("active").notNull().default(true),
  createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [uniqueIndex("invite_tiers_key_unique").on(table.tierKey)]);

/** A code snapshots tier values at issue time; editing a tier never rewrites a handed-out code. */
export const inviteCodes = common.table("invite_codes", {
  id: uuid("id").primaryKey(),
  codeHash: varchar("code_hash", { length: 64 }).notNull(),
  codePrefix: varchar("code_prefix", { length: 16 }).notNull(),
  tierId: uuid("tier_id").notNull().references(() => inviteTiers.id, { onDelete: "restrict" }),
  tierKey: varchar("tier_key", { length: 64 }).notNull(),
  grantPoints: integer("grant_points").notNull(),
  dailyLimitPoints: integer("daily_limit_points").notNull(),
  expiresAt: utcTimestamp("expires_at"),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  status: varchar("status", { length: 16 }).notNull().default("active"),
  // Null means the one platform-issued pilot code; the table CHECK keeps every
  // administrator-issued code attributable to its actor.
  issuedByUserId: uuid("issued_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("invite_codes_hash_unique").on(table.codeHash),
  check(
    "invite_codes_issuer_provenance_check",
    sql`${table.issuedByUserId} IS NOT NULL OR (${table.id} = '3d0222ba-7c6f-4ffc-901f-510c3e4aa003'::uuid AND ${table.codeHash} = '9b062e193fc35fbf9267d3f5ec74324edb9f7dd07f333e7b0eb8c5b8f771638a')`,
  ),
  index("invite_codes_active_lookup_idx")
    .on(table.status, table.expiresAt, table.createdAt.desc())
    .where(sql`${table.status} = 'active'`),
]);

/** User-owned balance and daily ceiling. Points are integer fen, fixed 1:1 by DC. */
export const userCreditAccounts = common.table("user_credit_accounts", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  balancePoints: integer("balance_points").notNull().default(0),
  dailyLimitPoints: integer("daily_limit_points").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

export const userCreditDailyUsage = common.table("user_credit_daily_usage", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  usageDate: date("usage_date").notNull(),
  chargedPoints: integer("charged_points").notNull().default(0),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.usageDate], name: "user_credit_daily_usage_pkey" })]);

/** Immutable balance movements. Generation debits reference the consumed quote. */
export const userCreditLedgerEntries = common.table("user_credit_ledger_entries", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  entryKind: varchar("entry_kind", { length: 32 }).notNull(),
  pointsDelta: integer("points_delta").notNull(),
  balanceAfterPoints: integer("balance_after_points").notNull(),
  sourceType: varchar("source_type", { length: 64 }).notNull(),
  sourceId: uuid("source_id"),
  generationRequestId: uuid("generation_request_id").references(() => generationRequests.id, { onDelete: "restrict" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("user_credit_ledger_generation_quote_once")
    .on(table.sourceType, table.sourceId)
    .where(sql`${table.entryKind} = 'generation_debit' and ${table.sourceType} = 'generation_quote' and ${table.sourceId} is not null`),
  index("user_credit_ledger_user_created_idx").on(table.userId, table.createdAt.desc(), table.id.desc()),
]);

export const inviteCodeRedemptions = common.table("invite_code_redemptions", {
  id: uuid("id").primaryKey(),
  inviteCodeId: uuid("invite_code_id").notNull().references(() => inviteCodes.id, { onDelete: "restrict" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  grantPoints: integer("grant_points").notNull(),
  dailyLimitPoints: integer("daily_limit_points").notNull(),
  redeemedAt: utcTimestamp("redeemed_at").notNull(),
}, (table) => [
  uniqueIndex("invite_code_redemptions_code_user_unique").on(table.inviteCodeId, table.userId),
  index("invite_code_redemptions_user_idx").on(table.userId, table.redeemedAt.desc()),
]);

export const generationAttempts = common.table("generation_attempts", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id").notNull().references(() => generationRequests.id),
  attemptNo: integer("attempt_no").notNull(),
  retryIdempotencyKey: varchar("retry_idempotency_key", { length: 255 }),
  provider: varchar("provider", { length: 32 }).notNull(),
  providerTaskId: varchar("provider_task_id", { length: 255 }),
  model: varchar("model", { length: 128 }).notNull(),
  parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
  quantity: integer("quantity").notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  phase: varchar("phase", { length: 32 }).notNull(),
  providerStatus: varchar("provider_status", { length: 64 }),
  providerResponse: jsonb("provider_response").$type<Record<string, unknown>>(),
  errorCode: varchar("error_code", { length: 128 }),
  errorMessage: text("error_message"),
  retryable: boolean("retryable").notNull(),
  estimatedCostFen: integer("estimated_cost_fen").notNull(),
  actualCostFen: integer("actual_cost_fen"),
  actualCostStatus: varchar("actual_cost_status", { length: 20 }).notNull(),
  pricingRuleId: uuid("pricing_rule_id").references(() => pricingRules.id),
  priceSnapshot: jsonb("price_snapshot").$type<Record<string, unknown>>().notNull(),
  lastQueryError: text("last_query_error"),
  nextPollAt: utcTimestamp("next_poll_at"),
  lastPolledAt: utcTimestamp("last_polled_at"),
  leaseOwner: varchar("lease_owner", { length: 128 }),
  leaseUntil: utcTimestamp("lease_until"),
  submittedAt: utcTimestamp("submitted_at"),
  startedAt: utcTimestamp("started_at"),
  finishedAt: utcTimestamp("finished_at"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

/**
 * One durable, user-scoped station notification for each succeeded or
 * definitely failed generation attempt. The attempt remains the outcome truth,
 * so this table deliberately stores no frozen notification-status/type enum.
 */
export const generationAttemptNotifications = common.table("generation_attempt_notifications", {
  id: uuid("id").primaryKey(),
  attemptId: uuid("attempt_id").notNull().references(() => generationAttempts.id, { onDelete: "cascade" }),
  generationRequestId: uuid("generation_request_id").notNull().references(() => generationRequests.id),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  acknowledgedAt: utcTimestamp("acknowledged_at"),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("generation_attempt_notifications_attempt_unique").on(table.attemptId),
  index("generation_attempt_notifications_unread_user_created_idx")
    .on(table.userId, table.createdAt.desc(), table.id.desc())
    .where(sql`${table.acknowledgedAt} is null`),
]);

/**
 * S42 upload submission queue: one row per accepted image upload task.
 * The row is the queue-position/ETA/terminal-notification fact at once —
 * same waiting-period contract as generation attempts, not a second one.
 * Status moves queued → processing → succeeded/failed on the worker side only.
 */
export const assetUploadTasks = common.table("asset_upload_tasks", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientIdempotencyKey: uuid("client_idempotency_key"),
  status: varchar("status", { length: 16 }).notNull(),
  originalFileName: varchar("original_file_name", { length: 255 }).notNull(),
  contentType: varchar("content_type", { length: 128 }),
  assetKindHint: varchar("asset_kind_hint", { length: 32 }),
  contentSha256: varchar("content_sha256", { length: 64 }),
  requestSha256: varchar("request_sha256", { length: 64 }),
  registrationForm: jsonb("registration_form").$type<Record<string, unknown>>(),
  stagedPath: text("staged_path").notNull(),
  stagedBytes: integer("staged_bytes").notNull(),
  resultAssetEntityId: uuid("result_asset_entity_id").references(() => assetEntities.id),
  resultAssetMediaId: uuid("result_asset_media_id").references(() => assetMedia.id),
  // SQL migration owns this FK because the registration table is declared
  // later in this module and cannot be referenced safely at runtime here.
  resultRegistrationId: uuid("result_registration_id"),
  resultRegistrationStatus: varchar("result_registration_status", { length: 24 }),
  registrationErrorCode: varchar("registration_error_code", { length: 64 }),
  registrationErrorMessage: text("registration_error_message"),
  resultAssetName: varchar("result_asset_name", { length: 255 }),
  errorCode: varchar("error_code", { length: 64 }),
  errorMessage: text("error_message"),
  durationSeconds: integer("duration_seconds"),
  acknowledgedAt: utcTimestamp("acknowledged_at"),
  createdAt: utcTimestamp("created_at").notNull(),
  startedAt: utcTimestamp("started_at"),
  finishedAt: utcTimestamp("finished_at"),
}, (table) => [
  index("asset_upload_tasks_queued_created_idx")
    .on(table.createdAt, table.id)
    .where(sql`${table.status} = 'queued'`),
  index("asset_upload_tasks_unread_user_created_idx")
    .on(table.userId, table.createdAt.desc(), table.id.desc())
    .where(sql`${table.acknowledgedAt} is null`),
  uniqueIndex("asset_upload_tasks_user_idempotency_unique")
    .on(table.userId, table.clientIdempotencyKey)
    .where(sql`${table.clientIdempotencyKey} is not null`),
]);

/**
 * One human confirmation over a complete, frozen batch-estimate list. This is
 * the authorization/audit fact; individual quotes and attempts remain the
 * source of truth for each paid generation item.
 */
export const generationBatchAuthorizations = common.table("generation_batch_authorizations", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  projectId: uuid("project_id").notNull().references(() => projects.id),
  clientIdempotencyKey: varchar("client_idempotency_key", { length: 255 }).notNull(),
  listHash: varchar("list_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  authorizedTotalEstimatedCostFen: integer("authorized_total_estimated_cost_fen").notNull(),
  submittedTotalEstimatedCostFen: integer("submitted_total_estimated_cost_fen").notNull(),
  currency: varchar("currency", { length: 8 }).notNull(),
  authorizedAt: utcTimestamp("authorized_at").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("generation_batch_authorizations_user_key_unique")
    .on(table.userId, table.clientIdempotencyKey),
  index("generation_batch_authorizations_project_authorized_idx")
    .on(table.projectId, table.authorizedAt.desc(), table.id.desc()),
]);

export const generationQuotes = common.table("generation_quotes", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  source: varchar("source", { length: 16 }).notNull(),
  action: varchar("action", { length: 16 }).notNull(),
  // The SQL migration keeps the FK. This table is declared before agentSessions
  // here, so the Drizzle definition deliberately avoids a forward runtime reference.
  assistantSessionId: uuid("assistant_session_id"),
  originalRequestId: uuid("original_request_id").references(() => generationRequests.id),
  baseAttemptId: uuid("base_attempt_id").references(() => generationAttempts.id),
  baseAttemptNo: integer("base_attempt_no"),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  normalizedRequest: jsonb("normalized_request").$type<Record<string, unknown>>().notNull(),
  pricingRuleId: uuid("pricing_rule_id").notNull().references(() => pricingRules.id),
  priceSnapshot: jsonb("price_snapshot").$type<Record<string, unknown>>().notNull(),
  estimatedCostFen: integer("estimated_cost_fen").notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  expiresAt: utcTimestamp("expires_at").notNull(),
  confirmedAt: utcTimestamp("confirmed_at"),
  confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id, { onDelete: "restrict" }),
  consumedAt: utcTimestamp("consumed_at"),
  generationRequestId: uuid("generation_request_id").references(() => generationRequests.id),
  generationAttemptId: uuid("generation_attempt_id").references(() => generationAttempts.id),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

/**
 * Quote-linked failure facts for provider media that failed the platform AIGC
 * gate. This is a pending compensation input, not an automatic refund.
 */
export const generationBillingFailureFacts = common.table("generation_billing_failure_facts", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
  attemptId: uuid("attempt_id").notNull().references(() => generationAttempts.id, { onDelete: "restrict" }),
  quoteId: uuid("quote_id").notNull().references(() => generationQuotes.id, { onDelete: "restrict" }),
  failureCode: varchar("failure_code", { length: 128 }).notNull(),
  reservedAmountFen: integer("reserved_amount_fen").notNull(),
  providerCostStatus: varchar("provider_cost_status", { length: 32 }).notNull(),
  resolutionStatus: varchar("resolution_status", { length: 32 }).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("generation_billing_failure_attempt_quote_unique").on(table.attemptId, table.quoteId),
  index("generation_billing_failure_quote_idx").on(table.quoteId),
  index("generation_billing_failure_user_created_idx").on(table.userId, table.createdAt, table.id),
  index("generation_billing_failure_project_created_idx").on(table.projectId, table.createdAt, table.id),
  index("generation_billing_failure_resolution_created_idx")
    .on(table.resolutionStatus, table.createdAt, table.id),
  check("generation_billing_failure_amount_check", sql`${table.reservedAmountFen} >= 0`),
  check("generation_billing_failure_provider_cost_status_check", sql`${table.providerCostStatus} = 'incurred'`),
  check(
    "generation_billing_failure_resolution_status_check",
    sql`${table.resolutionStatus} = 'pending_compensation'`,
  ),
]);

/** Ordered, durable copy of the exact list a user authorized and each outcome. */
export const generationBatchAuthorizationItems = common.table("generation_batch_authorization_items", {
  id: uuid("id").primaryKey(),
  authorizationId: uuid("authorization_id").notNull()
    .references(() => generationBatchAuthorizations.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  itemId: varchar("item_id", { length: 128 }).notNull(),
  generationQuoteId: uuid("generation_quote_id").notNull().references(() => generationQuotes.id),
  estimatedCostFen: integer("estimated_cost_fen").notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  failureCode: varchar("failure_code", { length: 128 }),
  failureMessage: text("failure_message"),
  failureStatusCode: integer("failure_status_code"),
  failureDetails: jsonb("failure_details").$type<Record<string, unknown>>(),
  generationRequestId: uuid("generation_request_id").references(() => generationRequests.id),
  generationAttemptId: uuid("generation_attempt_id").references(() => generationAttempts.id),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("generation_batch_authorization_items_position_unique")
    .on(table.authorizationId, table.position),
  uniqueIndex("generation_batch_authorization_items_item_unique")
    .on(table.authorizationId, table.itemId),
  uniqueIndex("generation_batch_authorization_items_quote_unique")
    .on(table.authorizationId, table.generationQuoteId),
  index("generation_batch_authorization_items_attempt_idx")
    .on(table.generationAttemptId)
    .where(sql`${table.generationAttemptId} is not null`),
]);

/**
 * v1.4 版本标签(065):`metadata.shot_version.label` 为用户可改的版本标签;
 * 版本号本身由查询时按同 shot_id+media_kind='video' 的 created_at 升序行号计算,
 * 不落库。与合规元数据 compliance_metadata 语义不同,分列存。
 */
export interface MediaResultMetadata {
  shot_version?: { label?: string | null; note?: string | null } | null;
  /* 预览档身份标记(happyhorse 预览集成 §2):parameters.preview=true 的请求落库时写入;
     历史行无此键=正式视频,读侧一律按 falsy 处理,不回填。 */
  preview?: boolean | null;
}

export const mediaResults = common.table("media_results", {
  id: uuid("id").primaryKey(),
  requestId: uuid("request_id").references(() => generationRequests.id),
  attemptId: uuid("attempt_id").references(() => generationAttempts.id),
  shotId: uuid("shot_id").references(() => shots.id),
  originKind: varchar("origin_kind", { length: 24 }).notNull(),
  sourceAssetMediaId: uuid("source_asset_media_id").references(() => assetMedia.id),
  registeredByUserId: uuid("registered_by_user_id").references(() => users.id),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  resultIndex: integer("result_index").notNull(),
  providerResultKey: varchar("provider_result_key", { length: 512 }),
  providerUrl: text("provider_url"),
  providerUrlExpiresAt: utcTimestamp("provider_url_expires_at"),
  persistenceStatus: varchar("persistence_status", { length: 32 }).notNull(),
  storageBucket: varchar("storage_bucket", { length: 128 }),
  storagePath: varchar("storage_path", { length: 1024 }),
  storageUrl: text("storage_url"),
  sha256: varchar("sha256", { length: 64 }),
  mimeType: varchar("mime_type", { length: 128 }),
  widthPx: integer("width_px"),
  heightPx: integer("height_px"),
  durationSeconds: integer("duration_seconds"),
  reviewStatus: varchar("review_status", { length: 20 }).notNull(),
  complianceMetadata: jsonb("compliance_metadata").$type<Record<string, unknown>>().default({}),
  /** v1.4 版本标签(065),见 {@link MediaResultMetadata}。 */
  metadata: jsonb("metadata").$type<MediaResultMetadata>().default({}).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

/**
 * Object-level TOS ledger. An upload is pending cleanup until a live media row
 * references it; terminal partial-output withdrawal moves it back to pending.
 * S49 records facts only and never deletes the object.
 */
export const generationTosOrphans = common.table("generation_tos_orphans", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
  attemptId: uuid("attempt_id").notNull().references(() => generationAttempts.id, { onDelete: "restrict" }),
  mediaResultId: uuid("media_result_id").references(() => mediaResults.id, { onDelete: "set null" }),
  providerResultKey: varchar("provider_result_key", { length: 512 }).notNull(),
  storageBucket: varchar("storage_bucket", { length: 128 }).notNull(),
  objectKey: varchar("object_key", { length: 1024 }).notNull(),
  producedAt: utcTimestamp("produced_at").notNull(),
  cleanupStatus: varchar("cleanup_status", { length: 32 }).notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("generation_tos_orphans_bucket_key_unique").on(table.storageBucket, table.objectKey),
  index("generation_tos_orphans_user_created_idx").on(table.userId, table.createdAt, table.id),
  index("generation_tos_orphans_project_created_idx").on(table.projectId, table.createdAt, table.id),
  index("generation_tos_orphans_cleanup_created_idx")
    .on(table.cleanupStatus, table.producedAt, table.id),
  index("generation_tos_orphans_attempt_idx").on(table.attemptId, table.id),
  index("generation_tos_orphans_media_result_idx").on(table.mediaResultId),
  check(
    "generation_tos_orphans_cleanup_status_check",
    sql`${table.cleanupStatus} in ('pending_cleanup', 'referenced')`,
  ),
]);

/**
 * Immutable, server-owned identity for either an uploaded local asset or a
 * generated result.  `media_provenance_parent_edges` is the only lineage
 * graph; JSON metadata and client request fields never participate in it.
 */
export const mediaProvenanceSubjects = common.table("media_provenance_subjects", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  assetMediaId: uuid("asset_media_id").references(() => assetMedia.id, { onDelete: "restrict" }),
  mediaResultId: uuid("media_result_id").references(() => mediaResults.id, { onDelete: "restrict" }),
  sourceChannel: varchar("source_channel", { length: 32 }).notNull(),
  sourceGenerationAttemptId: uuid("source_generation_attempt_id")
    .references(() => generationAttempts.id, { onDelete: "restrict" }),
  providerAssetId: varchar("provider_asset_id", { length: 255 }),
  observedAt: utcTimestamp("observed_at").notNull(),
}, (table) => [
  uniqueIndex("media_provenance_subject_asset_media_unique")
    .on(table.assetMediaId)
    .where(sql`${table.assetMediaId} is not null`),
  uniqueIndex("media_provenance_subject_media_result_unique")
    .on(table.mediaResultId)
    .where(sql`${table.mediaResultId} is not null`),
  index("media_provenance_subject_channel_observed_idx").on(table.sourceChannel, table.observedAt, table.id),
]);

/** Immutable direct parent edges between asset-media and/or result subjects. */
export const mediaProvenanceParentEdges = common.table("media_provenance_parent_edges", {
  childSubjectId: bigint("child_subject_id", { mode: "number" })
    .notNull().references(() => mediaProvenanceSubjects.id, { onDelete: "restrict" }),
  parentSubjectId: bigint("parent_subject_id", { mode: "number" })
    .notNull().references(() => mediaProvenanceSubjects.id, { onDelete: "restrict" }),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.childSubjectId, table.parentSubjectId] }),
  index("media_provenance_parent_edges_parent_child_idx").on(table.parentSubjectId, table.childSubjectId),
]);

/** PostgreSQL-owned recursive closure projection from migration 035. */
export const mediaProvenanceAuthority = common.view("media_provenance_authority", {
  id: bigint("id", { mode: "number" }).notNull(),
  assetMediaId: uuid("asset_media_id"),
  mediaResultId: uuid("media_result_id"),
  sourceChannel: varchar("source_channel", { length: 32 }).notNull(),
  sourceGenerationAttemptId: uuid("source_generation_attempt_id"),
  providerAssetId: varchar("provider_asset_id", { length: 255 }),
  observedAt: utcTimestamp("observed_at").notNull(),
  containsExternalImageAncestor: boolean("contains_external_image_ancestor").notNull(),
}).existing();

/**
 * 音频候选版本的生命周期事实。媒体对象与成本仍以 generation/media 主链为
 * 真源；此表保留字幕/合规快照及「候选没有自动进输入包」的显式状态动作。
 */
export const audioVersions = common.table("audio_versions", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  generationRequestId: uuid("generation_request_id").references(() => generationRequests.id, { onDelete: "set null" }),
  mediaResultId: uuid("media_result_id").notNull().references(() => mediaResults.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 16 }).notNull().default("candidate"),
  subtitleJson: jsonb("subtitle_json").$type<unknown>(),
  complianceMetadata: jsonb("compliance_metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  selectedByUserId: uuid("selected_by_user_id").references(() => users.id),
  selectedAt: utcTimestamp("selected_at"),
  discardedByUserId: uuid("discarded_by_user_id").references(() => users.id),
  discardedAt: utcTimestamp("discarded_at"),
  // 029 固化了 locked 后三条正式引用：硬删除被 RESTRICT，避免事实被 SET NULL 降格。
  lockedAssetEntityId: uuid("locked_asset_entity_id").references(() => assetEntities.id, { onDelete: "restrict" }),
  lockedAssetMediaId: uuid("locked_asset_media_id").references(() => assetMedia.id, { onDelete: "restrict" }),
  projectAssetRefId: uuid("project_asset_ref_id").references(() => projectAssetRefs.id, { onDelete: "restrict" }),
  lockedAt: utcTimestamp("locked_at"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("audio_versions_media_result_unique").on(table.mediaResultId),
  index("audio_versions_project_status_updated_idx").on(table.projectId, table.status, table.updatedAt.desc(), table.id.desc()),
  index("audio_versions_generation_request_idx")
    .on(table.generationRequestId)
    .where(sql`${table.generationRequestId} is not null`),
]);

/**
 * Product review audit trail (output-review-and-delivery-gate contract).
 * `reviewerUserId` is null only for the system `auto_accepted` action so a
 * machine decision can never masquerade as a human confirmation.
 */
export const mediaReviewActions = common.table("media_review_actions", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  mediaResultId: uuid("media_result_id").notNull().references(() => mediaResults.id),
  action: varchar("action", { length: 24 }).notNull(),
  fromStatus: varchar("from_status", { length: 20 }).notNull(),
  toStatus: varchar("to_status", { length: 20 }).notNull(),
  reviewerUserId: uuid("reviewer_user_id").references(() => users.id),
  assignedReviewerUserId: uuid("assigned_reviewer_user_id").references(() => users.id, { onDelete: "set null" }),
  rejectionReason: text("rejection_reason"),
  createdAt: utcTimestamp("created_at").notNull(),
});

/**
 * One row per delivery/export: which episode was delivered, which version of
 * the manifest, who did it and when. Snapshots are never rewritten afterwards.
 */
export const deliveryRecords = common.table("delivery_records", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  episodeId: uuid("episode_id").notNull().references(() => episodes.id, { onDelete: "cascade" }),
  manifestHash: varchar("manifest_hash", { length: 64 }).notNull(),
  mediaResultIds: jsonb("media_result_ids").$type<string[]>().notNull(),
  partial: boolean("partial").notNull().default(false),
  missingShotCodes: jsonb("missing_shot_codes").$type<string[]>().notNull(),
  purpose: text("purpose"),
  deliveredByUserId: uuid("delivered_by_user_id").notNull().references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
});

/**
 * Idempotent local truth for one Ark AIGC asset group. Provider writes are
 * deliberately represented before they happen so ambiguous outcomes cannot
 * be retried automatically.
 */
export const volcAssetGroups = common.table("volc_asset_groups", {
  id: uuid("id").primaryKey(),
  name: varchar("name", { length: 64 }).notNull(),
  description: varchar("description", { length: 300 }).notNull(),
  groupType: varchar("group_type", { length: 32 }).notNull().default("AIGC"),
  projectName: varchar("project_name", { length: 128 }).notNull(),
  volcAssetGroupId: varchar("volc_asset_group_id", { length: 128 }),
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  source: varchar("source", { length: 16 }).notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  lastActionByUserId: uuid("last_action_by_user_id").notNull().references(() => users.id),
  latestRequestId: varchar("latest_request_id", { length: 128 }),
  latestErrorCode: varchar("latest_error_code", { length: 128 }),
  latestErrorMessage: varchar("latest_error_message", { length: 512 }),
  retryCount: integer("retry_count").notNull().default(0),
  lastAttemptAt: utcTimestamp("last_attempt_at"),
  lastRetryAt: utcTimestamp("last_retry_at"),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("volc_asset_groups_identity_unique").on(table.projectName, table.groupType, table.name),
  uniqueIndex("volc_asset_groups_remote_id_unique")
    .on(table.volcAssetGroupId)
    .where(sql`${table.volcAssetGroupId} is not null`),
  index("volc_asset_groups_status_updated_idx").on(table.status, table.updatedAt.desc(), table.id.desc()),
]);

/**
 * Provider-side Seedance asset registration.
 *
 * `asset_media` remains the local media truth (including TOS location). This
 * table only maps that media to an opaque remote Asset ID and its usable state.
 */
export const seedanceAssetRegistrations = common.table("seedance_asset_registrations", {
  id: uuid("id").primaryKey(),
  assetMediaId: uuid("asset_media_id").notNull().references(() => assetMedia.id),
  sourceMediaResultId: uuid("source_media_result_id").references(() => mediaResults.id),
  assetGroupId: varchar("asset_group_id", { length: 128 }),
  projectName: varchar("project_name", { length: 128 }).notNull(),
  remoteAssetId: varchar("remote_asset_id", { length: 255 }),
  remoteAssetName: varchar("remote_asset_name", { length: 64 }),
  status: varchar("status", { length: 16 }).notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  lastActionByUserId: uuid("last_action_by_user_id").notNull().references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  lastActionAt: utcTimestamp("last_action_at").notNull(),
  activatedAt: utcTimestamp("activated_at"),
  authorizationExpiresAt: utcTimestamp("authorization_expires_at"),
  lastVerifiedAt: utcTimestamp("last_verified_at"),
  latestRequestId: varchar("latest_request_id", { length: 128 }),
  latestErrorCode: varchar("latest_error_code", { length: 128 }),
  latestErrorMessage: varchar("latest_error_message", { length: 512 }),
  retryCount: integer("retry_count").notNull().default(0),
  lastRetryAt: utcTimestamp("last_retry_at"),
}, (table) => [
  uniqueIndex("seedance_asset_registrations_asset_media_unique").on(table.assetMediaId),
  uniqueIndex("seedance_asset_registrations_source_result_unique")
    .on(table.sourceMediaResultId)
    .where(sql`${table.sourceMediaResultId} is not null`),
  uniqueIndex("seedance_asset_registrations_remote_asset_unique")
    .on(table.remoteAssetId)
    .where(sql`${table.remoteAssetId} is not null`),
  index("seedance_asset_registrations_status_updated_idx").on(table.status, table.updatedAt, table.id),
  index("seedance_asset_registrations_active_authorization_idx")
    .on(table.status, table.authorizationExpiresAt, table.lastVerifiedAt, table.assetMediaId),
  index("seedance_asset_registrations_creator_created_idx").on(table.createdByUserId, table.createdAt, table.id),
]);

/**
 * Sanitized, append-only provider interaction audit for one registration.
 * It deliberately has no storage URL, raw provider body, or credential field.
 */
export const seedanceAssetRegistrationAttempts = common.table("seedance_asset_registration_attempts", {
  id: uuid("id").primaryKey(),
  registrationId: uuid("registration_id").notNull().references(() => seedanceAssetRegistrations.id, { onDelete: "cascade" }),
  attemptNo: integer("attempt_no").notNull(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  action: varchar("action", { length: 16 }).notNull(),
  outcome: varchar("outcome", { length: 20 }).notNull(),
  providerRequestId: varchar("provider_request_id", { length: 128 }),
  providerHttpStatus: integer("provider_http_status"),
  remoteAssetId: varchar("remote_asset_id", { length: 255 }),
  errorCode: varchar("error_code", { length: 128 }),
  errorMessage: varchar("error_message", { length: 512 }),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("seedance_asset_registration_attempts_number_unique").on(table.registrationId, table.attemptNo),
  index("seedance_asset_registration_attempts_registration_created_idx").on(table.registrationId, table.createdAt, table.id),
  index("seedance_asset_registration_attempts_actor_created_idx").on(table.actorUserId, table.createdAt, table.id),
]);

export const referenceTests = common.table("reference_tests", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 128 }).notNull(),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  mode: varchar("mode", { length: 32 }).notNull(),
  modelKey: varchar("model_key", { length: 128 }).notNull(),
  prompt: text("prompt").notNull(),
  parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
  referenceMediaIds: jsonb("reference_media_ids").$type<string[]>().notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  version: integer("version").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
  deletedByUserId: uuid("deleted_by_user_id").references(() => users.id),
});

export const referenceTestResults = common.table("reference_test_results", {
  id: uuid("id").primaryKey(),
  referenceTestId: uuid("reference_test_id").notNull().references(() => referenceTests.id, { onDelete: "cascade" }),
  generationRequestId: uuid("generation_request_id").notNull().references(() => generationRequests.id),
  mediaResultId: uuid("media_result_id").notNull().references(() => mediaResults.id),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  mode: varchar("mode", { length: 32 }).notNull(),
  modelKey: varchar("model_key", { length: 128 }).notNull(),
  parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull(),
  createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  uniqueIndex("reference_test_results_test_media_unique").on(table.referenceTestId, table.mediaResultId),
]);

/**
 * User-level preferences for Grill Engine: preferred genre, style tags,
 * default tone, etc.  One row per user, upserted on first clarification
 * answer.  This is a preference hint, never an authorization or a paid
 * generation parameter.
 */
export const userPreferences = common.table("user_preferences", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  preferredGenre: varchar("preferred_genre", { length: 64 }),
  preferredTone: varchar("preferred_tone", { length: 64 }),
  styleTags: jsonb("style_tags").$type<string[]>().notNull().default([]),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

export const agentSessions = common.table("agent_sessions", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  authSessionId: uuid("auth_session_id").references(() => sessions.id, { onDelete: "set null" }),
  agentType: varchar("agent_type", { length: 64 }).notNull(),
  userAgent: varchar("user_agent", { length: 512 }),
  projectId: uuid("project_id").references(() => projects.id),
  shotId: uuid("shot_id").references(() => shots.id),
  title: varchar("title", { length: 255 }),
  // Grill Engine: persisted clarification state for information-insufficient
  // sessions. Null when no clarification round is active.
  clarificationState: jsonb("clarification_state").$type<Record<string, unknown>>(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
  deletedAt: utcTimestamp("deleted_at"),
});

export const agentMessages = common.table("agent_messages", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => agentSessions.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 20 }).notNull(),
  content: text("content").notNull(),
  toolName: varchar("tool_name", { length: 64 }),
  toolArguments: jsonb("tool_arguments").$type<Record<string, unknown>>(),
  toolResultSummary: jsonb("tool_result_summary").$type<Record<string, unknown>>(),
  status: varchar("status", { length: 16 }).notNull(),
  provider: varchar("provider", { length: 64 }),
  model: varchar("model", { length: 128 }),
  usage: jsonb("usage").$type<Record<string, unknown>>(),
  providerCostUsdMicros: integer("provider_cost_usd_micros"),
  pointsSpent: integer("points_spent"),
  durationMs: integer("duration_ms"),
  errorSummary: text("error_summary"),
  createdAt: utcTimestamp("created_at").notNull(),
});

/**
 * Server-side AI gateway audit metadata. Deliberately excludes prompt bodies,
 * output bodies, and raw provider responses: those are creator content, not
 * billing or operational telemetry.
 */
export const aiCalls = common.table("ai_calls", {
  id: uuid("id").primaryKey(),
  callerUserId: uuid("caller_user_id").notNull().references(() => users.id),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  relatedObjectType: varchar("related_object_type", { length: 64 }),
  relatedObjectId: varchar("related_object_id", { length: 128 }),
  purpose: varchar("purpose", { length: 64 }).notNull(),
  provider: varchar("provider", { length: 64 }).notNull(),
  model: varchar("model", { length: 128 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  durationMs: integer("duration_ms"),
  // Intentionally nullable until a provider-normalized actual cost exists. A
  // missing value means "not reported", never zero; it is not points.
  costFen: integer("cost_fen"),
  errorCode: varchar("error_code", { length: 128 }),
  createdAt: utcTimestamp("created_at").notNull(),
  completedAt: utcTimestamp("completed_at"),
});

/**
 * 模型能力登记(迁移 059)。输出上限的真源:网关按 callableModelId 查这张表
 * 决定单次调用能要多少输出 token,不再依赖代码里的写死数字。
 *
 * token 列都是已换算的整数:供应商返回的 "1024k" 由同步器在写入侧换算
 * (1k = 1024),库里不留带单位字符串,避免每个读取点各自解析。
 */
export const modelCapabilities = common.table("model_capabilities", {
  id: uuid("id").primaryKey(),
  modelName: varchar("model_name", { length: 128 }).notNull(),
  modelVersion: varchar("model_version", { length: 64 }).notNull(),
  /** 调用时真正传给供应商的 ID = 模型名-版本号。 */
  callableModelId: varchar("callable_model_id", { length: 255 }).notNull(),
  provider: varchar("provider", { length: 32 }).notNull(),
  contextWindowTokens: integer("context_window_tokens"),
  maxInputTokens: integer("max_input_tokens"),
  maxOutputTokens: integer("max_output_tokens").notNull(),
  maxReasoningTokens: integer("max_reasoning_tokens"),
  rateLimitRpm: integer("rate_limit_rpm"),
  rateLimitTpm: integer("rate_limit_tpm"),
  /** provider_api = 供应商接口查得;manual = 人工登记。 */
  dataSource: varchar("data_source", { length: 16 }).notNull(),
  syncedAt: utcTimestamp("synced_at").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

/**
 * A successful topic-radar read is preserved as a local, normalized snapshot.
 * The upstream API response remains an internal audit artifact only; product
 * clients consume the normalized item rows below.
 */
export const topicRadarSnapshots = common.table("topic_radar_snapshots", {
  id: uuid("id").primaryKey(),
  source: varchar("source", { length: 32 }).notNull(),
  resourceScope: varchar("resource_scope", { length: 128 }).notNull(),
  cacheDate: date("cache_date", { mode: "string" }).notNull(),
  rankDate: date("rank_date", { mode: "string" }).notNull(),
  fetchedAt: utcTimestamp("fetched_at").notNull(),
  rawPayload: jsonb("raw_payload").$type<unknown>().notNull(),
  itemCount: integer("item_count").notNull(),
});

export const topicRadarItems = common.table("topic_radar_items", {
  id: uuid("id").primaryKey(),
  snapshotId: uuid("snapshot_id").notNull().references(() => topicRadarSnapshots.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  rank: integer("rank"),
  title: varchar("title", { length: 512 }).notNull(),
  heat: varchar("heat", { length: 128 }),
  link: text("link"),
  rawItem: jsonb("raw_item").$type<unknown>().notNull(),
});

/**
 * This is an audit/guard ledger rather than billing.  Its unique daily row is
 * what prevents ordinary page reads from silently spending a second 52api
 * request on the same China-calendar day.
 */
export const topicRadarUpstreamCalls = common.table("topic_radar_upstream_calls", {
  id: uuid("id").primaryKey(),
  source: varchar("source", { length: 32 }).notNull(),
  resourceScope: varchar("resource_scope", { length: 128 }).notNull(),
  cacheDate: date("cache_date", { mode: "string" }).notNull(),
  requestKind: varchar("request_kind", { length: 16 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  requestedByUserId: uuid("requested_by_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  snapshotId: uuid("snapshot_id").references(() => topicRadarSnapshots.id, { onDelete: "restrict" }),
  startedAt: utcTimestamp("started_at").notNull(),
  completedAt: utcTimestamp("completed_at"),
  errorCode: varchar("error_code", { length: 128 }),
  errorMessage: varchar("error_message", { length: 512 }),
});

/**
 * SQL migration 016 owns this UNION view.  It is intentionally an existing
 * view: queries may aggregate it, but neither the ORM nor a service may write
 * a second accounting table.
 */
export const costEntries = common.view("cost_entries", {
  entryId: uuid("entry_id").notNull(),
  kind: varchar("kind", { length: 32 }).notNull(),
  userId: uuid("user_id").notNull(),
  projectId: uuid("project_id"),
  teamId: uuid("team_id"),
  model: varchar("model", { length: 128 }).notNull(),
  chargedPoints: integer("charged_points").notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  sourceTable: varchar("source_table", { length: 64 }).notNull(),
  sourceId: uuid("source_id").notNull(),
  isUnpriced: boolean("is_unpriced").notNull(),
}).existing();

export const events = common.table("events", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  event: varchar("event", { length: 128 }).notNull(),
  props: jsonb("props").$type<Record<string, unknown>>().notNull(),
  occurredAt: utcTimestamp("occurred_at").notNull(),
  receivedAt: utcTimestamp("received_at").notNull(),
});

export const cliRuns = common.table("cli_runs", {
  id: uuid("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  runId: varchar("run_id", { length: 128 }).notNull(),
  provider: varchar("provider", { length: 64 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  generationRequestId: uuid("generation_request_id").references(() => generationRequests.id),
  manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("cli_runs_user_run_unique").on(table.userId, table.runId),
]);

export const projectDirectorStoryboardPrompts = common.table("project_director_storyboard_prompts", {
  id: uuid("id").primaryKey(),
  projectId: uuid("project_id"),
  projectName: varchar("project_name", { length: 255 }),
  episodeNo: integer("episode_no"),
  shotNo: integer("shot_no"),
  sceneName: varchar("scene_name", { length: 255 }),
  directorPromptText: text("director_prompt_text"),
  shotDescription: text("shot_description"),
  cameraMovement: varchar("camera_movement", { length: 255 }),
  lighting: varchar("lighting", { length: 255 }),
  soundInstruction: text("sound_instruction"),
  soundEffect: varchar("sound_effect", { length: 255 }),
  userId: varchar("user_id", { length: 255 }),
  userName: varchar("user_name", { length: 255 }),
  resultMediaId: uuid("result_media_id"),
  status: varchar("status", { length: 64 }).notNull(),
  referenceFileUrl: varchar("reference_file_url", { length: 1024 }),
  storyboardFileUrl: varchar("storyboard_file_url", { length: 1024 }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }),
});

/**
 * Creative vocabulary (migration 020): reference-lane registry backing the
 * control_package_refs.lane FK (wired in SQL).  pick_kind filters the asset
 * picker for this lane; NULL means any media kind is selectable.
 * Migration 023 adds recommended: per-lane "what reference to prepare" list
 * (elements {key, label, required}), seeded from the frontend builtin
 * vocabulary; icon/hint presentation stays a code overlay, not a column.
 */
export const referenceLaneVocabulary = common.table("reference_lane_vocabulary", {
  id: varchar("id", { length: 24 }).primaryKey(),
  displayName: varchar("display_name", { length: 64 }).notNull(),
  domain: varchar("domain", { length: 16 }).notNull(),
  pickKind: varchar("pick_kind", { length: 32 }),
  recommended: jsonb("recommended").$type<Array<{ key: string; label: string; required: boolean }>>().notNull().default([]),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
});

/**
 * Creative vocabulary (migration 020): asset-role registry backing the
 * asset_entities.role FK (wired in SQL).  pick_kind is always NULL here —
 * roles do not filter the asset picker; domain is a display grouping only.
 */
export const assetRoleVocabulary = common.table("asset_role_vocabulary", {
  id: varchar("id", { length: 24 }).primaryKey(),
  displayName: varchar("display_name", { length: 64 }).notNull(),
  domain: varchar("domain", { length: 16 }).notNull(),
  pickKind: varchar("pick_kind", { length: 32 }),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
});

/**
 * Creative vocabulary (migration 020): seeded project-genre suggestions.
 * The id is the Chinese genre name itself (e.g. 甜宠).  Project genre is
 * free text (S24 unfreezing): this table is the suggestion source, not a
 * constraint; users may save genres beyond the seeded list.
 */
export const genreSuggestions = common.table("genre_suggestions", {
  id: varchar("id", { length: 32 }).primaryKey(),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
});

/**
 * Tag vocabulary (migration 031): self-referential canonical.  Aliases and
 * canonical terms live in the same table; a canonical term points at itself.
 * domain is an open string with no CHECK — domains are creative vocabulary
 * too and stay unfrozen.  Not seeded: tags grow from an empty vocabulary
 * (signed-in users ensure canonical terms; admins register aliases).
 */
export const tagVocabulary = common.table("tag_vocabulary", {
  id: varchar("id", { length: 64 }).primaryKey(),
  canonicalId: varchar("canonical_id", { length: 64 })
    .notNull()
    .references((): AnyPgColumn => tagVocabulary.id),
  domain: varchar("domain", { length: 32 }).notNull().default("general"),
  displayName: varchar("display_name", { length: 64 }).notNull(),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  index("tag_vocabulary_canonical_idx").on(table.canonicalId),
]);

/**
 * Asset ↔ tag links (migration 031): one asset may carry many tags.  tag_id
 * always stores the canonical id — the write path resolves aliases in one
 * hop before persisting; no multi-level chains.  Links cascade on hard
 * asset delete.
 */
export const assetTags = common.table("asset_tags", {
  assetEntityId: uuid("asset_entity_id").notNull().references(() => assetEntities.id, { onDelete: "cascade" }),
  tagId: varchar("tag_id", { length: 64 }).notNull().references(() => tagVocabulary.id),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.assetEntityId, table.tagId], name: "asset_tags_pkey" }),
  index("asset_tags_tag_idx").on(table.tagId),
]);

/**
 * Asset-kind vocabulary (migration 031): the same self-referential canonical
 * mechanism as tags.  Seeded with the 14 canonical kinds already in factual
 * use plus the three emerged aliases (clothing→costume, keyframe→keyword,
 * other→reference).  asset_entities.asset_kind stays an open varchar with
 * no FK — this table is the suggestion source and alias resolver, never a
 * write constraint.
 */
export const assetKindVocabulary = common.table("asset_kind_vocabulary", {
  id: varchar("id", { length: 32 }).primaryKey(),
  canonicalId: varchar("canonical_id", { length: 32 })
    .notNull()
    .references((): AnyPgColumn => assetKindVocabulary.id),
  displayName: varchar("display_name", { length: 64 }).notNull(),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  index("asset_kind_vocabulary_canonical_idx").on(table.canonicalId),
]);

/**
 * Voice vocabulary (migration 033): doubao TTS timbres are a vocabulary, not
 * a remote fetch — the supplier has no public voice-list API.  Same
 * self-referential canonical mechanism as migration 031: aliases and canonical
 * voices share one table; a canonical row points at itself and carries the
 * supplier voice_type, an alias row leaves voice_type NULL and points at its
 * canonical row.  Seeded only from the official doubao voice-list document;
 * audition_url is written only by the explicitly authorized pre-render script
 * (scripts/render-voice-auditions.mts) — voices without it show a disabled
 * audition button.
 */
export const voiceVocabulary = common.table("voice_vocabulary", {
  id: varchar("id", { length: 96 }).primaryKey(),
  canonicalId: varchar("canonical_id", { length: 96 })
    .notNull()
    .references((): AnyPgColumn => voiceVocabulary.id),
  voiceType: varchar("voice_type", { length: 96 }),
  displayName: varchar("display_name", { length: 128 }).notNull(),
  language: varchar("language", { length: 64 }),
  category: varchar("category", { length: 64 }),
  gender: varchar("gender", { length: 16 }),
  auditionUrl: text("audition_url"),
  sort: integer("sort").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
}, (table) => [
  index("voice_vocabulary_canonical_idx").on(table.canonicalId),
]);

/**
 * Soft-config source of truth (migration 023): entries that must change
 * without a deploy (release plan first).  Governance columns are fixed
 * (kind/status/timestamps/source/created-by); content lives in the
 * snake_case-keyed payload so multi-value labels and aliases stay possible
 * without a schema change.
 */
export const configEntries = common.table("config_entries", {
  id: uuid("id").primaryKey(),
  kind: varchar("kind", { length: 64 }).notNull(),
  entryKey: varchar("entry_key", { length: 128 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("published"),
  sort: integer("sort").notNull().default(0),
  payload: jsonb("payload").notNull().default({}),
  source: varchar("source", { length: 64 }).notNull().default("admin"),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: utcTimestamp("updated_at").notNull(),
});

/**
 * One provider-cost fact per provider generation attempt. Exact supplier spend is
 * kept in CNY micros; generation_attempts.actual_cost_fen is only the rounded
 * compatibility projection consumed by existing cost pages.
 */
export const providerCosts = common.table("provider_costs", {
  id: uuid("id").primaryKey(),
  generationRequestId: uuid("generation_request_id").notNull()
    .references(() => generationRequests.id, { onDelete: "restrict" }),
  generationAttemptId: uuid("generation_attempt_id").notNull()
    .references(() => generationAttempts.id, { onDelete: "restrict" }),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  rateConfigEntryId: uuid("rate_config_entry_id")
    .references(() => configEntries.id, { onDelete: "restrict" }),
  provider: varchar("provider", { length: 32 }).notNull(),
  model: varchar("model", { length: 128 }).notNull(),
  actualModelId: varchar("actual_model_id", { length: 128 }).notNull(),
  mediaKind: varchar("media_kind", { length: 16 }).notNull(),
  providerResultStatus: varchar("provider_result_status", { length: 16 }).notNull(),
  calculationStatus: varchar("calculation_status", { length: 16 }).notNull(),
  usageSource: varchar("usage_source", { length: 24 }).notNull(),
  usageUnit: varchar("usage_unit", { length: 32 }),
  usageQuantity: bigint("usage_quantity", { mode: "number" }),
  billingUnit: varchar("billing_unit", { length: 32 }),
  unitPriceCnyMicros: bigint("unit_price_cny_micros", { mode: "number" }),
  unitSize: bigint("unit_size", { mode: "number" }),
  costCnyMicros: bigint("cost_cny_micros", { mode: "number" }),
  costFenRounded: integer("cost_fen_rounded"),
  currency: varchar("currency", { length: 8 }).notNull().default("CNY"),
  rateConfigUpdatedAt: utcTimestamp("rate_config_updated_at"),
  rateConfigChecksum: varchar("rate_config_checksum", { length: 64 }),
  calculationVersion: varchar("calculation_version", { length: 32 }).notNull(),
  requiresAttention: boolean("requires_attention").notNull(),
  failureCode: varchar("failure_code", { length: 64 }),
  createdAt: utcTimestamp("created_at").notNull(),
  updatedAt: utcTimestamp("updated_at").notNull(),
}, (table) => [
  uniqueIndex("provider_costs_attempt_unique").on(table.generationAttemptId),
  index("provider_costs_request_idx").on(table.generationRequestId),
  index("provider_costs_project_created_idx").on(table.projectId, table.createdAt.desc(), table.id.desc()),
  index("provider_costs_actor_created_idx").on(table.actorUserId, table.createdAt.desc(), table.id.desc()),
  index("provider_costs_actual_model_created_idx")
    .on(table.actualModelId, table.createdAt.desc(), table.id.desc()),
  index("provider_costs_config_idx")
    .on(table.rateConfigEntryId)
    .where(sql`${table.rateConfigEntryId} is not null`),
  index("provider_costs_attention_created_idx")
    .on(table.createdAt.desc(), table.id.desc())
    .where(sql`${table.requiresAttention}`),
]);

/**
 * Test-environment paid-smoke reservation. A row is inserted before the
 * provider POST and is never deleted automatically, so Pod replacement cannot
 * reopen the same approved batch+tier for another paid call.
 */
export const tierSmokeReservations = common.table("tier_smoke_reservations", {
  reservationId: uuid("reservation_id").primaryKey(),
  batchId: varchar("batch_id", { length: 128 }).notNull(),
  tierId: varchar("tier_id", { length: 128 }).notNull(),
  target: varchar("target", { length: 16 }).notNull(),
  reservedFen: integer("reserved_fen").notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  reservedAt: utcTimestamp("reserved_at").notNull(),
  completedAt: utcTimestamp("completed_at"),
  providerTaskFingerprint: varchar("provider_task_fingerprint", { length: 64 }),
  artifactSha256: varchar("artifact_sha256", { length: 64 }),
  artifactWidthPx: integer("artifact_width_px"),
  artifactHeightPx: integer("artifact_height_px"),
}, (table) => [
  uniqueIndex("tier_smoke_reservations_batch_tier_unique").on(table.batchId, table.tierId),
  uniqueIndex("tier_smoke_reservations_task_unique").on(table.providerTaskFingerprint),
  uniqueIndex("tier_smoke_reservations_artifact_unique").on(table.artifactSha256),
  check("tier_smoke_reservations_target_check", sql`${table.target} = 'test-env'`),
  check(
    "tier_smoke_reservations_approved_batch_check",
    sql`${table.batchId} = 'ark-test-env-portrait-image-v1'
      AND ${table.tierId} = 'img-seedream5pro-916-1k-1'`,
  ),
  check(
    "tier_smoke_reservations_reserved_fen_check",
    sql`${table.reservedFen} = 30`,
  ),
  check(
    "tier_smoke_reservations_status_check",
    sql`(
      (${table.status} = 'reserved'
        AND ${table.completedAt} IS NULL
        AND ${table.providerTaskFingerprint} IS NULL
        AND ${table.artifactSha256} IS NULL
        AND ${table.artifactWidthPx} IS NULL
        AND ${table.artifactHeightPx} IS NULL)
      OR
      (${table.status} = 'completed'
        AND ${table.completedAt} IS NOT NULL
        AND ${table.providerTaskFingerprint} IS NOT NULL
        AND ${table.providerTaskFingerprint} ~ '^[0-9a-f]{16,64}$'
        AND ${table.artifactSha256} IS NOT NULL
        AND ${table.artifactSha256} ~ '^[0-9a-f]{64}$'
        AND ${table.artifactWidthPx} IS NOT NULL
        AND ${table.artifactHeightPx} IS NOT NULL
        AND ${table.artifactWidthPx} > 0
        AND ${table.artifactHeightPx} > ${table.artifactWidthPx})
    )`,
  ),
]);

/** Durable outcome of both human and retention-driven trash purge attempts. */
export const trashPurgeAttempts = common.table("trash_purge_attempts", {
  id: uuid("id").primaryKey(),
  source: varchar("source", { length: 16 }).notNull(),
  targetKind: varchar("target_kind", { length: 16 }).notNull(),
  targetId: uuid("target_id").notNull(),
  ownerUserId: uuid("owner_user_id"),
  actorUserId: uuid("actor_user_id"),
  status: varchar("status", { length: 24 }).notNull(),
  retentionDays: integer("retention_days"),
  deletedAtSnapshot: utcTimestamp("deleted_at_snapshot"),
  blockers: jsonb("blockers").$type<string[]>().notNull().default([]),
  errorCode: varchar("error_code", { length: 128 }),
  startedAt: utcTimestamp("started_at").notNull(),
  completedAt: utcTimestamp("completed_at"),
});

export const databaseSchema = {
  users,
  sessions,
  wecomUserIdentities,
  wecomAuthTransactions,
  teams,
  teamMembers,
  userGroups,
  userGroupMembers,
  adminOperationActions,
  projects,
  projectMembers,
  projectMemberProductionRoles,
  episodes,
  scenes,
  shots,
  storyboardImports,
  episodeScriptVersions,
  scriptBreakdownRuns,
  scriptBreakdownRunStages,
  assetSourceProjects,
  assetEntities,
  assetVariants,
  assetMedia,
  videoIngestTasks,
  assetMediaRenditions,
  assetMediaRepairTasks,
  assetMediaRepairBlockers,
  assetMediaRepairActions,
  projectAssetRefs,
  shotAssetRefs,
  scenePrepItems,
  scenePrepCommits,
  projectReviewPolicies,
  assetReviewActions,
  generationRequests,
  generationDefaultStrategies,
  generationAttempts,
  generationAttemptNotifications,
  emailVerificationCodes,
  accountCreditPolicies,
  inviteTiers,
  inviteCodes,
  userCreditAccounts,
  userCreditDailyUsage,
  userCreditLedgerEntries,
  inviteCodeRedemptions,
  generationQuotes,
  generationBillingFailureFacts,
  generationBatchAuthorizations,
  generationBatchAuthorizationItems,
  mediaResults,
  generationTosOrphans,
  mediaProvenanceSubjects,
  mediaProvenanceParentEdges,
  mediaProvenanceAuthority,
  audioVersions,
  mediaReviewActions,
  deliveryRecords,
  volcAssetGroups,
  seedanceAssetRegistrations,
  seedanceAssetRegistrationAttempts,
  referenceTests,
  referenceTestResults,
  pricingRules,
  promptTemplates,
  promptDefaultTemplates,
  agentSessions,
  agentMessages,
  aiCalls,
  userPreferences,
  topicRadarSnapshots,
  topicRadarItems,
  topicRadarUpstreamCalls,
  costEntries,
  events,
  cliRuns,
  projectDirectorStoryboardPrompts,
  referenceLaneVocabulary,
  assetRoleVocabulary,
  genreSuggestions,
  tagVocabulary,
  assetTags,
  assetKindVocabulary,
  voiceVocabulary,
  assetUploadTasks,
  configEntries,
  providerCosts,
  tierSmokeReservations,
  trashPurgeAttempts,
};

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type WecomUserIdentityRow = typeof wecomUserIdentities.$inferSelect;
export type WecomAuthTransactionRow = typeof wecomAuthTransactions.$inferSelect;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type ProjectMemberProductionRoleRow = typeof projectMemberProductionRoles.$inferSelect;
export type TeamRow = typeof teams.$inferSelect;
export type UserGroupRow = typeof userGroups.$inferSelect;
export type EpisodeRow = typeof episodes.$inferSelect;
export type SceneRow = typeof scenes.$inferSelect;
export type ShotRow = typeof shots.$inferSelect;
export type ShotAssetRefRow = typeof shotAssetRefs.$inferSelect;
export type CastingTaskRow = typeof castingTasks.$inferSelect;
export type EpisodeScriptVersionRow = typeof episodeScriptVersions.$inferSelect;
export type ScriptBreakdownRunRow = typeof scriptBreakdownRuns.$inferSelect;
export type ScriptBreakdownRunStageRow = typeof scriptBreakdownRunStages.$inferSelect;
export type AssetEntityRow = typeof assetEntities.$inferSelect;
export type AssetVariantRow = typeof assetVariants.$inferSelect;
export type AssetMediaRow = typeof assetMedia.$inferSelect;
export type VideoIngestTaskRow = typeof videoIngestTasks.$inferSelect;
export type AssetMediaRenditionRow = typeof assetMediaRenditions.$inferSelect;
export type AssetMediaRepairTaskRow = typeof assetMediaRepairTasks.$inferSelect;
export type AssetMediaRepairBlockerRow = typeof assetMediaRepairBlockers.$inferSelect;
export type AssetMediaRepairActionRow = typeof assetMediaRepairActions.$inferSelect;
export type MediaProvenanceSubjectRow = typeof mediaProvenanceSubjects.$inferSelect;
export type MediaProvenanceParentEdgeRow = typeof mediaProvenanceParentEdges.$inferSelect;
export type AudioVersionRow = typeof audioVersions.$inferSelect;
export type AssetSourceProjectRow = typeof assetSourceProjects.$inferSelect;
export type SeedanceAssetRegistrationRow = typeof seedanceAssetRegistrations.$inferSelect;
export type SeedanceAssetRegistrationAttemptRow = typeof seedanceAssetRegistrationAttempts.$inferSelect;
export type VolcAssetGroupRow = typeof volcAssetGroups.$inferSelect;
export type AiCallRow = typeof aiCalls.$inferSelect;
export type TopicRadarSnapshotRow = typeof topicRadarSnapshots.$inferSelect;
export type TopicRadarItemRow = typeof topicRadarItems.$inferSelect;
export type TopicRadarUpstreamCallRow = typeof topicRadarUpstreamCalls.$inferSelect;
export type ReferenceLaneVocabularyRow = typeof referenceLaneVocabulary.$inferSelect;
export type AssetRoleVocabularyRow = typeof assetRoleVocabulary.$inferSelect;
export type GenreSuggestionRow = typeof genreSuggestions.$inferSelect;
export type TagVocabularyRow = typeof tagVocabulary.$inferSelect;
export type AssetTagRow = typeof assetTags.$inferSelect;
export type AssetKindVocabularyRow = typeof assetKindVocabulary.$inferSelect;
export type VoiceVocabularyRow = typeof voiceVocabulary.$inferSelect;
export type AssetUploadTaskRow = typeof assetUploadTasks.$inferSelect;
export type ConfigEntryRow = typeof configEntries.$inferSelect;
export type ProviderCostRow = typeof providerCosts.$inferSelect;
