-- V0.1.1 参考测试域。
-- 测试只是人显式准备和归档的低成本验证；本迁移不创建生成任务，也不调用模型供应商。
-- 恢复/回滚：旧代码可以忽略这两张新表。若确实需要删除，先备份并由 DBA 手动执行 DROP TABLE。

CREATE TABLE IF NOT EXISTS {{schema}}.reference_tests (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  name varchar(128) NOT NULL,
  media_kind varchar(16) NOT NULL,
  mode varchar(32) NOT NULL,
  model_key varchar(128) NOT NULL,
  prompt text NOT NULL DEFAULT '',
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_media_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  CONSTRAINT reference_tests_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 128),
  CONSTRAINT reference_tests_media_kind_check CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT reference_tests_mode_check CHECK (mode IN ('direct_reference', 'material_to_prompt')),
  CONSTRAINT reference_tests_model_key_check CHECK (char_length(btrim(model_key)) BETWEEN 1 AND 128),
  CONSTRAINT reference_tests_parameters_object_check CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT reference_tests_reference_media_ids_array_check CHECK (jsonb_typeof(reference_media_ids) = 'array'),
  CONSTRAINT reference_tests_version_check CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS reference_tests_project_updated_idx
  ON {{schema}}.reference_tests (project_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.reference_test_results (
  id uuid PRIMARY KEY,
  reference_test_id uuid NOT NULL REFERENCES {{schema}}.reference_tests(id) ON DELETE CASCADE,
  generation_request_id uuid NOT NULL REFERENCES {{schema}}.generation_requests(id),
  media_result_id uuid NOT NULL REFERENCES {{schema}}.media_results(id),
  media_kind varchar(16) NOT NULL,
  mode varchar(32) NOT NULL,
  model_key varchar(128) NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reference_test_results_media_kind_check CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT reference_test_results_mode_check CHECK (mode IN ('direct_reference', 'material_to_prompt')),
  CONSTRAINT reference_test_results_model_key_check CHECK (char_length(btrim(model_key)) BETWEEN 1 AND 128),
  CONSTRAINT reference_test_results_parameters_object_check CHECK (jsonb_typeof(parameters) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS reference_test_results_test_media_unique
  ON {{schema}}.reference_test_results (reference_test_id, media_result_id);
CREATE INDEX IF NOT EXISTS reference_test_results_test_created_idx
  ON {{schema}}.reference_test_results (reference_test_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS reference_test_results_request_idx
  ON {{schema}}.reference_test_results (generation_request_id, media_result_id);
