-- 0.2.x 创作词表开放化 + media_kind 声音前置。
-- 真源:docs/design/creative-vocabulary-openness.md(裁决记录)、
-- docs/contracts/platform-ontology.md(R9/R10)、
-- docs/design/pre-production-design-workflow.md(R10)。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 全部语句幂等,可安全重放(CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING /
-- DROP CONSTRAINT IF EXISTS + 同名重建)。
--
-- 回滚口径(先备份;各步需先清理词表外取值,否则重建 CHECK 会失败):
--   1) control_package_refs:
--        ALTER TABLE {{schema}}.control_package_refs DROP CONSTRAINT control_package_refs_lane_fk;
--        ALTER TABLE {{schema}}.control_package_refs ADD CONSTRAINT control_package_refs_lane_check
--          CHECK (lane IN ('character', 'scene', 'prop', 'camera_motion', 'reference_video', 'audio'));
--      (013 原 CHECK 定义,见 013_control_packages.sql)
--   2) asset_entities:
--        ALTER TABLE {{schema}}.asset_entities DROP CONSTRAINT asset_entities_role_fk;
--        ALTER TABLE {{schema}}.asset_entities ADD CONSTRAINT asset_entities_control_role_check
--          CHECK (role IS NULL OR role IN (
--            'character_identity', 'scene', 'prop', 'motion', 'camera_storyboard', 'style_env'));
--      (012 原 CHECK 定义,见 012_shot_media_asset_registration.sql)
--   3) media_kind 七处:DROP 新 CHECK 后重建 IN ('image', 'video')(需先清理 'audio' 行)。
--   4) 三张词表表:旧代码不读取,可保留;确需清理由 DBA 手工 DROP。

-- =====================================================================
-- 1. 参考栏词表:承接 013 的 lane 六值 CHECK,开放为可登记词表。
--    domain 三分(实体/风格/媒介)来自裁决记录条 1;
--    pick_kind 是「从资产库选」选择器的资产类型过滤,NULL = 不限类型。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.reference_lane_vocabulary (
  id varchar(24) PRIMARY KEY,
  display_name varchar(64) NOT NULL,
  domain varchar(16) NOT NULL,
  pick_kind varchar(32),
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reference_lane_vocabulary_domain_check
    CHECK (domain IN ('entity', 'style', 'media'))
);

-- 播种七条:与前端内置词表(lane-vocabulary.ts)对齐;lighting 在 013 CHECK
-- 之外,是本次开放化新承认的参考栏。
INSERT INTO {{schema}}.reference_lane_vocabulary (id, display_name, domain, pick_kind, sort) VALUES
  ('character', '角色', 'entity', 'character', 1),
  ('scene', '场景', 'entity', 'scene', 2),
  ('prop', '道具', 'entity', 'prop', 3),
  ('lighting', '光影', 'style', 'lighting', 1),
  ('camera_motion', '运镜', 'style', 'camera', 2),
  ('reference_video', '参考视频', 'media', NULL, 1),
  ('audio', '音频', 'media', NULL, 2)
ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- 2. 资产角色词表:承接 012 的 role 六值 CHECK(asset_entities.role)。
--    结构同构;role 不参与「从资产库选」过滤,pick_kind 一律 NULL;
--    domain 为后端粗分(实体/风格/媒介),仅作展示分组。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.asset_role_vocabulary (
  id varchar(24) PRIMARY KEY,
  display_name varchar(64) NOT NULL,
  domain varchar(16) NOT NULL,
  pick_kind varchar(32),
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_role_vocabulary_domain_check
    CHECK (domain IN ('entity', 'style', 'media'))
);

