# ByteHouse 短剧素材资产库需求

## 一、建设目标

本需求用于规划短剧素材智能体项目的数据表与检索链路。当前目标是建立清晰、可落地、可扩展的数据模型，避免把所有内容混在一张大宽表里。

核心目标：

1. 支持 Excel 批量入库，将素材按资产类型分类存储。
2. 先以角色、角色变体、道具、场景和媒体资源为主要对象。
3. 角色主资产、角色变体、媒体资源分表管理，避免数据混乱。
4. ByteHouse 中单独建设轻量混合检索索引表，用于承载全文检索和向量检索。
5. 检索命中后，通过 source_table + source_id 回 ByteHouse 业务明细表查询完整详情。

## 二、总体设计

建议采用以下结构：

```text
ByteHouse 业务明细表：存真实业务数据
asset_media：统一存图片、视频、多视图等媒体资源
asset_vector_index：只存检索正文、全文索引和向量索引
```

整体链路：

```text
Excel / 图片入库
        ↓
识别资产类型：角色 / 角色变体 / 道具 / 场景
        ↓
写入对应 ByteHouse 业务明细表
        ↓
图片、多视图等资源写入 asset_media
        ↓
审核通过后生成向量索引
        ↓
写入 ByteHouse asset_vector_index
        ↓
用户检索时先查 asset_vector_index
        ↓
根据 source_table + source_id 回 ByteHouse 业务明细表查详情
        ↓
按 asset_id / variant_id 关联 asset_media
        ↓
返回前端
```

核心原则：

```text
主资产归主资产表
变体归变体表
媒体归 media 表
全文检索和向量检索归 asset_vector_index
```

## 三、业务资产表设计

### 3.1 项目表：source_projects

用于记录素材所属项目，例如《天尊》《FF超能九组》等。

| 字段名 | 说明 |
|---|---|
| project_id | 项目唯一 ID |
| project_name | 项目名称 |
| project_code | 项目编码 |
| project_type | 项目类型，例如 excel_upload / manual_upload |
| description | 项目描述 |
| metadata | 扩展信息 |
| created_at | 创建时间 |
| updated_at | 更新时间 |

### 3.2 角色表：asset_characters

角色表只存主角色，不再混放变体。

| 字段名 | 说明 |
|---|---|
| character_id | 角色唯一 ID |
| project_id | 所属项目 ID |
| project_name | 所属项目名称 |
| character_name | 角色名称，例如叶萧遥 |
| gender | 性别 |
| age_value | 年龄 |
| height_cm | 身高 |
| person_type | 角色类型 |
| intro | 人物简介 |
| appearance | 外观描述 |
| hair_description | 发型与头部特征 |
| outfit_description | 服装描述 |
| style_tags | 风格标签 |
| approved | 审核状态 |
| status | 业务状态 |
| metadata | 扩展 JSON |
| created_at | 创建时间 |
| updated_at | 更新时间 |

### 3.3 角色变体表：asset_character_variants

角色变体单独建表，通过 character_id 关联主角色。

例如：

```text
叶萧遥：存 asset_characters
叶萧遥天尊版：存 asset_character_variants，character_id 指向叶萧遥
```

| 字段名 | 说明 |
|---|---|
| variant_id | 变体唯一 ID |
| character_id | 父角色 ID |
| project_id | 所属项目 ID |
| project_name | 所属项目名称 |
| variant_name | 变体名称，例如天尊版 |
| full_name | 完整名称，例如叶萧遥天尊版 |
| variant_type | 变体类型，例如 look / state / outfit |
| intro | 变体简介 |
| appearance | 变体外观描述 |
| outfit_description | 变体服装描述 |
| usage_context | 使用场景 |
| style_tags | 风格标签 |
| approved | 审核状态 |
| status | 业务状态 |
| metadata | 扩展 JSON |
| created_at | 创建时间 |
| updated_at | 更新时间 |

### 3.4 道具表：asset_props

用于存储道具、法器、武器、物件类资产。

