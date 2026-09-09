-- S32 批量提交：一次人工确认授权一份冻结报价清单，仍逐项创建/消费普通报价。
--
-- 前向迁移：由 npm run db:migrate 显式执行；应用启动不自动迁移。
-- 原子性：一条 batch authorization 是一次人工授权事实；子项各自记录
-- created/expired/price_changed/budget_blocked 等结果。有效项继续入队，失败项
-- 不创建 generation_request，不消费报价，也不静默重新报价。
-- 回滚口径：旧代码不读取这两张表。确需回滚时，先停止 batch-submit 写入，
-- 再由 DBA 手工 DROP TABLE {{schema}}.generation_batch_authorization_items 和
-- {{schema}}.generation_batch_authorizations；已创建的 generation_requests、
-- generation_attempts 和 generation_quotes 仍是独立正式事实，绝不随之删除。

CREATE TABLE IF NOT EXISTS {{schema}}.generation_batch_authorizations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id),
  client_idempotency_key varchar(255) NOT NULL,
  list_hash varchar(64) NOT NULL,
  status varchar(24) NOT NULL,
  authorized_total_estimated_cost_fen integer NOT NULL,
  submitted_total_estimated_cost_fen integer NOT NULL,
  currency varchar(8) NOT NULL DEFAULT 'CNY',
  authorized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT generation_batch_authorizations_key_unique UNIQUE (user_id, client_idempotency_key),
  CONSTRAINT generation_batch_authorizations_hash_check CHECK (list_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT generation_batch_authorizations_status_check CHECK (status IN ('completed', 'partial', 'failed')),
  CONSTRAINT generation_batch_authorizations_total_check CHECK (
    authorized_total_estimated_cost_fen >= 0
    AND submitted_total_estimated_cost_fen >= 0
    AND submitted_total_estimated_cost_fen <= authorized_total_estimated_cost_fen
  ),
  CONSTRAINT generation_batch_authorizations_currency_check CHECK (currency = 'CNY')
);

CREATE INDEX IF NOT EXISTS generation_batch_authorizations_project_authorized_idx
  ON {{schema}}.generation_batch_authorizations (project_id, authorized_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.generation_batch_authorization_items (
  id uuid PRIMARY KEY,
  authorization_id uuid NOT NULL REFERENCES {{schema}}.generation_batch_authorizations(id) ON DELETE CASCADE,
  position integer NOT NULL,
  item_id varchar(128) NOT NULL,
  generation_quote_id uuid NOT NULL REFERENCES {{schema}}.generation_quotes(id),
  estimated_cost_fen integer NOT NULL,
  status varchar(32) NOT NULL,
  failure_code varchar(128),
  failure_message text,
  generation_request_id uuid REFERENCES {{schema}}.generation_requests(id),
  generation_attempt_id uuid REFERENCES {{schema}}.generation_attempts(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT generation_batch_authorization_items_position_unique UNIQUE (authorization_id, position),
  CONSTRAINT generation_batch_authorization_items_item_unique UNIQUE (authorization_id, item_id),
  CONSTRAINT generation_batch_authorization_items_quote_unique UNIQUE (authorization_id, generation_quote_id),
  CONSTRAINT generation_batch_authorization_items_position_check CHECK (position >= 0),
  CONSTRAINT generation_batch_authorization_items_cost_check CHECK (estimated_cost_fen >= 0),
  CONSTRAINT generation_batch_authorization_items_status_check CHECK (
    status IN ('created', 'expired', 'price_changed', 'budget_blocked', 'quote_unavailable', 'failed')
  ),
  CONSTRAINT generation_batch_authorization_items_created_shape_check CHECK (
    (status = 'created'
      AND generation_request_id IS NOT NULL
      AND generation_attempt_id IS NOT NULL
      AND failure_code IS NULL
      AND failure_message IS NULL)
    OR
    (status <> 'created'
      AND generation_request_id IS NULL
      AND generation_attempt_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS generation_batch_authorization_items_attempt_idx
  ON {{schema}}.generation_batch_authorization_items (generation_attempt_id)
  WHERE generation_attempt_id IS NOT NULL;
