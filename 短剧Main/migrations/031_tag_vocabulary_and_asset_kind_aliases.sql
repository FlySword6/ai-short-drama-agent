-- S41 标签体系 + 资产类型别名:同一件事的两半,共用「自指 canonical」机制。
-- 真源:docs/design/creative-vocabulary-openness.md(创作词汇开放化裁决)、
-- docs/contracts/platform-ontology.md(R9:钱/权/状态机才是不变量,创作词汇全部词表化)。
--
-- 设计要点:
--   1. 别名和规范词同表:canonical_id 指向规范形式,规范词自己指向自己。
--      查询时统一 resolve,不拆两张表、不写「先判断是不是别名」的逻辑。
--   2. 标签/类型词一律不落 CHECK、不落代码枚举:词表是建议源与解析真源,
--      不是写入约束。asset_entities.asset_kind 保持开放 varchar,不加 FK。
--   3. 多标签走真关联表 asset_tags(复合主键),不用逗号串。
--      asset_tags.tag_id 恒存规范词 id:别名在写入层一跳解析后落库,
--      不做多级链(建别名时校验目标本身是规范词)。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 全部语句幂等,可安全重放(CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING)。
--
-- 回滚口径(先备份;旧代码不读取这三张表,也可直接保留):
--   DROP TABLE IF EXISTS {{schema}}.asset_tags;
--   DROP TABLE IF EXISTS {{schema}}.tag_vocabulary;
--   DROP TABLE IF EXISTS {{schema}}.asset_kind_vocabulary;

-- =====================================================================
-- 1. 标签词表:自指 canonical。domain 是开放字符串(风格/情绪/题材……),
--    不设 CHECK——域本身也是创作词汇,同样不冻结。
--    不播种:标签是用户内容,从空词表开始生长(登录即可 ensure 规范词,
--    别名由管理员登记)。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.tag_vocabulary (
  id varchar(64) PRIMARY KEY,
  canonical_id varchar(64) NOT NULL REFERENCES {{schema}}.tag_vocabulary(id),
  domain varchar(32) NOT NULL DEFAULT 'general',
  display_name varchar(64) NOT NULL,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tag_vocabulary_canonical_idx
  ON {{schema}}.tag_vocabulary (canonical_id);

-- =====================================================================
-- 2. 资产标签关联:一份资产不该只进一个格子。
--    tag_id 恒为规范词 id(写入层把别名一跳解析后落库);
--    资产硬删除时级联清理关联行。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.asset_tags (
  asset_entity_id uuid NOT NULL REFERENCES {{schema}}.asset_entities(id) ON DELETE CASCADE,
  tag_id varchar(64) NOT NULL REFERENCES {{schema}}.tag_vocabulary(id),
  created_by uuid REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_entity_id, tag_id)
);
CREATE INDEX IF NOT EXISTS asset_tags_tag_idx
  ON {{schema}}.asset_tags (tag_id);

-- =====================================================================
-- 3. 资产类型词表:与标签同一套自指 canonical。
--    播种代码里已事实使用的 14 个规范词(主值与前端 ASSET_KIND_DEFS 对齐,
--    voice 来自后端 ingest 六值),以及已涌现的三个别名
--    (clothing→costume、keyframe→keyword、other→reference)。
--    规范词先插、别名后插(自指 FK 顺序);重放安全。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.asset_kind_vocabulary (
  id varchar(32) PRIMARY KEY,
  canonical_id varchar(32) NOT NULL REFERENCES {{schema}}.asset_kind_vocabulary(id),
  display_name varchar(64) NOT NULL,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_kind_vocabulary_canonical_idx
  ON {{schema}}.asset_kind_vocabulary (canonical_id);

INSERT INTO {{schema}}.asset_kind_vocabulary (id, canonical_id, display_name, sort) VALUES
  ('character', 'character', '角色', 1),
  ('scene', 'scene', '场景', 2),
  ('prop', 'prop', '道具', 3),
  ('costume', 'costume', '服装', 4),
  ('lighting', 'lighting', '光线参考', 5),
  ('camera', 'camera', '摄影参考', 6),
  ('video', 'video', '视频参考', 7),
  ('keyword', 'keyword', '关键帧', 8),
  ('animal', 'animal', '动物', 9),
  ('reference', 'reference', '参考', 10),
  ('model_3d', 'model_3d', '3D 素模', 11),
  ('sound', 'sound', '声音参考', 12),
  ('music', 'music', '配乐参考', 13),
  ('voice', 'voice', '配音', 14)
ON CONFLICT (id) DO NOTHING;

INSERT INTO {{schema}}.asset_kind_vocabulary (id, canonical_id, display_name, sort) VALUES
  ('clothing', 'costume', '服装', 101),
  ('keyframe', 'keyword', '关键帧', 102),
  ('other', 'reference', '参考', 103)
ON CONFLICT (id) DO NOTHING;