| 字段名 | 说明 |
|---|---|
| prop_id | 道具唯一 ID |
| project_id | 所属项目 ID |
| project_name | 所属项目名称 |
| prop_name | 道具名称 |
| prop_type | 道具类型 |
| usage_context | 使用场景 |
| appearance | 外观描述 |
| material_description | 材质描述 |
| style_tags | 风格标签 |
| approved | 审核状态 |
| status | 业务状态 |
| metadata | 扩展 JSON |
| created_at | 创建时间 |
| updated_at | 更新时间 |

### 3.5 场景表：asset_scenes

用于存储场景、环境、空间类资产。

| 字段名 | 说明 |
|---|---|
| scene_id | 场景唯一 ID |
| project_id | 所属项目 ID |
| project_name | 所属项目名称 |
| scene_name | 场景名称 |
| scene_type | 场景类型 |
| location_description | 地点描述 |
| visual_style | 视觉风格 |
| lighting_style | 光线风格 |
| mood | 氛围 |
| color_tone | 色调 |
| style_tags | 风格标签 |
| approved | 审核状态 |
| status | 业务状态 |
| metadata | 扩展 JSON |
| created_at | 创建时间 |
| updated_at | 更新时间 |

## 四、媒体表设计

媒体表单独存图片、视频、多视图、参考图等资源。

表名建议：

```text
asset_media
```

字段建议：

| 字段名 | 说明 |
|---|---|
| media_id | 媒体唯一 ID |
| asset_kind | 资产类型：character / character_variant / prop / scene |
| asset_id | 关联主资产 ID，例如 character_id / prop_id / scene_id |
| variant_id | 关联变体 ID，可为空 |
| project_id | 所属项目 ID |
| media_type | 媒体类型：image / video |
| view_type | 视图类型：front / side / back / three_view / reference / final |
| media_url | 媒体地址 |
| storage_bucket | 存储桶 |
| storage_path | 存储路径 |
| width | 图片宽度 |
| height | 图片高度 |
| format | 文件格式 |
| sha256 | 文件 hash，用于去重 |
| is_primary | 是否主图 |
| sort_order | 展示排序 |
| approved | 审核状态 |
| metadata | 扩展 JSON |
| created_at | 创建时间 |

示例：

```text
叶萧遥天尊版正面图：
asset_kind = character_variant
asset_id = 叶萧遥ID
variant_id = 叶萧遥天尊版ID
view_type = front
```

这样媒体资源不会污染角色表、变体表、道具表和场景表，同时可以清楚关联到具体资产。

## 五、ByteHouse 混合检索索引表设计

ByteHouse 中不建议把所有业务字段塞进一张复杂宽表，也不建议让角色表、变体表、道具表、场景表分别承担主检索能力。建议在业务明细表之外，单独建立一张轻量混合检索索引表：

```text
asset_vector_index
```

这张表只负责角色、角色变体、道具、场景等业务资产的检索，不负责承载完整业务数据。图片、多视图、视频等 media 不作为独立索引记录进入该表，只在检索命中资产后按关联关系查询展示。

索引建设原则：

```text
业务明细表：存完整业务字段，不作为主检索表
asset_vector_index：统一承载全文检索字段和向量字段
全文索引：建在 asset_vector_index.content 上
HNSW 向量索引：建在 asset_vector_index.embedding 上
```

这样做的好处是：角色、变体、道具、场景仍然分表存储，数据结构清楚；检索时又可以在一张索引表里统一做全文召回、向量召回和混合排序，避免多张业务表分别检索后再跨表合并分数。

字段建议：

| 字段名 | 说明 |
|---|---|
| index_id | 索引记录唯一 ID |
| doc_id | 检索文档 ID，可与 index_id 保持一致，或按 ByteHouse 混合检索要求生成 |
| source_table | 来源业务表，例如 asset_characters / asset_character_variants / asset_props / asset_scenes |
| source_id | 来源记录 ID |
| asset_kind | 资产类型：character / character_variant / prop / scene |
| project_id | 项目 ID |
| parent_asset_id | 父资产 ID，可为空；例如变体对应的 character_id |
| title | 检索标题 |
| summary | 检索摘要 |
| content | 用于全文检索的正文，可由名称、简介、外观、标签、使用场景等字段拼接 |
| text_for_embedding | 用于生成向量的文本 |
| embedding | 向量字段 |
| approved | 审核状态 |
| status | 业务状态 |
| metadata | 少量检索扩展信息 |
| created_at | 创建时间 |
| updated_at | 更新时间 |

