-- S40 商用授权形状约束：clearance 决定资产能否被检索、能否作生成参考、能否
-- 商用发布、能否训练模型。016 只约束了“是 jsonb 对象”，少字段、多字段、
-- 字符串 "false"、嵌套对象都能写入，合规判定会静默失真。本迁移收紧为：
--   1. 必须是 jsonb 对象（沿用 016 的底线，故替换原 object-only 约束）；
--   2. 只允许已知权利位（search / gen_reference / commercial_publish /
--      model_training），未知位一律拒绝——写入方与契约理解不一致时必须显式失败；
--   3. 已知位允许缺省（缺省 = 按列默认值的 fail-safe 语义生效），但一旦写出
--      必须是 JSON 布尔；显式 null 同样拒绝。
-- 权利位集合未来增长时，必须由新迁移同步扩展本约束；唯一真源是
-- src/db/schema.ts 的 assetClearanceKeys，本约束是它的 SQL 镜像。
--
-- 上线前置：先跑 npx tsx scripts/check-asset-clearance.mts（只读）。若存量存在
-- 不合法行，本迁移会在 ADD CONSTRAINT 时失败——这是有意的暴露，不是事故；
-- 处置存量数据需 DC 授权后另行进行，本迁移不替人修数据。
-- 回滚口径：DROP CONSTRAINT asset_entities_clearance_shape_check 并按 016 口径
-- 恢复 asset_entities_clearance_object_check 即可；本迁移不改任何数据行。

ALTER TABLE {{schema}}.asset_entities
  DROP CONSTRAINT IF EXISTS asset_entities_clearance_object_check;

ALTER TABLE {{schema}}.asset_entities
  ADD CONSTRAINT asset_entities_clearance_shape_check CHECK (
    jsonb_typeof(clearance) = 'object'
    -- 删掉全部已知位后必须为空对象：等价于“不存在未知位”，且可在 CHECK 里表达。
    AND clearance - 'search' - 'gen_reference' - 'commercial_publish' - 'model_training' = '{}'::jsonb
    AND (clearance -> 'search' IS NULL OR jsonb_typeof(clearance -> 'search') = 'boolean')
    AND (clearance -> 'gen_reference' IS NULL OR jsonb_typeof(clearance -> 'gen_reference') = 'boolean')
    AND (clearance -> 'commercial_publish' IS NULL OR jsonb_typeof(clearance -> 'commercial_publish') = 'boolean')
    AND (clearance -> 'model_training' IS NULL OR jsonb_typeof(clearance -> 'model_training') = 'boolean')
  );
