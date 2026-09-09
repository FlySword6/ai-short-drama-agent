CREATE TABLE IF NOT EXISTS {{database}}.`asset_vec_documents`
(
    `document_id` String COMMENT '投影文档稳定标识，不使用文件名或名称拼接',
    `source_object_type` LowCardinality(String) COMMENT 'OLTP 来源对象类型，首批为 asset_entity 或 asset_variant',
    `source_object_id` String COMMENT 'OLTP 来源对象标识',
    `asset_entity_id` String COMMENT '资产实体 canonical 标识',
    `asset_variant_id` Nullable(String) COMMENT '角色造型或阶段变体标识，实体级文档为空',
    `source_asset_project_id` Nullable(String) COMMENT '资产导入来源项目标识，不等同于业务项目授权范围',
    `authorized_project_ids` Array(String) COMMENT '有效 project_asset_refs 的预过滤投影，最终授权仍由应用层复核',
    `asset_kind` LowCardinality(String) COMMENT '资产类型词表值，新增创作类型只插词条不改 schema',
    `asset_role` Nullable(String) COMMENT '资产职责词表值',
    `usage_mode` Nullable(String) COMMENT '资产使用方式词表值',
    `name` String COMMENT '资产内部名称的安全检索投影',
    `display_name` Nullable(String) COMMENT '面向人的展示名称',
    `variant_kind` Nullable(String) COMMENT '造型或阶段类型词表值',
    `variant_label` Nullable(String) COMMENT '造型或阶段展示名',
    `stage_label` Nullable(String) COMMENT '由变体和来源资料派生的开放阶段词，非 OLTP 同名真源列',
    `summary` String COMMENT '面向检索的一句话摘要，不得编造源资料未给出的事实',
    `search_text` String COMMENT '按批准字段可复现编译的检索文本，不含 URL、ID、提示词或供应商载荷',
    `semantic_facets_json` String COMMENT '开放语义分面 JSON，承接外观、风格、动作、环境、构图等可扩展词表',
    `canonical_tag_ids` Array(String) COMMENT '规范标签词条标识数组',
    `tag_labels` Array(String) COMMENT '规范标签展示值数组，别名归一由 OLTP 词表完成',
    `quality_notes` Nullable(String) COMMENT '不含个人信息的资产质量说明',
    `confidence` Nullable(Float32) COMMENT '结构化或视觉理解置信度，未评估时为空',
    `needs_human_review` UInt8 COMMENT '投影需要人工复核标志',
    `source_status` LowCardinality(String) COMMENT '源资产或变体状态系统值',
    `visibility` LowCardinality(String) COMMENT '源可见性投影，仅用于预过滤而非最终鉴权',
    `search_clearance` UInt8 COMMENT '源 clearance.search 的布尔投影，最终仍由应用层复核',
    `source_locator_json` String COMMENT '来源文件、sheet 与 source_rows 等可审计定位信息，不存签名 URL',
    `source_checksum` FixedString(64) COMMENT '参与投影的规范化源字段 SHA256',
    `projection_version` UInt64 COMMENT '检索文档编译器版本',
    `source_updated_at` DateTime64(3, 'UTC') COMMENT '源对象最近变更时间',
    `source_deleted_at` Nullable(DateTime64(3, 'UTC')) COMMENT '源对象软删除时间，未删除时为空',
    `synced_at` DateTime64(3, 'UTC') COMMENT '本投影版本写入 ByteHouse 的时间',
    `retention_until` DateTime64(3, 'UTC') COMMENT '由源生命周期和环境配置计算的删除时间',
    CONSTRAINT `asset_document_id_nonempty` CHECK length(document_id) > 0,
    CONSTRAINT `asset_review_flag_valid` CHECK needs_human_review IN (0, 1),
    CONSTRAINT `asset_search_clearance_valid` CHECK search_clearance IN (0, 1)
)
ENGINE = CnchMergeTree()
ORDER BY (asset_kind, asset_entity_id, document_id, projection_version)
PARTITION BY toYYYYMM(synced_at)
PRIMARY KEY (asset_kind, asset_entity_id, document_id, projection_version)
TTL toDateTime(retention_until) DELETE
SETTINGS index_granularity = 8192
COMMENT = '资产实体与角色造型阶段的可检索文档投影；PostgreSQL 仍是身份、关系和权限真源';

