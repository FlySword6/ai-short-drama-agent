-- Migration 052: asset media repair display renditions, durable repair tasks, and immutable
-- per-action audit facts. This deliberately leaves legacy asset_media rows
-- unconstrained: historical metadata may be incomplete and must be diagnosed,
-- not block this forward migration.
--
-- Forward migration: `npm run db:migrate`; application startup never migrates.
-- Idempotency: CREATE TABLE/INDEX IF NOT EXISTS, and the audit trigger is
-- replaced on every replay.  Rollback requires stopping repair workers first;
-- task/action history must be retained unless a DBA explicitly approves removal.

CREATE TABLE IF NOT EXISTS {{schema}}.asset_media_renditions (
  id uuid PRIMARY KEY,
  asset_media_id uuid NOT NULL REFERENCES {{schema}}.asset_media(id) ON DELETE RESTRICT,
  rendition_kind varchar(16) NOT NULL,
  strategy varchar(16) NOT NULL,
  status varchar(16) NOT NULL,
  process_spec varchar(1024),
  storage_bucket varchar(128),
  storage_path varchar(512),
  storage_url varchar(1024),
  source_sha256 varchar(64),
  width_px integer,
  height_px integer,
  format varchar(32),
  sha256 varchar(64),
  error_code varchar(64),
  error_message text,
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_media_renditions_kind_check
    CHECK (rendition_kind IN ('thumbnail', 'detail')),
  CONSTRAINT asset_media_renditions_strategy_check
    CHECK (strategy IN ('tos_process', 'stored_object')),
  CONSTRAINT asset_media_renditions_status_check
    CHECK (status IN ('pending', 'healthy', 'stale', 'failed')),
  CONSTRAINT asset_media_renditions_source_sha256_check
    CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT asset_media_renditions_sha256_check
    CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT asset_media_renditions_dimensions_check
    CHECK ((width_px IS NULL OR width_px > 0) AND (height_px IS NULL OR height_px > 0)),
  CONSTRAINT asset_media_renditions_strategy_location_check
    CHECK (
      (strategy = 'tos_process'
        AND process_spec IS NOT NULL
        AND storage_bucket IS NULL AND storage_path IS NULL AND storage_url IS NULL)
      OR
      (strategy = 'stored_object'
        AND process_spec IS NULL
        AND storage_bucket IS NOT NULL AND storage_path IS NOT NULL)
    ),
  CONSTRAINT asset_media_renditions_healthy_facts_check
    CHECK (
      status <> 'healthy'
      OR (
        strategy = 'stored_object'
        AND process_spec IS NULL
        AND storage_bucket IS NOT NULL
        AND storage_path ~ '^asset-renditions/v1/[0-9a-f]{2}/[0-9a-f]{64}[.]webp$'
        AND storage_url IS NULL
        AND source_sha256 IS NOT NULL
        AND checked_at IS NOT NULL
        AND width_px IS NOT NULL AND height_px IS NOT NULL
        AND lower(format) = 'webp'
        AND sha256 IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_media_renditions_media_kind_unique
  ON {{schema}}.asset_media_renditions (asset_media_id, rendition_kind);

CREATE INDEX IF NOT EXISTS asset_media_renditions_status_checked_idx
  ON {{schema}}.asset_media_renditions (status, checked_at, id);

CREATE TABLE IF NOT EXISTS {{schema}}.asset_media_repair_tasks (
  id uuid PRIMARY KEY,
  asset_entity_id uuid NOT NULL REFERENCES {{schema}}.asset_entities(id) ON DELETE RESTRICT,
  requested_by_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  client_idempotency_key varchar(255),
  request_hash varchar(64) NOT NULL,
  mode varchar(16) NOT NULL DEFAULT 'safe',
  trigger varchar(16) NOT NULL,
  media_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(16) NOT NULL DEFAULT 'queued',
  claim_token uuid,
  lease_expires_at timestamptz,
  diagnosis jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code varchar(64),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_media_repair_tasks_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT asset_media_repair_tasks_mode_check
    CHECK (mode = 'safe'),
  CONSTRAINT asset_media_repair_tasks_trigger_check
    CHECK (trigger IN ('manual', 'self_heal', 'batch')),
  CONSTRAINT asset_media_repair_tasks_manual_requester_check
    CHECK (trigger <> 'manual' OR requested_by_user_id IS NOT NULL),
  CONSTRAINT asset_media_repair_tasks_status_check
    CHECK (status IN ('queued', 'processing', 'succeeded', 'partial', 'failed')),
  CONSTRAINT asset_media_repair_tasks_media_ids_array_check
    CHECK (jsonb_typeof(media_ids) = 'array'),
  CONSTRAINT asset_media_repair_tasks_diagnosis_object_check
    CHECK (jsonb_typeof(diagnosis) = 'object'),
  CONSTRAINT asset_media_repair_tasks_result_object_check
    CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT asset_media_repair_tasks_terminal_time_check
    CHECK (
      (status IN ('queued', 'processing') AND finished_at IS NULL)
      OR (status IN ('succeeded', 'partial', 'failed') AND finished_at IS NOT NULL)
  ),
  CONSTRAINT asset_media_repair_tasks_processing_lease_check
    CHECK (
      (status = 'processing' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'processing' AND claim_token IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS asset_media_repair_tasks_actor_idempotency_unique
  ON {{schema}}.asset_media_repair_tasks (requested_by_user_id, client_idempotency_key)
  WHERE requested_by_user_id IS NOT NULL AND client_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS asset_media_repair_tasks_asset_created_idx
  ON {{schema}}.asset_media_repair_tasks (asset_entity_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS asset_media_repair_tasks_queued_created_idx
  ON {{schema}}.asset_media_repair_tasks (created_at, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS asset_media_repair_tasks_expired_lease_idx
  ON {{schema}}.asset_media_repair_tasks (lease_expires_at, id)
  WHERE status = 'processing';

CREATE UNIQUE INDEX IF NOT EXISTS asset_media_repair_tasks_active_asset_unique
  ON {{schema}}.asset_media_repair_tasks (asset_entity_id)
  WHERE status IN ('queued', 'processing');

-- A hard blocker is remembered only while the source state fingerprint is
-- unchanged.  That prevents self-heal scans from endlessly re-enqueuing an
-- unrepairable asset, while a later asset/media update naturally reopens it.
CREATE TABLE IF NOT EXISTS {{schema}}.asset_media_repair_blockers (
  asset_entity_id uuid PRIMARY KEY REFERENCES {{schema}}.asset_entities(id) ON DELETE RESTRICT,
  state_fingerprint varchar(32) NOT NULL,
  error_code varchar(64) NOT NULL,
  error_message text,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  retry_after timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_media_repair_blockers_fingerprint_check
    CHECK (state_fingerprint ~ '^[0-9a-f]{32}$')
);

CREATE INDEX IF NOT EXISTS asset_media_repair_blockers_retry_idx
  ON {{schema}}.asset_media_repair_blockers (retry_after, asset_entity_id);

CREATE TABLE IF NOT EXISTS {{schema}}.asset_media_repair_actions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES {{schema}}.asset_media_repair_tasks(id) ON DELETE RESTRICT,
  asset_media_id uuid NOT NULL REFERENCES {{schema}}.asset_media(id) ON DELETE RESTRICT,
  action varchar(32) NOT NULL,
  status varchar(16) NOT NULL,
  before jsonb NOT NULL DEFAULT '{}'::jsonb,
  after jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code varchar(64),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_media_repair_actions_action_check
    CHECK (action IN ('diagnose', 'create_rendition', 'refresh_rendition', 'refresh_metadata', 'register_object', 'mark_blocked')),
  CONSTRAINT asset_media_repair_actions_status_check
    CHECK (status IN ('succeeded', 'skipped', 'blocked', 'failed')),
  CONSTRAINT asset_media_repair_actions_before_object_check
    CHECK (jsonb_typeof(before) = 'object'),
  CONSTRAINT asset_media_repair_actions_after_object_check
    CHECK (jsonb_typeof(after) = 'object')
);

CREATE INDEX IF NOT EXISTS asset_media_repair_actions_task_created_idx
  ON {{schema}}.asset_media_repair_actions (task_id, created_at, id);

CREATE INDEX IF NOT EXISTS asset_media_repair_actions_media_created_idx
  ON {{schema}}.asset_media_repair_actions (asset_media_id, created_at, id);

CREATE OR REPLACE FUNCTION {{schema}}.guard_asset_media_repair_actions_append_only()
RETURNS trigger AS $function$
BEGIN
  RAISE EXCEPTION 'asset media repair actions are append-only';
END;
$function$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS asset_media_repair_actions_append_only ON {{schema}}.asset_media_repair_actions;
CREATE TRIGGER asset_media_repair_actions_append_only
BEFORE UPDATE OR DELETE ON {{schema}}.asset_media_repair_actions
FOR EACH ROW EXECUTE FUNCTION {{schema}}.guard_asset_media_repair_actions_append_only();
