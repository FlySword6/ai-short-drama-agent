# ByteHouse dev 消费接入：汤林夕 / 董言

状态：S55 主卡 v1，2026-08-03。架构与最终验收：Fable。

## 当前可依赖边界

- 逻辑库：`shortdrama_analytics`；
- 本轮 environment：仅 dev；test/prod 尚未授权；
- PostgreSQL 是业务真源，ByteHouse 是可重建分析投影；
- `shortdrama_entity` 保持原用途，不承接 S55 四域；
- 领域底表固定六张，消费面固定九个 view；
- S55-HW 的 `s55_hello_world` 只用于通路证明，业务查询不要依赖。

账号、endpoint、密码不在本文或聊天分发。应用同步器使用 KMS 管理的 app 身份；人和看板只用
KMS 管理的 readonly 身份，并通过 S55-HW 同款私网通路接入。

## 只依赖消费视图

| 用途 | 视图 | 说明 |
| --- | --- | --- |
| 产品事件最新态 | `v_events_product_latest` | 每个 event ID 只暴露最新源版本 |
| 产品漏斗基础字段 | `v_events_funnel_base` | 已去标识、props 已白名单化 |
| 成本逐笔最新态 | `v_cost_ledger_latest` | 报价、扣费、实际成本口径分开 |
| 成本日聚合 | `v_cost_daily` | 未知实际成本不会被零值冒充 |
| 雷达调用最新态 | `v_radar_fetch_runs_latest` | 按 scope 查看抓取状态、耗时和条目数 |
| 雷达条目最新态 | `v_radar_rank_items_latest` | 只含结构化内部研究字段 |
| 资产安全文档 | `v_asset_vec_documents_latest` | 返回 canonical ID 和安全检索文本 |
| 资产向量 | `v_asset_vec_embeddings_latest` | 当前无持久向量真源，允许为空 |
| 同步水位 | `v_sync_watermarks_latest` | 查看每域最近批次、版本与源行数 |

不要查询或绑定 `events_product_fact` 等底表字段。底表允许以迁移方式演进，视图才是下游合同。

## 数据语义

- events 的 `user_subject_key` 是受控标识，不是用户资料；`safe_props_json` 只含固定 allowlist；
- cost 中 `pending_confirmation` 报价只表示估算，`charged_points` 和实际成本为空才是正确状态；
- radar 数据仅供内部研究，不能据此公开分发供应商内容；
- asset 文档只做候选预过滤，命中 ID 必须回应用 API 重新检查项目、可见性、clearance 和软删除；
- embedding 表为空不代表故障。没有持久 PostgreSQL 向量 ledger 时，禁止临时调用模型或伪造向量；
- ByteHouse 不接受审核、权限、发布、反馈或业务状态反写。

## 建表和变更

林夕/董言如需新表、字段或视图，提交以下信息给 Fable/S55：

1. 要回答的业务问题；
2. PostgreSQL canonical 真源；
3. 一行粒度、稳定键和增量键；
4. 查询样例、保留期和敏感字段；
5. 重放、删除、更正与最终鉴权方式。

由 S55 统一更新 migration、ledger、字段字典、血缘和验证收据。业务同学不直接执行 DDL/DML，
不使用个人管理员权限代替应用最小权限。

## 当前阻塞

2026-08-03 dev PostgreSQL 的 radar 三张源表为空；52API 是付费源且默认关闭。因此雷达视图可以
建成并查询，但在出现已有真实抓取产物或取得新的付费调用/PG 写入授权前，不能宣称四域数据
全部可依赖。最终“可依赖”通知由 Fable 在验收后发出。
