-- Trash retention audit and candidates. Migration number is provisional until
-- Fable assigns the integration slot; forward only, no retained-row backfill.
CREATE TABLE IF NOT EXISTS {{schema}}.trash_purge_attempts (
  id uuid PRIMARY KEY,
  source varchar(16) NOT NULL CHECK (source IN ('manual', 'retention')),
  target_kind varchar(16) NOT NULL CHECK (target_kind IN ('project', 'asset')),
  target_id uuid NOT NULL,
  owner_user_id uuid,
  actor_user_id uuid,
  status varchar(24) NOT NULL CHECK (status IN ('started', 'blocked', 'failed', 'deleted')),
  retention_days integer,
  deleted_at_snapshot timestamptz,
  blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code varchar(128),
  started_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS projects_trash_retention_candidates_idx
  ON {{schema}}.projects (deleted_at, id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS asset_entities_trash_retention_candidates_idx
  ON {{schema}}.asset_entities (deleted_at, id)
  WHERE deleted_at IS NOT NULL AND visibility <> 'common' AND owner_user_id IS NOT NULL;
