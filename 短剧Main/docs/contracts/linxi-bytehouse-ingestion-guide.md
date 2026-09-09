# 林夕素材 Excel 与图片导入指南

适用：林夕、董言可直接转发给 DC 的第一版资料准备说明。目标是把角色、角色变体、道具、场景
整理成可审核、可导入的资产资料；**先 dev**。这不是让业务同学自行连接 ByteHouse 的操作手册。

## 先记住三件事

1. 一行代表一个主资产或一个角色变体；图片另行交付，不能塞进 Excel 单元格。新资料只需维护
   `source_record_key`，平台 UUID 由导入器生成，不要手工编造。
2. `asset_kind` 使用 `character`、`prop`、`scene`；角色变体不是第四种主资产，它有自己的
   `asset_variant_id` 并关联角色的 `asset_entity_id`。
3. 审核状态只有 `automatic_review`、`pending_review`、`approved`、`rejected`；新资料导入后
   默认进入 `pending_review`，Excel 里的 `approved` 不作为审批证据。只有平台审核动作产生的
   `approved` 可进入搜索索引。S55 已准备索引表 DDL，本轮不生成向量、不灌索引数据。

## Excel 工作簿结构

请建立一个工作簿，使用下列四个资产工作表，另加一个 `media` 工作表。列名必须保持英文，
内容可填中文；资料方只稳定维护 `source_*_key`，平台 UUID 由应用生成。同一批次业务键不可重复。
空白表示“不提供”，不要用“无”“待定”代替稳定键。

### 1. `characters`：角色主资产

| 列名 | 必填 | 含义与填写规则 |
| --- | --- | --- |
| `source_record_key` | 是 | 本批及后续修订都不变的业务键，例如 `CHAR-001`；用于关联变体和图片。 |
| `asset_entity_id` | 否 | 仅更新平台已有角色时填现有 UUID；新角色留空，由导入器生成。 |
| `asset_kind` | 是 | 固定填 `character`。 |
| `name` | 是 | 角色名称，例如“叶萧遥”。 |
| `source_project_key` | 是 | 资料方可识别的来源项目稳定键。 |
| `source_project_id` | 否 | 仅已有平台项目时填现有 UUID；否则由导入器映射。 |
| `role` | 否 | 当前角色职责词条，例如主角、反派；可为空。 |
| `usage_mode` | 否 | 使用方式词条；可为空。 |
| `intro` | 否 | 一两句人物简介；与平台 `asset_entities.intro` 同名。 |
| `appearance` | 否 | 整体外观描述。 |
| `hair_description` | 否 | 发型与头部特征。 |
| `outfit_description` | 否 | 服装描述。 |
| `category` | 否 | 角色分类词条；可为空。 |
| `style_tags` | 否 | 标签，用英文半角逗号分隔。 |
| `metadata` | 否 | 仅放已批准字段的 JSON；无内容留空，不粘贴整行原始 Excel 或自由敏感文本。 |
| `status` | 否 / 系统回填 | 新资料留空；导入器写 `pending_review`，后续状态只由平台审核动作更新。 |

### 2. `character_variants`：角色变体

| 列名 | 必填 | 含义与填写规则 |
| --- | --- | --- |
| `source_record_key` | 是 | 变体业务键，例如 `CHAR-001-LOOK-01`。 |
| `parent_source_record_key` | 是 | 所属角色的 `source_record_key`，必须已在 `characters` 中出现。 |
| `asset_variant_id` | 否 | 仅更新已有变体时填现有 UUID；新变体留空。 |
| `asset_entity_id` | 否 | 已知现有父角色 UUID 时可填；否则由 `parent_source_record_key` 映射。 |
| `variant_kind` | 是 | 变体类型词条，例如 `look`、`state`、`outfit`。 |
| `name` | 是 | 变体名称，例如“天尊版”。 |
| `is_primary` | 否 | 是否为该角色默认变体，填 `true` 或 `false`。 |
| `sort_order` | 否 | 展示顺序，填非负整数。 |
| `description` | 否 | 变体简介、外观和服装差异；与平台字段同名。 |
| `usage_context` | 否 | 变体使用场景。 |
| `metadata` | 否 | 已批准的少量补充属性 JSON；无内容留空。 |
| `status` | 否 / 系统回填 | 新资料留空；只有平台将变体和父角色都审批为 `approved` 才可入索引。 |

### 3. `props`：道具主资产

| 列名 | 必填 | 含义与填写规则 |
| --- | --- | --- |
| `source_record_key` | 是 | 道具业务键，例如 `PROP-001`。 |
| `asset_entity_id` | 否 | 仅更新已有道具时填现有 UUID；新道具留空。 |
| `asset_kind` | 是 | 固定填 `prop`。 |
| `name` | 是 | 道具名称。 |
| `source_project_key` | 是 | 资料方可识别的来源项目稳定键。 |
| `source_project_id` | 否 | 仅已有平台项目时填现有 UUID；否则由导入器映射。 |
| `role` | 否 | 道具职责或用途词条。 |
| `usage_mode` | 否 | 使用方式词条。 |
| `intro` | 否 | 道具简介与使用场景。 |
| `appearance` | 否 | 外观、材质、颜色等描述。 |
| `category` | 否 | 道具类型词条。 |
| `style_tags` | 否 | 标签，用英文半角逗号分隔。 |
| `metadata` | 否 | 已批准补充属性 JSON；不要粘贴原始 Excel 整行。 |
| `status` | 否 / 系统回填 | 新资料留空；导入器写 `pending_review`。 |

### 4. `scenes`：场景主资产

