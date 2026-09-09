# ByteHouse 治理规范：租户 / 三环境 / 域库

状态：v5，2026-08-10；S55 dev 基础域与资产混合检索对象已实建读回。
本文件取代 S45 v1 的“一个实例、三个带环境后缀的库”模型；历史回执保留为过程记录，
不能再作为建库、账号或 `--apply` 的依据。

## 1. 已确认的资源边界

ByteHouse CDW 的本项目边界是一个租户内的 `dev`、`test`、`prod` 三个 environment。
environment 是隔离单位；本项目不存在需要命名、创建或迁移的 `shortdrama-bh`“实例”，
也不再使用 ClusterID 作为 S55 初始化前提。

| environment | 已确认事实 | S55 边界 |
| --- | --- | --- |
| dev | 已建；林夕正在使用 `shortdrama_entity` 资产实体域库 | 保留该库及其现有表，不把 S55 四域表自动并入 |
| test | 已建 | S55 目标库/表/账号均不因 dev 先行而自动创建；逐环境审批 |
| prod | 已建 | S55 目标库/表/账号均不因 dev 先行而自动创建；全程不写直到当次明确授权 |

默认只处理 shortdrama 项目，不查看、修改或清理其他项目/默认资源。

## 2. 命名与库归属

1. **数据库名不带 environment 后缀。** 同一逻辑库如在三个 environment 都存在，名称相同；
   连接的 environment endpoint 才是隔离边界。
2. `shortdrama_entity` 是现有 dev 资产实体域库，保留原样；它不是 PostgreSQL 的替代品，
   也不是“把所有 ByteHouse 分析事实都塞进去”的默认目标。
3. Fable 已裁 B：S55 的 `events_*`、`cost_*`、`radar_*`、`asset_vec_*` 均落在独立分析域库
   `shortdrama_analytics`。该逻辑库在三个
   environment 同名，连接目标由 environment endpoint 决定。裁决记录与四原则对照见
   [`docs/design/bytehouse-s55-domain-database-proposal-20260727.md`](../design/bytehouse-s55-domain-database-proposal-20260727.md)。
4. 不得从旧名称 `shortdrama_dev`、`shortdrama_test`、`shortdrama_prod` 推导目标库，也不得
   为了“环境同构”重建/改名 `shortdrama_entity` 或复制它到 test/prod。
5. `shortdrama_analytics.s55_hello_world` 是 2026-08-03 已验的受控通路证明，不属于四域
   业务表，也不能被下游当作分析合同。

## 3. 账号、KMS 与最小权限

Fable 已要求每个 environment 各有 `app` 与 `readonly` 应用账号。dev 已由实建回执确认：
`shortdrama_bh_app` / `shortdrama_bh_readonly`，凭据真源分别为
`shortdrama/dev/bytehouse` / `shortdrama/dev/bytehouse-readonly`；值不进入本规范。
test/prod 账号与 KMS 仍逐环境后建，不从 dev 复制或猜造。

| 要求 | 当前纪律 |
| --- | --- |
| 应用账号 | dev 的 app/readonly 已建；test/prod 仍分别配置，不得跨 environment，admin 不进应用配置 |
| 权限 | 稳态 app 只允许目标库 INSERT/SELECT/SHOW；readonly 只允许目标库 SELECT；DDL 窗口才临时加 CREATE，apply 后立即收回并回读 `SHOW GRANTS` |
| KMS / env | 值只经 KMS → 受控运行时环境变量流转；不进 git、文档、聊天、终端输出或截图 |
| endpoint | 三环境 endpoint 分开注入；S55 只可生成 environment + origin SHA-256 的审批材料，不回显 host 或连接串 |
| allowlist | Fable 独立核对控制台映射后批准版本库信任根；运行时 env 不能同时自证或改写该信任根 |

