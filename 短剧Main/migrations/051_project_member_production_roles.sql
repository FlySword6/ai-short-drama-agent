-- #16: five fixed, multi-select production responsibilities per project member.
--
-- owner/editor/viewer remains the authorization source in project_members.
-- These rows describe who is acting as director, art, screenwriter,
-- coordinator, or reviewer; they never grant platform-admin or project access
-- by themselves.

CREATE TABLE IF NOT EXISTS {{schema}}.project_member_production_roles (
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role varchar(32) NOT NULL,
  assigned_by_user_id uuid NOT NULL
    REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id, role),
  CONSTRAINT project_member_production_roles_membership_fk
    FOREIGN KEY (project_id, user_id)
    REFERENCES {{schema}}.project_members(project_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT project_member_production_roles_role_check
    CHECK (role IN ('director', 'art', 'screenwriter', 'coordinator', 'reviewer'))
);

CREATE INDEX IF NOT EXISTS project_member_production_roles_project_role_idx
  ON {{schema}}.project_member_production_roles (project_id, role, user_id);

CREATE INDEX IF NOT EXISTS project_member_production_roles_user_project_idx
  ON {{schema}}.project_member_production_roles (user_id, project_id);
