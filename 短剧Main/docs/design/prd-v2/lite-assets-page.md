# Lite 素材页 PRD（产品规格 + 交互线框）

> 本文件是 Lite 素材页的**唯一产品真源**，合并了原 `lite-assets-tab-modification-plan.md`（产品决定）和 `lite-assets-page-wireframe.md`（交互线框）。AI 模型开发代码时读本文件即可，不需要跨文件拼上下文。

## 版本历史

| 版本 | 日期 | 变更摘要 |
|---|---|---|
| v1.0 | 2026-08-10 | 初版：tab 列表、详情页、弹窗 A/B、materialize 五类、分镜引用 |
| v1.1 | 2026-08-11 | 补充线框交互（三段式布局、空状态、lightbox）；模型/比例选择器拆为两个级联下拉 |
| v1.2 | 2026-08-12 | **修正变体逻辑**：`new_variant` 模式现在真正创建 `asset_variants` 行（调 `POST /api/v1/assets/:id/variants`），不再只给同一实体加图。上传图可挂到特定变体（`asset_variant_id` 不再硬编码 null）。详情页变体 tab 从装饰性改为按变体筛选图片（「全部」+ 每个变体各显示 own 图片）。版本图轨返回 `variant_id` 字段。 |
| v1.3 | 2026-08-12 | **首发反馈迭代**（详见"问题五"）：一键生成本集解析 description 改为"资产特点提炼"而非原文，并落库集/分镜/场景导航信息；修正服装/音频仍抽不出来的问题；弹窗 A（新建资产）补齐 AI 生成/上传首图；重构变体语义——脚本解析自动创建第一个变体、首图自动设主图、支持删版本图与删变体、外层展示第一个变体的主图；右侧关联分镜改为变体级多条目表单（多集/多分镜/多场景），含后端改动；新建变体弹窗文件选择展示缩略图+文件名且可删除。 |
x1.3.1 | 2026-08-13 | **首发修复迭代**（详见"问题六"）：①一键生成本集第 2 集失败根因 = AI 网关瞬时故障（`ai_service_unavailable`），非代码缺陷，重试即可；确认并固化重跑幂等口径（资产：相同不覆盖不删除、只补缺失；分镜：每次重跑覆盖重写）。②修复版本图轨 `variant_id` 字段实际未下发导致变体下图片不显示的缺陷（v1.2 声称已返回，但路由映射漏字段，前端按变体过滤后恒为空）；③变体列表排序补 `created_at` 兜底，消除同 `sort_order` 变体顺序抖动（"变体消失/换位"）；④无变体资产（历史/手动）首次上传图自动创建第一个变体并落图，统一"首图落在第一个变体上"（覆盖脚本解析/手动新建/历史资产三来源）；⑤关联分镜点击不再跳转分镜页；⑥出现记录场景名按用户输入回显（`scene_names[0]` 优先），不再被解析后的英文场景名覆盖；⑦已生成集保留常驻"重新生成本集"入口，点击弹二次确认（覆盖现有分镜、素材只补缺失不删除），确认后走同一重跑流程。 |
| v1.3.2 | 2026-08-13 | **默认提示词模板入库**（详见 `docs/design/prd-v2/lite-model-defaults.md` §7）：把资产生图 `image_prompt` 默认模板与视频 `video_prompt` 默认模板两条作为**默认配置**注入数据库（迁移 064 新建平台级 `prompt_default_templates` 表并播种，任何本地环境 `npm run db:migrate` 后即存在）；`GET /generation/default-prompt-templates` 改读该表、缺行回落代码常量。默认配置全文见 `lite-model-defaults.md` §7.4。 |
| v1.4 | 2026-08-17 | **资产页视觉与生成配置迭代**（详见"问题七"）：①素材列表卡片收窄（网格最多 5-6 列、图片方形）；②详情页左栏去掉 sticky 主图大卡，只留变体卡片网格，看图一律点击进 lightbox；③明确 AI 生图配置与提示词合同：默认从项目配置读取，模型/画幅/清晰度弹窗内可临时改（选项=全部 active 档）；提示词 = 项目默认风格模板 + 资产描述/备注 + 类型子模板。**零数据库迁移。** |
| v1.5 | 2026-08-17 | **变体级动态匹配（建议）**（详见"问题八"）：剧本未点名的人工变体（如「xxx-泳装」）无法被现有精确名 backfill 匹配，新增「✨ 匹配剧集」按钮——变体级、AI 给建议不自动写、manual 永不被覆盖、命中集与 shot 候选去重防止同一镜多绑；零数据库迁移。 |
| v1.6 | 2026-08-17 | **匹配流程统一修正**（合同见问题八 8.8，实现清单与数据库影响见 8.9）：明确匹配方向 = 资产侧声明（集、分镜、场景）→ 分镜，分镜不反向匹配资产；一键生成本集 backfill、AI 匹配、手动关联三路同形——都落「集 · 分镜号 · 场景名」三要素并解析到真实 shot，同幂等键 `(shot_id, variant_id)`，manual 永不被覆盖；用户可手动修改资产/变体的集分镜场景后重新关联到具体分镜。**零数据库迁移。** |
| v1.7 | 2026-08-17 | **路径①自动匹配变体级兼容**（详见"问题八 八.10"）：一键生成本集 backfill 从「资产名 × 第一变体」升级为两层——确定性层不变，新增变体语义层（变体名/别名 vs 分镜 subject/visual/script_text 保守命中），一集内不同分镜自动落不同变体；仍 `matched_by: "exact_name"`、manual 永不被覆盖、只增不删；补齐 T5.6 缺失的 `shots.metadata.lite.removedAutoRefs` 抑制名单。**零数据库迁移。** |
| v1.8 | 2026-08-18 | **首发走查修正四问**（详见"问题九"）：①素材列表/项目列表页根容器补内层滚动容器，修复 `h-dvh overflow-hidden` 壳下底部被遮挡、页面不能滚动；②登记积分涉及的表（`user_credit_accounts` 等五组，迁移 034）与本地加积分路径（管理台调账 / SQL），明确价格按档走 `pricing_rules`（1K=30、2K=60、suchuang 网关 8 积分/张等）不是恒定 60 积分/张，Lite 弹窗删除积分价签（只删展示不删计费）；③详情页顶部「管理图片」改名「新建资产」（只改文案，行为不变，仍开弹窗 B add_image）；④基础信息三字段收敛为一对保存/取消，出现记录表单删掉变体下拉（含「资产级关联(不指定变体)」选项），新记录恒挂当前选中变体。**零数据库迁移。** |
| v1.9 | 2026-08-18 | **二版走查修正十问**（详见"问题十"）：①资产可软删（R1 合规）；②详情页顶部按钮退役；③弹窗 B 生成期间不关闭（轮询终态）；④变体删除入口常驻；⑤失败卡 10s 自动确认消退；⑥成功才扣积分（迁移 068）；⑦Lite 自动确认并入 submit；⑧estimate 503=环境开关与目录口径不一致（本机已对齐）；⑨**删除入口收口到素材列表资产卡**（二次确认；详情页顶删除退役）；⑩**变体级归属**：生成请求带 `target_asset_variant_id`（迁移 069），从哪个变体发起产物就挂哪个变体，素材轨按发起变体归属（缺省回落第一变体）。 |
| v2.0 | 2026-08-18 | **删除资产生图提示词的「类型子模板」段**（前端硬编码 `ASSET_TYPE_TEMPLATES` 常量整体移除）：提示词拼接合同收敛为两段 = 项目默认风格模板 + 资产名称/描述/备注（见"问题七"决策 3 修订）。`asset_kind` 仍作为资产元数据与筛选维度存在，只是不再进提示词。**同版本修复「✨ AI 优化」丢模板段**：当前提示词（含项目模板预填段）作为 `supplement` 传入 `/ai/prompt-draft`，单独保留到返回末尾，不再被 AI 优化结果覆盖掉。后端无改动，**零数据库迁移**。 |
| v2.1 | 2026-08-18 | **删除二次确认改自定义弹窗**（详见"问题十"十.10）：资产卡/变体/媒体/模板/风格的删除确认从浏览器原生 `window.confirm` 换为壳层 `Dialog` 自定义确认组件（`lite-confirm-dialog.tsx`，danger 主钮 + busy 禁用 + 遮罩点击不关）。**零数据库迁移。** |
| v2.2 | 2026-08-18 | **AI 优化输出不再分五段标签**：`POST /ai/prompt-draft` 由「AI 返回五层 JSON → 服务端拼【画面元素】等五段」改为「AI 直接输出一段完整生图提示词文本 → 服务端原样返回」。`prompt_text` = AI 提示词原文 + `supplement` 无标签追加到末尾；响应去掉结构化 `draft` 字段（`composePromptText` 与 `PromptDraft` 类型移除），接口形状其余不变，前端各调用方（资产弹窗/分镜工作台/视频草稿/按描述生成）只消费 `prompt_text` 无感。后端 service/routes/types 与测试同步。**零数据库迁移。** |
| v2.3 | 2026-08-18 | **「✨ AI 优化」输入结合项目默认风格与图片生成模板**：`POST /ai/prompt-draft` 服务端读取 `projects.image_style_description`（默认风格镜像列，与生成期 `compileAutoPrompt` 同源）注入 AI 输入创作上下文 `visual_style`；图片生成模板经前端预填随 `supplement` 进入输入，system/prompt 措辞调整为「模板构图、媒介、比例等指令须融入输出，不整段逐字复制」。AI 优化/起草结果由此体现项目默认视觉基调。**零数据库迁移。** |
| v2.4 | 2026-08-18 | **传给模型的输入通顺化 + 名称独立传达**：`POST /ai/prompt-draft` 的 prompt 由「任务/分镜生产意图/已选资产/创作上下文/…」九段机械拼接改为分项自然语言（「本次要生成的内容：名称 / 画面描述 / 补充备注」+「生成时必须落实：项目默认图片风格 / 项目图片生成模板 / 已选资产 / 创作上下文」，无值项行省略）。前端把弹窗「名称」独立为请求体可选 `name`（≤200 字符）传达（原先与描述合并进 `description`），`description` 只承载画面描述，`supplement` 仍承载备注；服务端按 `name`/`description`/`supplement` 分项呈现给模型。 |
| v2.5 | 2026-08-18 | **new_variant 仅首变体预填（走查裁定，修订问题七决策 3 / T3.10）**：弹窗 B `new_variant` 模式不再恒空白——资产当前无任何变体（=本次创建的是第一个变体）时预填资产名称/描述/备注并预填提示词（项目默认风格模板 + 资产信息）；资产已有变体时仍表单空白由用户自填。详情页按 `variants.length === 0` 传 `noExistingVariant`；同步修复 `syncNewVariantNote` 只回写用户改动值，避免非首变体空白表单把资产已有备注清空。**零数据库迁移。** |
| v2.6 | 2026-08-18 | **音频生成与展示完整改造（详见"问题十一"）**：①列表卡 + 详情页正确展示音频资产——列表 SpeakerHigh 图标、详情 `<audio>` 播放、音频版本轨、主音频/设为主音频、format 展示；②版本轨数据层补 `media_kind`/`format`（`LiteAssetVersionTrackItem` + `listAssetVersionTrack`，前端 `liteListVersionTrack` 映射补齐）；③弹窗 B 音频生成模式——纯 AI 生成（隐藏「本地上传」tab，后端 `/assets/:id/media` 只收图片）、音色下拉 + 试听（`GET /api/v1/audio/voices`）、`reference_media_ids: []`（音频不引用参考素材）、未选音色校验「请选择音色」、提示词标签「音频文本」、按钮「合成并保存」；④配置页音频档（A. 扩展合同）——`generation-defaults` 支持 audio（media_kind CHECK 加 `'audio'`、mode 加 `text_to_speech`，**迁移 071**），保存项目默认音频档（`model_key`）+ 默认音色（`parameters.speaker_id`），维度仅模型（时长是档冻参数 `original_duration_seconds`），无模板/风格概念，弹窗 B 打开时按默认策略预填音色。 |

## 目标

Lite 的素材页要从“剧本解析后的一组资产卡片”升级为“按素材类型管理、可进入详情、可生成/上传/登记图片版本、可被分镜引用”的资产工作台。

本方案只改 Lite 界面和 Lite BFF，仍然共用现有 PostgreSQL、`asset_entities`、`asset_variants`、`asset_media`、`generation_requests`、`media_results`、`generation_default_strategies`，不引入第二套素材事实源。

## 现状核对

当前 Lite 素材页已经有真实基础，但还没有达到图 1-3 的产品形态：

- 前端 `lite-assets-page.tsx` 当前按纵向分区展示：人物、场景、道具、其他；不是顶部 tab。
- Lite 资产实体化接口是 `POST /api/v1/projects/:project_id/lite/assets/materialize?episode_id=...`，按当前集最新已确认解析结果落资产。
- 当前剧本拆解输出 `AssetCandidates` 含 `characters`、`scenes`、`props`、`costumes`、`audios` 五类（v1.3 扩展）；角色有性别、年龄、外貌等字段，服装有款式/颜色/材质/穿着角色，音频有 `audio_kind`/说话人/对白片段等字段，五类均已进入 materialize 落库流程。
- 当前落资产逻辑把角色、场景、道具、服装、音频五类写入项目资产；其中分镜 backfill 只对拍角色/场景/道具/服装四类（音频不参与分镜匹配），见下节「现状：当前资产↔分镜匹配逻辑」。
- 数据库已有 `asset_entities` 作为资产主表，已有 `asset_variants` 作为变体/版本表，已有 `asset_media`/`media_results` 承载图片结果。
- 数据库已有 `generation_default_strategies`，当前 Lite 配置页把图片模型、尺寸和 `prompt_template` 存在这里；另有 `projects.image_prompt_template` 等历史项目级字段。当前没有独立的“图片提示词模板表”。
- 图片生成已接入模型档体系。现有代码和迁移能看到 Ark/Seedream、Minimax Image / Minimax Audio、OpenAI-compatible/NewAPI 的 `gpt-image-2`/Gemini image，以及 suchuang 图片网关的 `gpt-image-2-suchuang`、`nanobanana-lite`、`nanobanana-2` 价格档。Lite 配置页已经支持按 active 档选择图片模型和参数。

## 现状：当前资产↔分镜匹配逻辑（2026-08-17 代码实际行为）

> 本节回答「现在资产和分镜到底是怎么匹配的」——全部来自 `src/modules/lite/repository.ts` / `service.ts`、`src/modules/script-breakdown/repository.ts` / `mapper.ts`、`src/modules/generation/routes.ts` / `repository.ts` 现行实现，与问题二/三/五里的目标合同对应；问题八在此基础上扩展。

**一句话**：分镜的 `reference_asset_snapshots` 有三条写入路径——① 剧本确认时按「已通过资产 × 精确名称」写无变体快照（`matched_by: "exact_name"`，只作审计溯源，不驱动生成）；② Lite materialize 时按「资产类型+精确名称」对拍分镜候选，写带变体快照（`matched_by: "exact_name"`，永远挂第一个变体）；③ 资产详情页手动关联（`matched_by: "manual"`，可挂任意变体）。生成时只消费**带 `variant_id` 的快照**，取各变体主图入参考媒体；无变体快照不参与媒体选取。

### 路径① 剧本确认时的无变体快照（script-breakdown confirmRun 触发）

- **触发**：`script_breakdown` 确认事务（`confirmRun`）落分镜时，`mapper.collectReferenceSnapshots` / `repository.buildCurrentAssetSnapshots` 随 shot 插入同步写入。
- **匹配键**：`(kind, name)` 与**当前已通过的项目资产**（`ApprovedAssetSummary`）精确对拍，kind 只覆盖 `character / scene / prop / costume`（audio 无参考数组，不参与）。
- **写入形状**：`{asset_entity_id, name, asset_kind, matched_by: "exact_name"}`——**不含 `variant_id`**。因此它只是「那一刻的匹配审计快照」，生成参考媒体选取直接跳过它（见路径④）；Lite materialize 的带变体快照与它按 `(asset_entity_id, variant_id)` 区分并存，互不覆盖。

### 路径② materialize backfill（自动，带变体）

- **触发**：`POST /lite/assets/materialize?episode_id=` → `materializeAssetCandidates` 事务内，资产落库/合并后调 `backfillShotAssetReferences`。
- **匹配键**：`(asset_kind, name)` 与 confirmed run 的 `shotCandidates` 的 `characterNames / sceneNames / propNames / costumeNames` **精确字符串对拍**（`repository.ts` backfill 的 `references` 数组）。**变体名不参与**；**audio 不参与**（shot candidate 无音频参考数组）。
- **定位真实分镜**：按 `shots.source_candidate_id`（同集内）把候选分镜映射到真实 `shots.id`。
- **写入**：`metadata.lite.usages` 加一条 flat 条目——`matched_by: "exact_name"`、`status: "bound"`、`variant_id = firstVariantId`（永远挂第一个变体）；同时向该 shot 的 `reference_asset_snapshots` push `{asset_entity_id, variant_id: firstVariantId, name, asset_kind, matched_by: "exact_name"}`。
- **幂等**：确定性 `usage_id`（`asset:{assetId}:{variantId}:{episodeId}:{shotNo}:exact_name`）；同 `(shot_id, variant_id, exact_name)` 条目整体替换；同 shot 已有 `manual` 关联（含旧 `{episode_id, shot_ids[]}` 无 matched_by 格式）→ 跳过不覆盖。每镜对同一资产只匹配一次（`seenInShot` 去重）。

### 路径③ manual（手动，保存即解析）

- **触发**：详情页关联分镜表单保存 → `POST /lite/assets/:id/usages`（批量，`addAssetShotUsages` 单事务）。
- **寻址**：每条支持 `shot_id` 直传，或 `(episode_no + shot_no)` + 可选 `scene_name`；后者经 `findShotByLabel` 解析——`shots.sort_order` 优先，回落 `shot_code` / `title` 尾数字，多命中且有 scene_name 时按场景名过滤。
- **命中 → bound**：写 `metadata.lite.usages`（`matched_by: "manual"`、带 `variant_id`）+ 替换该 shot 快照上同 `(asset_entity_id, variant_id)` 对的 manual/exact_name 快照。
- **未命中（集未确认/镜号不存在）→ pending**：`shot_id = null`、`status = "pending"`，不报错、不占位建分镜；目标集 confirm 后按 `(episode_no, shot_no, scene_name)` 补真实 shot_id、回填快照、转 bound（挂钩 `confirmRun` 成功，见 `script-breakdown/repository.ts` 的 `reconcilePendingAssetUsages`）。

### 路径④ 读取（分镜生成消费）

- `POST generations(shot_id=...)` → `generation/routes.ts` `resolveControlReferences` 调 `resolveShotAssetVariantReferences({shotId})`：读该分镜 `reference_asset_snapshots`，收集其中的 `variant_id`（**无 `variant_id` 的快照直接跳过**），对每个变体取 `asset_media.is_primary = true` 且未软删的主图 media id，并入参考清单；变体无主图 → 跳过，不报 500。引用定位的识别键是 `(asset_entity_id, variant_id)` 二元组。
- 生成侧另有一张**可编辑、可查询**的引用真值 `shot_asset_refs`（迁移 065，v1.4）：full/生产路径（`production` 模块）与提示词编译（`generation/repository.ts`）读它；**Lite 模块当前只写 JSON 快照、不写 `shot_asset_refs`**。两者是并行事实源，不要混读。
- **快照冻结**：生成提交时把快照解析成 `reference_media_ids` 落 `generation_requests`，提交后改关联/改主图不影响已提交任务。

### 优先级与边界

- `manual` 永不被 backfill 覆盖；`exact_name` 可被 backfill 更新（资产名变了刷新）。
- backfill 双层（v1.7）：确定性层按资产名挂第一个变体（v1.3）；变体语义层按变体名/别名命中分镜文本、自动落非第一变体（八.10）——一集多变体在路径①即可表达。两层都写 `exact_name`，重跑只增不删、manual 不被覆盖。
- 重跑幂等（v1.3.1）：资产同名同类型不覆盖不删除、只补缺失；分镜/场景每次重跑覆盖重建。
- 候选分镜→真实分镜的对应链：`episodes.id → scenes.episode_id → shots.scene_id`；展示标签「第N集 · 第N个分镜 · 场景名」= `episodes.episode_no` + 分镜序号 + `scenes.name`。
- 三路写入的统一匹配合同（方向修正、三要素、幂等键、优先级与用户问题逐条澄清）见问题八 8.8。

## 问题一：素材页是否应做 tab 区分

结论：应该做。Lite 素材页首页改为图 1 的 tab 型资产面板，顶部 tab 是资产类型导航，列表只显示当前类型。

建议 tab：

- 全部
- 角色
- 场景
- 道具
- 服装
- 音频
- 光线参考
- 摄影参考
- 视频参考

第一期计划由剧本解析自动落库的 tab：

- 角色
- 场景
- 道具
- 服装
- 音频

第一期可先作为”参考配置/上传入口”的 tab（**只支持上传，不支持 AI 生成**）：

- 光线参考
- 摄影参考
- 视频参考

原因：光线、摄影、视频参考更像风格/参考通道，不一定能从单集剧本文本稳定解析成可复用实体；但角色、场景、道具、服装，以及剧本里可直接识别的音频线索（角色对白/旁白、拟声词、环境声、情绪声音提示）都可以成为资产实体。音频又是项目已接入的独立生成能力，应该从一开始就作为一等公民，而不是挂在“其他”里。

音频 tab 建议再拆成子类：

- 角色声音
- 旁白
- 音效
- 环境声
- 其他音频

UI 修改：

- 页头保留“素材”标题和生成配置提示。
- 标题下方增加 tab bar，tab 文案带数量，例如 `角色 8`、`场景 3`。
- 默认进入 `全部`，用户上次选择的 tab 可以存在 URL query：`?asset_tab=character`，不要用 localStorage 当事实源。
- 每个资产卡顶部有 aspect-video 图片占位区（无图时显示图标占位），下方展示名称 + 类型徽记 + 一句话描述。不再渲染状态徽记（出现集/分镜、主图状态、候选图数、是否可引用等）。这些状态由后端在资产详情接口维护，供详情页和分镜引用流程使用，但不进入列表卡渲染，保持列表只做扫读。
- 卡片本身可点击（无单独”查看详情”按钮），点击后导航到独立路由详情页 `/lite/projects/:projectId/assets/:assetEntityId`，承接图 2 的”角色板/资产详情”逻辑；复杂信息、版本、生成、上传、引用关系都放进详情，不放在列表卡上。

### tab 与数据库字段

- 不新增 `asset_tab`、`tab_type` 一类字段。tab 只是前端导航，资产分类唯一使用现有 `asset_entities.asset_kind`。
- `全部` 是不传 `asset_kind` 的聚合视图，不是数据库中的一种资产类型；各 tab 数量由后端按 `asset_kind` 聚合返回。
- `?asset_tab=` 只保存当前界面选择，值必须映射到 `asset_kind`，不能成为业务事实源。
- 不使用 `asset_entities.role` 或 `usage_mode` 代替分类。两者表达的是生成控制角色和引用方式，与角色、场景、道具、服装、音频等资产类型不是同一维度。

### 资产来源

项目资产有两个来源，都写入同一套 `asset_entities`：

1. **剧本解析（materialize）**：用户在剧本页确认某集解析后，从 confirmed run 的 `assetCandidates` 落库。详见"问题二"。
2. **手动新建**：用户在素材页每个 tab 的 `[+ 新建]` 入口，手动填写名称 + 描述 + 备注（三个通用字段，不按类型展示特有字段），可选上传首图、AI 生成首图或跳过。跳过则只建文本资产，进详情页是空状态。类型特有信息（性别/年龄/外貌等）在详情页身份信息面板补充。

手动新建的资产不关联 `script_breakdown_runs`，`metadata.lite.usages` 为空；出现信息随后续 materialize 命中同名同类资产或手动关联时补齐。手动新建是 materialize 的补充，不是替代——剧本里明确写到的资产仍走解析，手动新建主要覆盖剧本未提及但分镜需要的资产（如某个特殊道具、补充角色）。

两种弹窗的区分见 `lite-assets-page-wireframe.md` 第三节：弹窗 A（新增资产）对应手动新建，弹窗 B（给变体加图）对应给已有资产加图。弹窗 B **不展示已有版本列表**（详情页底部版本图区已展示），只聚焦"这次新增一张图"；弹窗 B 顶部展示资产的名称 / 描述 / 备注（从 `asset.name` / `asset.intro` / `metadata.lite.note` 预填），用户可临时调整后带入 AI 生成上下文，改动回写资产。弹窗 B 支持两种模式：`add_image`（给已有变体加图，预填资产信息）和 `new_variant`（新建变体，表单留空由用户填写）。参考图为多图上传区（不区分槽位），用户上传后展示缩略图并支持删除；提示词按 `asset_kind` 预填不同模板。

