-- v1.4 Lite 分镜页基础层（docs/design/prd-v2/lite-shots-page.md 附录 B）。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不自动执行迁移。
-- 全部语句幂等，可安全重放（IF NOT EXISTS / 无破坏性 DDL）。
--
-- 本迁移只落「基础层」所需的库表/列（实现顺序 3/5/7），片段编辑两表
-- （shot_segments / shot_assembly_versions）属实现顺序在后，不在本迁移。
--
-- 语义：
--   * episodes.synopsis（text，可空）——集级可编辑概要，与剧本正文
--     （episode_script_versions.script_text）分离：改概要不触发拆解。
--     为空时前端回退显示最新剧本版本正文开头作占位。
--   * shots.metadata（jsonb，NOT NULL DEFAULT '{}'）——长尾字段固定命名空间
--     `metadata.lite.shot`：氛围 atmosphere、结构化对白 dialogue.lines[]、
--     提示词锁定 prompt_locked。与资产方案的 metadata.lite 同口径（固定命名
--     空间 + 服务端 Zod 校验，不与既有 jsonb 冲突）。
--   * media_results.metadata（jsonb，NOT NULL DEFAULT '{}'）——版本信息存
--     `metadata.shot_version.label`（用户可改的版本标签，如「雨夜版」）；
--     版本号由查询时按同 shot_id+media_kind='video' 的 created_at 升序行号
--     计算，不落库。与合规元数据 compliance_metadata 语义不同，分列存。
--   * shot_asset_refs——分镜-资产引用关系表，把 shots.reference_asset_snapshots
--     那份只读 JSON 快照升级为可编辑、可查询的引用真值；快照保留为剧本确认
--     时的审计溯源，不删。首次进详情时按快照一次性初始化 refs（一次性迁移）。
--     usage_mode 取值沿用 asset_entities.usage_mode 口径：
--     reference / first_frame / last_frame（迁移 012）。
--     enabled 标记「临时禁用」：勾掉「参与生成」= enabled=false，引用关系
--     保留但提示词编译时跳过（决策 4 的交互项，快照/关系表均无此列，故新增）。
--
-- 回滚口径：旧代码不读本表/新列；确需回滚由 DBA 手工
--   DROP TABLE {{schema}}.shot_asset_refs;
--   ALTER TABLE {{schema}}.episodes DROP COLUMN synopsis;
--   ALTER TABLE {{schema}}.shots DROP COLUMN metadata;
--   ALTER TABLE {{schema}}.media_results DROP COLUMN metadata;

ALTER TABLE {{schema}}.episodes
  ADD COLUMN IF NOT EXISTS synopsis text;

ALTER TABLE {{schema}}.shots
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE {{schema}}.shots
  DROP CONSTRAINT IF EXISTS shots_metadata_object_check;

ALTER TABLE {{schema}}.shots
  ADD CONSTRAINT shots_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object');

ALTER TABLE {{schema}}.media_results
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE {{schema}}.media_results
  DROP CONSTRAINT IF EXISTS media_results_metadata_object_check;

ALTER TABLE {{schema}}.media_results
  ADD CONSTRAINT media_results_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object');

-- 分镜-资产引用：一镜一条引用 = 资产实体 + 可选变体/媒体 + 用法 + 排序 + 启用。
-- 唯一约束（shot_id, asset_entity_id）保证同一资产在同一分镜只有一条活动引用；
-- 「换变体/换媒体」走 PATCH 原地改指向，不新建行（决策 4）。
CREATE TABLE IF NOT EXISTS {{schema}}.shot_asset_refs (
  id uuid PRIMARY KEY,
  shot_id uuid NOT NULL REFERENCES {{schema}}.shots(id),
  asset_entity_id uuid NOT NULL REFERENCES {{schema}}.asset_entities(id),
  asset_variant_id uuid REFERENCES {{schema}}.asset_variants(id),
  asset_media_id uuid REFERENCES {{schema}}.asset_media(id),
  usage_mode varchar(16),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  CONSTRAINT shot_asset_refs_usage_mode_check
    CHECK (usage_mode IS NULL OR usage_mode IN ('reference', 'first_frame', 'last_frame'))
);

CREATE INDEX IF NOT EXISTS shot_asset_refs_shot_idx
  ON {{schema}}.shot_asset_refs (shot_id);
CREATE INDEX IF NOT EXISTS shot_asset_refs_asset_entity_idx
  ON {{schema}}.shot_asset_refs (asset_entity_id);
CREATE UNIQUE INDEX IF NOT EXISTS shot_asset_refs_shot_entity_unique
  ON {{schema}}.shot_asset_refs (shot_id, asset_entity_id)
  WHERE deleted_at IS NULL;
