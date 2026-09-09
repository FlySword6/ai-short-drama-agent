# ByteHouse 资产混合检索对齐包（R51 已采纳）

> 2026-08-10：本文件保留历史决策轨迹；当前实建合同与真实 dev 读回见
> [`bytehouse-asset-vector-index-alignment-20260810.md`](./bytehouse-asset-vector-index-alignment-20260810.md)。
> 新迁移编号为 `007`，CDW 全文索引使用官方 `inverted(2)`，并纳入 #77 安全字段。

状态：**Fable 已采纳 R51 物理模型；尚不是远端 apply 完成回执**。
适用范围：S55 的 `asset_vec_*` 域和新增 `005_asset_vector_index.sql`；不修改
PostgreSQL、审核服务、TOS、Milvus 或既有 `004_asset_vec.sql`。

## 1. 已采纳结论与执行边界

1. 资产明细采用 **统一详情投影 + 开放 `asset_kind`**。这是 S55 按骨架四原则作出的建模选择，
   与“B：独立分析域库”的库拓扑裁决不是同一个 B。既有 `asset_vec_documents` 是详情投影，
   新的 `asset_vector_index` 是一资产实体或一资产变体一行的统一检索投影；不生成
   `asset_detail_<kind>` 分类表。
2. 新增物理表为 `asset_vector_index`，由 `005_asset_vector_index.sql` 创建。该名称是
   `asset_vec_*` 前缀规则的受控例外；合同允许的资产向量对象前缀为
   `asset_vec_*` **或** `asset_vector_index*`。
3. R51 采用 `doubao-embedding-vision-251215`。本物理 HNSW 表固定
   **1024 维**：该值有已授权付费 smoke 回执支持，不从模型名称推断。证据在 context repo
   `docs/wiki/zhongwen-overseas-ai-shortdrama/_ops/reports/2026-06-30-vector-engine-vikingdb-milvus-evidence.md`
   的 text/image 两次 1024 输出记录；它只证明模型输出维度，不证明 ByteHouse HNSW 已开通。
4. `status` 只复用现有四态：`automatic_review`、`pending_review`、`approved`、
   `rejected`。**只有 `approved`** 进入 `asset_vector_index`；不另造 `search_approved`、
   `review_state` 或兼容布尔状态机。
5. 首先只在 dev 做受控验证。HNSW、全文 `inverted` 索引、对象 grant、endpoint allowlist
   与任何远端 `--apply`/`--verify` 都仍受 allowlist 和实际 dev 回读闸门约束；本文件不声称
   tenant 已开通这些能力，也不声称云端已建表。

```text
PostgreSQL（资产、变体、媒体、审核和授权真源）
  -> asset_vec_documents（安全详情投影）
  -> asset_vector_index（获批资产/变体的文本混合检索投影）
  -> 应用 API 复核授权、回查详情和组装媒体
```

ByteHouse 始终是 OLAP/可重建投影，不回写业务状态。命中结果只可作为候选；应用 API
必须重新检查当前用户、项目引用、clearance、软删除和审核状态。

### 资产类分表与统一投影两案比较

| 维度 | 词表驱动生成分类表 DDL | 统一详情投影 + `asset_kind`（S55 采用） |
| --- | --- | --- |
| 林夕的阅读习惯 | 角色、变体、道具、场景一眼对应独立表 | 通过 `asset_kind`、`source_table` 和变体字段区分 |
| 新增资产类 | 词表变更后仍须生成、评审、部署新物理表 | 插入 L2 词条并投影数据，不改 schema |
| OLTP 对齐 | 分类表会把平台 `asset_entities` 再拆一层，ETL 映射增加 | 与 `asset_entities` / `asset_variants` 两级同构，角色×变体直接对应角色×造型 |
| 检索与血缘 | 多详情表需要维护生成器、版本及跨表回查规则 | canonical `source_table + source_id` 与统一详情定位稳定 |
| 2.5 扩展 | 新模态/资产类持续增加物理对象 | 类型、标签、模态和模型以数据/版本扩展 |

S55 采用统一投影，是因为它同时满足骨架 L2 词表开放、平台 OLTP 同构和 R51 统一检索；
Excel 仍保留 `characters`、`character_variants`、`props`、`scenes` 四个业务友好的工作表，
由导入预检映射到统一 canonical 模型。若未来真实查询证明某一资产类必须有专属列或性能边界，
再以独立迁移提出例外，而不是由新增词条自动膨胀 schema。

