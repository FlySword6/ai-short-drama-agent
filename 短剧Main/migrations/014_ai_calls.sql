-- V0.2 AI gateway audit ledger.
--
-- This table intentionally records only operational metadata. Prompt bodies,
-- model output bodies, and raw provider responses stay out of the audit ledger
-- so an AI call can be traced and metered without duplicating creator content.
-- Cost remains nullable until a provider-normalized actual cost is available;
-- this migration does not invent a points conversion.

CREATE TABLE IF NOT EXISTS {{schema}}.ai_calls (
  id uuid PRIMARY KEY,
  caller_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  project_id uuid REFERENCES {{schema}}.projects(id) ON DELETE SET NULL,
  related_object_type varchar(64),
  related_object_id varchar(128),
  purpose varchar(64) NOT NULL,
  provider varchar(64) NOT NULL,
  model varchar(128) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'running',
  input_tokens integer,
  output_tokens integer,
  duration_ms integer,
  cost_fen integer,
  error_code varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT ai_calls_purpose_format_check
    CHECK (purpose ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  CONSTRAINT ai_calls_provider_format_check
    CHECK (provider ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  CONSTRAINT ai_calls_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  CONSTRAINT ai_calls_related_object_pair_check
    CHECK ((related_object_type IS NULL) = (related_object_id IS NULL)),
  CONSTRAINT ai_calls_nonnegative_metrics_check
    CHECK (
      (input_tokens IS NULL OR input_tokens >= 0)
      AND (output_tokens IS NULL OR output_tokens >= 0)
      AND (duration_ms IS NULL OR duration_ms >= 0)
      AND (cost_fen IS NULL OR cost_fen >= 0)
    ),
  CONSTRAINT ai_calls_completion_state_check
    CHECK (
      (status = 'running' AND completed_at IS NULL AND duration_ms IS NULL AND error_code IS NULL)
      OR (status = 'succeeded' AND completed_at IS NOT NULL AND duration_ms IS NOT NULL AND error_code IS NULL)
      OR (status = 'failed' AND completed_at IS NOT NULL AND duration_ms IS NOT NULL AND error_code IS NOT NULL)
    )
);

-- This index supports the per-user, UTC-day gateway limit without scanning
-- unrelated users' history. The application supplies the UTC day bounds.
CREATE INDEX IF NOT EXISTS ai_calls_caller_created_desc_idx
  ON {{schema}}.ai_calls (caller_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS ai_calls_project_created_desc_idx
  ON {{schema}}.ai_calls (project_id, created_at DESC, id DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ai_calls_purpose_created_desc_idx
  ON {{schema}}.ai_calls (purpose, created_at DESC, id DESC);