INSERT INTO {{schema}}.asset_role_vocabulary (id, display_name, domain, pick_kind, sort) VALUES
  ('character_identity', '角色身份', 'entity', NULL, 1),
  ('scene', '场景', 'entity', NULL, 2),
  ('prop', '道具', 'entity', NULL, 3),
  ('motion', '动作', 'media', NULL, 1),
  ('camera_storyboard', '运镜分镜', 'style', NULL, 1),
  ('style_env', '风格环境', 'style', NULL, 2)
ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- 3. 项目类型建议词表:播种建议(裁决记录条 3),id 即中文类型名,
--    与 PROJECT_GENRES(src/modules/operations/types.ts)对齐。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.genre_suggestions (
  id varchar(32) PRIMARY KEY,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO {{schema}}.genre_suggestions (id, sort) VALUES
  ('甜宠', 1),
  ('虐恋', 2),
  ('重生', 3),
  ('复仇', 4),
  ('穿越', 5),
  ('其他', 6)
ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- 4. control_package_refs.lane:CHECK 拆除,改 FK 词表。
--    存量 refs 取值全在播种集内(013 六值 ⊆ 播种七条),无数据搬迁。
-- =====================================================================
ALTER TABLE {{schema}}.control_package_refs
  DROP CONSTRAINT IF EXISTS control_package_refs_lane_check;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.control_package_refs
    ADD CONSTRAINT control_package_refs_lane_fk
    FOREIGN KEY (lane) REFERENCES {{schema}}.reference_lane_vocabulary(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

-- =====================================================================
-- 5. asset_entities.role:CHECK 拆除,改 FK 词表。
--    role 可空,NULL 不触发 FK;存量六值全在播种集内,无数据搬迁。
-- =====================================================================
ALTER TABLE {{schema}}.asset_entities
  DROP CONSTRAINT IF EXISTS asset_entities_control_role_check;

DO $migration$
BEGIN
  ALTER TABLE {{schema}}.asset_entities
    ADD CONSTRAINT asset_entities_role_fk
    FOREIGN KEY (role) REFERENCES {{schema}}.asset_role_vocabulary(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $migration$;

-- =====================================================================
-- 6. media_kind 七处 CHECK 一次加 'audio'(声音工坊前置)。
--    每处 DROP + 同名重建:重放时先 DROP 再 ADD,最终态一致,幂等。
--    存量行取值全在 ('image', 'video') 内,重建校验必过。
-- =====================================================================
DO $migration$
BEGIN
  ALTER TABLE {{schema}}.generation_requests DROP CONSTRAINT IF EXISTS generation_requests_media_kind_check;
  ALTER TABLE {{schema}}.generation_requests
    ADD CONSTRAINT generation_requests_media_kind_check CHECK (media_kind IN ('image', 'video', 'audio'));

  ALTER TABLE {{schema}}.pricing_rules DROP CONSTRAINT IF EXISTS pricing_rules_media_kind_check;
  ALTER TABLE {{schema}}.pricing_rules
    ADD CONSTRAINT pricing_rules_media_kind_check CHECK (media_kind IN ('image', 'video', 'audio'));

  ALTER TABLE {{schema}}.media_results DROP CONSTRAINT IF EXISTS media_results_kind_check;
  ALTER TABLE {{schema}}.media_results
    ADD CONSTRAINT media_results_kind_check CHECK (media_kind IN ('image', 'video', 'audio'));

  ALTER TABLE {{schema}}.generation_default_strategies DROP CONSTRAINT IF EXISTS generation_default_strategies_media_kind_check;
  ALTER TABLE {{schema}}.generation_default_strategies
    ADD CONSTRAINT generation_default_strategies_media_kind_check CHECK (media_kind IN ('image', 'video', 'audio'));

  ALTER TABLE {{schema}}.project_review_policies DROP CONSTRAINT IF EXISTS project_review_policies_media_kind_check;
  ALTER TABLE {{schema}}.project_review_policies
    ADD CONSTRAINT project_review_policies_media_kind_check CHECK (media_kind IN ('image', 'video', 'audio'));

  ALTER TABLE {{schema}}.reference_tests DROP CONSTRAINT IF EXISTS reference_tests_media_kind_check;
  ALTER TABLE {{schema}}.reference_tests
    ADD CONSTRAINT reference_tests_media_kind_check CHECK (media_kind IN ('image', 'video', 'audio'));

  ALTER TABLE {{schema}}.reference_test_results DROP CONSTRAINT IF EXISTS reference_test_results_media_kind_check;
  ALTER TABLE {{schema}}.reference_test_results
    ADD CONSTRAINT reference_test_results_media_kind_check CHECK (media_kind IN ('image', 'video', 'audio'));
END $migration$;
