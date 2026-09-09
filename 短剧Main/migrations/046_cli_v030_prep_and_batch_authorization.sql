-- R161 CLI v0.3.0: 服务端备戏真源 + 批量生成确认/提交拆分。
--
-- 前向迁移由 npm run db:migrate 显式执行，应用启动不自动迁移。
-- prep item 是场级备料事实；只有显式 shot 提交才写 control_package_refs。
-- generation batch 的 confirmed 状态只冻结并确认报价，不创建任务、不扣费。

CREATE TABLE IF NOT EXISTS {{schema}}.scene_prep_items (
  id uuid PRIMARY KEY,
  scene_id uuid NOT NULL REFERENCES {{schema}}.scenes(id) ON DELETE CASCADE,
  lane varchar(24) NOT NULL REFERENCES {{schema}}.reference_lane_vocabulary(id),
  asset_entity_id uuid NOT NULL REFERENCES {{schema}}.asset_entities(id),
  asset_variant_id uuid REFERENCES {{schema}}.asset_variants(id),
  asset_media_id uuid REFERENCES {{schema}}.asset_media(id),
  status varchar(16) NOT NULL DEFAULT 'pending',
  project_asset_ref_id uuid REFERENCES {{schema}}.project_asset_refs(id),
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  committed_by_user_id uuid REFERENCES {{schema}}.users(id),
  client_idempotency_key varchar(255) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  committed_at timestamptz,
  CONSTRAINT scene_prep_items_status_check CHECK (status IN ('pending', 'committed')),
  CONSTRAINT scene_prep_items_commit_shape_check CHECK (
    (status = 'pending'
      AND project_asset_ref_id IS NULL
      AND committed_by_user_id IS NULL
      AND committed_at IS NULL)
    OR
    (status = 'committed'
      AND project_asset_ref_id IS NOT NULL
      AND committed_by_user_id IS NOT NULL
      AND committed_at IS NOT NULL)
  ),
  CONSTRAINT scene_prep_items_scene_lane_asset_unique
    UNIQUE (scene_id, lane, asset_entity_id),
  CONSTRAINT scene_prep_items_actor_key_unique
    UNIQUE (created_by_user_id, client_idempotency_key)
);

CREATE INDEX IF NOT EXISTS scene_prep_items_scene_status_created_idx
  ON {{schema}}.scene_prep_items (scene_id, status, created_at, id);

CREATE TABLE IF NOT EXISTS {{schema}}.scene_prep_commits (
  id uuid PRIMARY KEY,
  scene_id uuid NOT NULL REFERENCES {{schema}}.scenes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  client_idempotency_key varchar(255) NOT NULL,
  request_hash varchar(64) NOT NULL,
  target_mode varchar(16) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT scene_prep_commits_actor_key_unique UNIQUE (user_id, client_idempotency_key),
  CONSTRAINT scene_prep_commits_hash_check CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT scene_prep_commits_target_mode_check CHECK (
    target_mode IN ('scene', 'shots', 'all_shots')
  )
);

CREATE INDEX IF NOT EXISTS scene_prep_commits_scene_created_idx
  ON {{schema}}.scene_prep_commits (scene_id, created_at DESC, id DESC);

ALTER TABLE {{schema}}.generation_batch_authorizations
  DROP CONSTRAINT IF EXISTS generation_batch_authorizations_status_check;
ALTER TABLE {{schema}}.generation_batch_authorizations
  ADD CONSTRAINT generation_batch_authorizations_status_check
  CHECK (status IN ('confirmed', 'completed', 'partial', 'failed'));

ALTER TABLE {{schema}}.generation_batch_authorization_items
  DROP CONSTRAINT IF EXISTS generation_batch_authorization_items_status_check;
ALTER TABLE {{schema}}.generation_batch_authorization_items
  ADD CONSTRAINT generation_batch_authorization_items_status_check
  CHECK (
    status IN (
      'confirmed', 'created', 'expired', 'price_changed',
      'budget_blocked', 'quote_unavailable', 'failed'
    )
  );

ALTER TABLE {{schema}}.generation_batch_authorization_items
  DROP CONSTRAINT IF EXISTS generation_batch_authorization_items_created_shape_check;
ALTER TABLE {{schema}}.generation_batch_authorization_items
  ADD CONSTRAINT generation_batch_authorization_items_created_shape_check
  CHECK (
    (status = 'confirmed'
      AND generation_request_id IS NULL
      AND generation_attempt_id IS NULL
      AND failure_code IS NULL
      AND failure_message IS NULL)
    OR
    (status = 'created'
      AND generation_request_id IS NOT NULL
      AND generation_attempt_id IS NOT NULL
      AND failure_code IS NULL
      AND failure_message IS NULL)
    OR
    (status NOT IN ('confirmed', 'created')
      AND generation_request_id IS NULL
      AND generation_attempt_id IS NULL)
  );
