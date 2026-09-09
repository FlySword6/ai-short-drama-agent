-- Issue #312: vNext confirmed generation tasks and stable provider attempts.
-- A task is created once when a pending intent is confirmed; it is never mutated.
-- An attempt is appended per execution; crashed submits leave unknown_outcome.
-- Automatic paid retries are prohibited: human re-confirmation creates a new attempt.

CREATE TABLE IF NOT EXISTS vnext.generation_tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  intent_id uuid NOT NULL REFERENCES vnext.pending_generation_intents(id) ON DELETE RESTRICT,
  client_idempotency_key varchar(128) NOT NULL,
  control_package_id uuid NOT NULL REFERENCES vnext.control_package_versions(id) ON DELETE RESTRICT,
  control_package_version integer NOT NULL,
  reference_snapshot jsonb NOT NULL,
  -- Provider / model that accepted this task.
  provider varchar(64) NOT NULL DEFAULT 'seedance_2_5',
  model varchar(255) NOT NULL,
  -- Frozen finalPrompt + parameters from the control package at confirm time.
  prompt text NOT NULL,
  no_bgm boolean NOT NULL DEFAULT true,
  parameters jsonb NOT NULL,
  estimated_cost_fen bigint NOT NULL,
  -- Current terminal status; updated only when an attempt reaches a terminal state.
  status varchar(32) NOT NULL DEFAULT 'created',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, actor_id, client_idempotency_key),
  CONSTRAINT vnext_generation_tasks_provider CHECK (char_length(provider) > 0),
  CONSTRAINT vnext_generation_tasks_model CHECK (char_length(model) > 0),
  CONSTRAINT vnext_generation_tasks_prompt CHECK (char_length(prompt) > 0),
  CONSTRAINT vnext_generation_tasks_estimated_cost CHECK (estimated_cost_fen >= 0),
  CONSTRAINT vnext_generation_tasks_status CHECK (
    status IN ('created', 'running', 'succeeded', 'failed')
  ),
  CONSTRAINT vnext_generation_tasks_reference_snapshot CHECK (jsonb_typeof(reference_snapshot) = 'array'),
  CONSTRAINT vnext_generation_tasks_parameters CHECK (jsonb_typeof(parameters) = 'object')
);

CREATE INDEX IF NOT EXISTS vnext_generation_tasks_project_actor_created_idx
  ON vnext.generation_tasks(project_id, actor_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS vnext_generation_tasks_project_created_idx
  ON vnext.generation_tasks(project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS vnext.generation_attempts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES vnext.generation_tasks(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL,
  -- Lifecycle phase; each value is terminal or has a defined next step.
  status varchar(32) NOT NULL DEFAULT 'created',
  -- Provider task id returned on accepted submission; set on provider_queued.
  provider_task_id text,
  -- Last raw provider status string, for debugging.
  provider_raw_status text,
  -- Provider result snapshot (JSONB), set on provider_succeeded and onwards.
  provider_result jsonb,
  -- Media persisted to TOS, appended as each item is copied.
  tos_media jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Lease for distributed execution. Null = available for claiming.
  lease_owner text,
  lease_expires_at timestamptz,
  -- Error/failure tracking.
  error_code varchar(128),
  error_message text,
  actual_cost_fen bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_no),
  CONSTRAINT vnext_generation_attempts_attempt_no CHECK (attempt_no >= 1),
  CONSTRAINT vnext_generation_attempts_status CHECK (
    status IN (
      'created', 'submitting', 'provider_queued', 'provider_running',
      'provider_succeeded', 'copying_to_tos', 'succeeded', 'failed', 'unknown_outcome'
    )
  ),
  CONSTRAINT vnext_generation_attempts_tos_media CHECK (jsonb_typeof(tos_media) = 'array'),
  CONSTRAINT vnext_generation_attempts_cost CHECK (actual_cost_fen IS NULL OR actual_cost_fen >= 0)
);

CREATE INDEX IF NOT EXISTS vnext_generation_attempts_task_idx
  ON vnext.generation_attempts(task_id, attempt_no DESC);

CREATE INDEX IF NOT EXISTS vnext_generation_attempts_lease_idx
  ON vnext.generation_attempts(lease_owner, lease_expires_at)
  WHERE status NOT IN ('succeeded', 'failed', 'unknown_outcome');

CREATE INDEX IF NOT EXISTS vnext_generation_attempts_claimable_idx
  ON vnext.generation_attempts(status, lease_expires_at, updated_at ASC);

-- Automatic updated_at maintenance.
CREATE OR REPLACE FUNCTION vnext.set_generation_attempt_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER vnext_generation_attempts_updated_at
BEFORE UPDATE ON vnext.generation_attempts
FOR EACH ROW EXECUTE FUNCTION vnext.set_generation_attempt_updated_at();

-- Tasks never mutate their control fields; only status is updated.
CREATE OR REPLACE FUNCTION vnext.prevent_task_control_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.actor_id IS DISTINCT FROM NEW.actor_id
    OR OLD.intent_id IS DISTINCT FROM NEW.intent_id
    OR OLD.client_idempotency_key IS DISTINCT FROM NEW.client_idempotency_key
    OR OLD.control_package_id IS DISTINCT FROM NEW.control_package_id
    OR OLD.reference_snapshot IS DISTINCT FROM NEW.reference_snapshot
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.model IS DISTINCT FROM NEW.model
    OR OLD.prompt IS DISTINCT FROM NEW.prompt
    OR OLD.no_bgm IS DISTINCT FROM NEW.no_bgm
    OR OLD.parameters IS DISTINCT FROM NEW.parameters
    OR OLD.estimated_cost_fen IS DISTINCT FROM NEW.estimated_cost_fen
  ) THEN
    RAISE EXCEPTION 'generation task control fields are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER vnext_generation_tasks_control_immutable
BEFORE UPDATE ON vnext.generation_tasks
FOR EACH ROW EXECUTE FUNCTION vnext.prevent_task_control_mutation();

GRANT SELECT, INSERT, UPDATE ON vnext.generation_tasks TO vnext_app;
GRANT SELECT, INSERT, UPDATE ON vnext.generation_attempts TO vnext_app;
