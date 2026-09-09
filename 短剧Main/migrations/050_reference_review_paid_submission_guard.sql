-- #28 / V-19: the worker's `running/submitting` state is the short durable
-- interval after the final review check and before the paid provider outcome.
-- Generation locks the referenced common asset rows before entering that
-- state. This trigger is the database backstop for every status writer, so a
-- review/import/admin path cannot revoke approval in the gap between commit
-- and the external provider POST.
--
-- Personal assets are explicitly exempt. A failed/submitting attempt is also
-- excluded because its status is no longer running; it represents an unknown
-- provider outcome and must not freeze review forever.
--
-- Rollback: drop trigger asset_entities_paid_reference_review_guard, then drop
-- function guard_paid_reference_review_status(); drop the two batch failure
-- columns after callers no longer need durable per-item review details.

ALTER TABLE {{schema}}.generation_batch_authorization_items
  ADD COLUMN IF NOT EXISTS failure_status_code integer,
  ADD COLUMN IF NOT EXISTS failure_details jsonb;

-- Historical rows with no frozen price snapshot are deliberately excluded
-- from worker recovery. Leaving one in running/submitting would therefore
-- freeze every referenced asset forever. Close only that unrecoverable shape
-- as the same conservative "provider outcome unknown" fact used by the worker;
-- keep phase, provider fields and request linkage as the audit trail.
UPDATE {{schema}}.generation_attempts
SET status = 'failed',
    phase = 'submitting',
    error_code = 'SUBMISSION_OUTCOME_UNKNOWN',
    error_message = 'Historical submission cannot be recovered because its frozen price snapshot is missing',
    retryable = false,
    next_poll_at = NULL,
    lease_owner = NULL,
    lease_until = NULL,
    finished_at = COALESCE(finished_at, now()),
    updated_at = now()
WHERE status = 'running'
  AND phase = 'submitting'
  AND price_snapshot = '{}'::jsonb;

-- Reconciled attempts remain visible to their owner instead of becoming a
-- silent terminal row. The deterministic UUID and attempt unique key make the
-- forward migration replay-safe.
INSERT INTO {{schema}}.generation_attempt_notifications (
  id,
  attempt_id,
  generation_request_id,
  project_id,
  user_id,
  acknowledged_at,
  created_at
)
SELECT
  md5('050-reference-review-' || attempt.id::text)::uuid,
  attempt.id,
  request.id,
  request.project_id,
  request.user_id,
  NULL,
  COALESCE(attempt.finished_at, now())
FROM {{schema}}.generation_attempts AS attempt
INNER JOIN {{schema}}.generation_requests AS request
  ON request.id = attempt.request_id
WHERE attempt.status = 'failed'
  AND attempt.phase = 'submitting'
  AND attempt.error_code = 'SUBMISSION_OUTCOME_UNKNOWN'
  AND attempt.error_message = 'Historical submission cannot be recovered because its frozen price snapshot is missing'
ON CONFLICT (attempt_id) DO NOTHING;

CREATE OR REPLACE FUNCTION {{schema}}.guard_paid_reference_review_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
       NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.visibility IS NOT DISTINCT FROM OLD.visibility
     )
     OR (OLD.visibility = 'personal' AND NEW.visibility = 'personal') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM {{schema}}.generation_attempts AS attempt
    INNER JOIN {{schema}}.generation_requests AS request
      ON request.id = attempt.request_id
    INNER JOIN {{schema}}.asset_media AS media
      ON request.reference_media_ids ? media.id::text
    LEFT JOIN {{schema}}.asset_variants AS variant
      ON variant.id = media.asset_variant_id
    WHERE attempt.status = 'running'
      AND attempt.phase = 'submitting'
      AND media.deleted_at IS NULL
      AND (
        media.asset_entity_id = NEW.id
        OR (
          media.asset_entity_id IS NULL
          AND variant.deleted_at IS NULL
          AND variant.asset_entity_id = NEW.id
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'asset_review_change_in_progress',
      DETAIL = NEW.id::text;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS asset_entities_paid_reference_review_guard
  ON {{schema}}.asset_entities;

CREATE TRIGGER asset_entities_paid_reference_review_guard
  BEFORE UPDATE OF status, visibility ON {{schema}}.asset_entities
  FOR EACH ROW
  EXECUTE FUNCTION {{schema}}.guard_paid_reference_review_status();
