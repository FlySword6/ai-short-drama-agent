-- V0.1.1 Lite 项目级提示词模板库（docs/design/prd-v2/lite-model-defaults.md §4.3）。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不自动执行迁移。
-- 全部语句幂等，可安全重放（CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING / 守卫 UPDATE）。
--
-- 语义约定（与文档一致）：
--   * 系统默认模板是代码常量（promptCompiler.ts），不是行数据——本表只存用户自建模板。
--   * 生效 = 引用关系（generation_default_strategies.parameters->>'prompt_template_id'），
--     不是本表的行属性；策略表本身零 DDL（JSONB 键形状变化，不用改表结构）。
--   * 软删（R1 禁硬删）：删除仅置 deleted_at + deleted_by_user_id；
--     同名唯一是 PARTIAL 索引（WHERE deleted_at IS NULL），软删后可复用名字。
--   * 内容上限 5000 字符（Lite 页面前端同样 5000，两侧一致）。
--
-- 回滚口径：旧代码不读本表；确需回滚由 DBA 手工
--   DROP TABLE {{schema}}.prompt_templates（DROP 前确认无自建模板或已导出）。

CREATE TABLE IF NOT EXISTS {{schema}}.prompt_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  media_kind varchar(16) NOT NULL,
  name varchar(80) NOT NULL,
  content text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_templates_media_kind_check
    CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT prompt_templates_name_len_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT prompt_templates_content_len_check
    CHECK (char_length(btrim(content)) BETWEEN 1 AND 5000)
);

-- 同名唯一只在“未删除”行上生效：软删后允许用回旧名字。
CREATE UNIQUE INDEX IF NOT EXISTS prompt_templates_project_kind_name_active_key
  ON {{schema}}.prompt_templates (project_id, media_kind, name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS prompt_templates_project_kind_idx
  ON {{schema}}.prompt_templates (project_id, media_kind, created_at);

-- =====================================================================
-- 历史数据回填：把旧文本键迁移成模板行，再把策略指向新 id。
--
-- 来源一：generation_default_strategies.parameters->>'prompt_template'（历史文本键）
--   → 模板名「历史模板」，created_by = 策略最后更新人。
-- 来源二：projects.image_prompt_template / video_prompt_template（054 遗留列，完整版
--   设置页仍在读）
--   → 模板名「项目设置历史模板」，created_by = 项目 owner。
-- 守卫：btrim 非空 且 长度 ≤ 5000（超长旧值不强行写入触发 CHECK，避免迁移失败）。
-- =====================================================================

-- 来源一：策略 JSONB 文本键 → 模板行。
INSERT INTO {{schema}}.prompt_templates (project_id, media_kind, name, content, created_by_user_id)
SELECT
  s.project_id,
  s.media_kind,
  '历史模板',
  btrim(s.parameters->>'prompt_template'),
  s.updated_by_user_id
FROM {{schema}}.generation_default_strategies s
WHERE btrim(COALESCE(s.parameters->>'prompt_template', '')) <> ''
  AND char_length(s.parameters->>'prompt_template') <= 5000
ON CONFLICT (project_id, media_kind, name) WHERE deleted_at IS NULL DO NOTHING;

-- 来源二：项目 054 遗留列 → 模板行（图片/视频各一条）。
INSERT INTO {{schema}}.prompt_templates (project_id, media_kind, name, content, created_by_user_id)
SELECT
  p.id,
  'image',
  '项目设置历史模板',
  btrim(p.image_prompt_template),
  p.owner_user_id
FROM {{schema}}.projects p
WHERE btrim(COALESCE(p.image_prompt_template, '')) <> ''
  AND char_length(p.image_prompt_template) <= 5000
ON CONFLICT (project_id, media_kind, name) WHERE deleted_at IS NULL DO NOTHING;

INSERT INTO {{schema}}.prompt_templates (project_id, media_kind, name, content, created_by_user_id)
SELECT
  p.id,
  'video',
  '项目设置历史模板',
  btrim(p.video_prompt_template),
  p.owner_user_id
FROM {{schema}}.projects p
WHERE btrim(COALESCE(p.video_prompt_template, '')) <> ''
  AND char_length(p.video_prompt_template) <= 5000
ON CONFLICT (project_id, media_kind, name) WHERE deleted_at IS NULL DO NOTHING;

-- 策略指向新模板 id（保留原有 parameters，仅换键：prompt_template → prompt_template_id）。
-- 仅回填「迁移插入过模板行」的策略：join 到刚插入/已存在的活动模板行，
-- 避免把没有对应模板的策略写成 NULL（NULL = 系统默认，本来就该是默认值，无需写入）。
UPDATE {{schema}}.generation_default_strategies s
SET parameters = (s.parameters - 'prompt_template')
  || jsonb_build_object('prompt_template_id', t.id::text)
FROM {{schema}}.prompt_templates t
WHERE t.project_id = s.project_id
  AND t.media_kind = s.media_kind
  AND t.name = '历史模板'
  AND t.deleted_at IS NULL
  AND btrim(COALESCE(s.parameters->>'prompt_template', '')) <> ''
  AND char_length(s.parameters->>'prompt_template') <= 5000;
