-- Durable pre-submit reservation for the one approved test-environment tier
-- smoke. The unique batch+tier key survives Pod replacement and prevents a
-- second paid provider call after either success or an unknown outcome.

CREATE TABLE IF NOT EXISTS {{schema}}.tier_smoke_reservations (
  reservation_id uuid PRIMARY KEY,
  batch_id varchar(128) NOT NULL,
  tier_id varchar(128) NOT NULL,
  target varchar(16) NOT NULL,
  reserved_fen integer NOT NULL,
  status varchar(16) NOT NULL,
  reserved_at timestamptz NOT NULL,
  completed_at timestamptz,
  provider_task_fingerprint varchar(64),
  artifact_sha256 varchar(64),
  artifact_width_px integer,
  artifact_height_px integer,
  CONSTRAINT tier_smoke_reservations_target_check
    CHECK (target = 'test-env'),
  CONSTRAINT tier_smoke_reservations_approved_batch_check
    CHECK (
      batch_id = 'ark-test-env-portrait-image-v1'
      AND tier_id = 'img-seedream5pro-916-1k-1'
    ),
  CONSTRAINT tier_smoke_reservations_reserved_fen_check
    CHECK (reserved_fen = 30),
  CONSTRAINT tier_smoke_reservations_status_check
    CHECK (
      (status = 'reserved'
        AND completed_at IS NULL
        AND provider_task_fingerprint IS NULL
        AND artifact_sha256 IS NULL
        AND artifact_width_px IS NULL
        AND artifact_height_px IS NULL)
      OR
      (status = 'completed'
        AND completed_at IS NOT NULL
        AND provider_task_fingerprint IS NOT NULL
        AND provider_task_fingerprint ~ '^[0-9a-f]{16,64}$'
        AND artifact_sha256 IS NOT NULL
        AND artifact_sha256 ~ '^[0-9a-f]{64}$'
        AND artifact_width_px IS NOT NULL
        AND artifact_height_px IS NOT NULL
        AND artifact_width_px > 0
        AND artifact_height_px > artifact_width_px)
    ),
  CONSTRAINT tier_smoke_reservations_batch_tier_unique
    UNIQUE (batch_id, tier_id),
  CONSTRAINT tier_smoke_reservations_task_unique
    UNIQUE (provider_task_fingerprint),
  CONSTRAINT tier_smoke_reservations_artifact_unique
    UNIQUE (artifact_sha256)
);