## 问题二：一键生成本集时如何解析当前集素材并分类

结论：可以，且应该按“当前集 episode_id”解析。当前代码已经有 episode 维度，但解析内容和落库类型要扩展。

### 当前流程

现在 Lite 剧本页提交某一集后，会创建 `script_breakdown_runs`。用户确认解析后，素材页调用：

`POST /api/v1/projects/:project_id/lite/assets/materialize?episode_id=<当前集>`

服务端从该集最新 `status='confirmed'` 的 `script_breakdown_runs.draft.assetCandidates` 读取资产候选，再幂等写入 `asset_entities` 和 `project_asset_refs`。

当前可解析并落库的分类只有：

- character
- scene
- prop

`costume` 和 `audio` 是第一期扩展后的目标类型，不是现有 Lite `materializeAssets` 已支持的真实落库类型。

第一期这里的补充原则是：新增的解析证据和长尾字段优先写入 `script_breakdown_runs.draft_json` / `asset_entities.metadata.lite`，不要先拆成一堆正式列；真正需要高频过滤、排序或跨集统计的字段，后续再单独列化或拆表。

### 修改后的解析分类

扩展 `AssetCandidates`：

- `characters`
- `scenes`
- `props`
- `costumes`
- `audios`

每个 candidate 需要增加统一字段：

- `candidateId`
- `assetKind`
- `name`
- `description`
- `episodeId`
- `episodeNo`
- `sceneNames`
- `shotCandidateIds`
- `lineIndices`
- `sourceTextSnippets`
- `confidence`
- `defaultImagePromptSeed`

角色额外字段：

- `gender`
- `ageValue`
- `ageStage`
- `appearance`
- `personalityTags`
- `relationshipHints`
- `outfitSummary`

场景额外字段：

- `locationType`
- `timeOfDay`
- `atmosphere`
- `visualKeywords`

道具额外字段：

- `propType`
- `usageContext`
- `heldByCharacterNames`

服装额外字段：

- `wearerNames`
- `style`
- `color`
- `material`
- `occasion`

音频额外字段：

- `audioKind`
- `speakerNames`
- `sceneContext`
- `emotion`
- `durationHint`
- `transcriptSnippet`
- `soundCueText`
- `defaultAudioPromptSeed`

### 第一期字段落库决策

结论：第一期需要把资产详情落入 PostgreSQL，但不需要为上述每个 candidate 字段新增数据库列。稳定、跨模块复用且已有正式列的内容写现有列；解析证据和类型特有的长尾内容写受约束的 `metadata.lite`。这样不是临时不落库，而是仍以 PostgreSQL 为正式事实源，只是不提前固化尚未形成查询合同的列。

| 数据内容 | 第一期写入位置 | 前端意义 | 后端意义 |
| --- | --- | --- | --- |
| 类型、名称、展示名、摘要 | `asset_entities.asset_kind`、`name`、`display_name`、`intro` | tab 分类、列表卡和详情标题 | 项目内按 `asset_kind + normalizedName` 幂等归并，支持列表筛选与计数 |
| 角色稳定属性 | 现有 `appearance`、`age_value`、`gender`、`height_cm`、`hair_description`、`outfit_description` | 角色详情展示和生成前预填 | 搜索、提示词组装及完整版复用；有值时不能只留在 metadata 中 |
| 通用分类与标签 | 现有 `category`、`style_tags` | 详情标签和后续筛选 | 统一检索字段；不要把解析证据混入标签 |
| 本次解析原始候选 | `script_breakdown_runs.draft_json.assetCandidates` | 前端不直接读取 | 保存某次 confirmed run 的可追溯解析快照，是 materialize 的输入 |
| 类型特有详情、出现信息、解析证据、默认提示词种子 | `asset_entities.metadata.lite` | 详情页展示、无媒体时的文本资产信息、生成弹窗预填 | materialize 后的项目资产投影，用于合并多集信息和组装生成上下文 |
| 变体及其稳定描述 | `asset_variants` 的正式列，补充信息放其 `metadata` | 造型/状态版本列表和主版本选择 | 区分同一资产的不同版本，不重复创建资产实体 |
| 图片或音频文件及主版本状态 | `asset_media` 的正式列及 `is_primary` | 缩略图、播放器、候选版本和主版本状态 | 媒体归属、格式、存储位置和默认引用事实 |
| 项目对资产/变体/媒体的引用 | `project_asset_refs` | 展示本项目当前可引用版本 | 保持项目作用域、引用目标及 `version_snapshot`，不把项目关系塞进资产 metadata |

`metadata.lite` 使用固定命名空间和可校验结构，建议第一期形状如下；具体 TypeScript 类型与 Zod schema 和实现一起提交：

```json
{
  "lite": {
    "schema_version": 1,
    "profile": {},
    "notes": "",
    "usages": [
      {
        "episode_id": "uuid",
        "episode_no": 1,
        "scene_ids": [],
        "scene_names": [],
        "shot_ids": [],
        "shot_candidate_ids": [],
        "line_indices": [],
        "source_text_snippets": [],
        "note": "",
        "confidence": 0.95,
        "source_breakdown_run_id": "uuid",
        "source_candidate_id": "candidate-id"
      }
    ],
    "prompt_seeds": {
      "image": "",
      "audio": ""
    }
  }
}
```

维护约束：

- `draft_json` 保存解析运行快照，`metadata.lite` 保存实体化后的当前资产投影；前端统一通过 Lite API 读取资产详情，不直接拼接或解释 `draft_json`。
- `metadata.lite.profile` 保存 `ageStage`、`personalityTags`、`relationshipHints`、`locationType`、`audioKind` 等类型特有字段；已有正式列的角色属性仍优先写正式列。
- ~~`metadata.lite.ref_slots`~~ 已移除。参考图不再区分槽位，改为弹窗 B 内的多图上传区（上传时仅在内存持有 File 对象 + 预览 URL，生成提交前上传到服务端拿 media_id 作为 `reference_media_ids`）。不持久化参考图分组标签。
- `metadata.lite.notes` 保存资产级补充备注，单次出现的备注放对应 usage 的 `note`；解析来源片段仍单独放 `source_text_snippets`，不能混成不可区分的一段文本。
- `usages` 按 `source_breakdown_run_id + source_candidate_id` 幂等合并；重复点击本集 materialize 不得重复追加，同名同类跨集资产只新增或更新对应 usage。
- repository 更新 `metadata.lite` 时必须保留 `metadata` 中其他命名空间，不能整块覆盖；所有读写都经过同一 TypeScript 类型和 Zod 校验。
- 一旦产品要求某字段参与常态化 `WHERE`、`ORDER BY`、`GROUP BY`、唯一约束或外键关联，就在该需求实现时迁为正式列或关系表。出现集/分镜需要高频筛选、统计或与真实 `shots.id` 关联时，直接新增 `asset_episode_usages`，不继续扩大 JSON 查询。

### 多集逻辑

本集按钮：

- 只解析/落当前 `episode_id` 的 confirmed run。
- 同名同类资产在项目内已存在时，不重复新建，只更新“出现信息”和“本集证据”。

多集按钮：

- 对选中的多个 episode 的 confirmed run 做合并。
- 合并规则以 `assetKind + normalizedName` 为主键；角色可用别名/显示名辅助归并。
- 合并后资产详情显示“出现于第 1、3、5 集”和关联分镜。

### usage 写入与读取走通

- materialize 只读取目标集最新 confirmed run；以该 run 的 `assetCandidates` 为资产详情来源，以 `shotCandidates` 中的 `characterNames`、`sceneNames`、`propNames` 反查每个资产出现在哪些候选分镜。
- 使用 `shots.source_breakdown_run_id + source_candidate_id` 把候选分镜映射到确认后真实 `shots.id`，再通过 `shots.scene_id` 和 `scenes` 补齐真实场景 ID、场景名、分镜号。第一期同时保留 candidate ID 和真实 ID，便于解析溯源与正式业务查询。
- 新建资产和命中既有同名同类资产必须走同一套 usage 合并逻辑；命中既有资产不能直接跳过，否则第二集以后永远不会累积出现信息。
- 重复 materialize 同一个 run 时，按 `source_breakdown_run_id + source_candidate_id` 覆盖该 usage，不追加重复行；不同集的 confirmed run 分别保留。
- `GET /lite/assets/:asset_entity_id` 由后端读取正式列与 `metadata.lite`，并把 usage 组装成“集 -> 场景 -> 分镜”的稳定响应，同时返回资产级备注、单次出现备注、来源片段和置信度。前端不自行关联多个接口猜测关系。
- 如果 confirmed run 尚未产生真实 `shots.id`，usage 可以暂存 candidate ID；确认完成或下次 materialize 时必须补齐真实 ID，不能长期只保留不可导航的 candidate ID。

## 问题三：详情信息是否齐全，以及如何支撑分镜引用

结论：详情现在不齐全。修改后，素材 tab 下展示摘要，详情页保存”默认信息 + 图片版本 + 引用状态”。

### 列表卡需要展示

- 名称
- 一句话描述
- 弱状态：无图/有图/可引用/生成中，最多 1-2 个小徽记

列表卡不展示完整类型、出现集数、分镜数、候选图数量、审核细节。原因是当前 tab 已经表达类型，复杂状态会降低 Lite 的扫读效率。用户需要判断或操作时，点击卡片进入详情即可。

### 详情页需要展示

通用信息：

- 名称
- 类型
- 描述
- 出现集
- 出现场景
- 关联分镜
- 解析来源文本
- 资产备注和单次出现备注
- 默认图片提示词种子
- 主图
- 候选图/版本
- 是否已登记为可引用素材

角色详情：

- 性别
- 年龄/年龄段
- 外貌
- 发型
- 身高
- 服装摘要
- 性格标签
- 关系提示

场景详情：

- 地点类型
- 时间
- 氛围
- 视觉关键词
- 相关角色/道具

道具详情：

- 道具类型
- 使用方式
- 出现镜头
- 持有人/关联角色

服装详情：

- 穿着角色
- 款式
- 颜色
- 材质
- 适用场景

音频详情：

- 音频类型
- 说话角色/声音角色
- 对白或旁白文本
- 场景上下文
- 情绪/语气
- 时长
- 当前版本
- 已上传文件

### 图 2 资产详情逻辑

图 2 的核心不是”把更多字段塞进一张卡”，而是进入某个资产后的工作台。Lite 采用独立路由详情页（`/lite/projects/:projectId/assets/:assetEntityId`），结构如下：

1. 顶部身份区
   - 面包屑：`项目资产 / 角色板`
   - 标题：资产名 + 类型，例如 `任天野 · 角色板`
   - 副标题：一句话说明这个资产的约束用途，例如“角色板定义身份、造型、标准视图与一致性约束”
   - 主动作：锁定角色板、引入资产、新建变体、上传图片/音频

2. 引用状态条
   - 显示该资产是否已被分镜、视频任务或故事板引用。
   - 显示锁定状态、当前主版本
   - 提供“查看引用”入口，进入后列出哪些集、哪些分镜、哪些生成任务用到了它。

3. 左侧版本/媒体列表
   - 列出当前资产下的图片或音频版本。
   - 每个版本展示：缩略图或音频占位、名称、来源（AI 生成/上传/个人引用/通用引用）、是否当前主版本。
   - 每个版本提供轻动作：设为主版本、查看详情、删除/弃用（只做可逆操作，不硬删）。

4. 右侧当前版本详情
   - 展示当前选中版本的大图或播放器。
   - 展示结构化信息：角色身份、外貌、服装、场景、道具、音频描述等。
   - 展示生成信息：模型、参数、提示词、参考图/参考音频、生成时间、生成任务 id。
   - Lite 第一期不做审核 UI（不展示自动审核 / 待审核 / 提交审核动作）；完整版的审核流程保留在完整版资产工作台，Lite 只保留"设为主图 / 主音频"这一个动作。

5. 变体区
   - 变体是同一资产的不同状态或不同造型，不是新资产。
   - 角色示例：基础身份、战甲造型、雨夜造型、医院病号服。
   - 场景示例：白天、夜晚、雨夜、破损状态。
   - 音频示例：平静版、愤怒版、受伤虚弱版、旁白版。

6. 规则说明区
   - 显示该资产的默认审核规则、引用范围和可复用范围。
   - Lite 里只展示结果和必要说明，不暴露完整版的复杂权限与审计表格。

交互规则：

- 点击列表卡只进入详情，不直接触发付费生成。
- **新建变体**（v1.2 修正 + v2.5 预填裁定）：详情页点 [+] → 弹窗 B 以 `new_variant` 模式打开。**v2.5 起仅首变体预填**：资产当前无任何变体（=本次创建的是第一个变体）时，名称/描述/备注从资产预填、提示词按「项目默认风格模板 + 资产信息」预填；资产已有变体时表单空白（名称/描述/备注/提示词均不预填），由用户自填。用户填写变体名称（必填）+ 描述后点保存/上传/生成时，**先调 `POST /api/v1/assets/:id/variants` 创建变体实体**（得到 `variant_id`），再继续图片操作。上传图通过 `asset_variant_id` 挂到该变体上。变体是同一角色的不同形态（如战甲造型、雨夜造型），不是同一张图的…
- 给已有变体加图时弹窗 B 以 `add_image` 模式打开，资产信息（名称/描述/备注）和提示词模板预填。
- 点击”生成图片/生成音频”后程序内部走 estimate → confirm → submit 三步流程（用户侧不展示预估 UI，但程序内部三步完成提交）。
- 弹窗 B 的”AI 优化提示词”按钮调用 `POST /ai/prompt-draft` 重新生成提示词，结果回填到提示词文本域。
- 弹窗 B 的模型/比例为两个级联下拉（v1.1：模型下拉 + 比例下拉），选项来自 `listCapabilityTiers(“image”)` 的 active 档。
- 参考图为多图上传区（不区分槽位），用户上传后展示缩略图并支持删除；生成提交前上传到服务端，media_id 作为 `reference_media_ids` 传入生成请求。
- **音频资产（`asset_kind === "audio"`）弹窗 B 为纯 AI 生成模式**（v2.6 完整改造）：隐藏「本地上传」tab（后端 `/assets/:id/media` 只接受图片，音频无上传通道）；无参考图上传区；提示词区标签为「音频文本」，输入待合成的对白/旁白/音效文本；主按钮「合成并保存」。
- 音频生成提交：`media_kind: "audio"` + `parameters.speakerId`（必选，来自 `GET /api/v1/audio/voices` 音色目录）+ `reference_media_ids: []`（音频不引用参考素材）；未选音色校验「请选择音色」。音频模型来自 `listCapabilityTiers("audio")` 的 active 档；音色下拉可选试听（`auditionUrl`，单实例 `<audio>`）。
- 上传媒体后先成为候选版本，用户手动设为主版本后才作为默认引用。
- 已被分镜引用的主版本修改时，要提示”会影响后续生成引用”，但不自动重跑已有任务。

### 图片版本/变体

详情中的图片区域按图 2、图 3 处理：

- **”新建变体”**（v1.2 修正）：调 `POST /api/v1/assets/:id/variants` 写入 `asset_variants`，变体可以是战甲造型、雨夜造型、医院造型等——是同一角色的不同形态（另一张卡片），不是同一张图的版本。创建变体后上传的图通过 `asset_variant_id` 挂到该变体上；AI 生成图暂无法直接挂变体（生成结果走 `media_results` 不走 `asset_media`），出现在「全部」tab。
- “生成图片”：走现有 generation 三步流程（estimate → confirm → submit），一次点击只创建一次任务。
- “上传图片”：走上传/登记流程，写入 `asset_media`，通过 `asset_variant_id` 关联到某个变体（v1.2：上传 API 已支持可选 `asset_variant_id` 参数）。
- “设为主图”：把该图片登记为当前资产或当前变体的主图/默认引用图。
- AI 生成图片必须保留版本概念：生成请求、模型档、提示词、参考图、参数、结果图都能追溯。
- "主图放大"：点击主图区域弹出全屏 lightbox，可左右切换浏览该变体下所有版本图；放大状态下可设为主图，下载等高级操作第一期不做。

音频也按同样方式处理：

- “生成音频”：走 Minimax / 其它已接入音频模型的三步流程（estimate → confirm → submit）。
- “上传音频”：复用上传流程并写入 `asset_media`，通过 `media_kind` 区分音频，再挂到资产或版本上；第一期不新增独立音频媒体表。
- “设为主音频”：同一资产可选默认声音版本，后续分镜引用时优先拿这版。
- AI 生成音频同样保留版本：提示词、角色声音描述、说话文本、模型、参数、结果文件都要可回溯。

### 分镜引用

一键生成本集时，即使还没有图片，也必须先生成资产详情的默认信息。分镜生成时引用顺序：

1. 如果资产有已登记主图，引用主图。
2. 如果资产有已登记候选图，按当前主版本引用。
3. 如果资产没有图，只引用文本资产信息：名称、描述、外貌/场景/道具/服装字段、默认图片提示词种子。
4. 如果是音频资产，优先引用主音频版本；没有音频时也要保留角色声音、对白、情绪和场景音的结构化信息。
5. 如果分镜明确点名某角色/场景/道具/服装/音频，但项目资产未落库，生成前应提示“缺少素材详情”，引导回素材页补齐。

这能保证“先有结构化资产，再慢慢补图”，不会因为没有图片而阻断后续分镜。

### 分镜绑定回填与自动引入

当前剧本确认只会绑定“确认当时已经存在”的同类同名项目资产，而 Lite 通常在确认后才执行 materialize。因此第一期必须补一个确定性的回填步骤，不能只依赖确认瞬间的绑定结果：

1. materialize 在同一项目、同一 confirmed run 范围内，根据该 run 的 `shotCandidates` 资产名称和新建/命中的 `asset_entity_id` 重建分镜绑定。
2. 通过 `shots.source_breakdown_run_id + source_candidate_id` 定位真实分镜，把绑定快照写入现有 `shots.reference_asset_snapshots`。重复执行按 `asset_entity_id` 幂等合并；只刷新本 run 的自动匹配项，不覆盖人工选择或其他来源的引用。
3. 当生成请求携带 `shot_id` 时，服务端生成模块读取该分镜的 `reference_asset_snapshots`，校验资产仍属于当前项目且未软删，再读取当前资产正式列、`metadata.lite.profile`、当前主变体和主媒体。自动引入逻辑必须在服务端完成，前端只负责展示和允许用户调整。
4. 资产名称、描述、外貌、服装、场景、道具、备注和默认提示词种子进入服务端提示词编译上下文；最终编译文本写入 `generation_requests.prompt`，实际使用的资产快照写入 `generation_requests.reference_asset_snapshots`。
5. 主媒体只有在通过当前审核、用途和模型能力校验后才自动进入引用媒体；需要 Seedance `asset://` 的模型还必须有 active 登记。显式人工选择与自动引用命中同一资产时，以人工选择为准并去重；合并后超过模型引用上限必须明确报错，不能静默截断。

降级与历史边界：

- 已绑定资产没有主图/主音频时，继续使用结构化文本生成，不阻断分镜；页面标记“仅文本引用”。
- 自动选中的主媒体失效、被软删除或不符合模型用途时，自动退回文本引用并给出可见提示；用户显式选择的非法媒体仍按现有生成合同返回 422，不能静默替换。
- 分镜点名资产但项目中没有可唯一匹配的实体时，不猜测、不跨项目取资产，生成前提示回素材页补齐或处理重名。
- 回填只影响后续生成。已经创建的 `generation_requests`、报价和媒体结果保持原快照，不自动重写，也不自动重跑。
- 自动引入只是用户点击生成后的请求组装，不得因此自动登记媒体、自动提交付费任务、自动重试或批量扩张。

### 资产侧关联编辑（声明出现范围）

资产的"出现在哪些集/场景/分镜"是用户可编辑的声明，用于让程序自动匹配资产到对应分镜。与分镜侧引用是两层不同的东西：

| 层 | 含义 | 存储 | 保存时发生什么 |
|---|---|---|---|
| **资产侧声明** | "我这个资产跟第3集·场景2·镜5 有关" | `asset.metadata.lite.usages`（`episodeIds / sceneIds / shotIds`） | push 到对应分镜的 `reference_asset_snapshots` |
| **分镜侧引用** | "第5镜要用任天野、书房、战甲" | `shots.reference_asset_snapshots` | 生成时直接读，是最终消费 |

规则：

- **资产侧追加关联**：新增"镜10" → push `{asset_entity_id, name, asset_kind, matched_by: "manual"}` 到 `shots[S010].reference_asset_snapshots`；同时写入 `metadata.lite.usages.shotIds`。
- **资产侧移除关联**：删掉"镜10" → 从 `shots[S010].reference_asset_snapshots` 删除同 `asset_entity_id` 且 `matched_by: "manual"` 的条目；不动 `matched_by: "exact_name"` 的自动匹配项（那是 backfill 写的，资产侧不能替它删）。同时从 `metadata.lite.usages.shotIds` 移除。
- **分镜侧删减**：在分镜页删掉一个 auto-matched 资产 = 当前分镜不引用它，**不影响资产侧声明**。分镜侧记录 `removed_asset_entity_ids` 列表，backfill 重跑时不重新 push 被 manually removed 的资产。
- **backfill 与手动的优先级**：`matched_by: "manual"` 的条目不被 backfill 覆盖；`matched_by: "exact_name"` 的条目可以被 backfill 更新（资产名称变了就刷新）。

资产详情页 UI：

```
── 出现在 ──
第3集 · 场景2 · 镜5（书房对话）                              [删除]
第3集 · 场景2 · 镜6（书房对话）                              [删除]
第5集 · 场景1 · 镜12（雨夜对峙）                             [删除]
[ + 关联分镜 ]   ← 弹出分镜选择器（树形：集 → 场景 → 镜）
```

### 并发与一致性约束

同一资产 / 变体可能被多人同时操作，或同一用户多端并发。后端必须处理以下冲突场景：

- **同时设主图**：两人各把不同版本设为主图时，不得出现多个 `is_primary=true`。翻转必须在单事务内条件更新（先清同变体其他主图，再置新的），冲突时返回 409「主图已被他人更改」，前端拉最新状态。
- **同时生成图片**：允许多个 `generation_requests` 并发（各付各的），不互斥；但资产详情接口要返回 `has_pending_generation` + 数量，让其他人感知"有 N 张生成中"，减少重复劳动。同一用户短时间重复提交可加幂等键挡一道。
- **生成中 + 设主图**：不冲突——生成结果默认非主图，只是候选版本。
- **软删主图 + 分镜读取**：分镜生成读 `reference_asset_snapshots` 时校验资产未软删；主图失效则降级文本引用。
- **同时 materialize 同一集**：幂等，按 `source_breakdown_run_id + source_candidate_id` 覆盖 usage，不追加重复行。
- **同时新建同名变体**：按 `asset_entity_id + normalizedName` 幂等；命中既有则返回既有。
- **改资产关联 vs 分镜生成**：不互斥。生成请求提交时冻结 `reference_asset_snapshots` 快照，资产关联编辑只影响后续生成。资产详情接口返回 `last_modified_at` + `modified_by_user_id`；分镜生成页如果引用了 `last_modified_at` 晚于本次打开页面的资产，显示轻提示"资产「任天野」刚被 XX 修改过，当前生成使用提交时的快照"，不阻断生成。

## 问题四：提示词模板表和图片模型

### 提示词模板

当前没有独立的“图片提示词模板表”。

当前可用事实源：

- `generation_default_strategies`：每个项目、每种媒介一条默认策略；Lite 配置页已把图片 `prompt_template` 存在 `parameters.prompt_template`。
- `projects.image_prompt_template`：项目级历史字段，仍在 schema 中。

修改建议：

- 不新增第二套模板事实源。
- Lite 第一阶段继续使用 `generation_default_strategies.parameters.prompt_template` 作为图片通用模板。
- 为资产类型增加同一字段里的结构化子模板，例如：

```json
{
  "prompt_template": "写实电影质感，保持角色一致性，不要文字水印",
  "asset_prompt_templates": {
    "character": "角色定妆照，正面半身，突出面部与服装特征",
    "scene": "场景概念图，突出空间结构、时间和氛围",
    "prop": "道具特写，干净背景，突出材质和用途",
    "costume": "服装设定图，突出款式、颜色、材质和穿着角色"
  }
}
```

生成最终图片提示词时按以下顺序拼接：

