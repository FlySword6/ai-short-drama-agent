-- V0.1.1 Lite 项目级风格库（docs/design/prd-v2/lite-config-tabs-and-style.md §4.4）。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不自动执行迁移。
-- 全部语句幂等，可安全重放（CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING / 守卫 UPDATE）。
--
-- 语义约定（与文档一致）：
--   * 风格 = 一段 ≤5000 字的画面基调描述，可多条；每项目每媒介至多 1 个默认
--     （project_styles_one_default_key 部分唯一索引兜底并发）。
--   * 生成期：默认风格内容镜像写 projects.image_style_description /
--     video_style_description（054 遗留列，完整版设置页仍在读），
--     服务端 resolveProjectGenerationConfig 读取同一列 → 生成链路零改动（§4.6）。
--   * 默认风格生命周期（D1 2026-08-17 修订：不锁定）：随时可编辑、可换设、可取消、可删除，
--     全程可逆（应用层事务保证「默认行 = 镜像列」一致，见 project-styles/repository.ts）。
--     初版「行级永久锁定」口径已作废（docs/design/prd-v2/lite-config-tabs-and-style.md §4.7）。
--   * 软删（R1 禁硬删）：删除仅置 deleted_at + deleted_by_user_id；
--     同名唯一是 PARTIAL 索引（WHERE deleted_at IS NULL），软删后可复用名字。
--   * 内容上限 5000 字符（Lite 页面前端同样 5000，两侧一致）。
--
-- 回滚口径：旧代码不读本表；确需回滚由 DBA 手工
--   DROP TABLE {{schema}}.project_styles（DROP 前确认无自建风格或已导出）。

CREATE TABLE IF NOT EXISTS {{schema}}.project_styles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES {{schema}}.projects(id) ON DELETE CASCADE,
  media_kind varchar(16) NOT NULL,
  name varchar(80) NOT NULL,
  content text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by_user_id uuid NOT NULL REFERENCES {{schema}}.users(id),
  deleted_by_user_id uuid REFERENCES {{schema}}.users(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_styles_media_kind_check
    CHECK (media_kind IN ('image', 'video')),
  CONSTRAINT project_styles_name_len_check
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT project_styles_content_len_check
    CHECK (char_length(btrim(content)) BETWEEN 1 AND 5000)
);

-- 同名唯一只在“未删除”行上生效：软删后允许用回旧名字。
CREATE UNIQUE INDEX IF NOT EXISTS project_styles_project_kind_name_active_key
  ON {{schema}}.project_styles (project_id, media_kind, name)
  WHERE deleted_at IS NULL;

-- 每项目每媒介至多一个默认风格；换设让位在应用事务内完成，索引兜底并发（D1：不锁定）。
CREATE UNIQUE INDEX IF NOT EXISTS project_styles_one_default_key
  ON {{schema}}.project_styles (project_id, media_kind)
  WHERE deleted_at IS NULL AND is_default;

CREATE INDEX IF NOT EXISTS project_styles_project_kind_idx
  ON {{schema}}.project_styles (project_id, media_kind, created_at);

-- =====================================================================
-- 历史数据回填：把完整版写进 projects.style* 列（054 遗留列）的非空值转成默认风格行。
--   → 风格名「项目设置历史风格」，is_default = true，created_by = 项目 owner。
-- 守卫：btrim 非空 且 长度 ≤ 5000（超长旧值不强行写入触发 CHECK，避免迁移失败）。
-- 全新项目默认无风格（无值 → 不落行），由用户自行添加。
-- =====================================================================

INSERT INTO {{schema}}.project_styles (project_id, media_kind, name, content, is_default, created_by_user_id)
SELECT
  p.id,
  'image',
  '项目设置历史风格',
  btrim(p.image_style_description),
  true,
  p.owner_user_id
FROM {{schema}}.projects p
WHERE btrim(COALESCE(p.image_style_description, '')) <> ''
  AND char_length(p.image_style_description) <= 5000
ON CONFLICT (project_id, media_kind, name) WHERE deleted_at IS NULL DO NOTHING;

INSERT INTO {{schema}}.project_styles (project_id, media_kind, name, content, is_default, created_by_user_id)
SELECT
  p.id,
  'video',
  '项目设置历史风格',
  btrim(p.video_style_description),
  true,
  p.owner_user_id
FROM {{schema}}.projects p
WHERE btrim(COALESCE(p.video_style_description, '')) <> ''
  AND char_length(p.video_style_description) <= 5000
ON CONFLICT (project_id, media_kind, name) WHERE deleted_at IS NULL DO NOTHING;
