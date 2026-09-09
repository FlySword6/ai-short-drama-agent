-- V0.1.1 审核域。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不自动执行迁移。
-- 恢复/回滚：旧代码不会读取这两张新表，因此回退应用代码时可保留它们。
-- 如必须清理，先导出审核动作记录，再由 DBA 手工 DROP TABLE。

CREATE TABLE IF NOT EXISTS {{schema}}.project_review_policies (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  media_kind varchar(16) NOT NULL,
  default_strategy varchar(24) NOT NULL,
  updated_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_review_policies_media_kind_check
    CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT project_review_policies_strategy_check
    CHECK (default_strategy IN ('automatic', 'pending_review')),
  CONSTRAINT project_review_policies_version_check CHECK (version > 0),
  CONSTRAINT project_review_policies_project_media_unique UNIQUE (project_id, media_kind)
);

CREATE INDEX IF NOT EXISTS project_review_policies_project_updated_idx
  ON {{schema}}.project_review_policies (project_id, updated_at DESC);

-- 动作日志是审核解释的正式事实。asset_entities.status 保持现有兼容列；
-- 审核域只写入 automatic_review / pending_review / approved / rejected 四态。
CREATE TABLE IF NOT EXISTS {{schema}}.asset_review_actions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  asset_entity_id uuid NOT NULL REFERENCES {{schema}}.asset_entities(id),
  action varchar(24) NOT NULL,
  from_status varchar(24) NOT NULL,
  to_status varchar(24) NOT NULL,
  reviewer_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_review_actions_action_check
    CHECK (action IN ('submitted', 'approved', 'rejected')),
  CONSTRAINT asset_review_actions_from_status_check
    CHECK (from_status IN ('automatic_review', 'pending_review', 'approved', 'rejected')),
  CONSTRAINT asset_review_actions_to_status_check
    CHECK (to_status IN ('automatic_review', 'pending_review', 'approved', 'rejected')),
  CONSTRAINT asset_review_actions_rejection_reason_check
    CHECK (
      (action = 'rejected' AND char_length(btrim(COALESCE(rejection_reason, ''))) > 0)
      OR (action <> 'rejected' AND rejection_reason IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS asset_review_actions_project_asset_created_idx
  ON {{schema}}.asset_review_actions (project_id, asset_entity_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS asset_entities_review_status_idx
  ON {{schema}}.asset_entities (status)
  WHERE deleted_at IS NULL;
