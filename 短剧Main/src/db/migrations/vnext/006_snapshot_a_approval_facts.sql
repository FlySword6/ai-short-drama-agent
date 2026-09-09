-- Compatibility bridge for deployments that applied the earlier Snapshot A 005.
-- Fresh installs and old-005 installs both run this file after 005, so every
-- object is created or altered idempotently. Existing approvals deliberately
-- remain incomplete until an operator backfills the exact signed media facts;
-- the runtime treats NULL facts as unapproved, so this change fails closed
-- while preserving any old audit rows. Recovery: do not roll back by dropping
-- these source-of-truth tables; disable the import route, restore manifest
-- facts, and replay readback by remote ID.
CREATE TABLE IF NOT EXISTS vnext.import_source_approvals (
  source_system varchar(64) NOT NULL,
  source_id varchar(255) NOT NULL,
  media_sha256 char(64),
  asset_kind varchar(16),
  media_kind varchar(16),
  approved boolean NOT NULL DEFAULT TRUE,
  is_human boolean NOT NULL DEFAULT FALSE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_system, source_id)
);
ALTER TABLE vnext.import_source_approvals
  ADD COLUMN IF NOT EXISTS media_sha256 char(64),
  ADD COLUMN IF NOT EXISTS asset_kind varchar(16),
  ADD COLUMN IF NOT EXISTS media_kind varchar(16);
ALTER TABLE vnext.import_source_approvals
  ADD COLUMN IF NOT EXISTS name varchar(255),
  ADD COLUMN IF NOT EXISTS snapshot_version varchar(64);
ALTER TABLE vnext.import_source_approvals
  ADD COLUMN IF NOT EXISTS source_snapshot_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vnext.import_source_approvals'::regclass
      AND conname = 'vnext_import_source_approvals_name'
  ) THEN
    ALTER TABLE vnext.import_source_approvals
      ADD CONSTRAINT vnext_import_source_approvals_name CHECK (char_length(name) BETWEEN 1 AND 255);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vnext.import_source_approvals'::regclass
      AND conname = 'vnext_import_source_approvals_version'
  ) THEN
    ALTER TABLE vnext.import_source_approvals
      ADD CONSTRAINT vnext_import_source_approvals_version CHECK (char_length(snapshot_version) BETWEEN 1 AND 64);
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vnext.import_source_approvals'::regclass
      AND conname = 'vnext_import_source_approvals_nonhuman'
  ) THEN
    ALTER TABLE vnext.import_source_approvals
      ADD CONSTRAINT vnext_import_source_approvals_nonhuman CHECK (approved IS TRUE AND is_human IS FALSE);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vnext.import_source_approvals'::regclass
      AND conname = 'vnext_import_source_approvals_kind'
  ) THEN
    ALTER TABLE vnext.import_source_approvals
      ADD CONSTRAINT vnext_import_source_approvals_kind CHECK (asset_kind IN ('character', 'scene', 'prop'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vnext.import_source_approvals'::regclass
      AND conname = 'vnext_import_source_approvals_media'
  ) THEN
    ALTER TABLE vnext.import_source_approvals
      ADD CONSTRAINT vnext_import_source_approvals_media CHECK (media_kind IN ('image', 'video', 'audio'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vnext.import_verification_attempts (
  id uuid PRIMARY KEY,
  source_system varchar(64) NOT NULL,
  source_id varchar(255) NOT NULL,
  media_url text NOT NULL,
  outcome varchar(16) NOT NULL,
  failure_code varchar(64),
  failure_reason varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnext_import_verification_attempts_outcome CHECK (outcome IN ('verified', 'failed'))
);
CREATE INDEX IF NOT EXISTS vnext_import_verification_attempts_source_created_idx
  ON vnext.import_verification_attempts(source_system, source_id, created_at DESC);

-- One legacy source has exactly one immutable target mapping. If this
-- constraint cannot be added, stop, reconcile duplicate mappings against the
-- signed snapshot manifest, then re-run the migration.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vnext.import_source_mappings'::regclass
      AND conname = 'vnext_import_source_mappings_source_unique'
  ) THEN
    ALTER TABLE vnext.import_source_mappings
      ADD CONSTRAINT vnext_import_source_mappings_source_unique UNIQUE (source_system, source_id);
  END IF;
END $$;

GRANT SELECT, INSERT ON
  vnext.asset_libraries,
  vnext.imported_assets,
  vnext.import_registration_attempts,
  vnext.import_verification_attempts
TO vnext_app;
REVOKE UPDATE ON vnext.imported_assets FROM vnext_app;
GRANT UPDATE (registration_status, registration_id, registration_failure_code, registration_failure_reason, registration_readback, updated_at)
  ON vnext.imported_assets TO vnext_app;
GRANT SELECT, INSERT ON vnext.import_source_mappings TO vnext_app;
GRANT SELECT ON vnext.import_source_approvals TO vnext_app;
REVOKE UPDATE ON vnext.import_source_mappings FROM vnext_app;
REVOKE INSERT, UPDATE ON vnext.import_source_approvals FROM vnext_app;
REVOKE UPDATE ON vnext.import_registration_attempts FROM vnext_app;
REVOKE UPDATE ON vnext.import_verification_attempts FROM vnext_app;
