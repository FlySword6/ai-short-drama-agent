/**
 * 逐域行级转换(纯函数,不碰数据库)。
 * 真源:docs/contracts/common-to-v020-mapping.md §2 列级映射与 §7 实证修正。
 *
 * 每个转换返回四态之一:
 *   ready      可落库(row 为目标表行,不含 id——由 runner 发新 uuid)
 *   candidate  计划候选(users/projects 按契约只允许 manual_confirmed,等人工决定)
 *   quarantine 进隔离区(记 crosswalk quarantined + 原因,不猜不合并)
 *   conflict   冲突(记 crosswalk conflict,需人工)
 *   skip       按规则不迁(记原因,不算异常)
 */

export const PASSWORD_HASH_SENTINEL = "legacy-import:reset-required:v1";
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
export const DEFAULT_CLEARANCE = {
  search: true,
  gen_reference: true,
  commercial_publish: false,
  model_training: false,
} as const;

export type TransformOutcome = "ready" | "candidate" | "quarantine" | "conflict" | "skip";

export interface TransformResult<TRow = Record<string, unknown>> {
  outcome: TransformOutcome;
  row?: TRow;
  reason?: string;
  /** 降级/留痕摘要(进 crosswalk notes;只放人工复核所需最小信息)。 */
  notes?: string;
}

