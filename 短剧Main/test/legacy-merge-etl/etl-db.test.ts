import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";
import { settings } from "../../src/config/env.js";
import { renderMigrationSql } from "../../src/db/migrate.js";
import { executeRun, rollbackClosure, type EtlRunConfig } from "../../scripts/legacy-merge-etl/lib/runner.mjs";
import { PASSWORD_HASH_SENTINEL, type ManualDecision } from "../../scripts/legacy-merge-etl/lib/transforms.mjs";

/**
 * 合流 ETL 真库集成验证(单测试顺序执行,各阶段共享一次 apply 的状态):
 *   阶段 1 dry-run   只落账,业务表零变化;
 *   阶段 2 apply     全量落库 + crosswalk 逐域账 + 守恒三桶 + 哨兵口令 + 红线诱饵;
 *   阶段 3 幂等      重跑零新增(含 conflict/quarantined 不重复记账);
 *   阶段 4 回滚      项目闭包按 target_ids_json 反查删除,用户闭包独立。
 * 源是手工 fixture schema `common`(迷你 they 侧),目标是重放全部 migrations 的本机库。
 * 连接串只允许本机或本地 Compose,拒绝云 RDS。
 */
const databaseUrl = process.env.LEGACY_ETL_TEST_DATABASE_URL;
const targetSchema = settings.postgresSchema;

const IMPORT_OWNER_ID = "00000000-0000-4000-8000-0000000000aa";
const U1 = "11111111-1111-4111-8111-111111111111"; // 有决定 → 迁
const U2 = "22222222-2222-4222-8222-222222222222"; // 无决定 → 候选
const U3 = "33333333-3333-4333-8333-333333333333"; // login 非法 → 隔离(决定也救不了)
const U4 = "44444444-4444-4444-8444-444444444444"; // deleted → 不抽取
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // owner u1,有决定 → 迁
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // owner u2 → 冲突
const E1 = "eeeeeeee-0001-4000-8000-eeeeeeeeeeee"; // 被 r1 引用 → 随项目闭包迁
const E2 = "eeeeeeee-0002-4000-8000-eeeeeeeeeeee"; // kind 超域 → 实体+ref 双隔离
const E3 = "eeeeeeee-0003-4000-8000-eeeeeeeeeeee"; // 孤儿实体 → asset 闭包迁
const E5 = "eeeeeeee-0005-4000-8000-eeeeeeeeeeee"; // 孤儿实体,人工指定隔离名单 → 隔离不迁
const SB1 = "5b5b5b5b-5b5b-45b5-85b5-5b5b5b5b5b5b";

function runConfig(mode: "dry_run" | "apply"): EtlRunConfig {
  assert.ok(databaseUrl);
  return {
    sourceUrl: databaseUrl,
    targetUrl: databaseUrl,
    sourceSchema: "common",
    targetSchema,
    mode,
    importOwnerId: IMPORT_OWNER_ID,
    userDecisions: new Map<string, ManualDecision>([
      [U1, { decision: "new", decidedBy: "fable" }],
      [U3, { decision: "new", decidedBy: "fable" }],
    ]),
    projectDecisions: new Map<string, ManualDecision>([[P1, { decision: "new", decidedBy: "fable" }]]),
    withPrompts: true,
    composeDirectorPrompt: false,
    autoCreateEpisodes: true,
    startedBy: "s25-test",
    freezeAt: "2026-07-26T00:00:00.000Z",
    domains: new Set(["user", "project", "asset", "pricing_rule"]),
    assetQuarantine: new Map([[E5, { reason: "图片归属错配(测试名单)", decidedBy: "s52-test" }]]),
  };
}

