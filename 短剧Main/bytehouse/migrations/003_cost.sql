CREATE TABLE IF NOT EXISTS {{database}}.`cost_ledger_fact`
(
    `entry_key` String COMMENT 'source_table 与 source_id 组合后的全局稳定账务键',
    `entry_kind` LowCardinality(String) COMMENT '逐笔事实种类，首批为 generation_quote 或 ai_call',
    `source_table` LowCardinality(String) COMMENT 'OLTP 真源表名，首批为 generation_quotes 或 ai_calls',
    `source_id` String COMMENT 'OLTP 真源记录标识',
    `source_version` UInt64 COMMENT '同步层单调版本，源记录更新时递增且不覆盖历史证据',
    `user_subject_key` String COMMENT '费用责任用户的受控标识，不镜像可识别资料',
    `project_id` Nullable(String) COMMENT '归属项目标识；ai_call 没有项目时保持空值',
    `generation_request_id` Nullable(String) COMMENT '关联生成请求标识，ai_call 或非生成报价可为空',
    `generation_attempt_id` Nullable(String) COMMENT '关联生成尝试标识，无法归属时为空',
    `pricing_rule_id` Nullable(String) COMMENT '报价采用的价格规则标识，未经过报价链时为空',
    `capability_tier_key` Nullable(String) COMMENT '能力档位键；模型扩展通过加档位而不是改表',
    `provider` LowCardinality(String) COMMENT '供应商适配层标识',
    `model` LowCardinality(String) COMMENT '供应商模型标识，必须与能力档位映射一同解释',
    `purpose` String COMMENT 'AI 调用用途合同值，不存提示词或消息正文',
    `media_kind` Nullable(String) COMMENT '生成媒体类型词表值',
    `source_status` LowCardinality(String) COMMENT '源报价、调用或任务的系统状态',
    `estimated_cost_fen` Nullable(Int64) COMMENT '报价记录的预估人民币分，未消费时不能解释为已发生支出',
    `actual_cost_fen` Nullable(Int64) COMMENT '供应商或 ai_call 明确报告的实际人民币分，未知时为空',
    `cost_cny_micros` Nullable(Int64) COMMENT '供应商成本人民币微元精度，未知时为空，不从积分反推',
    `cost_calculation_status` Nullable(String) COMMENT 'provider_costs 的正式计算状态，AI 调用行可为空',
    `charged_points` Nullable(Int64) COMMENT 'OLTP 明确记账的积分值；不得由人民币分自行换算',
    `currency` LowCardinality(String) COMMENT '金额币种，人民币分使用 CNY',
    `is_unpriced` UInt8 COMMENT '实际成本未知标志，未知时不得用零冒充已计价',
    `input_tokens` Nullable(UInt64) COMMENT '输入 token 数，供应商未报告时为空',
    `output_tokens` Nullable(UInt64) COMMENT '输出 token 数，供应商未报告时为空',
    `duration_ms` Nullable(UInt64) COMMENT '调用或尝试耗时毫秒',
    `occurred_at` DateTime64(3, 'UTC') COMMENT '报价消费或 AI 调用发生时间',
    `completed_at` Nullable(DateTime64(3, 'UTC')) COMMENT '调用或任务完成时间，未完成时为空',
    `source_updated_at` DateTime64(3, 'UTC') COMMENT '参与事实计算的基表最近变更时间',
    `synced_at` DateTime64(3, 'UTC') COMMENT '本版本写入 ByteHouse 的时间',
    `retention_until` DateTime64(3, 'UTC') COMMENT '由财务与审计保留配置计算的删除时间',
    CONSTRAINT `cost_entry_key_nonempty` CHECK length(entry_key) > 0,
    CONSTRAINT `cost_unpriced_flag_valid` CHECK is_unpriced IN (0, 1)
)
ENGINE = CnchMergeTree()
ORDER BY (occurred_at, entry_kind, entry_key, source_version)
PARTITION BY toYYYYMM(occurred_at)
PRIMARY KEY (occurred_at, entry_kind, entry_key, source_version)
TTL toDateTime(retention_until) DELETE
SETTINGS index_granularity = 8192
COMMENT = '逐笔成本与积分分析事实表；保留 consumed quote 和 ai_call 粒度，不复制聚合视图';
