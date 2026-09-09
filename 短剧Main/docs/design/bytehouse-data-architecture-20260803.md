# ByteHouse 数据架构稿 v1(S55 主卡执行框架)

2026-08-03,Fable。给 sol 的拆解基线,给 DC 的过目稿。承接:S55 裁 B(库归属)+R38(骨架统一出)+R43(六原则)+S55-HW(受控通路已验)+DC 08-03「完整库表承载需求,不是 Hello World」。

## 0. 一句话定位

pg 主库管**业务事实**(OLTP,真源),ByteHouse 管**分析投影**(OLAP,只读消费面)——BH 里没有任何一行数据是「原创」的,全部可从 pg/对象存储重放重建。这条分工线是所有设计判据的根。

## 1. 域与库(已裁,写死)

- 每 environment(dev/test/prod)同名库 `shortdrama_analytics` 承载四域;库名不带环境后缀,环境靠 environment 隔离。
- `shortdrama_entity`(dev)保留为林夕的资产实体域,S55 不写入、不复制、不承接四域。
- 四域与表基线(feature/v011-s55 旧 DDL 为 rebase 起点,{{database}}→shortdrama_analytics):

| 域 | 表(基线) | 承载什么 | pg/外部来源 |
|---|---|---|---|
| events(产品事件) | events_product_fact | 用户行为与产品事件流水 | pg 审计/事件表+前端埋点(埋点接入是后续卡,首版只同步已落库事件) |
| cost(成本台账) | cost_ledger_fact | 生成消耗/积分流水/供应商成本 | pg 消耗与计费事实表 |
| radar(选题雷达) | radar_fetch_runs / radar_rank_items | 外部榜单抓取与排名 | **定时抓取:每 6h 调一次 52api 存 pg,前端只读库不实时请求 API**(DC 2026-08-03 拍板;1w 次配额按此节奏够用两年);BH 侧照常从 pg 同步 |
| asset_vec(资产向量投影) | asset_vec_documents / asset_vec_embeddings | 资产语义检索投影 | pg 资产表+Milvus/嵌入产物 |

## 2. 来源与更新方式(首版统一批同步,不做实时)

- **同步器形态**:主仓一个 `bytehouse-sync` 任务(node,走 S55-HW 同款受控数据面通路),按域拉 pg 增量→INSERT 进 BH。cron 级调度(dev 手动/定时皆可),**不引入 CDC/消息队列**——数据量级(单日万行级)配不上那复杂度,依赖关系也最短。
- **增量水位**:每域一张 `_sync_watermark` 控制行(BH 内或 pg 侧 sync_state 表,sol 定,判据=重启后可恢复、可重放)。水位键=源表单调列(created_at/id)。
- **幂等策略**:BH CnchMergeTree 无 upsert——统一「重放安全」口径:同步批次带 `source_version`/`synced_at`,查询侧一律取最新版本行(视图封装 argMax 或 ORDER BY ... LIMIT 1 BY 语义);重放同一水位段不产生查询可见的重复。**验收以「同段重放两次,消费视图行数与内容不变」为准**(与 S55-HW 顺序幂等同一口径,不宣称并发安全)。
- **消费面**:每域给 1-2 个稳定视图(如 `v_cost_daily`、`v_events_funnel_base`),林夕/董言只依赖视图不依赖底表——底表结构演进不破坏下游。

## 3. 主键与排序键

- 逻辑主键=源系统主键(event_id/entry_key/run_id/document_id),BH 侧不生成新身份。
- 排序键沿旧 DDL 基线(已含时间+业务键),sol rebase 时按查询画像微调即可,不推倒。
- 分区统一 `toYYYYMM(时间列)`,与旧稿一致。

## 4. 保留周期

- dev:90 天滚动(TTL 或定期分区清理,sol 选实现);test:30 天;prod:上线前另裁(合规留存要求届时对齐 AIGC 标识底稿)。
- 源真源在 pg,BH 清了可重放,所以保留期宁短勿长。

## 5. 权限模型

- 沿 S55-HW 两账号扩权:`app`(同步器专用,目标库 CREATE/SHOW/SELECT/INSERT)、`readonly`(林夕/董言/看板,仅 SELECT)。
- 不加第三种角色;管理动作(建库/账号/白名单)只走受控 provision,不给长期管理账号。
- 网络边界沿 S55-HW:私网+白名单 /32,不开公网。林夕/董言接入方式=readonly 账号+私网通路说明(定稿后单独发接入卡)。

## 6. 迁移编号与血缘

- BH DDL 独立序列 `bytehouse/migrations/NNN_*.sql`(S55-HW 已开 001 先例;四域旧稿 001-005 rebase 后重新编号接续),**不占 pg 迁移号**;ledger.json 记录每次 apply 的 environment/库/表/checksum。
- 血缘登记:每表四元组(源表→同步任务→BH 表→消费视图)落 `docs/contracts/bytehouse-governance.md` 附表,建一张登一张,不许有无源之表。

## 7. 验收标准(S55 主卡 DONE 门槛)

1. 四域六表在 dev `shortdrama_analytics` 真实建成,控制台可回读;
2. 每域至少一条**真实 pg 源数据**走完 同步→BH 查得→视图可见(radar 域可用现有抓取产物);
3. 水位重放两次,消费视图行数与内容不变(幂等);
4. readonly 账号查询全部视图成功,且对底表无写权限(负向验证);
5. 血缘附表四元组齐,DDL 进 bytehouse/migrations 带 ledger;
6. 门禁:合同测试+typecheck+npm test 全绿;
7. 回执脱敏同 S55-HW 标准(零凭据/零 endpoint/零响应正文)。

## 8. 依赖与顺序(vibe coding 口径:只管依赖,不排钟点)

```
架构稿(本文,DC 可驳) → sol rebase 五件套到新 topology → DDL apply(dev,授权沿 S55-HW 框架,范围扩为四域建表)
                              ↘ 同步器实现(与 DDL 并行起,联调依赖 DDL 就绪)
同步器 dev 跑通 → 验收 1-7 → 血缘+接入卡 → 通知林夕/董言可依赖(→ test/prod 照单复制,另批)
```

R43 六原则在本稿的归属说明:槽位配置化/时间轴对象化/语音维度/受控编辑对象化主要约束 pg 本体与生成链,BH 侧的义务=events/asset_vec 表结构预留扩展列(旧 DDL 已有 payload/metadata JSON 列,够),不在本稿加戏。
