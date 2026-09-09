ALTER TABLE {{schema}}.agent_messages
  ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS provider varchar(64),
  ADD COLUMN IF NOT EXISTS model varchar(128),
  ADD COLUMN IF NOT EXISTS usage jsonb,
  ADD COLUMN IF NOT EXISTS provider_cost_usd_micros integer,
  ADD COLUMN IF NOT EXISTS points_spent integer,
  ADD COLUMN IF NOT EXISTS duration_ms integer,
  ADD COLUMN IF NOT EXISTS error_summary text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_messages_status_check'
      AND conrelid = '{{schema}}.agent_messages'::regclass
  ) THEN
    ALTER TABLE {{schema}}.agent_messages
      ADD CONSTRAINT agent_messages_status_check
      CHECK (status IN ('completed', 'failed', 'aborted'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_messages_usage_object_check'
      AND conrelid = '{{schema}}.agent_messages'::regclass
  ) THEN
    ALTER TABLE {{schema}}.agent_messages
      ADD CONSTRAINT agent_messages_usage_object_check
      CHECK (usage IS NULL OR jsonb_typeof(usage) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_messages_cost_check'
      AND conrelid = '{{schema}}.agent_messages'::regclass
  ) THEN
    ALTER TABLE {{schema}}.agent_messages
      ADD CONSTRAINT agent_messages_cost_check
      CHECK (
        (provider_cost_usd_micros IS NULL OR provider_cost_usd_micros >= 0)
        AND (points_spent IS NULL OR points_spent >= 0)
        AND (duration_ms IS NULL OR duration_ms >= 0)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS agent_messages_session_created_desc_idx
  ON {{schema}}.agent_messages (session_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS agent_sessions_project_updated_idx
  ON {{schema}}.agent_sessions (project_id, updated_at DESC, id DESC)
  WHERE project_id IS NOT NULL AND deleted_at IS NULL;

-- Recovery note: this migration only adds nullable audit metadata plus a
-- backwards-compatible completed default. If application rollback is needed,
-- old code can keep writing agent_messages without using the new columns.
