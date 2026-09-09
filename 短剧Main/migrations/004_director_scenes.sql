CREATE TABLE IF NOT EXISTS {{schema}}.director_scenes (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id),
  status varchar(20) NOT NULL DEFAULT 'draft',
  current_version integer NOT NULL DEFAULT 0,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by_user_id uuid REFERENCES {{schema}}.users(id),
  CONSTRAINT director_scenes_status_check CHECK (status IN ('draft', 'saved', 'archived')),
  CONSTRAINT director_scenes_version_check CHECK (current_version >= 0),
  CONSTRAINT director_scenes_archived_check CHECK (
    (status = 'archived') = (archived_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS director_scenes_project_active_unique
  ON {{schema}}.director_scenes (project_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.director_scene_versions (
  id uuid PRIMARY KEY,
  scene_id uuid NOT NULL REFERENCES {{schema}}.director_scenes(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  source_action varchar(64) NOT NULL DEFAULT 'manual_save',
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT director_scene_versions_version_check CHECK (version > 0),
  CONSTRAINT director_scene_versions_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS director_scene_versions_scene_version_unique
  ON {{schema}}.director_scene_versions (scene_id, version);

CREATE INDEX IF NOT EXISTS director_scene_versions_scene_created_idx
  ON {{schema}}.director_scene_versions (scene_id, version DESC);
