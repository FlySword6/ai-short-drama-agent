-- S-goal-09 P1:在既有上传队列上保存登记表单、幂等事实和两段结果。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 幂等:ADD COLUMN/CREATE INDEX 均带 IF NOT EXISTS。
-- 回滚口径:旧代码忽略新增可空列;若必须物理回滚,先停用登记表单写入和 worker,
-- 再由 DBA 删除本迁移新增索引、约束和列。资产本体、媒体与远端登记事实不得级联删除。

ALTER TABLE {{schema}}.asset_upload_tasks
  ADD COLUMN IF NOT EXISTS client_idempotency_key uuid,
  ADD COLUMN IF NOT EXISTS content_sha256 varchar(64),
  ADD COLUMN IF NOT EXISTS request_sha256 varchar(64),
  ADD COLUMN IF NOT EXISTS registration_form jsonb,
  ADD COLUMN IF NOT EXISTS result_asset_media_id uuid REFERENCES {{schema}}.asset_media(id),
  ADD COLUMN IF NOT EXISTS result_registration_id uuid REFERENCES {{schema}}.seedance_asset_registrations(id),
  ADD COLUMN IF NOT EXISTS result_registration_status varchar(24),
  ADD COLUMN IF NOT EXISTS registration_error_code varchar(64),
  ADD COLUMN IF NOT EXISTS registration_error_message text,
  ADD COLUMN IF NOT EXISTS error_code varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS asset_upload_tasks_user_idempotency_unique
  ON {{schema}}.asset_upload_tasks (user_id, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asset_upload_tasks_content_sha256_check'
      AND conrelid = '{{schema}}.asset_upload_tasks'::regclass
  ) THEN
    ALTER TABLE {{schema}}.asset_upload_tasks
      ADD CONSTRAINT asset_upload_tasks_content_sha256_check
      CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asset_upload_tasks_request_sha256_check'
      AND conrelid = '{{schema}}.asset_upload_tasks'::regclass
  ) THEN
    ALTER TABLE {{schema}}.asset_upload_tasks
      ADD CONSTRAINT asset_upload_tasks_request_sha256_check
      CHECK (request_sha256 IS NULL OR request_sha256 ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asset_upload_tasks_registration_status_check'
      AND conrelid = '{{schema}}.asset_upload_tasks'::regclass
  ) THEN
    ALTER TABLE {{schema}}.asset_upload_tasks
      ADD CONSTRAINT asset_upload_tasks_registration_status_check
      CHECK (
        result_registration_status IS NULL
        OR result_registration_status IN (
          'pending', 'submitting', 'processing', 'active',
          'unavailable', 'failed', 'unknown'
        )
      );
  END IF;
END
$migration$;
