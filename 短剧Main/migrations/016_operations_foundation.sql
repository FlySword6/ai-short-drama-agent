-- V0.2.0 operations foundation.
--
-- This is a forward-only, schema-scoped migration.  The migration runner
-- passes the Day-0 ADMIN_USERNAMES bootstrap list into the current transaction
-- as `shortdrama.admin_usernames`; no username value belongs in this file.

-- ---------------------------------------------------------------------------
-- Platform role and management dimensions
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS {{schema}}.users
  ADD COLUMN IF NOT EXISTS role varchar(16);

UPDATE {{schema}}.users
SET role = CASE
  WHEN lower(username) = ANY(
    string_to_array(COALESCE(current_setting('shortdrama.admin_usernames', true), ''), ',')
  ) THEN 'admin'
  ELSE 'member'
END
WHERE role IS NULL;

ALTER TABLE {{schema}}.users
  ALTER COLUMN role SET DEFAULT 'member';
ALTER TABLE {{schema}}.users
  ALTER COLUMN role SET NOT NULL;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.users
    ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'operator', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

CREATE TABLE IF NOT EXISTS {{schema}}.teams (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  parent_team_id uuid REFERENCES {{schema}}.teams(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_parent_not_self_check CHECK (parent_team_id IS NULL OR parent_team_id <> id)
);

CREATE UNIQUE INDEX IF NOT EXISTS teams_name_unique
  ON {{schema}}.teams (lower(name));
CREATE INDEX IF NOT EXISTS teams_parent_name_idx
  ON {{schema}}.teams (parent_team_id, lower(name));

-- A team may have one parent, but that parent must be a root team.  This keeps
-- the organization deliberately at one parent/child level and rejects both a
-- grandchild and the only remaining cycle shape.
CREATE OR REPLACE FUNCTION {{schema}}.assert_team_one_level()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
DECLARE
  parent_parent_id uuid;
BEGIN
  IF NEW.parent_team_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_team_id = NEW.id THEN
    RAISE EXCEPTION '团队不能把自己设为上级' USING ERRCODE = '23514';
  END IF;

  SELECT parent_team_id INTO parent_parent_id
  FROM {{schema}}.teams
  WHERE id = NEW.parent_team_id;

  IF parent_parent_id IS NOT NULL THEN
    RAISE EXCEPTION '团队最多支持一层父子关系' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$migration$;

DROP TRIGGER IF EXISTS teams_assert_one_level ON {{schema}}.teams;
CREATE TRIGGER teams_assert_one_level
BEFORE INSERT OR UPDATE OF parent_team_id ON {{schema}}.teams
FOR EACH ROW EXECUTE FUNCTION {{schema}}.assert_team_one_level();

CREATE TABLE IF NOT EXISTS {{schema}}.team_members (
  team_id uuid NOT NULL REFERENCES {{schema}}.teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS team_members_user_team_idx
  ON {{schema}}.team_members (user_id, team_id);

CREATE TABLE IF NOT EXISTS {{schema}}.user_groups (
  id uuid PRIMARY KEY,
  name varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_groups_name_unique
  ON {{schema}}.user_groups (lower(name));

CREATE TABLE IF NOT EXISTS {{schema}}.user_group_members (
  user_group_id uuid NOT NULL REFERENCES {{schema}}.user_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_group_id, user_id)
);

CREATE INDEX IF NOT EXISTS user_group_members_user_group_idx
  ON {{schema}}.user_group_members (user_id, user_group_id);

-- The reserved team gives legacy projects an explicit cost owner without
-- making the physical column non-null before all creators are on the new form.
-- The application still requires a deliberate team choice for new projects.
INSERT INTO {{schema}}.teams (id, name, parent_team_id, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000016'::uuid, '未分配', NULL, now(), now())
ON CONFLICT DO NOTHING;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM {{schema}}.teams WHERE lower(name) = lower('未分配')
  ) THEN
    RAISE EXCEPTION '运营底座迁移未找到“未分配”团队，无法安全回填项目归属';
  END IF;
END $migration$;

ALTER TABLE IF EXISTS {{schema}}.projects
  ADD COLUMN IF NOT EXISTS team_id uuid;
ALTER TABLE IF EXISTS {{schema}}.projects
  ADD COLUMN IF NOT EXISTS genre varchar(32);

UPDATE {{schema}}.projects
SET team_id = (
  SELECT id FROM {{schema}}.teams WHERE lower(name) = lower('未分配') LIMIT 1
)
WHERE team_id IS NULL;

ALTER TABLE {{schema}}.projects
  ALTER COLUMN team_id DROP DEFAULT;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.projects
    ADD CONSTRAINT projects_team_fk
    FOREIGN KEY (team_id) REFERENCES {{schema}}.teams(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

CREATE INDEX IF NOT EXISTS projects_team_updated_idx
  ON {{schema}}.projects (team_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS projects_genre_updated_idx
  ON {{schema}}.projects (genre, updated_at DESC)
  WHERE deleted_at IS NULL AND genre IS NOT NULL;

-- Legacy create-project callers do not yet send a team.  Keep them usable by
-- assigning the global unassigned team at write time rather than relying on a
-- brittle hard-coded UUID default.
CREATE OR REPLACE FUNCTION {{schema}}.assign_unassigned_team_to_project()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
DECLARE
  unassigned_team_id uuid;
BEGIN
  IF NEW.team_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT id INTO unassigned_team_id
  FROM {{schema}}.teams
  WHERE lower(name) = lower('未分配')
  LIMIT 1;
  IF unassigned_team_id IS NULL THEN
    RAISE EXCEPTION '未配置“未分配”团队，不能创建项目';
  END IF;
  NEW.team_id := unassigned_team_id;
  RETURN NEW;
END;
$migration$;

DROP TRIGGER IF EXISTS projects_assign_unassigned_team ON {{schema}}.projects;
CREATE TRIGGER projects_assign_unassigned_team
BEFORE INSERT ON {{schema}}.projects
FOR EACH ROW EXECUTE FUNCTION {{schema}}.assign_unassigned_team_to_project();

-- ---------------------------------------------------------------------------
-- Project membership.  `projects.owner_user_id` remains the compatibility
-- index; this table is the authoritative membership record.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{schema}}.project_members (
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL,
  added_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT project_members_role_check CHECK (role IN ('owner', 'editor', 'viewer'))
);

-- Every historical project owner remains visible after the membership cutover.
INSERT INTO {{schema}}.project_members (project_id, user_id, role, added_by_user_id, created_at)
SELECT p.id, p.owner_user_id, 'owner', p.owner_user_id, now()
FROM {{schema}}.projects p
ON CONFLICT (project_id, user_id) DO NOTHING;

-- Historical creators are collaborators, not silently locked out when the
-- visibility rule changes.  The owner row above wins for the same person.
INSERT INTO {{schema}}.project_members (project_id, user_id, role, added_by_user_id, created_at)
SELECT DISTINCT r.project_id, r.user_id, 'editor', p.owner_user_id, now()
FROM {{schema}}.generation_requests r
INNER JOIN {{schema}}.projects p ON p.id = r.project_id
WHERE r.user_id <> p.owner_user_id
ON CONFLICT (project_id, user_id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS project_members_one_owner_per_project
  ON {{schema}}.project_members (project_id)
  WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS project_members_user_project_idx
  ON {{schema}}.project_members (user_id, project_id);
CREATE INDEX IF NOT EXISTS project_members_project_role_idx
  ON {{schema}}.project_members (project_id, role, user_id);

-- Legacy project creation and direct owner changes must keep producing an
-- owner membership row.  Membership CRUD remains responsible for rejecting a
-- transfer that would leave the project without an owner.
CREATE OR REPLACE FUNCTION {{schema}}.sync_project_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id THEN
    RETURN NEW;
  END IF;

  UPDATE {{schema}}.project_members
  SET role = 'editor'
  WHERE project_id = NEW.id
    AND role = 'owner'
    AND user_id <> NEW.owner_user_id;

  INSERT INTO {{schema}}.project_members (project_id, user_id, role, added_by_user_id, created_at)
  VALUES (NEW.id, NEW.owner_user_id, 'owner', NEW.owner_user_id, now())
  ON CONFLICT (project_id, user_id) DO UPDATE
    SET role = EXCLUDED.role,
        added_by_user_id = EXCLUDED.added_by_user_id;

  RETURN NEW;
END;
$migration$;

DROP TRIGGER IF EXISTS projects_sync_owner_membership ON {{schema}}.projects;
CREATE TRIGGER projects_sync_owner_membership
AFTER INSERT OR UPDATE OF owner_user_id ON {{schema}}.projects
FOR EACH ROW EXECUTE FUNCTION {{schema}}.sync_project_owner_membership();

-- The partial unique index above prevents two owners.  This deferred
-- constraint completes the invariant by preventing a membership mutation from
-- committing a project with no owner or an owner different from the retained
-- compatibility column.  Deferral allows an ownership transfer to demote and
-- promote within one transaction.
CREATE OR REPLACE FUNCTION {{schema}}.assert_project_has_synchronized_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
DECLARE
  target_project_id uuid;
  expected_owner_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_project_id := OLD.project_id;
  ELSE
    target_project_id := NEW.project_id;
  END IF;
  SELECT owner_user_id INTO expected_owner_user_id
  FROM {{schema}}.projects
  WHERE id = target_project_id;

  -- The project may already be gone because project_members cascades on a
  -- project delete; there is nothing left to validate in that case.
  IF expected_owner_user_id IS NULL THEN RETURN NULL; END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM {{schema}}.project_members member
    WHERE member.project_id = target_project_id
      AND member.user_id = expected_owner_user_id
      AND member.role = 'owner'
  ) THEN
    RAISE EXCEPTION '项目必须保留且仅保留与负责人一致的一位 owner'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$migration$;

DROP TRIGGER IF EXISTS project_members_require_synchronized_owner ON {{schema}}.project_members;
CREATE CONSTRAINT TRIGGER project_members_require_synchronized_owner
AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.project_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION {{schema}}.assert_project_has_synchronized_owner();

-- ---------------------------------------------------------------------------
-- Cost ledger projection.  A request stores the sum of every *consumed* quote,
-- including retries.  The trigger keeps the column true for future writes so
-- callers do not have to reconstruct a second accounting truth in application
-- code.
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS {{schema}}.generation_requests
  ADD COLUMN IF NOT EXISTS charged_points integer;

UPDATE {{schema}}.generation_requests request
SET charged_points = COALESCE((
  SELECT SUM(quote.estimated_cost_fen)::integer
  FROM {{schema}}.generation_quotes quote
  WHERE quote.generation_request_id = request.id
    AND quote.status = 'consumed'
), 0);

ALTER TABLE {{schema}}.generation_requests
  ALTER COLUMN charged_points SET DEFAULT 0;
ALTER TABLE {{schema}}.generation_requests
  ALTER COLUMN charged_points SET NOT NULL;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.generation_requests
    ADD CONSTRAINT generation_requests_charged_points_nonnegative_check
    CHECK (charged_points >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

CREATE OR REPLACE FUNCTION {{schema}}.refresh_generation_request_charged_points()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
DECLARE
  target_request_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_request_id := NEW.generation_request_id;
  ELSIF TG_OP = 'DELETE' THEN
    target_request_id := OLD.generation_request_id;
  ELSE
    target_request_id := NEW.generation_request_id;
    IF OLD.generation_request_id IS DISTINCT FROM NEW.generation_request_id AND OLD.generation_request_id IS NOT NULL THEN
      UPDATE {{schema}}.generation_requests old_request
      SET charged_points = COALESCE((
        SELECT SUM(old_quote.estimated_cost_fen)::integer
        FROM {{schema}}.generation_quotes old_quote
        WHERE old_quote.generation_request_id = old_request.id
          AND old_quote.status = 'consumed'
      ), 0)
      WHERE old_request.id = OLD.generation_request_id;
    END IF;
  END IF;

  IF target_request_id IS NOT NULL THEN
    UPDATE {{schema}}.generation_requests request
    SET charged_points = COALESCE((
      SELECT SUM(quote.estimated_cost_fen)::integer
      FROM {{schema}}.generation_quotes quote
      WHERE quote.generation_request_id = request.id
        AND quote.status = 'consumed'
    ), 0)
    WHERE request.id = target_request_id;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$migration$;

DROP TRIGGER IF EXISTS generation_quotes_refresh_charged_points ON {{schema}}.generation_quotes;
CREATE TRIGGER generation_quotes_refresh_charged_points
AFTER INSERT OR UPDATE OR DELETE ON {{schema}}.generation_quotes
FOR EACH ROW EXECUTE FUNCTION {{schema}}.refresh_generation_request_charged_points();

-- cost_fen intentionally remains nullable.  `is_unpriced` lets every cost
-- aggregate report those records separately while treating their numeric value
-- as zero.  No token-to-points conversion is invented here.
CREATE OR REPLACE VIEW {{schema}}.cost_entries AS
SELECT
  request.id AS entry_id,
  'generation'::varchar(32) AS kind,
  request.user_id,
  request.project_id,
  project.team_id,
  COALESCE(latest_attempt.model, request.parameters ->> 'model_key', request.parameters ->> 'model', request.media_kind) AS model,
  request.charged_points,
  request.created_at,
  'generation_requests'::varchar(64) AS source_table,
  request.id AS source_id,
  false AS is_unpriced
FROM {{schema}}.generation_requests request
INNER JOIN {{schema}}.projects project ON project.id = request.project_id
LEFT JOIN LATERAL (
  SELECT attempt.model
  FROM {{schema}}.generation_attempts attempt
  WHERE attempt.request_id = request.id
  ORDER BY attempt.attempt_no DESC
  LIMIT 1
) latest_attempt ON true

UNION ALL

SELECT
  ai_call.id AS entry_id,
  'ai_call'::varchar(32) AS kind,
  ai_call.caller_user_id AS user_id,
  ai_call.project_id,
  project.team_id,
  ai_call.model,
  COALESCE(ai_call.cost_fen, 0) AS charged_points,
  ai_call.created_at,
  'ai_calls'::varchar(64) AS source_table,
  ai_call.id AS source_id,
  ai_call.cost_fen IS NULL AS is_unpriced
FROM {{schema}}.ai_calls ai_call
LEFT JOIN {{schema}}.projects project ON project.id = ai_call.project_id;

-- ---------------------------------------------------------------------------
-- Review assignment and asset clearance.  Enforcement of clearance remains a
-- later publishing-chain concern; this migration only establishes the fact.
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS {{schema}}.project_review_policies
  ADD COLUMN IF NOT EXISTS reviewer_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS project_review_policies_reviewer_idx
  ON {{schema}}.project_review_policies (reviewer_user_id, project_id)
  WHERE reviewer_user_id IS NOT NULL;

ALTER TABLE IF EXISTS {{schema}}.asset_review_actions
  ADD COLUMN IF NOT EXISTS assigned_reviewer_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS asset_review_actions_assigned_reviewer_idx
  ON {{schema}}.asset_review_actions (assigned_reviewer_user_id, created_at DESC, id DESC)
  WHERE assigned_reviewer_user_id IS NOT NULL;

ALTER TABLE IF EXISTS {{schema}}.asset_entities
  ADD COLUMN IF NOT EXISTS clearance jsonb;

UPDATE {{schema}}.asset_entities
SET clearance = '{"search": true, "gen_reference": true, "commercial_publish": false, "model_training": false}'::jsonb
WHERE clearance IS NULL;

ALTER TABLE {{schema}}.asset_entities
  ALTER COLUMN clearance SET DEFAULT '{"search": true, "gen_reference": true, "commercial_publish": false, "model_training": false}'::jsonb;
ALTER TABLE {{schema}}.asset_entities
  ALTER COLUMN clearance SET NOT NULL;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_clearance_object_check CHECK (jsonb_typeof(clearance) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

-- Cross-entity management actions are deliberately separate from the legacy
-- user-only audit table, whose target constraint is tied to user mutations.
CREATE TABLE IF NOT EXISTS {{schema}}.admin_operation_actions (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  actor_session_id uuid REFERENCES {{schema}}.sessions(id) ON DELETE SET NULL,
  action varchar(64) NOT NULL,
  target_type varchar(32) NOT NULL,
  target_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_operation_actions_action_format_check
    CHECK (action ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  CONSTRAINT admin_operation_actions_target_type_format_check
    CHECK (target_type ~ '^[a-z][a-z0-9_.:-]{0,31}$'),
  CONSTRAINT admin_operation_actions_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS admin_operation_actions_created_desc_idx
  ON {{schema}}.admin_operation_actions (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_operation_actions_actor_created_idx
  ON {{schema}}.admin_operation_actions (actor_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_operation_actions_target_created_idx
  ON {{schema}}.admin_operation_actions (target_type, target_id, created_at DESC, id DESC);
