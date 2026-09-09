-- S38 声音工坊：音频候选版本是独立的正式事实，但媒体字节、TOS 位置与
-- 计费继续分别由 media_results / generation_* / cost_entries 持有。
-- 本表不创建第二条生成或审核链；锁定动作必须由应用复用既有审核域确认后才可写入。
-- 回滚口径：旧应用不读取本表。若必须回退，先停止音频版本写入并导出记录，再由 DBA 手工 DROP TABLE。

CREATE TABLE IF NOT EXISTS {{schema}}.audio_versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  generation_request_id uuid REFERENCES {{schema}}.generation_requests(id) ON DELETE SET NULL,
  media_result_id uuid NOT NULL REFERENCES {{schema}}.media_results(id) ON DELETE CASCADE,
  status varchar(16) NOT NULL DEFAULT 'candidate',
  subtitle_json jsonb,
  compliance_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  selected_by_user_id uuid REFERENCES {{schema}}.users(id),
  selected_at timestamptz,
  discarded_by_user_id uuid REFERENCES {{schema}}.users(id),
  discarded_at timestamptz,
  -- locked 是正式可追责事实：三条引用必须完整，且不得被硬删除降格为 NULL。
  locked_asset_entity_id uuid REFERENCES {{schema}}.asset_entities(id) ON DELETE RESTRICT,
  locked_asset_media_id uuid REFERENCES {{schema}}.asset_media(id) ON DELETE RESTRICT,
  project_asset_ref_id uuid REFERENCES {{schema}}.project_asset_refs(id) ON DELETE RESTRICT,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audio_versions_media_result_unique UNIQUE (media_result_id),
  CONSTRAINT audio_versions_status_check CHECK (status IN ('candidate', 'selected', 'locked', 'discarded')),
  CONSTRAINT audio_versions_compliance_metadata_object_check CHECK (jsonb_typeof(compliance_metadata) = 'object'),
  -- 候选绝不自动进输入包。审核域确认后才能把 selected 变为 locked；这里保留
  -- 谁在何时做了状态动作及锁定后转资产的正式引用，不另建审核表。
  CONSTRAINT audio_versions_lifecycle_shape_check CHECK (
    (status = 'candidate'
      AND selected_by_user_id IS NULL AND selected_at IS NULL
      AND discarded_by_user_id IS NULL AND discarded_at IS NULL
      AND locked_at IS NULL)
    OR (status = 'selected'
      AND selected_by_user_id IS NOT NULL AND selected_at IS NOT NULL
      AND discarded_by_user_id IS NULL AND discarded_at IS NULL
      AND locked_at IS NULL)
    OR (status = 'locked'
      AND selected_by_user_id IS NOT NULL AND selected_at IS NOT NULL
      AND discarded_by_user_id IS NULL AND discarded_at IS NULL
      AND locked_at IS NOT NULL)
    OR (status = 'discarded'
      AND selected_by_user_id IS NULL AND selected_at IS NULL
      AND discarded_by_user_id IS NOT NULL AND discarded_at IS NOT NULL
      AND locked_at IS NULL)
  ),
  CONSTRAINT audio_versions_locked_refs_shape_check CHECK (
    (status = 'locked'
      AND locked_asset_entity_id IS NOT NULL
      AND locked_asset_media_id IS NOT NULL
      AND project_asset_ref_id IS NOT NULL)
    OR (status <> 'locked'
      AND locked_asset_entity_id IS NULL
      AND locked_asset_media_id IS NULL
      AND project_asset_ref_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS audio_versions_project_status_updated_idx
  ON {{schema}}.audio_versions (project_id, status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audio_versions_generation_request_idx
  ON {{schema}}.audio_versions (generation_request_id)
  WHERE generation_request_id IS NOT NULL;
