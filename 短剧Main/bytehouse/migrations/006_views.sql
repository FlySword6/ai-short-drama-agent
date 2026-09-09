CREATE TABLE IF NOT EXISTS {{database}}.`sync_watermarks`
(
    `domain` LowCardinality(String) COMMENT 'events、cost、radar、asset_vec 四域之一',
    `batch_id` String COMMENT '一次同步批次的稳定标识，重放沿用同一值',
    `source_cursor` String COMMENT '不含凭据和内容正文的增量游标 JSON',
    `source_version` UInt64 COMMENT '由源事实确定的单调版本，不使用进程内计数',
    `row_count` UInt64 COMMENT '该批次写入的物理行数',
    `synced_at` DateTime64(3, 'UTC') COMMENT '批次完成 UTC 时间',
    `retention_until` DateTime64(3, 'UTC') COMMENT 'dev 控制面记录保留截止时间',
    CONSTRAINT `sync_watermark_domain_valid` CHECK domain IN ('events', 'cost', 'radar', 'asset_vec'),
    CONSTRAINT `sync_watermark_batch_nonempty` CHECK length(batch_id) > 0
)
ENGINE = CnchMergeTree()
ORDER BY (domain, source_version, batch_id)
PARTITION BY toYYYYMM(synced_at)
PRIMARY KEY (domain, source_version, batch_id)
TTL toDateTime(retention_until) DELETE
SETTINGS index_granularity = 8192
COMMENT = 'ByteHouse 批同步水位；每域查询最新版本，源事实仍在 PostgreSQL';

CREATE VIEW IF NOT EXISTS {{database}}.`v_events_product_latest` AS
SELECT *
FROM {{database}}.`events_product_fact`
ORDER BY source_version DESC, synced_at DESC
LIMIT 1 BY event_id;

CREATE VIEW IF NOT EXISTS {{database}}.`v_events_funnel_base` AS
SELECT event_id, event_name, event_contract_version, user_subject_key, project_id,
       request_id, quote_id, asset_entity_id, media_kind, result_status,
       search_mode, result_count, occurred_at, received_at, source_updated_at
FROM {{database}}.`v_events_product_latest`;

CREATE VIEW IF NOT EXISTS {{database}}.`v_cost_ledger_latest` AS
SELECT *
FROM {{database}}.`cost_ledger_fact`
ORDER BY source_version DESC, synced_at DESC
LIMIT 1 BY entry_key;

CREATE VIEW IF NOT EXISTS {{database}}.`v_cost_daily` AS
SELECT toDate(occurred_at) AS cost_date, provider, model, currency,
       sumIf(estimated_cost_fen, estimated_cost_fen IS NOT NULL) AS estimated_cost_fen,
       sumIf(actual_cost_fen, actual_cost_fen IS NOT NULL) AS actual_cost_fen,
       sumIf(cost_cny_micros, cost_cny_micros IS NOT NULL) AS cost_cny_micros,
       sumIf(charged_points, charged_points IS NOT NULL) AS charged_points,
       count() AS entry_count
FROM {{database}}.`v_cost_ledger_latest`
GROUP BY cost_date, provider, model, currency;

CREATE VIEW IF NOT EXISTS {{database}}.`v_radar_fetch_runs_latest` AS
SELECT *
FROM {{database}}.`radar_fetch_runs`
ORDER BY source_version DESC, synced_at DESC
LIMIT 1 BY run_id;

CREATE VIEW IF NOT EXISTS {{database}}.`v_radar_rank_items_latest` AS
SELECT *
FROM {{database}}.`radar_rank_items`
ORDER BY source_version DESC, synced_at DESC
LIMIT 1 BY item_id;

CREATE VIEW IF NOT EXISTS {{database}}.`v_asset_vec_documents_latest` AS
SELECT *
FROM {{database}}.`asset_vec_documents`
ORDER BY projection_version DESC, synced_at DESC
LIMIT 1 BY document_id;

CREATE VIEW IF NOT EXISTS {{database}}.`v_asset_vec_embeddings_latest` AS
SELECT *
FROM {{database}}.`asset_vec_embeddings`
ORDER BY projection_version DESC, synced_at DESC
LIMIT 1 BY embedding_id;

CREATE VIEW IF NOT EXISTS {{database}}.`v_sync_watermarks_latest` AS
SELECT *
FROM {{database}}.`sync_watermarks`
ORDER BY source_version DESC, synced_at DESC
LIMIT 1 BY domain;
