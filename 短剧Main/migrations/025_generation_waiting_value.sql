-- S29 等待期用户价值：队列位置/时长估计的事实来自 generation_attempts；
-- 本表只记录一次终态尝试需要被站内提醒，避免把通知类型冻结为枚举。
--
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不自动执行迁移。
-- 幂等：CREATE TABLE/INDEX IF NOT EXISTS；写入侧以 attempt_id 唯一键去重。
-- 回滚口径：旧代码不读取本表；确需回滚时，先停止 S29 通知读取与写入，再由 DBA
-- 手工 DROP TABLE {{schema}}.generation_attempt_notifications。不会影响生成请求、尝试或媒体结果。

CREATE TABLE IF NOT EXISTS {{schema}}.generation_attempt_notifications (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES {{schema}}.generation_attempts(id) ON DELETE CASCADE,
  generation_request_id uuid NOT NULL REFERENCES {{schema}}.generation_requests(id),
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id),
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT generation_attempt_notifications_attempt_unique UNIQUE (attempt_id)
);

-- 站内提醒只读取当前用户尚未确认的终态尝试；同一 created_at 时由 id 保持稳定顺序。
CREATE INDEX IF NOT EXISTS generation_attempt_notifications_unread_user_created_idx
  ON {{schema}}.generation_attempt_notifications (user_id, created_at DESC, id DESC)
  WHERE acknowledged_at IS NULL;
