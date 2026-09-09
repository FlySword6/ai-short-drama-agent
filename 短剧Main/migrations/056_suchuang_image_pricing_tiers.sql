-- #157: publish every documented parameter combination for the three
-- temporary company image-gateway models. All combinations have a supplier
-- price, so none needs an estimated-price or pending-activation placeholder.

CREATE TEMP TABLE issue157_suchuang_tiers ON COMMIT DROP AS
WITH
gpt AS (
  SELECT
    1 AS model_order,
    'gpt-image-2-suchuang'::text AS model,
    'GPT Image 2'::text AS model_label,
    ratio,
    NULL::text AS resolution,
    10 AS unit_price_fen,
    'https://api.wuyinkeji.com/doc/53'::text AS document_url,
    0::bigint AS size_order,
    ratio_order
  FROM unnest(ARRAY[
    'auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4',
    '21:9', '9:21', '1:3', '3:1', '2:1', '1:2'
  ]::text[]) WITH ORDINALITY AS ratios(ratio, ratio_order)
),
lite AS (
  SELECT
    2 AS model_order,
    'nanobanana-lite'::text AS model,
    'NanoBanana Lite'::text AS model_label,
    ratio,
    '1K'::text AS resolution,
    8 AS unit_price_fen,
    'https://api.wuyinkeji.com/doc/74'::text AS document_url,
    1::bigint AS size_order,
    ratio_order
  FROM unnest(ARRAY[
    'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
    '5:4', '4:5', '21:9'
  ]::text[]) WITH ORDINALITY AS ratios(ratio, ratio_order)
),
nano2 AS (
  SELECT
    3 AS model_order,
    'nanobanana-2'::text AS model,
    'NanoBanana 2'::text AS model_label,
    ratio,
    resolution,
    10 AS unit_price_fen,
    'https://api.wuyinkeji.com/doc/65'::text AS document_url,
    size_order,
    ratio_order
  FROM unnest(ARRAY['1K', '2K', '4K']::text[])
    WITH ORDINALITY AS sizes(resolution, size_order)
  CROSS JOIN unnest(ARRAY[
    'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
    '5:4', '4:5', '21:9', '1:4', '1:8', '4:1', '8:1'
  ]::text[]) WITH ORDINALITY AS ratios(ratio, ratio_order)
),
numbered AS (
  SELECT
    row_number() OVER (ORDER BY model_order, size_order, ratio_order) AS ordinal,
    model,
    model_label,
    ratio,
    resolution,
    unit_price_fen,
    document_url
  FROM (
    SELECT * FROM gpt
    UNION ALL
    SELECT * FROM lite
    UNION ALL
    SELECT * FROM nano2
  ) definitions
)
SELECT
  ('00000000-5601-4000-8000-' || lpad(ordinal::text, 12, '0'))::uuid AS id,
  model,
  model_label,
  ratio,
  resolution,
  unit_price_fen,
  document_url,
  'img-suchuang-'
    || replace(replace(model, '-suchuang', ''), '-', '')
    || '-'
    || replace(ratio, ':', 'x')
    || CASE WHEN resolution IS NULL THEN '' ELSE '-' || lower(resolution) END
    || '-1' AS tier_id,
  CASE
    WHEN resolution IS NULL
      THEN ratio || '，按 1 张计价；这不是模型能力上限'
    ELSE resolution || '、' || ratio || '，按 1 张计价；这不是模型能力上限'
  END AS display_name
FROM numbered;

