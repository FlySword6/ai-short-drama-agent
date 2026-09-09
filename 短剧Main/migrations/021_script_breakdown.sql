-- 0.2.x 剧本拆解草稿区:剧本版本 + 拆解运行 + 分阶段检查点。
-- 真源:docs/proposals/script-breakdown-port.md(方案稿,S20 按任务包架构约束落地)。
--
-- 核心边界:AI 产出只进草稿区(script_breakdown_runs.draft_json 与各阶段
-- output_json),任何情况下不直接写正式 scenes/shots;只有人工确认动作
-- (POST /script-breakdowns/:id/confirm)在单事务内把草稿映射进正式表,
-- 并通过 scenes/shots.source_breakdown_run_id + source_candidate_id 留下
-- 可追溯关系。同一运行只能确认一次;重复确认按幂等返回同一结果。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 全部语句幂等,可安全重放(CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
-- DROP CONSTRAINT IF EXISTS + 同名重建)。
--
-- 回滚口径(先备份):
--   1) ALTER TABLE {{schema}}.shots  DROP COLUMN source_breakdown_run_id, DROP COLUMN source_candidate_id;
--      ALTER TABLE {{schema}}.scenes DROP COLUMN source_breakdown_run_id, DROP COLUMN source_candidate_id;
--      (需先清理引用:把引用拆解来源的 shots/scenes 软删或置空两列)
--   2) DROP TABLE {{schema}}.script_breakdown_run_stages;
--      DROP TABLE {{schema}}.script_breakdown_runs;
--      DROP TABLE {{schema}}.episode_script_versions;
--      旧代码不读这三表,保留亦无害;确需清理由 DBA 手工执行。

-- =====================================================================
-- 1. episode_script_versions:一集剧本的不可变版本(追加写)。
--    剧本文本不进 episodes 列;每次拆解运行绑定一个版本,保证可回放、
--    可对比、可重拆不覆盖旧证据。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.episode_script_versions (
  id uuid PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES {{schema}}.episodes(id),
  version_no integer NOT NULL,
  title varchar(255),
  script_text text NOT NULL,
  script_sha256 varchar(64) NOT NULL,
  source varchar(16) NOT NULL DEFAULT 'manual',
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  client_idempotency_key varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT episode_script_versions_version_no_check CHECK (version_no > 0),
  CONSTRAINT episode_script_versions_script_text_check CHECK (length(btrim(script_text)) > 0),
  CONSTRAINT episode_script_versions_source_check CHECK (source IN ('manual', 'import'))
);

CREATE UNIQUE INDEX IF NOT EXISTS episode_script_versions_episode_version_unique
  ON {{schema}}.episode_script_versions (episode_id, version_no);
-- 幂等:同一用户重复提交同一幂等键返回同一版本,不重复建行。
CREATE UNIQUE INDEX IF NOT EXISTS episode_script_versions_creator_idem_unique
  ON {{schema}}.episode_script_versions (created_by_user_id, client_idempotency_key);
CREATE INDEX IF NOT EXISTS episode_script_versions_episode_idx
  ON {{schema}}.episode_script_versions (episode_id, created_at DESC);