ByteHouse 控制台会把目标库级 `CREATE` / `SHOW` 回显为 `CREATE TABLE`、`CREATE VIEW`、
`CREATE DICTIONARY` 与对应 `SHOW ...` 权限；在 DDL 窗口还可能临时展开同库
ALTER/DROP/TRUNCATE 等供应商权限。执行器只在 DC/Fable 当次 apply 授权期间、且范围仍严格
绑定 `shortdrama_analytics.*` 时接受该临时展开。DDL 完成后必须从控制面移除 CREATE，
再确认 app 只剩 INSERT/SELECT/SHOW、无 grant option。任何 `*.*`、目标库外权限或
收口后仍存在的额外写权限均拒绝。

不得把 dev 账号写成 test/prod 已存在，也不得恢复“readonly 跨三库”的旧模型。

## 4. 打标、计算组与网络

- 资源必须补 `project=shortdrama`，作为成本归因的依据；当前标签数为 0 不等于已经完成。
- 不再使用旧“单实例共享”的 `env=shared` 标签。environment 本身是隔离维度；具体
  resource type、resource ID 与 API 形状在真正打标前以控制台/官方回读为准。
- 现有 dev 计算组 `shortdrama_dev_wh` 的 S 档、自动暂停和 stopped 正常状态保留；test/prod
  未来如建计算组，沿用同样的成本控制策略，但不因本文件自动创建。
- 数据面仅走获批网络路径。endpoint、用户名和密码不得进入本文件。

## 5. S55 执行闸门

`scripts/bytehouse-provision.mts` 是 S55 主卡 dev-only 执行面。它复用 S55-HW 已验的私网、
单 `/32` allowlist、固定 `127.0.0.1:18123` 隧道和脱敏错误边界。解除写闸门必须同时满足：

1. Fable 已批准当前 `shortdrama_analytics` ledger，并有 DC 当次 apply 授权；
2. app/readonly 两套 KMS 凭据均可认证，账号相互独立；
3. 自动执行器若使用 app DDL 窗口，app 在目标库须包含 `CREATE`（或等价的
   `CREATE TABLE` + `CREATE VIEW`）、`INSERT`、`SELECT`、`SHOW`；readonly 仅包含 `SELECT`。
   2026-08-10 的 `007` 使用现有 IAM 控制台授权，不为 app 扩权；
4. 未展开角色、admin/ALL、`*.*` 宽权限、目标库外权限或无法解析的 grant 一律
   fail-closed；供应商在同库临时展开的 DDL 权限与 grant option 只允许用于当前 apply，
   不属于稳态授权；
5. apply 必须逐字确认 `APPLY_BYTEHOUSE_S55_DOMAINS_DEV`；脚本仅执行 ledger 中的
   `CREATE ... IF NOT EXISTS`，允许从已知子集安全重放，不自动 DROP/ALTER/清理；
6. apply 后必须用 readonly 回读八张物理表（七张领域表 + 一张水位表）、十个消费视图，
   并做 readonly INSERT 负向验证；
7. DDL 验证通过后必须在控制面收回 app 的 CREATE 及其供应商展开，再以 app 回读
   `SHOW GRANTS`，只接受目标库 INSERT/SELECT/SHOW 且无 grant option，之后才能启动同步。

dry-run 零 env、零网络、零写入。dev 验证通过不自动授权 test/prod。

2026-08-03 的 S55-HW 只完成最小连通性证明。完整四域基础六表以 Fable 架构稿
`docs/design/bytehouse-data-architecture-20260803.md` 为准；本次只允许 dev
`shortdrama_analytics` 的 DDL；数据写入、权限变更与 test/prod 继续保持关闭。

## 6. 不做

- 不新建或重建 `shortdrama-bh`、不使用 ClusterID 补救旧脚本；
- 不创建环境后缀数据库，不把环境名编码进数据库名称；
- 不修改 `shortdrama_entity`、PostgreSQL 业务真源、审核状态机、Milvus 或 TOS；
- 不把 endpoint 或任何凭据写入 repo、回执、聊天、日志或截图；
- 不把“文档已更新”误报成 database、权限、标签或环境已实建。