索引示例：

| source_table | source_id | asset_kind | parent_asset_id | title |
|---|---|---|---|---|
| asset_characters | 叶萧遥ID | character | 空 | 叶萧遥 |
| asset_character_variants | 叶萧遥天尊版ID | character_variant | 叶萧遥ID | 叶萧遥天尊版 |
| asset_props | 法器ID | prop | 空 | 玄天剑 |
| asset_scenes | 大殿ID | scene | 空 | 仙门大殿 |

检索命中后，通过：

```text
source_table + source_id
```

回 ByteHouse 业务明细表查询完整详情，再按资产 ID 查询 asset_media。

检索表索引建议：

```text
content 建全文倒排索引，用于关键词、名称、标签、描述类召回
embedding 建 HNSW 向量索引，用于语义相似度召回
asset_kind / project_id / approved / status 作为结构化过滤字段
```

不需要在每一张分类业务表都重复创建主全文索引。分类业务表只需要满足详情查询、管理和必要的结构化筛选即可；主检索统一走 asset_vector_index。

## 六、入库流程

建议入库流程：

```text
1. 上传 Excel
2. 解析表头、行数据和图片
3. 识别资产类型：角色 / 角色变体 / 道具 / 场景
4. 主角色写入 asset_characters
5. 角色变体写入 asset_character_variants
6. 道具写入 asset_props
7. 场景写入 asset_scenes
8. 图片、多视图、参考图写入 asset_media
9. 生成待审核记录
10. 审核通过后生成 content 和 text_for_embedding
11. 调用 embedding 模型生成向量
12. 写入 ByteHouse asset_vector_index
```

## 七、检索流程

建议检索流程：

```text
用户输入搜索词
        ↓
生成 query embedding
        ↓
在 ByteHouse asset_vector_index 中做结构化过滤 + 全文检索 + 向量检索
        ↓
返回 source_table + source_id
        ↓
回 ByteHouse 业务明细表查询角色 / 角色变体 / 道具 / 场景详情
        ↓
按 character_id / variant_id / prop_id / scene_id 关联 asset_media
        ↓
组装前端展示结果
```

如果用户选择资产类型，例如“角色”，则在 asset_vector_index 中过滤：

```text
asset_kind = character
```

如果用户搜索“叶萧遥天尊版正面图”，检索命中的是“叶萧遥天尊版”这个角色变体资产；返回详情时，再从 asset_media 中查找该变体的正面图、侧面图、三视图等关联媒体。

推荐的混合检索链路：

```text
1. content 走全文检索，解决名称、关键词、标签命中
2. embedding 走 HNSW 向量检索，解决语义相似、描述相近命中
3. 对全文结果和向量结果做融合排序
4. 返回 source_table + source_id
5. 回对应 ByteHouse 业务明细表查完整详情
6. 再关联 asset_media 查询图片、视频、多视图和站位图
```

## 八、推荐结论

推荐采用以下方案：

```text
角色主资产放 asset_characters
角色变体放 asset_character_variants
道具放 asset_props
场景放 asset_scenes
图片、多视图、视频等媒体资源统一放 asset_media
ByteHouse 中业务明细表和 asset_vector_index 混合检索索引表分开建设
全文索引和 HNSW 向量索引都建在 asset_vector_index，不分散建在各业务表
检索表不放 media，media 只通过资产关联展示
检索命中后回 ByteHouse 业务明细表查询完整详情
```

这个方案结构更清楚，避免角色、变体、图片混在一张表里，也避免 ByteHouse 大宽表过度复杂。
