# ByteHouse 四域字段字典

状态：S55 主卡 v2，2026-08-10。
架构真源：`docs/design/ontology-blueprint.md`。
物理 DDL：`bytehouse/migrations/002_events.sql` 至 `007_asset_vector_index.sql`。S55-HW 的
`001_hello_world.sql` 是独立兼容证据，不属于本领域 ledger。

## 1. 适用范围与数据库

同一套表结构初始化到三个隔离环境：

| 环境 | 数据库 | 数据面连接 |
| --- | --- | --- |
| dev | `shortdrama_analytics` | dev environment 的独立 ByteHouse endpoint |
| test | `shortdrama_analytics` | test environment 的独立 ByteHouse endpoint |
| prod | `shortdrama_analytics` | prod environment 的独立 ByteHouse endpoint |

本轮仅允许 dev，网络沿 S55-HW 的私网、单 `/32` allowlist 与固定 loopback 隧道。
test/prod 没有本轮授权，不能因同名数据库或 dev 验证而自动复制。

ByteHouse 只保存 PostgreSQL 事实的分析/检索投影。同步方向固定为
`PostgreSQL/TOS → ByteHouse`；推荐、反馈、人工复核、权限和发布裁决必须通过应用 API
回到 PostgreSQL，禁止从 ByteHouse 反向改业务状态。

## 2. 七张领域表 + 一张控制表

| 域 | 表 | 一行的粒度 | 主要消费者 |
| --- | --- | --- | --- |
| events | `events_product_fact` | 一条去标识后的产品/生产事件 | 使用趋势、生产效果分析、反馈分析 |
| cost | `cost_ledger_fact` | 一笔 generation quote 或一笔 ai_call 的一个源版本 | 项目/用户/模型成本归因 |
| radar | `radar_fetch_runs` | 一次上游调用及其快照结果 | 雷达稳定性、额度与失败分析 |
| radar | `radar_rank_items` | 一个快照中的一个榜单条目版本 | 题材趋势分析 |
| asset_vec | `asset_vec_documents` | 一个资产实体或角色造型/阶段的可检索文档版本 | 关键词/混合检索、资产目录 |
| asset_vec | `asset_vec_embeddings` | 一个文档×模态×媒体×模型的单条向量版本 | 文搜图、图搜图、多模态检索 |
| asset search | `asset_vector_index` | 一个经人工确认与治理放行的资产实体或变体索引版本 | 安全全文、语义与混合检索 |
| control | `sync_watermarks` | 一域一次稳定同步批次 | 同步恢复、重放与对账 |

不预建日汇总表。汇总可由明细重算；没有真实查询证据前，不把可重算结果固化成第二份事实。

## 3. 跨表字段纪律

- ID 使用 PostgreSQL canonical ID 或由 canonical ID、模态、模型与投影版本确定的稳定 ID；
  禁止用名称、文件名、剧名或阶段文本拼主键。
- 所有业务时间使用 `DateTime64(3, 'UTC')`；`radar.cache_date/rank_date` 保留
  Asia/Shanghai 自然日语义。
- `PRIMARY KEY` 是 ByteHouse 稀疏索引，不当作唯一约束。同步层负责幂等，
  quality-inspector 负责重复检查。
- 每表都显式提供 `retention_until`，DDL 使用
  `TTL toDateTime(retention_until) DELETE`；显式转换兼容 ByteHouse 对 TTL
  结果类型的要求，不改变毫秒精度源字段。
  具体期限来自获批的环境/财务/隐私配置，不在 schema 中硬编码。
- 创作语汇使用 `String`/`LowCardinality(String)` 或规范词条 ID；这些类型只优化存储，
  不冻结取值。钱、状态、权限等 L0 值仍由 PostgreSQL 合同裁决。
- JSON 只保存经过 allowlist、去标识、可审计的投影。提示词、消息正文、供应商原始响应、
  错误正文、密码、token、签名 URL 和个人可识别资料不得进入这些表。

## 4. `events_product_fact`

