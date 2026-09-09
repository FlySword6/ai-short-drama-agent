-- #157 forward repair for 056:
-- 1. align value_sources.params with the versioned seed truth;
-- 2. reject NULL/missing metadata and undocumented extra parameters exactly.

UPDATE {{schema}}.pricing_rules current
SET
  metadata = jsonb_set(
    current.metadata,
    '{value_sources,params}',
    to_jsonb(
      CASE
        WHEN current.model = 'gpt-image-2-suchuang'
          THEN (current.metadata->'capability_tier'->'params'->>'aspect_ratio')
            || ' / 单张；供应商字段 size 表示画幅'
        ELSE (current.metadata->'capability_tier'->'params'->>'resolution')
          || ' / '
          || (current.metadata->'capability_tier'->'params'->>'aspect_ratio')
          || ' / 单张'
      END
      || '；参数值域逐模型按供应商文档独立登记，不与其他模型合并'
    ),
    false
  ),
  updated_at = now()
WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
  AND current.provider = 'suchuang';

DO $$
DECLARE
  issue157_count integer;
BEGIN
  SELECT count(*)
  INTO issue157_count
  FROM {{schema}}.pricing_rules current
  WHERE current.source = 'seed:issue-157:suchuang-image-gateway';

  IF issue157_count <> 70 THEN
    RAISE EXCEPTION '#157 expected exactly 70 documented image tiers, got %', issue157_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM {{schema}}.pricing_rules current
    WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
      AND (
        current.provider IS DISTINCT FROM 'suchuang'
        OR current.media_kind IS DISTINCT FROM 'image'
        OR current.billing_unit IS DISTINCT FROM 'image'
        OR current.currency IS DISTINCT FROM 'CNY'
        OR current.active IS NOT TRUE
        OR current.effective_to IS NOT NULL
        OR current.metadata->>'price_source_kind' IS DISTINCT FROM '内部定价'
        OR current.metadata->'capability_tier'->>'status' IS DISTINCT FROM 'active'
        OR current.metadata->'capability_tier'->>'provider_label'
          IS DISTINCT FROM '公司图片网关'
        OR current.metadata->'capability_tier'->'capabilities'
          IS DISTINCT FROM '["text_to_image","image_reference","platform_aigc_metadata"]'::jsonb
        OR current.metadata->'capability_tier'->>'display_name'
          IS DISTINCT FROM (
            CASE
              WHEN current.model = 'gpt-image-2-suchuang'
                THEN (current.metadata->'capability_tier'->'params'->>'aspect_ratio')
              ELSE (current.metadata->'capability_tier'->'params'->>'resolution')
                || '、'
                || (current.metadata->'capability_tier'->'params'->>'aspect_ratio')
            END
            || '，按 1 张计价；这不是模型能力上限'
          )
        OR current.metadata->'capability_tier'->>'tier_id'
          IS DISTINCT FROM (
            'img-suchuang-'
            || replace(replace(current.model, '-suchuang', ''), '-', '')
            || '-'
            || replace(
              current.metadata->'capability_tier'->'params'->>'aspect_ratio',
              ':',
              'x'
            )
            || CASE
              WHEN current.model = 'gpt-image-2-suchuang' THEN ''
              ELSE '-'
                || lower(current.metadata->'capability_tier'->'params'->>'resolution')
            END
            || '-1'
          )
        OR current.metadata->'value_sources'->>'params'
          IS DISTINCT FROM (
            CASE
              WHEN current.model = 'gpt-image-2-suchuang'
                THEN (current.metadata->'capability_tier'->'params'->>'aspect_ratio')
                  || ' / 单张；供应商字段 size 表示画幅'
              ELSE (current.metadata->'capability_tier'->'params'->>'resolution')
                || ' / '
                || (current.metadata->'capability_tier'->'params'->>'aspect_ratio')
                || ' / 单张'
            END
            || '；参数值域逐模型按供应商文档独立登记，不与其他模型合并'
          )
        OR current.metadata->'value_sources'->>'tier_id'
          IS DISTINCT FROM (
            '#157 公司图片网关计费档 '
            || (current.metadata->'capability_tier'->>'tier_id')
          )
      )
  ) THEN
    RAISE EXCEPTION '#157 image pricing tier common metadata drift detected';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM {{schema}}.pricing_rules current
    WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
      AND current.model = 'gpt-image-2-suchuang'
      AND (
        current.unit_price_fen IS DISTINCT FROM 10
        OR current.metadata->'capability_tier'->>'model_label'
          IS DISTINCT FROM 'GPT Image 2'
        OR current.metadata->'capability_tier'->>'official_price_source'
          IS DISTINCT FROM 'https://api.wuyinkeji.com/doc/53'
        OR current.metadata->'capability_tier'->'params'
          IS DISTINCT FROM jsonb_build_object(
            'aspect_ratio',
            current.metadata->'capability_tier'->'params'->>'aspect_ratio',
            'quantity',
            1
          )
        OR NOT (
          current.metadata->'capability_tier'->'params'->>'aspect_ratio'
          = ANY(ARRAY[
            'auto', '1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4',
            '21:9', '9:21', '1:3', '3:1', '2:1', '1:2'
          ]::text[])
        )
      )
  ) THEN
    RAISE EXCEPTION '#157 GPT Image 2 pricing tier drift detected';
  END IF;

  IF (
    SELECT count(*)
    FROM {{schema}}.pricing_rules current
    WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
      AND current.model = 'gpt-image-2-suchuang'
  ) <> 14 THEN
    RAISE EXCEPTION '#157 GPT Image 2 expected 14 tiers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM {{schema}}.pricing_rules current
    WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
      AND current.model = 'nanobanana-lite'
      AND (
        current.unit_price_fen IS DISTINCT FROM 8
        OR current.metadata->'capability_tier'->>'model_label'
          IS DISTINCT FROM 'NanoBanana Lite'
        OR current.metadata->'capability_tier'->>'official_price_source'
          IS DISTINCT FROM 'https://api.wuyinkeji.com/doc/74'
        OR current.metadata->'capability_tier'->'params'
          IS DISTINCT FROM jsonb_build_object(
            'aspect_ratio',
            current.metadata->'capability_tier'->'params'->>'aspect_ratio',
            'quantity',
            1,
            'resolution',
            '1K'
          )
        OR NOT (
          current.metadata->'capability_tier'->'params'->>'aspect_ratio'
          = ANY(ARRAY[
            'auto', '1:1', '16:9', '9:16', '4:3', '3:4',
            '3:2', '2:3', '5:4', '4:5', '21:9'
          ]::text[])
        )
      )
  ) THEN
    RAISE EXCEPTION '#157 NanoBanana Lite pricing tier drift detected';
  END IF;

  IF (
    SELECT count(*)
    FROM {{schema}}.pricing_rules current
    WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
      AND current.model = 'nanobanana-lite'
  ) <> 11 THEN
    RAISE EXCEPTION '#157 NanoBanana Lite expected 11 tiers';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM {{schema}}.pricing_rules current
    WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
      AND current.model = 'nanobanana-2'
      AND (
        current.unit_price_fen IS DISTINCT FROM 10
        OR current.metadata->'capability_tier'->>'model_label'
          IS DISTINCT FROM 'NanoBanana 2'
        OR current.metadata->'capability_tier'->>'official_price_source'
          IS DISTINCT FROM 'https://api.wuyinkeji.com/doc/65'
        OR current.metadata->'capability_tier'->'params'
          IS DISTINCT FROM jsonb_build_object(
            'aspect_ratio',
            current.metadata->'capability_tier'->'params'->>'aspect_ratio',
            'quantity',
            1,
            'resolution',
            current.metadata->'capability_tier'->'params'->>'resolution'
          )
        OR NOT (
          current.metadata->'capability_tier'->'params'->>'aspect_ratio'
          = ANY(ARRAY[
            'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3',
            '5:4', '4:5', '21:9', '1:4', '1:8', '4:1', '8:1'
          ]::text[])
        )
        OR NOT (
          current.metadata->'capability_tier'->'params'->>'resolution'
          = ANY(ARRAY['1K', '2K', '4K']::text[])
        )
      )
  ) THEN
    RAISE EXCEPTION '#157 NanoBanana 2 pricing tier drift detected';
  END IF;

  IF (
    SELECT count(*)
    FROM {{schema}}.pricing_rules current
    WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
      AND current.model = 'nanobanana-2'
  ) <> 45 THEN
    RAISE EXCEPTION '#157 NanoBanana 2 expected 45 tiers';
  END IF;

  IF EXISTS (
    SELECT current.metadata->'capability_tier'->>'tier_id'
    FROM {{schema}}.pricing_rules current
    WHERE current.source = 'seed:issue-157:suchuang-image-gateway'
    GROUP BY current.metadata->'capability_tier'->>'tier_id'
    HAVING current.metadata->'capability_tier'->>'tier_id' IS NULL
      OR count(*) <> 1
  ) THEN
    RAISE EXCEPTION '#157 duplicate or missing image pricing tier id detected';
  END IF;
END
$$;