test("legacy ETL: dry-run → apply → 幂等 → 回滚 全链路", {
  skip: !databaseUrl,
  timeout: 300_000,
}, async () => {
  assert.ok(databaseUrl);
  assertLocalTestDatabase(databaseUrl);
  const setup = new Client({ connectionString: databaseUrl });
  await setup.connect();
  try {
    await replayMigrations(setup);
    await buildSourceFixture(setup);
    await seedImportOwner(setup);
  } finally {
    await setup.end();
  }

  const probe = new Client({ connectionString: databaseUrl });
  await probe.connect();
  try {
    const count = async (sql: string, params: unknown[] = []) =>
      Number((await probe.query<{ count: string }>(sql, params)).rows[0]!.count);
    const targetCount = (table: string) => count(`SELECT count(*)::text AS count FROM "${targetSchema}"."${table}"`);

    // ==================== 阶段 1: dry-run ====================
    const baseline = {
      users: await targetCount("users"),
      projects: await targetCount("projects"),
      assetEntities: await targetCount("asset_entities"),
      pricingRules: await targetCount("pricing_rules"),
      crosswalk: await targetCount("legacy_identity_crosswalk"),
    };
    const dry = await executeRun(runConfig("dry_run"));
    assert.equal(await targetCount("users"), baseline.users, "dry-run 不得写 users");
    assert.equal(await targetCount("projects"), baseline.projects, "dry-run 不得写 projects");
    assert.equal(await targetCount("asset_entities"), baseline.assetEntities, "dry-run 不得写 asset_entities");
    assert.equal(await targetCount("pricing_rules"), baseline.pricingRules, "dry-run 不得写 pricing_rules");
    assert.equal(await targetCount("legacy_identity_crosswalk"), baseline.crosswalk, "dry-run 不得写 crosswalk");
    assert.ok(dry.tally.planned > 0, "dry-run 应有计划行");
    assert.ok(dry.tally.candidates > 0, "dry-run 应认出候选(u2/p2 无人工决定)");
    const dryRunRow = (await probe.query<{ mode: string }>(
      `SELECT mode FROM "${targetSchema}".legacy_import_runs WHERE id=$1`, [dry.runId],
    )).rows[0]!;
    assert.equal(dryRunRow.mode, "dry_run", "dry-run 也落运行账");

    // ==================== 阶段 2: apply ====================
    const applied = await executeRun(runConfig("apply"));
    assert.equal(applied.tally.failed, 0, `不应有失败闭包: ${JSON.stringify(applied.tally)}`);
    assert.equal(applied.buckets.failed, 0, "守恒硬校验必须全过(无 failed 桶)");
    assert.ok(applied.buckets.needs_human > 0, "隔离/冲突项应进 needs_human 桶");

    // users:u1 迁入且口令是哨兵(诱饵 password_hash 不得被复制);u3 隔离;u4 未抽取
    assert.equal(await targetCount("users"), baseline.users + 1);
    const landed = (await probe.query<{ password_hash: string; active: boolean }>(
      `SELECT password_hash, active FROM "${targetSchema}".users WHERE username='zhangsan'`,
    )).rows[0]!;
    assert.equal(landed.password_hash, PASSWORD_HASH_SENTINEL, "口令必须是不可解析哨兵(红线 R1)");
    assert.equal(landed.active, true);

    // crosswalk 逐域账(预期见 fixture 注释):
    //   new=8:u1 p1 r1 e1 e3 sb1 + 2 pricing
    //   matched=2:pr1 pr2 合并入 shot
    //   conflict=1:p2(owner 未解析)
    //   quarantined=7:u3 g2 r2 e2 pr3 + 1 pricing(fixed_fee≠0) + e5(人工指定隔离)
    const decisions = async (decision: string) => count(
      `SELECT count(*)::text AS count FROM "${targetSchema}".legacy_identity_crosswalk WHERE import_run_id=$1 AND decision=$2`,
      [applied.runId, decision],
    );
    assert.equal(await decisions("new"), 8, "u1 p1 r1 e1 e3 sb1 + 2 pricing");
    assert.equal(await decisions("matched"), 2, "pr1 pr2 合并入 shot");
    assert.equal(await decisions("conflict"), 1, "p2 owner 未解析");
    assert.equal(await decisions("quarantined"), 7, "u3 g2 r2 e2 pr3 + fixed_fee 规则 + e5 人工隔离");

    // e5 人工指定隔离:不得落业务表,crosswalk 留理由与登记人
    assert.equal(
      await count(`SELECT count(*)::text AS count FROM "${targetSchema}".asset_entities WHERE name='带病场景'`),
      0, "人工指定隔离的实体不得迁入",
    );
    const e5Row = (await probe.query<{ decision: string; notes: string }>(
      `SELECT decision, notes FROM "${targetSchema}".legacy_identity_crosswalk WHERE import_run_id=$1 AND source_table='asset_entities' AND source_pk=$2`,
      [applied.runId, E5],
    )).rows[0]!;
    assert.equal(e5Row.decision, "quarantined");
    assert.match(e5Row.notes, /人工指定隔离\(by s52-test\): 图片归属错配/);

    // 成员:项目恰一个 owner(g2 用户未解析 → 隔离,不进成员表)
    const members = await probe.query<{ role: string }>(
      `SELECT m.role FROM "${targetSchema}".project_members m
       JOIN "${targetSchema}".projects p ON p.id = m.project_id WHERE p.name='迁移项目一'`,
    );
    assert.deepEqual(members.rows.map((row) => row.role), ["owner"]);

    // shots:分镜迁入,两类提示词按链接规则落位
    const shot = (await probe.query<{ shot_code: string; image_prompt: string | null; video_prompt: string | null }>(
      `SELECT shot_code, image_prompt, video_prompt FROM "${targetSchema}".shots WHERE shot_code='G01'`,
    )).rows[0]!;
    assert.equal(shot.image_prompt, "女主特写 image prompt", "metadata 回链优先");
    assert.equal(shot.video_prompt, "推镜 video prompt", "(episode,shot) 兜底");

    // pricing:图片规则换算为分;text 不迁;fixed_fee≠0 隔离
    const pricing = (await probe.query<{ billing_unit: string; unit_price_fen: number }>(
      `SELECT billing_unit, unit_price_fen FROM "${targetSchema}".pricing_rules WHERE model='seedream-4'`,
    )).rows[0]!;
    assert.deepEqual(pricing, { billing_unit: "image", unit_price_fen: 8 });
    assert.equal(await count(`SELECT count(*)::text AS count FROM "${targetSchema}".pricing_rules WHERE model='gpt'`), 0, "text 不迁");

    // ==================== 阶段 3: 幂等重跑 ====================
    const before = {
      users: await targetCount("users"),
      shots: await targetCount("shots"),
      pricing: await targetCount("pricing_rules"),
      crosswalk: await targetCount("legacy_identity_crosswalk"),
    };
    const rerun = await executeRun(runConfig("apply"));
    assert.equal(rerun.tally.migrated, 0, "重跑不应有新迁移闭包");
    assert.ok(rerun.tally.skipped > 0, "重跑应识别已决行(含 conflict/quarantined 不重复记账)");
    assert.equal(await targetCount("users"), before.users);
    assert.equal(await targetCount("shots"), before.shots);
    assert.equal(await targetCount("pricing_rules"), before.pricing);
    assert.equal(await targetCount("legacy_identity_crosswalk"), before.crosswalk, "重跑不得新增 crosswalk 行");

    // ==================== 阶段 4: 闭包粒度回滚 ====================
    const rollback = await rollbackClosure({
      targetUrl: databaseUrl, targetSchema, runId: applied.runId, closureKey: `project:${P1}`,
    });
    assert.equal(rollback.deleted["projects"], 1, JSON.stringify(rollback.deleted));
    assert.equal(rollback.deleted["project_members"], 1);
    assert.equal(rollback.deleted["project_asset_refs"], 1, "只有 r1 落库(r2 被隔离)");
    assert.equal(rollback.deleted["asset_entities"], 1, "e1 随闭包回滚;e3 是独立闭包不受影响");
    assert.equal(rollback.deleted["shots"], 1);
    assert.equal(rollback.deleted["episodes"], 1);
    const closureRow = (await probe.query<{ status: string }>(
      `SELECT status FROM "${targetSchema}".legacy_import_closures WHERE run_id=$1 AND closure_key=$2`,
      [applied.runId, `project:${P1}`],
    )).rows[0]!;
    assert.equal(closureRow.status, "rolled_back");
    assert.equal(
      await count(`SELECT count(*)::text AS count FROM "${targetSchema}".projects WHERE name='迁移项目一'`),
      0, "项目行已随回滚删除",
    );
    assert.equal(
      await count(`SELECT count(*)::text AS count FROM "${targetSchema}".users WHERE username='zhangsan'`),
      1, "用户闭包独立,不受项目回滚影响",
    );
  } finally {
    await probe.end();
  }
});