1. 项目通用图片模板
2. 当前 tab/资产类型模板
3. 资产详情默认信息
4. 当前变体说明
5. 用户在弹窗里临时补充的提示词

最终提示词必须写入 `generation_requests.prompt`，用于审计、重试和版本回溯。

### 图片模型

当前已经接了多种图片生成能力，不是完全空白：

- Ark/Seedream 图片模型，例如 Seedream 5 Pro。
- Minimax Image。
- OpenAI-compatible/NewAPI 图片能力，例如 `gpt-image-2`、Gemini image。
- suchuang 图片网关模型，例如 `gpt-image-2-suchuang`、`nanobanana-lite`、`nanobanana-2`。

修改建议：

- 素材详情里的“生成图片”默认使用项目图片配置页保存的模型和尺寸。
- 生成弹窗允许用户临时选择模型/尺寸/比例等 active 档参数，但不能保存成全局默认，除非用户点“保存为项目默认配置”。
- 所有可选模型必须来自 active pricing/capability tier；前端不能手写模型 ID。
- 仍然保持付费红线：一次按钮点击只创建一次提交（内部走 estimate → confirm → submit 三步流程），不自动批量生成，不自动重试。

## 问题五（v1.3 反馈迭代）：资产解析与变体语义修正

> 本节基于首发反馈（2026-08-12）逐条记录「现状 → 决策 → 模块改动 → 测试」。反馈场景 = 用户在真实项目里点"一键生成本集"并进入详情页后暴露的问题，全部合并进本文件作为 v1.3 唯一真源。

### 反馈五.1：一键生成本集的解析描述与集/分镜/场景信息

**现状**：

- `materializeAssets` 直接取 `candidate.description` 写入 `asset_entities.intro`；`buildAssetsPrompt` 只要求"description 写角色定位/环境/功能要点"，没有禁止抄原文，实际模型常把剧本原文整句搬进 description，详情页描述读起来是剧本台词而不是资产特点。
- materialize 落库时 `metadata` 只写 `{ source / source_breakdown_run_id / source_candidate_id }`，**不写** `metadata.lite.usages`，也不回填 `shots.reference_asset_snapshots`——详情页"出现记录"拿不到"第1集 · 第1个分镜 · 厨房场景"这类集/分镜/场景导航信息。

**决策**：

- 解析侧（`buildAssetsPrompt` 升 v4）：`description` 必须是"资产特点"的提炼，按类型给出口径——
  - 角色：外形 / 身份 / 性格概括，如"中年刑警，体格健硕，常穿便装"；
  - 场景：空间结构 / 时间 / 氛围概括，如"旧式厨房，暖黄灯光，陈设拥挤"；
  - 道具：功能 / 特征概括，如"黑色手枪，警用制式"；
  - 服装：款式 / 颜色 / 材质 / 场合概括；
  - 音频：解析信息 = 说话角色 + 角色特点 + 剧本说话原文（如"任天野，中年刑警，声线低沉；原话：'把门锁上'"）。
  - 硬性要求：禁止整段照抄原文，`description` 上限 100 字；原文引用行保留在 `source_text_snippets` 供溯源，不混入 description。
- 落库侧（materialize）：落库时按本集 confirmed run 的 `shotCandidates` 反查每个资产出现的候选分镜与场景，写出 `metadata.lite.usages`（`episode_no / scene_names / shot_candidate_ids / line_indices / source_text_snippets`），并 backfill `shots.reference_asset_snapshots`（`matched_by: "exact_name"`）。
- 详情页：出现记录默认展开，逐条显示"第1集 · 第1个分镜 · 厨房场景"导航；来源文本折叠可查。

### 反馈五.2：音频和服装仍然解析不出来

**现状**：类型 / schema / prompt / materialize 已扩到五类（`script-breakdown.v3`），但实际运行仍常抽不到服装 / 音频桶。

**根因（依据 v3 提示词逐条核对）**：`buildAssetsPrompt` 对服装约束过严——"只抽取剧本明确描写的、有辨识度的""不抽取日常无特征的通用衣着"；音频也要求"原文没有明确音频线索时不虚构"；叠加 description 抄原文，导致输出桶经常为空。

**决策**：

- 放宽并明确抽取标准（v4）：
  - 服装：剧本点名"穿着 / 换上 / 脱下"且带特征描述（如"军绿风衣""病号服"）即抽；即使日常衣着、只要剧本明确点名穿着也抽，不再要求"有辨识度"。
  - 音频：按 `character_voice`（对白）/ `narration`（旁白）/ `sfx`（拟声词与动作音）/ `ambience`（环境声）四类，剧本有明确线索即抽，`audio_kind` 必填。
- 解析校验：剧本含明显服装 / 音频线索但输出桶为空时，走 repair 阶段补抽。
- 详情页补齐服装 / 音频特有字段展示：服装 = 穿着角色 / 款式 / 颜色 / 材质 / 适用场合；音频 = 音频类型 / 说话角色 / 角色特点 / 对白或旁白文本 / 场景上下文 / 情绪 / 时长。

### 反馈五.3：弹窗 A（新建资产）补齐 AI 生成与上传首图

**现状**：`lite-asset-create-dialog.tsx` 的"上传首图 / AI 生成"是 toast 占位（"将在第二阶段上线"），只实现"跳过"纯文本新建。用户手动新建资产后拿不到与详情页一致的生成 / 上传体验。

**决策**：弹窗 A 与弹窗 B 共用同一套加图能力：

- 新建资产三选一：跳过（纯文本，进详情空状态）/ 上传首图 / AI 生成。
- AI 生成走 estimate → confirm → submit 三步流程，模型 / 比例级联选器与提示词模板与弹窗 B 一致；上传走 `uploadAssetMedia`。
- 首图落库到第一个变体并自动设为主图（见反馈五.4）。
- 纯上传类型（光线 / 摄影 / 视频参考）仍只显示"上传首图 / 跳过"。
- 实现：从弹窗 B 提取可复用的上传 / AI 生成子组件，或弹窗 A 内嵌同款区块，避免两套生成逻辑漂移。

### 反馈五.4：变体语义修正

**现状**：

- materialize 不创建任何 `asset_variants` 行——脚本解析资产在用户手动新建变体之前"没有变体"，与"从剧本解析出来的就是唯一变体"的预期不符。
- 变体标签条"全部(N) + 变体(N)"，`pickDefaultVariant` 优先主变体否则第一个，没有"固定默认第一个变体"的语义。
- 生成图 `variant_id = null`（走 `media_results`）挂不到变体，只出现在「全部」。
- 没有删除版本图，主图、删除变体的能力，当删除了主图，第一个版本就是默认设置为主图。

**决策（v1.3 变体语义）**：

1. 变体 = 同一资产的不同形态 / 状态卡片（角色示例：老人 / 小孩 / 战甲造型；场景示例：白天 / 夜晚 / 破损）。一个变体可挂多张版本图（上传或 AI 生成）。
2. **脚本解析自动创建第一个变体**：materialize 落库时同时创建 `asset_variants` 第一行（`display_name = 资产名`，`variant_kind` 取默认）。此后"上传 / 生成第一张图"落在第一个变体上。
3. **主图规则**：
   - 变体的第一张图（上传或生成）自动 `is_primary = true`（默认主图）；
   - 变体已有图后再加图 → 候选版本，不自动改主图；
   - 多张图时用户手动"设为主图"（沿用原子翻转 + 409 冲突处理）。
4. **外层展示**：详情页默认选中第一个变体；主图区展示"第一个变体的主图"。手动新建且未加图 → 空状态引导卡（生成 / 上传入口）。
5. **删除能力**（只做可逆软删，不物理删行）：
   - 删除某个版本的图：软删 `asset_media` / `media_results` 行，图轨与主图区同步移除；
   - 删除某个变体：软删 `asset_variants` 行，并级联处理其下媒体与 usage 关联（该变体删除后，其图与关联分镜一并移除或转未归属，需要明确归到哪）。
6. 生成图挂变体：生成时若当前选中某变体，把生成任务 / 结果关联到该变体（后端 `generation_requests` 增加变体目标字段，或落库时绑定到第一个变体）；未关联时仍出现在「全部」。

### 反馈五.5：右侧关联分镜改为变体级多条目表单

**现状**：

- 详情页右侧"出现记录"只有单条添加表单（一次一个 集数 + 分镜号 + 场景名）。
- usage 是资产级（`metadata.lite.usages`），没有变体维度——无法表达"这个变体关联第1集镜3、第3集镜8、第5集镜12（多集多分镜多场景）"。

**决策**：

- usage 增加变体维度：`metadata.lite.usages` 每条 usage 记录 `variant_id`（或按变体组织）；右侧展示的是**当前选中变体**的关联分镜。
- 表单支持一次填多条：多集 / 多分镜 / 多场景批量添加；已有条目逐条删除。
- 后端改动：
  - `POST /lite/assets/:id/usages` 入参改为数组（`[{ episode_no, shot_no, scene_name?, variant_id? }]`），批量落库并回填 `shots.reference_asset_snapshots`（`matched_by: "manual"`）；
  - `GET /lite/assets/:id/usages?variant_id=` 按变体过滤返回；
  - `DELETE /lite/assets/:id/usages/:shot_id` 保持逐条删除（按变体限定）。
- 分镜生成引用按变体取主图：某分镜引用某变体时，用该变体的主图（原"主版本"口径从资产级下沉到变体级）。

### 匹配：关联分镜 ↔ 分镜生成的资产

v1.3 把 usage 下沉到变体级后，"关联分镜"与"分镜生成"的匹配流程如下（沿用问题三的 backfill / manual 双层口径，主版本口径从资产级下沉到变体级）：

1. **写入（资产侧声明，保存即解析）**：详情页关联分镜表单的每条 `{ episode_no, shot_no, scene_name?, variant_id? }`，点保存时服务端立即用 `findShotByLabel` 解析真实 `shot_id`：
   - **命中** → 写 `metadata.lite.usages`（带 `variant_id`）→ push `shots[shot_id].reference_asset_snapshots` 条目 `{ asset_entity_id, variant_id, name, asset_kind, matched_by: "manual" }`；
   - **未命中（该集尚未确认 / 镜号不存在）→ 不报错，落"待绑定"条目**：`shot_id = null`，保留 `episode_no / shot_no / scene_name / variant_id`，`status = "pending"`；列表以"待绑定"状态展示、可删。**不做占位自动建分镜**——正式 `shots` 唯一写路径是 confirm 事务（`boundary.test` 约束），伪造分镜会破坏该不变量；
   - **绑定回填（reconcile）**：目标集 confirm 写正式 shots 后，扫本项目 `status = "pending"` 且 `(episode_no, shot_no, scene_name)` 匹配的条目 → 补真实 `shot_id`、回填 `shots.reference_asset_snapshots`、转 `status = "bound"`；挂钩点 = `confirmRun` 成功后。
2. **读取（分镜侧消费）**：`POST generations(shot_id=...)` 时，服务端读该分镜的 `reference_asset_snapshots`，按 `(asset_entity_id, variant_id)` 二元组匹配（只消费 `status = "bound"` 的条目——pending 无分镜、未回填快照，天然不参与）：
   - 校验资产属于当前项目且未软删；
   - 取该变体的主图编入引用媒体（变体级主图口径）；
   - 该变体无主图 → 文本引用降级（资产结构化信息 + 变体描述 + 默认提示词种子），不阻断生成；
   - 资产或变体软删 → 降级文本或跳过，不报 500。
3. **优先级**：`matched_by: "manual"` 不被 backfill 覆盖；`matched_by: "exact_name"` 可被 backfill 更新。backfill 自动匹配默认挂到第一个变体（脚本解析的变体）。
4. **匹配键为什么是二元组**：同一资产的不同变体可被不同分镜引用（如镜3 用"老人"变体、镜8 用"小孩"变体），只按 asset 匹配会拿错变体的主图。
5. **快照冻结**：生成请求提交时冻结 `reference_asset_snapshots` 快照，提交后改关联 / 改主图不影响已提交任务（沿用问题三 T7.3）。

### 反馈五.6：新建变体弹窗的文件选择

**现状**：`lite-asset-add-image-dialog.tsx` 上传 tab 只显示一行文本"已选择: xxx.png"，没有缩略图，可点"移除"但没有图片卡片。

**决策**：上传区改为文件选择卡片——展示所选文件的缩略图（preview URL） + 大小，右上角删除按钮可移除；多选时每个文件一张卡片、逐个删除（与参考图区的交互一致）。

### v1.3 需要改的模块

前端：

- `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-create-dialog.tsx`
  - 「上传首图 / AI 生成」从 toast 占位改为真实路径，复用弹窗 B 的加图能力（上传 + AI 三步流程）；首图自动设为主图。
- `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx`
  - 变体语义：默认选中第一个变体；外层主图区展示第一个变体的主图；出现记录按当前选中变体展示。
  - 关联分镜改为多条目表单（批量添加 / 逐条删除）。
  - 新增删图、删变体入口与确认提示。
  - 出现记录逐条显示"第N集 · 第N个分镜 · 场景名"。
- `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-add-image-dialog.tsx`
  - 上传区文件选择改为缩略图 + 文件名 + 大小 + 删除卡片。
  - 生成时若选中变体，把生成任务关联到该变体。
- `frontend/shortdrama-rag-demo/src/api.ts`
  - 新增删除变体 / 删除媒体 / 批量添加 usage 的 API 调用。

后端：

- `src/modules/script-breakdown/prompts.ts`
  - `buildAssetsPrompt` 升 `PROMPT_VERSION = "script-breakdown.v4"`：
    - `description` 改为"资产特点提炼"（分类型口径），禁止抄原文，上限 100 字；
    - 放宽服装 / 音频抽取标准（见反馈五.2）。
- `src/modules/script-breakdown/schemas.ts`
  - `assetsStageOutputSchema` 的 `description` 长度上限收紧（≤100 字）；确认 `storedCostumeCandidateSchema` / `storedAudioCandidateSchema` 在 confirmed run 读回时完整。
- `src/modules/lite/service.ts` / `repository.ts`
  - `materializeAssets` 落库时：创建第一个变体（`asset_variants`）；写 `metadata.lite.usages`（集 / 分镜 / 场景 / 证据）；backfill `shots.reference_asset_snapshots`。
  - 新增 `DELETE /lite/assets/:id/variants/:variant_id`、`DELETE /lite/assets/:id/media/:media_id`（可逆软删）。
  - `POST /lite/assets/:id/usages` 支持批量数组 + `variant_id`；`GET .../usages?variant_id=` 按变体过滤。
  - 关联分镜 `findShotByLabel` 未命中时不再报错：落 `status = "pending"` 待绑定条目（`shot_id = null`），列表可展示 / 删除；`confirmRun` 成功后触发 pending → bound 绑定回填（补 `shot_id` + 回填 `reference_asset_snapshots`）。
  - 生成任务关联变体（`generation_requests` 变体目标字段，或落库绑定第一个变体）。
- `src/modules/lite/routes.ts`
  - 登记上述新增 / 变更路由。

数据库：

- **零迁移**：`asset_variants`、`asset_media` 已有软删列与 `variant_id`；usage 的变体维度先落 `metadata.lite.usages`。若"出现于哪些集 / 分镜"需要高频查询，再按原计划迁 `asset_episode_usages`。

### v1.3 测试标准（T10）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T10.1 | 解析 description 为资产特点 | 剧本含角色 / 场景 / 道具 | 一键生成本集 → 查看资产详情描述 | description 是特点提炼（≤100 字），不是原文整段；原文片段在来源文本中可查 |
| T10.2 | 集 / 分镜 / 场景信息落库 | 一键生成本集 | 查看详情"出现记录" | 显示"第1集 · 第1个分镜 · 厨房场景"逐条导航；`metadata.lite.usages` 含集 / 分镜 / 场景 / 证据字段 |
| T10.3 | 服装解析 | 剧本含"穿上军绿风衣" | 解析 + materialize | 服装候选落库，详情显示穿着角色 / 款式 / 颜色 / 材质 / 场合 |
| T10.4 | 音频解析 | 剧本含对白 / 旁白 / 拟声词 | 解析 + materialize | 音频候选落库，详情显示类型 / 说话角色 / 文本 / 情绪 / 时长 |
| T10.5 | 弹窗 A AI 生成 | 新建角色资产 | 弹窗 A 选「AI 生成」→ 生成 | 资产 + 生成任务落库；结果图挂第一个变体并自动设为主图 |
| T10.6 | 脚本解析自动建第一个变体 | 一键生成本集 | 查看详情变体条 | 出现第一个变体（`display_name`=资产名）；上传 / 生成首图落该变体且自动设主图 |
| T10.7 | 首图自动主图 | 变体无图 | 上传 / 生成第一张图 | `is_primary=true`；再传第二张不自动改主图 |
| T10.8 | 外层显示第一个变体的主图 | 第一个变体有主图 | 打开详情页 | 主图区显示第一个变体的主图 |
| T10.9 | 删版本图 | 变体有多张图 | 删除其中一张 | 软删（`deleted_at`）；图轨与主图区同步移除 |
| T10.10 | 删变体 | 资产有多个变体 | 删除某变体 | 软删 `asset_variants`；其下图与 usage 关联一并处理；其余变体不受影响 |
| T10.11 | 关联分镜多条目 | 资产存在 | 右侧表单一次填多条（多集多分镜）→ 保存 | 批量写入 `metadata.lite.usages` + 回填 `shots.reference_asset_snapshots`；按变体展示 |
| T10.12 | 关联分镜按变体过滤 | 资产有 2 个变体各有关联 | 切换变体 tab | 右侧只显示当前选中变体的关联分镜 |
| T10.13 | 新建变体弹窗文件选择 | 打开弹窗 B 上传 tab | 选择文件 | 展示缩略图 + 文件名 + 大小，可删除；多选时逐张卡片逐个删除 |
| T10.14 | 关联分镜 → 分镜生成匹配 | 镜5 已关联 A001 的"老人"变体且有主图；镜8 关联同资产的"小孩"变体 | `POST generations(shot_id=S005)` / `(shot_id=S008)` | 服务端按 `(asset_entity_id, variant_id)` 匹配：镜5 引用"老人"变体主图、镜8 引用"小孩"变体主图，互不串图；无主图变体降级文本引用 |
| T10.15 | 关联分镜待绑定（分镜 id 尚不存在） | 输入第2集镜5，但第2集尚未确认（`shots` 无对应行） | 保存 → 查看出现记录 → 再确认第2集 | 保存时不报错，落 `status = "pending"` 条目显示"待绑定"、可删；第2集确认后自动绑定真实 shot_id、回填 snapshots、转 bound；确认前不参与分镜生成引用 |

### v1.3 通过标准

- T10.1–T10.15 全部通过 = v1.3 可交付。
- 生成图挂变体的正式变体目标字段（反馈五.4 第 6 条）涉及 `generation_requests`，允许先以"落库绑定第一个变体"过渡，正式字段随 `asset_episode_usages` 迁移一并做出来，不阻塞其余 T10。

## 问题六（v1.3.1 首发修复迭代）：一键生成本集失败 / 变体下图片不显示 / 关联分镜跳转与场景回显

首发后收到三个问题，本迭代逐一给出根因与决策。**前置约定：先改文档（本版），再改代码；v1.3 语义不变，本次只修缺陷。**

### 六.1 一键生成本集失败根因（问题一）

**现状**：第 2 集一键生成本集在 2026-08-13 02:04 失败。查 `script_breakdown_run_stages`：第 1 集 run `f57afd61`（promptVer v3）正常完成并确认；第 2 集 run `e3eb5978`（promptVer v4）在模型阶段报 `ai_service_unavailable`。

**根因**：AI 网关（Ark）在该时间点瞬时故障，属**外部瞬时故障，非代码缺陷**。失败发生在解析模型调用阶段，失败 run 不写正式分镜行，不残留半截数据；重试（再次点击一键生成本集 = 新 submit → 新 run → 自动 confirm）即可恢复。

**决策**：
- 失败处理流程无需改动；给用户的呈现为可重试的明确报错（失败原因 + 重试按钮）。
- 固化重跑幂等口径（同"问题一"既有实现，本次以文档+测试确认，不改逻辑）：
  - **资产（`asset_entities`）**：`materializeAssetCandidates` 幂等——按 `assetKind + name` 命中既有未删资产 → `existed += 1`、`ensureFirstVariant`、**不覆盖不删除**，只补缺失；未命中才新建。
  - **分镜/场景（`shots`/`scenes`）**：每次重新确认都是新 run；`confirmRun` 事务内先软删该集上一 run 产生的正式场景/分镜行，再按新 mapping 重建 → **始终覆盖**。脚本变了，重跑后分镜内容即为新脚本结果。
  - **关联分镜快照（`asset_episode_usages`）**：同 `(shot_id, variant_id)` 幂等；manual 条目不覆盖，exact_name 可被更新。
  - 既有资产上重新生成图时，图挂该资产第一个变体，不因重跑产生重复资产。

### 六.2 版本图轨 `variant_id` 字段缺失（问题二核心）

**现状**：repository `listAssetVersionTrack` 每行已算好 `variantId`（上传图 = `asset_media.asset_variant_id`；生成图 = 第一个变体 `firstVariantId`；资产级 = null），但 `GET /lite/assets/:asset_entity_id/version-track` 路由映射响应时**漏掉 `variant_id`**，前端 `api.ts` 里该字段因后端未下发而恒为 `null`。详情页版本图轨按 `item.variant_id === selectedVariantId` 过滤：资产无变体时 `null === null` 全量显示（首图"回显"正常）；一旦新建变体，选中 `variantId` 非 null，过滤后**恒为空** → "图片不显示"、看起来"之前的变体/图片消失了"。

**决策**：路由响应补 `variant_id: item.variantId`。前端过滤逻辑已就绪，无需改动。修复后：
- 「全部」tab（`selectedVariantId = null`）：显示所有图（含资产级历史图）。
- 变体 tab：只显示 `variant_id === 选中变体` 的图（含生成图归属第一个变体）。

### 六.3 变体列表排序稳定 + 首图落第一个变体（问题二）

**排序**：`asset_variants` 新建与脚本解析创建的变体 `sort_order` 默认都是 0；lite `listAssetVariants` 只按 `sort_order` 排序、无 tie-break，同序变体顺序不稳定，刷新可能"换位/消失"。assets 模块 `AssetVariantService.list` 已有 `(sort_order, created_at)` 兜底。**决策**：lite `listAssetVariants` 补 `asc(created_at)`，与 assets 模块一致。

**首图落第一个变体**：v1.3 语义要求"上传/生成第一张图落在第一个变体上"，但仅覆盖脚本解析来源（`ensureFirstVariant`）。历史资产（脚本解析前创建、本就没有变体）或纯手动资产，详情页首次上传图 `asset_variant_id = null` 落**资产级**；之后新建变体，该资产级图只在「全部」可见、在变体 tab 下不可见 → 用户困惑"图片丢了"。**决策**：`add_image` 模式上传时若资产无任何变体，上传前先自动创建第一个变体（name = 资产名，`variant_kind = "look"`，与 `ensureFirstVariant` 同口径），图挂到该变体并保持 `is_primary` 语义；若已有变体但用户停在「全部」，目标落到第一个变体。至此三来源（脚本解析 / 手动新建 / 历史资产）统一：**首图落在第一个变体上**。

### 六.4 关联分镜不跳转 + 场景按用户输入回显（问题三）

**不跳转**：右侧出现记录的 bound 分镜条目目前渲染为按钮，点击 `navigate` 到分镜页——用户要求**点击不跳转**。**决策**：bound 条目与 pending 条目一样渲染为纯文本（保留删除操作），去掉 `navigate`；仅作为展示。

**场景回显**：`listAssetUsages` 对 bound 条目 `scene_name` 取 `shots.scene_id → scenes.name`（解析后的英文场景名），覆盖了用户在表单里输入的数字/中文场景名。**决策**：`scene_name` 优先 `u.sceneNames[0]`（用户输入值；backfill 为候选场景名），为空再回落到分镜场景名。回显文案 `第{episode_no}集 · 第{shot_no}个分镜 · {scene_name}` 不变。

### 六.5 已生成集保留重跑入口 + 二次弹窗确认（问题七）

**现状**：一键生成本集确认后，剧本页进入"已采用"锁定态，按钮区只剩「去分镜页 / 编辑剧本 / 看素材」——**没有再次触发一键生成本集的入口**。想重跑只能先点「编辑剧本」解锁（此时正文可被误改），再点「一键生成本集」。同一集已生成后无法直接重跑。

**决策**（与 六.1 重跑幂等口径一致，后端无需改动——`submitScript` 仅对有成片的集拦截 `lite_script_locked`，已确认无成片的集可再次提交）：

