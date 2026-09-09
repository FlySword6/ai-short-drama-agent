import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertDriftSchemaName,
  assertLocalDatabaseUrl,
  readDrizzleExpectations,
  sqlOwnedObjects,
} from "../scripts/check-schema-drift.mts";

const migrationsDirectory = path.resolve("migrations");

test("漂移检测只连本机/本地 Compose,云库主机一律拒绝", () => {
  for (const url of [
    "postgresql://u:p@127.0.0.1:5432/drift",
    "postgresql://u:p@localhost:5432/drift",
    "postgresql://u:p@db:5432/drift",
    "postgresql://u:p@postgres:5432/drift",
  ]) {
    assert.doesNotThrow(() => assertLocalDatabaseUrl(url));
  }
  for (const url of [
    "postgresql://u:p@pg-abc.rds.volces.com:5432/prod",
    "postgresql://u:p@10.0.1.8:5432/app",
    "postgresql://u:p@mydb.cluster-xxx.rds.amazonaws.com:5432/app",
  ]) {
    assert.throws(() => assertLocalDatabaseUrl(url), /绝不连云库/);
  }
  assert.throws(() => assertLocalDatabaseUrl("not-a-url"), /无法解析/);
});

test("漂移检测拒绝触碰真实业务 schema(它会 DROP 目标 schema)", () => {
  assert.doesNotThrow(() => assertDriftSchemaName("s22_drift_check"));
  assert.doesNotThrow(() => assertDriftSchemaName("s22_anything_else"));
  for (const real of ["app", "common", "public", "prod", "shortdrama_test"]) {
    assert.throws(() => assertDriftSchemaName(real), /拒绝触碰真实业务 schema/);
  }
  assert.throws(() => assertDriftSchemaName("bad;drop"), /非法/);
});

test("SQL 自有对象白名单与迁移/schema.ts 严格一致", async () => {
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
  const sources = await Promise.all(files.map((name) => readFile(path.join(migrationsDirectory, name), "utf8")));
  const schemaModule = await import("../src/db/schema.js");

  for (const [table] of sqlOwnedObjects) {
    if (table === "schema_migrations") continue; // 迁移器自建台账,不出现在迁移文件里
    const created = sources.some((source) =>
      new RegExp(`CREATE TABLE IF NOT EXISTS \\{\\{schema\\}\\}\\.${table}\\b`).test(source));
    assert.ok(created, `白名单对象 ${table} 在任何迁移里都找不到 CREATE TABLE——白名单不许挂空`);
  }

  // 反方向:迁移建的每张表都必须有归属(schema.ts 或白名单)。
  // 少了这一向,「迁移加了表但没人登记」就是护栏的盲区——迁移 023 的三张 ETL 表
  // 当初就是这么漏过去的:两边都没有,门禁却全绿。
  const { tables: expectedTables } = readDrizzleExpectations(
    Object.entries(schemaModule)
      .filter(([name]) => name !== "databaseSchema")
      .map(([, value]) => value),
  );
  const createdInMigrations = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(/CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.([a-z_][a-z0-9_]*)/g)) {
      createdInMigrations.add(match[1]!);
    }
  }
  const orphans = [...createdInMigrations]
    .filter((table) => !expectedTables.has(table) && !sqlOwnedObjects.has(table))
    .sort();
  assert.deepEqual(orphans, [],
    `这些表由迁移建出来但既不在 schema.ts 也不在 SQL 自有白名单里,没有归属:${orphans.join(", ")}`);

  // 白名单对象一旦进了 schema.ts,必须先从白名单移除(双重真源)。
  const { tables } = readDrizzleExpectations(
    Object.entries(schemaModule)
      .filter(([name]) => name !== "databaseSchema")
      .map(([, value]) => value),
  );
  for (const [table] of sqlOwnedObjects) {
    assert.equal(tables.has(table), false, `${table} 已进 schema.ts,白名单条目应删除`);
  }
});

