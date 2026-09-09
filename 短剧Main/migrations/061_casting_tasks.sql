-- 抽卡任务（casting-tasks，main#292「表与读」段）：一张「这镜/这场缺哪件参考、
-- 要什么样子、派给谁做」的工单事实表。领单/交单/验收的状态转换属于下一张卡，
-- 本迁移只落 open；reference_test_id / delivered_asset_media_id / rejection_reason
-- 三个字段同样由下一张卡的流程写入，本卡只保留列位。
--
-- lane 外键进 reference_lane_vocabulary 词表（迁移 020），应用层按 control-packages
-- 既有约定把未知/停用 lane 拒成 422，不依赖裸 23503。
-- 场级单只填 scene_id；镜级单再加 shot_id；两个都不填是纯补图单。
-- 不加「有镜必有场」的 CHECK：shots.scene_id 本来就可空，即镜头可以不属于任何场
-- （docs/agents/domain.md 已把这条记为数据事实），约束上去会让无场镜头永远开不出单。
-- 镜头属于哪个项目、指定了场时是否对得上，都由应用层校验。
-- assignee_user_id 为空 = 待认领；承接人是普通用户 ID，不引入任何新角色枚举。
-- 时间戳由应用写值（同 013/046 既有约定）。
--
-- Rollback: 先停应用写方，再 DROP TABLE {{schema}}.casting_tasks。无自动 down migration。

CREATE TABLE IF NOT EXISTS {{schema}}.casting_tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id),
  scene_id uuid REFERENCES {{schema}}.scenes(id),
  shot_id uuid REFERENCES {{schema}}.shots(id),
  lane varchar(24) NOT NULL REFERENCES {{schema}}.reference_lane_vocabulary(id),
  target_asset_entity_id uuid REFERENCES {{schema}}.asset_entities(id),
  target_asset_variant_id uuid REFERENCES {{schema}}.asset_variants(id),
  title text NOT NULL,
  brief text,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  assignee_user_id uuid REFERENCES {{schema}}.users(id),
  status varchar(16) NOT NULL DEFAULT 'open',
  reference_test_id uuid REFERENCES {{schema}}.reference_tests(id),
  delivered_asset_media_id uuid REFERENCES {{schema}}.asset_media(id),
  rejection_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT casting_tasks_status_check CHECK (status IN ('open'))
);

CREATE INDEX IF NOT EXISTS casting_tasks_project_status_idx
  ON {{schema}}.casting_tasks (project_id, status);
CREATE INDEX IF NOT EXISTS casting_tasks_assignee_idx
  ON {{schema}}.casting_tasks (assignee_user_id);
CREATE INDEX IF NOT EXISTS casting_tasks_shot_idx
  ON {{schema}}.casting_tasks (shot_id);