上游：`app.events`（migration 011）。同步水位用 `(received_at, id)`；业务分区用
`occurred_at`。`props` 必须按事件目录做 allowlist，未知事件/未知字段进入隔离队列，
不得自动扩列或原样复制。

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `event_id` | String | `events.id`，稳定事件标识 |
| `event_name` | LowCardinality(String) | `events.event`，开放事件合同名 |
| `event_contract_version` | UInt32 | 事件属性合同版本 |
| `user_subject_key` | String | `events.user_id` 的受控标识，不带用户资料 |
| `project_id` | Nullable(String) | 从批准属性 `project_id` 提取 |
| `request_id` | Nullable(String) | 从批准属性 `request_id` 提取 |
| `quote_id` | Nullable(String) | 从批准属性 `quote_id` 提取 |
| `asset_entity_id` | Nullable(String) | 从批准属性 `asset_entity_id` 提取 |
| `media_kind` | Nullable(String) | `generation_submit` 等事件的媒体类型词表值 |
| `result_status` | Nullable(String) | `generation_result` 等事件的系统状态 |
| `search_mode` | Nullable(String) | `asset_search` 的检索方式 |
| `result_count` | Nullable(UInt32) | 搜索/导入等事件报告的数量 |
| `safe_props_json` | String | allowlist 后的剩余安全属性 JSON |
| `props_redacted` | UInt8 | 必须为 `1`，证明已走白名单和去标识 |
| `occurred_at` | DateTime64(3, UTC) | 客户端报告的业务发生时间 |
| `received_at` | DateTime64(3, UTC) | 服务端接收时间和微批水位 |
| `source_updated_at` | DateTime64(3, UTC) | 源记录最近可观察变更时间 |
| `synced_at` | DateTime64(3, UTC) | 本行写入 ByteHouse 的时间 |
| `retention_until` | DateTime64(3, UTC) | 环境保留策略算出的删除时间 |

当前允许投影的事件属性：

| 事件 | 允许字段 |
| --- | --- |
| `login` | 无 |
| `project_create` | `project_id` |
| `asset_search` | `mode`、`count`、`page` |
| `asset_import` | `channel`、`count` |
| `asset_upload_submit` | 不承接 `file_name`，只保留事件本身 |
| `generation_confirm` | `quote_id` |
| `generation_submit` | `source`、`media_kind`、`project_id`、`request_id`、`retry_of` |
| `generation_result` | `request_id`、`status` |

## 5. `cost_ledger_fact`

上游不是单表：`generation_quotes`、`user_credit_ledger_entries`、`provider_costs` 与
`ai_calls` 共同提供事实。不得从估算金额反推积分或供应商实际成本；旧 quote/ai_call 后续仍会
更新，首版按稳定源 ID + `source_version` 追加，再由 latest view 合并。

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `entry_key` | String | `source_table:source_id`，跨源稳定键 |
| `entry_kind` | LowCardinality(String) | 首批 `generation_quote` / `ai_call` |
| `source_table` | LowCardinality(String) | `generation_quotes` / `ai_calls` |
| `source_id` | String | 对应 quote 或 ai_call 的 ID |
| `source_version` | UInt64 | 同一源事实的单调同步版本 |
| `user_subject_key` | String | quote.user_id 或 ai_calls.caller_user_id 的受控标识 |
| `project_id` | Nullable(String) | 项目归属；ai_call 允许为空 |
| `generation_request_id` | Nullable(String) | quote 关联的生成请求 |
| `generation_attempt_id` | Nullable(String) | quote 关联的生成尝试 |
| `pricing_rule_id` | Nullable(String) | quote 使用的价格规则 |
| `capability_tier_key` | Nullable(String) | 能力档位键；新模型通过加档位扩展 |
| `provider` | LowCardinality(String) | attempt/ai_call 供应商 |
| `model` | LowCardinality(String) | attempt/ai_call 模型 ID |
| `purpose` | String | ai_call purpose 或生成用途合同值 |
| `media_kind` | Nullable(String) | 生成媒体类型 |
| `source_status` | LowCardinality(String) | quote/ai_call/attempt 的系统状态 |
| `estimated_cost_fen` | Nullable(Int64) | quote 的预估人民币分；未消费时只是估算 |
| `actual_cost_fen` | Nullable(Int64) | attempt/ai_call 明确报告的实际人民币分 |
| `cost_cny_micros` | Nullable(Int64) | `provider_costs` 明确记录的人民币微元 |
| `cost_calculation_status` | Nullable(String) | `provider_costs.calculation_status` |
| `charged_points` | Nullable(Int64) | OLTP 明确记账的积分；不从人民币分推导 |
| `currency` | LowCardinality(String) | 金额币种，人民币分使用 `CNY` |
| `is_unpriced` | UInt8 | 实际成本未知时为 `1` |
| `input_tokens` | Nullable(UInt64) | ai_call 输入 token |
| `output_tokens` | Nullable(UInt64) | ai_call 输出 token |
| `duration_ms` | Nullable(UInt64) | 调用/尝试耗时 |
| `occurred_at` | DateTime64(3, UTC) | quote 的消费/确认/创建时间（依次降级）或 ai_call 创建时间 |
| `completed_at` | Nullable(DateTime64(3, UTC)) | 调用/尝试终态时间 |
| `source_updated_at` | DateTime64(3, UTC) | 所有参与基表的最大变更时间 |
| `synced_at` | DateTime64(3, UTC) | 本版本写入 ByteHouse 的时间 |
| `retention_until` | DateTime64(3, UTC) | 获批财务/审计策略算出的删除时间 |

