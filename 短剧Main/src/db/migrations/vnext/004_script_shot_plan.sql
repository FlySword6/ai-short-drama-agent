-- Issue #308: fixed-script parse drafts and confirmed shot-plan facts.
-- Script content stays private in script_sources and is never copied into telemetry.
CREATE TABLE IF NOT EXISTS vnext.script_sources (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  source_kind varchar(16) NOT NULL,
  file_name varchar(255),
  script_content text NOT NULL,
  content_sha256 char(64) NOT NULL,
  created_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnext_script_sources_kind CHECK (source_kind IN ('paste', 'upload')),
  CONSTRAINT vnext_script_sources_content_nonempty CHECK (length(btrim(script_content)) > 0),
  CONSTRAINT vnext_script_sources_file_name CHECK (
    (source_kind = 'paste' AND file_name IS NULL)
    OR (source_kind = 'upload' AND length(btrim(file_name)) > 0)
  )
);

CREATE TABLE IF NOT EXISTS vnext.script_parse_runs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES vnext.script_sources(id) ON DELETE RESTRICT,
  client_idempotency_key varchar(128) NOT NULL,
  status varchar(32) NOT NULL,
  progress integer NOT NULL DEFAULT 0,
  current_stage varchar(32) NOT NULL DEFAULT 'queued',
  draft jsonb,
  error_code varchar(64),
  error_message varchar(255),
  error_retryable boolean NOT NULL DEFAULT false,
  created_by_user_id uuid NOT NULL,
  confirmed_by_user_id uuid,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, client_idempotency_key),
  CONSTRAINT vnext_script_parse_runs_status CHECK (
    status IN ('queued', 'running', 'draft', 'partial_failure', 'failed', 'confirmed')
  ),
  CONSTRAINT vnext_script_parse_runs_progress CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT vnext_script_parse_runs_error_shape CHECK (
    (status IN ('partial_failure', 'failed') AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR (status NOT IN ('partial_failure', 'failed') AND error_code IS NULL AND error_message IS NULL)
  ),
  CONSTRAINT vnext_script_parse_runs_draft_shape CHECK (
    (status IN ('draft', 'partial_failure', 'confirmed') AND draft IS NOT NULL)
    OR (status NOT IN ('draft', 'partial_failure', 'confirmed') AND draft IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS vnext_script_parse_runs_project_created_idx
  ON vnext.script_parse_runs(project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS vnext.script_confirmations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  run_id uuid NOT NULL UNIQUE REFERENCES vnext.script_parse_runs(id) ON DELETE RESTRICT,
  client_idempotency_key varchar(128) NOT NULL,
  confirmed_by_user_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, client_idempotency_key)
);

CREATE TABLE IF NOT EXISTS vnext.shot_plan_characters (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL REFERENCES vnext.script_confirmations(id) ON DELETE RESTRICT,
  draft_key varchar(128) NOT NULL,
  name varchar(160) NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (confirmation_id, draft_key)
);

CREATE TABLE IF NOT EXISTS vnext.shot_plan_scenes (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL REFERENCES vnext.script_confirmations(id) ON DELETE RESTRICT,
  draft_key varchar(128) NOT NULL,
  title varchar(240) NOT NULL,
  summary text NOT NULL,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (confirmation_id, draft_key),
  UNIQUE (confirmation_id, position),
  CONSTRAINT vnext_shot_plan_scenes_position CHECK (position >= 0)
);

CREATE TABLE IF NOT EXISTS vnext.shot_plan_shots (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL REFERENCES vnext.script_confirmations(id) ON DELETE RESTRICT,
  scene_id uuid NOT NULL REFERENCES vnext.shot_plan_scenes(id) ON DELETE RESTRICT,
  draft_key varchar(128) NOT NULL,
  position integer NOT NULL,
  shot_size varchar(64) NOT NULL,
  camera_movement varchar(160) NOT NULL,
  action text NOT NULL,
  rhythm varchar(160) NOT NULL,
  dialogue text NOT NULL,
  sound text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (confirmation_id, draft_key),
  UNIQUE (scene_id, position),
  CONSTRAINT vnext_shot_plan_shots_position CHECK (position >= 0)
);

GRANT SELECT, INSERT, UPDATE ON
  vnext.script_sources,
  vnext.script_parse_runs,
  vnext.script_confirmations,
  vnext.shot_plan_characters,
  vnext.shot_plan_scenes,
  vnext.shot_plan_shots
TO vnext_app;