INSERT INTO {{schema}}.pricing_rules (
  id,
  provider,
  model,
  media_kind,
  billing_unit,
  unit_price_fen,
  currency,
  source,
  active,
  effective_from,
  effective_to,
  metadata,
  created_at,
  updated_at
)
SELECT
  expected.id,
  'suchuang',
  expected.model,
  'image',
  'image',
  expected.unit_price_fen,
  'CNY',
  'seed:issue-157:suchuang-image-gateway',
  true,
  '2026-08-07T00:00:00+08:00'::timestamptz,
  NULL,
  jsonb_build_object(
    'capability_tier',
    jsonb_build_object(
      'tier_id', expected.tier_id,
      'params',
      jsonb_build_object(
        'aspect_ratio', expected.ratio,
        'quantity', 1
      ) || CASE
        WHEN expected.resolution IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('resolution', expected.resolution)
      END,
      'status', 'active',
      'display_name', expected.display_name,
      'provider_label', '公司图片网关',
      'model_label', expected.model_label,
      'capabilities', jsonb_build_array(
        'text_to_image',
        'image_reference',
        'platform_aigc_metadata'
      ),
      'official_price_source', expected.document_url
    ),
    'value_sources',
    jsonb_build_object(
      'model', expected.model_label || ' 临时公司通道模型；' || expected.document_url,
      'unit_price_fen',
        expected.unit_price_fen || ' 积分/张（1 积分=1 分钱，'
        || to_char(expected.unit_price_fen::numeric / 100, 'FM0.00')
        || ' 元/张）；2026-08-06 产品负责人确认核账口径；'
        || expected.document_url,
      'params',
        coalesce(expected.resolution || ' / ', '')
        || expected.ratio
        || ' / 单张；参数值域逐模型按供应商文档独立登记，不与其他模型合并',
      'tier_id', '#157 公司图片网关计费档 ' || expected.tier_id
    ),
    'price_source_kind', '内部定价'
  ),
  now(),
  now()
FROM issue157_suchuang_tiers expected
WHERE NOT EXISTS (
  SELECT 1
  FROM {{schema}}.pricing_rules current
  WHERE current.metadata->'capability_tier'->>'tier_id' = expected.tier_id
);

-- Existing rows may have been installed by the controlled seed before this
-- migration. Update only the user-facing sentence; prices and parameters stay
-- immutable and are validated below.
UPDATE {{schema}}.pricing_rules current
SET
  metadata = jsonb_set(
    current.metadata,
    '{capability_tier,display_name}',
    to_jsonb(expected.display_name),
    false
  ),
  updated_at = now()
FROM issue157_suchuang_tiers expected
WHERE current.metadata->'capability_tier'->>'tier_id' = expected.tier_id
  AND current.provider = 'suchuang'
  AND current.model = expected.model
  AND current.media_kind = 'image'
  AND current.billing_unit = 'image'
  AND current.unit_price_fen = expected.unit_price_fen;

DO $$
BEGIN
  IF (SELECT count(*) FROM issue157_suchuang_tiers) <> 70 THEN
    RAISE EXCEPTION '#157 expected exactly 70 documented image tiers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM issue157_suchuang_tiers expected
    LEFT JOIN {{schema}}.pricing_rules current
      ON current.metadata->'capability_tier'->>'tier_id' = expected.tier_id
    WHERE current.id IS NULL
      OR current.provider <> 'suchuang'
      OR current.model <> expected.model
      OR current.media_kind <> 'image'
      OR current.billing_unit <> 'image'
      OR current.unit_price_fen <> expected.unit_price_fen
      OR current.currency <> 'CNY'
      OR current.active IS NOT TRUE
      OR current.metadata->'capability_tier'->>'status' <> 'active'
      OR current.metadata->'capability_tier'->>'display_name' <> expected.display_name
      OR NOT (
        current.metadata->'capability_tier'->'params'
        @> (
          jsonb_build_object(
            'aspect_ratio', expected.ratio,
            'quantity', 1
          ) || CASE
            WHEN expected.resolution IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('resolution', expected.resolution)
          END
        )
      )
  ) THEN
    RAISE EXCEPTION '#157 image pricing tier drift detected';
  END IF;

  IF EXISTS (
    SELECT current.metadata->'capability_tier'->>'tier_id'
    FROM {{schema}}.pricing_rules current
    JOIN issue157_suchuang_tiers expected
      ON current.metadata->'capability_tier'->>'tier_id' = expected.tier_id
    GROUP BY current.metadata->'capability_tier'->>'tier_id'
    HAVING count(*) <> 1
  ) THEN
    RAISE EXCEPTION '#157 duplicate image pricing tier detected';
  END IF;
END
$$;