口径红线：

- migration 014 的 `ai_calls.cost_fen` 是人民币分，不是积分。
- migration 016 的 `cost_entries` 把部分金额投影成 `charged_points`，本表不继续放大该混用；
  三个数值字段分开保存。
- `generation_requests.prompt`、报价请求快照、供应商响应、错误正文和幂等键不镜像。
- `pending_confirmation` 报价的 `charged_points`、`actual_cost_fen`、`cost_cny_micros`
  必须为空，不能用 `0` 冒充已结算。

## 6. `radar_fetch_runs`

上游：`topic_radar_upstream_calls`，并只展开关联 snapshot 的结构化日期和条目数。
调用从 `fetching` 更新到终态，因此按 ID 合并或持续重读未完成记录。

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `run_id` | String | `topic_radar_upstream_calls.id` |
| `source` | LowCardinality(String) | 雷达来源词表值 |
| `resource_scope` | String | 排名目录/榜单页的稳定 scope，防止不同资源共享水位 |
| `cache_date` | Date | Asia/Shanghai 缓存自然日 |
| `request_kind` | LowCardinality(String) | `daily` / `manual` 系统值 |
| `source_status` | LowCardinality(String) | `fetching` / `succeeded` / `failed` |
| `requested_by_subject_key` | Nullable(String) | 人工请求人的受控标识 |
| `snapshot_id` | Nullable(String) | 成功关联快照 ID |
| `rank_date` | Nullable(Date) | 快照榜单日期 |
| `started_at` | DateTime64(3, UTC) | 调用开始时间 |
| `completed_at` | Nullable(DateTime64(3, UTC)) | 调用完成时间 |
| `fetched_at` | Nullable(DateTime64(3, UTC)) | 快照抓取时间 |
| `duration_ms` | Nullable(UInt64) | 调用耗时 |
| `item_count` | Nullable(UInt32) | 成功快照条目数 |
| `error_code` | Nullable(String) | 稳定、脱敏的错误分类码 |
| `source_contract_version` | UInt32 | 供应商适配合同版本 |
| `raw_payload_sha256` | Nullable(FixedString(64)) | 原始响应校验摘要 |
| `source_updated_at` | DateTime64(3, UTC) | 调用账本最近变更时间 |
| `synced_at` | DateTime64(3, UTC) | 本版本写入 ByteHouse 的时间 |
| `retention_until` | DateTime64(3, UTC) | 运行日志保留策略算出的删除时间 |

## 7. `radar_rank_items`

