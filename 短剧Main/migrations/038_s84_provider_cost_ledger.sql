-- S84 provider-cost ledger.
--
-- This ledger is deliberately independent from generation quote consumption
-- and user-credit triggers. A provider-cost write may fail open in the
-- application without rolling back or changing the paid generation state.
--
-- Rollback: stop application writers first, export provider_costs and the
-- provider_cost_basis config entries, then DROP TABLE provider_costs. Remove
-- the seeded config rows only after confirming that no retained audit export
-- depends on their ids/checksums. No automatic down migration is provided.

CREATE TABLE IF NOT EXISTS {{schema}}.provider_costs (
  id uuid PRIMARY KEY,
  generation_request_id uuid NOT NULL
    REFERENCES {{schema}}.generation_requests(id) ON DELETE RESTRICT,
  generation_attempt_id uuid NOT NULL
    REFERENCES {{schema}}.generation_attempts(id) ON DELETE RESTRICT,
  project_id uuid NOT NULL
    REFERENCES {{schema}}.projects(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL
    REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  rate_config_entry_id uuid
    REFERENCES {{schema}}.config_entries(id) ON DELETE RESTRICT,
  provider varchar(32) NOT NULL,
  model varchar(128) NOT NULL,
  actual_model_id varchar(128) NOT NULL,
  media_kind varchar(16) NOT NULL,
  provider_result_status varchar(16) NOT NULL,
  calculation_status varchar(16) NOT NULL,
  usage_source varchar(24) NOT NULL,
  usage_unit varchar(32),
  usage_quantity bigint,
  billing_unit varchar(32),
  unit_price_cny_micros bigint,
  unit_size bigint,
  cost_cny_micros bigint,
  cost_fen_rounded integer,
  currency varchar(8) NOT NULL DEFAULT 'CNY',
  rate_config_updated_at timestamptz,
  rate_config_checksum varchar(64),
  calculation_version varchar(32) NOT NULL,
  requires_attention boolean NOT NULL,
  failure_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_costs_attempt_unique UNIQUE (generation_attempt_id),
  CONSTRAINT provider_costs_media_kind_check
    CHECK (media_kind IN ('image', 'video', 'audio')),
  CONSTRAINT provider_costs_result_status_check
    CHECK (provider_result_status IN ('pending', 'running', 'succeeded', 'failed')),
  CONSTRAINT provider_costs_calculation_status_check
    CHECK (calculation_status IN ('confirmed', 'estimated', 'unavailable')),
  CONSTRAINT provider_costs_usage_source_check
    CHECK (usage_source IN ('provider_reported', 'formula_fallback', 'unavailable')),
  CONSTRAINT provider_costs_currency_check CHECK (currency = 'CNY'),
  CONSTRAINT provider_costs_checksum_check
    CHECK (rate_config_checksum IS NULL OR rate_config_checksum ~ '^[a-f0-9]{64}$'),
  CONSTRAINT provider_costs_known_cost_shape_check CHECK (
    (
      calculation_status = 'unavailable'
      AND usage_source = 'unavailable'
      AND usage_unit IS NULL
      AND usage_quantity IS NULL
      AND billing_unit IS NULL
      AND unit_price_cny_micros IS NULL
      AND unit_size IS NULL
      AND cost_cny_micros IS NULL
      AND cost_fen_rounded IS NULL
      AND requires_attention
      AND failure_code IS NOT NULL
    )
    OR
    (
      calculation_status IN ('confirmed', 'estimated')
      AND usage_source = CASE
        WHEN calculation_status = 'confirmed' THEN 'provider_reported'
        ELSE 'formula_fallback'
      END
      AND usage_unit IS NOT NULL
      AND usage_quantity >= 0
      AND billing_unit IS NOT NULL
      AND unit_price_cny_micros > 0
      AND unit_size > 0
      AND cost_cny_micros >= 0
      AND cost_fen_rounded >= 0
      AND rate_config_entry_id IS NOT NULL
      AND rate_config_updated_at IS NOT NULL
      AND rate_config_checksum IS NOT NULL
      AND requires_attention = (calculation_status <> 'confirmed')
      AND failure_code IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS provider_costs_request_idx
  ON {{schema}}.provider_costs (generation_request_id);
CREATE INDEX IF NOT EXISTS provider_costs_project_created_idx
  ON {{schema}}.provider_costs (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS provider_costs_actor_created_idx
  ON {{schema}}.provider_costs (actor_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS provider_costs_actual_model_created_idx
  ON {{schema}}.provider_costs (actual_model_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS provider_costs_config_idx
  ON {{schema}}.provider_costs (rate_config_entry_id)
  WHERE rate_config_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS provider_costs_attention_created_idx
  ON {{schema}}.provider_costs (created_at DESC, id DESC)
  WHERE requires_attention;

-- Supplier rates are soft configuration, not source constants. The payload is
-- validated by the admin config API; every applied rate is copied into typed
-- provider_costs columns with the config id, updated_at and checksum so later
-- edits never rewrite historical cost.
INSERT INTO {{schema}}.config_entries (
  id, kind, entry_key, status, sort, payload, source, created_at, updated_at
) VALUES
  (
    '84000000-0000-4000-8000-000000000001',
    'provider_cost_basis',
    'ark-seedream-5-pro-1k',
    'published',
    10,
    '{"provider":"ark","model":"doubao-seedream-5-0-pro-260628","media_kind":"image","parameter_match":{"size":["1K"]},"billing_unit":"image","usage_keys":["generated_images"],"unit_price_cny_micros":300000,"unit_size":1,"currency":"CNY","fallback":{"kind":"request_quantity"},"source_url":"https://www.volcengine.com/docs/82379/1544106"}'::jsonb,
    'seed:s84:migration-038',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000002',
    'provider_cost_basis',
    'ark-seedream-5-pro-2k',
    'published',
    20,
    '{"provider":"ark","model":"doubao-seedream-5-0-pro-260628","media_kind":"image","parameter_match":{"size":["2K"]},"billing_unit":"image","usage_keys":["generated_images"],"unit_price_cny_micros":600000,"unit_size":1,"currency":"CNY","fallback":{"kind":"request_quantity"},"source_url":"https://www.volcengine.com/docs/82379/1544106"}'::jsonb,
    'seed:s84:migration-038',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000003',
    'provider_cost_basis',
    'ark-seedance-2-0-480p-720p',
    'published',
    30,
    '{"provider":"ark","model":"doubao-seedance-2-0-260128","media_kind":"video","parameter_match":{"resolution":["480p","720p"]},"billing_unit":"million_output_tokens","usage_keys":["completion_tokens","output_tokens","total_tokens"],"unit_price_cny_micros":46000000,"unit_size":1000000,"currency":"CNY","fallback":{"kind":"video_token_formula","frames_per_second":24,"token_divisor":1024,"pixel_count_by_resolution_ratio":{"480p":{"16:9":428544,"9:16":428544,"1:1":409600},"720p":{"16:9":921600,"9:16":921600,"1:1":921600} } },"source_url":"https://www.volcengine.com/docs/82379/1544106"}'::jsonb,
    'seed:s84:migration-038',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000004',
    'provider_cost_basis',
    'ark-seedance-2-0-1080p',
    'published',
    40,
    '{"provider":"ark","model":"doubao-seedance-2-0-260128","media_kind":"video","parameter_match":{"resolution":["1080p"]},"billing_unit":"million_output_tokens","usage_keys":["completion_tokens","output_tokens","total_tokens"],"unit_price_cny_micros":51000000,"unit_size":1000000,"currency":"CNY","fallback":{"kind":"video_token_formula","frames_per_second":24,"token_divisor":1024,"pixel_count_by_resolution_ratio":{"1080p":{"16:9":2073600,"9:16":2073600,"1:1":2073600} } },"source_url":"https://www.volcengine.com/docs/82379/1544106"}'::jsonb,
    'seed:s84:migration-038',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000005',
    'provider_cost_basis',
    'ark-seedance-2-0-4k',
    'published',
    50,
    '{"provider":"ark","model":"doubao-seedance-2-0-260128","media_kind":"video","parameter_match":{"resolution":["4k"]},"billing_unit":"million_output_tokens","usage_keys":["completion_tokens","output_tokens","total_tokens"],"unit_price_cny_micros":26000000,"unit_size":1000000,"currency":"CNY","fallback":{"kind":"video_token_formula","frames_per_second":24,"token_divisor":1024,"pixel_count_by_resolution_ratio":{"4k":{"16:9":8294400,"9:16":8294400,"1:1":8294400} } },"source_url":"https://www.volcengine.com/docs/82379/1544106"}'::jsonb,
    'seed:s84:migration-038',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000006',
    'provider_cost_basis',
    'ark-seedance-2-0-fast-480p-720p',
    'published',
    60,
    '{"provider":"ark","model":"doubao-seedance-2-0-fast-260128","media_kind":"video","parameter_match":{"resolution":["480p","720p"]},"billing_unit":"million_output_tokens","usage_keys":["completion_tokens","output_tokens","total_tokens"],"unit_price_cny_micros":37000000,"unit_size":1000000,"currency":"CNY","fallback":{"kind":"video_token_formula","frames_per_second":24,"token_divisor":1024,"pixel_count_by_resolution_ratio":{"480p":{"16:9":428544,"9:16":428544,"1:1":409600},"720p":{"16:9":921600,"9:16":921600,"1:1":921600} } },"source_url":"https://www.volcengine.com/docs/82379/1544106"}'::jsonb,
    'seed:s84:migration-038',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000007',
    'provider_cost_basis',
    'ark-seedance-2-0-mini-480p-720p',
    'published',
    70,
    '{"provider":"ark","model":"doubao-seedance-2-0-mini-260615","media_kind":"video","parameter_match":{"resolution":["480p","720p"]},"billing_unit":"million_output_tokens","usage_keys":["completion_tokens","output_tokens","total_tokens"],"unit_price_cny_micros":23000000,"unit_size":1000000,"currency":"CNY","fallback":{"kind":"video_token_formula","frames_per_second":24,"token_divisor":1024,"pixel_count_by_resolution_ratio":{"480p":{"16:9":428544,"9:16":428544,"1:1":409600},"720p":{"16:9":921600,"9:16":921600,"1:1":921600} } },"source_url":"https://www.volcengine.com/docs/82379/1544106"}'::jsonb,
    'seed:s84:migration-038',
    now(),
    now()
  )
ON CONFLICT (kind, entry_key) DO NOTHING;
