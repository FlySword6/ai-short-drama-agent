# S55 ByteHouse 建表规范

状态：v2，2026-08-10；dev 新增对象已真实创建并由 readonly 身份读回。

本规范回答“表是怎么建的”。目标固定为 ByteHouse 华北 2（北京）开发环境的
`shortdrama_analytics`。PostgreSQL 仍是业务事实唯一真源；ByteHouse 只保存可重建的分析和
检索投影，不承接账号、权限、审核、发布或资产主数据写入。

## 1. 完整建表清单

| 域 | 物理表 / 视图 | 本单状态 | 用途与边界 |
| --- | --- | --- | --- |
| events | `events_product_fact` | 已存在未动 | 去标识产品事件明细 |
| cost | `cost_ledger_fact` | 已存在未动 | 报价、积分和供应商成本分栏归因 |
| radar | `radar_fetch_runs` | 已存在未动 | 上游调用与快照运行质量 |
| radar | `radar_rank_items` | 已存在未动 | 榜单条目版本 |
| asset_vec | `asset_vec_documents` | 已存在未动 | 资产实体/变体安全详情文档 |
| asset_vec | `asset_vec_embeddings` | 已存在未动 | 文档×媒体×模型的可审计向量空合同 |
| control | `sync_watermarks` | 已存在未动 | 四域批同步水位与重放对账 |
| asset search | `asset_vector_index` | **本单新建** | 经分级、人审、授权与发布放行的全文 + 1024 维向量检索投影 |
| asset search | `v_asset_vector_index_latest` | **本单新建** | 每个 canonical 来源最新可消费索引版本 |

另有 `s55_hello_world` 兼容通路证明和原有 9 个消费视图，均未修改。`s55_hello_world`
不计入领域表。

本单没有“补索引”的旧表：两张既有 `asset_vec_*` 表真实 `SHOW CREATE` 均无索引，但 goal
禁止修改已有表；全文与 HNSW 索引随新表 `asset_vector_index` 原子创建。

## 2. 数据规范文档族逐册对照

| 分册 | ByteHouse 放在哪 | 没有照搬的内容与原因 |
| --- | --- | --- |
| 0 数据规范总纲 | 全表稳定 ID、UTC 时间、中文注释、TTL、开放词表和不可逆敏感内容禁入 | OLTP 公共 envelope、RLS、change request 是 PostgreSQL 治理结构，不复制成 OLAP 事实 |
| 1 资产库 | `asset_vec_documents`、`asset_vec_embeddings`、`asset_vector_index` | `AssetEntity → AssetVariant → AssetMedia` 仍在 PG；不按资产类型拆第二套主表 |
| 2 生产链 | events/cost 中只保留必要 project/request/asset 引用 | Project/Episode/Scene/Shot/Storyline 是 OLTP 对象；分册注明“非建表授权” |
| 3 核算与指标 | `cost_ledger_fact`、events/radar 明细和可重算视图 | 不预建没有真实查询证据的日汇总事实；估算、积分、实际成本不互相推导 |
| 4 交付物 | 当前无专表 | 交付 manifest 与文件版本仍是 OLTP/TOS 事实；S55 没有独立分析查询需求 |
| 5 角色与权限 | `*_subject_key`、`visibility`、`authorized_project_ids`、clearance 仅作预过滤 | 角色、团队、RLS policy 和最终授权不复制；命中必须回应用 API 复核 |
| 6 事件与集成 | `events_product_fact` 及稳定合同版本 | 不复制 prompt、消息、供应商原始响应和错误正文 |
| 7 术语与本体 | `asset_kind`、role、usage、variant、model 等使用开放 String 词表 | 不用 Enum 冻结创作语汇，不为新增词条生成新表 |
| 8 核心业务对象 | 只保存 canonical ID、关系定位与分析所需字段 | 七类核心对象不整体迁入 ByteHouse；避免形成第二业务真源 |

参考槽位数量、时间轴片段、声音维度和受控编辑对象均留在现有 PG/媒体模型；向量明细通过
`item_ordinal`、`timeline_segment_id`、模态和媒体 ID 加行扩展，不在 DDL 硬编码 9/3/3、
50 或其他上限。

## 3. 每表物理合同

字段的逐列类型和含义以
[`bytehouse-field-dictionary.md`](./bytehouse-field-dictionary.md) 为准；本节给出每表可审查的
字段组、物理策略和 PG 关系。

