-- 068：v1.9 十.6「成功才扣」——generation_quotes 增加 voided 终态，并放宽
-- consistency 约束允许 confirmed 报价先绑定 attempt（提交时绑定、成功时消费）。
-- 触发器 generation_quotes_debit_account_credit 不改：仍只在 → consumed 时扣费；
-- voided 不触发任何扣费。

ALTER TABLE {{schema}}.generation_quotes
  DROP CONSTRAINT IF EXISTS generation_quotes_status_check;

ALTER TABLE {{schema}}.generation_quotes
  ADD CONSTRAINT generation_quotes_status_check CHECK (
    status IN ('pending_confirmation', 'confirmed', 'consumed', 'voided')
  );

ALTER TABLE {{schema}}.generation_quotes
  DROP CONSTRAINT IF EXISTS generation_quotes_status_consistency;

ALTER TABLE {{schema}}.generation_quotes
  ADD CONSTRAINT generation_quotes_status_consistency CHECK (
    (
      status = 'pending_confirmation'
      AND confirmed_at IS NULL
      AND consumed_at IS NULL
      AND generation_request_id IS NULL
      AND generation_attempt_id IS NULL
    ) OR (
      -- 已确认未绑定（完整版三步流程等待提交）
      (
        status = 'confirmed'
        AND confirmed_at IS NOT NULL
        AND consumed_at IS NULL
        AND generation_request_id IS NULL
        AND generation_attempt_id IS NULL
      )
      OR
      -- 已确认且绑定到 attempt（v1.9 十.6：提交绑定、成功才消费）
      (
        status = 'confirmed'
        AND confirmed_at IS NOT NULL
        AND consumed_at IS NULL
        AND generation_request_id IS NOT NULL
        AND generation_attempt_id IS NOT NULL
      )
    ) OR (
      status = 'consumed'
      AND confirmed_at IS NOT NULL
      AND consumed_at IS NOT NULL
      AND generation_request_id IS NOT NULL
      AND generation_attempt_id IS NOT NULL
    ) OR (
      -- 作废：attempt 终态失败（绑定必带 confirmed_at，见 bindQuote/autoConfirm）
      status = 'voided'
      AND confirmed_at IS NOT NULL
      AND consumed_at IS NULL
      AND generation_attempt_id IS NOT NULL
    )
  );

-- 037 的 accounting_actor_check 对 UPDATE 行生效且不含 voided;同步扩展,
-- 允许 voided 行(绑定必同 actor;pending 直接作废时 confirmed_by 为 NULL)。
-- 条件化:037 晚于本迁移回放时(测试 rehearsal)列尚不存在,跳过;037 自己会建不含
-- voided 的版本,而该回放不跑 void 路径。
DO $v19_actor_check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = trim(both '"' from '{{schema}}')
      AND table_name = 'generation_quotes'
      AND column_name = 'confirmed_by_user_id'
  ) THEN
    ALTER TABLE {{schema}}.generation_quotes
      DROP CONSTRAINT IF EXISTS generation_quotes_accounting_actor_check;
    ALTER TABLE {{schema}}.generation_quotes
      ADD CONSTRAINT generation_quotes_accounting_actor_check
      CHECK (
        (status = 'pending_confirmation' AND confirmed_by_user_id IS NULL)
        OR (
          status IN ('confirmed', 'consumed')
          AND confirmed_by_user_id IS NOT NULL
          AND confirmed_by_user_id = user_id
        )
        OR (
          status = 'voided'
          AND (confirmed_by_user_id IS NULL OR confirmed_by_user_id = user_id)
        )
      ) NOT VALID;
  END IF;
END
$v19_actor_check$;
