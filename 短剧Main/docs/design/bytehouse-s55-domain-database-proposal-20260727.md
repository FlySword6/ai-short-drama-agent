# S55 ByteHouse 四域库归属（Fable 已裁定 B）

状态：**B 已采纳；不是建库或 `--apply` 指令**。dev 是第一个受控验证环境；任何远端动作
仍须 endpoint allowlist、实际回读和当次明确授权。

## 已裁事实

1. ByteHouse CDW 的边界是一个租户内的 `dev` / `test` / `prod` 三个 environment，
   **没有**本项目可命名或迁移的“实例”对象；environment 已是隔离边界。
2. 数据库名称不再重复写环境后缀。同一逻辑库若在三环境存在，名称应相同，连接目标由
   environment endpoint 决定。
3. 林夕正在使用的 `shortdrama_entity`（dev）保留为资产实体域库；S55 不重建、不改名、
   不把它当 PostgreSQL 真源。
4. S55 的四个 ByteHouse 投影域仍是 `events_*`、`cost_*`、`radar_*`、`asset_vec_*`；
   PostgreSQL 仍是业务状态、权限和审核真源。

## 已完成的方案比较

| 维度 | A. 并入 `shortdrama_entity`，同库分表 | B. 独立分析域库 `shortdrama_analytics`（已选择） |
| --- | --- | --- |
| 建在哪 | dev 在既有 `shortdrama_entity` 增四域表；test/prod 为环境同构还需另建同名库 | 每个 environment 建同名 `shortdrama_analytics`，其中放四域表；既有 `shortdrama_entity` 不动 |
| 近期工作量 | 最低；少一个逻辑域和连接目标 | 多一套每环境 database/grant/verify 映射，但不是旧的 `shortdrama_dev/test/prod` 三库模型 |
| 域语义与血缘 | 资产实体、成本、事件、雷达混在“实体库”中；表级注释能补救，库级 owner/保留语义仍失真 | 资产实体库与可重建分析投影分开；四域的 owner、上游、同步、TTL 与消费面有一致的库级边界 |
| 权限与风险面 | 一个库授权会同时覆盖资产、成本、雷达与向量投影；后续想收窄成本/雷达访问要再拆库 | 可先把分析域与实体域隔离；若 CDW 支持并能回读更细的 database/table grant，再继续按域/消费者收窄 |
| 查询体验 | 同库查询最短 | 跨域看板需显式指定库或走受控服务；这是可见的边界，不允许 Agent 用直连绕过应用鉴权 |
| 可逆性 | 以后拆出分析库要复制历史投影、迁移 consumer 与权限，影响面较大 | 将来改变分析库结构不动 `shortdrama_entity` 或 PostgreSQL 真源；必要时可重新生成投影 |
| 数据流回路 | 可做，但资产实体库容易被误当成业务/检索真源 | `OLTP → analytics projection → API 反馈` 边界清楚，检索命中仍只返回 stable ID 后回 API |
| 词表开放 | 两案均以 `asset_kind` / tag 等开放词表表达，不以库名或分类表冻结创作语汇 | 同左；同时避免把新的分析消费者塞进资产实体库而诱发 schema 例外 |
| 2.5 前瞻 | 新模态、模型、雷达源与成本事实继续挤入实体库 | 新能力主要通过表/投影版本与 capability 数据扩展，实体域不被分析型事实反向绑死 |
| Agent-first | Agent 需要更宽的同库读面，错误授权的 blast radius 更大 | Agent 可见范围由分析服务/API 和后续细粒度 grant 说明；血缘、注释、质量检查集中在分析域 |

## 已裁定的实现边界

Fable 选择 **B**：在每个 environment 使用同名的 `shortdrama_analytics`，承载 S55 的四域表；
`shortdrama_entity` 保持为既有资产实体域库。这里的“同名”不是环境混用：dev/test/prod
仍通过不同的 environment endpoint 隔离。

推荐 B 的目的不是多建库，而是避免把成本、行为、外部雷达和可重建检索投影伪装成资产实体。
它不替代表级血缘登记，也不自动证明 ByteHouse 已支持数据库级最小权限；该能力必须先由实际
grant 回读证明。若回读无法实现分析域与实体域的最小权限隔离，应先重裁权限模型，不能把 A
当作掩盖缺口的默认终局。

| 域 | 已裁定目标库 | 表族 | 说明 |
| --- | --- | --- | --- |
| events | `shortdrama_analytics` | `events_*` | 去标识行为/生产事件投影 |
| cost | `shortdrama_analytics` | `cost_*` | 成本与积分分析事实；财务口径仍回 PostgreSQL 对账 |
| radar | `shortdrama_analytics` | `radar_*` | 内部研究快照与运行事实 |
| asset_vec | `shortdrama_analytics` | `asset_vec_*`、`asset_vector_index*` | 可重建的资产检索/向量投影；`shortdrama_entity` 不是其写入目标 |

资产混合检索的 `asset_vector_index` 已在 2026-08-10 由 `007` 合同实建：模型为
`doubao-embedding-vision-251215`、物理 HNSW 维度为 1024，且只有已确认、人工审核与治理
放行的 S0-S2 资产/变体可入索引。dev 表与视图已由 readonly 身份真实读回；数据同步、真实
向量查询与后续 environment apply 仍须单独授权和验证。

## 已裁定事项与待验证前置

1. 已选择 B；逻辑库名固定为 `shortdrama_analytics`，dev/test/prod 以 endpoint 隔离、同名存在。
2. `shortdrama_entity` 只保留 dev 既有资产实体域，不自动复制到 test/prod，也不写入 S55 四域表。
3. 当前没有 S55 四域远端写入；dev 是首个验证目标，test/prod 不因文档裁定而被创建或复制。
4. dev 的 `shortdrama_bh_app` / `readonly` 应用身份及 KMS 存放位置已由主线确认；资源打标仍待
   主线补齐，但不阻塞 S55 文档与 DDL 交付。test/prod 的对应身份、KMS 与资源准备保持
   deferred，不因 dev 先行而自动复制；任何值只进 KMS 与运行时 env。
5. 值到位后，S55 只从 env 读取 endpoint/账号信息，生成不含 host 或凭据的 environment +
   origin SHA-256 审批材料交 Fable；Fable 独立核对并将 endpoint、当前 schema manifest、
   全文/HNSW 能力集和短时 apply 授权一并绑定后，才可能讨论 apply。

## 未发生的动作

- 没有创建、删除、迁移或改名任何 ByteHouse database、environment、计算组、账号或标签；
- 没有读取 endpoint、用户名、密码或 KMS 值；
- `scripts/bytehouse-provision.mts --apply` 与 `--verify` 在新 topology、KMS 和 Fable
  allowlist 获批前保持 fail-closed；
- 不修改 PostgreSQL、`shortdrama_entity` 的现有表，或资产/审核业务真源。
