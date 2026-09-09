-- V0.1.1 shot image registration:
--   keep media_results as the only shot-media registry while allowing an
--   already persisted asset_media image to become a shot primary image.
--
-- Forward-only migration. Existing generation rows are backfilled as
-- origin_kind=generation. Historical persistence completeness is outside this
-- migration; this file changes only what the new source kind requires.

-- Control-package metadata belongs to the canonical asset entity, not to an
-- individual TOS object. Both columns are nullable so existing assets retain
-- their V0.1 reference behaviour until a human classifies them.
ALTER TABLE IF EXISTS {{schema}}.asset_entities
  ADD COLUMN IF NOT EXISTS role varchar(32),
  ADD COLUMN IF NOT EXISTS usage_mode varchar(16);

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_control_role_check
    CHECK (role IS NULL OR role IN (
      'character_identity', 'scene', 'prop', 'motion', 'camera_storyboard', 'style_env'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_control_usage_mode_check
    CHECK (usage_mode IS NULL OR usage_mode IN ('reference', 'first_frame', 'last_frame'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

ALTER TABLE IF EXISTS {{schema}}.media_results
  ADD COLUMN IF NOT EXISTS origin_kind varchar(24) NOT NULL DEFAULT 'generation',
  ADD COLUMN IF NOT EXISTS source_asset_media_id uuid,
  ADD COLUMN IF NOT EXISTS registered_by_user_id uuid;

ALTER TABLE IF EXISTS {{schema}}.media_results
  ALTER COLUMN request_id DROP NOT NULL,
  ALTER COLUMN attempt_id DROP NOT NULL,
  ALTER COLUMN provider_result_key DROP NOT NULL;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.media_results
    ADD CONSTRAINT media_results_source_asset_media_fk
    FOREIGN KEY (source_asset_media_id) REFERENCES {{schema}}.asset_media(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.media_results
    ADD CONSTRAINT media_results_registered_by_user_fk
    FOREIGN KEY (registered_by_user_id) REFERENCES {{schema}}.users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.media_results
    ADD CONSTRAINT media_results_origin_kind_check
    CHECK (origin_kind IN ('generation', 'asset_media'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.media_results
    ADD CONSTRAINT media_results_origin_xor_check
    CHECK (
      (
        origin_kind = 'generation'
        AND request_id IS NOT NULL
        AND attempt_id IS NOT NULL
        AND provider_result_key IS NOT NULL
        AND source_asset_media_id IS NULL
        AND registered_by_user_id IS NULL
      )
      OR
      (
        origin_kind = 'asset_media'
        AND request_id IS NULL
        AND attempt_id IS NULL
        AND provider_result_key IS NULL
        AND source_asset_media_id IS NOT NULL
        AND registered_by_user_id IS NOT NULL
        AND shot_id IS NOT NULL
        AND media_kind = 'image'
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

CREATE UNIQUE INDEX IF NOT EXISTS media_results_active_shot_asset_source_unique
  ON {{schema}}.media_results (shot_id, source_asset_media_id)
  WHERE origin_kind = 'asset_media'
    AND deleted_at IS NULL;
