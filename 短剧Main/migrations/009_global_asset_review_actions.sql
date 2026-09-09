-- 通用采购资产不属于任何项目，但仍共用审核动作事实表。
-- 保持 007 的校验和稳定，通过前向迁移放宽 project_id；项目内动作仍由服务端写入项目 ID。

ALTER TABLE IF EXISTS {{schema}}.asset_review_actions
  ALTER COLUMN project_id DROP NOT NULL;
