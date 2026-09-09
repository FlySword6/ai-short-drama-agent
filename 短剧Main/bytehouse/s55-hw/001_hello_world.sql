-- S55-HW 2026-08-03 approved dev-only Hello World.
-- Runtime scope is additionally enforced by scripts/bytehouse-provision.mts.

CREATE DATABASE IF NOT EXISTS shortdrama_analytics ENGINE = Cnch;

CREATE TABLE IF NOT EXISTS shortdrama_analytics.s55_hello_world
(
    hello_key String COMMENT 'S55-HW 稳定幂等键',
    owner_project String COMMENT '数据归属项目',
    created_at DateTime64(3, 'UTC') COMMENT '首次写入 UTC 时间'
)
ENGINE = CnchMergeTree()
ORDER BY (hello_key)
PRIMARY KEY (hello_key)
COMMENT = 'S55-HW dev 最小真实链路表';

-- The executor writes the stable key s55-hw-v1 with INSERT ... SELECT ...
-- WHERE NOT EXISTS, reads it through the readonly account, then repeats the
-- same insert and requires the second readonly result to equal the first one.
-- This proves sequential controlled replay, not concurrent upsert semantics.
