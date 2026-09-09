-- 0.2.x 配置真源第二波(S24):版本计划内容替换 + lane 词表 recommended 扩列。
-- 真源依据:任务包 kimi-goal-s24-config-migration-wave2-20260726;
-- 内容真源 docs/design/version-plan.md(2026-07-26 重排,Fable 架构);
-- 裁决 docs/design/creative-vocabulary-openness.md:recommended 扩词表列,
-- iconKey 等呈现字段留代码覆盖层,不入库。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 全部语句幂等,可安全重放(ADD COLUMN IF NOT EXISTS / 带守卫 UPDATE /
-- 固定 UUID DELETE + ON CONFLICT (kind, entry_key) DO NOTHING)。
--
-- 回滚口径:
--   1) recommended 列:旧代码不读取,可保留;确需回滚由 DBA 手工
--      ALTER TABLE {{schema}}.reference_lane_vocabulary DROP COLUMN recommended;
--   2) 版本计划内容:被删的 022 七行种子可由重放 022 恢复(其 ON CONFLICT
--      只在行不存在时写入);恢复后本迁移的八行仍在,由管理界面归档或 DBA 手工清理。
--
-- 内容替换口径(幂等性论证):
--   节 2 先按 022 播种的七个固定 UUID DELETE 旧内容——无论其是否被运营改过,
--   旧内容已过期(任务包明示删除或废弃,此处选删除);再按新固定 UUID 插入八行。
--   重放:DELETE 命中 0 行;INSERT 撞 (kind, entry_key) 唯一键 DO NOTHING;
--   操作员在管理界面改过新行,重放同样不覆盖。整体完全确定,no-op 重放。
--   recommended 播种同理:UPDATE 带 recommended='[]' 守卫,只在仍是种子默认
--   空数组时回填;操作员改过的条目重放不动(代价:操作员清空成 [] 会被重放
--   回填,已在交接回执中声明)。

-- =====================================================================
-- 1. reference_lane_vocabulary 扩 recommended 列并播种七条:
--    每条参考栏的「建议配什么参考」清单,元素 {key, label, required}。
--    内容=前端内置词表(lane-vocabulary.ts BUILTIN_LANE_VOCABULARY)
--    七条的 recommended 数组逐字拷贝;播种后前端改从接口读,
--    内置数组退役为接口失败时的兜底(残留重复已在交接回执声明)。
-- =====================================================================
ALTER TABLE {{schema}}.reference_lane_vocabulary
  ADD COLUMN IF NOT EXISTS recommended jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE {{schema}}.reference_lane_vocabulary SET recommended = '[{"key":"identity","label":"每个出场角色锁定 1 张身份定妆图","required":true},{"key":"ensemble","label":"多角色同框再补 1 张同框比例参考","required":false}]'::jsonb
  WHERE id = 'character' AND recommended = '[]'::jsonb;
UPDATE {{schema}}.reference_lane_vocabulary SET recommended = '[{"key":"master","label":"场景主视图 1 张（全景空间基准）","required":true},{"key":"variants","label":"日/夜或气氛差异大时各 1 张","required":false}]'::jsonb
  WHERE id = 'scene' AND recommended = '[]'::jsonb;
UPDATE {{schema}}.reference_lane_vocabulary SET recommended = '[{"key":"hero","label":"会特写/交互的关键道具 1 张参考图","required":false}]'::jsonb
  WHERE id = 'prop' AND recommended = '[]'::jsonb;
UPDATE {{schema}}.reference_lane_vocabulary SET recommended = '[{"key":"tone","label":"定 1 张全场影调基准（色卡/光影参考）","required":false}]'::jsonb
  WHERE id = 'lighting' AND recommended = '[]'::jsonb;
UPDATE {{schema}}.reference_lane_vocabulary SET recommended = '[{"key":"description","label":"在 3D 导演台录一段运镜小样，或写一句机位描述","required":true}]'::jsonb
  WHERE id = 'camera_motion' AND recommended = '[]'::jsonb;
UPDATE {{schema}}.reference_lane_vocabulary SET recommended = '[{"key":"draft","label":"上传真人参考视频，或用文生视频快抽一段动作小样","required":false}]'::jsonb
  WHERE id = 'reference_video' AND recommended = '[]'::jsonb;
UPDATE {{schema}}.reference_lane_vocabulary SET recommended = '[{"key":"voice","label":"音色/环境音参考","required":false}]'::jsonb
  WHERE id = 'audio' AND recommended = '[]'::jsonb;