上游：`topic_radar_items` + 所属 `topic_radar_snapshots`。条目没有独立时间列，
必须继承 snapshot 的 `cache_date/rank_date/fetched_at`。

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `item_id` | String | `topic_radar_items.id` |
| `snapshot_id` | String | 所属 snapshot ID |
| `source` | LowCardinality(String) | 从 snapshot 继承 |
| `resource_scope` | String | 从 snapshot 继承的稳定 scope |
| `cache_date` | Date | 从 snapshot 继承 |
| `rank_date` | Date | 从 snapshot 继承 |
| `fetched_at` | DateTime64(3, UTC) | 从 snapshot 继承 |
| `ordinal` | UInt32 | snapshot 内从 0 开始的稳定顺序，与 OLTP `items.entries()` 一致 |
| `rank_value` | Nullable(UInt32) | 供应商明确名次 |
| `title` | String | 获准用于内部研究的标题 |
| `heat_raw` | Nullable(String) | 清洗后的热度文本 |
| `heat_value` | Nullable(Float64) | 标准化热度数值 |
| `heat_parse_status` | LowCardinality(String) | 热度解析质量状态 |
| `link_url` | Nullable(String) | 去追踪参数后的公开来源 URL |
| `source_item_sha256` | FixedString(64) | 规范化源条目摘要 |
| `source_version` | UInt64 | 条目更正/删除对账版本 |
| `synced_at` | DateTime64(3, UTC) | 本版本写入 ByteHouse 的时间 |
| `retention_until` | DateTime64(3, UTC) | 条目保留策略算出的删除时间 |

`raw_payload`、`raw_item`、完整 error_message、供应商 endpoint/key 和完整追踪链接不镜像。
供应商数据当前只批准内部研究；公开展示/分发必须另行取得授权。

## 8. `asset_vec_documents`

上游：`asset_entities`、`asset_variants`、`project_asset_refs`、开放词表与
migration 017 的安全 `search_text` 口径。一行是实体文档或角色造型/阶段文档。
`stage_label` 是从 variant/source locator 派生的开放词，不伪称 OLTP 同名字段。

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `document_id` | String | canonical 对象与投影版本确定的稳定文档 ID |
| `source_object_type` | LowCardinality(String) | `asset_entity` / `asset_variant` |
| `source_object_id` | String | 来源 entity/variant ID |
| `asset_entity_id` | String | canonical 资产实体 ID |
| `asset_variant_id` | Nullable(String) | 造型/阶段 variant ID |
| `source_asset_project_id` | Nullable(String) | 导入来源项目，不是业务授权项目 |
| `authorized_project_ids` | Array(String) | 有效 project refs 的预过滤投影 |
| `asset_kind` | LowCardinality(String) | 开放资产类型词表值 |
| `asset_role` | Nullable(String) | 开放资产职责词表值 |
| `usage_mode` | Nullable(String) | 开放使用方式词表值 |
| `name` | String | 安全内部名称 |
| `display_name` | Nullable(String) | 面向人展示名 |
| `variant_kind` | Nullable(String) | 开放造型/阶段类型词 |
| `variant_label` | Nullable(String) | 造型/阶段展示名 |
| `stage_label` | Nullable(String) | 从变体或 Excel 来源派生的阶段名 |
| `summary` | String | 不编造的一句话摘要 |
| `search_text` | String | 按批准字段可复现编译的检索文本 |
| `semantic_facets_json` | String | 开放语义分面 JSON |
| `canonical_tag_ids` | Array(String) | 规范标签词条 ID |
| `tag_labels` | Array(String) | 规范标签展示值 |
| `quality_notes` | Nullable(String) | 不含个人信息的质量说明 |
| `confidence` | Nullable(Float32) | 结构化/视觉理解置信度 |
| `needs_human_review` | UInt8 | 是否需要人工复核 |
| `source_status` | LowCardinality(String) | 源资产/变体系统状态 |
| `visibility` | LowCardinality(String) | 源可见性预过滤值 |
| `search_clearance` | UInt8 | `clearance.search` 预过滤值 |
| `source_locator_json` | String | 文件/sheet/source_rows 等来源定位 |
| `source_checksum` | FixedString(64) | 参与文档编译的源字段摘要 |
| `projection_version` | UInt64 | 文档编译器版本 |
| `source_updated_at` | DateTime64(3, UTC) | 源对象最近变更时间 |
| `source_deleted_at` | Nullable(DateTime64(3, UTC)) | 源软删除时间 |
| `synced_at` | DateTime64(3, UTC) | 本版本写入 ByteHouse 的时间 |
| `retention_until` | DateTime64(3, UTC) | 源生命周期策略算出的删除时间 |

