-- S42 上传提交队列:图片上传从「同步等待」改为「提交即返、后台串行执行」。
-- 任务行即事实:排队位置、近 20 次成功时长中位数估计、终态站内提醒(acknowledged_at)
-- 都从本表读出,与 S29 等待期能力同一口径,不另造第二套进度。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 幂等:CREATE TABLE/INDEX IF NOT EXISTS。
-- 回滚口径:旧代码不读写本表;确需回滚时,先停用到 /asset-upload-tasks 的写入与轮询,
-- 再由 DBA 手工 DROP TABLE {{schema}}.asset_upload_tasks。不会影响资产本体与媒体行。

CREATE TABLE IF NOT EXISTS {{schema}}.asset_upload_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  -- queued / processing / succeeded / failed;状态机由 worker 单侧写入,CHECK 挡住写错的词
  status varchar(16) NOT NULL,
  original_file_name varchar(255) NOT NULL,
  content_type varchar(128),
  asset_kind_hint varchar(32),
  -- 上传体暂存于应用本地磁盘;进程重启后文件丢失的任务以 failed 诚实收尾
  staged_path text NOT NULL,
  staged_bytes integer NOT NULL,
  result_asset_entity_id uuid REFERENCES {{schema}}.asset_entities(id),
  result_asset_name varchar(255),
  error_message text,
  duration_seconds integer,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT asset_upload_tasks_status_check
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed'))
);

-- worker 认领与用户侧「排队第 N 位」共用同一谓词:status='queued' 按 created_at,id 稳定序。
CREATE INDEX IF NOT EXISTS asset_upload_tasks_queued_created_idx
  ON {{schema}}.asset_upload_tasks (created_at, id)
  WHERE status = 'queued';

-- 站内提醒只读当前用户未确认的终态任务。
CREATE INDEX IF NOT EXISTS asset_upload_tasks_unread_user_created_idx
  ON {{schema}}.asset_upload_tasks (user_id, created_at DESC, id DESC)
  WHERE acknowledged_at IS NULL;
