# S55 ByteHouse 建模建表 dev 验证

日期：2026-08-10

环境：ByteHouse 华北 2（北京）开发环境

数据库：`shortdrama_analytics`
结论：新增 1 张表和 1 个视图，控制台 DDL 成功，readonly 真实读回成功。

本文件不含 endpoint、账号、API token、密码、KMS 值、供应商响应正文或个人数据。

## 1. 写前真实盘点

| 对象 | 引擎 | 行数 | 本单处理 |
| --- | --- | ---: | --- |
| `events_product_fact` | CnchMergeTree | 44 | 已存在未动 |
| `cost_ledger_fact` | CnchMergeTree | 48 | 已存在未动 |
| `radar_fetch_runs` | CnchMergeTree | 4 | 已存在未动 |
| `radar_rank_items` | CnchMergeTree | 0 | 已存在未动 |
| `asset_vec_documents` | CnchMergeTree | 6 | 已存在未动；SHOW CREATE 无索引 |
| `asset_vec_embeddings` | CnchMergeTree | 0 | 已存在未动；SHOW CREATE 无索引 |
| `sync_watermarks` | CnchMergeTree | 8 | 已存在未动 |
| `s55_hello_world` | CnchMergeTree | 1 | 范围外未动 |

另有 9 个原有消费视图，均未修改。

## 2. 真实 DDL 执行

通过已登录子账号的 ByteHouse SQL 工作台执行：

1. `CREATE TABLE IF NOT EXISTS shortdrama_analytics.asset_vector_index ...`
   → 控制台“SQL 执行成功”；
2. `CREATE VIEW IF NOT EXISTS shortdrama_analytics.v_asset_vector_index_latest ...`
   → 控制台“SQL 执行成功”。

执行前页面事实：华北 2（北京）、开发环境、目标库
`shortdrama_analytics`、既有计算组。没有改变数据库用户、grant、网络或计算组配置。

## 3. readonly 读回

受控私网路径使用既有 KMS readonly 身份，每次查询只在远端临时目录使用 mode 600 的短生命周期
凭据文件，结束时覆写清理。

### 3.1 新表

- `DESCRIBE TABLE ... FORMAT JSON`：60 列，列名、类型和中文注释齐全；
- `SHOW CREATE TABLE ... FORMAT JSON`：引擎、分区、主键、排序键、TTL、设置、2 个索引和
  18 个 CHECK 约束均回显；
- `SELECT count()`：0。

关键回显：

```text
ENGINE = CnchMergeTree
PARTITION BY toYYYYMM(indexed_at)
PRIMARY KEY / ORDER BY =
  visibility, sensitivity_level, asset_kind, embedding_model,
  embedding_dimension, source_table, source_id, source_revision,
  index_version, index_id
TTL toDateTime(retention_until)
INDEX asset_vector_content_inverted content TYPE inverted(2) GRANULARITY 1
INDEX asset_vector_embedding_hnsw embedding
  TYPE HNSW('DIM=1024, METRIC=COSINE') GRANULARITY 1
SETTINGS index_granularity=128, index_granularity_bytes=0
```

安全约束读回包含：

- 来源只允许 `asset_entities` / `asset_variants`；
- 来源与父实体必须 approved，search clearance 必须放行；
- 来源和派生敏感级只允许 S0/S1/S2；
- 分类必须 confirmed，审核必须 human accepted/corrected；
- rights、clearance、publication 必须放行；
- 降级必须带 reason/evidence；
- 模型固定且向量长度必须为 1024。

### 3.2 新视图

- `SHOW CREATE TABLE ... FORMAT JSON`：60 列，并回显：

```text
FROM shortdrama_analytics.asset_vector_index
ORDER BY source_revision DESC, index_version DESC, synced_at DESC
LIMIT 1 BY source_table, source_id
```

- `SELECT count()`：0。

## 4. 边界与未验证项

- 本单 DML 为 0；没有样例写入、历史回填或数据修订。
- app 数据库用户的稳态 grant 仍为 SELECT/INSERT，无 CREATE/ALTER；建表使用现有 IAM 控制台
  授权，没有扩权或重置密码。
- 当前 PG 上传链没有 #77 全字段、分类函数、人工确认和持久向量 ledger，因此新表保持空。
- 没有真实向量，故本回执证明 HNSW DDL 已被目标引擎接受，不声称向量召回质量或 ANN 查询
  已验。
- test/prod 无动作。

## 5. 版本库证据

- DDL：`bytehouse/migrations/007_asset_vector_index.sql`
- 完整建表规范：`docs/contracts/bytehouse-s55-table-build-spec.md`
- 字段字典：`docs/contracts/bytehouse-field-dictionary.md`
- 血缘登记：`docs/contracts/bytehouse-table-registry.md`
