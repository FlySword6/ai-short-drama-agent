-- Volcengine Ark asset-library registration truth.
--
-- `volc_asset_groups` owns idempotent CreateAssetGroup state. The existing
-- `seedance_asset_registrations` table remains the one local-to-remote asset
-- mapping; this migration only makes its latest provider outcome queryable.
-- Neither table may contain source URLs, credentials, signatures, tokens, or
-- raw provider responses.

CREATE TABLE IF NOT EXISTS {{schema}}.volc_asset_groups (
  id uuid PRIMARY KEY,
  name varchar(64) NOT NULL,
  description varchar(300) NOT NULL,
  group_type varchar(32) NOT NULL DEFAULT 'AIGC',
  project_name varchar(128) NOT NULL,
  volc_asset_group_id varchar(128),
  status varchar(16) NOT NULL DEFAULT 'pending',
  source varchar(16) NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  last_action_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  latest_request_id varchar(128),
  latest_error_code varchar(128),
  latest_error_message varchar(512),
  retry_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT volc_asset_groups_name_nonblank_check
    CHECK (char_length(btrim(name)) > 0),
  CONSTRAINT volc_asset_groups_description_nonblank_check
    CHECK (char_length(btrim(description)) > 0),
  CONSTRAINT volc_asset_groups_group_type_check
    CHECK (group_type = 'AIGC'),
  CONSTRAINT volc_asset_groups_project_nonblank_check
    CHECK (char_length(btrim(project_name)) > 0),
  CONSTRAINT volc_asset_groups_remote_id_nonblank_check
    CHECK (volc_asset_group_id IS NULL OR char_length(btrim(volc_asset_group_id)) > 0),
  CONSTRAINT volc_asset_groups_status_check
    CHECK (status IN ('pending', 'creating', 'active', 'failed', 'unknown')),
  CONSTRAINT volc_asset_groups_source_check
    CHECK (source IN ('configured', 'created')),
  CONSTRAINT volc_asset_groups_retry_count_check
    CHECK (retry_count >= 0),
  CONSTRAINT volc_asset_groups_retry_time_check
    CHECK (
      (retry_count = 0 AND last_retry_at IS NULL)
      OR (retry_count > 0 AND last_retry_at IS NOT NULL)
    ),
  CONSTRAINT volc_asset_groups_state_shape_check
    CHECK (
      (status IN ('pending', 'creating') AND volc_asset_group_id IS NULL
        AND latest_error_code IS NULL AND latest_error_message IS NULL)
      OR (status = 'active' AND volc_asset_group_id IS NOT NULL
        AND latest_error_code IS NULL AND latest_error_message IS NULL)
      OR (status IN ('failed', 'unknown') AND volc_asset_group_id IS NULL
        AND latest_error_code IS NOT NULL AND latest_error_message IS NOT NULL)
    ),
  CONSTRAINT volc_asset_groups_error_message_sanitized_check
    CHECK (
      latest_error_message IS NULL
      OR latest_error_message !~* '(https?://|authorization|x-api-key|secret|token|access[_ -]?key|credential)'
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS volc_asset_groups_identity_unique
  ON {{schema}}.volc_asset_groups (project_name, group_type, name);

CREATE UNIQUE INDEX IF NOT EXISTS volc_asset_groups_remote_id_unique
  ON {{schema}}.volc_asset_groups (volc_asset_group_id)
  WHERE volc_asset_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS volc_asset_groups_status_updated_idx
  ON {{schema}}.volc_asset_groups (status, updated_at DESC, id DESC);

ALTER TABLE {{schema}}.seedance_asset_registrations
  ALTER COLUMN asset_group_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS remote_asset_name varchar(64),
  ADD COLUMN IF NOT EXISTS latest_request_id varchar(128),
  ADD COLUMN IF NOT EXISTS latest_error_code varchar(128),
  ADD COLUMN IF NOT EXISTS latest_error_message varchar(512),
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at timestamptz;

-- Preserve the latest sanitized provider evidence for historical rows. A
-- subsequent application action writes these columns in the same transaction
-- as the append-only attempt row.
WITH latest_attempt AS (
  SELECT DISTINCT ON (registration_id)
    registration_id,
    provider_request_id,
    error_code,
    error_message
  FROM {{schema}}.seedance_asset_registration_attempts
  ORDER BY registration_id, attempt_no DESC
)
UPDATE {{schema}}.seedance_asset_registrations AS registration
SET latest_request_id = latest_attempt.provider_request_id,
    latest_error_code = latest_attempt.error_code,
    latest_error_message = latest_attempt.error_message
FROM latest_attempt
WHERE latest_attempt.registration_id = registration.id
  AND registration.latest_request_id IS NULL
  AND registration.latest_error_code IS NULL
  AND registration.latest_error_message IS NULL;

WITH create_attempts AS (
  SELECT
    registration_id,
    GREATEST(count(*) FILTER (
      WHERE action = 'create' AND outcome = 'submitting'
    ) - 1, 0)::integer AS retry_count,
    max(created_at) FILTER (
      WHERE action = 'create' AND outcome = 'submitting' AND attempt_no > 1
    ) AS last_retry_at
  FROM {{schema}}.seedance_asset_registration_attempts
  GROUP BY registration_id
)
UPDATE {{schema}}.seedance_asset_registrations AS registration
SET retry_count = create_attempts.retry_count,
    last_retry_at = CASE
      WHEN create_attempts.retry_count > 0 THEN create_attempts.last_retry_at
      ELSE NULL
    END
FROM create_attempts
WHERE create_attempts.registration_id = registration.id
  AND registration.retry_count = 0;

UPDATE {{schema}}.seedance_asset_registrations
SET latest_error_code = COALESCE(latest_error_code, 'ARK_ASSET_REGISTRY_FAILED'),
    latest_error_message = COALESCE(
      latest_error_message,
      '火山素材登记未完成，请按请求编号联系管理员复核'
    )
WHERE status IN ('failed', 'unknown', 'unavailable')
  AND (latest_error_code IS NULL OR latest_error_message IS NULL);

ALTER TABLE {{schema}}.seedance_asset_registrations
  DROP CONSTRAINT IF EXISTS seedance_asset_registrations_group_nonblank_check,
  DROP CONSTRAINT IF EXISTS seedance_asset_registrations_state_shape_check,
  DROP CONSTRAINT IF EXISTS seedance_asset_registrations_latest_error_state_check,
  DROP CONSTRAINT IF EXISTS seedance_asset_registrations_retry_count_check,
  DROP CONSTRAINT IF EXISTS seedance_asset_registrations_retry_time_check,
  DROP CONSTRAINT IF EXISTS seedance_asset_registrations_error_message_sanitized_check;

ALTER TABLE {{schema}}.seedance_asset_registrations
  ADD CONSTRAINT seedance_asset_registrations_group_nonblank_check
    CHECK (asset_group_id IS NULL OR char_length(btrim(asset_group_id)) > 0),
  ADD CONSTRAINT seedance_asset_registrations_state_shape_check
    CHECK (
      (status = 'pending' AND remote_asset_id IS NULL AND activated_at IS NULL)
      OR (status = 'submitting' AND asset_group_id IS NOT NULL
        AND remote_asset_id IS NULL AND activated_at IS NULL)
      OR (status = 'processing' AND asset_group_id IS NOT NULL
        AND remote_asset_id IS NOT NULL AND activated_at IS NULL)
      OR (status = 'active' AND asset_group_id IS NOT NULL
        AND remote_asset_id IS NOT NULL AND activated_at IS NOT NULL
        AND last_verified_at IS NOT NULL)
      OR (status IN ('failed', 'unknown', 'unavailable') AND activated_at IS NULL)
    ),
  ADD CONSTRAINT seedance_asset_registrations_latest_error_state_check
    CHECK (
      (status IN ('failed', 'unknown', 'unavailable')
        AND latest_error_code IS NOT NULL AND latest_error_message IS NOT NULL)
      OR (status NOT IN ('failed', 'unknown', 'unavailable')
        AND latest_error_code IS NULL AND latest_error_message IS NULL)
    ),
  ADD CONSTRAINT seedance_asset_registrations_retry_count_check
    CHECK (retry_count >= 0),
  ADD CONSTRAINT seedance_asset_registrations_retry_time_check
    CHECK (
      (retry_count = 0 AND last_retry_at IS NULL)
      OR (retry_count > 0 AND last_retry_at IS NOT NULL)
    ),
  ADD CONSTRAINT seedance_asset_registrations_error_message_sanitized_check
    CHECK (
      latest_error_message IS NULL
      OR latest_error_message !~* '(https?://|authorization|x-api-key|secret|token|access[_ -]?key|credential)'
    );

ALTER TABLE {{schema}}.seedance_asset_registration_attempts
  DROP CONSTRAINT IF EXISTS seedance_asset_registration_attempts_action_check;

ALTER TABLE {{schema}}.seedance_asset_registration_attempts
  ADD CONSTRAINT seedance_asset_registration_attempts_action_check
    CHECK (action IN ('group', 'create', 'list', 'refresh', 'reuse', 'bind'));