- 已确认（confirmed）的集，按钮区新增常驻**「重新生成本集」**入口：不改动已锁定的剧本正文，直接以当前已采用的脚本重跑。
- 点击后弹**二次确认对话框**，明确告知后果，防误触：
  - 标题：重新生成本集？
  - 说明：本集已生成 N 场、M 个分镜。重新生成将按当前剧本重新解析：**现有分镜会被覆盖（软删重建），素材只补缺失、不覆盖不删除**。此操作不可撤销。
  - 按钮：再想想（取消）/ 确认重新生成（确认）。
- 确认后走与首次一键生成本集完全相同的流程：新 `submitScript` → 新 run → 自动 `confirm` → 跳转分镜页。重跑幂等口径同 六.1（分镜覆盖重写、资产幂等补缺失、关联快照 `(shot_id, variant_id)` 幂等）。
- 「编辑剧本」解锁路径保持不变（需要改剧本时使用）；两者都复用 `autoGenerate` 提交流程。

### v1.3.1 测试标准（T11）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T11.1 | 一键生成本集失败可重试 | 第 2 集上一 run 失败（`ai_service_unavailable`） | 再次点击一键生成本集 | 新 run 正常完成并确认；失败 run 不残留半截正式分镜行 |
| T11.2 | 重跑幂等-资产 | 第 1 集已生成资产与图 | 再次一键生成本集并确认 | 既有资产行数与图不重复、不删除；仅补缺失资产；资产上生成图挂第一个变体 |
| T11.3 | 重跑幂等-分镜覆盖 | 第 1 集已确认分镜 | 修改脚本后重跑并确认 | 旧分镜软删、按新 mapping 重建，行数与内容随新脚本 |
| T11.4 | 版本图轨下发 variant_id | 资产有上传图 + 生成图 + 资产级历史图 | `GET version-track` | 每行带 `variant_id`：上传图=asset_variant_id、生成图=第一个变体、资产级=null |
| T11.5 | 变体 tab 只显示自己图 | 资产 2 个变体各有图 | 切换变体 tab / 「全部」 | 变体 tab 只显示该变体图；「全部」显示所有（含资产级） |
| T11.6 | 变体排序稳定 | 同 `sort_order` 多个变体 | 反复刷新详情页 | 变体标签顺序稳定（按 `created_at` 兜底），不换位 |
| T11.7 | 无变体资产首图落第一个变体 | 历史资产（无变体） | 详情页上传首图 → 保存 | 自动创建第一个变体（name=资产名），图挂该变体、`is_primary=true`，变体 tab 可见 |
| T11.8 | 关联分镜不跳转 | 资产有 bound 出现记录 | 点击 bound 条目 | 页面不导航（URL 不变），条目为纯文本展示 |
| T11.9 | 场景按用户输入回显 | 表单场景名填"2"（数字） | 保存 → 查看出现记录 | 显示"第2集 · 第1个分镜 · 2"（用户输入原样回显，不被英文场景名覆盖） |
| T11.10 | 已生成集保留重跑入口 | 某集已确认（"已采用"锁定态） | 查看按钮区 | 存在「重新生成本集」入口（无需先进"编辑剧本"）；点击弹出二次确认对话框 |
| T11.11 | 重跑二次确认与幂等 | 已生成 N 场 M 分镜的集 | 二次确认对话框点「确认重新生成」 | 走同一重跑流程（新 submit → 新 run → 自动 confirm）：分镜被覆盖（软删重建），资产重复项 `created:0`（只补缺失、不删除）；取消（再想想）不触发任何提交 |

## 问题七（v1.4 视觉与生成配置迭代）：卡片过宽 / 详情页大图 / AI 生成配置与提示词合同

> 2026-08-17 反馈三件事：①素材页卡片太宽；②详情页左侧大图区是否多余（点击放大即可）；③AI 生图的模型选择与提示词拼接逻辑不清晰。本节给出结论、具体改动的文件/函数、数据库影响和测试标准。**本迭代零数据库迁移。**

### 七.1 素材列表卡片收窄（问题一）

**现状**：`lite-assets-page.tsx` 卡片网格为 `grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3`（骨架屏与实际列表各一处），顶部图为 `aspect-video`。桌面端一行只放 3 张，卡宽约容器 1/3，扫读效率低。

**决策**：

- 网格改为 `grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6`，桌面端一行最多 5-6 张，间距同步收窄（`gap-4` → `gap-3`）。骨架屏与列表网格保持同一套断点。
- 卡片顶部图片占位区从 `aspect-video` 改为 `aspect-square`（方形），配 `object-cover`；无图占位图标不变。
- 卡内文案规则不变：名称 + 一句话描述 + 类型徽记，不渲染状态徽记（问题一既有约束）。描述行如已截断保持现状，不为新网格加新截断逻辑。

**改动的文件 / 函数**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-assets-page.tsx` | 列表网格容器（`<div className="grid ..." aria-label="资产列表">`，现约 826 行） | 网格断点改为上述 2/3/4/5/6 列；`gap-4` → `gap-3` |
| 同上 | 骨架屏网格容器（`aria-label="素材读取中"`，现约 797-798 行） | 同一套断点；骨架 `Skeleton` 的 `aspect-video` → `aspect-square` |
| 同上 | 卡片内图片占位区（Card 内顶部图区，`aspect-video`） | `aspect-video` → `aspect-square` |

### 七.2 详情页去掉左侧 sticky 主图大卡（问题二）

**现状**：`lite-asset-detail-page.tsx` 左栏 = sticky 主图大卡（`aspect-[9/16] h-[48vh]`，滚动吸附）+ 变体卡片两列网格。大图常驻占左栏近一半高度，视觉上"丑"且与下方版本图素材轨信息重复——看图本就有 lightbox。

**决策**：

- **删除左栏 sticky 主图大卡**（含其常驻计数、点击进 lightbox 的包装按钮、空状态大图逻辑）。左栏只保留变体卡片网格（两列，上图下名、选中描边、⭐ 主图角标、删变体入口、尾部「＋ 新建变体」虚线卡），网格区头保留 `共 N 个变体` 计数。
- 看大图统一走 **lightbox**（`DetailLightbox`，已存在）：入口 = ①变体卡封面点击 → lightbox 打开并定位到该变体主图；②底部版本图素材轨缩略图点击（现状保留）；③选中变体信息面板顶部增加小封面缩略图（选中变体主图，`aspect-square` 小图）点击进 lightbox。
- **变体无图**时：变体卡封面为类型图标占位（现状保留），点击进弹窗 B（`add_image` 模式）——原大图区的空状态引导卡职责并入变体卡封面点击行为。
- 「新建资产」主动作（v1.8 改名，原「管理图片」；只改文案行为不变，见问题九 9.3）、lightbox 内「设为主图」、左右切换浏览当前筛选范围版本图的规则全部不变。

**改动的文件 / 函数**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 左栏主图大卡块（`{/* 主图大卡 + 常驻计数 */}` sticky 容器，现约 475-505 行） | 整块删除 |
| 同上 | `displayVersion` / `hasImages` 派生（现约 236-238 行） | `hasImages` 保留（空状态判断仍在用）；`displayVersion` 如仅服务大图区则一并删除，改供信息面板小封面使用 |
| 同上 | 变体卡封面按钮（`variants.map` 内 `<button ...>`，现约 507-545 行） | 点击行为：有图 → `setLightboxIndex(定位该变体主图/首图)`；无图 → 打开弹窗 B `add_image` |
| 同上 | 选中变体信息面板（右栏顶部） | 新增小封面缩略图（选中变体主图）+ 点击进 lightbox |
| 同上 | 文件头注释（第 7-17 行布局说明） | 同步更新为"左栏 = 变体卡片网格；看图走 lightbox" |

测试文件 `lite-asset-detail-page.test.ts` 若对主图大卡 / `navigateLightbox` / `canSetAsPrimary` 有断言：纯函数测试保留，大卡相关渲染断言改为变体卡点击进 lightbox 的行为断言。

### 七.3 AI 生成的模型选择与提示词合同（问题三）

**现状与根因**（`lite-asset-add-image-dialog.tsx` 与 `lite-asset-create-dialog.tsx` 同款逻辑）：

- 模型下拉 `modelOptions` 本来就是**全部 active 档**按 `tierModelLabel` 去重聚合的（`handleModelChange` / `handleRatioChange`，现约 396-433 行）。"只能选一个模型"的根因是当前 active 图片档只配了一个模型（档位是 active `pricing_rules` 的投影，见下数据库节）——不是前端写死，是**可选项本来就只有一个**。配置/开通更多模型的 active 价格档后，下拉自然出现多个模型。
- 弹窗默认值已从项目配置读取：`api.generationDefault(projectId, "image")` → `generation_default_strategies.model_key`（= tier_id）匹配 active 档（`loadTier`，现约 148-165 行）。
- 但有两个缺口：①**清晰度（resolution）不可选**——比例下拉 `handleRatioChange` 在同模型同比例的多个分辨率档里自动取最便宜档，用户无法指定 1K/2K；②**提示词拼接漏了备注**——预填只拼 `[模板, 类型模板, name，intro]`（现约 168-173 行），`metadata.lite.notes`（备注）未进入。


**现行提示词生成逻辑（今天代码实际做的事）**：

提示词 = 两段文本按行拼接，预填进文本域，用户可整体编辑。以给角色「任天野」点 AI 生成为例，文本域里预填的就是：

```
写实电影质感，保持角色一致性，不要文字水印        ← 风格段
任天野，中年刑警，体格健硕，常穿便装              ← 资产段
```

两段含义与来源：

| 段 | 管什么 | 来源 |
|---|---|---|
| **风格段** | 全项目统一画风，不管生成哪个资产都在 | 配置页保存的模板：`generation_default_strategies.parameters.prompt_template_id` → `prompt_templates` 表命中行（media_kind='image'）的 content；id 缺失/软删/跨项目回落系统默认（content 为空，由 `effectivePromptTemplate()` 判定） |
| **资产段** | 拍的是谁——这个资产自己的信息 | 资产名称 + 描述（intro）+ 备注（metadata.lite.notes），中文逗号连接 |

拼接规则：两段各自非空才保留，段间换行符连接。
```

各入口的触发时机与差异：

| 入口 | 预填时机 | 差异 |
|---|---|---|
| 弹窗 B `add_image`（给变体加图） | 弹窗打开、`loadTier` 完成后**无条件预填**（覆盖空文本域） | 资产段取资产当前 name/intro |
| 弹窗 B `new_variant`（新建变体） | **仅首变体预填**（v2.5）：资产无任何变体时预填资产 name/intro/note + 提示词；已有变体时表单空白（`shouldPrefill = !isNewVariant || noExistingVariant`） | 首变体提示词 = 项目默认风格模板 + 资产信息；非首变体由用户手填 |
| 弹窗 A（新建资产） | 用户**首次切到「AI 生成」且提示词为空**时预填一次（`handleSelectAi`） | 资产段取弹窗内刚输入的名称/描述 |
| 「✨ AI 优化提示词」按钮 | 任意时刻手动触发 | 调 `POST /ai/prompt-draft`（`api.draftPrompt`：名称独立传请求体 `name`，画面描述传 `description`，当前提示词含项目模板预填段作为 `supplement` 备注传入），服务端读取 `projects.image_style_description` 注入 AI 输入为显式「项目默认图片风格」指令段，并读取图片生成模板（优先 `projects.image_prompt_template` → 图片默认策略引用 `prompt_templates.content` → **平台系统默认模板 `prompt_default_templates` 表（迁移 064 播种的「资产生图提示词规范」），缺行才回落代码骨架 `DEFAULT_IMAGE_PROMPT_TEMPLATE`**，均与生成期同源，见 v2.3），模板原文占位符用本请求真实值渲染后注入（`{{segment_content}}`→生产意图、`{{characters}}`/`{{props}}`/`{{references}}`→已选资产、`{{style_description}}`→项目默认风格，无值占位符所在行删除；与生成期 `renderProjectPromptTemplate` 同源），返回结果 = AI 提示词原文 + supplement 无标签追加到末尾，**整体覆盖**文本域，不是追加 |

提交去向：文本域全文作为 `supplement_prompt`（≤5000 字）随生成请求提交（estimate → confirm → submit 三步），最终提示词由服务端落 `generation_requests.prompt` 供审计回溯。**已知的三个缺口**：①名称/画面描述已独立传达，但 `metadata.lite.notes`（备注）仍未拼进生产意图；②风格段引用链缺失时回落为空串，用户看到提示词只有资产段，感知不到"默认风格"存在；③`new_variant` 模式非首变体不预填，变体描述不参与任何自动拼接（首变体自 v2.5 起预填资产信息，见下方决策 3 修订）。


**决策（生成配置合同）**：

1. **默认值 = 项目配置**。弹窗打开时读 `GET /projects/:project_id/generation-defaults/image`（`generation_default_strategies` 表）：模型 = `model_key`（tier_id），画幅 = `parameters.ratio`，清晰度 = `parameters.size`，风格模板 = `parameters.prompt_template_id` 引用的 `prompt_templates` 行。配置缺项时回落：模型/画幅/清晰度 → 首个 active 档；模板 → 平台默认模板（`prompt_default_templates` 表，迁移 064）→ 空。
2. **弹窗内可临时改模型、画幅、清晰度**，选项全部来自 active 档（`GET /api/v1/generation/capability-tiers?media_type=image`，档位由 `pricing_rules` active 行投影而来，前端不手写模型 ID）。选择器为三级级联：**模型 → 画幅（aspect_ratio）→ 清晰度（resolution）**，每级只列当前组合下真实存在 active 档的选项；切上级时下级收敛到合法首项（沿用现有"多档取最便宜"兜底）。改动**只影响本次生成**，不写回项目配置——写回仍走配置页「保存」或既有的"保存为项目默认配置"入口（问题四既有约束）。
3. **提示词拼接合同**（弹窗 A 新建资产与弹窗 B 加图/新建变体完全一致，同一函数）：

   ```
   最终提示词 = 项目默认风格模板（prompt_templates 中 prompt_template_id 命中的行内容；一个项目同媒介有且只有一个默认风格 = generation_default_strategies 每 (project_id, media_kind) 一行 + 单个 prompt_template_id 引用）
              + 资产描述与备注（name + intro/description + metadata.lite.notes）
              + 用户在弹窗内临时补充/修改（文本域可整体编辑）
   ```

   - 模板库（`prompt_templates`）允许同项目同媒介**多个**模板；"默认风格"是 `generation_default_strategies.parameters.prompt_template_id` 的引用关系，天然唯一，不需要也不允许新增"多默认"机制。模板 id 缺失/软删回落系统默认（`prompt_default_templates`，空内容口径不变，`effectivePromptTemplate` 已实现）。
   - 拼接在客户端完成、随 `supplement_prompt` 提交（≤5000 字，服务端 zod 已有），服务端生成期不读模板表——`lite-model-defaults.md` §4.3 既有合同不变。
   - `new_variant` 模式（v2.5 修订）：资产无任何变体（首变体）时预填资产 name/intro/note，提示词 = 默认风格模板 + 资产信息（与 add_image 同口径）；资产已有变体时表单空白，提示词 = 默认风格模板，用户填的变体描述进入临时补充段。判定 = 详情页传 `noExistingVariant = variants.length === 0`，弹窗内 `shouldPrefill = !isNewVariant || noExistingVariant === true`。

**改动的文件 / 函数**：

| 文件 | 函数 / 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-add-image-dialog.tsx` | `loadTier`（现约 148-176 行） | 默认值读取补画幅/清晰度：`strat.parameters.ratio` / `size` 参与默认档匹配（复用 `lite-generation.ts` 的 `resolveLiteTier` 口径），匹配不到回落首个 active 档 |
| 同上 | `handleRatioChange` + 新增 `resolutionOptions` / `handleResolutionChange`（现约 406-433 行） | 拆出第三级"清晰度"下拉：同模型同比例下列出所有 active 分辨率档；选清晰度 = 精确定位 tier |
| 同上 | 提示词预填块（现约 168-173 行） | `assetInfo` 从 `[name, intro]` 扩为 `[name, intro, notes]`（备注 = `asset.metadata.lite.notes`，经 `LiteAssetDetail` 下发） |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-create-dialog.tsx` | 同款三处（`loadTier` / 比例选择器 / 提示词预填，现约 176-228 行） | 与弹窗 B 保持同一合同；两弹窗拼接统一走 `assembleAssetImagePrompt`（见下） |
| `frontend/shortdrama-rag-demo/src/lite-prompt-templates.ts` | `assembleAssetImagePrompt(opts: { template, name, intro, notes }): string` | 两弹窗共用的拼接纯函数 |
| `frontend/shortdrama-rag-demo/src/api.ts` | `LiteAssetDetail` 类型 | 确认 `metadata.lite.notes` 已下发；未下发则在详情响应映射里补（后端 `GET /lite/assets/:asset_entity_id` 已返回 metadata，前端类型补字段即可） |

后端：**无改动**。默认配置读 `generation_default_strategies`、档位读 `pricing_rules` 投影、`supplement_prompt` ≤5000、`prompt_templates` 模板库均已就绪。

### v1.4 数据库影响

**结论：零迁移。** 涉及的表全部已存在，无新表、无新列、无新约束：

| 表 | 角色 | 本迭代是否改动 |
|---|---|---|
| `generation_default_strategies` | 项目级默认生成配置：`model_key`（= tier_id）+ `parameters`（`ratio` / `size` / `prompt_template_id`）；`(project_id, media_kind)` 唯一 → "一个项目一个默认风格"由此保证 | 否 |
| `prompt_templates` | 项目模板库（可多个），软删 | 否 |
| `prompt_default_templates` | 平台级默认模板（迁移 064 已建并播种） | 否 |
| `pricing_rules` | active 行投影出能力档（`capability-tiers` 模块 `capabilityTiersFromPricingRules`），模型/画幅/清晰度选项来源 | 否（要多模型 = 运营侧配置更多 active 价格档，不改代码） |

### v1.4 测试标准（T12）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T12.1 | 卡片网格收窄 | 项目有 ≥12 个资产 | 桌面端打开素材页 | 一行 4-6 张卡（随视口断点）；卡图为方形 `aspect-square`；骨架屏同断点 |
| T12.2 | 详情页无大图卡 | 资产有主图 | 打开详情页 | 左栏只有变体卡片网格，无 sticky 主图大卡；滚动左栏无吸附大图 |
| T12.3 | 看图走 lightbox | 变体有图 | 点击变体卡封面 / 信息面板小封面 / 版本轨缩略图 | 均打开 lightbox，定位到对应图，可左右切换、可设主图 |
| T12.4 | 无图变体点击 | 变体无图 | 点击变体卡封面占位 | 打开弹窗 B（`add_image` 模式），不是 lightbox |
| T12.5 | 默认值来自项目配置 | 项目图片默认配置指定模型 X / 9:16 / 2K | 打开弹窗 B AI 生成 tab | 三级选择器预选 X / 9:16 / 2K；未配置时回落首个 active 档 |
| T12.6 | 清晰度可选 | 同模型同比例存在 1K 与 2K 两个 active 档 | 弹窗内切清晰度 | 清晰度下拉列出两档且可切换；提交 `tier_id` 与所选一致，不再恒取最便宜档 |
| T12.7 | 多模型可选 | active 价格档含 ≥2 个图片模型 | 打开弹窗查看模型下拉 | 模型下拉列出全部 active 模型（当前线上只有 1 个模型时下拉只有 1 项属预期，非缺陷） |
| T12.8 | 提示词含备注 | 资产 `metadata.lite.notes` 非空 | 打开弹窗 B（add_image） | 预填提示词 = 默认风格模板 + 名称/描述/备注 |
| T12.9 | 两弹窗同合同 | 新建资产（弹窗 A）与加图（弹窗 B） | 同资产信息分别打开两弹窗 | 提示词拼接结果一致（同一 `assembleAssetImagePrompt`） |
| T12.10 | 临时改配置不写回 | 弹窗内改模型/画幅/清晰度并生成 | 查看 `generation_default_strategies` | 行不变（version 不前进）；仅本次 `generation_requests` 用所选档 |

### v1.4 通过标准

- T12.1–T12.10 全部通过 = v1.4 可交付。
- T12.7 的多模型展示依赖 active 价格档数量；档只有一个模型时 UI 行为正确即通过，不因"只有一个选项"判失败。


## 问题八（v1.5 建议）：人工新建变体的剧集动态匹配

> 2026-08-17 需求：一键生成本集后，解析只按**资产名精确匹配**做 backfill（`backfillShotAssetReferences`，`matched_by: "exact_name"`，挂第一个变体）。用户人工新建的变体——如剧本没写"穿泳衣"所以解析不出泳装，用户手动建「xxx-泳装」变体——永远不会被匹配到集-分镜-场景。需要一套符合制作逻辑的匹配规范。**结论：变体级「✨ 匹配剧集」按钮，AI 给建议、用户勾选确认后才写入，manual 永不被自动覆盖。**

### 八.1 问题拆解

1. **剧本没有的变体匹配不到**：backfill 是资产名 → shot 候选 `characterNames/sceneNames/propNames` 的精确对拍，变体名（「战甲造型」「泳装」）不参与，且命中也只挂第一个变体。
2. **用户方案辨析**：
   - ~~保存变体时自动调模型重新匹配全剧~~ —— 否决：违反"先建议后写入"原则（与付费红线同源的"机器不替人做判定"口径）；自动写会覆盖用户已填的关联；用户刚建变体还没生图，匹配时机也不对。
   - **每个变体的出现记录区加「✨ 匹配剧集」按钮，AI 出建议清单，用户逐条勾选后才写入** —— 采用。用户对结果有完全控制权，覆盖风险归零。
3. **同名变体撞车**（用户举例：变体名叫「女主」，很多集分镜都涉及）：见八.3 命中去重规则。
4. **剧本已点名的集是否重做匹配**：已存在 manual 或 exact_name 关联的 shot 不重复建议（去重），避免噪音；AI 只找"缺口"。

### 八.2 匹配规范（制作逻辑）

**触发**：详情页选中某变体 → 出现记录区头部「✨ 匹配剧集」按钮。**只在变体级触发**（资产级无此按钮——第一个变体/脚本解析资产的集、分镜、场景已由路径①一键生成本集 backfill 自动落齐，并可经路径③手动增删修改；AI 匹配只补人工新建变体的缺口）。匹配方向（资产侧声明 → 分镜）见 8.8。

**范围**：默认本项目**所有已确认（confirmed）集**的正式 `shots`；未确认集不参与。点按钮时可先选**集范围**（默认全部，可勾选特定几集）——命中过多或只关心某几集时收窄范围重跑。

**输入（服务端拼给模型的上下文）**：

- 变体档案：变体名、描述、备注；所属资产名、类型、描述、备注、类型特有字段（外貌/款式等正式列与 `metadata.lite.profile`）。
- 分镜清单（逐条，取自正式 `shots` 行，不读候选 JSON）：`episode_no / shot_no / scene_name / title / script_text / breakdown_elements`。**匹配对象 = 按分镜切好的剧本单元**——`script_text` 是该分镜的剧本原文，`breakdown_elements`（subject/action/visual/camera_language）是解析出的结构化拆解。模型做的是**语义判断**（"泳装" vs "她换上衣服走向游泳池"这类推断），不是名字精确对拍；这正是精确名 backfill 做不到、需要 AI 补位的原因。
- 该变体与该资产的**已有关联 shot_id 全集**（manual + exact_name + pending），指令里要求排除。

**模型调用**：复用 AI 网关文本通道（`AiGatewayService`，`COL_TEXT_MODELS` 路由口径，与 `prompt-draft` 同款），独立 purpose（如 `variant_match_suggest`）计入日调用限额。输出结构化 JSON：`[{ episode_no, shot_no, reason }]`，每条 ≤ 一句理由。**模型不返回场景名**——定位键 `(episode_no, shot_no)` 已唯一，多要一个字段只增加幻觉面。**AI 只给建议，不写任何表。**

**命中判定（服务端校验，不信模型）**：模型返回的 `(episode_no, shot_no)` 必须能经 `findShotByLabel` 定位到真实 `shots` 行才进建议清单；定位不到的丢弃（防模型幻觉）。**场景名由服务端补齐**：定位到 shot 后取 `shots.scene_id → scenes.name` 填入建议条目，展示格式与出现记录一致（`第N集 · 第N个分镜 · {scene_name}`）——场景名永远来自真实分镜，不是模型输出。


**去重与冲突规则**：

