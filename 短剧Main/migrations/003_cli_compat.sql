CREATE TABLE IF NOT EXISTS {{schema}}.cli_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  run_id varchar(128) NOT NULL,
  provider varchar(64) NOT NULL,
  status varchar(20) NOT NULL,
  generation_request_id uuid REFERENCES {{schema}}.generation_requests(id),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cli_runs_status_check CHECK (
    status IN ('mock', 'pending', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT cli_runs_manifest_object_check CHECK (jsonb_typeof(manifest) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS cli_runs_user_run_unique
  ON {{schema}}.cli_runs (user_id, run_id);
CREATE INDEX IF NOT EXISTS cli_runs_generation_request_idx
  ON {{schema}}.cli_runs (generation_request_id)
  WHERE generation_request_id IS NOT NULL;
