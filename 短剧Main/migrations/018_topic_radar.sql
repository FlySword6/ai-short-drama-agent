-- V0.2.0 topic-radar local cache and upstream call ledger.
--
-- The provider endpoint is intentionally not encoded in the schema.  The
-- purchased 52api product must be selected by an operator through controlled
-- configuration before any outbound request is enabled.  `source` therefore
-- names the product domain, not a provider endpoint or an undocumented cell
-- identifier.
--
-- `cache_date` is calculated by the application in Asia/Shanghai.  It is the
-- guard key for paid upstream requests: normal reads get one claim per China
-- calendar day, while an administrator may make at most one separate manual
-- refresh claim on that same day.  A failed claim is retained rather than
-- silently retried, so a page refresh cannot spend another provider call.

CREATE TABLE IF NOT EXISTS {{schema}}.topic_radar_snapshots (
  id uuid PRIMARY KEY,
  source varchar(32) NOT NULL,
  cache_date date NOT NULL,
  rank_date date NOT NULL,
  fetched_at timestamptz NOT NULL,
  -- This is an internal provenance record.  Product responses must use the
  -- normalized topic_radar_items rows below and must never expose it directly.
  raw_payload jsonb NOT NULL,
  item_count integer NOT NULL,
  CONSTRAINT topic_radar_snapshots_source_check
    CHECK (source = '52api_hongguo_ranking'),
  CONSTRAINT topic_radar_snapshots_item_count_check
    CHECK (item_count >= 0),
  CONSTRAINT topic_radar_snapshots_raw_payload_check
    CHECK (jsonb_typeof(raw_payload) IN ('object', 'array'))
);

CREATE INDEX IF NOT EXISTS topic_radar_snapshots_source_fetched_idx
  ON {{schema}}.topic_radar_snapshots (source, fetched_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS topic_radar_snapshots_source_cache_idx
  ON {{schema}}.topic_radar_snapshots (source, cache_date DESC, fetched_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.topic_radar_items (
  id uuid PRIMARY KEY,
  snapshot_id uuid NOT NULL REFERENCES {{schema}}.topic_radar_snapshots(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  rank integer,
  title varchar(512) NOT NULL,
  heat varchar(128),
  link text,
  -- Retained for internal source traceability only.  It is never returned by
  -- the product API and must be supplied by a credential-redacting adapter.
  raw_item jsonb NOT NULL,
  CONSTRAINT topic_radar_items_ordinal_check
    CHECK (ordinal >= 0),
  CONSTRAINT topic_radar_items_rank_check
    CHECK (rank IS NULL OR rank >= 0),
  CONSTRAINT topic_radar_items_title_nonblank_check
    CHECK (char_length(btrim(title)) > 0),
  CONSTRAINT topic_radar_items_snapshot_ordinal_unique
    UNIQUE (snapshot_id, ordinal)
);

CREATE INDEX IF NOT EXISTS topic_radar_items_snapshot_ordinal_idx
  ON {{schema}}.topic_radar_items (snapshot_id, ordinal, id);

CREATE TABLE IF NOT EXISTS {{schema}}.topic_radar_upstream_calls (
  id uuid PRIMARY KEY,
  source varchar(32) NOT NULL,
  cache_date date NOT NULL,
  request_kind varchar(16) NOT NULL,
  status varchar(16) NOT NULL,
  requested_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  snapshot_id uuid REFERENCES {{schema}}.topic_radar_snapshots(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  error_code varchar(128),
  error_message varchar(512),
  CONSTRAINT topic_radar_upstream_calls_source_check
    CHECK (source = '52api_hongguo_ranking'),
  CONSTRAINT topic_radar_upstream_calls_request_kind_check
    CHECK (request_kind IN ('daily', 'manual')),
  CONSTRAINT topic_radar_upstream_calls_status_check
    CHECK (status IN ('fetching', 'succeeded', 'failed')),
  CONSTRAINT topic_radar_upstream_calls_error_nonblank_check
    CHECK (
      (error_code IS NULL OR char_length(btrim(error_code)) > 0)
      AND (error_message IS NULL OR char_length(btrim(error_message)) > 0)
    ),
  CONSTRAINT topic_radar_upstream_calls_state_shape_check
    CHECK (
      (status = 'fetching'
        AND completed_at IS NULL
        AND snapshot_id IS NULL
        AND error_code IS NULL
        AND error_message IS NULL)
      OR (status = 'succeeded'
        AND completed_at IS NOT NULL
        AND snapshot_id IS NOT NULL
        AND error_code IS NULL
        AND error_message IS NULL)
      OR (status = 'failed'
        AND completed_at IS NOT NULL
        AND snapshot_id IS NULL
        AND (error_code IS NOT NULL OR error_message IS NOT NULL))
    ),
  CONSTRAINT topic_radar_upstream_calls_completed_after_started_check
    CHECK (completed_at IS NULL OR completed_at >= started_at),
  -- The service must sanitize an upstream failure before writing it.  This
  -- defence-in-depth check rejects common credential-bearing fragments.
  CONSTRAINT topic_radar_upstream_calls_error_message_sanitized_check
    CHECK (
      error_message IS NULL
      OR error_message !~* '(https?://|authorization|x-api-key|secret|token|access[_ -]?key|credential)'
    )
);

-- The daily row is the ordinary read-through cache lock.  A row is created
-- before the provider request leaves the process, so concurrent browser reads
-- cannot each consume an upstream quota unit.
CREATE UNIQUE INDEX IF NOT EXISTS topic_radar_upstream_calls_daily_unique
  ON {{schema}}.topic_radar_upstream_calls (source, cache_date)
  WHERE request_kind = 'daily';

-- Manual refresh is deliberately a separate, administrator-only budget lane.
-- It allows one explicit corrective refresh without letting repeated clicks
-- expand the purchased provider-call budget.
CREATE UNIQUE INDEX IF NOT EXISTS topic_radar_upstream_calls_manual_unique
  ON {{schema}}.topic_radar_upstream_calls (source, cache_date)
  WHERE request_kind = 'manual';

CREATE INDEX IF NOT EXISTS topic_radar_upstream_calls_source_day_status_idx
  ON {{schema}}.topic_radar_upstream_calls (source, cache_date DESC, status, started_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS topic_radar_upstream_calls_requester_started_idx
  ON {{schema}}.topic_radar_upstream_calls (requested_by_user_id, started_at DESC, id DESC);
