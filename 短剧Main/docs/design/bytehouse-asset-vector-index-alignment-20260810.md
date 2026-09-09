# ByteHouse 资产混合检索对齐包（S55 / #77 实建版）

状态：2026-08-10 dev 已实建并 readonly 读回。旧
`bytehouse-asset-vector-index-alignment-20260727.md` 仅保留 R51 历史决策轨迹。

## 结论

1. 统一详情投影仍是 `asset_vec_documents`；统一混合检索投影是
   `asset_vector_index`。不按角色、道具、场景拆第二套资产主表。
2. canonical 身份只允许 `asset_entities` / `asset_variants`。媒体在命中后由应用 API
   鉴权组装，不单独成为索引行。
3. 新表由 `007_asset_vector_index.sql` 创建，同时创建
   `v_asset_vector_index_latest`。既有 `005_asset_vec.sql` 与旧表不改。
4. 模型固定 `doubao-embedding-vision-251215`，维度固定 1024；换模型或维度必须隔离空间，
   不能在同一 HNSW 表混写。
5. CDW 全文索引使用官方 `inverted(2)`；历史草案的企业版
   `inverted('standard', '{"version":"v2"}')` 不适用于本目标。
6. #77 的 sensitivity、rights、clearance、review、publication、transfer、retention
   彼此正交；S3 和未确认分类在物理约束层拒绝进入检索表。

## 数据流

```text
PostgreSQL AssetEntity / AssetVariant / project refs
  + 分类候选与人工确认
  + rights / clearance / publication / transfer / retention 裁决
  + 持久 1024 维向量 ledger
    -> asset_vec_documents（安全详情）
    -> asset_vector_index（仅已确认、已放行、S0-S2）
    -> v_asset_vector_index_latest
    -> 应用 API 回 PostgreSQL 复核当前用户、项目、撤销和软删除
```

ByteHouse 不回写业务状态。命中只是候选，不是授权结果。

## 物理形态

```text
ENGINE       CnchMergeTree
PARTITION BY toYYYYMM(indexed_at)
ORDER BY     visibility, sensitivity_level, asset_kind, model/dimension,
             canonical source, source_revision, index_version, index_id
TTL          toDateTime(retention_until) DELETE
SETTINGS     index_granularity=128, index_granularity_bytes=0
FULL TEXT    content TYPE inverted(2) GRANULARITY 1
VECTOR       embedding TYPE HNSW('DIM=1024, METRIC=COSINE') GRANULARITY 1
```

服务端真实 `SHOW CREATE` 将未显式指定的 HNSW granularity 规范化为 1，因此 migration
显式记录该值。服务端另补计算组和 storage policy 设置；它们是供应商拥有的环境参数，不写进
可移植 DDL。

## 安全不变量

- 来源、父资产、人工审核、rights、clearance、publication 任一未放行即不能插入。
- S3、未知、自动候选和 pending review 均不能进入普通分析/全文/向量表。
- 派生敏感级不得降低；有审计依据的降级必须带 reason/evidence。
- 内容列只允许可复现的安全文本；证据列只存脱敏引用。
- 项目数组与 visibility 仅作预过滤，最终权限回应用 API。
- ByteHouse TTL 不是即时撤销机制。

## 仍未完成的行为链

本次授权只覆盖建模与建表，没有修改数据。当前 PG 上传链仍需后续补：

1. #77 分类函数与人工确认真源；
2. 密钥拒绝、未知数据待审、S3 隔离、派生继承的行为测试；
3. 持久 1024 维向量 ledger 与安全同步器；
4. 两个真实样例的受控写入、readonly 读回和幂等验证。

在这些前置完成前，新表保持空是正确的 fail-closed 状态。
