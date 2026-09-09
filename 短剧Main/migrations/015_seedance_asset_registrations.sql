-- Seedance / Ark private asset registration is a separate provider mapping.
--
-- `asset_media` remains the canonical local reference and owns TOS location.
-- These tables deliberately never duplicate a source URL, request signature,
-- credential, or raw provider body.  They retain only the remote Asset ID,
-- lifecycle state, and a sanitized audit summary.

CREATE TABLE IF NOT EXISTS {{schema}}.seedance_asset_registrations (
  id uuid PRIMARY KEY,
  asset_media_id uuid NOT NULL REFERENCES {{schema}}.asset_media(id) ON DELETE RESTRICT,
  source_media_result_id uuid REFERENCES {{schema}}.media_results(id) ON DELETE RESTRICT,
  asset_group_id varchar(128) NOT NULL,
  project_name varchar(128) NOT NULL,
  remote_asset_id varchar(255),
  status varchar(16) NOT NULL DEFAULT 'pending',
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  last_action_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_action_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  CONSTRAINT seedance_asset_registrations_status_check
    CHECK (status IN ('pending', 'submitting', 'processing', 'active', 'failed', 'unknown')),
  CONSTRAINT seedance_asset_registrations_group_nonblank_check
    CHECK (char_length(btrim(asset_group_id)) > 0),
  CONSTRAINT seedance_asset_registrations_project_nonblank_check
    CHECK (char_length(btrim(project_name)) > 0),
  CONSTRAINT seedance_asset_registrations_remote_asset_nonblank_check
    CHECK (remote_asset_id IS NULL OR char_length(btrim(remote_asset_id)) > 0),
  CONSTRAINT seedance_asset_registrations_state_shape_check
    CHECK (
      (status = 'pending' AND remote_asset_id IS NULL AND activated_at IS NULL)
      OR (status = 'submitting' AND remote_asset_id IS NULL AND activated_at IS NULL)
      OR (status = 'processing' AND remote_asset_id IS NOT NULL AND activated_at IS NULL)
      OR (status = 'active' AND remote_asset_id IS NOT NULL AND activated_at IS NOT NULL)
      OR (status IN ('failed', 'unknown') AND activated_at IS NULL)
    ),
  CONSTRAINT seedance_asset_registrations_last_action_after_create_check
    CHECK (last_action_at >= created_at)
);

-- One local media item maps to one remote registered asset.  A media-result
-- promotion may be retried but must not produce a second local registration.
CREATE UNIQUE INDEX IF NOT EXISTS seedance_asset_registrations_asset_media_unique
  ON {{schema}}.seedance_asset_registrations (asset_media_id);

CREATE UNIQUE INDEX IF NOT EXISTS seedance_asset_registrations_source_result_unique
  ON {{schema}}.seedance_asset_registrations (source_media_result_id)
  WHERE source_media_result_id IS NOT NULL;

-- An Asset ID is an opaque remote identity, not reusable local metadata.
CREATE UNIQUE INDEX IF NOT EXISTS seedance_asset_registrations_remote_asset_unique
  ON {{schema}}.seedance_asset_registrations (remote_asset_id)
  WHERE remote_asset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS seedance_asset_registrations_status_updated_idx
  ON {{schema}}.seedance_asset_registrations (status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS seedance_asset_registrations_creator_created_idx
  ON {{schema}}.seedance_asset_registrations (created_by_user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.seedance_asset_registration_attempts (
  id uuid PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES {{schema}}.seedance_asset_registrations(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  action varchar(16) NOT NULL,
  outcome varchar(20) NOT NULL,
  provider_request_id varchar(128),
  provider_http_status integer,
  remote_asset_id varchar(255),
  error_code varchar(128),
  error_message varchar(512),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seedance_asset_registration_attempts_number_check
    CHECK (attempt_no > 0),
  CONSTRAINT seedance_asset_registration_attempts_action_check
    CHECK (action IN ('create', 'refresh', 'reuse')),
  CONSTRAINT seedance_asset_registration_attempts_outcome_check
    CHECK (outcome IN ('submitting', 'submitted', 'processing', 'active', 'failed', 'unknown', 'already_active')),
  CONSTRAINT seedance_asset_registration_attempts_http_status_check
    CHECK (provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599),
  CONSTRAINT seedance_asset_registration_attempts_error_values_nonblank_check
    CHECK (
      (error_code IS NULL OR char_length(btrim(error_code)) > 0)
      AND (error_message IS NULL OR char_length(btrim(error_message)) > 0)
    ),
  CONSTRAINT seedance_asset_registration_attempts_remote_asset_check
    CHECK (
      outcome IN ('submitting', 'failed', 'unknown')
      OR remote_asset_id IS NOT NULL
    ),
  CONSTRAINT seedance_asset_registration_attempts_error_state_check
    CHECK (
      (outcome IN ('failed', 'unknown') AND (error_code IS NOT NULL OR error_message IS NOT NULL))
      OR (outcome NOT IN ('failed', 'unknown') AND error_code IS NULL AND error_message IS NULL)
    ),
  -- This is a defence-in-depth guard.  The service is responsible for
  -- sanitising messages before insert; the database rejects common ways a
  -- URL, credential, or authorization header could leak into audit history.
  CONSTRAINT seedance_asset_registration_attempts_error_message_sanitized_check
    CHECK (
      error_message IS NULL
      OR error_message !~* '(https?://|authorization|x-api-key|secret|token|access[_ -]?key|credential)'
    ),
  CONSTRAINT seedance_asset_registration_attempts_number_unique
    UNIQUE (registration_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS seedance_asset_registration_attempts_registration_created_idx
  ON {{schema}}.seedance_asset_registration_attempts (registration_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS seedance_asset_registration_attempts_actor_created_idx
  ON {{schema}}.seedance_asset_registration_attempts (actor_user_id, created_at DESC, id DESC);
