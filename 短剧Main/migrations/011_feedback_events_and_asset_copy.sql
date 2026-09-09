-- V0.1.1 feedback foundation:
--   1. trace an idempotent common-asset -> personal-asset copy;
--   2. accept lightweight product events for admin aggregation.

ALTER TABLE IF EXISTS {{schema}}.asset_entities
  ADD COLUMN IF NOT EXISTS copied_from_asset_entity_id uuid;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_copied_from_fk
    FOREIGN KEY (copied_from_asset_entity_id) REFERENCES {{schema}}.asset_entities(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_copy_not_self_check
    CHECK (copied_from_asset_entity_id IS NULL OR copied_from_asset_entity_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

CREATE UNIQUE INDEX IF NOT EXISTS asset_entities_active_personal_copy_unique
  ON {{schema}}.asset_entities (owner_user_id, copied_from_asset_entity_id)
  WHERE visibility = 'personal'
    AND copied_from_asset_entity_id IS NOT NULL
    AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  event varchar(128) NOT NULL,
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_name_check CHECK (event ~ '^[a-z][a-z0-9_.:-]{0,127}$'),
  CONSTRAINT events_props_object_check CHECK (jsonb_typeof(props) = 'object')
);

CREATE INDEX IF NOT EXISTS events_event_occurred_idx
  ON {{schema}}.events (event, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_user_occurred_idx
  ON {{schema}}.events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_occurred_idx
  ON {{schema}}.events (occurred_at DESC);
