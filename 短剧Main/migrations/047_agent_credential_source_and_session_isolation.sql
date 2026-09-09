-- R164 P0-A: credential origin is stored with the bearer credential, never
-- inferred from a request header or body.  Existing sessions cannot be
-- classified reliably, so they become legacy credentials and are revoked.

ALTER TABLE {{schema}}.sessions
  ADD COLUMN IF NOT EXISTS credential_source varchar(16),
  ADD COLUMN IF NOT EXISTS agent_type varchar(64),
  ADD COLUMN IF NOT EXISTS user_agent varchar(512),
  ADD COLUMN IF NOT EXISTS credential_label varchar(128),
  ADD COLUMN IF NOT EXISTS issued_by_session_id uuid;

UPDATE {{schema}}.sessions
SET credential_source = 'legacy'
WHERE credential_source IS NULL;

UPDATE {{schema}}.sessions
SET revoked_at = now()
WHERE credential_source = 'legacy'
  AND revoked_at IS NULL;

ALTER TABLE {{schema}}.sessions
  ALTER COLUMN credential_source SET NOT NULL;

ALTER TABLE {{schema}}.sessions
  DROP CONSTRAINT IF EXISTS sessions_credential_source_check,
  DROP CONSTRAINT IF EXISTS sessions_credential_shape_check,
  DROP CONSTRAINT IF EXISTS sessions_agent_type_format_check,
  DROP CONSTRAINT IF EXISTS sessions_issued_by_session_id_fkey;

ALTER TABLE {{schema}}.sessions
  ADD CONSTRAINT sessions_credential_source_check
    CHECK (credential_source IN ('legacy', 'web', 'cli', 'agent')),
  ADD CONSTRAINT sessions_credential_shape_check
    CHECK (
      (
        credential_source = 'agent'
        AND agent_type IS NOT NULL
        AND credential_label IS NOT NULL
        AND issued_by_session_id IS NOT NULL
      )
      OR
      (
        credential_source <> 'agent'
        AND agent_type IS NULL
        AND credential_label IS NULL
        AND issued_by_session_id IS NULL
      )
    ),
  ADD CONSTRAINT sessions_agent_type_format_check
    CHECK (agent_type IS NULL OR agent_type ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  ADD CONSTRAINT sessions_issued_by_session_id_fkey
    FOREIGN KEY (issued_by_session_id) REFERENCES {{schema}}.sessions(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS {{schema}}.sessions_user_active_idx;

CREATE INDEX IF NOT EXISTS sessions_human_active_idx
  ON {{schema}}.sessions (user_id, expires_at)
  WHERE revoked_at IS NULL
    AND credential_source IN ('web', 'cli');

CREATE INDEX IF NOT EXISTS sessions_agent_active_idx
  ON {{schema}}.sessions (user_id, agent_type, expires_at)
  WHERE revoked_at IS NULL
    AND credential_source = 'agent';

ALTER TABLE {{schema}}.agent_sessions
  ADD COLUMN IF NOT EXISTS auth_session_id uuid,
  ADD COLUMN IF NOT EXISTS agent_type varchar(64),
  ADD COLUMN IF NOT EXISTS user_agent varchar(512);

UPDATE {{schema}}.agent_sessions
SET agent_type = 'legacy_assistant'
WHERE agent_type IS NULL;

ALTER TABLE {{schema}}.agent_sessions
  ALTER COLUMN agent_type SET NOT NULL;

ALTER TABLE {{schema}}.agent_sessions
  DROP CONSTRAINT IF EXISTS agent_sessions_auth_session_id_fkey,
  DROP CONSTRAINT IF EXISTS agent_sessions_agent_type_format_check;

ALTER TABLE {{schema}}.agent_sessions
  ADD CONSTRAINT agent_sessions_auth_session_id_fkey
    FOREIGN KEY (auth_session_id) REFERENCES {{schema}}.sessions(id) ON DELETE SET NULL,
  ADD CONSTRAINT agent_sessions_agent_type_format_check
    CHECK (agent_type ~ '^[a-z0-9][a-z0-9._-]{1,63}$');

ALTER TABLE {{schema}}.generation_quotes
  DROP CONSTRAINT IF EXISTS generation_quotes_source_check;

ALTER TABLE {{schema}}.generation_quotes
  ADD CONSTRAINT generation_quotes_source_check
    CHECK (source IN ('web', 'assistant', 'cli', 'agent'));
