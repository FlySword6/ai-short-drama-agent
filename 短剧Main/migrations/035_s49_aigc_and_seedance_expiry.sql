-- S49: AIGC evidence, immutable source lineage, and independent Seedance
-- self-produced trust.  This migration deliberately does not put a 30-day
-- expiry on CreateAsset registrations.

ALTER TABLE {{schema}}.media_results
  ADD COLUMN IF NOT EXISTS compliance_metadata jsonb DEFAULT '{}'::jsonb;

ALTER TABLE {{schema}}.media_results
  DROP CONSTRAINT IF EXISTS media_results_compliance_metadata_object_check;

ALTER TABLE {{schema}}.media_results
  ADD CONSTRAINT media_results_compliance_metadata_object_check
  CHECK (
    compliance_metadata IS NULL
    OR jsonb_typeof(compliance_metadata) = 'object'
  );

-- A source subject is the sole server-owned provenance identity for either a
-- local asset-media object or a generated media result.  The client never
-- supplies this value.  Existing objects are intentionally backfilled as
-- unknown: metadata, C2PA and model labels are not evidence of provenance.
CREATE TABLE IF NOT EXISTS {{schema}}.media_provenance_subjects (
  id bigserial PRIMARY KEY,
  asset_media_id uuid REFERENCES {{schema}}.asset_media(id) ON DELETE RESTRICT,
  media_result_id uuid REFERENCES {{schema}}.media_results(id) ON DELETE RESTRICT,
  source_channel varchar(32) NOT NULL,
  source_generation_attempt_id uuid REFERENCES {{schema}}.generation_attempts(id) ON DELETE RESTRICT,
  provider_asset_id varchar(255),
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_provenance_subject_xor_check
    CHECK ((asset_media_id IS NULL) <> (media_result_id IS NULL)),
  CONSTRAINT media_provenance_subject_channel_check
    CHECK (source_channel IN ('first_party_generation', 'external_upload', 'provider_library', 'unknown')),
  CONSTRAINT media_provenance_subject_attempt_shape_check
    CHECK (
      (source_channel = 'first_party_generation' AND source_generation_attempt_id IS NOT NULL)
      OR (source_channel <> 'first_party_generation' AND source_generation_attempt_id IS NULL)
    ),
  CONSTRAINT media_provenance_subject_provider_asset_shape_check
    CHECK (
      (source_channel = 'provider_library'
        AND asset_media_id IS NOT NULL
        AND provider_asset_id IS NOT NULL
        AND char_length(btrim(provider_asset_id)) > 0)
      OR (source_channel <> 'provider_library' AND provider_asset_id IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS media_provenance_subject_asset_media_unique
  ON {{schema}}.media_provenance_subjects (asset_media_id)
  WHERE asset_media_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS media_provenance_subject_media_result_unique
  ON {{schema}}.media_provenance_subjects (media_result_id)
  WHERE media_result_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_provenance_subject_channel_observed_idx
  ON {{schema}}.media_provenance_subjects (source_channel, observed_at, id);

INSERT INTO {{schema}}.media_provenance_subjects (asset_media_id, source_channel)
SELECT id, 'unknown' FROM {{schema}}.asset_media
ON CONFLICT DO NOTHING;

INSERT INTO {{schema}}.media_provenance_subjects (media_result_id, source_channel)
SELECT id, 'unknown' FROM {{schema}}.media_results
ON CONFLICT DO NOTHING;

-- Direct parent edges are immutable.  A generated child has an edge to every
-- frozen input subject; a promoted asset has an edge to its source result.
CREATE TABLE IF NOT EXISTS {{schema}}.media_provenance_parent_edges (
  child_subject_id bigint NOT NULL REFERENCES {{schema}}.media_provenance_subjects(id) ON DELETE RESTRICT,
  parent_subject_id bigint NOT NULL REFERENCES {{schema}}.media_provenance_subjects(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (child_subject_id, parent_subject_id),
  CONSTRAINT media_provenance_parent_edges_no_self_check CHECK (child_subject_id <> parent_subject_id)
);

CREATE INDEX IF NOT EXISTS media_provenance_parent_edges_parent_child_idx
  ON {{schema}}.media_provenance_parent_edges (parent_subject_id, child_subject_id);

CREATE OR REPLACE FUNCTION {{schema}}.guard_media_provenance_subject_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'media provenance subjects are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION {{schema}}.guard_media_provenance_parent_edge_insert()
RETURNS trigger AS $$
BEGIN
  -- A trust decision freezes the parent set it was based on. A promoted asset
  -- may add its first edge to a trusted result, but no later edge may revise
  -- either that trusted result or the promoted asset's ancestry.
  IF EXISTS (
    SELECT 1
    FROM {{schema}}.media_provenance_subjects child
    JOIN {{schema}}.seedance_self_produced_trust trust
      ON trust.media_result_id = child.media_result_id
    WHERE child.id = NEW.child_subject_id
  ) OR EXISTS (
    SELECT 1
    FROM {{schema}}.media_provenance_parent_edges existing
    JOIN {{schema}}.media_provenance_subjects parent
      ON parent.id = existing.parent_subject_id
    JOIN {{schema}}.seedance_self_produced_trust trust
      ON trust.media_result_id = parent.media_result_id
    WHERE existing.child_subject_id = NEW.child_subject_id
  ) THEN
    RAISE EXCEPTION 'trusted media provenance parent set is frozen';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors(subject_id) AS (
      SELECT parent_subject_id
      FROM {{schema}}.media_provenance_parent_edges
      WHERE child_subject_id = NEW.parent_subject_id
      UNION
      SELECT edge.parent_subject_id
      FROM {{schema}}.media_provenance_parent_edges edge
      JOIN ancestors ON edge.child_subject_id = ancestors.subject_id
    )
    SELECT 1 FROM ancestors WHERE subject_id = NEW.child_subject_id
  ) THEN
    RAISE EXCEPTION 'media provenance edge must not introduce a cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION {{schema}}.guard_media_provenance_parent_edge_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'media provenance parent edges are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_provenance_subject_immutable ON {{schema}}.media_provenance_subjects;
CREATE TRIGGER media_provenance_subject_immutable
  BEFORE UPDATE OR DELETE ON {{schema}}.media_provenance_subjects
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.guard_media_provenance_subject_immutable();

DROP TRIGGER IF EXISTS media_provenance_parent_edge_insert_guard ON {{schema}}.media_provenance_parent_edges;
CREATE TRIGGER media_provenance_parent_edge_insert_guard
  BEFORE INSERT ON {{schema}}.media_provenance_parent_edges
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.guard_media_provenance_parent_edge_insert();

DROP TRIGGER IF EXISTS media_provenance_parent_edge_immutable ON {{schema}}.media_provenance_parent_edges;
CREATE TRIGGER media_provenance_parent_edge_immutable
  BEFORE UPDATE OR DELETE ON {{schema}}.media_provenance_parent_edges
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.guard_media_provenance_parent_edge_immutable();

-- A first-party promoted asset must have a direct parent result owned by the
-- same server-side generation attempt.  DEFERRABLE lets repository code write
-- the subject and its edge in one transaction without a transient loophole.
CREATE OR REPLACE FUNCTION {{schema}}.assert_first_party_asset_provenance_parent()
RETURNS trigger AS $$
BEGIN
  IF NEW.asset_media_id IS NOT NULL AND NEW.source_channel = 'first_party_generation'
    AND NOT EXISTS (
      SELECT 1
      FROM {{schema}}.media_provenance_parent_edges edge
      JOIN {{schema}}.media_provenance_subjects parent ON parent.id = edge.parent_subject_id
      WHERE edge.child_subject_id = NEW.id
        AND parent.media_result_id IS NOT NULL
        AND parent.source_channel = 'first_party_generation'
        AND parent.source_generation_attempt_id = NEW.source_generation_attempt_id
    ) THEN
    RAISE EXCEPTION 'first-party asset provenance requires its direct first-party result parent';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS media_provenance_first_party_asset_parent_guard ON {{schema}}.media_provenance_subjects;
CREATE CONSTRAINT TRIGGER media_provenance_first_party_asset_parent_guard
  AFTER INSERT ON {{schema}}.media_provenance_subjects
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.assert_first_party_asset_provenance_parent();

-- The closure is calculated in PostgreSQL from immutable direct edges.  It
-- intentionally sees external and unknown image ancestors; unknown never
-- becomes self-produced merely because a later model touched it.
CREATE OR REPLACE FUNCTION {{schema}}.media_provenance_has_external_image_ancestor(target_subject_id bigint)
RETURNS boolean STABLE AS $$
  WITH RECURSIVE ancestors(subject_id) AS (
    SELECT parent_subject_id
    FROM {{schema}}.media_provenance_parent_edges
    WHERE child_subject_id = target_subject_id
    UNION
    SELECT edge.parent_subject_id
    FROM {{schema}}.media_provenance_parent_edges edge
    JOIN ancestors ON edge.child_subject_id = ancestors.subject_id
  )
  SELECT EXISTS (
    SELECT 1
    FROM ancestors
    JOIN {{schema}}.media_provenance_subjects subject ON subject.id = ancestors.subject_id
    LEFT JOIN {{schema}}.asset_media asset ON asset.id = subject.asset_media_id
    LEFT JOIN {{schema}}.media_results result ON result.id = subject.media_result_id
    WHERE subject.source_channel IN ('external_upload', 'unknown')
      AND coalesce(asset.media_kind, result.media_kind) = 'image'
  );
$$ LANGUAGE sql;

CREATE OR REPLACE VIEW {{schema}}.media_provenance_authority AS
SELECT subject.id,
       subject.asset_media_id,
       subject.media_result_id,
       subject.source_channel,
       subject.source_generation_attempt_id,
       subject.provider_asset_id,
       subject.observed_at,
       {{schema}}.media_provenance_has_external_image_ancestor(subject.id) AS contains_external_image_ancestor
FROM {{schema}}.media_provenance_subjects subject;

-- Self-produced trust is a separate, finite admission fact.  It belongs to a
-- result, not a CreateAsset registration or an asset-media projection.
CREATE TABLE IF NOT EXISTS {{schema}}.seedance_self_produced_trust (
  id uuid PRIMARY KEY,
  media_result_id uuid NOT NULL REFERENCES {{schema}}.media_results(id) ON DELETE RESTRICT,
  trusted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  status varchar(16) NOT NULL DEFAULT 'active',
  provider varchar(64) NOT NULL,
  model varchar(255) NOT NULL,
  tier_id varchar(128) NOT NULL,
  reference_count integer NOT NULL DEFAULT 0,
  qualification_evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seedance_self_produced_trust_media_result_unique UNIQUE (media_result_id),
  CONSTRAINT seedance_self_produced_trust_status_check CHECK (status IN ('active', 'expired')),
  CONSTRAINT seedance_self_produced_trust_window_check CHECK (expires_at = trusted_at + interval '30 days'),
  CONSTRAINT seedance_self_produced_trust_reference_count_check CHECK (reference_count = 0),
  CONSTRAINT seedance_self_produced_trust_evidence_object_check CHECK (jsonb_typeof(qualification_evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS seedance_self_produced_trust_status_expires_idx
  ON {{schema}}.seedance_self_produced_trust (status, expires_at, id);

CREATE OR REPLACE FUNCTION {{schema}}.assert_seedance_self_produced_trust()
RETURNS trigger AS $$
DECLARE
  result_row record;
BEGIN
  SELECT mr.media_kind, mr.origin_kind, mr.source_asset_media_id, mr.created_at, mr.attempt_id,
         mr.provider_result_key, mr.persistence_status, mr.compliance_metadata,
         gr.reference_media_ids, gr.reference_asset_snapshots,
         ga.provider, ga.model, ga.price_snapshot,
         authority.source_channel, authority.source_generation_attempt_id,
         authority.contains_external_image_ancestor
  INTO result_row
  FROM {{schema}}.media_results mr
  JOIN {{schema}}.generation_requests gr ON gr.id = mr.request_id
  JOIN {{schema}}.generation_attempts ga ON ga.id = mr.attempt_id
  LEFT JOIN {{schema}}.media_provenance_authority authority ON authority.media_result_id = mr.id
  WHERE mr.id = NEW.media_result_id AND mr.deleted_at IS NULL;

  IF result_row IS NULL
    OR result_row.media_kind <> 'image'
    OR result_row.origin_kind <> 'generation'
    OR result_row.source_asset_media_id IS NOT NULL
    OR result_row.persistence_status <> 'persisted'
    OR result_row.source_channel IS DISTINCT FROM 'first_party_generation'
    OR result_row.source_generation_attempt_id IS DISTINCT FROM result_row.attempt_id
    OR coalesce(result_row.contains_external_image_ancestor, true)
    OR result_row.provider_result_key IS NULL
    OR coalesce(jsonb_array_length(result_row.reference_media_ids), -1) <> 0
    OR coalesce(jsonb_array_length(result_row.reference_asset_snapshots), -1) <> 0
    OR result_row.compliance_metadata IS NULL
    OR coalesce(result_row.compliance_metadata->>'aigcMetadataEvidence', '') <> 'platform_applied'
    OR result_row.provider <> 'ark'
    OR result_row.model <> 'doubao-seedream-5-0-pro-260628'
    OR coalesce(result_row.price_snapshot->>'tierId', '') <> 'img-seedream5pro-169-2k-1'
    OR coalesce(result_row.price_snapshot->>'providerAccountBinding', '') = ''
    OR NEW.provider <> result_row.provider
    OR NEW.model <> result_row.model
    OR NEW.tier_id <> result_row.price_snapshot->>'tierId'
    OR NEW.reference_count <> 0 THEN
    RAISE EXCEPTION 'seedance self-produced trust requires direct provider-evidenced Seedream image output without input ancestors';
  END IF;
  IF NOT (NEW.qualification_evidence ?& ARRAY[
    'provider_result_key', 'aigc_metadata_evidence', 'provider_origin_evidence', 'account_binding'
  ])
    OR coalesce(NEW.qualification_evidence->>'provider_result_key', '') <> result_row.provider_result_key
    OR coalesce(NEW.qualification_evidence->>'aigc_metadata_evidence', '') <> 'platform_applied'
    OR jsonb_typeof(NEW.qualification_evidence->'provider_origin_evidence') <> 'object'
    OR jsonb_typeof(NEW.qualification_evidence->'account_binding') <> 'object'
    OR NEW.qualification_evidence->'provider_origin_evidence' = '{}'::jsonb
    OR NEW.qualification_evidence->'account_binding' = '{}'::jsonb
    OR NEW.qualification_evidence->'provider_origin_evidence'->>'observationMethod'
      <> 'exiftool_c2pa_jumbf'
    OR NEW.qualification_evidence->'provider_origin_evidence'->>'c2paPresentBefore' <> 'true'
    OR NEW.qualification_evidence->'provider_origin_evidence'->>'c2paPresentAfter' <> 'true'
    OR coalesce(NEW.qualification_evidence->'provider_origin_evidence'->>'manifestFingerprint', '')
      !~ '^[a-f0-9]{64}$'
    OR NEW.qualification_evidence->'provider_origin_evidence'->>'signatureVerification'
      <> 'not_performed'
    OR coalesce(NEW.qualification_evidence->'account_binding'->>'id', '')
      <> coalesce(result_row.price_snapshot->>'providerAccountBinding', '') THEN
    RAISE EXCEPTION 'seedance self-produced trust requires explicit server-origin qualification evidence';
  END IF;
  -- Never accept an application clock. The result persistence fact starts the
  -- only allowed 30-day window.
  NEW.trusted_at := result_row.created_at;
  NEW.expires_at := result_row.created_at + interval '30 days';
  NEW.status := 'active';
  NEW.reference_count := 0;
  NEW.created_at := result_row.created_at;
  NEW.updated_at := result_row.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION {{schema}}.guard_seedance_self_produced_trust_update()
RETURNS trigger AS $$
BEGIN
  IF OLD.media_result_id <> NEW.media_result_id
    OR OLD.trusted_at <> NEW.trusted_at
    OR OLD.expires_at <> NEW.expires_at
    OR OLD.provider <> NEW.provider
    OR OLD.model <> NEW.model
    OR OLD.tier_id <> NEW.tier_id
    OR OLD.reference_count <> NEW.reference_count
    OR OLD.qualification_evidence <> NEW.qualification_evidence
    OR OLD.created_at <> NEW.created_at
    OR NOT (OLD.status = 'active' AND NEW.status IN ('active', 'expired')) THEN
    RAISE EXCEPTION 'seedance self-produced trust is immutable except active-to-expired';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seedance_self_produced_trust_insert_guard ON {{schema}}.seedance_self_produced_trust;
CREATE TRIGGER seedance_self_produced_trust_insert_guard
  BEFORE INSERT ON {{schema}}.seedance_self_produced_trust
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.assert_seedance_self_produced_trust();

DROP TRIGGER IF EXISTS seedance_self_produced_trust_update_guard ON {{schema}}.seedance_self_produced_trust;
CREATE TRIGGER seedance_self_produced_trust_update_guard
  BEFORE UPDATE ON {{schema}}.seedance_self_produced_trust
  FOR EACH ROW EXECUTE FUNCTION {{schema}}.guard_seedance_self_produced_trust_update();

-- CreateAsset remains its own lifecycle.  `active` is not permanent: refresh
-- may move a remote asset to unavailable/unknown, and authorization expiry
-- makes a previously active mapping unusable at generation time.
ALTER TABLE {{schema}}.seedance_asset_registrations
  ADD COLUMN IF NOT EXISTS authorization_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

UPDATE {{schema}}.seedance_asset_registrations
SET last_verified_at = activated_at
WHERE status = 'active' AND last_verified_at IS NULL;

ALTER TABLE {{schema}}.seedance_asset_registrations
  DROP CONSTRAINT IF EXISTS seedance_asset_registrations_status_check,
  DROP CONSTRAINT IF EXISTS seedance_asset_registrations_state_shape_check;

ALTER TABLE {{schema}}.seedance_asset_registrations
  ADD CONSTRAINT seedance_asset_registrations_status_check
    CHECK (status IN ('pending', 'submitting', 'processing', 'active', 'failed', 'unknown', 'unavailable')),
  ADD CONSTRAINT seedance_asset_registrations_state_shape_check
    CHECK (
      (status = 'pending' AND remote_asset_id IS NULL AND activated_at IS NULL)
      OR (status = 'submitting' AND remote_asset_id IS NULL AND activated_at IS NULL)
      OR (status = 'processing' AND remote_asset_id IS NOT NULL AND activated_at IS NULL)
      OR (status = 'active' AND remote_asset_id IS NOT NULL AND activated_at IS NOT NULL AND last_verified_at IS NOT NULL)
      OR (status IN ('failed', 'unknown', 'unavailable') AND activated_at IS NULL)
    );

ALTER TABLE {{schema}}.seedance_asset_registration_attempts
  DROP CONSTRAINT IF EXISTS seedance_asset_registration_attempts_action_check;

ALTER TABLE {{schema}}.seedance_asset_registration_attempts
  ADD CONSTRAINT seedance_asset_registration_attempts_action_check
    CHECK (action IN ('create', 'refresh', 'reuse', 'bind'));

ALTER TABLE {{schema}}.seedance_asset_registration_attempts
  DROP CONSTRAINT IF EXISTS seedance_asset_registration_attempts_outcome_check;

ALTER TABLE {{schema}}.seedance_asset_registration_attempts
  ADD CONSTRAINT seedance_asset_registration_attempts_outcome_check
    CHECK (outcome IN ('submitting', 'submitted', 'processing', 'active', 'failed', 'unknown', 'unavailable', 'already_active'));

ALTER TABLE {{schema}}.seedance_asset_registration_attempts
  DROP CONSTRAINT IF EXISTS seedance_asset_registration_attempts_error_state_check;

ALTER TABLE {{schema}}.seedance_asset_registration_attempts
  ADD CONSTRAINT seedance_asset_registration_attempts_error_state_check
    CHECK (
      (outcome IN ('failed', 'unknown', 'unavailable')
        AND (error_code IS NOT NULL OR error_message IS NOT NULL))
      OR (outcome NOT IN ('failed', 'unknown', 'unavailable')
        AND error_code IS NULL AND error_message IS NULL)
    );

CREATE INDEX IF NOT EXISTS seedance_asset_registrations_active_authorization_idx
  ON {{schema}}.seedance_asset_registrations (status, authorization_expires_at, last_verified_at, asset_media_id);