| 规则 | 处理 |
|---|---|
| shot 已有本变体关联（manual / exact_name / pending） | 不进建议清单 |
| shot 已有**同资产其它变体**的关联 | 进清单但标黄"该镜头已关联「战甲造型」"，勾选则**并存**（同一镜头允许引用同资产多个变体，`(asset_entity_id, variant_id)` 二元组本就是匹配键），不静默替换 |
| 同一集多个 shot 命中 | 正常——一个变体在同一集出现多次是常态（女主一集多个镜头）；但**同一 shot 只出现一条建议**，不存在同 shot 双绑 |
| 变体名太泛（「女主」）命中爆炸 | 建议清单上限 50 条，超出不展示、不静默截断，提示两条出路：①收窄集范围重跑；②补充变体描述再匹配。另注：「女主」这类名字本身是**资产**不是变体——变体正确粒度是「女主-泳装」「女主-战甲」，规则会自然把用户引导到正确粒度 |

**写入（用户勾选确认后）**：复用 `POST /lite/assets/:id/usages` 批量路径（matched_by = `"manual"`，与手动关联完全同路径）：命中真实分镜 → bound + 回填 `shots.reference_asset_snapshots`；未命中 → pending 待绑定。**AI 建议本身不引入新的 matched_by 值**——用户确认即 manual，与亲手填的关联地位相同，永不被 backfill 覆盖（既有 manual 优先口径）。

**覆盖提示**（用户要求）：点按钮时弹说明——"AI 只给建议，不会改动你已填的关联；只有你勾选的条目才会写入（按手动关联处理）"。出现记录里 manual / exact_name(自动) / pending 的徽记沿用现状，用户随时能分辨哪些是 AI 建议写入的（本次会话内清单可回溯；不额外持久化建议日志）。

**重跑**：按钮可反复点；每次都先拉当前关联做排除，所以重复点不会产生重复建议。

### 八.3 「同一集匹配到两个变体」的口径

- **同一集、不同 shot** 命中不同变体：正常，各自独立条目，无冲突。
- **同一 shot、同资产两个变体**：模型按八.2 去重不会重复建议同一 (shot, variant)；用户主动把两个变体都勾上同一 shot 时**允许并存**——`(asset_entity_id, variant_id)` 二元组匹配键天然支持（问题五.5 合同），分镜生成按各自变体主图引用。
- **同一 shot、两个不同资产**（如角色「女主」+ 服装「泳装」）：本就合法（shot 的 `reference_asset_snapshots` 是数组），不受本功能影响。

### 八.4 改动的文件 / 函数

后端（`src/modules/lite/` + `src/modules/ai/`）：

| 文件 | 函数 / 位置 | 改动 |
|---|---|---|
| `src/modules/lite/service.ts` | 新增 `suggestVariantUsages(actor, projectId, assetEntityId, variantId)` | 组装八.2 上下文 → 调 AI 网关（复用 `AiGatewayService` 注入，参考 script-breakdown service 的模型调用方式）→ 解析 JSON → `findShotByLabel` 校验每条 → 排除已有关联 → 返回建议数组（≤50 条） |
| `src/modules/lite/routes.ts` | 新增 `POST /api/v1/projects/:project_id/lite/assets/:asset_entity_id/variants/:variant_id/match-suggest` | 只返回建议，不写库；zod 校验输出 schema |
| `src/modules/lite/repository.ts` | 无新方法 | 写入全部复用现有 `addAssetUsages`（批量 bound/pending 路径） |

前端：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 出现记录区头部（`usages` 渲染区，现约 615 行） | 选中变体非空时显示「✨ 匹配剧集」按钮 + 覆盖说明弹层 |
| 同上 | 新增建议清单弹层组件 | 展示 `(集, 镜, 理由)` 勾选列表；冲突标黄；确认 → `api.addAssetUsages`（variant_id 带入）→ `loadUsages` 刷新 |
| `frontend/shortdrama-rag-demo/src/api.ts` | 新增 `matchVariantUsages(projectId, assetId, variantId)` | 调 match-suggest 路由 |

### 八.5 数据库影响

**零迁移。** 匹配读写的表全部已存在：

| 表 | 在匹配中的角色 | 本功能改动 |
|---|---|---|
| `episodes` | 集（`episode_no` / `name` / `status`）；只提供已确认集范围 | 否（只读） |
| `scenes` | 场景（`episode_id` 挂集，`scene_no` / `name` / `description`）；`shots.scene_id → scenes.name` 补场景名 | 否（只读） |
| `shots` | 分镜，核心匹配对象：`script_text`（该镜剧本原文）/ `title` / `breakdown_elements`（subject/action/visual/camera_language）；写入端 `reference_asset_snapshots`（JSONB） | 否（写入复用现有 backfill 同字段） |
| `asset_entities` | 变体所属资产 + `metadata.lite.usages`（关联条目，flat 格式，`matched_by` 区分 manual/exact_name） | 否（写入复用 `addAssetUsages`） |
| `asset_variants` | 变体行（名称/描述/备注取这里） | 否（只读） |

集-分镜-场景的对应链：`episodes.id → scenes.episode_id → shots.scene_id`（`shots.episode_id` 亦直挂集）；展示标签"第N集 · 第N个分镜 · 场景名" = `episodes.episode_no` + 分镜序号 + `scenes.name`。`shot_asset_refs`（迁移 065，完整版可编辑引用真值表）lite 现流程不经过，本功能同样不引入。建议清单本身不落库（无新表）；AI 调用走现有网关与日限额。

### 八.6 测试标准（T13）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T13.1 | 剧本未点名变体补匹配 | 剧本"度假日早晨卧室去游泳池"未写泳衣；已建「泳装」变体 | 点「✨ 匹配剧集」→ 勾选游泳池相关镜头 → 确认 | 建议含相关 shot 且理由合理；确认后 bound 条目入 `metadata.lite.usages`（manual）+ 回填 shot 快照 |
| T13.2 | 建议不自动写 | 点按钮 | 只点按钮不勾选 | 无任何 usages / 快照写入（数据库行数不变） |
| T13.3 | 已有关联不重复 | 变体已手动关联镜5 | 再点匹配 | 建议清单不含镜5 |
| T13.4 | manual 不被覆盖 | 变体有 manual 关联 | 匹配后确认其它建议 | manual 条目原样保留，新条目并存 |
| T13.5 | 泛名命中爆炸 | 变体名「女主」，全剧 200 镜 | 点匹配 | 建议上限 50 条并提示补充描述；不静默截断写入 |
| T13.6 | 同 shot 不双绑 | 模型返回同 shot 两条 | 服务端校验后 | 建议清单该 shot 只一条 |
| T13.7 | 同 shot 跨变体并存 | shot 已关联同资产「战甲」变体，「便装」变体匹配命中该 shot | 勾选确认 | 两变体条目并存（二元组键），分镜生成各取各变体主图 |
| T13.8 | 幻觉 shot 丢弃 | 模型返回不存在的镜号 | 服务端 `findShotByLabel` 校验 | 该条不进清单，不报错 |
| T13.9 | 未确认集不参与 | 第 3 集未确认 | 点匹配 | 建议只来自已确认集的正式 shots |
| T13.10 | pending 待绑定 | 建议含已确认集镜号 | 勾选确认 | 走现有 bound/pending 路径，行为与手动批量关联一致 |

### 八.7 待裁项

1. AI 建议理由是否持久化（当前方案：只在会话内展示，不落库）。若要审计"哪条关联是 AI 建议的"，需给 `matched_by` 加第四值（如 `ai_suggested_manual`）——涉及读取端归一化改动，建议有审计需求时再立项。
2. 匹配粒度是否需要"场景级快捷"（按场景名批量勾选整个场景下所有镜）——第一期先不做，清单勾选已覆盖。

### 八.8 匹配方向修正与三路统一匹配合同（2026-08-17 补充）

> 用户反馈（2026-08-17）：「资产和分镜的匹配流程不对。不管是哪个资产，或者具体的资产变体，在一键生成本集时，应该有具体资产或者资产变体对应的集、分镜、场景；后面新建变体，通过点击 AI 匹配，也是最后能落到具体资产的集、分镜、场景；而具体资产或者变体的集、分镜、场景，用户可以手动修改，然后关联到具体的分镜——所以分镜应该是根据资产或者资产变体的集、分镜、场景来做正确匹配。」

**方向修正（本节结论）**：

- **匹配方向是单向的：资产侧（资产或变体）声明「集、分镜、场景」→ 写入分镜的 `reference_asset_snapshots`。** 分镜是被动方：不自己找资产、没有独立的匹配入口。「分镜根据资产/变体的集分镜场景做正确匹配」正是在这个意义上成立——分镜的引用清单完全由资产侧声明决定，生成时服务端只按分镜身上携带的 `(asset_entity_id, variant_id)` 二元组读取消费。
- 集、分镜、场景是每条关联条目的必备属性（三要素），不是可选装饰：集定范围（`episodes.episode_no`）、分镜号定位真实分镜（`shots.sort_order` 优先）、场景名做歧义消解与展示（`scenes.name`）。展示标签统一「第N集 · 第N个分镜 · 场景名」。
- 三条写入路径（一键生成本集 backfill、AI 匹配、手动关联）**同形、同写入位置、同幂等键**：任何一条都必须最终落到真实 `shots.id`，并向 `metadata.lite.usages` 写入同形状条目（variant_id + 三要素 + matched_by + status）。

**三路统一合同**：

| 路径 | 触发时机 | 集/分镜/场景怎么落 | matched_by | 挂哪个变体 |
|---|---|---|---|---|
| ① 一键生成本集（materialize backfill） | 集确认后 materialize | **两层**：A `(asset_kind, name)` 精确对拍 → `shots.source_candidate_id` 反查真实分镜（v1.3）；B 变体名/别名 vs 分镜 `subject/visual/script_text` 保守命中非第一变体（v1.7，八.10）；集=当前集、分镜号=候选分镜号、场景名=候选场景名 | `exact_name`（两层同标记） | A=第一个变体；B=命中的非第一变体 |
| ② AI 匹配（问题八） | 用户选中变体点「✨ 匹配剧集」 | 模型返回 `(episode_no, shot_no)` 建议 → 服务端逐条经 `findShotByLabel` 校验落到真实分镜（幻觉镜号丢弃），场景名由服务端从真实分镜补齐 | `manual`（用户勾选后才写入） | 用户选中的变体 |
| ③ 手动关联 | 用户在出现记录填集/分镜号/场景名保存 | 服务端立即经 `findShotByLabel` 解析：命中 → bound；未命中（集未确认/镜号不存在）→ pending，集确认时自动回补（`reconcilePendingAssetUsages`，已内联 `confirmRun` 事务） | `manual` | 用户指定变体或资产级 |

**公共规则（三路共同遵守）**：

1. **同幂等键**：都按 `(shot_id, variant_id)` 写入与去重，同一分镜对同一资产同一变体不可能多绑。
2. **manual 永不被 exact_name 覆盖**：②③ 写入的条目不被 ① 重跑覆盖；① 只更新自己的 exact_name 条目。
3. **跨变体并存**：同一资产的多个变体可关联同一分镜（二元组匹配键），生成时各取各变体主图。
4. **未确认集没有真实分镜**：① 此时无可回填；③ 落 pending 待绑定，集确认后自动转 bound；② 候选范围不含未确认集。
5. **删除对称**：资产侧删除关联（manual）同步移除分镜上对应快照；分镜侧删除的自动项（A/B 两层）不被 backfill 重新 push——抑制名单落 `shots.metadata.lite.removedAutoRefs`（v1.7 补齐，八.10.4；问题三 T5.5/T5.6 口径）。
6. **零迁移**：三要素存于 `metadata.lite.usages`（flat 条目）与 `shots.reference_asset_snapshots`（JSONB），均为既有字段。

**用户问题的逐条回答**：

- 「一键生成本集时，资产/变体应有对应的集、分镜、场景」→ 路径①：确定性层（v1.3）挂第一个变体 + 变体语义层（v1.7，八.10）自动落非第一变体，均带三要素。仍无法确定性命中的语义缺口（剧本没写变体名、只有同义暗示）由路径②补。
- 「新建变体后点 AI 匹配，最终落到具体资产的集、分镜、场景」→ 路径②（八.2–八.6）：AI 只给建议，用户勾选确认后走与手动关联完全相同的写入路径，条目带变体与三要素。
- 「集、分镜、场景用户可手动修改，然后关联到具体分镜」→ 路径③（v1.3 已实现，变体级多条目表单）：逐条增删、保存即解析真实分镜并同步分镜快照；修改对下一次生成生效，已提交任务用冻结快照不受影响。
- 「分镜是否应根据资产/变体的集、分镜、场景来做正确匹配？」→ **是，且只有这一个方向。** 分镜的剧本原文只是路径②语义匹配的输入（给模型读），判定权与写入权始终在资产侧用户手里，分镜侧不存在自动匹配逻辑。

**测试标准（T14，统一合同）**：

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T14.1 | 一键生成本集落三要素 | 集已确认，剧本点名资产「任天野」 | 一键生成本集 → 查看资产详情出现记录 | 每条目带「第1集 · 第N个分镜 · 场景名」完整三要素，变体=第一个变体，`(自动)` 徽记 |
| T14.2 | AI 匹配落三要素 | 手动建「泳装」变体 | ✨ 匹配剧集 → 勾选一条 → 确认 | 条目形状与手动关联完全一致（manual、变体=选中变体、三要素齐全），场景名来自真实分镜 |
| T14.3 | 手动修改重新关联 | 资产有 ① 自动关联镜5 | 删除该条 → 手动新增第3集镜8 | 镜5 快照移除、镜8 bound；镜8 生成时消费该资产，镜5 不再消费 |
| T14.4 | 三路幂等并存 | 同一分镜：① backfill 挂第一变体 + ② 匹配「泳装」变体 | 查看出现记录与分镜快照 | 两条目并存（variant_id 不同），生成时各取各变体主图，互不串图 |
| T14.5 | 手动修改不影响已提交任务 | 分镜已提交生成 | 修改该资产的关联分镜 | 已提交 `generation_requests.reference_asset_snapshots` 不变；新关联只影响下一次生成 |


### 八.9 实现改动清单与数据库影响（v1.6）

> 按八.4 与 8.8 合同列出 v1.6 需要改动的每一个文件与涉及的表。当前唯一未实现的缺口是路径②（✨ 匹配剧集，八.2–八.7 已有规格）；路径①③已在码、零改动。

**后端——AI 网关（只登记用途）**

| 文件 | 函数 / 位置 | 改动 |
|---|---|---|
| `src/modules/ai/types.ts` | `aiPurposes`（第 3 行） | 枚举加 `"variant_match_suggest"`；随既有审计与日限额计入 |
| `src/modules/ai/service.ts` | `aiGatewayConfiguration()` 的 `purposeModels`（现约 234 行） | **不加专用条目**——该 purpose 按 `modelForPurpose` 既有规则回落 `defaultModel`（与 `generation_orchestration` 等无专用配置的用途同款） |

**后端——lite 模块（路径②主体）**

| 文件 | 函数 / 位置 | 改动 |
|---|---|---|
| `src/modules/lite/types.ts` | `LiteRepository` 接口 + 类型区 | 接口新增 3 个**只读**方法：`listShotsForMatchSuggest`（已确认集 × 正式 shots 的三要素投影）、`findShotSuggestInfo`（按 shot_id 回单条三要素）、`findVariantForMatchSuggest`（变体名/描述/备注）；新增输出类型 `LiteMatchSuggestItem` / `LiteMatchSuggestShotRow` / `LiteVariantMatchProfile` |
| `src/modules/lite/repository.ts` | 实现上述 3 个方法 | 只读 join：`episodes`（confirmed、未软删）→ `shots` → `scenes`；投影 `episode_no / shot_no(shots.sort_order) / scene_name / title / script_text / breakdown_elements`。写路径**不加任何新方法**——确认后的写入全部走既有 `addAssetShotUsages` |
| `src/modules/lite/service.ts` | 新增 `suggestVariantUsages(actor, projectId, assetEntityId, variantId)` | 八.2 全流程：拼上下文（变体档案 + 所属资产档案 + 分镜清单 + 该资产/变体已有关联 shot_id 全集作排除）→ `AiGatewayService.completeValidated({ purpose: "variant_match_suggest", thinking: "disabled" })` → zod 解析 `[{ episode_no, shot_no, reason }]` → 逐条 `findShotByLabel` 校验、幻觉镜号丢弃 → `findShotSuggestInfo` 补三要素（场景名来自真实分镜）→ 排除已有关联（本变体 manual/exact_name/pending + 资产级 pending）→ 上限 50 条、超出置 `truncated` 标记返回。**本方法零写库** |
| `src/modules/lite/routes.ts` | 新增 `POST /api/v1/projects/:project_id/lite/assets/:asset_entity_id/variants/:variant_id/match-suggest` | 只返回建议；`LiteRouteDependencies` 增加可选 `createGateway?: (db: Database) => Pick<AiGatewayService, "completeValidated">` 供测试注入 fake；响应 `{ items: [{ episode_no, shot_no, scene_name, shot_id, reason, conflict_variant_name? }], truncated: boolean }` |
| `src/modules/lite/routes.test.ts` | `FakeLiteRepository` + 新用例 | fake 补齐 3 个新只读方法；注入 fake gateway（绝不触达真实模型）；覆盖 T13.2（只点不勾零写入）/ T13.3（已有关联不重复）/ T13.6（同 shot 不双绑）/ T13.8（幻觉镜号丢弃）/ T13.9（未确认集不参与） |

**前端**

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/api.ts` | lite 资产区（现约 2810 行附近） | 新增 `matchVariantUsages(projectId, assetEntityId, variantId)` 调 match-suggest 路由；新增 wire 类型 `LiteMatchSuggestItem`（防御解析同 `liteUsageEvidenceFromUnknown` 口径） |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 出现记录区头部（现约 614 行） | 选中变体非空时显示「✨ 匹配剧集」按钮；点击 → 覆盖说明层（AI 只给建议，只有勾选条目才写入，按手动关联处理）→ 调 `api.matchVariantUsages` → 建议清单弹层（勾选框 + 「第N集 · 第N个分镜 · 场景名」+ 一句理由；该 shot 已关联同资产其它变体时标黄并注名）→ 确认走既有 `api.liteAddShotUsages`（每条带 `variant_id`）→ `loadUsages` 刷新。demo 模式隐藏入口 |

**数据库影响：零迁移**（与八.5 一致，逐表确认）

| 表 | 本迭代是否改动 | 在 v1.6 中的角色 |
|---|---|---|
| `shots.reference_asset_snapshots` | 否 | 分镜引用的唯一写入位置；写入复用既有 `writeManualSnapshots`（与路径③同一函数，同幂等替换规则） |
| `asset_entities.metadata.lite.usages` | 否 | 资产侧三要素 usage 条目；写入复用既有 `addAssetShotUsages`（bound/pending 同路径③） |
| `ai_calls` | 否（schema 不动） | 新 purpose `variant_match_suggest` 经既有 `AiGatewayService` 预留—记账—失败关账流程自然落审计行，计入 `aiDailyCallLimit` 日限额 |
| `episodes` / `scenes` / `shots` / `asset_variants` | 否（只读） | 建议清单的分镜投影与三要素补齐 |
| `script_breakdown_runs` | 否（只读） | 判定集是否 confirmed（`status = 'confirmed'`）；未确认集不进入匹配范围 |

**明确不改的（避免误解与范围蔓延）**

- 路径①（materialize backfill）与路径③（手动关联）**零代码改动**——已满足 8.8 合同。
- 生成侧消费链（`generation/routes.ts` `resolveControlReferences` → `generation/repository.ts` `resolveShotAssetVariantReferences`）**零改动**——只按 `(asset_entity_id, variant_id)` 二元组读快照，对三条写入路径一视同仁。
- 不引入 `shot_asset_refs`（迁移 065 的完整版可编辑引用真值表）进 lite 流程。
- 不给 `matched_by` 加第四值：AI 建议勾选后的写入仍是 `manual`（8.8 公共规则 2；8.7 待裁项 1 有审计需求时再立项）。
- 建议清单不落库、不持久化（八.7 待裁项 1 现方案）。


### 八.10 路径①自动匹配的变体级兼容（v1.7：一集多变体自动落位）

> 2026-08-17 需求：路径①只按资产名精确对拍、永远挂第一个变体——「一集内不同分镜用同一资产的不同变体」（镜1-5 林晚-基础、镜6-10 林晚-泳装）自动匹配表达不出来，全靠路径②/③人工补。本节把路径①升级为**变体级**：确定性层不动，新增变体语义层，重跑后一集多变体自动落位，仍零人工点击、仍遵守 8.8 全部公共规则。**先改文档（本节），再改代码。**

**八.10.1 决策摘要**

| # | 决策 |
|---|---|
| D1 | 路径①升级为两层：**A 确定性层**（现有 `(asset_kind, name)` 精确对拍挂第一个变体，行为不变）；**B 变体语义层**（新增，只处理非第一变体）。两层都写 `matched_by: "exact_name"`。 |
| D2 | B 层匹配 = `(asset_kind 内)`变体名/别名 对分镜 `breakdown_elements.subject / visual` + `script_text` 做**保守子串命中**；确定性、不花钱、可审计。命中歧义（同镜多个变体同时命中）→ 该镜全部跳过，留给路径②/③。 |
| D3 | B 层是否叠加 AI 复核（复用 `variant_match_suggest` 文本通道，只收窄不收宽）→ **待裁项**，第一期不做；保守子串命中 + 路径②兜底已覆盖主场景。 |
| D4 | B 层写入与 A 层同幂等键 `(shot_id, variant_id)`、同 `exact_name` 标记；**manual 永不被覆盖**（8.8 规则 2 原样适用）；同键已有条目整体刷新。 |
| D5 | **无开关**：默认对全部 lite 项目生效，不引入配置层（AGENTS.md 第 2 条）。风险控制靠 D2 保守命中 + manual 覆盖 + 重跑只增不删。 |
| D6 | B 层**只增不删**：变体不再命中（剧本改了）时旧条目保留——删除权只在用户手里（资产侧删条目 / 分镜侧删引用）。 |

**八.10.2 B 层匹配算法（伪码）**

```
对本集每个非第一变体 v（所属资产 a）:
  names = [剥前缀(v.name)] + v.metadata.lite.aliases（可选）
        剥前缀规则：v.name 以「{a.name}-」或「{a.name}·」开头则剥掉
        （「林晚-泳装」→「泳装」；不剥则全名也参与命中）
  for 本集每个真实分镜 s（经 shots.source_candidate_id 反查，同 A 层范围）:
    text = (subject + " " + visual + " " + script_text)  null-safe 拼接
    if any(name 是 text 的子串 for name in names):
      if 该 (shot, v) 已有任意关联（manual/exact_name/pending，含旧分组格式）→ 跳过
      if 同镜本轮有 a 的其它非第一变体也命中 → 歧义：两变体该镜都跳过
      if (a, v) 在 shots.metadata.lite.removedAutoRefs 名单里 → 跳过
      else 写入：usage(exact_name, variant_id=v, 三要素) + shot 快照
           （快照走 writeExactNameSnapshots 同款同对替换规则）
