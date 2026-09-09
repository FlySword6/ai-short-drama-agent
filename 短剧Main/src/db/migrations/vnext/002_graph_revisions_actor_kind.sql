-- Agent 与界面写入同一条 GraphDocument revision 链(issue #345):每条修订记录写入方类别,
-- 页面上的「最近写入」与 Agent 增量状态都读这份事实,不再用本地文案冒充。
-- 001 已为 graph_revisions 装上禁 UPDATE/DELETE 的 immutable trigger,既有行的回填
-- 不得走 UPDATE。PG11+ 的 ADD COLUMN ... NOT NULL DEFAULT 常量走 catalog 快速路径,
-- 不重写堆、不触发行级 trigger,历史行读到 'human',运行时不可变合同不被削弱。
ALTER TABLE vnext.graph_revisions
  ADD COLUMN IF NOT EXISTS created_by_kind varchar(16) NOT NULL DEFAULT 'human';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vnext_graph_revisions_actor_kind') THEN
    ALTER TABLE vnext.graph_revisions
      ADD CONSTRAINT vnext_graph_revisions_actor_kind CHECK (created_by_kind IN ('human', 'agent'));
  END IF;
END
$$;
