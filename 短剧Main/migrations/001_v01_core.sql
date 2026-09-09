CREATE TABLE IF NOT EXISTS {{schema}}.users (
  id uuid PRIMARY KEY,
  username varchar(64) NOT NULL,
  display_name varchar(128) NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9_.-]{2,63}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON {{schema}}.users (lower(username));

CREATE TABLE IF NOT EXISTS {{schema}}.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  token_hash varchar(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique ON {{schema}}.sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON {{schema}}.sessions (user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.projects (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  name varchar(255) NOT NULL,
  description text,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  CONSTRAINT projects_status_check CHECK (status IN ('active', 'archived'))
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_name_active_unique
  ON {{schema}}.projects (owner_user_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_owner_updated_idx
  ON {{schema}}.projects (owner_user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.episodes (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id),
  episode_no integer NOT NULL,
  name varchar(255),
  sort_order integer NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  CONSTRAINT episodes_number_check CHECK (episode_no > 0),
  CONSTRAINT episodes_status_check CHECK (status IN ('active', 'archived'))
);
CREATE UNIQUE INDEX IF NOT EXISTS episodes_project_number_active_unique
  ON {{schema}}.episodes (project_id, episode_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS episodes_project_sort_idx
  ON {{schema}}.episodes (project_id, sort_order, episode_no) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.scenes (
  id uuid PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES {{schema}}.episodes(id),
  scene_no integer NOT NULL,
  name varchar(255),
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  CONSTRAINT scenes_number_check CHECK (scene_no > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS scenes_episode_number_active_unique
  ON {{schema}}.scenes (episode_id, scene_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS scenes_episode_sort_idx
  ON {{schema}}.scenes (episode_id, sort_order, scene_no) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.shots (
  id uuid PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES {{schema}}.episodes(id),
  scene_id uuid REFERENCES {{schema}}.scenes(id),
  shot_code varchar(64) NOT NULL,
  title varchar(255),
  script_text text,
  director_prompt text,
  image_prompt text,
  video_prompt text,
  duration_seconds integer,
  sort_order integer NOT NULL DEFAULT 0,
  reference_asset_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_image_result_id uuid,
  selected_video_result_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  CONSTRAINT shots_duration_check CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  CONSTRAINT shots_reference_snapshots_array CHECK (jsonb_typeof(reference_asset_snapshots) = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS shots_episode_code_active_unique
  ON {{schema}}.shots (episode_id, shot_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS shots_episode_sort_idx
  ON {{schema}}.shots (episode_id, sort_order, shot_code) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.storyboard_imports (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id),
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  source_file_name varchar(512) NOT NULL,
  source_sha256 varchar(64) NOT NULL,
  source_storage_path varchar(1024),
  status varchar(20) NOT NULL DEFAULT 'previewed',
  preview_rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmation_result jsonb,
  confirmed_at timestamptz,
  confirmed_by_user_id uuid REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT storyboard_imports_status_check CHECK (status IN ('previewed', 'confirmed', 'rejected')),
  CONSTRAINT storyboard_imports_confirmed_consistency CHECK (
    (status = 'confirmed' AND confirmed_at IS NOT NULL AND confirmed_by_user_id IS NOT NULL)
    OR status <> 'confirmed'
  )
);
CREATE INDEX IF NOT EXISTS storyboard_imports_project_created_idx
  ON {{schema}}.storyboard_imports (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.asset_source_projects (
  id uuid PRIMARY KEY,
  name varchar(128),
  code varchar(64),
  description varchar(512),
  metadata jsonb,
  created_at timestamp,
  updated_at timestamp,
  project_type varchar(64)
);

CREATE TABLE IF NOT EXISTS {{schema}}.asset_entities (
  id uuid PRIMARY KEY,
  source_project_id uuid,
  source_project_name varchar(128),
  asset_kind varchar(20) NOT NULL,
  name varchar(128) NOT NULL,
  display_name varchar(128),
  intro text,
  appearance text,
  age_value integer,
  gender varchar(16),
  height_cm integer,
  hair_description varchar(512),
  outfit_description text,
  category varchar(64),
  style_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved boolean,
  reuse_scope varchar(20) NOT NULL DEFAULT 'all_projects',
  status varchar(20) NOT NULL DEFAULT 'pending_review',
  source_file_url varchar(1024),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  use_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS {{schema}}.asset_variants (
  id uuid PRIMARY KEY,
  asset_entity_id uuid NOT NULL,
  variant_kind varchar(32) NOT NULL,
  name varchar(128) NOT NULL,
  description text,
  usage_context varchar(255),
  visual_prompt text,
  approved boolean,
  status varchar(20) NOT NULL DEFAULT 'pending_review',
  is_primary boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  source_file_url varchar(1024),
  source_text text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp,
  updated_at timestamp
);

CREATE TABLE IF NOT EXISTS {{schema}}.asset_media (
  id uuid PRIMARY KEY,
  asset_entity_id uuid,
  asset_variant_id uuid,
  media_kind varchar(32) NOT NULL,
  view_angle varchar(20),
  title varchar(128),
  description text,
  storage_bucket varchar(128),
  storage_path varchar(512),
  storage_url varchar(1024),
  width_px integer,
  height_px integer,
  format varchar(32),
  sha256 varchar(64),
  is_primary boolean NOT NULL DEFAULT false,
  approved boolean,
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp
);

ALTER TABLE IF EXISTS {{schema}}.asset_entities ADD COLUMN IF NOT EXISTS owner_user_id uuid;
ALTER TABLE IF EXISTS {{schema}}.asset_entities ADD COLUMN IF NOT EXISTS visibility varchar(16);
ALTER TABLE IF EXISTS {{schema}}.asset_entities ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS {{schema}}.asset_entities ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid;

UPDATE {{schema}}.asset_entities SET visibility = 'common' WHERE visibility IS NULL;
ALTER TABLE {{schema}}.asset_entities ALTER COLUMN visibility SET DEFAULT 'personal';
ALTER TABLE {{schema}}.asset_entities ALTER COLUMN visibility SET NOT NULL;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_owner_user_fk FOREIGN KEY (owner_user_id) REFERENCES {{schema}}.users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;
DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_deleted_by_user_fk FOREIGN KEY (deleted_by_user_id) REFERENCES {{schema}}.users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;
DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_visibility_check CHECK (visibility IN ('personal', 'common'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

ALTER TABLE IF EXISTS {{schema}}.asset_variants ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS {{schema}}.asset_variants ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid;
DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_variants
    ADD CONSTRAINT asset_variants_deleted_by_user_fk FOREIGN KEY (deleted_by_user_id) REFERENCES {{schema}}.users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

ALTER TABLE IF EXISTS {{schema}}.asset_media ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE IF EXISTS {{schema}}.asset_media ADD COLUMN IF NOT EXISTS deleted_by_user_id uuid;
DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_media
    ADD CONSTRAINT asset_media_deleted_by_user_fk FOREIGN KEY (deleted_by_user_id) REFERENCES {{schema}}.users(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY asset_entity_id, variant_kind
    ORDER BY sort_order, created_at NULLS LAST, id
  ) AS rank
  FROM {{schema}}.asset_variants
  WHERE is_primary = true AND deleted_at IS NULL
)
UPDATE {{schema}}.asset_variants target
SET is_primary = false
FROM ranked
WHERE target.id = ranked.id AND ranked.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS asset_variants_one_primary_active
  ON {{schema}}.asset_variants (asset_entity_id, variant_kind)
  WHERE is_primary = true AND deleted_at IS NULL;

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY asset_entity_id, coalesce(asset_variant_id, '00000000-0000-0000-0000-000000000000'::uuid), media_kind
    ORDER BY sort_order, created_at NULLS LAST, id
  ) AS rank
  FROM {{schema}}.asset_media
  WHERE is_primary = true AND deleted_at IS NULL
)
UPDATE {{schema}}.asset_media target
SET is_primary = false
FROM ranked
WHERE target.id = ranked.id AND ranked.rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS asset_media_one_primary_active
  ON {{schema}}.asset_media (
    asset_entity_id,
    coalesce(asset_variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    media_kind
  ) WHERE is_primary = true AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.project_asset_refs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id),
  asset_entity_id uuid NOT NULL REFERENCES {{schema}}.asset_entities(id),
  asset_variant_id uuid REFERENCES {{schema}}.asset_variants(id),
  asset_media_id uuid REFERENCES {{schema}}.asset_media(id),
  version_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS project_asset_refs_active_unique
  ON {{schema}}.project_asset_refs (project_id, asset_entity_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS project_asset_refs_project_idx
  ON {{schema}}.project_asset_refs (project_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.generation_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id),
  episode_id uuid REFERENCES {{schema}}.episodes(id),
  scene_id uuid REFERENCES {{schema}}.scenes(id),
  shot_id uuid REFERENCES {{schema}}.shots(id),
  target_asset_entity_id uuid REFERENCES {{schema}}.asset_entities(id),
  media_kind varchar(16) NOT NULL,
  prompt text NOT NULL,
  reference_media_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  reference_asset_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  quantity integer NOT NULL DEFAULT 1,
  client_idempotency_key varchar(255) NOT NULL,
  request_hash varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_requests_media_kind_check CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT generation_requests_quantity_check CHECK (quantity BETWEEN 1 AND 8),
  CONSTRAINT generation_requests_target_check CHECK (shot_id IS NOT NULL OR target_asset_entity_id IS NOT NULL),
  CONSTRAINT generation_requests_reference_media_array CHECK (jsonb_typeof(reference_media_ids) = 'array'),
  CONSTRAINT generation_requests_reference_snapshot_array CHECK (jsonb_typeof(reference_asset_snapshots) = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS generation_requests_user_idempotency_unique
  ON {{schema}}.generation_requests (user_id, client_idempotency_key);
CREATE INDEX IF NOT EXISTS generation_requests_project_created_idx
  ON {{schema}}.generation_requests (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.pricing_rules (
  id uuid PRIMARY KEY,
  provider varchar(32) NOT NULL,
  model varchar(128) NOT NULL,
  media_kind varchar(16) NOT NULL,
  billing_unit varchar(32) NOT NULL,
  unit_price_fen integer NOT NULL,
  currency varchar(8) NOT NULL DEFAULT 'CNY',
  source varchar(512) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_rules_media_kind_check CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT pricing_rules_unit_price_check CHECK (unit_price_fen >= 0),
  CONSTRAINT pricing_rules_effective_range_check CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS pricing_rules_lookup_idx
  ON {{schema}}.pricing_rules (provider, model, media_kind, effective_from DESC) WHERE active = true;

CREATE TABLE IF NOT EXISTS {{schema}}.generation_attempts (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES {{schema}}.generation_requests(id),
  attempt_no integer NOT NULL,
  retry_idempotency_key varchar(255),
  provider varchar(32) NOT NULL,
  provider_task_id varchar(255),
  model varchar(128) NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  quantity integer NOT NULL DEFAULT 1,
  status varchar(16) NOT NULL DEFAULT 'pending',
  phase varchar(32) NOT NULL DEFAULT 'created',
  provider_status varchar(64),
  provider_response jsonb,
  error_code varchar(128),
  error_message text,
  retryable boolean NOT NULL DEFAULT false,
  estimated_cost_fen integer NOT NULL,
  actual_cost_fen integer,
  actual_cost_status varchar(20) NOT NULL DEFAULT 'unavailable',
  pricing_rule_id uuid REFERENCES {{schema}}.pricing_rules(id),
  price_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_query_error text,
  next_poll_at timestamptz,
  last_polled_at timestamptz,
  lease_owner varchar(128),
  lease_until timestamptz,
  submitted_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_attempts_attempt_no_check CHECK (attempt_no > 0),
  CONSTRAINT generation_attempts_status_check CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT generation_attempts_phase_check CHECK (phase IN ('created', 'submitting', 'provider_queued', 'provider_running', 'provider_succeeded', 'persisting', 'complete')),
  CONSTRAINT generation_attempts_cost_check CHECK (estimated_cost_fen >= 0 AND (actual_cost_fen IS NULL OR actual_cost_fen >= 0)),
  CONSTRAINT generation_attempts_actual_status_check CHECK (actual_cost_status IN ('unavailable', 'estimated', 'confirmed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS generation_attempts_request_number_unique
  ON {{schema}}.generation_attempts (request_id, attempt_no);
CREATE UNIQUE INDEX IF NOT EXISTS generation_attempts_retry_idempotency_unique
  ON {{schema}}.generation_attempts (request_id, retry_idempotency_key)
  WHERE retry_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS generation_attempts_provider_task_unique
  ON {{schema}}.generation_attempts (provider, provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS generation_attempts_worker_idx
  ON {{schema}}.generation_attempts (status, next_poll_at, lease_until)
  WHERE status IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS {{schema}}.media_results (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES {{schema}}.generation_requests(id),
  attempt_id uuid NOT NULL REFERENCES {{schema}}.generation_attempts(id),
  shot_id uuid REFERENCES {{schema}}.shots(id),
  media_kind varchar(16) NOT NULL,
  result_index integer NOT NULL,
  provider_result_key varchar(512) NOT NULL,
  provider_url text,
  provider_url_expires_at timestamptz,
  persistence_status varchar(32) NOT NULL DEFAULT 'pending_persistence',
  storage_bucket varchar(128),
  storage_path varchar(1024),
  storage_url text,
  sha256 varchar(64),
  mime_type varchar(128),
  width_px integer,
  height_px integer,
  duration_seconds integer,
  review_status varchar(20) NOT NULL DEFAULT 'needs_review',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  CONSTRAINT media_results_kind_check CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT media_results_index_check CHECK (result_index >= 0),
  CONSTRAINT media_results_persistence_check CHECK (persistence_status IN ('pending_persistence', 'persisted', 'persistence_failed')),
  CONSTRAINT media_results_review_check CHECK (review_status IN ('needs_review', 'accepted', 'rejected')),
  CONSTRAINT media_results_persisted_has_tos CHECK (
    persistence_status <> 'persisted'
    OR (storage_bucket IS NOT NULL AND storage_path IS NOT NULL AND storage_url IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS media_results_remote_result_unique
  ON {{schema}}.media_results (attempt_id, provider_result_key);
CREATE INDEX IF NOT EXISTS media_results_shot_created_idx
  ON {{schema}}.media_results (shot_id, created_at DESC) WHERE deleted_at IS NULL;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.shots
    ADD CONSTRAINT shots_selected_image_result_fk FOREIGN KEY (selected_image_result_id) REFERENCES {{schema}}.media_results(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;
DO $migration$
BEGIN
  ALTER TABLE {{schema}}.shots
    ADD CONSTRAINT shots_selected_video_result_fk FOREIGN KEY (selected_video_result_id) REFERENCES {{schema}}.media_results(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

CREATE TABLE IF NOT EXISTS {{schema}}.agent_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  project_id uuid REFERENCES {{schema}}.projects(id),
  shot_id uuid REFERENCES {{schema}}.shots(id),
  title varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_sessions_user_updated_idx
  ON {{schema}}.agent_sessions (user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.agent_messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES {{schema}}.agent_sessions(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL,
  content text NOT NULL,
  tool_name varchar(64),
  tool_arguments jsonb,
  tool_result_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_messages_role_check CHECK (role IN ('user', 'assistant', 'tool'))
);
CREATE INDEX IF NOT EXISTS agent_messages_session_created_idx
  ON {{schema}}.agent_messages (session_id, created_at, id);

CREATE TABLE IF NOT EXISTS {{schema}}.project_director_storyboard_prompts (
  id uuid PRIMARY KEY,
  project_id uuid,
  project_name varchar(255),
  episode_no integer,
  shot_no integer,
  scene_name varchar(255),
  director_prompt_text text,
  shot_description text,
  camera_movement varchar(255),
  lighting varchar(255),
  sound_instruction text,
  sound_effect varchar(255),
  user_id varchar(255),
  user_name varchar(255),
  result_media_id uuid,
  status varchar(64) NOT NULL DEFAULT 'active',
  reference_file_url varchar(1024),
  storyboard_file_url varchar(1024),
  metadata jsonb,
  created_at timestamp,
  updated_at timestamp
);