```

- **变体名归一**：只做「剥资产名前缀」一步；不做拼音/分词/同义词扩展——那是路径② AI 的活，B 层保持确定性。
- **别名**：`metadata.lite.aliases` 为可选字符串数组（第一期可不做，变体名命中即够用；留字段不增列）。
- **歧义即跳过，宁可漏不可错**：漏掉的由路径②（✨ 匹配剧集）或路径③补——维持三路分工：①管确定性命中，②管语义推断，③管人工裁决。

**八.10.3 与三路合同的衔接（8.8 公共规则逐条核对）**

| 8.8 规则 | v1.7 下 |
|---|---|
| 1 同幂等键 | B 层同按 `(shot_id, variant_id)` 写入去重 |
| 2 manual 永不被覆盖 | B 层写入前同款 `hasManual` 检查（含旧分组格式），命中即跳过 |
| 3 跨变体并存 | B 层正是一集/一镜多变体的自动来源：镜3 可同时有 林晚-基础（A 层）+ 林晚-泳装（B 层），生成各取各变体主图 |
| 4 未确认集 | B 层与 A 层同一 materialize 调用链，未确认集本就 ConflictError，不涉及 |
| 5 删除对称 | 分镜侧删除记抑制名单（八.10.4），A/B 两层重跑都不复活 |
| 6 零迁移 | 全部落既有 jsonb 字段（`asset_entities.metadata` / `shots.metadata` / `shots.reference_asset_snapshots`），无 DDL |

**八.10.4 分镜侧删除的抑制名单（补齐 T5.5/T5.6）**

现状缺口：T5.5/T5.6 要求「分镜侧删除的自动项不被 backfill 重新 push」，但 `shots` 表当前没有对应存储，A 层重跑实际会复活被删项（文档口径先于实现）。v1.7 一并补齐，A/B 两层共用：

- **存在哪**：`shots.metadata.lite.removedAutoRefs: Array<{ asset_entity_id, variant_id }>`（`shots.metadata` 既有 jsonb 列，`ShotMetadata.lite` 加一个键，零迁移）。
- **写**：分镜页删除某自动引用（exact_name，含 A/B 层）→ 追加该对到名单。
- **读**：`backfillShotAssetReferences`（A 层）与 B 层写入前都先查名单，命中即跳过 push。
- **解除**：资产侧重新手动关联该 `(asset, variant, shot)`（manual 写入）→ 从名单移除该对——用户显式恢复意愿优先。

**八.10.5 改动清单**

| 文件 | 改动 |
|---|---|
| `src/modules/lite/repository.ts` | ① `backfillShotAssetReferences` 增 B 层：命中计算 + 写入循环（复用 usages/快照写路径与 `hasManual` 守卫）；② A/B 写入前查 `shots.metadata.lite.removedAutoRefs`；③ 新增私有 `removeShotAutoRef`（分镜侧删除：移除快照 + 追加名单） |
| `src/modules/lite/service.ts` | materialize 编排不变（单事务内 A+B 两层均为纯计算+写入，无需模型调用）；B 层异常捕获后不阻断 materialize，响应带 `variant_match_skipped` 原因 |
| `src/modules/lite/types.ts` | `LiteMaterializeAssetsResult` 增 `variantMatches: number`；`ShotMetadata.lite`（`src/db/schema.ts` 类型区）增 `removedAutoRefs` 键 |
| 分镜页删除引用端点（lite 分镜路由） | 改调 `removeShotAutoRef`（现状若直接改 JSON 则迁移过来） |
| `src/modules/lite/routes.test.ts` | T15 用例（fake repository 注入分镜文本） |

**测试标准（T15）**

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T15.1 | 一集多变体自动落位 | 资产「林晚」有 基础/泳装 两变体；剧本镜1-5 点名林晚、镜6-10 的 visual 含「泳装」 | 一键生成本集 | 镜1-5 挂 林晚-基础（A 层）；镜6-10 额外挂 林晚-泳装（B 层）；均 `exact_name`、带三要素 |
| T15.2 | 歧义跳过 | 同一镜 visual 同时含「泳装」「战甲」（两个非第一变体名） | 一键生成本集 | 该镜两个变体都不自动挂；A 层基础变体照常 |
| T15.3 | manual 保护 | 镜3 已手动绑 林晚-泳装 | 重跑一键生成本集 | 镜3 泳装 manual 条目不动，B 层跳过该镜该变体 |
| T15.4 | 重跑不删 | 第一次命中镜8 泳装；改剧本去掉「泳装」字样后重跑 | 查看镜8 | 旧 B 层条目保留（只增不删）；去除走资产侧/分镜侧删除 |
| T15.5 | 分镜侧删除不复活 | 分镜页删掉镜5 的泳装自动引用 | 重跑 | 镜5 不重新 push；`shots.metadata.lite.removedAutoRefs` 含 `(林晚, 泳装)` |
| T15.6 | 手动恢复解除抑制 | T15.5 后资产侧重新手动关联镜5 泳装 | 查看名单与快照 | 名单移除该对；manual 条目写入；再重跑不误伤 manual |
| T15.7 | B 层失败不阻断 | 分镜文本字段全空/异常 | 一键生成本集 | materialize 成功，A 层正常，响应带 variant_match_skipped |

**明确不做**：拼音/分词/模糊匹配（交给路径②）；B 层自动删除或降级既有条目（D6）；变体级/项目级开关（D5）；`matched_by` 新增值（B 层仍 `exact_name`）。

## 问题九（v1.8 首发走查修正）：滚动遮挡 / AI 生图积分 / 详情页文案与表单收敛

> 2026-08-18 走查四问：①资产页不能滚动、有些页面底部被遮挡；②AI 生图没有积分——积分在哪个库、本地能否自己加、价格是否恒 60 积分/张、Lite 是否先删价签；③资产详情「管理图片」改「新建资产」；④基础信息收敛为一对保存/取消、出现记录表单删「资产级关联」下拉。**本迭代零数据库迁移。**

### 九.1 资产页不能滚动 / 底部被遮挡（问题一）

**问题与根因**：Lite 壳根容器是 `h-dvh overflow-hidden`（`app.tsx` 现约 406 行，R2-4 去幻影滚动时定），全站没有页面级滚动条——每页必须自带内层滚动容器（`flex-1 min-h-0 overflow-y-auto` 链）。工作台型页面已各自带 `overflow-y-auto`（资产详情左右两栏、制作页左栏与分镜区、配置页文本区、分镜详情左栏）；但文档型页面——素材列表页 `lite-assets-page.tsx`（以及同结构的项目列表页 `lite-projects-page.tsx`）——根 `<section>` 是裸 `flex flex-col`，无高度约束、无滚动容器，内容超一屏时被根容器直接裁掉，表现即「不能滚动、底部被遮挡」。

**决策**：

- 素材列表页根 `<section>`（现约 751 行）追加 `flex-1 min-h-0 overflow-y-auto`，让页身成为内层滚动容器；main 区既有内边距不动。
- 项目列表页 `lite-projects-page.tsx` 根 `<section>`（现约 72 行）同款处理，避免同类遮挡。
- 工作台型页面（详情/制作/配置/分镜详情）已有内层滚动区，不动，不引入双重滚动条。
- 口径固化进走查清单：Lite 每页在 `h-dvh overflow-hidden` 壳下，根容器要么自身是滚动容器、要么含声明的内层滚动区，不允许第三种形态（不滚且不裁的页面不存在）。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-assets-page.tsx` | 根 `<section className="mx-auto flex w-full max-w-[1440px] ...">`（现约 751 行） | className 追加 `flex-1 min-h-0 overflow-y-auto` |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-projects-page.tsx` | 根 `<section>`（现约 72 行） | 同款追加 |

**数据库影响**：无。

### 九.2 AI 生图与积分（问题二）

**积分涉及哪个库（同一个 PostgreSQL，没有第二套）**：积分体系 = S57/S65 账户积分，表全在本应用唯一 PostgreSQL 里（迁移 `034_s57_account_registration.sql`）：

| 表 | 角色 |
|---|---|
| `user_credit_accounts` | 每用户余额 `balance_points` 与日额度 `daily_limit_points`（1 积分 = 1 分钱，DC 冻结 1:1） |
| `user_credit_daily_usage` | 每日已扣积分（每天 0 点重置） |
| `user_credit_ledger_entries` | 不可变流水（`invite_grant` / `admin_adjustment` / `generation_debit`） |
| `account_credit_policies` | 自注册每日额度策略 |
| `invite_tiers` / `invite_codes` / `invite_code_redemptions` | 邀请档位与兑换赠分 |

扣费链：生成消费已确认报价时，迁移 034 的库内触发器 `debit_credit_for_consumed_generation_quote` 在同一事务里原子扣余额 + 日用量 + 写流水。闸门：余额 ≤ 0 时 `assertGenerationPilotCreditAccess`（env `GENERATION_PILOT_CREDIT_GATE_ENABLED`，默认开）在预估/提交预备动作前拒绝，提示「积分不够，请联系管理员调整后再试」。

**本地是否可以自己加积分**：可以，两条路径（任选，优先 ①）：

1. 管理员身份走管理台 → 用户面板 →「调积分」（`POST /api/v1/admin/users/:id/account-credits/adjust`，界面已存在且有测试），流水自动落 `admin_adjustment`。
2. 本地 SQL 直改（仅开发环境）：`UPDATE user_credit_accounts SET balance_points = balance_points + N, updated_at = now() WHERE user_id = '...';`，并补一行 `user_credit_ledger_entries`（`entry_kind = 'admin_adjustment'`、`balance_after_points` = 改后余额、`actor_user_id` = 管理员 id）保流水完整；需要同时放大日额度则改同表 `daily_limit_points`。
   本地开发也可整体关闸：`GENERATION_PILOT_CREDIT_GATE_ENABLED=false`——只关预检闸门，不改计费与流水。

**积分不一定都是 60 积分/张**：价随档走，真源 = `pricing_rules.unit_price_fen`（种子 `scripts/seed-pricing-tiers.mts`）——同模型图片 1K = 30 积分/张、2K = 60 积分/张；suchuang 图片网关 nanobanana-lite 1K = 8 积分/张；视频 80–155 积分/秒；音频 3 积分/秒。界面上看到的「60 积分/张」只是当前选中 2K 档的价签（`tierPriceLabel(selectedTier)`），不是全局常量。

**决策：Lite 版删除积分价签展示**。两个弹窗模型选择区的 `{tierPriceLabel(selectedTier)}` 行（`lite-asset-add-image-dialog.tsx` 现约 672 行、`lite-asset-create-dialog.tsx` 现约 642 行）删除——Lite 用户不需要看到每张单价。只删展示不删计费：服务端仍按真实档价报价扣积分。完整版的档价标签（`capability-tiers.ts` 的 `tierLabel` / `tierPriceLabel`）与 demo fixture 不动——它们服务完整版消耗页与合同测试，不属本条范围。

**数据库影响**：无（积分是既有体系；本条只删前端展示）。

### 九.3 「管理图片」改「新建资产」（问题三）

**决策**：详情页页顶主动作文案「管理图片」→「新建资产」；**行为不变**（用户 2026-08-18 裁定：只改文案）——点击仍打开弹窗 B（`add_image` 模式、primary 按钮）。加图入口本就齐全（版本图素材轨「加图」、变体卡封面点击、「＋ 新建变体」引导卡），本按钮职责不扩张不收缩。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 页顶主动作按钮（现约 526 行）、文件头注释（现约 18 行） | 文案「管理图片」→「新建资产」，注释同步 |
| `frontend/shortdrama-rag-demo/src/lite-asset-detail-page.test.ts` | 文件头注释（现约 6 行）与 T4.4 断言（现约 86 行） | 「管理图片」→「新建资产」（仍是打开弹窗 B add_image 的唯一主动作） |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-add-image-dialog.tsx` | props 注释（现约 54 行） | 「[+管理图片]」→「[+新建资产]」同步 |

本文七.2 的「管理图片」措辞已同步修订（见该节）。**数据库影响**：无。

### 九.4 基础信息一对保存/取消；出现记录删「资产级关联」下拉（问题四）

**九.4a · 基础信息**：现状 `EditableTextRow` 三行（名称/描述/备注）各自进编辑态、各自一对保存/取消——三个字段三套入口，容易漏保存或误以为已保存。**决策**：基础信息三字段收敛为**一个表单**——默认展示态，点「编辑」整体进编辑态，三字段共用**唯一一对保存/取消**；保存一次 `PATCH /api/v1/projects/:pid/lite/assets/:id` 同时提交 name/intro/note（后端 `patchAssetBodySchema` 本就三字段同收，零改动）；取消三字段一并回滚。`EditableTextRow` 组件退役删除（无其他使用方）。

**九.4b · 出现记录**：出现记录（关联分镜）表单自带的确认/取消**保留**（用户确认此点现状正确，不动）。**删除**每行的变体下拉 `<Select>`（含「资产级关联(不指定变体)」选项与变体列表）：出现记录区本就按「当前选中变体」展示，新记录一律挂当前选中变体——「资产级关联」选项与 v1.3 变体级合同（关联分镜是变体级多条目表单）相悖，只会误导。回落规则：未选中变体 → 挂第一个变体；资产无任何变体 → 隐藏「+ 新增关联分镜」入口（变体级合同，先建变体再关联）。「✨ 匹配剧集」按钮与建议清单不受影响（本就变体级，勾选写入带选中变体）。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 基础信息区块（现约 656-664 行） | `EditableTextRow` ×3 → 单表单 + 一对保存/取消；保存合并为一次 PATCH |
| 同上 | `EditableTextRow` 组件（现约 1013 行） | 删除 |
| 同上 | 出现记录表单变体下拉（现约 771-782 行） | 删除 `<Select>`；行 `variantId` 固定取当前选中变体（回落第一个变体） |
| 同上 | 「+ 新增关联分镜」入口（现约 792 行） | 资产无变体时隐藏 |

**数据库影响**：无（复用既有 PATCH 与 `addAssetShotUsages` 合同，后者本就带 `variant_id`）。

### v1.8 测试标准（T16）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T16.1 | 素材列表可滚 | 项目资产超一屏 | 素材列表页纵向滚动 | 页身在主区内滚动；最后一张卡完整可见，不被壳裁切 |
| T16.2 | 项目列表可滚 | 项目数超一屏 | 项目列表页滚动 | 同 T16.1 |
| T16.3 | 工作台页无回归 | 资产详情/制作/配置页 | 各页滚动 | 原内层滚动区正常，无双重滚动条 |
| T16.4 | 零余额拦截与本地加积分 | 账号余额 0 | 弹窗 B 切 AI 生成 → 管理员调积分 → 重试 | 先报「积分不够」；调账后可正常提交；`user_credit_ledger_entries` 有 `admin_adjustment` 流水 |
| T16.5 | Lite 弹窗无价签 | 打开弹窗 A/B 的 AI 生成 tab | 查看模型选择区 | 无「N 积分/张」价签；完整版档价标签不受影响 |
| T16.6 | 价随档走（口径核对） | 查 `pricing_rules` active 图片档 | 对比 1K/2K 档价 | 1K=30、2K=60（suchuang 网关档另有其价），不存在恒定 60 的代码常量 |
| T16.7 | 文案改名 | 任意资产详情页 | 查看页顶主动作并点击 | 文案「新建资产」；点击仍打开弹窗 B add_image，行为与改名前一致 |
| T16.8 | 基础信息单对保存/取消 | 资产详情页 | 编辑名称+描述+备注 → 保存；再编辑 → 取消 | 保存=一次 PATCH 三字段落库；取消三字段全部回滚、无 PATCH 发出 |
| T16.9 | 出现记录无下拉 | 资产有 ≥2 变体，选中变体 A | 点「+ 新增关联分镜」 | 每行只有集数/分镜号/场景三个输入框，无变体下拉；保存后记录挂变体 A |
| T16.10 | 无变体回落 | 资产无任何变体 | 查看出现记录区 | 无「+ 新增关联分镜」入口 |

**v1.8 通过标准**：T16.1–T16.10 全部通过 = v1.8 可交付。积分计费合同（1 积分 = 1 分钱、报价消费触发器、闸门 env）本版本一行不改——改价是管理动作（`POST /api/v1/admin/pricing-rules`），不进 Lite 迭代。

## 问题十（v1.9 二版走查修正）：资产软删 / 详情页按钮撤销 / 生图弹窗不关与调用链 / 变体删除可见 / 失败提醒消退 / 成功才扣积分 / Lite 报价自动确认

> 2026-08-18 二版走查七问：①新建的资产不能删除；②v1.8 改名的「新建资产」按钮实际是变体级动作，不该在资产详情展示；③AI 生图失败且弹窗点击后立刻关闭，并要求理清生图调用哪个接口、什么逻辑、涉及哪些数据库；④变体是否也能删除（能，但入口太隐蔽）；⑤生成失败的右下角提醒不该常驻；⑥失败不应扣积分、成功才扣；⑦Lite 的报价确认步是否改自动确认（是，②并入③）。①–⑤⑦ 零数据库迁移；⑥ 需迁移 068（十.6）。

### 十.1 新建资产可删除（软删）

**现状缺口**：Lite 已有删变体（`DELETE /lite/assets/:id/variants/:vid`）、删媒体（`DELETE /lite/assets/:id/media/:mid`）两个软删路由，但**没有资产级软删**；完整版 `DELETE /api/v1/assets/:asset_id`（回收站，`assets/catalog.ts moveToTrash`）走 canManageAsset 口径，Lite 界面没有入口。新建错的资产无法自助纠错，违反 R1 精神（R1 禁的是硬删，不是可逆操作）。

**决策**：

- 新增 Lite 路由 `DELETE /api/v1/projects/:project_id/lite/assets/:asset_entity_id`：项目访问校验 + 资产属本项目（`project_asset_refs` 活跃行）→ 单事务软删 `asset_entities` + 本项目 `project_asset_refs` 行 + 全部 `asset_variants` + `asset_media`（`deleted_at`/`deleted_by_user_id`，与删变体同口径）；**不硬删**、不动其他项目引用。已提交 `generation_requests` 不回滚（快照冻结口径不变）。
- 前端：资产详情页顶动作位加「删除资产」danger ghost 按钮，`window.confirm` 二次确认（同删变体口径），成功后 `navigate` 回素材列表并刷新；素材列表卡不加删除入口（第一期收敛在详情页）。
- 回收站/恢复 UI 第一期不做（完整版回收站已有，软删行天然可被完整版恢复）。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/modules/lite/routes.ts` | 删变体路由旁（现约 394 行） | 新增 `DELETE /lite/assets/:asset_entity_id` |
| `src/modules/lite/service.ts` / `repository.ts` / `types.ts` | 删变体实现旁 | 新增 `deleteAsset`（单事务级联软删，复用删变体的写法） |
| `src/modules/lite/routes.test.ts` | fake repository | 补 T17.1–T17.3 用例 |
| `frontend/shortdrama-rag-demo/src/api.ts` | lite 资产区 | 新增 `liteDeleteAsset(projectId, assetEntityId)` |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 页顶动作位（十.2 撤销按钮后该位复用） | 「删除资产」按钮 + 确认 + 回列表 |

**数据库影响**：无（只写既有 `deleted_at`/`deleted_by_user_id` 列）。

### 十.2 撤销 v1.8 九.3：详情页顶部按钮删除

**问题**：v1.8 把详情页顶部「管理图片」改名「新建资产」是错的——该按钮打开弹窗 B，是**针对当前选中变体**的加图/生图动作；真正的「新建资产」入口在素材列表页 tab 栏（`newLabel` 随 tab 变）。在详情页摆「新建资产」误导用户以为能建全新资产。用户 2026-08-18 裁定：不在资产详情展示。

**决策**：

- **删除详情页顶部主动作按钮**（现约 530-539 行的页顶动作位整块）。v1.8 九.3 的改名决定作废。
- 变体级动作入口保留且文案诚实：左栏「＋ 新建变体」虚线卡（弹窗 B `new_variant`）、版本图素材轨「加图」（弹窗 B `add_image`）、无图变体卡封面点击（`add_image`）。新建资产入口 = 素材列表页 tab 栏「新建XX」。
- 测试 T4.4 改口径：空状态引导走变体卡封面点击（T12.4 已断言），不再断言页顶主动作。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 页顶动作位（现约 530-539 行）、文件头注释（现约 17-19 行） | 整块删除；注释同步 |
| `frontend/shortdrama-rag-demo/src/lite-asset-detail-page.test.ts` | T4.4（现约 83-90 行） | 改断言：无页顶主动作；空态引导=变体卡封面点击 |

**数据库影响**：无。

### 十.3 生图弹窗不关闭 + 调用链与失败根因

**十.3a · 弹窗行为修正**：

- **现状缺陷**：`handleGenerate` 在 estimate→confirm→submit 三步同步链返回 202 后立即 `onCompleted()` 关闭弹窗——此时 worker 还没跑完，用户看到「弹窗一点就关」，随后才在别处看到失败。
- **决策**：提交成功后弹窗**不关**，切「生成中」态（禁用取消/重复点击，展示「已提交，生成中…」）；前端轮询 `GET /api/v1/generations/:id`（既有端点，K2J 轮询口径）直到终态：成功 → 提示并 `onCompleted()` 刷新；失败 → 弹窗内展示失败原因 + 「重试」按钮（重跑三步链、新幂等键；既有 `POST /generations/:id/retry` 也可用，第一期弹窗内重跑即可）+「关闭」按钮（关闭后详情页「有 N 张生成中/失败」提示仍在）。同步链本身抛错（403/422/503）保持现状：弹窗不关、toast 报错。

**十.3b · 生图调用链（接口 / 逻辑 / 数据库）**：

| 步骤 | 接口 | 逻辑 | 落库 |
|---|---|---|---|
| ① 估价 | `POST /api/v1/generations/estimate`（`action=submit`） | 按 `tier_id` 查 `pricing_rules` 算 `estimated_cost_fen`，建报价单；preHandler 跑试点积分闸（余额>0 且当日有额度） | `generation_quotes`；读 `user_credit_accounts`/`user_credit_daily_usage` |
| ② 确认 | `POST /api/v1/generation-quotes/:id/confirm` | 人显式确认（AGENTS §4 付费红线：一次点击一次任务）；**Lite 自十.7 起并入③**（提交事务内自动确认，端点保留供完整版与幂等重入） | `generation_quotes.status` |
| ③ 提交 | `POST /api/v1/generations` | 闸序：`ALLOW_PAID_GENERATION` 开关（403）→ worker 依赖齐备（503）→ 平台预算 `PAID_GENERATION_BUDGET_FEN`（budget_exceeded）→ 建请求+attempt，报价**绑定**到 attempt（十.6 起不再在提交时消费） | `generation_requests`（幂等键）、`generation_attempts`（phase=created）、报价 `generation_request_id/generation_attempt_id` 绑定；积分扣减推迟到④成功事务（十.6） |
| ④ 执行 | worker 轮询（`GENERATION_WORKER_POLL_INTERVAL_MS`，默认 5s） | 租约领取 attempt → `ArkGenerationProvider.submit` 调 ARK `POST {ARK_BASE_URL}/images/generations`（同步出图）→ 下载图 → 传 TOS → 挂变体 | `media_results`、`asset_media`（`asset_variant_id`/`is_primary`）、`generation_attempts` 终态；TOS 对象（非数据库） |
| ⑤ 回显 | `GET /api/v1/generations/:id` | 前端轮询任务状态 | 只读 |

**十.3c · 失败根因与口径（2026-08-18 实测）**：

- 用户与诊断复现的失败 attempt 均为 `error_code = SUBMISSION_OUTCOME_UNKNOWN`，插桩实测原始错误 = `AbortError` 于 **120.13s** = 供应商客户端自带 120s 超时（`arkGenerationProvider.ts DEFAULT_TIMEOUT_MS`）：ARK 图片生成正常 60–90s，服务端调用偶发更慢即撞顶；另有连接层瞬时失败（undici connect timeout ~10s×2）。两类都归「unknown」，`retryable=false`，需显式重试——**非代码逻辑 bug，是供应商时延/网络抖动**。
- **积分口径（十.6 取代旧口径）**：旧合同「提交消费报价即扣、失败不自动退、管理台调账补偿」自 v1.9 起**作废**，改为**成功才扣**（十.6）。2026-08-18 之前已发生的失败扣费仍按旧口径走管理台调账补偿（流水不可变，不追溯改合同）。
- **estimate 报 503「所选生成档位暂时不可用」= 环境开关与目录口径不一致，非代码缺陷**：目录 `availability` 按产品决策投影（2026-08-08 已拍板开通 suchuang，70 个公司网关档与其他 active 档同口径，`COMPANY_PROVIDER_ALLOWLIST` 含 suchuang），但运行时供应商注册表另读 `SUCHUANG_GENERATION_ENABLED` 开关。本机 `.env` 该开关留 `false`（陈旧值）时，下拉里 suchuang 档「可选但必 503」。2026-08-18 已在本机置 `true` 对齐产品决策；新环境部署须按产品口径配置该开关，避免「界面给选、提交必拒」。
- **本机付费闸**：2026-08-18 经用户 ask 授权 `.env` 开 `ALLOW_PAID_GENERATION=true` + `PAID_GENERATION_BUDGET_FEN=40000`（行内注释标明授权与回退口径）；验收完改回 `false`/`0`。
- **对策**：十.3a 弹窗留驻 + 失败重试（重试走新提交新扣费，旧失败扣费按上条人工补偿口径）；供应商超时调高属架构决策，不在本迭代（登记待裁：`DEFAULT_TIMEOUT_MS` 120s→180s 需 DC 裁）。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-add-image-dialog.tsx` | `handleGenerate`（现约 299-361 行）、footer（现约 675-691 行） | 提交成功后不 `onCompleted()`：切生成中态轮询 `GET /generations/:id`；终态成功才关；失败留弹窗给重试/关闭 |
| 同上 | state 区 | 新增 `genTaskId` / `genPhase` 状态与轮询 effect |

**数据库影响**：无。

### 十.4 变体删除入口常驻可见