`authorized_project_ids`、`visibility` 和 `search_clearance` 只能减少候选集合，不能充当最终鉴权。
产品 Agent 必须把命中 ID 交给应用 API，由 PostgreSQL 重新检查用户、项目引用、clearance
和软删除状态。

## 9. `asset_vec_embeddings`

一行只保存一个向量，避免 POC `Array(Array(Float32))` 使媒体级血缘、独立更新与 50+
参考扩展失真。模型和维度作为数据，未来加档位不改表。不同模型/维度的向量不得直接比较。
当前 PostgreSQL 没有持久、可审计的向量 ledger，因此本轮只建空表和消费视图，不调用模型、
不伪造或现场重算向量。

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `embedding_id` | String | 文档×模态×媒体×模型×版本的稳定 ID |
| `document_id` | String | 关联检索文档 ID |
| `asset_entity_id` | String | 冗余 canonical 资产 ID |
| `asset_variant_id` | Nullable(String) | 造型/阶段 variant ID |
| `asset_media_id` | Nullable(String) | OLTP asset_media ID，文本向量为空 |
| `asset_kind` | LowCardinality(String) | 开放资产类型词表值 |
| `modality` | LowCardinality(String) | `text`、`image`、`video_segment`、`audio_segment` 等开放模态 |
| `media_kind` | Nullable(String) | 开放媒体类型词表值 |
| `reference_role` | Nullable(String) | 参考职责词表值 |
| `item_ordinal` | UInt16 | 同文档同职责内顺序，不写死 9/3/3 或 50 |
| `language_tag` | Nullable(String) | BCP47 多语言标签 |
| `timeline_segment_id` | Nullable(String) | 时间轴片段 ID |
| `segment_start_ms` | Nullable(UInt32) | 片段起始毫秒 |
| `segment_end_ms` | Nullable(UInt32) | 片段结束毫秒 |
| `tos_uri` | Nullable(String) | 无签名参数的 `tos://` 路径 |
| `media_sha256` | Nullable(FixedString(64)) | 源媒体内容摘要 |
| `embedding_model` | LowCardinality(String) | 模型/档位解析后的模型 ID |
| `embedding_dimension` | UInt16 | 本行持久源明确记录的实际维度 |
| `embedding` | Array(Float32) | 单文本/单媒体向量 |
| `embedding_source_sha256` | FixedString(64) | 实际 embedding 输入摘要 |
| `projection_version` | UInt64 | 向量投影编译器版本 |
| `computed_at` | DateTime64(3, UTC) | 向量计算完成时间 |
| `synced_at` | DateTime64(3, UTC) | 本版本写入 ByteHouse 的时间 |
| `retention_until` | DateTime64(3, UTC) | 源生命周期/模型退役策略算出的删除时间 |

约束 `length(embedding) = embedding_dimension` 保证单行维度一致。embedding 消费仍须按
`embedding_model + embedding_dimension` 分空间，且最终资产授权回应用 API 复核。

## 10. `asset_vector_index`

