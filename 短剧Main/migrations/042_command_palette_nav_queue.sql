-- ⌘K 命令面板补播种：生产队列全局入口。
-- Kimi 壳层注册表使用指令 id `nav.queue`，用户可见标签为「生产队列」，
-- 注册行为导航到 `/queue`；本迁移只补配置内容，不复制前端行为。
--
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不自动执行迁移。
-- 幂等：仅当 back_office.items 尚无 nav.queue 时在数组尾部追加；重放
-- 命中 0 行。既有分组标题、说明、指令、排序、状态及来源全部保留，
-- 管理端已配置过 nav.queue 时也不覆盖其文案。
--
-- 回滚口径：旧前端会过滤未注册指令，因此该项可保留；确需回滚由 DBA
-- 从 back_office.items 中按 command = nav.queue 摘除该对象。

UPDATE {{schema}}.config_entries AS entry
SET payload = jsonb_set(
  entry.payload,
  '{items}',
  (entry.payload -> 'items')
    || '[{"command":"nav.queue","label":"生产队列","hint":"查看后台在跑的任务","keywords":["scdl","shengchanduilie","队列","任务"]}]'::jsonb,
  false
)
WHERE entry.kind = 'command_palette_group'
  AND entry.entry_key = 'back_office'
  AND jsonb_typeof(entry.payload -> 'items') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(entry.payload -> 'items') AS item(value)
    WHERE item.value ->> 'command' = 'nav.queue'
  );