**现状**：变体软删**后端与 handler 都已存在**——路由 `DELETE /lite/assets/:id/variants/:vid`（软删变体 + 级联软删其下 `asset_media` + 清 usages/shot 快照，`repository.ts` 现约 1596-1607 行）、前端 `handleDeleteVariant`（`window.confirm` 二次确认，现约 476 行）。但入口只是变体卡上 **hover 才显示的 ✕**（现约 600-610 行），用户感知不到，走查结论即「变体不能删」。

**决策**：

- 左栏变体网格头部（`共 N 个变体` 计数行，现约 534-536 行）在**有选中变体**时加常驻「删除变体」ghost danger 按钮，调既有 `handleDeleteVariant(selectedVariantId, ...)`；hover ✕ 保留（双入口同函数）。
- 确认文案沿用现状（其下图片与关联一并软删、可恢复）。删后选中回落第一个剩余变体（既有 effect）；最后一个变体也允许删（删完网格只剩「＋ 新建变体」引导卡，R1 可逆软删合规）。
- 后端零改动。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 左栏网格头（现约 534-536 行） | 选中变体非空时渲染「删除变体」常驻按钮 |

**数据库影响**：无。

### 十.5 生成失败提醒卡自动消退

**现状**：`app.tsx` 的 `GenerationAttemptNotificationDock`（现约 466-601 行）轮询 `generation-attempt-notifications`，终态卡（含失败）**常驻右下角直到用户显式确认**（`acknowledgeGenerationAttemptNotification`；S29 口径「用户明确确认才移除」）。失败的生成会留下一张消不掉的失败卡反复提醒，干扰工作。

**决策**：

- **失败**终态卡：新出现时启动 **10s 倒计时自动 acknowledge**（复用既有确认接口，服务端落已确认，语义仍是「确认后移除」，只是确认者从用户变成计时器）；**hover 卡片暂停倒计时**（给用户读文案/点击查看的时间），移开后继续计时。
- **成功**终态卡保持现状（显式确认才移除）——成功是去取结果的入口，自动消退会丢结果。
- 失败信息的其他出口不依赖 dock：弹窗 B 失败态（十.3a）、详情页「有 N 张生成中/失败」提示、消耗页逐笔明细。dock 对失败只是补充通道。
- `s29-notifications.test.ts` 同步改口径：失败卡自动确认 + hover 暂停断言；「显式确认才移除」断言收窄到成功卡。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/app.tsx` | `GenerationAttemptNotificationDock`（现约 466-601 行） | 失败卡 10s 自动 acknowledge + hover 暂停；成功卡路径不动 |
| `frontend/shortdrama-rag-demo/src/s29-notifications.test.ts` | 现约 11-15 行断言 | 改口径：失败卡自动确认、成功卡显式确认 |

**数据库影响**：无（复用既有 acknowledge 接口）。
### 十.6 计费合同：成功才扣积分（失败不扣）

**问题**：现行合同在③提交事务内 `consumeQuote`（报价 `confirmed → consumed`），迁移 034 触发器 `generation_quotes_debit_account_credit` 在同一事务原子扣积分——**提交即扣**。供应商失败（十.3c）后积分照扣、不自动退，只能管理台人工补偿。用户 2026-08-18 裁定：**失败不应扣积分，只有生成成功才扣**。

**决策（最小迁移、不引入双扣窗口）**：

1. **消费时机后移**：③提交事务不再 `consumeQuote`，改为**绑定**报价（写 `generation_request_id`/`generation_attempt_id`，status 保持 `confirmed`）。**④成功落库事务**（`markProviderSucceeded`/persist，写 `media_results`+`asset_media` 同一事务）内调 `consumeQuote` → 触发器原子扣积分。**扣费 ⇔ 成功落库，同事务原子**。
2. **失败作废**：attempt 终态失败（`markProviderFailed` / `markSubmissionOutcomeUnknown`）同事务把报价置 `voided`——触发器只对 `→ consumed` 扣费，`voided` 不扣。
3. **重试 = 新报价**：失败后重试走既有 `POST /generations/estimate`（`action=retry`，`api.quoteGenerationRetry`）建新报价；新报价只在新 attempt 成功时扣。已 voided 的旧报价不可复活。
4. **预算占用口径**：`budget_exceeded` 的已占用额从「consumed 合计」扩为「consumed + 已绑定 confirmed 合计」，防止在途 attempt 无限堆预算外任务。
5. **试点积分闸不变**：余额>0 预检仍在 estimate/提交前（防负余额开工）。
6. **AIGC 闸门失败**（provider 成功但平台合规闸拦下）= attempt 失败 = 报价 voided 不扣费；`generation_billing_failure_facts` 补偿表保留作历史审计，新合同下不再产生新行。
7. **防双扣**：迁移 034 触发器既有守卫（同 attempt 已有 consumed 报价 → `account_credit_duplicate_generation_attempt` 异常）原样保留，天然挡住「成功事务重复消费」。

**迁移 068（`069_generation_quote_voided.sql`，随实现交付并同步 `migrations/ledger.json`）**：

- `ALTER TABLE generation_quotes DROP CONSTRAINT generation_quotes_status_check; ADD CONSTRAINT generation_quotes_status_check CHECK (status IN ('pending_confirmation','confirmed','consumed','voided'))`。
- `generation_quotes_status_consistency` 同步放行 `voided`（要求 `generation_attempt_id IS NOT NULL`，即只允许已绑定 attempt 的报价作废）。
- 触发器函数**不改**（仍只在 `→ consumed` 扣费）。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `migrations/069_generation_quote_voided.sql` | 新增 | status 枚举扩 `voided` + consistency 约束 |
| `migrations/ledger.json` | 「现已用到」 | 067 → 068 |
| `src/modules/generation/repository.ts` | `consumeQuote` 调用点（现约 494/563/825/909/959 行） | 提交/重试事务改「绑定不消费」；新增 `voidQuote`（失败终态同事务）；成功落库事务内 `consumeQuote` |
| 同上 | `reservedCostFen`（现约 503/763/920 行口径） | 已占用 = consumed + 已绑定 confirmed |
| `src/modules/generation/service.ts` | `submitAttempt` 失败分支（现约 321-333 行）与成功分支（现约 345-351 行） | 失败 → `voidQuote`；成功事务 → `consumeQuote` |
| `src/modules/generation/routes.test.ts` / `account-credits` 相关测试 | 付费桥断言 | 改口径：失败无 `generation_debit`、成功才有；重试新报价 |

**数据库影响**：迁移 068（仅 CHECK 约束扩展，无数据搬迁；触发器不动）。


### 十.7 Lite 报价自动确认（②并入③）

**现状**：Lite 弹窗 B 的 `handleGenerate` 本就程序化连调 estimate→confirm→submit（`api.confirmGenerationQuote`，现约 351 行），用户无感知确认步骤；confirm 端点的用户可见意义在完整版三步流程（S59 确认弹窗）。对 Lite 该中间步是纯开销：多一次 RTT、多一个失败点（confirm 网络抖动=整链失败），且 Lite 界面不展示价签（v1.8 ②），confirm 不携带额外信息。用户 2026-08-18 提议、采纳：Lite 版②改自动确认。

**决策**：

- `POST /api/v1/generations` 请求体增**可选** `auto_confirm: true`（zod `z.literal(true).optional()`）。服务端见旗标且报价 `pending_confirmation` 且属同 actor 时，在提交事务内做与 `confirmQuote` 同口径的确认跃迁（`confirmed_at/confirmed_by` = 提交 actor）后继续；**不带旗标维持现状**（`assertConfirmedAndFresh` 拒 pending）——完整版行为零变化。
- Lite 客户端（弹窗 B 三步链与重试路径）统一带 `auto_confirm: true`，不再单独调 confirm 端点；`POST /generation-quotes/:id/confirm` 端点**保留不退役**（完整版 + 幂等重入：已 confirmed 直接返回）。
- 红线对账（AGENTS §4）：「人明确点击一次才创建一次任务」的载体是「生成并保存」点击 + `client_idempotency_key`；confirm 是记账跃迁不是人的动作，合并不削弱红线。结合十.6，Lite 报价生命周期 = `pending_confirmation` →（提交事务内自动确认）→ `consumed`（成功扣）/ `voided`（失败不扣）。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `src/modules/generation/routes.ts` | `submissionSchema`（现约 235 行） | 增 `auto_confirm: z.literal(true).optional()`，透传 |
| `src/modules/generation/repository.ts` | `createSubmission`（现约 457-476 行） | `autoConfirm` 且 pending 同 actor：事务内确认跃迁后继续；重试路径同款 |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-add-image-dialog.tsx` | `handleGenerate` 提交入参（现约 338-352 行） | 带 `auto_confirm: true`，去掉单独 confirm 调用；重试同款 |
| `frontend/shortdrama-rag-demo/src/api.ts` | 提交 wire 类型 | 增可选 `auto_confirm` |
| `src/modules/generation/routes.test.ts` | 付费桥用例 | T17.17–T17.19 |

**数据库影响**：无。

### 十.8 删除入口收口到资产卡（二次确认）

**用户裁定（2026-08-18）**：删除按钮放在**资产上**（素材列表的资产卡），点击需二次确认；详情页顶不再设资产级删除。

**决策**：

- 素材列表资产卡图区右上角常驻删除图标（`Trash`，hover 红），`stopPropagation` 不触发卡片导航；点击弹 `window.confirm` 二次确认（文案含资产名与「软删可恢复」），确认后调 `DELETE /lite/assets/:id` 并刷新列表。
- 详情页顶部「删除资产」按钮退役（十.1 的初版位置作废）；变体删除入口仍在详情页左栏网格头（十.4）。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-assets-page.tsx` | 资产卡图区（现约 852-872 行） | 卡上删除图标 + 二次确认 + `handleDeleteAssetFromCard` |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 页顶动作位 | 「删除资产」按钮退役，仅留注释说明收口位置 |

**数据库影响**：无。

### 十.9 变体级归属：从哪个变体生成，产物挂哪个变体

**问题**：旧口径（v1.3 过渡）AI 生成图一律挂**第一个变体**（`listAssetVersionTrack` 的 `firstVariantId`），且提交体只有 `target_asset_entity_id` 没有变体维度——用户从变体 B 发起生成，产物却出现在变体 A 下，表现为「从变体生成变成另外的资产/变体」。

**决策**：

- 提交体增 `target_asset_variant_id`（可选）；后端 `generation_requests` 增同名列（**迁移 069**，可空、外键 `asset_variants`，历史行 NULL）。
- 弹窗 B：`add_image` 模式用当前选中变体（无变体先建第一个）；`new_variant` 模式用新建变体 id——都随提交带上。
- 素材轨（`listAssetVersionTrack`）：AI 行 `variantId = request.target_asset_variant_id ?? 第一变体`（历史行回落不变）。
- 语义边界：**新增图片 = 从某资产/变体发起**（弹窗 B 必带资产+变体）；对已有图的修改走设主图/删图/重新生成（重新生成=新一次从该变体发起），不另设「在原图上修改」通道。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `migrations/070_generation_request_target_variant.sql` | 新增 | `generation_requests.target_asset_variant_id` 可空外键 |
| `src/db/schema.ts` | `generationRequests` | 增 `targetAssetVariantId` 列 |
| `src/modules/generation/{types,routes,service,repository}.ts` | 提交链 | 透传 `target_asset_variant_id` → 落库 |
| `src/modules/lite/repository.ts` | `listAssetVersionTrack`（现约 1077-1133 行） | AI 行按 `targetAssetVariantId` 归属，缺省回落第一变体 |
| `frontend/shortdrama-rag-demo/src/{types.ts,pages/lite/lite-asset-add-image-dialog.tsx}` | 提交体 | 带 `target_asset_variant_id` |

**数据库影响**：迁移 069（仅加可空列，无数据搬迁）。


### 十.10 删除二次确认改自定义弹窗（取代浏览器原生 confirm）

**用户裁定（2026-08-18）**：删除的二次确认不要浏览器自带 `window.confirm`，用自定义弹窗。

**决策**：

- 新增共享组件 `lite-confirm-dialog.tsx`（`LiteConfirmDialog`）：壳层 `Dialog`（size=small）+ 标题 + 描述 + 「取消」ghost + 「删除」danger 主钮；busy 期间两钮禁用、遮罩点击不关。
- 收口范围（删除类动作）：素材列表资产卡删除（十.8）、详情页删变体/删图（十.4/既有）、配置页删模板/删风格。设/取消默认风格等**非删除**的可逆设置动作本期不动。
- 各页面持有 `confirmState`（`LiteConfirmState | null`），点删除只开弹窗；`onConfirm` 内执行真删除并在成功后关弹窗、刷新。

**改动的文件 / 位置**：

| 文件 | 位置 | 改动 |
|---|---|---|
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-confirm-dialog.tsx` | 新增 | 共享自定义确认弹窗组件 |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-assets-page.tsx` | 卡删除 handler（现约 401-424 行） | `window.confirm` → `LiteConfirmDialog` |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | 删图/删变体 handler（现约 460-503 行） | 同上 |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-project-config-page.tsx` | 删模板/删风格 handler（现约 432-518 行） | 同上 |
| `frontend/shortdrama-rag-demo/src/lite-shots-reference.test.ts` | 模板删除用例（现约 828-836 行） | 改为点自定义弹窗「删除」确认 |

**数据库影响**：无。

### v1.9 测试标准（T17）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T17.1 | 软删资产 | Lite 手动新建资产 | 详情页点「删除资产」→ 确认 | 200；列表不再显示；`asset_entities.deleted_at` 非空；无硬删行 |
| T17.2 | 跨项目拒删 | 资产属项目 A | 项目 B 调 DELETE | 403/404，不删 |
| T17.3 | 删除不影响已提交任务 | 资产有在途生成 | 删除资产 | 在途 attempt 照常跑完（快照冻结） |
| T17.4 | 详情页无「新建资产」按钮 | 任意资产详情 | 查看页顶 | 无页顶主动作按钮；「＋ 新建变体」「加图」仍在 |
| T17.5 | 列表页新建入口仍在 | 素材列表页 | 查看 tab 栏 | 「新建XX」按钮在，打开弹窗 A |
| T17.6 | 弹窗生成中不关 | 弹窗 B AI 生成 | 点「生成并保存」 | 提交成功后弹窗仍在、显「生成中」；成功终态才关闭并刷新 |
| T17.7 | 失败留弹窗可重试 | 同上且 attempt 失败 | 等轮询终态 | 弹窗内显失败原因 + 重试/关闭；不自动关 |
| T17.8 | 同步错误不关弹窗 | 余额 0 或闸关 | 点生成 | toast 报错、弹窗不关（现状保持） |
| T17.9 | 变体删除入口常驻 | 资产有选中变体 | 查看左栏网格头 | 「删除变体」按钮常驻可见；hover ✕ 仍可用；两入口同行为 |
| T17.10 | 变体删除级联 | 变体有图与关联 | 点「删除变体」→ 确认 | 200；变体卡消失、其下媒体/usages 软删；选中回落第一个剩余变体 |
| T17.11 | 失败卡自动消退 | 生成失败终态卡出现 | 不操作等 10s | 右下角失败卡自动确认移除；成功卡不自动移除 |
| T17.12 | 失败卡 hover 暂停 | 同上 | hover 卡片等 10s | 卡片仍在；移开 hover 后倒计时继续并消退 |
| T17.13 | 失败不扣积分 | 提交后 attempt 终态失败 | 查 `user_credit_ledger_entries` 与余额 | 无该报价的 `generation_debit` 行；余额不变；报价 status=`voided` |
| T17.14 | 成功才扣 | attempt 成功落库 | 查流水 | 恰有一条 `generation_debit`（=报价额），与 `media_results` 落库同事务时间戳 |
| T17.15 | 重试新报价 | T17.13 后点重试 | estimate(retry)→confirm→submit→成功 | 旧报价保持 voided；新报价成功时扣一次，共扣一次 |
| T17.16 | 双扣守卫 | 同 attempt 试图消费第二张报价 | 触发器 | 抛 `account_credit_duplicate_generation_attempt`，不双扣 |
| T17.17 | Lite 自动确认 | pending 报价 + `auto_confirm: true` | `POST /generations` | 202；报价 `confirmed_by`=提交 actor；无需先调 confirm |
| T17.18 | 完整版零变化 | pending 报价、不带旗标 | `POST /generations` | 按现状拒绝（未确认），与改前一致 |
| T17.19 | 自动确认+失败不扣 | T17.17 且 attempt 失败 | 查流水 | 报价 `voided`，无 `generation_debit` |
| T17.20 | 卡上删除二次确认 | 列表有资产 | 点卡上删除图标 | 弹确认；取消不删、不导航；确认后 200 且列表刷新、实体软删 |
| T17.21 | 变体归属 | 资产有变体 A/B，选中 B | 弹窗 B 生成 | 提交体带 `target_asset_variant_id`=B；成功后素材轨该行 `variant_id`=B |
| T17.22 | 历史回落 | 迁移前生成的 AI 图（target 变体为 NULL） | 查素材轨 | 归属第一变体（旧口径不变） |
| T17.23 | 删除自定义确认 | 列表有资产 | 点卡上删除图标 | 弹自定义 Dialog（非浏览器 confirm）；取消不删；点「删除」才软删并刷新 |

**v1.9 通过标准**：T17.1–T17.23 全部通过。供应商超时调高（120s→180s）为待裁项，不阻塞本版本。十.6/十.7 为计费合同变更，实施需 DC 知悉（改的是付费红线实施细则，方向=对用户更友好，红线载体不变）。

## 问题十一（v2.6 音频生成与展示改造）：列表卡/详情音频展示 / 弹窗 B 音频模式 / 版本轨 media_kind / 配置页音频档

> 2026-08-18 需求：Lite 音频资产此前只有类型与文本信息，没有音频生成、展示与配置。本次**完整改造**（用户裁定）：①列表卡 + 详情页正确展示音频资产；②弹窗 B 音频生成模式；③版本轨数据层补 `media_kind`/`format`；④Lite 配置页支持音频档。详情形态 = **变体 + 版本轨并行**（与图片资产同结构）；配置页音频档形态 = **A. 扩展合同**（generation-defaults 支持 audio，保存项目默认音频档 + 默认音色）。**数据库迁移：071（改 `generation_default_strategies` 两个 CHECK）。**

### 现状

- 音频生成能力后端**已接入**（回答「是否已接入」= 是）：`voice-synthesis` / `minimax-voice` 能力、`seedAudioProvider` / `openspeechTtsProvider` / `minimaxGenerationProvider` provider 完整；通用 `/generations` 三步流程支持 audio（`assertAudioSource` 须带 `speakerId`）；`GET /api/v1/audio/voices` 返回音色目录（`VoiceCatalogVoice { id, displayName, language?, category?, gender?, auditionUrl? }`）。参数契约 = `parameters.speakerId`。
- 音频档本地可用：本地 `pricing_rules` 有 4 条 audio 档（openspeech seed-audio-1.0 3s、seed-audio-1.0-multilingual 3s、minimax speech-2.8-turbo/hd experimental）→ 本地 `listCapabilityTiers("audio")` 非空；部署环境无种子仍可能为空，弹窗如实禁用。
- **音频档 params 键 = `original_duration_seconds`（非 `duration_seconds`）**，档无 `duration_seconds` 键 → `FORM_DIMENSION_KEYS.audio = ["model_label"]`（时长是档冻参数，不是用户可选维度）。
- 版本轨（`listAssetVersionTrack`）此前对 AI 行只返回图片字段，丢弃 `media_kind`/`format` → 音频行无法识别与渲染。
- 上传接口只收图片（`mediaUpload.ts` `supportedImageFormats` 仅图片 + sharp `inspectUploadedImage`；`/assets/:id/media` 用该 service）→ 音频无本地上传通道，硬传 422。
- `generation_default_strategies` 迁移 005 原始 `media_kind` CHECK 只允许 `('image','video')`、mode CHECK 只允许 `('direct_reference','material_to_prompt')`（本地库曾被手工改过已含 audio，但原始迁移不含）。
- 完整版已有可复用件：`voice-catalog.ts`（`fetchVoiceCatalog()` + `VoiceCatalogVoice`）、`timbre-browser.tsx`、`asset-widgets.tsx` 音频渲染模式。

### 决策

1. **详情形态 = 变体 + 版本轨并行**（用户裁定）：音频资产与图片资产同结构——左栏变体卡片网格（无图变体显示音频占位图标）、选中变体信息面板、底部版本轨（按 `media_kind` 区分图片/音频行）、`DetailLightbox` 对音频项按 `item.media_kind === "audio"` 渲染 `<audio>`。音频资产同样支持「设为主音频」（`asset_media.is_primary`）。
2. **弹窗 B 音频生成模式**（完整改造）：
   - 音频资产打开弹窗 B 为**纯 AI 生成模式**：隐藏「本地上传」tab（后端无音频上传接口）、无参考图上传区、提示词区标签「音频文本」、主按钮「合成并保存」。
   - 模型档现取 `listCapabilityTiers("audio")`；音色下拉来自 `GET /api/v1/audio/voices`，可选试听（`auditionUrl`，单实例 `<audio>`）；未选音色校验「请选择音色」。
   - 提交体：`media_kind: "audio"`、`parameters.speakerId`（音色 id）、`reference_media_ids: []`（音频不引用参考素材，空数组语义 = 无参考素材）。
3. **版本轨数据层加 media_kind/format**：`LiteAssetVersionTrackItem` 加 `media_kind`/`format` 字段；`listAssetVersionTrack` 的 select 与映射补齐——详情页与版本轨据此区分图片/音频行（此前前端 `liteListVersionTrack` 映射丢弃这两列）。
4. **配置页音频档 = A. 扩展合同**（用户裁定）：`generation-defaults` 合同扩展支持 `media_kind: "audio"` 与 mode `"text_to_speech"`（TTS 文本 + 音色直出，无参考素材概念，不复用 `direct_reference` 占位）。配置页媒体 tab 三枚（图片/视频/音频，`?kind=audio` 持久化）；音频卡 = 模型档 + **默认音色下拉**（保存 `model_key` + `parameters.speaker_id`）；维度仅模型；无模板/风格概念（音频无提示词模板）。
5. **音色预填守卫**：配置页音色预填用 `voiceUserPicked` ref——用户主动改过音色后，目录加载/策略刷新不再覆盖用户选择（否则 `current ?? preset` 会让先到的首音色挡住后到的已存策略音色）。
6. **弹窗 B 打开时按默认策略预填**：音频生成读 `GET /generation-defaults/audio`（`model_key` + `parameters.speaker_id`），未显式选档/音色时按此预填；档必须现取（本地档不是真档，拿它提交必 422）。

### 改动的文件 / 位置

