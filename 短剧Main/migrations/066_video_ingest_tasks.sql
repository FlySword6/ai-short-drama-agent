-- Video reference ingest queue.
--
-- The asset row and source media row are PostgreSQL facts.  This table keeps
-- the slow Volcengine LAS parsing task auditable and retryable without
-- stuffing process state into asset_entities.metadata.

CREATE TABLE IF NOT EXISTS {{schema}}.video_ingest_tasks (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  asset_entity_id uuid NOT NULL REFERENCES {{schema}}.asset_entities(id) ON DELETE RESTRICT,
  asset_media_id uuid NOT NULL REFERENCES {{schema}}.asset_media(id) ON DELETE RESTRICT,
  source_video_bucket varchar(128) NOT NULL,
  source_video_path varchar(512) NOT NULL,
  operator_id varchar(64) NOT NULL,
  operator_version varchar(32) NOT NULL,
  operator_task_id varchar(128),
  task_template varchar(64) NOT NULL,
  query_hash varchar(64) NOT NULL,
  status varchar(16) NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  raw_result jsonb,
  normalized_result jsonb,
  error_code varchar(64),
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_ingest_tasks_status_check
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed')),
  CONSTRAINT video_ingest_tasks_attempt_count_check
    CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS video_ingest_tasks_queued_created_idx
  ON {{schema}}.video_ingest_tasks (created_at, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS video_ingest_tasks_actor_created_idx
  ON {{schema}}.video_ingest_tasks (actor_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS video_ingest_tasks_asset_media_idx
  ON {{schema}}.video_ingest_tasks (asset_media_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS video_ingest_tasks_active_media_unique
  ON {{schema}}.video_ingest_tasks (asset_media_id)
  WHERE status IN ('queued', 'processing');

CREATE UNIQUE INDEX IF NOT EXISTS video_ingest_tasks_success_dedupe_unique
  ON {{schema}}.video_ingest_tasks (
    asset_media_id,
    operator_id,
    operator_version,
    task_template,
    query_hash
  )
  WHERE status = 'succeeded';
