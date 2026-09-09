-- Issue #313: immutable video segment versions with modify/extend change drafts.
-- A version row is appended only from a succeeded generation attempt's TOS media.
-- The original version row and its TOS objects are never mutated: modify/extend
-- grows the chain with a new row that references its origin version.
-- Failed change tasks only leave failed attempt records; no version row is written.

CREATE TABLE IF NOT EXISTS vnext.video_versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  -- Chain identity: all versions grown from the same registered root share it.
  chain_id uuid NOT NULL,
  version_no integer NOT NULL,
  change_type varchar(16) NOT NULL,
  -- Immediate parent; NULL only for the registered root (version_no = 1).
  origin_version_id uuid REFERENCES vnext.video_versions(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  source_task_id uuid NOT NULL REFERENCES vnext.generation_tasks(id) ON DELETE RESTRICT,
  source_attempt_id uuid NOT NULL REFERENCES vnext.generation_attempts(id) ON DELETE RESTRICT,
  control_package_id uuid NOT NULL REFERENCES vnext.control_package_versions(id) ON DELETE RESTRICT,
  control_package_version integer NOT NULL,
  -- Frozen inputs/cost copied from the task + attempt at registration time.
  provider varchar(64) NOT NULL,
  model varchar(255) NOT NULL,
  prompt text NOT NULL,
  parameters jsonb NOT NULL,
  tos_media jsonb NOT NULL,
  estimated_cost_fen bigint NOT NULL,
  actual_cost_fen bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnext_video_versions_chain_version_unique UNIQUE (chain_id, version_no),
  CONSTRAINT vnext_video_versions_attempt_unique UNIQUE (project_id, source_attempt_id),
  -- Linear growth: at most one child version per origin (NULLs stay distinct).
  CONSTRAINT vnext_video_versions_single_child UNIQUE (origin_version_id),
  CONSTRAINT vnext_video_versions_change_type CHECK (change_type IN ('register', 'modify', 'extend')),
  CONSTRAINT vnext_video_versions_version_no CHECK (version_no >= 1),
  CONSTRAINT vnext_video_versions_root_shape CHECK (
    (change_type = 'register' AND origin_version_id IS NULL AND version_no = 1)
    OR (change_type IN ('modify', 'extend') AND origin_version_id IS NOT NULL AND version_no >= 2)
  ),
  CONSTRAINT vnext_video_versions_control_package_version CHECK (control_package_version >= 1),
  CONSTRAINT vnext_video_versions_provider CHECK (char_length(provider) > 0),
  CONSTRAINT vnext_video_versions_model CHECK (char_length(model) > 0),
  CONSTRAINT vnext_video_versions_prompt CHECK (char_length(prompt) > 0),
  CONSTRAINT vnext_video_versions_estimated_cost CHECK (estimated_cost_fen >= 0),
  CONSTRAINT vnext_video_versions_actual_cost CHECK (actual_cost_fen IS NULL OR actual_cost_fen >= 0),
  CONSTRAINT vnext_video_versions_parameters CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT vnext_video_versions_tos_media CHECK (
    jsonb_typeof(tos_media) = 'array' AND jsonb_array_length(tos_media) > 0
  )
);

CREATE INDEX IF NOT EXISTS vnext_video_versions_project_created_idx
  ON vnext.video_versions(project_id, created_at DESC, id DESC);

-- A change draft binds a human-started modify/extend request to its pending
-- generation intent. No provider call happens at this point; the existing
-- confirm flow (generation_tasks) owns the single paid task per confirmation.
CREATE TABLE IF NOT EXISTS vnext.video_change_drafts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  origin_version_id uuid NOT NULL REFERENCES vnext.video_versions(id) ON DELETE RESTRICT,
  change_type varchar(16) NOT NULL,
  intent_id uuid NOT NULL REFERENCES vnext.pending_generation_intents(id) ON DELETE RESTRICT,
  client_idempotency_key varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vnext_video_change_drafts_intent_unique UNIQUE (intent_id),
  CONSTRAINT vnext_video_change_drafts_idempotency_unique UNIQUE (project_id, actor_id, client_idempotency_key),
  CONSTRAINT vnext_video_change_drafts_change_type CHECK (change_type IN ('modify', 'extend'))
);

CREATE INDEX IF NOT EXISTS vnext_video_change_drafts_origin_idx
  ON vnext.video_change_drafts(origin_version_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION vnext.prevent_video_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'video versions and change drafts are append-only';
END;
$$;

CREATE TRIGGER vnext_video_versions_immutable
BEFORE UPDATE OR DELETE ON vnext.video_versions
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_video_version_mutation();

CREATE TRIGGER vnext_video_change_drafts_immutable
BEFORE UPDATE OR DELETE ON vnext.video_change_drafts
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_video_version_mutation();

GRANT SELECT, INSERT ON
  vnext.video_versions,
  vnext.video_change_drafts
TO vnext_app;
REVOKE UPDATE, DELETE ON
  vnext.video_versions,
  vnext.video_change_drafts
FROM vnext_app;
