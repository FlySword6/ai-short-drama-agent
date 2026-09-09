-- 0.2.x 配置真源:软配置统一入库(S23),首个迁入对象=版本计划与版本预告。
-- 真源依据:任务包 kimi-goal-s23-config-source-of-truth-20260726(DC:「代码里不能写死」);
-- R9(docs/contracts/platform-ontology.md):治理字段固定(类型/状态/时间/来源/负责人),
-- 分类与标签放 payload,允许多值与别名并存,不强行唯一归类。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 全部语句幂等,可安全重放(CREATE IF NOT EXISTS / ON CONFLICT DO NOTHING)。
--
-- 回滚口径:本表独立无外部依赖,旧代码不读取,可保留;确需回滚由 DBA 手工
--   DROP TABLE {{schema}}.config_entries(DROP 前确认库内运营改动已导出,种子不背锅)。
--
-- 播种口径:七行种子=迁移时刻设置页写死内容的逐字拷贝(生成自
--   frontend/shortdrama-rag-demo/src/pages/settings-page.tsx,未改一字)。
--   ON CONFLICT (kind, entry_key) DO NOTHING:种子只在首次播种时写入,
--   之后库内修改以库为准,重放迁移或再次部署不会覆盖运营改动。

-- =====================================================================
-- 1. config_entries:软配置统一真源表。
--    治理字段(固定,走代码评审才可变):kind 类型 / status 状态 /
--    created_at,updated_at 时间 / source 来源 / created_by,updated_by 负责人。
--    内容字段(软,运营可改):entry_key 业务键 / sort 排序 / payload 内容。
--    payload 的键一律 snake_case,与线上 JSON 合同同形(响应层做递归 snake)。
-- =====================================================================
CREATE TABLE IF NOT EXISTS {{schema}}.config_entries (
  id uuid PRIMARY KEY,
  kind varchar(64) NOT NULL,
  entry_key varchar(128) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'published',
  sort int NOT NULL DEFAULT 0,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source varchar(64) NOT NULL DEFAULT 'admin',
  created_by uuid REFERENCES {{schema}}.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES {{schema}}.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_entries_kind_key_unique UNIQUE (kind, entry_key),
  CONSTRAINT config_entries_status_check
    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT config_entries_kind_check
    CHECK (kind ~ '^[a-z][a-z0-9_]{1,62}$')
);

CREATE INDEX IF NOT EXISTS config_entries_kind_status_sort
  ON {{schema}}.config_entries (kind, status, sort);

