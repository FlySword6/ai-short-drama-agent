import assert from "node:assert/strict";
import test from "node:test";
import {
  PASSWORD_HASH_SENTINEL,
  composeDirectorPrompt,
  isNonZeroNumeric,
  mapGrantRole,
  mapProjectStatus,
  mapUserActive,
  normalizeUsername,
  numericToFen,
  pgTimestampToMs,
  shotCodeFromNo,
  transformAssetEntity,
  transformAssetRef,
  transformGrant,
  transformPricingRule,
  transformProject,
  transformStoryboardBundle,
  transformUser,
  type CommonAssetEntityRow,
  type CommonAssetRefRow,
  type CommonGrantRow,
  type CommonPricingRuleRow,
  type CommonProjectRow,
  type CommonPromptRow,
  type CommonStoryboardRow,
  type CommonUserRow,
} from "../../scripts/legacy-merge-etl/lib/transforms.mjs";

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

test("numericToFen: 十进制精确换算与非法值", () => {
  assert.equal(numericToFen("0.08"), 8);
  assert.equal(numericToFen("1.005"), 101); // 第三位 5 进位
  assert.equal(numericToFen("0.086"), 9);
  assert.equal(numericToFen("12"), 1200);
  assert.equal(numericToFen("0.004"), 0); // 第三位 4 舍去
  assert.equal(numericToFen("-0.08"), null); // 负值 → 隔离
  assert.equal(numericToFen("abc"), null);
  assert.equal(numericToFen(null), null);
  assert.equal(numericToFen(undefined), null);
});

test("isNonZeroNumeric: 零的各种写法与非零", () => {
  assert.equal(isNonZeroNumeric("0"), false);
  assert.equal(isNonZeroNumeric("0.000000"), false);
  assert.equal(isNonZeroNumeric("-0.0"), false);
  assert.equal(isNonZeroNumeric("0.08"), true);
  assert.equal(isNonZeroNumeric("1"), true);
  assert.equal(isNonZeroNumeric(null), false);
});

test("pgTimestampToMs: pg 文本与 ISO 混排可比较", () => {
  const pgText = pgTimestampToMs("2026-07-26 10:00:00+00");
  const iso = pgTimestampToMs("2026-07-26T00:00:00.000Z");
  assert.ok(pgText !== null && iso !== null);
  assert.ok(pgText > iso); // 混排格式下字典序会给出错误答案,解析后必须正确
  assert.equal(pgTimestampToMs("2026-07-26 10:00:00.123456+08"), Date.UTC(2026, 6, 26, 2, 0, 0));
  assert.equal(pgTimestampToMs("垃圾"), null);
  assert.equal(pgTimestampToMs("2026-07-26 10:00:00"), null); // 无时区不猜
  assert.equal(pgTimestampToMs(null), null);
});

test("normalizeUsername: 各分支", () => {
  assert.deepEqual(normalizeUsername("ZhangSan"), { ok: true, username: "zhangsan" });
  assert.deepEqual(normalizeUsername("  abc_def-1.2 "), { ok: true, username: "abc_def-1.2" });
  assert.equal(normalizeUsername(null).ok, false);
  assert.equal(normalizeUsername("   ").ok, false);
  assert.equal(normalizeUsername("ab").ok, false); // 最短 3
  assert.equal(normalizeUsername(`a${"b".repeat(64)}`).ok, false); // > 64
  assert.equal(normalizeUsername("bad name!").ok, false);
  assert.equal(normalizeUsername("-leading-dash").ok, false);
});

