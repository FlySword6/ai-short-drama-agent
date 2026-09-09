-- P6 分镜拆分改版（docs/lite-oneclick-generate-episode.md §2 P6 D）。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不自动执行迁移。
-- 全部语句幂等，可安全重放（ADD COLUMN IF NOT EXISTS）。
--
-- 语义：
--   * shots.storyboard_detail（jsonb，可空）——固定 skill《跨模型统一影视分镜
--     生成约束规范》单次结构化拆镜输出的全量：segment_title / N Shot 四模块 /
--     光影 / sfx / dialogue / asset_definitions（@ 引用资产库）/ 画风·色调·运镜策略。
--     分镜（shots 一行）= 一个 Segment（独立剧情单元）；Segment 内 N Shot
--     （N = 用户配置几段式 generation_default_strategies.parameters.shots_per_segment，
--     默认 5）作为该分镜的内部结构化内容落本列，成文提示词涵盖 N Shot。
--   * 列可空：skill 删除降级路径（通用拆镜，无结构化输出）写 NULL，前端隐藏
--     「高级查看」入口；恢复 skill 常量即恢复全量落库，对称可逆（§2.6 F）。
--   * 每镜成文提示词复用既有 shots.video_prompt 列，不新增列、不新增表。
--
-- 回滚口径：旧代码不读本列；确需回滚由 DBA 手工
--   ALTER TABLE {{schema}}.shots DROP COLUMN storyboard_detail;

ALTER TABLE {{schema}}.shots
  ADD COLUMN IF NOT EXISTS storyboard_detail jsonb;

COMMENT ON COLUMN {{schema}}.shots.storyboard_detail IS
  'skill 单次结构化拆镜输出全量：segment_title / N Shot 四模块 / 光影 / sfx / dialogue / asset_definitions / 画风·色调·运镜策略（§2 P6）';
