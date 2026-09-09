-- Issue #310: immutable storyboard cells, versions, and ordered board lineage.
CREATE TABLE IF NOT EXISTS vnext.storyboard_cells (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL REFERENCES vnext.script_confirmations(id) ON DELETE RESTRICT,
  shot_id uuid NOT NULL REFERENCES vnext.shot_plan_shots(id) ON DELETE RESTRICT,
  position integer NOT NULL,
  created_by_user_id uuid NOT NULL,
  client_idempotency_key varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (confirmation_id, position),
  UNIQUE (confirmation_id, shot_id),
  UNIQUE (confirmation_id, client_idempotency_key),
  CONSTRAINT vnext_storyboard_cells_position CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS vnext_storyboard_cells_project_created_idx
  ON vnext.storyboard_cells(project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS vnext.storyboard_cell_versions (
  id uuid PRIMARY KEY,
  cell_id uuid NOT NULL REFERENCES vnext.storyboard_cells(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  version integer NOT NULL,
  prompt text NOT NULL,
  source jsonb NOT NULL,
  media_url text NOT NULL,
  media_sha256 char(64) NOT NULL,
  provider varchar(64) NOT NULL,
  model varchar(128) NOT NULL,
  billing_receipt_id varchar(255) NOT NULL,
  created_by_user_id uuid NOT NULL,
  client_idempotency_key varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cell_id, version),
  UNIQUE (cell_id, client_idempotency_key),
  CONSTRAINT vnext_storyboard_cell_versions_version CHECK (version >= 1),
  CONSTRAINT vnext_storyboard_cell_versions_sha256 CHECK (media_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT vnext_storyboard_cell_versions_billing_receipt CHECK (length(billing_receipt_id) > 0)
);

CREATE INDEX IF NOT EXISTS vnext_storyboard_cell_versions_cell_created_idx
  ON vnext.storyboard_cell_versions(cell_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS vnext.storyboard_boards (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  confirmation_id uuid NOT NULL REFERENCES vnext.script_confirmations(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  source_kind varchar(16) NOT NULL,
  base_board_id uuid REFERENCES vnext.storyboard_boards(id) ON DELETE RESTRICT,
  redrawn_cell_id uuid REFERENCES vnext.storyboard_cells(id) ON DELETE RESTRICT,
  redrawn_cell_version_id uuid REFERENCES vnext.storyboard_cell_versions(id) ON DELETE RESTRICT,
  composition jsonb NOT NULL,
  created_by_user_id uuid NOT NULL,
  client_idempotency_key varchar(128) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version),
  UNIQUE (project_id, client_idempotency_key),
  CONSTRAINT vnext_storyboard_boards_version CHECK (version >= 1),
  CONSTRAINT vnext_storyboard_boards_source CHECK (source_kind IN ('shot_plan', 'redraw')),
  CONSTRAINT vnext_storyboard_boards_composition CHECK (jsonb_typeof(composition) = 'array'),
  CONSTRAINT vnext_storyboard_boards_lineage CHECK (
    (source_kind = 'shot_plan' AND base_board_id IS NULL AND redrawn_cell_id IS NULL AND redrawn_cell_version_id IS NULL)
    OR (source_kind = 'redraw' AND base_board_id IS NOT NULL AND redrawn_cell_id IS NOT NULL AND redrawn_cell_version_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS vnext_storyboard_boards_project_created_idx
  ON vnext.storyboard_boards(project_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION vnext.prevent_storyboard_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'storyboard records are append-only';
END;
$$;

CREATE TRIGGER vnext_storyboard_cells_immutable
BEFORE UPDATE OR DELETE ON vnext.storyboard_cells
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_storyboard_mutation();

CREATE TRIGGER vnext_storyboard_cell_versions_immutable
BEFORE UPDATE OR DELETE ON vnext.storyboard_cell_versions
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_storyboard_mutation();

CREATE TRIGGER vnext_storyboard_boards_immutable
BEFORE UPDATE OR DELETE ON vnext.storyboard_boards
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_storyboard_mutation();

GRANT SELECT, INSERT ON
  vnext.storyboard_cells,
  vnext.storyboard_cell_versions,
  vnext.storyboard_boards
TO vnext_app;
REVOKE UPDATE ON
  vnext.storyboard_cells,
  vnext.storyboard_cell_versions,
  vnext.storyboard_boards
FROM vnext_app;