test("mapUserActive / mapProjectStatus / mapGrantRole / shotCodeFromNo / composeDirectorPrompt", () => {
  assert.equal(mapUserActive("active", false), true);
  assert.equal(mapUserActive("active", true), false);
  assert.equal(mapUserActive("disabled", false), false);
  assert.deepEqual(mapProjectStatus("active"), { status: "active" });
  assert.deepEqual(mapProjectStatus("draft"), { status: "archived", note: "legacy_status=draft" });
  assert.equal(mapGrantRole("owner"), "owner");
  assert.equal(mapGrantRole("admin"), "editor");
  assert.equal(mapGrantRole("collaborator"), "editor");
  assert.equal(mapGrantRole("viewer"), "viewer");
  assert.equal(mapGrantRole("superadmin"), null);
  assert.equal(shotCodeFromNo(3), "G03");
  assert.equal(shotCodeFromNo(12), "G12");
  assert.equal(
    composeDirectorPrompt("基调", { scene: "酒吧", camera: "推", lighting: null, sound: "雨声" }),
    "场景:酒吧\n基调\n运镜:推\n声音:雨声",
  );
  assert.equal(composeDirectorPrompt(null, {}), null);
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

function userRow(overrides: Partial<CommonUserRow> = {}): CommonUserRow {
  return {
    id: "u-1", login_name: "zhangsan", display_name: "张三", email: "z@example.com",
    auth_subject_id: null, status: "active", is_disabled: false, metadata: {},
    created_at: "2024-01-01 00:00:00+00", updated_at: "2024-01-02 00:00:00+00",
    ...overrides,
  };
}

test("transformUser: 无人工决定一律候选(契约 §3 manual_confirmed)", () => {
  const result = transformUser(userRow(), { usernameTaken: () => false });
  assert.equal(result.outcome, "candidate");
  assert.match(result.reason ?? "", /人工确认/);
});

test("transformUser: 有决定 → ready,口令为不可解析哨兵", () => {
  const result = transformUser(userRow(), {
    usernameTaken: () => false,
    decision: { decision: "new", decidedBy: "fable" },
  });
  assert.equal(result.outcome, "ready");
  const row = result.row as { username: string; password_hash: string; role: string; active: boolean };
  assert.equal(row.username, "zhangsan");
  assert.equal(row.password_hash, PASSWORD_HASH_SENTINEL);
  assert.equal(row.role, "member");
  assert.equal(row.active, true);
});

test("哨兵值不是 scrypt 格式(服务端校验必败,不可能是真 hash)", () => {
  // 服务端口令格式 scrypt:N:r:p:salt:key(见 src 口令校验);哨兵必须不匹配。
  assert.doesNotMatch(PASSWORD_HASH_SENTINEL, /^scrypt:\d+:\d+:\d+:[^:]+:[^:]+$/);
});

test("transformUser: username 被占 → conflict;非法 login → quarantine;人工改名", () => {
  const taken = transformUser(userRow(), {
    usernameTaken: () => true,
    decision: { decision: "new", decidedBy: "fable" },
  });
  assert.equal(taken.outcome, "conflict");
  const bad = transformUser(userRow({ login_name: "Bad Name!" }), {
    usernameTaken: () => false,
    decision: { decision: "new", decidedBy: "fable" },
  });
  assert.equal(bad.outcome, "quarantine");
  const renamed = transformUser(userRow({ login_name: "Bad Name!" }), {
    usernameTaken: () => false,
    decision: { decision: "new", decidedBy: "fable", usernameOverride: "zhangsan2" },
  });
  assert.equal(renamed.outcome, "ready");
});

// ---------------------------------------------------------------------------
// projects / grants
// ---------------------------------------------------------------------------

function projectRow(overrides: Partial<CommonProjectRow> = {}): CommonProjectRow {
  return {
    id: "p-1", project_code: "PRJ-1", name: "项目一", owner_user_id: "u-1", status: "active",
    description: null, budget_amount: "0", budget_spent_amount: "0", budget_remaining_amount: "0",
    cover_image_url: null, start_time: null, end_time: null, metadata: {},
    created_at: "2024-01-01 00:00:00+00", updated_at: "2024-01-02 00:00:00+00",
    ...overrides,
  };
}

test("transformProject: owner 未解析 → conflict;无决定 → candidate;有决定 → ready", () => {
  const noOwner = transformProject(projectRow(), { ownerTargetId: null, nameTaken: () => false });
  assert.equal(noOwner.outcome, "conflict");
  const candidate = transformProject(projectRow(), { ownerTargetId: "t-1", nameTaken: () => false });
  assert.equal(candidate.outcome, "candidate");
  const ready = transformProject(projectRow(), {
    ownerTargetId: "t-1", nameTaken: () => false,
    decision: { decision: "new", decidedBy: "fable" },
  });
  assert.equal(ready.outcome, "ready");
  assert.equal((ready.row as { owner_user_id: string }).owner_user_id, "t-1");
});

test("transformProject: 同名冲突;draft → archived 留痕;budget 非零入 notes", () => {
  const conflict = transformProject(projectRow(), {
    ownerTargetId: "t-1", nameTaken: () => true,
    decision: { decision: "new", decidedBy: "fable" },
  });
  assert.equal(conflict.outcome, "conflict");
  const draft = transformProject(projectRow({ status: "draft", budget_amount: "100.5" }), {
    ownerTargetId: "t-1", nameTaken: () => false,
    decision: { decision: "new", decidedBy: "fable" },
  });
  assert.equal(draft.outcome, "ready");
  assert.equal((draft.row as { status: string }).status, "archived");
  assert.match(draft.notes ?? "", /legacy_status|budget/);
});

function grantRow(overrides: Partial<CommonGrantRow> = {}): CommonGrantRow {
  return { id: "g-1", project_id: "p-1", user_id: "u-2", role_type: "collaborator", role_level: 10, ...overrides };
}

test("transformGrant: 值域映射与冲突分支", () => {
  const ready = transformGrant(grantRow(), { projectOwnerSourceId: "u-1", userTargetId: "t-2" });
  assert.equal(ready.outcome, "ready");
  assert.equal((ready.row as { role: string }).role, "editor");
  const unresolved = transformGrant(grantRow(), { projectOwnerSourceId: "u-1", userTargetId: null });
  assert.equal(unresolved.outcome, "quarantine");
  const unknownRole = transformGrant(grantRow({ role_type: "superadmin" }), { projectOwnerSourceId: "u-1", userTargetId: "t-2" });
  assert.equal(unknownRole.outcome, "conflict");
  const sameOwner = transformGrant(grantRow({ user_id: "u-1", role_type: "owner" }), { projectOwnerSourceId: "u-1", userTargetId: "t-1" });
  assert.equal(sameOwner.outcome, "skip");
  const secondOwner = transformGrant(grantRow({ user_id: "u-9", role_type: "owner" }), { projectOwnerSourceId: "u-1", userTargetId: "t-9" });
  assert.equal(secondOwner.outcome, "conflict");
});

// ---------------------------------------------------------------------------
// asset_entities / refs
// ---------------------------------------------------------------------------

function assetRow(overrides: Partial<CommonAssetEntityRow> = {}): CommonAssetEntityRow {
  return {
    id: "e-1", source_project_id: null, source_project_name: null, asset_kind: "character",
    name: "角色甲", display_name: "角色甲", intro: null, appearance: null, age_value: null,
    gender: "female", category: "主角", style_tags: ["古风"], approved: true,
    reuse_scope: "all_projects", status: "active", metadata: {},
    created_at: "2024-01-01 00:00:00", updated_at: "2024-01-02 00:00:00",
    ...overrides,
  };
}

test("transformAssetEntity: ready 映射(approved→status、clearance 默认、lineage)", () => {
  const result = transformAssetEntity(assetRow(), { importOwnerId: "owner-1", importRunId: "run-1" });
  assert.equal(result.outcome, "ready");
  const row = result.row as Record<string, unknown>;
  assert.equal(row["status"], "approved");
  assert.equal(row["visibility"], "common");
  assert.equal(row["owner_user_id"], "owner-1");
  const clearance = row["clearance"] as Record<string, boolean>;
  assert.equal(clearance["commercial_publish"], false);
  const metadata = row["metadata"] as { lineage: { source_table: string; import_run_id: string } };
  assert.equal(metadata.lineage.source_table, "asset_entities");
  assert.equal(metadata.lineage.import_run_id, "run-1");
});

test("transformAssetEntity: kind/reuse_scope/name 超域 → quarantine(不猜不合并)", () => {
  const badKind = transformAssetEntity(assetRow({ asset_kind: "vehicle" }), { importOwnerId: "o", importRunId: "r" });
  assert.equal(badKind.outcome, "quarantine");
  const badScope = transformAssetEntity(assetRow({ reuse_scope: "organization" }), { importOwnerId: "o", importRunId: "r" });
  assert.equal(badScope.outcome, "quarantine");
  const longName = transformAssetEntity(assetRow({ name: "x".repeat(129) }), { importOwnerId: "o", importRunId: "r" });
  assert.equal(longName.outcome, "quarantine");
});

test("transformAssetEntity: 超长字段降级留痕(不静默截断)", () => {
  const result = transformAssetEntity(
    assetRow({ display_name: "d".repeat(200), gender: "g".repeat(20), category: "c".repeat(70), style_tags: { not: "array" } }),
    { importOwnerId: "o", importRunId: "r" },
  );
  assert.equal(result.outcome, "ready");
  const row = result.row as { display_name: unknown; gender: unknown; category: unknown; style_tags: unknown; metadata: { legacy_display_name?: string } };
  assert.equal(row.display_name, null);
  assert.equal(row.gender, null);
  assert.equal(row.category, null);
  assert.deepEqual(row.style_tags, []);
  assert.equal(row.metadata.legacy_display_name, "d".repeat(200));
  assert.match(result.notes ?? "", /display_name/);
});

test("transformAssetRef: legacy 字段整体入 version_snapshot", () => {
  const ref: CommonAssetRefRow = {
    id: "r-1", project_id: "p-1", project_name: "项目一", asset_entity_id: "e-1",
    asset_kind: "character", role_type: "lead", role_name: "女主", character_name: "小白",
    usage_note: "主演", metadata: { k: 1 }, created_at: "2024-01-01 00:00:00+00", updated_at: "2024-01-02 00:00:00+00",
  };
  const result = transformAssetRef(ref);
  assert.equal(result.outcome, "ready");
  const snapshot = (result.row as { version_snapshot: { legacy: Record<string, unknown> } }).version_snapshot;
  assert.equal(snapshot.legacy["character_name"], "小白");
  assert.equal(snapshot.legacy["usage_note"], "主演");
});

// ---------------------------------------------------------------------------
// storyboard + prompts → shots
// ---------------------------------------------------------------------------

function storyboardRow(overrides: Partial<CommonStoryboardRow> = {}): CommonStoryboardRow {
  return {
    id: "sb-1", project_id: "p-1", episode_no: 1, shot_no: 2, scene_name: "酒吧",
    director_prompt_text: "压抑基调", shot_description: "女主独坐", camera_movement: "推",
    lighting: "昏黄", sound_instruction: "雨声", metadata: {},
    created_at: "2024-01-01 00:00:00", updated_at: "2024-01-02 00:00:00",
    ...overrides,
  };
}

function promptRow(overrides: Partial<CommonPromptRow> = {}): CommonPromptRow {
  return {
    id: "pr-1", project_id: "p-1", episode_no: 1, shot_no: 2, prompt_type: "storyboard_image",
    prompt_text: "image prompt", metadata: {}, updated_at: "2024-01-02 00:00:00+00",
    ...overrides,
  };
}

test("transformStoryboardBundle: 链接规则(metadata 回链优先,(ep,shot) 兜底)", () => {
  const byMetadata = promptRow({ id: "pr-meta", episode_no: 9, shot_no: 9, metadata: { project_director_storyboard_prompt_id: "sb-1" } });
  const byCoords = promptRow({ id: "pr-coord", prompt_type: "shot_video", prompt_text: "video prompt" });
  const unrelated = promptRow({ id: "pr-x", episode_no: 2, shot_no: 2 });
  const bundle = transformStoryboardBundle(storyboardRow(), [byMetadata, byCoords, unrelated], { composeDirectorPrompt: false });
  assert.equal(bundle.shot.outcome, "ready");
  const row = bundle.shot.row as { image_prompt: string; video_prompt: string; shot_code: string };
  assert.equal(row.image_prompt, "image prompt");
  assert.equal(row.video_prompt, "video prompt");
  assert.equal(row.shot_code, "G02");
  assert.deepEqual([...bundle.promptDecisions.consumed].sort(), ["pr-coord", "pr-meta"]);
  assert.deepEqual(bundle.promptDecisions.merged.sort(), ["pr-coord", "pr-meta"]);
});

test("transformStoryboardBundle: 未知 prompt_type → quarantined;同类型多条 → conflicted", () => {
  const unknown = promptRow({ id: "pr-unk", prompt_type: "thumbnail" });
  const dup1 = promptRow({ id: "pr-a" });
  const dup2 = promptRow({ id: "pr-b" });
  const bundle = transformStoryboardBundle(storyboardRow(), [dup1, dup2, unknown], { composeDirectorPrompt: false });
  assert.deepEqual(bundle.promptDecisions.merged, ["pr-a"]); // 查询已按 updated_at DESC 排序,先到的最新
  assert.deepEqual(bundle.promptDecisions.conflicted, ["pr-b"]);
  assert.deepEqual(bundle.promptDecisions.quarantined, ["pr-unk"]);
});

test("transformStoryboardBundle: episode_no/shot_no NULL → quarantine;compose 开关", () => {
  const noEpisode = transformStoryboardBundle(storyboardRow({ episode_no: null }), [], { composeDirectorPrompt: false });
  assert.equal(noEpisode.shot.outcome, "quarantine");
  const noShot = transformStoryboardBundle(storyboardRow({ shot_no: null }), [], { composeDirectorPrompt: false });
  assert.equal(noShot.shot.outcome, "quarantine");
  const plain = transformStoryboardBundle(storyboardRow(), [], { composeDirectorPrompt: false });
  assert.equal((plain.shot.row as { director_prompt: string }).director_prompt, "压抑基调");
  const composed = transformStoryboardBundle(storyboardRow(), [], { composeDirectorPrompt: true });
  assert.match((composed.shot.row as { director_prompt: string }).director_prompt, /^场景:酒吧\n压抑基调\n运镜:推\n灯光:昏黄\n声音:雨声$/);
});

// ---------------------------------------------------------------------------
// pricing_rules
// ---------------------------------------------------------------------------

function pricingRow(overrides: Partial<CommonPricingRuleRow> = {}): CommonPricingRuleRow {
  return {
    id: "pr-1", provider_name: "volc", model_name: "seedream-4", pricing_unit: "image",
    input_unit_price: "0.100000", output_unit_price: "0.080000", fixed_fee: "0.000000",
    currency: "CNY", effective_from: "2024-01-01 00:00:00+00", effective_to: null, status: "active",
    ...overrides,
  };
}

test("transformPricingRule: fixed_fee=0 的图片规则 → ready,价格换算为分", () => {
  const result = transformPricingRule(pricingRow(), { catalogType: "image", freezeAt: "2026-07-26T00:00:00.000Z", importRunId: "run-1" });
  assert.equal(result.outcome, "ready");
  const row = result.row as Record<string, unknown>;
  assert.equal(row["media_kind"], "image");
  assert.equal(row["billing_unit"], "image");
  assert.equal(row["unit_price_fen"], 8);
  assert.equal(row["source"], "legacy:common.model_pricing_rules:pr-1");
  const metadata = row["metadata"] as { legacy_prices: { input_unit_price: string } };
  assert.equal(metadata.legacy_prices.input_unit_price, "0.100000"); // 输入价只留痕不落库(代码从不读)
});

test("transformPricingRule: fixed_fee≠0 → quarantine(回归:条件曾写反)", () => {
  const result = transformPricingRule(pricingRow({ fixed_fee: "1.500000" }), { catalogType: "image", freezeAt: "2026-07-26T00:00:00.000Z", importRunId: "r" });
  assert.equal(result.outcome, "quarantine");
  assert.match(result.reason ?? "", /fixed_fee/);
});

test("transformPricingRule: sec→second;text/token 不迁;catalog join 不上 → quarantine", () => {
  const video = transformPricingRule(pricingRow({ pricing_unit: "sec" }), { catalogType: "video", freezeAt: "f", importRunId: "r" });
  assert.equal(video.outcome, "ready");
  assert.equal((video.row as { billing_unit: string }).billing_unit, "second");
  const text = transformPricingRule(pricingRow(), { catalogType: "text", freezeAt: "f", importRunId: "r" });
  assert.equal(text.outcome, "skip");
  const token = transformPricingRule(pricingRow({ pricing_unit: "token" }), { catalogType: "image", freezeAt: "f", importRunId: "r" });
  assert.equal(token.outcome, "skip");
  const noCatalog = transformPricingRule(pricingRow(), { catalogType: undefined, freezeAt: "f", importRunId: "r" });
  assert.equal(noCatalog.outcome, "quarantine");
});

test("transformPricingRule: effective_from NULL 补冻结时刻;混排格式区间比较", () => {
  const nullFrom = transformPricingRule(pricingRow({ effective_from: null }), { catalogType: "image", freezeAt: "2026-07-26T00:00:00.000Z", importRunId: "r" });
  assert.equal(nullFrom.outcome, "ready");
  assert.equal((nullFrom.row as { effective_from: string }).effective_from, "2026-07-26T00:00:00.000Z");
  assert.match(nullFrom.notes ?? "", /冻结时刻/);
  // 回归:effective_to 为 pg 文本、from 为 ISO,字典序会误判为越界,解析后必须放行。
  const mixed = transformPricingRule(
    pricingRow({ effective_from: null, effective_to: "2026-07-26 10:00:00+00" }),
    { catalogType: "image", freezeAt: "2026-07-26T00:00:00.000Z", importRunId: "r" },
  );
  assert.equal(mixed.outcome, "ready");
  const inverted = transformPricingRule(
    pricingRow({ effective_from: "2026-01-01 00:00:00+00", effective_to: "2025-01-01 00:00:00+00" }),
    { catalogType: "image", freezeAt: "2026-07-26T00:00:00.000Z", importRunId: "r" },
  );
  assert.equal(inverted.outcome, "quarantine");
});