-- =====================================================================
-- 2. script_breakdown_runs:一次拆解运行(草稿区聚合根)。
--    状态机:queued → running → draft(全部阶段完成且校验通过)
--                         → failed(任一阶段失败,可 resume 续跑)
--            draft → confirmed(人工确认,仅一次)→ superseded(被同集
--            更新的确认替换);queued/running/failed/draft → discarded。
--    draft_json 只存草稿(摘要/场次/资产候选/分镜候选);usage_json 汇总
--    各阶段 token;estimated/actual_cost_fen 暂不计价,保持 NULL。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.script_breakdown_runs (
  id uuid PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES {{schema}}.episodes(id),
  script_version_id uuid NOT NULL REFERENCES {{schema}}.episode_script_versions(id),
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  client_idempotency_key varchar(255) NOT NULL,
  request_hash varchar(64) NOT NULL,
  model_name varchar(128),
  prompt_version varchar(64) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'queued',
  current_stage varchar(64),
  target_duration_sec integer,
  input_sha256 varchar(64) NOT NULL,
  draft_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_json jsonb NOT NULL DEFAULT '{"issues":[]}'::jsonb,
  usage_json jsonb NOT NULL DEFAULT '{"call_count":0,"total_input_tokens":0,"total_output_tokens":0}'::jsonb,
  estimated_cost_fen integer,
  actual_cost_fen integer,
  error_code varchar(64),
  error_message varchar(512),
  confirmed_by_user_id uuid REFERENCES {{schema}}.users(id),
  confirmed_at timestamptz,
  discarded_by_user_id uuid REFERENCES {{schema}}.users(id),
  discarded_at timestamptz,
  superseded_by_run_id uuid REFERENCES {{schema}}.script_breakdown_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT script_breakdown_runs_status_check
    CHECK (status IN ('queued', 'running', 'draft', 'failed', 'confirmed', 'discarded', 'superseded')),
  CONSTRAINT script_breakdown_runs_target_duration_check
    CHECK (target_duration_sec IS NULL OR target_duration_sec > 0),
  CONSTRAINT script_breakdown_runs_draft_json_check CHECK (jsonb_typeof(draft_json) = 'object'),
  CONSTRAINT script_breakdown_runs_validation_json_check CHECK (jsonb_typeof(validation_json) = 'object'),
  CONSTRAINT script_breakdown_runs_usage_json_check CHECK (jsonb_typeof(usage_json) = 'object'),
  CONSTRAINT script_breakdown_runs_confirmed_shape_check
    CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND confirmed_by_user_id IS NOT NULL)),
  CONSTRAINT script_breakdown_runs_discarded_shape_check
    CHECK (status <> 'discarded' OR (discarded_at IS NOT NULL AND discarded_by_user_id IS NOT NULL)),
  CONSTRAINT script_breakdown_runs_superseded_shape_check
    CHECK (status <> 'superseded' OR superseded_by_run_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS script_breakdown_runs_creator_idem_unique
  ON {{schema}}.script_breakdown_runs (created_by_user_id, client_idempotency_key);
CREATE INDEX IF NOT EXISTS script_breakdown_runs_episode_idx
  ON {{schema}}.script_breakdown_runs (episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS script_breakdown_runs_script_version_idx
  ON {{schema}}.script_breakdown_runs (script_version_id);

-- =====================================================================
-- 3. script_breakdown_run_stages:数据驱动调用计划的逐步检查点。
--    每次模型调用(含一次 JSON 修复)落一行阶段状态;失败只重跑失败
--    阶段,不整条重来。validation_json 只存可诊断结构(期望/实际形状、
--    受限的校验条目),不存 provider 原始响应。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.script_breakdown_run_stages (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES {{schema}}.script_breakdown_runs(id) ON DELETE CASCADE,
  stage_key varchar(64) NOT NULL,
  stage_order integer NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  output_json jsonb,
  validation_json jsonb NOT NULL DEFAULT '{"issues":[]}'::jsonb,
  usage_json jsonb NOT NULL DEFAULT '{"calls":[]}'::jsonb,
  error_code varchar(64),
  error_message varchar(512),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT script_breakdown_run_stages_status_check
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  CONSTRAINT script_breakdown_run_stages_output_json_check
    CHECK (output_json IS NULL OR jsonb_typeof(output_json) = 'object'),
  CONSTRAINT script_breakdown_run_stages_validation_json_check CHECK (jsonb_typeof(validation_json) = 'object'),
  CONSTRAINT script_breakdown_run_stages_usage_json_check CHECK (jsonb_typeof(usage_json) = 'object'),
  CONSTRAINT script_breakdown_run_stages_shape_check
    CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS script_breakdown_run_stages_run_key_unique
  ON {{schema}}.script_breakdown_run_stages (run_id, stage_key);
CREATE INDEX IF NOT EXISTS script_breakdown_run_stages_run_idx
  ON {{schema}}.script_breakdown_run_stages (run_id, stage_order);

-- =====================================================================
-- 4. scenes/shots 追溯列:人工确认落正式表后,正式行记录来源运行与
--    草稿候选 ID。部分唯一索引兜底「同一候选只落一次正式行」
--    (被替换的旧行已软删,不占用唯一位)。
-- =====================================================================
ALTER TABLE {{schema}}.scenes ADD COLUMN IF NOT EXISTS source_breakdown_run_id uuid
  REFERENCES {{schema}}.script_breakdown_runs(id);
ALTER TABLE {{schema}}.scenes ADD COLUMN IF NOT EXISTS source_candidate_id varchar(64);
ALTER TABLE {{schema}}.shots ADD COLUMN IF NOT EXISTS source_breakdown_run_id uuid
  REFERENCES {{schema}}.script_breakdown_runs(id);
ALTER TABLE {{schema}}.shots ADD COLUMN IF NOT EXISTS source_candidate_id varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS scenes_breakdown_candidate_unique
  ON {{schema}}.scenes (source_breakdown_run_id, source_candidate_id)
  WHERE source_breakdown_run_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shots_breakdown_candidate_unique
  ON {{schema}}.shots (source_breakdown_run_id, source_candidate_id)
  WHERE source_breakdown_run_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS scenes_source_breakdown_run_idx
  ON {{schema}}.scenes (source_breakdown_run_id) WHERE source_breakdown_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shots_source_breakdown_run_idx
  ON {{schema}}.shots (source_breakdown_run_id) WHERE source_breakdown_run_id IS NOT NULL;