// ---------------------------------------------------------------------------
// fixture 与工具
// ---------------------------------------------------------------------------

function assertLocalTestDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!["127.0.0.1", "localhost", "db"].includes(host)) {
    throw new Error("LEGACY_ETL_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL,拒绝连接云 RDS");
  }
}

async function replayMigrations(client: Client): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${targetSchema}"`);
  const files = (await readdir(path.resolve("migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const source = await readFile(path.resolve("migrations", file), "utf8");
    await client.query(renderMigrationSql(source, targetSchema));
  }
}

async function buildSourceFixture(client: Client): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS common CASCADE");
  await client.query("CREATE SCHEMA common");
  // 迷你 they 侧 schema:只建白名单列 + 一个红线诱饵列(password_hash)。
  await client.query(`
CREATE TABLE common.users (
  id uuid PRIMARY KEY, login_name varchar(128), display_name varchar(128) NOT NULL,
  email varchar(255), auth_subject_id varchar(128), current_organization_id uuid,
  status varchar(20) NOT NULL DEFAULT 'active', is_disabled boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  password_hash text
);
CREATE TABLE common.projects (
  id uuid PRIMARY KEY, project_code varchar(64) NOT NULL, name varchar(128) NOT NULL,
  owner_user_id uuid NOT NULL, owner_team_id uuid, owner_organization_id uuid,
  status varchar(20) NOT NULL DEFAULT 'draft', description text,
  budget_amount numeric(18,4) NOT NULL DEFAULT 0, budget_spent_amount numeric(18,4) NOT NULL DEFAULT 0,
  budget_remaining_amount numeric(18,4) NOT NULL DEFAULT 0,
  cover_image_url text, start_time timestamptz, end_time timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE common.project_access_grants (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, user_id uuid NOT NULL,
  role_type varchar(32) NOT NULL, role_level integer NOT NULL DEFAULT 0,
  source_type varchar(20) NOT NULL DEFAULT 'explicit', is_active boolean NOT NULL DEFAULT true,
  is_disabled boolean NOT NULL DEFAULT false, revoked_at timestamptz,
  granted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE common.asset_entities (
  id uuid PRIMARY KEY, source_project_id uuid, source_project_name varchar(255),
  asset_kind varchar(32) NOT NULL, name varchar(255) NOT NULL, display_name varchar(255),
  intro text, appearance text, age_value integer, gender varchar(64), category varchar(255),
  style_tags jsonb NOT NULL DEFAULT '[]'::jsonb, approved boolean DEFAULT false,
  reuse_scope varchar(32) NOT NULL DEFAULT 'all_projects', status varchar(20) NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL, updated_at timestamp NOT NULL
);
CREATE TABLE common.project_asset_refs (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, project_name varchar(255),
  asset_entity_id uuid NOT NULL, asset_kind varchar(32) NOT NULL,
  role_type varchar(255), role_name varchar(255), character_name varchar(255), usage_note text,
  status varchar(20) NOT NULL DEFAULT 'active', metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE common.project_director_storyboard_prompts (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, script_id uuid, breakdown_run_id uuid,
  project_name varchar(255), episode_no integer, shot_no integer, scene_name varchar(255),
  director_prompt_text text, shot_description text, camera_movement varchar(255),
  lighting varchar(255), sound_instruction text,
  status varchar(20) NOT NULL DEFAULT 'active', metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL, updated_at timestamp NOT NULL
);
CREATE TABLE common.project_prompts (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, script_id uuid, breakdown_run_id uuid,
  project_name varchar(255), episode_no integer, shot_no integer,
  prompt_type varchar(64) NOT NULL, prompt_text text NOT NULL, model_name varchar(255),
  status varchar(20) NOT NULL DEFAULT 'active', metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE common.model_pricing_rules (
  id uuid PRIMARY KEY, provider_name varchar(64) NOT NULL, model_name varchar(128) NOT NULL,
  pricing_unit varchar(20) NOT NULL, input_unit_price numeric(18,6) NOT NULL DEFAULT 0,
  output_unit_price numeric(18,6) NOT NULL DEFAULT 0, fixed_fee numeric(18,6) NOT NULL DEFAULT 0,
  currency varchar(16) NOT NULL DEFAULT 'CNY',
  effective_from timestamptz, effective_to timestamptz, status varchar(20) NOT NULL DEFAULT 'active'
);
CREATE TABLE common.model_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), model_key varchar(255),
  provider_name varchar(64) NOT NULL, model_name varchar(128) NOT NULL,
  model_type varchar(20) NOT NULL, is_enabled boolean NOT NULL DEFAULT true
)`);
  const ts = "2024-06-01 08:00:00+00";
  await client.query(
    `INSERT INTO common.users (id, login_name, display_name, email, status, is_disabled, created_at, updated_at, password_hash) VALUES
      ($1, 'zhangsan', '张三', 'z@example.com', 'active', false, $5, $5, 'scrypt:16384:8:1:realsalt:realhash-DECOY-诱饵不得被抽取'),
      ($2, 'lisi', '李四', null, 'active', false, $5, $5, 'scrypt:16384:8:1:realsalt:otherhash-DECOY'),
      ($3, 'Bad Name!', '坏名字', null, 'active', false, $5, $5, null),
      ($4, 'deleted_user', '已删', null, 'deleted', false, $5, $5, null)`,
    [U1, U2, U3, U4, ts],
  );
  await client.query(
    `INSERT INTO common.projects (id, project_code, name, owner_user_id, status, description, created_at, updated_at) VALUES
      ($1, 'PRJ-001', '迁移项目一', $3, 'active', '首个迁移项目', $4, $4),
      ($2, 'PRJ-002', '悬空项目', $5, 'draft', null, $4, $4)`,
    [P1, P2, U1, ts, U2],
  );
  await client.query(
    `INSERT INTO common.project_access_grants (id, project_id, user_id, role_type, role_level, granted_at, created_at, updated_at) VALUES
      (gen_random_uuid(), $1, $2, 'owner', 100, $3, $3, $3),
      (gen_random_uuid(), $1, $4, 'collaborator', 10, $3, $3, $3)`,
    [P1, U1, ts, U2],
  );
  await client.query(
    `INSERT INTO common.asset_entities (id, asset_kind, name, display_name, approved, status, created_at, updated_at) VALUES
      ($1, 'character', '角色甲', '角色甲', true, 'active', $4, $4),
      ($2, 'vehicle', '道具车', '道具车', false, 'active', $4, $4),
      ($3, 'scene', '孤儿场景', '孤儿场景', false, 'active', $4, $4),
      ($5, 'scene', '带病场景', '带病场景', false, 'active', $4, $4)`,
    [E1, E2, E3, ts, E5],
  );
  await client.query(
    `INSERT INTO common.project_asset_refs (id, project_id, asset_entity_id, asset_kind, role_type, character_name, created_at, updated_at) VALUES
      (gen_random_uuid(), $1, $2, 'character', 'lead', '小白', $3, $3),
      (gen_random_uuid(), $1, $4, 'vehicle', 'prop', '道具车', $3, $3)`,
    [P1, E1, ts, E2],
  );
  await client.query(
    `INSERT INTO common.project_director_storyboard_prompts
      (id, project_id, episode_no, shot_no, scene_name, director_prompt_text, shot_description, created_at, updated_at)
     VALUES ($1, $2, 1, 1, '酒吧', '压抑基调', '女主独坐', $3, $3)`,
    [SB1, P1, ts],
  );
  await client.query(
    `INSERT INTO common.project_prompts (id, project_id, episode_no, shot_no, prompt_type, prompt_text, metadata, created_at, updated_at) VALUES
      (gen_random_uuid(), $1, 9, 9, 'storyboard_image', '女主特写 image prompt', jsonb_build_object('project_director_storyboard_prompt_id', $2::text), $3, $3),
      (gen_random_uuid(), $1, 1, 1, 'shot_video', '推镜 video prompt', '{}'::jsonb, $3, $3),
      (gen_random_uuid(), $1, 8, 8, 'storyboard_image', '无主 prompt', '{}'::jsonb, $3, $3)`,
    [P1, SB1, ts],
  );
  await client.query(
    `INSERT INTO common.model_catalog (model_key, provider_name, model_name, model_type, is_enabled) VALUES
      ('volc:seedream-4', 'volc', 'seedream-4', 'image', true),
      ('volc:seedance', 'volc', 'seedance', 'video', true),
      ('openai:gpt', 'openai', 'gpt', 'text', true)`,
  );
  await client.query(
    `INSERT INTO common.model_pricing_rules
      (id, provider_name, model_name, pricing_unit, input_unit_price, output_unit_price, fixed_fee, effective_from) VALUES
      (gen_random_uuid(), 'volc', 'seedream-4', 'image', 0.1, 0.08, 0, $1),
      (gen_random_uuid(), 'volc', 'seedance', 'sec', 0, 1.5, 0, $1),
      (gen_random_uuid(), 'openai', 'gpt', 'token', 0.001, 0.002, 0, $1),
      (gen_random_uuid(), 'volc', 'seedream-4', 'image', 0, 0.5, 2.5, $1)`,
    [ts],
  );
}

async function seedImportOwner(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "${targetSchema}".users (id, username, display_name, password_hash, active, role)
     VALUES ($1, $2, 'ETL Import Owner', 'test-only-hash', true, 'admin')
     ON CONFLICT (id) DO NOTHING`,
    [IMPORT_OWNER_ID, `import-owner-${randomUUID().slice(0, 8)}`],
  );
}
