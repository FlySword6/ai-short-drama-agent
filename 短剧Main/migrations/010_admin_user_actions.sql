-- 管理员用户管理动作审计（S1 交付，SQL 来源：docs/validation/v0.1.1-admin-users-handoff.md）
CREATE TABLE IF NOT EXISTS {{schema}}.admin_user_actions (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  actor_session_id uuid REFERENCES {{schema}}.sessions(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES {{schema}}.users(id),
  action varchar(32) NOT NULL,
  from_active boolean,
  to_active boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_user_actions_action_check CHECK (
    action IN ('users_listed', 'user_created', 'user_disabled', 'password_reset')
  ),
  CONSTRAINT admin_user_actions_metadata_object_check CHECK (
    jsonb_typeof(metadata) = 'object'
  ),
  CONSTRAINT admin_user_actions_target_check CHECK (
    (action = 'users_listed' AND target_user_id IS NULL)
    OR (action <> 'users_listed' AND target_user_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS admin_user_actions_created_desc_idx
  ON {{schema}}.admin_user_actions (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS admin_user_actions_target_created_desc_idx
  ON {{schema}}.admin_user_actions (target_user_id, created_at DESC, id DESC)
  WHERE target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS admin_user_actions_actor_created_desc_idx
  ON {{schema}}.admin_user_actions (actor_user_id, created_at DESC, id DESC);
