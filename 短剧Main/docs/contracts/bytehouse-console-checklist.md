# ByteHouse dev 控制台与执行清单

状态：S55 主卡 v2，2026-08-10。基础域对象已建；资产混合检索对象已由 IAM 控制台实建。

## 1. 环境与资源

- [ ] 当前 environment 明确为 dev；
- [ ] 数据库为 `shortdrama_analytics`，不带环境后缀；
- [ ] `shortdrama_entity` 未修改；
- [ ] `s55_hello_world` 保留为兼容通路证明；
- [ ] 计算组沿用 `shortdrama_dev_wh`，不新建常驻计算；
- [ ] 公网解析/公网域名保持关闭；
- [ ] 网络组只保留已批准 dev CLI ECS 的单 `/32` allowlist；
- [ ] test/prod 无任何写操作。

## 2. 账号与 secret

- [ ] app 与 readonly 是两个独立数据库用户；
- [ ] app secret 真源为 KMS `shortdrama/dev/bytehouse`；
- [ ] readonly secret 真源为 KMS `shortdrama/dev/bytehouse-readonly`；
- [ ] 两套账号均通过完整租户用户名认证；
- [ ] app 稳态 `SHOW GRANTS` 只含目标库 `INSERT`、`SELECT`、`SHOW`；
- [ ] readonly 的 `SHOW GRANTS` 只含目标库 `SELECT`、`SHOW`；
- [ ] 无 `*.*`、ALTER、ALL、admin role、grant option 或目标库外授权；
- [ ] 凭据值、endpoint、SQL 响应正文未进入文件、git、聊天、截图或回执。

## 3. DDL apply

基础域执行器：

```text
scripts/bytehouse-provision.mts --apply --environment dev
  --confirm APPLY_BYTEHOUSE_S55_DOMAINS_DEV
```

- [ ] ledger 校验六个 migration checksum；
- [ ] 对象清单只允许：兼容表 + 当前 ledger 的已知子集；
- [ ] 创建七张领域表、一张 `sync_watermarks`、十个消费视图；
- [ ] 失败后不 DROP/ALTER，允许同一 `IF NOT EXISTS` ledger 安全重放；
- [ ] readonly 能查询全部十视图；
- [ ] readonly 对零行 INSERT 也被拒绝。

2026-08-10 的 `007_asset_vector_index.sql` 没有修改 app grant，使用子账号已有 IAM 控制台权限
执行；创建后立即用 KMS readonly 身份回读表、视图和行数。若未来改走 app DDL 窗口，权限变更
必须另获当次授权，不能由本清单自动放行。

## 4. PostgreSQL 同步

执行器：`scripts/bytehouse-sync.mts`。只从现有 dev PostgreSQL 读真源，不修改 PG。

- [ ] events props 按 allowlist 投影；
- [ ] cost 的报价估算、积分扣账、实际供应商成本分栏；
- [ ] radar 只使用已有真实抓取产物，不自动调用付费 52API；
- [ ] asset 文档确定性编译；
- [ ] 没有持久向量 ledger 时 embedding 保持空；
- [ ] 每域同批写两次，消费视图去除同步时间后的摘要不变；
- [ ] 水位记录稳定 `batch_id`、版本、源行数和内容摘要。

## 5. DONE 闸门

只有以下全部满足才创建本地 tag `S55-DOMAINS-DONE`：

1. dev 七领域表、一控制表、十视图真实存在；
2. events、cost、radar、asset_vec 每域至少一条真实 PostgreSQL 源数据经同步后在消费视图可见；
3. 四域重放摘要稳定；
4. readonly 全视图查询成功且写入被拒绝；
5. 血缘、字段字典、ledger 齐全；
6. 合同测试、typecheck、`npm test`、build 全绿；
7. 验证回执完全脱敏。

任一项缺失时只能回执 PARTIAL/BLOCKED，不创建 DONE tag，不通知下游“可依赖”。
