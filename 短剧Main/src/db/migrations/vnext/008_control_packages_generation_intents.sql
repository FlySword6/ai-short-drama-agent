-- Issue #311: immutable reference control packages and provider-free pending generation intents.
CREATE TABLE IF NOT EXISTS vnext.control_package_versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version),
  CONSTRAINT vnext_control_package_versions_version CHECK (version >= 1),
  CONSTRAINT vnext_control_package_versions_snapshot CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS vnext_control_package_versions_project_created_idx
  ON vnext.control_package_versions(project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS vnext.pending_generation_intents (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  client_idempotency_key varchar(128) NOT NULL,
  control_package_id uuid NOT NULL REFERENCES vnext.control_package_versions(id) ON DELETE RESTRICT,
  control_package_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, actor_id, client_idempotency_key),
  CONSTRAINT vnext_pending_generation_intents_package_version CHECK (control_package_version >= 1),
  CONSTRAINT vnext_pending_generation_intents_snapshot CHECK (
    jsonb_typeof(snapshot) = 'object' AND snapshot->>'status' = 'pending_confirmation'
  )
);

CREATE INDEX IF NOT EXISTS vnext_pending_generation_intents_project_actor_created_idx
  ON vnext.pending_generation_intents(project_id, actor_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION vnext.prevent_generation_control_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'generation control records are append-only';
END;
$$;

CREATE TRIGGER vnext_control_package_versions_immutable
BEFORE UPDATE OR DELETE ON vnext.control_package_versions
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_generation_control_mutation();

CREATE TRIGGER vnext_pending_generation_intents_immutable
BEFORE UPDATE OR DELETE ON vnext.pending_generation_intents
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_generation_control_mutation();

GRANT SELECT, INSERT ON
  vnext.control_package_versions,
  vnext.pending_generation_intents
TO vnext_app;
REVOKE UPDATE, DELETE ON
  vnext.control_package_versions,
  vnext.pending_generation_intents
FROM vnext_app;
