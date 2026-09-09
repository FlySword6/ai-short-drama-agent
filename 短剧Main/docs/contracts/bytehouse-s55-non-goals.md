# S55 ByteHouse：明确不做项

状态：2026-08-10。S55 建模建表只获 dev 新对象 DDL 授权；数据、权限与部署仍关闭。

1. **不改 OLTP**：不修改 PostgreSQL 的表、迁移、状态机、积分账本、权限或业务数据。
2. **不改资产真源**：不修改 `asset_entities`、`asset_variants`、`asset_media` 或项目引用语义；
   不把 Excel 表头反向变成 OLTP schema。
3. **不动 `shortdrama_entity`**：它只保留现有 dev 资产实体域用途；不改名、不迁移、不删除、不
   复制至 test/prod，也不在其中创建或复制 S55 四域表。
4. **不伪造向量**：没有持久 PostgreSQL 向量 ledger 时，不读取 TOS 媒体、不调用 embedding、
   不向 `asset_vec_embeddings` 写数据；空表和空消费视图是诚实状态。
5. **不碰 Milvus**：不创建 collection、不迁移、删除数据或切检索流量。
6. **不越过 dev 授权**：本轮只允许 `shortdrama_analytics` 的七领域表、一控制表、十视图；
   不写数据、不 DROP/ALTER、不改既有 `s55_hello_world`。
7. **不做跨环境复制**：同名逻辑数据库 `shortdrama_analytics` 由 environment endpoint 选择；
   S55 先 dev，不把 dev 数据或 `shortdrama_entity` 复制到 test/prod。
8. **不生产化调度**：实现可重放 dev 批同步，但不部署 cron/CDC/队列，不承诺 SLA。
9. **不让产品 Agent 直连**：在线查询仍须经应用 API 的项目、资产与审核鉴权；不创建或分发宽权限
   账号、host、连接串或 secret。
10. **不部署**：本单按 goal 创建交付 PR；不部署、不切生产流量、不触发付费模型调用。
11. **不代办 S45 资源修复**：不恢复已废止的实例、ClusterID、环境后缀库或跨环境 readonly
    模型；账号、KMS、打标和 endpoint 交接只承接 Fable 最新租户/environment 裁决。

本地 DDL、文档或测试通过不是远端建成或可用证明。任一审批、allowlist、权限或 strict verify
缺失时，正确状态是“未执行”，不是“已完成”。
