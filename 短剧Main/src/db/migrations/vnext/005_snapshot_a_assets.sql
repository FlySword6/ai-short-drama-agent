-- Issue #309: immutable Snapshot A imports of approved non-human reference assets.
CREATE TABLE IF NOT EXISTS vnext.asset_libraries (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO vnext.asset_libraries (id, name)
VALUES ('00000000-0000-0000-0000-000000000309', '旧系统素材库')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS vnext.imported_assets (
  id uuid PRIMARY KEY,
  library_id uuid NOT NULL REFERENCES vnext.asset_libraries(id) ON DELETE RESTRICT,
  asset_kind varchar(16) NOT NULL,
  media_kind varchar(16) NOT NULL,
  name varchar(255) NOT NULL,
  media_url text NOT NULL,
  media_sha256 char(64) NOT NULL,
  snapshot_version varchar(64) NOT NULL,
  snapshot_at timestamptz NOT NULL,
  review_status varchar(24) NOT NULL,
  registration_status varchar(24) NOT NULL DEFAULT 'not_required',
  registration_id varchar(128),
  registration_failure_code varchar(64),
  registration_failure_reason varchar(255),
  registration_readback jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnext_imported_assets_kind CHECK (asset_kind IN ('character', 'scene', 'prop')),
  CONSTRAINT vnext_imported_assets_media CHECK (media_kind IN ('image', 'video', 'audio')),
  CONSTRAINT vnext_imported_assets_review CHECK (review_status IN ('approved', 'pending_review', 'rejected')),
  CONSTRAINT vnext_imported_assets_registration CHECK (registration_status IN ('not_required', 'pending', 'active', 'processing', 'failed', 'unknown'))
);

CREATE TABLE IF NOT EXISTS vnext.import_source_mappings (
  id uuid PRIMARY KEY,
  imported_asset_id uuid NOT NULL UNIQUE REFERENCES vnext.imported_assets(id) ON DELETE RESTRICT,
  source_system varchar(64) NOT NULL,
  source_id varchar(255) NOT NULL,
  media_sha256 char(64) NOT NULL,
  source_snapshot_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_system, source_id, media_sha256)
);

CREATE TABLE IF NOT EXISTS vnext.import_registration_attempts (
  id uuid PRIMARY KEY,
  imported_asset_id uuid NOT NULL REFERENCES vnext.imported_assets(id) ON DELETE RESTRICT,
  action varchar(32) NOT NULL,
  outcome varchar(24) NOT NULL,
  registration_id varchar(128),
  failure_code varchar(64),
  failure_reason varchar(255),
  readback jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnext_import_registration_attempts_action CHECK (action IN ('register', 'readback')),
  CONSTRAINT vnext_import_registration_attempts_outcome CHECK (outcome IN ('active', 'processing', 'failed', 'unknown'))
);

CREATE INDEX IF NOT EXISTS vnext_imported_assets_library_created_idx
  ON vnext.imported_assets(library_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS vnext_import_registration_attempts_asset_created_idx
  ON vnext.import_registration_attempts(imported_asset_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON
  vnext.asset_libraries,
  vnext.imported_assets,
  vnext.import_source_mappings,
  vnext.import_registration_attempts
TO vnext_app;