-- =====================================================================
-- 2. 版本计划内容替换:删 022 播种的七行(固定 UUID),按
--    docs/design/version-plan.md 写入新内容——release_section 五段
--    (v0.1.x/v0.2.0 已发布、v0.2.x 进行中、v0.3.0 下一档、v0.4+ 候选)
--    + release_history_entry 三条(新发布在前)。
--    卡片新增可选字段 reason(起因,前台可见)与 basis(依据,入库供运营
--    与管理界面追溯,前台不渲染);历史条目 v0.1.2/v0.1.1 内容沿用 022 原文。
-- =====================================================================
DELETE FROM {{schema}}.config_entries WHERE id IN (
  '826696a5-5179-402a-89cf-51d0a630bf70',
  '2e8c9bc0-8e4c-481c-a2e3-0a0e12e01d10',
  '849962d1-bbb0-4767-b0da-2a368846cd73',
  '715ee032-6831-4626-bac0-832de8806a10',
  '41e37609-fc06-4ed3-a6ad-8dc9f02d8c4b',
  'd6f71004-0772-4b7a-b7d8-fba17dc9c306',
  '17d7f449-f776-4e11-914c-19e180abfc5c'
);

INSERT INTO {{schema}}.config_entries (id, kind, entry_key, status, sort, payload, source) VALUES
  ('0f3c2a71-6b4d-4e1a-9c52-7d8b3f1a5e60', 'release_section', 'v0.1.x', 'published', 1, '{"title":"v0.1.x","status":"live","note":"从零到「能跑通一集戏」。","cards":[{"id":"core-domain","title":"核心域打底","tagline":"项目、分镜、资产、用户会话、生成请求与产物，一次搭好。","status":"live","category":"feature","release":"v0.1.x","basis":"迁移 001"},{"id":"generation-quotes","title":"生成报价与策略","tagline":"生成前先报价，默认策略后台下发。","status":"live","category":"feature","release":"v0.1.x","basis":"迁移 002、005"},{"id":"director-console","title":"导演台","tagline":"场次与分镜的导演视角。","status":"live","category":"feature","release":"v0.1.x","basis":"迁移 004"},{"id":"review-domain","title":"审核域","tagline":"资产审核状态机，全局审核动作留痕。","status":"live","category":"feature","release":"v0.1.x","basis":"迁移 007、009"},{"id":"reference-tests","title":"参考测试","tagline":"同一剧本多模型对比试产。","status":"live","category":"feature","release":"v0.1.x","basis":"迁移 008"},{"id":"admin-console","title":"管理控制台","tagline":"管理员用户操作、反馈事件收口。","status":"live","category":"feature","release":"v0.1.x","basis":"迁移 010、011"},{"id":"cli-compat","title":"命令行兼容","tagline":"Agent 侧命令行的调用契约。","status":"live","category":"feature","release":"v0.1.x","basis":"迁移 003"},{"id":"audit","title":"审计","tagline":"Agent 消息审计留痕。","status":"live","category":"feature","release":"v0.1.x","basis":"迁移 006"}]}'::jsonb, 'seed-024'),
  ('1a4d3b82-7c5e-4f2b-8d63-8e9c4a2b6f71', 'release_section', 'v0.2.0', 'published', 2, '{"title":"v0.2.0","status":"live","note":"从「能生成」到「能交付且算得清账」。","cards":[{"id":"control-packages","title":"控制包","tagline":"把一次生产的输入约束打包管理。","status":"live","category":"feature","release":"v0.2.0","basis":"迁移 013"},{"id":"ai-gateway","title":"统一 AI 网关","tagline":"所有模型调用走一个口子，可计量可限额。","status":"live","category":"feature","release":"v0.2.0","basis":"迁移 014"},{"id":"operations-base","title":"运营底座","tagline":"平台角色、成本口径、运营视图。","status":"live","category":"feature","release":"v0.2.0","basis":"迁移 016"},{"id":"hybrid-search","title":"混合检索","tagline":"资产按语义加关键词混合搜。","status":"live","category":"feature","release":"v0.2.0","basis":"迁移 017 + pg_trgm"},{"id":"topic-radar","title":"选题雷达","tagline":"外部热度信号接入（付费源，默认关闭）。","status":"live","category":"feature","release":"v0.2.0","basis":"迁移 018"},{"id":"review-gate","title":"产物审核与交付门禁","tagline":"未过审的产物出不了门。","status":"live","category":"feature","release":"v0.2.0","basis":"迁移 019"},{"id":"vocabulary-open","title":"创作词表化","tagline":"创作类词汇从写死枚举改为词表，不发版即可扩。","status":"live","category":"feature","release":"v0.2.0","basis":"迁移 020"},{"id":"voice-workshop-1","title":"声音工坊一期","tagline":"配音链路一期。","status":"live","category":"feature","release":"v0.2.0"},{"id":"media-registration","title":"素材注册","tagline":"供应商侧素材登记与血缘。","status":"live","category":"feature","release":"v0.2.0","basis":"迁移 012、015"}]}'::jsonb, 'seed-024'),
  ('2b5e4c93-8d6f-4a3c-9e74-9f0d5b3c7a82', 'release_section', 'v0.2.x', 'published', 3, '{"title":"v0.2.x","status":"filming","note":"把地基上的裂缝补上——大部分不是新功能，是让前面那些东西站得住。","cards":[{"id":"script-breakdown","title":"剧本拆解","tagline":"一集剧本拆成摘要、场次和有序分镜，角色、场景、道具候选自动列出；先进草稿区，人工确认才转正。","status":"filming","category":"feature","release":"v0.2.x","reason":"团队旧系统合流时吸收进来的能力。"},{"id":"env-governance","title":"环境规矩立起来","tagline":"开发、测试、生产三套环境定标准；账号权限分级，凭据登记造册。","status":"filming","category":"improvement","release":"v0.2.x","reason":"2026 年 7 月，测试环境一度连不上数据库。"},{"id":"config-source","title":"内容改起来不发版","tagline":"版本计划、创作词表、运营参数搬进后台可改的配置，页面从接口读取。","status":"filming","category":"improvement","release":"v0.2.x","reason":"这份版本计划能不改代码就更新，靠的就是这项改造。"},{"id":"dev-env-one-command","title":"开发环境一键起","tagline":"一条命令把本地开发环境装到能登录，数据库和示例数据一次到位。","status":"filming","category":"improvement","release":"v0.2.x","reason":"此前没有独立开发环境，人人直连共享云库。"},{"id":"db-engineering","title":"数据库体检常态化","tagline":"结构变更自动体检、与代码定义比对、示例数据集，全部自动化。","status":"filming","category":"improvement","release":"v0.2.x","reason":"数据库层出的问题，此前没有一条是自动发现的。"},{"id":"config-honesty","title":"配置有问题亮红灯","tagline":"启动时先自检配置，不对劲直接拒绝启动；就绪检查核对数据结构版本。","status":"filming","category":"improvement","release":"v0.2.x","reason":"健康检查、就绪检查、登录曾经同时失灵，没一个说真话。"},{"id":"asset-kind-vocabulary","title":"资产类型不再写死","tagline":"资产类型从写死的枚举改为可维护的词表加别名表，前端后端同一份。","status":"filming","category":"improvement","release":"v0.2.x","reason":"写死的枚举挡不住新叫法，界面已经自己长出了别名。"},{"id":"tag-system","title":"标签体系","tagline":"资产可以挂多个标签，标签有词表，允许别名并存。","status":"filming","category":"feature","release":"v0.2.x","reason":"归类该软——一份资产不该只进一个格子。"},{"id":"contract-validation","title":"授权信息写库先校验","tagline":"授权与元数据字段写入前必须过校验，存量数据做一次全量体检。","status":"filming","category":"improvement","release":"v0.2.x","reason":"商用授权字段疑似只有类型没有校验，属合规风险。"},{"id":"merge-wave-1","title":"旧系统数据迁入","tagline":"团队旧系统的数据以实体为单位合并进来，不先合并分类体系。","status":"filming","category":"feature","release":"v0.2.x","reason":"吸收团队旧系统的活数据。"},{"id":"cost-metric","title":"成本口径","tagline":"补「每过审镜头成本」，审核状态归并成三态统计，账算得清。","status":"filming","category":"improvement","release":"v0.2.x","reason":"对齐一个能对外解释的成本口径。"}]}'::jsonb, 'seed-024'),
  ('3c6f5da4-9e7a-4b4d-af85-0a1e6c4d8b93', 'release_section', 'v0.3.0', 'published', 4, '{"title":"v0.3.0","status":"scheduled","note":"后期链路——当前最大的空白：没有时间线、剪辑、字幕、导出，一集戏做到最后还得下载素材去别的软件里拼。","cards":[{"id":"timeline-workbench","title":"时间线工作台","tagline":"分镜按序排上时间线，可调时长与顺序。","status":"scheduled","category":"feature","release":"v0.3.0","basis":"性能设计参考 Clypra：filmstrip 密度分级、atlas 打包降 IPC、decoder 预热、GOP 内前向解码降 seek"},{"id":"editing-transitions","title":"剪辑与转场","tagline":"基础剪辑、转场、音画对齐。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"subtitles","title":"字幕","tagline":"字幕生成、样式、烧录。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"final-export","title":"成片导出","tagline":"一键出成片，走交付门禁。","status":"scheduled","category":"feature","release":"v0.3.0","basis":"依赖 v0.2.x 的产物审核"},{"id":"relation-system","title":"关系体系","tagline":"资产之间的关系有定义、有方向，可自动校验。","status":"scheduled","category":"feature","release":"v0.3.0","basis":"关系属不变量，分类不属于（asset_links + relation_vocabulary）"},{"id":"continuity","title":"角色一致性","tagline":"跨镜头人物一致性。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"style-reference","title":"参考调控与风格参考","tagline":"用参考图控制生成风格。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"image-inpaint","title":"图片局部编辑","tagline":"局部重绘。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"canvas-workbench","title":"画布工作台","tagline":"自由画布式编排。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"motion-replica","title":"动作复刻","tagline":"动作迁移。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"skill-library","title":"拍法技能库","tagline":"可复用的拍法预设。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"book-breakdown","title":"拆书定妆","tagline":"从书到人设定妆。","status":"scheduled","category":"feature","release":"v0.3.0"},{"id":"rbac-teams","title":"团队协作与权限","tagline":"组织、角色与权限体系。","status":"scheduled","category":"feature","release":"v0.3.0","basis":"旧系统合流吸收项，架构级新增；当前版本完全没有多租户。"}]}'::jsonb, 'seed-024'),
  ('4d7a6eb5-af8b-4c5e-b096-1b2f7d5e9c04', 'release_section', 'v0.4+', 'published', 5, '{"title":"v0.4 及以后","status":"vision","note":"候选方向，看准了再定档。","cards":[{"id":"model-catalog","title":"模型目录","tagline":"每个模型能做什么、是否可用，编目在案，定价有据可依。","status":"vision","category":"feature","release":"未定档"},{"id":"voice-clone","title":"语音克隆","tagline":"声音工坊二期：为角色克隆指定声音。","status":"vision","category":"feature","release":"未定档"},{"id":"ip-plaza","title":"IP 广场","tagline":"手握 IP 不知道拍什么？中文在线 IP 库进平台，选 IP 直接开项目。","status":"vision","category":"feature","release":"未定档"},{"id":"distribution","title":"投放分发","tagline":"做完剧还要一个个平台传？多渠道一键分发，投流数据回看。","status":"vision","category":"feature","release":"未定档"},{"id":"real-person-ip","title":"真人 IP 资产","tagline":"演员形象授权难管理？真人分身入库，授权范围与期限留痕，跨剧复用。","status":"vision","category":"feature","release":"未定档"},{"id":"phone-camera-motion","title":"手机实拍运镜","tagline":"手持感和真实抖动没法用嘴描述？——手机录制真实相机运动，导入导演台回放成运镜参考。","status":"vision","category":"feature","release":"未定档"}]}'::jsonb, 'seed-024'),
  ('5e8b7fc6-b09c-4d6f-c1a7-2c3a8e6f0d15', 'release_history_entry', 'v0.2.0', 'published', 1, '{"date":"2026-07-26","title":"能交付，也算得清账","items":[{"label":"控制包","category":"feature"},{"label":"统一 AI 网关","category":"feature"},{"label":"运营底座","category":"feature"},{"label":"混合检索","category":"feature"},{"label":"选题雷达","category":"feature"},{"label":"产物审核与交付门禁","category":"feature"},{"label":"创作词表化","category":"feature"},{"label":"声音工坊一期","category":"feature"},{"label":"素材注册","category":"feature"}]}'::jsonb, 'seed-024'),
  ('6f9c80d7-c10d-4e7a-d2b8-3d4b9f701e26', 'release_history_entry', 'v0.1.2', 'published', 2, '{"date":"2026-07-23","title":"版本预告四卡全量上线","items":[{"label":"生成主链四合同冻结","category":"improvement"},{"label":"TOS CORS 修复","category":"fix"}]}'::jsonb, 'seed-024'),
  ('70ad91e8-d21e-4f8b-e3c9-4e5c0a812f37', 'release_history_entry', 'v0.1.1', 'published', 3, '{"date":"2026-07-22","title":"首个可用版本","items":[{"label":"登录","category":"feature"},{"label":"项目管理","category":"feature"},{"label":"生产链（图片真跑验证）","category":"feature"},{"label":"资产中心","category":"feature"},{"label":"3D 导演台","category":"feature"},{"label":"消耗记账","category":"feature"}]}'::jsonb, 'seed-024')
ON CONFLICT (kind, entry_key) DO NOTHING;