该表是 `asset_vec_documents` 的安全检索加速投影，不是第二资产主表。当前只在 dev 实建；
PG 分类函数、人工确认与持久向量 ledger 未完成前保持空。

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `index_id` | String | 来源身份、模型、维度和索引版本生成的稳定 ID |
| `document_id` | String | 关联 `asset_vec_documents.document_id` |
| `source_table` | LowCardinality(String) | canonical 来源，仅 `asset_entities` / `asset_variants` |
| `source_id` | String | canonical 来源 ID |
| `detail_projection_table` | LowCardinality(String) | 固定 `asset_vec_documents` |
| `detail_projection_id` | String | 固定等于 `document_id` |
| `asset_entity_id` | String | 父资产实体 ID |
| `asset_variant_id` | Nullable(String) | 变体 ID，实体行为空 |
| `owner_subject_key` | String | owner 受控主体标识，不存个人资料 |
| `source_project_id` | Nullable(String) | 来源项目，不等于当前授权范围 |
| `authorized_project_ids` | Array(String) | 有效项目引用预过滤投影 |
| `asset_kind` | LowCardinality(String) | 开放资产类型词表值 |
| `role` | Nullable(String) | 开放资产职责词表值 |
| `usage_mode` | Nullable(String) | 开放使用方式词表值 |
| `variant_kind` | Nullable(String) | 开放变体类型词表值 |
| `variant_name` | Nullable(String) | 变体安全展示名 |
| `variant_is_primary` | Nullable(UInt8) | 变体是否主造型 |
| `variant_sort_order` | Nullable(UInt32) | 变体稳定排序 |
| `visibility` | LowCardinality(String) | 来源可见性预过滤 |
| `search_clearance` | UInt8 | 搜索放行布尔投影，索引行固定 1 |
| `source_status` | LowCardinality(String) | 来源审核状态，索引行固定 approved |
| `parent_entity_status` | Nullable(String) | 变体父实体审核状态 |
| `source_sensitivity_level` | LowCardinality(String) | 所有来源中的最高敏感级，仅 S0-S2 |
| `sensitivity_level` | LowCardinality(String) | 本投影确认敏感级，仅 S0-S2 |
| `sensitivity_inheritance` | LowCardinality(String) | `source_equal` / `source_max` / 有证据降级 |
| `classification_state` | LowCardinality(String) | 本投影固定 confirmed |
| `classification_source` | LowCardinality(String) | 自动候选经人审、人工确认或纠正 |
| `classification_rule_id` | String | 稳定分类规则编号 |
| `classification_confidence` | Nullable(Float32) | 自动候选置信度 0..1 |
| `classification_reason` | String | 人工纠正/降级理由 |
| `classification_evidence` | String | 脱敏证据引用 JSON，不存敏感原文 |
| `classification_confirmed_by` | String | 确认人 actor_ref |
| `classification_confirmed_at` | DateTime64(3, UTC) | 人工确认时间 |
| `policy_version` | String | 分级与处理策略版本 |
| `review_due_at` | Nullable(DateTime64(3, UTC)) | 下次复核截止 |
| `rights_state` | LowCardinality(String) | 版权/肖像授权状态，索引行固定 cleared |
| `rights_ref` | String | 权利证明受控引用 |
| `clearance_state` | LowCardinality(String) | 搜索/复用放行状态，固定 cleared |
| `clearance_ref` | String | 放行裁决引用 |
| `review_state` | LowCardinality(String) | `human_accepted` / `human_corrected` |
| `publication_state` | LowCardinality(String) | 发布状态，固定 approved |
| `publication_ref` | String | 发布批准引用 |
| `transfer_rule` | LowCardinality(String) | 跨项目/外部传输规则 |
| `transfer_ref` | Nullable(String) | 传输规则或批准引用 |
| `retention_class` | LowCardinality(String) | 保留期类别 |
| `retention_ref` | String | 保留策略引用 |
| `title` | String | 可复现的安全检索标题 |
| `summary` | String | 可复现的安全摘要 |
| `content` | String | `inverted(2)` 全文索引安全正文 |
| `text_for_embedding` | String | 规范化安全向量输入 |
| `embedding_model` | LowCardinality(String) | 固定 `doubao-embedding-vision-251215` |
| `embedding_dimension` | UInt16 | 固定 1024 |
| `embedding` | Array(Float32) | 一资产/变体一条 1024 维向量 |
| `embedding_input_sha256` | FixedString(64) | 向量输入摘要 |
| `index_version` | UInt64 | 索引/重嵌版本 |
| `source_updated_at` | DateTime64(3, UTC) | PG 来源最近更新时间 |
| `source_revision` | UInt64 | 持久 canonical 修订序号 |
| `indexed_at` | DateTime64(3, UTC) | 文档与向量完成时间 |
| `synced_at` | DateTime64(3, UTC) | 写入 ByteHouse 时间 |
| `retention_until` | DateTime64(3, UTC) | 生命周期策略算出的删除时间 |

