-- S57: self-service email registration, tiered invite codes and account credits.
--
-- Unit invariant (DC fixed): 1 point = 1 fen = ¥0.01.  The generation quote's
-- `estimated_cost_fen` is therefore copied verbatim into the account ledger;
-- no second price calculation is allowed in this migration.

-- ---------------------------------------------------------------------------
-- Identity and email verification.  Legacy username-only accounts remain
-- valid: email is nullable so Day-0/admin users never need a destructive
-- migration before they can log in.
-- ---------------------------------------------------------------------------

ALTER TABLE {{schema}}.users
  ADD COLUMN IF NOT EXISTS email varchar(320),
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON {{schema}}.users (lower(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.email_verification_codes (
  id uuid PRIMARY KEY,
  email varchar(320) NOT NULL,
  purpose varchar(32) NOT NULL DEFAULT 'registration',
  code_hash text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_verification_codes_purpose_check
    CHECK (purpose IN ('registration')),
  CONSTRAINT email_verification_codes_email_normalized_check
    CHECK (email = lower(btrim(email))),
  CONSTRAINT email_verification_codes_attempts_check
    CHECK (attempt_count >= 0 AND max_attempts BETWEEN 1 AND 10)
);
CREATE INDEX IF NOT EXISTS email_verification_codes_lookup_idx
  ON {{schema}}.email_verification_codes (email, purpose, created_at DESC, id DESC)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Table-driven invitation and account-credit policy.  Tiers seed only the
-- DC-approved values.  Later admin changes are audited and affect newly
-- issued codes; an issued code carries a value snapshot so a later edit never
-- changes a code already handed to a person.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS {{schema}}.account_credit_policies (
  policy_key varchar(64) PRIMARY KEY,
  daily_limit_points integer NOT NULL,
  created_by_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_credit_policies_key_check
    CHECK (policy_key IN ('self_registration')),
  CONSTRAINT account_credit_policies_daily_limit_check
    CHECK (daily_limit_points >= 0)
);

-- 无码注册不赠送积分；500 元日额度是没有邀请码时的可配置默认上限，
-- 余额仍为 0，所以不会绕开“有余额才能发起付费生成”的红线。
INSERT INTO {{schema}}.account_credit_policies
  (policy_key, daily_limit_points, created_at, updated_at)
VALUES ('self_registration', 50000, now(), now())
ON CONFLICT (policy_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS {{schema}}.invite_tiers (
  id uuid PRIMARY KEY,
  tier_key varchar(64) NOT NULL,
  display_name varchar(128) NOT NULL,
  grant_points integer NOT NULL,
  daily_limit_points integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_tiers_key_format_check
    CHECK (tier_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
  CONSTRAINT invite_tiers_grant_points_check CHECK (grant_points >= 0),
  CONSTRAINT invite_tiers_daily_limit_points_check CHECK (daily_limit_points >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS invite_tiers_key_unique ON {{schema}}.invite_tiers (tier_key);

INSERT INTO {{schema}}.invite_tiers
  (id, tier_key, display_name, grant_points, daily_limit_points, active, created_at, updated_at)
VALUES
  ('3d0222ba-7c6f-4ffc-901f-510c3e4aa001', 'developer', '开发账户', 100000, 100000, true, now(), now()),
  ('3d0222ba-7c6f-4ffc-901f-510c3e4aa002', 'invited', '内测受邀', 50000, 50000, true, now(), now())
ON CONFLICT (tier_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS {{schema}}.invite_codes (
  id uuid PRIMARY KEY,
  code_hash varchar(64) NOT NULL,
  code_prefix varchar(16) NOT NULL,
  tier_id uuid NOT NULL REFERENCES {{schema}}.invite_tiers(id) ON DELETE RESTRICT,
  tier_key varchar(64) NOT NULL,
  grant_points integer NOT NULL,
  daily_limit_points integer NOT NULL,
  expires_at timestamptz,
  max_uses integer NOT NULL DEFAULT 1,
  used_count integer NOT NULL DEFAULT 0,
  status varchar(16) NOT NULL DEFAULT 'active',
  issued_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_codes_hash_unique UNIQUE (code_hash),
  CONSTRAINT invite_codes_prefix_check CHECK (char_length(code_prefix) BETWEEN 4 AND 16),
  CONSTRAINT invite_codes_status_check CHECK (status IN ('active', 'suspended', 'revoked')),
  CONSTRAINT invite_codes_grant_points_check CHECK (grant_points >= 0),
  CONSTRAINT invite_codes_daily_limit_points_check CHECK (daily_limit_points >= 0),
  CONSTRAINT invite_codes_uses_check CHECK (max_uses >= 1 AND used_count >= 0 AND used_count <= max_uses)
);
CREATE INDEX IF NOT EXISTS invite_codes_active_lookup_idx
  ON {{schema}}.invite_codes (status, expires_at, created_at DESC)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS {{schema}}.user_credit_accounts (
  user_id uuid PRIMARY KEY REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  balance_points integer NOT NULL DEFAULT 0,
  daily_limit_points integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credit_accounts_balance_check CHECK (balance_points >= 0),
  CONSTRAINT user_credit_accounts_daily_limit_check CHECK (daily_limit_points >= 0)
);

CREATE TABLE IF NOT EXISTS {{schema}}.user_credit_daily_usage (
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  charged_points integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, usage_date),
  CONSTRAINT user_credit_daily_usage_charged_check CHECK (charged_points >= 0)
);

CREATE TABLE IF NOT EXISTS {{schema}}.user_credit_ledger_entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  entry_kind varchar(32) NOT NULL,
  points_delta integer NOT NULL,
  balance_after_points integer NOT NULL,
  source_type varchar(64) NOT NULL,
  source_id uuid,
  generation_request_id uuid REFERENCES {{schema}}.generation_requests(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_credit_ledger_entry_kind_check
    CHECK (entry_kind IN ('invite_grant', 'admin_adjustment', 'generation_debit')),
  CONSTRAINT user_credit_ledger_balance_after_check CHECK (balance_after_points >= 0),
  CONSTRAINT user_credit_ledger_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS user_credit_ledger_generation_quote_once
  ON {{schema}}.user_credit_ledger_entries (source_type, source_id)
  WHERE entry_kind = 'generation_debit' AND source_type = 'generation_quote' AND source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_credit_ledger_user_created_idx
  ON {{schema}}.user_credit_ledger_entries (user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS {{schema}}.invite_code_redemptions (
  id uuid PRIMARY KEY,
  invite_code_id uuid NOT NULL REFERENCES {{schema}}.invite_codes(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  grant_points integer NOT NULL,
  daily_limit_points integer NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_code_redemptions_code_user_unique UNIQUE (invite_code_id, user_id),
  CONSTRAINT invite_code_redemptions_grant_points_check CHECK (grant_points >= 0),
  CONSTRAINT invite_code_redemptions_daily_limit_points_check CHECK (daily_limit_points >= 0)
);
CREATE INDEX IF NOT EXISTS invite_code_redemptions_user_idx
  ON {{schema}}.invite_code_redemptions (user_id, redeemed_at DESC);

-- Existing and subsequently Day-0/admin-created users always get an account.
-- The trigger provisions a zero-balance account, while a successful invite
-- registration atomically replaces the allowance and writes a grant ledger.
INSERT INTO {{schema}}.user_credit_accounts (user_id, balance_points, daily_limit_points, created_at, updated_at)
SELECT u.id, 0, policy.daily_limit_points, now(), now()
FROM {{schema}}.users u
CROSS JOIN {{schema}}.account_credit_policies policy
WHERE policy.policy_key = 'self_registration'
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION {{schema}}.provision_user_credit_account()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
DECLARE
  default_daily_limit integer;
BEGIN
  SELECT daily_limit_points INTO default_daily_limit
  FROM {{schema}}.account_credit_policies
  WHERE policy_key = 'self_registration';
  IF default_daily_limit IS NULL THEN
    RAISE EXCEPTION 'S57 credit policy is missing' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO {{schema}}.user_credit_accounts (user_id, balance_points, daily_limit_points, created_at, updated_at)
  VALUES (NEW.id, 0, default_daily_limit, now(), now())
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$migration$;

DROP TRIGGER IF EXISTS users_provision_credit_account ON {{schema}}.users;
CREATE TRIGGER users_provision_credit_account
AFTER INSERT ON {{schema}}.users
FOR EACH ROW EXECUTE FUNCTION {{schema}}.provision_user_credit_account();

-- ---------------------------------------------------------------------------
-- Formal paid-task bridge.  Generation already consumes a confirmed quote in
-- one PostgreSQL transaction.  This AFTER trigger is inside that transaction,
-- so a debit, daily allowance update, account balance update, request
-- charged_points refresh and quote consumption either all commit or all roll
-- back.  No JavaScript generation module needs a parallel accounting branch.
-- China natural day is used for the day allowance.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION {{schema}}.debit_credit_for_consumed_generation_quote()
RETURNS trigger
LANGUAGE plpgsql
AS $migration$
DECLARE
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
  -- Serialize all quote consumptions that claim the same attempt before
  -- checking prior consumption. Without this row lock, two concurrent UPDATEs
  -- can both observe no committed sibling quote under MVCC and debit twice.
  PERFORM 1
  FROM {{schema}}.generation_attempts
  WHERE id = NEW.generation_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_credit_invalid_generation_quote'
      USING ERRCODE = 'P0001';
  END IF;
  -- A fresh quote may be generated after a browser retry, while the existing
  -- idempotent request already owns its first attempt.  A second quote must
  -- never be consumed for that same attempt: it would duplicate both account
  -- debit and `generation_requests.charged_points` without a new task.
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
  WHERE user_id = NEW.user_id
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
  WHERE user_id = NEW.user_id AND usage_date = quota_date
  FOR UPDATE;
  used_today := COALESCE(used_today, 0);
  IF used_today + charge_points > account_daily_limit THEN
    RAISE EXCEPTION 'account_credit_daily_limit_exceeded'
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO {{schema}}.user_credit_daily_usage (user_id, usage_date, charged_points, updated_at)
  VALUES (NEW.user_id, quota_date, charge_points, now())
  ON CONFLICT (user_id, usage_date) DO UPDATE
  SET charged_points = {{schema}}.user_credit_daily_usage.charged_points + EXCLUDED.charged_points,
      updated_at = now();

  resulting_balance := account_balance - charge_points;
  UPDATE {{schema}}.user_credit_accounts
  SET balance_points = resulting_balance, updated_at = now()
  WHERE user_id = NEW.user_id;

  INSERT INTO {{schema}}.user_credit_ledger_entries (
    id, user_id, entry_kind, points_delta, balance_after_points,
    source_type, source_id, generation_request_id, actor_user_id, metadata, created_at
  ) VALUES (
    -- One consumed quote can produce exactly one debit entry. Reusing its UUID
    -- makes the paid-task bridge deterministic and avoids depending on an
    -- extension function being provisioned in a fresh PostgreSQL schema.
    NEW.id, NEW.user_id, 'generation_debit', -charge_points, resulting_balance,
    'generation_quote', NEW.id, NEW.generation_request_id, NEW.user_id,
    jsonb_build_object('estimated_cost_fen', NEW.estimated_cost_fen), now()
  );

  RETURN NEW;
END;
$migration$;

-- Keep a stable name so migration health/DBAs can inspect the paid-task guard.
DROP TRIGGER IF EXISTS generation_quotes_debit_account_credit ON {{schema}}.generation_quotes;
CREATE TRIGGER generation_quotes_debit_account_credit
AFTER UPDATE OF status ON {{schema}}.generation_quotes
FOR EACH ROW EXECUTE FUNCTION {{schema}}.debit_credit_for_consumed_generation_quote();
