-- Migration 039: seed supplier-cost observation rules for Seed Audio.
-- At the 2026-07-30 integration baseline, 038 is the latest applied source
-- migration and 039 is the next available number. This migration does not
-- create user pricing rules or change credit authorization.
--
-- Official pricing: Doubao Audio Generation Model 1.0 is CNY 1/minute and is
-- billed by original_duration with millisecond precision.
-- https://www.volcengine.com/docs/6561/1359370

INSERT INTO {{schema}}.config_entries (
  id, kind, entry_key, status, sort, payload, source, created_at, updated_at
) VALUES
  (
    '84000000-0000-4000-8000-000000000008',
    'provider_cost_basis',
    'openspeech-seed-audio-1-0-original-duration',
    'published',
    80,
    '{"provider":"openspeech","model":"seed-audio-1.0","media_kind":"audio","parameter_match":{"format":["mp3","wav","pcm"]},"billing_unit":"millisecond","usage_keys":["original_duration_ms"],"unit_price_cny_micros":1000000,"unit_size":60000,"currency":"CNY","fallback":{"kind":"requested_duration_ms"},"source_url":"https://www.volcengine.com/docs/6561/1359370"}'::jsonb,
    'seed:s-goal-02:seed-audio-cost-basis',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000009',
    'provider_cost_basis',
    'openspeech-seed-audio-1-0-multilingual-original-duration',
    'published',
    90,
    '{"provider":"openspeech","model":"seed-audio-1.0-multilingual","media_kind":"audio","parameter_match":{"format":["mp3","wav","pcm"]},"billing_unit":"millisecond","usage_keys":["original_duration_ms"],"unit_price_cny_micros":1000000,"unit_size":60000,"currency":"CNY","fallback":{"kind":"requested_duration_ms"},"source_url":"https://www.volcengine.com/docs/6561/1359370"}'::jsonb,
    'seed:s-goal-02:seed-audio-cost-basis',
    now(),
    now()
  )
ON CONFLICT (kind, entry_key) DO NOTHING;
