-- vNext is an isolated product surface. It deliberately owns no Lite/legacy tables.
-- The deployment migration principal owns objects; vnext_app is the least-privilege runtime role.
CREATE SCHEMA IF NOT EXISTS vnext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vnext_app') THEN
    CREATE ROLE vnext_app NOLOGIN;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS vnext.projects (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnext_projects_name_nonempty CHECK (length(btrim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS vnext.project_members (
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role varchar(16) NOT NULL,
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT vnext_project_members_role CHECK (role IN ('owner', 'editor', 'viewer'))
);

CREATE TABLE IF NOT EXISTS vnext.graph_documents (
  project_id uuid PRIMARY KEY REFERENCES vnext.projects(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnext_graph_documents_revision_positive CHECK (revision > 0)
);

CREATE TABLE IF NOT EXISTS vnext.graph_revisions (
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  document jsonb NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, revision),
  CONSTRAINT vnext_graph_revisions_revision_positive CHECK (revision > 0)
);

CREATE OR REPLACE FUNCTION vnext.prevent_graph_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'vnext graph revisions are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS vnext_graph_revisions_immutable ON vnext.graph_revisions;
CREATE TRIGGER vnext_graph_revisions_immutable
BEFORE UPDATE OR DELETE ON vnext.graph_revisions
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_graph_revision_mutation();

CREATE TABLE IF NOT EXISTS vnext.generation_telemetry_events (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL,
  request_id varchar(128) NOT NULL,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL,
  event_type varchar(64) NOT NULL,
  provider varchar(128),
  model varchar(256),
  capability_snapshot_version varchar(128),
  paid_confirmation boolean,
  queue_latency_ms integer,
  provider_latency_ms integer,
  provider_cost_fen integer,
  result_status varchar(64),
  retry_reason varchar(128),
  CONSTRAINT vnext_generation_telemetry_event_type_nonempty CHECK (length(btrim(event_type)) > 0),
  CONSTRAINT vnext_generation_telemetry_no_negative_latency CHECK (
    (queue_latency_ms IS NULL OR queue_latency_ms >= 0)
    AND (provider_latency_ms IS NULL OR provider_latency_ms >= 0)
    AND (provider_cost_fen IS NULL OR provider_cost_fen >= 0)
  )
);

CREATE INDEX IF NOT EXISTS vnext_generation_telemetry_project_task_idx
  ON vnext.generation_telemetry_events(project_id, task_id, occurred_at DESC);

REVOKE ALL ON SCHEMA vnext FROM PUBLIC;
GRANT USAGE ON SCHEMA vnext TO vnext_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA vnext TO vnext_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA vnext GRANT SELECT, INSERT, UPDATE ON TABLES TO vnext_app;