## 2. 术语、血缘与状态准入

| 逻辑对象 | OLTP 真源 | `asset_vector_index` 口径 |
| --- | --- | --- |
| 主资产 | `asset_entities` | `asset_entity_id` 为稳定身份；实体行的 `source_table=asset_entities` |
| 资产变体 | `asset_variants` | `asset_variant_id` 非空，仍保留父 `asset_entity_id`；变体行的 `source_table=asset_variants` |
| 媒体 | `asset_media` | 仅由 API 在命中后授权、组装和展示，不单独成为索引行 |
| 项目可用范围 | `project_asset_refs` | `authorized_project_ids` 只作候选预过滤，绝不替代最终鉴权 |
| 详情投影 | `asset_vec_documents` | `detail_projection_table=asset_vec_documents`，`detail_projection_id=document_id` |
| 审核准入 | entity/variant 的 `status` | 仅 `approved` 写入；待审、自动审核和拒绝均不写入 |

`source_table + source_id` 永远指 PostgreSQL canonical 真源，当前只能是
`asset_entities` / `asset_variants`；ByteHouse 详情表定位另用
`detail_projection_table + detail_projection_id`。不得假称存在 `asset_characters`、
`asset_props` 或 `asset_scenes` 等分类 OLTP 表。

变体采用父子双重 fail-closed：变体自身和父实体均须为 `approved`，且状态、修订和授权
无法可信同步时不写索引。历史兼容布尔 `approved` 仅能做迁移质量对账，不能成为准入真源。

## 3. `005` 物理表合同

`005` 只新增下面这一张物理表；不重命名、ALTER 或回写 `004_asset_vec.sql`。同步写入的
稳定组合至少为：

```text
source_table + source_id + document_id + embedding_model + embedding_dimension
+ source_revision + index_version
```

ByteHouse 的 PRIMARY KEY 不是唯一约束，写入器和质量检查必须据此去重、处理重放和乱序。
`source_revision` 必须来自 PostgreSQL 持久 outbox 序号或 Fable 批准的等价 canonical 版本，
不得使用进程内计数。

| 字段组 | 字段与约束 | 口径 |
| --- | --- | --- |
| 身份与来源 | `index_id`、`document_id`、`source_table`、`source_id`、`detail_projection_table`、`detail_projection_id` | 一行是一资产实体或变体的索引版本；canonical 来源和详情投影语义分离 |
| 资产范围 | `asset_entity_id`、`asset_variant_id`、`source_project_id`、`authorized_project_ids`、`asset_kind` | `asset_kind` 是开放词表；项目数组仅缩小候选集 |
| 状态 | `status`、`parent_entity_status` | 均使用四态原值；物理写入只接受 `approved`，变体的父状态也必须为 `approved` |
| 可检索内容 | `title`、`summary`、`content`、`text_for_embedding` | 由批准字段可复现编译；不写 prompt、签名 URL、供应商响应或媒体二进制 |
| 向量 | `embedding_model`、`embedding_dimension`、`embedding`、`embedding_input_sha256` | 模型固定 `doubao-embedding-vision-251215`；维度固定 1024，且 `length(embedding)=1024` |
| 版本与保留 | `index_version`、`source_updated_at`、`source_revision`、`indexed_at`、`synced_at`、`retention_until` | 分区 `toYYYYMM(indexed_at)`；`TTL toDateTime(retention_until) DELETE` 由源生命周期、模型退役和环境策略计算 |

键与物理形态：

```text
ENGINE       CnchMergeTree
PARTITION BY toYYYYMM(indexed_at)
ORDER BY     (status, asset_kind, embedding_model, embedding_dimension,
              source_table, source_id, source_revision, index_version, index_id)
PRIMARY KEY  同 ORDER BY
TTL          toDateTime(retention_until) DELETE
```

目标索引（必须在 dev 能力闸门通过后，才可远端创建并严格回读）：

```sql
INDEX asset_vector_content_inverted content
  TYPE inverted('standard', '{"version":"v2"}') GRANULARITY 1,
INDEX asset_vector_embedding_hnsw embedding
  TYPE HNSW('DIM=1024, METRIC=COSINE')
```

