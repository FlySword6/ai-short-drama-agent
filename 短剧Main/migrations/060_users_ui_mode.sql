-- Lite 界面模式：users.ui_mode（红线 R2：服务端唯一事实源）+ projects.lite_episode_id（Lite 容器集指针）。
--
-- ui_mode 默认值必须是 'full'：上线那一刻不能把正在用完整版的人踢进简版。
-- 业务账号名单不写进本迁移，由管理员建号时指定 ui_mode 或迁移后单独 UPDATE。
-- projects.lite_episode_id 非空即「Lite 项目」的唯一判定，与集名解耦（集名可被完整版用户改）。
-- 指向 episodes.id，不做 ON DELETE 动作：集被软删（deleted_at）后指针仍可回溯。
--
-- Rollback: 先停应用写方，再 ALTER TABLE {{schema}}.users DROP COLUMN ui_mode、
-- ALTER TABLE {{schema}}.projects DROP COLUMN lite_episode_id。无自动 down migration。

ALTER TABLE {{schema}}.users
  ADD COLUMN ui_mode varchar(8) NOT NULL DEFAULT 'full';
ALTER TABLE {{schema}}.users
  ADD CONSTRAINT users_ui_mode_check CHECK (ui_mode IN ('lite', 'full'));

ALTER TABLE {{schema}}.projects
  ADD COLUMN lite_episode_id uuid REFERENCES {{schema}}.episodes (id);
