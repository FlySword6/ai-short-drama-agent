-- 企业微信内部成员登录的数据地基。
--
-- 企业微信只证明外部身份；平台用户、角色、项目权限和 session 继续以本库为事实源。
-- state、浏览器 nonce 和一次性 result 只保存 SHA-256，不保存授权 code、access token、
-- CorpSecret 或平台 Bearer token。

ALTER TABLE {{schema}}.users
  ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.wecom_user_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  corp_id varchar(64) NOT NULL,
  wecom_user_id varchar(64) NOT NULL,
  last_authenticated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wecom_user_identities_corp_id_not_blank CHECK (btrim(corp_id) <> ''),
  CONSTRAINT wecom_user_identities_user_id_not_blank CHECK (btrim(wecom_user_id) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS wecom_user_identities_external_unique
  ON {{schema}}.wecom_user_identities (corp_id, wecom_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS wecom_user_identities_user_unique
  ON {{schema}}.wecom_user_identities (user_id);

CREATE TABLE IF NOT EXISTS {{schema}}.wecom_auth_transactions (
  id uuid PRIMARY KEY,
  state_hash varchar(64) NOT NULL,
  browser_nonce_hash varchar(64) NOT NULL,
  return_path varchar(2048) NOT NULL,
  expires_at timestamptz NOT NULL,
  callback_consumed_at timestamptz,
  result_hash varchar(64),
  result_expires_at timestamptz,
  result_consumed_at timestamptz,
  resolved_user_id uuid REFERENCES {{schema}}.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wecom_auth_transactions_state_hash_format
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wecom_auth_transactions_nonce_hash_format
    CHECK (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wecom_auth_transactions_result_hash_format
    CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wecom_auth_transactions_return_path
    CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%' AND strpos(return_path, chr(92)) = 0),
  CONSTRAINT wecom_auth_transactions_result_shape
    CHECK (
      (result_hash IS NULL AND result_expires_at IS NULL AND resolved_user_id IS NULL AND result_consumed_at IS NULL)
      OR
      (result_hash IS NOT NULL AND result_expires_at IS NOT NULL AND resolved_user_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS wecom_auth_transactions_state_hash_unique
  ON {{schema}}.wecom_auth_transactions (state_hash);
CREATE UNIQUE INDEX IF NOT EXISTS wecom_auth_transactions_result_hash_unique
  ON {{schema}}.wecom_auth_transactions (result_hash)
  WHERE result_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS wecom_auth_transactions_expiry_idx
  ON {{schema}}.wecom_auth_transactions (expires_at, created_at);