| 表 | 字段组 | 分区 / 主排序 | 索引 | PostgreSQL 关系 |
| --- | --- | --- | --- | --- |
| `events_product_fact` | 事件身份、受控主体、项目/请求引用、安全属性、业务/接收/同步时间 | `toYYYYMM(occurred_at)`；事件名、业务时间、稳定 ID/版本 | 稀疏主键 | `app.events` 的去标识投影 |
| `cost_ledger_fact` | 来源身份、主体/项目、模型、三种成本口径、状态、token/时延、时间 | `toYYYYMM(occurred_at)`；来源类型、供应商、模型、稳定键/版本 | 稀疏主键 | quotes、credit ledger、provider costs、ai_calls 联合投影 |
| `radar_fetch_runs` | scope、日期、请求/状态、快照、时延/计数、稳定错误码、payload 摘要 | `toYYYYMM(started_at)`；来源、scope、自然日、稳定 ID/版本 | 稀疏主键 | upstream calls + snapshots |
| `radar_rank_items` | 快照、scope/日期、ordinal、标题/热度、公开链接、摘要/版本 | `toYYYYMM(fetched_at)`；来源、scope、榜单日、稳定 ID/版本 | 稀疏主键 | items + snapshots |
| `asset_vec_documents` | canonical 身份、项目范围、开放词表、可复现文本/分面、质量、状态/可见性、版本 | `toYYYYMM(source_updated_at)`；资产类型、来源对象、稳定 ID/版本 | 稀疏主键 | entities、variants、project refs、tags 的详情投影 |
| `asset_vec_embeddings` | 文档/资产/媒体血缘、模态/片段、TOS URI/摘要、模型/维度、单向量、版本 | `toYYYYMM(computed_at)`；模型、维度、模态、稳定 ID/版本 | 当前无 HNSW | 只接获批的持久向量 ledger；当前无真源所以保持空 |
| `sync_watermarks` | domain、batch、游标摘要、源版本、行数、同步/保留时间 | `toYYYYMM(synced_at)`；domain、版本、batch | 稀疏主键 | 同步器自身的可重放控制记录 |
| `asset_vector_index` | canonical 身份、资产/项目、治理门禁、安全文本、固定模型/向量、版本/保留 | `toYYYYMM(indexed_at)`；可见性、敏感级、资产类、模型、来源和版本 | `inverted(2)` + 1024/COSINE HNSW | PG 资产、分级、权利、审核、发布和保留裁决的安全检索投影 |

全部物理表使用 `CnchMergeTree` 和 `TTL toDateTime(retention_until) DELETE`。
`asset_vector_index` 按 ByteHouse Vector Search 官方建议显式使用
`index_granularity=128, index_granularity_bytes=0`；其余已存在表保持 8192，不做追改。

## 4. `asset_vector_index` 字段与 #77 安全规则

### 4.1 字段组

| 字段组 | 字段 |
| --- | --- |
| 稳定身份与血缘 | `index_id`、`document_id`、`source_table`、`source_id`、`detail_projection_*`、`asset_entity_id`、`asset_variant_id` |
| owner 与项目范围 | `owner_subject_key`、`source_project_id`、`authorized_project_ids`、`visibility`、`search_clearance` |
| 开放资产语义 | `asset_kind`、`role`、`usage_mode`、`variant_kind`、`variant_name`、`variant_is_primary`、`variant_sort_order` |
| 来源审核 | `source_status`、`parent_entity_status` |
| 分级分类 | `source_sensitivity_level`、`sensitivity_level`、`sensitivity_inheritance`、`classification_state/source/rule_id/confidence/reason/evidence`、确认人/时间、`policy_version`、`review_due_at` |
| 正交治理 | `rights_state/ref`、`clearance_state/ref`、`review_state`、`publication_state/ref`、`transfer_rule/ref`、`retention_class/ref` |
| 安全文本 | `title`、`summary`、`content`、`text_for_embedding` |
| 向量与版本 | 固定模型、1024 维单向量、输入 SHA-256、index/source 版本、三类时间和 `retention_until` |

### 4.2 准入与继承

- `source_sensitivity_level` 和 `sensitivity_level` 物理上只接受 S0/S1/S2；S3、未知、
  `pending_review` 均不能写进普通全文/向量表。
- `classification_state` 必须是 `confirmed`；`review_state` 必须是
  `human_accepted` 或 `human_corrected`。
- 来源资产与父实体必须 `approved`，`search_clearance=1`，rights/clearance 必须
  `cleared`，publication 必须 `approved`。
- 派生级别不得低于最高来源级别；唯一例外是
  `sensitivity_inheritance=audited_downgrade`，且必须同时有 reason 和脱敏 evidence 引用。
- `classification_evidence` 只保存证据引用 JSON，不存原始人脸、声纹、真人声音、合同正文、
  prompt、手机号、密钥、token、密码、连接串或供应商载荷。
- `authorized_project_ids`、visibility 和 clearance 只缩小候选集；最终用户/项目权限仍由
  PostgreSQL + 应用 API 裁决。

### 4.3 更新规则

PostgreSQL 状态、授权、项目引用、内容、策略或模型输入变化时，写入器用持久
`source_revision + index_version` 追加新版本；latest 视图只选最新行。撤销与软删的即时
fail-closed 仍由应用 API 复核，不能依赖 ByteHouse TTL 充当实时授权。

当前 PG 上传链尚未具备 #77 全字段、分类函数、人工确认和持久 1024 维向量 ledger，因此本单
只建空表，不伪造样例、不现场调用模型。分类函数、历史回填、真实样例写入与行为测试是后续
实现；它们不能反过来改变本表的 S3 fail-closed 合同。

## 5. DDL 与真实验证

- migration：`bytehouse/migrations/007_asset_vector_index.sql`
- ledger：`bytehouse/migrations/ledger.json`
- 真实 dev 读回：
  [`v011-s55-bytehouse-modeling-20260810.md`](../validation/v011-s55-bytehouse-modeling-20260810.md)
- 官方能力依据：
  [CDW 全文索引](https://www.volcengine.com/docs/6517/1255816)、
  [Vector Search 索引](https://www.volcengine.com/docs/6517/1568664)、
  [Vector Search 查询](https://www.volcengine.com/docs/6517/1568676)。

CDW 使用 `inverted(2)`，不套用企业版 advanced inverted v2/BM25 建表语法。查询向量索引
必须使用 `ORDER BY cosineDistance(...) LIMIT k SETTINGS enable_new_ann=1`；没有真实向量前
不以空表查询冒充检索可用性。
