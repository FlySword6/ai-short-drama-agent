-- S49 follow-up: qualification evidence is fail-closed. PostgreSQL's NULL
-- boolean semantics would otherwise let a missing required field bypass an
-- OR-based rejection condition in the original trust admission function.

-- A provider can finish paid generation before the platform label gate fails.
-- Keep the quote and reserved amount as a durable pending-compensation input;
-- this migration does not invent a refund or change pricing.
CREATE TABLE IF NOT EXISTS {{schema}}.generation_billing_failure_facts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES {{schema}}.generation_attempts(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL REFERENCES {{schema}}.generation_quotes(id) ON DELETE RESTRICT,
  failure_code varchar(128) NOT NULL,
  reserved_amount_fen integer NOT NULL,
  provider_cost_status varchar(32) NOT NULL,
  resolution_status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_billing_failure_amount_check CHECK (reserved_amount_fen >= 0),
  CONSTRAINT generation_billing_failure_provider_cost_status_check
    CHECK (provider_cost_status = 'incurred'),
  CONSTRAINT generation_billing_failure_resolution_status_check
    CHECK (resolution_status = 'pending_compensation'),
  CONSTRAINT generation_billing_failure_attempt_quote_unique UNIQUE (attempt_id, quote_id)
);
CREATE INDEX IF NOT EXISTS generation_billing_failure_quote_idx
  ON {{schema}}.generation_billing_failure_facts (quote_id);
CREATE INDEX IF NOT EXISTS generation_billing_failure_user_created_idx
  ON {{schema}}.generation_billing_failure_facts (user_id, created_at, id);
CREATE INDEX IF NOT EXISTS generation_billing_failure_project_created_idx
  ON {{schema}}.generation_billing_failure_facts (project_id, created_at, id);
CREATE INDEX IF NOT EXISTS generation_billing_failure_resolution_created_idx
  ON {{schema}}.generation_billing_failure_facts (resolution_status, created_at, id);

-- S49 never deletes a half-batch TOS object. It records the object key before
-- media persistence; a successful media transaction marks it referenced,
-- while terminal output withdrawal returns it to pending cleanup for S69.
CREATE TABLE IF NOT EXISTS {{schema}}.generation_tos_orphans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL REFERENCES {{schema}}.generation_attempts(id) ON DELETE RESTRICT,
  media_result_id uuid REFERENCES {{schema}}.media_results(id) ON DELETE SET NULL,
  provider_result_key varchar(512) NOT NULL,
  storage_bucket varchar(128) NOT NULL,
  object_key varchar(1024) NOT NULL,
  produced_at timestamptz NOT NULL,
  cleanup_status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_tos_orphans_cleanup_status_check
    CHECK (cleanup_status IN ('pending_cleanup', 'referenced')),
  CONSTRAINT generation_tos_orphans_bucket_key_unique UNIQUE (storage_bucket, object_key)
);
CREATE INDEX IF NOT EXISTS generation_tos_orphans_user_created_idx
  ON {{schema}}.generation_tos_orphans (user_id, created_at, id);
CREATE INDEX IF NOT EXISTS generation_tos_orphans_project_created_idx
  ON {{schema}}.generation_tos_orphans (project_id, created_at, id);
CREATE INDEX IF NOT EXISTS generation_tos_orphans_cleanup_created_idx
  ON {{schema}}.generation_tos_orphans (cleanup_status, produced_at, id);
CREATE INDEX IF NOT EXISTS generation_tos_orphans_attempt_idx
  ON {{schema}}.generation_tos_orphans (attempt_id, id);
CREATE INDEX IF NOT EXISTS generation_tos_orphans_media_result_idx
  ON {{schema}}.generation_tos_orphans (media_result_id);

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
      IS DISTINCT FROM 'exiftool_c2pa_jumbf'
    OR NEW.qualification_evidence->'provider_origin_evidence'->>'c2paPresentBefore' IS DISTINCT FROM 'true'
    OR NEW.qualification_evidence->'provider_origin_evidence'->>'c2paPresentAfter' IS DISTINCT FROM 'true'
    OR coalesce(NEW.qualification_evidence->'provider_origin_evidence'->>'manifestFingerprint', '')
      !~ '^[a-f0-9]{64}$'
    OR NEW.qualification_evidence->'provider_origin_evidence'->>'signatureVerification'
      IS DISTINCT FROM 'not_performed'
    OR coalesce(NEW.qualification_evidence->'account_binding'->>'id', '')
      <> coalesce(result_row.price_snapshot->>'providerAccountBinding', '') THEN
    RAISE EXCEPTION 'seedance self-produced trust requires explicit server-origin qualification evidence';
  END IF;
  NEW.trusted_at := result_row.created_at;
  NEW.expires_at := result_row.created_at + interval '30 days';
  NEW.status := 'active';
  NEW.reference_count := 0;
  NEW.created_at := result_row.created_at;
  NEW.updated_at := result_row.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
