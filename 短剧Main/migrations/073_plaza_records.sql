-- 073：创作广场（项目维度）独立生成记录表（2026-08-19）。
-- 广场右栏只认本表行：由广场发起的生成单独成账，不混入项目生产链
-- 的在途/产物列表（计费与队列真源仍是 generation_requests，本表只做
-- 广场自己的台账与回显快照：提示词/档位/参数/参考清单）。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不应自动执行迁移。
CREATE TABLE IF NOT EXISTS {{schema}}.plaza_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  generation_request_id uuid NOT NULL REFERENCES {{schema}}.generation_requests(id) ON DELETE CASCADE,
  media_kind varchar(16) NOT NULL,
  prompt text NOT NULL DEFAULT '',
  tier_id varchar(128),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plaza_records_project_created_idx
  ON {{schema}}.plaza_records (project_id, created_at DESC);
