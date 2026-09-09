-- S67 migration 037: the project grants a caller permission to operate a generation request,
-- but it never transfers the financial actor.  A quote, its confirmation, the
-- bound generation request, the debit account and the ledger actor must name
-- the same person.
--
-- Historical confirmed/consumed rows have no trustworthy confirmer to backfill.
-- Keep them readable and make this constraint NOT VALID; PostgreSQL still
-- enforces it for every subsequently inserted or updated row.

ALTER TABLE {{schema}}.generation_quotes
  ADD COLUMN IF NOT EXISTS confirmed_by_user_id uuid
  REFERENCES {{schema}}.users(id) ON DELETE RESTRICT;

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
  ) NOT VALID;

CREATE OR REPLACE FUNCTION {{schema}}.debit_credit_for_consumed_generation_quote()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
DECLARE
  billing_actor_user_id uuid;
  attempt_request_id uuid;
  account_balance integer;
  account_daily_limit integer;
  used_today integer;
  charge_points integer;
  quota_date date;
  resulting_balance integer;
BEGIN
  IF NEW.status <> 'consumed' OR OLD.status = 'consumed' THEN
    RETURN NEW;
  END IF;
  IF NEW.generation_request_id IS NULL THEN
    RAISE EXCEPTION 'account_credit_invalid_generation_quote'
      USING ERRCODE = 'P0001';
  END IF;

  -- The generation request is the financial source of truth.  Do not use a
  -- project membership predicate or a quote owner as a substitute: those are
  -- authorization facts, not the actor who initiated and pays for this task.
  SELECT request.user_id
  INTO billing_actor_user_id
  FROM {{schema}}.generation_requests request
  WHERE request.id = NEW.generation_request_id
  FOR KEY SHARE;
  IF billing_actor_user_id IS NULL
     OR NEW.user_id IS DISTINCT FROM billing_actor_user_id
     OR NEW.confirmed_by_user_id IS DISTINCT FROM billing_actor_user_id THEN
    RAISE EXCEPTION 'account_credit_actor_mismatch'
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.generation_attempt_id IS NULL THEN
    RAISE EXCEPTION 'account_credit_invalid_generation_quote'
      USING ERRCODE = 'P0001';
  END IF;

  -- Serialize all quote consumptions that claim the same attempt before
  -- checking prior consumption. Without this row lock, two concurrent UPDATEs
  -- can both observe no committed sibling quote under MVCC and debit twice.
  SELECT attempt.request_id
  INTO attempt_request_id
  FROM {{schema}}.generation_attempts attempt
  WHERE attempt.id = NEW.generation_attempt_id
  FOR UPDATE;
  IF attempt_request_id IS NULL OR attempt_request_id IS DISTINCT FROM NEW.generation_request_id THEN
    RAISE EXCEPTION 'account_credit_attempt_request_mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  -- Retry quotes are irrevocably bound to their original request. A manually
  -- rewritten generation_request_id must not turn a retry into a debit for a
  -- sibling request owned by the same person.
  IF NEW.action = 'retry' AND NEW.original_request_id IS DISTINCT FROM NEW.generation_request_id THEN
    RAISE EXCEPTION 'account_credit_retry_request_mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  -- A fresh quote may be generated after a browser retry, while the existing
  -- idempotent request already owns its first attempt. A second quote must
  -- never be consumed for that same attempt: it would duplicate both account
  -- debit and generation_requests.charged_points without a new task.
  IF EXISTS (
    SELECT 1
    FROM {{schema}}.generation_quotes prior_quote
    WHERE prior_quote.generation_attempt_id = NEW.generation_attempt_id
      AND prior_quote.status = 'consumed'
      AND prior_quote.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'account_credit_duplicate_generation_attempt'
      USING ERRCODE = 'P0001';
  END IF;

  charge_points := NEW.estimated_cost_fen;
  quota_date := (now() AT TIME ZONE 'Asia/Shanghai')::date;

  SELECT balance_points, daily_limit_points
  INTO account_balance, account_daily_limit
  FROM {{schema}}.user_credit_accounts
  WHERE user_id = billing_actor_user_id
  FOR UPDATE;

  IF account_balance IS NULL THEN
    RAISE EXCEPTION 'account_credit_account_missing'
      USING ERRCODE = 'P0001';
  END IF;
  IF account_balance < charge_points THEN
    RAISE EXCEPTION 'account_credit_insufficient'
      USING ERRCODE = 'P0001';
  END IF;
  IF account_daily_limit < charge_points THEN
    RAISE EXCEPTION 'account_credit_daily_limit_exceeded'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT charged_points
  INTO used_today
  FROM {{schema}}.user_credit_daily_usage
  WHERE user_id = billing_actor_user_id AND usage_date = quota_date
  FOR UPDATE;
  used_today := COALESCE(used_today, 0);
  IF used_today + charge_points > account_daily_limit THEN
    RAISE EXCEPTION 'account_credit_daily_limit_exceeded'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO {{schema}}.user_credit_daily_usage (user_id, usage_date, charged_points, updated_at)
  VALUES (billing_actor_user_id, quota_date, charge_points, now())
  ON CONFLICT (user_id, usage_date) DO UPDATE
  SET charged_points = {{schema}}.user_credit_daily_usage.charged_points + EXCLUDED.charged_points,
      updated_at = now();

  resulting_balance := account_balance - charge_points;
  UPDATE {{schema}}.user_credit_accounts
  SET balance_points = resulting_balance, updated_at = now()
  WHERE user_id = billing_actor_user_id;

  INSERT INTO {{schema}}.user_credit_ledger_entries (
    id, user_id, entry_kind, points_delta, balance_after_points,
    source_type, source_id, generation_request_id, actor_user_id, metadata, created_at
  ) VALUES (
    -- One consumed quote can produce exactly one debit entry. Reusing its UUID
    -- makes the paid-task bridge deterministic and avoids depending on an
    -- extension function being provisioned in a fresh PostgreSQL schema.
    NEW.id, billing_actor_user_id, 'generation_debit', -charge_points, resulting_balance,
    'generation_quote', NEW.id, NEW.generation_request_id, billing_actor_user_id,
    jsonb_build_object('estimated_cost_fen', NEW.estimated_cost_fen), now()
  );

  RETURN NEW;
END;
$migration$;
