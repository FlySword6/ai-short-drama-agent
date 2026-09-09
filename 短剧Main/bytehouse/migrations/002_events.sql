CREATE TABLE IF NOT EXISTS {{database}}.`events_product_fact`
(
    `event_id` String COMMENT 'OLTP events.id 的稳定标识，不使用名称或时间拼接',
    `event_name` LowCardinality(String) COMMENT '事件合同名，允许新增事件值但不得绕过事件目录校验',
    `event_contract_version` UInt32 COMMENT '事件字段合同版本，用于兼容后续属性演进',
    `source_version` UInt64 COMMENT '由 received_at 与稳定主键确定的可重放版本，不使用进程内计数',
    `user_subject_key` String COMMENT '用户标识的受控投影，不写用户名、手机号或邮箱',
    `project_id` Nullable(String) COMMENT '从白名单属性解析的业务项目标识，缺失时为空',
    `request_id` Nullable(String) COMMENT '从白名单属性解析的生成请求标识，缺失时为空',
    `quote_id` Nullable(String) COMMENT '从白名单属性解析的报价标识，缺失时为空',
    `asset_entity_id` Nullable(String) COMMENT '从白名单属性解析的资产实体标识，缺失时为空',
    `media_kind` Nullable(String) COMMENT '媒体类型词表值，不以数据库枚举冻结创作语汇',
    `result_status` Nullable(String) COMMENT '结果状态投影，仅承接已批准的系统状态值',
    `search_mode` Nullable(String) COMMENT '检索方式投影，新增方式通过事件合同扩展',
    `result_count` Nullable(UInt32) COMMENT '事件报告的结果数量，不存在时为空',
    `safe_props_json` String COMMENT '按事件白名单保留并去标识后的属性 JSON，禁止提示词、文件名和正文',
    `props_redacted` UInt8 COMMENT '属性已完成白名单和去标识处理的标志，必须为一',
    `occurred_at` DateTime64(3, 'UTC') COMMENT '客户端报告的业务发生时间，用于业务趋势分区',
    `received_at` DateTime64(3, 'UTC') COMMENT '服务端接收时间，用作微批同步水位',
    `source_updated_at` DateTime64(3, 'UTC') COMMENT '源记录最近可观察变更时间，删除对账由同步任务补 tombstone',
    `synced_at` DateTime64(3, 'UTC') COMMENT '本行写入 ByteHouse 的时间',
    `retention_until` DateTime64(3, 'UTC') COMMENT '由环境数据保留配置计算的删除时间，期限不硬编码在 schema',
    CONSTRAINT `events_event_id_nonempty` CHECK length(event_id) > 0,
    CONSTRAINT `events_props_must_be_redacted` CHECK props_redacted = 1
)
ENGINE = CnchMergeTree()
ORDER BY (event_name, occurred_at, event_id, source_version)
PARTITION BY toYYYYMM(occurred_at)
PRIMARY KEY (event_name, occurred_at, event_id, source_version)
TTL toDateTime(retention_until) DELETE
SETTINGS index_granularity = 8192
COMMENT = '产品行为与生产反馈事件事实表；只接受 OLTP events 的去标识白名单投影';