全文索引使用 v2 是为了与林夕需求和 `byted-bytehouse-hybrid-search` 的 BM25 + RRF
流程一致；HNSW 按官方建表语法不附加 `GRANULARITY`。两项仍须在 dev 实建前确认高级全文和
VectorSearch 能力已开通。

约束和同步器均须检查：非空身份、合法来源表、实体/变体父子形状、四态取值、仅
`approved` 准入、`source_revision > 0`、`embedding_dimension = 1024` 和向量长度为 1024。
即使 tenant 接受 constraint 语法，S52 写入器仍须在写前执行同样校验。

## 4. 四原则对照

| 原则 | B + `asset_vector_index` 放在哪 | 不允许的偏移 |
| --- | --- | --- |
| 数据流驱动回路 | canonical ID、`source_revision`、输入摘要和索引版本让内容/状态变化可追溯、可重建；命中反馈经 API 回 OLTP | ByteHouse 直写业务状态，或把旧投影行视为最终授权 |
| 枚举只冻不变量、词表开放 | 四态是既有 L0 合同；`asset_kind`、变体类型和标签仍为 L2 词表，新增创作类只插词条 | 为角色、道具、场景各建一张主表，或新增平行审核状态 |
| 2.5 前瞻 | 资产类型、内容版本、模型与索引版本均数据化；未来空间切换可走新表/完整重嵌 | 在同一 HNSW 表混写不同维度，或把当前参考数量写死进 schema |
| Agent-first | 中文注释、显式血缘、键、分区和 TTL 支持质量工具；Agent 只经应用/API 获得授权候选 | 给 Agent 直连基础表权限、媒体 URL 或绕过 PostgreSQL 鉴权 |

## 5. 偏离与理由

1. **命名例外已登记。** 新表必须使用产品已沟通的 `asset_vector_index`，而不是改名为
   `asset_vec_index`；因此前缀规则明确扩为 `asset_vec_*` 或 `asset_vector_index*`，使 migration
   helper、字段字典、registry 和质量扫描都不会漏表。
2. **1024 覆盖旧的 2048 表述。** 旧 `asset_vec_embeddings` 文档曾把 `251215` 写为“当前 2048”，
   历史 `250615` ImageRAG POC 也不能证明 R51 的物理 HNSW 维度。本次获批的、付费 smoke-backed
   `251215` 请求返回 1024，因此 `asset_vector_index` 固定 1024；旧媒体级投影不因此被改写或
   混入该 HNSW。未来换维度必须新建隔离表或完成重嵌/切换，不得混写。
3. **无 TTL 撤回 machinery 未获批，故不随 005 夹带。** 本次 `005` 仅有
   `asset_vector_index`，没有 `active_revocations`、撤回审计表或安全 view。审核撤回、软删、
   clearance/项目范围变化的即时失效仍由 OLTP + 应用 API 复核承担；如需 ByteHouse 侧
   fail-closed 撤回结构，必须另行批准其对象、无 TTL 例外、权限、物理删除验证与回滚合同。

## 6. 验证闸门与未发生动作

在任何远端 apply 前，dev 必须有不含凭据的可复核收据，至少证明：

1. 已授权付费 smoke 的模型、1024 输出和请求/回执关联；
2. HNSW `DIM=1024` 可在目标 engine 创建，并以固定 `cosineDistance` + `LIMIT` 查询形态工作；
3. tenant 已开通全文高级能力，`inverted` 可创建和查询；
4. 非法来源、非 approved 状态、父状态缺失、非 1024 向量和重复稳定组合均被写入器/质量检查拒绝；
5. `005` 表、中文注释、键、分区、TTL、索引和对象 grant 可被 strict verify 回读；
6. Fable 批准 dev endpoint allowlist 和当次 apply；test/prod 另行批准，不能由 dev 结果推定。

版本库 allowlist 的批准项还必须绑定当前 schema manifest，并在核对第 2、3 项后明确列出
`vector_hnsw_1024_cosine` 与 `advanced_inverted_v2`，且分别登记可复核能力收据内容的
SHA-256；当次 apply 使用独立、短时且绑定同一 manifest 的授权。只填 endpoint hash、能力名
或固定 confirm 字符串都不足以解锁 005。

截至本包更新，未创建或修改任何 ByteHouse database、表、索引、账号、grant、endpoint、
environment 或云资源；`shortdrama_entity` 也未被修改、复制或用作 S55 四域写入目标。