-- =====================================================================
-- 2. 播种版本计划与预告:release_section 五段(每段 payload 内含卡片数组,
--    卡片顺序即数组顺序)+ release_history_entry 两条(新发布在前)。
--    entry_key=档期版本号(远景段为 'vision');sort=展示顺序。
--    id 用固定 UUID(仓内约定:主键无默认,一律由写入方显式给出;
--    固定值同时让重放完全确定)。
-- =====================================================================
INSERT INTO {{schema}}.config_entries (id, kind, entry_key, status, sort, payload, source) VALUES
  ('826696a5-5179-402a-89cf-51d0a630bf70', 'release_section', 'v0.1.2', 'published', 1, '{"title":"v0.1.2","status":"live","note":"首个正式版。","cards":[{"id":"pro-polish","title":"界面专业化","tagline":"界面粗糙、术语看不懂？——全站按行业惯用语重做：品牌定稿、参数档位化、消耗逐笔可查。","status":"live","category":"improvement","release":"v0.1.2"},{"id":"director-embed","title":"导演台直通工作台","tagline":"摆完机位还要跳页搬文件？——导演台就在工作台页签里，机位图、运镜小样、深度图一键归组直接用。","status":"live","category":"feature","release":"v0.1.2"},{"id":"asset-library","title":"资产库全量可用","tagline":"素材散落各处找不到？——519 件素材可搜索、可引进项目、可 @ 进提示词。","status":"live","category":"improvement","release":"v0.1.2"},{"id":"review-desk","title":"审核台","tagline":"审核靠口头、出了问题无痕？——批量提审，审核人与拒绝理由留痕。","status":"live","category":"feature","release":"v0.1.2"}]}'::jsonb, 'seed-023'),
  ('2e8c9bc0-8e4c-481c-a2e3-0a0e12e01d10', 'release_section', 'v0.1.3', 'published', 2, '{"title":"v0.1.3","status":"filming","note":"体验打磨与自助管理。","cards":[{"id":"ux-comfort","title":"操作手感","tagline":"信息太挤、点了没反应？——按大家熟悉的使用习惯重排界面，操作有反馈，跳转不丢上下文。","status":"filming","category":"improvement","release":"v0.1.3","teaser":"操作有反馈，跳转不丢上下文"},{"id":"smart-search","title":"搜得懂人话","tagline":"搜资产必须打准关键词？——一个搜索框，名字、描述、意思相近都能命中，搜音色一样好使。","status":"filming","category":"improvement","release":"v0.1.3","teaser":"一个框，打啥都能搜到"},{"id":"preview-room","title":"模型对比试产","tagline":"不知道哪个模型效果好？——同一剧本多模型各出一条，小成本试出最优配置，一键设为默认。","status":"filming","category":"feature","release":"v0.1.3","teaser":"小成本试出最优配置，一键设为默认"},{"id":"producer-console","title":"管理控制台","tagline":"改个配置还要找运维？——模型接入、账号开通、复核阈值，管理员自助。","status":"filming","category":"feature","release":"v0.1.3","teaser":"管理员自助配置"}]}'::jsonb, 'seed-023'),
  ('849962d1-bbb0-4767-b0da-2a368846cd73', 'release_section', 'v0.2', 'published', 3, '{"title":"v0.2","status":"scheduled","note":"接口冻结在前，执行链验证在后。","cards":[{"id":"pi-collab","title":"Pi 协作","tagline":"拆剧本、备参考太费手？——对话说清楚，Pi 帮你备好；付费生成永远由你亲手点。","status":"scheduled","category":"feature","release":"v0.2","teaser":"对话拆剧本、提前备好参考、@素材直达提示词"},{"id":"command-k","title":"Cmd+K 命令面板","tagline":"找功能翻半天菜单？——一个快捷键，搜索、跳转、常用动作直达。","status":"scheduled","category":"feature","release":"v0.2","teaser":"一个快捷键直达一切"},{"id":"live-action","title":"实拍混排","tagline":"实拍剧组用不上 AI 平台？——实拍片段直接上传混排，AI 只补高成本镜头。","status":"scheduled","category":"feature","release":"v0.2","teaser":"实拍片段直接传，AI 只补高成本镜头"},{"id":"topic-radar","title":"选题雷达","tagline":"拍什么全靠拍脑袋？——红果热榜实时数据进平台，什么题材在爆一眼看到。","status":"scheduled","category":"feature","release":"v0.2","teaser":"热榜选题，有据可依"}]}'::jsonb, 'seed-023'),
  ('715ee032-6831-4626-bac0-832de8806a10', 'release_section', 'v0.3', 'published', 4, '{"title":"v0.3","status":"concept","note":"只立方向，不承诺档期。","cards":[{"id":"control-board","title":"参考调控","tagline":"参考图到底起没起作用？——每份参考的作用可见、可调。","status":"concept","category":"feature","release":"v0.3","teaser":"每份参考起了多大作用，可见可调"},{"id":"continuity","title":"角色一致性","tagline":"换一个镜头就换脸？——跨镜头锁定角色、光线、道具。","status":"concept","category":"feature","release":"v0.3","teaser":"跨镜头锁定角色、光线、道具"},{"id":"controlled-edit","title":"受控编辑","tagline":"只想改光线却要整段重来？——锁住不想变的，只改你声明的部分。","status":"concept","category":"feature","release":"v0.3","teaser":"锁住不想变的，只改声明的部分"},{"id":"canvas-workbench","title":"画布工作台","tagline":"页签来回切很割裂？——素材和参考摆上一张画布，连线就是引用。","status":"concept","category":"feature","release":"v0.3","teaser":"一张画布，连线即引用"},{"id":"script-workshop","title":"剧本工坊","tagline":"剧本还要去别的软件写？——平台内写剧本，AI 拆书报告+剧本评分，写完直接拆成项目草稿。","status":"concept","category":"feature","release":"v0.3","teaser":"写剧本、拆书、评分一条龙"},{"id":"motion-replica","title":"动作复刻","tagline":"想要的动作只有真人视频里有？——上传参考视频，便宜模型转成绿幕白模动作小样，动作留下、原片人物不带走。","status":"concept","category":"feature","release":"v0.3","teaser":"真人视频转白模动作参考"},{"id":"image-inpaint","title":"图片局部编辑","tagline":"改一处要重画整张？——在图上涂一下，说一句怎么改，只动你指的地方，还能把参考素材放进选区。","status":"concept","category":"feature","release":"v0.3","teaser":"涂哪改哪，局部重画"},{"id":"book-breakdown","title":"拆书定妆","tagline":"剧本有了，角色长什么样全靠抽卡？——AI 读剧本提出角色、场景、道具清单，像选角导演一样追问你要的感觉，每个资产出多版候选，选定即入库。","status":"concept","category":"feature","release":"v0.3","teaser":"拆书提资产，定妆再开拍"},{"id":"style-reference","title":"风格参考控制","tagline":"全片色调忽冷忽热、镜头味道说变就变？——色卡、光影、摄影质感做成风格参考，一次设定，整部剧一个味，每个分镜自动带上。","status":"concept","category":"feature","release":"v0.3","teaser":"定一次风格，整部剧不跑味"},{"id":"skill-library","title":"拍法技能库","tagline":"看到好的风格只能截图收藏？——韦斯安德森美学、女频爆款节奏这样的拍法打包成技能，一键套用到你的剧。","status":"concept","category":"feature","release":"v0.3.x","teaser":"好拍法，拿来就用"}]}'::jsonb, 'seed-023'),
  ('41e37609-fc06-4ed3-a6ad-8dc9f02d8c4b', 'release_section', 'vision', 'published', 5, '{"title":"远景","status":"vision","note":"看准了再定档。","cards":[{"id":"ip-plaza","title":"IP 广场","tagline":"手握 IP 不知道拍什么？中文在线 IP 库进平台，选 IP 直接开项目。","status":"vision","category":"feature","release":"未定档"},{"id":"distribution","title":"投放分发","tagline":"做完剧还要一个个平台传？多渠道一键分发，投流数据回看。","status":"vision","category":"feature","release":"未定档"},{"id":"real-person-ip","title":"真人 IP 资产","tagline":"演员形象授权难管理？真人分身入库，授权范围与期限留痕，跨剧复用。","status":"vision","category":"feature","release":"未定档"},{"id":"phone-camera-motion","title":"手机实拍运镜","tagline":"手持感和真实抖动没法用嘴描述？——手机录制真实相机运动，导入导演台回放成运镜参考。","status":"vision","category":"feature","release":"未定档"}]}'::jsonb, 'seed-023'),
  ('d6f71004-0772-4b7a-b7d8-fba17dc9c306', 'release_history_entry', 'v0.1.2', 'published', 1, '{"date":"2026-07-23","title":"版本预告四卡全量上线","items":[{"label":"生成主链四合同冻结","category":"improvement"},{"label":"TOS CORS 修复","category":"fix"}]}'::jsonb, 'seed-023'),
  ('17d7f449-f776-4e11-914c-19e180abfc5c', 'release_history_entry', 'v0.1.1', 'published', 2, '{"date":"2026-07-22","title":"首个可用版本","items":[{"label":"登录","category":"feature"},{"label":"项目管理","category":"feature"},{"label":"生产链（图片真跑验证）","category":"feature"},{"label":"资产中心","category":"feature"},{"label":"3D 导演台","category":"feature"},{"label":"消耗记账","category":"feature"}]}'::jsonb, 'seed-023')
ON CONFLICT (kind, entry_key) DO NOTHING;
