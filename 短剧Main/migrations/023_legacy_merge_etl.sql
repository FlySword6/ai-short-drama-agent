-- 合流一期 ETL 台账:legacy 身份 crosswalk + ETL 运行/闭包记录。
-- 真源:docs/contracts/common-to-v020-mapping.md §3(crosswalk 设计)与 §4(ETL 规格)。
--
-- 核心边界:
--   1. 本迁移只建"账簿"表(身份对照、运行记录、闭包记录),不搬任何业务数据;
--      数据搬运只能经 scripts/legacy-merge-etl/ 在获批窗口内显式执行。
--   2. 不做同名表 ALTER:旧 common 行与新 app 行只靠 crosswalk 关联,各自独立。
--   3. 两套迁移账本分开:本表记录的是 ETL 运行账,与 schema_migrations(结构账)
--      和对方 public.migrations(TypeORM 账)互不写入(红线 R7)。
--   4. 账簿不存凭据、不存 PII 超集:notes 只放人工匹配所必需的最小标识(红线 R1/R12)。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 全部语句幂等,可安全重放(CREATE IF NOT EXISTS)。
--
-- 回滚口径(先备份;旧代码不读这三表,保留亦无害):
--   DROP TABLE {{schema}}.legacy_import_closures;
--   DROP TABLE {{schema}}.legacy_import_runs;
--   DROP TABLE {{schema}}.legacy_identity_crosswalk;

-- =====================================================================
-- 1. legacy_identity_crosswalk:旧 id ↔ 新 id 的唯一身份对照。
--    每条源记录有且仅有一行(source 四元组唯一);decision 四值与
--    data-truth §4.D 验收公式对齐:source = matched + new + conflict + quarantined。
--    conflict/quarantined 时 target_id 必为 NULL(CHECK 强制)。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.legacy_identity_crosswalk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_system varchar(32) NOT NULL,
  source_schema varchar(64) NOT NULL,
  source_table varchar(64) NOT NULL,
  source_pk text NOT NULL,
  target_table varchar(64) NOT NULL,
  target_id uuid,
  match_rule varchar(32) NOT NULL,
  decision varchar(16) NOT NULL,
  import_run_id uuid NOT NULL,
  decided_by varchar(128),
  decided_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_crosswalk_decision_check
    CHECK (decision IN ('matched', 'new', 'conflict', 'quarantined')),
  CONSTRAINT legacy_crosswalk_match_rule_check
    CHECK (match_rule IN ('manual_confirmed', 'deterministic_key', 'content_hash', 'import_new')),
  CONSTRAINT legacy_crosswalk_target_consistency_check
    CHECK ((decision IN ('matched', 'new') AND target_id IS NOT NULL)
        OR (decision IN ('conflict', 'quarantined') AND target_id IS NULL)
        -- project_members 是复合主键无单列 uuid:new 行 target_id 置空,身份由 source 四元组承载。
        OR (target_table = 'project_members' AND decision = 'new' AND target_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_crosswalk_source_unique
  ON {{schema}}.legacy_identity_crosswalk (source_system, source_schema, source_table, source_pk);
-- 目标身份一对一只约束 decision='new' 的新发行;matched 是"并入既有/本批行",
-- 天然多对一(如多条 prompt 并入同一 shot),不参与本索引。
CREATE UNIQUE INDEX IF NOT EXISTS legacy_crosswalk_target_unique
  ON {{schema}}.legacy_identity_crosswalk (source_system, target_table, target_id)
  WHERE target_id IS NOT NULL AND decision = 'new';
CREATE INDEX IF NOT EXISTS legacy_crosswalk_run_idx
  ON {{schema}}.legacy_identity_crosswalk (import_run_id);

-- =====================================================================
-- 2. legacy_import_runs:一次 ETL 运行(含 dry-run)。
--    dry-run 也落账(mode='dry_run'),供执行前人工审阅计划;apply 运行
--    与 dry-run 计划在账上可对比。stats_json 只存计数,不存行内容。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.legacy_import_runs (
  id uuid PRIMARY KEY,
  source_system varchar(32) NOT NULL,
  source_schema varchar(64) NOT NULL,
  mode varchar(16) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'running',
  scope_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by varchar(128),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  notes text,
  CONSTRAINT legacy_import_runs_mode_check CHECK (mode IN ('dry_run', 'apply')),
  CONSTRAINT legacy_import_runs_status_check
    CHECK (status IN ('running', 'completed', 'completed_with_issues', 'failed', 'aborted')),
  CONSTRAINT legacy_import_runs_scope_shape_check CHECK (jsonb_typeof(scope_json) = 'object'),
  CONSTRAINT legacy_import_runs_stats_shape_check CHECK (jsonb_typeof(stats_json) = 'object'),
  CONSTRAINT legacy_import_runs_finished_shape_check
    CHECK ((status IN ('completed', 'completed_with_issues', 'failed', 'aborted')) = (finished_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS legacy_import_runs_started_idx
  ON {{schema}}.legacy_import_runs (started_at DESC);

-- =====================================================================
-- 3. legacy_import_closures:闭包粒度的迁移状态/校验/回滚账。
--    迁移单位是实体闭包(如"一个项目"= 项目行+成员+资产引用+被引用
--    资产实体+分镜提示词),不是表。每个闭包一行:
--      status       迁移状态机:planned → migrated → (verify_bucket 三桶)
--                   → conflict/quarantined(需人工)/ failed(迁错)
--                   → rolled_back(已按 target_ids_json 撤销)
--      verify_bucket 三桶验收:identical(完全一致)/ needs_human(有差异
--                   需人工确认)/ failed(迁移失败)。
--      target_ids_json 是回滚唯一依据:本闭包写入的全部目标行 id,撤销时
--    按单删除(ETL 只插入新发 uuid 的行,删除安全),同事务删 crosswalk 行。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.legacy_import_closures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES {{schema}}.legacy_import_runs(id),
  closure_type varchar(32) NOT NULL,
  closure_key text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'planned',
  verify_bucket varchar(16),
  source_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_ids_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  verify_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code varchar(64),
  error_message varchar(512),
  decided_by varchar(128),
  decided_at timestamptz,
  migrated_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legacy_import_closures_type_check
    CHECK (closure_type IN ('user', 'project', 'asset', 'pricing_rule')),
  CONSTRAINT legacy_import_closures_status_check
    CHECK (status IN ('planned', 'migrated', 'conflict', 'quarantined', 'failed', 'rolled_back')),
  CONSTRAINT legacy_import_closures_bucket_check
    CHECK (verify_bucket IS NULL OR verify_bucket IN ('identical', 'needs_human', 'failed')),
  CONSTRAINT legacy_import_closures_source_counts_shape_check CHECK (jsonb_typeof(source_counts_json) = 'object'),
  CONSTRAINT legacy_import_closures_target_ids_shape_check CHECK (jsonb_typeof(target_ids_json) = 'object'),
  CONSTRAINT legacy_import_closures_verify_shape_check CHECK (jsonb_typeof(verify_json) = 'object'),
  CONSTRAINT legacy_import_closures_migrated_shape_check
    CHECK (status <> 'migrated' OR migrated_at IS NOT NULL),
  CONSTRAINT legacy_import_closures_rollback_shape_check
    CHECK (status <> 'rolled_back' OR rolled_back_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS legacy_import_closures_run_key_unique
  ON {{schema}}.legacy_import_closures (run_id, closure_type, closure_key);
CREATE INDEX IF NOT EXISTS legacy_import_closures_status_idx
  ON {{schema}}.legacy_import_closures (run_id, status);
