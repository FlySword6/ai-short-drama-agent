CREATE TABLE IF NOT EXISTS {{schema}}.generation_quotes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  source varchar(16) NOT NULL,
  action varchar(16) NOT NULL,
  assistant_session_id uuid REFERENCES {{schema}}.agent_sessions(id) ON DELETE SET NULL,
  original_request_id uuid REFERENCES {{schema}}.generation_requests(id),
  base_attempt_id uuid REFERENCES {{schema}}.generation_attempts(id),
  base_attempt_no integer,
  request_hash varchar(64) NOT NULL,
  normalized_request jsonb NOT NULL,
  pricing_rule_id uuid NOT NULL REFERENCES {{schema}}.pricing_rules(id),
  price_snapshot jsonb NOT NULL,
  estimated_cost_fen integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'pending_confirmation',
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  consumed_at timestamptz,
  generation_request_id uuid REFERENCES {{schema}}.generation_requests(id),
  generation_attempt_id uuid REFERENCES {{schema}}.generation_attempts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT generation_quotes_source_check CHECK (source IN ('web', 'assistant', 'cli')),
  CONSTRAINT generation_quotes_action_check CHECK (action IN ('submit', 'retry')),
  CONSTRAINT generation_quotes_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT generation_quotes_normalized_request_object CHECK (jsonb_typeof(normalized_request) = 'object'),
  CONSTRAINT generation_quotes_price_snapshot_object CHECK (jsonb_typeof(price_snapshot) = 'object'),
  CONSTRAINT generation_quotes_cost_check CHECK (estimated_cost_fen >= 0),
  CONSTRAINT generation_quotes_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT generation_quotes_assistant_session_check CHECK (
    assistant_session_id IS NULL OR source = 'assistant'
  ),
  CONSTRAINT generation_quotes_original_request_check CHECK (
    (
      action = 'submit'
      AND original_request_id IS NULL
      AND base_attempt_id IS NULL
      AND base_attempt_no IS NULL
    ) OR (
      action = 'retry'
      AND original_request_id IS NOT NULL
      AND base_attempt_id IS NOT NULL
      AND base_attempt_no > 0
    )
  ),
  CONSTRAINT generation_quotes_status_check CHECK (
    status IN ('pending_confirmation', 'confirmed', 'consumed')
  ),
  CONSTRAINT generation_quotes_status_consistency CHECK (
    (
      status = 'pending_confirmation'
      AND confirmed_at IS NULL
      AND consumed_at IS NULL
      AND generation_request_id IS NULL
      AND generation_attempt_id IS NULL
    ) OR (
      status = 'confirmed'
      AND confirmed_at IS NOT NULL
      AND consumed_at IS NULL
      AND generation_request_id IS NULL
      AND generation_attempt_id IS NULL
    ) OR (
      status = 'consumed'
      AND confirmed_at IS NOT NULL
      AND consumed_at IS NOT NULL
      AND generation_request_id IS NOT NULL
      AND generation_attempt_id IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS generation_quotes_user_created_idx
  ON {{schema}}.generation_quotes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS generation_quotes_expiry_idx
  ON {{schema}}.generation_quotes (status, expires_at)
  WHERE status IN ('pending_confirmation', 'confirmed');
CREATE INDEX IF NOT EXISTS generation_quotes_attempt_idx
  ON {{schema}}.generation_quotes (generation_attempt_id)
  WHERE generation_attempt_id IS NOT NULL;