全文索引为 `content TYPE inverted(2) GRANULARITY 1`；向量索引为
`embedding TYPE HNSW('DIM=1024, METRIC=COSINE') GRANULARITY 1`。物理约束同时执行
S3 禁入、敏感级继承、人审、rights/clearance/publication 和固定维度门禁。

## 11. `sync_watermarks`

| 字段 | 类型 | 来源/含义 |
| --- | --- | --- |
| `domain` | LowCardinality(String) | `events` / `cost` / `radar` / `asset_vec` |
| `batch_id` | String | 当批规范化内容摘要生成的稳定 ID；重放沿用 |
| `source_cursor` | String | 不含凭据或正文的版本、摘要、源行数 JSON |
| `source_version` | UInt64 | 当批最大真实源版本 |
| `row_count` | UInt64 | 当批领域物理行数 |
| `synced_at` | DateTime64(3, UTC) | 当批完成时间 |
| `retention_until` | DateTime64(3, UTC) | dev 90 天控制记录保留截止 |

## 12. 对火山 ImageRAG POC 的承接

| POC 形态 | S55 处理 |
| --- | --- |
| `image_tos_uri` / `image_tos_uris` | 每个媒体在 `asset_vec_embeddings.tos_uri` 一行 |
| `project/key/stage/source_rows` | canonical ID 作为身份；文本与行锚点进入 document/source locator |
| `summary`、外观/风格/动作/环境/构图 | `summary` + 开放 `semantic_facets_json` |
| 三类 tag 与 `search_tags` | 规范词条 ID + 展示值，不冻结三类列 |
| `confidence`、`needs_human_review`、`quality_notes` | 原义承接到文档质量字段 |
| `Array(Array(Float32))` / 多图平均 | 拆成一媒体一向量，保留媒体级血缘 |
| 旧模型 `250615` | 不混入 `251215` 空间；S52 重嵌后再写 |
| POC 的计算组、storage policy、库名 | 不照抄；三个 environment 均使用逻辑库 `shortdrama_analytics`，连接目标由各自 endpoint 决定 |
| POC 原始 JSON | 不复制，只保留安全字段、版本和 SHA256 |

## 13. 四原则逐项核对

| 设计决定 | 数据流回路 | 词表开放 | 2.5 前瞻 | Agent-first |
| --- | --- | --- | --- | --- |
| 事件只建明细事实 | 行为→生产→反馈可重算 | 不新增创作枚举 | 新事件靠合同版本 | 常用字段显列，安全 JSON 有版本 |
| 成本统一查询面但逐笔存 | quote/call 可回查 | 钱和状态仍由 L0 合同裁决 | 能力档位作为字段 | 未计价与三种金额口径显式 |
| 雷达拆运行/条目 | 同时观察内容与获取质量 | source 新值不改表 | 新榜源只加适配器/值 | 不让 Agent 解析供应商原始 JSON |
| 文档/单向量拆表 | 内容变更触发可审计重嵌 | stage/role/tag 全是词表值 | 50+ 参考、多模态、片段、语言均可加行 | 文档、向量、媒体、模型血缘可解释 |
| 安全混合检索独立投影 | 分类/授权变化可追加重建，命中回 PG | asset kind/role/transfer/retention 仍以词表/策略扩展 | 模型或维度变化走隔离空间 | S3、待审和未授权在物理层 fail-closed |
| TTL 用 `retention_until` | 删除/退役能从源生命周期传导 | 不影响创作词表 | 期限进配置，不固化 schema | 每行都能解释何时清理 |
| ByteHouse 只预过滤 | 反馈经应用层回写 | 权限不混进创作词表 | Agent 增多不复制鉴权规则 | 命中回 canonical ID，再由 API 鉴权 |
