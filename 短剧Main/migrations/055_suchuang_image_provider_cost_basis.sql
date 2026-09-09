-- Migration 054: seed supplier-cost observation rules for the temporary
-- company image gateway used by issue #157.
--
-- 2026-08-06 product decision:
--   gpt-image-2 and nanobanana-2: CNY 0.10/image
--   nanobanana-lite:              CNY 0.08/image
--
-- These entries record supplier cost only. They do not enable a provider,
-- install credentials, authorize a paid request, or bypass the company
-- provider allowlist.

INSERT INTO {{schema}}.config_entries (
  id, kind, entry_key, status, sort, payload, source, created_at, updated_at
) VALUES
  (
    '84000000-0000-4000-8000-000000000010',
    'provider_cost_basis',
    'suchuang-gpt-image-2-per-image',
    'published',
    100,
    '{"provider":"suchuang","model":"gpt-image-2-suchuang","media_kind":"image","parameter_match":{},"billing_unit":"image","usage_keys":["generated_images"],"unit_price_cny_micros":100000,"unit_size":1,"currency":"CNY","fallback":{"kind":"request_quantity"},"source_url":"https://api.wuyinkeji.com/doc/53"}'::jsonb,
    'seed:issue-157:suchuang-image-cost-basis',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000011',
    'provider_cost_basis',
    'suchuang-nanobanana-lite-per-image',
    'published',
    110,
    '{"provider":"suchuang","model":"nanobanana-lite","media_kind":"image","parameter_match":{},"billing_unit":"image","usage_keys":["generated_images"],"unit_price_cny_micros":80000,"unit_size":1,"currency":"CNY","fallback":{"kind":"request_quantity"},"source_url":"https://api.wuyinkeji.com/doc/74"}'::jsonb,
    'seed:issue-157:suchuang-image-cost-basis',
    now(),
    now()
  ),
  (
    '84000000-0000-4000-8000-000000000012',
    'provider_cost_basis',
    'suchuang-nanobanana-2-per-image',
    'published',
    120,
    '{"provider":"suchuang","model":"nanobanana-2","media_kind":"image","parameter_match":{},"billing_unit":"image","usage_keys":["generated_images"],"unit_price_cny_micros":100000,"unit_size":1,"currency":"CNY","fallback":{"kind":"request_quantity"},"source_url":"https://api.wuyinkeji.com/doc/65"}'::jsonb,
    'seed:issue-157:suchuang-image-cost-basis',
    now(),
    now()
  )
ON CONFLICT (kind, entry_key) DO NOTHING;