export interface ManualDecision {
  decision: "new";
  decidedBy: string;
  usernameOverride?: string;
  nameOverride?: string;
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

export function truncateNotes(value: unknown, max = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** numeric(18,6) → 分(exact 十进制换算,四舍五入;负值/非法 → null 由调用方隔离)。 */
export function numericToFen(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const [, sign, intPart, fracPart = ""] = match;
  if (sign === "-") return null; // 单价 CHECK ≥0,负值进隔离
  const frac2 = fracPart.slice(0, 2).padEnd(2, "0");
  const thirdDigit = fracPart.length > 2 ? Number(fracPart[2]) : 0;
  let fen = BigInt(intPart) * 100n + BigInt(frac2);
  if (thirdDigit >= 5) fen += 1n;
  if (fen > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(fen);
}

/** 非零 numeric 判定(用于 fixed_fee ≠ 0 → quarantine)。 */
export function isNonZeroNumeric(value: string | number | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const match = /^-?0*(?:\.0*)?$/.exec(String(value).trim());
  return match === null;
}

/**
 * pg 时间戳文本(或 ISO 8601)→ epoch ms。
 * pg ::text 输出形如 `2024-01-15 08:30:00.123456+00`,与 ISO 的 T/Z 形式混排时
 * 字符串字典序不等于时序,必须解析后比较;解析失败返回 null 由调用方隔离。
 */
export function pgTimestampToMs(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:([+-])(\d{2})(?::?(\d{2}))?|([Zz]))?$/.exec(text.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, sign, offsetHour, offsetMinute, zulu] = match;
  let offsetMs = 0;
  if (sign && offsetHour) {
    const minutes = Number(offsetHour) * 60 + Number(offsetMinute ?? "0");
    offsetMs = minutes * 60_000 * (sign === "-" ? -1 : 1);
  } else if (!zulu) {
    return null; // 无时区歧义不猜
  }
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - offsetMs;
}

// ---------------------------------------------------------------------------
// users(契约 §2.1)
// ---------------------------------------------------------------------------

export interface CommonUserRow {
  id: string;
  login_name: string | null;
  display_name: string;
  email: string | null;
  auth_subject_id: string | null;
  status: string;
  is_disabled: boolean;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export function normalizeUsername(loginName: string | null): { ok: true; username: string } | { ok: false; reason: string } {
  if (loginName === null || loginName.trim() === "") return { ok: false, reason: "login_name 为空" };
  const username = loginName.trim().toLowerCase();
  if (username.length > 64) return { ok: false, reason: `login_name 超长(${username.length} > 64)` };
  if (!USERNAME_PATTERN.test(username)) return { ok: false, reason: `login_name 不合 username 正则: ${username}` };
  return { ok: true, username };
}

export function mapUserActive(status: string, isDisabled: boolean): boolean {
  return status === "active" && !isDisabled;
}

export function transformUser(
  source: CommonUserRow,
  opts: { usernameTaken: (username: string) => boolean; decision?: ManualDecision },
): TransformResult {
  const override = opts.decision?.usernameOverride;
  const normalized = override
    ? (USERNAME_PATTERN.test(override) ? { ok: true as const, username: override } : { ok: false as const, reason: `人工改名仍不合正则: ${override}` })
    : normalizeUsername(source.login_name);
  if (!normalized.ok) {
    return { outcome: "quarantine", reason: normalized.reason, notes: truncateNotes({ login_name: source.login_name, email: source.email }) };
  }
  if (opts.usernameTaken(normalized.username)) {
    return { outcome: "conflict", reason: `username 在目标库已被占用: ${normalized.username}`, notes: truncateNotes({ login_name: source.login_name, email: source.email }) };
  }
  const notes = truncateNotes({
    login_name: source.login_name,
    email: source.email,
    auth_subject_id: source.auth_subject_id ? "(present)" : null,
    legacy_metadata: source.metadata,
  });
  if (!opts.decision) {
    // 契约 §3:users 只允许 manual_confirmed——没有人工决定前一律候选。
    return { outcome: "candidate", reason: "等待人工确认(用户身份不自动合并)", notes };
  }
  return {
    outcome: "ready",
    row: {
      username: normalized.username,
      display_name: source.display_name,
      password_hash: PASSWORD_HASH_SENTINEL,
      active: mapUserActive(source.status, source.is_disabled),
      role: "member",
      created_at: source.created_at,
      updated_at: source.updated_at,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// projects(契约 §2.3)
// ---------------------------------------------------------------------------

export interface CommonProjectRow {
  id: string;
  project_code: string;
  name: string;
  owner_user_id: string;
  status: string;
  description: string | null;
  budget_amount: string | null;
  budget_spent_amount: string | null;
  budget_remaining_amount: string | null;
  cover_image_url: string | null;
  start_time: string | null;
  end_time: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export function mapProjectStatus(status: string): { status: "active" | "archived"; note?: string } {
  if (status === "active") return { status: "active" };
  return { status: "archived", note: `legacy_status=${status}` };
}

export function transformProject(
  source: CommonProjectRow,
  opts: {
    ownerTargetId: string | null;
    nameTaken: (name: string) => boolean;
    decision?: ManualDecision;
  },
): TransformResult {
  if (!opts.ownerTargetId) {
    return { outcome: "conflict", reason: "owner_user_id 无法经用户 crosswalk 解析(该用户未确认迁入)", notes: truncateNotes({ project_code: source.project_code, owner_user_id: source.owner_user_id }) };
  }
  const name = opts.decision?.nameOverride ?? source.name;
  if (opts.nameTaken(name)) {
    return { outcome: "conflict", reason: `同 owner 下项目名冲突: ${name}`, notes: truncateNotes({ project_code: source.project_code, name: source.name }) };
  }
  const mapped = mapProjectStatus(source.status);
  const notes = truncateNotes({
    project_code: source.project_code,
    legacy_status: mapped.note ? source.status : undefined,
    budget: isNonZeroNumeric(source.budget_amount) || isNonZeroNumeric(source.budget_spent_amount)
      ? { amount: source.budget_amount, spent: source.budget_spent_amount, remaining: source.budget_remaining_amount }
      : undefined,
    cover_image_url: source.cover_image_url ?? undefined,
    start_time: source.start_time ?? undefined,
    end_time: source.end_time ?? undefined,
    legacy_metadata: source.metadata,
  });
  if (!opts.decision) {
    return { outcome: "candidate", reason: "等待人工确认(项目身份不自动合并)", notes };
  }
  return {
    outcome: "ready",
    row: {
      owner_user_id: opts.ownerTargetId,
      name,
      description: source.description,
      status: mapped.status,
      created_at: source.created_at,
      updated_at: source.updated_at,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// project_access_grants → project_members(契约 §2.3,值域已实证)
// ---------------------------------------------------------------------------

export interface CommonGrantRow {
  id: string;
  project_id: string;
  user_id: string;
  role_type: string;
  role_level: number;
}

export function mapGrantRole(roleType: string): "owner" | "editor" | "viewer" | null {
  switch (roleType) {
    case "owner": return "owner";
    case "admin": return "editor";
    case "collaborator": return "editor";
    case "viewer": return "viewer";
    default: return null;
  }
}

export function transformGrant(
  source: CommonGrantRow,
  opts: { projectOwnerSourceId: string; userTargetId: string | null },
): TransformResult {
  if (!opts.userTargetId) {
    return { outcome: "quarantine", reason: "grant 用户无法经 crosswalk 解析", notes: truncateNotes({ grant_id: source.id, user_id: source.user_id }) };
  }
  const role = mapGrantRole(source.role_type);
  if (role === null) {
    return { outcome: "conflict", reason: `未知 role_type: ${source.role_type}(live 数据超出代码值域)`, notes: truncateNotes({ grant_id: source.id, role_type: source.role_type, role_level: source.role_level }) };
  }
  if (role === "owner") {
    if (source.user_id === opts.projectOwnerSourceId) {
      return { outcome: "skip", reason: "与 projects 自动 owner 成员行去重(同人)", notes: truncateNotes({ grant_id: source.id }) };
    }
    return { outcome: "conflict", reason: "grant 出现第二个 owner(每项目一个 owner 唯一索引)", notes: truncateNotes({ grant_id: source.id, user_id: source.user_id, role_level: source.role_level }) };
  }
  return { outcome: "ready", row: { role } };
}

// ---------------------------------------------------------------------------
// asset_entities(契约 §2.4)
// ---------------------------------------------------------------------------

export const ASSET_KINDS = new Set(["character", "scene", "prop"]);

export interface CommonAssetEntityRow {
  id: string;
  source_project_id: string | null;
  source_project_name: string | null;
  asset_kind: string;
  name: string;
  display_name: string | null;
  intro: string | null;
  appearance: string | null;
  age_value: number | null;
  gender: string | null;
  category: string | null;
  style_tags: unknown;
  approved: boolean | null;
  reuse_scope: string;
  status: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export function transformAssetEntity(
  source: CommonAssetEntityRow,
  opts: { importOwnerId: string; importRunId: string },
): TransformResult {
  if (!ASSET_KINDS.has(source.asset_kind) || source.asset_kind.length > 20) {
    return { outcome: "quarantine", reason: `asset_kind 超出已证值域(character/scene/prop): ${source.asset_kind}` };
  }
  if (!source.name || source.name.length > 128) {
    return { outcome: "quarantine", reason: `name 为空或超长(${(source.name ?? "").length} > 128),不静默截断` };
  }
  if (source.reuse_scope !== "all_projects") {
    return { outcome: "quarantine", reason: `reuse_scope 超出已证值域(all_projects): ${source.reuse_scope}` };
  }
  const degradations: string[] = [];
  let displayName = source.display_name;
  if (displayName && displayName.length > 128) {
    degradations.push("display_name>128 置 NULL,原值入 legacy_display_name");
    displayName = null;
  }
  let gender = source.gender;
  if (gender && gender.length > 16) {
    degradations.push("gender>16 置 NULL,原值入 legacy_gender");
    gender = null;
  }
  let category = source.category;
  if (category && category.length > 64) {
    degradations.push("category>64 置 NULL,原值入 legacy_category");
    category = null;
  }
  let styleTags: string[] = [];
  if (Array.isArray(source.style_tags) && source.style_tags.every((tag) => typeof tag === "string")) {
    styleTags = source.style_tags as string[];
  } else if (source.style_tags !== null && source.style_tags !== undefined) {
    degradations.push("style_tags 非 string 数组,置 []");
  }
  const status = source.approved === true ? "approved" : "pending_review";
  const visibility = "common"; // reuse_scope==='all_projects' 已在上面卡死
  const metadata = {
    lineage: {
      source_system: "common",
      source_table: "asset_entities",
      source_pk: source.id,
      import_run_id: opts.importRunId,
    },
    legacy_metadata: source.metadata ?? {},
    legacy_status: source.status,
    ...(source.display_name && source.display_name.length > 128 ? { legacy_display_name: source.display_name } : {}),
    ...(source.gender && source.gender.length > 16 ? { legacy_gender: source.gender } : {}),
    ...(source.category && source.category.length > 64 ? { legacy_category: source.category } : {}),
  };
  return {
    outcome: "ready",
    row: {
      source_project_id: source.source_project_id,
      source_project_name: source.source_project_name,
      owner_user_id: opts.importOwnerId,
      visibility,
      asset_kind: source.asset_kind,
      name: source.name,
      display_name: displayName,
      intro: source.intro,
      appearance: source.appearance,
      age_value: source.age_value,
      gender,
      category,
      style_tags: styleTags,
      approved: source.approved,
      reuse_scope: source.reuse_scope,
      status,
      metadata,
      clearance: { ...DEFAULT_CLEARANCE },
      created_at: source.created_at,
      updated_at: source.updated_at,
    },
    notes: degradations.length > 0 ? truncateNotes(degradations.join("; ")) : undefined,
  };
}

// ---------------------------------------------------------------------------
// project_asset_refs(契约 §2.4)
// ---------------------------------------------------------------------------

export interface CommonAssetRefRow {
  id: string;
  project_id: string;
  project_name: string | null;
  asset_entity_id: string;
  asset_kind: string;
  role_type: string | null;
  role_name: string | null;
  character_name: string | null;
  usage_note: string | null;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export function transformAssetRef(source: CommonAssetRefRow): TransformResult {
  return {
    outcome: "ready",
    row: {
      version_snapshot: {
        legacy: {
          project_name: source.project_name,
          asset_kind: source.asset_kind,
          role_type: source.role_type,
          role_name: source.role_name,
          character_name: source.character_name,
          usage_note: source.usage_note,
          metadata: source.metadata ?? {},
          legacy_updated_at: source.updated_at,
        },
      },
      created_at: source.created_at,
    },
  };
}

// ---------------------------------------------------------------------------
// 分镜提示词 → shots(契约 §2.7,prompt_type 值域已实证)
// ---------------------------------------------------------------------------

export interface CommonStoryboardRow {
  id: string;
  project_id: string;
  episode_no: number | null;
  shot_no: number | null;
  scene_name: string | null;
  director_prompt_text: string | null;
  shot_description: string | null;
  camera_movement: string | null;
  lighting: string | null;
  sound_instruction: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface CommonPromptRow {
  id: string;
  project_id: string;
  episode_no: number | null;
  shot_no: number | null;
  prompt_type: string;
  prompt_text: string;
  metadata: Record<string, unknown> | null;
  updated_at: string;
}

export function shotCodeFromNo(shotNo: number): string {
  return `G${String(shotNo).padStart(2, "0")}`;
}

/** 场景/运镜/灯光/声音拼接入 director_prompt(仅在 --compose-director-prompt 开启时使用)。 */
export function composeDirectorPrompt(base: string | null, parts: { scene?: string | null; camera?: string | null; lighting?: string | null; sound?: string | null }): string | null {
  const lines: string[] = [];
  if (parts.scene) lines.push(`场景:${parts.scene}`);
  if (base) lines.push(base);
  if (parts.camera) lines.push(`运镜:${parts.camera}`);
  if (parts.lighting) lines.push(`灯光:${parts.lighting}`);
  if (parts.sound) lines.push(`声音:${parts.sound}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

export interface ShotBundleResult {
  shot: TransformResult & { row?: Record<string, unknown> };
  /** 被合并/丢弃的 prompt 行(记 conflict/skip 用)。 */
  promptNotes: string[];
  /** prompt 行级决策(守恒校验与 crosswalk 逐行落账用):merged 进 shot,其余需留痕。 */
  promptDecisions: {
    merged: string[];
    conflicted: string[];
    quarantined: string[];
    consumed: Set<string>;
  };
}

export function transformStoryboardBundle(
  storyboard: CommonStoryboardRow,
  prompts: CommonPromptRow[],
  opts: { composeDirectorPrompt: boolean },
): ShotBundleResult {
  const emptyDecisions = { merged: [] as string[], conflicted: [] as string[], quarantined: [] as string[], consumed: new Set<string>() };
  if (storyboard.episode_no === null) {
    return { shot: { outcome: "quarantine", reason: "episode_no 为 NULL" }, promptNotes: [], promptDecisions: emptyDecisions };
  }
  if (storyboard.shot_no === null) {
    return { shot: { outcome: "quarantine", reason: "shot_no 为 NULL,无法生成 shot_code" }, promptNotes: [], promptDecisions: emptyDecisions };
  }
  const promptNotes: string[] = [];
  const promptDecisions = emptyDecisions;
  let imagePrompt: string | null = null;
  let videoPrompt: string | null = null;
  // 链接规则(实证):优先 metadata.project_director_storyboard_prompt_id 回链;
  // 退化按 (episode_no, shot_no) 对齐。
  const linked = prompts.filter((prompt) => {
    const linkId = prompt.metadata?.["project_director_storyboard_prompt_id"];
    if (typeof linkId === "string") return linkId === storyboard.id;
    return prompt.episode_no === storyboard.episode_no && prompt.shot_no === storyboard.shot_no;
  });
  for (const prompt of linked) {
    promptDecisions.consumed.add(prompt.id);
    const target = prompt.prompt_type === "storyboard_image" ? "image" : prompt.prompt_type === "shot_video" ? "video" : null;
    if (target === null) {
      promptNotes.push(`prompt ${prompt.id}: 未知 prompt_type ${prompt.prompt_type} → quarantine`);
      promptDecisions.quarantined.push(prompt.id);
      continue;
    }
    if (target === "image") {
      if (imagePrompt === null) { imagePrompt = prompt.prompt_text; promptDecisions.merged.push(prompt.id); }
      else {
        promptNotes.push(`prompt ${prompt.id}: 同镜头同类型多条,保留 updated_at 最新,本条记 conflict`);
        promptDecisions.conflicted.push(prompt.id);
      }
    } else {
      if (videoPrompt === null) { videoPrompt = prompt.prompt_text; promptDecisions.merged.push(prompt.id); }
      else {
        promptNotes.push(`prompt ${prompt.id}: 同镜头同类型多条,保留 updated_at 最新,本条记 conflict`);
        promptDecisions.conflicted.push(prompt.id);
      }
    }
  }
  let title = storyboard.shot_description;
  if (title && title.length > 255) {
    title = title.slice(0, 255);
    promptNotes.push("shot_description>255 已截断(记 conflict 清单)");
  }
  const directorPrompt = opts.composeDirectorPrompt
    ? composeDirectorPrompt(storyboard.director_prompt_text, {
        scene: storyboard.scene_name,
        camera: storyboard.camera_movement,
        lighting: storyboard.lighting,
        sound: storyboard.sound_instruction,
      })
    : storyboard.director_prompt_text;
  return {
    shot: {
      outcome: "ready",
      row: {
        shot_code: shotCodeFromNo(storyboard.shot_no),
        sort_order: storyboard.shot_no,
        title,
        director_prompt: directorPrompt,
        image_prompt: imagePrompt,
        video_prompt: videoPrompt,
      },
    },
    promptNotes,
    promptDecisions,
  };
}

// ---------------------------------------------------------------------------
// model_pricing_rules → pricing_rules(契约 §2.6,取价口径已实证)
// ---------------------------------------------------------------------------

export interface CommonPricingRuleRow {
  id: string;
  provider_name: string;
  model_name: string;
  pricing_unit: string;
  input_unit_price: string;
  output_unit_price: string;
  fixed_fee: string;
  currency: string;
  effective_from: string | null;
  effective_to: string | null;
  status: string;
}

export function transformPricingRule(
  source: CommonPricingRuleRow,
  opts: {
    catalogType: string | undefined;
    freezeAt: string;
    importRunId: string;
  },
): TransformResult {
  if (source.provider_name.length > 32) {
    return { outcome: "quarantine", reason: `provider_name 超长(${source.provider_name.length} > 32)` };
  }
  const modelType = opts.catalogType;
  if (modelType === undefined) {
    return { outcome: "quarantine", reason: `(provider_name, model_name) join 不上 model_catalog` };
  }
  if (modelType === "text") {
    return { outcome: "skip", reason: "model_type=text 不迁(我方生成域不含文本计费)" };
  }
  if (modelType !== "image" && modelType !== "video" && modelType !== "audio") {
    return { outcome: "quarantine", reason: `未知 model_type: ${modelType}` };
  }
  const billingUnit = source.pricing_unit === "image" ? "image" : source.pricing_unit === "sec" ? "second" : null;
  if (billingUnit === null) {
    return { outcome: "skip", reason: `pricing_unit=${source.pricing_unit} 暂不迁(我方无 token/char/frame 消费方)` };
  }
  if (isNonZeroNumeric(source.fixed_fee)) {
    // fixed_fee ≠ 0:我方无"每调用平费"概念,单行表达不了 → 人工。
    return { outcome: "quarantine", reason: `fixed_fee≠0(${source.fixed_fee}),平费+变量价单行表达不了,需人工`, notes: truncateNotes({ legacy_prices: legacyPrices(source) }) };
  }
  const unitPriceFen = numericToFen(source.output_unit_price);
  if (unitPriceFen === null) {
    return { outcome: "quarantine", reason: `output_unit_price 无法换算为分: ${source.output_unit_price}` };
  }
  if (source.currency.length > 8) {
    return { outcome: "quarantine", reason: `currency 超长: ${source.currency}` };
  }
  const notes: string[] = [];
  let effectiveFrom = source.effective_from;
  if (effectiveFrom === null) {
    effectiveFrom = opts.freezeAt;
    notes.push("effective_from 为 NULL,补冻结时刻");
  }
  if (source.effective_to !== null) {
    const fromMs = pgTimestampToMs(effectiveFrom);
    const toMs = pgTimestampToMs(source.effective_to);
    if (fromMs === null || toMs === null) {
      return { outcome: "quarantine", reason: `生效区间时间戳无法解析: from=${effectiveFrom} to=${source.effective_to}` };
    }
    if (toMs <= fromMs) {
      return { outcome: "quarantine", reason: `effective_to(${source.effective_to}) ≤ effective_from(${effectiveFrom})` };
    }
  }
  return {
    outcome: "ready",
    row: {
      provider: source.provider_name,
      model: source.model_name,
      media_kind: modelType,
      billing_unit: billingUnit,
      unit_price_fen: unitPriceFen,
      currency: source.currency,
      source: `legacy:common.model_pricing_rules:${source.id}`,
      active: source.status === "active",
      effective_from: effectiveFrom,
      effective_to: source.effective_to,
      metadata: {
        legacy_model_key: `${source.provider_name}:${source.model_name}`,
        legacy_rule_id: source.id,
        legacy_prices: legacyPrices(source),
        import_run_id: opts.importRunId,
      },
    },
    notes: notes.length > 0 ? notes.join("; ") : undefined,
  };
}

function legacyPrices(source: CommonPricingRuleRow): Record<string, unknown> {
  return {
    pricing_unit: source.pricing_unit,
    input_unit_price: source.input_unit_price,
    output_unit_price: source.output_unit_price,
    fixed_fee: source.fixed_fee,
  };
}