| 列名 | 必填 | 含义与填写规则 |
| --- | --- | --- |
| `source_record_key` | 是 | 场景业务键，例如 `SCENE-001`。 |
| `asset_entity_id` | 否 | 仅更新已有场景时填现有 UUID；新场景留空。 |
| `asset_kind` | 是 | 固定填 `scene`。 |
| `name` | 是 | 场景名称。 |
| `source_project_key` | 是 | 资料方可识别的来源项目稳定键。 |
| `source_project_id` | 否 | 仅已有平台项目时填现有 UUID；否则由导入器映射。 |
| `role` | 否 | 场景职责或用途词条。 |
| `usage_mode` | 否 | 使用方式词条。 |
| `intro` | 否 | 场景简介、地点、氛围。 |
| `appearance` | 否 | 空间、光线、色调等描述。 |
| `category` | 否 | 场景类型词条。 |
| `style_tags` | 否 | 标签，用英文半角逗号分隔。 |
| `metadata` | 否 | 已批准补充属性 JSON；无内容留空。 |
| `status` | 否 / 系统回填 | 新资料留空；导入器写 `pending_review`。 |

### 与需求初稿列名怎样对应

为避免大家重抄资料，需求稿里的已有列可以按下表归并；没有批准的新字段先放 `metadata`，
不要临时新增 Excel 列或数据库表。

| 需求稿里的列 | 本模板列 |
| --- | --- |
| `character_id` / `prop_id` / `scene_id` | 已是平台 UUID 才放 `asset_entity_id`；否则原值放 `source_record_key` |
| `variant_id` / `character_id` | 已是平台 UUID 才放 canonical ID；否则分别放 `source_record_key` / `parent_source_record_key` |
| `project_id` | 已是平台 UUID 才放 `source_project_id`；否则放 `source_project_key` |
| `intro` | 主资产保持 `intro`；变体归入 `description` |
| `hair_description`、`outfit_description` | 角色保持同名；变体归入 `description` |
| `material_description` | `appearance`；仍需保留的结构化内容放 `metadata` |
| `usage_context` | 变体保持 `usage_context`；主资产归入 `usage_mode`，补充说明写 `intro` |
| `visual_style`、`lighting_style`、`mood`、`color_tone` | `appearance` 与 `style_tags` |
| `metadata` | 清理后仍写 `metadata`，不得整包复制敏感或未知字段 |
| `approved` + `status` | 不作为导入批准；新资料留空，由平台写初始 `pending_review` 并记录审核动作 |
| `created_at` / `updated_at` | 不导入，由平台生成 |

## 图片怎样配对

在同一工作簿添加 `media` 工作表；一行是一张图片或一个视频文件的说明，文件本体放在与
`media` 表相同批次的媒体文件夹中。文件名使用 `media_file_name` 原样匹配，禁止填写访问链接、
签名 URL、bucket、密码或把图片嵌到单元格。

| 列名 | 必填 | 含义与填写规则 |
| --- | --- | --- |
| `media_source_key` | 是 | 本批媒体业务键，例如 `CHAR-001-FRONT-01`。 |
| `media_id` | 否 | 仅更新已有媒体时填现有 UUID；新媒体留空，由导入器生成。 |
| `media_file_name` | 是 | 交付文件夹内的精确文件名。 |
| `asset_source_record_key` | 是 | 对应角色、道具或场景的 `source_record_key`。 |
| `variant_source_record_key` | 否 | 对应角色变体时填写；主资产图片留空。 |
| `asset_entity_id` / `asset_variant_id` | 否 | 仅关联已有平台记录时填 UUID；否则由上述业务键映射。 |
| `media_kind` | 是 | `image` 或 `video`。 |
| `view_angle` | 否 | 例如 `front`、`side`、`back`、`three_view`、`reference`、`final`。 |
| `title` | 否 | 媒体标题。 |
| `description` | 否 | 媒体说明。 |
| `width_px` / `height_px` | 否 | 已知时填像素整数；导入器仍以文件实测为准。 |
| `format` | 否 | 文件格式；导入器仍以文件实测为准。 |
| `is_primary` | 是 | 是否主图，填 `true` 或 `false`；每个资产/变体最多一个主图。 |
| `sort_order` | 否 | 展示顺序，填非负整数。 |
| `metadata` | 否 | 已批准的少量补充属性 JSON。 |

配对规则：变体图同时填父 `asset_source_record_key` 与自身 `variant_source_record_key`；
角色、道具、场景主图只填前者。找不到文件、指向不存在业务键或一个对象有多个主图的行会被
预检退回。媒体当前使用平台既有 `approved` 兼容字段，该值由应用审核流程维护，不在 Excel
开放填写，也不能替代主资产/变体四态审核。

## 实际交接和导入步骤

1. 林夕/董言按上述模板整理 Excel 和媒体文件夹，先自查业务键和文件名；新资料的 canonical
   UUID 与审核状态留空。
2. 交给 S55 做本地预检；S55 返回业务键重复、关联、字段和图片配对错误，不会代替业务审核。
3. 首批可由我方另行提供的受控脚本代导，通过平台应用边界建立 canonical 资产、变体和媒体记录；
   林夕/董言不需要自行获取数据库写权限。
4. 业务审核 owner 将需要检索的资产和其变体明确审批为 `approved`。
5. Fable 确认 endpoint allowlist 完整，并明确批准本次 **dev** 投影/索引远端动作。
6. 获批记录才投影到 `shortdrama_analytics`；后续另行批准的任务再生成向量并写索引。
7. S55 对 dev 做严格回读，交付不含 host、连接串或 secret 的结果；只有后续单独批准，才可用
   相同模板推进 test/prod。

任何一步缺失都停止在本地预检或待审核状态。第一版本 S55 不写向量、不调用 embedding、不创建
Milvus 对象，也不把 `shortdrama_entity` 当作 S55 四域导入目标。
