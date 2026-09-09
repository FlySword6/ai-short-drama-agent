CREATE TABLE IF NOT EXISTS {{database}}.`radar_fetch_runs`
(
    `run_id` String COMMENT 'OLTP topic_radar_upstream_calls.id 的稳定标识',
    `source` LowCardinality(String) COMMENT '雷达数据源词表值，新增供应商不改 schema',
    `resource_scope` String COMMENT '榜单目录、历史热榜或具体榜单页的独立资源范围',
    `cache_date` Date COMMENT 'Asia/Shanghai 口径的缓存自然日',
    `request_kind` LowCardinality(String) COMMENT '请求种类系统值，首批为 daily 或 manual',
    `source_status` LowCardinality(String) COMMENT '上游调用状态系统值',
    `requested_by_subject_key` Nullable(String) COMMENT '人工触发人的受控标识，定时任务为空',
    `snapshot_id` Nullable(String) COMMENT '成功调用生成的快照标识',
    `rank_date` Nullable(Date) COMMENT '榜单业务日期，供应商未返回时为空',
    `started_at` DateTime64(3, 'UTC') COMMENT '上游调用开始时间',
    `completed_at` Nullable(DateTime64(3, 'UTC')) COMMENT '上游调用完成时间',
    `fetched_at` Nullable(DateTime64(3, 'UTC')) COMMENT '成功快照的抓取时间',
    `duration_ms` Nullable(UInt64) COMMENT '上游调用耗时毫秒',
    `item_count` Nullable(UInt32) COMMENT '成功快照包含的条目数量',
    `error_code` Nullable(String) COMMENT '已脱敏且稳定的错误分类码，不存原始错误消息',
    `source_contract_version` UInt32 COMMENT '供应商适配合同版本',
    `source_version` UInt64 COMMENT '由调用终态时间与稳定主键确定的可重放版本',
    `raw_payload_sha256` Nullable(FixedString(64)) COMMENT '原始响应校验摘要，仅用于血缘核对，不复制响应正文',
    `source_updated_at` DateTime64(3, 'UTC') COMMENT '调用账本最近变更时间',
    `synced_at` DateTime64(3, 'UTC') COMMENT '本版本写入 ByteHouse 的时间',
    `retention_until` DateTime64(3, 'UTC') COMMENT '由雷达运行日志保留配置计算的删除时间',
    CONSTRAINT `radar_run_id_nonempty` CHECK length(run_id) > 0
)
ENGINE = CnchMergeTree()
ORDER BY (source, resource_scope, cache_date, request_kind, run_id, source_version)
PARTITION BY toYYYYMM(cache_date)
PRIMARY KEY (source, resource_scope, cache_date, request_kind, run_id, source_version)
TTL toDateTime(retention_until) DELETE
SETTINGS index_granularity = 8192
COMMENT = '选题雷达上游调用与快照运行事实表；不复制供应商原始载荷和错误正文';

CREATE TABLE IF NOT EXISTS {{database}}.`radar_rank_items`
(
    `item_id` String COMMENT 'OLTP topic_radar_items.id 的稳定标识',
    `snapshot_id` String COMMENT '所属 topic_radar_snapshots.id',
    `source` LowCardinality(String) COMMENT '从快照继承的数据源词表值',
    `resource_scope` String COMMENT '从快照继承的榜单资源范围，禁止跨范围混排',
    `cache_date` Date COMMENT '从快照继承的 Asia/Shanghai 缓存自然日',
    `rank_date` Date COMMENT '从快照继承的榜单业务日期',
    `fetched_at` DateTime64(3, 'UTC') COMMENT '从快照继承的抓取时间',
    `ordinal` UInt32 COMMENT '条目在快照中的稳定顺序，从零开始',
    `rank_value` Nullable(UInt32) COMMENT '供应商明确给出的名次，无法解析时为空',
    `title` String COMMENT '经供应商合同允许用于内部研究的条目标题',
    `heat_raw` Nullable(String) COMMENT '经清洗的热度原文，不含供应商原始对象',
    `heat_value` Nullable(Float64) COMMENT '可比较的标准化热度值',
    `heat_parse_status` LowCardinality(String) COMMENT '热度解析质量状态',
    `link_url` Nullable(String) COMMENT '去除追踪参数后的公开来源链接，无分析用途时为空',
    `source_item_sha256` FixedString(64) COMMENT '源条目规范化后的校验摘要',
    `source_version` UInt64 COMMENT '同步层单调版本，用于处理更正与删除对账',
    `synced_at` DateTime64(3, 'UTC') COMMENT '本版本写入 ByteHouse 的时间',
    `retention_until` DateTime64(3, 'UTC') COMMENT '由雷达条目保留配置计算的删除时间',
    CONSTRAINT `radar_item_id_nonempty` CHECK length(item_id) > 0,
    CONSTRAINT `radar_item_ordinal_nonnegative` CHECK ordinal >= 0
)
ENGINE = CnchMergeTree()
ORDER BY (source, resource_scope, rank_date, ordinal, item_id, source_version)
PARTITION BY toYYYYMM(rank_date)
PRIMARY KEY (source, resource_scope, rank_date, ordinal, item_id, source_version)
TTL toDateTime(retention_until) DELETE
SETTINGS index_granularity = 8192
COMMENT = '选题雷达榜单条目事实表；快照日期显式展开以便趋势查询';