test("Drizzle 期望读取:表/视图齐全,列类型映射对齐 information_schema", async () => {
  const schemaModule = await import("../src/db/schema.js");
  const { tables, views } = readDrizzleExpectations(
    Object.entries(schemaModule)
      .filter(([name]) => name !== "databaseSchema")
      .map(([, value]) => value),
  );

  // 锁定当前基线:47 张表 + cost_entries 视图(016 SQL 拥有,existing() 声明)。
  // 这是故意的绊线:schema 一变本行就必须有人改,改的时候要说清多/少了什么。
  // 44 → 47:迁移 021(剧本拆解)新增 episode_script_versions、
  // script_breakdown_runs、script_breakdown_run_stages 三张草稿区表。
  // 47 → 48:迁移 022(配置真源)新增 config_entries。
  // 48 → 49:迁移 025(等待期用户价值)新增 generation_attempt_notifications，
  // 让终态生成任务的站内提醒可跨页面、跨刷新保留。
  // 49 → 51:迁移 028(批量提交)新增 batch authorization 及其逐项清单，
  // 把一次人工授权、冻结总价和每项结果留为正式审计事实。
  // 51 → 52:迁移 029 新增 audio_versions，记录候选/已选/锁定/废弃生命周期。
  // 52 → 55:迁移 031(S41 标签体系+资产类型别名)新增 tag_vocabulary、
  // asset_tags、asset_kind_vocabulary 三张自指 canonical 词表/关联表。
  // 55 → 56:迁移 032(S42 上传提交队列)新增 asset_upload_tasks，
  // 让图片上传的排位/ETA/终态提醒与生成任务同一份等待期合同。
  // 56 → 57:迁移 033(S44 音色词表)新增 voice_vocabulary，
  // 豆包 TTS 音色落词表(自指 canonical + voice_type + audition_url),不走远程拉取。
  // 57 → 65:迁移 034(S57)新增邮箱验证、邀请码档位/码/核销和账户余额、日用量、台账
  // 八张表；65 → 68:迁移 035(S49)新增统一媒体溯源 subject/edge 与自产信任事实；
  // recursive authority 由 SQL 拥有、schema.ts 以 existing() 只读声明。
  // 68 → 70:迁移 036(S49 前向修复)新增报价关联的待补偿失败事实与 TOS 对象级 orphan 台账。
  // 70 → 71:迁移 038(S84)新增供应商实际成本账本 provider_costs。
  // 71 → 72:迁移 040 增加回收站清理的持久审计表 trash_purge_attempts。
  // 72 → 74:迁移 046 增加场级备戏清单与提交事实 scene_prep_items/scene_prep_commits。
  // 74 → 75:迁移 051 增加项目成员多选生产职责 project_member_production_roles，
  // 与 owner/editor/viewer 访问权限正交存储。
  // 75 → 79:迁移 052 增加展示变体、持久修理任务、hard-blocker 退避与不可变逐动作审计。
  // 79 → 80:迁移 053 增加火山素材组幂等映射 volc_asset_groups；
  // 既有 seedance_asset_registrations 仍是唯一素材登记真源。
  // 80 → 81:迁移 056 增加测试环境付费冒烟的持久防重账本，
  // Pod 重建后同一批次+档位仍不能再次触发付费调用。
  // 81 → 82:迁移 059 增加模型能力登记 model_capabilities，
  // 输出上限从此按模型自己的 max_output_tokens 走，不再写死在代码里。
  // 82 → 83:迁移 061 增加抽卡任务 casting_tasks——「这一镜缺哪件参考、要什么样子、
  // 派给谁做」的工单事实表;承接人是普通用户 ID,不新增角色枚举。
  // 83 → 84:迁移 062 增加 user_preferences——Grill 澄清引擎吸收的用户偏好
  // (preferred_genre/tone + style_tags + metadata)。
  // 84 → 87:迁移 063/064 增加 prompt_templates/prompt_default_templates——
  // 用户自建提示词模板与系统默认模板(不随数据库语言/种子重复下发)；
  // 迁移 065 增加 shot_asset_refs——Lite 分镜资产引用(参考/首帧/尾帧,复用 asset_entities)；
  // 87 → 88:迁移 066 增加 video_ingest_tasks——视频参考 LAS 异步解析任务队列。
  // 88 → 89:迁移 067 增加 project_styles——Lite 项目风格预设(项目级样式模板,
  // project_styles_one_default_key 部分唯一索引兜底并发)。
  // 89 → 91:迁移 075 增加企业微信身份映射与一次性 OAuth 事务表。
  assert.equal(tables.size, 91);
  assert.deepEqual([...views], ["cost_entries", "media_provenance_authority"]);

  const users = tables.get("users")!;
  assert.deepEqual(users.get("username"), { type: "character varying(64)", notNull: true });
  assert.deepEqual(users.get("password_hash"), { type: "text", notNull: false });
  assert.deepEqual(users.get("active"), { type: "boolean", notNull: true });
  assert.deepEqual(users.get("created_at"), { type: "timestamp with time zone", notNull: true });
  assert.deepEqual(users.get("id"), { type: "uuid", notNull: true });

  // timestamp 不带时区时要映射到 information_schema 的完整写法。
  const assetSourceProjects = tables.get("asset_source_projects")!;
  assert.deepEqual(assetSourceProjects.get("created_at"), { type: "timestamp without time zone", notNull: false });

  const topicRadarSnapshots = tables.get("topic_radar_snapshots")!;
  assert.deepEqual(topicRadarSnapshots.get("cache_date"), { type: "date", notNull: true });
  assert.deepEqual(topicRadarSnapshots.get("raw_payload"), { type: "jsonb", notNull: true });

  const projectMemberProductionRoles = tables.get("project_member_production_roles")!;
  assert.deepEqual(projectMemberProductionRoles.get("project_id"), { type: "uuid", notNull: true });
  assert.deepEqual(projectMemberProductionRoles.get("user_id"), { type: "uuid", notNull: true });
  assert.deepEqual(projectMemberProductionRoles.get("role"), { type: "character varying(32)", notNull: true });
  assert.deepEqual(projectMemberProductionRoles.get("assigned_by_user_id"), { type: "uuid", notNull: true });

  const wecomUserIdentities = tables.get("wecom_user_identities")!;
  assert.deepEqual(wecomUserIdentities.get("user_id"), { type: "uuid", notNull: true });
  assert.deepEqual(wecomUserIdentities.get("corp_id"), { type: "character varying(64)", notNull: true });
  assert.deepEqual(wecomUserIdentities.get("wecom_user_id"), { type: "character varying(64)", notNull: true });

  const wecomAuthTransactions = tables.get("wecom_auth_transactions")!;
  assert.deepEqual(wecomAuthTransactions.get("state_hash"), { type: "character varying(64)", notNull: true });
  assert.deepEqual(wecomAuthTransactions.get("result_hash"), { type: "character varying(64)", notNull: false });
  assert.deepEqual(wecomAuthTransactions.get("resolved_user_id"), { type: "uuid", notNull: false });

  const volcAssetGroups = tables.get("volc_asset_groups")!;
  assert.deepEqual(volcAssetGroups.get("volc_asset_group_id"), { type: "character varying(128)", notNull: false });
  assert.deepEqual(volcAssetGroups.get("status"), { type: "character varying(16)", notNull: true });
  assert.deepEqual(volcAssetGroups.get("retry_count"), { type: "integer", notNull: true });

  const videoIngestTasks = tables.get("video_ingest_tasks")!;
  assert.deepEqual(videoIngestTasks.get("id"), { type: "uuid", notNull: true });
  assert.deepEqual(videoIngestTasks.get("asset_media_id"), { type: "uuid", notNull: true });
  assert.deepEqual(videoIngestTasks.get("status"), { type: "character varying(16)", notNull: true });
  assert.deepEqual(videoIngestTasks.get("attempt_count"), { type: "integer", notNull: true });
  assert.deepEqual(videoIngestTasks.get("raw_result"), { type: "jsonb", notNull: false });
});
