-- V0.1.1 测试域默认策略。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不应自动执行迁移。
-- 恢复/回滚：先备份本表；如必须回退代码，可保留本表（旧代码不会读取）。
-- 只有在确认不再需要策略历史时，才由 DBA 手工 DROP TABLE {{schema}}.generation_default_strategies。

CREATE TABLE IF NOT EXISTS {{schema}}.generation_default_strategies (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  media_kind varchar(16) NOT NULL,
  mode varchar(32) NOT NULL,
  model_key varchar(128) NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_generation_request_id uuid REFERENCES {{schema}}.generation_requests(id) ON DELETE SET NULL,
  updated_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_default_strategies_media_kind_check
    CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT generation_default_strategies_mode_check
    CHECK (mode IN ('direct_reference', 'material_to_prompt')),
  CONSTRAINT generation_default_strategies_model_key_check
    CHECK (char_length(btrim(model_key)) BETWEEN 1 AND 128),
  CONSTRAINT generation_default_strategies_parameters_object_check
    CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT generation_default_strategies_version_check
    CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS generation_default_strategies_project_media_unique
  ON {{schema}}.generation_default_strategies (project_id, media_kind);

CREATE INDEX IF NOT EXISTS generation_default_strategies_project_updated_idx
  ON {{schema}}.generation_default_strategies (project_id, updated_at DESC);