| 文件 | 改动 |
|---|---|
| `migrations/072_generation_default_audio.sql` | 新迁移：幂等把 `generation_default_strategies.media_kind` CHECK 扩为 `('image','video','audio')`、`mode` CHECK 扩为 `('direct_reference','material_to_prompt','text_to_speech')` |
| `src/modules/generation/defaults/types.ts` | `generationDefaultMediaKinds` 加 `"audio"`、`generationDefaultModes` 加 `"text_to_speech"` |
| `docs/contracts/v0.1.1/api-and-data.md` | §测试域默认策略：audio 默认策略合同（`model_key` 存档 id、`parameters.speaker_id` 存默认音色） |
| `src/modules/lite/types.ts` / `repository.ts` | `LiteAssetVersionTrackItem` 加 `mediaKind`/`format`；`listAssetVersionTrack` select 与映射补齐 |
| `frontend/shortdrama-rag-demo/src/types.ts` | `GenerationDefaultMode` 加 `"text_to_speech"` |
| `frontend/shortdrama-rag-demo/src/api.ts` | `LiteAssetVersionTrackItem` 加 `media_kind`/`format`；`liteListVersionTrack` 映射补齐 |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-assets-page.tsx` | 列表卡音频资产 SpeakerHigh 图标分支 |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-detail-page.tsx` | isAudio/primaryLabel、变体卡封面、小封面 `<audio>`、AI 生成信息 format、音频版本轨、DetailLightbox `item.media_kind === "audio"` |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-asset-add-image-dialog.tsx` | 弹窗 B 音频模式（isAudio/kind、隐藏上传 tab、loadTier 参数化含音频、音色下拉 + 试听、`handleGenerate` audio 分支、参考图跳过） |
| `frontend/shortdrama-rag-demo/src/pages/lite/lite-project-config-page.tsx` | 媒体 tab 三枚、音频卡（模型 + 默认音色）、`FORM_DIMENSION_KEYS.audio`、音色预填守卫、模板/风格门控、禁存/notify/按钮文案 |

### T18 音频生成与展示

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T18.1 | 列表卡音频图标 | 项目有 audio 资产 | 查看素材列表「音频」tab | 卡片占位区显示 SpeakerHigh 音频图标 |
| T18.2 | 详情页音频播放 | 音频资产有主音频 | 进详情选中该变体 | 渲染 `<audio>` 可播放；AI 生成信息显示模型 format |
| T18.3 | 音频版本轨 | 音频资产有生成/上传记录 | 查看详情底部版本轨 | 按 `media_kind === "audio"` 渲染音频行并显示 format；图片行不受影响 |
| T18.4 | 还没有音频空态 | 音频资产无任何音频 | 进详情 | 显示「还没有音频」空态 + 生成入口 |
| T18.5 | 设为主音频 | 音频资产有多个候选 | 点候选「设为主音频」 | `is_primary` 原子翻转，单选主音频 |
| T18.6 | 弹窗 B 音频模式 | 音频资产点加图/新建变体 | 打开弹窗 B | 无「本地上传」tab、无参考图区；提示词标签「音频文本」；主按钮「合成并保存」 |
| T18.7 | 音色选择与试听 | 弹窗 B 音频模式 | 展开音色下拉 | 选项来自 `GET /api/v1/audio/voices`；带 `auditionUrl` 的可试听（单实例 `<audio>`） |
| T18.8 | 未选音色校验 | 弹窗 B 音频模式未选音色 | 点「合成并保存」 | 提示「请选择音色」，不提交 |
| T18.9 | 音频提交体 | 弹窗 B 音频模式选好音色与文本 | 提交 | `media_kind: "audio"`、`parameters.speakerId` = 所选音色、`reference_media_ids: []` |
| T18.10 | 音频文本必填 | 弹窗 B 音频模式文本为空 | 点「合成并保存」 | 提示音频文本校验，不提交 |
| T18.11 | 配置页音频 tab | 打开项目配置页 | 查看媒体 tab | 三枚 tab：图片/视频/音频（`?kind=audio` 持久化）；音频卡 = 模型档 + 默认音色下拉 |
| T18.12 | 默认音色保存 | 配置页音频 tab 选好音色 | 保存 | `PUT /generation-defaults/audio`：`model_key` + `parameters.speaker_id` 落库；通知「音频生成配置已保存」 |
| T18.13 | 音色预填 | 项目已存默认音色 | 打开配置页音频 tab | 下拉预选已存 `speaker_id` 音色（无则首音色）；用户改过后目录加载/策略刷新不覆盖用户选择 |
| T18.14 | 无音色禁存 | 音色目录为空或未选 | 点保存 | 禁存（saveDisabledReason「请选择音色后保存」） |
| T18.15 | 无模板/风格 | 配置页音频 tab | 查看子配置 | 模板配置子 tab 与风格配置面板对 audio 隐藏 |
| T18.16 | 弹窗 B 默认预填 | 项目存有音频默认策略 | 打开弹窗 B 音频模式 | 模型/音色按默认策略预填；未显式选档时档现取 `listCapabilityTiers("audio")` |

**v2.6 通过标准**：T18.1–T18.16 全部通过。部署环境无 audio 档种子时，弹窗/配置页如实禁用（空档即空，属预期，非缺陷）。

## 需要改的模块

前端：

- `frontend/shortdrama-rag-demo/src/pages/lite/lite-assets-page.tsx`
  - 改为 tab + 卡片列表，列表卡顶部有 aspect-video 图片占位区（无图时图标占位），下方展示名称 + 类型徽记 + 一句话描述，不渲染状态徽记。
  - 卡片整体可点击（无"查看详情"按钮），点击导航到详情页路由。
  - 增加每个 tab 的 `[+ 新建]` 入口（文案随 tab 变），打开新增资产弹窗（弹窗 A，见 wireframe 第三节）。
  - materialize 入口在剧本页那侧，不在素材列表页显示当前集。
- 新增 `lite-asset-detail-page.tsx`（独立路由页，非抽屉）
  - 路由：`/lite/projects/:projectId/assets/:assetEntityId`，顶栏有 ← 返回按钮（navigate 回素材列表）。
  - 三段式布局：顶栏（← 返回 + 资产名 + 变体横向标签条 + [+]）；主区（左 2/3 主图大图 + 右 1/3 信息折叠面板：出现记录默认展开 / 身份信息默认折叠）；底栏版本图素材轨（始终可见）。变体横向标签，变体多时横向滚动。
  - **变体标签条**（v1.2 修正）：首个 tab 为「全部(N)」显示所有图片；其后每个变体 tab 显示 `变体名(N)`，N 为该变体的图片数。点击变体 tab 筛选版本图轨和主图区——只显示 `variant_id === 选中变体` 的图片。「全部」tab 显示所有。`selectedVariantId = null` 表示选中「全部」。
  - 主图可点击放大（lightbox z-[70]），左右切换浏览**当前筛选范围内**所有版本图。
  - 变体无图时（或筛选后无图）主图区替换为空状态引导卡（显示资产名 + 描述 + 生成/上传入口），点击直接进弹窗 B（`add_image` 模式）。
  - [+] 按钮打开弹窗 B（`new_variant` 模式；v2.5 起仅首变体即资产无任何变体时预填资产名称/描述/备注 + 提示词，已有变体时表单空白）。弹窗完成后 `reloadAll` 刷新变体列表 + 版本图轨 + 资产详情 + 出现记录（v1.2 修正：原版遗漏了 `loadVariants` 导致新变体不刷新）。
  - 不做审核 UI（第一期）。
- `frontend/shortdrama-rag-demo/src/pages/lite/lite-project-config-page.tsx`
  - 媒体 tab 三枚：图片 / 视频 / 音频配置（`?kind=audio` 持久化，`readKindFromUrl`/`selectKind`）。
  - 图片/视频：模型 + 维度（画幅/清晰度等，按 `FORM_DIMENSION_KEYS`）+ 默认风格模板 + 风格配置。
  - 音频（v2.6 完整改造）：模型档 + **默认音色下拉**（`GET /api/v1/audio/voices`，保存到 `parameters.speaker_id`）；维度仅模型（`FORM_DIMENSION_KEYS.audio = ["model_label"]`——音频档时长是档冻参数 `original_duration_seconds`，不是用户可选维度）；无模板/风格概念（音频为 TTS 直出，无提示词模板）。

后端：

**第一层：解析流程扩展（让剧本解析能产出服装/音频候选）**

- `src/modules/script-breakdown/types.ts`
  - `AssetCandidateKind`（第 23 行）从 `"character" | "scene" | "prop"` 扩为五 类，加 `"costume" | "audio"`。
  - `AssetCandidates`（第 65-69 行）加 `costumes: CostumeAssetCandidate[]` 和 `audios: AudioAssetCandidate[]`。
  - 新增 `CostumeAssetCandidate`（`wearerNames / style / color / material / occasion`）和 `AudioAssetCandidate`（`audioKind / speakerNames / sceneContext / emotion / durationHint / transcriptSnippet / soundCueText / defaultAudioPromptSeed`），字段对应上文第 181-198 行的定义。
- `src/modules/script-breakdown/schemas.ts`
  - `assetsStageOutputSchema`（第 57-63 行）用了 `.strict()`，**多一个键都会被 Zod 拒绝**——必须显式加 `costumes` 和 `audios` 数组。
  - `draftSchema` / `storedCandidateSchema` / `storedCharacterCandidateSchema` 同步扩展，否则 confirmed run 读回时数据被丢。
- `src/modules/script-breakdown/prompts.ts`
  - `buildAssetsPrompt`（第 59-101 行）的系统指令和 JSON 模板加服装/音频抽取要求。
  - **关键：第 98 行 "appearance 只写外貌辨识特征,不混入服装" 这条规则要改**——当前是主动压制服装信息；改后服装抽到独立 `costumes` 桶，appearance 只保留非服装的外貌特征。
  - `PROMPT_VERSION`（第 10 行 `"script-breakdown.v2"`）升版本号，触发已有 run 重跑。
- `src/modules/script-breakdown/service.ts`
  - `executeStage` 对 assets stage 的 cross-validate 逻辑同步扩展（如有）。

**第二层：落库扩展（materialize 只认三类 → 认五类）**

- `src/modules/lite/types.ts`
  - `LiteAssetKind`（第 95 行）从 `"character" | "scene" | "prop"` 扩为 `"character" | "scene" | "prop" | "costume" | "audio"`。
- `src/modules/lite/service.ts`
  - `materializeAssets`（第 190-230 行）现在只 spread `{ characters, scenes, props }`（第 201-221 行硬编码三类）；加 `costumes` 和 `audios` 两个 spread，映射到 `assetKind: "costume"` / `assetKind: "audio"`。
  - 合并本集/多集出现信息。
  - materialize 后触发同 confirmed run 的分镜资产绑定回填。
- `src/modules/lite/repository.ts`
  - 新建和命中既有资产时都幂等合并 `metadata.lite.usages`，并保留其他 metadata 命名空间。
  - 根据 confirmed run 的候选分镜更新 `shots.reference_asset_snapshots`，只处理当前项目和当前 run。
  - 提供资产详情读取接口，返回真实 episode/scene/shot 导航信息和备注。
- `src/modules/lite/routes.ts`
  - 新增 `POST /lite/assets`：手动新建资产（名称 + 描述 + 备注，三个通用字段 + asset_kind + 可选上传首图）。不关联 `script_breakdown_runs`，`metadata.lite.usages` 初始为空。
  - 新增 `GET /lite/assets?episode_id=&kind=`：返回聚合 tab 数量 + 每个资产的 `has_media / has_primary / has_pending_generation` 标记（供详情页和分镜引用判断，列表卡不渲染）。
  - 新增 `GET /lite/assets/:asset_entity_id`
  - 新增 `PATCH /lite/assets/:asset_entity_id`，维护名称、描述、类型详情和备注；只能修改当前项目资产且保留 metadata 其他命名空间。
  - 新增 `POST /lite/assets/:asset_entity_id/variants`
  - 新增 `POST /lite/assets/:asset_entity_id/media/upload` 或复用现有上传接口。
  - 新增 `PATCH /lite/assets/:asset_entity_id/primary-media`
- `src/modules/generation/repository.ts` / `routes.ts`
  - 请求携带 `shot_id` 时服务端解析分镜绑定资产、当前主版本和合法主媒体。
  - 把资产文本加入提示词编译上下文，把实际引用快照冻结到生成请求；媒体不可用时执行文本降级。

数据库：

- **零迁移**：`asset_entities.asset_kind` 是开放 varchar(20)，没有 CHECK 约束、没有 FK（迁移 `031` 第 8-9 行明确写了"不加 FK"）。词表 `asset_kind_vocabulary` 已种子 `costume`(服装)、`sound`(声音参考)、`music`(配乐参考)、`voice`(配音)（迁移 `031` 第 75-90 行）。`generation_requests.media_kind` 和 `media_results.media_kind` 已支持 `audio`（迁移 `020` 扩的）。**扩展服装/音频不需要任何 schema 改动。**
- 不新增独立素材事实源。
- 第一期间把类型特有详情写入结构化 `asset_entities.metadata.lite`；列表优先读正式列，详情和生成预填再读 `metadata.lite`。
- 第一期开工时不要为了候选证据字段新增 `asset_entities` / `asset_variants` 的细粒度列，`episodeId`、`episodeNo`、`sceneIds`、`sceneNames`、`shotIds`、`shotCandidateIds`、`lineIndices`、`sourceTextSnippets`、`notes`、`confidence`、`defaultImagePromptSeed` 这类字段先保留在 metadata。
- 如果要高频查询“出现在哪些集/分镜”，再新增 `asset_episode_usages` 表，字段包括 `project_id`、`episode_id`、`asset_entity_id`、`shot_id`、`source_breakdown_run_id`、`source_candidate_id`、`evidence_json`。
- 不新增独立图片提示词模板表；先扩展 `generation_default_strategies.parameters`。

## 测试标准

> 按线框图（`lite-assets-page-wireframe.md`）的功能区组织。每条用例标注前置、步骤和预期。

### T1: 素材列表页（页面 A）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T1.1 | tab 导航 | 项目有多类资产 | 依次点击角色/场景/道具/服装/音频 tab | 列表切换到对应类型；tab 数量与项目实际 `asset_kind` 种类一致 |
| T1.2 | 卡片内容 | 资产有名称和描述 | 查看任意卡片 | 只显示名称 + 一句话描述，不渲染状态徽记（出现集/分镜、主图状态、候选图数等） |
| T1.3 | 「全部」聚合 | 项目有多类资产 | 点击「全部」tab | 显示所有类型资产混合列表 |
| T1.4 | tab 持久化 | 切到「服装」后刷新 | 观察 URL 和页面 | URL 带 `?asset_tab=costume`；刷新后停留在「服装」 |
| T1.5 | 新建入口 | 在「角色」tab | 点击 `[+ 新建]` | 弹出弹窗 A |

### T2: 弹窗 A（新增资产）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T2.1 | 纯文本新建 | 打开弹窗 A | 填名称/描述/备注 → 选「跳过」→ 保存 | 资产落库；列表多一张卡；进详情是空状态 |
| T2.2 | 上传首图 | 打开弹窗 A | 填信息 → 选「上传首图」→ 选文件 → 保存 | 资产 + 媒体落库；图在详情右侧显示，为候选版本（非主图） |
| T2.3 | AI 生成首图 | 打开弹窗 A | 填信息 → 选「AI 生成」→ 检查提示词预填 → 生成并保存 | 资产落库 + 生成请求提交；结果为候选版本 |
| T2.4 | 提示词联动 | 弹窗 A 左侧填了名称/描述 | 查看右侧 AI 提示词 | 提示词 = 项目模板 + 类型模板 + 左侧名称/描述/备注，实时联动 |
| T2.5 | 纯上传类型 | 在「光线参考」tab 点新建 | 查看弹窗 A 首图区 | 只显示「上传首图」和「跳过」，不显示「AI 生成」 |
| T2.6 | 名称必填校验 | 打开弹窗 A | 不填名称 → 点保存 | 报错，不落库 |
| T2.7 | 类型特有字段不在弹窗收集 | 角色资产 | 查看弹窗 A 基本信息区 | 只有名称/描述/备注三个通用字段，无性别/年龄等 |

### T3: 弹窗 B（给变体加图）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T3.1 | 资产信息预填 | 打开弹窗 B | 查看顶部 | 名称/描述/备注从 `asset.name`/`asset.intro`/`metadata.lite.note` 预填，可临时改 |
| T3.2 | 上传图片 | 打开弹窗 B | 切「本地上传」→ 拖文件 → 保存 | 图片追加为候选版本，不自动设主图 |
| T3.3 | AI 生成 | 打开弹窗 B | 切「AI 生成」→ 检查提示词 → 生成并保存 | 直接 submit（v1 不走预估→确认）；结果为候选 |
| T3.4 | 参考图多图上传区 | 角色 asset 打开弹窗 B AI 生成 tab | 上传多张参考图 | 参考图区为多图上传区（非槽位制），上传后展示缩略图并支持删除；生成时上传到服务端收集 media_id 作为 reference_media_ids |
| T3.5 | 不展示已有版本 | 打开弹窗 B | 查看弹窗内容 | 不出现已有变体缩略图列表（详情页版本图区已展示） |
| T3.6 | 纯上传类型 | 光线参考 asset 打开弹窗 B | 查看 tab | 只显示「本地上传」，隐藏「AI 生成」及参考图/提示词区 |
| T3.7 | 个人/通用资产库已移除 | 打开弹窗 B 参考图区 | 查看参考图来源 | 只有 `[📷 上传]`，没有 `[👤 个人资产] [📚 通用资产]` |
| T3.8 | AI 优化提示词 | 打开弹窗 B AI 生成 tab，提示词有内容 | 点「✨ AI 优化提示词」按钮 | 调用 `POST /ai/prompt-draft` 重新生成提示词，结果回填文本域（非 toast 占位） |
| T3.9 | 模型/比例选择器 | 打开弹窗 B AI 生成 tab | 查看底部控制区 | 有单 tier 下拉（模型 · 比例 · 分辨率），选项来自 active 档 |
| T3.10 | 新建变体模式 | 详情页点 [+] | 查看弹窗 B | 以 `new_variant` 模式打开：标题「新建变体」。资产无任何变体（首变体）时名称/描述/备注从资产预填、提示词 = 项目默认风格模板 + 资产信息；资产已有变体时名称/描述/备注/提示词均空白，由用户填写（v2.5 裁定） |
| T3.11 | 新建变体真正创建变体（v1.2） | 详情页点 [+] → 填名称「战甲造型」→ 上传图 → 保存 | 检查后端 | 先调 `POST /assets/:id/variants` 创建变体（返回 variant_id）；上传图时带 `asset_variant_id`；详情页刷新后新变体 tab 出现且该 tab 下有图 |
| T3.12 | 变体名称必填（v1.2） | 详情页点 [+] → 不填名称 → 点保存 | 查看弹窗 | 提示「请输入变体名称」，不创建变体也不上传图 |
| T3.13 | 变体 tab 筛选图片（v1.2） | 资产有 2 个变体各有图 | 切换变体 tab | 每个 tab 只显示该变体的图片；「全部」tab 显示所有 |

### T4: 资产详情页（页面 B）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T4.1 | 三段式布局 | 打开任意资产详情 | 查看布局 | 左：身份信息面板；右：主图 + 版本图区；底：出现信息 |
| T4.2 | 设主图 | 资产有多张候选图 | 点一张候选 →「设为主图」 | 原子翻转：新图 `is_primary=true`，原主图降候选 |
| T4.3 | 主图唯一性 | 上一步完成后 | 查数据库 `asset_media` | 同一变体内 `is_primary=true` 只有一条 |
| T4.4 | 空状态 | 无图资产进详情 | 查看主图区 | 显示空状态引导卡（生成/上传入口），点进弹窗 B |
| T4.5 | 主图放大 | 资产有主图 | 点击主图 | 弹出 lightbox 大图查看 |
| T4.6 | 身份信息编辑 | 角色资产 | 改性别/年龄/外貌 → 保存 | 写入 `metadata.lite` 对应字段 |
| T4.7 | 名称/描述/备注编辑 | 任意资产 | 改三个字段 → 保存 | 写入 `name`/`intro`/`metadata.lite.note`；`last_modified_at` 更新 |
| T4.8 | 生成中提示 | 资产有进行中的生成 | 查看详情页 | 显示”有 N 张生成中”，减少重复劳动 |

### T5: 资产关联编辑（资产侧声明 + 分镜侧引用）

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T5.1 | 显示出现信息 | 资产经 backfill 关联了分镜 | 查看详情底部 | 显示”第3集·场景2·镜5（书房对话）”列表 |
| T5.2 | 添加关联 | 资产存在 | 点 `[+ 关联分镜]` → 勾选镜10 → 保存 | `metadata.lite.usages.shotIds` 增加 S010；`shots[S010].reference_asset_snapshots` push 该资产（`matched_by: “manual”`） |
| T5.3 | 删除关联 | 资产关联了镜5 | 点镜5的 `[删除]` | `metadata.lite.usages` 移除 S005；`shots[S005].reference_asset_snapshots` 删除 `matched_by: “manual”` 的同资产条目 |
| T5.4 | 不误删自动匹配 | 镜5 的资产是 backfill 自动匹配（`matched_by: “exact_name”`） | 在资产侧删除镜5 | 只删 manual 条目；backfill 重跑时自动匹配项恢复 |
| T5.5 | 分镜侧删减 | 镜5 引用了 A001 | 在分镜页删除 A001 | 镜5 不再引用 A001；资产 A001 的 `metadata.lite.usages` 不变 |
| T5.6 | 分镜侧不恢复 | T5.5 之后触发 backfill | 检查 shots[S005] | 被 manually removed 的资产不重新 push |

### T6: materialize 与 backfill

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T6.1 | 单集 materialize | 某集有 confirmed run | `POST materialize?episode_id=X` | 角色/场景/道具/服装/音频按 `asset_kind` 落库 |
| T6.2 | 重复 materialize 幂等 | 同一集已 materialize | 再次 `POST materialize` | 不产生重复行/usage；已有资产命中后 `outcome: “existing”` |
| T6.3 | 多集同名合并 | 第3集和第5集都有”任天野” | 分别 materialize | 同名同类资产不重复；详情按集显示出现信息 |
| T6.4 | backfill 回填 | materialize 完成 | 检查 `shots.reference_asset_snapshots` | confirmed run 产生的分镜已回填 `asset_entity_id` |
| T6.5 | 不覆盖人工引用 | 分镜有人工引用资产 | 执行 backfill | `matched_by: “manual”` 条目不被覆盖 |
| T6.6 | 服装/音频解析（扩展后） | 剧本含服装/音频线索 | 解析 + materialize | 服装候选（`wearerNames/style/color`）和音频候选（`audioKind/speakerNames`）落库 |
| T6.7 | 未确认不 materialize | 某集 run 状态不是 confirmed | `POST materialize` | 返回 `ConflictError(“lite_breakdown_not_confirmed”)` |

### T7: 分镜生成自动引用

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T7.1 | 自动引用主图 | 镜5 绑定 A001，A001 有主图 | `POST generations(shot_id=S005)` | 服务端自动读 `reference_asset_snapshots` → 拉 A001 主图编入引用媒体 |
| T7.2 | 文本降级 | 镜5 绑定 A001，A001 无图 | `POST generations(shot_id=S005)` | 使用文本资产信息，标记”仅文本引用”，不阻断生成 |
| T7.3 | 快照冻结 | 镜5 引用 A001，已提交生成 | 提交后改 A001 主图 | 已提交的 `generation_requests.reference_asset_snapshots` 不变 |
| T7.4 | 不自动重跑 | 历史生成请求存在 | 改资产详情/主版本/回填 | 历史 `generation_requests` 不重写、不重跑 |
| T7.5 | 超引用上限 | 镜5 绑定大量资产 | `POST generations` | 返回 422，不静默截断 |
| T7.6 | 资产软删降级 | 镜5 引用的资产被软删 | `POST generations(shot_id=S005)` | 该资产降级文本引用或跳过，不报 500 |
| T7.7 | 资产缺失提示 | 分镜点名资产但项目无匹配 | `POST generations` | 提示回素材页补齐，不猜测、不跨项目取资产 |

### T8: 并发场景

| ID | 场景 | 前置 | 步骤 | 预期 |
|---|---|---|---|---|
| T8.1 | 同时设主图 | 两人操作同一变体 | A 设图X、B 同时设图Y 为主图 | 只有一个 `is_primary=true`；后操作者收 409 |
| T8.2 | 改资产 vs 生成 | B 正在生成引用 A001 的分镜 | A 同时编辑 A001 的关联/信息 | B 的生成用提交时快照，不受影响；后续生成用 A 的新数据 |
| T8.3 | 改资产可见性 | 上一步场景 | B 查看分镜生成页 | 显示轻提示”资产「A001」刚被 XX 修改过”，不阻断 |
| T8.4 | 生成中设主图 | 资产生成中 | 设另一张图为主图 | 不冲突；生成结果仍为候选 |
| T8.5 | 同时 materialize | 同一集 | 两人同时 POST materialize | 幂等，不产生重复 |
| T8.6 | 重复提交生成 | 同一用户 | 短时间连续点两次”生成并保存” | 幂等键挡一道，只提交一次 |

### T9: 边界与安全

| ID | 场景 | 步骤 | 预期 |
|---|---|---|---|
| T9.1 | 不跨项目写 | 任意操作后检查数据库 | 只写当前项目的 `project_asset_refs`，不跨项目 |
| T9.2 | 不硬删除 | 删除资产/变体/媒体 | 只设 `deleted_at`，不物理删除行 |
| T9.3 | 不自动付费 | 任何自动操作（materialize/backfill/资产编辑） | 不触发非用户主动提交的 `generation_requests` |
| T9.4 | 模型只来自 active 档 | 生成时查看模型选择 | 只能选项目 active 档配置的模型 |
| T9.5 | 三步流程提交 | 生成图片/音频 | 程序内部走 estimate → confirm → submit 三步流程，用户侧一次点击完成 |
| T9.6 | 音频生成可用 | 音频资产点弹窗 B 生成 | 可选音频模型，提交后返回音频结果 |
| T9.7 | Lite 审核不做 | 详情页 | 无审核 UI、无审核状态流转 |

### 通过标准

- T1–T9 全部通过 = 第一期可交付。
- T6.6（服装/音频解析）在解析流程扩展完成后才算。
- T8.3（可见性提示）允许延期到第一期补丁版本，不阻塞首发。

