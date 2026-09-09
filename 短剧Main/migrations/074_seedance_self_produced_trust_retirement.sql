-- 072 之后：退役「30 天自产信任链」(seedance_self_produced_trust,用户裁定)。
-- 信任表 035 建、036 加固,现在整体退役:CreateAsset 登记成为唯一 Seedance
-- 准入通道,血缘事实(media_provenance_*、contains_external_image_ancestor)
-- 保留为审计存储。
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不应自动执行迁移。
-- 全部语句幂等,可安全重放(DROP ... IF EXISTS 语义)。

-- 035 的 guard_media_provenance_parent_edge_insert() 内嵌了「信任冻结父集」检查,
-- 其 plpgsql 体引用了将被删除的信任表。重新定义该守卫,只保留血缘闭包无环检查。
CREATE OR REPLACE FUNCTION {{schema}}.guard_media_provenance_parent_edge_insert()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE ancestors(subject_id) AS (
      SELECT parent_subject_id
      FROM {{schema}}.media_provenance_parent_edges
      WHERE child_subject_id = NEW.parent_subject_id
      UNION
      SELECT edge.parent_subject_id
      FROM {{schema}}.media_provenance_parent_edges edge
      JOIN ancestors ON edge.child_subject_id = ancestors.subject_id
    )
    SELECT 1 FROM ancestors WHERE subject_id = NEW.child_subject_id
  ) THEN
    RAISE EXCEPTION 'media provenance edge must not introduce a cycle';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 信任表退役(连同其上的 insert/update 守卫触发器一起删除)。
DROP TABLE IF EXISTS {{schema}}.seedance_self_produced_trust CASCADE;

-- 信任准入/更新守卫函数一并清理。
DROP FUNCTION IF EXISTS {{schema}}.assert_seedance_self_produced_trust();
DROP FUNCTION IF EXISTS {{schema}}.guard_seedance_self_produced_trust_update();
