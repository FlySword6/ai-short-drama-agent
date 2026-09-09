-- ⌘K 命令面板内容播种(S30):两组静态指令 + 一套面板文案。
-- 真源依据:任务包 kimi-goal-s30-command-palette-20260726(DC 点名:面板展示
-- 什么、文案是什么、排序怎么排不许写死代码);分组/文案调性照
-- docs/contracts/v0.1/design-system.md(片场语言、空态教学、不用破折号)。
-- 指令 id(action.*/nav.*)是注册机制锚点,行为留在前端 command-registry;
-- 本迁移只入内容。command_palette_* 两个 kind 由同批代码加进
-- src/modules/config-entries/types.ts 的 kind 枚举与 payload 校验。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 全部语句幂等:固定 UUID + ON CONFLICT (kind, entry_key) DO NOTHING,
-- 重放 no-op;操作员在管理界面改过的行重放不覆盖。
--
-- 回滚口径:旧代码不读这两个 kind,行可保留;确需回滚由 DBA 按下面三个
-- 固定 UUID DELETE。

INSERT INTO {{schema}}.config_entries (id, kind, entry_key, status, sort, payload, source) VALUES
  ('8a1c5e02-3b47-4f9d-a6e1-2c0d7f5b91a3', 'command_palette_group', 'production', 'published', 1, '{"title":"开拍","note":"手上这摊活,从这儿起。","items":[{"command":"action.create_project","label":"新建项目","hint":"开一部新戏","keywords":["xjxm","lixiang","立项"]},{"command":"action.create_shot","label":"新建分镜","hint":"给当前这集加一条镜头","keywords":["xjfj","jingtou","镜头"],"context":"project"}]}'::jsonb, 'seed-026'),
  ('9b2d6f13-4c58-4a0e-b7f2-3d1e8a6c02b4', 'command_palette_group', 'back_office', 'published', 2, '{"title":"后场","note":"设置与后台,都在这排。","items":[{"command":"nav.settings","label":"打开设置","hint":"API、提示词与账户","keywords":["sz","shezhi"]},{"command":"nav.releases","label":"版本计划","hint":"看看接下来上什么","keywords":["bbjh","jihua","计划"]},{"command":"nav.admin","label":"管理后台","hint":"用户与运营","keywords":["glht","houtai","后台"],"requires":"admin"}]}'::jsonb, 'seed-026'),
  ('ac3e7024-5d69-4b1f-c8a3-4e2f9b7d13c5', 'command_palette_copy', 'default', 'published', 1, '{"placeholder":"搜项目、剧集、分镜、资产,或直接下令…","empty_results":"没找着。项目、剧集、场、分镜、资产都能搜,换个词再试试。","load_failed":"搜索这会儿连不上,指令照常能用;搜东西请稍后再试。","search_group_labels":{"projects":"项目","episodes":"剧集","scenes":"场","shots":"分镜","assets":"资产"} }'::jsonb, 'seed-026')
ON CONFLICT (kind, entry_key) DO NOTHING;
