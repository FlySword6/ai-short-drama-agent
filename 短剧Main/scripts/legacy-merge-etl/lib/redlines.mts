/**
 * 红线护栏:源表抽取列白名单 + 红线列/表清单。
 * 真源:docs/contracts/common-to-v020-mapping.md §2(逐表映射)与 §5(R1–R13 不迁清单)。
 *
 * 机制:ETL 只允许按白名单列抽取;任何抽取 SQL 经 assertExtractionSafe 校验——
 * 命中红线列或非白名单表即抛错。白名单之外的红线字段(密码 hash、会话 token、
 * provider 原始响应、PII 超集)在代码层就不可能进入管道。
 */

/** 允许抽取的源表及其列(契约 §2 中"迁/转换"所需的列,逐表对齐)。 */
export const SOURCE_COLUMN_WHITELIST: Readonly<Record<string, readonly string[]>> = {
  users: [
    "id", "login_name", "display_name", "email", "auth_subject_id",
    "current_organization_id", "status", "is_disabled", "metadata",
    "created_at", "updated_at",
  ],
  projects: [
    "id", "project_code", "name", "owner_user_id", "owner_team_id",
    "owner_organization_id", "status", "description",
    "budget_amount", "budget_spent_amount", "budget_remaining_amount",
    "cover_image_url", "start_time", "end_time", "metadata",
    "created_at", "updated_at",
  ],
  project_access_grants: [
    "id", "project_id", "user_id", "role_type", "role_level",
    "source_type", "is_active", "is_disabled", "revoked_at", "granted_at",
    "created_at", "updated_at",
  ],
  asset_entities: [
    "id", "source_project_id", "source_project_name", "asset_kind", "name",
    "display_name", "intro", "appearance", "age_value", "gender", "category",
    "style_tags", "approved", "reuse_scope", "status", "metadata",
    "created_at", "updated_at",
  ],
  project_asset_refs: [
    "id", "project_id", "project_name", "asset_entity_id", "asset_kind",
    "role_type", "role_name", "character_name", "usage_note", "status",
    "metadata", "created_at", "updated_at",
  ],
  project_director_storyboard_prompts: [
    "id", "project_id", "script_id", "breakdown_run_id", "project_name",
    "episode_no", "shot_no", "scene_name", "director_prompt_text",
    "shot_description", "camera_movement", "lighting", "sound_instruction",
    "status", "metadata", "created_at", "updated_at",
  ],
  project_prompts: [
    "id", "project_id", "script_id", "breakdown_run_id", "project_name",
    "episode_no", "shot_no", "prompt_type", "prompt_text", "model_name",
    "status", "metadata", "created_at", "updated_at",
  ],
  model_pricing_rules: [
    "id", "provider_name", "model_name", "pricing_unit",
    "input_unit_price", "output_unit_price", "fixed_fee", "currency",
    "effective_from", "effective_to", "status",
  ],
  model_catalog: ["model_key", "provider_name", "model_name", "model_type", "is_enabled"],
};

/** 红线列(R1/R2/R3/R12):出现在任何抽取 SQL 中即失败。 */
export const REDLINE_COLUMNS: readonly string[] = [
  // R1 凭据
  "password_hash", "password_algorithm", "password_changed_at", "password_updated_at",
  // R2 会话
  "refresh_token_hash",
  // R3 provider 原始响应/请求体
  "request_payload", "original_request_payload", "submit_response",
  "latest_status_response", "provider_response", "create_response", "status_response",
  // R12 PII 超集(email/auth_subject_id 例外:仅人工匹配最小标识,在白名单内)
  "ip_address", "user_agent",
];

/** 红线表(R1/R2/R4/R8/R9/R11/R13 与暂缓表):任何抽取 SQL 引用即失败。 */
export const REDLINE_TABLES: readonly string[] = [
  "user_credentials", "manhua_user_credentials", "user_sessions",
  "generation_tasks", "generation_calls", "generation_outputs",
  "voice_clone_tasks", "seedance_asset_tasks", "audio_voices",
  "file_uploads", "project_metrics", "permission_policies",
  "roles", "permissions", "role_permissions", "user_roles",
  "organizations", "organization_members",
  "scripts", "script_breakdown_runs", "script_imports",
  "asset_media", "migrations", "schema_migrations",
  "manhua_users", "manhua_organizations",
];

const identifierPattern = /[a-z_][a-z0-9_]*/gi;

/** 从 SQL 文本中抽取标识符(粗粒度:做护栏不做解析器,宁可误报不可漏报)。 */
function sqlIdentifiers(sql: string): string[] {
  // 只剥字符串字面量与注释;双引号标识符正是表/列名出现的位置,必须扫描。
  const stripped = sql
    .replace(/'[^']*'/g, " ")
    .replace(/--[^\n]*/g, " ");
  return (stripped.match(identifierPattern) ?? []).map((token) => token.toLowerCase());
}

/**
 * 校验一段抽取 SQL:不得含红线列、不得引用非白名单表。
 * 所有 ETL 抽取查询在执行前必须经过本函数;测试同时对整个脚本目录做静态扫描。
 */
export function assertExtractionSafe(sql: string): void {
  const tokens = new Set(sqlIdentifiers(sql));
  for (const column of REDLINE_COLUMNS) {
    if (tokens.has(column)) {
      throw new Error(`抽取 SQL 命中红线列 ${column}(契约 §5 R1/R2/R3/R12)`);
    }
  }
  for (const table of REDLINE_TABLES) {
    if (tokens.has(table)) {
      throw new Error(`抽取 SQL 引用红线/暂缓表 ${table}(契约 §5)`);
    }
  }
}

/** 静态自洽:白名单自身不得含红线列、不得含红线表。 */
export function assertWhitelistSelfConsistent(): void {
  for (const [table, columns] of Object.entries(SOURCE_COLUMN_WHITELIST)) {
    if ((REDLINE_TABLES as readonly string[]).includes(table)) {
      throw new Error(`白名单表 ${table} 同时在红线表清单——配置自相矛盾`);
    }
    for (const column of columns) {
      if ((REDLINE_COLUMNS as readonly string[]).includes(column)) {
        throw new Error(`白名单 ${table}.${column} 命中红线列——配置自相矛盾`);
      }
    }
  }
}

/** 生成某源表的 SELECT 列清单(调用方拼进 SQL 前必须再过 assertExtractionSafe)。 */
export function selectList(table: string): string {
  const columns = SOURCE_COLUMN_WHITELIST[table];
  if (!columns) throw new Error(`表 ${table} 不在抽取白名单`);
  return columns.map((column) => `"${column}"`).join(", ");
}