CREATE TABLE IF NOT EXISTS {{database}}.`asset_vec_embeddings`
(
    `embedding_id` String COMMENT '文档、模态、媒体、模型和投影版本共同确定的稳定标识',
    `document_id` String COMMENT '关联 asset_vec_documents.document_id',
    `asset_entity_id` String COMMENT '冗余资产实体标识，用于无 join 的安全预过滤',
    `asset_variant_id` Nullable(String) COMMENT '关联角色造型或阶段变体标识',
    `asset_media_id` Nullable(String) COMMENT '关联 OLTP asset_media.id，纯文本向量可为空',
    `asset_kind` LowCardinality(String) COMMENT '资产类型词表值',
    `modality` LowCardinality(String) COMMENT '向量输入模态词表值，例如 text、image、video_segment 或 audio_segment',
    `media_kind` Nullable(String) COMMENT '媒体类型词表值',
    `reference_role` Nullable(String) COMMENT '参考条目职责词表值，不冻结 first_frame 等创作值',
    `item_ordinal` UInt16 COMMENT '同文档同职责内的顺序，类型容量不把参考数量锁死在当前上限',
    `language_tag` Nullable(String) COMMENT '多语言声音或文本的 BCP47 语言标签',
    `timeline_segment_id` Nullable(String) COMMENT '时间轴片段标识，当前无来源时为空',
    `segment_start_ms` Nullable(UInt32) COMMENT '音视频片段起始毫秒，整媒体向量为空',
    `segment_end_ms` Nullable(UInt32) COMMENT '音视频片段结束毫秒，整媒体向量为空',
    `tos_uri` Nullable(String) COMMENT '平台自有 TOS 对象路径，不含 AK、SK 或签名查询参数',
    `media_sha256` Nullable(FixedString(64)) COMMENT '源媒体内容 SHA256，纯文本向量为空',
    `embedding_model` LowCardinality(String) COMMENT '实际生成该向量的模型标识，必须来自持久向量账本',
    `embedding_dimension` UInt16 COMMENT '本行实际向量维度，不在 DDL 中猜测或固定供应商维度',
    `embedding` Array(Float32) COMMENT '单媒体或单文本向量；每个媒体一行，不使用多向量嵌套数组',
    `embedding_source_sha256` FixedString(64) COMMENT '实际送入 embedding 的规范化输入 SHA256',
    `projection_version` UInt64 COMMENT '向量投影编译器版本',
    `computed_at` DateTime64(3, 'UTC') COMMENT '向量计算完成时间',
    `synced_at` DateTime64(3, 'UTC') COMMENT '本向量版本写入 ByteHouse 的时间',
    `retention_until` DateTime64(3, 'UTC') COMMENT '由源生命周期、模型退役和环境配置计算的删除时间',
    CONSTRAINT `asset_embedding_id_nonempty` CHECK length(embedding_id) > 0,
    CONSTRAINT `asset_embedding_dimension_matches` CHECK (embedding_dimension > 0) AND (length(embedding) = embedding_dimension),
    CONSTRAINT `asset_segment_range_valid` CHECK isNull(segment_end_ms) OR isNull(segment_start_ms) OR (segment_end_ms >= segment_start_ms)
)
ENGINE = CnchMergeTree()
ORDER BY (embedding_model, modality, asset_kind, document_id, item_ordinal, embedding_id, projection_version)
PARTITION BY toYYYYMM(computed_at)
PRIMARY KEY (embedding_model, modality, asset_kind, document_id, item_ordinal, embedding_id, projection_version)
TTL toDateTime(retention_until) DELETE
SETTINGS index_granularity = 8192
COMMENT = '资产单媒体多模态向量投影；当前统一 doubao-embedding-vision-251215，查询必须隔离模型与维度';
