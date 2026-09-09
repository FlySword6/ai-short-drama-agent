-- 068 之后的 v1.9 十.10：生成请求记录发起变体，产物按变体归属。
-- 缺省 NULL = 历史行/未指定，读取侧回落第一变体（v1.3 过渡口径不变）。
ALTER TABLE {{schema}}.generation_requests
  ADD COLUMN IF NOT EXISTS target_asset_variant_id uuid
  REFERENCES {{schema}}.asset_variants(id);
