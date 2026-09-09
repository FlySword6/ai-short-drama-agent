-- V0.2.x 产物审核与交付门禁（合同 docs/contracts/v0.2.0/output-review-and-delivery-gate.md）。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不自动执行迁移。
-- 本迁移不改 media_results 既有列（review_status 三态约束自 001 已存在），
-- 只追加产物审核动作留痕表、交付记录表与待审队列索引。
-- 恢复/回滚：旧代码不读取这两张新表，回退应用代码时可保留它们；
-- 如必须清理，先导出审核动作与交付历史，再由 DBA 手工 DROP TABLE。

-- 产物审核动作是审核解释的正式事实，平行于 007 的 asset_review_actions。
-- 状态机只有 needs_review -> accepted | rejected；终态不反向。
-- automatic 策略下落库即视同 accepted，但必须留 action='auto_accepted' 的显式记录：
-- reviewer_user_id 为空表示系统动作，不把“机器没有拦”冒充“人已确认”。
CREATE TABLE IF NOT EXISTS {{schema}}.media_review_actions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  media_result_id uuid NOT NULL REFERENCES {{schema}}.media_results(id),
  action varchar(24) NOT NULL,
  from_status varchar(20) NOT NULL,
  to_status varchar(20) NOT NULL,
  reviewer_user_id uuid REFERENCES {{schema}}.users(id),
  assigned_reviewer_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_review_actions_action_check
    CHECK (action IN ('accepted', 'rejected', 'auto_accepted')),
  CONSTRAINT media_review_actions_from_status_check
    CHECK (from_status IN ('needs_review', 'accepted', 'rejected')),
  CONSTRAINT media_review_actions_to_status_check
    CHECK (to_status IN ('needs_review', 'accepted', 'rejected')),
  CONSTRAINT media_review_actions_transition_check
    CHECK (from_status = 'needs_review' AND to_status IN ('accepted', 'rejected')),
  CONSTRAINT media_review_actions_reviewer_check
    CHECK (
      (action = 'auto_accepted' AND reviewer_user_id IS NULL)
      OR (action IN ('accepted', 'rejected') AND reviewer_user_id IS NOT NULL)
    ),
  CONSTRAINT media_review_actions_rejection_reason_check
    CHECK (
      (action = 'rejected' AND char_length(btrim(COALESCE(rejection_reason, ''))) > 0)
      OR (action <> 'rejected' AND rejection_reason IS NULL)
    )
);

-- 同一产物的自动通过记录至多一行，落库幂等重放不会产生重复审计。
CREATE UNIQUE INDEX IF NOT EXISTS media_review_actions_auto_once_idx
  ON {{schema}}.media_review_actions (media_result_id) WHERE action = 'auto_accepted';

CREATE INDEX IF NOT EXISTS media_review_actions_project_media_created_idx
  ON {{schema}}.media_review_actions (project_id, media_result_id, created_at DESC, id DESC);

-- 待审队列按项目分页扫描产物，部分索引只覆盖待审热点子集。
CREATE INDEX IF NOT EXISTS media_results_review_queue_idx
  ON {{schema}}.media_results (shot_id) WHERE review_status = 'needs_review' AND deleted_at IS NULL;

-- 交付记录：每次导出/交付落一行，回答“哪集交了、交的哪版、谁交的、何时”。
-- manifest_hash 是清单内容（不含时间戳等易变字段）的 SHA-256，可对同一集的两次交付；
-- media_result_ids / missing_shot_codes 是交付时刻的快照，事后不随主版本变更而改写。
CREATE TABLE IF NOT EXISTS {{schema}}.delivery_records (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  episode_id uuid NOT NULL REFERENCES {{schema}}.episodes(id) ON DELETE CASCADE,
  manifest_hash varchar(64) NOT NULL,
  media_result_ids jsonb NOT NULL,
  partial boolean NOT NULL DEFAULT false,
  missing_shot_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  purpose text,
  delivered_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_records_media_ids_check CHECK (jsonb_typeof(media_result_ids) = 'array'),
  CONSTRAINT delivery_records_missing_codes_check CHECK (jsonb_typeof(missing_shot_codes) = 'array')
);

CREATE INDEX IF NOT EXISTS delivery_records_project_episode_created_idx
  ON {{schema}}.delivery_records (project_id, episode_id, created_at DESC, id DESC);
